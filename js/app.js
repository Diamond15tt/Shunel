
import { searchTracks } from "./search.js";
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
   MEDIA SESSION BRIDGE
========================================= */

const silentAudio = document.createElement("audio");

silentAudio.src =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

silentAudio.loop = true;
silentAudio.setAttribute("playsinline", "");

function triggerIOSAudioContext() {
  try {
    silentAudio.play().catch(() => {});
  } catch (error) {
    // Puede ocurrir antes de una interacción del usuario.
  }
}

function pauseIOSAudioContext() {
  try {
    silentAudio.pause();
  } catch (error) {}
}

// Desbloqueo global para iOS en la primera interacción.
document.addEventListener(
  "pointerdown",
  () => {
    triggerIOSAudioContext();
  },
  { once: true }
);

/* =========================================
   MEDIA SESSION
   CONTROLES DEL SISTEMA / PANTALLA BLOQUEADA
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
   SHUNEL — DYNAMIC PLAYER BACKGROUND
   Extrae el color de la portada
========================================= */

let artworkColorRequest = 0;

function setFullPlayerBackground(track) {
  const fullPlayer = document.getElementById("fullPlayer");

  if (!fullPlayer || !track) return;

  const requestId = ++artworkColorRequest;
  const image = new Image();

  image.crossOrigin = "anonymous";

  image.onload = () => {
    // Evitar que una portada anterior sobrescriba la actual.
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

      // Reducir la intensidad para mantener la interfaz oscura.
      const brightness = (red + green + blue) / 3;
      const scale = brightness > 150 ? 0.65 : 0.85;

      red = Math.round(red * scale);
      green = Math.round(green * scale);
      blue = Math.round(blue * scale);

      const color = `rgb(${red}, ${green}, ${blue})`;

      fullPlayer.style.setProperty(
        "--song-color",
        color
      );

    } catch (error) {
      // Fallback si el navegador bloquea el acceso a la imagen.
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
  } catch {
    // Algunos navegadores no permiten actualizar la posición.
  }
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

      player.seekTo(
        Math.max(0, current - offset)
      );
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

// Control global del botón de letras.
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
   RESETEO Y REPRODUCCIÓN
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

  // Actualizar el fondo según la portada.
  setFullPlayerBackground(track);

  triggerIOSAudioContext();

  // Cargar letras de la canción actual.
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

  // Buscar canciones del mismo artista o estilo.
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

  // Si no hay coincidencias, usar el resto de la biblioteca.
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
  } catch (error) {
    // Fallback si getCurrentTime falla.
  }

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
   SEARCH
========================================= */

async function handleSearch(event) {
  event.preventDefault();

  const query = ui.elements.input?.value.trim();

  if (!query) {
    ui.setStatus(
      "Escribe el nombre de una canción."
    );
    return;
  }

  searchController?.abort();

  const controller = new AbortController();

  searchController = controller;

  ui.setSearching(true);

  ui.setStatus(
    "Buscando música en YouTube..."
  );

  ui.renderSearchResults([], () => ({}));

  try {
    const tracks = await searchTracks(
      query,
      controller.signal
    );

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
        ? `Encontramos ${tracks.length} resultados para "${query}".`
        : "No encontramos resultados. Prueba con otra búsqueda."
    );

  } catch (error) {
    if (error.name === "AbortError") return;

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

      // Sincronizar las letras segundo a segundo.
      syncLyricsProgress(current);

    } catch (error) {
      // Ignorar errores transitorios del reproductor.
    }
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
   DOM READY
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

  console.info(
    "[Shunel] Aplicación iniciada correctamente."
  );
}

// Inicializar cuando el DOM esté completamente cargado.
if (document.readyState === "loading") {
  document.addEventListener(
    "DOMContentLoaded",
    initialize
  );
} else {
  initialize();
}
