
/* =========================================================
   SHUNEL — SEARCH ENGINE 4.1
   Búsqueda, validación, caché y gestión de peticiones

   COMPATIBILIDAD:
   - Mantiene searchTracks(query, signal).
   - Añade searchTracks(query, signal, options).
   - Mantiene el endpoint /api/search.
   - Mantiene el formato de canciones del servidor.
   - Mantiene las funciones públicas originales.

   NUEVO:
   - Orden por relevancia.
   - Orden por popularidad (viewCount).
   - Orden por fecha (date).
   - Caché independiente por orden y cantidad.
   - Peticiones compartidas según sus opciones.
   - Paginación con orden configurable.

   IMPORTANTE:
   El endpoint /api/search también debe aceptar
   el parámetro "order" y enviarlo a YouTube.
========================================================= */

const SEARCH_ENDPOINT = "/api/search";

/* =========================================================
   01. CONFIGURACIÓN
========================================================= */

const CONFIG = Object.freeze({
  maxQueryLength: 150,
  minQueryLength: 1,

  timeout: 15000,

  cacheTTL: 3 * 60 * 1000,
  maxCacheEntries: 40,

  maxResponseBytes: 2 * 1024 * 1024,

  maxRecentSearches: 20,
  recentStorageKey: "shunel_recent_searches",

  maxResults: 100,
  defaultSort: "relevance",

  defaultOrder: "relevance",
  defaultRequestResults: 15,
  maxRequestResults: 25
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

/* =========================================================
   02. ESTADO INTERNO
========================================================= */

const searchCache = new Map();
const inFlightRequests = new Map();
const recentSearches = [];

const statistics = {
  totalSearches: 0,
  successfulSearches: 0,
  failedSearches: 0,
  cancelledSearches: 0,
  cacheHits: 0,
  sharedRequests: 0,
  totalDuration: 0,
  lastSearchDuration: 0
};

/* =========================================================
   03. ERRORES PERSONALIZADOS
========================================================= */

export class SearchError extends Error {
  constructor(message, code = "SEARCH_ERROR", details = {}) {
    super(message);

    this.name = "SearchError";
    this.code = code;
    this.details = details;
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
  return typeof performance !== "undefined" &&
    typeof performance.now === "function"
      ? performance.now()
      : Date.now();
}

/* =========================================================
   05. NORMALIZACIÓN DE CONSULTAS
========================================================= */

export function normalizeSearchQuery(query) {
  if (query === null || query === undefined) {
    return "";
  }

  let value = safeString(query);

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
   06. VALIDACIÓN DE CONSULTAS
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

  if (cleanQuery.length > CONFIG.maxQueryLength) {
    throw new SearchError(
      "La búsqueda es demasiado larga.",
      "QUERY_TOO_LONG"
    );
  }

  return cleanQuery;
}

/* =========================================================
   07. OPCIONES DE BÚSQUEDA
========================================================= */

/**
 * Normaliza las opciones enviadas al servidor.
 *
 * order:
 * - relevance
 * - viewCount
 * - date
 *
 * maxResults:
 * - Entre 1 y 25.
 */

function normalizeSearchOptions(options = {}) {
  const source = isObject(options) ? options : {};

  const requestedOrder = source.order;

  const order = ALLOWED_ORDERS.includes(requestedOrder)
    ? requestedOrder
    : CONFIG.defaultOrder;

  const requestedResults = Number(source.maxResults);

  const maxResults = Number.isFinite(requestedResults)
    ? clamp(
        Math.floor(requestedResults),
        1,
        CONFIG.maxRequestResults
      )
    : CONFIG.defaultRequestResults;

  return {
    order,
    maxResults
  };
}

/**
 * Crea una clave única para cada combinación.
 *
 * Evita que una búsqueda popular se confunda
 * con una búsqueda reciente o normal.
 */

function createRequestKey(query, options = {}) {
  const normalizedQuery = getNormalizedKey(query);
  const normalizedOptions = normalizeSearchOptions(options);

  return [
    normalizedQuery,
    normalizedOptions.order,
    normalizedOptions.maxResults
  ].join("|");
}

/* =========================================================
   08. VALIDACIÓN DE VIDEO ID
========================================================= */

export function isValidVideoId(videoId) {
  return (
    typeof videoId === "string" &&
    VIDEO_ID_REGEX.test(videoId)
  );
}

/* =========================================================
   09. VALIDACIÓN DE URL
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

  return value;
}

/* =========================================================
   10. VALIDACIÓN DE DURACIÓN
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
   11. VALIDACIÓN DE CANCIONES
========================================================= */

export function isValidTrack(track) {
  if (!isObject(track)) {
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

  return true;
}

function normalizeTrack(track) {
  if (!isValidTrack(track)) {
    return null;
  }

  const normalized = {
    ...track,

    videoId: track.videoId,

    title: normalizeWhitespace(
      track.title.normalize("NFC")
    )
  };

  if (typeof track.artist === "string") {
    normalized.artist = normalizeWhitespace(
      track.artist.normalize("NFC")
    );
  }

  if (typeof track.channelTitle === "string") {
    normalized.channelTitle = normalizeWhitespace(
      track.channelTitle.normalize("NFC")
    );
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

  if (typeof track.thumbnail === "string") {
    const thumbnail = normalizeThumbnail(track.thumbnail);

    if (thumbnail) {
      normalized.thumbnail = thumbnail;
    } else {
      delete normalized.thumbnail;
    }
  }

  if (typeof track.thumbnailUrl === "string") {
    const thumbnail = normalizeThumbnail(track.thumbnailUrl);

    if (thumbnail) {
      normalized.thumbnailUrl = thumbnail;
    } else {
      delete normalized.thumbnailUrl;
    }
  }

  return normalized;
}

/* =========================================================
   12. ELIMINACIÓN DE DUPLICADOS
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

    seen.add(track.videoId);

    const normalized = normalizeTrack(track);

    if (normalized) {
      results.push(normalized);
    }

    if (results.length >= CONFIG.maxResults) {
      break;
    }
  }

  return results;
}

/* =========================================================
   13. ORDENAMIENTO LOCAL
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

  if (mode === "title") {
    results.sort((a, b) =>
      safeString(a.title).localeCompare(
        safeString(b.title),
        undefined,
        { sensitivity: "base" }
      )
    );
  }

  if (mode === "artist") {
    results.sort((a, b) =>
      safeString(a.artist || a.channelTitle).localeCompare(
        safeString(b.artist || b.channelTitle),
        undefined,
        { sensitivity: "base" }
      )
    );
  }

  if (mode === "duration") {
    results.sort((a, b) => {
      const first = normalizeDuration(
        a.duration ?? a.durationSeconds
      );

      const second = normalizeDuration(
        b.duration ?? b.durationSeconds
      );

      if (first === undefined) return 1;
      if (second === undefined) return -1;

      return first - second;
    });
  }

  return results;
}

/* =========================================================
   14. FILTROS LOCALES
========================================================= */

export function filterTracks(items, filters = {}) {
  if (!Array.isArray(items)) {
    return [];
  }

  let results = [...items];

  if (filters.artist) {
    const artist = normalizeSearchQuery(
      filters.artist
    ).toLocaleLowerCase();

    results = results.filter(track => {
      const name = safeString(
        track.artist || track.channelTitle
      ).toLocaleLowerCase();

      return name.includes(artist);
    });
  }

  if (filters.minDuration !== undefined) {
    const min = Number(filters.minDuration);

    if (Number.isFinite(min) && min >= 0) {
      results = results.filter(track => {
        const duration = normalizeDuration(
          track.duration ?? track.durationSeconds
        );

        return duration !== undefined && duration >= min;
      });
    }
  }

  if (filters.maxDuration !== undefined) {
    const max = Number(filters.maxDuration);

    if (Number.isFinite(max) && max >= 0) {
      results = results.filter(track => {
        const duration = normalizeDuration(
          track.duration ?? track.durationSeconds
        );

        return duration !== undefined && duration <= max;
      });
    }
  }

  if (filters.query) {
    const query = normalizeSearchQuery(
      filters.query
    ).toLocaleLowerCase();

    results = results.filter(track => {
      const title = safeString(
        track.title
      ).toLocaleLowerCase();

      const artist = safeString(
        track.artist || track.channelTitle
      ).toLocaleLowerCase();

      return (
        title.includes(query) ||
        artist.includes(query)
      );
    });
  }

  return results;
}

/* =========================================================
   15. CACHÉ
========================================================= */

function getCachedResults(key) {
  const entry = searchCache.get(key);

  if (!entry) return null;

  if (Date.now() >= entry.expiresAt) {
    searchCache.delete(key);
    return null;
  }

  searchCache.delete(key);
  searchCache.set(key, entry);

  statistics.cacheHits++;

  return entry.items.map(track => ({ ...track }));
}

function setCachedResults(key, items) {
  if (!Array.isArray(items)) return;

  if (searchCache.has(key)) {
    searchCache.delete(key);
  }

  while (searchCache.size >= CONFIG.maxCacheEntries) {
    const oldestKey = searchCache.keys().next().value;

    searchCache.delete(oldestKey);
  }

  searchCache.set(key, {
    items: items.map(track => ({ ...track })),
    expiresAt: Date.now() + CONFIG.cacheTTL
  });
}

export function clearSearchCache() {
  searchCache.clear();
}

export function cleanSearchCache() {
  const now = Date.now();

  for (const [key, entry] of searchCache) {
    if (now >= entry.expiresAt) {
      searchCache.delete(key);
    }
  }
}

/* =========================================================
   16. HISTORIAL DE BÚSQUEDAS
========================================================= */

function loadRecentSearches() {
  try {
    const saved = localStorage.getItem(
      CONFIG.recentStorageKey
    );

    if (!saved) return;

    const parsed = JSON.parse(saved);

    if (!Array.isArray(parsed)) return;

    recentSearches.length = 0;

    parsed
      .filter(item =>
        typeof item === "string" &&
        item.trim()
      )
      .slice(0, CONFIG.maxRecentSearches)
      .forEach(item => recentSearches.push(item));

  } catch {
    recentSearches.length = 0;
  }
}

function saveRecentSearches() {
  try {
    localStorage.setItem(
      CONFIG.recentStorageKey,
      JSON.stringify(recentSearches)
    );
  } catch {
    // El historial es opcional.
  }
}

function rememberSearch(query) {
  const key = getNormalizedKey(query);

  const index = recentSearches.findIndex(
    item => getNormalizedKey(item) === key
  );

  if (index !== -1) {
    recentSearches.splice(index, 1);
  }

  recentSearches.unshift(query);

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
    localStorage.removeItem(CONFIG.recentStorageKey);
  } catch {
    // El almacenamiento puede estar deshabilitado.
  }
}

/* =========================================================
   17. ESTADÍSTICAS
========================================================= */

export function getSearchStats() {
  return {
    ...statistics,

    cacheEntries: searchCache.size,

    activeRequests: inFlightRequests.size,

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
   18. LECTURA SEGURA DE RESPUESTAS
========================================================= */

async function readResponseJSON(response, signal) {
  if (signal?.aborted) {
    throw createAbortError();
  }

  const contentType = response.headers.get(
    "content-type"
  ) || "";

  if (!contentType.toLowerCase().includes("json")) {
    throw new SearchError(
      "El servidor devolvió un formato inesperado.",
      "INVALID_CONTENT_TYPE"
    );
  }

  const contentLength = Number(
    response.headers.get("content-length")
  );

  if (
    Number.isFinite(contentLength) &&
    contentLength > CONFIG.maxResponseBytes
  ) {
    throw new SearchError(
      "La respuesta del servidor es demasiado grande.",
      "RESPONSE_TOO_LARGE"
    );
  }

  let text;

  try {
    text = await response.text();
  } catch (error) {
    if (
      signal?.aborted ||
      error.name === "AbortError"
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

  if (text.length > CONFIG.maxResponseBytes) {
    throw new SearchError(
      "La respuesta del servidor es demasiado grande.",
      "RESPONSE_TOO_LARGE"
    );
  }

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
   19. PETICIÓN HTTP
========================================================= */

/**
 * Envía la consulta y sus opciones al endpoint.
 *
 * La señal de cada consumidor no controla la petición
 * compartida. Cada consumidor cancela solamente su espera.
 */

async function performRequest(query, options = {}) {
  const normalizedOptions = normalizeSearchOptions(options);

  const url = new URL(
    SEARCH_ENDPOINT,
    window.location.origin
  );

  url.searchParams.set("q", query);
  url.searchParams.set("order", normalizedOptions.order);
  url.searchParams.set(
    "maxResults",
    String(normalizedOptions.maxResults)
  );

  const controller = new AbortController();

  let timedOut = false;

  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, CONFIG.timeout);

  try {
    const response = await fetch(url, {
      method: "GET",

      headers: {
        Accept: "application/json"
      },

      signal: controller.signal
    });

    if (!response.ok) {
      let message = "No se pudo buscar en YouTube.";

      try {
        const data = await response.json();

        if (
          typeof data?.error === "string" &&
          data.error.length <= 250
        ) {
          message = data.error;
        }
      } catch {
        // Se conserva el mensaje general.
      }

      throw new SearchError(
        message,
        "HTTP_ERROR",
        { status: response.status }
      );
    }

    const data = await readResponseJSON(
      response,
      controller.signal
    );

    if (!isObject(data)) {
      throw new SearchError(
        "YouTube devolvió una respuesta inesperada.",
        "INVALID_RESPONSE"
      );
    }

    if (!Array.isArray(data.items)) {
      throw new SearchError(
        "YouTube devolvió una respuesta inesperada.",
        "INVALID_ITEMS"
      );
    }

    return {
      items: deduplicateTracks(data.items),

      nextPageToken:
        typeof data.nextPageToken === "string"
          ? data.nextPageToken
          : null,

      hasMore:
        typeof data.hasMore === "boolean"
          ? data.hasMore
          : null,

      totalResults:
        Number.isFinite(data.totalResults)
          ? data.totalResults
          : null
    };

  } catch (error) {
    if (
      timedOut ||
      error.name === "AbortError"
    ) {
      if (timedOut) {
        throw createTimeoutError();
      }

      throw createAbortError();
    }

    if (error instanceof SearchError) {
      throw error;
    }

    throw new SearchError(
      "No se pudo conectar con el servidor de búsqueda.",
      "NETWORK_ERROR"
    );

  } finally {
    clearTimeout(timeoutId);
  }
}

/* =========================================================
   20. PETICIONES COMPARTIDAS
========================================================= */

function waitForSharedRequest(promise, signal) {
  if (!signal) return promise;

  if (signal.aborted) {
    return Promise.reject(createAbortError());
  }

  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      signal.removeEventListener(
        "abort",
        onAbort
      );
    };

    const finish = callback => value => {
      if (settled) return;

      settled = true;

      cleanup();

      callback(value);
    };

    const onResolve = finish(resolve);
    const onReject = finish(reject);

    const onAbort = () => {
      onReject(createAbortError());
    };

    signal.addEventListener(
      "abort",
      onAbort,
      { once: true }
    );

    promise.then(onResolve, onReject);
  });
}

function getSharedRequest(query, key, options = {}) {
  const existing = inFlightRequests.get(key);

  if (existing) {
    statistics.sharedRequests++;
    return existing;
  }

  const request = performRequest(query, options)
    .finally(() => {
      if (inFlightRequests.get(key) === request) {
        inFlightRequests.delete(key);
      }
    });

  inFlightRequests.set(key, request);

  return request;
}

/* =========================================================
   21. RESOLUCIÓN DE ARGUMENTOS
========================================================= */

/**
 * Mantiene la firma antigua:
 *
 * searchTracks(query, signal)
 *
 * También permite:
 *
 * searchTracks(query, signal, options)
 *
 * Y la forma alternativa:
 *
 * searchTracks(query, {
 *   signal,
 *   order: "date"
 * })
 */

function resolveSearchArguments(signalOrOptions, options) {
  if (isAbortSignal(signalOrOptions)) {
    return {
      signal: signalOrOptions,
      options: isObject(options) ? options : {}
    };
  }

  if (isObject(signalOrOptions)) {
    return {
      signal: isAbortSignal(signalOrOptions.signal)
        ? signalOrOptions.signal
        : undefined,

      options: signalOrOptions
    };
  }

  return {
    signal: undefined,
    options: isObject(options) ? options : {}
  };
}

/* =========================================================
   22. BÚSQUEDA PRINCIPAL
========================================================= */

/**
 * Busca canciones en el servidor.
 *
 * Uso antiguo:
 * searchTracks(query, signal)
 *
 * Uso con opciones:
 * searchTracks(query, signal, {
 *   order: "viewCount"
 * })
 *
 * Uso alternativo:
 * searchTracks(query, {
 *   order: "date"
 * })
 */

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

      statistics.successfulSearches++;

      completed = true;

      return cached;
    }

    const sharedPromise = getSharedRequest(
      cleanQuery,
      cacheKey,
      options
    );

    const data = await waitForSharedRequest(
      sharedPromise,
      signal
    );

    if (signal?.aborted) {
      throw createAbortError();
    }

    const tracks = deduplicateTracks(data.items);

    setCachedResults(cacheKey, tracks);

    rememberSearch(cleanQuery);

    statistics.successfulSearches++;

    completed = true;

    return tracks.map(track => ({ ...track }));

  } catch (error) {
    if (
      error.name === "AbortError" ||
      error.code === "SEARCH_ABORTED"
    ) {
      statistics.cancelledSearches++;
      throw error;
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
    const duration = Math.round(
      getCurrentTime() - startedAt
    );

    statistics.lastSearchDuration = duration;

    if (completed) {
      statistics.totalDuration += duration;
    }
  }
}

/* =========================================================
   23. BÚSQUEDA CON OPCIONES
========================================================= */

/**
 * Búsqueda avanzada con:
 *
 * - sort: ordenamiento local.
 * - filters: filtros locales.
 * - order: orden del servidor.
 * - maxResults: cantidad solicitada al servidor.
 *
 * Ejemplo:
 *
 * searchTracksAdvanced("música nueva", {
 *   order: "date",
 *   sort: "relevance"
 * });
 */

export async function searchTracksAdvanced(
  query,
  options = {},
  signal
) {
  const tracks = await searchTracks(
    query,
    signal,
    {
      order: options.order,
      maxResults: options.maxResults
    }
  );

  let results = tracks;

  if (options.filters) {
    results = filterTracks(
      results,
      options.filters
    );
  }

  if (options.sort) {
    results = sortTracks(
      results,
      options.sort
    );
  }

  return results;
}

/* =========================================================
   24. BÚSQUEDAS ESPECIALIZADAS
========================================================= */

/**
 * Música popular.
 *
 * Usa el orden viewCount de YouTube.
 */

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

/**
 * Música nueva.
 *
 * Usa el orden date de YouTube.
 */

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

/**
 * Búsqueda normal por relevancia.
 */

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
   25. PAGINACIÓN
========================================================= */

/**
 * Busca una página adicional.
 *
 * Uso:
 *
 * searchTracksPage(query, pageToken, signal)
 *
 * Con orden:
 *
 * searchTracksPage(query, pageToken, signal, {
 *   order: "date"
 * })
 */

export async function searchTracksPage(
  query,
  pageToken,
  signal,
  options = {}
) {
  const cleanQuery = validateQuery(query);

  if (
    typeof pageToken !== "string" ||
    !pageToken.trim()
  ) {
    throw new SearchError(
      "El identificador de página no es válido.",
      "INVALID_PAGE_TOKEN"
    );
  }

  if (signal?.aborted) {
    throw createAbortError();
  }

  const normalizedOptions = normalizeSearchOptions(options);

  const url = new URL(
    SEARCH_ENDPOINT,
    window.location.origin
  );

  url.searchParams.set("q", cleanQuery);
  url.searchParams.set("pageToken", pageToken);
  url.searchParams.set("order", normalizedOptions.order);
  url.searchParams.set(
    "maxResults",
    String(normalizedOptions.maxResults)
  );

  const controller = new AbortController();

  let timedOut = false;

  const abort = () => controller.abort();

  signal?.addEventListener("abort", abort, {
    once: true
  });

  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, CONFIG.timeout);

  try {
    const response = await fetch(url, {
      method: "GET",

      headers: {
        Accept: "application/json"
      },

      signal: controller.signal
    });

    if (signal?.aborted) {
      throw createAbortError();
    }

    if (!response.ok) {
      throw new SearchError(
        "No se pudo cargar la siguiente página.",
        "PAGINATION_HTTP_ERROR",
        { status: response.status }
      );
    }

    const data = await readResponseJSON(
      response,
      controller.signal
    );

    if (!Array.isArray(data?.items)) {
      throw new SearchError(
        "La respuesta de paginación no es válida.",
        "INVALID_PAGE_RESPONSE"
      );
    }

    return {
      items: deduplicateTracks(data.items),

      nextPageToken:
        typeof data.nextPageToken === "string"
          ? data.nextPageToken
          : null,

      hasMore:
        typeof data.hasMore === "boolean"
          ? data.hasMore
          : null,

      totalResults:
        Number.isFinite(data.totalResults)
          ? data.totalResults
          : null
    };

  } catch (error) {
    if (
      signal?.aborted ||
      error.name === "AbortError"
    ) {
      throw createAbortError();
    }

    if (timedOut) {
      throw createTimeoutError();
    }

    if (error instanceof SearchError) {
      throw error;
    }

    throw new SearchError(
      "No se pudo cargar la siguiente página.",
      "PAGINATION_ERROR"
    );

  } finally {
    clearTimeout(timeoutId);

    signal?.removeEventListener(
      "abort",
      abort
    );
  }
}

/* =========================================================
   26. CANCELACIÓN DE PETICIONES
========================================================= */

/**
 * Limpia las referencias a peticiones compartidas.
 *
 * Las peticiones activas terminan por respuesta
 * o timeout.
 */

export function clearPendingSearches() {
  inFlightRequests.clear();
}

/* =========================================================
   27. LIMPIEZA GENERAL
========================================================= */

export function clearSearchData() {
  clearSearchCache();
  clearRecentSearches();
  clearPendingSearches();
  resetSearchStats();
}

/* =========================================================
   28. UTILIDADES DE DIAGNÓSTICO
========================================================= */

export function getSearchEngineInfo() {
  return {
    version: "4.1",

    endpoint: SEARCH_ENDPOINT,

    cacheTTL: CONFIG.cacheTTL,

    maxCacheEntries: CONFIG.maxCacheEntries,

    timeout: CONFIG.timeout,

    maxQueryLength: CONFIG.maxQueryLength,

    maxResults: CONFIG.maxResults,

    defaultOrder: CONFIG.defaultOrder,

    supportedOrders: [...ALLOWED_ORDERS],

    supportedLocalSorts: [...ALLOWED_SORTS]
  };
}

/* =========================================================
   29. INICIALIZACIÓN DEL HISTORIAL
========================================================= */

loadRecentSearches();
cleanSearchCache();

/* =========================================================
   FIN — SHUNEL SEARCH ENGINE 4.1
========================================================= */
