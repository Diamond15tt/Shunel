
/* =========================================================
   SHUNEL — SEARCH ENGINE 5.0

   Búsqueda, validación, caché LRU, historial,
   peticiones compartidas, cancelación y paginación.

   COMPATIBILIDAD:
   - searchTracks(query, signal)
   - searchTracks(query, signal, options)
   - searchTracks(query, options)
   - searchTracksAdvanced(query, options, signal)
   - searchPopularTracks()
   - searchNewTracks()
   - searchRelevantTracks()
   - searchTracksPage()
   - Mantiene /api/search.
   - Mantiene el formato de canciones del servidor.
   - Conserva las funciones públicas de 4.1.

   REQUISITO DEL SERVIDOR:
   /api/search debe aceptar:
   - q
   - order
   - maxResults
   - pageToken

   IMPORTANTE:
   La cancelación de un consumidor no cancela las
   peticiones de otros consumidores.
========================================================= */

const SEARCH_ENDPOINT = "/api/search";

/* =========================================================
   01. CONFIGURACIÓN
========================================================= */

const CONFIG = Object.freeze({
  version: "5.0",

  maxQueryLength: 150,
  minQueryLength: 1,

  timeout: 15000,

  cacheTTL: 3 * 60 * 1000,
  maxCacheEntries: 40,
  maxCacheBytes: 5 * 1024 * 1024,

  maxResponseBytes: 2 * 1024 * 1024,
  maxErrorMessageLength: 250,

  maxRecentSearches: 20,
  recentStorageKey: "shunel_recent_searches",

  maxResults: 100,
  defaultSort: "relevance",

  defaultOrder: "relevance",
  defaultRequestResults: 15,
  maxRequestResults: 25,

  maxPageTokenLength: 4096,
  maxTrackTextLength: 1000,
  maxCloneDepth: 12,

  maxConcurrentRequests: 8
});

const VIDEO_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;

const ALLOWED_SORTS = Object.freeze([
  "relevance",
  "title",
  "artist",
  "duration"
]);

const ALLOWED_ORDERS = Object.freeze([
  "relevance",
  "viewCount",
  "date"
]);

const collator = typeof Intl !== "undefined" &&
  typeof Intl.Collator === "function"
    ? new Intl.Collator(undefined, {
        sensitivity: "base",
        numeric: true,
        usage: "sort"
      })
    : null;

/* =========================================================
   02. ESTADO INTERNO
========================================================= */

const searchCache = new Map();
const inFlightRequests = new Map();
const recentSearches = [];

let cacheBytes = 0;
let requestGeneration = 0;

const statistics = {
  totalSearches: 0,
  successfulSearches: 0,
  failedSearches: 0,
  cancelledSearches: 0,

  cacheHits: 0,
  sharedRequests: 0,

  totalDuration: 0,
  lastSearchDuration: 0,

  totalHttpRequests: 0,
  totalPages: 0
};

/* =========================================================
   03. ERRORES
========================================================= */

export class SearchError extends Error {
  constructor(message, code = "SEARCH_ERROR", details = {}) {
    super(message);

    this.name = "SearchError";
    this.code = code;
    this.details = details;

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, SearchError);
    }
  }
}

function createAbortError() {
  const error = new Error("La búsqueda fue cancelada.");

  error.name = "AbortError";
  error.code = "SEARCH_ABORTED";

  return error;
}

function createTimeoutError() {
  return new SearchError(
    "La búsqueda tardó demasiado. Intentá nuevamente.",
    "SEARCH_TIMEOUT"
  );
}

function isAbortError(error) {
  return (
    error?.name === "AbortError" ||
    error?.code === "SEARCH_ABORTED"
  );
}

/* =========================================================
   04. UTILIDADES GENERALES
========================================================= */

function isObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function isPlainObject(value) {
  if (!isObject(value)) return false;

  const prototype = Object.getPrototypeOf(value);

  return (
    prototype === Object.prototype ||
    prototype === null
  );
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function safeString(value) {
  if (typeof value === "string") {
    return value;
  }

  if (
    typeof value === "number" &&
    Number.isFinite(value)
  ) {
    return String(value);
  }

  return "";
}

function normalizeWhitespace(value) {
  return value
    .replace(/[\s\u00A0]+/g, " ")
    .trim();
}

function isAbortSignal(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.aborted === "boolean" &&
    typeof value.addEventListener === "function" &&
    typeof value.removeEventListener === "function"
  );
}

function getCurrentTime() {
  return (
    typeof performance !== "undefined" &&
    typeof performance.now === "function"
  )
    ? performance.now()
    : Date.now();
}

function getOrigin() {
  if (
    typeof globalThis !== "undefined" &&
    globalThis.location?.origin
  ) {
    return globalThis.location.origin;
  }

  return "http://localhost";
}

function compareStrings(first, second) {
  if (collator) {
    return collator.compare(first, second);
  }

  return first.localeCompare(second);
}

function normalizeForComparison(value) {
  return safeString(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase();
}

/* =========================================================
   05. COPIAS SEGURAS
========================================================= */

function cloneData(value, depth = 0, seen = new WeakMap()) {
  if (
    value === null ||
    typeof value !== "object"
  ) {
    return value;
  }

  if (depth >= CONFIG.maxCloneDepth) {
    return undefined;
  }

  if (seen.has(value)) {
    return seen.get(value);
  }

  if (Array.isArray(value)) {
    const result = [];

    seen.set(value, result);

    for (const item of value) {
      result.push(
        cloneData(item, depth + 1, seen)
      );
    }

    return result;
  }

  if (!isPlainObject(value)) {
    return undefined;
  }

  const result = {};

  seen.set(value, result);

  for (const key of Object.keys(value)) {
    if (
      key === "__proto__" ||
      key === "constructor" ||
      key === "prototype"
    ) {
      continue;
    }

    const cloned = cloneData(
      value[key],
      depth + 1,
      seen
    );

    if (cloned !== undefined) {
      result[key] = cloned;
    }
  }

  return result;
}

function cloneTracks(items) {
  return items.map(track => cloneData(track));
}

function estimateSize(value) {
  try {
    const serialized = JSON.stringify(value);

    if (!serialized) return 0;

    return serialized.length * 2;
  } catch {
    return 0;
  }
}

/* =========================================================
   06. NORMALIZACIÓN DE CONSULTAS
========================================================= */

export function normalizeSearchQuery(query) {
  if (
    typeof query !== "string" &&
    typeof query !== "number"
  ) {
    return "";
  }

  if (
    typeof query === "number" &&
    !Number.isFinite(query)
  ) {
    return "";
  }

  let value = String(query);

  value = value.normalize("NFC");

  value = value.replace(
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,
    ""
  );

  value = value.replace(
    /[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g,
    ""
  );

  value = value.replace(/[‘’ʼ]/g, "'");

  return normalizeWhitespace(value);
}

function getNormalizedKey(query) {
  return normalizeSearchQuery(query)
    .toLocaleLowerCase()
    .normalize("NFC");
}

/* =========================================================
   07. VALIDACIÓN DE CONSULTAS
========================================================= */

function validateQuery(query) {
  const cleanQuery = normalizeSearchQuery(query);

  if (!cleanQuery) {
    throw new SearchError(
      "Escribe qué música quieres buscar.",
      "EMPTY_QUERY"
    );
  }

  if (cleanQuery.length < CONFIG.minQueryLength) {
    throw new SearchError(
      "La búsqueda es demasiado corta.",
      "QUERY_TOO_SHORT"
    );
  }

  if (
    Array.from(cleanQuery).length >
    CONFIG.maxQueryLength
  ) {
    throw new SearchError(
      "La búsqueda es demasiado larga.",
      "QUERY_TOO_LONG"
    );
  }

  return cleanQuery;
}

/* =========================================================
   08. OPCIONES DE BÚSQUEDA
========================================================= */

function normalizeSearchOptions(options = {}) {
  const source = isPlainObject(options)
    ? options
    : {};

  const requestedOrder = source.order;

  const order = ALLOWED_ORDERS.includes(requestedOrder)
    ? requestedOrder
    : CONFIG.defaultOrder;

  const requestedResults = source.maxResults;

  let maxResults = CONFIG.defaultRequestResults;

  if (
    requestedResults !== undefined &&
    requestedResults !== null &&
    requestedResults !== ""
  ) {
    const number = Number(requestedResults);

    if (Number.isFinite(number)) {
      maxResults = clamp(
        Math.floor(number),
        1,
        CONFIG.maxRequestResults
      );
    }
  }

  return {
    order,
    maxResults
  };
}

function createRequestKey(query, options = {}) {
  const normalizedQuery = getNormalizedKey(query);

  const normalizedOptions = normalizeSearchOptions(
    options
  );

  return [
    normalizedQuery,
    normalizedOptions.order,
    normalizedOptions.maxResults
  ].join("|");
}

/* =========================================================
   09. VALIDACIÓN DE VIDEO ID
========================================================= */

export function isValidVideoId(videoId) {
  return (
    typeof videoId === "string" &&
    VIDEO_ID_REGEX.test(videoId)
  );
}

/* =========================================================
   10. VALIDACIÓN DE URL
========================================================= */

export function isSafeHttpUrl(value) {
  if (
    typeof value !== "string" ||
    !value.trim()
  ) {
    return false;
  }

  try {
    const url = new URL(value);

    return (
      url.protocol === "https:" ||
      url.protocol === "http:"
    );
  } catch {
    return false;
  }
}

function normalizeThumbnail(value) {
  if (!isSafeHttpUrl(value)) {
    return undefined;
  }

  try {
    const url = new URL(value);

    if (
      typeof globalThis !== "undefined" &&
      globalThis.location?.protocol === "https:" &&
      url.protocol !== "https:"
    ) {
      return undefined;
    }

    return url.href;
  } catch {
    return undefined;
  }
}

/* =========================================================
   11. VALIDACIÓN DE DURACIÓN
========================================================= */

export function normalizeDuration(value) {
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0
  ) {
    return value;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const clean = value.trim();

  if (!clean) return undefined;

  if (/^\d+(\.\d+)?$/.test(clean)) {
    const number = Number(clean);

    return Number.isFinite(number) && number >= 0
      ? number
      : undefined;
  }

  const parts = clean.split(":");

  if (
    parts.length < 2 ||
    parts.length > 3 ||
    !parts.every(part => /^\d+$/.test(part))
  ) {
    return undefined;
  }

  const numbers = parts.map(Number);

  if (
    numbers.some(number => !Number.isFinite(number))
  ) {
    return undefined;
  }

  if (
    numbers.slice(1).some(number => number >= 60)
  ) {
    return undefined;
  }

  if (numbers.length === 2) {
    return numbers[0] * 60 + numbers[1];
  }

  return (
    numbers[0] * 3600 +
    numbers[1] * 60 +
    numbers[2]
  );
}

/* =========================================================
   12. VALIDACIÓN DE CANCIONES
========================================================= */

export function isValidTrack(track) {
  if (!isPlainObject(track)) {
    return false;
  }

  if (!isValidVideoId(track.videoId)) {
    return false;
  }

  if (
    typeof track.title !== "string" ||
    !track.title.trim()
  ) {
    return false;
  }

  if (
    track.title.length >
    CONFIG.maxTrackTextLength
  ) {
    return false;
  }

  return true;
}

function normalizeTrack(track) {
  if (!isValidTrack(track)) {
    return null;
  }

  const normalized = cloneData(track);

  if (!normalized) return null;

  normalized.videoId = track.videoId;

  normalized.title = normalizeWhitespace(
    track.title.normalize("NFC")
  );

  if (typeof track.artist === "string") {
    normalized.artist = normalizeWhitespace(
      track.artist.normalize("NFC")
    ).slice(0, CONFIG.maxTrackTextLength);
  } else {
    delete normalized.artist;
  }

  if (typeof track.channelTitle === "string") {
    normalized.channelTitle = normalizeWhitespace(
      track.channelTitle.normalize("NFC")
    ).slice(0, CONFIG.maxTrackTextLength);
  } else {
    delete normalized.channelTitle;
  }

  if (track.duration !== undefined) {
    const duration = normalizeDuration(track.duration);

    if (duration !== undefined) {
      normalized.duration = duration;
    } else {
      delete normalized.duration;
    }
  }

  if (track.durationSeconds !== undefined) {
    const duration = normalizeDuration(
      track.durationSeconds
    );

    if (duration !== undefined) {
      normalized.durationSeconds = duration;
    } else {
      delete normalized.durationSeconds;
    }
  }

  const thumbnail = normalizeThumbnail(
    track.thumbnail
  );

  if (thumbnail) {
    normalized.thumbnail = thumbnail;
  } else {
    delete normalized.thumbnail;
  }

  const thumbnailUrl = normalizeThumbnail(
    track.thumbnailUrl
  );

  if (thumbnailUrl) {
    normalized.thumbnailUrl = thumbnailUrl;
  } else {
    delete normalized.thumbnailUrl;
  }

  return normalized;
}

/* =========================================================
   13. ELIMINACIÓN DE DUPLICADOS
========================================================= */

export function deduplicateTracks(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  const seen = new Set();
  const results = [];

  for (const track of items) {
    if (!isValidTrack(track)) continue;

    if (seen.has(track.videoId)) continue;

    const normalized = normalizeTrack(track);

    if (!normalized) continue;

    seen.add(normalized.videoId);

    results.push(normalized);

    if (results.length >= CONFIG.maxResults) {
      break;
    }
  }

  return results;
}

/* =========================================================
   14. ORDENAMIENTO LOCAL
========================================================= */

export function sortTracks(
  items,
  mode = CONFIG.defaultSort
) {
  if (!Array.isArray(items)) {
    return [];
  }

  const results = [...items];

  if (!ALLOWED_SORTS.includes(mode)) {
    return results;
  }

  if (mode === "relevance") {
    return results;
  }

  const decorated = results.map((track, index) => ({
    track,
    index
  }));

  decorated.sort((first, second) => {
    const a = first.track;
    const b = second.track;

    let result = 0;

    if (mode === "title") {
      result = compareStrings(
        safeString(a?.title),
        safeString(b?.title)
      );
    }

    if (mode === "artist") {
      result = compareStrings(
        safeString(a?.artist || a?.channelTitle),
        safeString(b?.artist || b?.channelTitle)
      );
    }

    if (mode === "duration") {
      const firstDuration = normalizeDuration(
        a?.duration ?? a?.durationSeconds
      );

      const secondDuration = normalizeDuration(
        b?.duration ?? b?.durationSeconds
      );

      if (firstDuration === undefined) {
        result = secondDuration === undefined ? 0 : 1;
      } else if (secondDuration === undefined) {
        result = -1;
      } else {
        result = firstDuration - secondDuration;
      }
    }

    return result || first.index - second.index;
  });

  return decorated.map(item => item.track);
}

/* =========================================================
   15. FILTROS LOCALES
========================================================= */

export function filterTracks(items, filters = {}) {
  if (!Array.isArray(items)) {
    return [];
  }

  if (!isPlainObject(filters)) {
    filters = {};
  }

  let results = [...items];

  if (filters.artist) {
    const artist = normalizeForComparison(
      normalizeSearchQuery(filters.artist)
    );

    results = results.filter(track => {
      const name = normalizeForComparison(
        track?.artist || track?.channelTitle
      );

      return name.includes(artist);
    });
  }

  const min = filters.minDuration === undefined
    ? undefined
    : Number(filters.minDuration);

  const max = filters.maxDuration === undefined
    ? undefined
    : Number(filters.maxDuration);

  const validMin = Number.isFinite(min) && min >= 0;
  const validMax = Number.isFinite(max) && max >= 0;

  if (
    validMin &&
    validMax &&
    min > max
  ) {
    return [];
  }

  if (validMin || validMax) {
    results = results.filter(track => {
      const duration = normalizeDuration(
        track?.duration ?? track?.durationSeconds
      );

      if (duration === undefined) {
        return false;
      }

      if (validMin && duration < min) {
        return false;
      }

      if (validMax && duration > max) {
        return false;
      }

      return true;
    });
  }

  if (filters.query) {
    const query = normalizeForComparison(
      normalizeSearchQuery(filters.query)
    );

    results = results.filter(track => {
      const title = normalizeForComparison(
        track?.title
      );

      const artist = normalizeForComparison(
        track?.artist || track?.channelTitle
      );

      return (
        title.includes(query) ||
        artist.includes(query)
      );
    });
  }

  return results;
}

/* =========================================================
   16. CACHÉ LRU
========================================================= */

function removeCacheEntry(key) {
  const entry = searchCache.get(key);

  if (!entry) return;

  cacheBytes = Math.max(
    0,
    cacheBytes - entry.size
  );

  searchCache.delete(key);
}

function getCachedResults(key) {
  const entry = searchCache.get(key);

  if (!entry) return null;

  if (Date.now() >= entry.expiresAt) {
    removeCacheEntry(key);
    return null;
  }

  searchCache.delete(key);
  searchCache.set(key, entry);

  statistics.cacheHits++;

  return cloneTracks(entry.items);
}

function setCachedResults(key, items) {
  if (!Array.isArray(items)) return;

  if (searchCache.has(key)) {
    removeCacheEntry(key);
  }

  const cloned = cloneTracks(items);
  const size = estimateSize(cloned);

  if (size > CONFIG.maxCacheBytes) {
    return;
  }

  while (
    searchCache.size >= CONFIG.maxCacheEntries ||
    cacheBytes + size > CONFIG.maxCacheBytes
  ) {
    const oldestKey = searchCache.keys().next().value;

    if (oldestKey === undefined) break;

    removeCacheEntry(oldestKey);
  }

  const entry = {
    items: cloned,
    size,
    expiresAt: Date.now() + CONFIG.cacheTTL
  };

  searchCache.set(key, entry);
  cacheBytes += size;
}

export function clearSearchCache() {
  searchCache.clear();
  cacheBytes = 0;
}

export function cleanSearchCache() {
  const now = Date.now();

  for (const [key, entry] of searchCache) {
    if (now >= entry.expiresAt) {
      removeCacheEntry(key);
    }
  }
}

/* =========================================================
   17. HISTORIAL DE BÚSQUEDAS
========================================================= */

function loadRecentSearches() {
  try {
    if (typeof localStorage === "undefined") {
      return;
    }

    const saved = localStorage.getItem(
      CONFIG.recentStorageKey
    );

    if (!saved) return;

    const parsed = JSON.parse(saved);

    if (!Array.isArray(parsed)) return;

    const seen = new Set();
    const valid = [];

    for (const item of parsed) {
      if (typeof item !== "string") continue;

      const normalized = normalizeSearchQuery(item);

      if (
        !normalized ||
        Array.from(normalized).length >
          CONFIG.maxQueryLength
      ) {
        continue;
      }

      const key = getNormalizedKey(normalized);

      if (seen.has(key)) continue;

      seen.add(key);
      valid.push(normalized);

      if (valid.length >= CONFIG.maxRecentSearches) {
        break;
      }
    }

    recentSearches.length = 0;
    recentSearches.push(...valid);

  } catch {
    recentSearches.length = 0;
  }
}

function saveRecentSearches() {
  try {
    if (typeof localStorage === "undefined") {
      return;
    }

    localStorage.setItem(
      CONFIG.recentStorageKey,
      JSON.stringify(recentSearches)
    );
  } catch {
    // El historial es opcional.
  }
}

function rememberSearch(query) {
  const cleanQuery = validateQuery(query);
  const key = getNormalizedKey(cleanQuery);

  const index = recentSearches.findIndex(
    item => getNormalizedKey(item) === key
  );

  if (index !== -1) {
    recentSearches.splice(index, 1);
  }

  recentSearches.unshift(cleanQuery);

  if (recentSearches.length > CONFIG.maxRecentSearches) {
    recentSearches.length = CONFIG.maxRecentSearches;
  }

  saveRecentSearches();
}

export function getRecentSearches() {
  return [...recentSearches];
}

export function clearRecentSearches() {
  recentSearches.length = 0;

  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(CONFIG.recentStorageKey);
    }
  } catch {
    // El almacenamiento puede estar deshabilitado.
  }
}

/* =========================================================
   18. ESTADÍSTICAS
========================================================= */

export function getSearchStats() {
  let activeConsumers = 0;

  for (const entry of inFlightRequests.values()) {
    activeConsumers += entry.consumers;
  }

  return {
    ...statistics,

    cacheEntries: searchCache.size,
    cacheBytes,

    activeRequests: inFlightRequests.size,
    activeConsumers,

    averageDuration:
      statistics.successfulSearches > 0
        ? Math.round(
            statistics.totalDuration /
            statistics.successfulSearches
          )
        : 0
  };
}

export function resetSearchStats() {
  Object.keys(statistics).forEach(key => {
    statistics[key] = 0;
  });
}

/* =========================================================
   19. LECTURA LIMITADA DE RESPUESTAS
========================================================= */

function getContentLength(response) {
  const value = response.headers.get("content-length");

  if (!value) return null;

  const number = Number(value);

  return Number.isFinite(number) && number >= 0
    ? number
    : null;
}

async function readResponseText(response, signal) {
  if (signal?.aborted) {
    throw createAbortError();
  }

  const contentLength = getContentLength(response);

  if (
    contentLength !== null &&
    contentLength > CONFIG.maxResponseBytes
  ) {
    try {
      await response.body?.cancel();
    } catch {
      // La cancelación del cuerpo es best effort.
    }

    throw new SearchError(
      "La respuesta del servidor es demasiado grande.",
      "RESPONSE_TOO_LARGE"
    );
  }

  const body = response.body;

  if (
    body &&
    typeof body.getReader === "function" &&
    typeof TextDecoder !== "undefined"
  ) {
    const reader = body.getReader();
    const decoder = new TextDecoder("utf-8");

    let receivedBytes = 0;
    let text = "";

    try {
      while (true) {
        if (signal?.aborted) {
          throw createAbortError();
        }

        const result = await reader.read();

        if (result.done) break;

        const chunk = result.value;

        receivedBytes += chunk.byteLength;

        if (receivedBytes > CONFIG.maxResponseBytes) {
          try {
            await reader.cancel();
          } catch {
            // El cuerpo puede estar cerrado.
          }

          throw new SearchError(
            "La respuesta del servidor es demasiado grande.",
            "RESPONSE_TOO_LARGE"
          );
        }

        text += decoder.decode(chunk, {
          stream: true
        });
      }

      text += decoder.decode();

      if (signal?.aborted) {
        throw createAbortError();
      }

      return text;

    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Puede haberse liberado anteriormente.
      }
    }
  }

  let text;

  try {
    text = await response.text();
  } catch (error) {
    if (
      signal?.aborted ||
      error?.name === "AbortError"
    ) {
      throw createAbortError();
    }

    throw new SearchError(
      "No se pudo leer la respuesta del servidor.",
      "RESPONSE_READ_ERROR"
    );
  }

  if (signal?.aborted) {
    throw createAbortError();
  }

  const size = typeof TextEncoder !== "undefined"
    ? new TextEncoder().encode(text).byteLength
    : text.length * 3;

  if (size > CONFIG.maxResponseBytes) {
    throw new SearchError(
      "La respuesta del servidor es demasiado grande.",
      "RESPONSE_TOO_LARGE"
    );
  }

  return text;
}

async function readResponseJSON(response, signal) {
  const contentType = (
    response.headers.get("content-type") || ""
  ).toLowerCase();

  if (
    !contentType.includes("json") &&
    !contentType.includes("+json")
  ) {
    throw new SearchError(
      "El servidor devolvió un formato inesperado.",
      "INVALID_CONTENT_TYPE"
    );
  }

  const text = await readResponseText(
    response,
    signal
  );

  try {
    return JSON.parse(text);
  } catch {
    throw new SearchError(
      "El servidor devolvió datos inválidos.",
      "INVALID_JSON"
    );
  }
}

/* =========================================================
   20. MENSAJES HTTP
========================================================= */

function getSafeServerMessage(data) {
  if (
    typeof data?.error === "string" &&
    data.error.trim()
  ) {
    return normalizeWhitespace(data.error)
      .slice(0, CONFIG.maxErrorMessageLength);
  }

  if (
    typeof data?.message === "string" &&
    data.message.trim()
  ) {
    return normalizeWhitespace(data.message)
      .slice(0, CONFIG.maxErrorMessageLength);
  }

  return "No se pudo completar la búsqueda.";
}

async function createHttpError(response, signal) {
  let message = "No se pudo buscar en YouTube.";

  try {
    const contentType = (
      response.headers.get("content-type") || ""
    ).toLowerCase();

    if (
      contentType.includes("json") ||
      contentType.includes("+json")
    ) {
      const data = await readResponseJSON(
        response,
        signal
      );

      message = getSafeServerMessage(data);
    }
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }

    if (error?.code === "RESPONSE_TOO_LARGE") {
      message = "El servidor devolvió un error demasiado grande.";
    }
  }

  const status = response.status;

  let code = "HTTP_ERROR";

  if (status === 429) {
    code = "RATE_LIMIT";
  } else if (status >= 500) {
    code = "SERVER_ERROR";
  } else if (status >= 400) {
    code = "CLIENT_ERROR";
  }

  return new SearchError(
    message,
    code,
    {
      status,
      retryAfter: response.headers.get("retry-after")
    }
  );
}

/* =========================================================
   21. PETICIONES HTTP CON TIMEOUT
========================================================= */

async function fetchJSONWithTimeout(
  url,
  externalSignal
) {
  if (externalSignal?.aborted) {
    throw createAbortError();
  }

  const controller = new AbortController();

  let timedOut = false;

  const abortFromExternal = () => {
    controller.abort();
  };

  externalSignal?.addEventListener(
    "abort",
    abortFromExternal,
    { once: true }
  );

  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, CONFIG.timeout);

  try {
    statistics.totalHttpRequests++;

    const response = await fetch(url, {
      method: "GET",

      headers: {
        Accept: "application/json"
      },

      signal: controller.signal
    });

    if (externalSignal?.aborted) {
      throw createAbortError();
    }

    if (!response.ok) {
      throw await createHttpError(
        response,
        controller.signal
      );
    }

    return await readResponseJSON(
      response,
      controller.signal
    );

  } catch (error) {
    if (timedOut) {
      throw createTimeoutError();
    }

    if (
      externalSignal?.aborted ||
      error?.name === "AbortError"
    ) {
      throw createAbortError();
    }

    if (error instanceof SearchError) {
      throw error;
    }

    if (error instanceof TypeError) {
      throw new SearchError(
        "No se pudo conectar con el servidor de búsqueda.",
        "NETWORK_ERROR",
        { cause: error.message }
      );
    }

    throw new SearchError(
      "Ocurrió un problema al comunicarse con el servidor.",
      "REQUEST_ERROR"
    );

  } finally {
    clearTimeout(timeoutId);

    externalSignal?.removeEventListener(
      "abort",
      abortFromExternal
    );
  }
}

/* =========================================================
   22. VALIDACIÓN DE RESPUESTAS
========================================================= */

function normalizeServerResponse(data) {
  if (!isPlainObject(data)) {
    throw new SearchError(
      "YouTube devolvió una respuesta inesperada.",
      "INVALID_RESPONSE"
    );
  }

  if (!Array.isArray(data.items)) {
    throw new SearchError(
      "YouTube devolvió una lista de canciones inválida.",
      "INVALID_ITEMS"
    );
  }

  const nextPageToken =
    typeof data.nextPageToken === "string" &&
    data.nextPageToken.length <= CONFIG.maxPageTokenLength
      ? data.nextPageToken
      : null;

  return {
    items: deduplicateTracks(data.items),

    nextPageToken,

    hasMore:
      typeof data.hasMore === "boolean"
        ? data.hasMore
        : null,

    totalResults:
      Number.isSafeInteger(data.totalResults) &&
      data.totalResults >= 0
        ? data.totalResults
        : null
  };
}

/* =========================================================
   23. CONSTRUCCIÓN DE URL
========================================================= */

function createSearchURL(query, options = {}, pageToken) {
  const normalizedOptions = normalizeSearchOptions(
    options
  );

  const url = new URL(
    SEARCH_ENDPOINT,
    getOrigin()
  );

  url.searchParams.set("q", query);

  url.searchParams.set(
    "order",
    normalizedOptions.order
  );

  url.searchParams.set(
    "maxResults",
    String(normalizedOptions.maxResults)
  );

  if (pageToken !== undefined) {
    url.searchParams.set("pageToken", pageToken);
  }

  return url;
}

/* =========================================================
   24. PETICIÓN DE BÚSQUEDA
========================================================= */

async function performRequest(
  query,
  options = {},
  signal
) {
  const url = createSearchURL(query, options);

  const data = await fetchJSONWithTimeout(
    url,
    signal
  );

  return normalizeServerResponse(data);
}

/* =========================================================
   25. PETICIONES COMPARTIDAS
========================================================= */

function createSharedRequest(query, key, options = {}) {
  const controller = new AbortController();

  const entry = {
    controller,
    consumers: 0,
    settled: false,
    generation: requestGeneration,
    promise: null
  };

  entry.promise = performRequest(
    query,
    options,
    controller.signal
  ).finally(() => {
    entry.settled = true;

    if (inFlightRequests.get(key) === entry) {
      inFlightRequests.delete(key);
    }
  });

  inFlightRequests.set(key, entry);

  return entry;
}

function getSharedRequest(query, key, options = {}) {
  const existing = inFlightRequests.get(key);

  if (existing && !existing.settled) {
    statistics.sharedRequests++;
    return existing;
  }

  return createSharedRequest(
    query,
    key,
    options
  );
}

function waitForSharedRequest(entry, signal) {
  if (signal?.aborted) {
    return Promise.reject(createAbortError());
  }

  if (entry.settled && entry.controller.signal.aborted) {
    return Promise.reject(createAbortError());
  }

  entry.consumers++;

  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      signal?.removeEventListener(
        "abort",
        onAbort
      );
    };

    const releaseConsumer = () => {
      entry.consumers = Math.max(
        0,
        entry.consumers - 1
      );

      if (
        entry.consumers === 0 &&
        !entry.settled
      ) {
        entry.controller.abort();
      }
    };

    const finish = (callback, value) => {
      if (settled) return;

      settled = true;

      cleanup();
      releaseConsumer();

      callback(value);
    };

    const onAbort = () => {
      finish(reject, createAbortError());
    };

    signal?.addEventListener(
      "abort",
      onAbort,
      { once: true }
    );

    entry.promise.then(
      value => finish(resolve, value),
      error => finish(reject, error)
    );
  });
}

/* =========================================================
   26. RESOLUCIÓN DE ARGUMENTOS
========================================================= */

function resolveSearchArguments(
  signalOrOptions,
  options
) {
  if (isAbortSignal(signalOrOptions)) {
    return {
      signal: signalOrOptions,
      options: isPlainObject(options)
        ? options
        : {}
    };
  }

  if (isPlainObject(signalOrOptions)) {
    return {
      signal: isAbortSignal(signalOrOptions.signal)
        ? signalOrOptions.signal
        : undefined,

      options: signalOrOptions
    };
  }

  return {
    signal: undefined,
    options: isPlainObject(options)
      ? options
      : {}
  };
}

/* =========================================================
   27. BÚSQUEDA PRINCIPAL
========================================================= */

export async function searchTracks(
  query,
  signalOrOptions,
  additionalOptions = {}
) {
  const startedAt = getCurrentTime();

  statistics.totalSearches++;

  let completed = false;

  const resolved = resolveSearchArguments(
    signalOrOptions,
    additionalOptions
  );

  const signal = resolved.signal;

  const generation = requestGeneration;

  try {
    if (signal?.aborted) {
      throw createAbortError();
    }

    const cleanQuery = validateQuery(query);

    const options = normalizeSearchOptions(
      resolved.options
    );

    const cacheKey = createRequestKey(
      cleanQuery,
      options
    );

    const cached = getCachedResults(cacheKey);

    if (cached) {
      if (signal?.aborted) {
        throw createAbortError();
      }

      rememberSearch(cleanQuery);

      statistics.successfulSearches++;

      completed = true;

      return cached;
    }

    const entry = getSharedRequest(
      cleanQuery,
      cacheKey,
      options
    );

    const data = await waitForSharedRequest(
      entry,
      signal
    );

    if (signal?.aborted) {
      throw createAbortError();
    }

    const tracks = deduplicateTracks(data.items);

    if (generation === requestGeneration) {
      setCachedResults(cacheKey, tracks);
    }

    rememberSearch(cleanQuery);

    statistics.successfulSearches++;

    completed = true;

    return cloneTracks(tracks);

  } catch (error) {
    if (isAbortError(error)) {
      statistics.cancelledSearches++;
      throw createAbortError();
    }

    statistics.failedSearches++;

    if (error instanceof SearchError) {
      throw error;
    }

    throw new SearchError(
      "Ocurrió un problema al buscar canciones.",
      "UNKNOWN_ERROR"
    );

  } finally {
    const duration = Math.max(
      0,
      Math.round(getCurrentTime() - startedAt)
    );

    statistics.lastSearchDuration = duration;

    if (completed) {
      statistics.totalDuration += duration;
    }
  }
}

/* =========================================================
   28. BÚSQUEDA AVANZADA
========================================================= */

export async function searchTracksAdvanced(
  query,
  options = {},
  signal
) {
  const source = isPlainObject(options)
    ? options
    : {};

  const resolved = resolveSearchArguments(
    signal,
    {}
  );

  const tracks = await searchTracks(
    query,
    resolved.signal,
    {
      order: source.order,
      maxResults: source.maxResults
    }
  );

  let results = tracks;

  if (source.filters) {
    results = filterTracks(
      results,
      source.filters
    );
  }

  if (source.sort) {
    results = sortTracks(
      results,
      source.sort
    );
  }

  return results;
}

/* =========================================================
   29. BÚSQUEDAS ESPECIALIZADAS
========================================================= */

export function searchPopularTracks(
  query = "música popular",
  signal,
  options = {}
) {
  return searchTracks(
    query,
    signal,
    {
      ...options,
      order: "viewCount"
    }
  );
}

export function searchNewTracks(
  query = "música nueva",
  signal,
  options = {}
) {
  return searchTracks(
    query,
    signal,
    {
      ...options,
      order: "date"
    }
  );
}

export function searchRelevantTracks(
  query,
  signal,
  options = {}
) {
  return searchTracks(
    query,
    signal,
    {
      ...options,
      order: "relevance"
    }
  );
}

/* =========================================================
   30. PAGINACIÓN
========================================================= */

export async function searchTracksPage(
  query,
  pageToken,
  signalOrOptions,
  additionalOptions = {}
) {
  const resolved = resolveSearchArguments(
    signalOrOptions,
    additionalOptions
  );

  const signal = resolved.signal;

  const cleanQuery = validateQuery(query);

  if (
    typeof pageToken !== "string" ||
    !pageToken.trim() ||
    pageToken.length > CONFIG.maxPageTokenLength
  ) {
    throw new SearchError(
      "El identificador de página no es válido.",
      "INVALID_PAGE_TOKEN"
    );
  }

  if (signal?.aborted) {
    throw createAbortError();
  }

  const options = normalizeSearchOptions(
    resolved.options
  );

  const url = createSearchURL(
    cleanQuery,
    options,
    pageToken
  );

  const data = await fetchJSONWithTimeout(
    url,
    signal
  );

  if (signal?.aborted) {
    throw createAbortError();
  }

  const normalized = normalizeServerResponse(data);

  if (
    normalized.nextPageToken &&
    normalized.nextPageToken === pageToken
  ) {
    throw new SearchError(
      "El servidor devolvió el mismo identificador de página.",
      "PAGINATION_TOKEN_LOOP"
    );
  }

  statistics.totalPages++;

  return normalized;
}

/* =========================================================
   31. CANCELACIÓN DE PETICIONES
========================================================= */

export function clearPendingSearches() {
  requestGeneration++;

  const entries = [...inFlightRequests.values()];

  inFlightRequests.clear();

  for (const entry of entries) {
    if (!entry.settled) {
      entry.controller.abort();
    }
  }
}

/* =========================================================
   32. LIMPIEZA GENERAL
========================================================= */

export function clearSearchData() {
  clearSearchCache();
  clearRecentSearches();
  clearPendingSearches();
  resetSearchStats();
}

/* =========================================================
   33. DIAGNÓSTICO
========================================================= */

export function getSearchEngineInfo() {
  return {
    version: CONFIG.version,

    endpoint: SEARCH_ENDPOINT,

    cacheTTL: CONFIG.cacheTTL,
    maxCacheEntries: CONFIG.maxCacheEntries,
    maxCacheBytes: CONFIG.maxCacheBytes,

    timeout: CONFIG.timeout,

    maxQueryLength: CONFIG.maxQueryLength,
    maxResponseBytes: CONFIG.maxResponseBytes,

    maxResults: CONFIG.maxResults,
    defaultOrder: CONFIG.defaultOrder,

    supportedOrders: [...ALLOWED_ORDERS],
    supportedLocalSorts: [...ALLOWED_SORTS],

    pagination: true,
    sharedRequests: true,
    independentCancellation: true,
    responseSizeLimit: true,
    lruCache: true
  };
}

/* =========================================================
   34. INICIALIZACIÓN
========================================================= */

loadRecentSearches();
cleanSearchCache();

/* =========================================================
   FIN — SHUNEL SEARCH ENGINE 5.0
========================================================= */
