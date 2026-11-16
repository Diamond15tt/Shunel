
/* =========================================
   SHUNEL — YOUTUBE ENGINE
   Integración oficial YouTube IFrame API
   Version: 1.0.0
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
    currentVideoId: null,
    pendingVideoId: null,
    player: null,
    container: null,
    mount: null,
    lastError: null
  };

  const PLAYER = () => window.ShunelPlayer;

  function emit(name, detail = {}) {
    if (window.ShunelEvents) {
      window.ShunelEvents.emit(name, detail);
    } else {
      window.dispatchEvent(
        new CustomEvent(`shunel:${name}`, { detail })
      );
    }
  }

  function getContainer() {
    return document.getElementById("youtubePlayerContainer");
  }

  function normalizeVideoId(value) {
    if (!value) return null;

    const id = String(value).trim();

    if (/^[a-zA-Z0-9_-]{11}$/.test(id)) {
      return id;
    }

    try {
      const url = new URL(id);

      if (url.hostname === "youtu.be") {
        const videoId = url.pathname.split("/")[1];

        return /^[a-zA-Z0-9_-]{11}$/.test(videoId)
          ? videoId
          : null;
      }

      if (
        url.hostname.endsWith("youtube.com") ||
        url.hostname.endsWith("youtube-nocookie.com")
      ) {
        const videoId =
          url.searchParams.get("v") ||
          url.pathname.match(/\/embed\/([^/?]+)/)?.[1] ||
          url.pathname.match(/\/shorts\/([^/?]+)/)?.[1];

        return videoId &&
          /^[a-zA-Z0-9_-]{11}$/.test(videoId)
          ? videoId
          : null;
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

  function prepareContainer() {
    const container = getContainer();

    if (!container) {
      throw new Error(
        "No se encontró #youtubePlayerContainer."
      );
    }

    state.container = container;

    let mount = container.querySelector(
      "#shunelYoutubeMount"
    );

    if (!mount) {
      mount = document.createElement("div");
      mount.id = "shunelYoutubeMount";
      container.appendChild(mount);
    }

    state.mount = mount;

    return mount;
  }

  function loadAPI() {
    if (state.apiReady) {
      return Promise.resolve();
    }

    if (window.YT && window.YT.Player) {
      state.apiReady = true;
      return Promise.resolve();
    }

    if (state.loadingPromise) {
      return state.loadingPromise;
    }

    state.loadingPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new Error("Tiempo de espera agotado cargando YouTube.")
        );
      }, 20000);

      const previousCallback = window.onYouTubeIframeAPIReady;

      window.onYouTubeIframeAPIReady = () => {
        clearTimeout(timeout);

        state.apiReady = true;

        try {
          previousCallback?.();
        } catch (error) {
          console.warn("[Shunel YouTube] Callback anterior:", error);
        }

        resolve();
      };

      let script = document.querySelector(
        'script[src="https://www.youtube.com/iframe_api"]'
      );

      if (!script) {
        script = document.createElement("script");
        script.src = "https://www.youtube.com/iframe_api";
        script.async = true;

        script.onerror = () => {
          clearTimeout(timeout);
          reject(
            new Error("No se pudo cargar la API de YouTube.")
          );
        };

        document.head.appendChild(script);
      }
    });

    return state.loadingPromise;
  }

  function waitForPlayer() {
    if (state.playerReady) {
      return Promise.resolve();
    }

    if (state.playerPromise) {
      return state.playerPromise;
    }

    state.playerPromise = new Promise((resolve, reject) => {
      state.playerResolve = resolve;
      state.playerReject = reject;

      const timeout = setTimeout(() => {
        if (!state.playerReady) {
          reject(
            new Error("No se pudo iniciar el reproductor de YouTube.")
          );
        }
      }, 20000);

      state.playerTimeout = timeout;
    });

    return state.playerPromise;
  }

  async function initialize() {
    if (state.initialized) return true;

    prepareContainer();

    await loadAPI();

    if (state.player) {
      return waitForPlayer().then(() => true);
    }

    state.player = new YT.Player(state.mount, {
      width: "100%",
      height: "100%",
      videoId: "",
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

    console.info("[Shunel YouTube] Reproductor preparado.");

    emit("youtube:ready", {});

    return true;
  }

  function handleReady() {
    state.playerReady = true;

    clearTimeout(state.playerTimeout);

    try {
      state.player.setVolume(80);
    } catch {}

    state.playerResolve?.();

    state.playerResolve = null;
    state.playerReject = null;

    emit("youtube:player-ready", {});

    if (state.pendingVideoId) {
      const videoId = state.pendingVideoId;
      state.pendingVideoId = null;

      playVideo(videoId);
    }
  }

  function handleStateChange(event) {
    const playerState = event.data;
    const player = PLAYER();

    if (!player) return;

    if (playerState === YT.PlayerState.PLAYING) {
      showPlayer();

      player.setExternalState(true);

      emit("youtube:playing", {
        videoId: state.currentVideoId
      });
    }

    if (playerState === YT.PlayerState.PAUSED) {
      player.setExternalState(false);

      emit("youtube:paused", {
        videoId: state.currentVideoId
      });
    }

    if (playerState === YT.PlayerState.ENDED) {
      player.setExternalState(false);

      emit("youtube:ended", {
        videoId: state.currentVideoId
      });

      player.next();
    }

    if (playerState === YT.PlayerState.BUFFERING) {
      emit("youtube:buffering", {
        videoId: state.currentVideoId
      });
    }

    if (playerState === YT.PlayerState.CUED) {
      emit("youtube:video-cued", {
        videoId: state.currentVideoId
      });
    }
  }

  function handleError(event) {
    const messages = {
      2: "El identificador del video no es válido.",
      5: "El video no se puede reproducir en este reproductor.",
      100: "El video no existe o fue eliminado.",
      101: "El propietario no permite reproducir este video.",
      150: "El propietario no permite reproducir este video."
    };

    const message =
      messages[event.data] ||
      "YouTube no pudo reproducir este video.";

    state.lastError = {
      code: event.data,
      message
    };

    PLAYER()?.setExternalState(false);

    console.error("[Shunel YouTube]", message);

    emit("youtube:error", {
      code: event.data,
      message,
      videoId: state.currentVideoId
    });

    notify(message);
  }

  function notify(message) {
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

  function showPlayer() {
    if (!state.container) return;

    state.container.hidden = false;
    state.container.classList.add("youtube-active");
  }

  function hidePlayer() {
    if (!state.container) return;

    state.container.classList.remove("youtube-active");
    state.container.hidden = true;
  }

  async function playVideo(videoId) {
    const normalized = normalizeVideoId(videoId);

    if (!normalized) {
      throw new Error("El videoId de YouTube no es válido.");
    }

    await initialize();

    state.currentVideoId = normalized;

    showPlayer();

    state.player.loadVideoById({
      videoId: normalized
    });

    emit("youtube:load", {
      videoId: normalized
    });

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

      state.currentVideoId = videoId;

      PLAYER()?.setExternalController({
        play: async () => {
          state.player.playVideo();
          return true;
        },

        pause: async () => {
          state.player.pauseVideo();
          return true;
        },

        destroy: () => {
          state.player.stopVideo();
          hidePlayer();
        }
      });

      await playVideo(videoId);

      return true;
    } catch (error) {
      console.error("[Shunel YouTube] Error:", error);

      emit("youtube:error", {
        message: error.message,
        videoId
      });

      notify("No se pudo iniciar YouTube.");

      return false;
    }
  }

  function pause() {
    if (!state.playerReady) return false;

    state.player.pauseVideo();

    return true;
  }

  function resume() {
    if (!state.playerReady) return false;

    state.player.playVideo();

    return true;
  }

  function stop() {
    if (!state.playerReady) return false;

    state.player.stopVideo();

    hidePlayer();

    return true;
  }

  function setVolume(value) {
    if (!state.playerReady) return false;

    const volume = Math.max(
      0,
      Math.min(100, Number(value))
    );

    state.player.setVolume(volume);

    return volume;
  }

  function getCurrentTime() {
    if (!state.playerReady) return 0;

    return state.player.getCurrentTime() || 0;
  }

  function getDuration() {
    if (!state.playerReady) return 0;

    return state.player.getDuration() || 0;
  }

  function getState() {
    return {
      initialized: state.initialized,
      apiReady: state.apiReady,
      playerReady: state.playerReady,
      currentVideoId: state.currentVideoId,
      currentTime: getCurrentTime(),
      duration: getDuration(),
      lastError: state.lastError
    };
  }

  function bindEvents() {
    const events = window.ShunelEvents;

    if (events) {
      events.on("external-play", detail => {
        if (detail.track) {
          playTrack(detail.track);
        }
      });

      events.on("trackchange", detail => {
        if (!detail.track || detail.track.source !== "youtube") {
          stop();
          hidePlayer();
        }
      });
    } else {
      window.addEventListener("shunel:external-play", event => {
        if (event.detail?.track) {
          playTrack(event.detail.track);
        }
      });

      window.addEventListener("shunel:trackchange", event => {
        if (
          !event.detail?.track ||
          event.detail.track.source !== "youtube"
        ) {
          stop();
          hidePlayer();
        }
      });
    }
  }

  window.ShunelYouTube = Object.freeze({
    initialize,
    playTrack,
    playVideo,
    pause,
    resume,
    stop,
    setVolume,
    getCurrentTime,
    getDuration,
    getState,
    hide: hidePlayer,
    show: showPlayer
  });

  bindEvents();

  console.info("[Shunel YouTube] Módulo cargado.");

})();
