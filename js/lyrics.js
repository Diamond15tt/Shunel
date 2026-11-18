
/* =========================================
   SHUNEL — LYRICS ENGINE 2.0
   Multi-source API + Sync + Cache
========================================= */

let parsedLines = [];
let activeLineIndex = -1;
let currentAbortController = null;

const lyricsCache = new Map();

/* =========================================
   UTILIDADES
========================================= */

function escapeHTML(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
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
    .replace(/\s{2,}/g, " ")
    .trim();
}

/* =========================================
   PARSER LRC
   Soporta múltiples marcas por línea.
========================================= */

function parseLRC(text) {
  if (!text || typeof text !== "string") return [];

  const result = [];
  const lines = text.split(/\r?\n/);

  const timeRegex = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

  for (const rawLine of lines) {
    const matches = [...rawLine.matchAll(timeRegex)];

    if (!matches.length) continue;

    const lyricText = rawLine
      .replace(timeRegex, "")
      .trim();

    if (!lyricText) continue;

    for (const match of matches) {
      const minutes = Number(match[1]);
      const seconds = Number(match[2]);
      const fraction = Number(
        String(match[3] || "0").padEnd(3, "0")
      );

      result.push({
        time: minutes * 60 + seconds + fraction / 1000,
        text: lyricText
      });
    }
  }

  return result.sort((a, b) => a.time - b.time);
}

/* =========================================
   ESTADO
========================================= */

function resetLyrics() {
  parsedLines = [];
  activeLineIndex = -1;
}

function getCacheKey(track) {
  return [
    cleanTrackTitle(track.title).toLowerCase(),
    String(track.artist || track.channelTitle || "").toLowerCase(),
    track.id || track.videoId || ""
  ].join("|");
}

/* =========================================
   RENDERIZADO
========================================= */

function renderSyncedLines(container) {
  container.innerHTML = parsedLines
    .map((line, index) => `
      <div
        class="lyric-line"
        data-index="${index}"
        data-time="${line.time}"
      >${escapeHTML(line.text)}</div>
    `)
    .join("");
}

function renderPlainText(container, text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  container.innerHTML = lines
    .map(line =>
      `<div class="lyric-line">${escapeHTML(line)}</div>`
    )
    .join("");
}

/* =========================================
   MOSTRAR RESULTADO
========================================= */

function displayLyrics(data, container, titleEl) {
  if (!data || !data.text) return false;

  resetLyrics();

  const syncedText =
    data.syncedLyrics ||
    (data.synced ? data.text : "");

  const lines = syncedText
    ? parseLRC(syncedText)
    : [];

  if (lines.length > 0) {
    parsedLines = lines;

    if (titleEl) {
      titleEl.textContent = "Letra sincronizada";
    }

    renderSyncedLines(container);
  } else {
    if (titleEl) {
      titleEl.textContent = "Letra";
    }

    renderPlainText(
      container,
      data.plainLyrics || data.text
    );
  }

  if (data.source) {
    container.dataset.lyricsSource = data.source;
  }

  return true;
}

/* =========================================
   BÚSQUEDA PRINCIPAL
========================================= */

export async function loadLyricsForTrack(track) {
  const container = document.getElementById("lyricsContainer");
  const subtitle = document.getElementById("lyricsSubtitle");
  const titleEl = document.getElementById("lyricsTitle");

  if (!container || !track) return;

  if (currentAbortController) {
    currentAbortController.abort();
  }

  currentAbortController = new AbortController();

  const signal = currentAbortController.signal;

  resetLyrics();

  const title = cleanTrackTitle(track.title);
  const artist =
    track.artist ||
    track.channelTitle ||
    track.channel ||
    "";

  const videoId = track.videoId || track.id || "";

  const duration = Number(
    track.duration ||
    track.durationSeconds ||
    0
  );

  if (subtitle) {
    subtitle.textContent = `${artist} — ${title}`;
  }

  if (titleEl) {
    titleEl.textContent = "Buscando letra...";
  }

  container.dataset.lyricsSource = "";
  container.innerHTML =
    `<p class="muted">Buscando en varias fuentes...</p>`;

  const cacheKey = getCacheKey({
    ...track,
    title,
    artist
  });

  // Caché de esta sesión.
  if (lyricsCache.has(cacheKey)) {
    const cached = lyricsCache.get(cacheKey);

    if (displayLyrics(cached, container, titleEl)) {
      return;
    }
  }

  try {
    const params = new URLSearchParams();

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

    const response = await fetch(
      `/api/lyrics?${params.toString()}`,
      {
        method: "GET",
        signal,
        headers: {
          Accept: "application/json"
        }
      }
    );

    if (signal.aborted) return;

    if (response.status === 404) {
      if (titleEl) {
        titleEl.textContent = "Sin letra";
      }

      container.innerHTML =
        `<p class="muted">No encontramos una letra disponible para esta canción.</p>`;

      return;
    }

    if (!response.ok) {
      throw new Error(`Lyrics API: ${response.status}`);
    }

    const data = await response.json();

    if (signal.aborted) return;

    if (!data || !data.text) {
      throw new Error("Respuesta de letras vacía");
    }

    lyricsCache.set(cacheKey, data);

    displayLyrics(data, container, titleEl);

    // Actualizar Lyrics Studio si está instalado.
    window.ShunelLyricsStudio?.refreshLyrics?.();

  } catch (error) {
    if (error.name === "AbortError") return;

    console.error("[Shunel Lyrics]", error);

    if (titleEl) {
      titleEl.textContent = "Error";
    }

    container.innerHTML =
      `<p class="muted">No se pudo cargar la letra. Intentá nuevamente.</p>`;
  }
}

/* =========================================
   SINCRONIZACIÓN
========================================= */

export function syncLyricsProgress(currentTime) {
  if (!parsedLines.length) return;

  const time = Number(currentTime);

  if (!Number.isFinite(time)) return;

  // Compatible con Safari sin findLastIndex.
  let newIndex = -1;

  for (let i = 0; i < parsedLines.length; i++) {
    if (time >= parsedLines[i].time) {
      newIndex = i;
    } else {
      break;
    }
  }

  if (newIndex === activeLineIndex) return;

  activeLineIndex = newIndex;

  const container = document.getElementById("lyricsContainer");

  if (!container) return;

  const lines = container.querySelectorAll(".lyric-line");

  lines.forEach((element, index) => {
    element.classList.toggle(
      "active",
      index === activeLineIndex
    );
  });

  if (activeLineIndex < 0) return;

  const activeElement = lines[activeLineIndex];

  if (!activeElement) return;

  const autoScroll =
    window.ShunelLyricsStudio?.getSettings?.().autoScroll ?? true;

  if (!autoScroll) return;

  const reducedMotion =
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  activeElement.scrollIntoView({
    behavior: reducedMotion ? "auto" : "smooth",
    block: "center"
  });
}

/* =========================================
   API PÚBLICA
========================================= */

export function clearLyrics() {
  if (currentAbortController) {
    currentAbortController.abort();
  }

  resetLyrics();

  const container = document.getElementById("lyricsContainer");
  const titleEl = document.getElementById("lyricsTitle");

  if (container) {
    container.innerHTML = "";
  }

  if (titleEl) {
    titleEl.textContent = "Sincronizada";
  }
}
