
/* =========================================================
   SHUNEL — ARTWORK ENGINE v4.2
   Frontend ES Module
   Compatible con iOS Safari / PWA

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

   Exports:
   - applyArtwork
   - loadArtwork
   - preloadArtwork
   - resetArtwork
   - destroyArtwork
   - initArtwork
   - setArtworkPlaybackState
   ========================================================= */

import { getTrackMetadata } from './metadata.js';

import {
  applyModToTrack,
  getArtistArtworkEntry
} from './mods.js';

/* =========================================================
   CONFIGURACIÓN
   ========================================================= */

const VERSION = '4.2';

const FALLBACK_ARTWORK = '/assets/logo.png';

const ARTIST_CACHE_KEY = 'shunel_artist_artwork_v4';

const ARTIST_CACHE_TTL =
  10 * 24 * 60 * 60 * 1000;

const ARTIST_CACHE_LIMIT = 90;

const ARTWORK_TIMEOUT = 6500;

const COLOR_TIMEOUT = 450;

const ITUNES_ENDPOINT =
  'https://itunes.apple.com/search';

const DEEZER_ENDPOINT =
  'https://proxy.cors.dev/https://api.deezer.com';

const IMAGE_SOURCE_PRIORITY = {
  mod: 100,
  'musicbrainz-cover-art-archive': 90,
  itunes: 80,
  artist: 60,
  'youtube-thumbnail': 20,
  fallback: 0
};

/* =========================================================
   ESTADO
   ========================================================= */

let activeTrack = null;

let activeArtwork = '';

let activeArtworkSource = 'fallback';

let activeRequestId = 0;

let activeRequestKey = '';

let activeController = null;

let activeColorKey = '';

let activeSongColor = null;

let activeSecondaryColor = null;

let isPlaying = false;

let initialized = false;

let destroyed = false;

let visualRafId = 0;

let visualSyncPending = false;

let activePointer = null;

let pointerStartX = 0;

let pointerStartY = 0;

let pointerMoved = false;

let gestureScale = 1;

let songColorCache = new Map();

let albumRequests = new Map();

let artistRequests = new Map();

let preloadRequests = new Map();

let imageListeners = new WeakMap();

let boundEvents = [];

let visualElements = new Set();

/* =========================================================
   UTILIDADES
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

function isValidImageUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return false;
  }

  try {
    const url = new URL(value, location.origin);

    return (
      url.protocol === 'https:' ||
      url.origin === location.origin
    );
  } catch {
    return false;
  }
}

function createAbortError() {
  const error = new Error('Artwork request cancelled.');

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
  try {
    window.dispatchEvent(
      new CustomEvent(name, {
        detail: {
          version: VERSION,
          ...detail
        }
      })
    );
  } catch {
    // No interrumpir el reproductor.
  }
}

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

  /*
   * Eliminar artista al principio.
   */

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

  /*
   * Separar el álbum:
   *
   * TURiSTA (Visualizer) I DeBÍ TiRAR MáS FOToS
   */

  const separator = title.match(
    /\s+(?:\||｜|I)\s+(?=[A-ZÁÉÍÓÚÑ0-9])/
  );

  let album = '';

  if (separator) {
    album = title
      .slice(
        separator.index + separator[0].length
      )
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
   CLAVE DE PISTA
   ========================================================= */

function getTrackKey(track) {
  const identity = cleanQueryTitle(
    getTitle(track),
    getArtist(track)
  );

  return [
    normalizeText(identity.title),
    normalizeArtist(getArtist(track)),
    normalizeText(identity.album || getAlbum(track))
  ].join('::');
}

/* =========================================================
   SELECTORES
   ========================================================= */

function getArtworkElements() {
  return [
    ...document.querySelectorAll(
      '#currentThumbnail, #fullPlayerThumbnail, [data-shunel-artwork]'
    )
  ];
}

function getPrimaryArtworkElement() {
  return (
    document.querySelector('#currentThumbnail') ||
    document.querySelector('#fullPlayerThumbnail') ||
    document.querySelector('[data-shunel-artwork]')
  );
}

/* =========================================================
   CACHE DE PORTADAS DE ARTISTA
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
    const raw = storage.getItem(ARTIST_CACHE_KEY);

    if (!raw) {
      return {};
    }

    const data = JSON.parse(raw);

    if (!isObject(data)) {
      return {};
    }

    const now = Date.now();
    const valid = {};

    for (const [key, entry] of Object.entries(data)) {
      if (
        !isObject(entry) ||
        !isValidImageUrl(entry.url) ||
        !Number.isFinite(entry.expiresAt) ||
        entry.expiresAt <= now
      ) {
        continue;
      }

      valid[key] = entry;
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
    // La caché es opcional.
  }
}

function getCachedArtistArtwork(artist) {
  const key = normalizeArtist(artist);

  if (!key) {
    return '';
  }

  const cache = readArtistCache();

  return cache[key]?.url || '';
}

function saveArtistArtwork(artist, url) {
  const key = normalizeArtist(artist);

  if (!key || !isValidImageUrl(url)) {
    return;
  }

  const cache = readArtistCache();

  cache[key] = {
    url,
    savedAt: Date.now(),
    expiresAt: Date.now() + ARTIST_CACHE_TTL
  };

  writeArtistCache(cache);
}

/* =========================================================
   CACHÉ DE COLOR POR SESIÓN
   ========================================================= */

function getCachedSongColor(key) {
  return songColorCache.get(key) || null;
}

function saveSongColor(key, color) {
  if (!key || !color) {
    return;
  }

  songColorCache.set(key, color);

  if (songColorCache.size > 100) {
    const first = songColorCache.keys().next().value;

    songColorCache.delete(first);
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

    if (!isValidImageUrl(artwork)) {
      return null;
    }

    return {
      artwork,
      track: result
    };
  } catch {
    return null;
  }
}

function getExplicitModArtwork(track) {
  const mod = getTrackMod(track);

  if (!mod) {
    return '';
  }

  return mod.artwork;
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

    return isValidImageUrl(url) ? url : '';
  } catch {
    return '';
  }
}

/* =========================================================
   CARGA DE IMAGEN
   ========================================================= */

function loadImage(url, options = {}) {
  return new Promise((resolve, reject) => {
    if (!isValidImageUrl(url)) {
      reject(new Error('Invalid artwork URL.'));
      return;
    }

    const image = new Image();

    image.decoding = 'async';

    if (options.crossOrigin !== false) {
      image.crossOrigin = 'anonymous';
    }

    let finished = false;

    const timeout = setTimeout(() => {
      if (finished) return;

      finished = true;

      image.onload = null;
      image.onerror = null;

      reject(new Error('Artwork image timeout.'));
    }, options.timeout || ARTWORK_TIMEOUT);

    image.onload = async () => {
      if (finished) return;

      finished = true;

      clearTimeout(timeout);

      try {
        if (image.decode) {
          await image.decode().catch(() => {});
        }
      } catch {
        // Safari puede rechazar decode aunque la imagen cargue.
      }

      resolve(image);
    };

    image.onerror = () => {
      if (finished) return;

      finished = true;

      clearTimeout(timeout);

      reject(new Error('Artwork image failed.'));
    };

    image.src = url;
  });
}

/* =========================================================
   APLICAR PORTADA AL DOM
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
    element.src = url;

    element.alt =
      element.alt || 'Portada de la canción';

    element.loading = 'eager';

    element.decoding = 'async';

    return;
  }

  element.style.backgroundImage =
    `url("${url.replace(/["\\]/g, '\\$&')}")`;
}

function updateArtworkCss(url) {
  const value = url
    ? `url("${url.replace(/["\\]/g, '\\$&')}")`
    : 'none';

  document.documentElement.style.setProperty(
    '--shunel-artwork',
    value
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
  return IMAGE_SOURCE_PRIORITY[source] ?? -1;
}

/* =========================================================
   APLICAR PORTADA
   ========================================================= */

export function applyArtwork(
  url,
  options = {}
) {
  const source = clean(
    options.source || 'fallback',
    80
  );

  if (!isValidImageUrl(url)) {
    return false;
  }

  const force = Boolean(options.force);

  const newPriority = getSourcePriority(source);

  const currentPriority = getSourcePriority(
    activeArtworkSource
  );

  /*
   * Un mod explícito siempre tiene prioridad.
   */

  if (
    activeArtworkSource === 'mod' &&
    source !== 'mod' &&
    !force
  ) {
    return false;
  }

  /*
   * Evitar que una miniatura de YouTube
   * reemplace una portada de mejor calidad.
   */

  if (
    !force &&
    newPriority < currentPriority
  ) {
    return false;
  }

  if (
    activeArtwork === url &&
    activeArtworkSource === source
  ) {
    return true;
  }

  activeArtwork = url;

  activeArtworkSource = source;

  applyArtworkToElements(
    url,
    source
  );

  safeDispatch(
    'shunel:artwork-updated',
    {
      artwork: url,
      source,
      track: activeTrack
    }
  );

  if (options.extractColor !== false) {
    resolveSongColorWithBudget(
      url,
      activeRequestKey,
      activeRequestId
    );
  }

  return true;
}

/* =========================================================
   FALLBACK Y MINIATURA DE YOUTUBE
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

  if (isValidImageUrl(explicit)) {
    return explicit;
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

function applyFallback(track) {
  const youtube = getYouTubeThumbnail(track);

  if (youtube) {
    return applyArtwork(
      youtube,
      {
        source: 'youtube-thumbnail',
        force: false,
        extractColor: true
      }
    );
  }

  return applyArtwork(
    FALLBACK_ARTWORK,
    {
      source: 'fallback',
      force: false,
      extractColor: false
    }
  );
}

/* =========================================================
   BÚSQUEDA DE iTUNES
   ========================================================= */

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

  let score = 0;

  if (!title || !expectedTitle) {
    return -1000;
  }

  if (title === expectedTitle) {
    score += 100;
  } else if (
    title.includes(expectedTitle) ||
    expectedTitle.includes(title)
  ) {
    score += 55;
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

  const artwork = clean(
    result?.artworkUrl100 ||
    result?.artworkUrl60 ||
    '',
    1000
  );

  if (artwork) {
    score += 20;
  }

  return score;
}

function upgradeArtworkUrl(url) {
  if (!url) {
    return '';
  }

  return String(url)
    .replace(/\/[0-9]+x[0-9]+bb\./i, '/1000x1000bb.')
    .replace(/\/[0-9]+x[0-9]+bb-/i, '/1000x1000bb-');
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
    limit: '15',
    media: 'music',
    country: 'US'
  }).toString();

  const response = await fetch(url.toString(), {
    signal,
    headers: {
      Accept: 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(
      'iTunes HTTP ' + response.status
    );
  }

  const data = await response.json();

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
    const artwork = upgradeArtworkUrl(
      item.result?.artworkUrl100 ||
      item.result?.artworkUrl60
    );

    if (isValidImageUrl(artwork)) {
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
  }

  return null;
}

/* =========================================================
   BÚSQUEDA DE ARTISTA EN DEEZER
   ========================================================= */

async function searchDeezerArtist(artist, signal) {
  const normalized = normalizeArtist(artist);

  if (!normalized) {
    return '';
  }

  const cacheKey = normalized;

  const cached = getCachedArtistArtwork(artist);

  if (cached) {
    return cached;
  }

  if (artistRequests.has(cacheKey)) {
    return artistRequests.get(cacheKey).promise;
  }

  const controller = new AbortController();

  const relayAbort = () => controller.abort();

  signal?.addEventListener(
    'abort',
    relayAbort,
    { once: true }
  );

  const promise = (async () => {
    try {
      const url =
        DEEZER_ENDPOINT +
        '/search/artist?' +
        new URLSearchParams({
          q: artist,
          limit: '5'
        });

      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: 'application/json'
        }
      });

      if (!response.ok) {
        return '';
      }

      const data = await response.json();

      const artists = Array.isArray(data?.data)
        ? data.data
        : [];

      const match = artists.find(item => {
        return (
          normalizeArtist(item?.name) === normalized
        );
      }) || artists[0];

      const artwork = clean(
        match?.picture_xl ||
        match?.picture_big ||
        match?.picture_medium ||
        '',
        1000
      );

      if (isValidImageUrl(artwork)) {
        saveArtistArtwork(artist, artwork);

        return artwork;
      }

      return '';
    } finally {
      signal?.removeEventListener(
        'abort',
        relayAbort
      );

      const current = artistRequests.get(cacheKey);

      if (current?.promise === promise) {
        artistRequests.delete(cacheKey);
      }
    }
  })();

  artistRequests.set(cacheKey, {
    promise,
    controller
  });

  return promise;
}

/* =========================================================
   METADATA / MUSICBRAINZ
   ========================================================= */

async function searchMusicMetadata(track, signal) {
  const metadata = await getTrackMetadata(
    track,
    {
      signal,
      timeout: 8000
    }
  );

  if (
    !metadata ||
    !isValidImageUrl(metadata.artwork)
  ) {
    return null;
  }

  return {
    artwork: metadata.artwork,
    album: metadata.album || '',
    artist: metadata.artist || '',
    source: 'musicbrainz-cover-art-archive'
  };
}

/* =========================================================
   DEDUPLICACIÓN DE BÚSQUEDAS DE ÁLBUM
   ========================================================= */

function getAlbumRequest(key, factory) {
  const existing = albumRequests.get(key);

  if (existing) {
    return existing.promise;
  }

  const controller = new AbortController();

  const promise = Promise.resolve()
    .then(() => factory(controller.signal))
    .finally(() => {
      const current = albumRequests.get(key);

      if (current?.promise === promise) {
        albumRequests.delete(key);
      }
    });

  albumRequests.set(key, {
    promise,
    controller
  });

  return promise;
}

/* =========================================================
   CANCELACIÓN DE PISTA
   ========================================================= */

function cancelActiveRequest() {
  if (activeController) {
    activeController.abort();
    activeController = null;
  }

  activeRequestId++;

  /*
   * Las peticiones compartidas de artista o álbum
   * no se cancelan aquí.
   *
   * Cada una tiene su propio controlador.
   */
}

function isCurrentRequest(requestId, key) {
  return (
    !destroyed &&
    requestId === activeRequestId &&
    key === activeRequestKey
  );
}

/* =========================================================
   COLOR DOMINANTE
   ========================================================= */

function colorFromImage(image) {
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

      /*
       * Ignorar píxeles casi blancos o negros.
       */

      const brightness = (r + g + b) / 3;

      if (brightness < 18 || brightness > 245) {
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
     * Canvas puede bloquear getImageData cuando
     * el servidor remoto no permite CORS.
     */

    return null;
  }
}

function setSongColors(color) {
  if (!color) {
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

  safeDispatch(
    'shunel:artwork-color-updated',
    {
      color: color.primary,
      secondary: color.secondary
    }
  );
}

async function extractDominantSongColor(
  url,
  key,
  requestId
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
      crossOrigin: true
    });

    const color = colorFromImage(image);

    if (!color) {
      return null;
    }

    /*
     * No guardar ni aplicar colores de una pista
     * que ya dejó de estar activa.
     */

    if (!isCurrentRequest(requestId, key)) {
      return null;
    }

    saveSongColor(key, color);

    setSongColors(color);

    return color;
  } catch {
    return null;
  }
}

/* =========================================================
   PRESUPUESTO PARA EXTRACCIÓN DE COLOR
   ========================================================= */

async function resolveSongColorWithBudget(
  url,
  key,
  requestId
) {
  let timer = null;

  try {
    await Promise.race([
      extractDominantSongColor(
        url,
        key,
        requestId
      ),

      new Promise(resolve => {
        timer = setTimeout(
          resolve,
          COLOR_TIMEOUT
        );
      })
    ]);
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

/* =========================================================
   SINCRONIZACIÓN VISUAL
   ========================================================= */

function syncArtworkVisuals() {
  visualSyncPending = false;

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
  if (visualRafId || destroyed) {
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
   GESTOS TÁCTILES Y POINTER
   ========================================================= */

function onPointerDown(event) {
  if (
    event.pointerType === 'mouse' &&
    event.button !== 0
  ) {
    return;
  }

  activePointer = event.pointerId;

  pointerStartX = event.clientX;
  pointerStartY = event.clientY;

  pointerMoved = false;
}

function onPointerMove(event) {
  if (
    activePointer === null ||
    event.pointerId !== activePointer
  ) {
    return;
  }

  const dx = event.clientX - pointerStartX;
  const dy = event.clientY - pointerStartY;

  if (
    Math.abs(dx) > 8 ||
    Math.abs(dy) > 8
  ) {
    pointerMoved = true;
  }

  if (!pointerMoved) {
    return;
  }

  const distance = Math.min(
    Math.abs(dx) + Math.abs(dy),
    70
  );

  gestureScale = Math.max(
    0.96,
    1 - distance / 1800
  );

  scheduleVisualSync();
}

function onPointerUp(event) {
  if (
    activePointer === null ||
    event.pointerId !== activePointer
  ) {
    return;
  }

  activePointer = null;

  gestureScale = 1;

  scheduleVisualSync();
}

function onPointerCancel() {
  activePointer = null;

  gestureScale = 1;

  scheduleVisualSync();
}

function bindGestureEvents(element) {
  if (!element || imageListeners.has(element)) {
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
}

/* =========================================================
   ACCESIBILIDAD
   ========================================================= */

function prepareAccessibility() {
  for (const element of getArtworkElements()) {
    if (element.tagName?.toLowerCase() === 'img') {
      if (!element.hasAttribute('alt')) {
        element.alt = 'Portada de la canción';
      }

      element.decoding = 'async';
    } else {
      element.setAttribute(
        'role',
        'img'
      );

      element.setAttribute(
        'aria-label',
        'Portada de la canción'
      );
    }

    bindGestureEvents(element);
  }
}

/* =========================================================
   PRELOAD
   ========================================================= */

export async function preloadArtwork(track) {
  if (!isObject(track)) {
    return null;
  }

  const key = getTrackKey(track);

  if (!key) {
    return null;
  }

  if (preloadRequests.has(key)) {
    return preloadRequests.get(key);
  }

  const promise = (async () => {
    const controller = new AbortController();

    try {
      /*
       * Precalentar metadatos sin modificar
       * la portada que está en reproducción.
       */

      const metadata = await getTrackMetadata(
        track,
        {
          signal: controller.signal
        }
      );

      if (
        metadata?.artwork &&
        isValidImageUrl(metadata.artwork)
      ) {
        const image = new Image();

        image.src = metadata.artwork;

        return metadata.artwork;
      }

      return getYouTubeThumbnail(track) || null;
    } catch {
      return getYouTubeThumbnail(track) || null;
    }
  })().finally(() => {
    preloadRequests.delete(key);
  });

  preloadRequests.set(key, promise);

  return promise;
}

/* =========================================================
   CARGA PRINCIPAL DE PORTADA
   ========================================================= */

export async function loadArtwork(
  track,
  options = {}
) {
  if (!isObject(track) || destroyed) {
    return null;
  }

  const requestId = ++activeRequestId;

  if (activeController) {
    activeController.abort();
  }

  const controller = new AbortController();

  activeController = controller;

  const key = getTrackKey(track);

  activeRequestKey = key;

  activeTrack = track;

  activeColorKey = key;

  activeSongColor = null;
  activeSecondaryColor = null;

  const forceRefresh = Boolean(
    options.forceRefresh ||
    options.refresh
  );

  /*
   * Reiniciar prioridad para una nueva canción,
   * conservando la portada anterior mientras carga.
   */

  const explicitMod = getExplicitModArtwork(track);

  if (explicitMod) {
    applyArtwork(
      explicitMod,
      {
        source: 'mod',
        force: true
      }
    );

    return {
      artwork: explicitMod,
      source: 'mod'
    };
  }

  /*
   * Miniatura original como fallback temporal.
   */

  const youtube = getYouTubeThumbnail(track);

  if (youtube) {
    applyArtwork(
      youtube,
      {
        source: 'youtube-thumbnail',
        force: true
      }
    );
  }

  const identity = cleanQueryTitle(
    getTitle(track),
    getArtist(track)
  );

  const albumKey = [
    normalizeArtist(getArtist(track)),
    normalizeText(identity.album || getAlbum(track))
  ].join('::');

  const isCurrent = () =>
    isCurrentRequest(requestId, key) &&
    !controller.signal.aborted;

  const sources = [];

  /*
   * 1. MusicBrainz / Cover Art Archive.
   */

  sources.push(async () => {
    return getAlbumRequest(
      albumKey + '::musicbrainz',
      signal => searchMusicMetadata(
        track,
        signal
      )
    );
  });

  /*
   * 2. iTunes.
   */

  sources.push(async () => {
    return searchITunes(
      track,
      controller.signal
    );
  });

  /*
   * 3. Portada de artista.
   */

  sources.push(async () => {
    const artist = getArtist(track);

    const cached = getCachedArtistArtwork(artist);

    if (cached) {
      return {
        artwork: cached,
        source: 'artist'
      };
    }

    const modArtwork = getArtistModArtwork(artist);

    if (modArtwork) {
      return {
        artwork: modArtwork,
        source: 'artist'
      };
    }

    const artwork = await searchDeezerArtist(
      artist,
      controller.signal
    );

    if (!artwork) {
      return null;
    }

    return {
      artwork,
      source: 'artist'
    };
  });

  /*
   * Ejecutar las fuentes en orden de prioridad.
   *
   * Una portada de artista no reemplaza una portada
   * oficial que ya se haya encontrado.
   */

  let bestResult = null;

  for (const sourceSearch of sources) {
    if (!isCurrent()) {
      throw createAbortError();
    }

    try {
      const result = await sourceSearch();

      if (
        !result ||
        !isValidImageUrl(result.artwork)
      ) {
        continue;
      }

      if (!isCurrent()) {
        throw createAbortError();
      }

      bestResult = result;

      const source = result.source || 'fallback';

      const applied = applyArtwork(
        result.artwork,
        {
          source,
          force: false
        }
      );

      if (applied) {
        /*
         * MusicBrainz e iTunes tienen prioridad
         * sobre una imagen de artista.
         */

        if (
          source === 'musicbrainz-cover-art-archive' ||
          source === 'itunes'
        ) {
          break;
        }
      }
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }

      /*
       * Si una fuente falla, continuar con la siguiente.
       */
    }
  }

  if (!isCurrent()) {
    throw createAbortError();
  }

  /*
   * Si no se encontró una portada superior,
   * conservar la miniatura original de YouTube.
   */

  if (!bestResult && !activeArtwork) {
    applyFallback(track);
  }

  const result = {
    artwork: activeArtwork,
    source: activeArtworkSource,
    found: Boolean(bestResult)
  };

  safeDispatch(
    'shunel:artwork-updated',
    {
      ...result,
      track
    }
  );

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
   RESET
   ========================================================= */

export function resetArtwork(options = {}) {
  cancelActiveRequest();

  activeTrack = null;

  activeRequestKey = '';

  activeColorKey = '';

  activeArtwork = '';

  activeArtworkSource = 'fallback';

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
        `url("${FALLBACK_ARTWORK}")`;
    }
  }

  updateArtworkCss(FALLBACK_ARTWORK);

  document.documentElement.style.removeProperty(
    '--song-color'
  );

  document.documentElement.style.removeProperty(
    '--shunel-song-secondary'
  );

  scheduleVisualSync();
}

/* =========================================================
   EVENTOS
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
      console.warn(
        '[Shunel Artwork] Track artwork failed:',
        error
      );
    }
  });
}

function handlePlayRequest(event) {
  const track =
    event?.detail?.track ||
    event?.detail?.song;

  if (isObject(track)) {
    loadArtwork(track).catch(() => {});
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

  /*
   * Al retirar un mod, volver a resolver
   * la portada sin dejar la imagen personalizada.
   */

  loadArtwork(
    activeTrack,
    {
      forceRefresh: true
    }
  ).catch(() => {});
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
  if (initialized && !destroyed) {
    return true;
  }

  destroyed = false;

  initialized = true;

  prepareAccessibility();

  bindApplicationEvents();

  const currentTrack =
    window.currentTrack ||
    window.currentSong ||
    null;

  if (isObject(currentTrack)) {
    loadArtwork(currentTrack).catch(() => {});
  }

  return true;
}

/* =========================================================
   DESTRUCCIÓN
   ========================================================= */

export function destroyArtwork() {
  destroyed = true;

  initialized = false;

  cancelActiveRequest();

  /*
   * Cancelar RAF usando el ID numérico real.
   */

  if (visualRafId) {
    cancelAnimationFrame(visualRafId);

    visualRafId = 0;
  }

  visualSyncPending = false;

  /*
   * Eliminar listeners globales.
   */

  for (const item of boundEvents) {
    item.target.removeEventListener(
      item.eventName,
      item.handler
    );
  }

  boundEvents = [];

  /*
   * Eliminar listeners de gestos.
   */

  for (const element of getArtworkElements()) {
    unbindGestureEvents(element);
  }

  /*
   * Cancelar solicitudes propias.
   */

  for (const request of albumRequests.values()) {
    request.controller?.abort();
  }

  for (const request of artistRequests.values()) {
    request.controller?.abort();
  }

  for (const request of preloadRequests.values()) {
    request?.controller?.abort?.();
  }

  albumRequests.clear();

  artistRequests.clear();

  preloadRequests.clear();

  activeController = null;

  activePointer = null;

  visualElements.clear();
}

/* =========================================================
   INFORMACIÓN DE DEPURACIÓN
   ========================================================= */

export function getArtworkState() {
  return {
    version: VERSION,

    artwork: activeArtwork,

    source: activeArtworkSource,

    track: activeTrack,

    requestId: activeRequestId,

    requestKey: activeRequestKey,

    playing: isPlaying,

    initialized,

    destroyed
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
