/* =========================================
   SHUNEL — LYRICS ENGINE (LRCLIB + YT Fallback + Sync)
   Versión corregida y robusta
========================================= */

let parsedLines = []; // [{ time: number, text: string }]
let activeLineIndex = -1;
let currentAbortController = null;

/**
 * Escapa caracteres HTML para evitar problemas de seguridad / renderizado
 */
function escapeHTML(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Parser de LRC robusto.
 * Soporta:
 * - [01:23.45]
 * - [1:23.45]
 * - [01:23.4]
 * - [01:23]
 */
function parseLRC(lrcText) {
  if (!lrcText || typeof lrcText !== "string") return [];
  
  const lines = lrcText.split(/\r?\n/);
  const result = [];
  // Minutos 1-3 dígitos, segundos 2 dígitos, ms opcionales 1-3 dígitos
  const timeRegex = /^\[(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?\](.*)/;
  
  for (const line of lines) {
    const match = line.match(timeRegex);
    if (match) {
      const minutes = parseInt(match[1], 10);
      const seconds = parseInt(match[2], 10);
      const msStr = match[3] || "0";
      const ms = parseInt(msStr.padEnd(3, "0"), 10);
      const timeInSeconds = minutes * 60 + seconds + ms / 1000;
      const text = match[4].trim();
      
      if (text) {
        result.push({ time: timeInSeconds, text });
      }
    }
  }
  
  // Asegurar orden por tiempo (por si acaso)
  return result.sort((a, b) => a.time - b.time);
}

/**
 * Limpia el título de YouTube de forma menos agresiva
 */
function cleanTrackTitle(title) {
  if (!title) return "";
  
  return title
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

/**
 * Elige la mejor coincidencia de LRCLIB
 * Prioridad: syncedLyrics > plainLyrics
 */
function selectBestMatch(results) {
  if (!Array.isArray(results) || results.length === 0) return null;
  
  // 1. Preferir con letra sincronizada
  const withSynced = results.filter(item => item.syncedLyrics && item.syncedLyrics.trim());
  if (withSynced.length > 0) {
    return withSynced[0]; // Podrías mejorar el ranking aquí si quieres
  }
  
  // 2. Si no hay synced, usar plain
  const withPlain = results.filter(item => item.plainLyrics && item.plainLyrics.trim());
  if (withPlain.length > 0) {
    return withPlain[0];
  }
  
  return null;
}

/**
 * Busca y renderiza la letra (1. LRCLIB → 2. Fallback /api/lyrics de YouTube)
 */
export async function loadLyricsForTrack(track) {
  const container = document.getElementById("lyricsContainer");
  const subtitle = document.getElementById("lyricsSubtitle");
  const titleEl = document.getElementById("lyricsTitle");
  
  if (!container || !track) return;
  
  // Cancelar petición anterior si existe
  if (currentAbortController) {
    currentAbortController.abort();
  }
  currentAbortController = new AbortController();
  const signal = currentAbortController.signal;
  
  // Reset estado
  parsedLines = [];
  activeLineIndex = -1;
  
  const trackTitle = track.title || "";
  const artistName = track.channelTitle || track.artist || "";
  const videoId = track.id || track.videoId;
  
  if (subtitle) subtitle.textContent = `${artistName} — ${trackTitle}`;
  if (titleEl) titleEl.textContent = "Buscando letra...";
  container.innerHTML = `<p class="muted">Cargando letra...</p>`;
  
  try {
    const cleanTitle = cleanTrackTitle(trackTitle);
    
    // Intentar separar "Artista - Canción" si viene así en el título
    let searchArtist = artistName;
    let searchTrack = cleanTitle;
    
    if (cleanTitle.includes(" - ")) {
      const parts = cleanTitle.split(" - ");
      searchArtist = parts[0].trim();
      searchTrack = parts.slice(1).join(" - ").trim();
    }
    
    // ======================
    // 1. Intentar con LRCLIB
    // ======================
    const lrcUrl = `https://lrclib.net/api/search?track_name=${encodeURIComponent(searchTrack)}&artist_name=${encodeURIComponent(searchArtist)}`;
    
    const lrcRes = await fetch(lrcUrl, {
      signal,
      headers: {
        "Lrclib-Client": "Shunel/1.0 (https://shunel.app)"
      }
    });
    
    if (lrcRes.ok) {
      const lrcData = await lrcRes.json();
      const bestMatch = selectBestMatch(lrcData);
      
      if (bestMatch?.syncedLyrics) {
        parsedLines = parseLRC(bestMatch.syncedLyrics);
        
        if (parsedLines.length > 0) {
          if (titleEl) titleEl.textContent = "Letra sincronizada";
          renderSyncedLines(container);
          return;
        }
      }
      
      if (bestMatch?.plainLyrics) {
        if (titleEl) titleEl.textContent = "Letra";
        renderPlainText(container, bestMatch.plainLyrics);
        return;
      }
    }
    
    // ======================
    // 2. Fallback: Subtítulos de YouTube
    // ======================
    if (videoId) {
      const ytRes = await fetch(`/api/lyrics?videoId=${encodeURIComponent(videoId)}`, {
        signal
      });
      
      if (ytRes.ok) {
        const ytData = await ytRes.json();
        if (ytData?.text) {
          if (titleEl) titleEl.textContent = "Subtítulos de YouTube";
          renderPlainText(container, ytData.text);
          return;
        }
      }
    }
    
    // No se encontró nada
    if (titleEl) titleEl.textContent = "Sin letra";
    container.innerHTML = `<p class="muted">No encontramos letra disponible para esta canción.</p>`;
    
  } catch (error) {
    if (error.name === "AbortError") {
      // Petición cancelada voluntariamente (cambio de canción)
      return;
    }
    
    console.error("[Shunel Lyrics] Error:", error);
    if (titleEl) titleEl.textContent = "Error";
    container.innerHTML = `<p class="muted">No se pudo cargar la letra en este momento.</p>`;
  }
}

/**
 * Renderiza líneas sincronizadas
 */
function renderSyncedLines(container) {
  container.innerHTML = parsedLines
    .map(
      (line, index) =>
      `<div class="lyric-line" data-index="${index}" data-time="${line.time}">${escapeHTML(line.text)}</div>`
    )
    .join("");
}

/**
 * Renderiza letra sin sincronizar
 */
function renderPlainText(container, text) {
  container.innerHTML = text
    .split("\n")
    .filter(l => l.trim() !== "")
    .map(line => `<div class="lyric-line">${escapeHTML(line)}</div>`)
    .join("");
}

/**
 * Sincroniza el verso activo según el tiempo actual del reproductor.
 * Llama a esta función desde el callback onProgress del YouTube Player.
 */
export function syncLyricsProgress(currentTime) {
  if (parsedLines.length === 0) return;
  
  // Buscar la última línea cuyo tiempo ya haya pasado
  const newIndex = parsedLines.findLastIndex(line => currentTime >= line.time);
  
  if (newIndex === -1 || newIndex === activeLineIndex) return;
  
  activeLineIndex = newIndex;
  
  const container = document.getElementById("lyricsContainer");
  if (!container) return;
  
  const lines = container.querySelectorAll(".lyric-line");
  if (!lines.length) return;
  
  lines.forEach((el, idx) => {
    el.classList.toggle("active", idx === activeLineIndex);
  });
  
  const activeEl = lines[activeLineIndex];
  if (activeEl) {
    activeEl.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}