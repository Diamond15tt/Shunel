/* =====================================================
   SHUNEL — APP.JS (MASTER DEBUG EDITION)
   Control principal de la aplicación, PWA, Supabase Auth y UI
   ===================================================== */

(() => {
  "use strict";

  /* =====================================================
     1. UTILIDADES Y ESTADO GLOBAL
  ===================================================== */

  const $ = (selector, parent = document) => parent.querySelector(selector);
  const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];

  const state = {
    currentPage: "home",
    searching: false,
    searchRequest: 0,
    currentVideo: null,
    user: null,
    theme: localStorage.getItem("shunel_theme") || "dark"
  };

  const pages = {
    home: "#homePage",
    library: "#libraryPage",
    playlists: "#playlistsPage",
    favorites: "#favoritesPage",
    artists: "#artistsPage",
    profile: "#profilePage",
    stats: "#statsPage",
    rooms: "#roomsPage",
    ai: "#aiPage",
    settings: "#settingsPage"
  };

  /* =====================================================
     2. SUPABASE & AUTENTICACIÓN CON DEBUGIN
  ===================================================== */

  const SUPABASE_URL = "https://tztigiwqteilnhuopmxv.supabase.co";
  const SUPABASE_KEY = "sb_publishable_6XIlbp2GB_pWTfPa5nqUtA_RVzYbaQH";

  
  let supabaseClient = null;

  function initSupabase() {
    if (window.supabase && typeof window.supabase.createClient === "function") {
      try {
        supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
        console.log("[Shunel Supabase] Cliente inicializado correctamente.");
        checkUserSession();

        // Escuchar cambios de sesión en tiempo real
        supabaseClient.auth.onAuthStateChange((event, session) => {
          console.log("[Shunel Auth State Change]:", event, session);
          state.user = session?.user || null;
          updateProfileUI();
          toggleAuthScreen(!state.user);
        });
      } catch (err) {
        console.error("[Shunel Supabase] Error crítico al crear cliente:", err);
      }
    } else {
      console.warn("[Shunel Supabase] La librería de Supabase no está cargada en el HTML.");
    }
  }

  async function checkUserSession() {
    if (!supabaseClient) return;
    try {
      const { data: { session }, error } = await supabaseClient.auth.getSession();
      if (error) throw error;
      state.user = session?.user || null;
      console.log("[Shunel Auth] Sesión activa:", state.user ? state.user.email : "Ninguna");
      updateProfileUI();
      toggleAuthScreen(!state.user);
    } catch (error) {
      console.error("[Shunel Auth] Error al verificar sesión:", error);
    }
  }

  function updateProfileUI() {
    const usernameEl = $("#topbarUsername");
    if (usernameEl) {
      usernameEl.textContent = state.user 
        ? (state.user.user_metadata?.username || state.user.email?.split("@")[0] || "Mi cuenta") 
        : "Perfil";
    }

    const profileDisplayName = $("#profileDisplayName");
    if (profileDisplayName && state.user) {
      profileDisplayName.textContent = state.user.user_metadata?.displayName || state.user.user_metadata?.username || "Usuario de Shunel";
    }

    const profileEmail = $("#profileUsername");
    if (profileEmail && state.user) {
      profileEmail.textContent = state.user.email;
    }
  }

  function toggleAuthScreen(show) {
    const authScreen = $("#authScreen");
    if (!authScreen) return;
    if (show) {
      authScreen.classList.add("active");
      authScreen.removeAttribute("hidden");
    } else {
      authScreen.classList.remove("active");
      authScreen.setAttribute("hidden", "true");
    }
  }

  function initializeAuthForms() {
    const loginForm = $("#loginForm");
    const registerForm = $("#registerForm");
    const showRegisterBtn = $("#showRegisterButton");
    const signOutBtn = $("#signOutButton");

    // Alternar entre Login y Registro
    showRegisterBtn?.addEventListener("click", () => {
      const isHidden = registerForm.hidden;
      registerForm.hidden = !isHidden;
      loginForm.hidden = isHidden;
      showRegisterBtn.textContent = isHidden ? "Iniciar sesión" : "Crear cuenta";
    });

    // Manejar Inicio de Sesión
    loginForm?.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!supabaseClient) {
        console.error("[Shunel Auth] Cliente de Supabase no disponible.");
        return notify("Error: Supabase no está conectado.");
      }

      const email = $("#loginEmail")?.value.trim();
      const password = $("#loginPassword")?.value.trim();

      if (!email || !password) return notify("Completa todos los campos.");

      notify("Iniciando sesión...");
      console.log("[Shunel Auth] Intentando iniciar sesión con:", email);

      const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });

      if (error) {
        console.error("[Shunel Auth Login Error]:", error);
        notify("Error: " + error.message);
      } else {
        console.log("[Shunel Auth Login Success]:", data);
        notify("¡Bienvenido de vuelta a Shunel!");
        loginForm.reset();
        toggleAuthScreen(false);
      }
    });

    // Manejar Registro
    registerForm?.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!supabaseClient) return notify("Supabase no está conectado.");

      const username = $("#registerUsername")?.value.trim();
      const displayName = $("#registerDisplayName")?.value.trim();
      const email = $("#registerEmail")?.value.trim();
      const password = $("#registerPassword")?.value.trim();

      if (!email || !password || !username) return notify("Completa los campos obligatorios.");

      notify("Registrando cuenta...");
      console.log("[Shunel Auth] Intentando registrar usuario:", email);

      const { data, error } = await supabaseClient.auth.signUp({
        email,
        password,
        options: {
          data: { username, displayName }
        }
      });

      if (error) {
        console.error("[Shunel Auth Register Error]:", error);
        notify("Error: " + error.message);
      } else {
        console.log("[Shunel Auth Register Success]:", data);
        notify("¡Cuenta creada con éxito! Ya puedes iniciar sesión.");
        registerForm.reset();
        registerForm.hidden = true;
        loginForm.hidden = false;
        if (showRegisterBtn) showRegisterBtn.textContent = "Crear cuenta";
      }
    });

    // Manejar Cierre de Sesión
    signOutBtn?.addEventListener("click", async () => {
      if (!supabaseClient) return;
      const { error } = await supabaseClient.auth.signOut();
      if (error) {
        console.error("[Shunel Auth SignOut Error]:", error);
        notify("Error al cerrar sesión.");
      } else {
        notify("Sesión cerrada correctamente.");
        toggleAuthScreen(true);
      }
    });
  }

  /* =====================================================
     3. NOTIFICACIONES (TOAST)
  ===================================================== */

  function notify(message) {
    const toast = $("#toast");
    if (!toast) {
      console.log("[Shunel Notify]", message);
      return;
    }

    toast.textContent = message;
    toast.classList.add("show");

    clearTimeout(notify.timer);
    notify.timer = setTimeout(() => {
      toast.classList.remove("show");
    }, 3500);
  }

  /* =====================================================
     4. GESTIÓN DE TEMAS
  ===================================================== */

  function setTheme(themeName) {
    state.theme = themeName;
    document.body.setAttribute("data-theme", themeName);
    localStorage.setItem("shunel_theme", themeName);

    const themeSelect = $("#themeSetting");
    if (themeSelect) themeSelect.value = themeName;

    document.dispatchEvent(
      new CustomEvent("shunel:theme-change", { detail: { theme: themeName } })
    );
  }

  function initializeTheme() {
    setTheme(state.theme);
    const themeSelect = $("#themeSetting");
    if (themeSelect) {
      themeSelect.addEventListener("change", (e) => {
        setTheme(e.target.value);
        notify(`Tema cambiado correctamente.`);
      });
    }
  }

  /* =====================================================
     5. NAVEGACIÓN Y RUTAS SPA
  ===================================================== */

  function normalizePage(value) {
    if (!value) return null;
    value = value.replace(/^#/, "").replace(/^\/+/, "");
    if (pages[value]) return value;
    return Object.keys(pages).find(key => pages[key].replace("#", "") === value) || null;
  }

  function showPage(pageName, updateHistory = true) {
    const page = normalizePage(pageName);
    if (!page) {
      console.warn("[Shunel] Página desconocida:", pageName);
      return;
    }

    const target = $(pages[page]);
    if (!target) {
      console.error("[Shunel] No existe la sección:", pages[page]);
      notify("No se encontró esta sección.");
      return;
    }

    Object.entries(pages).forEach(([name, selector]) => {
      const element = $(selector);
      if (!element) return;
      const active = name === page;
      element.hidden = !active;
      element.classList.toggle("active", active);
      element.setAttribute("aria-hidden", String(!active));
    });

    state.currentPage = page;

    // Actualizar menús de navegación
    $$(".nav-link, .bottom-nav a, .bottom-nav button").forEach(item => {
      const destination = item.dataset.page || item.dataset.target || item.getAttribute("href");
      const active = normalizePage(destination) === page;
      item.classList.toggle("active", active);
      if (item.matches(".nav-link")) {
        if (active) item.setAttribute("aria-current", "page");
        else item.removeAttribute("aria-current");
      }
    });

    if (updateHistory) {
      history.replaceState({ page }, "", `#${page}`);
    }

    document.dispatchEvent(new CustomEvent("shunel:navigate", { detail: { page } }));

    window.scrollTo({ top: 0, behavior: "auto" });
  }

  function initializeNavigation() {
    document.addEventListener("click", event => {
      const link = event.target.closest("[data-page], [data-target], .nav-link, .bottom-nav a");
      if (!link) return;

      const destination = link.dataset.page || link.dataset.target || link.getAttribute("href");
      const page = normalizePage(destination);
      if (!page) return;

      event.preventDefault();
      showPage(page);
    });

    $("#profileButton")?.addEventListener("click", () => {
      showPage("profile");
    });

    window.addEventListener("popstate", () => {
      const page = normalizePage(location.hash);
      showPage(page || "home", false);
    });
  }

  /* =====================================================
     6. BUSCADOR YOUTUBE
  ===================================================== */

  const searchForm = $("#searchForm");
  const searchInput = $("#searchInput");
  const searchResults = $("#searchResults");

  function createSearchStatus(message) {
    if (!searchResults) return;
    const element = document.createElement("p");
    element.className = "search-status";
    element.textContent = message;
    searchResults.replaceChildren(element);
    searchResults.hidden = false;
  }

  function createSearchResult(track) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "search-result track-row";
    button.dataset.videoId = track.videoId;
    button.setAttribute("aria-label", `Reproducir ${track.title}`);

    const image = document.createElement("img");
    image.src = track.artwork || "";
    image.alt = "";
    image.loading = "lazy";

    const info = document.createElement("div");
    info.className = "track-info";

    const title = document.createElement("strong");
    title.textContent = track.title || "Sin título";

    const artist = document.createElement("span");
    artist.textContent = track.artist || "Artista desconocido";

    info.append(title, artist);
    button.append(image, info);

    return button;
  }

  async function searchMusic(query) {
    query = String(query || "").trim();
    if (!query) {
      notify("Escribe el nombre de una canción o artista.");
      return;
    }

    if (!searchResults) return;

    const requestId = ++state.searchRequest;
    state.searching = true;
    createSearchStatus("Buscando música...");

    try {
      const response = await fetch(`/api/youtube?q=${encodeURIComponent(query)}&limit=15`, {
        method: "GET",
        headers: { Accept: "application/json" }
      });

      let data;
      try {
        data = await response.json();
      } catch {
        throw new Error("Respuesta inválida del servidor.");
      }

      if (requestId !== state.searchRequest) return;
      if (!response.ok || !data.success) {
        throw new Error(data.error || `Error de búsqueda (${response.status}).`);
      }

      const results = Array.isArray(data.results) ? data.results : [];
      searchResults.replaceChildren();

      if (results.length === 0) {
        createSearchStatus("No encontramos canciones.");
        return;
      }

      results.forEach(track => {
        if (!track.videoId) return;
        searchResults.append(createSearchResult(track));
      });

      searchResults.hidden = false;

      document.dispatchEvent(new CustomEvent("shunel:search-results", { detail: { query, results } }));

    } catch (error) {
      if (requestId !== state.searchRequest) return;
      console.error("[Shunel Search]", error);
      createSearchStatus("No se pudo completar la búsqueda.");
      notify("Error al buscar música.");
    } finally {
      if (requestId === state.searchRequest) {
        state.searching = false;
      }
    }
  }

  function initializeSearch() {
    if (!searchForm) return;

    searchForm.addEventListener("submit", event => {
      event.preventDefault();
      searchMusic(searchInput?.value);
    });

    searchInput?.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        event.preventDefault();
        searchMusic(searchInput.value);
      }
    });
  }

  /* =====================================================
     7. REPRODUCTOR YOUTUBE
  ===================================================== */

  function playYouTubeVideo(videoId) {
    if (!videoId) return;
    const container = $("#youtubePlayerContainer");
    if (!container) {
      notify("Reproductor no disponible.");
      return;
    }

    const iframe = document.createElement("iframe");
    iframe.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?autoplay=1&playsinline=1&rel=0`;
    iframe.title = "Shunel Music Player";
    iframe.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
    iframe.allowFullscreen = true;
    iframe.setAttribute("frameborder", "0");

    container.replaceChildren(iframe);
    state.currentVideo = videoId;

    if (searchResults) searchResults.hidden = true;

    document.dispatchEvent(new CustomEvent("shunel:youtube-play", { detail: { videoId } }));
    notify("Reproduciendo audio...");
  }

  function initializeResults() {
    if (!searchResults) return;
    searchResults.addEventListener("click", event => {
      const result = event.target.closest("[data-video-id]");
      if (!result) return;
      playYouTubeVideo(result.dataset.videoId);
    });
  }

  /* =====================================================
     8. CONTROLES Y OVERLAYS
  ===================================================== */

  function initializePlayerControls() {
    $("#miniPlayButton")?.addEventListener("click", () => window.ShunelPlayer?.togglePlay?.());
    $("#miniNextButton")?.addEventListener("click", () => window.ShunelPlayer?.next?.());
    $("#miniPreviousButton")?.addEventListener("click", () => window.ShunelPlayer?.previous?.());
    $("#playButton")?.addEventListener("click", () => window.ShunelPlayer?.togglePlay?.());

    $("#bottom-player")?.addEventListener("click", event => {
      if (event.target.closest("button")) return;
      window.ShunelPlayer?.openPlayer?.();
    });
  }

  function initializeOverlays() {
    const selectors = ["#nowPlayingScreen", "#lyricsScreen", "#queueScreen", "#canvasScreen", "#aiScreen"];

    selectors.forEach(selector => {
      const overlay = $(selector);
      if (!overlay) return;

      $$("[data-close], .close-button, .close-overlay", overlay).forEach(button => {
        button.addEventListener("click", () => {
          overlay.classList.remove("active", "open");
          overlay.hidden = true;
        });
      });
    });

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        selectors.forEach(sel => {
          const el = $(sel);
          if (el && !el.hidden) {
            el.classList.remove("active", "open");
            el.hidden = true;
          }
        });
        if (searchResults) searchResults.hidden = true;
      }
    });
  }

  /* =====================================================
     9. DETECCIÓN DE CONEXIÓN (OFFLINE/ONLINE)
  ===================================================== */

  function initializeNetworkListeners() {
    window.addEventListener("online", () => notify("Conexión restablecida."));
    window.addEventListener("offline", () => notify("Estás sin conexión. Modo offline activo."));
  }

  /* =====================================================
     10. SERVICE WORKER / PWA
  ===================================================== */

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js")
      .then(reg => console.log("[Shunel PWA] Service Worker registrado:", reg.scope))
      .catch(err => console.error("[Shunel PWA] Error Service Worker:", err));
  }

  /* =====================================================
     11. INICIALIZACIÓN GLOBAL
  ===================================================== */

  function initialize() {
    initSupabase();
    initializeAuthForms();
    initializeTheme();
    initializeNavigation();
    initializeSearch();
    initializeResults();
    initializePlayerControls();
    initializeOverlays();
    initializeNetworkListeners();

    const initialPage = normalizePage(location.hash) || "home";
    showPage(initialPage, false);

    document.documentElement.classList.add("shunel-ready");
    registerServiceWorker();

    console.log("[Shunel] Aplicación inicializada correctamente.");
  }

  /* =====================================================
     12. API PÚBLICA DE LA APP
  ===================================================== */

  window.ShunelApp = {
    navigate: showPage,
    search: searchMusic,
    playYouTube: playYouTubeVideo,
    setTheme,
    getCurrentPage: () => state.currentPage,
    getUser: () => state.user,
    getState: () => ({ ...state }),
    getPages: () => ({ ...pages })
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  } else {
    initialize();
  }

})();
