
/* =========================================================
   SHUNEL — METADATA CLIENT v4.2
   Frontend ES Module

   API:
   /api/metadata

   Cache:
   shunel_metadata_v2:

   Exports:
   - getTrackMetadata(track, options = {})
   - enrichTrack(track, options = {})
   ========================================================= */

const API_ENDPOINT = '/api/metadata';

const CACHE_PREFIX = 'shunel_metadata_v2:';

const CACHE_TTL = {
  artwork: 7 * 24 * 60 * 60 * 1000,
  empty: 10 * 60 * 1000
};

const DEFAULT_TIMEOUT = 9000;

const MAX_CACHE_ENTRIES = 180;

/* =========================================================
   UTILIDADES
   ========================================================= */

function clean(value, maxLength = 200) {
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
    .slice(0, maxLength);
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
    .replace(/\b(?:official|topic|vevo|music|records?|tv|channel|hd|hq)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isValidArtwork(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return false;
  }

  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  );
}

/* =========================================================
   ARTISTA
   ========================================================= */

function getTrackArtist(track) {
  return clean(
    track?.artist ||
    track?.artistName ||
    track?.channelTitle ||
    track?.metadata?.artist ||
    '',
    200
  );
}

/* =========================================================
   EXTRACCIÓN DE TÍTULO Y ÁLBUM
   ========================================================= */

function stripArtistPrefix(title, artist) {
  let result = title;

  const variants = [
    artist,
    ...String(artist || '')
      .split(
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

    if (expression.test(result)) {
      result = result.replace(expression, '').trim();
      break;
    }
  }

  return result;
}

function cleanTrackIdentity(rawTitle, rawArtist = '', rawAlbum = '') {
  const originalTitle = clean(rawTitle, 260);

  let title = originalTitle;
  let album = clean(rawAlbum, 180);

  if (!title) {
    return {
      title: '',
      album,
      originalTitle
    };
  }

  /*
   * Quitar el artista al inicio:
   *
   * BAD BUNNY - TURiSTA (Visualizer)
   */

  title = stripArtistPrefix(title, rawArtist);

  /*
   * Extraer álbum de formatos como:
   *
   * TURiSTA (Visualizer) I DeBÍ TiRAR MáS FOToS
   * EoO (Visualizer) I DeBÍ TiRAR MáS FOTO$S$
   *
   * El separador se procesa antes de eliminar
   * los adornos entre paréntesis.
   */

  const separator = title.match(
    /\s+(?:\||｜|I)\s+(?=[A-ZÁÉÍÓÚÑ0-9])/
  );

  if (separator) {
    const possibleAlbum = title
      .slice(
        separator.index + separator[0].length
      )
      .trim();

    if (!album && possibleAlbum) {
      album = possibleAlbum;
    }

    title = title
      .slice(0, separator.index)
      .trim();
  }

  /*
   * Eliminar etiquetas de YouTube.
   */

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
    'prod',
    'remix',
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

  const bracketExpression = new RegExp(
    '\\s*[\\[(][^\\])]*\\b(?:' +
    decorations +
    ')\\b[^\\])]*[\\])]',
    'gi'
  );

  title = title.replace(
    bracketExpression,
    ' '
  );

  /*
   * Limpiar etiquetas sin paréntesis al final.
   */

  title = title.replace(
    /\s+(?:official\s*(?:video|audio|visualizer|lyric\s*video)|video\s*oficial|audio\s*oficial|visualizer|lyrics?|letra\s*oficial)\s*$/i,
    ''
  );

  /*
   * Limpiar espacios y puntuación sobrante.
   */

  title = title
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—:|]+|[\s\-–—:|]+$/g, '')
    .trim();

  album = album
    .replace(/\s*[\[(].*?[\])]\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    title: title || originalTitle,
    album,
    originalTitle
  };
}

/* =========================================================
   CLAVE DE CACHÉ
   ========================================================= */

function createCacheKey(title, artist, album) {
  return [
    normalizeText(title),
    normalizeArtist(artist),
    normalizeText(album)
  ].join('::');
}

function getStorage() {
  try {
    if (typeof localStorage === 'undefined') {
      return null;
    }

    return localStorage;
  } catch {
    return null;
  }
}

/* =========================================================
   CACHÉ LOCAL
   ========================================================= */

function readCache(key) {
  const storage = getStorage();

  if (!storage) {
    return null;
  }

  try {
    const raw = storage.getItem(
      CACHE_PREFIX + key
    );

    if (!raw) {
      return null;
    }

    const entry = JSON.parse(raw);

    if (
      !isPlainObject(entry) ||
      !Number.isFinite(entry.expiresAt) ||
      !isPlainObject(entry.data)
    ) {
      storage.removeItem(CACHE_PREFIX + key);
      return null;
    }

    if (Date.now() >= entry.expiresAt) {
      storage.removeItem(CACHE_PREFIX + key);
      return null;
    }

    return entry.data;
  } catch {
    try {
      storage.removeItem(CACHE_PREFIX + key);
    } catch {
      // localStorage puede estar bloqueado.
    }

    return null;
  }
}

function writeCache(key, data, ttl) {
  const storage = getStorage();

  if (!storage) {
    return;
  }

  try {
    const entry = {
      version: 2,
      savedAt: Date.now(),
      expiresAt: Date.now() + ttl,
      data
    };

    storage.setItem(
      CACHE_PREFIX + key,
      JSON.stringify(entry)
    );

    pruneCache(storage);
  } catch {
    /*
     * Si localStorage está lleno o bloqueado,
     * la aplicación sigue funcionando sin caché.
     */
  }
}

function pruneCache(storage) {
  try {
    const entries = [];

    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);

      if (!key || !key.startsWith(CACHE_PREFIX)) {
        continue;
      }

      try {
        const value = JSON.parse(
          storage.getItem(key)
        );

        entries.push({
          key,
          savedAt: Number(value?.savedAt) || 0
        });
      } catch {
        storage.removeItem(key);
      }
    }

    if (entries.length <= MAX_CACHE_ENTRIES) {
      return;
    }

    entries.sort(
      (a, b) => a.savedAt - b.savedAt
    );

    const excess = entries.length - MAX_CACHE_ENTRIES;

    for (const entry of entries.slice(0, excess)) {
      storage.removeItem(entry.key);
    }
  } catch {
    // No interrumpir la reproducción por la caché.
  }
}

/* =========================================================
   TIMEOUT Y ABORT
   ========================================================= */

function createAbortError(message = 'La petición fue cancelada.') {
  const error = new Error(message);

  error.name = 'AbortError';

  return error;
}

function createTimeoutError() {
  const error = new Error(
    'La consulta de metadatos excedió el tiempo disponible.'
  );

  error.name = 'TimeoutError';
  error.code = 'ETIMEDOUT';

  return error;
}

function createHttpError(status) {
  const error = new Error(
    'La API de metadatos respondió con HTTP ' + status
  );

  error.name = 'HttpError';
  error.status = status;

  return error;
}

/*
 * La señal externa se conecta a un controlador propio.
 * El temporizador permanece activo hasta terminar de leer
 * y analizar el cuerpo de la respuesta.
 */

async function requestMetadata(url, options = {}) {
  const timeout = Math.max(
    1000,
    Math.min(
      Number(options.timeout) || DEFAULT_TIMEOUT,
      15000
    )
  );

  const controller = new AbortController();

  const externalSignal = options.signal;

  let timedOut = false;

  const relayAbort = () => {
    controller.abort();
  };

  if (externalSignal?.aborted) {
    throw createAbortError();
  }

  externalSignal?.addEventListener(
    'abort',
    relayAbort,
    { once: true }
  );

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json'
      },
      cache: 'no-store',
      signal: controller.signal
    });

    /*
     * Leer el cuerpo como texto permite distinguir
     * respuestas inválidas de respuestas vacías válidas.
     */

    const body = await response.text();

    if (!response.ok) {
      throw createHttpError(response.status);
    }

    let data;

    try {
      data = JSON.parse(body);
    } catch {
      const error = new Error(
        'La API devolvió una respuesta JSON inválida.'
      );

      error.name = 'InvalidResponseError';

      throw error;
    }

    if (!isPlainObject(data)) {
      const error = new Error(
        'La API devolvió un formato de respuesta inesperado.'
      );

      error.name = 'InvalidResponseError';

      throw error;
    }

    return data;
  } catch (error) {
    if (externalSignal?.aborted) {
      throw createAbortError();
    }

    if (timedOut) {
      throw createTimeoutError();
    }

    if (
      error?.name === 'AbortError' &&
      !externalSignal?.aborted
    ) {
      throw createTimeoutError();
    }

    throw error;
  } finally {
    clearTimeout(timer);

    externalSignal?.removeEventListener(
      'abort',
      relayAbort
    );
  }
}

/* =========================================================
   VALIDACIÓN DE RESPUESTA
   ========================================================= */

function normalizeApiResponse(data, identity, artist) {
  /*
   * Una respuesta sin artwork puede ser válida.
   * La API usa artwork: "" cuando no encuentra portada.
   */

  if (
    typeof data.artwork !== 'string' ||
    typeof data.title !== 'string'
  ) {
    const error = new Error(
      'La respuesta de metadatos no contiene los campos necesarios.'
    );

    error.name = 'InvalidResponseError';

    throw error;
  }

  const artwork = isValidArtwork(data.artwork)
    ? data.artwork.trim()
    : '';

  return {
    title: clean(data.title, 180) || identity.title,

    artist: clean(
      data.artist || artist,
      180
    ),

    album: clean(
      data.album || identity.album,
      180
    ),

    date: clean(data.date, 30),

    artwork,

    musicbrainzId: clean(
      data.musicbrainzId,
      60
    ),

    source: artwork
      ? (
          data.source === 'musicbrainz-cover-art-archive'
            ? data.source
            : 'musicbrainz-cover-art-archive'
        )
      : 'none',

    found: Boolean(artwork)
  };
}

/* =========================================================
   CONSTRUIR URL DE LA API
   ========================================================= */

function buildApiUrl(identity, artist) {
  const parameters = new URLSearchParams();

  parameters.set('title', identity.title);

  if (artist) {
    parameters.set('artist', artist);
  }

  if (identity.album) {
    parameters.set('album', identity.album);
  }

  return API_ENDPOINT + '?' + parameters.toString();
}

/* =========================================================
   OBTENER METADATOS
   ========================================================= */

export async function getTrackMetadata(track, options = {}) {
  if (!isPlainObject(track)) {
    return null;
  }

  const rawTitle = clean(
    track?.title ||
    track?.name ||
    track?.trackName ||
    track?.videoTitle ||
    '',
    260
  );

  const artist = getTrackArtist(track);

  const identity = cleanTrackIdentity(
    rawTitle,
    artist,
    track?.album || track?.metadata?.album || ''
  );

  if (!identity.title) {
    return null;
  }

  const cacheKey = createCacheKey(
    identity.title,
    artist,
    identity.album
  );

  const forceRefresh = Boolean(
    options.forceRefresh ||
    options.refresh
  );

  /*
   * Consultar caché antes de llamar a la API.
   */

  if (!forceRefresh) {
    const cached = readCache(cacheKey);

    if (cached) {
      return {
        ...cached,
        cached: true
      };
    }
  }

  /*
   * Construir la consulta.
   */

  const url = buildApiUrl(
    identity,
    artist
  );

  /*
   * La señal del usuario solo controla esta petición.
   * No se comparte un AbortController entre canciones.
   */

  const data = await requestMetadata(url, {
    signal: options.signal,
    timeout: options.timeout
  });

  const result = normalizeApiResponse(
    data,
    identity,
    artist
  );

  /*
   * No guardar errores HTTP, JSON inválido,
   * respuestas incompletas ni resultados incorrectos.
   *
   * Sí guardar una respuesta válida sin portada
   * durante 10 minutos.
   */

  const ttl = result.artwork
    ? CACHE_TTL.artwork
    : CACHE_TTL.empty;

  writeCache(
    cacheKey,
    result,
    ttl
  );

  return {
    ...result,
    cached: false
  };
}

/* =========================================================
   ENRIQUECER PISTA
   ========================================================= */

export async function enrichTrack(track, options = {}) {
  if (!isPlainObject(track)) {
    return track;
  }

  const metadata = await getTrackMetadata(
    track,
    options
  );

  if (!metadata) {
    return track;
  }

  const previousMetadata = isPlainObject(track.metadata)
    ? track.metadata
    : {};

  /*
   * No sustituir una portada existente por una
   * respuesta vacía de la API.
   */

  const existingArtwork =
    clean(
      track.artwork ||
      track.thumbnail ||
      track.cover ||
      previousMetadata.artwork ||
      previousMetadata.thumbnail ||
      '',
      1000
    );

  const artwork = metadata.artwork || existingArtwork;

  return {
    ...track,

    title: track.title || metadata.title,

    artist:
      track.artist ||
      track.artistName ||
      track.channelTitle ||
      metadata.artist,

    album:
      metadata.album ||
      track.album ||
      previousMetadata.album ||
      '',

    artwork,

    metadata: {
      ...previousMetadata,

      title: metadata.title,
      artist: metadata.artist,
      album: metadata.album,
      date: metadata.date,

      artwork: metadata.artwork,

      musicbrainzId: metadata.musicbrainzId,

      artworkSource: metadata.source,

      artworkFound: metadata.found
    }
  };
}

/* =========================================================
   UTILIDADES INTERNAS DISPONIBLES
   ========================================================= */

export const metadataUtils = Object.freeze({
  cleanTrackIdentity,
  normalizeText,
  normalizeArtist,
  getTrackArtist,
  isValidArtwork
});
