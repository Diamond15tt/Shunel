
/* =========================================
   SHUNEL — PLAYER ENGINE
   Reproductor principal
========================================= */

(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const audio = $("localAudio");

  if (!audio) {
    console.error("[Shunel Player] No se encontró #localAudio.");
    return;
  }

  const elements = {
    miniPlayer: $("bottom-player"),
    miniArtwork: $("miniPlayerArtwork"),
    miniCover: $("miniCoverImage"),
    miniTitle: $("miniTrackTitle"),
    miniArtist: $("miniTrackArtist"),
    miniPlay: $("miniPlayButton"),
    miniPrevious: $("miniPreviousButton"),
    miniNext: $("miniNextButton"),
    miniProgress: $("miniProgressBar"),

    fullPlayer: $("nowPlayingScreen"),
    closePlayer: $("closePlayerButton"),
    openQueue: $("openQueueButton"),
    openLyrics: $("openLyricsButton"),
    openCanvas: $("openCanvasButton"),
    openPlayerQueue: $("openPlayerQueueButton"),

    cover: $("playerCoverImage"),
    title: $("playerTrackTitle"),
    artist: $("playerTrackArtist"),
    artistButton: $("playerArtistButton"),
    favorite: $("playerFavoriteButton"),

    progress: $("playerProgress"),
    currentTime: $("currentTime"),
    duration: $("durationTime"),

    play: $("playButton"),
    previous: $("previousButton"),
    next: $("nextButton"),
    shuffle: $("shuffleButton"),
    repeat: $("repeatButton"),

    lyricsPreview: $("lyricsPreviewText")
  };

  const state = {
    currentTrack: null,
    queue: [],
    currentIndex: -1,
    isPlaying: false,
    isShuffle: false,
    repeatMode: "off",
    isSeeking: false,
    initialized: false
  };

  const STORAGE_KEY = "shunel_player_preferences";

  /* =========================================
     EVENTOS INTERNOS
  ========================================= */

  function emit(name, detail = {}) {
    window.dispatchEvent(
      new CustomEvent(`shunel:${name}`, { detail })
    );
  }

  function notify(message) {
    const toast = $("toast");

    if (!toast) return;

    toast.textContent = message;
    toast.hidden = false;

    clearTimeout(notify.timer);

    notify.timer = setTimeout(() => {
      toast.hidden = true;
    }, 2600);
  }

  function savePreferences() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          shuffle: state.isShuffle,
          repeat: state.repeatMode,
          volume: audio.volume,
          muted: audio.muted
        })
      );
    } catch (error) {
      console.warn("[Shunel Player] No se pudieron guardar los ajustes.", error);
    }
  }

  function loadPreferences() {
    try {
      const saved = JSON.parse(
        localStorage.getItem(STORAGE_KEY) || "{}"
      );

      state.isShuffle = Boolean(saved.shuffle);

      if (["off", "one", "all"].includes(saved.repeat)) {
        state.repeatMode = saved.repeat;
      }

      if (typeof saved.volume === "number") {
        audio.volume = Math.max(0, Math.min(1, saved.volume));
      }

      audio.muted = Boolean(saved.muted);
    } catch {
      audio.volume = 1;
    }
  }

  /* =========================================
     UTILIDADES
  ========================================= */

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) {
      return "0:00";
    }

    const minutes = Math.floor(seconds / 60);
    const remaining = Math.floor(seconds % 60);

    return `${minutes}:${String(remaining).padStart(2, "0")}`;
  }

  function getArtwork(track) {
    return (
      track?.artwork_url ||
      track?.artwork ||
      track?.cover ||
      track?.thumbnail ||
      ""
    );
  }

  function getTrackUrl(track) {
    return (
      track?.audioUrl ||
      track?.audio_url ||
      track?.url ||
      track?.src ||
      ""
    );
  }

  function isExternalTrack(track) {
    const source = String(track?.source || "").toLowerCase();

    return (
      source === "youtube" ||
      source === "external-youtube" ||
      Boolean(track?.videoId || track?.video_id)
    );
  }

  function normalizeTrack(track) {
    if (!track || typeof track !== "object") {
      return null;
    }

    return {
      ...track,
      id: String(
        track.id ||
        track.track_id ||
        track.videoId ||
        track.video_id ||
        getTrackUrl(track) ||
        `track-${Date.now()}`
      ),
      title: track.title || track.name || "Canción desconocida",
      artist: track.artist || track.artist_name || "Artista desconocido",
      artwork_url: getArtwork(track),
      source: track.source || "local"
    };
  }

  /* =========================================
     INFORMACIÓN VISUAL
  ========================================= */

  function updateTrackInformation(track) {
    if (!track) return;

    const artwork = getArtwork(track);

    if (elements.miniTitle) {
      elements.miniTitle.textContent = track.title;
    }

    if (elements.miniArtist) {
      elements.miniArtist.textContent = track.artist;
    }

    if (elements.title) {
      elements.title.textContent = track.title;
    }

    if (elements.artist) {
      elements.artist.textContent = track.artist;
    }

    if (elements.miniCover) {
      elements.miniCover.src = artwork;
      elements.miniCover.alt = `Portada de ${track.title}`;
    }

    if (elements.cover) {
      elements.cover.src = artwork;
      elements.cover.alt = `Portada de ${track.title}`;
    }

    if (elements.lyricsPreview) {
      elements.lyricsPreview.textContent =
        "Las letras aparecerán aquí.";
    }

    if (elements.miniPlayer) {
      elements.miniPlayer.hidden = false;
    }

    emit("trackchange", { track });
  }

  function updatePlayButtons() {
    const icon = state.isPlaying ? "Ⅱ" : "▶";

    if (elements.play) {
      elements.play.textContent = icon;
      elements.play.setAttribute(
        "aria-label",
        state.isPlaying ? "Pausar" : "Reproducir"
      );
    }

    if (elements.miniPlay) {
      elements.miniPlay.textContent = icon;
      elements.miniPlay.setAttribute(
        "aria-label",
        state.isPlaying ? "Pausar" : "Reproducir"
      );
    }
  }

  function updateModeButtons() {
    if (elements.shuffle) {
      elements.shuffle.classList.toggle(
        "active",
        state.isShuffle
      );

      elements.shuffle.setAttribute(
        "aria-pressed",
        String(state.isShuffle)
      );
    }

    if (elements.repeat) {
      elements.repeat.classList.toggle(
        "active",
        state.repeatMode !== "off"
      );

      elements.repeat.textContent =
        state.repeatMode === "one" ? "🔂" : "🔁";

      elements.repeat.setAttribute(
        "aria-label",
        `Repetición: ${state.repeatMode}`
      );
    }
  }

  /* =========================================
     PROGRESO
  ========================================= */

  function updateProgress() {
    const duration = audio.duration || 0;
    const current = audio.currentTime || 0;

    const percentage = duration
      ? (current / duration) * 100
      : 0;

    if (elements.progress && !state.isSeeking) {
      elements.progress.value = percentage;
    }

    if (elements.miniProgress) {
      elements.miniProgress.style.width = `${percentage}%`;
    }

    if (elements.currentTime) {
      elements.currentTime.textContent = formatTime(current);
    }

    if (elements.duration) {
      elements.duration.textContent = formatTime(duration);
    }
  }

  function seekTo(value) {
    if (!Number.isFinite(audio.duration)) return;

    const percentage = Math.max(0, Math.min(100, Number(value)));

    audio.currentTime = audio.duration * percentage / 100;

    updateProgress();

    emit("seek", {
      currentTime: audio.currentTime,
      duration: audio.duration
    });
  }

  /* =========================================
     REPRODUCCIÓN
  ========================================= */

  async function play() {
    if (!state.currentTrack) {
      notify("Selecciona una canción primero.");
      return false;
    }

    if (isExternalTrack(state.currentTrack)) {
      emit("external-play", {
        track: state.currentTrack
      });

      notify("Esta canción necesita su reproductor externo.");
      return false;
    }

    try {
      await audio.play();
      return true;
    } catch (error) {
      console.error("[Shunel Player] Error al reproducir:", error);

      notify("No se pudo iniciar la reproducción.");
      return false;
    }
  }

  function pause() {
    audio.pause();
  }

  async function togglePlay() {
    if (audio.paused) {
      return play();
    }

    pause();
    return true;
  }

  async function playTrack(track, tracks = null) {
    const normalized = normalizeTrack(track);

    if (!normalized) {
      notify("La canción no es válida.");
      return false;
    }

    if (Array.isArray(tracks) && tracks.length) {
      state.queue = tracks
        .map(normalizeTrack)
        .filter(Boolean);

      state.currentIndex = state.queue.findIndex(
        item => item.id === normalized.id
      );

      if (state.currentIndex < 0) {
        state.queue.unshift(normalized);
        state.currentIndex = 0;
      }
    } else {
      state.queue = [normalized];
      state.currentIndex = 0;
    }

    state.currentTrack = normalized;

    updateTrackInformation(normalized);

    if (isExternalTrack(normalized)) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();

      emit("external-play", {
        track: normalized
      });

      return true;
    }

    const url = getTrackUrl(normalized);

    if (!url) {
      notify("Esta canción no tiene un archivo de audio disponible.");
      return false;
    }

    audio.pause();
    audio.src = url;
    audio.load();

    updateProgress();

    return play();
  }

  /* =========================================
     COLA DE REPRODUCCIÓN
  ========================================= */

  function setQueue(tracks, startIndex = 0, autoplay = true) {
    if (!Array.isArray(tracks)) return false;

    const validTracks = tracks
      .map(normalizeTrack)
      .filter(Boolean);

    if (!validTracks.length) {
      state.queue = [];
      state.currentIndex = -1;
      state.currentTrack = null;

      notify("La cola está vacía.");
      return false;
    }

    state.queue = validTracks;

    const index = Math.max(
      0,
      Math.min(validTracks.length - 1, Number(startIndex) || 0)
    );

    state.currentIndex = index;

    if (autoplay) {
      playTrack(validTracks[index], validTracks);
    } else {
      state.currentTrack = validTracks[index];
      updateTrackInformation(state.currentTrack);
    }

    emit("queuechange", {
      queue: [...state.queue],
      currentIndex: state.currentIndex
    });

    return true;
  }

  function addToQueue(track) {
    const normalized = normalizeTrack(track);

    if (!normalized) return false;

    state.queue.push(normalized);

    emit("queuechange", {
      queue: [...state.queue],
      currentIndex: state.currentIndex
    });

    notify("Añadida a la cola.");

    return true;
  }

  function clearQueue() {
    state.queue = [];
    state.currentIndex = -1;

    emit("queuechange", {
      queue: [],
      currentIndex: -1
    });
  }

  function getNextIndex() {
    if (!state.queue.length) return -1;

    if (state.isShuffle && state.queue.length > 1) {
      let nextIndex;

      do {
        nextIndex = Math.floor(
          Math.random() * state.queue.length
        );
      } while (nextIndex === state.currentIndex);

      return nextIndex;
    }

    const next = state.currentIndex + 1;

    if (next < state.queue.length) {
      return next;
    }

    return state.repeatMode === "all" ? 0 : -1;
  }

  async function next() {
    if (state.repeatMode === "one" && state.currentTrack) {
      audio.currentTime = 0;
      return play();
    }

    const index = getNextIndex();

    if (index < 0) {
      pause();
      return false;
    }

    return playTrack(
      state.queue[index],
      state.queue
    );
  }

  async function previous() {
    if (audio.currentTime > 3) {
      audio.currentTime = 0;
      return true;
    }

    if (!state.queue.length) return false;

    let index = state.currentIndex - 1;

    if (index < 0) {
      if (state.repeatMode === "all") {
        index = state.queue.length - 1;
      } else {
        audio.currentTime = 0;
        return false;
      }
    }

    return playTrack(
      state.queue[index],
      state.queue
    );
  }

  /* =========================================
     MODOS DE REPRODUCCIÓN
  ========================================= */

  function toggleShuffle() {
    state.isShuffle = !state.isShuffle;

    updateModeButtons();
    savePreferences();

    emit("shufflechange", {
      enabled: state.isShuffle
    });
  }

  function toggleRepeat() {
    const modes = ["off", "all", "one"];

    const index = modes.indexOf(state.repeatMode);

    state.repeatMode = modes[
      (index + 1) % modes.length
    ];

    updateModeButtons();
    savePreferences();

    emit("repeatchange", {
      mode: state.repeatMode
    });
  }

  /* =========================================
     REPRODUCTOR VISUAL
  ========================================= */

  function openPlayer() {
    if (!state.currentTrack) {
      notify("Todavía no hay ninguna canción.");
      return;
    }

    if (elements.fullPlayer) {
      elements.fullPlayer.hidden = false;
    }

    emit("playeropen", {
      track: state.currentTrack
    });
  }

  function closePlayer() {
    if (elements.fullPlayer) {
      elements.fullPlayer.hidden = true;
    }

    emit("playerclose");
  }

  function openLyrics() {
    const screen = $("lyricsScreen");

    if (screen) {
      screen.hidden = false;
      emit("lyricsopen");
    }
  }

  function openQueue() {
    const screen = $("queueScreen");

    if (screen) {
      screen.hidden = false;

      emit("queueopen", {
        queue: [...state.queue],
        currentIndex: state.currentIndex
      });
    }
  }

  function openCanvas() {
    const screen = $("canvasScreen");

    if (screen) {
      screen.hidden = false;
      emit("canvasopen");
    }
  }

  /* =========================================
     MEDIA SESSION
     Controles de pantalla bloqueada
  ========================================= */

  function updateMediaSession() {
    if (!("mediaSession" in navigator)) return;
    if (!state.currentTrack) return;

    const track = state.currentTrack;
    const artwork = getArtwork(track);

    try {
      const metadata = {
        title: track.title,
        artist: track.artist,
        album: track.album || "Shunel",
        artwork: artwork
          ? [
              {
                src: artwork,
                sizes: "512x512",
                type: "image/jpeg"
              }
            ]
          : []
      };

      navigator.mediaSession.metadata =
        new MediaMetadata(metadata);

      navigator.mediaSession.playbackState =
        state.isPlaying ? "playing" : "paused";

      navigator.mediaSession.setActionHandler(
        "play",
        play
      );

      navigator.mediaSession.setActionHandler(
        "pause",
        pause
      );

      navigator.mediaSession.setActionHandler(
        "previoustrack",
        previous
      );

      navigator.mediaSession.setActionHandler(
        "nexttrack",
        next
      );

      navigator.mediaSession.setActionHandler(
        "seekto",
        (details) => {
          if (Number.isFinite(details.seekTime)) {
            audio.currentTime = details.seekTime;
          }
        }
      );

      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        navigator.mediaSession.setPositionState({
          duration: audio.duration,
          playbackRate: audio.playbackRate,
          position: Math.min(audio.currentTime, audio.duration)
        });
      }
    } catch (error) {
      console.warn("[Shunel Player] Media Session:", error);
    }
  }

  /* =========================================
     EVENTOS DEL AUDIO
  ========================================= */

  audio.addEventListener("play", () => {
    state.isPlaying = true;

    updatePlayButtons();
    updateMediaSession();

    emit("play", {
      track: state.currentTrack
    });
  });

  audio.addEventListener("pause", () => {
    state.isPlaying = false;

    updatePlayButtons();
    updateMediaSession();

    emit("pause", {
      track: state.currentTrack
    });
  });

  audio.addEventListener("timeupdate", () => {
    updateProgress();
    updateMediaSession();
  });

  audio.addEventListener("loadedmetadata", () => {
    updateProgress();
    updateMediaSession();

    emit("metadata", {
      duration: audio.duration,
      track: state.currentTrack
    });
  });

  audio.addEventListener("durationchange", updateProgress);

  audio.addEventListener("ended", () => {
    if (state.repeatMode === "one") {
      audio.currentTime = 0;
      play();
      return;
    }

    next();
  });

  audio.addEventListener("error", () => {
    if (!state.currentTrack) return;

    console.error(
      "[Shunel Player] Error de audio:",
      audio.error
    );

    notify("No se pudo cargar el archivo de audio.");

    emit("error", {
      track: state.currentTrack,
      error: audio.error
    });
  });

  /* =========================================
     EVENTOS DE LOS BOTONES
  ========================================= */

  elements.play?.addEventListener("click", togglePlay);
  elements.miniPlay?.addEventListener("click", togglePlay);

  elements.next?.addEventListener("click", next);
  elements.miniNext?.addEventListener("click", next);

  elements.previous?.addEventListener("click", previous);
  elements.miniPrevious?.addEventListener("click", previous);

  elements.shuffle?.addEventListener("click", toggleShuffle);
  elements.repeat?.addEventListener("click", toggleRepeat);

  elements.progress?.addEventListener("input", (event) => {
    state.isSeeking = true;

    if (elements.currentTime && Number.isFinite(audio.duration)) {
      elements.currentTime.textContent = formatTime(
        audio.duration * Number(event.target.value) / 100
      );
    }
  });

  elements.progress?.addEventListener("change", (event) => {
    seekTo(event.target.value);
    state.isSeeking = false;
  });

  elements.miniArtwork?.addEventListener("click", openPlayer);

  elements.closePlayer?.addEventListener("click", closePlayer);

  elements.openLyrics?.addEventListener("click", openLyrics);

  elements.openQueue?.addEventListener("click", openQueue);
  elements.openPlayerQueue?.addEventListener("click", openQueue);

  elements.openCanvas?.addEventListener("click", openCanvas);

  elements.artistButton?.addEventListener("click", () => {
    if (!state.currentTrack) return;

    emit("artistclick", {
      artist: state.currentTrack.artist,
      track: state.currentTrack
    });
  });

  elements.favorite?.addEventListener("click", () => {
    if (!state.currentTrack) return;

    emit("favoriteclick", {
      track: state.currentTrack
    });
  });

  /* =========================================
     INICIALIZACIÓN
  ========================================= */

  function init() {
    if (state.initialized) return;

    state.initialized = true;

    loadPreferences();

    updatePlayButtons();
    updateModeButtons();
    updateProgress();

    emit("ready");

    console.info("[Shunel Player] Reproductor inicializado.");
  }

  /* =========================================
     API PÚBLICA
     Acceso desde los demás módulos
  ========================================= */

  window.ShunelPlayer = {
    play,
    pause,
    togglePlay,

    playTrack,
    setQueue,
    addToQueue,
    clearQueue,

    next,
    previous,

    seekTo,
    openPlayer,
    closePlayer,

    openLyrics,
    openQueue,
    openCanvas,

    toggleShuffle,
    toggleRepeat,

    getState() {
      return {
        ...state,
        queue: [...state.queue]
      };
    },

    getCurrentTrack() {
      return state.currentTrack;
    },

    getAudio() {
      return audio;
    },

    getQueue() {
      return [...state.queue];
    },

    setVolume(value) {
      audio.volume = Math.max(
        0,
        Math.min(1, Number(value))
      );

      audio.muted = false;
      savePreferences();
    }
  };

  init();

})();
