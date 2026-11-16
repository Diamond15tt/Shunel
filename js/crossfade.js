
/* =========================================
   SHUNEL — CROSSFADE ENGINE
   Transiciones graduales entre canciones
   Version: 2.0.0
========================================= */

(() => {
  "use strict";

  if (window.ShunelCrossfade) {
    console.warn("[Shunel Crossfade] Ya está inicializado.");
    return;
  }

  const STORAGE_KEY = "shunel_crossfade_settings";

  const audio = document.getElementById("localAudio");

  const elements = {
    enabled: document.getElementById("crossfadeSetting"),
    duration: document.getElementById("crossfadeDuration"),
    durationValue: document.getElementById("crossfadeDurationValue")
  };

  const state = {
    enabled: false,
    duration: 5,
    transitioning: false,
    initialized: false,
    transitionTimer: null,
    generation: 0,
    lastTrackId: null
  };

  const MIN_DURATION = 1;
  const MAX_DURATION = 12;

  function emit(name, detail = {}) {
    if (window.ShunelEvents) {
      window.ShunelEvents.emit(name, detail);
    } else {
      window.dispatchEvent(
        new CustomEvent(`shunel:${name}`, { detail })
      );
    }
  }

  function getPlayer() {
    return window.ShunelPlayer || null;
  }

  function getAudioEngine() {
    return window.ShunelAudioEngine || null;
  }

  function clampDuration(value) {
    const number = Number(value);

    if (!Number.isFinite(number)) {
      return 5;
    }

    return Math.max(
      MIN_DURATION,
      Math.min(MAX_DURATION, number)
    );
  }

  function loadSettings() {
    try {
      const saved = JSON.parse(
        localStorage.getItem(STORAGE_KEY) || "{}"
      );

      state.enabled = Boolean(saved.enabled);
      state.duration = clampDuration(saved.duration);

    } catch (error) {
      console.warn(
        "[Shunel Crossfade] Configuración inválida:",
        error
      );
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          enabled: state.enabled,
          duration: state.duration
        })
      );
    } catch (error) {
      console.warn(
        "[Shunel Crossfade] No se pudo guardar:",
        error
      );
    }
  }

  function updateUI() {
    if (elements.enabled) {
      elements.enabled.checked = state.enabled;
    }

    if (elements.duration) {
      elements.duration.value = state.duration;
      elements.duration.disabled = !state.enabled;
    }

    if (elements.durationValue) {
      elements.durationValue.textContent =
        `${state.duration} segundos`;
    }
  }

  function getDuration() {
    if (!audio || !Number.isFinite(audio.duration)) {
      return 0;
    }

    return audio.duration;
  }

  function getRemainingTime() {
    const duration = getDuration();

    if (!duration) return Infinity;

    return Math.max(
      0,
      duration - audio.currentTime
    );
  }

  function isSupported() {
    const player = getPlayer();
    const engine = getAudioEngine();

    if (!audio || !player || !engine) {
      return false;
    }

    if (player.getState().source !== "local") {
      return false;
    }

    return true;
  }

  function cancelTransition() {
    state.generation++;

    if (state.transitionTimer) {
      clearTimeout(state.transitionTimer);
      state.transitionTimer = null;
    }

    state.transitioning = false;

    getAudioEngine()?.resetTrackGain();
  }

  async function transitionToNext() {
    if (state.transitioning || !state.enabled) {
      return false;
    }

    const player = getPlayer();
    const engine = getAudioEngine();

    if (!player || !engine || !audio) {
      return false;
    }

    const currentState = player.getState();

    if (
      currentState.source !== "local" ||
      !currentState.currentTrack ||
      !currentState.isPlaying
    ) {
      return false;
    }

    if (getRemainingTime() > state.duration + 0.5) {
      return false;
    }

    const queue = player.getQueue();

    if (!queue.length) return false;

    const nextIndex = currentState.currentIndex + 1;

    const hasNext =
      nextIndex < queue.length ||
      currentState.repeat === "all";

    if (!hasNext && !currentState.shuffle) {
      return false;
    }

    const generation = ++state.generation;

    state.transitioning = true;

    emit("crossfade:start", {
      duration: state.duration,
      track: currentState.currentTrack
    });

    try {
      const ready = await engine.resume();

      if (!ready) {
        state.transitioning = false;
        return false;
      }

      if (generation !== state.generation) {
        return false;
      }

      const remaining = getRemainingTime();

      const fadeDuration = Math.min(
        state.duration,
        Math.max(0.1, remaining)
      );

      engine.rampTrackGain(0, fadeDuration);

      await new Promise(resolve => {
        state.transitionTimer = setTimeout(
          resolve,
          fadeDuration * 1000
        );
      });

      state.transitionTimer = null;

      if (generation !== state.generation) {
        return false;
      }

      engine.setTrackGain(0, 0.001);

      const played = await player.next();

      if (generation !== state.generation) {
        return false;
      }

      if (!played) {
        engine.resetTrackGain();
        state.transitioning = false;
        return false;
      }

      if (player.getState().source === "local") {
        await engine.resume();
        engine.rampTrackGain(1, fadeDuration);
      } else {
        engine.resetTrackGain();
      }

      emit("crossfade:end", {
        duration: fadeDuration,
        track: player.getCurrentTrack()
      });

      state.transitioning = false;

      return true;

    } catch (error) {
      console.error(
        "[Shunel Crossfade] Error:",
        error
      );

      engine.resetTrackGain();

      state.transitioning = false;

      emit("crossfade:error", {
        message: error.message
      });

      return false;
    }
  }

  function handleTimeUpdate() {
    if (
      !state.enabled ||
      state.transitioning ||
      !audio ||
      audio.paused
    ) {
      return;
    }

    if (getPlayer()?.getState().source !== "local") {
      return;
    }

    if (getRemainingTime() <= state.duration + 0.5) {
      transitionToNext();
    }
  }

  function handleTrackChange(detail = {}) {
    cancelTransition();

    const track = detail.track || null;

    state.lastTrackId = track?.id || null;

    if (track?.source !== "local") {
      return;
    }

    // Recuperar la ganancia cuando se inicia una canción normal.
    getAudioEngine()?.resetTrackGain();
  }

  function setEnabled(value) {
    state.enabled = Boolean(value);

    if (!state.enabled) {
      cancelTransition();
    }

    saveSettings();
    updateUI();

    emit("crossfade:settings", {
      enabled: state.enabled,
      duration: state.duration
    });

    return state.enabled;
  }

  function setDuration(value) {
    state.duration = clampDuration(value);

    saveSettings();
    updateUI();

    emit("crossfade:settings", {
      enabled: state.enabled,
      duration: state.duration
    });

    return state.duration;
  }

  function initialize() {
    if (state.initialized) return;

    loadSettings();
    updateUI();

    elements.enabled?.addEventListener(
      "change",
      event => setEnabled(event.target.checked)
    );

    elements.duration?.addEventListener(
      "input",
      event => setDuration(event.target.value)
    );

    audio?.addEventListener(
      "timeupdate",
      handleTimeUpdate
    );

    if (window.ShunelEvents) {
      window.ShunelEvents.on(
        "trackchange",
        handleTrackChange
      );

      window.ShunelEvents.on(
        "play",
        () => {
          if (
            state.enabled &&
            state.transitioning === false
          ) {
            getAudioEngine()?.resetTrackGain();
          }
        }
      );
    } else {
      window.addEventListener(
        "shunel:trackchange",
        event => handleTrackChange(event.detail)
      );
    }

    state.initialized = true;

    emit("crossfade:ready", {
      enabled: state.enabled,
      duration: state.duration
    });

    console.info(
      "[Shunel Crossfade] Sistema inicializado."
    );
  }

  window.ShunelCrossfade = Object.freeze({
    initialize,
    setEnabled,
    setDuration,
    transitionToNext,
    cancelTransition,
    getState() {
      return {
        enabled: state.enabled,
        duration: state.duration,
        transitioning: state.transitioning,
        supported: isSupported()
      };
    }
  });

  initialize();

})();
