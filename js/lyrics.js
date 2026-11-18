/* =========================================
   SHUNEL — LYRICS ENGINE (LRCLIB + YT Fallback + Sync)
========================================= */

let parsedLines = []; // [{ time: segundos, text: "..." }]
let activeLineIndex = -1;

/**
 * Convierte formato LRC "[01:23.45] Texto" en objetos con tiempo en segundos
 */
function parseLRC(lrcText) {
  const lines = lrcText.split("\n");
  const result = [];
  const timeRegex = /^\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)/;

  for (const line of lines) {
    const match = line.match(timeRegex);
    if (match) {
      const minutes = parseInt(match[1], 10);
      const seconds = parseInt(match[2], 10);
      const ms = parseInt(match[3].padEnd(3, "0"), 10);
      const timeInSeconds = minutes * 60 + seconds + ms / 1000;
      const text = match[4].trim();

      if (text) {
        result.push({ time: timeInSeconds, text });
      }
    }
  }
  return result;
}

/**
 * Busca y renderiza la letra (1. LRCLIB -> 2. Fallback /api/lyrics de YouTube)
 */
export async function loadLyricsForTrack(track) {
  const container = document.getElementById("lyricsContainer");
  const subtitle = document.getElementById("lyricsSubtitle");
  const titleEl = document.getElementById("lyricsTitle");

  if (!container || !track) return;

  parsedLines = [];
  activeLineIndex = -1;

  const trackTitle = track.title || "";
  const artistName = track.channelTitle || track.artist || "";
  const videoId = track.id || track.videoId;

  if (subtitle) subtitle.textContent = `${artistName} — ${trackTitle}`;
  if (titleEl) titleEl.textContent = "Buscando letra...";
  container.innerHTML = `<p class="muted">Cargando letra...</p>`;

  try {
    // Limpiar ruido habitual de títulos de YouTube
    const cleanTitle = trackTitle
      .replace(/\([^)]*\)/g, "")
      .replace(/\[[^\]]*\]/g, "")
      .replace(/official video|video oficial|lyrics|letra|audio|remix|hd|4k/gi, "")
      .trim();

    // Si el título en YT viene como "Artista - Canción", separarlo ayuda mucho a LRCLIB
    let searchArtist = artistName;
    let searchTrack = cleanTitle;
    if (cleanTitle.includes(" - ")) {
      const parts = cleanTitle.split(" - ");
      searchArtist = parts[0].trim();
      searchTrack = parts.slice(1).join(" - ").trim();
    }

    // 1. Intentar con LRCLIB
    const lrcUrl = `https://lrclib.net/api/search?track_name=${encodeURIComponent(searchTrack)}&artist_name=${encodeURIComponent(searchArtist)}`;
    const lrcRes = await fetch(lrcUrl);
    const lrcData = await lrcRes.json();

    if (Array.isArray(lrcData) && lrcData.length > 0) {
      const bestMatch = lrcData.find(item => item.syncedLyrics || item.plainLyrics);

      if (bestMatch?.syncedLyrics) {
        parsedLines = parseLRC(bestMatch.syncedLyrics);
        if (titleEl) titleEl.textContent = "Letra sincronizada";
        renderSyncedLines(container);
        return;
      }

      if (bestMatch?.plainLyrics) {
        if (titleEl) titleEl.textContent = "Letra";
        renderPlainText(container, bestMatch.plainLyrics);
        return;
      }
    }

    // 2. Fallback: Subtítulos de YouTube vía Vercel (/api/lyrics)
    if (videoId) {
      const ytRes = await fetch(`/api/lyrics?videoId=${encodeURIComponent(videoId)}`);
      if (ytRes.ok) {
        const ytData = await ytRes.json();
        if (ytData.text) {
          if (titleEl) titleEl.textContent = "Subtítulos de YouTube";
          renderPlainText(container, ytData.text);
          return;
        }
      }
    }

    // Si ninguno tuvo resultados
    if (titleEl) titleEl.textContent = "Sin letra";
    container.innerHTML = `<p class="muted">No encontramos letra disponible para esta canción.</p>`;

  } catch (error) {
    console.error("[Shunel Lyrics] Error:", error);
    if (titleEl) titleEl.textContent = "Error";
    container.innerHTML = `<p class="muted">No se pudo cargar la letra en este momento.</p>`;
  }
}

function renderSyncedLines(container) {
  container.innerHTML = parsedLines
    .map(
      (line, index) =>
        `<div class="lyric-line" data-index="${index}" data-time="${line.time}">${line.text}</div>`
    )
    .join("");
}

function renderPlainText(container, text) {
  container.innerHTML = text
    .split("\n")
    .filter(l => l.trim() !== "")
    .map(line => `<div class="lyric-line">${line}</div>`)
    .join("");
}

/**
 * Conectar esto al callback `onProgress` de YouTubePlayer para iluminar el verso activo
 */
export function syncLyricsProgress(currentTime, onSeekRequest) {
  if (parsedLines.length === 0) return;

  // Buscar la última línea cuyo tiempo ya haya pasado
  let newIndex = -1;
  for (let i = 0; i < parsedLines.length; i++) {
    if (currentTime >= parsedLines[i].time) {
      newIndex = i;
    } else {
      break;
    }
  }

  if (newIndex !== -1 && newIndex !== activeLineIndex) {
    activeLineIndex = newIndex;
    const container = document.getElementById("lyricsContainer");
    if (!container) return;

    const lines = container.querySelectorAll(".lyric-line");
    lines.forEach((el, idx) => {
      el.classList.toggle("active", idx === activeLineIndex);
    });

    const activeEl = lines[activeLineIndex];
    if (activeEl) {
      activeEl.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }
}
