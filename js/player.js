
/* =========================================
   SHUNEL — PLAYER ENGINE
   Motor central de reproducción
   Version: 2.2.0
========================================= */

(() => {
  "use strict";

  if (window.ShunelPlayer) {
    console.warn("[Shunel Player] Ya está inicializado.");
    return;
  }

  const audio = document.getElementById("localAudio");

  if (!audio) {
    console.error("[Shunel Player] No se encontró #localAudio.");
    return;
  }

  const $ = id => document.getElementById(id);

  const elements = {
    miniPlay: $("miniPlayButton"),
    miniNext: $("miniNextButton"),
    miniPrevious: $("miniPreviousButton"),

    play: $("playButton"),
    next: $("nextButton"),
    previous: $("previousButton"),

    shuffle: $("shuffleButton"),
    repeat: $("repeatButton"),

    volume: $("volumeSlider"),
    seek: $("seekSlider"),

    currentTime: $("currentTime"),
    duration: $("duration"),

    title: $("miniTrackTitle"),
    artist: $("miniTrackArtist"),
    artwork: $("miniTrackArtwork"),

    fullTitle: $("trackTitle") || $("playerTrackTitle"),
    fullArtist: $("trackArtist") || $("playerTrackArtist"),
    fullArtwork: $("trackArtwork") || $("playerCoverImage")
  };

  const state = {
    currentTrack: null,
    queue: [],
    currentIndex: -1,

    isPlaying: false,
    isLoading: false,

    shuffle: false,
    repeat: "off",
    volume: 0.8,

    source: "none",
    externalController: null,

    initialized: false,
    playRequest: 0,

    externalDuration: 0,
    externalTime: 0,
    externalProgressTimer: null
  };

  const STORAGE_KEY = "shunel_player_settings";

  /* =========================================
     EVENTOS
  ========================================= */

  function emit(name, detail = {}) {
    if (window.ShunelEvents?.emit) {
      window.ShunelEvents.emit(name, detail);
    } else {
      window.dispatchEvent(
        new CustomEvent(`shunel:${name}`, { detail })
      );
    }
  }

  function notify(message) {
    if (typeof window.ShunelNotify === "function") {
      window.ShunelNotify(message);
      return;
    }

    const toast = $("toast");

    if (!toast) {
      console.info("[Shunel]", message);
      return;
    }

    toast.textContent = message;
    toast.hidden = false;
    toast.classList.add("show");

    clearTimeout(notify.timer);

    notify.timer = setTimeout(() => {
      toast.classList.remove("show");
      toast.hidden = true;
    }, 2500);
  }

  /* =========================================
     NORMALIZACIÓN
  ========================================= */

  function safeImageUrl(value) {
    if (!value) return "";

    try {
      const url = new URL(value, location.href);

      if (
        ["http:", "https:", "blob:"].includes(url.protocol)
      ) {
        return url.href;
      }
    } catch {}

    return "";
  }

  function safeAudioUrl(value) {
    if (!value) return "";

    try {
      const url = new URL(value, location.href);

      if (
        ["http:", "https:", "blob:", "data:"].includes(url.protocol)
      ) {
        return url.href;
      }
    } catch {}

    return "";
  }

  function normalizeTrack(track) {
    if (!track || typeof track !== "object") {
      return null;
    }

    const title = String(
      track.title || track.name || "Sin título"
    ).trim();

    const artist = String(
      track.artist ||
      track.channelTitle ||
      "Artista desconocido"
    ).trim();

    const videoId = String(
      track.videoId ||
      track.youtubeId ||
      ""
    ).trim();

    const rawUrl =
      track.audioUrl ||
      track.url ||
      track.src ||
      "";

    const artwork =
      track.artwork ||
      track.thumbnail ||
      track.cover ||
      "";

    const source =
      track.source ||
      (videoId ? "youtube" : rawUrl ? "local" : "unknown");

    const id = String(
      track.id ||
      (videoId
        ? `youtube:${videoId}`
        : rawUrl || `${title}:${artist}`)
    );

    return {
      id,
      title,
      artist,
      artwork: safeImageUrl(artwork),
      audioUrl: safeAudioUrl(rawUrl),
      videoId,
      source,
      duration: Number(track.duration) || 0,
      album: track.album || "",
      metadata: track.metadata || {}
    };
  }

  function isYouTube(track) {
    return Boolean(
      track &&
      (track.source === "youtube" || track.videoId)
    );
  }

  /* =========================================
     ESTADO PÚBLICO
  ========================================= */

  function getCurrentTrack() {
    return state.currentTrack
      ? { ...state.currentTrack }
      : null;
  }

  function getQueue() {
    return state.queue.map(track => ({ ...track }));
  }

  function getState() {
    return {
      currentTrack: getCurrentTrack(),
      queue: getQueue(),
      currentIndex: state.currentIndex,

      isPlaying: state.isPlaying,
      isLoading: state.isLoading,

      shuffle: state.shuffle,
      repeat: state.repeat,
      volume: state.volume,

      source: state.source,

      currentTime: getCurrentTime(),
      duration: getDuration()
    };
  }

  /* =========================================
     TIEMPOS
  ========================================= */

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) {
      return "0:00";
    }

    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);

    return `${mins}:${String(secs).padStart(2, "0")}`;
  }

  function getCurrentTime() {
    if (state.source === "youtube") {
      const controller = state.externalController;

      if (controller?.getCurrentTime) {
        try {
          const value = Number(controller.getCurrentTime());

          if (Number.isFinite(value) && value >= 0) {
            state.externalTime = value;
          }
        } catch {}
      }

      return state.externalTime;
    }

    return audio.currentTime || 0;
  }

  function getDuration() {
    if (state.source === "youtube") {
      const controller = state.externalController;

      if (controller?.getDuration) {
        try {
          const value = Number(controller.getDuration());

          if (Number.isFinite(value) && value > 0) {
            state.externalDuration = value;
          }
        } catch {}
      }

      return (
        state.externalDuration ||
        state.currentTrack?.duration ||
        0
      );
    }

    return Number.isFinite(audio.duration)
      ? audio.duration
      : 0;
  }

  function updateTimeUI() {
    const current = getCurrentTime();
    const duration = getDuration();

    if (elements.currentTime) {
      elements.currentTime.textContent =
        formatTime(current);
    }

    if (elements.duration) {
      elements.duration.textContent =
        formatTime(duration);
    }

    if (elements.seek && duration > 0) {
      const percentage = Math.max(
        0,
        Math.min(1000, (current / duration) * 1000)
      );

      elements.seek.value = percentage;
    }
  }

  /* =========================================
     INTERFAZ
  ========================================= */

  function updatePlayButtons() {
    const iconName = state.isPlaying
      ? "pause"
      : "play";

    [elements.miniPlay, elements.play].forEach(button => {
      if (!button) return;

      button.dataset.state = state.isPlaying
        ? "playing"
        : "paused";

      button.setAttribute(
        "aria-label",
        state.isPlaying ? "Pausar" : "Reproducir"
      );

      const icon = button.querySelector("i");

      if (icon) {
        icon.className = `icon-${iconName}`;
      }
    });
  }

  function updateTrackUI(track = state.currentTrack) {
    if (!track) return;

    const title = track.title;
    const artist = track.artist;
    const artwork = track.artwork;

    if (elements.title) {
      elements.title.textContent = title;
    }

    if (elements.artist) {
      elements.artist.textContent = artist;
    }

    if (elements.fullTitle) {
      elements.fullTitle.textContent = title;
    }

    if (elements.fullArtist) {
      elements.fullArtist.textContent = artist;
    }

    [
      elements.artwork,
      elements.fullArtwork
    ].forEach(element => {
      if (!element) return;

      if (element.tagName === "IMG") {
        if (artwork) {
          element.src = artwork;
          element.alt = `Portada de ${title}`;
        } else {
          element.removeAttribute("src");
          element.alt = "";
        }
      }
    });

    document.title = `${title} — ${artist} | Shunel`;

    updateMediaSession(track);
  }

  function setPlaying(value, reason = "manual") {
    const changed = state.isPlaying !== Boolean(value);

    state.isPlaying = Boolean(value);

    updatePlayButtons();

    if (!changed) return;

    emit(state.isPlaying ? "play" : "pause", {
      track: getCurrentTrack(),
      source: state.source,
      reason
    });
  }

  /* =========================================
     MEDIA SESSION
  ========================================= */

  function updateMediaSession(track) {
    if (!("mediaSession" in navigator) || !track) {
      return;
    }

    try {
      navigator.mediaSession.metadata =
        new MediaMetadata({
          title: track.title,
          artist: track.artist,
          album: track.album || "Shunel",

          artwork: track.artwork
            ? [{
                src: track.artwork,
                sizes: "512x512",
                type: "image/jpeg"
              }]
            : []
        });

    } catch (error) {
      console.warn(
        "[Shunel Player] Metadata:",
        error
      );
    }
  }

  function registerMediaSession() {
    if (!("mediaSession" in navigator)) return;

    const actions = {
      play: () => play(),
      pause: () => pause(),
      nexttrack: () => next(),
      previoustrack: () => previous(),

      seekto: details => {
        if (Number.isFinite(details.seekTime)) {
          seekToTime(details.seekTime);
        }
      }
    };

    for (const [action, handler] of Object.entries(actions)) {
      try {
        navigator.mediaSession.setActionHandler(
          action,
          handler
        );
      } catch {}
    }
  }

  /* =========================================
     PROGRESO EXTERNO
  ========================================= */

  function stopExternalProgress() {
    if (state.externalProgressTimer !== null) {
      clearInterval(state.externalProgressTimer);
      state.externalProgressTimer = null;
    }
  }

  function startExternalProgress() {
    stopExternalProgress();

    state.externalProgressTimer = setInterval(() => {
      if (
        state.source !== "youtube" ||
        !state.isPlaying
      ) {
        return;
      }

      updateTimeUI();

    }, 500);
  }

  function updateExternalProgress() {
    if (state.source !== "youtube") return;

    updateTimeUI();
  }

  /* =========================================
     BÚSQUEDA DE POSICIÓN
  ========================================= */

  function seekToTime(seconds) {
    const duration = getDuration();

    if (!duration) return false;

    const time = Math.max(
      0,
      Math.min(duration, Number(seconds) || 0)
    );

    if (state.source === "youtube") {
      const controller = state.externalController;

      if (typeof controller?.seekTo !== "function") {
        return false;
      }

      try {
        controller.seekTo(time);
        state.externalTime = time;
      } catch (error) {
        console.error(
          "[Shunel Player] Error buscando posición:",
          error
        );

        return false;
      }

    } else {
      audio.currentTime = time;
    }

    updateTimeUI();

    return true;
  }

  function seek(value) {
    const percentage = Math.max(
      0,
      Math.min(1000, Number(value) || 0)
    );

    const duration = getDuration();

    if (!duration) return false;

    return seekToTime(
      duration * (percentage / 1000)
    );
  }

  /* =========================================
     CONTROLADOR EXTERNO
  ========================================= */

  function stopExternal() {
    stopExternalProgress();

    const controller = state.externalController;

    if (!controller) return;

    state.externalController = null;

    try {
      controller.destroy?.();
    } catch (error) {
      console.warn(
        "[Shunel Player] Error cerrando fuente externa:",
        error
      );
    }
  }

  function setExternalController(controller) {
    if (
      !controller ||
      typeof controller.play !== "function" ||
      typeof controller.pause !== "function"
    ) {
      throw new TypeError(
        "El controlador externo debe incluir play() y pause()."
      );
    }

    stopExternal();

    state.externalController = controller;

    return true;
  }

  function setExternalState(playing) {
    const active = Boolean(playing);

    setPlaying(active, "external");

    if (active) {
      startExternalProgress();
    } else {
      stopExternalProgress();
      updateTimeUI();
    }
  }

  /* =========================================
     VOLUMEN
  ========================================= */

  function getVolumeSliderValue(volume) {
    const max = Number(elements.volume?.max);

    return Number.isFinite(max) && max > 1
      ? volume * max
      : volume;
  }

  function normalizeVolumeValue(value) {
    const number = Number(value);

    if (!Number.isFinite(number)) return 0;

    const max = Number(elements.volume?.max);

    if (Number.isFinite(max) && max > 1) {
      return number / max;
    }

    return number > 1 ? number / 100 : number;
  }

  function setVolume(value) {
    const volume = Math.max(
      0,
      Math.min(1, Number(value) || 0)
    );

    state.volume = volume;

    audio.volume = volume;

    if (elements.volume) {
      elements.volume.value =
        getVolumeSliderValue(volume);
    }

    if (state.externalController?.setVolume) {
      try {
        state.externalController.setVolume(volume * 100);
      } catch (error) {
        console.warn(
          "[Shunel Player] Error ajustando volumen externo:",
          error
        );
      }
    }

    saveSettings();

    emit("volumechange", { volume });

    return volume;
  }

  /* =========================================
     REPRODUCCIÓN
  ========================================= */

  async function pause() {
    if (state.externalController) {
      try {
        await state.externalController.pause();
      } catch (error) {
        console.warn(
          "[Shunel Player] Error pausando fuente externa:",
          error
        );
      }
    }

    audio.pause();

    setPlaying(false, "manual");

    return true;
  }

  async function play() {
    if (!state.currentTrack) {
      if (state.queue.length) {
        return playTrack(state.queue[0]);
      }

      notify("No hay ninguna canción seleccionada.");
      return false;
    }

    if (state.externalController) {
      try {
        const result =
          await state.externalController.play();

        if (result === false) return false;

        return true;

      } catch (error) {
        console.error(
          "[Shunel Player] Error externo:",
          error
        );

        return false;
      }
    }

    if (!audio.src) return false;

    try {
      await audio.play();

      setPlaying(true, "manual");

      return true;

    } catch (error) {
      console.error(
        "[Shunel Player] No se pudo reproducir:",
        error
      );

      setPlaying(false, "error");

      notify("No se pudo reproducir esta canción.");

      return false;
    }
  }

  async function togglePlay() {
    return state.isPlaying
      ? pause()
      : play();
  }

  async function playTrack(track, newQueue = null) {
    const normalized = normalizeTrack(track);

    if (!normalized) {
      notify("Esta canción no es válida.");
      return false;
    }

    const requestId = ++state.playRequest;

    if (newQueue) {
      state.queue = newQueue
        .map(normalizeTrack)
        .filter(Boolean);
    }

    const index = state.queue.findIndex(
      item => item.id === normalized.id
    );

    if (index >= 0) {
      state.currentIndex = index;
    } else {
      state.queue.push(normalized);
      state.currentIndex = state.queue.length - 1;
    }

    state.currentTrack = normalized;
    state.isLoading = true;

    state.externalTime = 0;
    state.externalDuration = normalized.duration || 0;

    stopExternal();

    audio.pause();
    audio.removeAttribute("src");
    audio.load();

    state.source = isYouTube(normalized)
      ? "youtube"
      : "local";

    setPlaying(false, "trackchange");

    updateTrackUI(normalized);
    updateTimeUI();

    emit("trackchange", {
      track: getCurrentTrack(),
      index: state.currentIndex,
      queue: getQueue(),
      source: state.source
    });

    emit("queuechange", {
      queue: getQueue(),
      currentIndex: state.currentIndex
    });

    try {
      if (isYouTube(normalized)) {
        emit("external-play", {
          track: getCurrentTrack()
        });

        notify("Preparando reproducción de YouTube.");

        /*
          youtube.js se encarga de crear
          el reproductor y cargar el video.
        */

        state.isLoading = false;

        return true;
      }

      if (!normalized.audioUrl) {
        throw new Error(
          "La canción no tiene una dirección de audio válida."
        );
      }

      audio.src = normalized.audioUrl;
      audio.load();

      await audio.play();

      if (requestId !== state.playRequest) {
        audio.pause();
        return false;
      }

      state.isLoading = false;

      setPlaying(true, "trackchange");

      emit("trackloaded", {
        track: getCurrentTrack()
      });

      return true;

    } catch (error) {
      if (requestId !== state.playRequest) {
        return false;
      }

      state.isLoading = false;

      setPlaying(false, "error");

      console.error(
        "[Shunel Player] Error:",
        error
      );

      emit("playerror", {
        track: getCurrentTrack(),
        message: error.message
      });

      notify("No se pudo reproducir esta canción.");

      return false;
    }
  }

  /* =========================================
     COLA
  ========================================= */

  async function setQueue(
    tracks,
    startIndex = 0,
    autoplay = true
  ) {
    if (!Array.isArray(tracks)) return false;

    const normalized = tracks
      .map(normalizeTrack)
      .filter(Boolean);

    if (!normalized.length) {
      notify("La cola está vacía.");
      return false;
    }

    state.queue = normalized;

    const index = Math.max(
      0,
      Math.min(
        normalized.length - 1,
        Number(startIndex) || 0
      )
    );

    state.currentIndex = index;

    emit("queuechange", {
      queue: getQueue(),
      currentIndex: index
    });

    if (!autoplay) {
      state.currentTrack = normalized[index];

      state.source = isYouTube(normalized[index])
        ? "youtube"
        : "local";

      updateTrackUI();
      return true;
    }

    return playTrack(normalized[index]);
  }

  function addToQueue(track, nextTrack = false) {
    const normalized = normalizeTrack(track);

    if (!normalized) return false;

    if (nextTrack && state.currentIndex >= 0) {
      state.queue.splice(
        state.currentIndex + 1,
        0,
        normalized
      );
    } else {
      state.queue.push(normalized);
    }

    emit("queuechange", {
      queue: getQueue(),
      currentIndex: state.currentIndex
    });

    return true;
  }

  function removeFromQueue(index) {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= state.queue.length
    ) {
      return false;
    }

    const wasCurrent = index === state.currentIndex;

    state.queue.splice(index, 1);

    if (index < state.currentIndex) {
      state.currentIndex--;
    }

    if (!state.queue.length) {
      clearQueue();
      return true;
    }

    if (wasCurrent) {
      const nextIndex = Math.min(
        index,
        state.queue.length - 1
      );

      playTrack(state.queue[nextIndex]);
    }

    emit("queuechange", {
      queue: getQueue(),
      currentIndex: state.currentIndex
    });

    return true;
  }

  function clearQueue() {
    stop();

    state.queue = [];
    state.currentIndex = -1;
    state.currentTrack = null;
    state.source = "none";

    updatePlayButtons();
    updateTimeUI();

    emit("queuechange", {
      queue: [],
      currentIndex: -1
    });

    emit("trackchange", {
      track: null,
      source: "none"
    });

    return true;
  }

  async function next() {
    if (!state.queue.length) return false;

    if (
      state.repeat === "one" &&
      state.currentTrack
    ) {
      return playTrack(state.currentTrack);
    }

    let nextIndex;

    if (state.shuffle && state.queue.length > 1) {
      const available = state.queue
        .map((_, index) => index)
        .filter(index => index !== state.currentIndex);

      nextIndex = available[
        Math.floor(Math.random() * available.length)
      ];

    } else {
      nextIndex = state.currentIndex + 1;
    }

    if (nextIndex >= state.queue.length) {
      if (state.repeat === "all") {
        nextIndex = 0;
      } else {
        await stop();

        emit("queueend", {});

        return false;
      }
    }

    return playTrack(state.queue[nextIndex]);
  }

  async function previous() {
    if (!state.queue.length) return false;

    if (getCurrentTime() > 3) {
      seekToTime(0);
      return true;
    }

    let index = state.currentIndex - 1;

    if (index < 0) {
      index = state.repeat === "all"
        ? state.queue.length - 1
        : 0;
    }

    return playTrack(state.queue[index]);
  }

  async function stop() {
    ++state.playRequest;

    audio.pause();
    audio.currentTime = 0;

    stopExternal();

    state.externalTime = 0;
    state.externalDuration = 0;

    state.isLoading = false;
    state.source = "none";

    setPlaying(false, "stop");

    updateTimeUI();

    return true;
  }

  /* =========================================
     ALEATORIO Y REPETICIÓN
  ========================================= */

  function toggleShuffle() {
    state.shuffle = !state.shuffle;

    elements.shuffle?.classList.toggle(
      "active",
      state.shuffle
    );

    emit("shufflechange", {
      enabled: state.shuffle
    });

    saveSettings();

    return state.shuffle;
  }

  function toggleRepeat() {
    const modes = ["off", "all", "one"];

    const index = modes.indexOf(state.repeat);

    state.repeat = modes[
      (index + 1) % modes.length
    ];

    if (elements.repeat) {
      elements.repeat.classList.toggle(
        "active",
        state.repeat !== "off"
      );

      elements.repeat.dataset.mode = state.repeat;
    }

    emit("repeatchange", {
      mode: state.repeat
    });

    saveSettings();

    return state.repeat;
  }

  /* =========================================
     CONFIGURACIÓN
  ========================================= */

  function saveSettings() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          volume: state.volume,
          shuffle: state.shuffle,
          repeat: state.repeat
        })
      );
    } catch (error) {
      console.warn(
        "[Shunel Player] No se pudo guardar:",
        error
      );
    }
  }

  function loadSettings() {
    try {
      const settings = JSON.parse(
        localStorage.getItem(STORAGE_KEY) || "{}"
      );

      if (Number.isFinite(settings.volume)) {
        state.volume = Math.max(
          0,
          Math.min(1, settings.volume)
        );
      }

      state.shuffle = Boolean(settings.shuffle);

      if (
        ["off", "all", "one"].includes(settings.repeat)
      ) {
        state.repeat = settings.repeat;
      }

    } catch {
      console.warn(
        "[Shunel Player] Configuración inválida."
      );
    }

    audio.volume = state.volume;

    if (elements.volume) {
      elements.volume.value =
        getVolumeSliderValue(state.volume);
    }

    elements.shuffle?.classList.toggle(
      "active",
      state.shuffle
    );

    elements.repeat?.classList.toggle(
      "active",
      state.repeat !== "off"
    );

    if (elements.repeat) {
      elements.repeat.dataset.mode = state.repeat;
    }
  }

  /* =========================================
     CONTROLES
  ========================================= */

  function bindControls() {
    elements.miniPlay?.addEventListener(
      "click",
      togglePlay
    );

    elements.play?.addEventListener(
      "click",
      togglePlay
    );

    elements.miniNext?.addEventListener(
      "click",
      next
    );

    elements.next?.addEventListener(
      "click",
      next
    );

    elements.miniPrevious?.addEventListener(
      "click",
      previous
    );

    elements.previous?.addEventListener(
      "click",
      previous
    );

    elements.shuffle?.addEventListener(
      "click",
      toggleShuffle
    );

    elements.repeat?.addEventListener(
      "click",
      toggleRepeat
    );

    elements.volume?.addEventListener("input", event => {
      const value = normalizeVolumeValue(
        event.target.value
      );

      setVolume(value);
    });

    elements.seek?.addEventListener("change", event => {
      seek(event.target.value);
    });

    audio.addEventListener("play", () => {
      if (state.source === "local") {
        setPlaying(true, "audio");
      }
    });

    audio.addEventListener("pause", () => {
      if (state.source === "local") {
        setPlaying(false, "audio");
      }
    });

    audio.addEventListener("ended", () => {
      if (state.source !== "local") return;

      if (state.repeat === "one") {
        audio.currentTime = 0;
        play();
      } else {
        next();
      }
    });

    audio.addEventListener(
      "timeupdate",
      updateTimeUI
    );

    audio.addEventListener(
      "loadedmetadata",
      updateTimeUI
    );

    audio.addEventListener("error", () => {
      if (
        state.source === "local" &&
        state.currentTrack
      ) {
        emit("playerror", {
          track: getCurrentTrack(),
          message: "Error al cargar el archivo de audio."
        });
      }
    });

    registerMediaSession();
  }

  /* =========================================
     INICIALIZACIÓN
  ========================================= */

  function initialize() {
    if (state.initialized) return true;

    loadSettings();
    bindControls();

    state.initialized = true;

    emit("player:ready", {
      version: "2.2.0"
    });

    console.info(
      "[Shunel Player] Motor inicializado."
    );

    return true;
  }

  /* =========================================
     API PÚBLICA
  ========================================= */

  window.ShunelPlayer = Object.freeze({
    initialize,

    play,
    pause,
    togglePlay,
    stop,

    playTrack,

    setQueue,
    addToQueue,
    removeFromQueue,
    clearQueue,

    next,
    previous,

    seek,
    seekToTime,

    getCurrentTime,
    getDuration,

    setVolume,
    toggleShuffle,
    toggleRepeat,

    getCurrentTrack,
    getQueue,
    getState,

    getAudio: () => audio,
    formatTime,
    isYouTube,

    setExternalController,
    setExternalState,
    updateExternalProgress
  });

  initialize();

})();
