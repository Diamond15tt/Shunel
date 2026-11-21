
/* ==========================================================================
   SHUNEL — UI CONTROLLER 3.1
   DOM rendering, player presentation, collections, queue, lyrics and navigation.

   Responsibilities:
   - Controls visual presentation and DOM updates.
   - Does not control audio playback or persistent storage.
   - Receives callbacks from app.js.
   - Preserves the existing public API.
   - Supports optional HTML elements without throwing errors.
   - Uses safe DOM methods instead of injecting untrusted HTML.
   - Owns and cleans up its event listeners and timers.
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
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function clampNumber(value, min, max, fallback = min) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, number));
}

function cleanText(
  value,
  fallback = "",
  maxLength = MAX_TEXT_LENGTH
) {
  if (typeof value !== "string") {
    return fallback;
  }

  const cleaned = value
    .replace(/\u0000/g, "")
    .trim()
    .slice(0, maxLength);

  return cleaned || fallback;
}

function isValidVideoId(value) {
  return (
    typeof value === "string" &&
    VIDEO_ID_PATTERN.test(value)
  );
}

function normalizeTrack(track) {
  if (!isObject(track) || !isValidVideoId(track.videoId)) {
    return null;
  }

  const normalized = {
    ...track,
    videoId: track.videoId,
    title: cleanText(
      track.title || track.name,
      DEFAULT_LABELS.title,
      300
    ),
    channelTitle: cleanText(
      track.channelTitle || track.channel || track.artist,
      DEFAULT_LABELS.channel,
      200
    ),
    thumbnail: cleanText(
      track.thumbnail ||
      track.thumbnailUrl ||
      track.image,
      "",
      2048
    )
  };

  return normalized;
}

function normalizeTrackList(
  tracks,
  limit = MAX_RENDER_ITEMS
) {
  if (!Array.isArray(tracks)) {
    return [];
  }

  const output = [];
  const max = clampNumber(
    limit,
    0,
    MAX_RENDER_ITEMS,
    MAX_RENDER_ITEMS
  );

  if (max === 0) {
    return output;
  }

  const seen = new Set();

  for (const track of tracks) {
    const normalized = normalizeTrack(track);

    if (!normalized) continue;
    if (seen.has(normalized.videoId)) continue;

    seen.add(normalized.videoId);
    output.push(normalized);

    if (output.length >= max) {
      break;
    }
  }

  return output;
}

function isSafeImageSource(source) {
  if (
    typeof source !== "string" ||
    !source.trim()
  ) {
    return false;
  }

  const value = source.trim();

  if (
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../")
  ) {
    return !value.startsWith("//");
  }

  try {
    const url = new URL(value, document.baseURI);

    return (
      url.protocol === "https:" ||
      url.protocol === "http:"
    );
  } catch {
    return false;
  }
}

function createElement(
  tag,
  className = "",
  text = null
) {
  const element = document.createElement(tag);

  if (className) {
    element.className = className;
  }

  if (text !== null) {
    element.textContent = String(text);
  }

  return element;
}

function formatCount(value, singular, plural) {
  const count = Math.max(
    0,
    Math.floor(Number(value) || 0)
  );

  return `${count} ${count === 1 ? singular : plural}`;
}

function sameTrackId(first, second) {
  if (!first || !second) {
    return false;
  }

  return first.videoId === second.videoId;
}

function safeCallback(
  callback,
  args = [],
  onError = null
) {
  if (typeof callback !== "function") {
    return undefined;
  }

  try {
    return callback(...args);
  } catch (error) {
    if (typeof onError === "function") {
      onError(error);
    } else {
      console.error(
        "[Shunel UI] Error en callback:",
        error
      );
    }

    return undefined;
  }
}

function isElement(value) {
  return value instanceof Element;
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

    this.lastProgress = {
      current: 0,
      duration: 0
    };

    this.elements = this.collectElements();

    this.state = {
      fullPlayerOpen: false,
      queueOpen: false,
      searching: false,
      currentTrack: null,
      currentFavorite: false,
      playing: false,
      playbackLoading: false
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
      searchClear: get("searchClear"),
      searchLoading: get("searchLoading"),

      // Collections
      homeRecent: get("homeRecentList"),
      library: get("libraryList"),
      favorites: get("favoritesList"),
      history: get("historyList"),

      libraryCount: get("libraryCount"),
      favoritesCount: get("favoritesCount"),
      historyCount: get("historyCount"),

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
      queueCount: get("queueCount"),

      // Notifications
      toast: get("toast"),

      // Lyrics
      lyricsContainer: get("lyricsContainer"),
      lyricsContent: get("lyricsContent"),
      lyricsTitle: get("lyricsTitle"),
      lyricsArtist: get("lyricsArtist"),
      lyricsStatus: get("lyricsStatus"),
      lyricsLoading: get("lyricsLoading"),
      lyricsEmpty: get("lyricsEmpty"),
      lyricsCurrentLine: get("lyricsCurrentLine"),

      // Optional additions
      fullPlayerTitleRegion: get("fullPlayerTitleRegion"),
      mainContent: get("mainContent"),
      playerDock: document.querySelector(".player-dock"),
      youtubePlayerHost: get("youtubePlayerHost")
    };
  }

  refreshElements() {
    if (this.destroyed) {
      return this.elements;
    }

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
    console.error(
      `[Shunel UI] ${message}`,
      error || ""
    );
  }

  /* =========================================================================
     04. EVENT OWNERSHIP
  ========================================================================= */

  on(id, event, callback, options = undefined) {
    const element = typeof id === "string"
      ? document.getElementById(id)
      : id;

    return this.listen(
      element,
      event,
      callback,
      options
    );
  }

  listen(
    element,
    event,
    callback,
    options = undefined
  ) {
    if (
      this.destroyed ||
      !element ||
      typeof callback !== "function"
    ) {
      return false;
    }

    element.addEventListener(
      event,
      callback,
      options
    );

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
    if (this.destroyed || this.initialized) {
      return false;
    }

    this.initialized = true;

    this.refreshElements();
    this.prepareAccessibility();
    this.bindInternalEvents();

    return true;
  }

  bindInternalEvents() {
    const {
      searchClear,
      input,
      progressBar,
      fullProgressBar
    } = this.elements;

    if (searchClear && input) {
      this.listen(
        searchClear,
        "click",
        () => {
          input.value = "";
          input.focus();

          this.setStatus("");
          this.setResultCount(0);

          input.dispatchEvent(
            new Event("input", {
              bubbles: true
            })
          );
        }
      );
    }

    for (const inputElement of [
      progressBar,
      fullProgressBar
    ]) {
      if (!inputElement) continue;

      this.listen(
        inputElement,
        "keydown",
        event => {
          if (event.key === "Home") {
            inputElement.value = "0";
          }
        }
      );
    }
  }

  destroy() {
    if (this.destroyed) {
      return;
    }

    this.removeOwnedListeners();
    this.clearToasts();

    this.toastQueue.length = 0;

    this.destroyed = true;
    this.initialized = false;

    this.log("UI controller destruido.");
  }

  /* =========================================================================
     05. ACCESSIBILITY
  ========================================================================= */

  prepareAccessibility() {
    const {
      toast,
      status,
      results,
      queueList
    } = this.elements;

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
      if (!button) continue;

      if (!button.hasAttribute("aria-pressed")) {
        button.setAttribute(
          "aria-pressed",
          "false"
        );
      }
    }

    if (this.elements.fullPlayer) {
      this.elements.fullPlayer.setAttribute(
        "aria-hidden",
        String(!this.state.fullPlayerOpen)
      );
    }

    if (this.elements.queuePanel) {
      this.elements.queuePanel.setAttribute(
        "aria-hidden",
        String(!this.state.queueOpen)
      );
    }
  }

  setInert(element, inert) {
    if (!element) return;

    if (
      this.options.useInert &&
      "inert" in element
    ) {
      element.inert = Boolean(inert);
    }

    element.setAttribute(
      "aria-hidden",
      String(Boolean(inert))
    );
  }

  /* =========================================================================
     06. ICONS
  ========================================================================= */

  setIcon(button, iconName) {
    if (!button) {
      return false;
    }

    const safeName = cleanText(
      iconName,
      "",
      40
    );

    if (!Object.values(ICONS).includes(safeName)) {
      this.log(
        "Icono no reconocido:",
        safeName
      );

      return false;
    }

    const svg = document.createElementNS(
      SVG_NS,
      "svg"
    );

    const use = document.createElementNS(
      SVG_NS,
      "use"
    );

    svg.setAttribute(
      "viewBox",
      "0 0 24 24"
    );

    svg.setAttribute(
      "aria-hidden",
      "true"
    );

    svg.setAttribute(
      "focusable",
      "false"
    );

    use.setAttribute(
      "href",
      `#icon-${safeName}`
    );

    svg.appendChild(use);
    button.replaceChildren(svg);

    return true;
  }

  createIcon(
    iconName,
    className = ""
  ) {
    const safeName = cleanText(
      iconName,
      "",
      40
    );

    if (!Object.values(ICONS).includes(safeName)) {
      return document.createTextNode("");
    }

    const svg = document.createElementNS(
      SVG_NS,
      "svg"
    );

    const use = document.createElementNS(
      SVG_NS,
      "use"
    );

    svg.setAttribute(
      "viewBox",
      "0 0 24 24"
    );

    svg.setAttribute(
      "aria-hidden",
      "true"
    );

    svg.setAttribute(
      "focusable",
      "false"
    );

    if (className) {
      svg.setAttribute(
        "class",
        className
      );
    }

    use.setAttribute(
      "href",
      `#icon-${safeName}`
    );

    svg.appendChild(use);

    return svg;
  }

  /* =========================================================================
     07. IMAGE HANDLING
  ========================================================================= */

  setImage(
    image,
    source,
    options = {}
  ) {
    if (!image) {
      return false;
    }

    const fallback = this.options.imageFallback || PLACEHOLDER;

    const safeSource = isSafeImageSource(source)
      ? source.trim()
      : fallback;

    const version = (
      this.imageVersions.get(image) || 0
    ) + 1;

    this.imageVersions.set(
      image,
      version
    );

    image.onerror = () => {
      if (
        this.imageVersions.get(image) !== version
      ) {
        return;
      }

      image.onerror = null;
      image.classList.remove("is-loading");
      image.classList.remove("is-loaded");

      const fallbackUrl = new URL(
        fallback,
        document.baseURI
      ).href;

      if (image.src !== fallbackUrl) {
        image.src = fallback;
      }
    };

    image.onload = () => {
      if (
        this.imageVersions.get(image) !== version
      ) {
        return;
      }

      image.classList.add("is-loaded");
      image.classList.remove("is-loading");
    };

    image.classList.remove("is-loaded");
    image.classList.add("is-loading");

    if (options.alt !== undefined) {
      image.alt = cleanText(
        options.alt,
        "",
        300
      );
    }

    image.loading = options.lazy === false
      ? "eager"
      : "lazy";

    image.decoding = "async";

    if (
      image.src !== new URL(
        safeSource,
        document.baseURI
      ).href
    ) {
      image.src = safeSource;
    }

    return true;
  }

  createTrackImage(
    track,
    className = "track-art",
    eager = false
  ) {
    const image = createElement(
      "img",
      className
    );

    image.alt = "";
    image.width = 120;
    image.height = 120;
    image.draggable = false;

    this.setImage(
      image,
      track?.thumbnail,
      {
        lazy: !eager
      }
    );

    return image;
  }

  /* =========================================================================
     08. SEARCH STATES
  ========================================================================= */

  setStatus(message) {
    const element = this.elements.status;

    if (!element) return;

    element.textContent = cleanText(
      message,
      "",
      500
    );
  }

  setSearching(value) {
    const button = this.elements.searchButton;
    const loading = this.elements.searchLoading;

    const searching = Boolean(value);

    this.state.searching = searching;

    if (button) {
      button.disabled = searching;

      button.setAttribute(
        "aria-busy",
        String(searching)
      );

      if (!this.originalButtonContents.has(button)) {
        this.originalButtonContents.set(
          button,
          Array.from(button.childNodes).map(
            node => node.cloneNode(true)
          )
        );
      }

      if (searching) {
        button.textContent = "Buscando...";
      } else {
        const original =
          this.originalButtonContents.get(button) || [];

        button.replaceChildren(
          ...original.map(
            node => node.cloneNode(true)
          )
        );
      }
    }

    if (loading) {
      loading.hidden = !searching;

      loading.setAttribute(
        "aria-hidden",
        String(!searching)
      );
    }

    if (this.elements.form) {
      this.elements.form.setAttribute(
        "aria-busy",
        String(searching)
      );
    }
  }

  setResultCount(count) {
    const element = this.elements.resultCount;

    if (!element) return;

    const safeCount = Math.max(
      0,
      Math.floor(Number(count) || 0)
    );

    element.textContent = safeCount
      ? formatCount(
          safeCount,
          "canción",
          "canciones"
        )
      : "";
  }

  setSearchInput(value) {
    if (!this.elements.input) return;

    this.elements.input.value = cleanText(
      value,
      "",
      300
    );
  }

  focusSearch() {
    this.elements.input?.focus();
  }

  getSearchQuery() {
    return cleanText(
      this.elements.input?.value,
      "",
      300
    );
  }

  clearSearch() {
    if (!this.elements.input) return;

    this.elements.input.value = "";

    this.elements.input.dispatchEvent(
      new Event("input", {
        bubbles: true
      })
    );
  }

  setSearchDisabled(disabled) {
    const value = Boolean(disabled);

    if (this.elements.input) {
      this.elements.input.disabled = value;
    }

    if (this.elements.searchButton) {
      this.elements.searchButton.disabled =
        value || this.state.searching;
    }
  }

  /* =========================================================================
     09. EMPTY STATES
  ========================================================================= */

  showEmpty(
    container,
    message
  ) {
    if (!container) return;

    const safeMessage = cleanText(
      message,
      "No hay contenido disponible.",
      500
    );

    const empty = createElement(
      "div",
      "empty-state",
      safeMessage
    );

    empty.setAttribute(
      "role",
      "status"
    );

    container.replaceChildren(empty);
  }

  createEmptyState(
    message,
    iconName = ""
  ) {
    const empty = createElement(
      "div",
      "empty-state"
    );

    empty.setAttribute(
      "role",
      "status"
    );

    if (iconName) {
      empty.appendChild(
        this.createIcon(
          iconName,
          "empty-state-icon"
        )
      );
    }

    empty.appendChild(
      createElement(
        "p",
        "empty-state-message",
        cleanText(message, "No hay contenido.")
      )
    );

    return empty;
  }

  /* =========================================================================
     10. ACTION BUTTONS
  ========================================================================= */

  makeAction(
    icon,
    label,
    options = {}
  ) {
    const button = document.createElement("button");

    button.type = "button";

    button.className =
      options.className || "track-action";

    button.title = cleanText(
      label,
      "Acción",
      100
    );

    button.setAttribute(
      "aria-label",
      cleanText(label, "Acción", 100)
    );

    if (options.disabled) {
      button.disabled = true;
    }

    if (options.pressed !== undefined) {
      button.setAttribute(
        "aria-pressed",
        String(Boolean(options.pressed))
      );
    }

    const iconName =
      ICONS[icon] ||
      ICONS[icon?.toLowerCase?.()];

    if (iconName) {
      button.appendChild(
        this.createIcon(iconName)
      );
    } else {
      button.textContent = cleanText(
        icon,
        "",
        20
      );
    }

    return button;
  }

  bindAction(
    button,
    callback,
    track,
    label = "Acción"
  ) {
    if (
      !button ||
      typeof callback !== "function"
    ) {
      return;
    }

    this.listen(
      button,
      "click",
      event => {
        event.preventDefault();
        event.stopPropagation();

        safeCallback(
          callback,
          [track],
          error => {
            this.reportError(
              `No se pudo ejecutar: ${label}`,
              error
            );

            this.toastMessage(
              "No se pudo completar la acción."
            );
          }
        );
      }
    );
  }

  /* =========================================================================
     11. TRACK ROW FACTORY
  ========================================================================= */

  makeTrackRow(
    trackInput,
    actions = {}
  ) {
    const track = normalizeTrack(trackInput);

    if (!track) {
      return createElement(
        "article",
        "track-row is-invalid"
      );
    }

    const row = createElement(
      "article",
      "track-row"
    );

    row.dataset.videoId = track.videoId;

    const image = this.createTrackImage(track);

    const main = createElement(
      "div",
      "track-main"
    );

    const title = createElement(
      "div",
      "track-name",
      track.title
    );

    title.title = track.title;

    const channel = createElement(
      "div",
      "track-channel",
      track.channelTitle
    );

    channel.title = track.channelTitle;

    main.append(
      title,
      channel
    );

    const buttons = createElement(
      "div",
      "track-actions"
    );

    const play = this.makeAction(
      "play",
      "Reproducir"
    );

    this.bindAction(
      play,
      actions.play,
      track,
      "reproducir"
    );

    buttons.appendChild(play);

    if (typeof actions.favorite === "function") {
      const favorite = this.makeAction(
        "favorite",
        actions.isFavorite
          ? "Eliminar de favoritos"
          : "Agregar a favoritos",
        {
          pressed: Boolean(actions.isFavorite)
        }
      );

      favorite.classList.toggle(
        "is-favorite",
        Boolean(actions.isFavorite)
      );

      this.bindAction(
        favorite,
        actions.favorite,
        track,
        "favorito"
      );

      buttons.appendChild(favorite);
    }

    if (typeof actions.save === "function") {
      const save = this.makeAction(
        "save",
        "Guardar en biblioteca"
      );

      this.bindAction(
        save,
        actions.save,
        track,
        "guardar"
      );

      buttons.appendChild(save);
    }

    if (typeof actions.add === "function") {
      const add = this.makeAction(
        "add",
        "Agregar a la cola"
      );

      this.bindAction(
        add,
        actions.add,
        track,
        "agregar a la cola"
      );

      buttons.appendChild(add);
    }

    if (typeof actions.remove === "function") {
      const remove = this.makeAction(
        "remove",
        "Eliminar"
      );

      this.bindAction(
        remove,
        actions.remove,
        track,
        "eliminar"
      );

      buttons.appendChild(remove);
    }

    row.append(
      image,
      main,
      buttons
    );

    return row;
  }

  /* =========================================================================
     12. TRACK LIST RENDERING
  ========================================================================= */

  renderTracks(
    container,
    tracksInput,
    actionsFactory = () => ({}),
    emptyMessage = ""
  ) {
    if (!container) return false;

    const version = (
      this.renderVersions.get(container) || 0
    ) + 1;

    this.renderVersions.set(
      container,
      version
    );

    const tracks = normalizeTrackList(
      tracksInput,
      this.options.maxRenderItems
    );

    if (!tracks.length) {
      this.showEmpty(
        container,
        emptyMessage || "Todavía no hay canciones aquí."
      );

      container.dataset.trackCount = "0";

      return true;
    }

    const fragment = document.createDocumentFragment();

    for (const track of tracks) {
      if (
        this.renderVersions.get(container) !== version
      ) {
        return false;
      }

      const actions = safeCallback(
        actionsFactory,
        [track],
        error => {
          this.reportError(
            "Error al preparar acciones de una canción.",
            error
          );
        }
      ) || {};

      fragment.appendChild(
        this.makeTrackRow(track, actions)
      );
    }

    if (
      this.renderVersions.get(container) !== version
    ) {
      return false;
    }

    container.replaceChildren(fragment);

    container.dataset.trackCount = String(
      tracks.length
    );

    return true;
  }

  renderSearchResults(
    tracks,
    actions
  ) {
    const list = normalizeTrackList(
      tracks,
      this.options.maxRenderItems
    );

    this.renderTracks(
      this.elements.results,
      list,
      actions,
      EMPTY_MESSAGES.search
    );

    this.setResultCount(list.length);

    return list.length;
  }

  renderCollection(
    type,
    tracks,
    actions
  ) {
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

    const list = normalizeTrackList(
      tracks,
      this.options.maxRenderItems
    );

    this.renderTracks(
      target,
      list,
      actions,
      EMPTY_MESSAGES[type] ||
      "Todavía no hay canciones aquí."
    );

    const counter = counters[type];

    if (counter) {
      counter.textContent = String(list.length);
    }

    return true;
  }

  renderRecent(
    tracks,
    actions
  ) {
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

  updateTrackFavorite(
    videoId,
    favorite
  ) {
    if (!isValidVideoId(videoId)) {
      return 0;
    }

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
          '.track-action[aria-label*="favoritos"], ' +
          '.track-action[aria-label*="favorito"]'
        );

        if (!button) continue;

        button.classList.toggle(
          "is-favorite",
          Boolean(favorite)
        );

        button.setAttribute(
          "aria-pressed",
          String(Boolean(favorite))
        );

        button.setAttribute(
          "aria-label",
          favorite
            ? "Eliminar de favoritos"
            : "Agregar a favoritos"
        );

        button.title = favorite
          ? "Eliminar de favoritos"
          : "Agregar a favoritos";

        updated++;
      }
    }

    return updated;
  }

  setActiveTrack(videoId) {
    const safeId = isValidVideoId(videoId)
      ? videoId
      : "";

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

      container
        .querySelectorAll("[data-video-id]")
        .forEach(row => {
          const active =
            row.dataset.videoId === safeId;

          row.classList.toggle(
            "is-current",
            active
          );

          row.setAttribute(
            "aria-current",
            active ? "true" : "false"
          );
        });
    }
  }

  /* =========================================================================
     14. CURRENT TRACK
  ========================================================================= */

  setCurrentTrack(
    trackInput,
    favorite = false
  ) {
    const track = normalizeTrack(trackInput);

    this.state.currentTrack = track;
    this.state.currentFavorite = Boolean(favorite);

    const thumbnail =
      track?.thumbnail ||
      this.options.imageFallback;

    const title =
      track?.title ||
      DEFAULT_LABELS.idleTitle;

    const channel =
      track?.channelTitle ||
      DEFAULT_LABELS.idleChannel;

    this.setImage(
      this.elements.currentThumbnail,
      thumbnail,
      {
        lazy: false,
        alt: title
      }
    );

    this.setImage(
      this.elements.fullThumbnail,
      thumbnail,
      {
        lazy: false,
        alt: title
      }
    );

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

    this.updateFavoriteButtons(
      Boolean(track),
      favorite
    );

    this.setActiveTrack(
      track?.videoId || ""
    );

    if (!sameTrackId(this.lastCurrentTrack, track)) {
      this.setProgress(0, 0);
    }

    this.lastCurrentTrack = track;

    this.updateLyricsHeader(track);

    this.log(
      "Canción actualizada:",
      track?.videoId || "ninguna"
    );
  }

  updateFavoriteButtons(
    hasTrack,
    favorite
  ) {
    const buttons = [
      this.elements.favoriteCurrent,
      this.elements.fullFavorite
    ];

    for (const button of buttons) {
      if (!button) continue;

      const isFavorite = Boolean(favorite);

      button.classList.toggle(
        "is-favorite",
        isFavorite
      );

      button.disabled = !hasTrack;

      button.setAttribute(
        "aria-pressed",
        String(isFavorite)
      );

      button.setAttribute(
        "aria-label",
        isFavorite
          ? "Eliminar de favoritos"
          : "Agregar a favoritos"
      );

      button.title = isFavorite
        ? "Eliminar de favoritos"
        : "Agregar a favoritos";
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

      this.setIcon(
        button,
        isPlaying ? "pause" : "play"
      );

      button.setAttribute(
        "aria-label",
        isPlaying ? "Pausar" : "Reproducir"
      );

      button.setAttribute(
        "aria-pressed",
        String(isPlaying)
      );

      button.classList.toggle(
        "is-playing",
        isPlaying
      );
    }

    document.body.classList.toggle(
      "is-playing",
      isPlaying
    );
  }

  setPlaybackLoading(loading) {
    const value = Boolean(loading);

    this.state.playbackLoading = value;

    for (const button of [
      this.elements.playButton,
      this.elements.fullPlayButton
    ]) {
      if (!button) continue;

      button.classList.toggle(
        "is-loading",
        value
      );

      button.setAttribute(
        "aria-busy",
        String(value)
      );
    }
  }

  setPlaybackError(
    message = "No se pudo reproducir esta canción."
  ) {
    this.setPlaybackLoading(false);
    this.setPlaying(false);
    this.toastMessage(message);
  }

  /* =========================================================================
     16. PROGRESS AND TIME
  ========================================================================= */

  setProgress(
    current,
    duration
  ) {
    const safeDuration =
      Number.isFinite(Number(duration)) &&
      Number(duration) > 0
        ? Number(duration)
        : 0;

    const safeCurrent =
      Number.isFinite(Number(current)) &&
      Number(current) >= 0
        ? Math.min(
            Number(current),
            safeDuration || Number(current)
          )
        : 0;

    this.lastProgress = {
      current: safeCurrent,
      duration: safeDuration
    };

    const formattedCurrent = this.formatTime(
      safeCurrent
    );

    const formattedDuration = this.formatTime(
      safeDuration
    );

    const timeTargets = [
      [
        this.elements.currentTime,
        formattedCurrent
      ],
      [
        this.elements.duration,
        formattedDuration
      ],
      [
        this.elements.fullCurrentTime,
        formattedCurrent
      ],
      [
        this.elements.fullDuration,
        formattedDuration
      ]
    ];

    for (const [element, value] of timeTargets) {
      if (element) {
        element.textContent = value;
      }
    }

    this.updateProgressInput(
      this.elements.progressBar,
      safeCurrent,
      safeDuration
    );

    this.updateProgressInput(
      this.elements.fullProgressBar,
      safeCurrent,
      safeDuration
    );
  }

  updateProgressInput(
    input,
    current,
    duration
  ) {
    if (!input) return;

    input.min = "0";
    input.max = String(duration || 100);

    input.value = String(
      duration
        ? Math.min(current, duration)
        : 0
    );

    input.disabled = !duration;

    input.setAttribute(
      "aria-valuetext",
      `${this.formatTime(current)} de ${this.formatTime(duration)}`
    );
  }

  formatTime(seconds) {
    if (
      !Number.isFinite(Number(seconds)) ||
      Number(seconds) < 0
    ) {
      return "0:00";
    }

    const total = Math.floor(Number(seconds));

    const hours = Math.floor(total / 3600);

    const mins = Math.floor(
      (total % 3600) / 60
    );

    const secs = String(
      total % 60
    ).padStart(2, "0");

    if (hours > 0) {
      return (
        `${hours}:` +
        `${String(mins).padStart(2, "0")}:` +
        secs
      );
    }

    return `${mins}:${secs}`;
  }

  setVolume(value) {
    const volume = clampNumber(
      value,
      0,
      100,
      100
    );

    if (this.elements.volumeBar) {
      this.elements.volumeBar.value = String(volume);

      this.elements.volumeBar.setAttribute(
        "aria-valuenow",
        String(volume)
      );
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

    if (
      shouldOpen === this.state.fullPlayerOpen
    ) {
      return true;
    }

    if (shouldOpen) {
      this.lastFocusedElement = document.activeElement;

      this.state.fullPlayerOpen = true;

      this.setInert(
        this.elements.mainContent,
        true
      );
    } else {
      this.state.fullPlayerOpen = false;

      this.setInert(
        this.elements.mainContent,
        false
      );
    }

    player.classList.toggle(
      "active",
      shouldOpen
    );

    player.setAttribute(
      "aria-hidden",
      String(!shouldOpen)
    );

    if ("inert" in player) {
      player.inert = !shouldOpen;
    }

    document.body.classList.toggle(
      "full-player-open",
      shouldOpen
    );

    if (shouldOpen) {
      requestAnimationFrame(() => {
        if (!this.destroyed) {
          this.elements.closeFullPlayer?.focus();
        }
      });
    } else if (
      this.options.restoreFocus &&
      this.lastFocusedElement?.isConnected
    ) {
      requestAnimationFrame(() => {
        if (!this.destroyed) {
          this.lastFocusedElement.focus();
        }
      });
    }

    return true;
  }

  openFullPlayer() {
    return this.toggleFullPlayer(true);
  }

  closeFullPlayer() {
    return this.toggleFullPlayer(false);
  }

  /* =========================================================================
     18. QUEUE
  ========================================================================= */

  renderQueue(
    tracksInput,
    currentId,
    onPlay,
    onRemove
  ) {
    const container = this.elements.queueList;

    if (!container) return false;

    const tracks = normalizeTrackList(
      tracksInput,
      this.options.maxRenderItems
    );

    if (this.elements.queueCount) {
      this.elements.queueCount.textContent =
        String(tracks.length);
    }

    container.replaceChildren();

    if (!tracks.length) {
      this.showEmpty(
        container,
        EMPTY_MESSAGES.queue
      );

      container.dataset.trackCount = "0";

      return true;
    }

    const fragment = document.createDocumentFragment();

    tracks.forEach((track, index) => {
      const row = createElement(
        "div",
        "queue-item"
      );

      row.dataset.videoId = track.videoId;
      row.dataset.queueIndex = String(index);

      row.tabIndex = 0;

      row.setAttribute(
        "role",
        "button"
      );

      row.setAttribute(
        "aria-label",
        `Reproducir ${track.title}`
      );

      const isCurrent =
        track.videoId === currentId;

      row.classList.toggle(
        "active",
        isCurrent
      );

      row.classList.toggle(
        "is-current",
        isCurrent
      );

      row.setAttribute(
        "aria-current",
        String(isCurrent)
      );

      const image = this.createTrackImage(
        track,
        "queue-item-art"
      );

      const info = createElement(
        "div",
        "queue-item-info"
      );

      const title = createElement(
        "div",
        "queue-item-title",
        track.title
      );

      const channel = createElement(
        "div",
        "queue-item-artist",
        track.channelTitle
      );

      info.append(
        title,
        channel
      );

      const remove = this.makeAction(
        "remove",
        "Quitar de la cola"
      );

      remove.classList.add(
        "queue-item-remove"
      );

      this.listen(
        remove,
        "click",
        event => {
          event.preventDefault();
          event.stopPropagation();

          safeCallback(
            onRemove,
            [index, track],
            error => {
              this.reportError(
                "No se pudo quitar una canción de la cola.",
                error
              );
            }
          );
        }
      );

      const playTrack = () => {
        safeCallback(
          onPlay,
          [track, index],
          error => {
            this.reportError(
              "No se pudo reproducir desde la cola.",
              error
            );
          }
        );
      };

      this.listen(
        row,
        "click",
        event => {
          if (
            event.target.closest("button")
          ) {
            return;
          }

          playTrack();
        }
      );

      this.listen(
        row,
        "keydown",
        event => {
          if (event.target !== row) return;

          if (
            event.key === "Enter" ||
            event.key === " "
          ) {
            event.preventDefault();
            playTrack();
          }
        }
      );

      row.append(
        image,
        info,
        remove
      );

      fragment.appendChild(row);
    });

    container.appendChild(fragment);

    container.dataset.trackCount = String(
      tracks.length
    );

    return true;
  }

  toggleQueue(open) {
    const panel = this.elements.queuePanel;

    if (!panel) return false;

    const shouldOpen = Boolean(open);

    this.state.queueOpen = shouldOpen;

    panel.classList.toggle(
      "active",
      shouldOpen
    );

    panel.setAttribute(
      "aria-hidden",
      String(!shouldOpen)
    );

    if ("inert" in panel) {
      panel.inert = !shouldOpen;
    }

    for (const button of [
      this.elements.queueToggle,
      this.elements.fullQueueButton
    ]) {
      if (button) {
        button.setAttribute(
          "aria-expanded",
          String(shouldOpen)
        );
      }
    }

    return true;
  }

  /* =========================================================================
     19. TOAST NOTIFICATIONS
  ========================================================================= */

  toastMessage(
    message,
    options = {}
  ) {
    const toast = this.elements.toast;

    if (!toast || this.destroyed) {
      return false;
    }

    const text = cleanText(
      message,
      "",
      500
    );

    if (!text) return false;

    const duration = clampNumber(
      options.duration,
      500,
      10000,
      this.options.toastDuration
    );

    this.toastQueue.push({
      text,
      duration
    });

    if (!this.toastIsVisible) {
      this.showNextToast();
    }

    return true;
  }

  showNextToast() {
    const toast = this.elements.toast;

    if (
      !toast ||
      !this.toastQueue.length ||
      this.destroyed
    ) {
      this.toastIsVisible = false;
      return;
    }

    const next = this.toastQueue.shift();

    this.toastIsVisible = true;

    toast.textContent = next.text;

    toast.classList.add("visible");

    toast.setAttribute(
      "aria-hidden",
      "false"
    );

    if (this.toastTimer !== null) {
      window.clearTimeout(this.toastTimer);
    }

    this.toastTimer = window.setTimeout(() => {
      toast.classList.remove("visible");

      toast.setAttribute(
        "aria-hidden",
        "true"
      );

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

      this.elements.toast.setAttribute(
        "aria-hidden",
        "true"
      );
    }
  }

  /* =========================================================================
     20. NAVIGATION
  ========================================================================= */

  showView(name) {
    const safeName = cleanText(
      name,
      "",
      80
    );

    if (!safeName) return false;

    const views = document.querySelectorAll(".view");

    let targetFound = false;

    for (const view of views) {
      const active =
        view.id === `view-${safeName}`;

      if (active) {
        targetFound = true;
      }

      view.classList.toggle(
        "active",
        active
      );

      this.setInert(
        view,
        !active
      );
    }

    const navItems = document.querySelectorAll(
      ".bottom-nav-item, [data-view]"
    );

    for (const button of navItems) {
      const active =
        button.dataset.view === safeName;

      button.classList.toggle(
        "active",
        active
      );

      if (active) {
        button.setAttribute(
          "aria-current",
          "page"
        );
      } else {
        button.removeAttribute("aria-current");
      }
    }

    if (targetFound) {
      this.activeView = safeName;
    } else {
      this.log(
        "No se encontró la vista:",
        safeName
      );
    }

    return targetFound;
  }

  getActiveView() {
    return this.activeView;
  }

  /* =========================================================================
     21. LIBRARY FILTERS
  ========================================================================= */

  setLibraryFilter(filter) {
    const safeFilter = cleanText(
      filter,
      "all",
      40
    );

    const library = this.elements.library;
    const favorites = this.elements.favorites;

    if (!library || !favorites) {
      return false;
    }

    const showFavorites =
      safeFilter === "favorites";

    library.hidden = showFavorites;
    favorites.hidden = !showFavorites;

    document
      .querySelectorAll("[data-library-filter]")
      .forEach(button => {
        const active =
          button.dataset.libraryFilter === safeFilter;

        button.classList.toggle(
          "active",
          active
        );

        button.setAttribute(
          "aria-pressed",
          String(active)
        );
      });

    return true;
  }

  /* =========================================================================
     22. COLLECTION COUNTERS
  ========================================================================= */

  setCollectionCount(
    type,
    count
  ) {
    const map = {
      library: this.elements.libraryCount,
      favorites: this.elements.favoritesCount,
      history: this.elements.historyCount
    };

    const element = map[type];

    if (!element) return false;

    element.textContent = String(
      Math.max(
        0,
        Math.floor(Number(count) || 0)
      )
    );

    return true;
  }

  /* =========================================================================
     23. LYRICS PRESENTATION
     Does not fetch lyrics or synchronize playback.
     Those responsibilities remain in lyrics.js.
  ========================================================================= */

  updateLyricsHeader(trackInput) {
    const track = normalizeTrack(trackInput);

    if (this.elements.lyricsTitle) {
      this.elements.lyricsTitle.textContent =
        track?.title || "Letras";
    }

    if (this.elements.lyricsArtist) {
      this.elements.lyricsArtist.textContent =
        track?.channelTitle || "";
    }
  }

  setLyricsLoading(loading) {
    const value = Boolean(loading);

    if (this.elements.lyricsLoading) {
      this.elements.lyricsLoading.hidden = !value;

      this.elements.lyricsLoading.setAttribute(
        "aria-hidden",
        String(!value)
      );
    }

    if (this.elements.lyricsStatus) {
      this.elements.lyricsStatus.textContent =
        value ? "Buscando letras..." : "";
    }

    if (this.elements.lyricsEmpty) {
      this.elements.lyricsEmpty.hidden = value;
    }
  }

  setLyricsStatus(message) {
    if (!this.elements.lyricsStatus) return;

    this.elements.lyricsStatus.textContent =
      cleanText(message, "", 500);
  }

  clearLyrics() {
    const targets = [
      this.elements.lyricsContent,
      this.elements.lyricsContainer
    ];

    for (const target of targets) {
      if (!target) continue;

      target.replaceChildren();
    }

    if (this.elements.lyricsCurrentLine) {
      this.elements.lyricsCurrentLine.textContent = "";
    }

    this.setLyricsStatus("");
  }

  renderLyrics(lines) {
    const container =
      this.elements.lyricsContent ||
      this.elements.lyricsContainer;

    if (!container) return false;

    if (!Array.isArray(lines) || !lines.length) {
      this.showEmpty(
        container,
        "No encontramos letras para esta canción."
      );

      return false;
    }

    const fragment = document.createDocumentFragment();

    lines.slice(0, 5000).forEach((line, index) => {
      const text = typeof line === "string"
        ? line
        : line?.text;

      const cleanLine = cleanText(
        text,
        "",
        1000
      );

      if (!cleanLine) return;

      const element = createElement(
        "p",
        "lyrics-line",
        cleanLine
      );

      element.dataset.lyricsIndex = String(index);

      if (
        line &&
        typeof line === "object" &&
        Number.isFinite(Number(line.time))
      ) {
        element.dataset.time = String(
          Math.max(0, Number(line.time))
        );
      }

      fragment.appendChild(element);
    });

    container.replaceChildren(fragment);

    this.setLyricsLoading(false);

    return true;
  }

  setActiveLyric(index) {
    const container =
      this.elements.lyricsContent ||
      this.elements.lyricsContainer;

    if (!container) return false;

    const safeIndex = Number.isInteger(Number(index))
      ? Number(index)
      : -1;

    const lines = container.querySelectorAll(
      "[data-lyrics-index]"
    );

    let activeLine = null;

    lines.forEach(line => {
      const active =
        Number(line.dataset.lyricsIndex) === safeIndex;

      line.classList.toggle(
        "active",
        active
      );

      line.classList.toggle(
        "is-active",
        active
      );

      if (active) {
        activeLine = line;
      }
    });

    // SCROLL FIX: scrollIntoView() también movía TODA la página en cada
    // línea de la letra (por eso el scroll "saltaba" solo). Ahora se
    // desplaza únicamente el cuadro de la letra.
    if (activeLine) {
      const scroller =
        this.elements.lyricsContainer || container;

      const lineBox = activeLine.getBoundingClientRect();
      const boxRect = scroller.getBoundingClientRect();

      const target =
        scroller.scrollTop +
        (lineBox.top - boxRect.top) -
        (scroller.clientHeight - lineBox.height) / 2;

      const reduceMotion = window.matchMedia?.(
        "(prefers-reduced-motion: reduce)"
      ).matches;

      scroller.scrollTo({
        top: Math.max(0, target),
        behavior: reduceMotion ? "auto" : "smooth"
      });
    }

    return Boolean(activeLine);
  }

  /* =========================================================================
     24. GENERAL UI STATE
  ========================================================================= */

  getState() {
    return {
      ...this.state,

      currentTrack: this.state.currentTrack
        ? { ...this.state.currentTrack }
        : null,

      lastProgress: {
        ...this.lastProgress
      },

      activeView: this.activeView
    };
  }

  resetTransientState() {
    this.setSearching(false);
    this.setPlaybackLoading(false);
    this.clearToasts();

    this.toggleQueue(false);
    this.toggleFullPlayer(false);
  }

  /* =========================================================================
     25. KEYBOARD AND FOCUS HELPERS
  ========================================================================= */

  focusElement(element) {
    if (!element || typeof element.focus !== "function") {
      return false;
    }

    element.focus();

    return document.activeElement === element;
  }

  focusFirstAvailable(elements = []) {
    for (const element of elements) {
      if (
        element &&
        !element.disabled &&
        element.isConnected
      ) {
        return this.focusElement(element);
      }
    }

    return false;
  }

  /* =========================================================================
     26. DIAGNOSTICS
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
      if (!this.elements[key]) {
        missing.push(key);
      }
    }

    const report = {
      initialized: this.initialized,
      destroyed: this.destroyed,

      missingRequiredElements: missing,

      listenerCount: this.listeners.length,

      toastQueueLength: this.toastQueue.length,

      activeView: this.activeView,

      state: this.getState(),

      availableElements: Object.keys(
        this.elements
      ).filter(key => Boolean(this.elements[key]))
    };

    if (missing.length) {
      console.warn(
        "[Shunel UI] Elementos importantes no encontrados:",
        missing
      );
    }

    return report;
  }
}

/* ==========================================================================
   27. FACTORY
========================================================================== */

export function createShunelUI(options = {}) {
  const ui = new ShunelUI(options);

  ui.init();

  return ui;
}

/* ==========================================================================
   28. DEFAULT EXPORT
========================================================================== */

export default ShunelUI;
