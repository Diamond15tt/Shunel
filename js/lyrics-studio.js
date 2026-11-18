
/* =========================================
   SHUNEL — LYRICS STUDIO
   Version 1.0
   Preferences + Interface Controller
========================================= */

(() => {
  "use strict";

  const STORAGE_KEY = "shunel_lyrics_studio";

  const DEFAULT_SETTINGS = Object.freeze({
    style: "minimal",
    size: 25,
    motion: "smooth"
  });

  const VALID_STYLES = [
    "minimal",
    "cinematic",
    "silver",
    "neon",
    "focus"
  ];

  const VALID_MOTIONS = [
    "smooth",
    "cinematic",
    "none"
  ];

  let settings = { ...DEFAULT_SETTINGS };

  let container = null;
  let panel = null;
  let trigger = null;

  /* =========================================
     STORAGE
  ========================================= */

  function loadSettings() {
    try {
      const saved = JSON.parse(
        localStorage.getItem(STORAGE_KEY)
      );

      if (!saved || typeof saved !== "object") return;

      if (VALID_STYLES.includes(saved.style)) {
        settings.style = saved.style;
      }

      if (
        Number.isFinite(saved.size) &&
        saved.size >= 16 &&
        saved.size <= 38
      ) {
        settings.size = saved.size;
      }

      if (VALID_MOTIONS.includes(saved.motion)) {
        settings.motion = saved.motion;
      }

    } catch (error) {
      console.warn(
        "[Lyrics Studio] Error al cargar preferencias:",
        error
      );
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(settings)
      );

    } catch (error) {
      console.warn(
        "[Lyrics Studio] Error al guardar preferencias:",
        error
      );
    }
  }

  /* =========================================
     DOM HELPERS
  ========================================= */

  function createElement(tag, className = "", text = "") {
    const element = document.createElement(tag);

    if (className) {
      element.className = className;
    }

    if (text) {
      element.textContent = text;
    }

    return element;
  }

  function createSection(title) {
    const section = createElement(
      "section",
      "studio-section"
    );

    section.appendChild(
      createElement(
        "span",
        "studio-label",
        title
      )
    );

    return section;
  }

  function createOption(
    label,
    value,
    group,
    callback
  ) {
    const button = createElement(
      "button",
      "studio-option",
      label
    );

    button.type = "button";
    button.dataset.value = value;
    button.dataset.group = group;

    button.addEventListener("click", callback);

    return button;
  }

  /* =========================================
     APPLY SETTINGS
  ========================================= */

  function applySettings() {
    container = document.getElementById(
      "lyricsContainer"
    );

    if (!container) return;

    container.dataset.lyricsStyle = settings.style;

    container.dataset.lyricsMotion = settings.motion;

    container.style.setProperty(
      "--lyrics-size",
      `${settings.size}px`
    );

    let duration = "350ms";

    if (settings.motion === "cinematic") {
      duration = "550ms";
    }

    if (settings.motion === "none") {
      duration = "0ms";
    }

    container.style.setProperty(
      "--lyrics-motion",
      duration
    );

    updateControls();
  }

  /* =========================================
     INTERFACE
  ========================================= */

  function createInterface() {
    if (document.getElementById("lyricsStudio")) {
      panel = document.getElementById("lyricsStudio");
      trigger = document.getElementById(
        "lyricsStudioTrigger"
      );

      return;
    }

    /* TRIGGER */

    trigger = createElement(
      "button",
      "",
      "Lyrics Studio"
    );

    trigger.id = "lyricsStudioTrigger";
    trigger.type = "button";

    trigger.setAttribute(
      "aria-expanded",
      "false"
    );

    trigger.setAttribute(
      "aria-controls",
      "lyricsStudio"
    );

    const icon = createElement(
      "span",
      "",
      "Aa"
    );

    icon.setAttribute("aria-hidden", "true");

    trigger.prepend(icon);

    /* PANEL */

    panel = createElement("div");

    panel.id = "lyricsStudio";

    panel.setAttribute(
      "aria-label",
      "Personalizar letras"
    );

    panel.setAttribute(
      "aria-hidden",
      "true"
    );

    /* HEADER */

    const header = createElement(
      "div",
      "studio-header"
    );

    header.appendChild(
      createElement(
        "span",
        "studio-heading",
        "Lyrics Studio"
      )
    );

    const closeButton = createElement(
      "button",
      "studio-close",
      "×"
    );

    closeButton.type = "button";

    closeButton.setAttribute(
      "aria-label",
      "Cerrar Lyrics Studio"
    );

    closeButton.addEventListener(
      "click",
      closeStudio
    );

    header.appendChild(closeButton);

    panel.appendChild(header);

    /* =====================================
       STYLE SELECTOR
    ===================================== */

    const styleSection = createSection("ESTILO");

    const styleOptions = createElement(
      "div",
      "studio-options"
    );

    const styles = [
      ["Minimal", "minimal"],
      ["Cinematic", "cinematic"],
      ["Silver Flow", "silver"],
      ["Neon Blue", "neon"],
      ["Focus", "focus"]
    ];

    styles.forEach(([label, value]) => {
      const button = createOption(
        label,
        value,
        "style",
        () => {
          settings.style = value;

          saveSettings();
          applySettings();
        }
      );

      styleOptions.appendChild(button);
    });

    styleSection.appendChild(styleOptions);

    panel.appendChild(styleSection);

    /* =====================================
       SIZE CONTROL
    ===================================== */

    const sizeSection = createSection(
      "TAMAÑO DE LETRA"
    );

    const sizeInfo = createElement(
      "div",
      "studio-range-info"
    );

    sizeInfo.appendChild(
      createElement("span", "", "Pequeño")
    );

    const sizeValue = createElement(
      "strong",
      "",
      `${settings.size}px`
    );

    sizeValue.id = "lyricsStudioSizeValue";

    sizeInfo.appendChild(sizeValue);

    sizeInfo.appendChild(
      createElement("span", "", "Grande")
    );

    const sizeInput = createElement("input");

    sizeInput.type = "range";
    sizeInput.min = "16";
    sizeInput.max = "38";
    sizeInput.step = "1";
    sizeInput.value = String(settings.size);

    sizeInput.setAttribute(
      "aria-label",
      "Tamaño de letra"
    );

    sizeInput.addEventListener("input", () => {
      settings.size = Number(sizeInput.value);

      sizeValue.textContent =
        `${settings.size}px`;

      applySettings();
      saveSettings();
    });

    sizeSection.appendChild(sizeInfo);
    sizeSection.appendChild(sizeInput);

    panel.appendChild(sizeSection);

    /* =====================================
       MOTION SELECTOR
    ===================================== */

    const motionSection = createSection(
      "MOVIMIENTO"
    );

    const motionOptions = createElement(
      "div",
      "studio-options"
    );

    const motions = [
      ["Smooth", "smooth"],
      ["Cinematic", "cinematic"],
      ["Sin movimiento", "none"]
    ];

    motions.forEach(([label, value]) => {
      const button = createOption(
        label,
        value,
        "motion",
        () => {
          settings.motion = value;

          saveSettings();
          applySettings();
        }
      );

      motionOptions.appendChild(button);
    });

    motionSection.appendChild(motionOptions);

    panel.appendChild(motionSection);

    /* =====================================
       RESET
    ===================================== */

    const resetButton = createElement(
      "button",
      "studio-reset",
      "Restablecer configuración"
    );

    resetButton.type = "button";

    resetButton.addEventListener("click", () => {
      settings = { ...DEFAULT_SETTINGS };

      saveSettings();
      applySettings();
    });

    panel.appendChild(resetButton);

    /* =====================================
       APPEND ELEMENTS
    ===================================== */

    document.body.appendChild(trigger);
    document.body.appendChild(panel);

    trigger.addEventListener(
      "click",
      toggleStudio
    );

    updateControls();
  }

  /* =========================================
     UPDATE CONTROLS
  ========================================= */

  function updateControls() {
    if (!panel) return;

    const options = panel.querySelectorAll(
      ".studio-option"
    );

    options.forEach(button => {
      const value = button.dataset.value;
      const group = button.dataset.group;

      let selected = false;

      if (group === "style") {
        selected = settings.style === value;
      }

      if (group === "motion") {
        selected = settings.motion === value;
      }

      button.classList.toggle(
        "is-selected",
        selected
      );

      button.setAttribute(
        "aria-pressed",
        String(selected)
      );
    });

    const sizeInput = panel.querySelector(
      'input[type="range"]'
    );

    const sizeValue = document.getElementById(
      "lyricsStudioSizeValue"
    );

    if (sizeInput) {
      sizeInput.value = String(settings.size);
    }

    if (sizeValue) {
      sizeValue.textContent =
        `${settings.size}px`;
    }
  }

  /* =========================================
     PANEL CONTROLS
  ========================================= */

  function openStudio() {
    if (!panel || !trigger) return;

    panel.classList.add("is-open");

    panel.setAttribute(
      "aria-hidden",
      "false"
    );

    trigger.setAttribute(
      "aria-expanded",
      "true"
    );
  }

  function closeStudio() {
    if (!panel || !trigger) return;

    panel.classList.remove("is-open");

    panel.setAttribute(
      "aria-hidden",
      "true"
    );

    trigger.setAttribute(
      "aria-expanded",
      "false"
    );
  }

  function toggleStudio() {
    if (!panel) return;

    if (panel.classList.contains("is-open")) {
      closeStudio();
    } else {
      openStudio();
    }
  }

  /* =========================================
     EVENT LISTENERS
  ========================================= */

  function setupEvents() {
    document.addEventListener("keydown", event => {
      if (event.key === "Escape") {
        closeStudio();
      }
    });

    document.addEventListener("click", event => {
      if (
        !panel ||
        !trigger ||
        !panel.classList.contains("is-open")
      ) {
        return;
      }

      if (
        !panel.contains(event.target) &&
        !trigger.contains(event.target)
      ) {
        closeStudio();
      }
    });
  }

  /* =========================================
     INITIALIZATION
  ========================================= */

  function initialize() {
    container = document.getElementById(
      "lyricsContainer"
    );

    if (!container) {
      console.warn(
        "[Lyrics Studio] No se encontró #lyricsContainer."
      );

      return;
    }

    loadSettings();

    createInterface();

    applySettings();

    setupEvents();

    console.info(
      "[Lyrics Studio] Inicializado correctamente."
    );
  }

  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      initialize,
      { once: true }
    );
  } else {
    initialize();
  }

  /* =========================================
     PUBLIC API
  ========================================= */

  window.ShunelLyricsStudio = Object.freeze({

    getSettings() {
      return { ...settings };
    },

    open: openStudio,

    close: closeStudio,

    setStyle(style) {
      if (!VALID_STYLES.includes(style)) return;

      settings.style = style;

      saveSettings();
      applySettings();
    },

    setSize(size) {
      const value = Number(size);

      if (
        !Number.isFinite(value) ||
        value < 16 ||
        value > 38
      ) {
        return;
      }

      settings.size = value;

      saveSettings();
      applySettings();
    },

    setMotion(motion) {
      if (!VALID_MOTIONS.includes(motion)) return;

      settings.motion = motion;

      saveSettings();
      applySettings();
    },

    reset() {
      settings = { ...DEFAULT_SETTINGS };

      saveSettings();
      applySettings();
    },

    refresh() {
      applySettings();
    }

  });

})();
