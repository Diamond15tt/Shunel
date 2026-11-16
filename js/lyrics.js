
/* =========================================
   SHUNEL — LYRICS ENGINE
   Letras y sincronización musical
   Version: 2.0.0
========================================= */

(() => {
  "use strict";

  if (window.ShunelLyrics) {
    console.warn("[Shunel Lyrics] Ya está inicializado.");
    return;
  }

  const API = "https://lrclib.net/api";

  const CACHE_KEY = "shunel_lyrics_cache";
  const MAX_CACHE = 100;

  const elements = {
    overlay: document.getElementById("lyricsOverlay"),
    container: document.getElementById("lyricsContainer"),
    content: document.getElementById("lyricsContent"),
    title: document.getElementById("lyricsTitle"),
    artist: document.getElementById("lyricsArtist"),
    close: document.getElementById("closeLyricsButton"),
    search: document.getElementById("lyricsSearchButton")
  };

  const state = {
    currentTrack: null,
    lines: [],
    synchronized: false,
    loading: false,
    initialized: false,
    requestId: 0,
    activeIndex: -1,
    cache: new Map(),
    abortController: null
  };

  function emit(name, detail = {}) {
    if (window.ShunelEvents) {
      window.ShunelEvents.emit(name, detail);
    } else {
      window.dispatchEvent(
        new CustomEvent(`shunel:${name}`, { detail })
      );
    }
  }

  function normalizeText(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();
  }

  function getAudio() {
    return window.ShunelPlayer?.getAudio?.() ||
      document.getElementById("localAudio");
  }

  function getCurrentTime() {
    const player = window.ShunelPlayer;

    if (player?.getState().source === "youtube") {
      return window.ShunelYouTube?.getCurrentTime?.() || 0;
    }

    return getAudio()?.currentTime || 0;
  }

  function getTrackKey(track) {
    return [
      normalizeText(track.title),
      normalizeText(track.artist)
    ].join("::");
  }

  function loadCache() {
    try {
      const saved = JSON.parse(
        localStorage.getItem(CACHE_KEY) || "[]"
      );

      if (Array.isArray(saved)) {
        saved.forEach(item => {
          if (item.key && Array.isArray(item.lines)) {
            state.cache.set(item.key, item.lines);
          }
        });
      }
    } catch {
      console.warn("[Shunel Lyrics] Caché inválida.");
    }
  }

  function saveCache() {
    try {
      const entries = [...state.cache.entries()]
        .slice(-MAX_CACHE)
        .map(([key, lines]) => ({
          key,
          lines
        }));

      localStorage.setItem(
        CACHE_KEY,
        JSON.stringify(entries)
      );
    } catch (error) {
      console.warn(
        "[Shunel Lyrics] No se pudo guardar:",
        error
      );
    }
  }

  function parseLRC(content) {
    if (!content) return [];

    const lines = [];

    const regex =
      /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\](.*)/g;

    for (const rawLine of content.split(/\r?\n/)) {
      let match;
      regex.lastIndex = 0;

      while ((match = regex.exec(rawLine)) !== null) {
        const minutes = Number(match[1]);
        const seconds = Number(match[2]);

        const fraction = match[3] || "0";

        const milliseconds =
          fraction.length === 1
            ? Number(fraction) * 100
            : fraction.length === 2
              ? Number(fraction) * 10
              : Number(fraction);

        lines.push({
          time:
            minutes * 60 +
            seconds +
            milliseconds / 1000,
          text: match[4].trim()
        });
      }
    }

    return lines
      .filter(line => line.text)
      .sort((a, b) => a.time - b.time);
  }

  function render(lines) {
    const container =
      elements.content ||
      elements.container;

    if (!container) return;

    container.replaceChildren();

    if (!lines.length) {
      const message = document.createElement("p");

      message.className = "lyrics-empty";
      message.textContent = "No hay letras disponibles.";

      container.appendChild(message);

      return;
    }

    const fragment = document.createDocumentFragment();

    lines.forEach((line, index) => {
      const element = document.createElement("p");

      element.className = "lyrics-line";
      element.dataset.index = index;
      element.textContent = line.text;

      if (line.time !== null) {
        element.dataset.time = line.time;
      }

      fragment.appendChild(element);
    });

    container.appendChild(fragment);
  }

  function updateHeader(track) {
    if (elements.title) {
      elements.title.textContent =
        track?.title || "Letras";
    }

    if (elements.artist) {
      elements.artist.textContent =
        track?.artist || "";
    }
  }

  function setLoading(value) {
    state.loading = Boolean(value);

    if (!elements.content && !elements.container) {
      return;
    }

    const container =
      elements.content ||
      elements.container;

    if (state.loading) {
      container.textContent = "Buscando letras...";
      container.setAttribute("aria-busy", "true");
    } else {
      container.removeAttribute("aria-busy");
    }
  }

  function show() {
    if (!elements.overlay) return false;

    elements.overlay.hidden = false;
    elements.overlay.classList.add("active");
    elements.overlay.setAttribute("aria-hidden", "false");

    emit("lyrics:open", {});

    return true;
  }

  function close() {
    if (!elements.overlay) return false;

    elements.overlay.classList.remove("active");
    elements.overlay.hidden = true;
    elements.overlay.setAttribute("aria-hidden", "true");

    emit("lyrics:close", {});

    return true;
  }

  async function fetchLyrics(track) {
    const key = getTrackKey(track);

    if (state.cache.has(key)) {
      return state.cache.get(key);
    }

    if (state.abortController) {
      state.abortController.abort();
    }

    const controller = new AbortController();

    state.abortController = controller;

    const timeout = setTimeout(
      () => controller.abort(),
      12000
    );

    try {
      const params = new URLSearchParams({
        track_name: track.title,
        artist_name: track.artist
      });

      if (track.album) {
        params.set("album_name", track.album);
      }

      if (track.duration > 0) {
        params.set(
          "duration",
          String(Math.round(track.duration))
        );
      }

      const response = await fetch(
        `${API}/get?${params.toString()}`,
        {
          signal: controller.signal,
          headers: {
            Accept: "application/json"
          }
        }
      );

      if (!response.ok) {
        if (response.status === 404) return [];

        throw new Error(
          `LRCLIB respondió ${response.status}.`
        );
      }

      const data = await response.json();

      let lines = [];

      if (data.syncedLyrics) {
        lines = parseLRC(data.syncedLyrics);
      }

      if (!lines.length && data.plainLyrics) {
        lines = data.plainLyrics
          .split(/\r?\n/)
          .map(text => ({
            time: null,
            text: text.trim()
          }))
          .filter(line => line.text);
      }

      state.cache.set(key, lines);

      saveCache();

      return lines;

    } finally {
      clearTimeout(timeout);

      if (state.abortController === controller) {
        state.abortController = null;
      }
    }
  }

  async function search(track = null) {
    const target =
      track ||
      window.ShunelPlayer?.getCurrentTrack?.();

    if (!target) {
      emit("lyrics:error", {
        message: "No hay ninguna canción seleccionada."
      });

      return false;
    }

    const requestId = ++state.requestId;

    state.currentTrack = target;
    state.lines = [];
    state.activeIndex = -1;

    updateHeader(target);
    setLoading(true);

    try {
      const lines = await fetchLyrics(target);

      if (requestId !== state.requestId) {
        return false;
      }

      state.lines = lines;
      state.synchronized = lines.some(
        line => line.time !== null
      );

      setLoading(false);
      render(lines);

      emit("lyrics:loaded", {
        track: target,
        count: lines.length,
        synchronized: state.synchronized
      });

      return lines.length > 0;

    } catch (error) {
      if (requestId !== state.requestId) {
        return false;
      }

      state.lines = [];
      state.synchronized = false;

      setLoading(false);
      render([]);

      emit("lyrics:error", {
        message: error.name === "AbortError"
          ? "La búsqueda tardó demasiado."
          : error.message
      });

      return false;
    }
  }

  function sync() {
    if (!state.synchronized || !state.lines.length) {
      return;
    }

    const currentTime = getCurrentTime();

    let active = -1;

    for (let i = 0; i < state.lines.length; i++) {
      const line = state.lines[i];

      if (
        line.time !== null &&
        line.time <= currentTime
      ) {
        active = i;
      } else if (
        line.time !== null &&
        line.time > currentTime
      ) {
        break;
      }
    }

    if (active === state.activeIndex) return;

    state.activeIndex = active;

    const container =
      elements.content ||
      elements.container;

    if (!container) return;

    const lines = container.querySelectorAll(
      ".lyrics-line"
    );

    lines.forEach((element, index) => {
      const isActive = index === active;

      element.classList.toggle(
        "active",
        isActive
      );

      element.classList.toggle(
        "past",
        index < active
      );

      if (isActive) {
        element.scrollIntoView({
          behavior: "smooth",
          block: "center"
        });
      }
    });

    emit("lyrics:linechange", {
      index: active,
      line: state.lines[active] || null,
      currentTime
    });
  }

  function handleTrackChange(detail) {
    const track = detail?.track;

    if (!track) {
      state.requestId++;
      state.lines = [];
      state.currentTrack = null;
      state.synchronized = false;

      state.abortController?.abort();

      render([]);

      return;
    }

    search(track);
  }

  function bindEvents() {
    if (window.ShunelEvents) {
      window.ShunelEvents.on(
        "trackchange",
        handleTrackChange
      );
    } else {
      window.addEventListener(
        "shunel:trackchange",
        event => handleTrackChange(event.detail)
      );
    }

    const audio = getAudio();

    audio?.addEventListener("timeupdate", sync);

    elements.close?.addEventListener(
      "click",
      close
    );

    elements.search?.addEventListener(
      "click",
      () => search()
    );

    elements.overlay?.addEventListener(
      "click",
      event => {
        if (event.target === elements.overlay) {
          close();
        }
      }
    );
  }

  function initialize() {
    if (state.initialized) return;

    loadCache();
    bindEvents();

    state.initialized = true;

    emit("lyrics:ready", {});

    console.info("[Shunel Lyrics] Sistema preparado.");
  }

  window.ShunelLyrics = Object.freeze({
    initialize,
    search,
    show,
    close,
    sync,
    parseLRC,
    getState() {
      return {
        currentTrack: state.currentTrack,
        lineCount: state.lines.length,
        synchronized: state.synchronized,
        loading: state.loading,
        activeIndex: state.activeIndex
      };
    }
  });

  initialize();

})();
