
/* =========================================
   SHUNEL — CROSSFADE
   Preparación de transiciones de audio.
   Requiere integración de doble canal para
   realizar un crossfade real entre canciones.
========================================= */

(() => {
  "use strict";

  const STORAGE_KEY = "shunel_crossfade_settings";

  const state = {
    enabled: false,
    duration: 5,
    supported: false
  };

  const audio = document.getElementById("localAudio");

  function loadSettings() {
    try {
      const saved = JSON.parse(
        localStorage.getItem(STORAGE_KEY) || "{}"
      );

      state.enabled = saved.enabled === true;

      const duration = Number(saved.duration);

      if (Number.isFinite(duration)) {
        state.duration = Math.max(1, Math.min(12, duration));
      }
    } catch (error) {
      console.warn("[Shunel] Error cargando Crossfade:", error);
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
      console.warn("[Shunel] Error guardando Crossfade:", error);
    }
  }

  function setEnabled(value) {
    state.enabled = Boolean(value);
    saveSettings();
    updateControls();

    return state.enabled;
  }

  function setDuration(value) {
    const duration = Number(value);

    if (!Number.isFinite(duration)) return state.duration;

    state.duration = Math.max(1, Math.min(12, duration));
    saveSettings();
    updateControls();

    return state.duration;
  }

  function updateControls() {
    const enabledInput = document.getElementById("crossfadeSetting");
    const durationInput = document.getElementById("crossfadeDuration");
    const durationLabel = document.getElementById("crossfadeDurationValue");

    if (enabledInput) {
      enabledInput.checked = state.enabled;
    }

    if (durationInput) {
      durationInput.value = String(state.duration);
      durationInput.disabled = !state.enabled;
    }

    if (durationLabel) {
      durationLabel.textContent = `${state.duration} segundos`;
    }
  }

  function isCompatible(track) {
    if (!track) return false;

    const source = String(track.source || "").toLowerCase();

    return (
      !track.videoId &&
      !track.video_id &&
      source !== "youtube" &&
      source !== "external-youtube"
    );
  }

  function getStatus() {
    return {
      enabled: state.enabled,
      duration: state.duration,
      supported: state.supported,
      available: false,
      message: state.enabled
        ? "Configuración guardada. Requiere integración de doble canal."
        : "Crossfade desactivado."
    };
  }

  function initialize() {
    loadSettings();

    state.supported = Boolean(
      audio &&
      typeof audio.volume === "number" &&
      typeof window.AudioContext !== "undefined"
    );

    updateControls();

    const enabledInput = document.getElementById("crossfadeSetting");
    const durationInput = document.getElementById("crossfadeDuration");

    if (enabledInput) {
      enabledInput.addEventListener("change", () => {
        setEnabled(enabledInput.checked);
      });
    }

    if (durationInput) {
      durationInput.addEventListener("input", () => {
        setDuration(durationInput.value);
      });
    }

    document.addEventListener("shunel:ready", updateControls);

    console.info("[Shunel] Crossfade preparado.", getStatus());
  }

  window.ShunelCrossfade = {
    enable: () => setEnabled(true),
    disable: () => setEnabled(false),
    toggle: () => setEnabled(!state.enabled),
    setDuration,
    isCompatible,
    getStatus,
    getSettings: () => ({ ...state })
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  } else {
    initialize();
  }
})();
