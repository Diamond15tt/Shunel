
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

import {
  loadLyricsForTrack,
  syncLyricsProgress
} from "./lyrics.js";

/* =========================================
   SHUNEL — APP CONTROLLER
   Playback + Lyrics + Smart Autoplay
   + Dynamic Player Background
   + Popular Music + New Music
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
   AUDIO FANTASMA PARA iOS
========================================= */

const silentAudio = document.createElement("audio");

silentAudio.src =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

silentAudio.loop = true;
silentAudio.setAttribute("playsinline", "");

function triggerIOSAudioContext() {
  try {
    silentAudio.play().catch(() => {});
  } catch (error) {}
}

function pauseIOSAudioContext() {
  try {
    silentAudio.pause();
  } catch (error) {}
}

document.addEventListener(
  "pointerdown",
  () => {
    triggerIOSAudioContext();
  },
  { once: true }
);

/* =========================================
   MEDIA SESSION
========================================= */

const mediaSession = navigator.mediaSession || null;

/* =========================================
   ARTWORK
========================================= */

function getTrackArtwork(track) {
  let artworkUrl =
    track?.thumbnail ||
    track?.thumbnailUrl ||
    track?.image ||
    "/assets/placeholder.svg";

  if (artworkUrl.startsWith("//")) {
    artworkUrl = "https:" + artworkUrl;
  }

  return artworkUrl;
}

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

      const context = canvas.getContext("2d", {
        willReadFrequently: true
      });

      if (!context) {
        throw new Error("Canvas no disponible");
      }

      canvas.width = 24;
      canvas.height = 24;

      context.drawImage(image, 0, 0, 24, 24);

      const pixels = context.getImageData(
        0,
        0,
        24,
        24
      ).data;

      let red = 0;
      let green = 0;
      let blue = 0;
      let count = 0;

      for (let i = 0; i < pixels.length; i += 4) {
        const alpha = pixels[i + 3];

        if (alpha < 128) continue;

        red += pixels[i];
        green += pixels[i + 1];
        blue += pixels[i + 2];

        count++;
      }

      if (!count) {
        throw new Error("No se encontraron colores");
      }

      red = Math.round(red / count);
      green = Math.round(green / count);
      blue = Math.round(blue / count);

      const brightness = (red + green + blue) / 3;
      const scale = brightness > 150 ? 0.65 : 0.85;

      red = Math.round(red * scale);
      green = Math.round(green * scale);
      blue = Math.round(blue * scale);

      fullPlayer.style.setProperty(
        "--song-color",
        `rgb(${red}, ${green}, ${blue})`
      );

    } catch (error) {
      fullPlayer.style.setProperty(
        "--song-color",
        "#242424"
      );
    }
  };

  image.onerror = () => {
    if (requestId !== artworkColorRequest) return;

    fullPlayer.style.setProperty(
      "--song-color",
      "#242424"
    );
  };

  image.src = getTrackArtwork(track);
}

/* =========================================
   MEDIA METADATA
========================================= */

function updateMediaMetadata(track) {
  if (!mediaSession || !track) return;

  try {
    if ("MediaMetadata" in window) {
      const artworkUrl = getTrackArtwork(track);

      mediaSession.metadata = new MediaMetadata({
        title: track.title || track.name || "Reproduciendo",
        artist: track.channel || track.artist || "Shunel",
        album: "Shunel",
        artwork: [
          {
            src: artworkUrl,
            sizes: "96x96",
            type: "image/jpeg"
          },
          {
            src: artworkUrl,
            sizes: "256x256",
            type: "image/jpeg"
          },
          {
            src: artworkUrl,
            sizes: "512x512",
            type: "image/jpeg"
          }
        ]
      });
    }
  } catch (error) {
    console.warn(
      "[Shunel] No se pudo actualizar Media Session:",
      error
    );
  }
}

function updateMediaPlaybackState(playing) {
  if (!mediaSession) return;

  try {
    mediaSession.playbackState = playing
      ? "playing"
      : "paused";
  } catch (error) {
    console.warn(
      "[Shunel] Error de estado multimedia:",
      error
    );
  }
}

function updateMediaPosition() {
  if (
    !mediaSession ||
    !player ||
    typeof player.getDuration !== "function"
  ) {
    return;
  }

  if (typeof mediaSession.setPositionState !== "function") {
    return;
  }

  try {
    const duration = Number(player.getDuration());
    const position = Number(player.getCurrentTime());

    if (
      !Number.isFinite(duration) ||
      duration <= 0 ||
      !Number.isFinite(position)
    ) {
      return;
    }

    mediaSession.setPositionState({
      duration,
      playbackRate: 1,
      position: Math.min(
        Math.max(position, 0),
        duration
      )
    });
  } catch (error) {}
}

/* =========================================
   MEDIA SESSION ACTIONS
========================================= */

function setupMediaSession() {
  if (!mediaSession) {
    console.info("[Shunel] Media Session no disponible.");
    return;
  }

  const actions = {
    play: () => {
      if (!currentTrack) return;

      triggerIOSAudioContext();
      player?.resume?.();
    },

    pause: () => {
      pauseIOSAudioContext();
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
      if (!player) return;

      const current = player.getCurrentTime() || 0;
      const offset = details.seekOffset || 10;

      player.seekTo(Math.max(0, current - offset));
    },

    seekforward: details => {
      if (!player) return;

      const current = player.getCurrentTime() || 0;
      const duration = player.getDuration() || 0;
      const offset = details.seekOffset || 10;

      player.seekTo(
        duration > 0
          ? Math.min(duration, current + offset)
          : current + offset
      );
    }
  };

  Object.entries(actions).forEach(([action, handler]) => {
    try {
      mediaSession.setActionHandler(action, handler);
    } catch (error) {}
  });

  console.info("[Shunel] Media Session configurada.");
}

/* =========================================
   NAVIGATION
========================================= */

function navigateToView(viewName) {
  if (!viewName) return;

  const target = document.getElementById(
    `view-${viewName}`
  );

  if (!target) {
    console.warn(
      `[Shunel] Vista no encontrada: ${viewName}`
    );
    return;
  }

  ui.showView(viewName);

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

document.addEventListener("click", event => {
  const target = event.target;

  if (!(target instanceof Element)) return;

  const lyricsBtn = target.closest("#openLyricsButton");

  if (lyricsBtn) {
    event.preventDefault();

    navigateToView("lyrics");
    closeFullPlayer();
  }
});

/* =========================================
   LIBRARY FILTERS
========================================= */

function bindLibraryFilters() {
  const filters = document.querySelectorAll(
    "[data-library-filter]"
  );

  const libraryList = document.getElementById("libraryList");
  const favoritesList = document.getElementById("favoritesList");

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

        item.setAttribute(
          "aria-pressed",
          String(active)
        );
      });
    });
  });
}

/* =========================================
   COLLECTIONS
========================================= */

function refreshCollections() {
  ui.renderCollection(
    "library",
    library.getLibrary(),
    track => ({
      play: selectAndPlayTrack,
      favorite: toggleFavorite,
      isFavorite: library.isFavorite(track.videoId),

      remove: item => {
        library.remove(item.videoId);

        refreshCollections();

        ui.toastMessage(
          "Canción eliminada de tu biblioteca."
        );
      },

      add: addToQueue
    })
  );

  ui.renderCollection(
    "favorites",
    library.getFavorites(),
    track => ({
      play: selectAndPlayTrack,
      favorite: toggleFavorite,
      isFavorite: true,
      add: addToQueue
    })
  );

  ui.renderCollection(
    "history",
    library.getHistory(),
    track => ({
      play: selectAndPlayTrack,
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
    selectAndPlayTrack,
    index => {
      queue.remove(index);
      refreshQueue();
    }
  );
}

function toggleQueuePanel(open) {
  queuePanelOpen = Boolean(open);

  ui.toggleQueue(queuePanelOpen);

  document
    .querySelectorAll(
      "#queueToggle, #fullPlayerQueue, #fullQueueToggle"
    )
    .forEach(button => {
      button.setAttribute(
        "aria-expanded",
        String(queuePanelOpen)
      );
    });
}

/* =========================================
   LIBRARY ACTIONS
========================================= */

function saveTrack(track) {
  if (!track?.videoId) return;

  const saved = library.save(track);

  ui.toastMessage(
    saved
      ? "Agregada a tu biblioteca."
      : "Ya está en tu biblioteca."
  );

  refreshCollections();
}

function toggleFavorite(track) {
  if (!track?.videoId) return;

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
  if (!track?.videoId) return;

  queue.add(track);

  refreshQueue();

  ui.toastMessage("Agregada a la cola.");
}

/* =========================================
   PLAYBACK
========================================= */

function selectAndPlayTrack(track) {
  if (!track?.videoId) return;

  currentTrack = track;

  queue.setCurrent(track);
  library.addHistory(track);

  ui.setCurrentTrack(
    track,
    library.isFavorite(track.videoId)
  );

  setFullPlayerBackground(track);

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
    ui.toastMessage(
      "El reproductor todavía se está cargando."
    );
    return;
  }

  try {
    player.play(track.videoId);
  } catch (error) {
    console.error(
      "[Shunel] Error al reproducir:",
      error
    );

    ui.toastMessage(
      "No se pudo iniciar la canción."
    );
  }
}

/* =========================================
   SMART AUTOPLAY
========================================= */

function triggerSmartAutoplay() {
  const allTracks = [
    ...library.getLibrary(),
    ...library.getHistory()
  ];

  if (!allTracks.length || !currentTrack) {
    isPlaying = false;
    currentTrack = null;

    pauseIOSAudioContext();

    player?.pause?.();

    ui.setPlaying(false);

    updateMediaPlaybackState(false);

    ui.setCurrentTrack(null, false);

    ui.toastMessage("La cola terminó.");

    return;
  }

  let candidates = allTracks.filter(track =>
    track.videoId !== currentTrack.videoId &&
    (
      (
        track.channel &&
        currentTrack.channel &&
        track.channel === currentTrack.channel
      ) ||
      (
        track.artist &&
        currentTrack.artist &&
        track.artist === currentTrack.artist
      ) ||
      (
        track.style &&
        currentTrack.style &&
        track.style === currentTrack.style
      )
    )
  );

  if (candidates.length === 0) {
    candidates = allTracks.filter(
      track => track.videoId !== currentTrack.videoId
    );
  }

  if (candidates.length === 0) {
    ui.toastMessage("La cola terminó.");
    return;
  }

  const randomIndex = Math.floor(
    Math.random() * candidates.length
  );

  const nextSong = candidates[randomIndex];

  ui.toastMessage(
    "Reproduciendo recomendación inteligente..."
  );

  selectAndPlayTrack(nextSong);
}

/* =========================================
   NEXT / PREVIOUS
========================================= */

function playNext() {
  const next = queue.takeNext();

  refreshQueue();

  if (next) {
    selectAndPlayTrack(next);
  } else {
    triggerSmartAutoplay();
  }
}

function playPrevious() {
  if (!player || !currentTrack) return;

  try {
    if (player.getCurrentTime() > 3) {
      player.seekTo(0);
      return;
    }
  } catch (error) {}

  const history = library.getHistory();

  const previous = history.find(
    track => track.videoId !== currentTrack.videoId
  );

  if (previous) {
    selectAndPlayTrack(previous);
  } else {
    triggerIOSAudioContext();
    player.play(currentTrack.videoId);
  }
}

/* =========================================
   PLAYBACK TOGGLE
========================================= */

function togglePlayback() {
  if (!currentTrack) {
    ui.toastMessage("Primero elige una canción.");
    return;
  }

  if (isPlaying) {
    pauseIOSAudioContext();
  } else {
    triggerIOSAudioContext();
  }

  player?.toggle();
}

/* =========================================
   SEARCH ENGINE
   BÚSQUEDA NORMAL Y ESPECIALIZADA
========================================= */

/**
 * Ejecuta una búsqueda y representa sus resultados.
 *
 * searchFunction puede ser:
 * - searchTracks
 * - searchPopularTracks
 * - searchNewTracks
 */

async function executeSearch(query, searchFunction = searchTracks) {
  const cleanQuery = String(query || "").trim();

  if (!cleanQuery) {
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
    const tracks = await searchFunction(
      cleanQuery,
      controller.signal,
      {
        maxResults: 20
      }
    );

    if (controller.signal.aborted) return;

    ui.renderSearchResults(
      tracks,
      track => ({
        play: selectAndPlayTrack,
        favorite: toggleFavorite,
        isFavorite: library.isFavorite(track.videoId),
        save: saveTrack,
        add: addToQueue
      })
    );

    ui.setStatus(
      tracks.length
        ? `Encontramos ${tracks.length} resultados para "${cleanQuery}".`
        : "No encontramos resultados. Prueba con otra búsqueda."
    );

  } catch (error) {
    if (
      error.name === "AbortError" ||
      controller.signal.aborted
    ) {
      return;
    }

    console.error(
      "[Shunel] Search error:",
      error
    );

    ui.setStatus(
      error.message ||
      "No se pudo completar la búsqueda."
    );

  } finally {
    if (searchController === controller) {
      ui.setSearching(false);
      searchController = null;
    }
  }
}

/* =========================================
   SEARCH FORM
========================================= */

async function handleSearch(event) {
  event.preventDefault();

  const query = ui.elements.input?.value.trim();

  await executeSearch(query, searchTracks);
}

/* =========================================
   DISCOVER BUTTONS
   MÚSICA POPULAR / MÚSICA NUEVA
========================================= */

function normalizeDiscoverQuery(value) {
  return String(value || "")
    .trim()
    .toLocaleLowerCase("es")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
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

if (
  normalized.includes("popular") ||
  normalized.includes("mas escuchado") ||
  normalized.includes("mas escuchados")
) {
  navigateToView("home");
  
  const chart = document.getElementById(
    "spotifyCostaRicaTop50"
  );
  
  if (chart) {
    chart.scrollIntoView({
      behavior: "smooth",
      block: "start"
    });
  } else {
    ui.toastMessage(
      "El Top 50 todavía se está cargando."
    );
  }
  
  return;
}

    if (
      normalized.includes("nueva") ||
      normalized.includes("nuevo") ||
      normalized.includes("reciente")
    ) {
      navigateToView("search");

      ui.toastMessage("Buscando los lanzamientos más recientes...");

      executeSearch(
        query,
        searchNewTracks
      );

      return;
    }

    navigateToView("search");

    executeSearch(
      query,
      searchTracks
    );
  });
}
/* =========================================
   SPOTIFY TOP 50 — COSTA RICA
   Conexión con búsqueda y reproducción
========================================= */

function initializeCostaRicaTop50() {
  try {
    const result = initCostaRicaTop50({
      searchTracks,
      
      onPlay: track => {
        if (!track) return;
        
        const query = [
            track.artist,
            track.title
          ]
          .filter(Boolean)
          .join(" ")
          .trim();
        
        if (!query) return;
        
        navigateToView("search");
        
        if (ui.elements.input) {
          ui.elements.input.value = query;
        }
        
        executeSearch(query, searchTracks);
      },
      
      container: "#spotifyCostaRicaTop50"
    });
    
    if (result && typeof result.catch === "function") {
      result.catch(error => {
        console.error(
          "[Shunel] Error al cargar el Top 50:",
          error
        );
      });
    }
    
  } catch (error) {
    console.error(
      "[Shunel] No se pudo inicializar el Top 50:",
      error
    );
  }
}

/* =========================================
   QUEUE EVENTS
========================================= */

function bindQueueEvents() {
  document
    .getElementById("queueToggle")
    ?.addEventListener("click", () => {
      toggleQueuePanel(!queuePanelOpen);
    });

  document
    .getElementById("closeQueue")
    ?.addEventListener("click", () => {
      toggleQueuePanel(false);
    });

  document
    .getElementById("clearQueue")
    ?.addEventListener("click", () => {
      queue.clear();

      refreshQueue();

      ui.toastMessage("Cola vaciada.");
    });

  document
    .getElementById("fullPlayerQueue")
    ?.addEventListener("click", () => {
      toggleQueuePanel(!queuePanelOpen);
    });

  document
    .getElementById("fullQueueToggle")
    ?.addEventListener("click", () => {
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
  document
    .getElementById("closeFullPlayer")
    ?.addEventListener("click", closeFullPlayer);

  document
    .getElementById("openNativePlayer")
    ?.addEventListener("click", () => {
      if (currentTrack?.videoId) {
        const youtubeUrl =
          `https://www.youtube.com/watch?v=${currentTrack.videoId}`;

        try {
          window.open(
            youtubeUrl,
            "_blank",
            "noopener,noreferrer"
          );
        } catch (error) {
          ui.toastMessage(
            "No se pudo abrir el reproductor externo."
          );
        }
      } else {
        ui.toastMessage(
          "Primero reproduce una canción."
        );
      }
    });

  document
    .getElementById("fullPlayButton")
    ?.addEventListener("click", togglePlayback);

  document
    .getElementById("fullPreviousButton")
    ?.addEventListener("click", playPrevious);

  document
    .getElementById("fullNextButton")
    ?.addEventListener("click", playNext);

  document
    .getElementById("fullPlayerFavorite")
    ?.addEventListener("click", () => {
      if (currentTrack) {
        toggleFavorite(currentTrack);
      }
    });

  document
    .getElementById("fullProgressBar")
    ?.addEventListener("change", event => {
      if (!player) return;

      const duration = player.getDuration() || 0;

      const targetTime = Math.max(
        0,
        Math.min(
          Number(event.target.value),
          duration
        )
      );

      player.seekTo(targetTime);
    });
}

/* =========================================
   MINI PLAYER EVENTS
========================================= */

function bindPlayerEvents() {
  ui.elements.playButton?.addEventListener(
    "click",
    togglePlayback
  );

  ui.elements.nextButton?.addEventListener(
    "click",
    playNext
  );

  ui.elements.previousButton?.addEventListener(
    "click",
    playPrevious
  );

  ui.elements.favoriteCurrent?.addEventListener(
    "click",
    () => {
      if (currentTrack) {
        toggleFavorite(currentTrack);
      }
    }
  );

  ui.elements.volumeBar?.addEventListener(
    "input",
    event => {
      player?.setVolume(
        Number(event.target.value)
      );
    }
  );

  ui.elements.progressBar?.addEventListener(
    "change",
    event => {
      if (!player) return;

      const duration = player.getDuration() || 0;

      const targetTime = Math.max(
        0,
        Math.min(
          Number(event.target.value),
          duration
        )
      );

      player.seekTo(targetTime);
    }
  );

  document
    .querySelector(".player-dock")
    ?.addEventListener("click", event => {
      if (
        event.target.closest("button") ||
        event.target.closest("input")
      ) {
        return;
      }

      openFullPlayer();
    });

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
  bindDiscoverSearches(
    
  );
  bindPlayerEvents();
  bindQueueEvents();

  queue.setOnChange(refreshQueue);
}

/* =========================================
   PLAYER PROGRESS & LYRICS SYNC
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

    } catch (error) {}
  }, 1000);
}

/* =========================================
   YOUTUBE PLAYER
========================================= */

function initializePlayer() {
  player = new YouTubePlayer(
    "youtubePlayerHost",
    {
      onReady: () => {
        player.setVolume(
          Number(ui.elements.volumeBar?.value ?? 75)
        );

        console.info(
          "[Shunel] YouTube Player listo."
        );
      },

      onStateChange: state => {
        if (!window.YT?.PlayerState) return;

        const playing =
          state === window.YT.PlayerState.PLAYING;

        isPlaying = playing;

        ui.setPlaying(playing);

        updateMediaPlaybackState(playing);

        if (playing) {
          triggerIOSAudioContext();

          startProgressUpdates();

          updateMediaPosition();

        } else {
          clearInterval(progressTimer);
        }
      },

      onEnded: () => {
        playNext();
      },

      onError: code => {
        isPlaying = false;

        pauseIOSAudioContext();

        clearInterval(progressTimer);

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
    }
  );

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
  initializeCostaRicaTop50();

  setupMediaSession();

  refreshCollections();
  refreshQueue();

  ui.setCurrentTrack(null, false);

  ui.setPlaying(false);

  updateMediaPlaybackState(false);

  navigateToView("home");
  
  initializeCostaRicaTop50();

  initializePlayer();

  console.info(
    "[Shunel] Aplicación iniciada correctamente."
  );
}

if (document.readyState === "loading") {
  document.addEventListener(
    "DOMContentLoaded",
    initialize
  );
} else {
  initialize();
}
