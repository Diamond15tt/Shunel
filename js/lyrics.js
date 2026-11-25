/* =========================================================
   SHUNEL — LYRICS ENGINE 3.1
   Multi-source integration
   Universal LRC / Enhanced LRC parser
   Word synchronization (etiquetas <mm:ss> o wordTimings del backend)
   Smart cache / Retry / Abort
   Binary search / Smart scrolling
   Safari & iOS compatible
========================================================= */

const CONFIG = Object.freeze({
  API_URL: "/api/lyrics",

  CACHE_PREFIX: "shunel_lyrics_v4_",
  LEGACY_CACHE_PREFIXES: ["shun&& el_lyrics_v3_", "shunel_lyrics_v3_"],
  CACHE_TTL: 7 * 24 * 60 * 60 * 1000,
  CACHE_TTL_PLAIN: 60 * 60 * 1000,
  CACHE_MAX_ITEMS: 60,

  // El backend puede tardar hasta 18 s: el cliente debe esperar más que eso.
  REQUEST_TIMEOUT: 20000,
  MAX_RETRIES: 1,

  SCROLL_RESUME_DELAY: 4000,
  SCROLL_CENTER_TOLERANCE: 0.08,
  BACKWARD_JITTER: 0.25,

  MAX_LYRICS_LENGTH: 250000,
  MAX_LINES: 12000
});

/* =========================================================
   ESTADO INTERNO
========================================================= */

let parsedLines = [];
let lineElements = [];
let activeLineIndex = -1;
let activeWordIndex = -1;

let currentAbortController = null;
let currentRequestId = 0;
let currentTrackKey = "";

let currentMetadata = {};
let currentLyricsData = null;

let lastSyncTime = -1;
let lastScrollIndex = -1;

let scrollResumeTimer = null;
let manualScrollUntil = 0;

let lyricsContainer = null;
let scrollListenersBound = false;

const lyricsCache = new Map();

const WORD_TIME_TAG =
  /<(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?>/g;

const LINE_TIME_TAG =
  /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

// Solo las etiquetas de tiempo al INICIO de la línea cuentan como tiempo de línea.
const LEADING_LINE_TAGS =
  /^\s*((?:\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]\s*)+)(.*)$/;

const INLINE_WORD_TAG_TEST =
  /<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/;

class LyricsTimeoutError extends Error {
  constructor() {
    super("Tiempo de espera agotado.");
    this.name = "TimeoutError";
  }
}

/* =========================================================
   UTILIDADES GENERALES
========================================================= */

function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[​-‍﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSearchText(value) {
  return normalizeText(value)
    .toLocaleLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function isFiniteNumber(value) {
  return value !== null &&
    value !== undefined &&
    value !== "" &&
    Number.isFinite(Number(value));
}

/* =========================================================
   IDENTIDAD DE LA PISTA (título / artista / duración)
========================================================= */

const GENERIC_CHANNEL =
  /(vevo|topic|official|oficial|records?|music|musica|música|entertainment|tv)\s*$/i;

const NOISE_IN_BRACKETS =
  /\s*[(\[{][^)\]}]*\b(?:official|oficial|video|vídeo|videoclip|audio|lyrics?|lyric|letra|visuali[sz]er|hd|4k|mv|clip)\b[^)\]}]*[)\]}]/gi;

const FEAT_IN_BRACKETS =
  /\s*[(\[]\s*(?:feat|ft|featuring)\.?[^)\]]*[)\]]/gi;

const TRAILING_NOISE =
  /\s*[|:–—-]?\s*(?:official\s+(?:music\s+)?(?:video|audio|lyric\s+video)|lyric\s+video|lyrics?\s+video|video\s+oficial|audio\s+oficial|videoclip(?:\s+oficial)?|letra(?:\s+oficial)?|lyrics?)\s*$/i;

const VERSION_LIKE =
  /^(?:\d{4}\s+)?(?:remaster|live|version|mix|edit|acoustic|en vivo|remix|mono|stereo|radio|instrumental|demo)/i;

function cleanTrackTitle(title) {
  const original = normalizeText(title);

  let value = original
    .replace(NOISE_IN_BRACKETS, "")
    .replace(FEAT_IN_BRACKETS, "")
    .replace(/\s*\|.*$/, "")
    .replace(TRAILING_NOISE, "")
    .replace(/\s*[-–—]\s*topic$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  return value || original;
}

function cleanArtistName(artist) {
  return normalizeText(artist)
    .replace(/\s*[-–—]\s*topic$/i, "")
    .replace(/\s*vevo$/i, "")
    .replace(/\s*\((?:official|oficial)[^)]*\)$/i, "")
    .replace(/\s+(?:official|oficial)(?:\s+(?:channel|canal))?$/i, "")
    .trim();
}

/* Los títulos de YouTube suelen ser "Artista - Canción" y el artista
   suele ser el canal ("BadBunnyVEVO"). Se separa el título aquí. */
export function getTrackIdentity(track) {
  const rawArtist = normalizeText(
    track?.artist ||
    track?.channelTitle ||
    track?.channel ||
    track?.author ||
    ""
  );

  let artist = cleanArtistName(rawArtist);
  let title = cleanTrackTitle(track?.title || track?.name || "");

  const parts = title.split(/\s+[-–—]\s+/);

  if (parts.length >= 2) {
    const head = parts[0].trim();
    const rest = parts.slice(1).join(" - ").trim();

    if (head && rest) {
      const normalizedHead =
        normalizeSearchText(head).replace(/\s/g, "");
      const normalizedArtist =
        normalizeSearchText(artist).replace(/\s/g, "");

      const related = Boolean(
        normalizedArtist &&
        normalizedHead &&
        (
          normalizedArtist.includes(normalizedHead) ||
          normalizedHead.includes(normalizedArtist)
        )
      );

      const generic = !artist || GENERIC_CHANNEL.test(rawArtist);
      const versionLike = VERSION_LIKE.test(rest);

      if (related || generic || !versionLike) {
        artist = head;
        title = rest;
      }
    }
  }

  return { title, artist };
}

function parseDurationValue(value) {
  if (typeof value === "string") {
    const text = value.trim();

    const iso = text.match(
      /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i
    );

    if (iso && (iso[1] || iso[2] || iso[3])) {
      return (
        Number(iso[1] || 0) * 3600 +
        Number(iso[2] || 0) * 60 +
        Number(iso[3] || 0)
      );
    }

    const clock = text.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);

    if (clock) {
      return (
        Number(clock[1] || 0) * 3600 +
        Number(clock[2]) * 60 +
        Number(clock[3])
      );
    }
  }

  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

export function getTrackDuration(track) {
  const seconds = parseDurationValue(track?.durationSeconds);
  if (seconds > 0) return seconds;

  const milliseconds = parseDurationValue(track?.durationMs);
  if (milliseconds > 0) return milliseconds / 1000;

  const raw = [track?.duration, track?.length]
    .map(parseDurationValue)
    .find(value => value > 0) || 0;

  if (!raw) return 0;

  // Ninguna canción dura más de 2 h: por encima de eso son milisegundos.
  return raw > 7200 ? raw / 1000 : raw;
}

function getTrackVideoId(track) {
  const candidates = [
    track?.videoId,
    track?.id?.videoId,
    typeof track?.id === "string" ? track.id : ""
  ];

  return candidates.find(value =>
    typeof value === "string" &&
    /^[A-Za-z0-9_-]{11}$/.test(value)
  ) || "";
}

function getCacheKey(track) {
  const { title, artist } = getTrackIdentity(track);
  const duration = getTrackDuration(track);

  // La duración separa versiones (estudio / en vivo / cover).
  const bucket = duration ? Math.round(duration / 5) * 5 : 0;

  return [
    normalizeSearchText(artist),
    normalizeSearchText(title),
    bucket
  ].join("|");
}

function getLyricsContainer() {
  return document.getElementById("lyricsContainer");
}

function getLyricsTitle() {
  return document.getElementById("lyricsTitle");
}

function getLyricsSubtitle() {
  return document.getElementById("lyricsSubtitle");
}

function setLyricsStatus(message, className = "muted") {
  const container = getLyricsContainer();

  if (!container) return;

  container.innerHTML =
    `<p class="${escapeHTML(className)}">${escapeHTML(message)}</p>`;

  container.scrollTop = 0;
}

function isReducedMotion() {
  return Boolean(
    window.matchMedia?.(
      "(prefers-reduced-motion: reduce)"
    ).matches
  );
}

/* =========================================================
   CACHÉ EN MEMORIA Y LOCALSTORAGE
========================================================= */

function ttlFor(data) {
  return data?.syncedLyrics
    ? CONFIG.CACHE_TTL
    : CONFIG.CACHE_TTL_PLAIN;
}

/* Solo se guarda lo imprescindible: sin diagnostics ni wordTimings
   (las palabras ya van incrustadas en el LRC mejorado). */
function toCacheable(data) {
  return {
    syncedLyrics: data.syncedLyrics || "",
    plainLyrics: data.plainLyrics || "",
    source: data.source || "Desconocida",
    language: data.language || null,
    syncLevel: data.syncLevel || null
  };
}

function purgeLegacyCache() {
  try {
    const stale = [];

    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);

      if (
        key &&
        CONFIG.LEGACY_CACHE_PREFIXES.some(prefix =>
          key.startsWith(prefix)
        )
      ) {
        stale.push(key);
      }
    }

    stale.forEach(key => localStorage.removeItem(key));
  } catch {
    // Almacenamiento no disponible.
  }
}

function readPersistentCache(key) {
  try {
    const raw = localStorage.getItem(
      CONFIG.CACHE_PREFIX + key
    );

    if (!raw) return null;

    const entry = JSON.parse(raw);

    if (
      !entry ||
      !entry.expires ||
      Date.now() > entry.expires ||
      !entry.data
    ) {
      localStorage.removeItem(
        CONFIG.CACHE_PREFIX + key
      );

      return null;
    }

    return entry.data;
  } catch {
    return null;
  }
}

function writePersistentCache(key, data) {
  try {
    const now = Date.now();

    localStorage.setItem(
      CONFIG.CACHE_PREFIX + key,
      JSON.stringify({
        timestamp: now,
        expires: now + ttlFor(data),
        data
      })
    );

    cleanPersistentCache();
  } catch {
    // La caché no debe impedir que se carguen las letras.
  }
}

function cleanPersistentCache() {
  try {
    const keys = [];

    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);

      if (key?.startsWith(CONFIG.CACHE_PREFIX)) {
        keys.push(key);
      }
    }

    if (keys.length <= CONFIG.CACHE_MAX_ITEMS) {
      return;
    }

    const entries = keys.map(key => {
      try {
        const value = JSON.parse(
          localStorage.getItem(key)
        );

        return {
          key,
          timestamp: value?.timestamp || 0
        };
      } catch {
        return { key, timestamp: 0 };
      }
    });

    entries.sort(
      (a, b) => a.timestamp - b.timestamp
    );

    const removeCount =
      entries.length - CONFIG.CACHE_MAX_ITEMS;

    for (let i = 0; i < removeCount; i++) {
      localStorage.removeItem(entries[i].key);
    }
  } catch {
    // Almacenamiento no disponible.
  }
}

function getCachedLyrics(key) {
  if (lyricsCache.has(key)) {
    const entry = lyricsCache.get(key);

    if (Date.now() <= entry.expires) {
      // Actualizar posición para comportamiento LRU.
      lyricsCache.delete(key);
      lyricsCache.set(key, entry);

      return entry.data;
    }

    lyricsCache.delete(key);
  }

  const persistent = readPersistentCache(key);

  if (persistent) {
    setCachedLyrics(key, persistent, false);
    return persistent;
  }

  return null;
}

function setCachedLyrics(key, data, persist = true) {
  if (!key || !data) return;

  const compact = toCacheable(data);

  lyricsCache.delete(key);

  lyricsCache.set(key, {
    expires: Date.now() + ttlFor(compact),
    data: compact
  });

  while (lyricsCache.size > CONFIG.CACHE_MAX_ITEMS) {
    const oldestKey = lyricsCache.keys().next().value;
    lyricsCache.delete(oldestKey);
  }

  if (persist) {
    writePersistentCache(key, compact);
  }
}

/* =========================================================
   PARSER DE TIMESTAMPS
========================================================= */

function parseTimestamp(minutes, seconds, fraction = "0") {
  const min = Number(minutes);
  const sec = Number(seconds);

  if (
    !Number.isFinite(min) ||
    !Number.isFinite(sec) ||
    sec >= 60
  ) {
    return null;
  }

  const digits = String(fraction || "0");

  const milliseconds = Number(
    digits.padEnd(3, "0").slice(0, 3)
  );

  return (
    min * 60 +
    sec +
    milliseconds / 1000
  );
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatStamp(seconds) {
  const total = Math.round(Math.max(0, seconds) * 100);
  const minutes = Math.floor(total / 6000);
  const wholeSeconds = Math.floor((total % 6000) / 100);
  const centiseconds = total % 100;

  return `${pad2(minutes)}:${pad2(wholeSeconds)}.${pad2(centiseconds)}`;
}

/* =========================================================
   METADATOS LRC
========================================================= */

function parseLRCMetadata(text) {
  const metadata = {
    title: "",
    artist: "",
    album: "",
    author: "",
    by: "",
    offset: 0,
    length: "",
    version: "",
    language: ""
  };

  const patterns = {
    title: /^\[ti:(.*?)\]$/i,
    artist: /^\[ar:(.*?)\]$/i,
    album: /^\[al:(.*?)\]$/i,
    author: /^\[au:(.*?)\]$/i,
    by: /^\[by:(.*?)\]$/i,
    length: /^\[length:(.*?)\]$/i,
    version: /^\[ve:(.*?)\]$/i,
    language: /^\[la:(.*?)\]$/i
  };

  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();

    for (const [key, pattern] of Object.entries(patterns)) {
      const match = line.match(pattern);

      if (match) {
        metadata[key] = normalizeText(match[1]);
      }
    }

    const offsetMatch = line.match(
      /^\[offset:\s*([+-]?\d+)\s*\]$/i
    );

    if (offsetMatch) {
      // Según la especificación LRC, un offset positivo ADELANTA la letra.
      metadata.offset = Number(offsetMatch[1]) / 1000;
    }
  }

  return metadata;
}

/* =========================================================
   ENHANCED LRC
   Soporta timestamps por línea y por palabra/sílaba.
========================================================= */

function parseEnhancedLine(rawText, lineStart, offset = 0) {
  const matches = [
    ...rawText.matchAll(WORD_TIME_TAG)
  ];

  if (!matches.length) {
    return {
      text: rawText
        .replace(/<[^>]*>/g, "")
        .trim(),
      words: []
    };
  }

  const words = [];

  // Texto que aparece antes de la primera etiqueta de palabra.
  const leading = rawText
    .slice(0, matches[0].index)
    .replace(/<[^>]*>/g, "");

  if (leading.trim()) {
    words.push({
      text: leading.trim(),
      start: Math.max(0, lineStart),
      end: null,
      space: true
    });
  }

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];

    const timestamp = parseTimestamp(
      match[1],
      match[2],
      match[3] || "0"
    );

    if (timestamp === null) continue;

    const nextMatch = matches[i + 1];

    const end = nextMatch
      ? nextMatch.index
      : rawText.length;

    // Sin trim: el espacio final indica si la palabra termina ahí
    // (en sílabas no hay espacio entre una y otra).
    const segment = rawText
      .slice(match.index + match[0].length, end)
      .replace(/<[^>]*>/g, "");

    const wordText = segment.trim();

    if (!wordText) {
      if (/\s/.test(segment) && words.length) {
        words[words.length - 1].space = true;
      }

      continue;
    }

    words.push({
      text: wordText,
      start: Math.max(0, timestamp - offset),
      end: null,
      space: /\s$/.test(segment)
    });
  }

  for (let i = 0; i < words.length; i++) {
    words[i].end =
      words[i + 1]?.start ?? null;
  }

  const text = words
    .map((word, index) =>
      word.text +
      (word.space && index < words.length - 1 ? " " : "")
    )
    .join("")
    .trim();

  return {
    text,
    words
  };
}

export function parseLRC(text) {
  if (
    typeof text !== "string" ||
    !text.trim() ||
    text.length > CONFIG.MAX_LYRICS_LENGTH
  ) {
    return [];
  }

  const metadata = parseLRCMetadata(text);
  const result = [];

  const lines = text.split(/\r?\n/);

  for (const rawLine of lines) {
    const lineMatch = rawLine.match(LEADING_LINE_TAGS);

    if (!lineMatch) continue;

    const stamps = [
      ...lineMatch[1].matchAll(LINE_TIME_TAG)
    ];

    if (!stamps.length) continue;

    const lyricText = lineMatch[2].trim();

    const baseTimestamp = parseTimestamp(
      stamps[0][1],
      stamps[0][2],
      stamps[0][3] || "0"
    );

    if (baseTimestamp === null) continue;

    const wordData = lyricText
      ? parseEnhancedLine(
          lyricText,
          Math.max(0, baseTimestamp - metadata.offset),
          metadata.offset
        )
      : { text: "", words: [] };

    for (const stamp of stamps) {
      const timestamp = parseTimestamp(
        stamp[1],
        stamp[2],
        stamp[3] || "0"
      );

      if (timestamp === null) continue;

      const time = Math.max(
        0,
        timestamp - metadata.offset
      );

      // Estribillos repetidos: [00:10][01:30]texto → las palabras se desplazan.
      const delta = timestamp - baseTimestamp;

      result.push({
        time,
        text: wordData.text || lyricText,
        gap: !lyricText,
        words: wordData.words.map(word => ({
          ...word,
          start: word.start + delta,
          end: word.end === null ? null : word.end + delta
        }))
      });
    }
  }

  result.sort((a, b) => a.time - b.time);

  // Quitar duplicados exactos, líneas vacías iniciales y vacías consecutivas.
  const unique = [];

  for (const line of result) {
    const previous = unique[unique.length - 1];

    if (
      previous &&
      previous.time === line.time &&
      previous.text === line.text
    ) {
      continue;
    }

    if (line.gap && (!previous || previous.gap)) {
      continue;
    }

    unique.push(line);
  }

  // Añadir duración estimada a palabras sin final.
  for (let i = 0; i < unique.length; i++) {
    const line = unique[i];
    const nextLine = unique[i + 1];

    const lineEnd = nextLine
      ? nextLine.time
      : line.time + 8;

    for (let j = 0; j < line.words.length; j++) {
      const word = line.words[j];

      if (
        !Number.isFinite(word.end) ||
        word.end === null
      ) {
        word.end =
          line.words[j + 1]?.start ??
          lineEnd;
      }

      word.end = Math.max(
        word.start,
        word.end
      );
    }
  }

  return unique.slice(0, CONFIG.MAX_LINES);
}

/* =========================================================
   LRC MEJORADO (construcción) Y WORD TIMINGS DEL BACKEND
========================================================= */

function buildEnhancedLRC(lines) {
  return lines
    .map(line => {
      const head = `[${formatStamp(line.time)}]`;

      if (line.words?.length) {
        return head + line.words
          .map(word =>
            `<${formatStamp(word.start)}>${word.text}` +
            (word.space !== false ? " " : "")
          )
          .join("")
          .trimEnd();
      }

      return head + (line.text || "");
    })
    .join("\n");
}

/* Coloca cada palabra dentro de su línea comprobando que el texto coincida. */
function alignWords(lineText, words) {
  if (!words.length) return null;

  const text = normalizeText(lineText);
  let cursor = 0;
  const output = [];

  for (const word of words) {
    const wordText = normalizeText(word.text);

    if (!wordText) continue;

    const index = text.indexOf(wordText, cursor);

    if (index < 0 || index - cursor > 3) return null;

    const after = index + wordText.length;

    output.push({
      text: wordText,
      start: word.start,
      end: Number.isFinite(word.end) ? word.end : null,
      space: /\s/.test(text[after] ?? "")
    });

    cursor = after;
  }

  const rest = text
    .slice(cursor)
    .replace(/[\s\p{P}]/gu, "");

  if (rest.length > 2) return null;

  return output.length ? output : null;
}

function enrichWithWordTimings(lrcText, wordTimings) {
  if (parseLRCMetadata(lrcText).offset !== 0) return null;

  const lines = parseLRC(lrcText);

  if (!lines.length) return null;

  const words = wordTimings
    .filter(word =>
      word &&
      typeof word.text === "string" &&
      Number.isFinite(Number(word.start))
    )
    .map(word => ({
      text: word.text,
      start: Number(word.start),
      end: word.end === null || word.end === undefined
        ? null
        : Number(word.end)
    }))
    .sort((a, b) => a.start - b.start);

  if (!words.length) return null;

  let cursor = 0;
  let matched = 0;
  let textLines = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const nextTime = lines[i + 1]?.time ?? Infinity;
    const group = [];

    while (
      cursor < words.length &&
      words[cursor].start < nextTime - 0.05
    ) {
      if (words[cursor].start >= line.time - 0.3) {
        group.push(words[cursor]);
      }

      cursor++;
    }

    if (line.gap) continue;

    textLines++;

    const aligned = alignWords(line.text, group);

    if (aligned) {
      line.words = aligned;
      matched++;
    }
  }

  // Si casi nada coincide, es mejor dejar la letra por línea.
  if (!textLines || matched < textLines * 0.6) return null;

  return buildEnhancedLRC(lines);
}

/* =========================================================
   NORMALIZACIÓN DE RESPUESTAS JSON
   Permite integrar proveedores con estructuras diferentes.
========================================================= */

function detectTimeScale(values) {
  let max = -Infinity;

  for (const value of values) {
    const number = Number(value);

    if (Number.isFinite(number) && number >= 0 && number > max) {
      max = number;
    }
  }

  if (max === -Infinity) return 1;

  // Ninguna canción dura más de 2 h: un máximo mayor implica milisegundos.
  return max > 7200 ? 0.001 : 1;
}

function normalizeTimedJSON(data) {
  if (!data || typeof data !== "object") {
    return [];
  }

  const sourceLines =
    data.lines ||
    (Array.isArray(data.lyrics) ? data.lyrics : null) ||
    data.syncedLines ||
    [];

  if (!Array.isArray(sourceLines)) return [];

  const items = sourceLines
    .slice(0, CONFIG.MAX_LINES)
    .filter(item => item && typeof item === "object");

  const startOf = item =>
    item.start ??
    item.time ??
    item.timestamp ??
    item.startTime ??
    item.start_time;

  const scale = detectTimeScale(items.map(startOf));
  const lines = [];

  for (const item of items) {
    const rawTime = startOf(item);

    if (!isFiniteNumber(rawTime)) continue;

    const time = Number(rawTime) * scale;
    const nested = Array.isArray(item.words) ? item.words : null;

    let rawText = item.text ?? item.lyric ?? item.content;

    if (rawText === null || rawText === undefined) {
      rawText = typeof item.words === "string"
        ? item.words
        : nested
          ? nested
              .map(word => word?.text ?? word?.word ?? "")
              .join(" ")
          : "";
    }

    const text = normalizeText(rawText);

    if (!text) continue;

    const words = nested
      ? nested
          .filter(word => word && typeof word === "object")
          .map(word => {
            const start = Number(
              word.start ??
              word.time ??
              word.timestamp ??
              rawTime
            ) * scale;

            const end = Number(
              word.end ??
              word.endTime ??
              word.end_time ??
              start / scale
            ) * scale;

            return {
              text: normalizeText(word.text || word.word || ""),
              start,
              end,
              space: true
            };
          })
          .filter(word =>
            word.text &&
            Number.isFinite(word.start)
          )
      : [];

    lines.push({
      time,
      text,
      words
    });
  }

  lines.sort((a, b) => a.time - b.time);

  return lines;
}

function extractSyncedLyrics(data) {
  if (!data) return "";

  if (typeof data.syncedLyrics === "string") {
    return data.syncedLyrics;
  }

  if (typeof data.lrc === "string") {
    return data.lrc;
  }

  if (typeof data.timedLyrics === "string") {
    return data.timedLyrics;
  }

  if (typeof data.wordSyncedLyrics === "string") {
    return data.wordSyncedLyrics;
  }

  if (typeof data.enhancedLyrics === "string") {
    return data.enhancedLyrics;
  }

  const timedLines = normalizeTimedJSON(data);

  if (timedLines.length) {
    return buildEnhancedLRC(timedLines);
  }

  return "";
}

/* =========================================================
   PREPARAR RESULTADO
========================================================= */

export function prepareLyricsData(data) {
  if (!data || typeof data !== "object") {
    return null;
  }

  let syncedLyrics = extractSyncedLyrics(data);

  // El backend envía las palabras aparte: se incrustan en el LRC.
  if (
    syncedLyrics &&
    !INLINE_WORD_TAG_TEST.test(syncedLyrics) &&
    Array.isArray(data.wordTimings) &&
    data.wordTimings.length
  ) {
    syncedLyrics =
      enrichWithWordTimings(syncedLyrics, data.wordTimings) ||
      syncedLyrics;
  }

  const plainLyrics =
    data.plainLyrics ||
    data.plain ||
    (
      !syncedLyrics &&
      typeof data.text === "string"
        ? data.text
        : ""
    );

  const text =
    syncedLyrics ||
    plainLyrics ||
    data.text;

  if (
    typeof text !== "string" ||
    !text.trim()
  ) {
    return null;
  }

  // diagnostics y wordTimings no se conservan.
  const { diagnostics, wordTimings, ...rest } = data;

  return {
    ...rest,
    text,
    syncedLyrics,
    plainLyrics:
      typeof plainLyrics === "string"
        ? plainLyrics
        : "",
    source: data.source || data.provider || "Desconocida"
  };
}

/* =========================================================
   ESTADO DE LETRAS
========================================================= */

function resetLyrics() {
  parsedLines = [];
  lineElements = [];
  activeLineIndex = -1;
  activeWordIndex = -1;

  lastSyncTime = -1;
  lastScrollIndex = -1;

  currentMetadata = {};
  currentLyricsData = null;

  manualScrollUntil = 0;

  clearTimeout(scrollResumeTimer);
  scrollResumeTimer = null;
}

function cancelCurrentRequest() {
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }
}

/* =========================================================
   RENDERIZADO SEGURO (DOM, sin espacios sobrantes)
========================================================= */

function appendWordSpans(element, words) {
  words.forEach((word, index) => {
    const span = document.createElement("span");

    span.className = "lyric-word";
    span.dataset.wordIndex = String(index);
    span.dataset.start = String(Number(word.start) || 0);
    span.dataset.end = String(Number(word.end) || 0);
    span.textContent = word.text;

    element.appendChild(span);

    if (word.space !== false && index < words.length - 1) {
      element.appendChild(document.createTextNode(" "));
    }
  });
}

function renderSyncedLines(container) {
  const fragment = document.createDocumentFragment();
  const elements = [];

  parsedLines.forEach((line, index) => {
    const element = document.createElement("div");

    element.className = line.gap
      ? "lyric-line lyric-gap"
      : "lyric-line";

    element.dataset.index = String(index);
    element.dataset.time = String(line.time);

    if (line.gap) {
      element.setAttribute("aria-hidden", "true");
      element.textContent = " ";
    } else if (line.words?.length) {
      appendWordSpans(element, line.words);
    } else {
      element.textContent = line.text;
    }

    elements.push(element);
    fragment.appendChild(element);
  });

  container.replaceChildren(fragment);
  lineElements = elements;

  container.dataset.lyricsType =
    parsedLines.some(line => line.words?.length)
      ? "word"
      : "line";
}

function renderPlainText(container, text) {
  const rawLines = String(text || "")
    .replace(/\r/g, "")
    .split("\n")
    .map(line => line.trim());

  const fragment = document.createDocumentFragment();
  let previousBlank = true;
  let count = 0;

  for (const line of rawLines) {
    if (count >= CONFIG.MAX_LINES) break;

    if (!line) {
      // Un solo espacio entre estrofas.
      if (!previousBlank) {
        const gap = document.createElement("div");

        gap.className = "lyric-gap";
        gap.setAttribute("aria-hidden", "true");
        gap.textContent = " ";

        fragment.appendChild(gap);
        previousBlank = true;
      }

      continue;
    }

    const element = document.createElement("div");

    element.className = "lyric-line";
    element.textContent = line;

    fragment.appendChild(element);
    previousBlank = false;
    count++;
  }

  container.replaceChildren(fragment);
  container.dataset.lyricsType = "plain";
  lineElements = [];
}

/* =========================================================
   AUTO-SCROLL INTELIGENTE
========================================================= */

function recenterActiveLine() {
  if (activeLineIndex < 0) return;

  lastScrollIndex = -1;

  scrollActiveLine(
    lineElements[activeLineIndex],
    activeLineIndex
  );
}

function bindManualScrollDetection(container) {
  if (
    scrollListenersBound &&
    lyricsContainer === container
  ) {
    return;
  }

  lyricsContainer = container;
  scrollListenersBound = true;

  const markManualScroll = () => {
    manualScrollUntil =
      Date.now() + CONFIG.SCROLL_RESUME_DELAY;

    clearTimeout(scrollResumeTimer);

    scrollResumeTimer = setTimeout(() => {
      manualScrollUntil = 0;
      recenterActiveLine();
    }, CONFIG.SCROLL_RESUME_DELAY);
  };

  container.addEventListener(
    "wheel",
    markManualScroll,
    { passive: true }
  );

  container.addEventListener(
    "touchstart",
    markManualScroll,
    { passive: true }
  );

  container.addEventListener(
    "touchmove",
    markManualScroll,
    { passive: true }
  );

  container.addEventListener(
    "pointerdown",
    markManualScroll,
    { passive: true }
  );
}

function isAutoScrollEnabled() {
  return (
    window.ShunelLyricsStudio
      ?.getSettings?.()
      ?.autoScroll ?? true
  );
}

function shouldAutoScroll() {
  return (
    isAutoScrollEnabled() &&
    Date.now() >= manualScrollUntil
  );
}

function scrollContainerTo(container, top, behavior) {
  try {
    container.scrollTo({ top, behavior });
  } catch {
    container.scrollTop = top;
  }
}

function scrollActiveLine(element, index) {
  if (!element || index === lastScrollIndex) return;

  if (!shouldAutoScroll()) return;

  const container = getLyricsContainer();

  if (!container) return;

  const containerRect = container.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();

  // Distancia de la línea al centro visible; no depende de offsetParent.
  const offsetFromCenter =
    (elementRect.top + elementRect.height / 2) -
    (containerRect.top + containerRect.height / 2);

  const tolerance =
    containerRect.height *
    CONFIG.SCROLL_CENTER_TOLERANCE;

  // Evitar mover la vista si la línea ya está casi centrada.
  if (Math.abs(offsetFromCenter) < tolerance) return;

  lastScrollIndex = index;

  const behavior = isReducedMotion()
    ? "auto"
    : "smooth";

  const maxTop = Math.max(
    0,
    container.scrollHeight - container.clientHeight
  );

  const targetTop = clamp(
    container.scrollTop + offsetFromCenter,
    0,
    maxTop
  );

  scrollContainerTo(container, targetTop, behavior);
}

/* =========================================================
   MOSTRAR RESULTADO
========================================================= */

function displayLyrics(data, container, titleEl) {
  const prepared = prepareLyricsData(data);

  if (!prepared || !container) {
    return false;
  }

  resetLyrics();

  currentLyricsData = prepared;

  const syncedText = prepared.syncedLyrics;

  parsedLines = syncedText
    ? parseLRC(syncedText)
    : [];

  // Solo huecos, sin texto: no es una letra sincronizada.
  if (!parsedLines.some(line => line.text)) {
    parsedLines = [];
  }

  currentMetadata = syncedText
    ? parseLRCMetadata(syncedText)
    : {};

  if (parsedLines.length) {
    if (titleEl) {
      titleEl.textContent = parsedLines.some(
        line => line.words?.length
      )
        ? "Letra sincronizada por palabra"
        : "Letra sincronizada";
    }

    renderSyncedLines(container);
    bindManualScrollDetection(container);

    container.dataset.lyricsSynced = "true";
  } else {
    if (titleEl) {
      titleEl.textContent = "Letra";
    }

    renderPlainText(
      container,
      prepared.plainLyrics || prepared.text
    );

    container.dataset.lyricsSynced = "false";
  }

  bindLineSeeking(container);

  // La letra nueva siempre empieza arriba.
  container.scrollTop = 0;

  container.dataset.lyricsSource =
    prepared.source || "Desconocida";

  container.dataset.lyricsType =
    parsedLines.some(line => line.words?.length)
      ? "word"
      : parsedLines.length
        ? "line"
        : "plain";

  if (prepared.language) {
    container.dataset.lyricsLanguage =
      prepared.language;
  }

  window.ShunelLyricsStudio
    ?.refreshLyrics?.();

  return true;
}

/* =========================================================
   FETCH CON TIMEOUT Y REINTENTOS
========================================================= */

function parseRetryAfter(response) {
  const header = response.headers.get("Retry-After");

  if (!header) return 1000;

  const seconds = Number(header);

  if (Number.isFinite(seconds)) {
    return clamp(seconds * 1000, 500, 5000);
  }

  const date = Date.parse(header);

  if (Number.isFinite(date)) {
    return clamp(date - Date.now(), 500, 5000);
  }

  return 1000;
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }

    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function fetchLyricsWithRetry(url, signal) {
  let lastError = null;

  for (
    let attempt = 0;
    attempt <= CONFIG.MAX_RETRIES;
    attempt++
  ) {
    if (signal.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    const requestController = new AbortController();
    let timedOut = false;

    const timeoutId = setTimeout(() => {
      timedOut = true;
      requestController.abort();
    }, CONFIG.REQUEST_TIMEOUT);

    const abortHandler = () => {
      requestController.abort();
    };

    signal.addEventListener(
      "abort",
      abortHandler,
      { once: true }
    );

    try {
      const response = await fetch(url, {
        method: "GET",
        signal: requestController.signal,
        headers: {
          Accept: "application/json"
        },
        cache: "no-store"
      });

      // El 504 del backend ya agotó todo su tiempo: reintentar no ayuda.
      const retryable =
        response.status === 429 ||
        (response.status >= 500 && response.status !== 504);

      if (retryable && attempt < CONFIG.MAX_RETRIES) {
        clearTimeout(timeoutId);

        try {
          await response.body?.cancel();
        } catch {
          // Nada que cancelar.
        }

        const wait = response.status === 429
          ? parseRetryAfter(response)
          : 500 * (attempt + 1);

        await delay(wait, signal);
        continue;
      }

      return response;

    } catch (error) {
      if (signal.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      // Un timeout NO es una cancelación: se informa al usuario.
      if (timedOut) {
        throw new LyricsTimeoutError();
      }

      lastError = error;

      if (attempt >= CONFIG.MAX_RETRIES) break;

      await delay(
        400 * (attempt + 1),
        signal
      );

    } finally {
      clearTimeout(timeoutId);

      signal.removeEventListener(
        "abort",
        abortHandler
      );
    }
  }

  throw lastError ||
    new Error("No se pudo conectar con el servicio de letras.");
}

/* =========================================================
   CONSTRUIR CONSULTA
========================================================= */

function buildLyricsURL(track) {
  const params = new URLSearchParams();

  const { title, artist } = getTrackIdentity(track);
  const videoId = getTrackVideoId(track);
  const duration = getTrackDuration(track);

  params.set("title", title);

  if (artist) {
    params.set("artist", artist);
  }

  if (videoId) {
    params.set("videoId", videoId);
  }

  if (duration > 0) {
    params.set("duration", String(Math.round(duration)));
  }

  return `${CONFIG.API_URL}?${params.toString()}`;
}

/* =========================================================
   BÚSQUEDA PRINCIPAL
========================================================= */

export async function loadLyricsForTrack(track) {
  const container = getLyricsContainer();
  const subtitle = getLyricsSubtitle();
  const titleEl = getLyricsTitle();

  if (!container || !track) return;

  cancelCurrentRequest();

  const requestId = ++currentRequestId;

  currentAbortController = new AbortController();

  const signal = currentAbortController.signal;

  resetLyrics();

  const { title, artist } = getTrackIdentity(track);

  const cacheKey = getCacheKey(track);

  currentTrackKey = cacheKey;

  if (subtitle) {
    subtitle.textContent =
      artist
        ? `${artist} — ${title}`
        : title;
  }

  if (titleEl) {
    titleEl.textContent = "Buscando letra...";
  }

  container.dataset.lyricsSource = "";
  container.dataset.lyricsSynced = "false";
  container.dataset.lyricsType = "";

  setLyricsStatus(
    "Buscando letras en varias fuentes..."
  );

  // Caché primero.
  const cached = getCachedLyrics(cacheKey);

  if (cached) {
    if (
      requestId !== currentRequestId ||
      signal.aborted
    ) {
      return;
    }

    if (displayLyrics(cached, container, titleEl)) {
      if (titleEl) {
        titleEl.textContent += " · Caché";
      }

      return;
    }
  }

  try {
    const url = buildLyricsURL(track);

    const response = await fetchLyricsWithRetry(
      url,
      signal
    );

    if (
      signal.aborted ||
      requestId !== currentRequestId
    ) {
      return;
    }

    if (response.status === 404) {
      if (titleEl) {
        titleEl.textContent = "Sin letra";
      }

      setLyricsStatus(
        "No encontramos una letra disponible para esta canción."
      );

      return;
    }

    if (response.status === 504) {
      throw new LyricsTimeoutError();
    }

    if (!response.ok) {
      throw new Error(
        `Lyrics API: ${response.status}`
      );
    }

    const data = await response.json();

    if (
      signal.aborted ||
      requestId !== currentRequestId
    ) {
      return;
    }

    const prepared = prepareLyricsData(data);

    if (!prepared) {
      throw new Error(
        "El servicio devolvió una respuesta sin letras."
      );
    }

    setCachedLyrics(cacheKey, prepared);

    displayLyrics(
      prepared,
      container,
      titleEl
    );

  } catch (error) {
    // Solo se ignora una cancelación real (otra canción o clearLyrics).
    if (
      signal.aborted ||
      requestId !== currentRequestId
    ) {
      return;
    }

    console.error(
      "[Shunel Lyrics] Error:",
      error
    );

    const timedOut = error?.name === "TimeoutError";

    if (titleEl) {
      titleEl.textContent = timedOut
        ? "Tardó demasiado"
        : "Error al cargar";
    }

    setLyricsStatus(
      timedOut
        ? "La búsqueda de letras tardó demasiado. Intentá nuevamente."
        : "No se pudo cargar la letra. Intentá nuevamente."
    );
  }
}

/* =========================================================
   BÚSQUEDA BINARIA
   Encuentra la línea activa sin recorrer toda la letra.
========================================================= */

function findActiveLineIndex(time) {
  let low = 0;
  let high = parsedLines.length - 1;
  let result = -1;

  while (low <= high) {
    const middle = (low + high) >> 1;

    if (parsedLines[middle].time <= time) {
      result = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return result;
}

/* =========================================================
   SINCRONIZACIÓN POR PALABRA
========================================================= */

function findActiveWordIndex(words, time) {
  if (!Array.isArray(words) || !words.length) {
    return -1;
  }

  let low = 0;
  let high = words.length - 1;
  let result = -1;

  while (low <= high) {
    const middle = (low + high) >> 1;

    if (words[middle].start <= time) {
      result = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return result;
}

function clearWordClasses(lineElement) {
  if (!lineElement) return;

  lineElement
    .querySelectorAll(".lyric-word.active, .lyric-word.played")
    .forEach(element => {
      element.classList.remove("active", "played");
    });
}

function updateWordHighlight(lineElement, line, time) {
  if (!lineElement || !line?.words?.length) {
    return;
  }

  const newWordIndex = findActiveWordIndex(
    line.words,
    time
  );

  if (newWordIndex === activeWordIndex) {
    return;
  }

  activeWordIndex = newWordIndex;

  const wordElements =
    lineElement.querySelectorAll(".lyric-word");

  wordElements.forEach((element, index) => {
    element.classList.toggle(
      "active",
      index === newWordIndex
    );

    element.classList.toggle(
      "played",
      index < newWordIndex
    );
  });
}

/* =========================================================
   SINCRONIZACIÓN PRINCIPAL
========================================================= */

export function syncLyricsProgress(currentTime) {
  if (!parsedLines.length) return;

  const time = Number(currentTime);

  if (!Number.isFinite(time) || time < 0) {
    return;
  }

  // Los elementos se guardan al renderizar; solo se vuelven a buscar
  // si el DOM cambió por fuera.
  if (lineElements.length !== parsedLines.length) {
    const container = getLyricsContainer();

    if (!container) return;

    lineElements = [
      ...container.querySelectorAll(".lyric-line")
    ];

    if (lineElements.length !== parsedLines.length) return;
  }

  // Evitar trabajo repetido si el tiempo no cambió.
  if (time === lastSyncTime) return;

  // Retroceso real (seek), ignorando el ruido del reproductor.
  const movedBackwards =
    lastSyncTime >= 0 &&
    time < lastSyncTime - CONFIG.BACKWARD_JITTER;

  lastSyncTime = time;

  const newIndex = findActiveLineIndex(time);

  if (newIndex !== activeLineIndex || movedBackwards) {
    const previousElement =
      lineElements[activeLineIndex];

    if (previousElement) {
      previousElement.classList.remove("active");
      clearWordClasses(previousElement);
    }

    activeLineIndex = newIndex;
    activeWordIndex = -1;

    if (movedBackwards) {
      lastScrollIndex = -1;
    }

    const activeElement = lineElements[activeLineIndex];

    if (activeElement) {
      activeElement.classList.add("active");

      if (parsedLines[activeLineIndex]) {
        updateWordHighlight(
          activeElement,
          parsedLines[activeLineIndex],
          time
        );
      }

      scrollActiveLine(
        activeElement,
        activeLineIndex
      );
    }

    // Si se retrocede antes de la primera línea.
    if (activeLineIndex < 0) {
      lastScrollIndex = -1;
    }

    return;
  }

  // La línea no cambió, pero puede haber cambiado la palabra.
  if (activeLineIndex >= 0) {
    updateWordHighlight(
      lineElements[activeLineIndex],
      parsedLines[activeLineIndex],
      time
    );
  }
}

/* =========================================================
   SEEK MANUAL DESDE UNA LÍNEA
========================================================= */

function bindLineSeeking(container) {
  if (container.dataset.lineSeekingBound === "true") {
    return;
  }

  container.dataset.lineSeekingBound = "true";

  container.addEventListener("click", event => {
    const target = event.target;

    if (!(target instanceof Element)) return;

    const lineElement = target.closest(
      ".lyric-line[data-time]"
    );

    if (!lineElement) return;

    const time = Number(lineElement.dataset.time);

    if (!Number.isFinite(time)) return;

    // Tocar una línea para saltar no debe bloquear el auto-scroll.
    manualScrollUntil = 0;
    clearTimeout(scrollResumeTimer);
    scrollResumeTimer = null;
    lastScrollIndex = -1;

    // El player expone seekTo globalmente desde app.js.
    window.ShunelLyricsSeek?.(time);
  });
}

/* =========================================================
   API PÚBLICA
========================================================= */

export function clearLyrics() {
  cancelCurrentRequest();

  currentRequestId++;

  resetLyrics();

  currentTrackKey = "";

  const container = getLyricsContainer();
  const titleEl = getLyricsTitle();
  const subtitle = getLyricsSubtitle();

  if (container) {
    container.replaceChildren();

    container.dataset.lyricsSource = "";
    container.dataset.lyricsSynced = "false";
    container.dataset.lyricsType = "";
    container.dataset.lyricsLanguage = "";

    container.scrollTop = 0;
  }

  if (titleEl) {
    titleEl.textContent = "Sincronizada";
  }

  if (subtitle) {
    subtitle.textContent = "";
  }

  window.ShunelLyricsStudio
    ?.refreshLyrics?.();
}

/* =========================================================
   DIAGNÓSTICO PÚBLICO
========================================================= */

export function getLyricsDiagnostics() {
  return {
    version: "3.1",
    lineCount: parsedLines.length,
    activeLineIndex,
    activeWordIndex,
    synchronized: parsedLines.length > 0,
    wordSynchronized: parsedLines.some(
      line => line.words?.length > 0
    ),
    source: currentLyricsData?.source || null,
    metadata: { ...currentMetadata },
    cacheSize: lyricsCache.size,
    currentTrackKey
  };
}

/* =========================================================
   INICIALIZACIÓN
========================================================= */

function initializeLyricsEngine() {
  // Limpia las letras guardadas por versiones anteriores (rotas).
  purgeLegacyCache();

  const container = getLyricsContainer();

  if (!container) return;

  bindManualScrollDetection(container);
  bindLineSeeking(container);
}

if (document.readyState === "loading") {
  document.addEventListener(
    "DOMContentLoaded",
    initializeLyricsEngine,
    { once: true }
  );
} else {
  initializeLyricsEngine();
}
