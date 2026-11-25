
/*
 * SHUNEL — API: Spotify Daily Top 50 Costa Rica
 *
 * Version: 3.0.0
 * Endpoint: GET /api/charts/cr
 * Source: https://kworb.net/spotify/country/cr_daily.html
 *
 * Runtime: Vercel Node.js
 * Dependencies: None (Node.js native APIs)
 *
 * Features:
 * - Strict Top 50 validation
 * - HTML parsing and data normalization
 * - Bounded response streaming
 * - Independent request timeouts
 * - Intelligent retries with exponential backoff
 * - Correct ETag and If-None-Match handling
 * - GET and HEAD support
 * - Query validation
 * - Unicode-insensitive search
 * - Consistent JSON response contract
 */

import { createHash } from "node:crypto";

// ============================================================
// CONFIGURATION
// ============================================================

const CONFIG = Object.freeze({
  source: "https://kworb.net/spotify/country/cr_daily.html",

  chartId: "spotify-daily-cr",
  parserVersion: "3.0.0",

  expectedTracks: 50,

  requestTimeoutMs: 10000,
  maxHtmlBytes: 5 * 1024 * 1024,

  maxAttempts: 3,
  retryBaseDelayMs: 350,
  maxRetryDelayMs: 2000,

  maxQueryLength: 100,
  minValidTracks: 50,

  cacheControl:
    "public, max-age=300, s-maxage=1800, stale-while-revalidate=86400"
});

const BLOCK_PATTERNS = [
  /cf-browser-verification/i,
  /challenge-platform/i,
  /attention required!\s*\|\s*cloudflare/i,
  /captcha/i,
  /access denied/i,
  /just a moment\.\.\./i
];

const TEMPORARY_HTTP_STATUSES = new Set([
  408,
  425,
  429,
  500,
  502,
  503,
  504
]);

const HTML_ENTITIES = Object.freeze({
  nbsp: " ",
  amp: "&",
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
  eacute: "é",
  Eacute: "É",
  aacute: "á",
  Aacute: "Á",
  iacute: "í",
  Iacute: "Í",
  oacute: "ó",
  Oacute: "Ó",
  uacute: "ú",
  Uacute: "Ú",
  ntilde: "ñ",
  Ntilde: "Ñ",
  ccedil: "ç",
  Ccedil: "Ç"
});

// ============================================================
// CUSTOM ERRORS
// ============================================================

class ChartError extends Error {
  constructor(message, code, status = 502) {
    super(message);

    this.name = "ChartError";
    this.code = code;
    this.status = status;
  }
}

function createTimeoutError() {
  return new ChartError(
    "La fuente excedió el tiempo máximo de respuesta.",
    "SOURCE_TIMEOUT",
    504
  );
}

// ============================================================
// TEXT NORMALIZATION
// ============================================================

function decodeEntities(value) {
  return String(value ?? "").replace(
    /&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi,
    (entity, code) => {
      if (code.startsWith("#x") || code.startsWith("#X")) {
        const number = parseInt(code.slice(2), 16);

        if (
          Number.isSafeInteger(number) &&
          number >= 0 &&
          number <= 0x10ffff
        ) {
          return String.fromCodePoint(number);
        }

        return entity;
      }

      if (code.startsWith("#")) {
        const number = Number(code.slice(1));

        if (
          Number.isSafeInteger(number) &&
          number >= 0 &&
          number <= 0x10ffff
        ) {
          return String.fromCodePoint(number);
        }

        return entity;
      }

      return HTML_ENTITIES[code] ?? entity;
    }
  );
}

function normalizeText(value) {
  return decodeEntities(String(value ?? ""))
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripTags(value) {
  return normalizeText(
    String(value ?? "")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
      .replace(/<[^>]*>/g, " ")
  );
}

function normalizeSearch(value) {
  return normalizeText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es");
}

// ============================================================
// HTML EXTRACTION
// ============================================================

function getCells(rowHtml) {
  const cells = [];
  const regex = /<td\b[^>]*>([\s\S]*?)<\/td\s*>/gi;

  let match;

  while ((match = regex.exec(rowHtml)) !== null) {
    cells.push(match[1]);
  }

  return cells;
}

function getAnchors(cellHtml) {
  const anchors = [];
  const regex = /<a\b[^>]*>([\s\S]*?)<\/a\s*>/gi;

  let match;

  while ((match = regex.exec(cellHtml)) !== null) {
    const text = stripTags(match[1]);

    if (text) {
      anchors.push(text);
    }
  }

  return anchors;
}

// ============================================================
// NUMERIC VALIDATION
// ============================================================

function parseInteger(value) {
  const normalized = normalizeText(value)
    .replace(/,/g, "")
    .replace(/\s/g, "");

  if (!/^[+-]?\d+$/.test(normalized)) {
    return null;
  }

  const number = Number(normalized);

  return Number.isSafeInteger(number) ? number : null;
}

function parseMovement(value) {
  const text = stripTags(value)
    .toUpperCase()
    .replace(/\s+/g, "");

  if (!text || text === "=") {
    return {
      movement: 0,
      movementType: "stable"
    };
  }

  if (/^NEW!?$/.test(text)) {
    return {
      movement: null,
      movementType: "new"
    };
  }

  if (/^RE!?$/.test(text)) {
    return {
      movement: null,
      movementType: "reentry"
    };
  }

  const number = parseInteger(text);

  if (number === null) {
    return {
      movement: null,
      movementType: "unknown"
    };
  }

  return {
    movement: number,
    movementType:
      number > 0
        ? "up"
        : number < 0
          ? "down"
          : "stable"
  };
}

// ============================================================
// ARTIST AND TITLE EXTRACTION
// ============================================================

function extractArtistAndTitle(cellHtml) {
  const plainText = stripTags(cellHtml);

  if (!plainText) {
    return {
      artist: "",
      title: ""
    };
  }

  const dashIndex = plainText.indexOf(" - ");

  if (dashIndex > 0) {
    const artist = normalizeText(
      plainText.slice(0, dashIndex)
    );

    const title = normalizeText(
      plainText.slice(dashIndex + 3)
    );

    if (artist && title) {
      return {
        artist,
        title
      };
    }
  }

  const anchors = getAnchors(cellHtml);

  if (anchors.length >= 2) {
    return {
      artist: normalizeText(anchors[0]),
      title: normalizeText(anchors.slice(1).join(" - "))
    };
  }

  return {
    artist: "",
    title: ""
  };
}

// ============================================================
// DATE EXTRACTION
// ============================================================

function isValidDate(year, month, day) {
  const date = new Date(
    Date.UTC(year, month - 1, day)
  );

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function formatDate(year, month, day) {
  if (!isValidDate(year, month, day)) {
    return null;
  }

  return {
    date: [
      String(day).padStart(2, "0"),
      String(month).padStart(2, "0"),
      String(year)
    ].join("/"),

    chartDate: [
      String(year),
      String(month).padStart(2, "0"),
      String(day).padStart(2, "0")
    ].join("-")
  };
}

function parseDate(html) {
  const patterns = [
    /Spotify\s+Daily\s+Chart\s*-\s*Costa\s+Rica\s*-\s*(\d{4})\/(\d{2})\/(\d{2})/i,
    /\b(20\d{2})\/(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])\b/,
    /\b(0[1-9]|[12]\d|3[01])\/(0[1-9]|1[0-2])\/(20\d{2})\b/
  ];

  for (let index = 0; index < patterns.length; index++) {
    const match = html.match(patterns[index]);

    if (!match) {
      continue;
    }

    const year = Number(index === 2 ? match[3] : match[1]);
    const month = Number(index === 2 ? match[2] : match[2]);
    const day = Number(index === 2 ? match[1] : match[3]);

    const result = formatDate(year, month, day);

    if (result) {
      return result;
    }
  }

  return {
    date: null,
    chartDate: null
  };
}

// ============================================================
// SOURCE VALIDATION
// ============================================================

function detectBlockPage(html) {
  return BLOCK_PATTERNS.some((pattern) => pattern.test(html));
}

function validateHtml(html) {
  if (!html || typeof html !== "string") {
    throw new ChartError(
      "La fuente devolvió una respuesta vacía.",
      "EMPTY_RESPONSE"
    );
  }

  if (detectBlockPage(html)) {
    throw new ChartError(
      "La fuente bloqueó la solicitud.",
      "SOURCE_BLOCKED"
    );
  }

  if (!/<html\b/i.test(html) && !/<table\b/i.test(html)) {
    throw new ChartError(
      "La respuesta no contiene HTML válido.",
      "INVALID_HTML"
    );
  }

  if (!/<tr\b/i.test(html)) {
    throw new ChartError(
      "No se encontró ninguna fila en la fuente.",
      "MISSING_TABLE_ROWS"
    );
  }
}

// ============================================================
// CHART PARSER
// ============================================================

function parseChart(html) {
  validateHtml(html);

  const rowsByRank = new Map();

  const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi;

  let match;

  while ((match = rowRegex.exec(html)) !== null) {
    const cells = getCells(match[1]);

    if (cells.length < 7) {
      continue;
    }

    const rank = parseInteger(stripTags(cells[0]));

    if (
      rank === null ||
      rank < 1 ||
      rank > CONFIG.expectedTracks ||
      rowsByRank.has(rank)
    ) {
      continue;
    }

    const { artist, title } = extractArtistAndTitle(cells[2]);

    if (!artist || !title) {
      continue;
    }

    const streams = parseInteger(stripTags(cells[6]));

    if (streams === null || streams < 0) {
      continue;
    }

    const movement = parseMovement(cells[1]);

    const peak = parseInteger(stripTags(cells[3]));
    const days = parseInteger(stripTags(cells[5]));

    const previousPosition =
      movement.movementType === "new" ||
      movement.movementType === "reentry" ||
      movement.movementType === "unknown"
        ? null
        : rank + movement.movement;

    rowsByRank.set(rank, {
      rank,
      artist,
      title,
      streams,
      movement: movement.movement,
      movementType: movement.movementType,
      previousPosition,
      peak:
        peak !== null && peak >= 1 && peak <= 50
          ? peak
          : null,
      days:
        days !== null && days >= 0
          ? days
          : null
    });
  }

  const tracks = Array.from(rowsByRank.values())
    .sort((a, b) => a.rank - b.rank);

  const missingRanks = [];

  for (let rank = 1; rank <= CONFIG.expectedTracks; rank++) {
    if (!rowsByRank.has(rank)) {
      missingRanks.push(rank);
    }
  }

  if (tracks.length < CONFIG.minValidTracks) {
    throw new ChartError(
      `Ranking incompleto: ${tracks.length}/50 canciones válidas.`,
      "INCOMPLETE_CHART"
    );
  }

  if (missingRanks.length > 0) {
    throw new ChartError(
      "El ranking contiene posiciones faltantes.",
      "MISSING_RANKS"
    );
  }

  const warnings = [];

  if (tracks.some((track) => track.movementType === "unknown")) {
    warnings.push("Algunos movimientos no pudieron interpretarse.");
  }

  const seenSongs = new Set();
  const duplicateSongs = [];

  for (const track of tracks) {
    const key = normalizeSearch(
      `${track.artist}|${track.title}`
    );

    if (seenSongs.has(key)) {
      duplicateSongs.push(track.rank);
    }

    seenSongs.add(key);
  }

  if (duplicateSongs.length > 0) {
    warnings.push(
      `Posibles canciones duplicadas en puestos: ${duplicateSongs.join(", ")}.`
    );
  }

  return {
    tracks,
    quality: {
      complete: tracks.length === CONFIG.expectedTracks,
      expectedTracks: CONFIG.expectedTracks,
      parsedTracks: tracks.length,
      missingRanks,
      warnings
    }
  };
}

// ============================================================
// QUERY VALIDATION
// ============================================================

function getSingleQueryValue(value, name) {
  if (Array.isArray(value)) {
    throw new ChartError(
      `El parámetro ${name} no puede repetirse.`,
      "INVALID_QUERY",
      400
    );
  }

  if (value !== undefined && typeof value !== "string") {
    throw new ChartError(
      `El parámetro ${name} no es válido.`,
      "INVALID_QUERY",
      400
    );
  }

  return value;
}

function validateQuery(query = {}) {
  const allowedParameters = new Set(["q", "limit"]);

  for (const key of Object.keys(query)) {
    if (!allowedParameters.has(key)) {
      throw new ChartError(
        `Parámetro no permitido: ${key}.`,
        "INVALID_QUERY",
        400
      );
    }
  }

  const rawQ = getSingleQueryValue(query.q, "q");
  const rawLimit = getSingleQueryValue(query.limit, "limit");

  const q = normalizeText(rawQ || "");

  if (q.length > CONFIG.maxQueryLength) {
    throw new ChartError(
      "La búsqueda supera la longitud máxima permitida.",
      "QUERY_TOO_LONG",
      400
    );
  }

  let limit = CONFIG.expectedTracks;

  if (rawLimit !== undefined) {
    if (!/^\d+$/.test(rawLimit)) {
      throw new ChartError(
        "El parámetro limit debe ser un entero.",
        "INVALID_LIMIT",
        400
      );
    }

    limit = Number(rawLimit);

    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > CONFIG.expectedTracks
    ) {
      throw new ChartError(
        "El límite debe estar entre 1 y 50.",
        "INVALID_LIMIT",
        400
      );
    }
  }

  return {
    q,
    normalizedQ: normalizeSearch(q),
    limit
  };
}

function applyQueryFilters(tracks, query) {
  let result = tracks;

  if (query.normalizedQ) {
    result = result.filter((track) => {
      return (
        normalizeSearch(track.title).includes(query.normalizedQ) ||
        normalizeSearch(track.artist).includes(query.normalizedQ)
      );
    });
  }

  return result.slice(0, query.limit);
}

// ============================================================
// HTTP ETAG
// ============================================================

function computeETag(payload) {
  const hash = createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");

  return `"${hash}"`;
}

function matchesETag(header, etag) {
  if (!header || !etag) {
    return false;
  }

  const candidates = String(header)
    .split(",")
    .map((value) => value.trim());

  return candidates.some((candidate) => {
    if (candidate === "*") {
      return true;
    }

    const normalized = candidate.replace(/^W\//i, "");

    return normalized === etag;
  });
}

// ============================================================
// HTTP HEADERS
// ============================================================

function setSuccessHeaders(res, etag, contentLength) {
  res.setHeader(
    "Content-Type",
    "application/json; charset=utf-8"
  );

  res.setHeader(
    "Cache-Control",
    CONFIG.cacheControl
  );

  res.setHeader(
    "X-Content-Type-Options",
    "nosniff"
  );

  res.setHeader(
    "Referrer-Policy",
    "no-referrer"
  );

  res.setHeader(
    "X-Chart-Version",
    CONFIG.parserVersion
  );

  res.setHeader("ETag", etag);

  if (contentLength !== undefined) {
    res.setHeader("Content-Length", String(contentLength));
  }
}

function setErrorHeaders(res) {
  res.setHeader(
    "Content-Type",
    "application/json; charset=utf-8"
  );

  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate"
  );

  res.setHeader(
    "X-Content-Type-Options",
    "nosniff"
  );

  res.setHeader(
    "Referrer-Policy",
    "no-referrer"
  );
}

function sendError(res, error) {
  const status =
    error instanceof ChartError
      ? error.status
      : 502;

  const code =
    error instanceof ChartError
      ? error.code
      : "SOURCE_ERROR";

  if (status >= 500) {
    console.error("[Shunel Charts]", {
      code,
      message: error.message,
      name: error.name
    });
  }

  setErrorHeaders(res);

  const messages = {
    400: error.message,
    502: "No se pudo consultar el ranking de Spotify Costa Rica.",
    504: "La fuente del ranking tardó demasiado en responder."
  };

  return res.status(status).json({
    ok: false,
    error: messages[status] || "Error al procesar la solicitud.",
    code
  });
}

// ============================================================
// RESPONSE SIZE LIMIT
// ============================================================

async function readHtmlWithByteLimit(response, maxBytes) {
  const contentLengthHeader =
    response.headers.get("content-length");

  if (contentLengthHeader) {
    const declaredBytes = Number(contentLengthHeader);

    if (
      Number.isFinite(declaredBytes) &&
      declaredBytes > maxBytes
    ) {
      await response.body?.cancel().catch(() => {});

      throw new ChartError(
        "La respuesta supera el tamaño máximo permitido.",
        "RESPONSE_TOO_LARGE"
      );
    }
  }

  if (!response.body || typeof response.body.getReader !== "function") {
    throw new ChartError(
      "La fuente no permite lectura progresiva.",
      "UNSUPPORTED_RESPONSE_BODY"
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");

  let totalBytes = 0;
  let html = "";

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      totalBytes += value.byteLength;

      if (totalBytes > maxBytes) {
        throw new ChartError(
          "La respuesta supera el tamaño máximo permitido.",
          "RESPONSE_TOO_LARGE"
        );
      }

      html += decoder.decode(value, {
        stream: true
      });
    }

    html += decoder.decode();

    if (!html.trim()) {
      throw new ChartError(
        "La fuente devolvió una respuesta vacía.",
        "EMPTY_RESPONSE"
      );
    }

    return html;
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

// ============================================================
// RETRY AND TIMEOUT
// ============================================================

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfter(value) {
  if (!value) {
    return null;
  }

  const seconds = Number(value);

  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, CONFIG.maxRetryDelayMs);
  }

  const date = Date.parse(value);

  if (!Number.isFinite(date)) {
    return null;
  }

  return Math.min(
    Math.max(0, date - Date.now()),
    CONFIG.maxRetryDelayMs
  );
}

function getRetryDelay(attempt, retryAfter) {
  if (retryAfter !== null) {
    return retryAfter;
  }

  const exponential =
    CONFIG.retryBaseDelayMs * (2 ** attempt);

  const jitter = Math.floor(Math.random() * 150);

  return Math.min(
    exponential + jitter,
    CONFIG.maxRetryDelayMs
  );
}

function isRetryable(error) {
  if (error?.name === "AbortError") {
    return true;
  }

  if (error instanceof ChartError) {
    return (
      error.code === "SOURCE_TIMEOUT" ||
      error.code === "NETWORK_ERROR" ||
      error.code === "HTTP_TEMPORARY"
    );
  }

  return true;
}

async function fetchChartHtml() {
  let lastError = null;

  for (
    let attempt = 0;
    attempt < CONFIG.maxAttempts;
    attempt++
  ) {
    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, CONFIG.requestTimeoutMs);

    let retryAfter = null;

    try {
      const response = await fetch(CONFIG.source, {
        method: "GET",

        headers: {
          Accept: "text/html,application/xhtml+xml",
          "User-Agent":
            "Mozilla/5.0 (compatible; ShunelCharts/3.0; +https://shunel.vercel.app)"
        },

        signal: controller.signal,
        redirect: "follow"
      });

      if (!response.ok) {
        const status = response.status;

        retryAfter = parseRetryAfter(
          response.headers.get("retry-after")
        );

        await response.body?.cancel().catch(() => {});

        if (TEMPORARY_HTTP_STATUSES.has(status)) {
          throw new ChartError(
            `La fuente respondió con HTTP ${status}.`,
            "HTTP_TEMPORARY"
          );
        }

        throw new ChartError(
          `La fuente respondió con HTTP ${status}.`,
          "HTTP_SOURCE_ERROR"
        );
      }

      const contentType = String(
        response.headers.get("content-type") || ""
      ).toLowerCase();

      if (
        !contentType.includes("text/html") &&
        !contentType.includes("application/xhtml+xml")
      ) {
        await response.body?.cancel().catch(() => {});

        throw new ChartError(
          "La fuente devolvió un tipo de contenido inesperado.",
          "INVALID_CONTENT_TYPE"
        );
      }

      const html = await readHtmlWithByteLimit(
        response,
        CONFIG.maxHtmlBytes
      );

      return html;
    } catch (error) {
      lastError = error;

      if (error?.name === "AbortError") {
        lastError = createTimeoutError();
      }

      if (
        attempt >= CONFIG.maxAttempts - 1 ||
        !isRetryable(lastError)
      ) {
        throw lastError;
      }

      const delay = getRetryDelay(attempt, retryAfter);

      await sleep(delay);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new ChartError(
    "No se pudo obtener el ranking.",
    "SOURCE_ERROR"
  );
}

// ============================================================
// RESPONSE GENERATION
// ============================================================

function buildResponse(chart, filteredTracks, date) {
  /*
   * updatedAt representa la fecha del ranking,
   * no la hora de ejecución de esta petición.
   *
   * Se mantiene estable para permitir ETag y HTTP 304.
   */

  const updatedAt = date.chartDate
    ? `${date.chartDate}T00:00:00.000Z`
    : null;

  return {
    ok: true,

    chartId: CONFIG.chartId,
    parserVersion: CONFIG.parserVersion,

    country: "Costa Rica",
    countryCode: "cr",

    chart: "Spotify Daily Top 50",

    date: date.date,
    chartDate: date.chartDate,

    updatedAt,

    count: filteredTracks.length,
    totalAvailable: chart.tracks.length,

    quality: chart.quality,

    tracks: filteredTracks,

    source: CONFIG.source
  };
}

// ============================================================
// MAIN HANDLER
// ============================================================

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");

    return sendError(
      res,
      new ChartError(
        "Método no permitido.",
        "METHOD_NOT_ALLOWED",
        405
      )
    );
  }

  try {
    // 1. Validate query parameters.

    const query = validateQuery(req.query || {});

    // 2. Retrieve source HTML.

    const html = await fetchChartHtml();

    // 3. Parse and validate chart.

    const chart = parseChart(html);

    // 4. Extract chart date.

    const date = parseDate(html);

    // 5. Apply filters.

    const tracks = applyQueryFilters(
      chart.tracks,
      query
    );

    // 6. Build response.

    const data = buildResponse(
      chart,
      tracks,
      date
    );

    // 7. Generate representation-specific ETag.

    const etag = computeETag(data);

    const body = JSON.stringify(data);
    const contentLength = Buffer.byteLength(body, "utf8");

    // 8. Set HTTP headers.

    setSuccessHeaders(
      res,
      etag,
      contentLength
    );

    // 9. Conditional request handling.

    const ifNoneMatch = req.headers["if-none-match"];

    if (matchesETag(ifNoneMatch, etag)) {
      return res.status(304).end();
    }

    // 10. HEAD must return the same headers as GET,
    //     without sending a response body.

    if (req.method === "HEAD") {
      return res.status(200).end();
    }

    // 11. Send JSON.

    return res.status(200).send(body);

  } catch (error) {
    return sendError(res, error);
  }
}
