
/* =========================================
   SHUNEL — LYRICS API
   Multi-source lyrics engine
   LRCLIB + LiriQo + LRCMux
   + Better Lyrics + Lyrics.ovh + YouTube
========================================= */

const LIRIQO_URL = "https://api.liriqo-alfarrizi.my.id/v1";
const BETTER_URL = "https://api.betterlyrics.org";
const LRCMUX_URL = "https://api.lrcmux.dev";
const LRCLIB_URL = "https://lrclib.net/api";

const USER_AGENT = "Shunel/2.0 (https://shunel.vercel.app)";

function clean(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function formatLrcTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds - minutes * 60;

  return (
    "[" +
    String(minutes).padStart(2, "0") +
    ":" +
    remainder.toFixed(2).padStart(5, "0") +
    "]"
  );
}

function makeLrc(lines) {
  if (!Array.isArray(lines)) return "";

  return lines
    .filter(line =>
      line &&
      typeof line.text === "string" &&
      Number.isFinite(Number(line.start))
    )
    .map(line => {
      // LiriQo y LRCMux expresan los tiempos en milisegundos.
      const time = Number(line.start);
      const seconds = time > 1000 ? time / 1000 : time;

      return formatLrcTime(seconds) + line.text.trim();
    })
    .filter(line => line.length > 6)
    .join("\n");
}

function validLyrics(text) {
  if (typeof text !== "string") return false;

  const value = text.trim();

  return (
    value.length >= 20 &&
    !/^(lyrics not found|not found|no lyrics|error)$/i.test(value)
  );
}

function result(lyrics, source, synced = false) {
  if (!validLyrics(lyrics)) return null;

  return {
    text: lyrics,
    source,
    synced,
    syncedLyrics: synced ? lyrics : "",
    plainLyrics: synced ? "" : lyrics
  };
}

async function request(url, options = {}, timeout = 6500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json, text/plain, */*",
        ...(options.headers || {})
      }
    });

    if (!response.ok) return null;

    return response;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* =========================================
   1. LRCLIB
========================================= */

async function searchLRCLIB(title, artist, duration) {
  const url = new URL(`${LRCLIB_URL}/search`);

  url.searchParams.set("track_name", title);

  if (artist) {
    url.searchParams.set("artist_name", artist);
  }

  if (duration > 0) {
    url.searchParams.set("duration", String(Math.round(duration)));
  }

  const response = await request(url.toString(), {
    headers: {
      "Lrclib-Client": "Shunel/2.0 (https://shunel.vercel.app)"
    }
  });

  if (!response) return null;

  const data = await response.json();

  if (!Array.isArray(data)) return null;

  const normalizedTitle = title.toLowerCase();

  const candidates = data
    .filter(item =>
      validLyrics(item.syncedLyrics) ||
      validLyrics(item.plainLyrics)
    )
    .map(item => {
      const candidateTitle = clean(item.trackName).toLowerCase();
      const candidateArtist = clean(item.artistName).toLowerCase();

      let score = 0;

      if (candidateTitle === normalizedTitle) score += 5;
      if (candidateTitle.includes(normalizedTitle)) score += 2;

      if (
        artist &&
        candidateArtist.includes(artist.toLowerCase())
      ) {
        score += 3;
      }

      if (duration && item.duration) {
        const difference = Math.abs(
          Number(item.duration) - Number(duration)
        );

        if (difference <= 5) score += 2;
        else if (difference <= 15) score += 1;
      }

      if (validLyrics(item.syncedLyrics)) score += 5;

      return { item, score };
    })
    .sort((a, b) => b.score - a.score);

  if (!candidates.length) return null;

  const best = candidates[0].item;

  if (validLyrics(best.syncedLyrics)) {
    return result(best.syncedLyrics, "LRCLIB", true);
  }

  return result(best.plainLyrics, "LRCLIB", false);
}

/* =========================================
   2. LIRIQO
   11 proveedores en un solo servicio
========================================= */

async function searchLiriQo(title, artist, duration, videoId) {
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
    url.searchParams.set("duration", String(Math.round(duration)));
  }

  url.searchParams.set("full", "1");

  const response = await request(url.toString(), {}, 14000);

  if (!response) return null;

  const data = await response.json();

  if (data.error) return null;

  const candidates = [
    ...(data.primary ? [data.primary] : []),
    ...(Array.isArray(data.tracks) ? data.tracks : [])
  ];

  const unique = [];
  const seen = new Set();

  for (const item of candidates) {
    if (!item) continue;

    const key = [
      item.provider,
      item.syncLevel,
      item.plain
    ].join("|");

    if (!seen.has(key)) {
      seen.add(key);
      unique.push(item);
    }
  }

  const rank = {
    syllable: 5,
    word: 4,
    character: 4,
    line: 3,
    plain: 1
  };

  unique.sort((a, b) =>
    (rank[b.syncLevel] || 0) - (rank[a.syncLevel] || 0)
  );

  for (const item of unique) {
    const timed = Array.isArray(item.timed)
      ? item.timed
      : [];

    const lrc = makeLrc(timed);

    if (validLyrics(lrc)) {
      return result(
        lrc,
        `LiriQo · ${item.upstreamProvider || item.provider || "Proveedor"}`,
        true
      );
    }

    if (validLyrics(item.lrc)) {
      return result(
        item.lrc,
        `LiriQo · ${item.provider || "Proveedor"}`,
        true
      );
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
   3. LRCMUX
   Agregador: KuGou, Genius, LRCLIB,
   YouTube Music y otras fuentes
========================================= */

async function searchLRCMux(title, artist, duration) {
  const url = new URL(`${LRCMUX_URL}/get`);

  url.searchParams.set("title", title);
  url.searchParams.set("artist", artist);
  url.searchParams.set("level", "word");
  url.searchParams.set("format", "json");

  if (duration > 0) {
    url.searchParams.set("duration", String(Math.round(duration)));
  }

  const response = await request(url.toString(), {}, 9000);

  if (!response) return null;

  const data = await response.json();

  if (Array.isArray(data.lines)) {
    const lrc = makeLrc(data.lines);

    if (validLyrics(lrc)) {
      return result(
        lrc,
        `LRCMux · ${data.meta?.source?.name || "Proveedor"}`,
        true
      );
    }

    const plain = data.lines
      .map(line => line.text || "")
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
   4. BETTER LYRICS
   KuGou y QQ no requieren API key
========================================= */

async function searchBetterLyrics(title, artist, duration) {
  const providers = ["kugou", "qq"];

  for (const provider of providers) {
    const url = new URL(`${BETTER_URL}/${provider}/getLyrics`);

    url.searchParams.set("s", title);
    url.searchParams.set("a", artist);
    url.searchParams.set("al", "");
    url.searchParams.set("d", String(Math.round(duration || 0)));

    const response = await request(url.toString(), {}, 6500);

    if (!response) continue;

    const data = await response.json();

    if (!validLyrics(data.lyrics)) continue;

    const lyrics = data.lyrics;

    if (provider === "kugou" && /\[\d{1,3}:\d{2}/.test(lyrics)) {
      return result(lyrics, "Better Lyrics · KuGou", true);
    }

    // QRC: extraer el texto si no podemos conservar
    // de forma fiable sus marcas de tiempo.
    const plain = decodeEntities(
      lyrics
        .replace(/<[^>]*>/g, "\n")
        .replace(/\(\d+,\d+\)/g, "")
        .replace(/\[\d+,\d+\]/g, "")
    );

    if (validLyrics(plain)) {
      return result(plain, "Better Lyrics · QQ Music", false);
    }
  }

  return null;
}

/* =========================================
   5. LYRICS.OVH
========================================= */

async function searchLyricsOVH(title, artist) {
  if (!artist || !title) return null;

  const url =
    "https://api.lyrics.ovh/v1/" +
    encodeURIComponent(artist) +
    "/" +
    encodeURIComponent(title);

  const response = await request(url, {}, 6500);

  if (!response) return null;

  const data = await response.json();

  return result(data.lyrics, "Lyrics.ovh", false);
}

/* =========================================
   6. YOUTUBE CAPTIONS
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

async function searchYouTube(videoId) {
  if (!videoId) return null;

  const watchResponse = await request(
    `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
    {
      headers: {
        "Accept-Language": "es,en;q=0.9"
      }
    },
    8000
  );

  if (!watchResponse) return null;

  const html = await watchResponse.text();

  const rawTracks = extractArrayAfter(html, '"captionTracks":');

  if (!rawTracks) return null;

  let tracks;

  try {
    tracks = JSON.parse(rawTracks);
  } catch {
    return null;
  }

  if (!Array.isArray(tracks) || !tracks.length) return null;

  const preferred =
    tracks.find(track =>
      /^es(-|$)/i.test(track.languageCode || "")
    ) ||
    tracks.find(track =>
      /^en(-|$)/i.test(track.languageCode || "")
    ) ||
    tracks[0];

  if (!preferred?.baseUrl) return null;

  const subtitleResponse = await request(
    preferred.baseUrl,
    {},
    8000
  );

  if (!subtitleResponse) return null;

  const xml = await subtitleResponse.text();

  const lines = [...xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)]
    .map(match =>
      decodeEntities(
        match[1].replace(/<[^>]+>/g, "")
      ).trim()
    )
    .filter(Boolean);

  if (!lines.length) return null;

  return result(lines.join("\n"), "YouTube Subtitles", false);
}

/* =========================================
   API HANDLER
========================================= */

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Método no permitido"
    });
  }

  const title = clean(req.query.title);
  const artist = clean(req.query.artist);
  const videoId = clean(req.query.videoId);
  const duration = Math.max(
    0,
    Number(req.query.duration) || 0
  );

  if (!title && !videoId) {
    return res.status(400).json({
      error: "Se necesita el título o el videoId"
    });
  }

  // Caché CDN de Vercel.
  res.setHeader(
    "Cache-Control",
    "public, s-maxage=3600, stale-while-revalidate=86400"
  );

  const errors = [];

  async function attempt(name, callback) {
    try {
      const found = await callback();

      if (found) return found;
    } catch (error) {
      errors.push(name);
      console.warn(`[Shunel Lyrics] ${name}:`, error.message);
    }

    return null;
  }

  try {
    // Primera ronda: tres catálogos principales en paralelo.
    const firstRound = await Promise.all([
      attempt("LRCLIB", () =>
        title
          ? searchLRCLIB(title, artist, duration)
          : null
      ),

      attempt("LiriQo", () =>
        searchLiriQo(title, artist, duration, videoId)
      ),

      attempt("LRCMux", () =>
        title && artist
          ? searchLRCMux(title, artist, duration)
          : null
      )
    ]);

    // Priorizar sincronización entre los resultados.
    const synced = firstRound.find(item => item?.synced);

    if (synced) {
      return res.status(200).json(synced);
    }

    const plainFirstRound = firstRound.find(Boolean);

    if (plainFirstRound) {
      // Antes de entregar texto normal, probar fuentes
      // que todavía pueden devolver sincronización.
      const better = await attempt("Better Lyrics", () =>
        title && artist
          ? searchBetterLyrics(title, artist, duration)
          : null
      );

      if (better?.synced) {
        return res.status(200).json(better);
      }

      return res.status(200).json(
        better || plainFirstRound
      );
    }

    // Segunda ronda: fuentes adicionales.
    const better = await attempt("Better Lyrics", () =>
      title && artist
        ? searchBetterLyrics(title, artist, duration)
        : null
    );

    if (better) {
      return res.status(200).json(better);
    }

    const ovh = await attempt("Lyrics.ovh", () =>
      title && artist
        ? searchLyricsOVH(title, artist)
        : null
    );

    if (ovh) {
      return res.status(200).json(ovh);
    }

    const youtube = await attempt("YouTube", () =>
      searchYouTube(videoId)
    );

    if (youtube) {
      return res.status(200).json(youtube);
    }

    return res.status(404).json({
      error: "No encontramos una letra disponible",
      providersChecked: [
        "LRCLIB",
        "LiriQo",
        "LRCMux",
        "Better Lyrics",
        "Lyrics.ovh",
        "YouTube"
      ],
      failedProviders: errors
    });

  } catch (error) {
    console.error("[Shunel Lyrics API]", error);

    return res.status(500).json({
      error: "Error interno buscando letras"
    });
  }
}
