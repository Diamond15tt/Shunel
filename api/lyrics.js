/* SHUNEL — Lyrics API
 * Vercel Node.js Function: /api/lyrics
 * Multi-provider search with bounded requests, validation and diagnostics.
 * Runtime: Node.js 20+
 */

const PROVIDERS = Object.freeze({
  lrclib: "https://lrclib.net/api",
  liriqo: "https://api.liriqo-alfarrizi.my.id/v1",
  lrcmux: "https://api.lrcmux.dev",
  better: "https://api.betterlyrics.org",
  lyricsOvh: "https://api.lyrics.ovh/v1",
  youtube: "https://www.youtube.com"
});

const CONFIG = Object.freeze({
  userAgent: "Shunel/4.0 (+https://shunel.vercel.app)",
  maxTitleLength: 250,
  maxArtistLength: 180,
  maxVideoIdLength: 30,
  maxLyricsLength: 250_000,
  maxLines: 12_000,
  maxResponseBytes: 1_500_000,
  youtubeMaxBytes: 4_000_000,
  requestTimeoutMs: 8_000,
  liriqoTimeoutMs: 11_000,
  youtubeTimeoutMs: 9_000,
  totalTimeoutMs: 18_000,
  maxRetries: 1,
  cacheTtlMs: 60 * 60 * 1000,
  cacheMaxEntries: 100,
  minMatchScore: 62,
  earlySyncedScore: 68,
  earlySyncedQuality: 58,
  trustedProviderScore: 70,
  minTimedLines: 2,
  minTimingRatio: 0.5
});

const PROVIDER_NAMES = [
  "LRCLIB",
  "LiriQo",
  "LRCMux",
  "Better Lyrics",
  "Lyrics.ovh",
  "YouTube"
];

const WORD_LEVELS = new Set(["syllable", "word", "character"]);
const KNOWN_LEVELS = new Set(["syllable", "word", "character", "line", "plain"]);

const memoryCache = new Map();

class LyricsHttpError extends Error {
  constructor(message, status = 502, retryable = false) {
    super(message);
    this.name = "LyricsHttpError";
    this.status = status;
    this.retryable = retryable;
  }
}

/* ---------- Texto ---------- */

function clean(value, maxLength = 500) {
  return String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeText(value) {
  const base = clean(value, 500)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  const result = base
    .replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g, " ")
    .replace(
      /\s[-–—|]\s*(?:\d{4}\s+)?(?:remaster(?:ed)?|live|version|edit|mix|acoustic|mono|stereo|deluxe|radio|single|bonus|explicit|clean)\b.*$/i,
      " "
    )
    .replace(/\b(feat|ft|featuring)\b.*$/i, " ")
    .replace(
      /\b(official\s+(?:music\s+)?(?:video|audio|lyric\s+video)|lyrics?\s+video|lyric\s+video|video\s+oficial|audio\s+oficial|letra|lyrics|visuali[sz]er)\b/gi,
      " "
    )
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  return result || base.replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
}

function normalizeArtist(value) {
  return normalizeText(value)
    .replace(/\b(topic|vevo|official|oficial)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(value) {
  // &amp; va al final para no decodificar dos veces (&amp;quot; -> &quot;).
  return String(value ?? "")
    .replace(/&#(\d+);/g, (_, raw) => {
      try {
        return String.fromCodePoint(Number(raw));
      } catch {
        return "";
      }
    })
    .replace(/&#x([a-f\d]+);/gi, (_, raw) => {
      try {
        return String.fromCodePoint(Number.parseInt(raw, 16));
      } catch {
        return "";
      }
    })
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function stripLrcTags(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map(line =>
      line
        .replace(/^\s*(?:\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]\s*)+/, "")
        .replace(/<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/g, "")
        .replace(/\s+$/, "")
    )
    .filter(line => !/^\s*\[(ar|ti|al|by|re|ve|offset|length|kana|la|tool):/i.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* ---------- Validación ---------- */

function validVideoId(value) {
  return /^[A-Za-z0-9_-]{11}$/.test(value);
}

function validDuration(value) {
  return Number.isFinite(value) && value > 0 && value < 86_400;
}

function validLyrics(value) {
  if (typeof value !== "string") return false;
  const text = value.trim();

  if (text.length < 20 || text.length > CONFIG.maxLyricsLength) {
    return false;
  }

  if (/^(lyrics not found|not found|no lyrics|error|undefined|null)$/i.test(text)) {
    return false;
  }

  const visible = text
    .replace(/\[[^\]]+\]/g, "")
    .replace(/<[^>]+>/g, "")
    .trim();

  return visible.length >= 15;
}

/* ---------- Señales, tiempos y red ---------- */

function parseRetryAfter(response) {
  const raw = response.headers.get("retry-after");
  if (!raw) return 500;

  const seconds = Number(raw);
  if (Number.isFinite(seconds)) {
    return Math.min(4_000, Math.max(250, seconds * 1_000));
  }

  const date = Date.parse(raw);
  if (Number.isFinite(date)) {
    return Math.min(4_000, Math.max(250, date - Date.now()));
  }

  return 500;
}

function abortError() {
  const error = new Error("La solicitud fue cancelada.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const timer = setTimeout(done, ms);

    function done() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }

    function onAbort() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError());
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function combineSignals(signals) {
  const valid = signals.filter(Boolean);
  const controller = new AbortController();
  const cleanups = [];

  for (const signal of valid) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }

    const handler = () => controller.abort(signal.reason);
    signal.addEventListener("abort", handler, { once: true });
    cleanups.push(() => signal.removeEventListener("abort", handler));
  }

  return {
    signal: controller.signal,
    cleanup() {
      for (const cleanup of cleanups) cleanup();
    }
  };
}

async function readBodyLimited(response, maxBytes = CONFIG.maxResponseBytes) {
  const declaredLength = Number(response.headers.get("content-length") || 0);

  if (declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new LyricsHttpError("Respuesta del proveedor demasiado grande.", 502);
  }

  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new LyricsHttpError("Respuesta del proveedor supera el límite permitido.", 502);
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder("utf-8", { fatal: false }).decode(merged);
}

async function fetchText(url, options = {}) {
  const {
    signal,
    timeoutMs = CONFIG.requestTimeoutMs,
    headers = {},
    retries = CONFIG.maxRetries,
    maxBytes = CONFIG.maxResponseBytes
  } = options;

  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "https:") {
    throw new LyricsHttpError("Solo se permiten conexiones HTTPS.", 400);
  }

  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    throwIfAborted(signal);

    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
    const combined = combineSignals([signal, timeoutController.signal]);

    try {
      // Se siguen redirecciones (muchos proveedores y YouTube las usan),
      // pero el destino final debe seguir siendo HTTPS.
      const response = await fetch(parsedUrl, {
        method: "GET",
        redirect: "follow",
        signal: combined.signal,
        headers: {
          "User-Agent": CONFIG.userAgent,
          Accept: "application/json, text/plain, application/xml, text/xml, */*",
          ...headers
        }
      });

      if (response.url && new URL(response.url).protocol !== "https:") {
        await response.body?.cancel().catch(() => {});
        throw new LyricsHttpError("Redirección no segura rechazada.", 502);
      }

      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        const retryDelay = response.status === 429
          ? parseRetryAfter(response)
          : 350 * (attempt + 1);

        await response.body?.cancel().catch(() => {});

        if (retryable && attempt < retries) {
          await sleep(retryDelay + Math.floor(Math.random() * 180), signal);
          continue;
        }

        throw new LyricsHttpError(
          `Proveedor respondió HTTP ${response.status}.`,
          response.status,
          retryable
        );
      }

      return await readBodyLimited(response, maxBytes);
    } catch (error) {
      if (signal?.aborted) throw abortError();

      let failure = error;
      if (timeoutController.signal.aborted) {
        failure = new LyricsHttpError("Tiempo de espera agotado.", 504, true);
      }

      lastError = failure;

      const retryable = failure?.retryable || failure?.status === 429 ||
        failure?.status >= 500 || failure?.name === "TypeError";

      if (!retryable || attempt >= retries) throw failure;

      await sleep(350 * (attempt + 1) + Math.floor(Math.random() * 180), signal);
    } finally {
      clearTimeout(timeout);
      combined.cleanup();
    }
  }

  throw lastError || new LyricsHttpError("No se pudo contactar al proveedor.", 502);
}

async function fetchJson(url, options = {}) {
  const text = await fetchText(url, options);

  try {
    return JSON.parse(text);
  } catch {
    throw new LyricsHttpError("El proveedor devolvió JSON inválido.", 502);
  }
}

/* Une base + ruta SIN perder el prefijo de la base
 * (new URL("/search", "https://x/api") descartaba "/api"). */
function makeUrl(base, path, params = {}) {
  const joined = `${String(base).replace(/\/+$/, "")}/${String(path).replace(/^\/+/, "")}`;
  const url = new URL(joined);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  return url.toString();
}

/* ---------- Tiempos y LRC ---------- */

function startOf(item) {
  return item.start ?? item.time ?? item.timestamp ?? item.offset ??
    item.startTime ?? item.start_time;
}

function endOf(item) {
  return item.end ?? item.endTime ?? item.end_time;
}

/* La unidad (segundos o milisegundos) se decide UNA vez para toda la lista.
 * Ninguna canción dura más de 2 h, así que un máximo > 7200 implica ms. */
function detectTimeScale(values) {
  let max = -Infinity;

  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0 && number > max) max = number;
  }

  if (max === -Infinity) return 1;
  return max > 7_200 ? 0.001 : 1;
}

function toSeconds(value, scale) {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw < 0) return null;
  return raw * scale;
}

function formatLrcTime(seconds) {
  const centiseconds = Math.round(Math.max(0, seconds) * 100);
  const minutes = Math.floor(centiseconds / 6_000);
  const remainder = centiseconds % 6_000;
  const wholeSeconds = Math.floor(remainder / 100);
  const fraction = remainder % 100;

  return `[${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}.${String(fraction).padStart(2, "0")}]`;
}

function inspectLrc(text) {
  if (!validLyrics(text)) {
    return { valid: false, lineCount: 0, timedLineCount: 0, ratio: 0 };
  }

  const lines = text.split(/\r?\n/);
  let lineCount = 0;
  let timedLineCount = 0;
  const timestamp = /^\s*\[(\d{1,3}):([0-5]\d)(?:[.:](\d{1,3}))?\]/;

  for (const line of lines) {
    const value = line.trim();
    if (!value || /^\[(ar|ti|al|by|re|ve|offset|length|kana|la|tool):/i.test(value)) {
      continue;
    }

    lineCount++;
    if (timestamp.test(value)) timedLineCount++;
  }

  return {
    valid: lineCount > 0,
    lineCount,
    timedLineCount,
    ratio: lineCount ? timedLineCount / lineCount : 0
  };
}

function normalizeTimedEntries(entries, duration = 0) {
  if (!Array.isArray(entries)) return [];

  const list = entries
    .slice(0, CONFIG.maxLines)
    .filter(item => item && typeof item === "object");

  const scale = detectTimeScale(list.map(startOf));
  const output = [];

  for (const item of list) {
    const start = toSeconds(startOf(item), scale);
    const text = decodeEntities(item.text ?? item.word ?? "").trim();

    if (start === null || !text || text.length > 1_000) continue;
    if (duration > 0 && start > duration * 1.25 + 30) continue;

    output.push({ time: start, text });
  }

  output.sort((a, b) => a.time - b.time);

  return output.filter((line, index) =>
    index === 0 ||
    line.time !== output[index - 1].time ||
    line.text !== output[index - 1].text
  );
}

function entriesToLrc(entries, duration = 0) {
  return normalizeTimedEntries(entries, duration)
    .map(line => `${formatLrcTime(line.time)}${line.text}`)
    .join("\n");
}

/* nestedOnly: solo toma palabras que vengan dentro de line.words / line.syllables. */
function normalizeWordTimings(entries, duration = 0, nestedOnly = false) {
  if (!Array.isArray(entries)) return [];

  const flat = [];

  for (const item of entries.slice(0, CONFIG.maxLines)) {
    if (!item || typeof item !== "object") continue;

    const nested = item.words ?? item.syllables;
    if (Array.isArray(nested)) {
      for (const word of nested.slice(0, 500)) {
        if (word && typeof word === "object") flat.push(word);
      }
    } else if (!nestedOnly) {
      flat.push(item);
    }

    if (flat.length >= CONFIG.maxLines * 4) break;
  }

  const scale = detectTimeScale(flat.map(startOf));

  return flat.flatMap(item => {
    const start = toSeconds(startOf(item), scale);
    const end = toSeconds(endOf(item), scale);
    const text = decodeEntities(item.text ?? item.word ?? "").trim();

    if (start === null || !text || text.length > 200) return [];
    if (duration > 0 && start > duration * 1.25 + 30) return [];

    return [{
      text,
      start,
      end: end !== null && end >= start ? end : null
    }];
  }).sort((a, b) => a.start - b.start);
}

function createResult(lyrics, source, synced = false, metadata = {}) {
  if (!validLyrics(lyrics)) return null;

  const raw = lyrics.trim();
  const info = inspectLrc(raw);

  const hasTimestamps = Boolean(
    synced &&
    info.valid &&
    info.timedLineCount >= CONFIG.minTimedLines &&
    info.ratio >= CONFIG.minTimingRatio
  );

  // Con tiempos: se quitan solo etiquetas inline <mm:ss.xx>.
  // Sin tiempos: se quitan todas las etiquetas LRC para no mostrarlas en pantalla.
  const text = hasTimestamps
    ? raw.replace(/<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/g, "")
    : stripLrcTags(raw);

  if (!validLyrics(text)) return null;

  return {
    text,
    source,
    synced: hasTimestamps,
    syncedLyrics: hasTimestamps ? text : "",
    plainLyrics: hasTimestamps ? "" : text,
    syncLevel: hasTimestamps ? (metadata.syncLevel || "line") : "plain",
    wordTimings: hasTimestamps && Array.isArray(metadata.wordTimings)
      ? metadata.wordTimings
      : [],
    language: metadata.language || null,
    duration: Number.isFinite(metadata.duration) ? metadata.duration : null,
    metadata: {
      lineCount: info.lineCount,
      timedLineCount: info.timedLineCount,
      timingRatio: info.ratio,
      provider: source,
      matchScore: Number.isFinite(metadata.matchScore)
        ? metadata.matchScore
        : CONFIG.trustedProviderScore
    }
  };
}

/* ---------- Coincidencia y ranking ---------- */

function similarityScore(target, candidate, lenient = false) {
  if (!target || !candidate) return 0;
  if (target === candidate) return 1;

  const a = new Set(target.split(" ").filter(Boolean));
  const b = new Set(candidate.split(" ").filter(Boolean));
  const intersection = [...a].filter(word => b.has(word)).length;
  const union = new Set([...a, ...b]).size;
  let score = union ? intersection / union : 0;

  if (lenient) {
    score = Math.max(
      score,
      (0.9 * intersection) / Math.max(1, Math.min(a.size, b.size))
    );
  }

  if (candidate.includes(target) || target.includes(candidate)) {
    const ratio = Math.min(target.length, candidate.length) /
      Math.max(target.length, candidate.length);
    score = Math.max(score, 0.6 + 0.35 * ratio);
  }

  return Math.min(1, score);
}

function matchScore(target, candidate) {
  const titleScore = similarityScore(
    normalizeText(target.title),
    normalizeText(candidate.title)
  );

  if (titleScore < 0.5) return Math.round(titleScore * 40);

  const hasArtist = Boolean(target.artist && candidate.artist);
  const artistScore = hasArtist
    ? similarityScore(normalizeArtist(target.artist), normalizeArtist(candidate.artist), true)
    : 0.45;

  let score = titleScore * 68 + artistScore * 27;

  const candidateDuration = Number(candidate.duration);
  let difference = null;

  if (target.duration > 0 && validDuration(candidateDuration)) {
    difference = Math.abs(target.duration - candidateDuration) / target.duration;

    if (difference <= 0.01) score += 6;
    else if (difference <= 0.03) score += 4;
    else if (difference <= 0.06) score += 2;
    else if (difference > 0.2) score -= 14;
    else if (difference > 0.1) score -= 6;
  }

  // Artista distinto: solo se acepta si el título es casi exacto y la duración coincide.
  if (hasArtist && artistScore < 0.2) {
    const rescued = titleScore >= 0.95 && difference !== null && difference <= 0.03;
    if (!rescued) score = Math.min(score, 55);
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

function resultQuality(item) {
  if (!item) return 0;

  let score = item.synced ? 48 : 0;
  const levels = { syllable: 28, word: 24, character: 22, line: 10, plain: 0 };
  score += levels[String(item.syncLevel || "plain").toLowerCase()] || 0;

  if (item.wordTimings?.length) score += 14;
  if ((item.metadata?.timingRatio || 0) >= 0.8) score += 7;
  else if ((item.metadata?.timingRatio || 0) >= 0.5) score += 3;
  if ((item.metadata?.lineCount || 0) >= 5) score += 3;
  if (item.language === "es") score += 2;

  return score;
}

function selectBestResult(results) {
  return results
    .filter(Boolean)
    .filter(item => validLyrics(item.text))
    .sort((a, b) => {
      const qualityDifference = resultQuality(b) - resultQuality(a);
      if (qualityDifference) return qualityDifference;
      return (b.metadata?.matchScore || 0) - (a.metadata?.matchScore || 0);
    })[0] || null;
}

function isGoodEnough(item) {
  return Boolean(
    item?.synced &&
    resultQuality(item) >= CONFIG.earlySyncedQuality &&
    (item.metadata?.matchScore ?? 0) >= CONFIG.earlySyncedScore
  );
}

/* ---------- Proveedores ---------- */

function pickLrclib(target, data) {
  if (!Array.isArray(data)) return null;

  const candidates = data
    .filter(item => item && typeof item === "object" && !item.instrumental)
    .map(item => ({
      item,
      score: matchScore(target, {
        title: item.trackName,
        artist: item.artistName,
        duration: item.duration
      })
    }))
    .filter(candidate =>
      candidate.score >= CONFIG.minMatchScore &&
      (validLyrics(candidate.item.syncedLyrics) || validLyrics(candidate.item.plainLyrics))
    )
    .map(candidate => ({
      ...candidate,
      rank: candidate.score + (validLyrics(candidate.item.syncedLyrics) ? 6 : 0)
    }))
    .sort((a, b) => b.rank - a.rank);

  const best = candidates[0];
  if (!best) return null;

  const synced = validLyrics(best.item.syncedLyrics);
  return createResult(
    synced ? best.item.syncedLyrics : best.item.plainLyrics,
    "LRCLIB",
    synced,
    {
      syncLevel: synced ? "line" : "plain",
      duration: Number(best.item.duration) || null,
      matchScore: best.score
    }
  );
}

async function searchLrclib(target, signal) {
  const queries = [{ track_name: target.title, artist_name: target.artist }];
  if (target.artist) queries.push({ q: `${target.artist} ${target.title}` });

  for (const params of queries) {
    throwIfAborted(signal);

    const data = await fetchJson(makeUrl(PROVIDERS.lrclib, "/search", params), {
      signal,
      timeoutMs: CONFIG.requestTimeoutMs
    });

    const result = pickLrclib(target, data);
    if (result) return result;
  }

  return null;
}

function normalizeLevel(value) {
  const level = String(value || "").toLowerCase();
  return KNOWN_LEVELS.has(level) ? level : "line";
}

async function searchLiriqo(target, videoId, signal) {
  const url = makeUrl(PROVIDERS.liriqo, "/lyrics", {
    v: videoId || undefined,
    title: videoId ? undefined : target.title,
    artist: videoId ? undefined : target.artist,
    duration: target.duration ? Math.round(target.duration) : undefined,
    full: "1"
  });

  const data = await fetchJson(url, { signal, timeoutMs: CONFIG.liriqoTimeoutMs });
  if (!data || typeof data !== "object" || data.error) return null;

  const candidates = [
    ...(data.primary ? [data.primary] : []),
    ...(Array.isArray(data.tracks) ? data.tracks : [])
  ].filter(item => item && typeof item === "object");

  const unique = [];
  const seen = new Set();

  for (const item of candidates) {
    const key = [
      item.provider, item.upstreamProvider, item.syncLevel,
      item.lrc, item.plain, JSON.stringify(item.timed || [])
    ].join("|");

    if (!seen.has(key)) {
      seen.add(key);
      unique.push(item);
    }
  }

  const rank = { syllable: 6, word: 5, character: 5, line: 4, plain: 1 };

  unique.sort((a, b) =>
    (rank[normalizeLevel(b.syncLevel)] || 0) -
    (rank[normalizeLevel(a.syncLevel)] || 0)
  );

  for (const item of unique) {
    const level = normalizeLevel(item.syncLevel);
    const wordLevel = WORD_LEVELS.has(level);
    const source = `LiriQo · ${clean(item.upstreamProvider || item.provider || "Proveedor", 60)}`;

    // 1) Un LRC ya armado por líneas siempre tiene prioridad.
    if (typeof item.lrc === "string" && inspectLrc(item.lrc).timedLineCount > 0) {
      const result = createResult(item.lrc, source, true, {
        syncLevel: level === "plain" ? "line" : level,
        wordTimings: wordLevel ? normalizeWordTimings(item.timed, target.duration) : [],
        duration: target.duration || null
      });
      if (result?.synced) return result;
    }

    // 2) `timed` solo se convierte a LRC si son LÍNEAS.
    //    En nivel palabra/sílaba cada entrada es una palabra: convertirla
    //    daba una línea por palabra.
    if (!wordLevel && Array.isArray(item.timed)) {
      const lrc = entriesToLrc(item.timed, target.duration);
      const result = createResult(lrc, source, true, {
        syncLevel: "line",
        duration: target.duration || null
      });
      if (result?.synced) return result;
    }
  }

  for (const item of unique) {
    if (validLyrics(item.plain)) {
      return createResult(
        item.plain,
        `LiriQo · ${clean(item.upstreamProvider || item.provider || "Proveedor", 60)}`,
        false
      );
    }
  }

  return null;
}

function looksLikeWordEntries(lines) {
  if (!Array.isArray(lines) || lines.length < 40) return false;

  const sample = lines
    .slice(0, 200)
    .map(line => String(line?.text ?? line?.word ?? "").trim())
    .filter(Boolean);

  if (!sample.length) return false;

  const average = sample.reduce((sum, text) => sum + text.split(/\s+/).length, 0) /
    sample.length;

  return average < 1.3;
}

async function searchLrcmux(target, signal) {
  let lastError = null;

  for (const level of ["word", "line"]) {
    throwIfAborted(signal);

    const url = makeUrl(PROVIDERS.lrcmux, "/get", {
      title: target.title,
      artist: target.artist,
      level,
      format: "json",
      duration: target.duration ? Math.round(target.duration) : undefined
    });

    let data;
    try {
      data = await fetchJson(url, { signal, timeoutMs: 9_000 });
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") throw error;
      lastError = error;
      continue;
    }

    if (!data || typeof data !== "object" || !Array.isArray(data.lines)) continue;

    // Si cada "línea" es una palabra suelta, se pide el nivel por línea.
    if (looksLikeWordEntries(data.lines)) continue;

    const lrc = entriesToLrc(data.lines, target.duration);
    const source = `LRCMux · ${clean(data.meta?.source?.name || "Proveedor", 60)}`;

    if (validLyrics(lrc)) {
      const words = normalizeWordTimings(data.lines, target.duration, true);
      const result = createResult(lrc, source, true, {
        syncLevel: words.length ? "word" : "line",
        wordTimings: words,
        duration: target.duration || null
      });
      if (result?.synced) return result;
    }

    const plain = data.lines
      .map(line => decodeEntities(line?.text || "").trim())
      .filter(Boolean)
      .join("\n");

    const plainResult = createResult(plain, source, false);
    if (plainResult) return plainResult;
  }

  if (lastError) throw lastError;
  return null;
}

/* Formatos de Better Lyrics: LRC normal, o KRC/QRC "[inicio_ms,duracion]texto<..>". */
function parseBetterLyrics(raw, providerLabel, target) {
  const lyrics = decodeEntities(raw);
  const source = `Better Lyrics · ${providerLabel}`;

  if (inspectLrc(lyrics).timedLineCount >= CONFIG.minTimedLines) {
    const result = createResult(lyrics, source, true, {
      syncLevel: "line",
      duration: target.duration || null
    });
    if (result?.synced) return result;
  }

  const krcLines = lyrics.split(/\r?\n/).flatMap(line => {
    const match = line.match(/^\s*\[(\d+),(\d+)\](.*)$/);
    if (!match) return [];

    const text = match[3]
      .replace(/<\d+,\d+(?:,\d+)?>/g, "")
      .replace(/\(\d+,\d+(?:,\d+)?\)/g, "")
      .trim();

    return text ? [{ time: Number(match[1]), text }] : [];
  });

  if (krcLines.length >= 3) {
    const lrc = entriesToLrc(krcLines, target.duration);
    const result = createResult(lrc, source, true, {
      syncLevel: "line",
      duration: target.duration || null
    });
    if (result?.synced) return result;
  }

  const plain = lyrics
    .replace(/<[^>]*>/g, "")
    .replace(/\(\d+,\d+(?:,\d+)?\)|\[\d+,\d+\]/g, "");

  return createResult(plain, source, false);
}

async function searchBetterLyrics(target, signal) {
  let fallbackPlain = null;

  for (const provider of ["kugou", "qq"]) {
    throwIfAborted(signal);

    const url = makeUrl(PROVIDERS.better, `/${provider}/getLyrics`, {
      s: target.title,
      a: target.artist,
      al: "",
      d: Math.round(target.duration || 0)
    });

    let data;
    try {
      data = await fetchJson(url, { signal, timeoutMs: 7_000, retries: 0 });
    } catch (error) {
      if (signal?.aborted) throw error;
      continue;
    }

    if (!validLyrics(data?.lyrics)) continue;

    const result = parseBetterLyrics(
      data.lyrics,
      provider === "qq" ? "QQ Music" : "KuGou",
      target
    );

    if (result?.synced) return result;
    if (result && !fallbackPlain) fallbackPlain = result;
  }

  return fallbackPlain;
}

function cleanPlainOvh(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/^\s*Paroles de la chanson[^\n]*\n+/i, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function searchLyricsOvh(target, signal) {
  if (!target.title || !target.artist) return null;

  const url = `${PROVIDERS.lyricsOvh}/${encodeURIComponent(target.artist)}/${encodeURIComponent(target.title)}`;
  const data = await fetchJson(url, { signal, timeoutMs: CONFIG.requestTimeoutMs });

  return createResult(cleanPlainOvh(data?.lyrics), "Lyrics.ovh", false);
}

/* ---------- YouTube ---------- */

function extractArrayAfter(html, marker) {
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) return null;

  const start = html.indexOf("[", markerIndex);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < html.length; index++) {
    const char = html[index];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === "[") depth++;
    else if (char === "]") {
      depth--;
      if (depth === 0) return html.slice(start, index + 1);
    }
  }

  return null;
}

function extractYoutubeCaptionLines(xml, duration = 0) {
  if (typeof xml !== "string" || xml.length > CONFIG.maxLyricsLength * 2) return [];

  const entries = [];
  const stripTags = value =>
    decodeEntities(value.replace(/<[^>]+>/g, "").replace(/\s+/g, " ")).trim();

  // Formato clásico: <text start="1.2" dur="3">...</text> (segundos)
  const legacy = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
  let match;

  while ((match = legacy.exec(xml)) && entries.length < CONFIG.maxLines) {
    const startRaw = (match[1] || "").match(/\bstart=["']([\d.]+)["']/i)?.[1];
    if (!startRaw) continue;

    const start = Number(startRaw);
    const text = stripTags(match[2]);

    if (!Number.isFinite(start) || start < 0 || !text || text.length > 1_000) continue;
    if (duration > 0 && start > duration * 1.25 + 30) continue;

    entries.push({ time: start, text });
  }

  // Formato srv3: <p t="1200" d="3000">...</p> (milisegundos)
  if (!entries.length) {
    const modern = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;

    while ((match = modern.exec(xml)) && entries.length < CONFIG.maxLines) {
      const startRaw = (match[1] || "").match(/\bt=["'](\d+)["']/i)?.[1];
      if (!startRaw) continue;

      const start = Number(startRaw) / 1_000;
      const text = stripTags(match[2]);

      if (!Number.isFinite(start) || start < 0 || !text || text.length > 1_000) continue;
      if (duration > 0 && start > duration * 1.25 + 30) continue;

      entries.push({ time: start, text });
    }
  }

  entries.sort((a, b) => a.time - b.time);

  return entries.filter((line, index) =>
    index === 0 || line.text !== entries[index - 1].text
  );
}

async function searchYoutube(videoId, target, signal) {
  if (!validVideoId(videoId)) return null;

  const watchUrl = `${PROVIDERS.youtube}/watch?v=${encodeURIComponent(videoId)}`;
  const html = await fetchText(watchUrl, {
    signal,
    timeoutMs: CONFIG.youtubeTimeoutMs,
    retries: 0,
    maxBytes: CONFIG.youtubeMaxBytes,
    headers: {
      "Accept-Language": "es,en;q=0.8",
      Cookie: "SOCS=CAI"
    }
  });

  const rawTracks = extractArrayAfter(html, '"captionTracks":');
  if (!rawTracks) return null;

  let tracks;
  try {
    tracks = JSON.parse(rawTracks);
  } catch {
    return null;
  }

  if (!Array.isArray(tracks) || !tracks.length) return null;

  // Los subtítulos automáticos (asr) no son letras: se descartan.
  const manual = tracks.filter(track => track && track.kind !== "asr");
  if (!manual.length) return null;

  const preferred = manual.find(track => /^es(-|$)/i.test(track.languageCode || "")) ||
    manual.find(track => /^en(-|$)/i.test(track.languageCode || "")) ||
    manual[0];

  if (!preferred?.baseUrl) return null;

  const captionUrl = new URL(preferred.baseUrl);
  if (captionUrl.protocol !== "https:" ||
      !/(^|\.)youtube\.com$/i.test(captionUrl.hostname)) {
    return null;
  }

  const xml = await fetchText(captionUrl.toString(), {
    signal,
    timeoutMs: CONFIG.youtubeTimeoutMs,
    retries: 0
  });

  const entries = extractYoutubeCaptionLines(xml, target.duration);
  const lrc = entriesToLrc(entries, target.duration);

  return createResult(lrc, "YouTube Subtitles", true, {
    syncLevel: "line",
    language: clean(preferred.languageCode || "", 12) || null,
    duration: target.duration || null
  });
}

/* ---------- Caché ---------- */

function makeCacheKey(target, videoId) {
  return [
    normalizeText(target.artist),
    normalizeText(target.title),
    videoId || "",
    target.duration ? Math.round(target.duration / 5) * 5 : 0
  ].join("|");
}

function getCache(key) {
  const entry = memoryCache.get(key);
  if (!entry) return null;

  if (Date.now() - entry.timestamp > CONFIG.cacheTtlMs) {
    memoryCache.delete(key);
    return null;
  }

  memoryCache.delete(key);
  memoryCache.set(key, entry);
  return entry.value;
}

function setCache(key, value) {
  memoryCache.delete(key);
  memoryCache.set(key, { timestamp: Date.now(), value });

  while (memoryCache.size > CONFIG.cacheMaxEntries) {
    memoryCache.delete(memoryCache.keys().next().value);
  }
}

/* ---------- Ejecución de proveedores ---------- */

async function runProvider(name, callback, diagnostics, signal) {
  const startedAt = Date.now();

  try {
    throwIfAborted(signal);
    const value = await callback(signal);

    diagnostics[name] = {
      success: Boolean(value),
      durationMs: Date.now() - startedAt,
      status: value ? "found" : "not_found"
    };

    return value;
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") {
      diagnostics[name] = {
        success: false,
        durationMs: Date.now() - startedAt,
        status: "cancelled"
      };
      return null;
    }

    if (error?.status === 404) {
      diagnostics[name] = {
        success: false,
        durationMs: Date.now() - startedAt,
        status: "not_found"
      };
      return null;
    }

    diagnostics[name] = {
      success: false,
      durationMs: Date.now() - startedAt,
      status: error?.status === 504 ? "timeout" : "error",
      message: clean(error?.message || "Error desconocido", 140)
    };

    return null;
  }
}

/* Lanza todos los proveedores en paralelo y termina en cuanto uno devuelve
 * un resultado suficientemente bueno (cancelando el resto), o cuando todos
 * acaban. Nunca descarta lo ya encontrado si se agota el tiempo. */
async function runRound(tasks, signal, diagnostics) {
  const results = [];
  if (!tasks.length) return results;

  const roundController = new AbortController();
  const combined = combineSignals([signal, roundController.signal]);

  let resolveEarly;
  const early = new Promise(resolve => { resolveEarly = resolve; });

  const all = Promise.all(tasks.map(async ([name, callback]) => {
    const value = await runProvider(name, callback, diagnostics, combined.signal);

    if (value) {
      results.push(value);
      if (isGoodEnough(value)) resolveEarly();
    }

    return value;
  }));

  try {
    await Promise.race([all, early]);
  } finally {
    roundController.abort();
    combined.cleanup();
  }

  return [...results];
}

function getQueryValue(query, key) {
  const value = query?.[key];
  return Array.isArray(value) ? value[0] : value;
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, status, payload) {
  // Los errores nunca deben quedar cacheados en el CDN.
  if (status >= 400) res.setHeader("Cache-Control", "no-store");
  res.status(status).json(payload);
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.setHeader("Allow", "GET, OPTIONS");
    return res.status(204).end();
  }

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    return sendJson(res, 405, { error: "Método no permitido." });
  }

  let title = clean(getQueryValue(req.query, "title"), CONFIG.maxTitleLength);
  let artist = clean(getQueryValue(req.query, "artist"), CONFIG.maxArtistLength);
  const requestedVideoId = clean(getQueryValue(req.query, "videoId"), CONFIG.maxVideoIdLength);
  const videoId = validVideoId(requestedVideoId) ? requestedVideoId : "";
  const requestedDuration = Number(getQueryValue(req.query, "duration"));
  const duration = validDuration(requestedDuration) ? requestedDuration : 0;

  if (!title && !videoId) {
    return sendJson(res, 400, {
      error: "Se necesita el título o un videoId válido."
    });
  }

  // Títulos de YouTube tipo "Artista - Canción" cuando no llega el artista.
  if (title && !artist) {
    const parts = title.split(/\s+[-–—]\s+/);
    if (parts.length >= 2 && parts[0] && parts.slice(1).join(" - ")) {
      artist = clean(parts[0], CONFIG.maxArtistLength);
      title = clean(parts.slice(1).join(" - "), CONFIG.maxTitleLength);
    }
  }

  const target = { title, artist, duration };
  const cacheKey = makeCacheKey(target, videoId);
  const cached = getCache(cacheKey);

  if (cached) {
    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
    res.setHeader("X-Shunel-Lyrics-Cache", "HIT");
    return sendJson(res, 200, { ...cached, cache: "hit" });
  }

  const startedAt = Date.now();
  const diagnostics = {};
  const clientController = new AbortController();
  const totalController = new AbortController();
  const totalTimer = setTimeout(
    () => totalController.abort(),
    CONFIG.totalTimeoutMs
  );

  const onRequestAborted = () => clientController.abort();
  const onResponseClose = () => {
    if (!res.writableEnded) clientController.abort();
  };

  req.on?.("aborted", onRequestAborted);
  res.on?.("close", onResponseClose);

  const combined = combineSignals([clientController.signal, totalController.signal]);
  const signal = combined.signal;

  const plan = (tasks, name, enabled, callback) => {
    if (enabled) {
      tasks.push([name, callback]);
    } else {
      diagnostics[name] = { success: false, durationMs: 0, status: "skipped" };
    }
  };

  const respondOk = (result) => {
    // Si se agotó el tiempo total, el resultado puede ser parcial: no se cachea.
    const partial = totalController.signal.aborted;

    if (partial) {
      res.setHeader("Cache-Control", "no-store");
    } else {
      res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
      setCache(cacheKey, result);
    }

    res.setHeader("X-Shunel-Lyrics-Cache", "MISS");

    return sendJson(res, 200, {
      ...result,
      diagnostics: {
        providers: diagnostics,
        totalDurationMs: Date.now() - startedAt
      }
    });
  };

  try {
    const firstTasks = [];
    plan(firstTasks, "LRCLIB", Boolean(title), s => searchLrclib(target, s));
    plan(firstTasks, "LiriQo", Boolean(title || videoId), s => searchLiriqo(target, videoId, s));
    plan(firstTasks, "LRCMux", Boolean(title && artist), s => searchLrcmux(target, s));
    plan(firstTasks, "Better Lyrics", Boolean(title && artist), s => searchBetterLyrics(target, s));

    const firstRound = await runRound(firstTasks, signal, diagnostics);

    if (clientController.signal.aborted) return;

    let best = selectBestResult(firstRound);
    if (best && isGoodEnough(best)) return respondOk(best);

    let secondRound = [];

    if (!totalController.signal.aborted) {
      const secondTasks = [];
      plan(secondTasks, "Lyrics.ovh", Boolean(title && artist), s => searchLyricsOvh(target, s));
      plan(secondTasks, "YouTube", Boolean(videoId), s => searchYoutube(videoId, target, s));

      secondRound = await runRound(secondTasks, signal, diagnostics);

      if (clientController.signal.aborted) return;
    }

    best = selectBestResult([...firstRound, ...secondRound]);
    if (best) return respondOk(best);

    if (totalController.signal.aborted) {
      return sendJson(res, 504, {
        error: "La búsqueda de letras superó el tiempo máximo.",
        diagnostics: {
          providers: diagnostics,
          totalDurationMs: Date.now() - startedAt
        }
      });
    }

    const failedProviders = PROVIDER_NAMES.filter(name =>
      ["error", "timeout"].includes(diagnostics[name]?.status)
    );

    return sendJson(res, 404, {
      error: "No encontramos una letra disponible.",
      providersChecked: PROVIDER_NAMES,
      failedProviders,
      diagnostics: {
        providers: diagnostics,
        totalDurationMs: Date.now() - startedAt
      }
    });
  } catch (error) {
    if (signal.aborted && clientController.signal.aborted) return;

    console.error("[Shunel Lyrics API]", clean(error?.message || error, 240));
    return sendJson(res, 500, { error: "Error interno buscando letras." });
  } finally {
    clearTimeout(totalTimer);
    combined.cleanup();
    req.off?.("aborted", onRequestAborted);
    res.off?.("close", onResponseClose);
  }
}
