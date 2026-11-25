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
  requestTimeoutMs: 8_000,
  liriqoTimeoutMs: 11_000,
  youtubeTimeoutMs: 9_000,
  totalTimeoutMs: 18_000,
  maxRetries: 1,
  cacheTtlMs: 60 * 60 * 1000,
  cacheMaxEntries: 100,
  minMatchScore: 62,
  earlySyncedScore: 68,
  earlySyncedQuality: 58
});

const PROVIDER_NAMES = [
  "LRCLIB",
  "LiriQo",
  "LRCMux",
  "Better Lyrics",
  "Lyrics.ovh",
  "YouTube"
];

const memoryCache = new Map();

class LyricsHttpError extends Error {
  constructor(message, status = 502, retryable = false) {
    super(message);
    this.name = "LyricsHttpError";
    this.status = status;
    this.retryable = retryable;
  }
}

function clean(value, maxLength = 500) {
  return String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeText(value) {
  return clean(value, 500)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(feat|ft|featuring)\b.*$/i, "")
    .replace(/\b(official|video|lyrics?|letra|audio|visualizer)\b/gi, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(value) {
  return String(value ?? "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, raw) => {
      const code = Number(raw);
      try {
        return String.fromCodePoint(code);
      } catch {
        return "";
      }
    })
    .replace(/&#x([a-f\d]+);/gi, (_, raw) => {
      const code = Number.parseInt(raw, 16);
      try {
        return String.fromCodePoint(code);
      } catch {
        return "";
      }
    });
}

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
    retries = CONFIG.maxRetries
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
      const response = await fetch(parsedUrl, {
        method: "GET",
        redirect: "error",
        signal: combined.signal,
        headers: {
          "User-Agent": CONFIG.userAgent,
          Accept: "application/json, text/plain, application/xml, text/xml, */*",
          ...headers
        }
      });

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

      return await readBodyLimited(response);
    } catch (error) {
      lastError = error;

      if (signal?.aborted) throw abortError();
      if (timeoutController.signal.aborted) {
        lastError = new LyricsHttpError("Tiempo de espera agotado.", 504, true);
      }

      const retryable = error?.retryable || error?.status === 429 ||
        error?.status >= 500 || error?.name === "TypeError" ||
        error?.name === "AbortError";

      if (!retryable || attempt >= retries) throw lastError;

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

function normalizeTimestamp(value, duration = 0) {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw < 0) return null;

  if (duration > 0 && raw > duration * 1.5) {
    return raw / 1_000;
  }

  if (raw >= 100_000) return raw / 1_000;
  return raw;
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

  const output = [];

  for (const item of entries.slice(0, CONFIG.maxLines)) {
    if (!item || typeof item !== "object") continue;

    const rawStart = item.start ?? item.time ?? item.timestamp ??
      item.offset ?? item.startTime ?? item.start_time;

    const start = normalizeTimestamp(rawStart, duration);
    const text = decodeEntities(item.text ?? item.word ?? "").trim();

    if (start === null || !text || text.length > 1_000) continue;
    if (duration > 0 && start > duration + 30) continue;

    output.push({ time: start, text });
  }

  output.sort((a, b) => a.time - b.time);
  return output;
}

function entriesToLrc(entries, duration = 0) {
  return normalizeTimedEntries(entries, duration)
    .map(line => `${formatLrcTime(line.time)}${line.text}`)
    .join("\n");
}

function normalizeWordTimings(entries, duration = 0) {
  if (!Array.isArray(entries)) return [];

  return entries.slice(0, CONFIG.maxLines).flatMap(item => {
    if (!item || typeof item !== "object") return [];

    const start = normalizeTimestamp(
      item.start ?? item.time ?? item.timestamp,
      duration
    );
    const end = normalizeTimestamp(
      item.end ?? item.endTime ?? item.end_time,
      duration
    );
    const text = decodeEntities(item.text ?? item.word ?? "").trim();

    if (start === null || !text || text.length > 200) return [];

    return [{
      text,
      start,
      end: end !== null && end >= start ? end : null
    }];
  }).sort((a, b) => a.start - b.start);
}

function createResult(lyrics, source, synced = false, metadata = {}) {
  if (!validLyrics(lyrics)) return null;

  const text = lyrics.trim();
  const info = inspectLrc(text);
  const hasTimestamps = Boolean(synced && info.valid && info.timedLineCount);

  return {
    text,
    source,
    synced: hasTimestamps,
    syncedLyrics: hasTimestamps ? text : "",
    plainLyrics: hasTimestamps ? "" : text,
    syncLevel: metadata.syncLevel || (hasTimestamps ? "line" : "plain"),
    wordTimings: Array.isArray(metadata.wordTimings) ? metadata.wordTimings : [],
    language: metadata.language || null,
    duration: Number.isFinite(metadata.duration) ? metadata.duration : null,
    metadata: {
      lineCount: info.lineCount,
      timedLineCount: info.timedLineCount,
      timingRatio: info.ratio,
      provider: source,
      matchScore: Number.isFinite(metadata.matchScore) ? metadata.matchScore : null
    }
  };
}

function similarityScore(target, candidate) {
  if (!target || !candidate) return 0;
  if (target === candidate) return 1;

  const a = new Set(target.split(" "));
  const b = new Set(candidate.split(" "));
  const intersection = [...a].filter(word => b.has(word)).length;
  const union = new Set([...a, ...b]).size;
  const jaccard = union ? intersection / union : 0;

  if (candidate.includes(target) || target.includes(candidate)) {
    return Math.max(0.82, jaccard);
  }

  return jaccard;
}

function matchScore(target, candidate) {
  const titleScore = similarityScore(
    normalizeText(target.title),
    normalizeText(candidate.title)
  );
  const artistScore = target.artist
    ? similarityScore(normalizeText(target.artist), normalizeText(candidate.artist))
    : 0.45;

  let score = titleScore * 68 + artistScore * 27;

  const candidateDuration = Number(candidate.duration);
  if (target.duration > 0 && validDuration(candidateDuration)) {
    const difference = Math.abs(target.duration - candidateDuration) / target.duration;

    if (difference <= 0.02) score += 5;
    else if (difference <= 0.06) score += 3;
    else if (difference > 0.2) score -= 14;
  }

  return Math.round(score);
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

function makeUrl(base, path, params = {}) {
  const url = new URL(path, base);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function searchLrclib(target, signal) {
  const url = makeUrl(PROVIDERS.lrclib, "/search", {
    track_name: target.title,
    artist_name: target.artist,
    duration: target.duration ? Math.round(target.duration) : undefined
  });

  const data = await fetchJson(url, { signal, timeoutMs: CONFIG.requestTimeoutMs });
  if (!Array.isArray(data)) return null;

  const candidates = data.map(item => {
    const score = matchScore(target, {
      title: item.trackName,
      artist: item.artistName,
      duration: item.duration
    });
    return { item, score };
  }).filter(candidate =>
    candidate.score >= CONFIG.minMatchScore &&
    (validLyrics(candidate.item.syncedLyrics) || validLyrics(candidate.item.plainLyrics))
  ).sort((a, b) => {
    const syncA = validLyrics(a.item.syncedLyrics) ? 1 : 0;
    const syncB = validLyrics(b.item.syncedLyrics) ? 1 : 0;
    return (syncB - syncA) || (b.score - a.score);
  });

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
    (rank[String(b.syncLevel).toLowerCase()] || 0) -
    (rank[String(a.syncLevel).toLowerCase()] || 0)
  );

  for (const item of unique) {
    const timed = normalizeTimedEntries(item.timed, target.duration);
    const lrc = entriesToLrc(timed, target.duration);

    if (validLyrics(lrc)) {
      const words = normalizeWordTimings(item.timed, target.duration);
      return createResult(
        lrc,
        `LiriQo · ${clean(item.upstreamProvider || item.provider || "Proveedor", 60)}`,
        true,
        {
          syncLevel: rank[String(item.syncLevel).toLowerCase()]
            ? String(item.syncLevel).toLowerCase()
            : "line",
          wordTimings: words,
          duration: target.duration || null
        }
      );
    }

    if (validLyrics(item.lrc) && inspectLrc(item.lrc).timedLineCount > 0) {
      return createResult(
        item.lrc,
        `LiriQo · ${clean(item.upstreamProvider || item.provider || "Proveedor", 60)}`,
        true,
        {
          syncLevel: String(item.syncLevel || "line").toLowerCase(),
          wordTimings: normalizeWordTimings(item.timed, target.duration),
          duration: target.duration || null
        }
      );
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

async function searchLrcmux(target, signal) {
  const url = makeUrl(PROVIDERS.lrcmux, "/get", {
    title: target.title,
    artist: target.artist,
    level: "word",
    format: "json",
    duration: target.duration ? Math.round(target.duration) : undefined
  });

  const data = await fetchJson(url, { signal, timeoutMs: 9_000 });
  if (!data || typeof data !== "object" || !Array.isArray(data.lines)) return null;

  const lrc = entriesToLrc(data.lines, target.duration);
  const source = `LRCMux · ${clean(data.meta?.source?.name || "Proveedor", 60)}`;

  if (validLyrics(lrc)) {
    return createResult(lrc, source, true, {
      syncLevel: "word",
      wordTimings: normalizeWordTimings(data.lines, target.duration),
      duration: target.duration || null
    });
  }

  const plain = data.lines
    .map(line => decodeEntities(line?.text || "").trim())
    .filter(Boolean)
    .join("\n");

  return createResult(plain, source, false);
}

async function searchBetterLyrics(target, signal) {
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

    const lyrics = decodeEntities(data.lyrics);
    if (provider === "kugou" && inspectLrc(lyrics).timedLineCount > 0) {
      return createResult(lyrics, "Better Lyrics · KuGou", true, {
        syncLevel: "line",
        duration: target.duration || null
      });
    }

    const plain = lyrics
      .replace(/<[^>]*>/g, "\n")
      .replace(/\(\d+,\d+\)|\[\d+,\d+\]/g, "")
      .trim();

    const resultValue = createResult(
      plain,
      `Better Lyrics · ${provider === "qq" ? "QQ Music" : "KuGou"}`,
      false
    );
    if (resultValue) return resultValue;
  }

  return null;
}

async function searchLyricsOvh(target, signal) {
  if (!target.title || !target.artist) return null;

  const url = `${PROVIDERS.lyricsOvh}/${encodeURIComponent(target.artist)}/${encodeURIComponent(target.title)}`;
  const data = await fetchJson(url, { signal, timeoutMs: CONFIG.requestTimeoutMs });

  return createResult(data?.lyrics, "Lyrics.ovh", false);
}

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
  if (typeof xml !== "string" || xml.length > CONFIG.maxLyricsLength) return [];

  const entries = [];
  const regex = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
  let match;

  while ((match = regex.exec(xml)) && entries.length < CONFIG.maxLines) {
    const attributes = match[1] || "";
    const startRaw = attributes.match(/\bstart=["']([\d.]+)["']/i)?.[1];
    const durRaw = attributes.match(/\bdur=["']([\d.]+)["']/i)?.[1];
    if (!startRaw) continue;

    const start = Number(startRaw);
    const segmentDuration = Number(durRaw || 0);
    const text = decodeEntities(
      match[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ")
    ).trim();

    if (!Number.isFinite(start) || start < 0 || !text || text.length > 1_000) continue;
    if (duration > 0 && start > duration + 30) continue;

    entries.push({ time: start, duration: segmentDuration, text });
  }

  return entries.sort((a, b) => a.time - b.time);
}

async function searchYoutube(videoId, target, signal) {
  if (!validVideoId(videoId)) return null;

  const watchUrl = `${PROVIDERS.youtube}/watch?v=${encodeURIComponent(videoId)}`;
  const html = await fetchText(watchUrl, {
    signal,
    timeoutMs: CONFIG.youtubeTimeoutMs,
    retries: 0,
    headers: { "Accept-Language": "es,en;q=0.8" }
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

  const preferred = tracks.find(track => /^es(-|$)/i.test(track.languageCode || "")) ||
    tracks.find(track => /^en(-|$)/i.test(track.languageCode || "")) ||
    tracks[0];

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

async function runProvider(name, callback, diagnostics, signal) {
  const startedAt = Date.now();

  try {
    throwIfAborted(signal);
    const value = await callback();

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

    diagnostics[name] = {
      success: false,
      durationMs: Date.now() - startedAt,
      status: error?.status === 504 ? "timeout" : "error",
      message: clean(error?.message || "Error desconocido", 140)
    };

    return null;
  }
}

function getQueryValue(query, key) {
  const value = query?.[key];
  return Array.isArray(value) ? value[0] : value;
}

function sendJson(res, status, payload) {
  res.status(status).json(payload);
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Allow", "GET, OPTIONS");
    return res.status(204).end();
  }

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    return sendJson(res, 405, { error: "Método no permitido." });
  }

  const title = clean(getQueryValue(req.query, "title"), CONFIG.maxTitleLength);
  const artist = clean(getQueryValue(req.query, "artist"), CONFIG.maxArtistLength);
  const requestedVideoId = clean(getQueryValue(req.query, "videoId"), CONFIG.maxVideoIdLength);
  const videoId = validVideoId(requestedVideoId) ? requestedVideoId : "";
  const requestedDuration = Number(getQueryValue(req.query, "duration"));
  const duration = validDuration(requestedDuration) ? requestedDuration : 0;

  if (!title && !videoId) {
    return sendJson(res, 400, {
      error: "Se necesita el título o un videoId válido."
    });
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

  res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
  res.setHeader("X-Shunel-Lyrics-Cache", "MISS");

  try {
    const firstRound = await Promise.all([
      runProvider("LRCLIB", () => title ? searchLrclib(target, signal) : null, diagnostics, signal),
      runProvider("LiriQo", () => searchLiriqo(target, videoId, signal), diagnostics, signal),
      runProvider("LRCMux", () => title && artist ? searchLrcmux(target, signal) : null, diagnostics, signal),
      runProvider("Better Lyrics", () => title && artist ? searchBetterLyrics(target, signal) : null, diagnostics, signal)
    ]);

    if (signal.aborted) {
      if (totalController.signal.aborted && !clientController.signal.aborted) {
        return sendJson(res, 504, { error: "La búsqueda de letras superó el tiempo máximo." });
      }
      return;
    }

    const bestFirstRound = selectBestResult(firstRound);

    if (
      bestFirstRound?.synced &&
      resultQuality(bestFirstRound) >= CONFIG.earlySyncedQuality &&
      (bestFirstRound.metadata?.matchScore ?? 100) >= CONFIG.earlySyncedScore
    ) {
      const payload = {
        ...bestFirstRound,
        diagnostics: {
          providers: diagnostics,
          totalDurationMs: Date.now() - startedAt
        }
      };
      setCache(cacheKey, payload);
      return sendJson(res, 200, payload);
    }

    const secondRound = await Promise.all([
      runProvider("Lyrics.ovh", () => title && artist ? searchLyricsOvh(target, signal) : null, diagnostics, signal),
      runProvider("YouTube", () => videoId ? searchYoutube(videoId, target, signal) : null, diagnostics, signal)
    ]);

    if (signal.aborted) {
      if (totalController.signal.aborted && !clientController.signal.aborted) {
        return sendJson(res, 504, { error: "La búsqueda de letras superó el tiempo máximo." });
      }
      return;
    }

    const best = selectBestResult([...firstRound, ...secondRound]);

    if (best) {
      const payload = {
        ...best,
        diagnostics: {
          providers: diagnostics,
          totalDurationMs: Date.now() - startedAt
        }
      };
      setCache(cacheKey, payload);
      return sendJson(res, 200, payload);
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