
/* =========================================
   SHUNEL — LYRICS API 3.0
   Multi-source lyrics engine

   Providers:
   - LRCLIB
   - LiriQo
   - LRCMux
   - Better Lyrics (KuGou / QQ)
   - Lyrics.ovh
   - YouTube Captions

   Features:
   - Smart provider ranking
   - Synced lyrics priority
   - Enhanced LRC preservation
   - Word timing metadata when available
   - Timestamp normalization
   - YouTube caption timing extraction
   - Better title / artist matching
   - Request timeouts and cancellation
   - Response validation
   - Provider diagnostics
========================================= */

const LIRIQO_URL = "https://api.liriqo-alfarrizi.my.id/v1";
const BETTER_URL = "https://api.betterlyrics.org";
const LRCMUX_URL = "https://api.lrcmux.dev";
const LRCLIB_URL = "https://lrclib.net/api";

const USER_AGENT = "Shunel/3.0 (https://shunel.vercel.app)";

const MAX_TITLE_LENGTH = 250;
const MAX_ARTIST_LENGTH = 180;
const MAX_VIDEO_ID_LENGTH = 30;
const MAX_LYRICS_LENGTH = 250000;
const MAX_LYRIC_LINES = 12000;

const DEFAULT_TIMEOUT = 8000;
const LIRIQO_TIMEOUT = 14000;
const YOUTUBE_TIMEOUT = 9000;

const PROVIDER_NAMES = [
  "LRCLIB",
  "LiriQo",
  "LRCMux",
  "Better Lyrics",
  "Lyrics.ovh",
  "YouTube"
];

/* =========================================
   01. GENERAL UTILITIES
========================================= */

function clean(value, maxLength = 500) {
  return String(value || "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeText(value) {
  return clean(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(feat|ft|featuring)\b.*$/i, "")
    .replace(/\b(official|video|lyrics?|letra|audio|visualizer)\b/gi, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => {
      const number = Number(code);

      try {
        return String.fromCodePoint(number);
      } catch {
        return "";
      }
    })
    .replace(/&#x([a-f0-9]+);/gi, (_, code) => {
      const number = parseInt(code, 16);

      try {
        return String.fromCodePoint(number);
      } catch {
        return "";
      }
    });
}

function isValidVideoId(value) {
  return /^[a-zA-Z0-9_-]{11}$/.test(value || "");
}

function isValidDuration(value) {
  return Number.isFinite(value) &&
    value > 0 &&
    value < 86400;
}

function validLyrics(text) {
  if (typeof text !== "string") return false;

  const value = text.trim();

  if (
    value.length < 20 ||
    value.length > MAX_LYRICS_LENGTH
  ) {
    return false;
  }

  if (
    /^(lyrics not found|not found|no lyrics|error|undefined|null)$/i.test(value)
  ) {
    return false;
  }

  const normalized = value
    .replace(/\[[^\]]+\]/g, "")
    .replace(/<[^>]+>/g, "")
    .trim();

  return normalized.length >= 15;
}

function safeJson(response) {
  return response.json().catch(() => null);
}

/* =========================================
   02. TIMESTAMP UTILITIES
========================================= */

function normalizeTimestamp(value, duration = 0) {
  const raw = Number(value);

  if (!Number.isFinite(raw) || raw < 0) {
    return null;
  }

  /*
    Los servicios pueden devolver segundos o milisegundos.

    Se usa la duración como referencia cuando existe.
    Esto también corrige el caso exacto de 1000 ms.
  */

  if (
    duration > 0 &&
    raw > duration * 1.5
  ) {
    return raw / 1000;
  }

  if (raw >= 1000) {
    return raw / 1000;
  }

  return raw;
}

function formatLrcTime(seconds) {
  const safeSeconds = Math.max(0, Number(seconds) || 0);

  const totalCentiseconds = Math.round(safeSeconds * 100);

  const minutes = Math.floor(totalCentiseconds / 6000);
  const remaining = totalCentiseconds % 6000;

  const wholeSeconds = Math.floor(remaining / 100);
  const centiseconds = remaining % 100;

  return (
    "[" +
    String(minutes).padStart(2, "0") +
    ":" +
    String(wholeSeconds).padStart(2, "0") +
    "." +
    String(centiseconds).padStart(2, "0") +
    "]"
  );
}

function parseLrcTimestamp(value) {
  const match = String(value || "").match(
    /^(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?$/
  );

  if (!match) return null;

  const minutes = Number(match[1]);
  const seconds = Number(match[2]);

  const fraction = Number(
    String(match[3] || "0").padEnd(3, "0")
  );

  if (seconds >= 60) return null;

  return minutes * 60 + seconds + fraction / 1000;
}

/* =========================================
   03. LRC VALIDATION
========================================= */

function inspectLRC(text) {
  if (!validLyrics(text)) {
    return {
      valid: false,
      lineCount: 0,
      timedLineCount: 0,
      ratio: 0
    };
  }

  const lines = text.split(/\r?\n/);

  let timedLineCount = 0;
  let contentLineCount = 0;

  const timestampRegex =
    /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) continue;

    if (
      /^\[(ar|ti|al|by|re|ve|offset|length|kana|la|tool):/i.test(trimmed)
    ) {
      continue;
    }

    contentLineCount++;

    if (timestampRegex.test(trimmed)) {
      timedLineCount++;
    }

    timestampRegex.lastIndex = 0;
  }

  const ratio = contentLineCount
    ? timedLineCount / contentLineCount
    : 0;

  return {
    valid: contentLineCount > 0,
    lineCount: contentLineCount,
    timedLineCount,
    ratio
  };
}

/* =========================================
   04. LYRICS RESULT
========================================= */

function result(
  lyrics,
  source,
  synced = false,
  metadata = {}
) {
  if (!validLyrics(lyrics)) return null;

  const text = lyrics.trim();
  const lrcInfo = inspectLRC(text);

  const hasTimestamps =
    synced &&
    lrcInfo.valid &&
    lrcInfo.timedLineCount > 0;

  return {
    text,

    source,

    synced: Boolean(hasTimestamps),

    syncedLyrics: hasTimestamps ? text : "",

    plainLyrics: hasTimestamps
      ? ""
      : text,

    syncLevel: metadata.syncLevel ||
      (hasTimestamps ? "line" : "plain"),

    wordTimings: Array.isArray(metadata.wordTimings)
      ? metadata.wordTimings
      : [],

    language: metadata.language || null,

    duration: Number.isFinite(metadata.duration)
      ? metadata.duration
      : null,

    metadata: {
      lineCount: lrcInfo.lineCount,
      timedLineCount: lrcInfo.timedLineCount,
      timingRatio: lrcInfo.ratio,
      provider: source
    }
  };
}

/* =========================================
   05. SMART MATCHING
========================================= */

function similarityScore(target, candidate) {
  if (!target || !candidate) return 0;

  if (target === candidate) return 1;

  if (
    candidate.includes(target) ||
    target.includes(candidate)
  ) {
    return 0.82;
  }

  const targetWords = new Set(target.split(" "));
  const candidateWords = new Set(candidate.split(" "));

  const intersection = [...targetWords].filter(
    word => candidateWords.has(word)
  ).length;

  const union = new Set([
    ...targetWords,
    ...candidateWords
  ]).size;

  return union ? intersection / union : 0;
}

function calculateMatchScore({
  title,
  artist,
  duration,
  candidateTitle,
  candidateArtist,
  candidateDuration
}) {
  const targetTitle = normalizeText(title);
  const targetArtist = normalizeText(artist);

  const foundTitle = normalizeText(candidateTitle);
  const foundArtist = normalizeText(candidateArtist);

  const titleScore = similarityScore(
    targetTitle,
    foundTitle
  );

  const artistScore = targetArtist
    ? similarityScore(targetArtist, foundArtist)
    : 0.5;

  let score =
    titleScore * 65 +
    artistScore * 25;

  if (
    duration > 0 &&
    Number(candidateDuration) > 0
  ) {
    const difference = Math.abs(
      duration - Number(candidateDuration)
    );

    const ratio = difference / duration;

    if (ratio <= 0.02) score += 10;
    else if (ratio <= 0.05) score += 7;
    else if (ratio <= 0.10) score += 4;
    else if (ratio > 0.25) score -= 12;
  }

  return Math.round(score);
}

/* =========================================
   06. REQUEST ENGINE
========================================= */

async function request(
  url,
  options = {},
  timeout = DEFAULT_TIMEOUT
) {
  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    timeout
  );

  let externalAbortHandler = null;

  try {
    if (options.signal) {
      if (options.signal.aborted) {
        controller.abort();
      } else {
        externalAbortHandler = () => controller.abort();

        options.signal.addEventListener(
          "abort",
          externalAbortHandler,
          { once: true }
        );
      }
    }

    const headers = {
      "User-Agent": USER_AGENT,
      Accept: "application/json, text/plain, */*",
      ...(options.headers || {})
    };

    const response = await fetch(url, {
      ...options,
      headers,
      signal: controller.signal
    });

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        response: null
      };
    }

    return {
      ok: true,
      status: response.status,
      response
    };

  } catch (error) {
    return {
      ok: false,
      status: 0,
      response: null,
      error
    };

  } finally {
    clearTimeout(timer);

    if (options.signal && externalAbortHandler) {
      options.signal.removeEventListener(
        "abort",
        externalAbortHandler
      );
    }
  }
}

/* =========================================
   07. TIMED ENTRIES
========================================= */

function normalizeTimedEntries(entries, duration = 0) {
  if (!Array.isArray(entries)) return [];

  return entries
    .slice(0, MAX_LYRIC_LINES)
    .map(item => {
      if (!item || typeof item.text !== "string") {
        return null;
      }

      const rawStart =
        item.start ??
        item.time ??
        item.timestamp ??
        item.offset;

      const start = normalizeTimestamp(
        rawStart,
        duration
      );

      const text = decodeEntities(
        item.text
      ).trim();

      if (
        start === null ||
        !text ||
        text.length > 1000
      ) {
        return null;
      }

      return {
        time: start,
        text
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.time - b.time);
}

function makeLrc(entries, duration = 0) {
  const normalized = normalizeTimedEntries(
    entries,
    duration
  );

  if (!normalized.length) return "";

  return normalized
    .map(line =>
      formatLrcTime(line.time) + line.text
    )
    .join("\n");
}

function createWordTimings(entries, duration = 0) {
  const normalized = normalizeTimedEntries(
    entries,
    duration
  );

  if (!normalized.length) return [];

  return normalized.map(item => ({
    time: item.time,
    text: item.text
  }));
}

/* =========================================
   08. 1. LRCLIB
========================================= */

async function searchLRCLIB(
  title,
  artist,
  duration
) {
  const url = new URL(`${LRCLIB_URL}/search`);

  url.searchParams.set("track_name", title);

  if (artist) {
    url.searchParams.set("artist_name", artist);
  }

  if (duration > 0) {
    url.searchParams.set(
      "duration",
      String(Math.round(duration))
    );
  }

  const requestResult = await request(
    url.toString(),
    {
      headers: {
        "Lrclib-Client": "Shunel/3.0 (https://shunel.vercel.app)"
      }
    },
    DEFAULT_TIMEOUT
  );

  if (!requestResult.ok) return null;

  const data = await safeJson(
    requestResult.response
  );

  if (!Array.isArray(data)) return null;

  const candidates = data
    .filter(item =>
      validLyrics(item.syncedLyrics) ||
      validLyrics(item.plainLyrics)
    )
    .map(item => {
      const score = calculateMatchScore({
        title,
        artist,
        duration,
        candidateTitle: item.trackName,
        candidateArtist: item.artistName,
        candidateDuration: item.duration
      });

      const hasSynced = validLyrics(
        item.syncedLyrics
      );

      return {
        item,
        score: score + (hasSynced ? 12 : 0),
        hasSynced
      };
    })
    .sort((a, b) => b.score - a.score);

  if (!candidates.length) return null;

  const best = candidates[0];

  if (best.score < 45) return null;

  if (best.hasSynced) {
    return result(
      best.item.syncedLyrics,
      "LRCLIB",
      true,
      {
        syncLevel: "line",
        duration: Number(best.item.duration) || null
      }
    );
  }

  return result(
    best.item.plainLyrics,
    "LRCLIB",
    false
  );
}

/* =========================================
   09. 2. LIRIQO
========================================= */

async function searchLiriQo(
  title,
  artist,
  duration,
  videoId
) {
  const url = new URL(`${LIRIQO_URL}/lyrics`);

  if (videoId) {
    url.searchParams.set("v", videoId);
  } else {
    url.searchParams.set("title", title);

    if (artist) {
      url.searchParams.set("artist", artist);
    }
  }

  if (duration > 0) {
    url.searchParams.set(
      "duration",
      String(Math.round(duration))
    );
  }

  url.searchParams.set("full", "1");

  const requestResult = await request(
    url.toString(),
    {},
    LIRIQO_TIMEOUT
  );

  if (!requestResult.ok) return null;

  const data = await safeJson(
    requestResult.response
  );

  if (!data || data.error) return null;

  const candidates = [
    ...(data.primary ? [data.primary] : []),
    ...(Array.isArray(data.tracks) ? data.tracks : [])
  ];

  const unique = [];
  const seen = new Set();

  for (const item of candidates) {
    if (!item || typeof item !== "object") continue;

    const key = [
      item.provider,
      item.upstreamProvider,
      item.syncLevel,
      item.lrc,
      item.plain
    ].join("|");

    if (seen.has(key)) continue;

    seen.add(key);
    unique.push(item);
  }

  const rank = {
    syllable: 6,
    word: 5,
    character: 5,
    line: 4,
    plain: 1
  };

  unique.sort((a, b) =>
    (rank[String(b.syncLevel).toLowerCase()] || 0) -
    (rank[String(a.syncLevel).toLowerCase()] || 0)
  );

  for (const item of unique) {
    const timed = Array.isArray(item.timed)
      ? item.timed
      : [];

    const lrc = makeLrc(timed, duration);

    if (validLyrics(lrc)) {
      const wordTimings = createWordTimings(
        timed,
        duration
      );

      return result(
        lrc,
        `LiriQo · ${item.upstreamProvider || item.provider || "Proveedor"}`,
        true,
        {
          syncLevel: rank[String(item.syncLevel).toLowerCase()]
            ? String(item.syncLevel).toLowerCase()
            : "line",
          wordTimings,
          duration
        }
      );
    }

    if (validLyrics(item.lrc)) {
      const lrcInfo = inspectLRC(item.lrc);

      if (lrcInfo.timedLineCount > 0) {
        return result(
          item.lrc,
          `LiriQo · ${item.upstreamProvider || item.provider || "Proveedor"}`,
          true,
          {
            syncLevel: String(item.syncLevel || "line").toLowerCase(),
            duration
          }
        );
      }
    }
  }

  for (const item of unique) {
    if (validLyrics(item.plain)) {
      return result(
        item.plain,
        `LiriQo · ${item.upstreamProvider || item.provider || "Proveedor"}`,
        false
      );
    }
  }

  return null;
}

/* =========================================
   10. 3. LRCMUX
========================================= */

async function searchLRCMux(
  title,
  artist,
  duration
) {
  const url = new URL(`${LRCMUX_URL}/get`);

  url.searchParams.set("title", title);
  url.searchParams.set("artist", artist);
  url.searchParams.set("level", "word");
  url.searchParams.set("format", "json");

  if (duration > 0) {
    url.searchParams.set(
      "duration",
      String(Math.round(duration))
    );
  }

  const requestResult = await request(
    url.toString(),
    {},
    9000
  );

  if (!requestResult.ok) return null;

  const data = await safeJson(
    requestResult.response
  );

  if (!data) return null;

  if (Array.isArray(data.lines)) {
    const lrc = makeLrc(
      data.lines,
      duration
    );

    if (validLyrics(lrc)) {
      const wordTimings = createWordTimings(
        data.lines,
        duration
      );

      return result(
        lrc,
        `LRCMux · ${data.meta?.source?.name || "Proveedor"}`,
        true,
        {
          syncLevel: "word",
          wordTimings,
          duration
        }
      );
    }

    const plain = data.lines
      .map(line => decodeEntities(line?.text || ""))
      .filter(Boolean)
      .join("\n");

    if (validLyrics(plain)) {
      return result(
        plain,
        `LRCMux · ${data.meta?.source?.name || "Proveedor"}`,
        false
      );
    }
  }

  return null;
}

/* =========================================
   11. 4. BETTER LYRICS
========================================= */

async function searchBetterLyrics(
  title,
  artist,
  duration
) {
  const providers = ["kugou", "qq"];

  for (const provider of providers) {
    const url = new URL(
      `${BETTER_URL}/${provider}/getLyrics`
    );

    url.searchParams.set("s", title);
    url.searchParams.set("a", artist);
    url.searchParams.set("al", "");
    url.searchParams.set(
      "d",
      String(Math.round(duration || 0))
    );

    const requestResult = await request(
      url.toString(),
      {},
      7000
    );

    if (!requestResult.ok) continue;

    const data = await safeJson(
      requestResult.response
    );

    if (!data || !validLyrics(data.lyrics)) {
      continue;
    }

    const lyrics = decodeEntities(data.lyrics);

    if (
      provider === "kugou" &&
      inspectLRC(lyrics).timedLineCount > 0
    ) {
      return result(
        lyrics,
        "Better Lyrics · KuGou",
        true,
        {
          syncLevel: "line",
          duration
        }
      );
    }

    /*
      QQ puede devolver QRC u otros formatos.
      Se conserva como texto normal cuando no se
      puede verificar una conversión segura.
    */

    const plain = decodeEntities(
      lyrics
        .replace(/<[^>]*>/g, "\n")
        .replace(/\(\d+,\d+\)/g, "")
        .replace(/\[\d+,\d+\]/g, "")
    );

    if (validLyrics(plain)) {
      return result(
        plain,
        `Better Lyrics · ${provider === "qq" ? "QQ Music" : "KuGou"}`,
        false
      );
    }
  }

  return null;
}

/* =========================================
   12. 5. LYRICS.OVH
========================================= */

async function searchLyricsOVH(
  title,
  artist
) {
  if (!artist || !title) return null;

  const url =
    "https://api.lyrics.ovh/v1/" +
    encodeURIComponent(artist) +
    "/" +
    encodeURIComponent(title);

  const requestResult = await request(
    url,
    {},
    DEFAULT_TIMEOUT
  );

  if (!requestResult.ok) return null;

  const data = await safeJson(
    requestResult.response
  );

  if (!data || !validLyrics(data.lyrics)) {
    return null;
  }

  return result(
    data.lyrics,
    "Lyrics.ovh",
    false
  );
}

/* =========================================
   13. YOUTUBE CAPTIONS
========================================= */

function extractArrayAfter(html, marker) {
  const markerIndex = html.indexOf(marker);

  if (markerIndex === -1) return null;

  const start = html.indexOf("[", markerIndex);

  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < html.length; i++) {
    const char = html[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }

      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "[") {
      depth++;
    } else if (char === "]") {
      depth--;

      if (depth === 0) {
        return html.slice(start, i + 1);
      }
    }
  }

  return null;
}

function extractYouTubeCaptionLines(xml, duration = 0) {
  if (typeof xml !== "string") return [];

  const entries = [];

  /*
    YouTube suele entregar subtítulos XML con:
    start="12.34"
    dur="2.10"

    Se conservan los tiempos originales.
  */

  const regex = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;

  let match;

  while (
    (match = regex.exec(xml)) &&
    entries.length < MAX_LYRIC_LINES
  ) {
    const attributes = match[1] || "";
    const content = match[2] || "";

    const startMatch = attributes.match(
      /\bstart=["']([\d.]+)["']/i
    );

    const durationMatch = attributes.match(
      /\bdur=["']([\d.]+)["']/i
    );

    if (!startMatch) continue;

    const start = Number(startMatch[1]);
    const segmentDuration = Number(
      durationMatch?.[1] || 0
    );

    const text = decodeEntities(
      content
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
    ).trim();

    if (
      !Number.isFinite(start) ||
      start < 0 ||
      !text
    ) {
      continue;
    }

    if (
      duration > 0 &&
      start > duration + 30
    ) {
      continue;
    }

    entries.push({
      time: start,
      duration: segmentDuration,
      text
    });
  }

  return entries.sort(
    (a, b) => a.time - b.time
  );
}

async function searchYouTube(videoId) {
  if (!isValidVideoId(videoId)) return null;

  const watchResult = await request(
    `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
    {
      headers: {
        "Accept-Language": "es,en;q=0.9"
      }
    },
    YOUTUBE_TIMEOUT
  );

  if (!watchResult.ok) return null;

  const html = await watchResult.response.text();

  const rawTracks = extractArrayAfter(
    html,
    '"captionTracks":'
  );

  if (!rawTracks) return null;

  let tracks;

  try {
    tracks = JSON.parse(rawTracks);
  } catch {
    return null;
  }

  if (!Array.isArray(tracks) || !tracks.length) {
    return null;
  }

  const preferred =
    tracks.find(track =>
      /^es(-|$)/i.test(track.languageCode || "")
    ) ||
    tracks.find(track =>
      /^en(-|$)/i.test(track.languageCode || "")
    ) ||
    tracks[0];

  if (!preferred?.baseUrl) return null;

  const subtitleResult = await request(
    preferred.baseUrl,
    {},
    YOUTUBE_TIMEOUT
  );

  if (!subtitleResult.ok) return null;

  const xml = await subtitleResult.response.text();

  const entries = extractYouTubeCaptionLines(xml);

  if (!entries.length) return null;

  const lrc = entries
    .map(line =>
      formatLrcTime(line.time) + line.text
    )
    .join("\n");

  if (!validLyrics(lrc)) return null;

  return result(
    lrc,
    "YouTube Subtitles",
    true,
    {
      syncLevel: "line",
      language: preferred.languageCode || null,
      wordTimings: [],
      duration: null
    }
  );
}

/* =========================================
   14. PROVIDER QUALITY
========================================= */

function getResultQuality(item) {
  if (!item) return 0;

  let score = 0;

  if (item.synced) score += 50;

  const syncLevel = String(
    item.syncLevel || "plain"
  ).toLowerCase();

  const syncScores = {
    syllable: 30,
    word: 25,
    character: 25,
    line: 10,
    plain: 0
  };

  score += syncScores[syncLevel] || 0;

  if (item.wordTimings?.length) {
    score += 15;
  }

  const metadata = item.metadata || {};

  if (metadata.timingRatio >= 0.8) {
    score += 8;
  } else if (metadata.timingRatio >= 0.5) {
    score += 4;
  }

  if (metadata.lineCount >= 5) {
    score += 3;
  }

  if (item.language === "es") {
    score += 2;
  }

  return score;
}

function selectBestResult(results) {
  const valid = results
    .filter(Boolean)
    .filter(item => validLyrics(item.text));

  if (!valid.length) return null;

  return valid
    .map(item => ({
      item,
      score: getResultQuality(item)
    }))
    .sort((a, b) => b.score - a.score)[0]
    .item;
}

/* =========================================
   15. PROVIDER EXECUTION
========================================= */

async function runProvider(
  name,
  callback,
  diagnostics
) {
  const startedAt = Date.now();

  try {
    const value = await callback();

    diagnostics[name] = {
      success: Boolean(value),
      duration: Date.now() - startedAt,
      status: value ? "found" : "not_found"
    };

    return value;

  } catch (error) {
    diagnostics[name] = {
      success: false,
      duration: Date.now() - startedAt,
      status: "error",
      message: clean(error?.message || "Unknown error", 180)
    };

    console.warn(
      `[Shunel Lyrics] ${name}:`,
      error?.message || error
    );

    return null;
  }
}

/* =========================================
   16. API HANDLER
========================================= */

export default async function handler(req, res) {
  res.setHeader(
    "Access-Control-Allow-Origin",
    "*"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Método no permitido"
    });
  }

  const title = clean(
    req.query.title,
    MAX_TITLE_LENGTH
  );

  const artist = clean(
    req.query.artist,
    MAX_ARTIST_LENGTH
  );

  const requestedVideoId = clean(
    req.query.videoId,
    MAX_VIDEO_ID_LENGTH
  );

  const videoId = isValidVideoId(requestedVideoId)
    ? requestedVideoId
    : "";

  const requestedDuration = Number(
    req.query.duration
  );

  const duration = isValidDuration(requestedDuration)
    ? requestedDuration
    : 0;

  if (!title && !videoId) {
    return res.status(400).json({
      error: "Se necesita el título o el videoId"
    });
  }

  /*
    Cache CDN:
    - 1 hora de caché normal.
    - 24 horas de stale-while-revalidate.
  */

  res.setHeader(
    "Cache-Control",
    "public, s-maxage=3600, stale-while-revalidate=86400"
  );

  res.setHeader(
    "Content-Type",
    "application/json; charset=utf-8"
  );

  const startedAt = Date.now();

  const diagnostics = {};

  try {
    /*
      Primera ronda:
      consultar en paralelo las fuentes que
      pueden entregar sincronización.
    */

    const firstRound = await Promise.all([
      runProvider(
        "LRCLIB",
        () => title
          ? searchLRCLIB(title, artist, duration)
          : null,
        diagnostics
      ),

      runProvider(
        "LiriQo",
        () => searchLiriQo(
          title,
          artist,
          duration,
          videoId
        ),
        diagnostics
      ),

      runProvider(
        "LRCMux",
        () => title && artist
          ? searchLRCMux(title, artist, duration)
          : null,
        diagnostics
      ),

      runProvider(
        "Better Lyrics",
        () => title && artist
          ? searchBetterLyrics(title, artist, duration)
          : null,
        diagnostics
      )
    ]);

    /*
      No se entrega inmediatamente una letra plain.
      Primero se comparan los resultados sincronizados.
    */

    const bestFirstRound = selectBestResult(
      firstRound
    );

    if (
      bestFirstRound?.synced &&
      getResultQuality(bestFirstRound) >= 50
    ) {
      return res.status(200).json({
        ...bestFirstRound,
        diagnostics: {
          providers: diagnostics,
          totalDuration: Date.now() - startedAt
        }
      });
    }

    /*
      Segunda ronda:
      Lyrics.ovh y subtítulos de YouTube.
    */

    const secondRound = await Promise.all([
      runProvider(
        "Lyrics.ovh",
        () => title && artist
          ? searchLyricsOVH(title, artist)
          : null,
        diagnostics
      ),

      runProvider(
        "YouTube",
        () => videoId
          ? searchYouTube(videoId)
          : null,
        diagnostics
      )
    ]);

    const best = selectBestResult([
      ...firstRound,
      ...secondRound
    ]);

    if (best) {
      return res.status(200).json({
        ...best,
        diagnostics: {
          providers: diagnostics,
          totalDuration: Date.now() - startedAt
        }
      });
    }

    const failedProviders = PROVIDER_NAMES.filter(
      name => diagnostics[name]?.status === "error"
    );

    return res.status(404).json({
      error: "No encontramos una letra disponible",
      providersChecked: PROVIDER_NAMES,
      failedProviders,
      diagnostics: {
        providers: diagnostics,
        totalDuration: Date.now() - startedAt
      }
    });

  } catch (error) {
    console.error(
      "[Shunel Lyrics API]",
      error
    );

    return res.status(500).json({
      error: "Error interno buscando letras"
    });
  }
}
