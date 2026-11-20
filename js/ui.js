/* ==========================================================================
   SHUNEL — UI CONTROLLER 3.0
   DOM rendering, player presentation, collections, queue and navigation.

   Compatibility:
   - Keeps the public methods and DOM IDs from the previous ShunelUI.
   - Does not import Storage or control audio playback.
   - Receives actions/callbacks from the application controller.
   - All optional DOM elements are safe to omit.

   Design principles:
   - No untrusted HTML is inserted into the document.
   - DOM writes are batched where practical.
   - Event listeners and timers are owned and cleaned up by this instance.
   - Rendering is deterministic and does not mutate source track objects.
========================================================================== */

const PLACEHOLDER = "/assets/placeholder.svg";
const SVG_NS = "http://www.w3.org/2000/svg";

const VIDEO_ID_PATTERN = /^[a-zA-Z0-9_-]{11}$/;
const MAX_TEXT_LENGTH = 2000;
const MAX_RENDER_ITEMS = 2000;
const TOAST_DURATION = 2200;

const ICONS = Object.freeze({
  play: "play",
  pause: "pause",
  favorite: "heart",
  add: "queue",
  save: "library",
  remove: "close",
  previous: "skip-back",
  next: "skip-forward",
  close: "close",
  queue: "queue",
  heart: "heart",
  library: "library",
  search: "search"
});

const EMPTY_MESSAGES = Object.freeze({
  search: "No encontramos canciones. Prueba con otro nombre.",
  library: "Todavía no has guardado canciones en tu biblioteca.",
  favorites: "Todavía no tienes canciones favoritas.",
  history: "Tu historial aparecerá aquí cuando escuches música.",
  recent: "Todavía no has escuchado música.",
  queue: "Tu cola está vacía."
});

const DEFAULT_LABELS = Object.freeze({
  title: "Canción sin título",
  channel: "YouTube",
  idleTitle: "Elige una canción",
  idleChannel: "Tu música comienza aquí"
});

const DEFAULT_OPTIONS = Object.freeze({
  maxRenderItems: MAX_RENDER_ITEMS,
  toastDuration: TOAST_DURATION,
  imageFallback: PLACEHOLDER,
  useInert: true,
  restoreFocus: true,
  debug: false
});

/* ==========================================================================
   01. PURE HELPERS
========================================================================== */

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function clampNumber(value, min, max, fallback = min) {
  const number = Number(value);

  if (!Number.isFinite(number)) return fallback;

  return Math.min(max, Math.max(min, number));
}

function cleanText(value, fallback = "", maxLength = MAX_TEXT_LENGTH) {
  if (typeof value !== "string") return fallback;

  const cleaned = value
    .replace(/\u0000/g, "")
    .trim()
    .slice(0, maxLength);

  return cleaned || fallback;
}

function isValidVideoId(value) {
  return typeof value === "string" && VIDEO_ID_PATTERN.test(value);
}

function normalizeTrack(track) {
  if (!isObject(track) || !isValidVideoId(track.videoId)) {
    return null;
  }

  return {
    ...track,
    videoId: track.videoId,
    title: cleanText(track.title, DEFAULT_LABELS.title, 300),
    channelTitle: cleanText(track.channelTitle, DEFAULT_LABELS.channel, 200),
    thumbnail: typeof track.thumbnail === "string"
      ? track.thumbnail.slice(0, 2048)
      : ""
  };
}

function normalizeTrackList(tracks, limit = MAX_RENDER_ITEMS) {
  if (!Array.isArray(tracks)) return [];

  const output = [];
  const max = clampNumber(limit, 0, MAX_RENDER_ITEMS, MAX_RENDER_ITEMS);

  for (const track of tracks) {
    const normalized = normalizeTrack(track);

    if (!normalized) continue;

    output.push(normalized);

    if (output.length >= max) break;
  }

  return output;
}

function isSafeImageSource(source) {
  if (typeof source !== "string" || !source.trim()) return false;

  const value = source.trim();

  if (value.startsWith("/") || value.startsWith("./") || value.startsWith("../")) {
    return !value.startsWith("//");
  }

  try {
    const url = new URL(value, document.baseURI);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function createElement(tag, className = "", text = null) {
  const element = document.createElement(tag);

  if (className) element.className = className;
  if (text !== null) element.textContent = text;

  return element;
}

function setBooleanAttribute(element, name, value) {
  if (!element) return;

  if (value) {
    element.setAttribute(name, "true");
  } else {
    element.removeAttribute(name);
  }
}

function sameTrackId(first, second) {
  if (!first || !second) return false;

  return first.videoId === second.videoId;
}

function formatCount(value, singular, plural) {
  const count = Math.max(0, Math.floor(Number(value) || 0));
  return `${count} ${count === 1 ? singular : plural}`;
}

function safeCallback(callback, args = [], onError = null) {
  if (typeof callback !== "function") return undefined;

  try {
    return callback(...args);
  } catch (error) {
    if (typeof onError === "function") {
      onError(error);
    } else {
      console.error("[Shunel UI] Error en callback:", error);
    }

    return undefined;
  }
}

/* ==========================================================================
   02. UI CLASS
========================================================================== */

export class ShunelUI {
  constructor(options = {}) {
    this.options = {
      ...DEFAULT_OPTIONS,
      ...(isObject(options) ? options : {})
    };

    this.toastTimer = null;
    this.toastQueue = [];
    this.toastIsVisible = false;

    this.destroyed = false;
    this.initialized = false;

    this.listeners = [];
    this.renderVersions = new WeakMap();
    this.imageVersions = new WeakMap();
    this.originalButtonContents = new WeakMap();

    this.activeView = null;
    this.lastFocusedElement = null;
    this.lastCurrentTrack = null;
    this.lastPlayingState = false;
    this.lastProgress = { current: 0, duration: 0 };

    this.elements = this.collectElements();
    this.state = {
      fullPlayerOpen: false,
      queueOpen: false,
      searching: false,
      currentTrack: null,
      currentFavorite: false,
      playing: false
    };

    this.log("UI controller creado.");
  }

  /* =========================================================================
     03. DOM REFERENCES
  ========================================================================= */

  collectElements() {
    const get = id => document.getElementById(id);

    return {
      // Search
      form: get("searchForm"),
      input: get("searchInput"),
      searchButton: get("searchButton"),
      status: get("status"),
      results: get("results"),
      resultCount: get("resultCount"),

      // Collections
      homeRecent: get("homeRecentList"),
      library: get("libraryList"),
      favorites: get("favoritesList"),
      history: get("historyList"),

      // Mini player
      currentThumbnail: get("currentThumbnail"),
      currentTitle: get("currentTitle"),
      currentChannel: get("currentChannel"),
      favoriteCurrent: get("favoriteCurrent"),
      playButton: get("playButton"),
      previousButton: get("previousButton"),
      nextButton: get("nextButton"),
      currentTime: get("currentTime"),
      duration: get("duration"),
      progressBar: get("progressBar"),
      volumeBar: get("volumeBar"),

      // Full player
      fullPlayer: get("fullPlayer"),
      expandPlayer: get("expandPlayer"),
      closeFullPlayer: get("closeFullPlayer"),
      fullThumbnail: get("fullPlayerThumbnail"),
      fullTitle: get("fullPlayerTitle"),
      fullChannel: get("fullPlayerChannel"),
      fullFavorite: get("fullPlayerFavorite"),
      fullPlayButton: get("fullPlayButton"),
      fullPreviousButton: get("fullPreviousButton"),
      fullNextButton: get("fullNextButton"),
      fullProgressBar: get("fullProgressBar"),
      fullCurrentTime: get("fullCurrentTime"),
      fullDuration: get("fullDuration"),
      fullQueueButton: get("fullQueueToggle"),

      // Queue
      queuePanel: get("queuePanel"),
      queueList: get("queueList"),
      queueToggle: get("queueToggle"),

      // Notifications
      toast: get("toast"),

      // Optional additions; safe when absent
      queueCount: get("queueCount"),
      searchClear: get("searchClear"),
      searchLoading: get("searchLoading"),
      libraryCount: get("libraryCount"),
      favoritesCount: get("favoritesCount"),
      historyCount: get("historyCount"),
      fullPlayerTitleRegion: get("fullPlayerTitleRegion"),
      mainContent: get("mainContent")
    };
  }

  refreshElements() {
    if (this.destroyed) return this.elements;

    this.elements = this.collectElements();
    return this.elements;
  }

  getElement(name) {
    return this.elements[name] || null;
  }

  hasElement(name) {
    return Boolean(this.getElement(name));
  }

  log(...args) {
    if (this.options.debug) {
      console.info("[Shunel UI]", ...args);
    }
  }

  reportError(message, error = null) {
    console.error(`[Shunel UI] ${message}`, error || "");
  }

  /* =========================================================================
     04. EVENT OWNERSHIP
  ========================================================================= */

  on(id, event, callback, options = undefined) {
    const element = typeof id === "string"
      ? document.getElementById(id)
      : id;

    if (!element || typeof callback !== "function") return false;

    element.addEventListener(event, callback, options);

    this.listeners.push({
      element,
      event,
      callback,
      options
    });

    return true;
  }

  listen(element, event, callback, options = undefined) {
    if (!element || typeof callback !== "function") return false;

    element.addEventListener(event, callback, options);

    this.listeners.push({
      element,
      event,
      callback,
      options
    });

    return true;
  }

  removeOwnedListeners() {
    for (const listener of this.listeners) {
      listener.element.removeEventListener(
        listener.event,
        listener.callback,
        listener.options
      );
    }

    this.listeners.length = 0;
  }

  init() {
    if (this.destroyed || this.initialized) return false;

    this.initialized = true;
    this.refreshElements();
    this.prepareAccessibility();
    this.bindInternalEvents();

    return true;
  }

  bindInternalEvents() {
    const { searchClear, input } = this.elements;

    if (searchClear && input) {
      this.listen(searchClear, "click", () => {
        input.value = "";
        input.focus();
        this.setStatus("");
        this.setResultCount(0);
      });
    }

    const progressInputs = [
      this.elements.progressBar,
      this.elements.fullProgressBar
    ];

    for (const inputElement of progressInputs) {
      if (!inputElement) continue;

      this.listen(inputElement, "keydown", event => {
        if (event.key === "Home") {
          inputElement.value = "0";
        }
      });
    }
  }

  destroy() {
    if (this.destroyed) return;

    this.removeOwnedListeners();

    if (this.toastTimer !== null) {
      window.clearTimeout(this.toastTimer);
      this.toastTimer = null;
    }

    this.toastQueue.length = 0;
    this.toastIsVisible = false;
    this.destroyed = true;
    this.initialized = false;

    this.log("UI controller destruido.");
  }

  /* =========================================================================
     05. ACCESSIBILITY BASELINE
  ========================================================================= */

  prepareAccessibility() {
    const { toast, status, results, queueList } = this.elements;

    if (toast && !toast.hasAttribute("role")) {
      toast.setAttribute("role", "status");
    }

    if (toast && !toast.hasAttribute("aria-live")) {
      toast.setAttribute("aria-live", "polite");
    }

    if (status && !status.hasAttribute("aria-live")) {
      status.setAttribute("aria-live", "polite");
    }

    if (results && !results.hasAttribute("aria-live")) {
      results.setAttribute("aria-live", "polite");
    }

    if (queueList && !queueList.hasAttribute("aria-live")) {
      queueList.setAttribute("aria-live", "polite");
    }

    for (const button of [
      this.elements.playButton,
      this.elements.fullPlayButton
    ]) {
      if (button && !button.hasAttribute("aria-pressed")) {
        button.setAttribute("aria-pressed", "false");
      }
    }
  }

  setInert(element, inert) {
    if (!element) return;

    if (this.options.useInert && "inert" in element) {
      element.inert = Boolean(inert);
    }

    if (inert) {
      element.setAttribute("aria-hidden", "true");
    } else {
      element.setAttribute("aria-hidden", "false");
    }
  }

  /* =========================================================================
     06. ICONS
  ========================================================================= */

  setIcon(button, iconName) {
    if (!button) return false;

    const safeName = cleanText(iconName, "", 40);

    if (!Object.values(ICONS).includes(safeName)) {
      this.log("Icono no reconocido:", safeName);
      return false;
    }

    const svg = document.createElementNS(SVG_NS, "svg");
    const use = document.createElementNS(SVG_NS, "use");

    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");

    use.setAttribute("href", `#icon-${safeName}`);

    svg.appendChild(use);
    button.replaceChildren(svg);

    return true;
  }

  createIcon(iconName, className = "") {
    const safeName = cleanText(iconName, "", 40);

    if (!Object.values(ICONS).includes(safeName)) {
      return document.createTextNode("");
    }

    const svg = document.createElementNS(SVG_NS, "svg");
    const use = document.createElementNS(SVG_NS, "use");

    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");

    if (className) svg.setAttribute("class", className);

    use.setAttribute("href", `#icon-${safeName}`);
    svg.appendChild(use);

    return svg;
  }

  /* =========================================================================
     07. IMAGE HANDLING
  ========================================================================= */

  setImage(image, source, options = {}) {
    if (!image) return false;

    const fallback = this.options.imageFallback || PLACEHOLDER;
    const safeSource = isSafeImageSource(source) ? source.trim() : fallback;
    const version = (this.imageVersions.get(image) || 0) + 1;

    this.imageVersions.set(image, version);

    image.onerror = () => {
      if (this.imageVersions.get(image) !== version) return;

      image.onerror = null;

      if (image.src !== new URL(fallback, document.baseURI).href) {
        image.src = fallback;
      }
    };

    image.onload = () => {
      if (this.imageVersions.get(image) !== version) return;

      image.classList.add("is-loaded");
      image.classList.remove("is-loading");
    };

    image.classList.remove("is-loaded");
    image.classList.add("is-loading");

    if (options.alt !== undefined) {
      image.alt = cleanText(options.alt, "", 300);
    }

    if (options.lazy !== false) {
      image.loading = "lazy";
    } else {
      image.loading = "eager";
    }

    image.decoding = "async";

    if (image.src !== new URL(safeSource, document.baseURI).href) {
      image.src = safeSource;
    }

    return true;
  }

  createTrackImage(track, className = "track-art", eager = false) {
    const image = createElement("img", className);

    image.alt = "";
    image.width = 120;
    image.height = 120;
    image.draggable = false;

    this.setImage(image, track?.thumbnail, {
      lazy: !eager
    });

    return image;
  }

  /* =========================================================================
     08. SEARCH STATES
  ========================================================================= */

  setStatus(message) {
    const element = this.elements.status;

    if (!element) return;

    element.textContent = cleanText(message, "", 500);
  }

  setSearching(value) {
    const button = this.elements.searchButton;
    const loading = this.elements.searchLoading;

    const searching = Boolean(value);
    this.state.searching = searching;

    if (button) {
      button.disabled = searching;
      button.setAttribute("aria-busy", String(searching));

      if (!this.originalButtonContents.has(button)) {
        this.originalButtonContents.set(
          button,
          Array.from(button.childNodes).map(node => node.cloneNode(true))
        );
      }

      if (searching) {
        button.textContent = "Buscando...";
      } else {
        const original = this.originalButtonContents.get(button) || [];
        button.replaceChildren(...original.map(node => node.cloneNode(true)));
      }
    }

    if (loading) {
      loading.hidden = !searching;
      loading.setAttribute("aria-hidden", String(!searching));
    }

    if (this.elements.form) {
      this.elements.form.setAttribute("aria-busy", String(searching));
    }
  }

  setResultCount(count) {
    const element = this.elements.resultCount;

    if (!element) return;

    const safeCount = Math.max(0, Math.floor(Number(count) || 0));

    element.textContent = safeCount
      ? formatCount(safeCount, "canción", "canciones")
      : "";
  }

  setSearchInput(value) {
    if (!this.elements.input) return;

    this.elements.input.value = cleanText(value, "", 300);
  }

  focusSearch() {
    this.elements.input?.focus();
  }

  /* =========================================================================
     09. EMPTY STATES
  ========================================================================= */

  showEmpty(container, message) {
    if (!container) return;

    const safeMessage = cleanText(message, "No hay contenido disponible.", 500);
    const empty = createElement("div", "empty-state", safeMessage);

    empty.setAttribute("role", "status");
    container.replaceChildren(empty);
  }

  createEmptyState(message, iconName = "") {
    const empty = createElement("div", "empty-state");
    empty.setAttribute("role", "status");

    if (iconName) {
      const icon = this.createIcon(iconName, "empty-state-icon");
      empty.appendChild(icon);
    }

    const text = createElement("p", "empty-state-message", message);
    empty.appendChild(text);

    return empty;
  }

  /* =========================================================================
     10. ACTION BUTTONS
  ========================================================================= */

  makeAction(icon, label, options = {}) {
    const button = document.createElement("button");

    button.type = "button";
    button.className = options.className || "track-action";
    button.title = cleanText(label, "Acción", 100);
    button.setAttribute("aria-label", cleanText(label, "Acción", 100));

    if (options.disabled) {
      button.disabled = true;
    }

    if (options.pressed !== undefined) {
      button.setAttribute("aria-pressed", String(Boolean(options.pressed)));
    }

    const iconName = ICONS[icon] || ICONS[icon?.toLowerCase?.()];

    if (iconName) {
      button.appendChild(this.createIcon(iconName));
    } else {
      button.textContent = cleanText(icon, "", 20);
    }

    return button;
  }

  bindAction(button, callback, track, label = "Acción") {
    if (!button || typeof callback !== "function") return;

    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();

      safeCallback(callback, [track], error => {
        this.reportError(`No se pudo ejecutar: ${label}`, error);
        this.toastMessage("No se pudo completar la acción.");
      });
    });
  }

  /* =========================================================================
     11. TRACK ROW FACTORY
  ========================================================================= */

  makeTrackRow(trackInput, actions = {}) {
    const track = normalizeTrack(trackInput);

    if (!track) {
      return createElement("article", "track-row is-invalid");
    }

    const row = createElement("article", "track-row");
    row.dataset.videoId = track.videoId;

    const image = this.createTrackImage(track);

    const main = createElement("div", "track-main");

    const title = createElement("div", "track-name", track.title);
    title.title = track.title;

    const channel = createElement("div", "track-channel", track.channelTitle);
    channel.title = track.channelTitle;

    main.append(title, channel);

    const buttons = createElement("div", "track-actions");

    const play = this.makeAction("play", "Reproducir");
    this.bindAction(play, actions.play, track, "reproducir");
    buttons.appendChild(play);

    if (typeof actions.favorite === "function") {
      const favorite = this.makeAction(
        "favorite",
        actions.isFavorite ? "Eliminar de favoritos" : "Agregar a favoritos",
        { pressed: Boolean(actions.isFavorite) }
      );

      favorite.classList.toggle("is-favorite", Boolean(actions.isFavorite));
      this.bindAction(favorite, actions.favorite, track, "favorito");
      buttons.appendChild(favorite);
    }

    if (typeof actions.save === "function") {
      const save = this.makeAction("save", "Guardar en biblioteca");
      this.bindAction(save, actions.save, track, "guardar");
      buttons.appendChild(save);
    }

    if (typeof actions.add === "function") {
      const add = this.makeAction("add", "Agregar a la cola");
      this.bindAction(add, actions.add, track, "agregar a la cola");
      buttons.appendChild(add);
    }

    if (typeof actions.remove === "function") {
      const remove = this.makeAction("remove", "Eliminar");
      this.bindAction(remove, actions.remove, track, "eliminar");
      buttons.appendChild(remove);
    }

    row.append(image, main, buttons);

    return row;
  }

  /* =========================================================================
     12. TRACK LIST RENDERING
  ========================================================================= */

  renderTracks(container, tracksInput, actionsFactory = () => ({}), emptyMessage = "") {
    if (!container) return false;

    const version = (this.renderVersions.get(container) || 0) + 1;
    this.renderVersions.set(container, version);

    const tracks = normalizeTrackList(
      tracksInput,
      this.options.maxRenderItems
    );

    if (!tracks.length) {
      this.showEmpty(
        container,
        emptyMessage || "Todavía no hay canciones aquí."
      );
      return true;
    }

    const fragment = document.createDocumentFragment();

    for (const track of tracks) {
      let actions = {};

      try {
        actions = safeCallback(actionsFactory, [track], error => {
          this.reportError("Error al preparar acciones de una canción.", error);
        }) || {};
      } catch {
        actions = {};
      }

      fragment.appendChild(this.makeTrackRow(track, actions));
    }

    if (this.renderVersions.get(container) !== version) {
      return false;
    }

    container.replaceChildren(fragment);
    container.dataset.trackCount = String(tracks.length);

    return true;
  }

  renderSearchResults(tracks, actions) {
    const list = normalizeTrackList(tracks, this.options.maxRenderItems);

    this.renderTracks(
      this.elements.results,
      list,
      actions,
      EMPTY_MESSAGES.search
    );

    this.setResultCount(list.length);
  }

  renderCollection(type, tracks, actions) {
    const targets = {
      library: this.elements.library,
      favorites: this.elements.favorites,
      history: this.elements.history
    };

    const counters = {
      library: this.elements.libraryCount,
      favorites: this.elements.favoritesCount,
      history: this.elements.historyCount
    };

    const target = targets[type];

    if (!target) return false;

    const list = normalizeTrackList(tracks, this.options.maxRenderItems);

    this.renderTracks(
      target,
      list,
      actions,
      EMPTY_MESSAGES[type] || "Todavía no hay canciones aquí."
    );

    const counter = counters[type];

    if (counter) {
      counter.textContent = String(list.length);
    }

    return true;
  }

  renderRecent(tracks, actions) {
    return this.renderTracks(
      this.elements.homeRecent,
      tracks,
      actions,
      EMPTY_MESSAGES.recent
    );
  }

  /* =========================================================================
     13. TRACK ROW UPDATES
  ========================================================================= */

  updateTrackFavorite(videoId, favorite) {
    if (!isValidVideoId(videoId)) return 0;

    let updated = 0;

    const containers = [
      this.elements.results,
      this.elements.homeRecent,
      this.elements.library,
      this.elements.favorites,
      this.elements.history,
      this.elements.queueList
    ];

    for (const container of containers) {
      if (!container) continue;

      const rows = container.querySelectorAll(
        `[data-video-id="${videoId}"]`
      );

      for (const row of rows) {
        const button = row.querySelector(
          '.track-action[aria-label*="favoritos"], .track-action[aria-label*="favorito"]'
        );

        if (!button) continue;

        button.classList.toggle("is-favorite", Boolean(favorite));
        button.setAttribute("aria-pressed", String(Boolean(favorite)));
        button.setAttribute(
          "aria-label",
          favorite ? "Eliminar de favoritos" : "Agregar a favoritos"
        );

        updated += 1;
      }
    }

    return updated;
  }

  setActiveTrack(videoId) {
    const containers = [
      this.elements.results,
      this.elements.homeRecent,
      this.elements.library,
      this.elements.favorites,
      this.elements.history,
      this.elements.queueList
    ];

    for (const container of containers) {
      if (!container) continue;

      container.querySelectorAll("[data-video-id]").forEach(row => {
        row.classList.toggle(
          "is-current",
          row.dataset.videoId === videoId
        );
      });
    }
  }

  /* =========================================================================
     14. CURRENT TRACK
  ========================================================================= */

  setCurrentTrack(trackInput, favorite = false) {
    const track = normalizeTrack(trackInput);

    this.state.currentTrack = track;
    this.state.currentFavorite = Boolean(favorite);

    const thumbnail = track?.thumbnail || this.options.imageFallback;
    const title = track?.title || DEFAULT_LABELS.idleTitle;
    const channel = track?.channelTitle || DEFAULT_LABELS.idleChannel;

    this.setImage(this.elements.currentThumbnail, thumbnail, { lazy: false });
    this.setImage(this.elements.fullThumbnail, thumbnail, { lazy: false });

    if (this.elements.currentTitle) {
      this.elements.currentTitle.textContent = title;
    }

    if (this.elements.currentChannel) {
      this.elements.currentChannel.textContent = channel;
    }

    if (this.elements.fullTitle) {
      this.elements.fullTitle.textContent = title;
    }

    if (this.elements.fullChannel) {
      this.elements.fullChannel.textContent = channel;
    }

    this.updateFavoriteButtons(Boolean(track), favorite);
    this.setActiveTrack(track?.videoId || "");

    if (!sameTrackId(this.lastCurrentTrack, track)) {
      this.setProgress(0, 0);
    }

    this.lastCurrentTrack = track;
    this.log("Canción actual actualizada:", track?.videoId || "ninguna");
  }

  updateFavoriteButtons(hasTrack, favorite) {
    const buttons = [
      this.elements.favoriteCurrent,
      this.elements.fullFavorite
    ];

    for (const button of buttons) {
      if (!button) continue;

      const isFavorite = Boolean(favorite);

      button.classList.toggle("is-favorite", isFavorite);
      button.disabled = !hasTrack;
      button.setAttribute("aria-pressed", String(isFavorite));
      button.setAttribute(
        "aria-label",
        isFavorite ? "Eliminar de favoritos" : "Agregar a favoritos"
      );
    }
  }

  setCurrentFavorite(favorite) {
    this.state.currentFavorite = Boolean(favorite);
    this.updateFavoriteButtons(
      Boolean(this.state.currentTrack),
      this.state.currentFavorite
    );
  }

  /* =========================================================================
     15. PLAYBACK STATE
  ========================================================================= */

  setPlaying(playing) {
    const isPlaying = Boolean(playing);
    this.state.playing = isPlaying;
    this.lastPlayingState = isPlaying;

    const buttons = [
      this.elements.playButton,
      this.elements.fullPlayButton
    ];

    for (const button of buttons) {
      if (!button) continue;

      this.setIcon(button, isPlaying ? "pause" : "play");

      button.setAttribute(
        "aria-label",
        isPlaying ? "Pausar" : "Reproducir"
      );

      button.setAttribute("aria-pressed", String(isPlaying));
      button.classList.toggle("is-playing", isPlaying);
    }

    document.body.classList.toggle("is-playing", isPlaying);
  }

  setPlaybackLoading(loading) {
    const value = Boolean(loading);

    for (const button of [
      this.elements.playButton,
      this.elements.fullPlayButton
    ]) {
      if (!button) continue;

      button.classList.toggle("is-loading", value);
      button.setAttribute("aria-busy", String(value));
    }
  }

  setPlaybackError(message = "No se pudo reproducir esta canción.") {
    this.setPlaybackLoading(false);
    this.setPlaying(false);
    this.toastMessage(message);
  }

  /* =========================================================================
     16. PROGRESS AND TIME
  ========================================================================= */

  setProgress(current, duration) {
    const safeDuration = Number.isFinite(Number(duration)) && Number(duration) > 0
      ? Number(duration)
      : 0;

    const safeCurrent = Number.isFinite(Number(current)) && Number(current) >= 0
      ? Math.min(Number(current), safeDuration || Number(current))
      : 0;

    this.lastProgress = {
      current: safeCurrent,
      duration: safeDuration
    };

    const formattedCurrent = this.formatTime(safeCurrent);
    const formattedDuration = this.formatTime(safeDuration);

    const timeTargets = [
      [this.elements.currentTime, formattedCurrent],
      [this.elements.duration, formattedDuration],
      [this.elements.fullCurrentTime, formattedCurrent],
      [this.elements.fullDuration, formattedDuration]
    ];

    for (const [element, value] of timeTargets) {
      if (element) element.textContent = value;
    }

    this.updateProgressInput(this.elements.progressBar, safeCurrent, safeDuration);
    this.updateProgressInput(this.elements.fullProgressBar, safeCurrent, safeDuration);
  }

  updateProgressInput(input, current, duration) {
    if (!input) return;

    input.min = "0";
    input.max = String(duration || 100);
    input.value = String(duration ? Math.min(current, duration) : 0);
    input.disabled = !duration;

    input.setAttribute(
      "aria-valuetext",
      `${this.formatTime(current)} de ${this.formatTime(duration)}`
    );
  }

  formatTime(seconds) {
    if (!Number.isFinite(Number(seconds)) || Number(seconds) < 0) {
      return "0:00";
    }

    const total = Math.floor(Number(seconds));
    const hours = Math.floor(total / 3600);
    const mins = Math.floor((total % 3600) / 60);
    const secs = String(total % 60).padStart(2, "0");

    if (hours > 0) {
      return `${hours}:${String(mins).padStart(2, "0")}:${secs}`;
    }

    return `${mins}:${secs}`;
  }

  setVolume(value) {
    const volume = clampNumber(value, 0, 100, 100);

    if (this.elements.volumeBar) {
      this.elements.volumeBar.value = String(volume);
      this.elements.volumeBar.setAttribute("aria-valuenow", String(volume));
    }

    return volume;
  }

  /* =========================================================================
     17. FULL PLAYER
  ========================================================================= */

  toggleFullPlayer(open) {
    const player = this.elements.fullPlayer;

    if (!player) return false;

    const shouldOpen = Boolean(open);

    if (shouldOpen === this.state.fullPlayerOpen) return true;

    if (shouldOpen) {
      this.lastFocusedElement = document.activeElement;
      this.state.fullPlayerOpen = true;
      this.setInert(this.elements.mainContent, true);
    } else {
      this.state.fullPlayerOpen = false;
      this.setInert(this.elements.mainContent, false);
    }

    player.classList.toggle("active", shouldOpen);
    player.setAttribute("aria-hidden", String(!shouldOpen));

    if ("inert" in player) {
      player.inert = !shouldOpen;
    }

    document.body.classList.toggle("full-player-open", shouldOpen);

    if (shouldOpen) {
      requestAnimationFrame(() => {
        this.elements.closeFullPlayer?.focus();
      });
    } else if (this.options.restoreFocus && this.lastFocusedElement?.isConnected) {
      requestAnimationFrame(() => this.lastFocusedElement.focus());
    }

    return true;
  }

  /* =========================================================================
     18. QUEUE
  ========================================================================= */

  renderQueue(tracksInput, currentId, onPlay, onRemove) {
    const container = this.elements.queueList;

    if (!container) return false;

    const tracks = normalizeTrackList(
      tracksInput,
      this.options.maxRenderItems
    );

    if (this.elements.queueCount) {
      this.elements.queueCount.textContent = String(tracks.length);
    }

    container.replaceChildren();

    if (!tracks.length) {
      this.showEmpty(container, EMPTY_MESSAGES.queue);
      return true;
    }

    const fragment = document.createDocumentFragment();

    tracks.forEach((track, index) => {
      const row = createElement("div", "queue-item");
      row.dataset.videoId = track.videoId;
      row.dataset.queueIndex = String(index);
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      row.setAttribute("aria-label", `Reproducir ${track.title}`);

      const isCurrent = track.videoId === currentId;

      row.classList.toggle("active", isCurrent);
      row.classList.toggle("is-current", isCurrent);
      row.setAttribute("aria-current", isCurrent ? "true" : "false");

      const image = this.createTrackImage(track, "queue-item-art");

      const info = createElement("div", "queue-item-info");
      const title = createElement("div", "queue-item-title", track.title);
      const channel = createElement("div", "queue-item-artist", track.channelTitle);

      info.append(title, channel);

      const remove = this.makeAction("remove", "Quitar de la cola");
      remove.classList.add("queue-item-remove");

      remove.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();

        safeCallback(onRemove, [index, track], error => {
          this.reportError("No se pudo quitar una canción de la cola.", error);
        });
      });

      const playTrack = () => {
        safeCallback(onPlay, [track, index], error => {
          this.reportError("No se pudo reproducir desde la cola.", error);
        });
      };

      row.addEventListener("click", event => {
        if (event.target.closest("button")) return;
        playTrack();
      });

      row.addEventListener("keydown", event => {
        if (event.target !== row) return;

        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          playTrack();
        }
      });

      row.append(image, info, remove);
      fragment.appendChild(row);
    });

    container.appendChild(fragment);
    return true;
  }

  toggleQueue(open) {
    const panel = this.elements.queuePanel;

    if (!panel) return false;

    const shouldOpen = Boolean(open);
    this.state.queueOpen = shouldOpen;

    panel.classList.toggle("active", shouldOpen);
    panel.setAttribute("aria-hidden", String(!shouldOpen));

    if ("inert" in panel) {
      panel.inert = !shouldOpen;
    }

    for (const button of [
      this.elements.queueToggle,
      this.elements.fullQueueButton
    ]) {
      if (button) {
        button.setAttribute("aria-expanded", String(shouldOpen));
      }
    }

    return true;
  }

  /* =========================================================================
     19. TOAST NOTIFICATIONS
  ========================================================================= */

  toastMessage(message, options = {}) {
    const toast = this.elements.toast;

    if (!toast) return false;

    const text = cleanText(message, "", 500);

    if (!text) return false;

    const duration = clampNumber(
      options.duration,
      500,
      10000,
      this.options.toastDuration
    );

    this.toastQueue.push({ text, duration });

    if (!this.toastIsVisible) {
      this.showNextToast();
    }

    return true;
  }

  showNextToast() {
    const toast = this.elements.toast;

    if (!toast || !this.toastQueue.length || this.destroyed) {
      this.toastIsVisible = false;
      return;
    }

    const next = this.toastQueue.shift();

    this.toastIsVisible = true;
    toast.textContent = next.text;
    toast.classList.add("visible");
    toast.setAttribute("aria-hidden", "false");

    if (this.toastTimer !== null) {
      window.clearTimeout(this.toastTimer);
    }

    this.toastTimer = window.setTimeout(() => {
      toast.classList.remove("visible");
      toast.setAttribute("aria-hidden", "true");

      this.toastTimer = window.setTimeout(() => {
        this.toastTimer = null;
        this.toastIsVisible = false;
        this.showNextToast();
      }, 180);
    }, next.duration);
  }

  clearToasts() {
    if (this.toastTimer !== null) {
      window.clearTimeout(this.toastTimer);
      this.toastTimer = null;
    }

    this.toastQueue.length = 0;
    this.toastIsVisible = false;

    if (this.elements.toast) {
      this.elements.toast.classList.remove("visible");
      this.elements.toast.textContent = "";
      this.elements.toast.setAttribute("aria-hidden", "true");
    }
  }

  /* =========================================================================
     20. NAVIGATION
  ========================================================================= */

  showView(name) {
    const safeName = cleanText(name, "", 80);

    if (!safeName) return false;

    const views = document.querySelectorAll(".view");
    let targetFound = false;

    for (const view of views) {
      const active = view.id === `view-${safeName}`;

      if (active) targetFound = true;

      view.classList.toggle("active", active);
      this.setInert(view, !active);
    }

    const navItems = document.querySelectorAll(".bottom-nav-item");

    for (const button of navItems) {
      const active = button.dataset.view === safeName;

      button.classList.toggle("active", active);

      if (active) {
        button.setAttribute("aria-current", "page");
      } else {
        button.removeAttribute("aria-current");
      }
    }

    this.activeView = targetFound ? safeName : this.activeView;

    if (!targetFound) {
      this.log("No se encontró la vista:", safeName);
    }

    return targetFound;
  }

  getActiveView() {
    return this.activeView;
  }

  /* =========================================================================
     21. SEARCH FORM HELPERS
  ========================================================================= */

  getSearchQuery() {
    return cleanText(this.elements.input?.value, "", 300);
  }

  clearSearch() {
    if (!this.elements.input) return;

    this.elements.input.value = "";
    this.elements.input.dispatchEvent(
      new Event("input", { bubbles: true })
    );
  }

  setSearchDisabled(disabled) {
    const value = Boolean(disabled);

    if (this.elements.input) {
      this.elements.input.disabled = value;
    }

    if (this.elements.searchButton) {
      this.elements.searchButton.disabled = value || this.state.searching;
    }
  }

  /* =========================================================================
     22. COLLECTION COUNTERS
  ========================================================================= */

  setCollectionCount(type, count) {
    const map = {
      library: this.elements.libraryCount,
      favorites: this.elements.favoritesCount,
      history: this.elements.historyCount
    };

    const element = map[type];

    if (!element) return false;

    element.textContent = String(
      Math.max(0, Math.floor(Number(count) || 0))
    );

    return true;
  }

  /* =========================================================================
     23. GENERAL UI STATE
  ========================================================================= */

  getState() {
    return {
      ...this.state,
      currentTrack: this.state.currentTrack
        ? { ...this.state.currentTrack }
        : null,
      lastProgress: { ...this.lastProgress },
      activeView: this.activeView
    };
  }

  resetTransientState() {
    this.setSearching(false);
    this.setPlaybackLoading(false);
    this.clearToasts();

    this.state.queueOpen = false;
    this.state.fullPlayerOpen = false;

    this.toggleQueue(false);
    this.toggleFullPlayer(false);
  }

  /* =========================================================================
     24. DIAGNOSTICS
  ========================================================================= */

  diagnose() {
    const missing = [];

    const required = [
      "results",
      "searchButton",
      "input",
      "currentTitle",
      "playButton"
    ];

    for (const key of required) {
      if (!this.elements[key]) missing.push(key);
    }

    const report = {
      initialized: this.initialized,
      destroyed: this.destroyed,
      missingRequiredElements: missing,
      listenerCount: this.listeners.length,
      toastQueueLength: this.toastQueue.length,
      activeView: this.activeView,
      state: this.getState()
    };

    if (missing.length) {
      console.warn("[Shunel UI] Elementos importantes no encontrados:", missing);
    }

    return report;
  }
}

/* ==========================================================================
   25. FACTORY
========================================================================== */

export function createShunelUI(options = {}) {
  const ui = new ShunelUI(options);
  ui.init();
  return ui;
}

/* ==========================================================================
   26. DEFAULT EXPORT
========================================================================== */

export default ShunelUI;
