/* ==========================================================================
   SHUNEL — Artwork Manager (v4.1)
   Portadas por canción, validación de coincidencias, respaldo de carátula de álbum,
   --song-color con <canvas>, estados de carga/reproducción, gestos táctiles, a11y
   y gestión limpia de ciclo de vida.
   ========================================================================== */

import { getTrackMetadata } from './metadata.js';
import {
  applyModToTrack,
  getArtistArtworkEntry
} from './mods.js';

const FALLBACK = '/assets/logo.png';
const DEEZER_PROXY = 'https://proxy.cors.dev/https://api.deezer.com';
const ITUNES_SEARCH_URL = 'https://itunes.apple.com/search';
const CACHE_KEY = 'shunel_artist_artwork_v3';
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 10; // 10 días
const MAX_CACHE_ENTRIES = 90;
const MAX_COLOR_CACHE_ENTRIES = 120;
const FETCH_TIMEOUT_MS = 7000;
const COLOR_SYNC_TIMEOUT_MS = 450;
const DEFAULT_SONG_COLOR = '#242424';
const DEFAULT_SECONDARY_COLOR = '#141414';

const CLASS_LOADING = 'shunel-artwork-loading';
const CLASS_READY = 'shunel-artwork-ready';
const CLASS_ERROR = 'shunel-artwork-error';

let activeTrackKey = '';
let activeArtwork = FALLBACK;
let activeSongColor = DEFAULT_SONG_COLOR;
let activeTrack = null;
let requestController = null;
let requestCounter = 0;
let initialized = false;
let isPlayingState = false;
let isLoadingState = false;
let rafScheduled = false;
let pendingVisualSync = null;

const artistRequests = new Map();
const albumRequests = new Map();
const colorCache = new Map();
const preloadedUrls = new Set();
const cleanupCallbacks = [];
const gestureState = new WeakMap();

let colorCanvas = null;
let colorCtx = null;

/* --------------------------------------------------------------------------
   01. UTILIDADES DE IDENTIDAD, NORMALIZACIÓN Y VALIDACIÓN DE URLs
   -------------------------------------------------------------------------- */

function isDebugEnabled() {
  try {
    return Boolean(
      window?.__SHUNEL_DEBUG__ === true ||
      window?.localStorage?.getItem('shunel_debug') === '1'
    );
  } catch {
    return false;
  }
}

function logDebug(...args) {
  if (isDebugEnabled()) {
    console.debug('[Shunel Artwork]', ...args);
  }
}

function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function isDataSaverEnabled() {
  try {
    return Boolean(navigator?.connection?.saveData);
  } catch {
    return false;
  }
}

function extractTrackFromEvent(event) {
  const detail = event?.detail;
  if (!detail) return null;
  if (detail.track && typeof detail.track === 'object') return detail.track;
  if (typeof detail === 'object') return detail;
  return null;
}

function getTrackTitle(track) {
  return String(track?.title || track?.name || '').trim();
}

function getTrackArtist(track) {
  return String(
    track?.artist ||
    track?.channelTitle ||
    track?.artistName ||
    track?.metadata?.artist ||
    ''
  ).trim();
}

function trackKey(track) {
  if (!track || typeof track !== 'object') return '';
  const idPart = String(track.videoId || track.id || track.uuid || '').trim();
  const titlePart = getTrackTitle(track).toLowerCase();
  const artistPart = normaliseArtist(getTrackArtist(track));
  return `${idPart}|${titlePart}|${artistPart}`;
}

function normaliseText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normaliseArtist(value) {
  return normaliseText(value)
    .replace(/\b(official|topic|vevo|music|records|tv)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitCollaborators(artistName) {
  const raw = String(artistName || '').trim();
  if (!raw) return [];
  const parts = raw
    .split(/\s*(?:,|&|\+|\/|\bfeat\.?\b|\bft\.?\b|\bwith\b|\bx\b|\band\b|\by\b)\s*/i)
    .map(normaliseArtist)
    .filter(Boolean);
  return [...new Set(parts)];
}

function artistMatchesCandidate(expectedArtist, candidateArtist) {
  const expectedNorm = normaliseArtist(expectedArtist);
  const candidateNorm = normaliseArtist(candidateArtist);
  if (!expectedNorm || !candidateNorm) return false;
  if (expectedNorm === candidateNorm) return true;

  const expectedParts = splitCollaborators(expectedArtist);
  const candidateParts = splitCollaborators(candidateArtist);

  if (expectedParts.some(p => candidateParts.includes(p))) return true;
  if (expectedNorm.length >= 4 && candidateNorm.includes(expectedNorm)) return true;
  if (candidateNorm.length >= 4 && expectedNorm.includes(candidateNorm)) return true;

  return false;
}

function cleanQueryTitle(title, artist = '') {
  let cleaned = String(title || '').trim();
  if (!cleaned) return '';

  const artistClean = String(artist || '').trim();
  if (artistClean) {
    const escapedArtist = artistClean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    cleaned = cleaned.replace(new RegExp(`^${escapedArtist}\\s*[-–—:|/]+\\s*`, 'i'), '');
  }

  cleaned = cleaned
    .replace(/\s*[\[(](?:[^[\]()]{0,80}\b(?:official|video|audio|lyric\s*video|visualizer|lyrics?|hd|4k|remaster(?:ed)?|explicit|clean|prod\.?)\b[^[\]()]{0,80})[\])]\s*/gi, ' ')
    .replace(/\s+(?:official\s*(?:video|audio|lyrics?)|lyrics?|video\s*oficial|audio\s*oficial|visualizer)\s*$/i, '')
    .replace(/\s+[|｜]\s+.*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return cleaned || String(title || '').trim();
}

function titleMatchesCandidate(expectedTitle, candidateTitle) {
  const expNorm = normaliseText(expectedTitle);
  const candNorm = normaliseText(candidateTitle);
  if (!expNorm || !candNorm) return false;
  if (expNorm === candNorm) return true;
  if (expNorm.length >= 3 && candNorm.includes(expNorm)) return true;
  if (candNorm.length >= 3 && expNorm.includes(candNorm)) return true;

  const expTokens = expNorm.split(' ').filter(t => t.length >= 2);
  const candSet = new Set(candNorm.split(' ').filter(t => t.length >= 2));
  if (!expTokens.length || !candSet.size) return false;

  let hits = 0;
  for (const token of expTokens) {
    if (candSet.has(token)) hits += 1;
  }
  return hits / expTokens.length >= 0.6;
}

function normaliseUrl(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'null' || trimmed === 'undefined') return '';
  return trimmed;
}

function validImageUrl(value) {
  const normalized = normaliseUrl(value);
  if (!normalized) return false;

  if (/^https:\/\//i.test(normalized)) {
    try {
      const parsed = new URL(normalized);
      return parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }

  if (/^\/assets\/[a-z0-9_./-]+$/i.test(normalized)) {
    return !normalized.includes('..');
  }

  if (/^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[a-z0-9+/=]+$/i.test(normalized)) {
    return normalized.length <= 250000;
  }

  if (/^blob:/i.test(normalized)) {
    return true;
  }

  return false;
}

function isPersistableUrl(url) {
  const normalized = normaliseUrl(url);
  return /^https:\/\//i.test(normalized) || /^\/assets\//i.test(normalized);
}

function resolveAbsoluteUrl(url) {
  try {
    return new URL(url, window.location.origin).href;
  } catch {
    return url;
  }
}

/* --------------------------------------------------------------------------
   02. OBJETIVOS DEL DOM Y SINCRONIZACIÓN DE ESTADO / ESTILO
   -------------------------------------------------------------------------- */

function getCurrentThumbnailEl() {
  return document.getElementById('currentThumbnail');
}

function getFullThumbnailEl() {
  return document.getElementById('fullPlayerThumbnail');
}

function getFullPlayerEl() {
  return document.getElementById('fullPlayer') || document.querySelector('.full-player');
}

function isPrimaryArtworkTarget(el) {
  if (!el) return false;
  const current = getCurrentThumbnailEl();
  const full = getFullThumbnailEl();
  return el === current || el === full;
}

function imageTargets() {
  const targets = [
    getCurrentThumbnailEl(),
    getFullThumbnailEl(),
    ...document.querySelectorAll('[data-shunel-artwork]')
  ];
  const unique = [];
  const seen = new Set();

  for (const el of targets) {
    if (el && !seen.has(el)) {
      seen.add(el);
      unique.push(el);
    }
  }

  return unique;
}

function setLifecycleClass(el, state) {
  if (!el || !el.classList) return;
  el.classList.remove(CLASS_LOADING, CLASS_READY, CLASS_ERROR);
  if (state === 'loading') {
    el.classList.add(CLASS_LOADING);
  } else if (state === 'ready') {
    el.classList.add(CLASS_READY);
  } else if (state === 'error') {
    el.classList.add(CLASS_ERROR);
  }
}

function updateTargetsLifecycle(targets, state) {
  for (const el of targets) {
    setLifecycleClass(el, state);
  }
}

function setGestureScale(el, scaleValue) {
  if (!el || !el.style) return;
  const nextScale = prefersReducedMotion() ? 1 : Number(scaleValue) || 1;
  el.style.setProperty('--shunel-art-gesture-scale', String(nextScale));
}

function flushVisualSync() {
  rafScheduled = false;
  const payload = pendingVisualSync;
  pendingVisualSync = null;
  if (!payload) return;

  const root = document.documentElement;

  if (typeof payload.artworkCss === 'string') {
    if (payload.artworkCss && payload.artworkCss !== 'none') {
      root.style.setProperty('--shunel-artwork', `url("${payload.artworkCss}")`);
    } else {
      root.style.setProperty('--shunel-artwork', 'none');
    }
  }

  if (typeof payload.songColor === 'string' && payload.songColor) {
    root.style.setProperty('--song-color', payload.songColor);
  }

  if (typeof payload.secondaryColor === 'string' && payload.secondaryColor) {
    root.style.setProperty('--shunel-song-secondary', payload.secondaryColor);
  }

  if (typeof payload.isPlaying === 'boolean') {
    const fullPlayer = getFullPlayerEl();
    if (fullPlayer) {
      fullPlayer.classList.toggle('is-playing', payload.isPlaying);
      fullPlayer.classList.toggle('is-paused', !payload.isPlaying);
      fullPlayer.setAttribute(
        'data-shunel-player-state',
        payload.isPlaying ? 'playing' : 'paused'
      );
    }
  }
}

function scheduleVisualSync(partial = {}) {
  pendingVisualSync = {
    ...(pendingVisualSync || {}),
    ...partial
  };

  if (!rafScheduled) {
    rafScheduled = true;
    requestAnimationFrame(flushVisualSync);
  }
}

function setImage(image, url, alt, options = {}) {
  if (!image) return;

  const isImg = image instanceof HTMLImageElement;
  const safeUrl = validImageUrl(url) ? normaliseUrl(url) : FALLBACK;
  const isPrimary = Boolean(options.isPrimary ?? isPrimaryArtworkTarget(image));
  const label = alt || 'Portada de la canción';

  if (isImg) {
    image.loading = isPrimary ? 'eager' : 'lazy';
    image.decoding = 'async';
    if (image.alt !== label) {
      image.alt = label;
    }
  } else if (image.getAttribute('role') === 'img' && image.getAttribute('aria-label') !== label) {
    image.setAttribute('aria-label', label);
  }

  if (!isImg) {
    const escaped = safeUrl.replace(/["\\\n\r]/g, '');
    image.style.backgroundImage = `url("${escaped}")`;
    setLifecycleClass(image, safeUrl === FALLBACK ? 'error' : 'ready');
    return;
  }

  const currentAttr = normaliseUrl(image.getAttribute('src'));

  if (currentAttr === safeUrl && image.complete && image.naturalWidth > 0) {
    setLifecycleClass(image, 'ready');
    return;
  }

  setLifecycleClass(image, 'loading');

  const loadToken = (Number(image.dataset.shunelLoadToken || 0) + 1);
  image.dataset.shunelLoadToken = String(loadToken);

  image.onload = async () => {
    if (Number(image.dataset.shunelLoadToken || 0) !== loadToken) return;
    image.onload = null;
    image.onerror = null;

    if (typeof image.decode === 'function') {
      try {
        await image.decode();
      } catch {
        /* Ignora error de decode si ya está pintada. */
      }
    }

    if (Number(image.dataset.shunelLoadToken || 0) !== loadToken) return;
    setLifecycleClass(image, 'ready');
  };

  image.onerror = () => {
    if (Number(image.dataset.shunelLoadToken || 0) !== loadToken) return;
    image.onload = null;
    image.onerror = null;

    setLifecycleClass(image, 'error');

    const fallbackAbs = resolveAbsoluteUrl(FALLBACK);
    if (image.src !== fallbackAbs) {
      image.src = FALLBACK;
    }
  };

  if (currentAttr !== safeUrl) {
    image.src = safeUrl;
  } else {
    image.src = '';
    image.src = safeUrl;
  }

  if (image.complete && image.naturalWidth > 0) {
    image.onload = null;
    image.onerror = null;
    setLifecycleClass(image, 'ready');
  }
}

/* --------------------------------------------------------------------------
   03. EXTRACCIÓN DE COLOR DOMINANTE (--song-color) CON <canvas>
   -------------------------------------------------------------------------- */

function ensureColorCanvas() {
  if (colorCanvas && colorCtx) return true;
  try {
    colorCanvas = document.createElement('canvas');
    colorCanvas.width = 24;
    colorCanvas.height = 24;
    colorCtx = colorCanvas.getContext('2d', { willReadFrequently: true });
    return Boolean(colorCtx);
  } catch {
    colorCanvas = null;
    colorCtx = null;
    return false;
  }
}

function rgbToHex(r, g, b) {
  const clamp = v => Math.max(0, Math.min(255, Math.round(v)));
  return (
    '#' +
    [clamp(r), clamp(g), clamp(b)]
      .map(n => n.toString(16).padStart(2, '0'))
      .join('')
  );
}

function tuneColorForDarkBackdrop(r, g, b) {
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  const maxC = Math.max(r, g, b);
  const minC = Math.min(r, g, b);
  const saturation = maxC === 0 ? 0 : (maxC - minC) / maxC;

  let nr = r;
  let ng = g;
  let nb = b;

  if (luminance < 0.055 && saturation < 0.18) {
    return DEFAULT_SONG_COLOR;
  }

  if (luminance < 0.09) {
    const lift = 1.45;
    nr = Math.min(255, nr * lift + 10);
    ng = Math.min(255, ng * lift + 10);
    nb = Math.min(255, nb * lift + 10);
  }

  const tunedLum = (0.2126 * nr + 0.7152 * ng + 0.0722 * nb) / 255;
  if (tunedLum > 0.58) {
    const scale = 0.58 / tunedLum;
    nr *= scale;
    ng *= scale;
    nb *= scale;
  }

  return rgbToHex(nr, ng, nb);
}

function cacheSongColor(key, color) {
  if (!key || !color) return;
  if (colorCache.has(key)) {
    colorCache.delete(key);
  }
  colorCache.set(key, color);

  while (colorCache.size > MAX_COLOR_CACHE_ENTRIES) {
    const oldestKey = colorCache.keys().next().value;
    colorCache.delete(oldestKey);
  }
}

async function extractDominantSongColor(imageUrl, cacheKeyHint = '', signal = null) {
  const safeUrl = normaliseUrl(imageUrl);
  if (!validImageUrl(safeUrl) || safeUrl === FALLBACK) {
    return DEFAULT_SONG_COLOR;
  }

  const cacheKey = cacheKeyHint || safeUrl;
  if (colorCache.has(cacheKey)) {
    return colorCache.get(cacheKey);
  }

  if (!ensureColorCanvas()) {
    return DEFAULT_SONG_COLOR;
  }

  return new Promise(resolve => {
    if (signal?.aborted) {
      resolve(DEFAULT_SONG_COLOR);
      return;
    }

    const probe = new Image();
    let settled = false;

    const finish = color => {
      if (settled) return;
      settled = true;
      probe.onload = null;
      probe.onerror = null;
      if (signal && onAbort) {
        signal.removeEventListener('abort', onAbort);
      }
      const finalColor = color || DEFAULT_SONG_COLOR;
      cacheSongColor(cacheKey, finalColor);
      resolve(finalColor);
    };

    const onAbort = () => finish(activeSongColor || DEFAULT_SONG_COLOR);
    signal?.addEventListener('abort', onAbort, { once: true });

    if (/^https:\/\//i.test(safeUrl)) {
      probe.crossOrigin = 'anonymous';
    }

    probe.onload = () => {
      try {
        const w = colorCanvas.width;
        const h = colorCanvas.height;
        colorCtx.clearRect(0, 0, w, h);

        const natW = probe.naturalWidth || w;
        const natH = probe.naturalHeight || h;
        let sx = 0;
        let sy = 0;
        let sw = natW;
        let sh = natH;

        if (natW > natH * 1.45) {
          sh = Math.round(natH * 0.72);
          sy = Math.round((natH - sh) / 2);
        }

        colorCtx.drawImage(probe, sx, sy, sw, sh, 0, 0, w, h);
        const imageData = colorCtx.getImageData(0, 0, w, h).data;

        const buckets = new Map();

        for (let i = 0; i < imageData.length; i += 4) {
          const r = imageData[i];
          const g = imageData[i + 1];
          const b = imageData[i + 2];
          const a = imageData[i + 3];

          if (a < 128) continue;

          const maxC = Math.max(r, g, b);
          const minC = Math.min(r, g, b);
          const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

          if (lum < 0.04 || lum > 0.94) continue;

          const sat = maxC === 0 ? 0 : (maxC - minC) / maxC;
          const weight = 1 + sat * 2.2;

          const qr = Math.floor(r / 24) * 24;
          const qg = Math.floor(g / 24) * 24;
          const qb = Math.floor(b / 24) * 24;
          const bucketKey = `${qr},${qg},${qb}`;

          const entry = buckets.get(bucketKey) || {
            weight: 0,
            rSum: 0,
            gSum: 0,
            bSum: 0
          };

          entry.weight += weight;
          entry.rSum += r * weight;
          entry.gSum += g * weight;
          entry.bSum += b * weight;
          buckets.set(bucketKey, entry);
        }

        if (!buckets.size) {
          finish(DEFAULT_SONG_COLOR);
          return;
        }

        let best = null;
        for (const entry of buckets.values()) {
          if (!best || entry.weight > best.weight) {
            best = entry;
          }
        }

        const avgR = best.rSum / best.weight;
        const avgG = best.gSum / best.weight;
        const avgB = best.bSum / best.weight;

        finish(tuneColorForDarkBackdrop(avgR, avgG, avgB));
      } catch (err) {
        logDebug('No se pudo leer píxeles de portada (posible CORS):', err?.message);
        finish(DEFAULT_SONG_COLOR);
      }
    };

    probe.onerror = () => {
      finish(DEFAULT_SONG_COLOR);
    };

    probe.src = safeUrl;
  });
}

function resolveSongColorWithBudget(imageUrl, cacheKeyHint, signal, budgetMs = COLOR_SYNC_TIMEOUT_MS) {
  const safeUrl = normaliseUrl(imageUrl);
  if (!validImageUrl(safeUrl) || safeUrl === FALLBACK) {
    return Promise.resolve(DEFAULT_SONG_COLOR);
  }

  const cacheKey = cacheKeyHint || safeUrl;
  if (colorCache.has(cacheKey)) {
    return Promise.resolve(colorCache.get(cacheKey));
  }

  const extraction = extractDominantSongColor(safeUrl, cacheKey, signal);
  return Promise.race([
    extraction,
    new Promise(resolve => {
      window.setTimeout(() => resolve(activeSongColor || DEFAULT_SONG_COLOR), budgetMs);
    })
  ]);
}

/* --------------------------------------------------------------------------
   04. CACHÉ PERSISTENTE CON TTL Y LÍMITE DE TAMAÑO
   -------------------------------------------------------------------------- */

function readArtworkCache() {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return {};
    }

    const now = Date.now();
    const cleaned = {};
    let mutated = false;

    for (const [k, entry] of Object.entries(raw)) {
      if (typeof entry === 'string') {
        mutated = true;
        continue;
      }

      if (
        entry &&
        typeof entry === 'object' &&
        validImageUrl(entry.url) &&
        isPersistableUrl(entry.url) &&
        typeof entry.ts === 'number' &&
        now - entry.ts <= CACHE_TTL_MS
      ) {
        cleaned[k] = { url: entry.url.trim(), ts: entry.ts };
      } else {
        mutated = true;
      }
    }

    if (mutated) {
      writeArtworkCache(cleaned);
    }

    return cleaned;
  } catch {
    return {};
  }
}

function writeArtworkCache(cache) {
  try {
    const entries = Object.entries(cache).filter(
      ([, v]) => v && typeof v === 'object' && validImageUrl(v.url) && isPersistableUrl(v.url)
    );

    entries.sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));

    const trimmed =
      entries.length > MAX_CACHE_ENTRIES
        ? Object.fromEntries(entries.slice(entries.length - MAX_CACHE_ENTRIES))
        : Object.fromEntries(entries);

    localStorage.setItem(CACHE_KEY, JSON.stringify(trimmed));
  } catch {
    /* Caché opcional. */
  }
}

function getCachedArtistArtwork(normalizedArtistKey) {
  if (!normalizedArtistKey) return '';
  const cache = readArtworkCache();
  const entry = cache[normalizedArtistKey];
  if (entry && validImageUrl(entry.url)) {
    return entry.url;
  }
  return '';
}

function setCachedArtistArtwork(normalizedArtistKey, url) {
  if (!normalizedArtistKey || !validImageUrl(url) || !isPersistableUrl(url)) return;
  const cache = readArtworkCache();
  cache[normalizedArtistKey] = {
    url: url.trim(),
    ts: Date.now()
  };
  writeArtworkCache(cache);
}

/* --------------------------------------------------------------------------
   05. BÚSQUEDA DE CARÁTULA DE ÁLBUM Y ARTISTA CON VALIDACIÓN
   -------------------------------------------------------------------------- */

async function fetchAlbumArtwork(track, signal) {
  const rawTitle = getTrackTitle(track);
  const rawArtist = getTrackArtist(track);
  const cleanedTitle = cleanQueryTitle(rawTitle, rawArtist);
  const queryText = [cleanedTitle, rawArtist].filter(Boolean).join(' ').trim();

  if (!cleanedTitle || !rawArtist || !queryText) return '';

  const cacheKey = `album::${normaliseText(cleanedTitle)}::${normaliseArtist(rawArtist)}`;
  const cached = getCachedArtistArtwork(cacheKey);
  if (cached) {
    return cached;
  }

  if (albumRequests.has(cacheKey)) {
    return albumRequests.get(cacheKey);
  }

  const request = (async () => {
    const timeoutController = new AbortController();
    const onExternalAbort = () => timeoutController.abort();
    signal?.addEventListener('abort', onExternalAbort, { once: true });

    const timerId = window.setTimeout(() => {
      timeoutController.abort();
    }, Math.min(FETCH_TIMEOUT_MS, 4500));

    try {
      const url = new URL(ITUNES_SEARCH_URL);
      url.search = new URLSearchParams({
        term: queryText,
        entity: 'song',
        limit: '6'
      }).toString();

      const response = await fetch(url.toString(), {
        method: 'GET',
        credentials: 'omit',
        signal: timeoutController.signal,
        headers: {
          Accept: 'application/json'
        }
      });

      if (!response.ok) return '';

      const data = await response.json();
      const results = Array.isArray(data?.results) ? data.results : [];

      const matched = results.find(
        item =>
          artistMatchesCandidate(rawArtist, item?.artistName) &&
          titleMatchesCandidate(cleanedTitle, item?.trackName)
      );

      const rawArt = normaliseUrl(
        matched?.artworkUrl100 || matched?.artworkUrl60 || ''
      );
      const hiResArt = rawArt
        ? rawArt.replace(/\/\d+x\d+bb\.(jpg|png|webp)$/i, '/600x600bb.$1')
        : '';

      if (!validImageUrl(hiResArt)) return '';

      setCachedArtistArtwork(cacheKey, hiResArt);
      return hiResArt;
    } catch {
      return '';
    } finally {
      window.clearTimeout(timerId);
      signal?.removeEventListener('abort', onExternalAbort);
    }
  })().finally(() => {
    albumRequests.delete(cacheKey);
  });

  albumRequests.set(cacheKey, request);
  return request;
}

async function fetchArtistArtwork(name, signal) {
  const expectedName = String(name || '').trim();
  const key = normaliseArtist(expectedName);
  if (!key) return '';

  const cached = getCachedArtistArtwork(key);
  if (cached) {
    return cached;
  }

  if (artistRequests.has(key)) {
    return artistRequests.get(key);
  }

  const request = (async () => {
    const timeoutController = new AbortController();
    const onExternalAbort = () => timeoutController.abort();
    signal?.addEventListener('abort', onExternalAbort, { once: true });

    const timerId = window.setTimeout(() => {
      timeoutController.abort();
    }, FETCH_TIMEOUT_MS);

    try {
      const url =
        `${DEEZER_PROXY}/search/artist?q=${encodeURIComponent(expectedName)}&limit=5`;

      const response = await fetch(url, {
        method: 'GET',
        credentials: 'omit',
        signal: timeoutController.signal,
        headers: {
          Accept: 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`No se pudo consultar la portada (${response.status}).`);
      }

      const data = await response.json();

      if (data?.error || !Array.isArray(data?.data)) {
        throw new Error('Respuesta inválida al buscar el artista.');
      }

      const exactMatch = data.data.find(
        item => normaliseArtist(item?.name) === key
      );
      const looseMatch = exactMatch || data.data.find(
        item => artistMatchesCandidate(expectedName, item?.name)
      );

      if (!looseMatch) {
        return '';
      }

      const artwork = normaliseUrl(
        looseMatch?.picture_xl ||
        looseMatch?.picture_big ||
        looseMatch?.picture_medium ||
        ''
      );

      if (!validImageUrl(artwork)) return '';

      setCachedArtistArtwork(key, artwork);
      return artwork;
    } finally {
      window.clearTimeout(timerId);
      signal?.removeEventListener('abort', onExternalAbort);
    }
  })().finally(() => {
    artistRequests.delete(key);
  });

  artistRequests.set(key, request);
  return request;
}

/* --------------------------------------------------------------------------
   06. APLICACIÓN PRINCIPAL DE PORTADA Y SINCRONIZACIÓN AMBIENTAL
   -------------------------------------------------------------------------- */

export function applyArtwork(track, url = '', options = {}) {
  const safeTrack = track && typeof track === 'object' ? track : {};
  const explicitUrl = normaliseUrl(url);
  const trackArt = normaliseUrl(safeTrack.artwork);
  const thumbArt = normaliseUrl(safeTrack.thumbnail);
  const metaArt = normaliseUrl(safeTrack.metadata?.artwork);

  const candidate = validImageUrl(explicitUrl)
    ? explicitUrl
    : validImageUrl(trackArt)
      ? trackArt
      : validImageUrl(thumbArt)
        ? thumbArt
        : validImageUrl(metaArt)
          ? metaArt
          : FALLBACK;

  activeArtwork = candidate;

  const title = getTrackTitle(safeTrack) || 'Canción';
  const artist = getTrackArtist(safeTrack);
  const altText = artist ? `${title} — ${artist}` : title;

  const targets = imageTargets();
  for (const target of targets) {
    setImage(target, candidate, altText, {
      isPrimary: isPrimaryArtworkTarget(target)
    });
  }

  const cssUrl = candidate.replace(/["\\\n\r]/g, '');
  scheduleVisualSync({
    artworkCss: candidate === FALLBACK ? 'none' : cssUrl,
    isPlaying: isPlayingState
  });

  const colorKey = trackKey(safeTrack) || candidate;
  const colorSignal = options.signal || requestController?.signal || null;

  void resolveSongColorWithBudget(candidate, colorKey, colorSignal).then(color => {
    if (activeArtwork !== candidate) return;
    activeSongColor = color;
    scheduleVisualSync({
      songColor: color,
      secondaryColor: DEFAULT_SECONDARY_COLOR
    });

    document.dispatchEvent(
      new CustomEvent('shunel:artwork-updated', {
        detail: {
          track: safeTrack,
          artwork: candidate,
          songColor: activeSongColor
        }
      })
    );
  });

  return candidate;
}

/* --------------------------------------------------------------------------
   07. CARGA ORQUESTADA POR PISTA (PRIORIDAD ESTRICTA DE CARÁTULA DEL TEMA)
   -------------------------------------------------------------------------- */

export async function loadArtwork(track, options = {}) {
  if (!track || typeof track !== 'object') {
    return applyArtwork(null, FALLBACK);
  }

  const key = trackKey(track);
  const currentReqId = ++requestCounter;

  if (
    key &&
    key === activeTrackKey &&
    !options.force &&
    !isLoadingState &&
    activeArtwork !== FALLBACK
  ) {
    return activeArtwork;
  }

  activeTrack = track;
  activeTrackKey = key;
  isLoadingState = true;

  requestController?.abort();
  requestController = new AbortController();

  const signal = options.signal || requestController.signal;
  const targets = imageTargets();
  updateTargetsLifecycle(targets, 'loading');

  let moddedTrack = track;
  try {
    const maybeModded = applyModToTrack(track);
    if (maybeModded && typeof maybeModded === 'object') {
      moddedTrack = maybeModded;
    }
  } catch (err) {
    logDebug('applyModToTrack falló:', err?.message);
  }

  const originalArtwork = normaliseUrl(
    track.artwork ||
    track.thumbnail ||
    track.cover ||
    track.metadata?.artwork ||
    ''
  );

  const trackOverride =
    moddedTrack?.modPackId &&
    validImageUrl(moddedTrack.artwork) &&
    normaliseUrl(moddedTrack.artwork) !== originalArtwork
      ? normaliseUrl(moddedTrack.artwork)
      : '';

  const artistEntry = (() => {
    try {
      return getArtistArtworkEntry(track);
    } catch {
      return null;
    }
  })();

  const isStale = () =>
    currentReqId !== requestCounter ||
    (key && activeTrackKey !== key) ||
    Boolean(signal?.aborted);

  try {
    // 1. Override explícito por mod de canción
    if (validImageUrl(trackOverride)) {
      if (isStale()) return activeArtwork;
      isLoadingState = false;
      return applyArtwork(moddedTrack, trackOverride, { signal });
    }

    // 2. Pintado inicial inmediato si el track ya trae carátula o miniatura
    if (validImageUrl(originalArtwork)) {
      if (isStale()) return activeArtwork;
      applyArtwork(track, originalArtwork, { signal });
    }

    // 3. Metadata específica del track (/api/metadata)
    try {
      const metadata = await getTrackMetadata(track, {
        signal,
        force: Boolean(options.force)
      });

      if (isStale()) return activeArtwork;

      const metaArtwork = normaliseUrl(metadata?.artwork);
      if (validImageUrl(metaArtwork)) {
        const enrichedTrack = {
          ...track,
          metadata: {
            ...(track.metadata && typeof track.metadata === 'object' ? track.metadata : {}),
            ...(metadata && typeof metadata === 'object' ? metadata : {})
          }
        };
        isLoadingState = false;
        return applyArtwork(enrichedTrack, metaArtwork, { signal });
      }
    } catch (error) {
      if (error?.name === 'AbortError' || isStale()) {
        return activeArtwork;
      }
      logDebug('getTrackMetadata sin portada propia:', error?.message);
    }

    // 4. Respaldo de carátula de álbum validada si metadata no devolvió portada
    try {
      const albumArtwork = await fetchAlbumArtwork(track, signal);
      if (isStale()) return activeArtwork;

      if (validImageUrl(albumArtwork)) {
        isLoadingState = false;
        return applyArtwork(track, albumArtwork, { signal });
      }
    } catch (error) {
      if (error?.name === 'AbortError' || isStale()) {
        return activeArtwork;
      }
    }

    // 5. Portada explícita del pack de artista si existe
    if (validImageUrl(artistEntry?.artwork)) {
      if (isStale()) return activeArtwork;
      isLoadingState = false;
      return applyArtwork(track, normaliseUrl(artistEntry.artwork), { signal });
    }

    // 6. Mantener miniatura original del track si existía
    if (validImageUrl(originalArtwork)) {
      isLoadingState = false;
      return applyArtwork(track, originalArtwork, { signal });
    }

    // 7. Último recurso antes de FALLBACK: foto de artista validada
    const artistQueryName = normaliseUrl(artistEntry?.name) || getTrackArtist(track);
    if (artistQueryName) {
      try {
        const artistArtwork = await fetchArtistArtwork(artistQueryName, signal);
        if (isStale()) return activeArtwork;

        if (validImageUrl(artistArtwork)) {
          isLoadingState = false;
          return applyArtwork(track, artistArtwork, { signal });
        }
      } catch (error) {
        if (error?.name === 'AbortError' || isStale()) {
          return activeArtwork;
        }
        logDebug('fetchArtistArtwork sin resultado:', error?.message);
      }
    }

    if (isStale()) return activeArtwork;
    isLoadingState = false;
    return applyArtwork(track, FALLBACK, { signal });
  } finally {
    if (currentReqId === requestCounter) {
      isLoadingState = false;
    }
  }
}

/* --------------------------------------------------------------------------
   08. PRECAGAR SIGUIENTE PORTADA DE COLA (BAJA PRIORIDAD / RESPETANDO SAVEDATA)
   -------------------------------------------------------------------------- */

export function preloadArtwork(url) {
  const safeUrl = normaliseUrl(url);
  if (!validImageUrl(safeUrl) || safeUrl === FALLBACK) return;
  if (!isPersistableUrl(safeUrl)) return;
  if (isDataSaverEnabled()) return;
  if (document.hidden) return;
  if (preloadedUrls.has(safeUrl)) return;

  if (preloadedUrls.size > 60) {
    const first = preloadedUrls.values().next().value;
    preloadedUrls.delete(first);
  }
  preloadedUrls.add(safeUrl);

  const img = new Image();
  img.decoding = 'async';
  img.loading = 'eager';
  img.src = safeUrl;
}

/* --------------------------------------------------------------------------
   09. GESTOS TÁCTILES (PRESS SCALE + SWIPE HORIZONTAL OPCIONAL) Y A11Y
   -------------------------------------------------------------------------- */

function bindArtworkGestures(el) {
  if (!el || gestureState.has(el)) return;

  const state = {
    pointerId: null,
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    moved: false,
    rafId: 0
  };
  gestureState.set(el, state);

  const setScaleRaf = nextVal => {
    if (state.rafId) cancelAnimationFrame(state.rafId);
    state.rafId = requestAnimationFrame(() => {
      state.rafId = 0;
      setGestureScale(el, nextVal);
    });
  };

  const onPointerDown = event => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    state.pointerId = event.pointerId;
    state.startX = event.clientX;
    state.startY = event.clientY;
    state.lastX = event.clientX;
    state.lastY = event.clientY;
    state.moved = false;
    setScaleRaf(isPrimaryArtworkTarget(el) ? 0.975 : 0.95);
  };

  const onPointerMove = event => {
    if (state.pointerId !== event.pointerId) return;
    state.lastX = event.clientX;
    state.lastY = event.clientY;
    const dx = Math.abs(state.lastX - state.startX);
    const dy = Math.abs(state.lastY - state.startY);
    if (dx > 8 || dy > 8) {
      state.moved = true;
    }
  };

  const finishGesture = (event, cancelled = false) => {
    if (state.pointerId !== event.pointerId) return;

    const deltaX = state.lastX - state.startX;
    const deltaY = state.lastY - state.startY;
    const wasSwipeHorizontal =
      !cancelled &&
      Math.abs(deltaX) > 64 &&
      Math.abs(deltaX) > Math.abs(deltaY) * 1.4;

    state.pointerId = null;
    setScaleRaf(1);

    if (wasSwipeHorizontal && el.id === 'fullPlayerThumbnail') {
      document.dispatchEvent(
        new CustomEvent('shunel:artwork-swipe', {
          detail: {
            direction: deltaX < 0 ? 'next' : 'prev',
            deltaX,
            track: activeTrack
          }
        })
      );
    }
  };

  const onPointerUp = event => finishGesture(event, false);
  const onPointerCancel = event => finishGesture(event, true);
  const onPointerLeave = event => {
    if (state.pointerId === event.pointerId) {
      state.pointerId = null;
      setScaleRaf(1);
    }
  };

  const onKeyDown = event => {
    if (!el.hasAttribute('tabindex')) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      el.click();
    }
  };

  el.addEventListener('pointerdown', onPointerDown, { passive: true });
  el.addEventListener('pointermove', onPointerMove, { passive: true });
  el.addEventListener('pointerup', onPointerUp, { passive: true });
  el.addEventListener('pointercancel', onPointerCancel, { passive: true });
  el.addEventListener('pointerleave', onPointerLeave, { passive: true });
  el.addEventListener('keydown', onKeyDown);

  cleanupCallbacks.push(() => {
    if (state.rafId) cancelAnimationFrame(state.rafId);
    el.removeEventListener('pointerdown', onPointerDown);
    el.removeEventListener('pointermove', onPointerMove);
    el.removeEventListener('pointerup', onPointerUp);
    el.removeEventListener('pointercancel', onPointerCancel);
    el.removeEventListener('pointerleave', onPointerLeave);
    el.removeEventListener('keydown', onKeyDown);
  });
}

function attachGesturesToCurrentTargets() {
  for (const target of imageTargets()) {
    bindArtworkGestures(target);
  }
}

/* --------------------------------------------------------------------------
   10. INICIALIZACIÓN, ESTADOS Y LIMPIEZA
   -------------------------------------------------------------------------- */

export function setArtworkPlaybackState(playing) {
  const nextPlaying = Boolean(playing);
  if (nextPlaying === isPlayingState) return;
  isPlayingState = nextPlaying;
  scheduleVisualSync({ isPlaying: isPlayingState });
}

export function resetArtwork() {
  requestController?.abort();
  requestController = null;
  activeTrackKey = '';
  activeTrack = null;
  activeSongColor = DEFAULT_SONG_COLOR;
  isLoadingState = false;

  scheduleVisualSync({
    artworkCss: 'none',
    songColor: DEFAULT_SONG_COLOR,
    secondaryColor: DEFAULT_SECONDARY_COLOR,
    isPlaying: isPlayingState
  });

  return applyArtwork(null, FALLBACK);
}

export function destroyArtwork() {
  while (cleanupCallbacks.length) {
    const fn = cleanupCallbacks.pop();
    try {
      fn();
    } catch {
      /* Ignora error al limpiar. */
    }
  }
  requestController?.abort();
  requestController = null;
  artistRequests.clear();
  albumRequests.clear();
  if (rafScheduled) {
    cancelAnimationFrame(rafScheduled);
    rafScheduled = false;
  }
  initialized = false;
}

export function initArtwork() {
  if (initialized) {
    attachGesturesToCurrentTargets();
    return;
  }

  initialized = true;
  attachGesturesToCurrentTargets();

  const onTrackChange = event => {
    const track = extractTrackFromEvent(event);
    if (track) {
      attachGesturesToCurrentTargets();
      void loadArtwork(track);
    }
  };

  const onPlayRequest = event => {
    const track = extractTrackFromEvent(event);
    if (track) {
      attachGesturesToCurrentTargets();
      void loadArtwork(track);
    }
  };

  const onPlaybackState = event => {
    const detail = event?.detail;
    if (typeof detail?.playing === 'boolean') {
      setArtworkPlaybackState(detail.playing);
    } else if (typeof detail?.isPlaying === 'boolean') {
      setArtworkPlaybackState(detail.isPlaying);
    } else if (typeof detail?.state === 'string') {
      setArtworkPlaybackState(detail.state === 'playing');
    }
  };

  const onModsChanged = () => {
    attachGesturesToCurrentTargets();
    if (activeTrack) {
      void loadArtwork(activeTrack, { force: true });
    }
  };

  const onPreloadNext = event => {
    const nextUrl =
      event?.detail?.artwork ||
      event?.detail?.thumbnail ||
      event?.detail?.track?.artwork ||
      event?.detail?.track?.thumbnail ||
      '';
    if (nextUrl) {
      preloadArtwork(nextUrl);
    }
  };

  const onVisibilityChange = () => {
    if (!document.hidden) {
      attachGesturesToCurrentTargets();
      scheduleVisualSync({
        artworkCss: activeArtwork === FALLBACK ? 'none' : activeArtwork.replace(/["\\\n\r]/g, ''),
        songColor: activeSongColor,
        secondaryColor: DEFAULT_SECONDARY_COLOR,
        isPlaying: isPlayingState
      });
    }
  };

  let reducedMotionMq = null;
  let onMotionChange = null;
  try {
    reducedMotionMq = window.matchMedia('(prefers-reduced-motion: reduce)');
    onMotionChange = () => {
      if (prefersReducedMotion()) {
        for (const el of imageTargets()) {
          setGestureScale(el, 1);
        }
      }
    };
    if (typeof reducedMotionMq.addEventListener === 'function') {
      reducedMotionMq.addEventListener('change', onMotionChange);
    } else if (typeof reducedMotionMq.addListener === 'function') {
      reducedMotionMq.addListener(onMotionChange);
    }
  } catch {
    /* Ignora si matchMedia no está disponible. */
  }

  document.addEventListener('shunel:track-change', onTrackChange);
  document.addEventListener('shunel:play-request', onPlayRequest);
  document.addEventListener('shunel:playback-state', onPlaybackState);
  document.addEventListener('shunel:mods-changed', onModsChanged);
  document.addEventListener('shunel:preload-artwork', onPreloadNext);
  document.addEventListener('visibilitychange', onVisibilityChange);

  cleanupCallbacks.push(() => {
    document.removeEventListener('shunel:track-change', onTrackChange);
    document.removeEventListener('shunel:play-request', onPlayRequest);
    document.removeEventListener('shunel:playback-state', onPlaybackState);
    document.removeEventListener('shunel:mods-changed', onModsChanged);
    document.removeEventListener('shunel:preload-artwork', onPreloadNext);
    document.removeEventListener('visibilitychange', onVisibilityChange);

    if (reducedMotionMq && onMotionChange) {
      if (typeof reducedMotionMq.removeEventListener === 'function') {
        reducedMotionMq.removeEventListener('change', onMotionChange);
      } else if (typeof reducedMotionMq.addListener === 'function') {
        reducedMotionMq.removeListener(onMotionChange);
      }
    }
  });
}
