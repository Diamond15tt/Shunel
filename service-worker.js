
"use strict";

const CACHE_NAME = "meulify-local-v1";

const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json"
];

// Instalar y guardar los archivos principales.
self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

// Activar y limpiar versiones antiguas.
self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// Estrategia para recursos de la aplicación.
self.addEventListener("fetch", event => {
  const request = event.request;

  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // No interceptar servicios externos ni el reproductor de YouTube.
  if (url.origin !== self.location.origin) return;

  // Navegación: intentar red y usar la copia local si no hay conexión.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME)
              .then(cache => cache.put("./index.html", copy));
          }
          return response;
        })
        .catch(async () => {
          return await caches.match("./index.html")
            || new Response("Aplicación no disponible sin conexión.", {
              status: 503,
              headers: { "Content-Type": "text/plain; charset=utf-8" }
            });
        })
    );
    return;
  }

  // Archivos estáticos: caché primero, red después.
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;

      return fetch(request).then(response => {
        if (response.ok && response.type === "basic") {
          const copy = response.clone();
          caches.open(CACHE_NAME)
            .then(cache => cache.put(request, copy));
        }
        return response;
      });
    })
  );
});
