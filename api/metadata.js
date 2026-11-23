
/* =========================================================
   SHUNEL — METADATA API v4.2
   MusicBrainz Recording
       -> Releases / Release Groups
       -> Cover Art Archive

   Runtime: Node.js / Vercel
   Module system: CommonJS
   ========================================================= */

const USER_AGENT =
  'Shunel/4.2 (https://github.com/Diamond15tt/Shunel)';

const MUSICBRAINZ_URL =
  'https://musicbrainz.org/ws/2/recording/';

const COVER_ART_URL =
  'https://coverartarchive.org/release-group';

const REQUEST_TIMEOUT_MS = 2600;
const TOTAL_BUDGET_MS = 8200;

const POSITIVE_CACHE_TTL = 12 * 60 * 60 * 1000;
const NEGATIVE_CACHE_TTL = 10 * 60 * 1000;

const MAX_CACHE_ENTRIES = 150;

const MBID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const memoryCache = new Map();
const pendingRequests = new Map();

/* =========================================================
   UTILIDADES
   ========================================================= */

function clean(value, maxLength = 180) {
  const input = Array.isArray(value) ? value[0] : value;

  if (input === null || input === undefined) {
    return '';
  }

  if (typeof input === 'object') {
    return '';
  }

  return String(input)
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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isValidMbid(value) {
  return (
    typeof value === 'string' &&
    MBID_REGEX.test(value)
  );
}

function isSafeHttps(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/* =========================================================
   NORMALIZACIÓN DE ARTISTAS
   ========================================================= */

function splitArtists(value) {
  return [
    ...new Set(
      clean(value, 200)
        .split(
          /\s*(?:,|&|\+|\/|\bfeat\.?\b|\bft\.?\b|\bwith\b|\bx\b|\band\b|\by\b)\s*/i
        )
        .map(normalizeArtist)
        .filter(Boolean)
    )
  ];
}

function artistsMatch(expected, candidate) {
  const a = normalizeArtist(expected);
  const b = normalizeArtist(candidate);

  if (!a || !b) {
    return false;
  }

  if (a === b || a.includes(b) || b.includes(a)) {
    return true;
  }

  const expectedArtists = splitArtists(expected);
  const candidateArtists = splitArtists(candidate);

  return expectedArtists.some(expectedArtist =>
    candidateArtists.some(candidateArtist =>
      expectedArtist === candidateArtist ||
      expectedArtist.includes(candidateArtist) ||
      candidateArtist.includes(expectedArtist)
    )
  );
}

/* =========================================================
   NORMALIZACIÓN DE TÍTULOS Y ÁLBUMES
   ========================================================= */

function cleanTrackTitle(rawTitle, rawArtist = '', rawAlbum = '') {
  const original = clean(rawTitle, 240);

  let title = original;
  let album = clean(rawAlbum, 180);

  const artist = clean(rawArtist, 200);

  /*
   * Eliminar el nombre del artista cuando YouTube
   * lo incluye al principio del título.
   */

  if (artist) {
    const artistVariants = [
      artist,
      ...splitArtists(artist)
    ];

    for (const variant of artistVariants) {
      if (!variant) continue;

      const expression = new RegExp(
        '^' + escapeRegExp(variant) + '\\s*[-–—:|/]+\\s*',
        'i'
      );

      if (expression.test(title)) {
        title = title.replace(expression, '').trim();
        break;
      }
    }
  }

  /*
   * Separar el nombre del álbum.
   *
   * Ejemplo:
   * TURiSTA (Visualizer) I DeBÍ TiRAR MáS FOToS
   *
   * El separador " I " se procesa antes de eliminar
   * los adornos del video.
   */

  const albumSeparator = title.match(
    /\s+(?:\||｜|I)\s+(?=[A-ZÁÉÍÓÚÑ0-9])/
  );

  if (albumSeparator) {
    if (!album) {
      album = title
        .slice(
          albumSeparator.index +
          albumSeparator[0].length
        )
        .trim();
    }

    title = title
      .slice(0, albumSeparator.index)
      .trim();
  }

  /*
   * Eliminar etiquetas entre paréntesis o corchetes
   * relacionadas con el video.
   */

  const videoDecorations = [
    'official',
    'video',
    'audio',
    'lyrics?',
    'lyric video',
    'visualizer',
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
    'radio',
    'mix',
    'hd',
    '4k'
  ].join('|');

  const decorationRegex = new RegExp(
    '\\s*[\\[(][^\\])]*\\b(?:' +
    videoDecorations +
    ')\\b[^\\])]*[\\])]',
    'gi'
  );

  title = title.replace(decorationRegex, ' ');

  /*
   * Eliminar adornos que aparezcan al final
   * sin paréntesis.
   */

  title = title
    .replace(
      /\s+(?:official\s*(?:video|audio|lyric\s*video|visualizer)|video\s*oficial|audio\s*oficial|letra(?:\s*oficial)?|lyrics?|visualizer)\s*$/i,
      ''
    )
    .replace(/\s+/g, ' ')
    .trim();

  /*
   * Limpiar álbum.
   */

  album = album
    .replace(/\s*[\[(].*?[\])]\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    title: title || original,
    album,
    originalTitle: original
  };
}

/* =========================================================
   BÚSQUEDAS MUSICBRAINZ
   ========================================================= */

function toLucene(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

function getCacheKey(title, artist, album) {
  return [
    normalizeText(title),
    normalizeArtist(artist),
    normalizeText(album),
    'front-500'
  ].join('::');
}

/* =========================================================
   CACHÉ EN MEMORIA
   ========================================================= */

function readCache(key) {
  const entry = memoryCache.get(key);

  if (!entry) {
    return null;
  }

  if (Date.now() >= entry.expiresAt) {
    memoryCache.delete(key);
    return null;
  }

  /*
   * Mover al final para mantener las entradas
   * recientemente utilizadas.
   */

  memoryCache.delete(key);
  memoryCache.set(key, entry);

  return entry.data;
}

function writeCache(key, data, ttl) {
  memoryCache.set(key, {
    data,
    expiresAt: Date.now() + ttl
  });

  while (memoryCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = memoryCache.keys().next().value;
    memoryCache.delete(oldestKey);
  }
}

/* =========================================================
   TIMEOUT Y PETICIONES HTTP
   ========================================================= */

function createTimeoutError() {
  const error = new Error('La petición excedió el tiempo disponible.');

  error.name = 'AbortError';
  error.code = 'ETIMEDOUT';

  return error;
}

async function fetchWithTimeout(
  url,
  options = {},
  timeoutMs = REQUEST_TIMEOUT_MS,
  deadline = Infinity,
  readBody = true
) {
  const controller = new AbortController();

  const parentSignal = options.signal;

  const relayAbort = () => {
    controller.abort(parentSignal.reason);
  };

  if (parentSignal?.aborted) {
    relayAbort();
  } else {
    parentSignal?.addEventListener(
      'abort',
      relayAbort,
      { once: true }
    );
  }

  const remaining = Math.max(
    1,
    Math.min(timeoutMs, deadline - Date.now())
  );

  const timer = setTimeout(() => {
    controller.abort(createTimeoutError());
  }, remaining);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });

    let body = '';

    if (readBody) {
      /*
       * El timeout permanece activo durante la lectura
       * completa del cuerpo de la respuesta.
       */

      body = await response.text();
    } else if (response.body) {
      /*
       * Para Cover Art Archive no necesitamos descargar
       * la imagen. Basta con comprobar las cabeceras.
       */

      await response.body.cancel().catch(() => {});
    }

    return {
      response,
      body
    };
  } catch (error) {
    if (
      controller.signal.aborted &&
      !parentSignal?.aborted
    ) {
      throw createTimeoutError();
    }

    throw error;
  } finally {
    clearTimeout(timer);

    parentSignal?.removeEventListener(
      'abort',
      relayAbort
    );
  }
}

/* =========================================================
   RESPUESTAS JSON
   ========================================================= */

function parseJson(body, serviceName) {
  try {
    const data = JSON.parse(body);

    if (!data || typeof data !== 'object') {
      throw new Error('JSON inválido');
    }

    return data;
  } catch {
    const error = new Error(
      'Respuesta JSON inválida de ' + serviceName
    );

    error.statusCode = 502;

    throw error;
  }
}

/* =========================================================
   ARTIST CREDIT DE MUSICBRAINZ
   ========================================================= */

function getArtistCredit(credit, fallback = '') {
  if (!Array.isArray(credit)) {
    return fallback;
  }

  const result = credit
    .map(item => {
      const name = clean(
        item?.name || item?.artist?.name,
        100
      );

      const joinphrase =
        typeof item?.joinphrase === 'string'
          ? item.joinphrase
          : '';

      return name + joinphrase;
    })
    .join('')
    .trim();

  return result || fallback;
}

/* =========================================================
   PUNTUACIÓN DE COINCIDENCIAS
   ========================================================= */

function tokenOverlap(a, b) {
  const left = normalizeText(a)
    .split(' ')
    .filter(token => token.length > 1);

  const right = new Set(
    normalizeText(b)
      .split(' ')
      .filter(token => token.length > 1)
  );

  if (!left.length) {
    return 0;
  }

  return (
    left.filter(token => right.has(token)).length /
    left.length
  );
}

function scoreRecording(recording, title, artist) {
  const expected = normalizeText(title);
  const candidate = normalizeText(recording?.title);

  if (!expected || !candidate) {
    return -1000;
  }

  let score = 0;

  if (expected === candidate) {
    score += 100;
  } else if (
    expected.includes(candidate) ||
    candidate.includes(expected)
  ) {
    score += 55;
  } else {
    score += tokenOverlap(title, recording.title) * 35;
  }

  const credit = getArtistCredit(
    recording?.['artist-credit']
  );

  if (artist) {
    score += artistsMatch(artist, credit)
      ? 65
      : -80;
  }

  const musicBrainzScore = Number(recording?.score);

  if (Number.isFinite(musicBrainzScore)) {
    score += Math.min(
      15,
      Math.max(0, musicBrainzScore / 7)
    );
  }

  if (recording?.video === 'true') {
    score -= 4;
  }

  return score;
}

function scoreReleaseGroup(
  group,
  title,
  artist,
  albumHint
) {
  if (!isValidMbid(group?.id)) {
    return -1000;
  }

  const groupTitle = normalizeText(group.title);
  const expectedAlbum = normalizeText(albumHint);

  let score = 0;

  /*
   * Coincidencia del álbum extraído del título.
   */

  if (expectedAlbum) {
    if (groupTitle === expectedAlbum) {
      score += 110;
    } else if (
      groupTitle.includes(expectedAlbum) ||
      expectedAlbum.includes(groupTitle)
    ) {
      score += 65;
    } else {
      score -= 20;
    }
  }

  /*
   * Coincidencia del artista.
   */

  const credit = getArtistCredit(
    group?.['artist-credit']
  );

  if (artistsMatch(artist, credit)) {
    score += 35;
  } else if (artist && credit) {
    score -= 45;
  }

  /*
   * Tipo de lanzamiento.
   */

  const primaryType = String(
    group?.['primary-type'] || ''
  ).toLowerCase();

  const secondaryTypes = Array.isArray(
    group?.['secondary-types']
  )
    ? group['secondary-types'].map(value =>
        String(value).toLowerCase()
      )
    : [];

  if (primaryType === 'album') {
    score += 18;
  } else if (
    primaryType === 'single' ||
    primaryType === 'ep'
  ) {
    score += 8;
  }

  if (secondaryTypes.includes('compilation')) {
    score -= 15;
  }

  if (secondaryTypes.includes('live')) {
    score -= 10;
  }

  if (
    secondaryTypes.includes('bootleg') ||
    secondaryTypes.includes('pseudo-release')
  ) {
    score -= 35;
  }

  if (secondaryTypes.includes('remix')) {
    score -= 8;
  }

  if (/^\d{4}/.test(
    clean(group?.['first-release-date'], 20)
  )) {
    score += 3;
  }

  score += tokenOverlap(
    title,
    group.title
  ) * (expectedAlbum ? 5 : 12);

  return score;
}

/* =========================================================
   CONSULTA DE RECORDINGS
   ========================================================= */

async function searchRecordings(
  title,
  artist,
  deadline
) {
  const titleTerm = toLucene(title);
  const artistTerm = toLucene(artist);

  if (!titleTerm) {
    return [];
  }

  let query;

  if (artistTerm) {
    query =
      'recording:"' +
      titleTerm +
      '" AND artist:"' +
      artistTerm +
      '"';
  } else {
    query =
      'recording:"' +
      titleTerm +
      '"';
  }

  const url = new URL(MUSICBRAINZ_URL);

  url.search = new URLSearchParams({
    query,
    fmt: 'json',
    limit: '8',
    inc: 'releases'
  }).toString();

  const result = await fetchWithTimeout(
    url.toString(),
    {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json'
      }
    },
    REQUEST_TIMEOUT_MS,
    deadline
  );

  if (!result.response.ok) {
    const error = new Error(
      'MusicBrainz HTTP ' + result.response.status
    );

    error.statusCode =
      result.response.status === 429 ||
      result.response.status === 503
        ? 503
        : 502;

    throw error;
  }

  const data = parseJson(
    result.body,
    'MusicBrainz'
  );

  return Array.isArray(data.recordings)
    ? data.recordings
    : [];
}

/* =========================================================
   OBTENER RELEASE GROUPS DESDE LOS RELEASES
   ========================================================= */

function rankReleaseGroups(
  recordings,
  title,
  artist,
  albumHint
) {
  const rankedRecordings = recordings
    .map(recording => ({
      recording,
      score: scoreRecording(
        recording,
        title,
        artist
      )
    }))
    .filter(item => item.score >= 55)
    .sort((a, b) => b.score - a.score);

  const groups = new Map();

  for (const item of rankedRecordings.slice(0, 5)) {
    const releases = Array.isArray(
      item.recording?.releases
    )
      ? item.recording.releases
      : [];

    for (const release of releases) {
      const rawGroup = release?.['release-group'];

      if (!isValidMbid(rawGroup?.id)) {
        continue;
      }

      const group = {
        ...rawGroup,

        /*
         * Algunos resultados no incluyen
         * artist-credit dentro del release-group.
         */

        'artist-credit':
          rawGroup['artist-credit'] ||
          release['artist-credit']
      };

      const groupScore =
        item.score +
        scoreReleaseGroup(
          group,
          title,
          artist,
          albumHint
        );

      const previous = groups.get(group.id);

      if (
        !previous ||
        groupScore > previous.score
      ) {
        groups.set(group.id, {
          group,
          score: groupScore,
          releaseDate: clean(release.date, 20),
          releaseTitle: clean(release.title, 180)
        });
      }
    }
  }

  return [...groups.values()]
    .sort((a, b) => b.score - a.score);
}

/* =========================================================
   COVER ART ARCHIVE
   ========================================================= */

async function resolveCoverArt(mbid, deadline) {
  if (!isValidMbid(mbid)) {
    return '';
  }

  const endpoint =
    COVER_ART_URL +
    '/' +
    encodeURIComponent(mbid) +
    '/front-500';

  /*
   * Primera opción: HEAD.
   */

  try {
    const head = await fetchWithTimeout(
      endpoint,
      {
        method: 'HEAD',
        redirect: 'follow',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'image/*'
        }
      },
      1500,
      deadline,
      false
    );

    const contentType =
      head.response.headers.get('content-type') || '';

    const finalUrl =
      head.response.url || endpoint;

    if (
      head.response.ok &&
      (!contentType || contentType.startsWith('image/')) &&
      isSafeHttps(finalUrl)
    ) {
      return finalUrl;
    }
  } catch {
    // Continuar con GET si HEAD falla.
  }

  /*
   * Segunda opción: GET.
   *
   * Algunos servidores no aceptan HEAD.
   * No necesitamos descargar la imagen completa.
   */

  try {
    const get = await fetchWithTimeout(
      endpoint,
      {
        method: 'GET',
        redirect: 'follow',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'image/*',
          Range: 'bytes=0-0'
        }
      },
      1700,
      deadline,
      false
    );

    const contentType =
      get.response.headers.get('content-type') || '';

    const finalUrl =
      get.response.url || endpoint;

    if (
      get.response.ok &&
      contentType.startsWith('image/') &&
      isSafeHttps(finalUrl)
    ) {
      return finalUrl;
    }
  } catch {
    // Sin portada disponible.
  }

  return '';
}

/* =========================================================
   RESOLUCIÓN DE LA MEJOR PORTADA
   ========================================================= */

async function findBestCover(
  title,
  artist,
  albumHint,
  deadline
) {
  const recordings = await searchRecordings(
    title,
    artist,
    deadline
  );

  const candidates = rankReleaseGroups(
    recordings,
    title,
    artist,
    albumHint
  );

  /*
   * Consultar los candidatos mejor puntuados.
   */

  for (const candidate of candidates.slice(0, 3)) {
    if (Date.now() >= deadline - 100) {
      break;
    }

    const artwork = await resolveCoverArt(
      candidate.group.id,
      deadline
    );

    if (!artwork) {
      continue;
    }

    return {
      artwork,

      album: clean(
        candidate.group.title ||
        candidate.releaseTitle,
        160
      ),

      date: clean(
        candidate.group['first-release-date'] ||
        candidate.releaseDate,
        20
      ),

      musicbrainzId: candidate.group.id,

      artist: getArtistCredit(
        candidate.group['artist-credit'],
        artist
      )
    };
  }

  return null;
}

/* =========================================================
   CABECERAS HTTP
   ========================================================= */

function setCacheHeaders(res, status, hasArtwork) {
  let cacheControl;

  if (status >= 400) {
    cacheControl = 'no-store';
  } else if (hasArtwork) {
    cacheControl =
      'public, s-maxage=86400, stale-while-revalidate=3600';
  } else {
    cacheControl =
      'public, s-maxage=300, stale-while-revalidate=300';
  }

  res.setHeader('Cache-Control', cacheControl);

  res.setHeader(
    'X-Content-Type-Options',
    'nosniff'
  );
}

function sendJson(res, status, payload) {
  if (res.writableEnded || res.headersSent) {
    return;
  }

  setCacheHeaders(
    res,
    status,
    Boolean(payload?.artwork)
  );

  return res.status(status).json(payload);
}

/* =========================================================
   RESOLVER PRINCIPAL
   ========================================================= */

async function resolveMetadata(
  titleInput,
  artistInput,
  albumInput,
  deadline
) {
  const identity = cleanTrackTitle(
    titleInput,
    artistInput,
    albumInput
  );

  if (!identity.title) {
    const error = new Error(
      'Falta el título de la canción.'
    );

    error.statusCode = 400;

    throw error;
  }

  const result = await findBestCover(
    identity.title,
    artistInput,
    identity.album,
    deadline
  );

  /*
   * Respuesta válida sin portada.
   * Se puede almacenar durante 10 minutos.
   */

  if (!result) {
    return {
      payload: {
        title: identity.title,
        artist: clean(artistInput, 180),
        album: identity.album,
        date: '',
        artwork: '',
        musicbrainzId: '',
        source: 'none'
      },

      ttl: NEGATIVE_CACHE_TTL
    };
  }

  return {
    payload: {
      title: identity.title,
      artist: result.artist || clean(artistInput, 180),
      album: result.album || identity.album,
      date: result.date,

      artwork: isSafeHttps(result.artwork)
        ? result.artwork
        : '',

      musicbrainzId: result.musicbrainzId,

      source: 'musicbrainz-cover-art-archive'
    },

    ttl: POSITIVE_CACHE_TTL
  };
}

/* =========================================================
   VERCEL SERVERLESS HANDLER
   ========================================================= */

module.exports = async function handler(req, res) {
  /*
   * Declarar fuera de try para que también
   * esté disponible dentro de catch.
   */

  const method = String(
    req?.method || 'GET'
  ).toUpperCase();

  try {
    if (method === 'OPTIONS') {
      res.setHeader(
        'Allow',
        'GET, HEAD, OPTIONS'
      );

      res.setHeader(
        'Cache-Control',
        'no-store'
      );

      return res.status(204).end();
    }

    if (method !== 'GET' && method !== 'HEAD') {
      res.setHeader(
        'Allow',
        'GET, HEAD, OPTIONS'
      );

      return sendJson(res, 405, {
        error: 'Método no permitido.'
      });
    }

    const query = req?.query || {};

    let title = clean(query.title, 240);
    let artist = clean(query.artist, 200);
    let album = clean(query.album, 180);

    /*
     * Compatibilidad con solicitudes donde
     * req.query no esté disponible.
     */

    if (req?.url) {
      try {
        const parsed = new URL(
          req.url,
          'https://shunel.vercel.app'
        );

        title ||= clean(
          parsed.searchParams.get('title'),
          240
        );

        artist ||= clean(
          parsed.searchParams.get('artist'),
          200
        );

        album ||= clean(
          parsed.searchParams.get('album'),
          180
        );
      } catch {
        // Se conserva lo recibido en req.query.
      }
    }

    if (!title) {
      return sendJson(res, 400, {
        error: 'Falta el título de la canción.'
      });
    }

    const identity = cleanTrackTitle(
      title,
      artist,
      album
    );

    const key = getCacheKey(
      identity.title,
      artist,
      identity.album
    );

    /*
     * Consultar caché.
     */

    const cached = readCache(key);

    if (cached) {
      setCacheHeaders(
        res,
        200,
        Boolean(cached.artwork)
      );

      if (method === 'HEAD') {
        return res.status(200).end();
      }

      return res.status(200).json(cached);
    }

    /*
     * Deduplicar solicitudes simultáneas.
     */

    let task = pendingRequests.get(key);

    if (!task) {
      const deadline =
        Date.now() + TOTAL_BUDGET_MS;

      task = resolveMetadata(
        title,
        artist,
        album,
        deadline
      )
        .then(result => {
          writeCache(
            key,
            result.payload,
            result.ttl
          );

          return result.payload;
        })
        .finally(() => {
          pendingRequests.delete(key);
        });

      pendingRequests.set(key, task);
    }

    const payload = await task;

    setCacheHeaders(
      res,
      200,
      Boolean(payload.artwork)
    );

    if (method === 'HEAD') {
      return res.status(200).end();
    }

    return res.status(200).json(payload);

  } catch (error) {
    /*
     * Clasificar errores sin exponer detalles
     * internos del servidor.
     */

    const status = Number(error?.statusCode) ||
      (
        error?.name === 'AbortError' ||
        error?.code === 'ETIMEDOUT'
          ? 504
          : 502
      );

    const safeStatus =
      status >= 400 && status <= 599
        ? status
        : 500;

    let message =
      'No se pudieron obtener los metadatos musicales.';

    if (safeStatus === 400) {
      message = clean(error?.message, 180);
    } else if (safeStatus === 503) {
      message =
        'MusicBrainz está temporalmente ocupado. Inténtalo de nuevo.';
    } else if (safeStatus === 504) {
      message =
        'La búsqueda de portadas excedió el tiempo disponible.';
    }

    if (method === 'HEAD') {
      setCacheHeaders(
        res,
        safeStatus,
        false
      );

      return res.status(safeStatus).end();
    }

    return sendJson(res, safeStatus, {
      error: message,
      source: 'error'
    });
  }
};
