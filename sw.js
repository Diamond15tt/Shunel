
/* =========================================
   SHUNEL — SERVICE WORKER
   PWA, caché y funcionamiento offline
   Version: 2.0.0
========================================= */

"use strict";

const VERSION = "2.0.0";

const CACHE_PREFIX = "shunel-";
const STATIC_CACHE = `${CACHE_PREFIX}static-${VERSION}`;
const RUNTIME_CACHE = `${CACHE_PREFIX}runtime-${VERSION}`;

const APP_FILES = [
  "/",
  "/index.html",
  "/manifest.json",

  "/css/style.css",
  "/css/player.css",

  "/js/events.js",
  "/js/player.js",
  "/js/youtube.js",
  "/js/audio-engine.js",
  "/js/crossfade.js",
  "/js/lyrics.js",
  "/js/canvas.js",
  "/js/smart-radio.js",
  "/js/shunel-ai.js",
  "/js/profiles.js",
  "/js/social.js",
  "/js/statistics.js",
  "/js/app.js"
];

const MAX_RUNTIME_ENTRIES = 60;

const NETWORK_TIMEOUT = 5000;

/* =========================================
   INSTALACIÓN
========================================= */

self.addEventListener("install", event => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);

      /*
        No obligamos a que todos los archivos
        existan para completar la instalación.
        Los recursos faltantes se reportan.
      */

      await Promise.all(
        APP_FILES.map(async path => {
          try {
            const response = await fetch(path, {
              cache: "reload"
            });

            if (!response.ok) {
              throw new Error(
                `HTTP ${response.status}`
              );
            }

            await cache.put(path, response);

          } catch (error) {
            console.warn(
              "[Shunel SW] No se pudo guardar:",
              path,
              error.message
            );
          }
        })
      );

      await self.skipWaiting();

      console.info(
        `[Shunel SW] Instalado ${VERSION}`
      );
    })()
  );
});

/* =========================================
   ACTIVACIÓN
========================================= */

self.addEventListener("activate", event => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();

      await Promise.all(
        keys.map(async key => {
          if (
            key.startsWith(CACHE_PREFIX) &&
            key !== STATIC_CACHE &&
            key !== RUNTIME_CACHE
          ) {
            await caches.delete(key);
          }
        })
      );

      await self.clients.claim();

      console.info(
        `[Shunel SW] Activado ${VERSION}`
      );
    })()
  );
});

/* =========================================
   UTILIDADES
========================================= */

function isSameOrigin(url) {
  return url.origin === self.location.origin;
}

function isCacheable(response) {
  return (
    response &&
    response.status === 200 &&
    response.type !== "opaque"
  );
}

async function networkWithTimeout(request) {
  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    NETWORK_TIMEOUT
  );

  try {
    return await fetch(request, {
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);

  const keys = await cache.keys();

  if (keys.length <= maxEntries) return;

  const excess = keys.length - maxEntries;

  await Promise.all(
    keys.slice(0, excess).map(request => {
      return cache.delete(request);
    })
  );
}

/* =========================================
   ARCHIVOS ESTÁTICOS
   NETWORK FIRST
========================================= */

async function networkFirst(request) {
  const cache = await caches.open(STATIC_CACHE);

  try {
    const response = await networkWithTimeout(request);

    if (isCacheable(response)) {
      await cache.put(request, response.clone());
    }

    return response;

  } catch {
    const cached = await cache.match(request);

    if (cached) return cached;

    throw new Error("Recurso no disponible offline.");
  }
}

/* =========================================
   RECURSOS DINÁMICOS
   STALE WHILE REVALIDATE
========================================= */

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE);

  const cached = await cache.match(request);

  const networkRequest = fetch(request)
    .then(async response => {
      if (isCacheable(response)) {
        await cache.put(request, response.clone());

        await trimCache(
          RUNTIME_CACHE,
          MAX_RUNTIME_ENTRIES
        );
      }

      return response;
    })
    .catch(() => null);

  if (cached) {
    return cached;
  }

  const response = await networkRequest;

  if (response) return response;

  throw new Error("Recurso no disponible.");
}

/* =========================================
   NAVEGACIÓN HTML
========================================= */

async function handleNavigation(request) {
  try {
    const response = await networkWithTimeout(request);

    if (isCacheable(response)) {
      const cache = await caches.open(STATIC_CACHE);

      await cache.put(
        "/index.html",
        response.clone()
      );
    }

    return response;

  } catch {
    const cache = await caches.open(STATIC_CACHE);

    const cached = await cache.match("/index.html");

    if (cached) return cached;

    return new Response(
      "Shunel no está disponible sin conexión.",
      {
        status: 503,
        headers: {
          "Content-Type": "text/plain; charset=utf-8"
        }
      }
    );
  }
}

/* =========================================
   ESTRATEGIA DE PETICIONES
========================================= */

self.addEventListener("fetch", event => {
  const request = event.request;

  if (request.method !== "GET") return;

  const url = new URL(request.url);

  /*
    No interceptar:
    - Peticiones externas.
    - Supabase.
    - APIs.
    - YouTube.
    - Streaming de audio.
  */

  if (!isSameOrigin(url)) return;

  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.includes("/auth/") ||
    url.pathname.includes("/rest/") ||
    url.pathname.includes("/storage/") ||
    url.pathname.includes("/realtime/")
  ) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      handleNavigation(request)
    );

    return;
  }

  const isStaticFile =
    /\.(js|css|json|svg|png|jpg|jpeg|webp|ico|woff2?)$/i
      .test(url.pathname);

  if (isStaticFile) {
    event.respondWith(
      networkFirst(request)
    );

    return;
  }

  event.respondWith(
    staleWhileRevalidate(request)
  );
});

/* =========================================
   MENSAJES DESDE LA APLICACIÓN
========================================= */

self.addEventListener("message", event => {
  const message = event.data;

  if (!message || typeof message !== "object") {
    return;
  }

  if (message.type === "SKIP_WAITING") {
    event.waitUntil(
      self.skipWaiting()
    );
  }

  if (message.type === "GET_VERSION") {
    event.ports?.[0]?.postMessage({
      version: VERSION
    });
  }

  if (message.type === "CLEAR_RUNTIME_CACHE") {
    event.waitUntil(
      caches.delete(RUNTIME_CACHE)
    );
  }
});

/* =========================================
   FINAL
========================================= */

console.info(
  `[Shunel SW] Service Worker ${VERSION} listo.`
);
