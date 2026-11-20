
/* =========================================================
   SHUNEL — LYRICS STUDIO 4.0
   Personalización, accesibilidad y gestión de preferencias

   FUNCIONES:
   - 6 estilos visuales
   - Tamaño de letra configurable
   - Movimiento y alineación
   - Colores activos
   - Desplazamiento automático
   - Preferencias persistentes y versionadas
   - Importación y exportación de ajustes
   - Detección de estados de letras
   - Compatibilidad con Lyrics Engine
   - Accesibilidad de teclado y lectores de pantalla
   - Compatibilidad con dispositivos móviles
   - Optimización de MutationObserver
   - Limpieza completa de eventos y recursos

   API PÚBLICA COMPATIBLE:
   getSettings()
   getLyricsState()
   open()
   close()
   toggle()
   setStyle()
   setSize()
   setMotion()
   setAlignment()
   setActiveColor()
   setAutoScroll()
   reset()
   refresh()
   refreshLyrics()
   destroyObserver()

   NUEVOS MÉTODOS:
   getOptions()
   isInitialized()
   resetStyle()
   resetSize()
   exportSettings()
   importSettings()
   destroy()

   IMPORTANTE:
   Este archivo controla el comportamiento.
   Los estilos visuales se complementan en lyrics.css.
========================================================= */

(() => {
  "use strict";

  /* =======================================================
     01. CONFIGURACIÓN GENERAL
  ======================================================= */

  const STORAGE_KEY = "shunel_lyrics_studio";
  const STORAGE_VERSION = 4;

  const MIN_SIZE = 16;
  const MAX_SIZE = 38;

  const DEFAULTS = Object.freeze({
    style: "pure",
    size: 25,
    motion: "smooth",
    alignment: "center",
    activeColor: "white",
    autoScroll: true
  });

  const OPTIONS = Object.freeze({
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
  });

  const LABELS = Object.freeze({
    loading: "Buscando letras...",
    empty: "No hay letras disponibles",
    synced: "Letras sincronizadas",
    plain: "Letras sin sincronización",
    error: "No se pudieron cargar las letras"
  });

  /* =======================================================
     02. ESTADO INTERNO
  ======================================================= */

  let settings = { ...DEFAULTS };

  let container = null;
  let panel = null;
  let trigger = null;
  let statusElement = null;

  let observer = null;
  let initialized = false;
  let destroyed = false;

  let eventController = null;
  let observerFrame = 0;
  let saveTimeout = null;

  let createdTrigger = false;
  let createdPanel = false;

  let previousFocus = null;
  let originalPanelChildren = null;

  let originalTriggerAttributes = null;
  let originalContainerAttributes = null;
  let originalContainerSize = null;

  let reducedMotionQuery = null;
  let highContrastQuery = null;

  let importInput = null;

  /* =======================================================
     03. UTILIDADES
  ======================================================= */

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function isValidSize(value) {
    return (
      typeof value === "number" &&
      Number.isFinite(value)
    );
  }

  function normalizeBoolean(value) {
    return typeof value === "boolean" ? value : null;
  }

  function createElement(tag, className, text) {
    const node = document.createElement(tag);

    if (className) {
      node.className = className;
    }

    if (text !== undefined) {
      node.textContent = String(text);
    }

    return node;
  }

  function isConnected(element) {
    return Boolean(
      element &&
      element.isConnected &&
      document.documentElement.contains(element)
    );
  }

  function getOptionValues(key) {
    return OPTIONS[key]
      ? OPTIONS[key].map(option => option[1])
      : [];
  }

  function isValidOption(key, value) {
    return getOptionValues(key).includes(value);
  }

  function safeMediaQuery(query) {
    try {
      return window.matchMedia
        ? window.matchMedia(query)
        : null;
    } catch {
      return null;
    }
  }

  function getFocusableElements(element) {
    if (!element) return [];

    return Array.from(
      element.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
      )
    ).filter(item => {
      return (
        !item.hidden &&
        item.getAttribute("aria-hidden") !== "true" &&
        item.getClientRects().length > 0
      );
    });
  }

  /* =======================================================
     04. VALIDACIÓN DE PREFERENCIAS
  ======================================================= */

  function validateSettings(source) {
    const result = { ...DEFAULTS };

    if (!source || typeof source !== "object") {
      return result;
    }

    Object.keys(OPTIONS).forEach(key => {
      if (isValidOption(key, source[key])) {
        result[key] = source[key];
      }
    });

    if (isValidSize(source.size)) {
      result.size = clamp(
        Math.round(source.size),
        MIN_SIZE,
        MAX_SIZE
      );
    }

    const autoScroll = normalizeBoolean(source.autoScroll);

    if (autoScroll !== null) {
      result.autoScroll = autoScroll;
    }

    return result;
  }

  /* =======================================================
     05. ALMACENAMIENTO
  ======================================================= */

  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);

      if (!raw) {
        settings = { ...DEFAULTS };
        return;
      }

      const saved = JSON.parse(raw);

      if (!saved || typeof saved !== "object") {
        settings = { ...DEFAULTS };
        return;
      }

      /*
       * Migración:
       * Las versiones anteriores guardaban directamente
       * las preferencias sin un objeto "settings".
       */

      const source =
        saved.settings &&
        typeof saved.settings === "object"
          ? saved.settings
          : saved;

      settings = validateSettings(source);

      /*
       * Se vuelve a guardar en el formato actual.
       * Así se normalizan configuraciones antiguas.
       */

      saveSettings();

    } catch (error) {
      console.warn(
        "[Lyrics Studio] No se pudieron cargar las preferencias.",
        error
      );

      settings = { ...DEFAULTS };
    }
  }

  function saveSettings(immediate = false) {
    if (saveTimeout) {
      clearTimeout(saveTimeout);
      saveTimeout = null;
    }

    const save = () => {
      try {
        const payload = {
          version: STORAGE_VERSION,
          settings: { ...settings }
        };

        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify(payload)
        );

      } catch (error) {
        console.warn(
          "[Lyrics Studio] No se pudieron guardar las preferencias.",
          error
        );
      }
    };

    if (immediate) {
      save();
      return;
    }

    saveTimeout = setTimeout(() => {
      saveTimeout = null;
      save();
    }, 180);
  }

  function handleStorageChange(event) {
    if (event.key !== STORAGE_KEY) return;

    if (!event.newValue) {
      settings = { ...DEFAULTS };
      applySettings();
      return;
    }

    try {
      const saved = JSON.parse(event.newValue);

      const source =
        saved?.settings &&
        typeof saved.settings === "object"
          ? saved.settings
          : saved;

      settings = validateSettings(source);
      applySettings();

    } catch {
      // Se ignoran datos externos inválidos.
    }
  }

  /* =======================================================
     06. CREACIÓN DE INTERFAZ
  ======================================================= */

  function createSection(title) {
    const section = createElement(
      "section",
      "studio-section"
    );

    const heading = createElement(
      "h3",
      "studio-label",
      title
    );

    section.appendChild(heading);

    return section;
  }

  function createOptionGroup(title, settingName, options) {
    const section = createSection(title);

    const grid = createElement(
      "div",
      "studio-options"
    );

    grid.setAttribute("role", "group");
    grid.setAttribute("aria-label", title);

    options.forEach(([label, value]) => {
      const button = createElement(
        "button",
        "studio-option",
        label
      );

      button.type = "button";
      button.dataset.setting = settingName;
      button.dataset.value = value;

      button.setAttribute("aria-pressed", "false");

      grid.appendChild(button);
    });

    section.appendChild(grid);

    return section;
  }

  function createSizeSection() {
    const section = createSection("TAMAÑO");

    const rangeInfo = createElement(
      "div",
      "studio-range-info"
    );

    const label = createElement(
      "label",
      "",
      "Tamaño de letra"
    );

    label.htmlFor = "lyricsStudioSize";

    const sizeValue = createElement(
      "strong",
      "",
      `${settings.size}px`
    );

    sizeValue.id = "lyricsStudioSizeValue";

    rangeInfo.appendChild(label);
    rangeInfo.appendChild(sizeValue);

    section.appendChild(rangeInfo);

    const range = createElement("input");

    range.type = "range";
    range.min = String(MIN_SIZE);
    range.max = String(MAX_SIZE);
    range.step = "1";
    range.value = String(settings.size);

    range.id = "lyricsStudioSize";
    range.name = "lyricsStudioSize";

    range.setAttribute(
      "aria-label",
      "Tamaño de las letras"
    );

    range.setAttribute(
      "aria-valuemin",
      String(MIN_SIZE)
    );

    range.setAttribute(
      "aria-valuemax",
      String(MAX_SIZE)
    );

    range.addEventListener(
      "input",
      () => {
        setSize(Number(range.value), false);
      },
      { signal: eventController.signal }
    );

    range.addEventListener(
      "change",
      () => saveSettings(true),
      { signal: eventController.signal }
    );

    section.appendChild(range);

    return section;
  }

  function createScrollSection() {
    const section = createSection("REPRODUCCIÓN");

    const toggle = createElement(
      "button",
      "studio-toggle"
    );

    toggle.type = "button";
    toggle.id = "lyricsStudioAutoScroll";
    toggle.setAttribute("aria-pressed", "true");

    toggle.appendChild(
      createElement(
        "span",
        "",
        "Desplazamiento automático"
      )
    );

    toggle.appendChild(
      createElement("span", "studio-switch")
    );

    toggle.addEventListener(
      "click",
      () => {
        setAutoScroll(!settings.autoScroll);
      },
      { signal: eventController.signal }
    );

    section.appendChild(toggle);

    return section;
  }

  function createPreview() {
    const section = createSection("VISTA PREVIA");

    const preview = createElement(
      "div",
      "studio-preview"
    );

    preview.id = "lyricsStudioPreview";

    const previous = createElement(
      "p",
      "studio-preview-line",
      "La música continúa"
    );

    const active = createElement(
      "p",
      "studio-preview-active",
      "Sigue el ritmo de la canción"
    );

    const next = createElement(
      "p",
      "studio-preview-line",
      "Y encuentra tu momento"
    );

    preview.appendChild(previous);
    preview.appendChild(active);
    preview.appendChild(next);

    section.appendChild(preview);

    return section;
  }

  function createResetSection() {
    const section = createSection("RESTABLECER");

    const buttons = createElement(
      "div",
      "studio-reset-actions"
    );

    const resetStyle = createElement(
      "button",
      "studio-reset-secondary",
      "Restablecer estilo"
    );

    resetStyle.type = "button";

    resetStyle.addEventListener(
      "click",
      resetStyleSettings,
      { signal: eventController.signal }
    );

    const resetSize = createElement(
      "button",
      "studio-reset-secondary",
      "Restablecer tamaño"
    );

    resetSize.type = "button";

    resetSize.addEventListener(
      "click",
      resetSizeSettings,
      { signal: eventController.signal }
    );

    const resetAll = createElement(
      "button",
      "studio-reset",
      "Restablecer todos los ajustes"
    );

    resetAll.type = "button";

    resetAll.addEventListener(
      "click",
      reset,
      { signal: eventController.signal }
    );

    buttons.appendChild(resetStyle);
    buttons.appendChild(resetSize);
    buttons.appendChild(resetAll);

    section.appendChild(buttons);

    return section;
  }

  function createDataSection() {
    const section = createSection("PREFERENCIAS");

    const actions = createElement(
      "div",
      "studio-data-actions"
    );

    const exportButton = createElement(
      "button",
      "studio-reset-secondary",
      "Exportar ajustes"
    );

    exportButton.type = "button";

    exportButton.addEventListener(
      "click",
      exportSettings,
      { signal: eventController.signal }
    );

    const importButton = createElement(
      "button",
      "studio-reset-secondary",
      "Importar ajustes"
    );

    importButton.type = "button";

    importButton.addEventListener(
      "click",
      () => importInput?.click(),
      { signal: eventController.signal }
    );

    importInput = createElement("input");

    importInput.type = "file";
    importInput.accept = "application/json,.json";
    importInput.hidden = true;

    importInput.addEventListener(
      "change",
      handleImportFile,
      { signal: eventController.signal }
    );

    actions.appendChild(exportButton);
    actions.appendChild(importButton);

    section.appendChild(actions);
    section.appendChild(importInput);

    return section;
  }

  function createInterface() {
    /*
     * Recupera el botón existente o crea uno nuevo.
     */

    trigger = document.getElementById(
      "lyricsStudioTrigger"
    );

    if (!trigger) {
      trigger = createElement(
        "button",
        "lyrics-studio-trigger",
        "Aa  Lyrics Studio"
      );

      trigger.id = "lyricsStudioTrigger";
      trigger.type = "button";

      trigger.setAttribute(
        "aria-label",
        "Abrir configuración de letras"
      );

      document.body.appendChild(trigger);

      createdTrigger = true;
    }

    originalTriggerAttributes = {
      expanded: trigger.getAttribute("aria-expanded"),
      controls: trigger.getAttribute("aria-controls")
    };

    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-controls", "lyricsStudio");

    /*
     * Recupera el panel existente o crea uno nuevo.
     */

    panel = document.getElementById("lyricsStudio");

    if (!panel) {
      panel = createElement("aside");

      panel.id = "lyricsStudio";

      document.body.appendChild(panel);

      createdPanel = true;
    } else {
      originalPanelChildren = Array.from(
        panel.childNodes
      ).map(node => node.cloneNode(true));
    }

    panel.dataset.studioVersion = "4";

    panel.setAttribute(
      "aria-label",
      "Configuración de letras"
    );

    panel.setAttribute("aria-hidden", "true");

    panel.setAttribute("tabindex", "-1");

    panel.replaceChildren();

    /* Encabezado */

    const header = createElement(
      "div",
      "studio-header"
    );

    const heading = createElement(
      "h2",
      "studio-heading",
      "Lyrics Studio"
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
      close,
      { signal: eventController.signal }
    );

    header.appendChild(heading);
    header.appendChild(closeButton);

    panel.appendChild(header);

    /* Estado */

    statusElement = createElement(
      "div",
      "studio-status",
      "Esperando letras..."
    );

    statusElement.setAttribute("role", "status");
    statusElement.setAttribute("aria-live", "polite");
    statusElement.setAttribute("aria-atomic", "true");

    panel.appendChild(statusElement);

    /* Controles */

    panel.appendChild(
      createOptionGroup(
        "ESTILO",
        "style",
        OPTIONS.style
      )
    );

    panel.appendChild(createSizeSection());

    panel.appendChild(
      createOptionGroup(
        "MOVIMIENTO",
        "motion",
        OPTIONS.motion
      )
    );

    panel.appendChild(
      createOptionGroup(
        "ALINEACIÓN",
        "alignment",
        OPTIONS.alignment
      )
    );

    panel.appendChild(
      createOptionGroup(
        "COLOR ACTIVO",
        "activeColor",
        OPTIONS.activeColor
      )
    );

    panel.appendChild(createScrollSection());
    panel.appendChild(createPreview());
    panel.appendChild(createResetSection());
    panel.appendChild(createDataSection());
  }

  /* =======================================================
     07. ACTUALIZACIÓN DE PREFERENCIAS
  ======================================================= */

  function updateSetting(key, value) {
    if (key === "size") {
      return setSize(value);
    }

    if (key === "autoScroll") {
      return setAutoScroll(value);
    }

    if (!isValidOption(key, value)) {
      return false;
    }

    settings[key] = value;

    applySettings();
    saveSettings();

    return true;
  }

  function setSize(value, persist = true) {
    const size = Number(value);

    if (!Number.isFinite(size)) {
      return false;
    }

    settings.size = clamp(
      Math.round(size),
      MIN_SIZE,
      MAX_SIZE
    );

    applySettings();

    if (persist) {
      saveSettings();
    }

    return true;
  }

  function setAutoScroll(value) {
    if (typeof value !== "boolean") {
      return false;
    }

    settings.autoScroll = value;

    applySettings();
    saveSettings();

    return true;
  }

  function applySettings() {
    if (!container || !isConnected(container)) {
      return;
    }

    /*
     * Los data-* permiten que lyrics.css controle
     * todos los estilos sin crear CSS desde JavaScript.
     */

    container.dataset.lyricsStyle = settings.style;
    container.dataset.lyricsMotion = settings.motion;
    container.dataset.lyricsAlignment = settings.alignment;
    container.dataset.lyricsColor = settings.activeColor;

    container.style.setProperty(
      "--lyrics-size",
      `${settings.size}px`
    );

    /*
     * Preferencias del sistema.
     */

    container.dataset.reducedMotion =
      reducedMotionQuery?.matches ? "true" : "false";

    container.dataset.highContrast =
      highContrastQuery?.matches ? "true" : "false";

    /*
     * Actualiza el deslizador.
     */

    const sizeValue = document.getElementById(
      "lyricsStudioSizeValue"
    );

    const range = document.getElementById(
      "lyricsStudioSize"
    );

    if (sizeValue) {
      sizeValue.textContent = `${settings.size}px`;
    }

    if (range) {
      range.value = String(settings.size);
      range.setAttribute(
        "aria-valuenow",
        String(settings.size)
      );
    }

    /*
     * Actualiza los botones de opciones.
     */

    panel?.querySelectorAll("[data-setting]").forEach(button => {
      const selected =
        settings[button.dataset.setting] === button.dataset.value;

      button.classList.toggle("is-selected", selected);

      button.setAttribute(
        "aria-pressed",
        String(selected)
      );
    });

    /*
     * Actualiza el interruptor.
     */

    const toggle = document.getElementById(
      "lyricsStudioAutoScroll"
    );

    if (toggle) {
      toggle.setAttribute(
        "aria-pressed",
        String(settings.autoScroll)
      );

      toggle.dataset.enabled =
        settings.autoScroll ? "true" : "false";
    }

    /*
     * Actualiza la vista previa.
     */

    const preview = document.getElementById(
      "lyricsStudioPreview"
    );

    if (preview) {
      preview.dataset.lyricsStyle = settings.style;
      preview.dataset.lyricsMotion = settings.motion;
      preview.dataset.lyricsAlignment = settings.alignment;
      preview.dataset.lyricsColor = settings.activeColor;

      preview.style.setProperty(
        "--lyrics-size",
        `${settings.size}px`
      );
    }

    refreshStatus();
  }

  /* =======================================================
     08. DETECCIÓN DE ESTADO DE LETRAS
  ======================================================= */

  function detectLyricsState() {
    if (!container || !isConnected(container)) {
      return "empty";
    }

    const title = (
      document.getElementById("lyricsTitle")?.textContent || ""
    ).trim().toLowerCase();

    const errorText = (
      container.textContent || ""
    ).toLowerCase();

    if (
      title.includes("buscando") ||
      title.includes("cargando") ||
      title.includes("obteniendo")
    ) {
      return "loading";
    }

    if (
      title.includes("error") ||
      errorText.includes("no se pudo cargar la letra")
    ) {
      return "error";
    }

    const lines = container.querySelectorAll(
      ".lyric-line"
    );

    if (!lines.length) {
      return "empty";
    }

    let hasSyncedLines = false;
    let hasPlainLines = false;

    for (const line of lines) {
      if (
        line.hasAttribute("data-time") ||
        line.hasAttribute("data-index")
      ) {
        hasSyncedLines = true;
      } else {
        hasPlainLines = true;
      }
    }

    /*
     * Si existen líneas sincronizadas y normales,
     * se considera un resultado parcialmente sincronizado.
     * Se conserva el estado público "synced".
     */

    if (hasSyncedLines) {
      return "synced";
    }

    if (hasPlainLines) {
      return "plain";
    }

    return "empty";
  }

  function refreshStatus() {
    if (!statusElement) return;

    const state = detectLyricsState();

    statusElement.textContent =
      LABELS[state] || LABELS.empty;

    statusElement.classList.toggle(
      "is-synced",
      state === "synced"
    );

    statusElement.classList.toggle(
      "is-plain",
      state === "plain"
    );

    statusElement.classList.toggle(
      "is-loading",
      state === "loading"
    );

    statusElement.classList.toggle(
      "is-error",
      state === "error"
    );

    statusElement.dataset.state = state;

    if (container && isConnected(container)) {
      container.dataset.lyricsType = state;
    }
  }

  /* =======================================================
     09. OBSERVACIÓN DE CAMBIOS
  ======================================================= */

  function scheduleStatusRefresh() {
    if (observerFrame) return;

    observerFrame = requestAnimationFrame(() => {
      observerFrame = 0;
      refreshStatus();
    });
  }

  function watchLyrics() {
    destroyObserver();

    if (!container || !isConnected(container)) {
      return;
    }

    if (!("MutationObserver" in window)) {
      return;
    }

    observer = new MutationObserver(() => {
      scheduleStatusRefresh();
    });

    /*
     * Se observan cambios estructurales y de texto.
     * Las actualizaciones de clases no disparan este observer.
     */

    observer.observe(container, {
      childList: true,
      subtree: true,
      characterData: true
    });

    const title = document.getElementById("lyricsTitle");

    if (title) {
      observer.observe(title, {
        childList: true,
        subtree: true,
        characterData: true
      });
    }
  }

  function destroyObserver() {
    observer?.disconnect();
    observer = null;

    if (observerFrame) {
      cancelAnimationFrame(observerFrame);
      observerFrame = 0;
    }
  }

  /* =======================================================
     10. PANEL Y NAVEGACIÓN
  ======================================================= */

  function open() {
    if (
      !panel ||
      !trigger ||
      destroyed ||
      !isConnected(panel) ||
      !isConnected(trigger)
    ) {
      return false;
    }

    if (panel.classList.contains("is-open")) {
      return true;
    }

    previousFocus = document.activeElement;

    panel.classList.add("is-open");

    panel.setAttribute("aria-hidden", "false");

    trigger.setAttribute("aria-expanded", "true");

    /*
     * Se enfoca el botón de cierre.
     * No se bloquea el foco del resto de la aplicación
     * porque este panel no es modal.
     */

    const closeButton = panel.querySelector(
      ".studio-close"
    );

    if (closeButton) {
      closeButton.focus();
    } else {
      panel.focus();
    }

    refreshStatus();

    return true;
  }

  function close(restoreFocus = true) {
    if (!panel || !trigger) return false;

    if (!panel.classList.contains("is-open")) {
      return true;
    }

    panel.classList.remove("is-open");

    panel.setAttribute("aria-hidden", "true");

    trigger.setAttribute("aria-expanded", "false");

    if (
      restoreFocus &&
      previousFocus &&
      isConnected(previousFocus) &&
      typeof previousFocus.focus === "function"
    ) {
      previousFocus.focus();
    } else if (
      restoreFocus &&
      isConnected(trigger)
    ) {
      trigger.focus();
    }

    previousFocus = null;

    return true;
  }

  function toggle() {
    if (panel?.classList.contains("is-open")) {
      return close();
    }

    return open();
  }

  /* =======================================================
     11. TECLADO Y CLICS EXTERIORES
  ======================================================= */

  function handleKeydown(event) {
    if (!panel?.classList.contains("is-open")) {
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }

    /*
     * El panel no es modal, por lo que no se aplica
     * un bloqueo de Tab ni un focus trap.
     */
  }

  function handlePointerDown(event) {
    if (!panel?.classList.contains("is-open")) {
      return;
    }

    const target = event.target;

    if (!(target instanceof Node)) {
      return;
    }

    if (
      panel.contains(target) ||
      trigger?.contains(target)
    ) {
      return;
    }

    /*
     * El toque exterior usa el mismo cierre que
     * el botón y Escape.
     */

    close(false);
  }

  function setupEvents() {
    if (!trigger || !panel) return;

    eventController?.abort();

    eventController = new AbortController();

    const signal = eventController.signal;

    trigger.addEventListener(
      "click",
      toggle,
      { signal }
    );

    document.addEventListener(
      "keydown",
      handleKeydown,
      { signal }
    );

    document.addEventListener(
      "pointerdown",
      handlePointerDown,
      { signal }
    );

    window.addEventListener(
      "storage",
      handleStorageChange,
      { signal }
    );

    /*
     * Cambios de preferencias de accesibilidad del sistema.
     */

    if (reducedMotionQuery) {
      const handler = () => applySettings();

      if (reducedMotionQuery.addEventListener) {
        reducedMotionQuery.addEventListener(
          "change",
          handler,
          { signal }
        );
      }
    }

    if (highContrastQuery) {
      const handler = () => applySettings();

      if (highContrastQuery.addEventListener) {
        highContrastQuery.addEventListener(
          "change",
          handler,
          { signal }
        );
      }
    }
  }

  /* =======================================================
     12. RESTABLECER AJUSTES
  ======================================================= */

  function resetStyleSettings() {
    settings.style = DEFAULTS.style;
    settings.motion = DEFAULTS.motion;
    settings.alignment = DEFAULTS.alignment;
    settings.activeColor = DEFAULTS.activeColor;

    applySettings();
    saveSettings(true);
  }

  function resetSizeSettings() {
    settings.size = DEFAULTS.size;

    applySettings();
    saveSettings(true);
  }

  function reset() {
    settings = { ...DEFAULTS };

    applySettings();
    saveSettings(true);
  }

  /* =======================================================
     13. EXPORTAR PREFERENCIAS
  ======================================================= */

  function exportSettings() {
    try {
      const payload = {
        application: "Shunel Lyrics Studio",
        version: STORAGE_VERSION,
        exportedAt: new Date().toISOString(),
        settings: { ...settings }
      };

      const blob = new Blob(
        [JSON.stringify(payload, null, 2)],
        { type: "application/json" }
      );

      const url = URL.createObjectURL(blob);

      const link = createElement("a");

      link.href = url;
      link.download = "shunel-lyrics-settings.json";

      document.body.appendChild(link);
      link.click();
      link.remove();

      /*
       * Se libera la URL después de iniciar la descarga.
       */

      setTimeout(() => {
        URL.revokeObjectURL(url);
      }, 1000);

      announce("Preferencias exportadas.");

      return true;

    } catch (error) {
      console.error(
        "[Lyrics Studio] Error exportando preferencias.",
        error
      );

      announce("No se pudieron exportar las preferencias.");

      return false;
    }
  }

  /* =======================================================
     14. IMPORTAR PREFERENCIAS
  ======================================================= */

  async function handleImportFile(event) {
    const file = event.target.files?.[0];

    /*
     * Permite volver a seleccionar el mismo archivo.
     */

    event.target.value = "";

    if (!file) return;

    /*
     * Límite de tamaño para evitar archivos innecesariamente
     * grandes en una configuración que solo contiene ajustes.
     */

    const MAX_FILE_SIZE = 64 * 1024;

    if (file.size > MAX_FILE_SIZE) {
      announce("El archivo de preferencias es demasiado grande.");
      return;
    }

    try {
      const text = await file.text();

      const parsed = JSON.parse(text);

      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        throw new Error("Formato inválido.");
      }

      /*
       * Se acepta tanto el formato exportado como
       * el formato sencillo de versiones anteriores.
       */

      const source =
        parsed.settings &&
        typeof parsed.settings === "object"
          ? parsed.settings
          : parsed;

      const imported = validateSettings(source);

      settings = imported;

      applySettings();
      saveSettings(true);

      announce("Preferencias importadas correctamente.");

    } catch (error) {
      console.warn(
        "[Lyrics Studio] Archivo de preferencias inválido.",
        error
      );

      announce("No se pudo importar el archivo.");
    }
  }

  function importSettings(data) {
    if (!data || typeof data !== "object") {
      return false;
    }

    const source =
      data.settings &&
      typeof data.settings === "object"
        ? data.settings
        : data;

    settings = validateSettings(source);

    applySettings();
    saveSettings(true);

    announce("Preferencias importadas correctamente.");

    return true;
  }

  /* =======================================================
     15. MENSAJES ACCESIBLES
  ======================================================= */

  function announce(message) {
    if (!statusElement) return;

    statusElement.textContent = message;
    statusElement.dataset.state = "info";
  }

  /* =======================================================
     16. RESTAURACIÓN DEL DOM
  ======================================================= */

  function restoreOriginalAttributes() {
    if (container && originalContainerAttributes) {
      Object.entries(originalContainerAttributes).forEach(
        ([key, value]) => {
          if (value === null) {
            container.removeAttribute(key);
          } else {
            container.setAttribute(key, value);
          }
        }
      );

      if (originalContainerSize === "") {
        container.style.removeProperty("--lyrics-size");
      } else if (originalContainerSize !== null) {
        container.style.setProperty(
          "--lyrics-size",
          originalContainerSize
        );
      }
    }

    if (trigger && originalTriggerAttributes) {
      if (originalTriggerAttributes.expanded === null) {
        trigger.removeAttribute("aria-expanded");
      } else {
        trigger.setAttribute(
          "aria-expanded",
          originalTriggerAttributes.expanded
        );
      }

      if (originalTriggerAttributes.controls === null) {
        trigger.removeAttribute("aria-controls");
      } else {
        trigger.setAttribute(
          "aria-controls",
          originalTriggerAttributes.controls
        );
      }
    }
  }

  /* =======================================================
     17. DESTRUCCIÓN COMPLETA
  ======================================================= */

  function destroy() {
    if (destroyed) return;

    close(false);

    destroyObserver();

    eventController?.abort();
    eventController = null;

    if (saveTimeout) {
      clearTimeout(saveTimeout);
      saveTimeout = null;
    }

    restoreOriginalAttributes();

    /*
     * Si el panel existía antes de inicializar el módulo,
     * se restaura su contenido original.
     */

    if (createdPanel && panel) {
      panel.remove();
    } else if (panel && originalPanelChildren) {
      panel.replaceChildren(
        ...originalPanelChildren.map(node => node.cloneNode(true))
      );

      panel.removeAttribute("data-studio-version");
      panel.removeAttribute("aria-hidden");
      panel.removeAttribute("aria-label");
      panel.removeAttribute("tabindex");
      panel.classList.remove("is-open");
    }

    if (createdTrigger && trigger) {
      trigger.remove();
    }

    if (container) {
      delete container.dataset.reducedMotion;
      delete container.dataset.highContrast;
    }

    container = null;
    panel = null;
    trigger = null;
    statusElement = null;
    importInput = null;

    createdPanel = false;
    createdTrigger = false;

    initialized = false;
    destroyed = true;
  }

  /* =======================================================
     18. INICIALIZACIÓN
  ======================================================= */

  function initialize() {
    if (initialized || destroyed) return;

    const lyricsContainer = document.getElementById(
      "lyricsContainer"
    );

    if (!lyricsContainer) {
      return;
    }

    container = lyricsContainer;

    /*
     * Guarda los atributos originales para poder
     * restaurarlos al destruir el módulo.
     */

    originalContainerAttributes = {
      "data-lyrics-style": container.getAttribute("data-lyrics-style"),
      "data-lyrics-motion": container.getAttribute("data-lyrics-motion"),
      "data-lyrics-alignment": container.getAttribute("data-lyrics-alignment"),
      "data-lyrics-color": container.getAttribute("data-lyrics-color"),
      "data-lyrics-type": container.getAttribute("data-lyrics-type")
    };

    originalContainerSize =
      container.style.getPropertyValue("--lyrics-size");

    reducedMotionQuery = safeMediaQuery(
      "(prefers-reduced-motion: reduce)"
    );

    highContrastQuery = safeMediaQuery(
      "(prefers-contrast: more)"
    );

    /*
     * Se carga la configuración antes de crear
     * los controles para mostrar los valores correctos.
     */

    loadSettings();

    eventController = new AbortController();

    try {
      createInterface();

      if (!trigger || !panel) {
        throw new Error("No se pudo crear la interfaz.");
      }

      setupEvents();

      watchLyrics();

      initialized = true;

      applySettings();

      refreshStatus();

    } catch (error) {
      console.error(
        "[Lyrics Studio] Error al inicializar.",
        error
      );

      eventController?.abort();
      destroyObserver();

      initialized = false;
    }
  }

  /* =======================================================
     19. API PÚBLICA
  ======================================================= */

  function getSettings() {
    return { ...settings };
  }

  function getLyricsState() {
    return detectLyricsState();
  }

  function getOptions() {
    return {
      style: OPTIONS.style.map(option => [...option]),
      motion: OPTIONS.motion.map(option => [...option]),
      alignment: OPTIONS.alignment.map(option => [...option]),
      activeColor: OPTIONS.activeColor.map(option => [...option]),
      defaults: { ...DEFAULTS },
      minSize: MIN_SIZE,
      maxSize: MAX_SIZE
    };
  }

  function isInitialized() {
    return initialized && !destroyed;
  }

  /* =======================================================
     20. COMPATIBILIDAD CON SHUNEL
  ======================================================= */

  window.ShunelLyricsStudio = {
    /*
     * API original.
     */

    getSettings,
    getLyricsState,

    open,
    close,
    toggle,

    setStyle: value => updateSetting("style", value),
    setSize,
    setMotion: value => updateSetting("motion", value),
    setAlignment: value => updateSetting("alignment", value),
    setActiveColor: value => updateSetting("activeColor", value),
    setAutoScroll,

    reset,

    refresh: refreshStatus,
    refreshLyrics: refreshStatus,

    destroyObserver,

    /*
     * API nueva.
     */

    getOptions,
    isInitialized,

    resetStyle: resetStyleSettings,
    resetSize: resetSizeSettings,

    exportSettings,
    importSettings,

    destroy
  };

  /* =======================================================
     21. ARRANQUE AUTOMÁTICO
  ======================================================= */

  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      initialize,
      { once: true }
    );
  } else {
    initialize();
  }

})();
