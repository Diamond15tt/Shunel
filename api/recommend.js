
/*
 * SHUNEL — RECOMMENDATION API
 *
 * Archivo: /api/recommend.js
 * Entorno: Vercel Serverless Functions
 * Runtime: Node.js
 *
 * Funciones:
 * - Recomendaciones basadas en artista y canción.
 * - Radio de artista.
 * - Resolución de canciones sin videoId.
 * - Caché temporal en memoria.
 * - Validación de solicitudes.
 * - Manejo de errores y timeout.
 *
 * No requiere dependencias externas.
 *
 * Variable de entorno necesaria:
 * YOUTUBE_API_KEY
 */

const YOUTUBE_API_URL =
  "https://www.googleapis.com/youtube/v3/search";

const CACHE_TTL = 10 * 60 * 1000;
const CACHE_MAX_ITEMS = 100;
const REQUEST_TIMEOUT = 10000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 30;

const cache = new Map();

/* =========================================================
   UTILIDADES
========================================================= */

function cleanText(value, maxLength = 200) {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeArtist(value) {
  return cleanText(value, 120)
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTitle(value) {
  return cleanText(value, 180)
    .replace(/\s+/g, " ")
    .trim();
}

function clampLimit(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return DEFAULT_LIMIT;
  }

  return Math.max(
    1,
    Math.min(MAX_LIMIT, Math.floor(number))
  );
}

function getCache(key) {
  const entry = cache.get(key);

  if (!entry) {
    return null;
  }

  if (Date.now() >= entry.expiresAt) {
    cache.delete(key);
    return null;
  }

  // Actualiza el orden de uso.
  cache.delete(key);
  cache.set(key, entry);

  return entry.value;
}

function setCache(key, value) {
  if (cache.has(key)) {
    cache.delete(key);
  }

  while (cache.size >= CACHE_MAX_ITEMS) {
    const oldestKey = cache.keys().next().value;

    if (oldestKey === undefined) {
      break;
    }

    cache.delete(oldestKey);
  }

  cache.set(key, {
    value,
    expiresAt: Date.now() + CACHE_TTL
  });
}

function makeCacheKey(data) {
  return JSON.stringify(data)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function getApiKey() {
  return cleanText(
    process.env.YOUTUBE_API_KEY || "",
    300
  );
}

/* =========================================================
   RESPUESTAS
========================================================= */

function sendError(res, status, message, code) {
  return res.status(status).json({
    error: true,
    message,
    code
  });
}

/* =========================================================
   YOUTUBE DATA API
========================================================= */

async function youtubeSearch(query, limit = DEFAULT_LIMIT) {
  const apiKey = getApiKey();

  if (!apiKey) {
    const error = new Error(
      "Falta configurar YOUTUBE_API_KEY en Vercel."
    );

    error.code = "MISSING_API_KEY";
    error.status = 500;

    throw error;
  }

  const params = new URLSearchParams({
    part: "snippet",
    type: "video",
    q: query,
    maxResults: String(clampLimit(limit)),
    videoCategoryId: "10",
    videoEmbeddable: "true",
    videoSyndicated: "true",
    regionCode: "CR",
    relevanceLanguage: "es",
    safeSearch: "moderate",
    key: apiKey
  });

  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT);

  let response;

  try {
    response = await fetch(
      `${YOUTUBE_API_URL}?${params.toString()}`,
      {
        method: "GET",
        headers: {
          Accept: "application/json"
        },
        signal: controller.signal
      }
    );
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error(
        "YouTube tardó demasiado en responder."
      );

      timeoutError.code = "YOUTUBE_TIMEOUT";
      timeoutError.status = 504;

      throw timeoutError;
    }

    const networkError = new Error(
      "No se pudo conectar con YouTube."
    );

    networkError.code = "YOUTUBE_NETWORK_ERROR";
    networkError.status = 502;

    throw networkError;
  } finally {
    clearTimeout(timeout);
  }

  let data;

  try {
    data = await response.json();
  } catch {
    const error = new Error(
      "YouTube devolvió una respuesta inválida."
    );

    error.code = "INVALID_YOUTUBE_RESPONSE";
    error.status = 502;

    throw error;
  }

  if (!response.ok) {
    const apiMessage =
      data?.error?.message ||
      "YouTube rechazó la solicitud.";

    const apiReason =
      data?.error?.errors?.[0]?.reason || "";

    const error = new Error(apiMessage);

    error.code =
      apiReason === "quotaExceeded"
        ? "YOUTUBE_QUOTA_EXCEEDED"
        : "YOUTUBE_API_ERROR";

    error.status =
      response.status === 403 ? 503 : 502;

    throw error;
  }

  return Array.isArray(data.items)
    ? data.items
    : [];
}

/* =========================================================
   NORMALIZACIÓN DE RESULTADOS
========================================================= */

function normalizeYouTubeItem(item, requestedArtist = "") {
  const videoId = cleanText(
    item?.id?.videoId || "",
    40
  );

  if (!videoId) {
    return null;
  }

  const snippet = item?.snippet || {};

  const title = cleanText(
    snippet.title || "",
    200
  );

  const channelTitle = cleanText(
    snippet.channelTitle || "",
    120
  );

  const thumbnail =
    snippet.thumbnails?.maxres?.url ||
    snippet.thumbnails?.high?.url ||
    snippet.thumbnails?.medium?.url ||
    snippet.thumbnails?.default?.url ||
    `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

  if (!title) {
    return null;
  }

  return {
    videoId,
    id: videoId,

    title,

    artist: channelTitle || requestedArtist,
    channel: channelTitle,
    channelTitle,

    thumbnail,

    duration: null,

    source: "youtube",

    needsResolve: false,

    searchQuery: "",

    sources: ["youtube"]
  };
}

function normalizeResults(items, requestedArtist = "") {
  const seen = new Set();
  const tracks = [];

  for (const item of items) {
    const track = normalizeYouTubeItem(
      item,
      requestedArtist
    );

    if (!track || seen.has(track.videoId)) {
      continue;
    }

    seen.add(track.videoId);
    tracks.push(track);
  }

  return tracks;
}

/* =========================================================
   CONSTRUCCIÓN DE CONSULTAS
========================================================= */

function buildRecommendationQuery(artist, title) {
  if (artist && title) {
    return `${artist} canciones similares a ${title}`;
  }

  if (artist) {
    return `${artist} canciones`;
  }

  return `${title} canción`;
}

function buildRadioQuery(artist) {
  return `${artist} canciones`;
}

function buildResolveQuery(artist, title) {
  const parts = [];

  if (artist) {
    parts.push(artist);
  }

  if (title) {
    parts.push(title);
  }

  parts.push("official audio");

  return parts.join(" ");
}

/* =========================================================
   RECOMENDACIONES
========================================================= */

async function getRecommendations(data) {
  const artist = normalizeArtist(data.artist);
  const title = normalizeTitle(data.title);

  const limit = clampLimit(data.limit);

  if (!artist && !title) {
    const error = new Error(
      "Debes proporcionar un artista o una canción."
    );

    error.code = "MISSING_TRACK_DATA";
    error.status = 400;

    throw error;
  }

  const query = buildRecommendationQuery(
    artist,
    title
  );

  const cacheKey = makeCacheKey({
    action: "recommend",
    artist,
    title,
    limit
  });

  const cached = getCache(cacheKey);

  if (cached) {
    return {
      tracks: cached,
      degraded: false,
      cached: true
    };
  }

  const items = await youtubeSearch(
    query,
    limit
  );

  const tracks = normalizeResults(
    items,
    artist
  );

  setCache(cacheKey, tracks);

  return {
    tracks,
    degraded: false,
    cached: false
  };
}

/* =========================================================
   RADIO DE ARTISTA
========================================================= */

async function getArtistRadio(data) {
  const artist = normalizeArtist(data.artist);
  const limit = clampLimit(data.limit);

  if (!artist) {
    const error = new Error(
      "Debes proporcionar el nombre de un artista."
    );

    error.code = "MISSING_ARTIST";
    error.status = 400;

    throw error;
  }

  const query = buildRadioQuery(artist);

  const cacheKey = makeCacheKey({
    action: "radio",
    artist,
    limit
  });

  const cached = getCache(cacheKey);

  if (cached) {
    return {
      tracks: cached,
      degraded: false,
      cached: true
    };
  }

  const items = await youtubeSearch(
    query,
    limit
  );

  const tracks = normalizeResults(
    items,
    artist
  );

  setCache(cacheKey, tracks);

  return {
    tracks,
    degraded: false,
    cached: false
  };
}

/* =========================================================
   RESOLVER CANCIÓN
========================================================= */

async function resolveRecommendation(data) {
  const artist = normalizeArtist(data.artist);
  const title = normalizeTitle(data.title);

  if (!artist && !title) {
    const error = new Error(
      "Faltan los datos de la canción."
    );

    error.code = "MISSING_TRACK_DATA";
    error.status = 400;

    throw error;
  }

  const query = buildResolveQuery(
    artist,
    title
  );

  const cacheKey = makeCacheKey({
    action: "resolve",
    artist,
    title
  });

  const cached = getCache(cacheKey);

  if (cached) {
    return {
      track: cached,
      degraded: false,
      cached: true
    };
  }

  const items = await youtubeSearch(query, 5);

  const tracks = normalizeResults(
    items,
    artist
  );

  const track = tracks[0] || null;

  if (track) {
    track.searchQuery = query;
    setCache(cacheKey, track);
  }

  return {
    track,
    degraded: !track,
    cached: false
  };
}

/* =========================================================
   LECTURA DEL BODY
========================================================= */

function readBody(req) {
  if (req.body && typeof req.body === "object") {
    return req.body;
  }

  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return null;
    }
  }

  return null;
}

/* =========================================================
   HANDLER PRINCIPAL — VERCEL
========================================================= */

export default async function handler(req, res) {
  res.setHeader(
    "Cache-Control",
    "no-store"
  );

  res.setHeader(
    "Content-Type",
    "application/json; charset=utf-8"
  );

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");

    return sendError(
      res,
      405,
      "Método no permitido. Utiliza POST.",
      "METHOD_NOT_ALLOWED"
    );
  }

  const data = readBody(req);

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return sendError(
      res,
      400,
      "El cuerpo de la solicitud debe ser JSON válido.",
      "INVALID_BODY"
    );
  }

  try {
    const action = cleanText(
      data.action || "recommend",
      30
    ).toLowerCase();

    let result;

    switch (action) {
      case "recommend":
        result = await getRecommendations(data);
        break;

      case "radio":
        result = await getArtistRadio(data);
        break;

      case "resolve":
        result = await resolveRecommendation(data);
        break;

      default:
        return sendError(
          res,
          400,
          "Acción no reconocida. Usa recommend, radio o resolve.",
          "INVALID_ACTION"
        );
    }

    return res.status(200).json(result);

  } catch (error) {
    const status = Number(error.status) || 500;

    const code =
      error.code || "RECOMMENDATION_ERROR";

    // El detalle técnico se registra en los logs de Vercel,
    // nunca se devuelve la clave de API al navegador.
    console.error("[Shunel Recommendations]", {
      code,
      message: error.message
    });

    return sendError(
      res,
      status,
      error.message || "No se pudieron obtener recomendaciones.",
      code
    );
  }
}
