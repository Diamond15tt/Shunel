
/* =========================================================
   SHUNEL — LYRICS ENGINE 3.0
   Multi-source integration
   Universal LRC / Enhanced LRC parser
   Word synchronization
   Smart cache / Retry / Abort
   Binary search / Smart scrolling
   Safari & iOS compatible
========================================================= */

const CONFIG = Object.freeze({
  API_URL: "/api/lyrics",

  CACHE_PREFIX: "shunel_lyrics_v3_",
  CACHE_TTL: 7 * 24 * 60 * 60 * 1000,
  CACHE_MAX_ITEMS: 60,

  REQUEST_TIMEOUT: 12000,
  MAX_RETRIES: 2,

  SCROLL_RESUME_DELAY: 4000,
  SCROLL_CENTER_TOLERANCE: 0.32,

  MAX_LYRICS_LENGTH: 250000,
  MAX_LINES: 12000
});

/* =========================================================
   ESTADO INTERNO
========================================================= */

let parsedLines = [];
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
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSearchText(value) {
  return normalizeText(value)
    .toLocaleLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanTrackTitle(title) {
  return String(title || "")
    .replace(/\([^)]*official[^)]*\)/gi, "")
    .replace(/\[[^\]]*official[^\]]*\]/gi, "")
    .replace(/\([^)]*video[^)]*\)/gi, "")
    .replace(/\[[^\]]*video[^\]]*\]/gi, "")
    .replace(/\([^)]*lyrics?[^)]*\)/gi, "")
    .replace(/\[[^\]]*lyrics?[^\]]*\]/gi, "")
    .replace(/\([^)]*letra[^)]*\)/gi, "")
    .replace(/\[[^\]]*letra[^\]]*\]/gi, "")
    .replace(/\([^)]*visualizer[^)]*\)/gi, "")
    .replace(/\[[^\]]*visualizer[^\]]*\]/gi, "")
    .replace(/\([^)]*audio[^)]*\)/gi, "")
    .replace(/\[[^\]]*audio[^\]]*\]/gi, "")
    .replace(/\s*[-–—]\s*topic$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function cleanArtistName(artist) {
  return normalizeText(artist)
    .replace(/\s*-\s*topic$/i, "")
    .replace(/\s*\(official\)$/i, "")
    .trim();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function isFiniteNumber(value) {
  return Number.isFinite(Number(value));
}

function getTrackDuration(track) {
  const value = Number(
    track?.durationSeconds ??
    track?.duration ??
    track?.length ??
    0
  );

  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  // Evitar convertir duraciones expresadas en segundos.
  return value > 100000 ? value / 1000 : value;
}

function getTrackArtist(track) {
  return cleanArtistName(
    track?.artist ||
    track?.channelTitle ||
    track?.channel ||
    track?.author ||
    ""
  );
}

function getTrackTitle(track) {
  return cleanTrackTitle(
    track?.title ||
    track?.name ||
    ""
  );
}

function getCacheKey(track) {
  const title = normalizeSearchText(getTrackTitle(track));
  const artist = normalizeSearchText(getTrackArtist(track));

  // No depender del videoId: dos videos pueden ser la misma canción.
  return `${artist}|${title}`;
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

function readPersistentCache(key) {
  try {
    const raw = localStorage.getItem(
      CONFIG.CACHE_PREFIX + key
    );

    if (!raw) return null;

    const entry = JSON.parse(raw);

    if (
      !entry ||
      !entry.timestamp ||
      Date.now() - entry.timestamp > CONFIG.CACHE_TTL ||
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
    localStorage.setItem(
      CONFIG.CACHE_PREFIX + key,
      JSON.stringify({
        timestamp: Date.now(),
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

    if (
      Date.now() - entry.timestamp <=
      CONFIG.CACHE_TTL
    ) {
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

  lyricsCache.delete(key);

  lyricsCache.set(key, {
    timestamp: Date.now(),
    data
  });

  while (lyricsCache.size > CONFIG.CACHE_MAX_ITEMS) {
    const oldestKey = lyricsCache.keys().next().value;
    lyricsCache.delete(oldestKey);
  }

  if (persist) {
    writePersistentCache(key, data);
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

function parseTimeTag(tag) {
  const match = String(tag).match(
    /[<[](\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?[>\]]/
  );

  if (!match) return null;

  return parseTimestamp(
    match[1],
    match[2],
    match[3] || "0"
  );
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
      /^\[offset:([+-]?\d+)\]$/i
    );

    if (offsetMatch) {
      metadata.offset = Number(offsetMatch[1]) / 1000;
    }
  }

  return metadata;
}

/* =========================================================
   ENHANCED LRC
   Soporta timestamps por línea y por palabra.
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
  let cursor = 0;

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

    const wordText = rawText
      .slice(match.index + match[0].length, end)
      .replace(/<[^>]*>/g, "")
      .trim();

    if (!wordText) continue;

    const startTime = Math.max(
      0,
      timestamp + offset
    );

    words.push({
      text: wordText,
      start: startTime,
      end: null
    });

    cursor = end;
  }

  for (let i = 0; i < words.length; i++) {
    words[i].end =
      words[i + 1]?.start ?? null;
  }

  const text = words
    .map(word => word.text)
    .join(" ")
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
    const matches = [
      ...rawLine.matchAll(LINE_TIME_TAG)
    ];

    if (!matches.length) continue;

    const lyricText = rawLine
      .replace(LINE_TIME_TAG, "")
      .trim();

    if (!lyricText) continue;

    const wordData = parseEnhancedLine(
      lyricText,
      0,
      metadata.offset
    );

    for (const match of matches) {
      const timestamp = parseTimestamp(
        match[1],
        match[2],
        match[3] || "0"
      );

      if (timestamp === null) continue;

      const time = Math.max(
        0,
        timestamp + metadata.offset
      );

      result.push({
        time,
        text: wordData.text || lyricText,
        words: wordData.words.map(word => ({
          ...word
        }))
      });
    }
  }

  result.sort((a, b) => a.time - b.time);

  // Quitar duplicados exactos.
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
   NORMALIZACIÓN DE RESPUESTAS JSON
   Permite integrar proveedores con estructuras diferentes.
========================================================= */

function normalizeTimedJSON(data) {
  if (!data || typeof data !== "object") {
    return [];
  }

  const sourceLines =
    data.lines ||
    data.lyrics ||
    data.syncedLines ||
    data.words ||
    [];

  if (!Array.isArray(sourceLines)) return [];

  const lines = [];

  for (const item of sourceLines) {
    if (!item || typeof item !== "object") continue;

    const rawTime =
      item.start ??
      item.time ??
      item.timestamp ??
      item.startTime ??
      item.start_time;

    if (!isFiniteNumber(rawTime)) continue;

    let time = Number(rawTime);

    // Convención: valores muy grandes suelen venir en ms.
    if (time > 100000) {
      time /= 1000;
    }

    const text = normalizeText(
      item.text ??
      item.words ??
      item.lyric ??
      item.content ??
      ""
    );

    if (!text) continue;

    const words = Array.isArray(item.words)
      ? item.words
          .filter(word => word && typeof word === "object")
          .map(word => {
            let start = Number(
              word.start ??
              word.time ??
              word.timestamp ??
              time
            );

            let end = Number(
              word.end ??
              word.endTime ??
              word.end_time ??
              start
            );

            if (start > 100000) start /= 1000;
            if (end > 100000) end /= 1000;

            return {
              text: normalizeText(word.text || word.word || ""),
              start,
              end
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

function linesToLRC(lines) {
  return lines
    .map(line => {
      const minutes = Math.floor(line.time / 60);
      const seconds = line.time % 60;

      const stamp =
        `[${String(minutes).padStart(2, "0")}:` +
        `${seconds.toFixed(3).padStart(6, "0")}]`;

      return stamp + line.text;
    })
    .join("\n");
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
    return linesToLRC(timedLines);
  }

  return "";
}

/* =========================================================
   PREPARAR RESULTADO
========================================================= */

function prepareLyricsData(data) {
  if (!data || typeof data !== "object") {
    return null;
  }

  const syncedLyrics = extractSyncedLyrics(data);

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
    data.text ||
    syncedLyrics ||
    plainLyrics;

  if (
    typeof text !== "string" ||
    !text.trim()
  ) {
    return null;
  }

  return {
    ...data,
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
   RENDERIZADO SEGURO
========================================================= */

function renderWordMarkup(words) {
  if (!Array.isArray(words) || !words.length) {
    return "";
  }

  return words
    .map((word, index) => `
      <span
        class="lyric-word"
        data-word-index="${index}"
        data-start="${Number(word.start) || 0}"
        data-end="${Number(word.end) || 0}"
      >${escapeHTML(word.text)}</span>
    `)
    .join(" ");
}

function renderSyncedLines(container) {
  const fragment = document.createDocumentFragment();

  parsedLines.forEach((line, index) => {
    const element = document.createElement("div");

    element.className = "lyric-line";
    element.dataset.index = String(index);
    element.dataset.time = String(line.time);

    if (line.words?.length) {
      element.innerHTML = renderWordMarkup(line.words);
    } else {
      element.textContent = line.text;
    }

    fragment.appendChild(element);
  });

  container.replaceChildren(fragment);

  container.dataset.lyricsType =
    parsedLines.some(line => line.words?.length)
      ? "word"
      : "line";
}

function renderPlainText(container, text) {
  const lines = String(text || "")
    .replace(/\r/g, "")
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, CONFIG.MAX_LINES);

  const fragment = document.createDocumentFragment();

  lines.forEach(line => {
    const element = document.createElement("div");

    element.className = "lyric-line";
    element.textContent = line;

    fragment.appendChild(element);
  });

  container.replaceChildren(fragment);
  container.dataset.lyricsType = "plain";
}

/* =========================================================
   AUTO-SCROLL INTELIGENTE
========================================================= */

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

function scrollActiveLine(element, index) {
  if (!element || index === lastScrollIndex) return;

  if (!shouldAutoScroll()) return;

  const container = getLyricsContainer();

  if (!container) return;

  const containerRect = container.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();

  const center = containerRect.top +
    containerRect.height / 2;

  const distance = Math.abs(
    elementRect.top +
    elementRect.height / 2 -
    center
  );

  const tolerance =
    containerRect.height *
    CONFIG.SCROLL_CENTER_TOLERANCE;

  // Evitar mover la vista si la línea ya está cerca del centro.
  if (distance < tolerance) return;

  lastScrollIndex = index;

  const behavior = isReducedMotion()
    ? "auto"
    : "smooth";

  const targetTop =
    element.offsetTop -
    container.clientHeight / 2 +
    element.offsetHeight / 2;

  container.scrollTo({
    top: Math.max(0, targetTop),
    behavior
  });
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

    const timer = setTimeout(resolve, ms);

    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true }
    );
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

    const timeoutController = new AbortController();

    const timeoutId = setTimeout(
      () => timeoutController.abort(),
      CONFIG.REQUEST_TIMEOUT
    );

    const abortHandler = () => {
      timeoutController.abort();
    };

    signal.addEventListener(
      "abort",
      abortHandler,
      { once: true }
    );

    try {
      const response = await fetch(url, {
        method: "GET",
        signal: timeoutController.signal,
        headers: {
          Accept: "application/json"
        },
        cache: "no-store"
      });

      if (
        response.status === 429 ||
        response.status >= 500
      ) {
        if (attempt < CONFIG.MAX_RETRIES) {
          const wait = response.status === 429
            ? parseRetryAfter(response)
            : 500 * (attempt + 1);

          await delay(wait, signal);
          continue;
        }
      }

      return response;

    } catch (error) {
      lastError = error;

      if (signal.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      if (attempt < CONFIG.MAX_RETRIES) {
        await delay(
          400 * (attempt + 1),
          signal
        );

        continue;
      }

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

  const title = getTrackTitle(track);
  const artist = getTrackArtist(track);

  const videoId =
    track.videoId ||
    track.id ||
    "";

  const duration = getTrackDuration(track);

  params.set("title", title);

  if (artist) {
    params.set("artist", artist);
  }

  if (videoId) {
    params.set("videoId", videoId);
  }

  if (duration > 0) {
    params.set("duration", String(duration));
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

  const title = getTrackTitle(track);
  const artist = getTrackArtist(track);

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
    if (
      error?.name === "AbortError" ||
      signal.aborted ||
      requestId !== currentRequestId
    ) {
      return;
    }

    console.error(
      "[Shunel Lyrics] Error:",
      error
    );

    if (titleEl) {
      titleEl.textContent = "Error al cargar";
    }

    setLyricsStatus(
      "No se pudo cargar la letra. Intentá nuevamente."
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
    const word = words[middle];

    if (word.start <= time) {
      result = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  if (result < 0) return -1;

  const activeWord = words[result];

  if (
    Number.isFinite(activeWord.end) &&
    time > activeWord.end
  ) {
    return result;
  }

  return result;
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

  const container = getLyricsContainer();

  if (!container) return;

  // Evitar trabajo repetido si el tiempo no cambió.
  if (time === lastSyncTime) return;

  // Detectar retroceso o seek.
  const movedBackwards =
    lastSyncTime >= 0 &&
    time < lastSyncTime;

  lastSyncTime = time;

  const newIndex = findActiveLineIndex(time);

  const lines = container.querySelectorAll(".lyric-line");

  if (newIndex !== activeLineIndex || movedBackwards) {
    const previousElement =
      lines[activeLineIndex];

    previousElement?.classList.remove("active");

    activeLineIndex = newIndex;
    activeWordIndex = -1;

    const activeElement = lines[activeLineIndex];

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
    const activeElement = lines[activeLineIndex];
    const activeLine = parsedLines[activeLineIndex];

    updateWordHighlight(
      activeElement,
      activeLine,
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
    version: "3.0",
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
