
/* =========================================
   SHUNEL — APPLICATION CORE
   Navegación, búsqueda e integración
   Version: 2.2.0
========================================= */

(() => {
  "use strict";

  if (window.ShunelApp) return;

  const CONFIG = {
    defaultPage: "home",
    searchEndpoint: "/api/search",
    searchTimeout: 15000,
    toastDuration: 2800
  };

  const state = {
    initialized: false,
    currentPage: CONFIG.defaultPage,
    searching: false,
    searchController: null,
    searchRequestId: 0,
    lastSearchResults: [],
    toastTimer: null,
    boundElements: new WeakSet()
  };

  const pages = {
    home: "homePage",
    library: "libraryPage",
    playlists: "playlistsPage",
    favorites: "favoritesPage",
    artists: "artistsPage",
    profile: "profilePage",
    stats: "statsPage",
    rooms: "roomsPage",
    ai: "aiPage",
    settings: "settingsPage"
  };

  const $ = (selector, parent = document) =>
    parent.querySelector(selector);

  const $$ = (selector, parent = document) =>
    [...parent.querySelectorAll(selector)];

  /* =========================================
     EVENTOS
  ========================================= */

  function emit(name, detail = {}) {
    if (window.ShunelEvents) {
      window.ShunelEvents.emit(name, detail);
    } else {
      window.dispatchEvent(
        new CustomEvent(`shunel:${name}`, { detail })
      );
    }
  }

  function bind(element, event, callback) {
    if (!element || state.boundElements.has(element)) {
      return;
    }

    element.addEventListener(event, callback);
    state.boundElements.add(element);
  }

  /* =========================================
     NOTIFICACIONES
  ========================================= */

  function notify(message, duration = CONFIG.toastDuration) {
    const toast = $("#toast");

    if (!toast) {
      console.info("[Shunel]", message);
      return;
    }

    toast.textContent = String(message);

    toast.hidden = false;
    toast.classList.add("show");
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");

    clearTimeout(state.toastTimer);

    state.toastTimer = setTimeout(() => {
      toast.classList.remove("show");
      toast.hidden = true;
    }, duration);
  }

  /* =========================================
     NAVEGACIÓN
  ========================================= */

  function normalizePageName(value) {
    return String(value || "")
      .trim()
      .replace(/^#/, "")
      .replace(/Page$/i, "");
  }

  function getPageName(element) {
    if (!element) return null;

    return normalizePageName(
      element.dataset.page ||
      element.dataset.target ||
      element.getAttribute("data-navigation") ||
      ""
    );
  }

  function navigate(page, options = {}) {
    const pageName = normalizePageName(page);
    const pageId = pages[pageName];

    if (!pageId) {
      console.warn("[Shunel] Página desconocida:", pageName);
      return false;
    }

    const target = document.getElementById(pageId);

    if (!target) {
      console.warn(
        "[Shunel] No existe el contenedor:",
        pageId
      );

      return false;
    }

    Object.entries(pages).forEach(([name, id]) => {
      const section = document.getElementById(id);

      if (!section) return;

      const active = name === pageName;

      section.hidden = !active;
      section.classList.toggle("active", active);
      section.setAttribute("aria-hidden", String(!active));
    });

    $$("[data-page], [data-navigation], [data-target]").forEach(item => {
      const active = getPageName(item) === pageName;

      item.classList.toggle("active", active);

      if (active) {
        item.setAttribute("aria-current", "page");
      } else {
        item.removeAttribute("aria-current");
      }
    });

    state.currentPage = pageName;

    if (options.history !== false) {
      try {
        history.pushState(
          { page: pageName },
          "",
          `#${pageName}`
        );
      } catch (error) {
        console.warn("[Shunel] Error actualizando historial:", error);
      }
    }

    $("#mainMenu")?.classList.remove("open");

    emit("navigation:change", {
      page: pageName
    });

    return true;
  }

  function initializeNavigation() {
    $$("[data-page], [data-navigation], [data-target]").forEach(item => {
      bind(item, "click", event => {
        const page = getPageName(item);

        if (!page) return;

        event.preventDefault();
        navigate(page);
      });
    });

    window.addEventListener("popstate", () => {
      const page = normalizePageName(location.hash);

      navigate(
        pages[page] ? page : CONFIG.defaultPage,
        { history: false }
      );
    });

    const initialPage = normalizePageName(location.hash);

    navigate(
      pages[initialPage]
        ? initialPage
        : CONFIG.defaultPage,
      { history: false }
    );

    const menuButton = $("#menuButton");
    const menu = $("#mainMenu");

    bind(menuButton, "click", () => {
      menu?.classList.toggle("open");
    });
  }

  /* =========================================
     REPRODUCTOR
     Los controles pertenecen a player.js.
  ========================================= */

  function getPlayer() {
    return window.ShunelPlayer || null;
  }

  function play() {
    const player = getPlayer();

    if (!player) {
      notify("El reproductor no está disponible.");
      return false;
    }

    return player.togglePlay();
  }

  function pause() {
    return getPlayer()?.pause?.() ?? false;
  }

  function next() {
    return getPlayer()?.next?.() ?? false;
  }

  function previous() {
    return getPlayer()?.previous?.() ?? false;
  }

  function initializePlayerControls() {
    /*
      No registrar aquí los botones de reproducción,
      volumen ni progreso.

      player.js ya administra esos controles.
      Evitamos eventos duplicados.
    */
  }

  /* =========================================
     BÚSQUEDA MUSICAL
  ========================================= */

  function showSearchResults() {
    const section = $("#searchResults");

    if (section) {
      section.hidden = false;
    }
  }

  function hideSearchResults() {
    const section = $("#searchResults");

    if (section) {
      section.hidden = true;
    }
  }

  function normalizeSearchResult(item) {
    if (!item || typeof item !== "object") {
      return null;
    }

    /*
      Los resultados de ShunelSearch ya llegan
      normalizados. Esto también admite la
      respuesta directa de YouTube.
    */

    const snippet = item.snippet || {};

    const videoId =
      item.videoId ||
      item.youtubeId ||
      item.id?.videoId ||
      (typeof item.id === "string" ? item.id : "");

    if (!videoId) return null;

    const thumbnail =
      item.thumbnail ||
      item.artwork ||
      snippet.thumbnails?.high?.url ||
      snippet.thumbnails?.medium?.url ||
      snippet.thumbnails?.default?.url ||
      "";

    return {
      id: item.id?.videoId
        ? `youtube:${videoId}`
        : item.id || `youtube:${videoId}`,

      videoId,
      youtubeId: videoId,

      title:
        item.title ||
        snippet.title ||
        "Canción desconocida",

      artist:
        item.artist ||
        item.channelTitle ||
        snippet.channelTitle ||
        "Artista desconocido",

      channelTitle:
        item.channelTitle ||
        snippet.channelTitle ||
        "",

      thumbnail,
      artwork: thumbnail,
      source: "youtube",

      duration: Number(item.duration) || 0,

      metadata: item.metadata || {
        platform: "YouTube",
        description: snippet.description || "",
        publishedAt: snippet.publishedAt || ""
      }
    };
  }

  function renderSearchResults(results) {
    const container = $("#searchResultsList");

    if (!container) {
      console.warn("[Shunel] Falta #searchResultsList.");
      return;
    }

    container.replaceChildren();
    showSearchResults();

    if (!Array.isArray(results) || !results.length) {
      const empty = document.createElement("p");

      empty.className = "search-empty";
      empty.textContent = "No se encontraron canciones.";

      container.appendChild(empty);
      return;
    }

    const fragment = document.createDocumentFragment();

    results.forEach((track, index) => {
      const item = document.createElement("button");

      item.type = "button";
      item.className = "search-result";
      item.dataset.index = String(index);
      item.setAttribute(
        "aria-label",
        `Reproducir ${track.title}`
      );

      const artwork = document.createElement("img");

      artwork.alt = "";
      artwork.loading = "lazy";

      const image = track.artwork || track.thumbnail;

      if (image) {
        try {
          const url = new URL(image);

          if (["https:", "http:"].includes(url.protocol)) {
            artwork.src = url.href;
          }
        } catch {}
      }

      const information = document.createElement("span");
      information.className = "search-result-info";

      const title = document.createElement("strong");
      title.textContent = track.title || "Canción desconocida";

      const artist = document.createElement("small");
      artist.textContent = track.artist || "Artista desconocido";

      information.append(title, artist);
      item.append(artwork, information);

      bind(item, "click", async () => {
        await playSearchResult(index);
      });

      fragment.appendChild(item);
    });

    container.appendChild(fragment);
  }

  async function playSearchResult(index) {
    const track = state.lastSearchResults[index];

    if (!track) return false;

    const player = getPlayer();

    if (!player) {
      notify("El reproductor no está disponible.");
      return false;
    }

    try {
      const result = await player.playTrack(track);

      if (result === false) {
        notify("No se pudo reproducir esta canción.");
        return false;
      }

      return true;

    } catch (error) {
      console.error("[Shunel] Error reproduciendo:", error);

      notify("Error al reproducir la canción.");

      return false;
    }
  }

  async function searchMusic(query) {
    const searchQuery = String(query || "").trim();

    if (!searchQuery) {
      notify("Escribe el nombre de una canción o artista.");
      return false;
    }

    if (state.searchController) {
      state.searchController.abort();
    }

    const requestId = ++state.searchRequestId;
    const controller = new AbortController();

    state.searchController = controller;
    state.searching = true;

    const timeout = setTimeout(() => {
      controller.abort();
    }, CONFIG.searchTimeout);

    emit("search:start", {
      query: searchQuery
    });

    try {
      let results = [];

      if (
        window.ShunelSearch &&
        typeof window.ShunelSearch.search === "function"
      ) {
        results = await window.ShunelSearch.search(
          searchQuery,
          { signal: controller.signal }
        );

      } else {
        const params = new URLSearchParams({
          q: searchQuery,
          maxResults: "20"
        });

        const response = await fetch(
          `${CONFIG.searchEndpoint}?${params.toString()}`,
          {
            method: "GET",
            signal: controller.signal,
            headers: {
              Accept: "application/json"
            }
          }
        );

        if (!response.ok) {
          throw new Error(
            `Error de búsqueda: ${response.status}`
          );
        }

        const data = await response.json();

        results = Array.isArray(data)
          ? data
          : data.results || data.items || [];
      }

      if (requestId !== state.searchRequestId) {
        return false;
      }

      state.lastSearchResults = Array.isArray(results)
        ? results.map(normalizeSearchResult).filter(Boolean)
        : [];

      renderSearchResults(state.lastSearchResults);

      emit("search:results", {
        query: searchQuery,
        results: state.lastSearchResults
      });

      if (!state.lastSearchResults.length) {
        notify("No se encontraron resultados.");
      }

      return state.lastSearchResults;

    } catch (error) {
      if (requestId !== state.searchRequestId) {
        return false;
      }

      if (error.name === "AbortError") {
        notify("La búsqueda fue cancelada o tardó demasiado.");
      } else {
        console.error("[Shunel] Error de búsqueda:", error);
        notify("No se pudo realizar la búsqueda.");
      }

      emit("search:error", {
        query: searchQuery,
        message: error.message
      });

      return false;

    } finally {
      clearTimeout(timeout);

      if (requestId === state.searchRequestId) {
        state.searching = false;
        state.searchController = null;
      }
    }
  }

  function initializeSearch() {
    const form = $("#searchForm");
    const input = $("#searchInput");
    const button = $("#searchButton");

    if (form) {
      bind(form, "submit", event => {
        event.preventDefault();
        searchMusic(input?.value || "");
      });

      return;
    }

    /*
      Compatibilidad si el HTML todavía no
      contiene un formulario.
    */

    bind(button, "click", () => {
      searchMusic(input?.value || "");
    });

    bind(input, "keydown", event => {
      if (event.key !== "Enter") return;

      event.preventDefault();
      searchMusic(input.value);
    });
  }

  /* =========================================
     OVERLAYS
  ========================================= */

  function initializeOverlays() {
    const overlayPairs = [
      ["lyricsButton", "lyricsOverlay"],
      ["openLyricsButton", "lyricsOverlay"],
      ["closeLyricsButton", "lyricsOverlay"],
      ["openAIButton", "aiOverlay"],
      ["closeAIButton", "aiOverlay"],
      ["openQueueButton", "queueOverlay"],
      ["closeQueueButton", "queueOverlay"]
    ];

    overlayPairs.forEach(([buttonId, overlayId]) => {
      const button = document.getElementById(buttonId);
      const overlay = document.getElementById(overlayId);

      if (!button || !overlay) return;

      bind(button, "click", () => {
        const isCloseButton = buttonId.startsWith("close");

        if (isCloseButton) {
          overlay.classList.remove("active");
          overlay.hidden = true;
          overlay.setAttribute("aria-hidden", "true");
          return;
        }

        if (overlayId === "lyricsOverlay") {
          window.ShunelLyrics?.show?.();
          return;
        }

        overlay.hidden = false;
        overlay.classList.add("active");
        overlay.setAttribute("aria-hidden", "false");
      });
    });
  }

  /* =========================================
     SUPABASE
  ========================================= */

  function getSupabase() {
    return (
      window.shunelSupabase ||
      window.supabaseClient ||
      window._supabase ||
      null
    );
  }

  async function initializeAccount() {
    const client = getSupabase();

    if (!client?.auth) return;

    try {
      const { data, error } = await client.auth.getSession();

      if (error) throw error;

      if (data?.session?.user) {
        await window.ShunelProfiles?.load?.();
        await window.ShunelSocial?.load?.();
        await window.ShunelStatistics?.load?.();
      }

      client.auth.onAuthStateChange((event, session) => {
        if (event === "SIGNED_OUT") {
          window.ShunelProfiles?.clearLocal?.();
          window.ShunelSocial?.clear?.();

          emit("account:signed-out", {});
          return;
        }

        if (
          event === "SIGNED_IN" ||
          event === "TOKEN_REFRESHED"
        ) {
          Promise.resolve().then(async () => {
            try {
              await window.ShunelProfiles?.load?.();
              await window.ShunelSocial?.load?.();
              await window.ShunelStatistics?.load?.();

              emit("account:signed-in", {
                userId: session?.user?.id || null
              });
            } catch (error) {
              console.error(
                "[Shunel] Error sincronizando sesión:",
                error
              );
            }
          });
        }
      });

    } catch (error) {
      console.warn(
        "[Shunel] Supabase no está disponible:",
        error
      );
    }
  }

  /* =========================================
     EVENTOS DEL SISTEMA
  ========================================= */

  function initializeEvents() {
    const events = window.ShunelEvents;

    if (!events) return;

    events.on("trackchange", detail => {
      emit("app:trackchange", detail);
    });

    events.on("play", () => {
      emit("app:play", {});
    });

    events.on("pause", () => {
      emit("app:pause", {});
    });

    events.on("player:error", detail => {
      notify(detail?.message || "Error del reproductor.");
    });
  }

  /* =========================================
     MÓDULOS
  ========================================= */

  async function initializeModules() {
    const modules = [
      ["ShunelYouTube", "initialize"],
      ["ShunelAudioEngine", "initialize"],
      ["ShunelCrossfade", "initialize"],
      ["ShunelLyrics", "initialize"],
      ["ShunelCanvas", "initialize"],
      ["ShunelRadio", "initialize"],
      ["ShunelAI", "initialize"],
      ["ShunelProfiles", "initialize"],
      ["ShunelSocial", "initialize"],
      ["ShunelStatistics", "initialize"]
    ];

    for (const [moduleName, method] of modules) {
      const module = window[moduleName];

      if (typeof module?.[method] !== "function") {
        console.warn(
          `[Shunel] Módulo no disponible: ${moduleName}`
        );

        continue;
      }

      try {
        await module[method]();
      } catch (error) {
        console.error(
          `[Shunel] Error inicializando ${moduleName}:`,
          error
        );
      }
    }
  }

  /* =========================================
     INICIALIZACIÓN
  ========================================= */

  async function initialize() {
    if (state.initialized) return true;

    if (document.readyState === "loading") {
      await new Promise(resolve => {
        document.addEventListener(
          "DOMContentLoaded",
          resolve,
          { once: true }
        );
      });
    }

    window.ShunelEvents?.initialize?.();

    initializeEvents();
    initializeNavigation();
    initializePlayerControls();
    initializeSearch();
    initializeOverlays();

    await initializeModules();
    await initializeAccount();

    state.initialized = true;

    emit("app:ready", {
      page: state.currentPage
    });

    console.info("[Shunel] Aplicación inicializada.");

    return true;
  }

  /* =========================================
     API PÚBLICA
  ========================================= */

  window.ShunelApp = Object.freeze({
    initialize,
    navigate,
    notify,
    searchMusic,
    play,
    pause,
    next,
    previous,

    getState() {
      return {
        initialized: state.initialized,
        currentPage: state.currentPage,
        searching: state.searching,
        searchResults: state.lastSearchResults.length
      };
    }
  });

  initialize();

})();
