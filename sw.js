
/* ==========================================
   SHUNEL — SERVICE WORKER
   PWA, caché y funcionamiento offline
========================================== */

const CACHE_NAME = "shunel-cache-v1";

const APP_FILES = [
  "/",
  "/index.html",
  "/manifest.json",
  "/css/style.css",
  "/css/player.css",
  "/js/app.js",
  "/js/player.js",
  "/js/crossfade.js",
  "/js/lyrics.js",
  "/js/canvas.js",
  "/js/smart-radio.js",
  "/js/shunel-ai.js",
  "/js/profiles.js",
  "/js/social.js",
  "/js/statistics.js"
];

// Instalación
self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async cache => {
      await Promise.all(
        APP_FILES.map(async file => {
          try {
            await cache.add(file);
          } catch (error) {
            console.warn(
              "[Shunel SW] No se pudo guardar:",
              file
            );
          }
        })
      );
    })
  );

  self.skipWaiting();
});

// Activación y limpieza de cachés antiguas
self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key.startsWith("shunel-cache-"))
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    )
  );

  self.clients.claim();
});

// Solicitudes de red
self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);

  // Solo solicitudes GET del mismo origen
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin
  ) {
    return;
  }

  // No almacenar respuestas de API ni autenticación
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.includes("auth")
  ) {
    event.respondWith(fetch(request));
    return;
  }

  // HTML: intentar red y usar caché si no hay conexión
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok) {
            const copy = response.clone();

            caches.open(CACHE_NAME).then(cache => {
              cache.put("/index.html", copy);
            });
          }

          return response;
        })
        .catch(async () => {
          return (
            await caches.match(request) ||
            await caches.match("/index.html") ||
            new Response(
              "Shunel no está disponible sin conexión.",
              {
                status: 503,
                headers: {
                  "Content-Type": "text/plain; charset=utf-8"
                }
              }
            )
          );
        })
    );

    return;
  }

  // Recursos estáticos: caché primero, red después
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;

      return fetch(request).then(response => {
        if (
          response.ok &&
          response.type === "basic"
        ) {
          const copy = response.clone();

          caches.open(CACHE_NAME).then(cache => {
            cache.put(request, copy);
          });
        }

        return response;
      });
    })
  );
});

console.log("[Shunel] Service Worker cargado.");
