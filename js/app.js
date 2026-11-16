
import { searchTracks } from "./search.js";
import { YouTubePlayer } from "./player.js";
import { QueueManager } from "./queue.js";
import { MusicLibrary } from "./library.js";
import { ShunelUI } from "./ui.js";

/* =========================================
   SHUNEL — APP CONTROLLER
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

const $ = selector => document.querySelector(selector);
const byId = id => document.getElementById(id);

/* =========================================
   MEDIA SESSION
   CONTROLES DEL SISTEMA / PANTALLA BLOQUEADA
========================================= */

const mediaSession = navigator.mediaSession || null;

function getTrackArtwork(track) {
  return (
    track?.thumbnail ||
    track?.thumbnailUrl ||
    track?.image ||
    "/assets/placeholder.svg"
  );
}

function updateMediaMetadata(track) {
  if (!mediaSession || !track) return;

  try {
    if ("MediaMetadata" in window) {
      mediaSession.metadata = new MediaMetadata({
        title: track.title || track.name || "Reproduciendo",
        artist: track.channel || track.artist || "Shunel",
        album: "Shunel",
        artwork: [
          {
            src: getTrackArtwork(track),
            sizes: "512x512",
            type: "image/jpeg"
          }
        ]
      });
    }
  } catch (error) {
    console.warn("[Shunel] No se pudo actualizar Media Session:", error);
  }
}

function updateMediaPlaybackState(playing) {
  if (!mediaSession) return;

  try {
    mediaSession.playbackState = playing ? "playing" : "paused";
  } catch (error) {
    console.warn("[Shunel] Error de estado multimedia:", error);
  }
}

function updateMediaPosition() {
  if (!mediaSession || !player) return;
  if (typeof mediaSession.setPositionState !== "function") return;

  try {
    const duration = Number(player.getDuration());
    const position = Number(player.getCurrentTime());

    if (!Number.isFinite(duration) || duration <= 0) return;

    mediaSession.setPositionState({
      duration,
      playbackRate: 1,
      position: Math.min(Math.max(position || 0, 0), duration)
    });
  } catch {
    // Algunos navegadores no permiten actualizar la posición.
  }
}

function setupMediaSession() {
  if (!mediaSession) {
    console.info("[Shunel] Media Session no disponible.");
    return;
  }

  const actions = {
    play: () => {
      if (!currentTrack) return;
      player?.resume?.();
    },

    pause: () => {
      player?.pause?.();
    },

    nexttrack: () => {
      playNext();
    },

    previoustrack: () => {
      playPrevious();
    },

    seekto: details => {
      if (Number.isFinite(details.seekTime)) {
        player?.seekTo(details.seekTime);
      }
    },

    seekbackward: details => {
      const current = player?.getCurrentTime() || 0;
      const offset = details.seekOffset || 10;

      player?.seekTo(Math.max(0, current - offset));
    },

    seekforward: details => {
      const current = player?.getCurrentTime() || 0;
      const duration = player?.getDuration() || 0;
      const offset = details.seekOffset || 10;

      player?.seekTo(
        duration > 0
          ? Math.min(duration, current + offset)
          : current + offset
      );
    }
  };

  Object.entries(actions).forEach(([action, handler]) => {
    try {
      mediaSession.setActionHandler(action, handler);
    } catch {
      // Acción no compatible con este navegador.
    }
  });

  console.info("[Shunel] Media Session configurada.");
}

/* =========================================
   NAVIGATION
========================================= */

function navigateToView(viewName) {
  if (!viewName) return;

  const target = byId(`view-${viewName}`);

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
    });
  });
}

/* =========================================
   LIBRARY FILTERS
========================================= */

function bindLibraryFilters() {
  const filters = document.querySelectorAll("[data-library-filter]");
  const libraryList = byId("libraryList");
  const favoritesList = byId("favoritesList");

  if (!libraryList || !favoritesList) return;

  filters.forEach(button => {
    button.addEventListener("click", () => {
      const showFavorites =
        button.dataset.libraryFilter === "favorites";

      libraryList.hidden = showFavorites;
      favoritesList.hidden = !showFavorites;

      filters.forEach(item => {
        const active = item === button;

        item.classList.toggle("active", active);
        item.setAttribute("aria-pressed", String(active));
      });
    });
  });
}

/* =========================================
   TRACK ACTIONS
========================================= */

function trackActions(track) {
  return {
    play: playTrack,
    favorite: toggleFavorite,
    isFavorite: library.isFavorite(track.videoId),
    save: saveTrack,
    add: addToQueue
  };
}

/* =========================================
   COLLECTIONS
========================================= */

function refreshCollections() {
  ui.renderCollection(
    "library",
    library.getLibrary(),
    track => ({
      play: playTrack,
      favorite: toggleFavorite,
      isFavorite: library.isFavorite(track.videoId),

      remove: item => {
        library.remove(item.videoId);
        refreshCollections();
        ui.toastMessage("Canción eliminada de tu biblioteca.");
      },

      add: addToQueue
    })
  );

  ui.renderCollection(
    "favorites",
    library.getFavorites(),
    track => ({
      play: playTrack,
      favorite: toggleFavorite,
      isFavorite: true,
      add: addToQueue
    })
  );

  ui.renderCollection(
    "history",
    library.getHistory(),
    track => ({
      play: playTrack,
      favorite: toggleFavorite,
      isFavorite: library.isFavorite(track.videoId),
      add: addToQueue
    })
  );
}

/* =========================================
   QUEUE
========================================= */

function refreshQueue() {
  ui.renderQueue(
    queue.getItems(),
    currentTrack?.videoId,
    playTrack,
    index => {
      queue.remove(index);
      refreshQueue();
    }
  );
}

function toggleQueuePanel(open) {
  queuePanelOpen = Boolean(open);
  ui.toggleQueue(queuePanelOpen);
}

/* =========================================
   LIBRARY ACTIONS
========================================= */

function saveTrack(track) {
  const saved = library.save(track);

  ui.toastMessage(
    saved
      ? "Agregada a tu biblioteca."
      : "Ya está en tu biblioteca."
  );

  refreshCollections();
}

function toggleFavorite(track) {
  const added = library.toggleFavorite(track);

  ui.toastMessage(
    added
      ? "Agregada a favoritos."
      : "Eliminada de favoritos."
  );

  refreshCollections();

  if (currentTrack?.videoId === track.videoId) {
    ui.setCurrentTrack(
      currentTrack,
      library.isFavorite(track.videoId)
    );
  }
}

function addToQueue(track) {
  queue.add(track);
  refreshQueue();
  ui.toastMessage("Agregada a la cola.");
}

/* =========================================
   PLAYBACK
========================================= */

function playTrack(track) {
  if (!track?.videoId) return;

  currentTrack = track;

  queue.setCurrent(track);
  library.addHistory(track);

  ui.setCurrentTrack(
    track,
    library.isFavorite(track.videoId)
  );

  // Esperar la confirmación real de YouTube.
  isPlaying = false;
  ui.setPlaying(false);
  ui.setProgress(0, 0);

  updateMediaMetadata(track);
  updateMediaPlaybackState(false);

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

function playNext() {
  const next = queue.takeNext();

  refreshQueue();

  if (next) {
    playTrack(next);
  } else {
    isPlaying = false;

    player?.pause?.();

    ui.setPlaying(false);
    updateMediaPlaybackState(false);

    ui.toastMessage("La cola terminó.");
  }
}

function playPrevious() {
  if (!player || !currentTrack) return;

  if (player.getCurrentTime() > 3) {
    player.seekTo(0);
    return;
  }

  const history = library.getHistory();

  const previous = history.find(
    track => track.videoId !== currentTrack.videoId
  );

  if (previous) {
    playTrack(previous);
  } else {
    player.play(currentTrack.videoId);
  }
}

function togglePlayback() {
  if (!currentTrack) {
    ui.toastMessage("Primero elige una canción.");
    return;
  }

  player?.toggle();
}

/* =========================================
   SEARCH
========================================= */

async function handleSearch(event) {
  event.preventDefault();

  const query = ui.elements.input?.value.trim();

  if (!query) {
    ui.setStatus("Escribe el nombre de una canción.");
    return;
  }

  searchController?.abort();

  const controller = new AbortController();
  searchController = controller;

  ui.setSearching(true);
  ui.setStatus("Buscando música en YouTube...");
  ui.renderSearchResults([], () => ({}));

  try {
    const tracks = await searchTracks(
      query,
      controller.signal
    );

    ui.renderSearchResults(tracks, trackActions);

    ui.setStatus(
      tracks.length
        ? `Encontramos ${tracks.length} resultados para "${query}".`
        : "No encontramos resultados. Prueba con otra búsqueda."
    );

  } catch (error) {
    if (error.name === "AbortError") return;

    console.error("[Shunel] Search error:", error);

    ui.setStatus(
      error.message || "No se pudo completar la búsqueda."
    );

  } finally {
    if (searchController === controller) {
      ui.setSearching(false);
      searchController = null;
    }
  }
}

/* =========================================
   QUEUE EVENTS
========================================= */

function bindQueueEvents() {
  byId("queueToggle")?.addEventListener("click", () => {
    toggleQueuePanel(!queuePanelOpen);
  });

  byId("closeQueue")?.addEventListener("click", () => {
    toggleQueuePanel(false);
  });

  byId("clearQueue")?.addEventListener("click", () => {
    queue.clear();
    refreshQueue();
    ui.toastMessage("Cola vaciada.");
  });

  // Botones de cola del reproductor grande.
  byId("fullPlayerQueue")?.addEventListener("click", () => {
    toggleQueuePanel(!queuePanelOpen);
  });

  byId("fullQueueToggle")?.addEventListener("click", () => {
    toggleQueuePanel(!queuePanelOpen);
  });
}

/* =========================================
   FULL PLAYER
========================================= */

function openFullPlayer() {
  if (!currentTrack) {
    ui.toastMessage("Primero elige una canción.");
    return;
  }

  ui.toggleFullPlayer(true);
}

function closeFullPlayer() {
  ui.toggleFullPlayer(false);
}

function bindFullPlayerEvents() {
  // Cerrar.
  byId("closeFullPlayer")?.addEventListener(
    "click",
    closeFullPlayer
  );

  // Reproducir / pausar.
  byId("fullPlayButton")?.addEventListener(
    "click",
    togglePlayback
  );

  // Canción anterior.
  byId("fullPreviousButton")?.addEventListener(
    "click",
    playPrevious
  );

  // Canción siguiente.
  byId("fullNextButton")?.addEventListener(
    "click",
    playNext
  );

  // Favoritos.
  byId("fullPlayerFavorite")?.addEventListener("click", () => {
    if (currentTrack) {
      toggleFavorite(currentTrack);
    }
  });

  // Progreso.
  byId("fullProgressBar")?.addEventListener("change", event => {
    player?.seekTo(Number(event.target.value));
  });
}

/* =========================================
   MINI PLAYER EVENTS
========================================= */

function bindPlayerEvents() {
  // Mini player: reproducir / pausar.
  ui.elements.playButton?.addEventListener(
    "click",
    togglePlayback
  );

  // Canciones.
  ui.elements.nextButton?.addEventListener("click", playNext);
  ui.elements.previousButton?.addEventListener("click", playPrevious);

  // Favoritos.
  ui.elements.favoriteCurrent?.addEventListener("click", () => {
    if (currentTrack) {
      toggleFavorite(currentTrack);
    }
  });

  // Volumen.
  ui.elements.volumeBar?.addEventListener("input", event => {
    player?.setVolume(Number(event.target.value));
  });

  // Progreso.
  ui.elements.progressBar?.addEventListener("change", event => {
    player?.seekTo(Number(event.target.value));
  });

  // Tocar la portada, título o artista abre el reproductor grande.
  $(".now-playing")?.addEventListener("click", event => {
    if (event.target.closest("button")) return;
    openFullPlayer();
  });

  // Flecha de expansión.
  byId("expandPlayer")?.addEventListener(
    "click",
    openFullPlayer
  );

  bindFullPlayerEvents();
}

/* =========================================
   EVENT BINDING
========================================= */

function bindEvents() {
  ui.elements.form?.addEventListener(
    "submit",
    handleSearch
  );

  bindNavigation();
  bindLibraryFilters();
  bindPlayerEvents();
  bindQueueEvents();

  queue.setOnChange(refreshQueue);
}

/* =========================================
   PLAYER PROGRESS
========================================= */

function startProgressUpdates() {
  window.clearInterval(progressTimer);

  progressTimer = window.setInterval(() => {
    if (!player || !isPlaying) return;

    const current = player.getCurrentTime();
    const duration = player.getDuration();

    ui.setProgress(current, duration);
    updateMediaPosition();

  }, 1000);
}

/* =========================================
   YOUTUBE PLAYER
========================================= */

function initializePlayer() {
  player = new YouTubePlayer("youtubePlayerHost", {

    onReady: () => {
      player.setVolume(
        Number(ui.elements.volumeBar?.value ?? 75)
      );

      console.info("[Shunel] YouTube Player listo.");
    },

    onStateChange: state => {
      const playing =
        state === window.YT.PlayerState.PLAYING;

      isPlaying = playing;

      ui.setPlaying(playing);
      updateMediaPlaybackState(playing);

      if (playing) {
        startProgressUpdates();
        updateMediaPosition();
      } else {
        window.clearInterval(progressTimer);
      }
    },

    onEnded: () => {
      playNext();
    },

    onError: code => {
      isPlaying = false;

      window.clearInterval(progressTimer);

      ui.setPlaying(false);
      updateMediaPlaybackState(false);

      console.warn(
        "[Shunel] YouTube player error:",
        code
      );

      ui.toastMessage(
        "YouTube no pudo reproducir este video."
      );
    }
  });

  player.init().catch(error => {
    console.error(
      "[Shunel] Player initialization:",
      error
    );

    ui.toastMessage(
      "No se pudo cargar el reproductor de YouTube."
    );
  });
}

/* =========================================
   INITIALIZATION
========================================= */

function initialize() {
  bindEvents();
  setupMediaSession();

  refreshCollections();
  refreshQueue();

  ui.setCurrentTrack(null, false);
  ui.setPlaying(false);

  updateMediaPlaybackState(false);

  navigateToView("home");

  initializePlayer();

  console.info("[Shunel] Aplicación iniciada.");
}

initialize();
