
/* =========================================
   SHUNEL — PLAYER ENGINE
   Motor central de reproducción
   Version: 2.0.0
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
    fullTitle: $("trackTitle"),
    fullArtist: $("trackArtist"),
    fullArtwork: $("trackArtwork")
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
    playRequest: 0
  };

  const STORAGE_KEY = "shunel_player_settings";

  function emit(name, detail = {}) {
    if (window.ShunelEvents) {
      window.ShunelEvents.emit(name, detail);
      return;
    }

    window.dispatchEvent(
      new CustomEvent(`shunel:${name}`, { detail })
    );
  }

  function notify(message) {
    if (typeof window.ShunelNotify === "function") {
      window.ShunelNotify(message);
      return;
    }

    const toast = $("toast");

    if (!toast) return;

    toast.textContent = message;
    toast.hidden = false;
    toast.classList.add("show");

    clearTimeout(notify.timer);

    notify.timer = setTimeout(() => {
      toast.classList.remove("show");
      toast.hidden = true;
    }, 2500);
  }

  function normalizeTrack(track) {
    if (!track || typeof track !== "object") {
      return null;
    }

    const title = String(track.title || track.name || "Sin título").trim();
    const artist = String(track.artist || track.channelTitle || "Artista desconocido").trim();

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

    let source = track.source;

    if (!source) {
      source = videoId
        ? "youtube"
        : rawUrl
          ? "local"
          : "unknown";
    }

    const id = String(
      track.id ||
      (videoId ? `youtube:${videoId}` : rawUrl || `${title}:${artist}`)
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

  function safeImageUrl(value) {
    if (!value) return "";

    try {
      const url = new URL(value, location.href);

      if (["http:", "https:", "blob:"].includes(url.protocol)) {
        return url.href;
      }
    } catch {}

    return "";
  }

  function safeAudioUrl(value) {
    if (!value) return "";

    try {
      const url = new URL(value, location.href);

      if (["http:", "https:", "blob:", "data:"].includes(url.protocol)) {
        return url.href;
      }
    } catch {}

    return "";
  }

  function isYouTube(track) {
    return Boolean(
      track &&
      (
        track.source === "youtube" ||
        track.videoId
      )
    );
  }

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
      source: state.source
    };
  }

  function updatePlayButtons() {
    const iconName = state.isPlaying ? "pause" : "play";

    [
      elements.miniPlay,
      elements.play
    ].forEach(button => {
      if (!button) return;

      button.dataset.state = state.isPlaying ? "playing" : "paused";
      button.setAttribute(
        "aria-label",
        state.isPlaying ? "Pausar" : "Reproducir"
      );

      const icon = button.querySelector("i, svg");

      if (icon && icon.tagName === "I") {
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
      if (!element || !artwork) return;

      if (element.tagName === "IMG") {
        element.src = artwork;
        element.alt = `Portada de ${title}`;
      }
    });

    document.title = `${title} — ${artist} | Shunel`;

    updateMediaSession(track);
  }

  function updateTimeUI() {
    const current = audio.currentTime || 0;
    const duration = audio.duration || 0;

    if (elements.currentTime) {
      elements.currentTime.textContent = formatTime(current);
    }

    if (elements.duration) {
      elements.duration.textContent = formatTime(duration);
    }

    if (elements.seek && duration > 0) {
      elements.seek.value = Math.floor(
        (current / duration) * 1000
      );
    }
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) {
      return "0:00";
    }

    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);

    return `${mins}:${String(secs).padStart(2, "0")}`;
  }

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
            ? [
                {
                  src: track.artwork,
                  sizes: "512x512",
                  type: "image/jpeg"
                }
              ]
            : []
        });
    } catch (error) {
      console.warn("[Shunel Player] Metadata:", error);
    }
  }

  function setPlaying(value, reason = "manual") {
    const changed = state.isPlaying !== Boolean(value);

    state.isPlaying = Boolean(value);

    updatePlayButtons();

    if (!changed) return;

    emit(
      state.isPlaying ? "play" : "pause",
      {
        track: getCurrentTrack(),
        source: state.source,
        reason
      }
    );
  }

  async function pause() {
    if (state.externalController) {
      try {
        await state.externalController.pause();
      } catch (error) {
        console.warn("[Shunel Player] Error pausando fuente externa:", error);
      }
    }

    audio.pause();

    setPlaying(false, "manual");

    return true;
  }

  async function play() {
    if (!state.currentTrack) {
      if (state.queue.length) {
        return playTrack(
          state.queue[0],
          state.queue
        );
      }

      notify("No hay ninguna canción seleccionada.");
      return false;
    }

    if (state.externalController) {
      try {
        const result = await state.externalController.play();

        if (result === false) return false;

        setPlaying(true, "manual");
        return true;
      } catch (error) {
        console.error("[Shunel Player] Error externo:", error);
        return false;
      }
    }

    if (!audio.src) return false;

    try {
      await audio.play();
      setPlaying(true, "manual");
      return true;
    } catch (error) {
      console.error("[Shunel Player] No se pudo reproducir:", error);
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

  function stopExternal() {
    if (!state.externalController) return;

    try {
      state.externalController.destroy?.();
    } catch (error) {
      console.warn("[Shunel Player] Error cerrando fuente externa:", error);
    }

    state.externalController = null;
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

    stopExternal();
    audio.pause();
    audio.removeAttribute("src");
    audio.load();

    state.source = isYouTube(normalized)
      ? "youtube"
      : "local";

    updateTrackUI(normalized);

    emit("trackchange", {
      track: getCurrentTrack(),
      index: state.currentIndex,
      queue: getQueue(),
      source: state.source
    });

    try {
      if (isYouTube(normalized)) {
        emit("external-play", {
          track: getCurrentTrack()
        });

        notify("Preparando reproducción de YouTube.");
        state.isLoading = false;
        return true;
      }

      if (!normalized.audioUrl) {
        throw new Error("La canción no tiene una dirección de audio válida.");
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
      if (requestId !== state.playRequest) return false;

      state.isLoading = false;
      setPlaying(false, "error");

      console.error("[Shunel Player] Error:", error);

      emit("playerror", {
        track: getCurrentTrack(),
        message: error.message
      });

      notify("No se pudo reproducir esta canción.");

      return false;
    }
  }

  async function setQueue(tracks, startIndex = 0, autoplay = true) {
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
      updateTrackUI();
      return true;
    }

    return playTrack(normalized[index]);
  }

  function addToQueue(track, next = false) {
    const normalized = normalizeTrack(track);

    if (!normalized) return false;

    if (next && state.currentIndex >= 0) {
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
      stop();
    } else if (wasCurrent) {
      state.currentIndex = Math.min(
        index,
        state.queue.length - 1
      );

      playTrack(state.queue[state.currentIndex]);
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

    updatePlayButtons();

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

    let nextIndex;

    if (state.repeat === "one") {
      return playTrack(state.currentTrack);
    }

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

    if (audio.currentTime > 3 && state.source === "local") {
      audio.currentTime = 0;
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

    state.source = "none";
    setPlaying(false, "stop");

    return true;
  }

  function seek(value) {
    if (state.source !== "local") return false;

    const duration = audio.duration;

    if (!Number.isFinite(duration)) return false;

    const percentage = Math.max(
      0,
      Math.min(1000, Number(value) || 0)
    );

    audio.currentTime = duration * (percentage / 1000);

    updateTimeUI();

    emit("seek", {
      currentTime: audio.currentTime,
      duration
    });

    return true;
  }

  function setVolume(value) {
    const volume = Math.max(
      0,
      Math.min(1, Number(value))
    );

    state.volume = volume;
    audio.volume = volume;

    if (elements.volume) {
      elements.volume.value = volume;
    }

    saveSettings();

    emit("volumechange", {
      volume
    });

    return volume;
  }

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
      console.warn("[Shunel Player] No se pudo guardar:", error);
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

      if (["off", "all", "one"].includes(settings.repeat)) {
        state.repeat = settings.repeat;
      }
    } catch {
      console.warn("[Shunel Player] Configuración inválida.");
    }

    audio.volume = state.volume;

    if (elements.volume) {
      elements.volume.value = state.volume;
    }

    elements.shuffle?.classList.toggle(
      "active",
      state.shuffle
    );

    elements.repeat?.classList.toggle(
      "active",
      state.repeat !== "off"
    );
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
          audio.currentTime = details.seekTime;
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

  function bindControls() {
    elements.miniPlay?.addEventListener("click", togglePlay);
    elements.play?.addEventListener("click", togglePlay);

    elements.miniNext?.addEventListener("click", next);
    elements.next?.addEventListener("click", next);

    elements.miniPrevious?.addEventListener("click", previous);
    elements.previous?.addEventListener("click", previous);

    elements.shuffle?.addEventListener("click", toggleShuffle);
    elements.repeat?.addEventListener("click", toggleRepeat);

    elements.volume?.addEventListener("input", event => {
      setVolume(event.target.value);
    });

    elements.seek?.addEventListener("input", event => {
      seek(event.target.value);
    });

    audio.addEventListener("play", () => {
      setPlaying(true, "audio");
    });

    audio.addEventListener("pause", () => {
      if (state.source === "local") {
        setPlaying(false, "audio");
      }
    });

    audio.addEventListener("ended", () => {
      if (state.repeat === "one") {
        audio.currentTime = 0;
        play();
      } else {
        next();
      }
    });

    audio.addEventListener("timeupdate", updateTimeUI);
    audio.addEventListener("loadedmetadata", updateTimeUI);

    audio.addEventListener("error", () => {
      if (state.source === "local" && state.currentTrack) {
        emit("playerror", {
          track: getCurrentTrack(),
          message: "Error al cargar el archivo de audio."
        });
      }
    });

    registerMediaSession();
  }

  function initialize() {
    if (state.initialized) return;

    loadSettings();
    bindControls();

    state.initialized = true;

    emit("player:ready", {
      version: "2.0.0"
    });

    console.info("[Shunel Player] Motor inicializado.");
  }

  window.ShunelPlayer = Object.freeze({
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
    setVolume,
    toggleShuffle,
    toggleRepeat,
    getCurrentTrack,
    getQueue,
    getState,
    getAudio: () => audio,
    formatTime,
    isYouTube,
    setExternalController(controller) {
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
    },
    setExternalState(playing) {
      setPlaying(playing, "external");
    }
  });

  initialize();

})();
