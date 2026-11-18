
/* =========================================
   SHUNEL — LYRICS STUDIO
   Version 3.0
========================================= */

(() => {
  "use strict";

  const STORAGE_KEY = "shunel_lyrics_studio";

  const DEFAULTS = {
    style: "pure",
    size: 25,
    motion: "smooth",
    alignment: "center",
    activeColor: "white",
    autoScroll: true
  };

  const OPTIONS = {
    style: [
      ["Pure", "pure"],
      ["Cinema", "cinema"],
      ["Karaoke", "karaoke"],
      ["Editorial", "editorial"],
      ["Midnight", "midnight"],
      ["Focus", "focus"]
    ],
    motion: [
      ["Suave", "smooth"],
      ["Cinemático", "cinematic"],
      ["Instantáneo", "none"]
    ],
    alignment: [
      ["Centro", "center"],
      ["Izquierda", "left"]
    ],
    activeColor: [
      ["Blanco", "white"],
      ["Azul", "blue"],
      ["Plateado", "silver"]
    ]
  };

  let settings = { ...DEFAULTS };
  let container = null;
  let panel = null;
  let trigger = null;
  let statusElement = null;
  let observer = null;
  let initialized = false;

  function loadSettings() {
    try {
      const saved = JSON.parse(
        localStorage.getItem(STORAGE_KEY) || "{}"
      );

      Object.keys(OPTIONS).forEach(key => {
        const allowed = OPTIONS[key].map(option => option[1]);

        if (allowed.includes(saved[key])) {
          settings[key] = saved[key];
        }
      });

      if (Number.isFinite(saved.size)) {
        settings.size = Math.min(38, Math.max(16, saved.size));
      }

      if (typeof saved.autoScroll === "boolean") {
        settings.autoScroll = saved.autoScroll;
      }
    } catch (error) {
      console.warn("[Lyrics Studio] Error cargando preferencias.", error);
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (error) {
      console.warn("[Lyrics Studio] Error guardando preferencias.", error);
    }
  }

  function createElement(tag, className, text) {
    const node = document.createElement(tag);

    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;

    return node;
  }

  function createSection(title) {
    const section = createElement("section", "studio-section");
    section.appendChild(
      createElement("span", "studio-label", title)
    );
    return section;
  }

  function createOptionGroup(title, settingName, options) {
    const section = createSection(title);
    const grid = createElement("div", "studio-options");

    options.forEach(([label, value]) => {
      const button = createElement("button", "studio-option", label);

      button.type = "button";
      button.dataset.setting = settingName;
      button.dataset.value = value;

      button.addEventListener("click", () => {
        updateSetting(settingName, value);
      });

      grid.appendChild(button);
    });

    section.appendChild(grid);
    return section;
  }

  function createInterface() {
    trigger = document.getElementById("lyricsStudioTrigger");

    if (!trigger) {
      trigger = createElement(
        "button",
        "",
        "Aa  Lyrics Studio"
      );

      trigger.id = "lyricsStudioTrigger";
      trigger.type = "button";
      document.body.appendChild(trigger);
    }

    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-controls", "lyricsStudio");

    panel = document.getElementById("lyricsStudio");

    if (!panel) {
      panel = createElement("aside");
      panel.id = "lyricsStudio";
      document.body.appendChild(panel);
    }

    panel.dataset.studioVersion = "3";
    panel.setAttribute("aria-label", "Configuración de letras");
    panel.replaceChildren();

    const header = createElement("div", "studio-header");
    header.appendChild(
      createElement("span", "studio-heading", "Lyrics Studio")
    );

    const closeButton = createElement("button", "studio-close", "×");
    closeButton.type = "button";
    closeButton.setAttribute("aria-label", "Cerrar Lyrics Studio");
    closeButton.addEventListener("click", close);

    header.appendChild(closeButton);
    panel.appendChild(header);

    statusElement = createElement(
      "div",
      "studio-status",
      "Esperando letras..."
    );

    statusElement.setAttribute("role", "status");
    panel.appendChild(statusElement);

    panel.appendChild(
      createOptionGroup("ESTILO", "style", OPTIONS.style)
    );

    const sizeSection = createSection("TAMAÑO");

    const rangeInfo = createElement("div", "studio-range-info");
    rangeInfo.appendChild(createElement("span", "", "Tamaño de letra"));

    const sizeValue = createElement("strong", "", `${settings.size}px`);
    sizeValue.id = "lyricsStudioSizeValue";
    rangeInfo.appendChild(sizeValue);

    sizeSection.appendChild(rangeInfo);

    const range = createElement("input");
    range.type = "range";
    range.min = "16";
    range.max = "38";
    range.step = "1";
    range.value = String(settings.size);
    range.id = "lyricsStudioSize";

    range.addEventListener("input", () => {
      settings.size = Number(range.value);
      applySettings();
      saveSettings();
    });

    sizeSection.appendChild(range);
    panel.appendChild(sizeSection);

    panel.appendChild(
      createOptionGroup("MOVIMIENTO", "motion", OPTIONS.motion)
    );

    panel.appendChild(
      createOptionGroup("ALINEACIÓN", "alignment", OPTIONS.alignment)
    );

    panel.appendChild(
      createOptionGroup("COLOR ACTIVO", "activeColor", OPTIONS.activeColor)
    );

    const scrollSection = createSection("REPRODUCCIÓN");

    const scrollToggle = createElement(
      "button",
      "studio-toggle"
    );

    scrollToggle.type = "button";
    scrollToggle.id = "lyricsStudioAutoScroll";
    scrollToggle.appendChild(
      createElement("span", "", "Desplazamiento automático")
    );
    scrollToggle.appendChild(
      createElement("span", "studio-switch")
    );

    scrollToggle.addEventListener("click", () => {
      settings.autoScroll = !settings.autoScroll;
      applySettings();
      saveSettings();
    });

    scrollSection.appendChild(scrollToggle);
    panel.appendChild(scrollSection);

    const resetButton = createElement(
      "button",
      "studio-reset",
      "Restablecer ajustes"
    );

    resetButton.type = "button";
    resetButton.addEventListener("click", reset);

    panel.appendChild(resetButton);
  }

  function updateSetting(key, value) {
    if (!OPTIONS[key]) return;

    const allowed = OPTIONS[key].map(option => option[1]);
    if (!allowed.includes(value)) return;

    settings[key] = value;
    applySettings();
    saveSettings();
  }

  function detectLyricsState() {
    if (!container) return "empty";

    const title = (
      document.getElementById("lyricsTitle")?.textContent || ""
    ).toLowerCase();

    if (
      title.includes("buscando") ||
      title.includes("cargando")
    ) {
      return "loading";
    }

    const lines = container.querySelectorAll(".lyric-line");

    if (!lines.length) {
      return "empty";
    }

    const synced = Array.from(lines).some(line => {
      return line.hasAttribute("data-time");
    });

    return synced ? "synced" : "plain";
  }

  function refreshStatus() {
    if (!statusElement) return;

    const state = detectLyricsState();

    const labels = {
      loading: "Buscando letras...",
      empty: "No hay letras disponibles",
      synced: "Letras sincronizadas",
      plain: "Letras sin sincronización"
    };

    statusElement.textContent = labels[state];
    statusElement.classList.toggle("is-synced", state === "synced");
    statusElement.classList.toggle("is-plain", state === "plain");
    statusElement.dataset.state = state;

    if (container) {
      container.dataset.lyricsType =
        state === "synced" || state === "plain" ? state : state;
    }
  }

  function applySettings() {
    if (!container) return;

    container.dataset.lyricsStyle = settings.style;
    container.dataset.lyricsMotion = settings.motion;
    container.dataset.lyricsAlignment = settings.alignment;
    container.dataset.lyricsColor = settings.activeColor;

    container.style.setProperty(
      "--lyrics-size",
      `${settings.size}px`
    );

    const sizeValue = document.getElementById("lyricsStudioSizeValue");
    const range = document.getElementById("lyricsStudioSize");

    if (sizeValue) sizeValue.textContent = `${settings.size}px`;
    if (range) range.value = String(settings.size);

    panel?.querySelectorAll("[data-setting]").forEach(button => {
      const selected =
        settings[button.dataset.setting] === button.dataset.value;

      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });

    const toggle = document.getElementById("lyricsStudioAutoScroll");

    if (toggle) {
      toggle.setAttribute(
        "aria-pressed",
        String(settings.autoScroll)
      );
    }

    refreshStatus();
  }

  function open() {
    if (!panel || !trigger) return;

    panel.classList.add("is-open");
    trigger.setAttribute("aria-expanded", "true");

    panel.querySelector(".studio-close")?.focus();
  }

  function close() {
    if (!panel || !trigger) return;

    panel.classList.remove("is-open");
    trigger.setAttribute("aria-expanded", "false");
    trigger.focus();
  }

  function toggle() {
    if (panel?.classList.contains("is-open")) {
      close();
    } else {
      open();
    }
  }

  function reset() {
    settings = { ...DEFAULTS };
    saveSettings();
    applySettings();
  }

  function setupEvents() {
    if (trigger.dataset.studioReady === "true") return;

    trigger.addEventListener("click", toggle);
    trigger.dataset.studioReady = "true";

    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && panel?.classList.contains("is-open")) {
        close();
      }
    });

    document.addEventListener("pointerdown", event => {
      if (!panel?.classList.contains("is-open")) return;

      if (
        panel.contains(event.target) ||
        trigger.contains(event.target)
      ) {
        return;
      }

      panel.classList.remove("is-open");
      trigger.setAttribute("aria-expanded", "false");
    });
  }

  function watchLyrics() {
    if (observer) observer.disconnect();

    observer = new MutationObserver(() => {
      refreshStatus();
    });

    if (container) {
      observer.observe(container, {
        childList: true,
        subtree: true,
        characterData: true
      });
    }

    const title = document.getElementById("lyricsTitle");

    if (title) {
      observer.observe(title, {
        childList: true,
        subtree: true,
        characterData: true
      });
    }
  }

  function initialize() {
    if (initialized) return;

    container = document.getElementById("lyricsContainer");

    if (!container) return;

    initialized = true;

    loadSettings();
    createInterface();
    setupEvents();
    watchLyrics();
    applySettings();
  }

  function getSettings() {
    return { ...settings };
  }

  function getLyricsState() {
    return detectLyricsState();
  }

  function destroyObserver() {
    observer?.disconnect();
    observer = null;
  }

  window.ShunelLyricsStudio = {
    getSettings,
    getLyricsState,
    open,
    close,
    toggle,
    setStyle: value => updateSetting("style", value),
    setSize: value => updateSetting("size", Math.min(38, Math.max(16, Number(value)))),
    setMotion: value => updateSetting("motion", value),
    setAlignment: value => updateSetting("alignment", value),
    setActiveColor: value => updateSetting("activeColor", value),
    setAutoScroll: value => {
      settings.autoScroll = Boolean(value);
      applySettings();
      saveSettings();
    },
    reset,
    refresh: refreshStatus,
    refreshLyrics: refreshStatus,
    destroyObserver
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  } else {
    initialize();
  }
})();
