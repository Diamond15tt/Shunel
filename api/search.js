import { randomUUID } from "node:crypto";

// ─────────────────────────────────────────────
// Configuración
// ─────────────────────────────────────────────
const YOUTUBE_SEARCH_URL = "https://www.googleapis.com/youtube/v3/search";
const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 150;
const DEFAULT_RESULTS = 15;
const MAX_RESULTS_LIMIT = 25;
const REQUEST_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutos
const CACHE_MAX_ENTRIES = 100;
const MUSIC_CATEGORY_ID = "10";

// Solo pedimos a YouTube los campos que usamos (menos payload)
const YOUTUBE_FIELDS =
  "nextPageToken,items(id/videoId,snippet(title,channelTitle,description,publishedAt,thumbnails(default/url,medium/url,high/url)))";

// Caché en memoria (best-effort: en serverless se reinicia con cada instancia fría).
// Para una caché real y compartida, usa Upstash Redis o Vercel KV.
const cache = new Map();

// ─────────────────────────────────────────────
// Utilidades
// ─────────────────────────────────────────────
function sendError(res, status, code, message, extraHeaders = {}) {
  for (const [key, value] of Object.entries(extraHeaders)) {
    res.setHeader(key, value);
  }
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json({ success: false, code, error: message });
}

function normalizeQuery(raw) {
  if (typeof raw !== "string") return null;
  
  const clean = raw
    .replace(/[\u0000-\u001F\u007F]/g, " ") // caracteres de control
    .replace(/\s+/g, " ")
    .trim();
  
  if (clean.length < MIN_QUERY_LENGTH || clean.length > MAX_QUERY_LENGTH) {
    return null;
  }
  return clean;
}

function parseMaxResults(raw) {
  if (raw === undefined) return DEFAULT_RESULTS;
  if (typeof raw !== "string" || !/^\d{1,2}$/.test(raw)) return null;
  
  const value = Number(raw);
  return value >= 1 && value <= MAX_RESULTS_LIMIT ? value : null;
}

function parsePageToken(raw) {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(raw)) return null;
  return raw;
}

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'"
};

// YouTube devuelve títulos con entidades HTML (&amp;, &#39;, etc.)
function decodeHtmlEntities(text) {
  return String(text).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === "#") {
      const isHex = entity[1].toLowerCase() === "x";
      const code = parseInt(entity.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ?
        String.fromCodePoint(code) :
        match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function mapItem(item) {
  const snippet = item.snippet;
  const thumbs = snippet.thumbnails || {};
  
  return {
    videoId: item.id.videoId,
    title: decodeHtmlEntities(snippet.title || "Sin título"),
    channelTitle: decodeHtmlEntities(snippet.channelTitle || "Canal desconocido").replace(/ - Topic$/, ""),
    description: decodeHtmlEntities(snippet.description || ""),
    publishedAt: snippet.publishedAt || null,
    thumbnail: thumbs.high?.url || thumbs.medium?.url || thumbs.default?.url || null
  };
}

function getFromCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.payload;
}

function saveInCache(key, payload) {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    // Elimina la entrada más antigua (los Map conservan el orden de inserción)
    cache.delete(cache.keys().next().value);
  }
  cache.set(key, { payload, expiresAt: Date.now() + CACHE_TTL_MS });
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

// Traduce el error de YouTube a una respuesta propia
function mapYouTubeError(status, data) {
  const reason = data?.error?.errors?.[0]?.reason || "";
  
  if (reason === "quotaExceeded" || reason === "dailyLimitExceeded" || reason === "rateLimitExceeded") {
    return {
      status: 429,
      code: "QUOTA_EXCEEDED",
      message: "Se alcanzó el límite de búsquedas por hoy. Inténtalo más tarde.",
      headers: { "Retry-After": "3600" }
    };
  }
  
  if (["keyInvalid", "ipRefererBlocked", "accessNotConfigured", "forbidden"].includes(reason)) {
    return {
      status: 502,
      code: "UPSTREAM_CONFIG",
      message: "YouTube rechazó la búsqueda. Revisa la API Key, sus restricciones y que la API esté habilitada."
    };
  }
  
  if (status === 400) {
    return {
      status: 400,
      code: "UPSTREAM_BAD_REQUEST",
      message: "La búsqueda no es válida."
    };
  }
  
  return {
    status: 502,
    code: "UPSTREAM_ERROR",
    message: "YouTube no pudo completar la búsqueda. Inténtalo de nuevo."
  };
}

// ─────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────
export default async function handler(req, res) {
  const requestId = randomUUID();
  res.setHeader("X-Request-Id", requestId);
  res.setHeader("X-Content-Type-Options", "nosniff");
  
  if (req.method !== "GET") {
    return sendError(res, 405, "METHOD_NOT_ALLOWED", "Método no permitido.", { Allow: "GET" });
  }
  
  const query = normalizeQuery(req.query.q);
  if (!query) {
    return sendError(
      res,
      400,
      "INVALID_QUERY",
      `Escribe una búsqueda válida (entre ${MIN_QUERY_LENGTH} y ${MAX_QUERY_LENGTH} caracteres).`
    );
  }
  
  const maxResults = parseMaxResults(req.query.maxResults);
  if (maxResults === null) {
    return sendError(res, 400, "INVALID_MAX_RESULTS", `maxResults debe ser un número entre 1 y ${MAX_RESULTS_LIMIT}.`);
  }
  
  const pageToken = parsePageToken(req.query.pageToken);
  if (pageToken === null) {
    return sendError(res, 400, "INVALID_PAGE_TOKEN", "El token de página no es válido.");
  }
  
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    console.error(JSON.stringify({ requestId, level: "error", msg: "Falta YOUTUBE_API_KEY" }));
    return sendError(res, 500, "SERVICE_NOT_CONFIGURED", "El servicio de búsqueda no está configurado.");
  }
  
  // Caché por query normalizada (cada búsqueda cuesta 100 unidades de cuota)
  const cacheKey = `${query.toLowerCase()}|${maxResults}|${pageToken || ""}`;
  const cached = getFromCache(cacheKey);
  if (cached) {
    res.setHeader("X-Cache", "HIT");
    res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=3600, stale-if-error=86400");
    return res.status(200).json(cached);
  }
  
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  
  try {
    const params = new URLSearchParams({
      part: "snippet",
      q: query,
      type: "video",
      videoCategoryId: MUSIC_CATEGORY_ID,
      videoEmbeddable: "true",
      videoSyndicated: "true",
      order: "relevance",
      maxResults: String(maxResults),
      safeSearch: "moderate",
      fields: YOUTUBE_FIELDS,
      key: apiKey
    });
    if (pageToken) params.set("pageToken", pageToken);
    
    const response = await fetch(`${YOUTUBE_SEARCH_URL}?${params}`, { signal: controller.signal });
    const data = await safeJson(response);
    
    if (!response.ok || !data) {
      const mapped = mapYouTubeError(response.status, data);
      console.error(
        JSON.stringify({
          requestId,
          level: "error",
          msg: "Error de YouTube API",
          httpStatus: response.status,
          reason: data?.error?.errors?.[0]?.reason,
          message: data?.error?.message
        })
      );
      return sendError(res, mapped.status, mapped.code, mapped.message, mapped.headers);
    }
    
    const items = (data.items || [])
      .filter(item => item.id?.videoId && item.snippet)
      .map(mapItem);
    
    const payload = {
      success: true,
      query,
      total: items.length,
      nextPageToken: data.nextPageToken || null,
      items
    };
    
    saveInCache(cacheKey, payload);
    
    res.setHeader("X-Cache", "MISS");
    res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=3600, stale-if-error=86400");
    return res.status(200).json(payload);
  } catch (error) {
    if (error.name === "AbortError") {
      console.error(JSON.stringify({ requestId, level: "error", msg: "Timeout hacia YouTube" }));
      return sendError(res, 504, "UPSTREAM_TIMEOUT", "YouTube tardó demasiado en responder. Inténtalo de nuevo.");
    }
    
    console.error(JSON.stringify({ requestId, level: "error", msg: "Error interno", error: error.message }));
    return sendError(res, 500, "INTERNAL_ERROR", "Error interno al buscar música.");
  } finally {
    clearTimeout(timeout);
  }
}