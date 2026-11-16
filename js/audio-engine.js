
/* =========================================
   SHUNEL — AUDIO ENGINE
   Motor de procesamiento de audio
   Version: 1.0.0
========================================= */

(() => {
  "use strict";

  if (window.ShunelAudioEngine) {
    console.warn("[Shunel Audio] Ya está inicializado.");
    return;
  }

  const audio = document.getElementById("localAudio");

  const state = {
    context: null,
    source: null,
    analyser: null,
    masterGain: null,
    trackGain: null,
    initialized: false,
    initializing: false,
    connected: false,
    supported: false,
    lastError: null,
    sampleRate: 0,
    volume: 1
  };

  const FFT_SIZE = 2048;
  const SMOOTHING = 0.78;

  function emit(name, detail = {}) {
    if (window.ShunelEvents) {
      window.ShunelEvents.emit(name, detail);
    } else {
      window.dispatchEvent(
        new CustomEvent(`shunel:${name}`, { detail })
      );
    }
  }

  function getAudioContextClass() {
    return (
      window.AudioContext ||
      window.webkitAudioContext ||
      null
    );
  }

  function initialize() {
    if (state.initialized) {
      return Promise.resolve(true);
    }

    if (state.initializing) {
      return state.initializing;
    }

    state.initializing = new Promise(resolve => {
      try {
        if (!audio) {
          throw new Error(
            "No se encontró el elemento #localAudio."
          );
        }

        const AudioContextClass = getAudioContextClass();

        if (!AudioContextClass) {
          throw new Error(
            "Este navegador no admite Web Audio API."
          );
        }

        state.context = new AudioContextClass();

        state.source =
          state.context.createMediaElementSource(audio);

        state.analyser =
          state.context.createAnalyser();

        state.masterGain =
          state.context.createGain();

        state.trackGain =
          state.context.createGain();

        state.analyser.fftSize = FFT_SIZE;
        state.analyser.smoothingTimeConstant = SMOOTHING;

        state.masterGain.gain.value = state.volume;
        state.trackGain.gain.value = 1;

        /*
          Cadena de audio:

          Audio HTML
              |
          Track Gain
              |
          Master Gain
              |
          Analyser
              |
          Speakers
        */

        state.source.connect(state.trackGain);

        state.trackGain.connect(state.masterGain);

        state.masterGain.connect(state.analyser);

        state.analyser.connect(
          state.context.destination
        );

        state.sampleRate = state.context.sampleRate;
        state.supported = true;
        state.connected = true;
        state.initialized = true;

        state.initializing = false;

        emit("audio:ready", {
          sampleRate: state.sampleRate,
          fftSize: FFT_SIZE
        });

        console.info(
          "[Shunel Audio] Motor de audio inicializado."
        );

        resolve(true);

      } catch (error) {
        state.lastError = error.message;
        state.initializing = false;

        console.error(
          "[Shunel Audio] Error:",
          error
        );

        emit("audio:error", {
          message: error.message
        });

        resolve(false);
      }
    });

    return state.initializing;
  }

  async function resume() {
    if (!state.initialized) {
      const success = await initialize();

      if (!success) return false;
    }

    try {
      if (state.context.state === "suspended") {
        await state.context.resume();
      }

      return state.context.state === "running";

    } catch (error) {
      state.lastError = error.message;

      emit("audio:error", {
        message: error.message
      });

      return false;
    }
  }

  async function suspend() {
    if (!state.initialized) return false;

    try {
      await state.context.suspend();
      return true;
    } catch (error) {
      state.lastError = error.message;
      return false;
    }
  }

  function setVolume(value, rampTime = 0.04) {
    const volume = Math.max(
      0,
      Math.min(1, Number(value))
    );

    if (!Number.isFinite(volume)) return false;

    state.volume = volume;

    if (state.masterGain && state.context) {
      const now = state.context.currentTime;

      state.masterGain.gain.cancelScheduledValues(now);

      state.masterGain.gain.setTargetAtTime(
        volume,
        now,
        Math.max(0.001, rampTime)
      );
    }

    emit("audio:volume", {
      volume
    });

    return volume;
  }

  function getVolume() {
    return state.volume;
  }

  function setTrackGain(value, rampTime = 0.03) {
    const gain = Math.max(
      0,
      Math.min(1, Number(value))
    );

    if (!Number.isFinite(gain)) return false;

    if (!state.initialized) return false;

    const now = state.context.currentTime;

    state.trackGain.gain.cancelScheduledValues(now);

    state.trackGain.gain.setTargetAtTime(
      gain,
      now,
      Math.max(0.001, rampTime)
    );

    return gain;
  }

  function rampTrackGain(value, duration = 1) {
    if (!state.initialized) return false;

    const gain = Math.max(
      0,
      Math.min(1, Number(value))
    );

    const seconds = Math.max(
      0.01,
      Number(duration)
    );

    const now = state.context.currentTime;

    const parameter = state.trackGain.gain;

    parameter.cancelScheduledValues(now);

    parameter.setValueAtTime(
      parameter.value,
      now
    );

    parameter.linearRampToValueAtTime(
      gain,
      now + seconds
    );

    return true;
  }

  function getFrequencyData() {
    if (!state.initialized) return null;

    const data = new Uint8Array(
      state.analyser.frequencyBinCount
    );

    state.analyser.getByteFrequencyData(data);

    return data;
  }

  function getTimeDomainData() {
    if (!state.initialized) return null;

    const data = new Uint8Array(
      state.analyser.fftSize
    );

    state.analyser.getByteTimeDomainData(data);

    return data;
  }

  function getByteFrequencyData(target) {
    if (!state.initialized) return false;

    if (!(target instanceof Uint8Array)) {
      return false;
    }

    state.analyser.getByteFrequencyData(target);

    return target;
  }

  function getByteTimeDomainData(target) {
    if (!state.initialized) return false;

    if (!(target instanceof Uint8Array)) {
      return false;
    }

    state.analyser.getByteTimeDomainData(target);

    return target;
  }

  function getAnalyser() {
    return state.analyser;
  }

  function getContext() {
    return state.context;
  }

  function getState() {
    return {
      initialized: state.initialized,
      initializing: Boolean(state.initializing),
      connected: state.connected,
      supported: state.supported,
      contextState: state.context?.state || "unavailable",
      sampleRate: state.sampleRate,
      volume: state.volume,
      lastError: state.lastError
    };
  }

  function resetTrackGain() {
    return setTrackGain(1, 0.01);
  }

  function dispose() {
    if (!state.initialized) return false;

    try {
      state.source?.disconnect();
      state.trackGain?.disconnect();
      state.masterGain?.disconnect();
      state.analyser?.disconnect();

      state.context?.close();

      state.context = null;
      state.source = null;
      state.trackGain = null;
      state.masterGain = null;
      state.analyser = null;

      state.initialized = false;
      state.initializing = false;
      state.connected = false;
      state.supported = false;

      emit("audio:disposed", {});

      return true;

    } catch (error) {
      state.lastError = error.message;

      console.error(
        "[Shunel Audio] Error al cerrar:",
        error
      );

      return false;
    }
  }

  window.ShunelAudioEngine = Object.freeze({
    initialize,
    resume,
    suspend,
    setVolume,
    getVolume,
    setTrackGain,
    rampTrackGain,
    resetTrackGain,
    getFrequencyData,
    getTimeDomainData,
    getByteFrequencyData,
    getByteTimeDomainData,
    getAnalyser,
    getContext,
    getState,
    dispose
  });

  console.info("[Shunel Audio] Módulo cargado.");

})();
