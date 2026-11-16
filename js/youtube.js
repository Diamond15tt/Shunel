
/* =========================================
   SHUNEL — YOUTUBE ENGINE
   Reproducción mediante YouTube IFrame API
   Version: 2.1.0
========================================= */

(() => {
  "use strict";

  if (window.ShunelYouTube) {
    console.warn("[Shunel YouTube] Ya está inicializado.");
    return;
  }

  const state = {
    initialized: false,
    apiReady: false,
    playerReady: false,
    loading: false,

    player: null,
    container: null,
    mount: null,

    currentVideoId: null,
    pendingVideoId: null,

    loadingPromise: null,
    playerPromise: null,
    playerResolve: null,
    playerReject: null,

    lastError: null,
    volume: 80
  };

  const PLAYER = () => window.ShunelPlayer;

  /* =========================================
     EVENTOS
  ========================================= */

  function emit(name, detail = {}) {
    if (window.ShunelEvents) {
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

    const toast = document.getElementById("toast");

    if (!toast) return;

    toast.textContent = message;
    toast.hidden = false;
    toast.classList.add("show");

    clearTimeout(notify.timer);

    notify.timer = setTimeout(() => {
      toast.classList.remove("show");
      toast.hidden = true;
    }, 3000);
  }

  /* =========================================
     IDENTIFICACIÓN DE VIDEOS
  ========================================= */

  function normalizeVideoId(value) {
    if (!value) return null;

    const input = String(value).trim();

    if (/^[a-zA-Z0-9_-]{11}$/.test(input)) {
      return input;
    }

    try {
      const url = new URL(input);

      if (url.hostname === "youtu.be") {
        return url.pathname.split("/").filter(Boolean)[0] || null;
      }

      if (
        url.hostname.includes("youtube.com") ||
        url.hostname.includes("youtube-nocookie.com")
      ) {
        const videoId = url.searchParams.get("v");

        if (videoId) return videoId;

        const parts = url.pathname.split("/").filter(Boolean);

        if (
          ["embed", "shorts", "live"].includes(parts[0]) &&
          parts[1]
        ) {
          return parts[1];
        }
      }
    } catch {}

    return null;
  }

  function getVideoId(track) {
    if (!track) return null;

    return normalizeVideoId(
      track.videoId ||
      track.youtubeId ||
      track.id
    );
  }

  /* =========================================
     CONTENEDOR
  ========================================= */

  function prepareContainer() {
    const container = document.getElementById(
      "youtubePlayerContainer"
    );

    if (!container) {
      throw new Error(
        "No se encontró #youtubePlayerContainer en el HTML."
      );
    }

    let mount = document.getElementById("shunelYoutubeMount");

    if (!mount) {
      mount = document.createElement("div");
      mount.id = "shunelYoutubeMount";

      const existing = document.getElementById("youtubePlayer");

      if (existing) {
        existing.replaceWith(mount);
      } else {
        container.appendChild(mount);
      }
    }

    state.container = container;
    state.mount = mount;

    return mount;
  }

  function showPlayer() {
    if (state.container) {
      state.container.hidden = false;
      state.container.classList.add("youtube-active");
    }
  }

  function hidePlayer() {
    if (state.container) {
      state.container.classList.remove("youtube-active");
      state.container.hidden = true;
    }
  }

  /* =========================================
     CARGA DE YOUTUBE IFRAME API
  ========================================= */

  function loadAPI() {
    if (window.YT?.Player) {
      state.apiReady = true;
      return Promise.resolve(true);
    }

    if (state.loadingPromise) {
      return state.loadingPromise;
    }

    state.loading = true;

    state.loadingPromise = new Promise((resolve, reject) => {
      let finished = false;

      const previousCallback = window.onYouTubeIframeAPIReady;

      const timeout = setTimeout(() => {
        finish(
          new Error("YouTube tardó demasiado en cargar.")
        );
      }, 20000);

      function finish(error) {
        if (finished) return;

        finished = true;
        clearTimeout(timeout);

        state.loading = false;

        if (error) {
          state.loadingPromise = null;
          reject(error);
          return;
        }

        state.apiReady = true;
        resolve(true);
      }

      window.onYouTubeIframeAPIReady = () => {
        try {
          if (typeof previousCallback === "function") {
            previousCallback();
          }
        } catch (error) {
          console.warn(
            "[Shunel YouTube] Callback anterior:",
            error
          );
        }

        finish();
      };

      const existing = document.querySelector(
        'script[src*="youtube.com/iframe_api"]'
      );

      if (!existing) {
        const script = document.createElement("script");

        script.src = "https://www.youtube.com/iframe_api";
        script.async = true;

        script.onerror = () => {
          finish(
            new Error("No se pudo cargar YouTube IFrame API.")
          );
        };

        document.head.appendChild(script);
      }
    });

    return state.loadingPromise;
  }

  /* =========================================
     ESTADOS DEL REPRODUCTOR
  ========================================= */

  function resolvePlayer() {
    state.playerReady = true;

    try {
      state.player?.setVolume(state.volume);
    } catch {}

    if (state.playerResolve) {
      state.playerResolve(true);
      state.playerResolve = null;
      state.playerReject = null;
    }

    emit("youtube:player-ready", {});

    if (state.pendingVideoId) {
      const videoId = state.pendingVideoId;
      state.pendingVideoId = null;

      playVideo(videoId).catch(error => {
        console.error("[Shunel YouTube] Error pendiente:", error);
      });
    }
  }

  function rejectPlayer(error) {
    if (state.playerReject) {
      state.playerReject(error);
      state.playerResolve = null;
      state.playerReject = null;
    }
  }

  function waitForPlayer() {
    if (state.playerReady && state.player) {
      return Promise.resolve(true);
    }

    if (state.playerPromise) {
      return state.playerPromise;
    }

    state.playerPromise = new Promise((resolve, reject) => {
      state.playerResolve = resolve;
      state.playerReject = reject;

      const timeout = setTimeout(() => {
        if (!state.playerReady) {
          rejectPlayer(
            new Error("El reproductor de YouTube no respondió.")
          );

          state.playerPromise = null;
        }
      }, 20000);

      const originalResolve = state.playerResolve;

      state.playerResolve = value => {
        clearTimeout(timeout);
        originalResolve(value);
      };
    });

    return state.playerPromise;
  }

  /* =========================================
     EVENTOS DEL REPRODUCTOR
  ========================================= */

  function handleReady() {
    resolvePlayer();

    console.info("[Shunel YouTube] Reproductor listo.");
  }

  function handleStateChange(event) {
    const YTState = window.YT?.PlayerState;
    const player = PLAYER();

    if (!YTState) return;

    if (event.data === YTState.PLAYING) {
      showPlayer();

      player?.setExternalState(true);
      player?.updateExternalProgress();

      emit("youtube:playing", {
        videoId: state.currentVideoId
      });
    }

    if (event.data === YTState.PAUSED) {
      player?.setExternalState(false);
      player?.updateExternalProgress();

      emit("youtube:paused", {
        videoId: state.currentVideoId
      });
    }

    if (event.data === YTState.ENDED) {
      player?.setExternalState(false);

      emit("youtube:ended", {
        videoId: state.currentVideoId
      });

      player?.next();
    }

    if (event.data === YTState.BUFFERING) {
      emit("youtube:buffering", {});
    }

    if (event.data === YTState.CUED) {
      emit("youtube:cued", {});
    }
  }

  function handleError(event) {
    const messages = {
      2: "El identificador del video no es válido.",
      5: "Este video no se puede reproducir en el reproductor HTML5.",
      100: "El video no existe o fue eliminado.",
      101: "El propietario no permite reproducir este video.",
      150: "El propietario no permite reproducir este video."
    };

    const message =
      messages[event.data] ||
      "Ocurrió un error reproduciendo YouTube.";

    state.lastError = {
      code: event.data,
      message
    };

    PLAYER()?.setExternalState(false);

    emit("youtube:error", state.lastError);

    notify(message);

    console.error("[Shunel YouTube]", state.lastError);
  }

  /* =========================================
     INICIALIZACIÓN
  ========================================= */

  async function initialize() {
    if (state.initialized) return true;

    prepareContainer();

    await loadAPI();

    if (state.player) {
      await waitForPlayer();
      state.initialized = true;
      return true;
    }

    state.player = new window.YT.Player(state.mount, {
      width: "100%",
      height: "100%",

      playerVars: {
        autoplay: 0,
        controls: 0,
        disablekb: 1,
        fs: 0,
        playsinline: 1,
        rel: 0,
        modestbranding: 1
      },

      events: {
        onReady: handleReady,
        onStateChange: handleStateChange,
        onError: handleError
      }
    });

    await waitForPlayer();

    state.initialized = true;

    emit("youtube:ready", {});

    return true;
  }

  /* =========================================
     REPRODUCCIÓN
  ========================================= */

  async function playVideo(value) {
    const videoId = normalizeVideoId(value);

    if (!videoId) {
      throw new Error("El video de YouTube no es válido.");
    }

    await initialize();

    if (!state.playerReady || !state.player) {
      state.pendingVideoId = videoId;
      return false;
    }

    state.currentVideoId = videoId;

    showPlayer();

    state.player.loadVideoById({
      videoId,
      startSeconds: 0
    });

    emit("youtube:load", { videoId });

    return true;
  }

  async function playTrack(track) {
    const videoId = getVideoId(track);

    if (!videoId) {
      notify("Esta canción no tiene un video de YouTube válido.");
      return false;
    }

    try {
      await initialize();

      const player = PLAYER();

      if (!player) {
        throw new Error("El motor central no está disponible.");
      }

      player.setExternalController({
        play: () => resume(),
        pause: () => pause(),
        destroy: () => {
          stop();
        },
        getCurrentTime: () => getCurrentTime(),
        getDuration: () => getDuration(),
        seekTo: seconds => seekTo(seconds),
        setVolume: value => setVolume(value)
      });

      return await playVideo(videoId);

    } catch (error) {
      console.error("[Shunel YouTube] Error:", error);

      notify("No se pudo iniciar YouTube.");

      return false;
    }
  }

  async function pause() {
    if (!state.playerReady || !state.player) return false;

    state.player.pauseVideo();

    return true;
  }

  async function resume() {
    if (!state.playerReady || !state.player) return false;

    state.player.playVideo();

    return true;
  }

  function stop() {
    if (state.playerReady && state.player) {
      try {
        state.player.stopVideo();
      } catch {}
    }

    state.currentVideoId = null;
    state.pendingVideoId = null;

    return true;
  }

  /* =========================================
     TIEMPO Y DURACIÓN
  ========================================= */

  function getCurrentTime() {
    if (!state.playerReady || !state.player) return 0;

    try {
      return Number(state.player.getCurrentTime()) || 0;
    } catch {
      return 0;
    }
  }

  function getDuration() {
    if (!state.playerReady || !state.player) return 0;

    try {
      return Number(state.player.getDuration()) || 0;
    } catch {
      return 0;
    }
  }

  function seekTo(seconds) {
    if (!state.playerReady || !state.player) return false;

    const duration = getDuration();

    if (!duration) return false;

    const time = Math.max(
      0,
      Math.min(duration, Number(seconds) || 0)
    );

    state.player.seekTo(time, true);

    emit("youtube:seek", {
      currentTime: time,
      duration
    });

    return true;
  }

  /* =========================================
     VOLUMEN
  ========================================= */

  function setVolume(value) {
    const volume = Math.max(
      0,
      Math.min(100, Number(value))
    );

    state.volume = volume;

    if (state.playerReady && state.player) {
      state.player.setVolume(volume);
    }

    return volume;
  }

  function getState() {
    return {
      initialized: state.initialized,
      apiReady: state.apiReady,
      playerReady: state.playerReady,
      currentVideoId: state.currentVideoId,
      currentTime: getCurrentTime(),
      duration: getDuration(),
      volume: state.volume,
      error: state.lastError
    };
  }

  /* =========================================
     SINCRONIZACIÓN
  ========================================= */

  function bindEvents() {
    const events = window.ShunelEvents;

    if (events) {
      events.on("external-play", detail => {
        if (detail?.track) {
          playTrack(detail.track);
        }
      });

      return;
    }

    window.addEventListener("shunel:external-play", event => {
      if (event.detail?.track) {
        playTrack(event.detail.track);
      }
    });
  }

  /* =========================================
     API PÚBLICA
  ========================================= */

  window.ShunelYouTube = Object.freeze({
    initialize,

    playTrack,
    playVideo,

    play: resume,
    pause,
    resume,
    stop,

    setVolume,
    getCurrentTime,
    getDuration,
    seekTo,

    getState,

    show: showPlayer,
    hide: hidePlayer
  });

  bindEvents();

  console.info("[Shunel YouTube] Módulo cargado.");

})();
