import {
  searchTracks,
  searchPopularTracks,
  searchNewTracks
} from "./search.js";

import { initCostaRicaTop50 } from "./charts.js";
import { YouTubePlayer } from "./player.js";
import { QueueManager } from "./queue.js";
import { MusicLibrary } from "./library.js";
import { ShunelUI } from "./ui.js";
import { Storage } from "./storage.js";
import { loadLyricsForTrack, syncLyricsProgress } from "./lyrics.js";

// // Módulos de Shunel
import { loadArtwork, applyArtwork, initArtwork } from "./artwork.js";
import {
  applyModToTrack,
  applyActiveMod,
  importModPack,
  listModPacks,
  enableModPack,
  disableModPack
} from "./mods.js";
import { startRadio, getRadioState, stopRadio, playRadioTrack } from "./radio.js";
import { getRecommendations, resolveRecommendation } from "./recommendations.js";
import { discoverTracks, discoverByMood } from "./discovery.js";
import { askShunelAIFull } from "./ai.js";

// // El cerebro: gusto, ranking, shuffle y texto (sin DOM)
import {
  ShunelBrain,
  cleanTitle,
  cleanArtist,
  scoreSearchMatch,
  artistKey
} from "./brain.js";

/* =========================================================================
   SHUNEL — APP CONTROLLER v2 ("cerebro")
   // Reproducción con máquina de estados + token anti-carreras
   // Autoplay infinito con ranking por gusto y diversidad (tipo Apple Music)
   // Cola con prioridad: lo que tú agregas va antes que el autoplay (Spotify)
   // Shuffle inteligente ("Fewer repeats") + Repetir (no / todo / una)
   // Temporizador de apagado con fade, reanudar sesión, atajos de teclado
   // Media Session robusta (pantalla de bloqueo iOS), errores de YouTube
   // Mantiene: letras, carátula dinámica, mods, radio, recomendaciones,
   // descubrimiento, Shunel AI y Top 50 de Costa Rica
   ========================================================================= */

const ui = new ShunelUI();
const queue = new QueueManager();
const library = new MusicLibrary();
const brain = new ShunelBrain();

let player = null;
let currentTrack = null;
let searchController = null;
let isPlaying = false;
let progressTimer = null;
let queuePanelOpen = false;
let costaRicaTop50 = null;
let top50Initialized = false;
let recommendationController = null;
let discoveryController = null;
let autoplayController = null;
let aiMessages = [];
let aiBusy = false;
let radioTracks = [];
let unresolvedToken = 0;

const mediaSession = navigator.mediaSession || null;

// // Estado de la reproducción (una sola fuente de verdad)
const playback = {
  token: 0,              // // sube con cada canción: invalida callbacks viejos
  phase: "idle",         // // idle | loading | playing | paused | ended | error
  listened: 0,           // // segundos realmente escuchados de esta canción
  lastTick: 0,           // // performance.now() del último tick
  lastPosition: 0,
  lastDuration: 0,
  resumeAt: 0,           // // segundo donde reanudar (sesión restaurada)
  pendingResume: false,  // // hay canción restaurada esperando el primer "play"
  retried: false,        // // error 2/5: ya se reintentó una vez
  errorStreak: 0,        // // saltos automáticos seguidos por error
  prefetchToken: -1,     // // para no pedir autoplay dos veces por canción
  finished: false,       // // ya se le contó al cerebro esta canción
  muted: false,
  watchdog: null
};

// // Videos agregados por autoplay (la cola guardada pierde la etiqueta)
const autoplayIds = new Set();

// // Temporizador de apagado
const sleep = { mode: "off", endsAt: 0, timer: null, fading: false };
const SLEEP_STEPS = ["off", 15, 30, 60, "track"];

// // Pestañas: solo una suena a la vez
const TAB_ID = Math.random().toString(36).slice(2);
let channel = null;

const RESUME_KEY = "shunel_resume_v1";
const SHUFFLE_KEY = "shunel_shuffle_order_v1";
const YT_STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };

/* =========================================================================
   // 1. HELPERS
   ========================================================================= */

function getArtist(track) {
  return String(track?.artist || track?.channel || track?.channelTitle || "Shunel").trim();
}

function normalizeTrack(track) {
  if (!track) return null;
  const artist = getArtist(track);
  return {
    ...track,
    artist,
    channel: track.channel || artist,
    channelTitle: track.channelTitle || artist,
    videoId: track.videoId || track.id || ""
  };
}

function getTrackArtwork(track) {
  let url = track?.artwork || track?.thumbnail || track?.thumbnailUrl || track?.image || "/assets/placeholder.svg";
  url = String(url);
  if (url.startsWith("//")) url = `https:${url}`;
  return url;
}

function ensureStylesheet(href) {
  const exists = [...document.styleSheets].some(sheet => {
    try { return sheet.href && new URL(sheet.href).pathname === href; }
    catch { return false; }
  });
  if (exists) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  document.head.appendChild(link);
}

function makeElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatTime(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

function safeNumber(fn, fallback = 0) {
  try {
    const value = Number(fn());
    return Number.isFinite(value) ? value : fallback;
  } catch { return fallback; }
}

function getPosition() { return safeNumber(() => player?.getCurrentTime?.()); }
function getDuration() { return safeNumber(() => player?.getDuration?.()); }

// // ¿El usuario está escribiendo? (no robar teclas)
function isTypingTarget(target) {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

// // Ejecuta en tiempo libre (mejor INP); Safari no tiene requestIdleCallback
const idle = window.requestIdleCallback
  ? callback => window.requestIdleCallback(callback, { timeout: 400 })
  : callback => setTimeout(callback, 60);

/* =========================================================================
   // 2. RENDER AGRUPADO (evita re-pintar la biblioteca en cada cambio)
   ========================================================================= */

const pendingRender = new Set();
let renderScheduled = false;

function scheduleRender(...parts) {
  parts.forEach(part => pendingRender.add(part));
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    const parts = [...pendingRender];
    pendingRender.clear();
    if (parts.includes("queue")) renderQueueNow();
    if (parts.includes("collections")) idle(renderCollectionsNow);
  });
}

// // Nombres antiguos (por compatibilidad con el resto del código)
function refreshCollections() { scheduleRender("collections"); }
function refreshQueue() { scheduleRender("queue"); }

/* =========================================================================
   // 3. iOS: AUDIO SILENCIOSO + AUDIO SESSION
   ========================================================================= */

const silentAudio = document.createElement("audio");
silentAudio.src = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
silentAudio.loop = true;
silentAudio.setAttribute("playsinline", "");

function triggerIOSAudioContext() {
  try {
    const result = silentAudio.play();
    if (result?.catch) result.catch(() => {});
  } catch {}
}

function pauseIOSAudioContext() {
  try { silentAudio.pause(); } catch {}
}

document.addEventListener("pointerdown", triggerIOSAudioContext, { once: true });

// // Safari 16.4+: declarar que somos una app de música ("playback")
try {
  if (navigator.audioSession && "type" in navigator.audioSession) navigator.audioSession.type = "playback";
} catch {}

/* =========================================================================
   // 4. FONDO DINÁMICO DEL REPRODUCTOR
   ========================================================================= */

let artworkColorRequest = 0;

function setFullPlayerBackground(track) {
  const fullPlayer = document.getElementById("fullPlayer");
  if (!fullPlayer || !track) return;

  const requestId = ++artworkColorRequest;
  const image = new Image();
  image.crossOrigin = "anonymous";
  image.decoding = "async";

  image.onload = () => {
    if (requestId !== artworkColorRequest) return;
    try {
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("Canvas no disponible");
      canvas.width = 24;
      canvas.height = 24;
      context.drawImage(image, 0, 0, 24, 24);
      const pixels = context.getImageData(0, 0, 24, 24).data;
      let red = 0, green = 0, blue = 0, count = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i + 3] < 128) continue;
        red += pixels[i]; green += pixels[i + 1]; blue += pixels[i + 2]; count++;
      }
      if (!count) throw new Error("Sin colores");
      red = Math.round(red / count);
      green = Math.round(green / count);
      blue = Math.round(blue / count);
      const scale = (red + green + blue) / 3 > 150 ? 0.65 : 0.85;
      fullPlayer.style.setProperty("--song-color", `rgb(${Math.round(red * scale)}, ${Math.round(green * scale)}, ${Math.round(blue * scale)})`);
    } catch {
      fullPlayer.style.setProperty("--song-color", "#242424");
    }
  };
  image.onerror = () => {
    if (requestId === artworkColorRequest) fullPlayer.style.setProperty("--song-color", "#242424");
  };
  image.src = getTrackArtwork(track);
}

document.addEventListener("shunel:artwork-updated", event => {
  const detail = event.detail || {};
  if (currentTrack && detail.track?.videoId === currentTrack.videoId) {
    setFullPlayerBackground({ ...currentTrack, artwork: detail.artwork });
    updateMediaMetadata({ ...currentTrack, artwork: detail.artwork });
  }
});

/* =========================================================================
   // 5. MEDIA SESSION (pantalla de bloqueo, AirPods, CarPlay)
   ========================================================================= */

// // El tipo MIME correcto evita que iOS descarte la carátula
function artworkType(url) {
  const clean = String(url).split("?")[0].toLowerCase();
  if (clean.endsWith(".png")) return "image/png";
  if (clean.endsWith(".webp")) return "image/webp";
  if (clean.endsWith(".svg")) return "image/svg+xml";
  return "image/jpeg";
}

function updateMediaMetadata(track) {
  if (!mediaSession || !track) return;
  try {
    if (!("MediaMetadata" in window)) return;
    const artwork = getTrackArtwork(track);
    const type = artworkType(artwork);
    // // Título limpio solo en la pantalla de bloqueo (sin "Video Oficial")
    mediaSession.metadata = new MediaMetadata({
      title: cleanTitle(track.title || track.name) || track.title || "Reproduciendo",
      artist: cleanArtist(getArtist(track)) || getArtist(track),
      album: track.album || "Shunel",
      artwork: [
        { src: artwork, sizes: "96x96", type },
        { src: artwork, sizes: "256x256", type },
        { src: artwork, sizes: "512x512", type }
      ]
    });
  } catch (error) {
    console.warn("[Shunel] No se pudo actualizar Media Session:", error);
  }
}

function updateMediaPlaybackState(state) {
  if (!mediaSession) return;
  try {
    mediaSession.playbackState = state === true ? "playing" : state === "none" ? "none" : "paused";
  } catch (error) { console.warn("[Shunel] Error de estado multimedia:", error); }
}

// // setPositionState lanza error si position > duration o duration <= 0
function updateMediaPosition() {
  if (!mediaSession || typeof mediaSession.setPositionState !== "function" || !player) return;
  try {
    const duration = getDuration();
    const position = getPosition();
    if (!(duration > 0)) return;
    mediaSession.setPositionState({
      duration,
      playbackRate: 1,
      position: Math.min(Math.max(position, 0), duration)
    });
  } catch {}
}

function clearMediaPosition() {
  try { mediaSession?.setPositionState?.({}); } catch {}
}

function seekBy(offset) {
  if (!player || !currentTrack) return;
  const duration = getDuration();
  const target = Math.max(0, getPosition() + offset);
  seekTo(duration > 0 ? Math.min(duration - 0.5, target) : target);
}

function seekTo(seconds) {
  if (!player) return;
  const value = Math.max(0, Number(seconds) || 0);
  try { player.seekTo(value); } catch {}
  playback.lastPosition = value;
  ui.setProgress(value, getDuration());
  syncLyricsProgress(value);
  updateMediaPosition();
}

function setupMediaSession() {
  if (!mediaSession) return;
  const actions = {
    play: () => { if (currentTrack) { triggerIOSAudioContext(); resumeOrStart(); } },
    pause: () => { pauseIOSAudioContext(); player?.pause?.(); },
    stop: () => { pauseIOSAudioContext(); player?.pause?.(); updateMediaPlaybackState(false); },
    nexttrack: () => playNext(),
    previoustrack: () => playPrevious(),
    seekto: details => { if (Number.isFinite(details.seekTime)) seekTo(details.seekTime); },
    seekbackward: details => seekBy(-(details.seekOffset || 10)),
    seekforward: details => seekBy(details.seekOffset || 10)
  };
  Object.entries(actions).forEach(([action, handler]) => {
    try { mediaSession.setActionHandler(action, handler); } catch {}
  });
}

/* =========================================================================
   // 6. NAVEGACIÓN
   ========================================================================= */

function navigateToView(viewName) {
  if (!viewName) return;
  const target = document.getElementById(`view-${viewName}`);
  if (!target) {
    console.warn(`[Shunel] Vista no encontrada: ${viewName}`);
    return;
  }
  ui.showView(viewName);
  document.querySelectorAll(".bottom-nav-item").forEach(button => {
    const active = button.dataset.view === viewName;
    button.classList.toggle("active", active);
    button.setAttribute("aria-current", active ? "page" : "false");
  });
}

function bindNavigation() {
  document.querySelectorAll("[data-view]").forEach(button => {
    button.addEventListener("click", event => {
      event.preventDefault();
      navigateToView(button.dataset.view);
      const filter = button.dataset.libraryFilter;
      if (filter) setLibraryFilter(filter);
    });
  });

  document.addEventListener("click", event => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest("#openLyricsButton")) {
      event.preventDefault();
      navigateToView("lyrics");
      closeFullPlayer();
    }
    if (target.closest("#profileButton")) {
      navigateToView("library");
    }
  });
}

/* =========================================================================
   // 7. BIBLIOTECA: FILTROS Y COLECCIONES
   ========================================================================= */

function setLibraryFilter(filter) {
  const libraryList = document.getElementById("libraryList");
  const favoritesList = document.getElementById("favoritesList");
  if (!libraryList || !favoritesList) return;
  const favorites = filter === "favorites";
  libraryList.hidden = favorites;
  favoritesList.hidden = !favorites;
  document.querySelectorAll("[data-library-filter]").forEach(button => {
    const active = button.dataset.libraryFilter === filter;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function bindLibraryFilters() {
  document.querySelectorAll("[data-library-filter]").forEach(button => {
    button.addEventListener("click", () => setLibraryFilter(button.dataset.libraryFilter));
  });
}

let lastRecentSignature = "";

function renderCollectionsNow() {
  const play = track => selectAndPlayTrack(track, { context: "user" });

  ui.renderCollection("library", library.getLibrary(), track => ({
    play,
    favorite: toggleFavorite,
    isFavorite: library.isFavorite(track.videoId),
    remove: item => {
      library.remove(item.videoId);
      refreshCollections();
      ui.toastMessage("Canción eliminada de tu biblioteca.");
    },
    add: addToQueue
  }));

  ui.renderCollection("favorites", library.getFavorites(), () => ({
    play,
    favorite: toggleFavorite,
    isFavorite: true,
    add: addToQueue
  }));

  ui.renderCollection("history", library.getHistory(), track => ({
    play,
    favorite: toggleFavorite,
    isFavorite: library.isFavorite(track.videoId),
    add: addToQueue
  }));

  // // Recientes de inicio: solo se re-pintan si cambió la lista
  const recent = document.getElementById("homeRecentList");
  if (!recent) return;
  const tracks = library.getHistory().slice(0, 6);
  const signature = tracks.map(track => track.videoId).join(",");
  if (signature === lastRecentSignature && recent.childElementCount) return;
  lastRecentSignature = signature;
  recent.replaceChildren();
  if (!tracks.length) {
    recent.append(makeElement("p", "muted", "Tus canciones recientes aparecerán aquí."));
    return;
  }
  tracks.forEach(track => {
    const row = makeElement("button", "track-row shunel-recent-track");
    row.type = "button";
    const image = makeElement("img");
    image.src = getTrackArtwork(track);
    image.alt = "";
    image.loading = "lazy";
    image.decoding = "async";
    const text = makeElement("span", "track-row-text");
    text.append(makeElement("strong", "", track.title || "Sin título"));
    text.append(makeElement("small", "", getArtist(track)));
    row.append(image, text);
    row.addEventListener("click", () => play(track));
    recent.append(row);
  });
}

/* =========================================================================
   // 8. COLA (prioridad: usuario → contexto → autoplay)
   ========================================================================= */

function isAutoplayItem(track) {
  return track?.source === "autoplay" || autoplayIds.has(track?.videoId);
}

function firstAutoplayIndex() {
  return queue.getItems().findIndex(isAutoplayItem);
}

function renderQueueNow() {
  ui.renderQueue(
    queue.getItems(),
    currentTrack?.videoId,
    (track, index) => {
      // // Tocar una canción de la cola: saltar hasta ella sin perder el resto
      const items = queue.getItems();
      const at = items[index]?.videoId === track?.videoId ? index : items.findIndex(item => item.videoId === track?.videoId);
      if (at > 0) queue.moveToTop(at);
      if (at < 0) { selectAndPlayTrack(track, { context: "queue" }); return; }
      playNext({ reason: "switch" });
    },
    index => {
      const item = queue.getItems()[index];
      queue.remove(index);
      if (item) autoplayIds.delete(item.videoId);
    }
  );
}

function toggleQueuePanel(open) {
  queuePanelOpen = Boolean(open);
  ui.toggleQueue(queuePanelOpen);
  document.querySelectorAll("#queueToggle, #fullPlayerQueue, #fullQueueToggle").forEach(button => {
    button.setAttribute("aria-expanded", String(queuePanelOpen));
  });
}

function bindQueueEvents() {
  document.getElementById("queueToggle")?.addEventListener("click", () => toggleQueuePanel(!queuePanelOpen));
  document.getElementById("closeQueue")?.addEventListener("click", () => toggleQueuePanel(false));
  document.getElementById("clearQueue")?.addEventListener("click", () => {
    queue.clear();
    autoplayIds.clear();
    ui.toastMessage("Cola vaciada.");
  });
  document.getElementById("fullPlayerQueue")?.addEventListener("click", () => toggleQueuePanel(!queuePanelOpen));
  document.getElementById("fullQueueToggle")?.addEventListener("click", () => toggleQueuePanel(!queuePanelOpen));
}

// // Quita lo que agregó el autoplay (al cambiar de contexto, como Spotify)
function clearAutoplayItems() {
  const indices = queue.getItems().map((item, index) => (isAutoplayItem(item) ? index : -1)).filter(index => index >= 0);
  if (indices.length) queue.removeMany(indices);
  autoplayIds.clear();
}

/* =========================================================================
   // 9. ACCIONES DE BIBLIOTECA
   ========================================================================= */

function saveTrack(track) {
  if (!track?.videoId) return;
  const saved = library.save(track);
  ui.toastMessage(saved ? "Agregada a tu biblioteca." : "Ya está en tu biblioteca.");
  refreshCollections();
}

function toggleFavorite(track) {
  if (!track?.videoId) return;
  const added = library.toggleFavorite(track);
  brain.recordLike(track, added);
  ui.toastMessage(added ? "Agregada a favoritos." : "Eliminada de favoritos.");
  refreshCollections();
  if (currentTrack?.videoId === track.videoId) ui.setCurrentTrack(currentTrack, library.isFavorite(track.videoId));
}

// // "Agregar a la cola": va después de tus otras canciones, antes del autoplay
function addToQueue(track) {
  if (!track?.videoId) return;
  const clean = { ...normalizeTrack(track), source: "user" };
  autoplayIds.delete(clean.videoId);
  const added = queue.add(clean);
  if (added === false) { ui.toastMessage("La cola está llena."); return; }
  const items = queue.getItems();
  const autoIndex = items.findIndex(isAutoplayItem);
  const lastIndex = items.length - 1;
  if (autoIndex >= 0 && autoIndex < lastIndex) queue.move(lastIndex, autoIndex);
  ui.toastMessage("Agregada a la cola.");
}

/* =========================================================================
   // 10. REPRODUCCIÓN (núcleo)
   ========================================================================= */

// // Cierra la canción actual y le cuenta al cerebro cuánto se escuchó
function finishCurrent(reason) {
  if (!currentTrack || playback.pendingResume || playback.finished) return;
  playback.finished = true;
  tickListened();
  brain.recordListen(currentTrack, {
    listened: playback.listened,
    duration: playback.lastDuration || getDuration(),
    reason
  });
  playback.listened = 0;
}

// // context: "user" (elegida a mano) | "queue" | "autoplay" | "previous" | "restore"
async function playUnresolved(track, options) {
  const token = ++unresolvedToken;
  ui.toastMessage(`Buscando "${track.title}"...`);
  try {
    const resolved = await resolveRecommendation(track);
    if (token !== unresolvedToken) return;
    if (!resolved?.videoId) { ui.toastMessage("No encontramos esta canción en YouTube ahora mismo."); return; }
    selectAndPlayTrack({ ...track, ...resolved, needsResolve: false }, options);
  } catch (error) {
    if (token === unresolvedToken) ui.toastMessage(error?.message || "No se pudo buscar la canción.");
  }
}

function selectAndPlayTrack(inputTrack, options = {}) {
  if (!inputTrack?.videoId && !inputTrack?.id) {
    if (inputTrack?.needsResolve && inputTrack.title) void playUnresolved(inputTrack, options);
    return;
  }
  unresolvedToken += 1;
  const { context = "user", reason = "switch", resumeAt = 0 } = options || {};
  const original = normalizeTrack(inputTrack);
  const track = normalizeTrack(applyModToTrack(original));
  if (!track?.videoId) return;

  if (currentTrack && currentTrack.videoId !== track.videoId) finishCurrent(reason);

  // // Elegir algo nuevo cambia el contexto: el autoplay viejo ya no aplica
  if (context === "user") clearAutoplayItems();

  playback.token += 1;
  playback.finished = false;
  playback.phase = "loading";
  playback.listened = 0;
  playback.lastTick = 0;
  playback.lastPosition = 0;
  playback.lastDuration = 0;
  playback.retried = false;
  playback.pendingResume = false;
  playback.resumeAt = resumeAt > 5 ? resumeAt : 0;
  autoplayIds.delete(track.videoId);

  currentTrack = track;
  queue.setCurrent(track);
  library.addHistory(track);
  ui.setCurrentTrack(track, library.isFavorite(track.videoId));
  setFullPlayerBackground(track);
  applyArtwork(track, getTrackArtwork(track));
  void loadArtwork(track).catch(error => console.warn("[Shunel] Artwork:", error));
  document.dispatchEvent(new CustomEvent("shunel:track-change", { detail: { track, originalTrack: original } }));

  triggerIOSAudioContext();
  loadLyricsForTrack(track);
  isPlaying = false;
  ui.setPlaying(false);
  ui.setProgress(0, 0);
  updateMediaMetadata(track);
  updateMediaPlaybackState(true);
  refreshCollections();
  refreshQueue();
  saveResumeState(true);

  if (!player) {
    ui.toastMessage("El reproductor todavía se está cargando.");
    return;
  }
  try {
    ui.setPlaybackLoading(true);
    player.play(track.videoId);
    armWatchdog(playback.token);
  } catch (error) {
    console.error("[Shunel] Error al reproducir:", error);
    ui.setPlaybackError("No se pudo iniciar la canción.");
  }
}

// // Si a los 8 s no empezó, iOS bloqueó el autoplay: pedir un toque
function armWatchdog(token) {
  clearTimeout(playback.watchdog);
  playback.watchdog = setTimeout(() => {
    if (token !== playback.token || playback.phase !== "loading") return;
    // // Sigue cargando (red lenta): esperar otro ciclo
    if (safeNumber(() => player?.getPlayerState?.(), -1) === YT_STATE.BUFFERING && !playback.watchdogRetried) {
      playback.watchdogRetried = true;
      armWatchdog(token);
      return;
    }
    playback.watchdogRetried = false;
    ui.setPlaybackLoading(false);
    ui.toastMessage(navigator.onLine === false ? "Sin conexión. Revisa tu internet." : "Toca reproducir para continuar.");
  }, 8000);
}

/* =========================================================================
   // 11. PUENTE DE EVENTOS: RADIO / TOP 50 / EXTERNOS
   ========================================================================= */

document.addEventListener("shunel:play-request", event => {
  const requested = event.detail?.track || event.detail;
  if (requested?.videoId || requested?.id || (requested?.needsResolve && requested?.title)) {
    event.preventDefault();
    selectAndPlayTrack(requested, { context: event.detail?.context || "user" });
  } else if (requested?.title && requested?.artist) {
    event.preventDefault();
    void playChartTrack(requested);
  }
});

/* =========================================================================
   // 12. AUTOPLAY INFINITO ("A continuación")
   ========================================================================= */

function localCandidates() {
  const make = (tracks, source) => tracks.map((track, rank, list) => ({ track: normalizeTrack(track), source, rank, total: list.length }));
  return [
    ...make(library.getFavorites(), "favorites"),
    ...make(library.getLibrary(), "library"),
    ...make(library.getHistory().slice(10), "history")
  ];
}

async function fetchAutoplayTracks(seed, limit = 5) {
  autoplayController?.abort();
  const controller = new AbortController();
  autoplayController = controller;
  let candidates = [];
  const exclude = [...queue.getItems(), ...queue.getHistory().slice(-25)];
  try {
    const recommended = await getRecommendations(normalizeTrack(seed), {
      signal: controller.signal,
      limit: 20,
      exclude: exclude.map(item => item?.videoId).filter(Boolean)
    });
    if (controller.signal.aborted) return [];
    candidates = (Array.isArray(recommended) ? recommended : [])
      .map((track, rank, list) => ({ track: normalizeTrack(track), source: "recs", rank, total: list.length }));
  } catch (error) {
    if (error?.name === "AbortError") return [];
    console.info("[Shunel] Recomendaciones no disponibles; usando biblioteca.", error?.message || error);
  }
  // // Mezcla: recomendaciones primero, tu biblioteca como respaldo
  let ranked = brain.rankCandidates([...candidates, ...localCandidates()], seed, { limit, exclude });
  // // Sesión muy larga y todo filtrado: relajar y permitir repetidas viejas
  if (!ranked.length) {
    ranked = brain.rankCandidates(localCandidates(), seed, { limit, exclude: [currentTrack].filter(Boolean), explore: 0.3 });
  }
  return ranked;
}

// // Rellena la cola por adelantado (al 50 % o a 25 s del final)
async function ensureAutoplayBuffer(token = playback.token) {
  if (!brain.settings.autoplay || !currentTrack || sleep.mode === "track") return;
  if (queue.getRepeatMode() !== "off") return; // // repetir manda sobre autoplay
  if (playback.prefetchToken === token) return;
  if (queue.getItems().length >= 2) return;
  playback.prefetchToken = token;
  const seed = currentTrack;
  const tracks = await fetchAutoplayTracks(seed, 5);
  if (token !== playback.token || !tracks.length) return;
  tracks.forEach(track => {
    if (queue.contains?.(track.videoId)) return;
    if (queue.add({ ...track, source: "autoplay" }) !== false) autoplayIds.add(track.videoId);
  });
}

async function triggerSmartAutoplay() {
  if (brain.settings.autoplay && currentTrack) {
    const token = playback.token;
    const tracks = await fetchAutoplayTracks(currentTrack, 5);
    if (token !== playback.token) return;
    if (tracks.length) {
      const [first, ...rest] = tracks;
      rest.forEach(track => {
        if (queue.add({ ...track, source: "autoplay" }) !== false) autoplayIds.add(track.videoId);
      });
      ui.toastMessage("Autoplay: música parecida a lo que escuchas.");
      selectAndPlayTrack(first, { context: "autoplay", reason: "ended" });
      return;
    }
  }
  stopAtQueueEnd();
}

function stopAtQueueEnd() {
  isPlaying = false;
  playback.phase = "ended";
  pauseIOSAudioContext();
  player?.pause?.();
  ui.setPlaying(false);
  ui.setPlaybackLoading(false);
  updateMediaPlaybackState(false);
  ui.toastMessage(brain.settings.autoplay ? "La cola terminó." : "La cola terminó. Activa Autoplay para seguir escuchando.");
}

/* =========================================================================
   // 13. SIGUIENTE / ANTERIOR / PLAY-PAUSA
   ========================================================================= */

// // reason: "skip" (botón) | "ended" (terminó) | "error" | "switch"
function playNext(options = {}) {
  const reason = options?.reason || "skip";
  if (reason !== "error") playback.errorStreak = 0;
  const repeatOne = queue.getRepeatMode() === "one";

  // // Repetir una + terminó: la misma canción desde 0, sin recargar
  if (repeatOne && reason === "ended" && currentTrack) {
    finishCurrent("ended");
    playback.finished = false;
    playback.listened = 0;
    seekTo(0);
    player?.resume?.();
    return;
  }

  finishCurrent(reason);

  // // Con "repetir una", el botón siguiente sí avanza (como Spotify)
  let next;
  if (repeatOne) {
    queue.repeat = "off";
    next = queue.takeNext();
    queue.repeat = "one";
  } else {
    next = queue.takeNext();
  }

  if (next) selectAndPlayTrack(next, { context: isAutoplayItem(next) ? "autoplay" : "queue", reason });
  else void triggerSmartAutoplay();
}

function playPrevious() {
  if (!player || !currentTrack) return;
  if (getPosition() > 3) { seekTo(0); return; }
  // // 1º: historial de la sesión (la actual vuelve a "A continuación")
  finishCurrent("switch");
  const previous = queue.playPrevious();
  if (previous?.videoId && previous.videoId !== currentTrack.videoId) {
    selectAndPlayTrack(previous, { context: "previous", reason: "switch" });
    return;
  }
  // // 2º: historial guardado de la biblioteca
  const history = library.getHistory();
  const fallback = history.find(track => track.videoId !== currentTrack.videoId);
  if (fallback) selectAndPlayTrack(fallback, { context: "previous", reason: "switch" });
  else seekTo(0);
}

// // Play cuando la canción viene de una sesión restaurada
function resumeOrStart() {
  if (playback.pendingResume && currentTrack) {
    selectAndPlayTrack(currentTrack, { context: "restore", resumeAt: playback.resumeAt });
    return;
  }
  player?.resume?.();
}

function togglePlayback() {
  if (!currentTrack) { ui.toastMessage("Primero elige una canción."); return; }
  if (playback.pendingResume) { triggerIOSAudioContext(); resumeOrStart(); return; }
  if (isPlaying) pauseIOSAudioContext();
  else triggerIOSAudioContext();
  player?.toggle();
}

/* =========================================================================
   // 14. SHUFFLE INTELIGENTE + REPETIR
   ========================================================================= */

function isShuffleOn() { return Boolean(brain.settings.shuffle); }

function toggleShuffle() {
  const items = queue.getItems();
  const userItems = items.filter(item => !isAutoplayItem(item));
  const autoItems = items.filter(isAutoplayItem);
  if (!isShuffleOn()) {
    Storage.saveShuffleState(true, userItems);
    try { localStorage.setItem(SHUFFLE_KEY, JSON.stringify(userItems.map(item => item.videoId))); } catch {}
    if (userItems.length > 1) queue.replaceQueue([...brain.smartShuffle(userItems), ...autoItems]);
    brain.setSetting("shuffle", true);
    ui.toastMessage("Aleatorio activado.");
  } else {
    const savedIds = readOriginalOrder();
    const byId = new Map(userItems.map(item => [item.videoId, item]));
    const restored = savedIds.map(id => byId.get(id)).filter(Boolean);
    const restoredIds = new Set(restored.map(item => item.videoId));
    const extra = userItems.filter(item => !restoredIds.has(item.videoId));
    if (restored.length) queue.replaceQueue([...restored, ...extra, ...autoItems]);
    Storage.saveShuffleState(false, null);
    brain.setSetting("shuffle", false);
    ui.toastMessage("Aleatorio desactivado.");
  }
  autoItems.forEach(item => autoplayIds.add(item.videoId));
  syncControlChips();
}

function readOriginalOrder() {
  try {
    const ids = JSON.parse(localStorage.getItem(SHUFFLE_KEY) || "[]");
    return Array.isArray(ids) ? ids : [];
  } catch { return []; }
}

const REPEAT_LABEL = { off: "Repetir: no", all: "Repetir: todo", one: "Repetir: una" };

function cycleRepeat() {
  const order = ["off", "all", "one"];
  const next = order[(order.indexOf(queue.getRepeatMode()) + 1) % order.length];
  queue.repeatMode(next);
  Storage.saveRepeatMode(next);
  ui.toastMessage(REPEAT_LABEL[next]);
  syncControlChips();
}

function toggleAutoplay() {
  brain.setSetting("autoplay", !brain.settings.autoplay);
  if (!brain.settings.autoplay) clearAutoplayItems();
  ui.toastMessage(brain.settings.autoplay ? "Autoplay activado." : "Autoplay desactivado.");
  syncControlChips();
}

/* =========================================================================
   // 15. TEMPORIZADOR DE APAGADO (con fade de volumen)
   ========================================================================= */

function sleepLabel() {
  if (sleep.mode === "off") return "Temporizador: no";
  if (sleep.mode === "track") return "Temporizador: fin de canción";
  const minutes = Math.max(1, Math.ceil((sleep.endsAt - Date.now()) / 60000));
  return `Temporizador: ${minutes} min`;
}

function setSleepTimer(mode) {
  clearTimeout(sleep.timer);
  sleep.mode = mode;
  sleep.endsAt = 0;
  if (typeof mode === "number") {
    sleep.endsAt = Date.now() + mode * 60000;
    const check = () => {
      if (sleep.mode !== mode) return;
      if (Date.now() >= sleep.endsAt) { void fadeOutAndPause(); return; }
      syncControlChips();
      sleep.timer = setTimeout(check, Math.min(30000, sleep.endsAt - Date.now()));
    };
    sleep.timer = setTimeout(check, Math.min(30000, mode * 60000));
  }
  ui.toastMessage(sleepLabel());
  syncControlChips();
}

function cycleSleepTimer() {
  const index = SLEEP_STEPS.indexOf(sleep.mode);
  setSleepTimer(SLEEP_STEPS[(index + 1) % SLEEP_STEPS.length]);
}

// // Baja el volumen en ~6 s, pausa y lo deja como estaba
async function fadeOutAndPause() {
  if (sleep.fading) return;
  sleep.fading = true;
  const original = Number(ui.elements.volumeBar?.value ?? 75);
  const steps = 30;
  for (let i = 1; i <= steps && isPlaying; i++) {
    player?.setVolume?.(original * (1 - i / steps));
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  pauseIOSAudioContext();
  player?.pause?.();
  player?.setVolume?.(original);
  sleep.fading = false;
  sleep.mode = "off";
  clearTimeout(sleep.timer);
  syncControlChips();
  ui.toastMessage("Temporizador: música pausada. Buenas noches.");
}

/* =========================================================================
   // 16. REANUDAR SESIÓN (canción + segundo exacto)
   ========================================================================= */

let lastResumeSave = 0;

function saveResumeState(force = false) {
  if (!currentTrack?.videoId) return;
  const t = Date.now();
  if (!force && t - lastResumeSave < 5000) return;
  lastResumeSave = t;
  const position = playback.pendingResume ? playback.resumeAt : getPosition();
  try {
    localStorage.setItem(RESUME_KEY, JSON.stringify({
      track: {
        videoId: currentTrack.videoId,
        title: currentTrack.title,
        artist: getArtist(currentTrack),
        channel: currentTrack.channel,
        thumbnail: getTrackArtwork(currentTrack)
      },
      position: Math.floor(position),
      at: t
    }));
    Storage.saveCurrentTrack(currentTrack);
  } catch {}
}

function restoreSession() {
  try {
    const data = JSON.parse(localStorage.getItem(RESUME_KEY) || "null");
    if (!data?.track?.videoId || Date.now() - (data.at || 0) > 7 * 24 * 60 * 60 * 1000) return;
    const track = normalizeTrack(data.track);
    currentTrack = track;
    queue.setCurrent(track, { saveHistory: false });
    playback.pendingResume = true;
    playback.resumeAt = Number(data.position) || 0;
    ui.setCurrentTrack(track, library.isFavorite(track.videoId));
    ui.setProgress(playback.resumeAt, 0);
    setFullPlayerBackground(track);
    applyArtwork(track, getTrackArtwork(track));
    updateMediaMetadata(track);
    loadLyricsForTrack(track);
  } catch {}
  // // Repetir y aleatorio guardados
  const repeat = Storage.getRepeatMode?.();
  if (repeat) queue.repeatMode(repeat);
}

/* =========================================================================
   // 17. BÚSQUEDA
   // Sin búsqueda mientras escribes: search.list tiene su propio cupo diario
   // (100 llamadas por defecto) en YouTube Data API.
   ========================================================================= */

function trackActions(track) {
  return {
    play: item => selectAndPlayTrack(item, { context: "user" }),
    favorite: toggleFavorite,
    isFavorite: library.isFavorite(track.videoId),
    save: saveTrack,
    add: addToQueue
  };
}

async function executeSearch(query, searchFunction = searchTracks) {
  const cleanQuery = String(query || "").trim();
  if (!cleanQuery) { ui.setStatus("Escribe el nombre de una canción."); return []; }
  searchController?.abort();
  const controller = new AbortController();
  searchController = controller;
  ui.setSearching(true);
  ui.setStatus("Buscando música en YouTube...");
  ui.renderSearchResults([], () => ({}));

  try {
    const response = await searchFunction(cleanQuery, controller.signal, { maxResults: 20 });
    if (controller.signal.aborted) return [];
    const tracks = Array.isArray(response) ? response.map(normalizeTrack).filter(track => track?.videoId) : [];
    // // Los videos bloqueados para insertar van al final
    tracks.sort((a, b) => Number(brain.isBlocked(a.videoId)) - Number(brain.isBlocked(b.videoId)));
    ui.renderSearchResults(tracks, trackActions);
    ui.setStatus(tracks.length ? `Encontramos ${tracks.length} resultados para "${cleanQuery}".` : "No encontramos resultados. Prueba con otra búsqueda.");
    const count = document.getElementById("resultCount");
    if (count) count.textContent = tracks.length ? `${tracks.length} resultados` : "";
    return tracks;
  } catch (error) {
    if (error?.name === "AbortError" || controller.signal.aborted) return [];
    console.error("[Shunel] Search error:", error);
    ui.setStatus(navigator.onLine === false ? "Sin conexión. Revisa tu internet." : error?.message || "No se pudo completar la búsqueda.");
    return [];
  } finally {
    if (searchController === controller) { ui.setSearching(false); searchController = null; }
  }
}

async function handleSearch(event) {
  event.preventDefault();
  ui.elements.input?.blur(); // // cierra el teclado en iPhone
  await executeSearch(ui.elements.input?.value.trim(), searchTracks);
}

function normalizeDiscoverQuery(value) {
  return String(value || "").trim().toLocaleLowerCase("es").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function bindDiscoverSearches() {
  document.addEventListener("click", event => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest("[data-search]");
    if (!button) return;
    event.preventDefault();
    const query = button.dataset.search?.trim();
    if (!query) return;
    const normalized = normalizeDiscoverQuery(query);

    if (normalized.includes("popular") || normalized.includes("mas escuchado") || normalized.includes("mas escuchados")) {
      navigateToView("home");
      document.getElementById("spotifyCostaRicaTop50")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    navigateToView("search");
    if (normalized.includes("nueva") || normalized.includes("nuevo") || normalized.includes("reciente")) {
      ui.toastMessage("Buscando los lanzamientos más recientes...");
      void executeSearch(query, searchNewTracks);
    } else if (normalized.includes("tendencia") || normalized.includes("top")) {
      void executeSearch(query, searchPopularTracks);
    } else {
      void executeSearch(query, searchTracks);
    }
  });
}

/* =========================================================================
   // 18. DESCUBRIMIENTO
   ========================================================================= */

function renderDiscoveryTracks(tracks, label = "Descubrimiento") {
  const list = document.getElementById("results");
  if (!list) return;
  const normalized = (Array.isArray(tracks) ? tracks : [])
    .map(normalizeTrack)
    .filter(track => track?.videoId && !brain.isBlocked(track.videoId));
  ui.renderSearchResults(normalized, trackActions);
  ui.setStatus(normalized.length ? `${label}: ${normalized.length} canciones.` : "No encontramos canciones para esta selección.");
  const count = document.getElementById("resultCount");
  if (count) count.textContent = normalized.length ? `${normalized.length} resultados` : "";
}

async function runDiscovery(query, mood = null) {
  discoveryController?.abort();
  const controller = new AbortController();
  discoveryController = controller;
  navigateToView("search");
  ui.setSearching(true);
  ui.setStatus("Preparando una selección de música...");
  try {
    const tracks = mood
      ? await discoverByMood(mood, { signal: controller.signal })
      : await discoverTracks(query, { signal: controller.signal });
    if (controller.signal.aborted) return;
    renderDiscoveryTracks(tracks, "Selección para descubrir");
  } catch (error) {
    if (error?.name !== "AbortError") {
      console.error("[Shunel] Discovery:", error);
      ui.setStatus(error.message || "No se pudo cargar el descubrimiento.");
    }
  } finally {
    if (discoveryController === controller) ui.setSearching(false);
  }
}

/* =========================================================================
   // 19. TOP 50 COSTA RICA (búsqueda difusa del mejor video)
   ========================================================================= */

function ensureTop50Container() {
  let container = document.getElementById("spotifyCostaRicaTop50");
  if (container) return container;
  const home = document.getElementById("view-home");
  if (!home) return null;
  container = document.createElement("section");
  container.id = "spotifyCostaRicaTop50";
  container.className = "spotify-costa-rica-top50";
  const discover = home.querySelector(".home-discover");
  if (discover?.parentNode) discover.insertAdjacentElement("afterend", container);
  else home.append(container);
  return container;
}

function getChartTrackMatch(results, chartTrack) {
  if (!Array.isArray(results) || !results.length) return null;
  let best = null, bestScore = -Infinity;
  for (const result of results) {
    if (!result?.videoId || brain.isBlocked(result.videoId)) continue;
    const score = scoreSearchMatch(result, chartTrack);
    if (score > bestScore) { bestScore = score; best = result; }
  }
  return best;
}

async function playChartTrack(chartTrack) {
  if (!chartTrack?.artist || !chartTrack?.title) { ui.toastMessage("No se pudo identificar esta canción del ranking."); return; }
  const query = `${chartTrack.artist} ${chartTrack.title}`.trim();
  navigateToView("search");
  if (ui.elements.input) ui.elements.input.value = query;
  ui.toastMessage(`Buscando "${chartTrack.title}" en YouTube...`);
  const results = await executeSearch(query, searchTracks);
  if (!results.length) { ui.toastMessage("No encontramos esta canción en YouTube."); return; }
  const selected = getChartTrackMatch(results, chartTrack);
  if (!selected?.videoId) { ui.toastMessage("Encontramos resultados, pero ninguno se puede reproducir."); return; }
  selectAndPlayTrack(selected, { context: "user" });
}

function initializeCostaRicaTop50() {
  if (top50Initialized) return costaRicaTop50;
  const container = ensureTop50Container();
  if (!container) return null;
  // // Evita inicializar dos veces si el script inline del HTML ya lo hizo
  if (container.querySelector(".shunel-chart__heading")) {
    top50Initialized = true;
    return window.shunelTop50 || null;
  }
  top50Initialized = true;
  try {
    const result = initCostaRicaTop50({
      searchTracks,
      onPlay: playChartTrack,
      container: "#spotifyCostaRicaTop50"
    });
    costaRicaTop50 = result || null;
    if (result?.then) {
      result.then(instance => { costaRicaTop50 = instance || null; window.shunelTop50 = costaRicaTop50; }).catch(error => {
        top50Initialized = false;
        console.error("[Shunel] Error al inicializar Top 50:", error);
      });
    }
    window.shunelTop50 = costaRicaTop50;
    return costaRicaTop50;
  } catch (error) {
    top50Initialized = false;
    console.error("[Shunel] No se pudo inicializar Top 50:", error);
    ui.toastMessage("No se pudo iniciar el Top 50 de Costa Rica.");
    return null;
  }
}

/* =========================================================================
   // 20. PANEL DE FUNCIONES: controles, ánimo, radio
   ========================================================================= */

function makeChip(id, label) {
  const button = makeElement("button", "filter-chip", label);
  button.type = "button";
  button.id = id;
  return button;
}

function ensureFeaturePanel() {
  const home = document.getElementById("view-home");
  if (!home) return null;
  let panel = document.getElementById("shunelFeatures");
  if (panel) return panel;
  panel = makeElement("section", "shunel-features");
  panel.id = "shunelFeatures";
  panel.setAttribute("aria-label", "Funciones musicales de Shunel");

  const heading = makeElement("div", "section-heading");
  const headingText = makeElement("div");
  headingText.append(makeElement("p", "eyebrow", "TU EXPERIENCIA"), makeElement("h2", "", "Más música para ti"));
  heading.append(headingText);
  panel.append(heading);

  // // Controles inteligentes (nuevos)
  const controls = makeElement("div", "shunel-feature-block");
  controls.append(makeElement("h3", "", "Reproducción inteligente"));
  const controlActions = makeElement("div", "shunel-feature-actions");
  controlActions.append(
    makeChip("shunelAutoplayToggle", "Autoplay"),
    makeChip("shunelShuffleToggle", "Aleatorio"),
    makeChip("shunelRepeatToggle", REPEAT_LABEL.off),
    makeChip("shunelSleepToggle", "Temporizador: no")
  );
  controls.append(controlActions);

  const discovery = makeElement("div", "shunel-feature-block");
  discovery.append(makeElement("h3", "", "Descubre por estado de ánimo"));
  const moods = makeElement("div", "shunel-feature-actions");
  [
    ["energia", "Energía"], ["tranquilo", "Tranquilo"], ["fiesta", "Fiesta"],
    ["romantico", "Romántico"], ["enfoque", "Concentración"]
  ].forEach(([mood, label]) => {
    const button = makeElement("button", "filter-chip", label);
    button.type = "button";
    button.dataset.mood = mood;
    moods.append(button);
  });
  discovery.append(moods);

  const radio = makeElement("div", "shunel-feature-block");
  radio.append(makeElement("h3", "", "Radio y recomendaciones"));
  const radioActions = makeElement("div", "shunel-feature-actions");
  const radioButton = makeElement("button", "text-button", "Iniciar radio del artista actual");
  radioButton.type = "button";
  radioButton.id = "shunelStartRadio";
  const recommendationsButton = makeElement("button", "text-button", "Recomendar canciones similares");
  recommendationsButton.type = "button";
  recommendationsButton.id = "shunelGetRecommendations";
  const stopRadioButton = makeElement("button", "text-button", "Detener radio");
  stopRadioButton.type = "button";
  stopRadioButton.id = "shunelStopRadio";
  radioActions.append(radioButton, recommendationsButton, stopRadioButton);
  radio.append(radioActions);
  const radioResults = makeElement("div", "shunel-radio-section");
  radioResults.id = "shunelRadioResults";
  radio.append(radioResults);

  panel.append(controls, discovery, radio);
  const chart = document.getElementById("spotifyCostaRicaTop50");
  if (chart?.parentNode) chart.insertAdjacentElement("beforebegin", panel);
  else home.append(panel);
  return panel;
}

// // Refleja el estado real en los chips (aria-pressed + clase active)
function syncControlChips() {
  const set = (id, active, label) => {
    const button = document.getElementById(id);
    if (!button) return;
    button.classList.toggle("active", Boolean(active));
    button.setAttribute("aria-pressed", String(Boolean(active)));
    if (label) button.textContent = label;
  };
  set("shunelAutoplayToggle", brain.settings.autoplay, brain.settings.autoplay ? "Autoplay: sí" : "Autoplay: no");
  set("shunelShuffleToggle", isShuffleOn(), isShuffleOn() ? "Aleatorio: sí" : "Aleatorio: no");
  set("shunelRepeatToggle", queue.getRepeatMode() !== "off", REPEAT_LABEL[queue.getRepeatMode()] || REPEAT_LABEL.off);
  set("shunelSleepToggle", sleep.mode !== "off", sleepLabel());
}

function renderRadioTracks(tracks, artist = "Radio Shunel") {
  const root = document.getElementById("shunelRadioResults");
  if (!root) return;
  root.replaceChildren();
  radioTracks = Array.isArray(tracks)
    ? tracks.map(normalizeTrack).filter(track => (track?.videoId && !brain.isBlocked(track.videoId)) || (!track?.videoId && track?.needsResolve))
    : [];
  const header = makeElement("div", "shunel-feature-actions");
  header.append(makeElement("p", "muted", radioTracks.length ? `${artist} · ${radioTracks.length} canciones` : "No hay canciones para mostrar."));
  // // Nuevo: reproducir toda la radio de una vez
  if (radioTracks.length > 1) {
    const playAll = makeElement("button", "text-button", "Reproducir todo");
    playAll.type = "button";
    playAll.addEventListener("click", () => playTrackList(radioTracks));
    header.append(playAll);
  }
  root.append(header);
  radioTracks.forEach((track, index) => {
    const row = makeElement("div", "shunel-radio-track");
    const image = makeElement("img");
    image.src = getTrackArtwork(track);
    image.alt = "";
    image.loading = "lazy";
    image.decoding = "async";
    const details = makeElement("div");
    details.append(makeElement("div", "shunel-radio-track-title", track.title || "Sin título"));
    details.append(makeElement("div", "shunel-radio-track-artist", getArtist(track)));
    const play = makeElement("button", "text-button", "Reproducir");
    play.type = "button";
    play.addEventListener("click", () => {
      const state = getRadioState();
      if (state?.tracks?.[index]) playRadioTrack(index);
      else selectAndPlayTrack(track, { context: "user" });
    });
    row.append(image, details, play);
    root.append(row);
  });
}

// // Reproduce la primera y pone el resto en la cola (en orden o aleatorio)
function playTrackList(tracks) {
  const list = (tracks || []).filter(track => track?.videoId);
  if (!list.length) return;
  const ordered = isShuffleOn() ? brain.smartShuffle(list) : list;
  const [first, ...rest] = ordered;
  selectAndPlayTrack(first, { context: "user" });
  queue.addMany?.(rest.map(track => ({ ...track, source: "user" })));
  ui.toastMessage(`Reproduciendo ${ordered.length} canciones.`);
}

async function startCurrentArtistRadio() {
  if (!currentTrack) { ui.toastMessage("Primero reproduce una canción para iniciar su radio."); return; }
  const artist = cleanArtist(getArtist(currentTrack)) || getArtist(currentTrack);
  const root = document.getElementById("shunelRadioResults");
  if (root) root.textContent = `Cargando radio de ${artist}...`;
  try {
    const tracks = await startRadio(artist, { limit: 15 });
    renderRadioTracks(tracks, `Radio de ${artist}`);
    if (!tracks.length) ui.toastMessage("No encontramos canciones para esta radio.");
  } catch (error) {
    console.error("[Shunel] Artist radio:", error);
    if (root) root.textContent = error.message || "No se pudo cargar la radio.";
    ui.toastMessage(error.message || "No se pudo cargar la radio.");
  }
}

async function loadCurrentRecommendations() {
  if (!currentTrack) { ui.toastMessage("Primero reproduce una canción."); return; }
  recommendationController?.abort();
  const controller = new AbortController();
  recommendationController = controller;
  const root = document.getElementById("shunelRadioResults");
  if (root) root.textContent = "Buscando canciones similares...";
  try {
    const tracks = await getRecommendations(currentTrack, {
      signal: controller.signal,
      limit: 20,
      lazy: true,
      exclude: queue.getHistory().slice(-25).map(item => item?.videoId).filter(Boolean)
    });
    if (controller.signal.aborted) return;
    // // Con videoId: ordenadas por el cerebro (gusto + diversidad). Sin videoId: se resuelven al tocarlas
    const playable = tracks.filter(track => track.videoId);
    const pending = tracks.filter(track => !track.videoId).map(normalizeTrack);
    const candidates = playable.map((track, rank, list) => ({ track: normalizeTrack(track), source: "recs", rank, total: list.length }));
    const ranked = brain.rankCandidates(candidates, currentTrack, { limit: 15, explore: 0 });
    renderRadioTracks([...(ranked.length ? ranked : playable), ...pending].slice(0, 20), "Recomendaciones");
    if (!tracks.length) {
      if (root) root.textContent = tracks.degraded ? "Las recomendaciones están limitadas por ahora. Inténtalo más tarde." : "No encontramos recomendaciones.";
      ui.toastMessage(tracks.degraded ? "Recomendaciones limitadas por ahora." : "No encontramos recomendaciones.");
    }
  } catch (error) {
    if (error.name !== "AbortError") {
      console.error("[Shunel] Recommendations:", error);
      if (root) root.textContent = error.message || "No se pudieron cargar recomendaciones.";
      ui.toastMessage(error.message || "No se pudieron cargar recomendaciones.");
    }
  }
}

/* =========================================================================
   // 21. SHUNEL AI (con más contexto musical)
   ========================================================================= */

function ensureAISection() {
  const home = document.getElementById("view-home");
  if (!home || document.getElementById("shunelAI")) return;
  const section = makeElement("section", "shunel-feature-block shunel-ai");
  section.id = "shunelAI";
  section.append(makeElement("p", "eyebrow", "ASISTENTE MUSICAL"), makeElement("h2", "", "Habla con Shunel AI"));
  const messages = makeElement("div", "shunel-ai-messages");
  messages.id = "shunelAIMessages";
  messages.setAttribute("role", "log");
  messages.setAttribute("aria-live", "polite");
  messages.append(makeElement("p", "muted", "Pregúntame por música, artistas o qué escuchar."));
  const form = makeElement("form", "shunel-ai-form");
  form.id = "shunelAIForm";
  const input = makeElement("input");
  input.id = "shunelAIInput";
  input.name = "message";
  input.type = "text";
  input.maxLength = 3000;
  input.placeholder = "Escribe tu pregunta...";
  input.autocomplete = "off";
  input.required = true;
  input.setAttribute("aria-label", "Mensaje para Shunel AI");
  const send = makeElement("button", "primary-button", "Enviar");
  send.type = "submit";
  form.append(input, send);
  section.append(messages, form);
  const features = document.getElementById("shunelFeatures");
  if (features) features.append(section);
  else home.append(section);
}

function renderAIMessage(role, content) {
  const root = document.getElementById("shunelAIMessages");
  if (!root) return;
  if (root.querySelector(".muted")) root.replaceChildren();
  const message = makeElement("p", `shunel-ai-message shunel-ai-${role}`);
  message.textContent = content;
  root.append(message);
  root.scrollTop = root.scrollHeight;
}

function buildAIContext() {
  const hour = new Date().getHours();
  return {
    currentTrack: currentTrack ? { title: cleanTitle(currentTrack.title), artist: cleanArtist(getArtist(currentTrack)) } : null,
    queueLength: queue.getItems().length,
    upNext: queue.getNextItems?.(3)?.map(track => `${cleanTitle(track.title)} — ${cleanArtist(getArtist(track))}`) || [],
    recentlyPlayed: queue.getHistory().slice(-5).map(track => `${cleanTitle(track.title)} — ${cleanArtist(getArtist(track))}`),
    topArtists: brain.topArtists(5),
    timeOfDay: hour < 12 ? "mañana" : hour < 19 ? "tarde" : "noche"
  };
}

function renderAISuggestions(suggestions) {
  const root = document.getElementById("shunelAIMessages");
  if (!root || !Array.isArray(suggestions) || !suggestions.length) return;
  const box = makeElement("div", "shunel-feature-actions shunel-ai-suggestions");
  suggestions.slice(0, 3).forEach(text => {
    const chip = makeElement("button", "filter-chip", String(text).slice(0, 80));
    chip.type = "button";
    chip.addEventListener("click", () => {
      const input = document.getElementById("shunelAIInput");
      if (!input || aiBusy) return;
      input.value = String(text);
      document.getElementById("shunelAIForm")?.requestSubmit();
    });
    box.append(chip);
  });
  root.append(box);
  root.scrollTop = root.scrollHeight;
}

// // Acciones que propone Shunel AI. Cada canción por resolver gasta una búsqueda de YouTube: máximo 3 por mensaje
async function runAIActions(actions) {
  let resolved = 0;
  let firstPlay = true;
  for (const action of (Array.isArray(actions) ? actions : []).slice(0, 5)) {
    try {
      if (action.type === "play" || action.type === "queue") {
        const base = { title: action.title, artist: action.artist, source: "ai" };
        if (action.type === "play" && firstPlay) {
          firstPlay = false;
          resolved += 1;
          selectAndPlayTrack({ ...base, needsResolve: true }, { context: "user" });
          continue;
        }
        if (resolved >= 3) continue;
        resolved += 1;
        const found = await resolveRecommendation(base);
        if (found?.videoId) addToQueue({ ...base, ...found });
      } else if (action.type === "radio" && action.artist) {
        const tracks = await startRadio(action.artist, { limit: 15 });
        renderRadioTracks(tracks, `Radio de ${action.artist}`);
      } else if (action.type === "search" && action.query) {
        navigateToView("search");
        if (ui.elements.input) ui.elements.input.value = action.query;
        void executeSearch(action.query, searchTracks);
      } else if (action.type === "mood" && action.query) {
        void runDiscovery("", action.query);
      }
    } catch (error) {
      if (error?.name !== "AbortError") ui.toastMessage(error?.message || "No se pudo completar una acción de Shunel AI.");
    }
  }
}

async function handleAIMessage(event) {
  event.preventDefault();
  if (aiBusy) return;
  const input = document.getElementById("shunelAIInput");
  const text = input?.value.trim();
  if (!text) return;
  document.querySelector("#shunelAIMessages .shunel-ai-suggestions")?.remove();
  aiMessages.push({ role: "user", content: text });
  // // Solo los últimos 20 mensajes: menos tokens, respuesta más rápida
  if (aiMessages.length > 20) aiMessages = aiMessages.slice(-20);
  renderAIMessage("user", text);
  input.value = "";
  aiBusy = true;
  const submit = document.querySelector("#shunelAIForm button[type='submit']");
  if (submit) { submit.disabled = true; submit.textContent = "Pensando..."; }
  try {
    const { reply, actions, suggestions } = await askShunelAIFull(aiMessages, { context: buildAIContext() });
    aiMessages.push({ role: "assistant", content: reply });
    renderAIMessage("assistant", reply);
    renderAISuggestions(suggestions);
    if (actions.length) void runAIActions(actions);
  } catch (error) {
    const message = error.message || "Shunel AI no está disponible.";
    renderAIMessage("assistant", message);
    ui.toastMessage(message);
  } finally {
    aiBusy = false;
    if (submit) { submit.disabled = false; submit.textContent = "Enviar"; }
    input?.focus();
  }
}

/* =========================================================================
   // 22. MOD PACKS
   ========================================================================= */

function ensureModsSection() {
  const features = document.getElementById("shunelFeatures");
  if (!features || document.getElementById("shunelMods")) return;
  const section = makeElement("section", "shunel-feature-block shunel-mods");
  section.id = "shunelMods";
  section.append(makeElement("p", "eyebrow", "PERSONALIZACIÓN"), makeElement("h2", "", "Mods de Shunel"));
  section.append(makeElement("p", "muted", "Importa un pack JSON para personalizar el nombre, la portada o los colores de una canción."));
  const importForm = makeElement("form", "shunel-mod-form");
  importForm.id = "shunelModForm";
  const textarea = makeElement("textarea");
  textarea.id = "shunelModJSON";
  textarea.rows = 4;
  textarea.placeholder = '{"id":"mi-pack","name":"Mi pack","match":{"artist":"Artista"},"override":{"title":"Nuevo título"}}';
  textarea.setAttribute("aria-label", "Contenido JSON del pack");
  const importButton = makeElement("button", "text-button", "Importar pack");
  importButton.type = "submit";
  importForm.append(textarea, importButton);
  const controls = makeElement("div", "shunel-feature-actions");
  const select = makeElement("select");
  select.id = "shunelModSelect";
  select.setAttribute("aria-label", "Pack de personalización");
  const apply = makeElement("button", "text-button", "Activar pack");
  apply.type = "button";
  apply.id = "shunelModEnable";
  const disable = makeElement("button", "text-button", "Desactivar");
  disable.type = "button";
  disable.id = "shunelModDisable";
  controls.append(select, apply, disable);
  const status = makeElement("p", "muted");
  status.id = "shunelModStatus";
  section.append(importForm, controls, status);
  features.append(section);
  refreshModSelect();
}

function refreshModSelect() {
  const select = document.getElementById("shunelModSelect");
  if (!select) return;
  const packs = listModPacks();
  select.replaceChildren();
  if (!packs.length) {
    const option = makeElement("option", "", "No hay packs importados");
    option.value = "";
    select.append(option);
  } else {
    packs.forEach(pack => {
      const option = makeElement("option", "", pack.name);
      option.value = pack.id;
      option.selected = pack.enabled;
      select.append(option);
    });
  }
}

function bindModEvents() {
  document.getElementById("shunelModForm")?.addEventListener("submit", event => {
    event.preventDefault();
    const textarea = document.getElementById("shunelModJSON");
    const status = document.getElementById("shunelModStatus");
    try {
      const pack = importModPack(textarea.value);
      refreshModSelect();
      if (status) status.textContent = `Pack "${pack.name}" importado. Ahora puedes activarlo.`;
      ui.toastMessage("Pack importado correctamente.");
    } catch (error) {
      if (status) status.textContent = error.message || "El JSON no es válido.";
      ui.toastMessage(error.message || "No se pudo importar el pack.");
    }
  });
  document.getElementById("shunelModEnable")?.addEventListener("click", () => {
    const id = document.getElementById("shunelModSelect")?.value;
    if (!id) { ui.toastMessage("Primero importa un pack."); return; }
    try {
      enableModPack(id);
      refreshModSelect();
      const pack = listModPacks().find(item => item.id === id);
      const status = document.getElementById("shunelModStatus");
      if (status) status.textContent = `Pack activo: ${pack?.name || id}. Se aplicará a las próximas canciones que coincidan.`;
      ui.toastMessage("Pack activado.");
    } catch (error) { ui.toastMessage(error.message); }
  });
  document.getElementById("shunelModDisable")?.addEventListener("click", () => {
    disableModPack();
    refreshModSelect();
    const status = document.getElementById("shunelModStatus");
    if (status) status.textContent = "Personalización desactivada.";
    ui.toastMessage("Pack desactivado.");
  });
}

/* =========================================================================
   // 23. REPRODUCTOR GRANDE + CONTROLES
   ========================================================================= */

function openFullPlayer() {
  if (!currentTrack) { ui.toastMessage("Primero elige una canción."); return; }
  ui.toggleFullPlayer(true);
}

function closeFullPlayer() { ui.toggleFullPlayer(false); }

function handleSeekInput(event) {
  if (!player) return;
  const duration = getDuration();
  if (playback.pendingResume) { playback.resumeAt = Number(event.target.value) || 0; return; }
  seekTo(Math.max(0, Math.min(Number(event.target.value), duration || Infinity)));
}

function bindFullPlayerEvents() {
  document.getElementById("closeFullPlayer")?.addEventListener("click", closeFullPlayer);
  document.getElementById("openNativePlayer")?.addEventListener("click", () => {
    if (!currentTrack?.videoId) { ui.toastMessage("Primero reproduce una canción."); return; }
    const url = `https://www.youtube.com/watch?v=${encodeURIComponent(currentTrack.videoId)}`;
    try { window.open(url, "_blank", "noopener,noreferrer"); }
    catch { ui.toastMessage("No se pudo abrir el reproductor externo."); }
  });
  document.getElementById("fullPlayButton")?.addEventListener("click", togglePlayback);
  document.getElementById("fullPreviousButton")?.addEventListener("click", playPrevious);
  document.getElementById("fullNextButton")?.addEventListener("click", () => playNext());
  document.getElementById("fullPlayerFavorite")?.addEventListener("click", () => { if (currentTrack) toggleFavorite(currentTrack); });
  document.getElementById("fullProgressBar")?.addEventListener("change", handleSeekInput);
}

function bindPlayerEvents() {
  ui.elements.playButton?.addEventListener("click", togglePlayback);
  ui.elements.nextButton?.addEventListener("click", () => playNext());
  ui.elements.previousButton?.addEventListener("click", playPrevious);
  ui.elements.favoriteCurrent?.addEventListener("click", () => { if (currentTrack) toggleFavorite(currentTrack); });
  ui.elements.volumeBar?.addEventListener("input", event => player?.setVolume(Number(event.target.value)));
  ui.elements.progressBar?.addEventListener("change", handleSeekInput);
  document.querySelector(".player-dock")?.addEventListener("click", event => {
    if (event.target.closest("button") || event.target.closest("input")) return;
    openFullPlayer();
  });
  bindFullPlayerEvents();
}

function bindControlChips() {
  document.getElementById("shunelAutoplayToggle")?.addEventListener("click", toggleAutoplay);
  document.getElementById("shunelShuffleToggle")?.addEventListener("click", toggleShuffle);
  document.getElementById("shunelRepeatToggle")?.addEventListener("click", cycleRepeat);
  document.getElementById("shunelSleepToggle")?.addEventListener("click", cycleSleepTimer);
  syncControlChips();
}

/* =========================================================================
   // 24. ATAJOS DE TECLADO (iPad con teclado / escritorio)
   // "/" y Ctrl+K ya los maneja index.html
   ========================================================================= */

function bindKeyboard() {
  document.addEventListener("keydown", event => {
    if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    if (isTypingTarget(event.target)) return;
    const key = event.key;
    const lower = key.length === 1 ? key.toLowerCase() : key;
    const onButton = event.target instanceof Element && event.target.closest("button, a");

    if (key === "Escape") {
      if (queuePanelOpen) { toggleQueuePanel(false); event.preventDefault(); }
      else if (ui.state?.fullPlayerOpen) { closeFullPlayer(); event.preventDefault(); }
      return;
    }
    if (key === " " || lower === "k") {
      if (key === " " && onButton) return; // // espacio sobre un botón = clic normal
      event.preventDefault(); togglePlayback(); return;
    }
    if (key === "ArrowRight" && event.shiftKey) { event.preventDefault(); playNext(); return; }
    if (key === "ArrowLeft" && event.shiftKey) { event.preventDefault(); playPrevious(); return; }
    if (key === "ArrowRight") { event.preventDefault(); seekBy(5); return; }
    if (key === "ArrowLeft") { event.preventDefault(); seekBy(-5); return; }
    if (lower === "m") {
      playback.muted = !playback.muted;
      if (playback.muted) player?.mute?.(); else player?.unmute?.();
      ui.toastMessage(playback.muted ? "Silenciado." : "Sonido activado.");
      return;
    }
    if (lower === "l" && currentTrack) { toggleFavorite(currentTrack); return; }
    if (lower === "s") { toggleShuffle(); return; }
    if (lower === "r") { cycleRepeat(); return; }
    if (lower === "q") { toggleQueuePanel(!queuePanelOpen); return; }
    if (lower === "f" && currentTrack) { ui.toggleFullPlayer(!ui.state?.fullPlayerOpen); }
  });
}

/* =========================================================================
   // 25. PROGRESO + LETRAS (250 ms visible, 1 s en segundo plano)
   ========================================================================= */

// // Suma tiempo escuchado de verdad (no cuenta pausas ni saltos)
function tickListened() {
  const t = performance.now();
  if (isPlaying && playback.lastTick) playback.listened += Math.min(2, (t - playback.lastTick) / 1000);
  playback.lastTick = isPlaying ? t : 0;
}

let lastMediaPositionAt = 0;

function progressTick() {
  if (!player || !isPlaying) return;
  tickListened();
  const current = getPosition();
  const duration = getDuration();
  playback.lastPosition = current;
  if (duration > 0) playback.lastDuration = duration;
  if (!document.hidden) {
    ui.setProgress(current, duration);
    syncLyricsProgress(current);
  }
  // // La pantalla de bloqueo interpola sola: actualizar cada 5 s basta
  const t = performance.now();
  if (t - lastMediaPositionAt > 5000) { lastMediaPositionAt = t; updateMediaPosition(); }
  saveResumeState();
  // // Prefetch del autoplay: al 50 % o a 25 s del final
  if (duration > 0 && (current / duration >= 0.5 || duration - current <= 25)) void ensureAutoplayBuffer(playback.token);
}

function startProgressUpdates() {
  clearInterval(progressTimer);
  playback.lastTick = performance.now();
  progressTimer = setInterval(progressTick, document.hidden ? 1000 : 250);
}

function stopProgressUpdates() {
  tickListened();
  clearInterval(progressTimer);
  progressTimer = null;
}

/* =========================================================================
   // 26. YOUTUBE PLAYER: estados y errores
   ========================================================================= */

// // 100 = no existe/privado · 101/150/153 = el autor no permite insertarlo
const UNPLAYABLE = new Set([100, 101, 150, 153]);

function handlePlayerError(code) {
  const token = playback.token;
  const numeric = Number(code);
  isPlaying = false;
  playback.phase = "error";
  stopProgressUpdates();
  ui.setPlaying(false);
  ui.setPlaybackLoading(false);
  updateMediaPlaybackState(false);
  console.warn("[Shunel] YouTube player error:", code);

  // // 2 (parámetro) / 5 (HTML5): un reintento
  if ((numeric === 2 || numeric === 5) && !playback.retried && currentTrack) {
    playback.retried = true;
    setTimeout(() => {
      if (token !== playback.token || !currentTrack) return;
      try { ui.setPlaybackLoading(true); player.play(currentTrack.videoId); } catch {}
    }, 900);
    return;
  }

  if (UNPLAYABLE.has(numeric) && currentTrack) {
    brain.block(currentTrack.videoId, numeric === 100 ? 30 * 24 * 3600 * 1000 : 7 * 24 * 3600 * 1000);
  }

  playback.errorStreak += 1;
  if (playback.errorStreak > 3) {
    playback.errorStreak = 0;
    ui.setPlaybackError("Varias canciones seguidas no se pudieron reproducir. Elige otra.");
    return;
  }
  ui.toastMessage(UNPLAYABLE.has(numeric) ? "Este video no se puede reproducir aquí. Saltando..." : "YouTube no pudo reproducir este video. Saltando...");
  setTimeout(() => {
    if (token === playback.token) playNext({ reason: "error" });
  }, 1200);
}

function handleStateChange(state) {
  const PS = window.YT?.PlayerState || YT_STATE;
  const playing = state === PS.PLAYING;

  if (state === PS.BUFFERING) { ui.setPlaybackLoading(true); return; }

  isPlaying = playing;
  ui.setPlaying(playing);
  updateMediaPlaybackState(playing);

  if (playing) {
    clearTimeout(playback.watchdog);
    ui.setPlaybackLoading(false);
    playback.phase = "playing";
    playback.errorStreak = 0;
    triggerIOSAudioContext();
    startProgressUpdates();
    updateMediaPosition();
    channel?.postMessage({ type: "playing", tabId: TAB_ID });
    // // Reanudar en el segundo guardado
    if (playback.resumeAt > 5) {
      const target = playback.resumeAt;
      playback.resumeAt = 0;
      const duration = getDuration();
      if (!duration || target < duration - 10) seekTo(target);
    }
  } else {
    if (state === PS.PAUSED) { playback.phase = "paused"; ui.setPlaybackLoading(false); }
    if (state === PS.ENDED) playback.phase = "ended";
    stopProgressUpdates();
    saveResumeState(true);
  }
}

function handleEnded() {
  playback.phase = "ended";
  if (sleep.mode === "track") {
    finishCurrent("ended");
    sleep.mode = "off";
    syncControlChips();
    pauseIOSAudioContext();
    updateMediaPlaybackState(false);
    ui.toastMessage("Temporizador: fin de la canción.");
    return;
  }
  playNext({ reason: "ended" });
}

function initializePlayer() {
  if (player) return;
  player = new YouTubePlayer("youtubePlayerHost", {
    onReady: () => {
      player.setVolume(Number(ui.elements.volumeBar?.value ?? 75));
      console.info("[Shunel] YouTube Player listo.");
    },
    onStateChange: handleStateChange,
    onEnded: handleEnded,
    onError: handlePlayerError
  });
  player.init().catch(error => {
    console.error("[Shunel] Player initialization:", error);
    ui.toastMessage("No se pudo cargar el reproductor de YouTube.");
  });
}

/* =========================================================================
   // 27. CICLO DE VIDA: pestañas, red, segundo plano
   ========================================================================= */

function bindLifecycle() {
  // // Otra pestaña empezó a sonar: esta se pausa
  if ("BroadcastChannel" in window) {
    try {
      channel = new BroadcastChannel("shunel-playback");
      channel.addEventListener("message", event => {
        if (event.data?.type === "playing" && event.data.tabId !== TAB_ID && isPlaying) {
          player?.pause?.();
          pauseIOSAudioContext();
        }
      });
    } catch {}
  }

  // // Segundo plano: tick más lento y guardar posición
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) saveResumeState(true);
    if (isPlaying) startProgressUpdates();
    if (!document.hidden && isPlaying) progressTick();
  });
  window.addEventListener("pagehide", () => {
    finishCurrentForUnload();
    saveResumeState(true);
    brain.save(true);
  });

  window.addEventListener("offline", () => ui.toastMessage("Sin conexión. La música puede detenerse."));
  window.addEventListener("online", () => {
    ui.toastMessage("Conexión recuperada.");
    if (playback.phase === "loading" && currentTrack) {
      try { player?.play?.(currentTrack.videoId); armWatchdog(playback.token); } catch {}
    }
  });

  // // Errores de promesas sin catch: se registran sin romper la app
  window.addEventListener("unhandledrejection", event => {
    if (event.reason?.name === "AbortError") { event.preventDefault(); return; }
    console.warn("[Shunel] Promesa rechazada:", event.reason);
  });
}

// // Al cerrar la app no contamos un "skip" falso: solo guardamos lo escuchado
function finishCurrentForUnload() {
  if (!currentTrack || playback.pendingResume) return;
  tickListened();
  if (playback.listened >= 30) brain.applySignal(currentTrack, 0, { plays: 1 });
}

/* =========================================================================
   // 28. EVENTOS
   ========================================================================= */

function bindFeatureEvents() {
  document.getElementById("shunelStartRadio")?.addEventListener("click", startCurrentArtistRadio);
  document.getElementById("shunelGetRecommendations")?.addEventListener("click", loadCurrentRecommendations);
  document.getElementById("shunelStopRadio")?.addEventListener("click", () => {
    stopRadio();
    radioTracks = [];
    const root = document.getElementById("shunelRadioResults");
    if (root) root.textContent = "Radio detenida.";
  });
  document.querySelectorAll("[data-mood]").forEach(button => {
    button.addEventListener("click", () => void runDiscovery("", button.dataset.mood));
  });
  document.getElementById("shunelAIForm")?.addEventListener("submit", handleAIMessage);
  bindModEvents();
  bindControlChips();
}

function bindEvents() {
  ui.elements.form?.addEventListener("submit", handleSearch);
  bindNavigation();
  bindLibraryFilters();
  bindDiscoverSearches();
  bindPlayerEvents();
  bindQueueEvents();
  queue.setOnChange(refreshQueue);
  bindFeatureEvents();
  bindKeyboard();
  bindLifecycle();
}

/* =========================================================================
   // 29. API DE DEPURACIÓN (consola: shunel.getState())
   ========================================================================= */

function exposeDebugAPI() {
  window.shunel = Object.freeze({
    getState: () => ({
      track: currentTrack ? { title: currentTrack.title, artist: getArtist(currentTrack), videoId: currentTrack.videoId } : null,
      phase: playback.phase,
      isPlaying,
      listened: Math.round(playback.listened),
      queue: queue.getItems().map(item => `${isAutoplayItem(item) ? "[auto] " : ""}${item.title}`),
      repeat: queue.getRepeatMode(),
      shuffle: isShuffleOn(),
      autoplay: brain.settings.autoplay,
      sleep: sleepLabel()
    }),
    brain: () => brain.stats(),
    resetBrain: () => brain.reset(),
    exportBrain: () => brain.exportData(),
    importBrain: data => brain.importData(data),
    play: track => selectAndPlayTrack(track, { context: "user" }),
    addToQueue,
    next: () => playNext(),
    previous: playPrevious,
    shuffle: toggleShuffle,
    repeat: cycleRepeat,
    sleep: setSleepTimer,
    artistKey,
    formatTime
  });
}

/* =========================================================================
   // 30. INICIO
   ========================================================================= */

function initialize() {
  ensureStylesheet("/css/artwork.css");
  ensureStylesheet("/css/radio.css");
  ensureFeaturePanel();
  ensureAISection();
  ensureModsSection();
  initArtwork();
  applyActiveMod();

  bindEvents();
  setupMediaSession();
  ui.setCurrentTrack(null, false);
  ui.setPlaying(false);
  updateMediaPlaybackState(false);
  restoreSession();
  syncControlChips();
  refreshCollections();
  refreshQueue();
  navigateToView("home");
  initializeCostaRicaTop50();
  initializePlayer();
  exposeDebugAPI();

  console.info("[Shunel] Aplicación v2 lista (cerebro activo).", brain.stats());
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initialize, { once: true });
} else {
  initialize();
}
