
import { randomUUID } from "node:crypto";

// ─────────────────────────────────────────────
// Configuración
// ─────────────────────────────────────────────

const YOUTUBE_SEARCH_URL =
  "https://www.googleapis.com/youtube/v3/search";

const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 150;

const DEFAULT_RESULTS = 15;
const MAX_RESULTS_LIMIT = 25;

const REQUEST_TIMEOUT_MS = 8000;

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 100;

const MUSIC_CATEGORY_ID = "10";

const ALLOWED_ORDERS = new Set([
  "relevance",
  "viewCount",
  "date"
]);

const DEFAULT_ORDER = "relevance";

const YOUTUBE_FIELDS =
  "nextPageToken,items(id/videoId,snippet(title,channelTitle,description,publishedAt,thumbnails(default/url,medium/url,high/url)))";

// Caché en memoria.
// En serverless puede reiniciarse con cada instancia fría.
const cache = new Map();

// ─────────────────────────────────────────────
// Respuestas de error
// ─────────────────────────────────────────────

function sendError(
  res,
  status,
  code,
  message,
  extraHeaders = {}
) {
  for (const [key, value] of Object.entries(extraHeaders)) {
    res.setHeader(key, value);
  }

  res.setHeader("Cache-Control", "no-store");

  return res.status(status).json({
    success: false,
    code,
    error: message
  });
}

// ─────────────────────────────────────────────
// Validación y normalización
// ─────────────────────────────────────────────

function normalizeQuery(raw) {
  if (typeof raw !== "string") return null;

  const clean = raw
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (
    clean.length < MIN_QUERY_LENGTH ||
    clean.length > MAX_QUERY_LENGTH
  ) {
    return null;
  }

  return clean;
}

function parseMaxResults(raw) {
  if (raw === undefined) {
    return DEFAULT_RESULTS;
  }

  if (
    typeof raw !== "string" ||
    !/^\d{1,2}$/.test(raw)
  ) {
    return null;
  }

  const value = Number(raw);

  return value >= 1 && value <= MAX_RESULTS_LIMIT
    ? value
    : null;
}

function parseOrder(raw) {
  if (raw === undefined) {
    return DEFAULT_ORDER;
  }

  if (
    typeof raw !== "string" ||
    !ALLOWED_ORDERS.has(raw)
  ) {
    return null;
  }

  return raw;
}

function parsePageToken(raw) {
  if (raw === undefined) {
    return undefined;
  }

  if (
    typeof raw !== "string" ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(raw)
  ) {
    return null;
  }

  return raw;
}

// ─────────────────────────────────────────────
// Entidades HTML
// ─────────────────────────────────────────────

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'"
};

function decodeHtmlEntities(text) {
  return String(text).replace(
    /&(#x?[0-9a-f]+|[a-z]+);/gi,
    (match, entity) => {
      if (entity[0] === "#") {
        const isHex = entity[1].toLowerCase() === "x";

        const code = parseInt(
          entity.slice(isHex ? 2 : 1),
          isHex ? 16 : 10
        );

        if (
          !Number.isFinite(code) ||
          code < 0 ||
          code > 0x10ffff ||
          (code >= 0xd800 && code <= 0xdfff)
        ) {
          return match;
        }

        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }

      return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
    }
  );
}

// ─────────────────────────────────────────────
// Transformación de resultados
// ─────────────────────────────────────────────

function mapItem(item) {
  const snippet = item.snippet;
  const thumbs = snippet.thumbnails || {};

  return {
    videoId: item.id.videoId,

    title: decodeHtmlEntities(
      snippet.title || "Sin título"
    ),

    channelTitle: decodeHtmlEntities(
      snippet.channelTitle || "Canal desconocido"
    ).replace(/ - Topic$/i, ""),

    description: decodeHtmlEntities(
      snippet.description || ""
    ),

    publishedAt: snippet.publishedAt || null,

    thumbnail:
      thumbs.high?.url ||
      thumbs.medium?.url ||
      thumbs.default?.url ||
      null
  };
}

function isValidYouTubeItem(item) {
  return (
    item &&
    typeof item === "object" &&
    typeof item.id?.videoId === "string" &&
    /^[a-zA-Z0-9_-]{11}$/.test(item.id.videoId) &&
    item.snippet &&
    typeof item.snippet === "object"
  );
}

// ─────────────────────────────────────────────
// Caché
// ─────────────────────────────────────────────

function getFromCache(key) {
  const entry = cache.get(key);

  if (!entry) return null;

  if (Date.now() >= entry.expiresAt) {
    cache.delete(key);
    return null;
  }

  // Actualiza la posición para mantener
  // el comportamiento LRU.
  cache.delete(key);
  cache.set(key, entry);

  return entry.payload;
}

function saveInCache(key, payload) {
  // Si la clave ya existe, se actualiza
  // sin eliminar otra entrada innecesariamente.
  if (cache.has(key)) {
    cache.delete(key);
  }

  while (cache.size >= CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;

    if (oldestKey === undefined) break;

    cache.delete(oldestKey);
  }

  cache.set(key, {
    payload,
    expiresAt: Date.now() + CACHE_TTL_MS
  });
}

function cleanExpiredCache() {
  const now = Date.now();

  for (const [key, entry] of cache.entries()) {
    if (now >= entry.expiresAt) {
      cache.delete(key);
    }
  }
}

// ─────────────────────────────────────────────
// Lectura segura de JSON
// ─────────────────────────────────────────────

async function safeJson(response) {
  try {
    return await response.json();
  } catch (error) {
    if (error.name === "AbortError") {
      throw error;
    }

    return null;
  }
}

// ─────────────────────────────────────────────
// Errores de YouTube
// ─────────────────────────────────────────────

function mapYouTubeError(status, data) {
  const reason =
    data?.error?.errors?.[0]?.reason || "";

  if (
    reason === "quotaExceeded" ||
    reason === "dailyLimitExceeded" ||
    reason === "rateLimitExceeded"
  ) {
    return {
      status: 429,
      code: "QUOTA_EXCEEDED",
      message:
        "Se alcanzó el límite de búsquedas por hoy. Inténtalo más tarde.",
      headers: {
        "Retry-After": "3600"
      }
    };
  }

  if (
    [
      "keyInvalid",
      "ipRefererBlocked",
      "accessNotConfigured",
      "forbidden"
    ].includes(reason)
  ) {
    return {
      status: 502,
      code: "UPSTREAM_CONFIG",
      message:
        "YouTube rechazó la búsqueda. Revisa la API Key, sus restricciones y que la API esté habilitada."
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
    message:
      "YouTube no pudo completar la búsqueda. Inténtalo de nuevo."
  };
}

// ─────────────────────────────────────────────
// Handler principal
// ─────────────────────────────────────────────

export default async function handler(req, res) {
  const requestId = randomUUID();

  res.setHeader("X-Request-Id", requestId);
  res.setHeader("X-Content-Type-Options", "nosniff");

  // Método HTTP
  if (req.method !== "GET") {
    return sendError(
      res,
      405,
      "METHOD_NOT_ALLOWED",
      "Método no permitido.",
      { Allow: "GET" }
    );
  }

  // Consulta
  const query = normalizeQuery(req.query.q);

  if (!query) {
    return sendError(
      res,
      400,
      "INVALID_QUERY",
      `Escribe una búsqueda válida (entre ${MIN_QUERY_LENGTH} y ${MAX_QUERY_LENGTH} caracteres).`
    );
  }

  // Cantidad de resultados
  const maxResults = parseMaxResults(
    req.query.maxResults
  );

  if (maxResults === null) {
    return sendError(
      res,
      400,
      "INVALID_MAX_RESULTS",
      `maxResults debe ser un número entre 1 y ${MAX_RESULTS_LIMIT}.`
    );
  }

  // Orden de resultados
  const order = parseOrder(req.query.order);

  if (order === null) {
    return sendError(
      res,
      400,
      "INVALID_ORDER",
      "El orden debe ser relevance, viewCount o date."
    );
  }

  // Paginación
  const pageToken = parsePageToken(
    req.query.pageToken
  );

  if (pageToken === null) {
    return sendError(
      res,
      400,
      "INVALID_PAGE_TOKEN",
      "El token de página no es válido."
    );
  }

  // API Key
  const apiKey = process.env.YOUTUBE_API_KEY;

  if (!apiKey) {
    console.error(
      JSON.stringify({
        requestId,
        level: "error",
        msg: "Falta YOUTUBE_API_KEY"
      })
    );

    return sendError(
      res,
      500,
      "SERVICE_NOT_CONFIGURED",
      "El servicio de búsqueda no está configurado."
    );
  }

  // ───────────────────────────────────────────
  // Caché
  // ───────────────────────────────────────────

  cleanExpiredCache();

  const cacheKey = [
    query.toLowerCase(),
    order,
    maxResults,
    pageToken || ""
  ].join("|");

  const cached = getFromCache(cacheKey);

  if (cached) {
    res.setHeader("X-Cache", "HIT");

    res.setHeader(
      "Cache-Control",
      "public, s-maxage=600, stale-while-revalidate=3600, stale-if-error=86400"
    );

    return res.status(200).json(cached);
  }

  // ───────────────────────────────────────────
  // Solicitud a YouTube
  // ───────────────────────────────────────────

  const controller = new AbortController();

  let timedOut = false;

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  try {
    const params = new URLSearchParams({
      part: "snippet",
      q: query,
      type: "video",

      videoCategoryId: MUSIC_CATEGORY_ID,

      videoEmbeddable: "true",
      videoSyndicated: "true",

      order,

      maxResults: String(maxResults),

      safeSearch: "moderate",

      fields: YOUTUBE_FIELDS,

      key: apiKey
    });

    if (pageToken) {
      params.set("pageToken", pageToken);
    }

    const response = await fetch(
      `${YOUTUBE_SEARCH_URL}?${params}`,
      {
        method: "GET",
        signal: controller.signal,
        headers: {
          Accept: "application/json"
        }
      }
    );

    const data = await safeJson(response);

    if (timedOut) {
      throw new Error("UPSTREAM_TIMEOUT");
    }

    if (!response.ok || !data) {
      const mapped = mapYouTubeError(
        response.status,
        data
      );

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

      return sendError(
        res,
        mapped.status,
        mapped.code,
        mapped.message,
        mapped.headers
      );
    }

    // ─────────────────────────────────────────
    // Validación y transformación
    // ─────────────────────────────────────────

    const rawItems = Array.isArray(data.items)
      ? data.items
      : [];

    const items = rawItems
      .filter(isValidYouTubeItem)
      .map(mapItem);

    // ─────────────────────────────────────────
    // Respuesta
    // ─────────────────────────────────────────

    const payload = {
      success: true,
      query,
      order,
      total: items.length,
      nextPageToken: data.nextPageToken || null,
      items
    };

    saveInCache(cacheKey, payload);

    res.setHeader("X-Cache", "MISS");

    res.setHeader(
      "Cache-Control",
      "public, s-maxage=600, stale-while-revalidate=3600, stale-if-error=86400"
    );

    return res.status(200).json(payload);

  } catch (error) {
    if (
      timedOut ||
      error.name === "AbortError" ||
      error.message === "UPSTREAM_TIMEOUT"
    ) {
      console.error(
        JSON.stringify({
          requestId,
          level: "error",
          msg: "Timeout hacia YouTube"
        })
      );

      return sendError(
        res,
        504,
        "UPSTREAM_TIMEOUT",
        "YouTube tardó demasiado en responder. Inténtalo de nuevo."
      );
    }

    console.error(
      JSON.stringify({
        requestId,
        level: "error",
        msg: "Error interno",
        error: error.message
      })
    );

    return sendError(
      res,
      500,
      "INTERNAL_ERROR",
      "Error interno al buscar música."
    );

  } finally {
    clearTimeout(timeout);
  }
}
