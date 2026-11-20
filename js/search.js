
/* =========================================================
   SHUNEL — SEARCH ENGINE 4.0
   Búsqueda, validación, caché y gestión de peticiones

   COMPATIBILIDAD:
   - Mantiene searchTracks(query, signal).
   - Mantiene el endpoint /api/search.
   - Mantiene el formato de canciones recibido del servidor.
   - No requiere cambios en app.js para la búsqueda básica.

   FUNCIONES:
   01. Normalización de consultas.
   02. Validación de entradas.
   03. Timeout de peticiones.
   04. Cancelación individual.
   05. Caché con expiración.
   06. Límite de memoria de caché.
   07. Peticiones simultáneas compartidas.
   08. Validación de respuestas.
   09. Eliminación de duplicados.
   10. Validación de canciones.
   11. Validación de URL.
   12. Historial de búsquedas.
   13. Estadísticas.
   14. Clasificación configurable.
   15. Filtros locales opcionales.
   16. Gestión de errores.
   17. Limpieza de recursos.

   IMPORTANTE:
   Las funciones que dependen de información adicional
   del servidor se activan únicamente cuando los campos
   correspondientes existen en la respuesta.

   No se inventan resultados, metadatos ni endpoints.
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

  defaultSort: "relevance"
});

const VIDEO_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;

const ALLOWED_SORTS = [
  "relevance",
  "title",
  "artist",
  "duration"
];

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

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return "";
}

function normalizeWhitespace(value) {
  return value
    .replace(/[\s\u00A0]+/g, " ")
    .trim();
}

/* =========================================================
   05. NORMALIZACIÓN DE CONSULTAS
========================================================= */

/**
 * Normaliza una consulta sin destruir acentos,
 * nombres propios ni signos musicales.
 *
 * @param {string} query
 * @returns {string}
 */

export function normalizeSearchQuery(query) {
  if (query === null || query === undefined) {
    return "";
  }

  let value = safeString(query);

  value = value.normalize("NFC");

  /*
   * Elimina caracteres de control.
   * Conserva letras, acentos y puntuación.
   */

  value = value.replace(
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,
    ""
  );

  /*
   * Elimina caracteres de formato invisibles
   * que pueden alterar una búsqueda.
   */

  value = value.replace(
    /[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g,
    ""
  );

  /*
   * Normaliza variantes tipográficas de apóstrofos.
   */

  value = value.replace(/[‘’ʼ]/g, "'");

  /*
   * Normaliza espacios.
   */

  value = normalizeWhitespace(value);

  return value;
}

/**
 * Genera una clave para caché.
 * No modifica la consulta enviada al servidor.
 */

function getNormalizedKey(query) {
  return normalizeSearchQuery(query)
    .toLocaleLowerCase()
    .normalize("NFC");
}

/* =========================================================
   06. VALIDACIÓN DE CONSULTAS
========================================================= */

/**
 * Comprueba que una consulta pueda enviarse.
 *
 * @param {string} query
 * @returns {string}
 */

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
   07. VALIDACIÓN DE VIDEO ID
========================================================= */

/**
 * Comprueba el identificador de un video de YouTube.
 */

export function isValidVideoId(videoId) {
  return (
    typeof videoId === "string" &&
    VIDEO_ID_REGEX.test(videoId)
  );
}

/* =========================================================
   08. VALIDACIÓN DE URL
========================================================= */

/**
 * Comprueba URL HTTP o HTTPS.
 *
 * Evita esquemas peligrosos como javascript: o data:.
 */

export function isSafeHttpUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
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

/**
 * Valida miniaturas.
 */

function normalizeThumbnail(value) {
  if (!isSafeHttpUrl(value)) {
    return undefined;
  }

  return value;
}

/* =========================================================
   09. VALIDACIÓN DE DURACIÓN
========================================================= */

/**
 * Normaliza duraciones sin asumir una unidad
 * cuando no existe información suficiente.
 *
 * Admite:
 * - Segundos numéricos.
 * - Cadenas numéricas.
 * - Formato MM:SS.
 * - Formato HH:MM:SS.
 */

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

  if (numbers.some(number => !Number.isFinite(number))) {
    return undefined;
  }

  if (numbers.slice(1).some(number => number >= 60)) {
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
   10. VALIDACIÓN DE CANCIONES
========================================================= */

/**
 * Comprueba si un resultado tiene los campos mínimos
 * necesarios para que Shunel pueda reproducirlo.
 *
 * No exige campos que el servidor podría no proporcionar.
 */

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

/**
 * Normaliza campos opcionales sin inventar metadatos.
 */

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
    }
  }

  if (track.durationSeconds !== undefined) {
    const duration = normalizeDuration(
      track.durationSeconds
    );

    if (duration !== undefined) {
      normalized.durationSeconds = duration;
    }
  }

  /*
   * Valida miniaturas únicamente cuando existen.
   */

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

  /*
   * Conserva los demás campos originales porque
   * app.js u otros módulos podrían utilizarlos.
   */

  return normalized;
}

/* =========================================================
   11. ELIMINACIÓN DE DUPLICADOS
========================================================= */

/**
 * Elimina videos repetidos usando videoId.
 *
 * Mantiene el primer resultado encontrado.
 */

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
   12. ORDENAMIENTO LOCAL
========================================================= */

/**
 * Ordena resultados según información disponible.
 *
 * relevance conserva el orden del servidor.
 * No inventa puntuaciones de relevancia.
 */

export function sortTracks(items, mode = CONFIG.defaultSort) {
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
   13. FILTROS LOCALES
========================================================= */

/**
 * Filtra canciones utilizando únicamente campos
 * que existan en los resultados.
 *
 * @param {Array} items
 * @param {Object} filters
 */

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
      const title = safeString(track.title).toLocaleLowerCase();

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
   14. CACHÉ
========================================================= */

function getCachedResults(key) {
  const entry = searchCache.get(key);

  if (!entry) return null;

  if (Date.now() >= entry.expiresAt) {
    searchCache.delete(key);
    return null;
  }

  /*
   * Actualiza el orden de uso para facilitar
   * una política LRU sencilla.
   */

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

/**
 * Elimina toda la caché.
 */

export function clearSearchCache() {
  searchCache.clear();
}

/**
 * Elimina las entradas expiradas.
 */

export function cleanSearchCache() {
  const now = Date.now();

  for (const [key, entry] of searchCache) {
    if (now >= entry.expiresAt) {
      searchCache.delete(key);
    }
  }
}

/* =========================================================
   15. HISTORIAL DE BÚSQUEDAS
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

/**
 * Recupera las búsquedas recientes.
 */

export function getRecentSearches() {
  return [...recentSearches];
}

/**
 * Elimina el historial.
 */

export function clearRecentSearches() {
  recentSearches.length = 0;

  try {
    localStorage.removeItem(CONFIG.recentStorageKey);
  } catch {
    // El almacenamiento puede estar deshabilitado.
  }
}

/* =========================================================
   16. ESTADÍSTICAS
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
   17. LECTURA SEGURA DE RESPUESTAS
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
    if (signal?.aborted || error.name === "AbortError") {
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

  /*
   * Verificación adicional cuando Content-Length
   * no está disponible.
   */

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
   18. PETICIÓN HTTP
========================================================= */

async function performRequest(query, signal) {
  const url = new URL(
    SEARCH_ENDPOINT,
    window.location.origin
  );

  url.searchParams.set("q", query);

  const controller = new AbortController();

  let timedOut = false;

  const abortFromCaller = () => {
    controller.abort();
  };

  if (signal) {
    if (signal.aborted) {
      throw createAbortError();
    }

    signal.addEventListener(
      "abort",
      abortFromCaller,
      { once: true }
    );
  }

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
        // Se mantiene el mensaje general.
      }

      throw new SearchError(
        message,
        "HTTP_ERROR",
        { status: response.status }
      );
    }

    const data = await readResponseJSON(
      response,
      signal
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

      /*
       * Se conservan los metadatos de paginación
       * únicamente si el servidor los proporciona.
       */

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
    if (signal?.aborted || error.name === "AbortError") {
      throw createAbortError();
    }

    if (timedOut) {
      throw createTimeoutError();
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

    signal?.removeEventListener(
      "abort",
      abortFromCaller
    );
  }
}

/* =========================================================
   19. PETICIONES COMPARTIDAS
========================================================= */

/**
 * Comparte una petición idéntica.
 *
 * Cada consumidor puede cancelar su propia espera.
 * Cancelar uno no cancela a los demás.
 *
 * La petición compartida termina por:
 * - Respuesta del servidor.
 * - Timeout.
 *
 * No se cancela la petición interna cuando un consumidor
 * individual deja de necesitar sus resultados.
 */

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

function getSharedRequest(query, key) {
  const existing = inFlightRequests.get(key);

  if (existing) {
    statistics.sharedRequests++;

    return existing;
  }

  const request = performRequest(query)
    .then(data => {
      return data;
    })
    .finally(() => {
      if (inFlightRequests.get(key) === request) {
        inFlightRequests.delete(key);
      }
    });

  inFlightRequests.set(key, request);

  return request;
}

/* =========================================================
   20. BÚSQUEDA PRINCIPAL
========================================================= */

/**
 * Busca canciones en el servidor.
 *
 * @param {string} query
 * @param {AbortSignal} signal
 * @returns {Promise<Array>}
 *
 * Esta función mantiene la compatibilidad con app.js.
 */

export async function searchTracks(query, signal) {
  const startedAt = performance.now();

  statistics.totalSearches++;

  let completed = false;

  try {
    if (signal?.aborted) {
      throw createAbortError();
    }

    const cleanQuery = validateQuery(query);

    const cacheKey = getNormalizedKey(cleanQuery);

    /*
     * Primero consulta la caché.
     */

    const cached = getCachedResults(cacheKey);

    if (cached) {
      if (signal?.aborted) {
        throw createAbortError();
      }

      statistics.successfulSearches++;

      return cached;
    }

    /*
     * Después consulta peticiones compartidas.
     */

    const sharedPromise = getSharedRequest(
      cleanQuery,
      cacheKey
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
      performance.now() - startedAt
    );

    statistics.lastSearchDuration = duration;

    if (completed) {
      statistics.totalDuration += duration;
    }
  }
}

/* =========================================================
   21. BÚSQUEDA CON OPCIONES
========================================================= */

/**
 * Variante avanzada de búsqueda.
 *
 * No cambia el comportamiento de searchTracks().
 *
 * Opciones:
 * - sort
 * - filters
 *
 * @param {string} query
 * @param {Object} options
 * @param {AbortSignal} signal
 */

export async function searchTracksAdvanced(
  query,
  options = {},
  signal
) {
  const tracks = await searchTracks(query, signal);

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
   22. PAGINACIÓN
========================================================= */

/**
 * Busca una página adicional cuando el servidor
 * proporciona nextPageToken.
 *
 * IMPORTANTE:
 * El endpoint actual debe aceptar pageToken.
 * Esta función no se utiliza en la búsqueda normal.
 *
 * @param {string} query
 * @param {string} pageToken
 * @param {AbortSignal} signal
 */

export async function searchTracksPage(
  query,
  pageToken,
  signal
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

  const url = new URL(
    SEARCH_ENDPOINT,
    window.location.origin
  );

  url.searchParams.set("q", cleanQuery);
  url.searchParams.set("pageToken", pageToken);

  const controller = new AbortController();

  const abort = () => controller.abort();

  signal?.addEventListener("abort", abort, {
    once: true
  });

  const timeoutId = setTimeout(
    () => controller.abort(),
    CONFIG.timeout
  );

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
      signal
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
    if (signal?.aborted || error.name === "AbortError") {
      throw createAbortError();
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
   23. CANCELACIÓN DE PETICIONES
========================================================= */

/**
 * Cancela las peticiones pendientes compartidas.
 *
 * No cancela las peticiones de los demás consumidores
 * mediante sus AbortSignal individuales.
 *
 * Esta función se reserva para la limpieza general
 * del módulo.
 */

export function clearPendingSearches() {
  /*
   * Las peticiones compartidas no exponen su controlador
   * interno para evitar que un consumidor individual
   * cancele el trabajo de otros.
   *
   * Se eliminan las referencias del registro.
   * Las peticiones activas finalizarán por respuesta
   * o timeout.
   */

  inFlightRequests.clear();
}

/* =========================================================
   24. LIMPIEZA GENERAL
========================================================= */

export function clearSearchData() {
  clearSearchCache();
  clearRecentSearches();
  clearPendingSearches();
  resetSearchStats();
}

/* =========================================================
   25. UTILIDADES DE DIAGNÓSTICO
========================================================= */

/**
 * Devuelve información del motor sin exponer
 * consultas privadas ni datos personales.
 */

export function getSearchEngineInfo() {
  return {
    version: "4.0",

    endpoint: SEARCH_ENDPOINT,

    cacheTTL: CONFIG.cacheTTL,

    maxCacheEntries: CONFIG.maxCacheEntries,

    timeout: CONFIG.timeout,

    maxQueryLength: CONFIG.maxQueryLength,

    maxResults: CONFIG.maxResults
  };
}

/* =========================================================
   26. INICIALIZACIÓN DEL HISTORIAL
========================================================= */

loadRecentSearches();
cleanSearchCache();

/* =========================================================
   FIN — SHUNEL SEARCH ENGINE 4.0
========================================================= */
