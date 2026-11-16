
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

  // Usa el controlador visual existente.
  ui.showView(viewName);

  // Sincroniza la navegación inferior.
  document.querySelectorAll(".bottom-nav-item").forEach(button => {
    const active = button.dataset.view === viewName;

    button.classList.toggle("active", active);
    button.setAttribute(
      "aria-current",
      active ? "page" : "false"
    );
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
  const libraryList = document.getElementById("libraryList");
  const favoritesList = document.getElementById("favoritesList");

  if (!libraryList || !favoritesList) return;

  filters.forEach(button => {
    button.addEventListener("click", () => {
      const filter = button.dataset.libraryFilter;
      const showFavorites = filter === "favorites";

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
  // Biblioteca general.
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

  // Favoritos dentro de Biblioteca.
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

  // Historial de reproducción.
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

  ui.setPlaying(true);
  ui.setProgress(0, 0);

  refreshCollections();
  refreshQueue();

  player?.play(track.videoId);
}

function playNext() {
  const next = queue.takeNext();

  refreshQueue();

  if (next) {
    playTrack(next);
  } else {
    isPlaying = false;

    ui.setPlaying(false);
    ui.toastMessage("La cola terminó.");
  }
}

function playPrevious() {
  if (!player || !currentTrack) return;

  // Si lleva más de 3 segundos, vuelve al inicio.
  if (player.getCurrentTime() > 3) {
    player.seekTo(0);
    return;
  }

  // Busca la canción anterior en el historial.
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

/* =========================================
   SEARCH
========================================= */

async function handleSearch(event) {
  event.preventDefault();

  const query = ui.elements.input.value.trim();

  if (!query) {
    ui.setStatus("Escribe el nombre de una canción.");
    return;
  }

  if (searchController) {
    searchController.abort();
  }

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
   QUEUE PANEL
========================================= */

function bindQueueEvents() {
  const queueToggle = document.getElementById("queueToggle");
  const closeQueue = document.getElementById("closeQueue");
  const clearQueue = document.getElementById("clearQueue");

  queueToggle?.addEventListener("click", () => {
    queuePanelOpen = !queuePanelOpen;
    ui.toggleQueue(queuePanelOpen);
  });

  closeQueue?.addEventListener("click", () => {
    queuePanelOpen = false;
    ui.toggleQueue(false);
  });

  clearQueue?.addEventListener("click", () => {
    queue.clear();
    refreshQueue();

    ui.toastMessage("Cola vaciada.");
  });
}

/* =========================================
   PLAYER CONTROLS
========================================= */

function bindPlayerEvents() {
  ui.elements.playButton?.addEventListener("click", () => {
    if (!currentTrack) {
      ui.toastMessage("Primero elige una canción.");
      return;
    }

    player?.toggle();
  });

  ui.elements.nextButton?.addEventListener(
    "click",
    playNext
  );

  ui.elements.previousButton?.addEventListener(
    "click",
    playPrevious
  );

  ui.elements.favoriteCurrent?.addEventListener("click", () => {
    if (currentTrack) {
      toggleFavorite(currentTrack);
    }
  });

  ui.elements.volumeBar?.addEventListener("input", event => {
    player?.setVolume(event.target.value);
  });

  ui.elements.progressBar?.addEventListener("change", event => {
    player?.seekTo(Number(event.target.value));
  });
}

/* =========================================
   EVENT BINDING
========================================= */

function bindEvents() {
  // Formularios de búsqueda.
  ui.elements.form?.addEventListener(
    "submit",
    handleSearch
  );

  // Navegación principal y accesos con data-view.
  bindNavigation();

  // Filtros de Biblioteca: Todo y Favoritos.
  bindLibraryFilters();

  // Controles del reproductor.
  bindPlayerEvents();
    // Abrir reproductor grande desde el mini reproductor
  const openFullPlayer = () => {
    if (!currentTrack) {
      ui.toastMessage("Primero elige una canción.");
      return;
    }
    
    ui.toggleFullPlayer(true);
  };
  
  const nowPlaying = document.querySelector(".now-playing");
  
  nowPlaying?.addEventListener("click", (event) => {
    // Evitar que el botón de favoritos abra el reproductor
    if (event.target.closest("button")) return;
    
    openFullPlayer();
  });
  
  ui.elements.expandPlayer?.addEventListener(
    "click",
    openFullPlayer
  );

  // Panel de cola.
  bindQueueEvents();

  // Actualización automática de la cola.
  queue.setOnChange(refreshQueue);
}

/* =========================================
   PLAYER PROGRESS
========================================= */

function startProgressUpdates() {
  window.clearInterval(progressTimer);

  progressTimer = window.setInterval(() => {
    if (!player || !isPlaying) return;

    ui.setProgress(
      player.getCurrentTime(),
      player.getDuration()
    );
  }, 500);
}

/* =========================================
   YOUTUBE PLAYER
========================================= */

function initializePlayer() {
  player = new YouTubePlayer("youtubePlayerHost", {

    onReady: () => {
      player.setVolume(ui.elements.volumeBar?.value ?? 70);

      console.info("[Shunel] YouTube Player listo.");
    },

    onStateChange: state => {
      const playing =
        state === window.YT.PlayerState.PLAYING;

      isPlaying = playing;

      ui.setPlaying(playing);

      if (playing) {
        startProgressUpdates();
      } else {
        window.clearInterval(progressTimer);
      }
    },

    onEnded: playNext,

    onError: code => {
      isPlaying = false;

      window.clearInterval(progressTimer);

      ui.setPlaying(false);

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

  refreshCollections();
  refreshQueue();

  ui.setCurrentTrack(null, false);

  // Iniciar siempre en Inicio.
  navigateToView("home");

  initializePlayer();

  console.info("[Shunel] Aplicación iniciada.");
}

initialize();
