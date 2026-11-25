
/* =========================================================
   SHUNEL — ARTWORK ENGINE v5.0
   Frontend ES Module
   iOS Safari / PWA

   Fuentes:
   - Mods del usuario
   - MusicBrainz / Cover Art Archive
   - iTunes Search API
   - Deezer Artist API
   - YouTube thumbnail
   - Fallback local

   Integraciones:
   - ./metadata.js
   - ./mods.js

   API pública conservada:
   - applyArtwork
   - cleanQueryTitle
   - preloadArtwork
   - loadArtwork
   - setArtworkPlaybackState
   - resetArtwork
   - destroyArtwork
   - initArtwork
   - getArtworkState

   Nota:
   Los cambios visuales que requieren CSS o HTML no se
   simulan desde JavaScript. Este motor se encarga de la
   lógica, las imágenes, las peticiones y el estado.
   ========================================================= */

import { getTrackMetadata } from './metadata.js';

import {
  applyModToTrack,
  getArtistArtworkEntry
} from './mods.js';

/* =========================================================
   CONFIGURACIÓN
   ========================================================= */

const VERSION = '5.0';

const FALLBACK_ARTWORK = '/assets/logo.png';

const ARTIST_CACHE_KEY = 'shunel_artist_artwork_v5';

const LEGACY_ARTIST_CACHE_KEY =
  'shunel_artist_artwork_v4';

const ARTIST_CACHE_TTL =
  10 * 24 * 60 * 60 * 1000;

const ARTIST_CACHE_LIMIT = 90;

const COLOR_CACHE_LIMIT = 100;

const ARTWORK_TIMEOUT = 6500;

const METADATA_TIMEOUT = 8000;

const COLOR_TIMEOUT = 900;

const IMAGE_TIMEOUT = 6500;

const ITUNES_ENDPOINT =
  'https://itunes.apple.com/search';

const DEEZER_ENDPOINT =
  'https://proxy.cors.dev/https://api.deezer.com';

const IMAGE_SOURCE_PRIORITY = Object.freeze({
  mod: 100,
  'musicbrainz-cover-art-archive': 90,
  itunes: 80,
  artist: 60,
  'youtube-thumbnail': 20,
  fallback: 0
});

const SOURCE_REGISTRY = Object.freeze({
  mod: {
    priority: 100,
    label: 'Mod personalizado'
  },

  'musicbrainz-cover-art-archive': {
    priority: 90,
    label: 'MusicBrainz'
  },

  itunes: {
    priority: 80,
    label: 'iTunes'
  },

  artist: {
    priority: 60,
    label: 'Artista'
  },

  'youtube-thumbnail': {
    priority: 20,
    label: 'YouTube'
  },

  fallback: {
    priority: 0,
    label: 'Imagen predeterminada'
  }
});

const RETRY_CONFIG = Object.freeze({
  attempts: 2,
  baseDelay: 350,
  maxDelay: 1200
});

const CIRCUIT_CONFIG = Object.freeze({
  failureThreshold: 3,
  cooldown: 30000
});

/* =========================================================
   ESTADO
   ========================================================= */

let activeTrack = null;

let activeArtwork = '';

let activeArtworkSource = 'fallback';

let activeAppliedPriority = -1;

let activeRequestId = 0;

let activeRequestKey = '';

let activeController = null;

let activeColorController = null;

let activeColorKey = '';

let activeSongColor = null;

let activeSecondaryColor = null;

let isPlaying = false;

let initialized = false;

let destroyed = false;

let visualRafId = 0;

let gestureScale = 1;

let songColorCache = new Map();

let albumRequests = new Map();

let artistRequests = new Map();

let preloadRequests = new Map();

let imageListeners = new WeakMap();

let pointerStates = new WeakMap();

const visualElements = new Set();

let boundEvents = [];

let mutationObserver = null;

let lastArtworkUpdate = 0;

let lastColorUpdate = 0;

let activeLoadStartedAt = 0;

let metrics = {
  requests: 0,
  successful: 0,
  failed: 0,
  cancelled: 0,
  cacheHits: 0,
  imageFailures: 0,
  sourceUsage: {},
  lastDuration: 0,
  averageDuration: 0
};

const circuitBreakers = new Map();

/* =========================================================
   UTILIDADES GENERALES
   ========================================================= */

function clean(value, max = 220) {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'object'
  ) {
    return '';
  }

  return String(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\$/g, 's')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeArtist(value) {
  return normalizeText(value)
    .replace(
      /\b(?:official|topic|vevo|music|records?|tv|channel|hd|hq)\b/g,
      ' '
    )
    .replace(/\s+/g, ' ')
    .trim();
}

function isObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  );
}

function now() {
  return Date.now();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function isBrowser() {
  return (
    typeof window !== 'undefined' &&
    typeof document !== 'undefined'
  );
}

/* =========================================================
   VALIDACIÓN DE URLS
   ========================================================= */

function isValidImageUrl(value) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    !isBrowser()
  ) {
    return false;
  }

  try {
    const url = new URL(
      value.trim(),
      window.location.origin
    );

    if (
      url.username ||
      url.password
    ) {
      return false;
    }

    if (
      url.protocol !== 'https:' &&
      url.origin !== window.location.origin
    ) {
      return false;
    }

    if (
      url.protocol !== 'https:' &&
      url.protocol !== 'http:'
    ) {
      return false;
    }

    if (
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '::1'
    ) {
      return url.origin === window.location.origin;
    }

    return true;
  } catch {
    return false;
  }
}

function normalizeImageUrl(value) {
  const url = clean(value, 2000);

  if (!isValidImageUrl(url)) {
    return '';
  }

  try {
    return new URL(
      url,
      window.location.origin
    ).href;
  } catch {
    return '';
  }
}

/* =========================================================
   ERRORES Y EVENTOS
   ========================================================= */

function createAbortError(message = 'Artwork request cancelled.') {
  const error = new Error(message);

  error.name = 'AbortError';

  return error;
}

function isAbortError(error) {
  return (
    error?.name === 'AbortError' ||
    error?.code === 'ABORT_ERR'
  );
}

function safeDispatch(name, detail = {}) {
  if (!isBrowser()) {
    return;
  }

  try {
    window.dispatchEvent(
      new CustomEvent(name, {
        detail: {
          version: VERSION,
          timestamp: now(),
          ...detail
        }
      })
    );
  } catch {
    // Un evento nunca debe interrumpir el reproductor.
  }
}

function reportError(error, context = '') {
  if (isAbortError(error)) {
    return;
  }

  safeDispatch(
    'shunel:artwork-error',
    {
      context,
      message: clean(error?.message || 'Unknown error', 300)
    }
  );
}

/* =========================================================
   INFORMACIÓN DE PISTA
   ========================================================= */

function getArtist(track) {
  return clean(
    track?.artist ||
    track?.artistName ||
    track?.channelTitle ||
    track?.metadata?.artist ||
    '',
    200
  );
}

function getTitle(track) {
  return clean(
    track?.title ||
    track?.name ||
    track?.trackName ||
    track?.videoTitle ||
    '',
    240
  );
}

function getAlbum(track) {
  return clean(
    track?.album ||
    track?.metadata?.album ||
    '',
    180
  );
}

/* =========================================================
   NORMALIZACIÓN DE TÍTULOS
   ========================================================= */

export function cleanQueryTitle(rawTitle, rawArtist = '') {
  const original = clean(rawTitle, 260);

  let title = original;

  const artist = clean(rawArtist, 200);

  if (artist) {
    const variants = [
      artist,
      ...artist.split(
        /\s*(?:,|&|\+|\/|\bfeat\.?\b|\bft\.?\b|\bwith\b|\bx\b|\band\b|\by\b)\s*/i
      )
    ]
      .map(value => clean(value, 120))
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);

    for (const variant of variants) {
      const escaped = variant.replace(
        /[.*+?^${}()|[\]\\]/g,
        '\\$&'
      );

      const expression = new RegExp(
        '^' + escaped + '\\s*[-–—:|/]+\\s*',
        'i'
      );

      if (expression.test(title)) {
        title = title.replace(expression, '').trim();
        break;
      }
    }
  }

  const separator = title.match(
    /\s+(?:\||｜|I)\s+(?=[A-ZÁÉÍÓÚÑ0-9])/
  );

  let album = '';

  if (separator) {
    album = title
      .slice(separator.index + separator[0].length)
      .trim();

    title = title
      .slice(0, separator.index)
      .trim();
  }

  const decorations = [
    'official',
    'video',
    'video oficial',
    'audio',
    'audio oficial',
    'lyrics?',
    'lyric video',
    'visualizer',
    'official visualizer',
    'official audio',
    'official video',
    'remastered',
    'remaster',
    'live',
    'acoustic',
    'instrumental',
    'explicit',
    'clean',
    'version',
    'edit',
    'radio edit',
    'mix',
    'hd',
    '4k'
  ].join('|');

  const bracketRegex = new RegExp(
    '\\s*[\\[(][^\\])]*\\b(?:' +
    decorations +
    ')\\b[^\\])]*[\\])]',
    'gi'
  );

  title = title.replace(bracketRegex, ' ');

  title = title.replace(
    /\s+(?:official\s*(?:video|audio|visualizer|lyric\s*video)|video\s*oficial|audio\s*oficial|visualizer|lyrics?|letra\s*oficial)\s*$/i,
    ''
  );

  title = title
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—:|]+|[\s\-–—:|]+$/g, '')
    .trim();

  return {
    title: title || original,
    album,
    originalTitle: original
  };
}

/* =========================================================
   IDENTIDAD DE PISTA
   ========================================================= */

function getTrackKey(track) {
  const identity = cleanQueryTitle(
    getTitle(track),
    getArtist(track)
  );

  const parts = [
    normalizeText(identity.title),
    normalizeArtist(getArtist(track)),
    normalizeText(identity.album || getAlbum(track))
  ];

  if (!parts.some(Boolean)) {
    return '';
  }

  return parts.join('::');
}

/* =========================================================
   SELECTORES
   ========================================================= */

const ARTWORK_SELECTOR = [
  '#currentThumbnail',
  '#fullPlayerThumbnail',
  '.current-art',
  '.full-player-art',
  '.mini-player-art',
  '[data-shunel-artwork]'
].join(',');

function getArtworkElements() {
  if (!isBrowser()) {
    return [];
  }

  return [
    ...document.querySelectorAll(ARTWORK_SELECTOR)
  ];
}

/* =========================================================
   CACHE DE ARTISTAS
   ========================================================= */

function getStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readArtistCache() {
  const storage = getStorage();

  if (!storage) {
    return {};
  }

  try {
    let raw = storage.getItem(ARTIST_CACHE_KEY);

    /*
     * Migración de la caché v4.
     */

    if (!raw) {
      raw = storage.getItem(LEGACY_ARTIST_CACHE_KEY);
    }

    if (!raw) {
      return {};
    }

    const data = JSON.parse(raw);

    if (!isObject(data)) {
      return {};
    }

    const timestamp = now();
    const valid = {};

    for (const [key, entry] of Object.entries(data)) {
      if (
        !isObject(entry) ||
        !isValidImageUrl(entry.url) ||
        !Number.isFinite(entry.expiresAt) ||
        entry.expiresAt <= timestamp
      ) {
        continue;
      }

      valid[key] = {
        url: normalizeImageUrl(entry.url),
        savedAt: Number(entry.savedAt) || timestamp,
        expiresAt: entry.expiresAt
      };
    }

    return valid;
  } catch {
    return {};
  }
}

function writeArtistCache(data) {
  const storage = getStorage();

  if (!storage) {
    return;
  }

  try {
    const entries = Object.entries(data)
      .sort(
        (a, b) =>
          (b[1]?.savedAt || 0) -
          (a[1]?.savedAt || 0)
      )
      .slice(0, ARTIST_CACHE_LIMIT);

    storage.setItem(
      ARTIST_CACHE_KEY,
      JSON.stringify(
        Object.fromEntries(entries)
      )
    );
  } catch {
    // La caché no es obligatoria.
  }
}

function getCachedArtistArtwork(artist) {
  const key = normalizeArtist(artist);

  if (!key) {
    return '';
  }

  const cache = readArtistCache();
  const entry = cache[key];

  if (!entry) {
    return '';
  }

  /*
   * Actualizar la fecha para mantener los más usados.
   */

  entry.savedAt = now();

  writeArtistCache(cache);

  metrics.cacheHits++;

  return entry.url;
}

function saveArtistArtwork(artist, url) {
  const key = normalizeArtist(artist);
  const normalizedUrl = normalizeImageUrl(url);

  if (!key || !normalizedUrl) {
    return;
  }

  const cache = readArtistCache();

  cache[key] = {
    url: normalizedUrl,
    savedAt: now(),
    expiresAt: now() + ARTIST_CACHE_TTL
  };

  writeArtistCache(cache);
}

/* =========================================================
   CACHE LRU DE COLORES
   ========================================================= */

function getCachedSongColor(key) {
  if (!key || !songColorCache.has(key)) {
    return null;
  }

  const value = songColorCache.get(key);

  /*
   * Mover al final: política LRU real.
   */

  songColorCache.delete(key);
  songColorCache.set(key, value);

  metrics.cacheHits++;

  return value;
}

function saveSongColor(key, color) {
  if (!key || !color) {
    return;
  }

  if (songColorCache.has(key)) {
    songColorCache.delete(key);
  }

  songColorCache.set(key, color);

  while (songColorCache.size > COLOR_CACHE_LIMIT) {
    const oldest = songColorCache.keys().next().value;

    songColorCache.delete(oldest);
  }
}

/* =========================================================
   MODS
   ========================================================= */

function getTrackMod(track) {
  try {
    const result = applyModToTrack(track);

    if (!isObject(result)) {
      return null;
    }

    const artwork = clean(
      result.artwork ||
      result.cover ||
      result.thumbnail ||
      result.image ||
      result.metadata?.artwork ||
      '',
      1000
    );

    const normalizedUrl = normalizeImageUrl(artwork);

    if (!normalizedUrl) {
      return null;
    }

    return {
      artwork: normalizedUrl,
      track: result
    };
  } catch {
    return null;
  }
}

function getExplicitModArtwork(track) {
  return getTrackMod(track)?.artwork || '';
}

function getArtistModArtwork(artist) {
  if (!artist) {
    return '';
  }

  try {
    const entry = getArtistArtworkEntry(artist);

    if (!isObject(entry)) {
      return '';
    }

    const url = clean(
      entry.artwork ||
      entry.cover ||
      entry.thumbnail ||
      entry.image ||
      entry.url ||
      '',
      1000
    );

    return normalizeImageUrl(url);
  } catch {
    return '';
  }
}

/* =========================================================
   CANCELACIÓN SEGURA
   ========================================================= */

function raceWithSignal(promise, signal) {
  if (!signal) {
    return promise;
  }

  if (signal.aborted) {
    return Promise.reject(createAbortError());
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(createAbortError());
    };

    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
    };

    signal.addEventListener(
      'abort',
      onAbort,
      { once: true }
    );

    promise.then(
      value => {
        cleanup();
        resolve(value);
      },
      error => {
        cleanup();
        reject(error);
      }
    );
  });
}

/* =========================================================
   PETICIONES COMPARTIDAS
   ========================================================= */

function getSharedRequest(map, key, factory, signal) {
  if (!key) {
    return Promise.resolve(null);
  }

  if (signal?.aborted) {
    return Promise.reject(createAbortError());
  }

  let entry = map.get(key);

  if (!entry) {
    const controller = new AbortController();

    entry = {
      controller,
      users: 0,
      settled: false,
      promise: null
    };

    const currentEntry = entry;

    entry.promise = Promise.resolve()
      .then(() => factory(controller.signal))
      .finally(() => {
        currentEntry.settled = true;

        if (map.get(key) === currentEntry) {
          map.delete(key);
        }
      });

    map.set(key, entry);
  }

  entry.users++;

  const currentEntry = entry;

  return raceWithSignal(
    entry.promise,
    signal
  ).finally(() => {
    currentEntry.users = Math.max(
      0,
      currentEntry.users - 1
    );

    /*
     * Si ningún consumidor necesita la petición,
     * cancelar el trabajo compartido.
     */

    if (
      currentEntry.users === 0 &&
      !currentEntry.settled
    ) {
      currentEntry.controller.abort();
    }
  });
}

/* =========================================================
   CIRCUIT BREAKER Y PETICIONES HTTP
   ========================================================= */

function getCircuitState(origin) {
  if (!circuitBreakers.has(origin)) {
    circuitBreakers.set(origin, {
      failures: 0,
      blockedUntil: 0
    });
  }

  return circuitBreakers.get(origin);
}

function assertCircuitAvailable(origin) {
  const state = getCircuitState(origin);

  if (state.blockedUntil > now()) {
    throw new Error(
      'Artwork source temporarily unavailable.'
    );
  }

  if (state.blockedUntil && state.blockedUntil <= now()) {
    state.failures = 0;
    state.blockedUntil = 0;
  }
}

function registerCircuitSuccess(origin) {
  const state = getCircuitState(origin);

  state.failures = 0;
  state.blockedUntil = 0;
}

function registerCircuitFailure(origin) {
  const state = getCircuitState(origin);

  state.failures++;

  if (
    state.failures >= CIRCUIT_CONFIG.failureThreshold
  ) {
    state.blockedUntil =
      now() + CIRCUIT_CONFIG.cooldown;
  }
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(createAbortError());
    };

    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
    };

    signal?.addEventListener(
      'abort',
      onAbort,
      { once: true }
    );
  });
}

async function fetchJSON(
  url,
  options = {}
) {
  const signal = options.signal;
  const timeout = options.timeout || ARTWORK_TIMEOUT;
  const attempts = options.attempts ?? RETRY_CONFIG.attempts;

  const parsedUrl = new URL(url);

  const origin = parsedUrl.origin;

  assertCircuitAvailable(origin);

  let lastError = null;

  for (
    let attempt = 0;
    attempt <= attempts;
    attempt++
  ) {
    if (signal?.aborted) {
      throw createAbortError();
    }

    const controller = new AbortController();

    let timeoutId = null;

    const relayAbort = () => controller.abort();

    signal?.addEventListener(
      'abort',
      relayAbort,
      { once: true }
    );

    try {
      timeoutId = setTimeout(
        () => controller.abort(),
        timeout
      );

      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          Accept: 'application/json'
        },
        cache: options.cache || 'default'
      });

      if (!response.ok) {
        const error = new Error(
          'HTTP ' + response.status
        );

        error.status = response.status;

        throw error;
      }

      const data = await response.json();

      registerCircuitSuccess(origin);

      return data;
    } catch (error) {
      if (signal?.aborted) {
        throw createAbortError();
      }

      lastError = error;

      const status = Number(error?.status || 0);

      const retryable =
        !status ||
        status === 408 ||
        status === 429 ||
        status >= 500;

      if (!retryable || attempt >= attempts) {
        break;
      }

      const backoff = Math.min(
        RETRY_CONFIG.baseDelay * (2 ** attempt),
        RETRY_CONFIG.maxDelay
      );

      try {
        await delay(backoff, signal);
      } catch {
        throw createAbortError();
      }
    } finally {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }

      signal?.removeEventListener(
        'abort',
        relayAbort
      );
    }
  }

  registerCircuitFailure(origin);

  throw lastError || new Error('Artwork request failed.');
}

/* =========================================================
   CARGA Y VALIDACIÓN DE IMÁGENES
   ========================================================= */

function loadImage(url, options = {}) {
  return new Promise((resolve, reject) => {
    const normalizedUrl = normalizeImageUrl(url);

    if (!normalizedUrl) {
      reject(new Error('Invalid artwork URL.'));
      return;
    }

    const signal = options.signal;

    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }

    const image = new Image();

    image.decoding = 'async';

    if (options.crossOrigin !== false) {
      image.crossOrigin = 'anonymous';
    }

    let finished = false;

    const timeoutMs =
      options.timeout || IMAGE_TIMEOUT;

    let timeoutId = null;

    const cleanup = () => {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }

      signal?.removeEventListener(
        'abort',
        onAbort
      );

      image.onload = null;
      image.onerror = null;
    };

    const finish = (callback, value) => {
      if (finished) {
        return;
      }

      finished = true;

      cleanup();

      callback(value);
    };

    const onAbort = () => {
      finish(
        reject,
        createAbortError()
      );

      /*
       * Liberar la descarga cuando Safari lo permita.
       */

      try {
        image.src = '';
      } catch {
        // Ignorar errores de limpieza.
      }
    };

    timeoutId = setTimeout(() => {
      finish(
        reject,
        new Error('Artwork image timeout.')
      );

      try {
        image.src = '';
      } catch {
        // Ignorar.
      }
    }, timeoutMs);

    signal?.addEventListener(
      'abort',
      onAbort,
      { once: true }
    );

    image.onload = async () => {
      if (finished) {
        return;
      }

      try {
        if (
          image.decode &&
          options.decode !== false
        ) {
          await image.decode().catch(() => {});
        }

        if (
          !image.naturalWidth ||
          !image.naturalHeight
        ) {
          throw new Error('Invalid image dimensions.');
        }

        finish(resolve, image);
      } catch (error) {
        finish(reject, error);
      }
    };

    image.onerror = () => {
      metrics.imageFailures++;

      finish(
        reject,
        new Error('Artwork image failed.')
      );
    };

    image.src = normalizedUrl;

    if (image.complete && image.naturalWidth > 0) {
      image.onload?.();
    }
  });
}

async function verifyArtwork(url, signal) {
  const normalizedUrl = normalizeImageUrl(url);

  if (!normalizedUrl) {
    return false;
  }

  try {
    await loadImage(normalizedUrl, {
      signal,
      timeout: IMAGE_TIMEOUT,
      crossOrigin: true
    });

    return true;
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }

    return false;
  }
}

/* =========================================================
   APLICAR IMAGEN AL DOM
   ========================================================= */

function updateArtworkAttributes(element, source) {
  if (!element) {
    return;
  }

  element.dataset.shunelArtworkSource = source;

  element.setAttribute(
    'aria-label',
    'Portada del contenido musical'
  );

  element.setAttribute(
    'role',
    element.getAttribute('role') || 'img'
  );
}

function setArtworkImage(element, url) {
  if (!element || !url) {
    return;
  }

  const tag = element.tagName?.toLowerCase();

  if (tag === 'img') {
    if (element.src !== url) {
      element.src = url;
    }

    element.alt =
      element.alt || 'Portada de la canción';

    element.loading = 'eager';
    element.decoding = 'async';

    return;
  }

  /*
   * Asignar la URL mediante CSSStyleDeclaration
   * evita construir una cadena CSS manualmente.
   */

  element.style.backgroundImage = `url(${JSON.stringify(url)})`;
}

function updateArtworkCss(url) {
  if (!isBrowser()) {
    return;
  }

  const root = document.documentElement;

  if (!url) {
    root.style.removeProperty('--shunel-artwork');
    return;
  }

  root.style.setProperty(
    '--shunel-artwork',
    `url(${JSON.stringify(url)})`
  );
}

function applyArtworkToElements(url, source) {
  for (const element of getArtworkElements()) {
    setArtworkImage(element, url);

    updateArtworkAttributes(
      element,
      source
    );

    element.classList.add('has-artwork');

    element.classList.remove(
      'artwork-loading',
      'artwork-failed'
    );
  }

  updateArtworkCss(url);
}

function getSourcePriority(source) {
  return (
    IMAGE_SOURCE_PRIORITY[source] ??
    IMAGE_SOURCE_PRIORITY.fallback
  );
}

/* =========================================================
   COLOR DOMINANTE
   ========================================================= */

function colorFromImage(image) {
  if (!isBrowser()) {
    return null;
  }

  const canvas = document.createElement('canvas');

  canvas.width = 24;
  canvas.height = 24;

  const context = canvas.getContext('2d', {
    willReadFrequently: true
  });

  if (!context) {
    return null;
  }

  try {
    context.drawImage(
      image,
      0,
      0,
      canvas.width,
      canvas.height
    );

    const pixels = context.getImageData(
      0,
      0,
      canvas.width,
      canvas.height
    ).data;

    let red = 0;
    let green = 0;
    let blue = 0;
    let count = 0;

    for (
      let index = 0;
      index < pixels.length;
      index += 4
    ) {
      const alpha = pixels[index + 3];

      if (alpha < 100) {
        continue;
      }

      const r = pixels[index];
      const g = pixels[index + 1];
      const b = pixels[index + 2];

      const brightness = (r + g + b) / 3;

      if (
        brightness < 18 ||
        brightness > 245
      ) {
        continue;
      }

      red += r;
      green += g;
      blue += b;

      count++;
    }

    if (!count) {
      return null;
    }

    const r = Math.round(red / count);
    const g = Math.round(green / count);
    const b = Math.round(blue / count);

    return {
      primary: `rgb(${r}, ${g}, ${b})`,
      secondary: `rgba(${r}, ${g}, ${b}, 0.32)`,
      rgb: [r, g, b]
    };
  } catch {
    /*
     * Algunos servidores no permiten leer píxeles
     * por CORS. La portada sigue funcionando.
     */

    return null;
  }
}

function setSongColors(color) {
  if (!color || !isBrowser()) {
    return;
  }

  activeSongColor = color.primary;
  activeSecondaryColor = color.secondary;

  const root = document.documentElement;

  root.style.setProperty(
    '--song-color',
    color.primary
  );

  root.style.setProperty(
    '--shunel-song-secondary',
    color.secondary
  );

  lastColorUpdate = now();

  safeDispatch(
    'shunel:artwork-color-updated',
    {
      color: color.primary,
      secondary: color.secondary,
      rgb: color.rgb
    }
  );
}

async function extractDominantSongColor(
  url,
  key,
  requestId,
  signal
) {
  if (!url || !key) {
    return null;
  }

  const cached = getCachedSongColor(key);

  if (cached) {
    if (isCurrentRequest(requestId, key)) {
      setSongColors(cached);
    }

    return cached;
  }

  try {
    const image = await loadImage(url, {
      timeout: COLOR_TIMEOUT,
      crossOrigin: true,
      signal
    });

    if (!isCurrentRequest(requestId, key)) {
      return null;
    }

    const color = colorFromImage(image);

    if (!color) {
      return null;
    }

    saveSongColor(key, color);

    if (isCurrentRequest(requestId, key)) {
      setSongColors(color);
    }

    return color;
  } catch (error) {
    if (!isAbortError(error)) {
      safeDispatch(
        'shunel:artwork-color-error',
        {
          artwork: url,
          message: clean(error?.message || '', 200)
        }
      );
    }

    return null;
  }
}

function cancelColorRequest() {
  if (activeColorController) {
    activeColorController.abort();
    activeColorController = null;
  }
}

function resolveSongColorWithBudget(
  url,
  key,
  requestId
) {
  cancelColorRequest();

  const controller = new AbortController();

  activeColorController = controller;

  return extractDominantSongColor(
    url,
    key,
    requestId,
    controller.signal
  ).finally(() => {
    if (activeColorController === controller) {
      activeColorController = null;
    }
  });
}

/* =========================================================
   APLICAR PORTADA
   ========================================================= */

export function applyArtwork(url, options = {}) {
  const normalizedUrl = normalizeImageUrl(url);

  if (!normalizedUrl) {
    return false;
  }

  const source = clean(
    options.source || 'fallback',
    80
  );

  const force = Boolean(options.force);

  const priority = getSourcePriority(source);

  /*
   * Si se proporciona una solicitud, impedir que
   * una respuesta antigua cambie la portada actual.
   */

  if (
    options.requestId !== undefined &&
    options.requestId !== activeRequestId
  ) {
    return false;
  }

  if (
    options.requestKey !== undefined &&
    options.requestKey !== activeRequestKey
  ) {
    return false;
  }

  /*
   * La prioridad se reinicia por pista.
   * No se compara con la prioridad de la canción anterior.
   */

  if (
    !force &&
    priority < activeAppliedPriority
  ) {
    return false;
  }

  if (
    activeArtwork === normalizedUrl &&
    activeArtworkSource === source
  ) {
    return true;
  }

  activeArtwork = normalizedUrl;

  activeArtworkSource = source;

  activeAppliedPriority = priority;

  applyArtworkToElements(
    normalizedUrl,
    source
  );

  lastArtworkUpdate = now();

  metrics.sourceUsage[source] =
    (metrics.sourceUsage[source] || 0) + 1;

  safeDispatch(
    'shunel:artwork-updated',
    {
      artwork: normalizedUrl,
      source,
      sourceLabel: SOURCE_REGISTRY[source]?.label || source,
      track: activeTrack,
      requestId: activeRequestId
    }
  );

  if (options.extractColor !== false) {
    resolveSongColorWithBudget(
      normalizedUrl,
      activeRequestKey,
      activeRequestId
    );
  }

  return true;
}

/* =========================================================
   YOUTUBE Y FALLBACK
   ========================================================= */

function getYouTubeThumbnail(track) {
  const explicit = clean(
    track?.thumbnail ||
    track?.thumbnails?.high?.url ||
    track?.thumbnails?.medium?.url ||
    track?.snippet?.thumbnails?.high?.url ||
    '',
    1000
  );

  const normalizedExplicit =
    normalizeImageUrl(explicit);

  if (normalizedExplicit) {
    return normalizedExplicit;
  }

  const videoId = clean(
    track?.videoId ||
    track?.id?.videoId ||
    track?.youtubeId ||
    '',
    100
  );

  if (
    videoId &&
    /^[a-zA-Z0-9_-]{11}$/.test(videoId)
  ) {
    return (
      'https://i.ytimg.com/vi/' +
      videoId +
      '/hqdefault.jpg'
    );
  }

  return '';
}

function applyFallback(track, requestId, key) {
  const youtube = getYouTubeThumbnail(track);

  if (youtube) {
    return applyArtwork(
      youtube,
      {
        source: 'youtube-thumbnail',
        force: true,
        requestId,
        requestKey: key
      }
    );
  }

  return applyArtwork(
    FALLBACK_ARTWORK,
    {
      source: 'fallback',
      force: true,
      extractColor: false,
      requestId,
      requestKey: key
    }
  );
}

/* =========================================================
   PUNTUACIÓN DE RESULTADOS
   ========================================================= */

function tokenSimilarity(a, b) {
  const first = new Set(
    normalizeText(a).split(' ').filter(Boolean)
  );

  const second = new Set(
    normalizeText(b).split(' ').filter(Boolean)
  );

  if (!first.size || !second.size) {
    return 0;
  }

  let intersection = 0;

  for (const token of first) {
    if (second.has(token)) {
      intersection++;
    }
  }

  return (
    intersection /
    Math.max(first.size, second.size)
  );
}

function scoreCandidate(
  result,
  identity,
  artist,
  albumHint
) {
  const title = normalizeText(
    result?.trackName ||
    result?.collectionName ||
    ''
  );

  const expectedTitle = normalizeText(
    identity.title
  );

  const candidateArtist = normalizeArtist(
    result?.artistName
  );

  const expectedArtist = normalizeArtist(
    artist
  );

  const candidateAlbum = normalizeText(
    result?.collectionName
  );

  const expectedAlbum = normalizeText(
    albumHint
  );

  if (!title || !expectedTitle) {
    return -1000;
  }

  const similarity = tokenSimilarity(
    title,
    expectedTitle
  );

  let score = 0;

  if (title === expectedTitle) {
    score += 100;
  } else if (
    title.includes(expectedTitle) ||
    expectedTitle.includes(title)
  ) {
    score += 55;
  } else if (similarity >= 0.75) {
    score += Math.round(similarity * 60);
  } else {
    return -1000;
  }

  if (expectedArtist) {
    if (candidateArtist === expectedArtist) {
      score += 65;
    } else if (
      candidateArtist.includes(expectedArtist) ||
      expectedArtist.includes(candidateArtist)
    ) {
      score += 35;
    } else if (
      tokenSimilarity(candidateArtist, expectedArtist) >= 0.7
    ) {
      score += 20;
    } else {
      score -= 50;
    }
  }

  if (expectedAlbum) {
    if (candidateAlbum === expectedAlbum) {
      score += 45;
    } else if (
      candidateAlbum.includes(expectedAlbum) ||
      expectedAlbum.includes(candidateAlbum)
    ) {
      score += 25;
    }
  }

  const collectionType = String(
    result?.collectionType || ''
  ).toLowerCase();

  if (collectionType === 'album') {
    score += 12;
  } else if (collectionType === 'single') {
    score += 8;
  }

  if (
    result?.artworkUrl100 ||
    result?.artworkUrl60
  ) {
    score += 20;
  }

  return score;
}

/* =========================================================
   iTUNES
   ========================================================= */

function upgradeArtworkUrl(url) {
  if (!url) {
    return '';
  }

  return String(url)
    .replace(
      /\/[0-9]+x[0-9]+bb\./i,
      '/1000x1000bb.'
    )
    .replace(
      /\/[0-9]+x[0-9]+bb-/i,
      '/1000x1000bb-'
    );
}

async function searchITunes(track, signal) {
  const artist = getArtist(track);

  const identity = cleanQueryTitle(
    getTitle(track),
    artist
  );

  if (!identity.title) {
    return null;
  }

  const query = [
    artist,
    identity.title
  ]
    .filter(Boolean)
    .join(' ');

  const url = new URL(ITUNES_ENDPOINT);

  url.search = new URLSearchParams({
    term: query,
    entity: 'song',
    limit: '20',
    media: 'music',
    country: 'US'
  }).toString();

  const data = await fetchJSON(
    url.toString(),
    {
      signal,
      timeout: ARTWORK_TIMEOUT
    }
  );

  if (!Array.isArray(data?.results)) {
    return null;
  }

  const ranked = data.results
    .map(result => ({
      result,
      score: scoreCandidate(
        result,
        identity,
        artist,
        identity.album || getAlbum(track)
      )
    }))
    .filter(item => item.score >= 100)
    .sort((a, b) => b.score - a.score);

  for (const item of ranked) {
    const artwork = normalizeImageUrl(
      upgradeArtworkUrl(
        item.result?.artworkUrl100 ||
        item.result?.artworkUrl60
      )
    );

    if (!artwork) {
      continue;
    }

    return {
      artwork,
      score: item.score,
      album: clean(
        item.result.collectionName,
        180
      ),
      artist: clean(
        item.result.artistName,
        180
      ),
      source: 'itunes'
    };
  }

  return null;
}

/* =========================================================
   DEEZER / PORTADA DE ARTISTA
   ========================================================= */

async function searchDeezerArtist(artist, signal) {
  const normalized = normalizeArtist(artist);

  if (!normalized) {
    return '';
  }

  const cached = getCachedArtistArtwork(artist);

  if (cached) {
    return cached;
  }

  return getSharedRequest(
    artistRequests,
    normalized,
    async sharedSignal => {
      const url =
        DEEZER_ENDPOINT +
        '/search/artist?' +
        new URLSearchParams({
          q: artist,
          limit: '5'
        });

      const data = await fetchJSON(
        url,
        {
          signal: sharedSignal,
          timeout: ARTWORK_TIMEOUT
        }
      );

      const artists = Array.isArray(data?.data)
        ? data.data
        : [];

      const match = artists.find(item => {
        return (
          normalizeArtist(item?.name) === normalized
        );
      }) || artists[0];

      const artwork = normalizeImageUrl(
        match?.picture_xl ||
        match?.picture_big ||
        match?.picture_medium ||
        ''
      );

      if (artwork) {
        saveArtistArtwork(artist, artwork);
      }

      return artwork;
    },
    signal
  );
}

/* =========================================================
   MUSICBRAINZ / COVER ART ARCHIVE
   ========================================================= */

async function searchMusicMetadata(track, signal) {
  const metadata = await getTrackMetadata(
    track,
    {
      signal,
      timeout: METADATA_TIMEOUT
    }
  );

  if (
    !metadata ||
    !isValidImageUrl(metadata.artwork)
  ) {
    return null;
  }

  return {
    artwork: normalizeImageUrl(metadata.artwork),
    album: clean(metadata.album || '', 180),
    artist: clean(metadata.artist || '', 180),
    source: 'musicbrainz-cover-art-archive'
  };
}

/* =========================================================
   DEDUPLICACIÓN DE METADATA
   ========================================================= */

function getAlbumRequest(key, factory, signal) {
  return getSharedRequest(
    albumRequests,
    key,
    factory,
    signal
  );
}

/* =========================================================
   ESTADO DE PETICIÓN
   ========================================================= */

function cancelActiveRequest() {
  if (activeController) {
    activeController.abort();
    activeController = null;
  }

  cancelColorRequest();

  activeRequestId++;

  metrics.cancelled++;
}

function isCurrentRequest(requestId, key) {
  return (
    !destroyed &&
    requestId === activeRequestId &&
    key === activeRequestKey
  );
}

/* =========================================================
   PRELOAD
   ========================================================= */

export async function preloadArtwork(track) {
  if (
    !isObject(track) ||
    destroyed
  ) {
    return null;
  }

  const key = getTrackKey(track);

  if (!key) {
    return null;
  }

  if (preloadRequests.has(key)) {
    return preloadRequests.get(key).promise;
  }

  const controller = new AbortController();

  const entry = {
    controller,
    promise: null
  };

  entry.promise = (async () => {
    try {
      const metadata = await getTrackMetadata(
        track,
        {
          signal: controller.signal,
          timeout: METADATA_TIMEOUT
        }
      );

      if (controller.signal.aborted) {
        throw createAbortError();
      }

      let artwork = normalizeImageUrl(
        metadata?.artwork
      );

      if (!artwork) {
        artwork = getYouTubeThumbnail(track);
      }

      if (!artwork) {
        return null;
      }

      /*
       * Descargar y decodificar sin modificar
       * la portada que está reproduciéndose.
       */

      await loadImage(artwork, {
        signal: controller.signal,
        timeout: IMAGE_TIMEOUT,
        crossOrigin: true
      });

      return artwork;
    } catch (error) {
      if (!isAbortError(error)) {
        const youtube = getYouTubeThumbnail(track);

        return youtube || null;
      }

      return null;
    } finally {
      if (preloadRequests.get(key) === entry) {
        preloadRequests.delete(key);
      }
    }
  })();

  preloadRequests.set(key, entry);

  return entry.promise;
}

/* =========================================================
   CARGA PRINCIPAL
   ========================================================= */

export async function loadArtwork(track, options = {}) {
  if (
    !isObject(track) ||
    destroyed
  ) {
    return null;
  }

  const key = getTrackKey(track);

  if (!key) {
    return null;
  }

  /*
   * Cancelar la solicitud anterior.
   */

  if (activeController) {
    activeController.abort();
  }

  cancelColorRequest();

  const controller = new AbortController();

  activeController = controller;

  const requestId = ++activeRequestId;

  activeRequestKey = key;
  activeTrack = track;
  activeColorKey = key;

  activeSongColor = null;
  activeSecondaryColor = null;

  activeAppliedPriority = -1;

  activeLoadStartedAt = now();

  metrics.requests++;

  const forceRefresh = Boolean(
    options.forceRefresh ||
    options.refresh
  );

  const isCurrent = () => (
    isCurrentRequest(requestId, key) &&
    !controller.signal.aborted
  );

  /*
   * Mostrar una portada temporal mientras se resuelve
   * la imagen definitiva.
   */

  const explicitMod = getExplicitModArtwork(track);

  if (explicitMod) {
    applyArtwork(
      explicitMod,
      {
        source: 'mod',
        force: true,
        requestId,
        requestKey: key
      }
    );

    return {
      artwork: explicitMod,
      source: 'mod',
      found: true
    };
  }

  applyFallback(
    track,
    requestId,
    key
  );

  /*
   * Preparar identidad de álbum.
   */

  const identity = cleanQueryTitle(
    getTitle(track),
    getArtist(track)
  );

  const albumKey = [
    normalizeArtist(getArtist(track)),
    normalizeText(identity.album || getAlbum(track)),
    normalizeText(identity.title)
  ].join('::');

  let bestResult = null;

  let bestPriority = activeAppliedPriority;

  /*
   * 1. MusicBrainz / Cover Art Archive.
   */

  try {
    if (isCurrent()) {
      const result = await getAlbumRequest(
        albumKey + '::musicbrainz',
        signal => searchMusicMetadata(
          track,
          signal
        ),
        controller.signal
      );

      if (
        isCurrent() &&
        result?.artwork
      ) {
        const valid = await verifyArtwork(
          result.artwork,
          controller.signal
        );

        if (valid && isCurrent()) {
          bestResult = result;
          bestPriority = getSourcePriority(result.source);

          applyArtwork(
            result.artwork,
            {
              source: result.source,
              requestId,
              requestKey: key
            }
          );
        }
      }
    }
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }

    reportError(error, 'musicbrainz');
  }

  /*
   * 2. iTunes.
   *
   * Se consulta incluso si hay una portada de artista,
   * porque iTunes puede ofrecer una portada de álbum.
   */

  if (
    isCurrent() &&
    bestPriority < getSourcePriority('itunes')
  ) {
    try {
      const result = await searchITunes(
        track,
        controller.signal
      );

      if (
        result?.artwork &&
        isCurrent()
      ) {
        const valid = await verifyArtwork(
          result.artwork,
          controller.signal
        );

        if (valid && isCurrent()) {
          bestResult = result;
          bestPriority = getSourcePriority('itunes');

          applyArtwork(
            result.artwork,
            {
              source: 'itunes',
              requestId,
              requestKey: key
            }
          );
        }
      }
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }

      reportError(error, 'itunes');
    }
  }

  /*
   * 3. Portada de artista.
   */

  if (
    isCurrent() &&
    bestPriority < getSourcePriority('artist')
  ) {
    try {
      const artist = getArtist(track);

      let artwork = '';

      if (!forceRefresh) {
        artwork = getCachedArtistArtwork(artist);
      }

      if (!artwork) {
        artwork = getArtistModArtwork(artist);
      }

      if (!artwork) {
        artwork = await searchDeezerArtist(
          artist,
          controller.signal
        );
      }

      if (
        artwork &&
        isCurrent()
      ) {
        const valid = await verifyArtwork(
          artwork,
          controller.signal
        );

        if (valid && isCurrent()) {
          bestResult = {
            artwork,
            source: 'artist'
          };

          applyArtwork(
            artwork,
            {
              source: 'artist',
              requestId,
              requestKey: key
            }
          );
        }
      }
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }

      reportError(error, 'artist');
    }
  }

  if (!isCurrent()) {
    throw createAbortError();
  }

  /*
   * La miniatura de YouTube o el fallback local
   * se conservan si no se encuentra algo mejor.
   */

  const duration = now() - activeLoadStartedAt;

  metrics.successful += bestResult ? 1 : 0;
  metrics.failed += bestResult ? 0 : 1;

  metrics.lastDuration = duration;

  const completed =
    metrics.successful + metrics.failed;

  metrics.averageDuration =
    completed > 0
      ? (
          metrics.averageDuration * (completed - 1) +
          duration
        ) / completed
      : duration;

  const result = {
    artwork: activeArtwork,
    source: activeArtworkSource,
    found: Boolean(bestResult),
    duration,
    requestId
  };

  /*
   * El evento shunel:artwork-updated se emite una sola
   * vez por cada cambio real de imagen, desde applyArtwork.
   */

  safeDispatch(
    'shunel:artwork-resolved',
    {
      ...result,
      track
    }
  );

  if (activeController === controller) {
    activeController = null;
  }

  return result;
}

/* =========================================================
   ESTADO DEL REPRODUCTOR
   ========================================================= */

export function setArtworkPlaybackState(state) {
  if (typeof state === 'boolean') {
    isPlaying = state;
  } else if (isObject(state)) {
    isPlaying = Boolean(
      state.playing ??
      state.isPlaying ??
      false
    );
  } else {
    isPlaying = false;
  }

  scheduleVisualSync();
}

/* =========================================================
   SINCRONIZACIÓN VISUAL
   ========================================================= */

function syncArtworkVisuals() {
  for (const element of getArtworkElements()) {
    element.style.setProperty(
      '--shunel-art-gesture-scale',
      String(gestureScale)
    );

    element.classList.toggle(
      'is-playing',
      isPlaying
    );
  }
}

function scheduleVisualSync() {
  if (
    visualRafId ||
    destroyed ||
    !isBrowser()
  ) {
    return;
  }

  visualRafId = requestAnimationFrame(() => {
    visualRafId = 0;

    if (destroyed) {
      return;
    }

    syncArtworkVisuals();
  });
}

/* =========================================================
   GESTOS POINTER
   ========================================================= */

function onPointerDown(event) {
  if (
    event.pointerType === 'mouse' &&
    event.button !== 0
  ) {
    return;
  }

  pointerStates.set(event.currentTarget, {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    moved: false
  });
}

function onPointerMove(event) {
  const element = event.currentTarget;
  const state = pointerStates.get(element);

  if (
    !state ||
    state.pointerId !== event.pointerId
  ) {
    return;
  }

  const dx = event.clientX - state.startX;
  const dy = event.clientY - state.startY;

  if (
    Math.abs(dx) > 8 ||
    Math.abs(dy) > 8
  ) {
    state.moved = true;
  }

  if (!state.moved) {
    return;
  }

  const distance = Math.min(
    Math.abs(dx) + Math.abs(dy),
    70
  );

  const scale = clamp(
    1 - distance / 1800,
    0.96,
    1
  );

  element.style.setProperty(
    '--shunel-art-gesture-scale',
    String(scale)
  );
}

function onPointerUp(event) {
  const element = event.currentTarget;
  const state = pointerStates.get(element);

  if (
    !state ||
    state.pointerId !== event.pointerId
  ) {
    return;
  }

  pointerStates.delete(element);

  element.style.setProperty(
    '--shunel-art-gesture-scale',
    '1'
  );
}

function onPointerCancel(event) {
  const element = event.currentTarget;

  pointerStates.delete(element);

  element.style.setProperty(
    '--shunel-art-gesture-scale',
    '1'
  );
}

function bindGestureEvents(element) {
  if (
    !element ||
    imageListeners.has(element)
  ) {
    return;
  }

  const listeners = {
    pointerdown: onPointerDown,
    pointermove: onPointerMove,
    pointerup: onPointerUp,
    pointercancel: onPointerCancel
  };

  for (const [event, handler] of Object.entries(listeners)) {
    element.addEventListener(
      event,
      handler,
      { passive: true }
    );
  }

  element.style.touchAction = 'pan-y';

  imageListeners.set(
    element,
    listeners
  );

  visualElements.add(element);
}

function unbindGestureEvents(element) {
  const listeners = imageListeners.get(element);

  if (!listeners) {
    return;
  }

  for (const [event, handler] of Object.entries(listeners)) {
    element.removeEventListener(
      event,
      handler
    );
  }

  imageListeners.delete(element);
  pointerStates.delete(element);
  visualElements.delete(element);
}

/* =========================================================
   ACCESIBILIDAD
   ========================================================= */

function prepareElementAccessibility(element) {
  if (!element) {
    return;
  }

  if (element.tagName?.toLowerCase() === 'img') {
    if (!element.hasAttribute('alt')) {
      element.alt = 'Portada de la canción';
    }

    element.decoding = 'async';
  } else {
    element.setAttribute('role', 'img');

    element.setAttribute(
      'aria-label',
      'Portada de la canción'
    );
  }

  bindGestureEvents(element);
}

function prepareAccessibility() {
  for (const element of getArtworkElements()) {
    prepareElementAccessibility(element);
  }
}

/* =========================================================
   OBSERVAR PORTADAS DINÁMICAS
   ========================================================= */

function observeArtworkElements() {
  if (
    typeof MutationObserver === 'undefined' ||
    !document.body
  ) {
    return;
  }

  mutationObserver?.disconnect();

  mutationObserver = new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) {
          continue;
        }

        const element = node;

        if (element.matches?.(ARTWORK_SELECTOR)) {
          prepareElementAccessibility(element);

          if (activeArtwork) {
            setArtworkImage(element, activeArtwork);

            updateArtworkAttributes(
              element,
              activeArtworkSource
            );
          }
        }

        for (const child of element.querySelectorAll?.(
          ARTWORK_SELECTOR
        ) || []) {
          prepareElementAccessibility(child);

          if (activeArtwork) {
            setArtworkImage(child, activeArtwork);

            updateArtworkAttributes(
              child,
              activeArtworkSource
            );
          }
        }
      }
    }
  });

  mutationObserver.observe(
    document.body,
    {
      childList: true,
      subtree: true
    }
  );
}

/* =========================================================
   RESET
   ========================================================= */

export function resetArtwork(options = {}) {
  cancelActiveRequest();

  activeTrack = null;

  activeRequestKey = '';
  activeColorKey = '';

  activeArtwork = '';
  activeArtworkSource = 'fallback';
  activeAppliedPriority = -1;

  activeSongColor = null;
  activeSecondaryColor = null;

  gestureScale = 1;

  if (options.clearColors) {
    songColorCache.clear();
  }

  for (const element of getArtworkElements()) {
    element.classList.remove(
      'has-artwork',
      'is-playing',
      'artwork-loading',
      'artwork-failed'
    );

    element.removeAttribute(
      'data-shunel-artwork-source'
    );

    if (element.tagName?.toLowerCase() === 'img') {
      element.src = FALLBACK_ARTWORK;
    } else {
      element.style.backgroundImage =
        `url(${JSON.stringify(FALLBACK_ARTWORK)})`;
    }

    element.style.setProperty(
      '--shunel-art-gesture-scale',
      '1'
    );
  }

  updateArtworkCss(FALLBACK_ARTWORK);

  if (isBrowser()) {
    document.documentElement.style.removeProperty(
      '--song-color'
    );

    document.documentElement.style.removeProperty(
      '--shunel-song-secondary'
    );
  }

  scheduleVisualSync();

  safeDispatch(
    'shunel:artwork-reset',
    {
      clearColors: Boolean(options.clearColors)
    }
  );
}

/* =========================================================
   EVENTOS DE LA APLICACIÓN
   ========================================================= */

function listen(target, eventName, handler) {
  if (!target) {
    return;
  }

  target.addEventListener(
    eventName,
    handler
  );

  boundEvents.push({
    target,
    eventName,
    handler
  });
}

function handleTrackChange(event) {
  const track =
    event?.detail?.track ||
    event?.detail?.song ||
    event?.detail;

  if (!isObject(track)) {
    return;
  }

  loadArtwork(track).catch(error => {
    if (!isAbortError(error)) {
      reportError(error, 'track-change');
    }
  });
}

function handlePlayRequest(event) {
  const track =
    event?.detail?.track ||
    event?.detail?.song;

  if (isObject(track)) {
    loadArtwork(track).catch(error => {
      if (!isAbortError(error)) {
        reportError(error, 'play-request');
      }
    });
  }
}

function handlePlaybackState(event) {
  setArtworkPlaybackState(
    event?.detail || false
  );
}

function handleModsChanged() {
  if (!activeTrack) {
    return;
  }

  const artwork = getExplicitModArtwork(
    activeTrack
  );

  if (artwork) {
    applyArtwork(
      artwork,
      {
        source: 'mod',
        force: true
      }
    );

    return;
  }

  loadArtwork(
    activeTrack,
    {
      forceRefresh: true
    }
  ).catch(error => {
    if (!isAbortError(error)) {
      reportError(error, 'mods-changed');
    }
  });
}

function handlePreloadArtwork(event) {
  const track =
    event?.detail?.track ||
    event?.detail?.song ||
    event?.detail;

  if (isObject(track)) {
    preloadArtwork(track);
  }
}

function bindApplicationEvents() {
  listen(
    window,
    'shunel:track-change',
    handleTrackChange
  );

  listen(
    window,
    'shunel:play-request',
    handlePlayRequest
  );

  listen(
    window,
    'shunel:playback-state',
    handlePlaybackState
  );

  listen(
    window,
    'shunel:mods-changed',
    handleModsChanged
  );

  listen(
    window,
    'shunel:preload-artwork',
    handlePreloadArtwork
  );
}

/* =========================================================
   INICIALIZACIÓN
   ========================================================= */

export function initArtwork() {
  if (
    initialized &&
    !destroyed
  ) {
    return true;
  }

  if (!isBrowser()) {
    return false;
  }

  destroyed = false;
  initialized = true;

  prepareAccessibility();

  observeArtworkElements();

  bindApplicationEvents();

  const currentTrack =
    window.currentTrack ||
    window.currentSong ||
    null;

  if (isObject(currentTrack)) {
    loadArtwork(currentTrack).catch(error => {
      if (!isAbortError(error)) {
        reportError(error, 'initialization');
      }
    });
  }

  safeDispatch(
    'shunel:artwork-initialized',
    {
      version: VERSION
    }
  );

  return true;
}

/* =========================================================
   DESTRUCCIÓN
   ========================================================= */

export function destroyArtwork() {
  destroyed = true;
  initialized = false;

  cancelActiveRequest();

  if (visualRafId) {
    cancelAnimationFrame(visualRafId);
    visualRafId = 0;
  }

  /*
   * Detener observador del DOM.
   */

  if (mutationObserver) {
    mutationObserver.disconnect();
    mutationObserver = null;
  }

  /*
   * Eliminar eventos globales.
   */

  for (const item of boundEvents) {
    item.target.removeEventListener(
      item.eventName,
      item.handler
    );
  }

  boundEvents = [];

  /*
   * Eliminar eventos de cada portada conocida.
   */

  for (const element of visualElements) {
    unbindGestureEvents(element);
  }

  /*
   * Cancelar solicitudes compartidas.
   */

  for (const request of albumRequests.values()) {
    request.controller?.abort();
  }

  for (const request of artistRequests.values()) {
    request.controller?.abort();
  }

  /*
   * Cancelar precargas.
   */

  for (const request of preloadRequests.values()) {
    request.controller?.abort();
  }

  albumRequests.clear();
  artistRequests.clear();
  preloadRequests.clear();

  activeController = null;
  activeColorController = null;

  activePointer = null;

  visualElements.clear();

  safeDispatch(
    'shunel:artwork-destroyed',
    {
      version: VERSION
    }
  );
}

/* =========================================================
   DIAGNÓSTICO Y MÉTRICAS
   ========================================================= */

export function getArtworkState() {
  return {
    version: VERSION,

    artwork: activeArtwork,

    source: activeArtworkSource,

    sourceLabel:
      SOURCE_REGISTRY[activeArtworkSource]?.label ||
      activeArtworkSource,

    priority: activeAppliedPriority,

    track: activeTrack,

    requestId: activeRequestId,

    requestKey: activeRequestKey,

    playing: isPlaying,

    initialized,

    destroyed,

    color: activeSongColor,

    secondaryColor: activeSecondaryColor,

    metrics: {
      ...metrics,
      sourceUsage: {
        ...metrics.sourceUsage
      }
    },

    cache: {
      colors: songColorCache.size,
      artists: Object.keys(readArtistCache()).length,
      albumRequests: albumRequests.size,
      artistRequests: artistRequests.size,
      preloadRequests: preloadRequests.size
    },

    timing: {
      lastArtworkUpdate,
      lastColorUpdate,
      lastDuration: metrics.lastDuration,
      averageDuration: Math.round(metrics.averageDuration)
    }
  };
}

/* =========================================================
   INICIALIZACIÓN AUTOMÁTICA
   ========================================================= */

if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener(
      'DOMContentLoaded',
      initArtwork,
      { once: true }
    );
  } else {
    initArtwork();
  }
}
