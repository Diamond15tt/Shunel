/* ==========================================================================
   SHUNEL — Metadata API Function (v2.0)
   MusicBrainz + Cover Art Archive con puntuación de coincidencias,
   limpieza de ruido, timeouts, caché LRU/TTL, deduplicación y resiliencia.
   ========================================================================== */

const DEFAULT_USER_AGENT = 'Shunel/2.0 (https://github.com/Diamond15tt/Shunel)';
const USER_AGENT = cleanText(process.env.MUSICBRAINZ_USER_AGENT || DEFAULT_USER_AGENT, 200) || DEFAULT_USER_AGENT;

const MB_BASE_URL = 'https://musicbrainz.org/ws/2/release-group/';
const CAA_BASE_URL = 'https://coverartarchive.org/release-group';

const REQUEST_TIMEOUT_MS = clampNumber(
  Number(process.env.METADATA_TIMEOUT_MS),
  1200,
  9000,
  4200
);

const MEMORY_CACHE_MAX = clampNumber(
  Number(process.env.METADATA_CACHE_MAX),
  20,
  500,
  200
);

const HIT_TTL_MS = clampNumber(
  Number(process.env.METADATA_HIT_TTL_MS),
  60_000,
  7 * 24 * 60 * 60 * 1000,
  12 * 60 * 60 * 1000
);

const MISS_TTL_MS = clampNumber(
  Number(process.env.METADATA_MISS_TTL_MS),
  30_000,
  60 * 60 * 1000,
  10 * 60 * 1000
);

const MB_MIN_INTERVAL_MS = 1050;

const ALLOWED_COVER_SIZES = new Map([
  ['250', 'front-250'],
  ['front-250', 'front-250'],
  ['500', 'front-500'],
  ['front-500', 'front-500'],
  ['1200', 'front-1200'],
  ['front-1200', 'front-1200'],
  ['full', 'front'],
  ['front', 'front']
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LUCENE_SPECIAL_RE = /[+\-&|!(){}[\]^"~*?:\\/]/g;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/g;
const MULTISPACE_RE = /\s+/g;

const memoryCache = new Map();
const inflightRequests = new Map();
let lastMusicBrainzCallAt = 0;

/* --------------------------------------------------------------------------
   01. UTILIDADES GENERALES, SEGURIDAD Y NORMALIZACIÓN
   -------------------------------------------------------------------------- */

function clampNumber(value, min, max, fallback) {
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, value));
}

function extractFirstQueryValue(raw) {
  if (Array.isArray(raw)) {
    return raw.length > 0 ? raw[0] : '';
  }
  if (raw && typeof raw === 'object') {
    return '';
  }
  return raw;
}

function cleanText(value, max = 160) {
  const raw = extractFirstQueryValue(value);
  if (raw === null || raw === undefined) return '';
  return String(raw)
    .replace(CONTROL_CHARS_RE, ' ')
    .replace(MULTISPACE_RE, ' ')
    .trim()
    .slice(0, max);
}

function escapeRegExp(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripDiacritics(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function normaliseComparable(value) {
  return stripDiacritics(String(value || ''))
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(MULTISPACE_RE, ' ')
    .trim();
}

function normaliseArtistName(value) {
  return normaliseComparable(value)
    .replace(/\b(official|topic|vevo|music|records|record|tv|channel|hd|hq)\b/g, ' ')
    .replace(MULTISPACE_RE, ' ')
    .trim();
}

function splitArtistTokens(artistValue) {
  const cleaned = cleanText(artistValue, 140);
  if (!cleaned) return [];
  const parts = cleaned
    .split(/\s*(?:,|&|\+|\/|\bfeat\.?\b|\bft\.?\b|\bwith\b|\bx\b|\band\b|\by\b)\s*/i)
    .map(normaliseArtistName)
    .filter(Boolean);
  return [...new Set(parts)];
}

function hasWholePhrase(haystack, needle) {
  if (!haystack || !needle) return false;
  if (haystack === needle) return true;
  const escaped = escapeRegExp(needle);
  const wordBoundaryRe = new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`, 'i');
  return wordBoundaryRe.test(haystack);
}

function artistsMatch(requestedArtist, candidateArtist) {
  const reqNorm = normaliseArtistName(requestedArtist);
  const candNorm = normaliseArtistName(candidateArtist);
  if (!reqNorm || !candNorm) return false;

  if (reqNorm === candNorm) return true;
  if (hasWholePhrase(candNorm, reqNorm) || hasWholePhrase(reqNorm, candNorm)) return true;

  const reqParts = splitArtistTokens(requestedArtist);
  const candParts = splitArtistTokens(candidateArtist);

  for (const rPart of reqParts) {
    if (rPart.length < 2) continue;
    for (const cPart of candParts) {
      if (cPart.length < 2) continue;
      if (rPart === cPart || hasWholePhrase(cPart, rPart) || hasWholePhrase(rPart, cPart)) {
        return true;
      }
    }
  }

  return false;
}

function cleanTrackTitle(rawTitle, rawArtist = '') {
  let title = cleanText(rawTitle, 180);
  const artist = cleanText(rawArtist, 120);
  if (!title) return '';

  // Quita prefijo "Artista - ..." o "Artista: ..." cuando coincide con el artista
  if (artist) {
    const artistVariants = [artist, ...splitArtistTokens(artist)].filter(Boolean);
    for (const variant of artistVariants) {
      const prefixRe = new RegExp(`^${escapeRegExp(variant)}\\s*[-–—:|/]+\\s*`, 'i');
      if (prefixRe.test(title)) {
        title = title.replace(prefixRe, '').trim();
        break;
      }
    }
  }

  // Quita etiquetas ruidosas entre paréntesis o corchetes
  title = title.replace(
    /\s*[\[(](?:[^[\]()]{0,80}\b(?:official|video|audio|lyric(?:s)?|visualizer|prod\.?|remix|remaster(?:ed)?|live|acoustic|instrumental|explicit|clean|version|edit|radio|mix|x100pre|yhlqmdlg|el ultimo tour)\b[^[\]()]{0,80})[\])]\s*/gi,
    ' '
  );

  // Quita sufijos sueltos típicos de videos/canales
  title = title.replace(
    /\s+(?:official\s*(?:video|audio|lyric\s*video|visualizer)|video\s*oficial|audio\s*oficial|letra(?:\s*oficial)?|lyrics?)\s*$/i,
    ''
  );

  // Recorta secciones separadas por barras verticales o slashes tras el título principal
  title = title.replace(/\s+[|｜]\s+.*$/, '');

  // Quita etiquetas de álbum mayúsculas pegadas al final tras guion o espacio largo
  title = title.replace(/\s+[-–—]\s+[A-Z0-9]{4,}\s*$/, '');

  title = title.replace(MULTISPACE_RE, ' ').trim();
  return title || cleanText(rawTitle, 160);
}

function sanitiseLuceneTerm(value, maxLen = 80) {
  const base = stripDiacritics(cleanText(value, maxLen))
    .replace(LUCENE_SPECIAL_RE, ' ')
    .replace(MULTISPACE_RE, ' ')
    .trim();
  return base.slice(0, maxLen).trim();
}

function isValidMbid(id) {
  return typeof id === 'string' && UUID_RE.test(id.trim());
}

function isSafeHttpsUrl(urlStr) {
  if (typeof urlStr !== 'string' || !urlStr.trim()) return false;
  try {
    const parsed = new URL(urlStr.trim());
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function resolveCoverSize(rawSize) {
  const key = cleanText(rawSize, 20).toLowerCase();
  return ALLOWED_COVER_SIZES.get(key) || 'front-500';
}

/* --------------------------------------------------------------------------
   02. CACHÉ EN MEMORIA (LRU + TTL) Y DEDUPLICACIÓN EN VUELO
   -------------------------------------------------------------------------- */

function buildCacheKey(cleanTitle, cleanArtist, coverSize) {
  return `${normaliseComparable(cleanTitle)}::${normaliseArtistName(cleanArtist)}::${coverSize}`;
}

function readMemoryCache(key) {
  const entry = memoryCache.get(key);
  if (!entry) return null;

  if (Date.now() > entry.expiresAt) {
    memoryCache.delete(key);
    return null;
  }

  // Promueve a más reciente (LRU)
  memoryCache.delete(key);
  memoryCache.set(key, entry);
  return entry.data;
}

function writeMemoryCache(key, data, ttlMs) {
  if (!key || !data || typeof data !== 'object') return;
  if (memoryCache.has(key)) {
    memoryCache.delete(key);
  }

  memoryCache.set(key, {
    data,
    expiresAt: Date.now() + ttlMs
  });

  while (memoryCache.size > MEMORY_CACHE_MAX) {
    const oldestKey = memoryCache.keys().next().value;
    memoryCache.delete(oldestKey);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForMusicBrainzSlot() {
  const now = Date.now();
  const elapsed = now - lastMusicBrainzCallAt;
  if (elapsed < MB_MIN_INTERVAL_MS) {
    await sleep(MB_MIN_INTERVAL_MS - elapsed);
  }
  lastMusicBrainzCallAt = Date.now();
}

/* --------------------------------------------------------------------------
   03. PETICIONES HTTP CON TIMEOUT Y PARSEO SEGURO
   -------------------------------------------------------------------------- */

async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timerId = setTimeout(() => {
    controller.abort(new Error('Tiempo de espera agotado'));
  }, timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timerId);
  }
}

async function safeJsonParse(response) {
  try {
    const text = await response.text();
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------------------
   04. CONSULTA A MUSICBRAINZ Y PUNTUACIÓN DE CANDIDATOS
   -------------------------------------------------------------------------- */

function extractArtistCreditName(releaseGroup, fallbackArtist = '') {
  const credits = Array.isArray(releaseGroup?.['artist-credit'])
    ? releaseGroup['artist-credit']
    : [];

  if (credits.length > 0) {
    const joined = credits
      .map(item => {
        const name = item?.name || item?.artist?.name || '';
        const phrase = typeof item?.joinphrase === 'string' ? item.joinphrase : '';
        return `${name}${phrase}`;
      })
      .join('')
      .replace(MULTISPACE_RE, ' ')
      .trim();

    if (joined) return joined;
  }

  return fallbackArtist;
}

function isVariousArtists(artistName) {
  const norm = normaliseArtistName(artistName);
  return norm === 'various artists' || norm === 'varios artistas';
}

function tokenOverlapScore(queryText, candidateText) {
  const qTokens = normaliseComparable(queryText)
    .split(' ')
    .filter(t => t.length >= 2);
  const cTokens = new Set(
    normaliseComparable(candidateText)
      .split(' ')
      .filter(t => t.length >= 2)
  );

  if (!qTokens.length || !cTokens.size) return 0;

  let matches = 0;
  for (const token of qTokens) {
    if (cTokens.has(token)) matches += 1;
  }
  return matches / qTokens.length;
}

function scoreReleaseGroup(group, cleanedTitle, requestedArtist, strictArtistRequired = true) {
  if (!group || typeof group !== 'object' || !isValidMbid(group.id)) {
    return -999;
  }

  let score = 0;
  const groupTitle = cleanText(group.title, 180);
  const groupArtist = extractArtistCreditName(group, '');
  const primaryType = String(group['primary-type'] || '').toLowerCase();
  const secondaryTypes = Array.isArray(group['secondary-types'])
    ? group['secondary-types'].map(s => String(s || '').toLowerCase())
    : [];

  const mbScore = Number(group.score || 0);
  score += Math.min(25, Math.max(0, mbScore / 4));

  // Coincidencia de artista
  const hasArtistFilter = Boolean(normaliseArtistName(requestedArtist));
  if (hasArtistFilter) {
    if (isVariousArtists(groupArtist)) {
      score -= strictArtistRequired ? 80 : 35;
    } else if (artistsMatch(requestedArtist, groupArtist)) {
      score += 45;
      if (normaliseArtistName(requestedArtist) === normaliseArtistName(groupArtist)) {
        score += 15;
      }
    } else {
      score -= strictArtistRequired ? 65 : 15;
    }
  } else if (isVariousArtists(groupArtist)) {
    score -= 20;
  }

  // Coincidencia de título / lanzamiento
  const qTitleNorm = normaliseComparable(cleanedTitle);
  const gTitleNorm = normaliseComparable(groupTitle);
  const overlap = tokenOverlapScore(cleanedTitle, groupTitle);

  if (qTitleNorm && gTitleNorm) {
    if (qTitleNorm === gTitleNorm) {
      score += 30;
    } else if (gTitleNorm.includes(qTitleNorm) || qTitleNorm.includes(gTitleNorm)) {
      score += 18;
    }
    score += overlap * 20;
  }

  // Evita que un título que es simplemente el nombre del artista gane como canción
  if (
    hasArtistFilter &&
    gTitleNorm &&
    gTitleNorm === normaliseArtistName(requestedArtist) &&
    qTitleNorm !== gTitleNorm
  ) {
    score -= 20;
  }

  // Preferencia de tipo de lanzamiento
  if (primaryType === 'album') score += 10;
  else if (primaryType === 'single' || primaryType === 'ep') score += 8;

  if (secondaryTypes.includes('compilation')) score -= 18;
  if (secondaryTypes.includes('bootleg') || secondaryTypes.includes('pseudo-release')) score -= 30;
  if (secondaryTypes.includes('live')) score -= 6;
  if (secondaryTypes.includes('remix')) score -= 4;

  // Preferencia por fecha de lanzamiento válida
  const dateStr = cleanText(group['first-release-date'], 20);
  if (/^\d{4}/.test(dateStr)) {
    score += 4;
  }

  return score;
}

async function queryMusicBrainzReleaseGroups(queryString, limit = 8) {
  await waitForMusicBrainzSlot();

  const url = new URL(MB_BASE_URL);
  url.search = new URLSearchParams({
    query: queryString,
    fmt: 'json',
    limit: String(clampNumber(limit, 1, 15, 8))
  }).toString();

  const response = await fetchWithTimeout(url.toString(), {
    method: 'GET',
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json'
    }
  });

  if (!response.ok) {
    const err = new Error(`MusicBrainz HTTP ${response.status}`);
    err.statusCode = response.status === 503 || response.status === 429 ? 503 : 502;
    throw err;
  }

  const payload = await safeJsonParse(response);
  if (!payload || typeof payload !== 'object') {
    const err = new Error('Respuesta JSON inválida de MusicBrainz');
    err.statusCode = 502;
    throw err;
  }

  return Array.isArray(payload['release-groups']) ? payload['release-groups'] : [];
}

function buildLuceneQuery(cleanedTitle, requestedArtist, mode = 'strict') {
  const tTerm = sanitiseLuceneTerm(cleanedTitle, 75);
  const aTerm = sanitiseLuceneTerm(requestedArtist, 65);

  if (mode === 'strict') {
    const parts = [];
    if (tTerm) parts.push(`release:${tTerm}`);
    if (aTerm) parts.push(`artist:${aTerm}`);
    return parts.join(' AND ');
  }

  if (mode === 'broad') {
    const parts = [];
    if (tTerm) parts.push(tTerm);
    if (aTerm) parts.push(`artist:${aTerm}`);
    return parts.join(' AND ');
  }

  // Respaldo sin restricción estricta de artista si no hubo coincidencias
  return tTerm || aTerm;
}

async function findRankedReleaseGroups(cleanedTitle, requestedArtist) {
  const queries = [
    { q: buildLuceneQuery(cleanedTitle, requestedArtist, 'strict'), strictArtist: true },
    { q: buildLuceneQuery(cleanedTitle, requestedArtist, 'broad'), strictArtist: true }
  ].filter(item => Boolean(item.q));

  // Solo si se indicó artista y no hubo resultados, intenta búsqueda sin filtro de artista
  let groups = [];
  let usedStrictArtist = true;

  for (const item of queries) {
    groups = await queryMusicBrainzReleaseGroups(item.q, 8);
    if (groups.length > 0) {
      usedStrictArtist = item.strictArtist;
      break;
    }
  }

  if (groups.length === 0 && requestedArtist) {
    const fallbackQ = buildLuceneQuery(cleanedTitle, '', 'title-only');
    if (fallbackQ) {
      groups = await queryMusicBrainzReleaseGroups(fallbackQ, 8);
      usedStrictArtist = false;
    }
  }

  const ranked = groups
    .map(group => ({
      group,
      score: scoreReleaseGroup(group, cleanedTitle, requestedArtist, usedStrictArtist)
    }))
    .filter(item => item.score > -50)
    .sort((a, b) => b.score - a.score);

  // Si todos tuvieron puntaje bajo pero hay candidatos válidos, conserva los mejores por orden
  if (ranked.length === 0 && groups.length > 0) {
    return groups
      .filter(g => isValidMbid(g?.id))
      .map(group => ({ group, score: 0 }));
  }

  return ranked;
}

/* --------------------------------------------------------------------------
   05. CONSULTA A COVER ART ARCHIVE
   -------------------------------------------------------------------------- */

async function resolveCoverArtUrl(mbid, coverSize = 'front-500') {
  if (!isValidMbid(mbid)) return '';

  const safeSize = resolveCoverSize(coverSize);
  const endpoint = `${CAA_BASE_URL}/${encodeURIComponent(mbid)}/${encodeURIComponent(safeSize)}`;

  try {
    const headResp = await fetchWithTimeout(
      endpoint,
      {
        method: 'HEAD',
        redirect: 'follow',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'image/*'
        }
      },
      Math.min(2800, REQUEST_TIMEOUT_MS)
    );

    if (headResp.ok) {
      const contentType = String(headResp.headers.get('content-type') || '').toLowerCase();
      const finalUrl = headResp.url && isSafeHttpsUrl(headResp.url) ? headResp.url : endpoint;
      if (!contentType || contentType.startsWith('image/') || isSafeHttpsUrl(finalUrl)) {
        return finalUrl;
      }
    }

    // Algunos servidores o proxies responden 405/403 a HEAD pero permiten GET ligero
    if (headResp.status === 405 || headResp.status === 403) {
      const getResp = await fetchWithTimeout(
        endpoint,
        {
          method: 'GET',
          redirect: 'follow',
          headers: {
            'User-Agent': USER_AGENT,
            Accept: 'image/*',
            Range: 'bytes=0-1'
          }
        },
        Math.min(2800, REQUEST_TIMEOUT_MS)
      );

      if (getResp.ok) {
        const finalUrl = getResp.url && isSafeHttpsUrl(getResp.url) ? getResp.url : endpoint;
        if (isSafeHttpsUrl(finalUrl)) return finalUrl;
      }
    }
  } catch {
    /* Sin portada disponible o error de red en CAA */
  }

  return '';
}

async function pickBestArtworkFromCandidates(rankedCandidates, maxChecks = 4, coverSize = 'front-500') {
  const slice = rankedCandidates.slice(0, maxChecks);
  for (const candidate of slice) {
    const mbid = candidate?.group?.id;
    if (!isValidMbid(mbid)) continue;
    const artwork = await resolveCoverArtUrl(mbid, coverSize);
    if (artwork) {
      return {
        artwork,
        selectedGroup: candidate.group,
        score: candidate.score
      };
    }
  }

  const firstGroup = rankedCandidates[0]?.group || null;
  return {
    artwork: '',
    selectedGroup: firstGroup,
    score: rankedCandidates[0]?.score ?? 0
  };
}

/* --------------------------------------------------------------------------
   06. RESPUESTA HTTP Y MANEJADOR PRINCIPAL DE VERCEL
   -------------------------------------------------------------------------- */

function applySecurityAndCacheHeaders(res, status, hasArtwork, hasData) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (status >= 400) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return;
  }

  if (hasArtwork && hasData) {
    res.setHeader(
      'Cache-Control',
      'public, s-maxage=86400, stale-while-revalidate=604800'
    );
  } else if (hasData) {
    res.setHeader(
      'Cache-Control',
      'public, s-maxage=3600, stale-while-revalidate=86400'
    );
  } else {
    res.setHeader(
      'Cache-Control',
      'public, s-maxage=300, stale-while-revalidate=1800'
    );
  }
}

function sendJson(res, status, body, meta = {}) {
  if (res.writableEnded || res.headersSent) return;
  applySecurityAndCacheHeaders(
    res,
    status,
    Boolean(body?.artwork),
    Boolean(body?.musicbrainzId || body?.album)
  );
  res.status(status).json(body);
  if (meta.debug) {
    console.debug('[Shunel Metadata]', meta.debug);
  }
}

async function computeMetadataPayload(rawTitle, rawArtist, coverSize) {
  const originalTitle = cleanText(rawTitle, 160);
  const requestedArtist = cleanText(rawArtist, 120);
  const cleanedTitle = cleanTrackTitle(originalTitle, requestedArtist) || originalTitle;

  const ranked = await findRankedReleaseGroups(cleanedTitle, requestedArtist);

  if (!ranked.length) {
    return {
      payload: {
        title: cleanedTitle,
        artist: requestedArtist,
        album: '',
        date: '',
        artwork: '',
        musicbrainzId: '',
        source: 'none'
      },
      ttlMs: MISS_TTL_MS
    };
  }

  const { artwork, selectedGroup, score } = await pickBestArtworkFromCandidates(
    ranked,
    4,
    coverSize
  );

  const chosenGroup = selectedGroup || ranked[0].group;
  const resolvedArtist =
    extractArtistCreditName(chosenGroup, requestedArtist) || requestedArtist;
  const albumTitle = cleanText(chosenGroup?.title, 160);
  const releaseDate = cleanText(chosenGroup?.['first-release-date'], 20);
  const mbid = isValidMbid(chosenGroup?.id) ? chosenGroup.id.trim() : '';

  const payload = {
    title: cleanedTitle,
    artist: resolvedArtist,
    album: albumTitle,
    date: releaseDate,
    artwork: isSafeHttpsUrl(artwork) ? artwork : '',
    musicbrainzId: mbid,
    source: artwork ? 'musicbrainz-cover-art-archive' : 'musicbrainz'
  };

  // Si la coincidencia tuvo puntaje muy bajo y no hubo portada, cachea por menos tiempo
  const ttlMs = artwork && score >= 15 ? HIT_TTL_MS : MISS_TTL_MS;

  return { payload, ttlMs };
}

module.exports = async function handler(req, res) {
  const method = String(req?.method || 'GET').toUpperCase();

  if (method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.status(204).end();
  }

  if (method !== 'GET' && method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    return sendJson(res, 405, { error: 'Método no permitido.' });
  }

  const query = req?.query && typeof req.query === 'object' ? req.query : {};
  const rawTitle = cleanText(query.title, 180);
  const rawArtist = cleanText(query.artist, 120);
  const coverSize = resolveCoverSize(query.size);

  if (!rawTitle) {
    return sendJson(res, 400, { error: 'Falta el título.' });
  }

  const cleanedTitle = cleanTrackTitle(rawTitle, rawArtist) || rawTitle;
  const cacheKey = buildCacheKey(cleanedTitle, rawArtist, coverSize);

  const cached = readMemoryCache(cacheKey);
  if (cached) {
    if (method === 'HEAD') {
      applySecurityAndCacheHeaders(res, 200, Boolean(cached.artwork), Boolean(cached.musicbrainzId || cached.album));
      return res.status(200).end();
    }
    return sendJson(res, 200, cached);
  }

  try {
    let pending = inflightRequests.get(cacheKey);
    if (!pending) {
      pending = computeMetadataPayload(rawTitle, rawArtist, coverSize)
        .then(({ payload, ttlMs }) => {
          writeMemoryCache(cacheKey, payload, ttlMs);
          return payload;
        })
        .finally(() => {
          inflightRequests.delete(cacheKey);
        });
      inflightRequests.set(cacheKey, pending);
    }

    const resultPayload = await pending;

    if (method === 'HEAD') {
      applySecurityAndCacheHeaders(
        res,
        200,
        Boolean(resultPayload.artwork),
        Boolean(resultPayload.musicbrainzId || resultPayload.album)
      );
      return res.status(200).end();
    }

    return sendJson(res, 200, resultPayload);
  } catch (error) {
    const statusCode =
      typeof error?.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 600
        ? error.statusCode
        : 500;

    if (statusCode >= 500) {
      console.error('[Shunel Metadata Error]', error?.message || 'Error inesperado');
    }

    if (method === 'HEAD') {
      applySecurityAndCacheHeaders(res, statusCode, false, false);
      return res.status(statusCode).end();
    }

    const message =
      statusCode === 503
        ? 'MusicBrainz está saturado o en mantenimiento temporalmente.'
        : statusCode === 502
          ? 'MusicBrainz no respondió correctamente.'
          : 'No se pudieron consultar los metadatos.';

    return sendJson(res, statusCode, { error: message });
  }
};
