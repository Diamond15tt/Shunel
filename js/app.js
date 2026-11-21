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
import { loadLyricsForTrack, syncLyricsProgress } from "./lyrics.js";

/* Nuevos módulos de Shunel */
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
import { getRecommendations } from "./recommendations.js";
import { discoverTracks, discoverByMood } from "./discovery.js";
import { askShunelAI } from "./ai.js";

/* =========================================
   SHUNEL — APP CONTROLLER
   Playback + Lyrics + Smart Autoplay
   + Dynamic Artwork + Metadata + Mods
   + Artist Radio + Recommendations
   + Discovery + Shunel AI + Spotify CR Top 50
========================================= */

const ui = new ShunelUI();
const queue = new QueueManager();
const library = new MusicLibrary();

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
let aiMessages = [];
let aiBusy = false;
let radioTracks = [];

const mediaSession = navigator.mediaSession || null;

/* =========================================
   HELPERS
========================================= */

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

/* =========================================
   iOS SILENT AUDIO
========================================= */

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

/* =========================================
   DYNAMIC PLAYER BACKGROUND
========================================= */

let artworkColorRequest = 0;

function setFullPlayerBackground(track) {
  const fullPlayer = document.getElementById("fullPlayer");
  if (!fullPlayer || !track) return;

  const requestId = ++artworkColorRequest;
  const image = new Image();
  image.crossOrigin = "anonymous";

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

/* =========================================
   MEDIA SESSION
========================================= */

function updateMediaMetadata(track) {
  if (!mediaSession || !track) return;
  try {
    if (!("MediaMetadata" in window)) return;
    const artwork = getTrackArtwork(track);
    mediaSession.metadata = new MediaMetadata({
      title: track.title || track.name || "Reproduciendo",
      artist: getArtist(track),
      album: track.album || "Shunel",
      artwork: [
        { src: artwork, sizes: "96x96", type: "image/jpeg" },
        { src: artwork, sizes: "256x256", type: "image/jpeg" },
        { src: artwork, sizes: "512x512", type: "image/jpeg" }
      ]
    });
  } catch (error) {
    console.warn("[Shunel] No se pudo actualizar Media Session:", error);
  }
}

function updateMediaPlaybackState(playing) {
  if (!mediaSession) return;
  try { mediaSession.playbackState = playing ? "playing" : "paused"; }
  catch (error) { console.warn("[Shunel] Error de estado multimedia:", error); }
}

function updateMediaPosition() {
  if (!mediaSession || !player || typeof player.getDuration !== "function" || typeof mediaSession.setPositionState !== "function") return;
  try {
    const duration = Number(player.getDuration());
    const position = Number(player.getCurrentTime());
    if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(position)) return;
    mediaSession.setPositionState({ duration, playbackRate: 1, position: Math.min(Math.max(position, 0), duration) });
  } catch {}
}

function setupMediaSession() {
  if (!mediaSession) return;
  const actions = {
    play: () => { if (currentTrack) { triggerIOSAudioContext(); player?.resume?.(); } },
    pause: () => { pauseIOSAudioContext(); player?.pause?.(); },
    nexttrack: playNext,
    previoustrack: playPrevious,
    seekto: details => { if (Number.isFinite(details.seekTime)) player?.seekTo(details.seekTime); },
    seekbackward: details => {
      if (!player) return;
      player.seekTo(Math.max(0, (player.getCurrentTime() || 0) - (details.seekOffset || 10)));
    },
    seekforward: details => {
      if (!player) return;
      const current = player.getCurrentTime() || 0;
      const duration = player.getDuration() || 0;
      const next = current + (details.seekOffset || 10);
      player.seekTo(duration > 0 ? Math.min(duration, next) : next);
    }
  };
  Object.entries(actions).forEach(([action, handler]) => {
    try { mediaSession.setActionHandler(action, handler); } catch {}
  });
}

/* =========================================
   NAVIGATION
========================================= */

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

/* =========================================
   LIBRARY FILTERS / COLLECTIONS
========================================= */

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

function refreshCollections() {
  ui.renderCollection("library", library.getLibrary(), track => ({
    play: selectAndPlayTrack,
    favorite: toggleFavorite,
    isFavorite: library.isFavorite(track.videoId),
    remove: item => {
      library.remove(item.videoId);
      refreshCollections();
      ui.toastMessage("Canción eliminada de tu biblioteca.");
    },
    add: addToQueue
  }));

  ui.renderCollection("favorites", library.getFavorites(), track => ({
    play: selectAndPlayTrack,
    favorite: toggleFavorite,
    isFavorite: true,
    add: addToQueue
  }));

  ui.renderCollection("history", library.getHistory(), track => ({
    play: selectAndPlayTrack,
    favorite: toggleFavorite,
    isFavorite: library.isFavorite(track.videoId),
    add: addToQueue
  }));

  const recent = document.getElementById("homeRecentList");
  if (recent) {
    const tracks = library.getHistory().slice(0, 6);
    recent.replaceChildren();
    if (!tracks.length) {
      recent.append(makeElement("p", "muted", "Tus canciones recientes aparecerán aquí."));
    } else {
      tracks.forEach(track => {
        const row = makeElement("button", "track-row shunel-recent-track");
        row.type = "button";
        const image = makeElement("img");
        image.src = getTrackArtwork(track);
        image.alt = "";
        image.loading = "lazy";
        const text = makeElement("span", "track-row-text");
        text.append(makeElement("strong", "", track.title || "Sin título"));
        text.append(makeElement("small", "", getArtist(track)));
        row.append(image, text);
        row.addEventListener("click", () => selectAndPlayTrack(track));
        recent.append(row);
      });
    }
  }
}

/* =========================================
   QUEUE
========================================= */

function refreshQueue() {
  ui.renderQueue(queue.getItems(), currentTrack?.videoId, selectAndPlayTrack, index => {
    queue.remove(index);
    refreshQueue();
  });
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
    queue.clear(); refreshQueue(); ui.toastMessage("Cola vaciada.");
  });
  document.getElementById("fullPlayerQueue")?.addEventListener("click", () => toggleQueuePanel(!queuePanelOpen));
  document.getElementById("fullQueueToggle")?.addEventListener("click", () => toggleQueuePanel(!queuePanelOpen));
}

/* =========================================
   LIBRARY ACTIONS
========================================= */

function saveTrack(track) {
  if (!track?.videoId) return;
  const saved = library.save(track);
  ui.toastMessage(saved ? "Agregada a tu biblioteca." : "Ya está en tu biblioteca.");
  refreshCollections();
}

function toggleFavorite(track) {
  if (!track?.videoId) return;
  const added = library.toggleFavorite(track);
  ui.toastMessage(added ? "Agregada a favoritos." : "Eliminada de favoritos.");
  refreshCollections();
  if (currentTrack?.videoId === track.videoId) ui.setCurrentTrack(currentTrack, library.isFavorite(track.videoId));
}

function addToQueue(track) {
  if (!track?.videoId) return;
  queue.add(track);
  refreshQueue();
  ui.toastMessage("Agregada a la cola.");
}

/* =========================================
   PLAYBACK + MODS + ARTWORK + METADATA
========================================= */

function selectAndPlayTrack(inputTrack) {
  if (!inputTrack?.videoId && !inputTrack?.id) return;
  const original = normalizeTrack(inputTrack);
  const track = normalizeTrack(applyModToTrack(original));
  if (!track?.videoId) return;

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

  if (!player) {
    ui.toastMessage("El reproductor todavía se está cargando.");
    return;
  }
  try {
    player.play(track.videoId);
  } catch (error) {
    console.error("[Shunel] Error al reproducir:", error);
    ui.toastMessage("No se pudo iniciar la canción.");
  }
}

/* =========================================
   EVENT BRIDGE: RADIO / TOP 50 / EXTERNAL
========================================= */

document.addEventListener("shunel:play-request", event => {
  const requested = event.detail?.track || event.detail;
  if (requested?.videoId || requested?.id) {
    event.preventDefault();
    selectAndPlayTrack(requested);
  } else if (requested?.title && requested?.artist) {
    event.preventDefault();
    void playChartTrack(requested);
  }
});

/* =========================================
   SMART AUTOPLAY + RECOMMENDATIONS
========================================= */

function localAutoplayCandidates() {
  const all = [...library.getLibrary(), ...library.getHistory()];
  const seen = new Set();
  return all.filter(track => {
    if (!track?.videoId || track.videoId === currentTrack?.videoId || seen.has(track.videoId)) return false;
    seen.add(track.videoId);
    return true;
  });
}

async function triggerSmartAutoplay() {
  if (currentTrack) {
    recommendationController?.abort();
    recommendationController = new AbortController();
    try {
      const recommended = await getRecommendations(normalizeTrack(currentTrack), {
        signal: recommendationController.signal,
        limit: 10
      });
      if (recommendationController.signal.aborted) return;
      const usable = recommended.map(normalizeTrack).filter(track => track?.videoId && track.videoId !== currentTrack?.videoId);
      if (usable.length) {
        const next = usable[Math.floor(Math.random() * usable.length)];
        ui.toastMessage("Reproduciendo una recomendación para ti...");
        selectAndPlayTrack(next);
        return;
      }
    } catch (error) {
      console.info("[Shunel] Recomendaciones no disponibles; usando biblioteca.", error?.message || error);
    }
  }

  const candidates = localAutoplayCandidates();
  if (!candidates.length) {
    isPlaying = false;
    pauseIOSAudioContext();
    player?.pause?.();
    ui.setPlaying(false);
    updateMediaPlaybackState(false);
    ui.setCurrentTrack(null, false);
    currentTrack = null;
    ui.toastMessage("La cola terminó.");
    return;
  }

  let similar = candidates.filter(track => {
    const artistMatch = getArtist(track).toLowerCase() === getArtist(currentTrack).toLowerCase();
    const styleMatch = track.style && currentTrack?.style && track.style === currentTrack.style;
    return artistMatch || styleMatch;
  });
  if (!similar.length) similar = candidates;
  const next = similar[Math.floor(Math.random() * similar.length)];
  ui.toastMessage("Reproduciendo recomendación de tu biblioteca...");
  selectAndPlayTrack(next);
}

function playNext() {
  const next = queue.takeNext();
  refreshQueue();
  if (next) selectAndPlayTrack(next);
  else void triggerSmartAutoplay();
}

function playPrevious() {
  if (!player || !currentTrack) return;
  try {
    if (player.getCurrentTime() > 3) { player.seekTo(0); return; }
  } catch {}
  const history = library.getHistory();
  const previous = history.find(track => track.videoId !== currentTrack.videoId);
  if (previous) selectAndPlayTrack(previous);
  else { triggerIOSAudioContext(); player.play(currentTrack.videoId); }
}

function togglePlayback() {
  if (!currentTrack) { ui.toastMessage("Primero elige una canción."); return; }
  if (isPlaying) pauseIOSAudioContext();
  else triggerIOSAudioContext();
  player?.toggle();
}

/* =========================================
   SEARCH ENGINE
========================================= */

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
    const tracks = Array.isArray(response) ? response.map(normalizeTrack) : [];
    ui.renderSearchResults(tracks, track => ({
      play: selectAndPlayTrack,
      favorite: toggleFavorite,
      isFavorite: library.isFavorite(track.videoId),
      save: saveTrack,
      add: addToQueue
    }));
    ui.setStatus(tracks.length ? `Encontramos ${tracks.length} resultados para "${cleanQuery}".` : "No encontramos resultados. Prueba con otra búsqueda.");
    const count = document.getElementById("resultCount");
    if (count) count.textContent = tracks.length ? `${tracks.length} resultados` : "";
    return tracks;
  } catch (error) {
    if (error?.name === "AbortError" || controller.signal.aborted) return [];
    console.error("[Shunel] Search error:", error);
    ui.setStatus(error?.message || "No se pudo completar la búsqueda.");
    return [];
  } finally {
    if (searchController === controller) { ui.setSearching(false); searchController = null; }
  }
}

async function handleSearch(event) {
  event.preventDefault();
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
    } else {
      void executeSearch(query, searchTracks);
    }
  });
}

/* =========================================
   DISCOVERY MODULE
========================================= */

function renderDiscoveryTracks(tracks, label = "Descubrimiento") {
  const list = document.getElementById("results");
  if (!list) return;
  const normalized = (Array.isArray(tracks) ? tracks : []).map(normalizeTrack).filter(track => track?.videoId);
  ui.renderSearchResults(normalized, track => ({
    play: selectAndPlayTrack,
    favorite: toggleFavorite,
    isFavorite: library.isFavorite(track.videoId),
    save: saveTrack,
    add: addToQueue
  }));
  ui.setStatus(normalized.length ? `${label}: ${normalized.length} canciones.` : "No encontramos canciones para esta selección.");
  const count = document.getElementById("resultCount");
  if (count) count.textContent = normalized.length ? `${normalized.length} resultados` : "";
}

async function runDiscovery(query, mood = null) {
  discoveryController?.abort();
  discoveryController = new AbortController();
  navigateToView("search");
  ui.setSearching(true);
  ui.setStatus("Preparando una selección de música...");
  try {
    const tracks = mood
      ? await discoverByMood(mood, { signal: discoveryController.signal })
      : await discoverTracks(query, { signal: discoveryController.signal });
    if (discoveryController.signal.aborted) return;
    renderDiscoveryTracks(tracks, "Selección para descubrir");
  } catch (error) {
    if (error?.name !== "AbortError") {
      console.error("[Shunel] Discovery:", error);
      ui.setStatus(error.message || "No se pudo cargar el descubrimiento.");
    }
  } finally {
    ui.setSearching(false);
  }
}

/* =========================================
   SPOTIFY TOP 50 — COSTA RICA
========================================= */

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

function normalizeTrackText(value) {
  return String(value || "").toLocaleLowerCase("es").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

function getChartTrackMatch(results, chartTrack) {
  if (!Array.isArray(results) || !results.length) return null;
  const wantedTitle = normalizeTrackText(chartTrack.title);
  const wantedArtist = normalizeTrackText(chartTrack.artist);
  let best = null, bestScore = -1;
  for (const result of results) {
    const title = normalizeTrackText(result.title || result.name);
    const artist = normalizeTrackText(result.channel || result.artist || result.channelTitle);
    let score = 0;
    if (title === wantedTitle) score += 10;
    else if (title.includes(wantedTitle) || wantedTitle.includes(title)) score += 5;
    if (artist === wantedArtist) score += 8;
    else if (artist.includes(wantedArtist) || wantedArtist.includes(artist)) score += 4;
    if (result.videoId) score += 2;
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
  selectAndPlayTrack(selected);
}

function initializeCostaRicaTop50() {
  if (top50Initialized) return costaRicaTop50;
  const container = ensureTop50Container();
  if (!container) return null;
  /* Evita la inicialización duplicada del script inline anterior del HTML. */
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
      result.then(instance => { costaRicaTop50 = instance || null; }).catch(error => {
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

/* =========================================
   ARTIST RADIO + RECOMMENDATIONS UI
========================================= */

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

  panel.append(discovery, radio);
  const chart = document.getElementById("spotifyCostaRicaTop50");
  if (chart?.parentNode) chart.insertAdjacentElement("beforebegin", panel);
  else home.append(panel);
  return panel;
}

function renderRadioTracks(tracks, artist = "Radio Shunel") {
  const root = document.getElementById("shunelRadioResults");
  if (!root) return;
  root.replaceChildren();
  radioTracks = Array.isArray(tracks) ? tracks.map(normalizeTrack).filter(track => track?.videoId) : [];
  const heading = makeElement("p", "muted", radioTracks.length ? `${artist} · ${radioTracks.length} canciones` : "No hay canciones para mostrar.");
  root.append(heading);
  radioTracks.forEach((track, index) => {
    const row = makeElement("div", "shunel-radio-track");
    const image = makeElement("img");
    image.src = getTrackArtwork(track);
    image.alt = "";
    image.loading = "lazy";
    const details = makeElement("div");
    details.append(makeElement("div", "shunel-radio-track-title", track.title || "Sin título"));
    details.append(makeElement("div", "shunel-radio-track-artist", getArtist(track)));
    const play = makeElement("button", "text-button", "Reproducir");
    play.type = "button";
    play.addEventListener("click", () => {
      const state = getRadioState();
      if (state?.tracks?.[index]) playRadioTrack(index);
      else selectAndPlayTrack(track);
    });
    row.append(image, details, play);
    root.append(row);
  });
}

async function startCurrentArtistRadio() {
  if (!currentTrack) { ui.toastMessage("Primero reproduce una canción para iniciar su radio."); return; }
  const artist = getArtist(currentTrack);
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
  recommendationController = new AbortController();
  const root = document.getElementById("shunelRadioResults");
  if (root) root.textContent = "Buscando canciones similares...";
  try {
    const tracks = await getRecommendations(currentTrack, { signal: recommendationController.signal, limit: 15 });
    if (recommendationController.signal.aborted) return;
    renderRadioTracks(tracks, "Recomendaciones");
    if (!tracks.length) ui.toastMessage("No encontramos recomendaciones.");
  } catch (error) {
    if (error.name !== "AbortError") {
      console.error("[Shunel] Recommendations:", error);
      if (root) root.textContent = error.message || "No se pudieron cargar recomendaciones.";
      ui.toastMessage(error.message || "No se pudieron cargar recomendaciones.");
    }
  }
}

/* =========================================
   SHUNEL AI UI
========================================= */

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

async function handleAIMessage(event) {
  event.preventDefault();
  if (aiBusy) return;
  const input = document.getElementById("shunelAIInput");
  const text = input?.value.trim();
  if (!text) return;
  aiMessages.push({ role: "user", content: text });
  renderAIMessage("user", text);
  input.value = "";
  aiBusy = true;
  const submit = document.querySelector("#shunelAIForm button[type='submit']");
  if (submit) { submit.disabled = true; submit.textContent = "Pensando..."; }
  try {
    const context = currentTrack ? {
      currentTrack: { title: currentTrack.title, artist: getArtist(currentTrack) },
      queueLength: queue.getItems().length
    } : null;
    const reply = await askShunelAI(aiMessages, { context });
    aiMessages.push({ role: "assistant", content: reply });
    renderAIMessage("assistant", reply);
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

/* =========================================
   MOD PACKS UI
========================================= */

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

/* =========================================
   FULL PLAYER
========================================= */

function openFullPlayer() {
  if (!currentTrack) { ui.toastMessage("Primero elige una canción."); return; }
  ui.toggleFullPlayer(true);
}

function closeFullPlayer() { ui.toggleFullPlayer(false); }

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
  document.getElementById("fullNextButton")?.addEventListener("click", playNext);
  document.getElementById("fullPlayerFavorite")?.addEventListener("click", () => { if (currentTrack) toggleFavorite(currentTrack); });
  document.getElementById("fullProgressBar")?.addEventListener("change", event => {
    if (!player) return;
    const duration = player.getDuration() || 0;
    player.seekTo(Math.max(0, Math.min(Number(event.target.value), duration)));
  });
}

function bindPlayerEvents() {
  ui.elements.playButton?.addEventListener("click", togglePlayback);
  ui.elements.nextButton?.addEventListener("click", playNext);
  ui.elements.previousButton?.addEventListener("click", playPrevious);
  ui.elements.favoriteCurrent?.addEventListener("click", () => { if (currentTrack) toggleFavorite(currentTrack); });
  ui.elements.volumeBar?.addEventListener("input", event => player?.setVolume(Number(event.target.value)));
  ui.elements.progressBar?.addEventListener("change", event => {
    if (!player) return;
    const duration = player.getDuration() || 0;
    player.seekTo(Math.max(0, Math.min(Number(event.target.value), duration)));
  });
  document.querySelector(".player-dock")?.addEventListener("click", event => {
    if (event.target.closest("button") || event.target.closest("input")) return;
    openFullPlayer();
  });
  bindFullPlayerEvents();
}

/* =========================================
   PLAYER PROGRESS + LYRICS
========================================= */

function startProgressUpdates() {
  clearInterval(progressTimer);
  progressTimer = setInterval(() => {
    if (!player || !isPlaying) return;
    try {
      const current = player.getCurrentTime();
      const duration = player.getDuration();
      ui.setProgress(current, duration);
      updateMediaPosition();
      syncLyricsProgress(current);
    } catch {}
  }, 1000);
}

/* =========================================
   YOUTUBE PLAYER
========================================= */

function initializePlayer() {
  if (player) return;
  player = new YouTubePlayer("youtubePlayerHost", {
    onReady: () => {
      player.setVolume(Number(ui.elements.volumeBar?.value ?? 75));
      console.info("[Shunel] YouTube Player listo.");
    },
    onStateChange: state => {
      if (!window.YT?.PlayerState) return;
      const playing = state === window.YT.PlayerState.PLAYING;
      isPlaying = playing;
      ui.setPlaying(playing);
      updateMediaPlaybackState(playing);
      if (playing) { triggerIOSAudioContext(); startProgressUpdates(); updateMediaPosition(); }
      else clearInterval(progressTimer);
    },
    onEnded: playNext,
    onError: code => {
      isPlaying = false;
      pauseIOSAudioContext();
      clearInterval(progressTimer);
      ui.setPlaying(false);
      updateMediaPlaybackState(false);
      console.warn("[Shunel] YouTube player error:", code);
      ui.toastMessage("YouTube no pudo reproducir este video.");
    }
  });
  player.init().catch(error => {
    console.error("[Shunel] Player initialization:", error);
    ui.toastMessage("No se pudo cargar el reproductor de YouTube.");
  });
}

/* =========================================
   EVENT BINDING
========================================= */

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
}

/* =========================================
   INITIALIZATION
========================================= */

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
  refreshCollections();
  refreshQueue();
  ui.setCurrentTrack(null, false);
  ui.setPlaying(false);
  updateMediaPlaybackState(false);
  navigateToView("home");
  initializeCostaRicaTop50();
  initializePlayer();

  console.info("[Shunel] Aplicación y módulos integrados.");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initialize, { once: true });
} else {
  initialize();
}
