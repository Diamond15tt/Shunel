
/* ==========================================
   SHUNEL — APP CONTROLLER
   Navegación e integración de interfaz
========================================== */

(() => {
  "use strict";

  const $ = (selector, parent = document) =>
    parent.querySelector(selector);

  const $$ = (selector, parent = document) =>
    [...parent.querySelectorAll(selector)];

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

  let currentPage = "home";

  function showPage(pageName) {
    if (!pages[pageName]) {
      console.warn("[Shunel] Página desconocida:", pageName);
      return;
    }

    const target = $(pages[pageName]);

    if (!target) {
      console.error(
        "[Shunel] No existe el elemento:",
        pages[pageName]
      );
      return;
    }

    Object.entries(pages).forEach(([name, selector]) => {
      const page = $(selector);
      if (!page) return;

      const active = name === pageName;

      page.hidden = !active;
      page.classList.toggle("active", active);
      page.setAttribute("aria-hidden", String(!active));
    });

    currentPage = pageName;

    $$(".nav-link, .bottom-nav button, .bottom-nav a").forEach(item => {
      const destination =
        item.dataset.page ||
        item.dataset.target ||
        item.getAttribute("href")?.replace("#", "");

      const active =
        destination === pageName ||
        destination === pages[pageName].replace("#", "");

      item.classList.toggle("active", active);

      if (item.matches(".nav-link")) {
        if (active) {
          item.setAttribute("aria-current", "page");
        } else {
          item.removeAttribute("aria-current");
        }
      }
    });

    document.dispatchEvent(
      new CustomEvent("shunel:navigate", {
        detail: { page: pageName }
      })
    );

    window.scrollTo({
      top: 0,
      behavior: "instant"
    });
  }

  function getPageFromElement(element) {
    const link = element.closest(
      "[data-page], [data-target], .nav-link, .bottom-nav a, .bottom-nav button"
    );

    if (!link) return null;

    const value =
      link.dataset.page ||
      link.dataset.target ||
      link.getAttribute("href")?.replace("#", "");

    if (!value) return null;

    if (pages[value]) return value;

    return Object.keys(pages).find(
      key => pages[key].replace("#", "") === value
    ) || null;
  }

  // Navegación por delegación de eventos
  document.addEventListener("click", event => {
    const pageName = getPageFromElement(event.target);

    if (!pageName) return;

    event.preventDefault();
    showPage(pageName);
  });

  // Botón para abrir el perfil
  $("#profileButton")?.addEventListener("click", () => {
    showPage("profile");
  });

  // Botones de cierre de overlays
  const overlays = [
    "#nowPlayingScreen",
    "#lyricsScreen",
    "#queueScreen",
    "#canvasScreen",
    "#aiScreen"
  ];

  overlays.forEach(selector => {
    const overlay = $(selector);
    if (!overlay) return;

    const closeButtons = $$(
      "[data-close], .close-button, .close-overlay",
      overlay
    );

    closeButtons.forEach(button => {
      button.addEventListener("click", () => {
        overlay.classList.remove("active", "open");
        overlay.hidden = true;
      });
    });
  });

  // Botón para abrir el reproductor
  $("#bottom-player")?.addEventListener("click", event => {
    if (event.target.closest("button")) return;

    if (window.ShunelPlayer?.openPlayer) {
      window.ShunelPlayer.openPlayer();
    }
  });

  // Búsqueda
  $("#searchForm")?.addEventListener("submit", event => {
    event.preventDefault();

    const query = $("#searchInput")?.value.trim();

    if (!query) return;

    document.dispatchEvent(
      new CustomEvent("shunel:search", {
        detail: { query }
      })
    );
  });

  // Botón atrás del navegador
  window.addEventListener("popstate", () => {
    const page = location.hash.replace("#", "");

    if (pages[page]) {
      showPage(page);
    } else {
      showPage("home");
    }
  });

  // Estado inicial
  function initialize() {
    const requestedPage = location.hash.replace("#", "");

    showPage(pages[requestedPage] ? requestedPage : "home");

    document.documentElement.classList.add("shunel-ready");

    console.log("[Shunel] Interfaz inicializada correctamente.");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize);
  } else {
    initialize();
  }

  // API pública
  window.ShunelApp = {
    navigate: showPage,
    getCurrentPage: () => currentPage,
    getPages: () => ({ ...pages })
  };

})();
