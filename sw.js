
/* =========================================
   SHUNEL — SERVICE WORKER
   PWA + OFFLINE + SISTEMA DE DIAGNÓSTICO
   Version: 3.0.0
========================================= */

"use strict";

/* =========================================
   CONFIGURACIÓN
========================================= */

const VERSION = "3.0.0";

const CACHE_PREFIX = "shunel-";
const STATIC_CACHE = `${CACHE_PREFIX}static-${VERSION}`;
const RUNTIME_CACHE = `${CACHE_PREFIX}runtime-${VERSION}`;

const MAX_RUNTIME_ENTRIES = 60;
const NETWORK_TIMEOUT = 10000;
const MAX_LOGS = 300;

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

/* =========================================
   SISTEMA DE DIAGNÓSTICO
========================================= */

const diagnostics = {
  version: VERSION,
  startedAt: new Date().toISOString(),

  status: "starting",

  installation: {
    status: "pending",
    successful: [],
    failed: []
  },

  activation: {
    status: "pending",
    deletedCaches: []
  },

  requests: {
    total: 0,
    successful: 0,
    failed: 0,
    cached: 0,
    network: 0,
    bypassed: 0
  },

  errors: [],

  logs: []
};

function log(level, category, message, details = {}) {
  const entry = {
    time: new Date().toISOString(),
    level,
    category,
    message,
    details
  };

  diagnostics.logs.push(entry);

  if (diagnostics.logs.length > MAX_LOGS) {
    diagnostics.logs.shift();
  }

  const prefix = `[Shunel SW][${category}]`;

  if (level === "ERROR") {
    console.error(prefix, message, details);
  } else if (level === "WARN") {
    console.warn(prefix, message, details);
  } else {
    console.info(prefix, message, details);
  }

  notifyClients({
    type: "SHUNEL_SW_DIAGNOSTIC",
    entry
  });
}

function recordError(category, message, details = {}) {
  const error = {
    time: new Date().toISOString(),
    category,
    message,
    details
  };

  diagnostics.errors.push(error);

  if (diagnostics.errors.length > 100) {
    diagnostics.errors.shift();
  }

  log("ERROR", category, message, details);
}

async function notifyClients(message) {
  try {
    const clients = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true
    });

    clients.forEach(client => {
      client.postMessage(message);
    });
  } catch (error) {
    console.warn(
      "[Shunel SW] No se pudo notificar a la aplicación:",
      error
    );
  }
}

/* =========================================
   UTILIDADES
========================================= */

function isCacheable(response) {
  return Boolean(
    response &&
    response.status === 200 &&
    response.type !== "opaque"
  );
}

function getResourceType(path) {
  if (/\.js$/i.test(path)) return "JavaScript";
  if (/\.css$/i.test(path)) return "CSS";
  if (/\.json$/i.test(path)) return "JSON";
  if (/\.(png|jpg|jpeg|webp|svg|ico)$/i.test(path)) {
    return "Imagen";
  }

  return "Recurso";
}

function getCacheName(url) {
  return /\.(js|css|json|svg|png|jpg|jpeg|webp|ico|woff2?)$/i
    .test(url.pathname)
    ? STATIC_CACHE
    : RUNTIME_CACHE;
}

async function networkWithTimeout(request) {
  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, NETWORK_TIMEOUT);

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

  for (const request of keys.slice(0, excess)) {
    await cache.delete(request);
  }

  log("INFO", "CACHE", "Caché limpiada", {
    cacheName,
    removed: excess
  });
}

/* =========================================
   INSTALACIÓN
========================================= */

self.addEventListener("install", event => {
  event.waitUntil(
    (async () => {
      log("INFO", "INSTALL", "Iniciando instalación", {
        version: VERSION,
        files: APP_FILES.length
      });

      diagnostics.installation.status = "installing";

      const cache = await caches.open(STATIC_CACHE);

      for (const path of APP_FILES) {
        try {
          const response = await networkWithTimeout(
            new Request(path, {
              cache: "reload"
            })
          );

          if (!isCacheable(response)) {
            throw new Error(
              `Respuesta HTTP ${response.status}`
            );
          }

          await cache.put(path, response.clone());

          diagnostics.installation.successful.push(path);

          log("INFO", "INSTALL", "Archivo guardado", {
            path,
            type: getResourceType(path)
          });

        } catch (error) {
          diagnostics.installation.failed.push({
            path,
            error: error.message
          });

          log("ERROR", "INSTALL", "Falló la descarga", {
            path,
            error: error.message
          });
        }
      }

      const totalSuccessful =
        diagnostics.installation.successful.length;

      const totalFailed =
        diagnostics.installation.failed.length;

      diagnostics.installation.status =
        totalFailed === 0 ? "success" : "partial";

      log(
        totalFailed === 0 ? "INFO" : "WARN",
        "INSTALL",
        "Instalación de recursos terminada",
        {
          total: APP_FILES.length,
          successful: totalSuccessful,
          failed: totalFailed,
          missing: diagnostics.installation.failed
        }
      );

      diagnostics.status = "installed";

      await self.skipWaiting();

      log("INFO", "INSTALL", "Service Worker instalado", {
        version: VERSION
      });
    })().catch(error => {
      diagnostics.installation.status = "failed";
      diagnostics.status = "error";

      recordError("INSTALL", "Falló la instalación", {
        error: error.message
      });

      throw error;
    })
  );
});

/* =========================================
   ACTIVACIÓN
========================================= */

self.addEventListener("activate", event => {
  event.waitUntil(
    (async () => {
      log("INFO", "ACTIVATE", "Iniciando activación");

      diagnostics.activation.status = "activating";

      const keys = await caches.keys();

      for (const key of keys) {
        if (
          key.startsWith(CACHE_PREFIX) &&
          key !== STATIC_CACHE &&
          key !== RUNTIME_CACHE
        ) {
          await caches.delete(key);

          diagnostics.activation.deletedCaches.push(key);

          log("INFO", "CACHE", "Caché antigua eliminada", {
            cache: key
          });
        }
      }

      await self.clients.claim();

      diagnostics.activation.status = "success";
      diagnostics.status = "ready";

      log("INFO", "ACTIVATE", "Service Worker activo", {
        version: VERSION,
        deletedCaches:
          diagnostics.activation.deletedCaches
      });

      await notifyClients({
        type: "SHUNEL_SW_READY",
        version: VERSION
      });
    })().catch(error => {
      diagnostics.activation.status = "failed";
      diagnostics.status = "error";

      recordError("ACTIVATE", "Falló la activación", {
        error: error.message
      });

      throw error;
    })
  );
});

/* =========================================
   NETWORK FIRST
   ARCHIVOS ESTÁTICOS
========================================= */

async function networkFirst(request) {
  const cacheName = getCacheName(new URL(request.url));
  const cache = await caches.open(cacheName);

  try {
    const response = await networkWithTimeout(request);

    if (isCacheable(response)) {
      await cache.put(request, response.clone());

      diagnostics.requests.network++;

      log("INFO", "NETWORK", "Recurso actualizado", {
        url: request.url,
        status: response.status
      });

      return response;
    }

    diagnostics.requests.failed++;

    log("WARN", "NETWORK", "Respuesta no válida", {
      url: request.url,
      status: response.status
    });

    const cached = await cache.match(request);

    if (cached) {
      diagnostics.requests.cached++;

      log("WARN", "CACHE", "Usando versión guardada", {
        url: request.url
      });

      return cached;
    }

    return response;

  } catch (error) {
    const cached = await cache.match(request);

    if (cached) {
      diagnostics.requests.cached++;

      log("WARN", "OFFLINE", "Recurso servido desde caché", {
        url: request.url,
        reason: error.message
      });

      return cached;
    }

    diagnostics.requests.failed++;

    recordError("NETWORK", "Recurso no disponible", {
      url: request.url,
      error: error.message
    });

    return new Response(
      "Recurso no disponible.",
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
   STALE WHILE REVALIDATE
   RECURSOS DINÁMICOS
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

        diagnostics.requests.network++;

        log("INFO", "RUNTIME", "Recurso actualizado", {
          url: request.url
        });
      }

      return response;
    })
    .catch(error => {
      log("WARN", "RUNTIME", "Falló la actualización", {
        url: request.url,
        error: error.message
      });

      return null;
    });

  if (cached) {
    diagnostics.requests.cached++;

    log("INFO", "CACHE", "Recurso servido desde caché", {
      url: request.url
    });

    return cached;
  }

  const response = await networkRequest;

  if (response) return response;

  diagnostics.requests.failed++;

  recordError("RUNTIME", "Recurso no disponible", {
    url: request.url
  });

  return new Response(
    "Recurso no disponible.",
    {
      status: 503
    }
  );
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

      diagnostics.requests.network++;

      log("INFO", "NAVIGATION", "Página cargada desde internet", {
        url: request.url,
        status: response.status
      });
    }

    if (response.ok) return response;

    throw new Error(`HTTP ${response.status}`);

  } catch (error) {
    const cache = await caches.open(STATIC_CACHE);
    const cached = await cache.match("/index.html");

    if (cached) {
      diagnostics.requests.cached++;

      log("WARN", "NAVIGATION", "Página cargada sin conexión", {
        url: request.url,
        reason: error.message
      });

      return cached;
    }

    diagnostics.requests.failed++;

    recordError("NAVIGATION", "No se pudo cargar Shunel", {
      url: request.url,
      error: error.message
    });

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
   INTERCEPTOR DE PETICIONES
========================================= */

self.addEventListener("fetch", event => {
  const request = event.request;

  if (request.method !== "GET") return;

  const url = new URL(request.url);

  if (url.origin !== self.location.origin) return;

  diagnostics.requests.total++;

  /*
    Estas peticiones no son gestionadas
    por la caché del Service Worker.
  */

  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.includes("/auth/") ||
    url.pathname.includes("/rest/") ||
    url.pathname.includes("/storage/") ||
    url.pathname.includes("/realtime/")
  ) {
    diagnostics.requests.bypassed++;

    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      handleNavigation(request).then(response => {
        if (response.ok) {
          diagnostics.requests.successful++;
        }

        return response;
      })
    );

    return;
  }

  const isStaticFile =
    /\.(js|css|json|svg|png|jpg|jpeg|webp|ico|woff2?)$/i
      .test(url.pathname);

  const strategy = isStaticFile
    ? networkFirst
    : staleWhileRevalidate;

  event.respondWith(
    strategy(request)
      .then(response => {
        if (response.ok) {
          diagnostics.requests.successful++;
        } else {
          diagnostics.requests.failed++;
        }

        return response;
      })
      .catch(error => {
        diagnostics.requests.failed++;

        recordError("FETCH", "Error procesando petición", {
          url: request.url,
          error: error.message
        });

        return new Response(
          "Error al cargar el recurso.",
          { status: 503 }
        );
      })
  );
});

/* =========================================
   INFORMACIÓN DE CACHÉ
========================================= */

async function getCacheDetails() {
  const keys = await caches.keys();

  const result = [];

  for (const key of keys) {
    if (!key.startsWith(CACHE_PREFIX)) continue;

    const cache = await caches.open(key);
    const requests = await cache.keys();

    result.push({
      name: key,
      entries: requests.length,
      resources: requests.map(request => request.url)
    });
  }

  return result;
}

/* =========================================
   INFORME COMPLETO
========================================= */

async function getDiagnostics() {
  const cacheDetails = await getCacheDetails();

  const installationSuccess =
    diagnostics.installation.successful.length;

  const installationFailed =
    diagnostics.installation.failed.length;

  return {
    application: "Shunel",
    serviceWorkerVersion: VERSION,
    status: diagnostics.status,

    generatedAt: new Date().toISOString(),
    startedAt: diagnostics.startedAt,

    installation: {
      ...diagnostics.installation,
      total: APP_FILES.length,
      successfulCount: installationSuccess,
      failedCount: installationFailed
    },

    activation: diagnostics.activation,

    requests: diagnostics.requests,

    caches: cacheDetails,

    errors: diagnostics.errors,

    logs: diagnostics.logs,

    limitations: [
      "No comprueba si el reproductor reproduce audio.",
      "No comprueba la autenticación de Supabase.",
      "No comprueba las respuestas internas de la IA.",
      "Las peticiones /api/ no son interceptadas.",
      "No puede confirmar que un módulo JavaScript funcione internamente."
    ]
  };
}

/* =========================================
   ERRORES DEL SERVICE WORKER
========================================= */

self.addEventListener("error", event => {
  recordError("UNCAUGHT", event.message || "Error desconocido", {
    filename: event.filename || null,
    line: event.lineno || null,
    column: event.colno || null
  });
});

self.addEventListener("unhandledrejection", event => {
  recordError(
    "UNHANDLED_REJECTION",
    "Promesa rechazada sin controlar",
    {
      reason: String(event.reason || "Desconocido")
    }
  );
});

/* =========================================
   COMUNICACIÓN CON SHUNEL
========================================= */

self.addEventListener("message", event => {
  const message = event.data;

  if (!message || typeof message !== "object") return;

  if (message.type === "GET_VERSION") {
    event.ports?.[0]?.postMessage({
      version: VERSION,
      status: diagnostics.status
    });

    return;
  }

  if (message.type === "GET_DIAGNOSTICS") {
    event.waitUntil(
      getDiagnostics()
        .then(report => {
          event.ports?.[0]?.postMessage({
            success: true,
            report
          });
        })
        .catch(error => {
          recordError("DIAGNOSTICS", "No se pudo generar el informe", {
            error: error.message
          });

          event.ports?.[0]?.postMessage({
            success: false,
            error: error.message
          });
        })
    );

    return;
  }

  if (message.type === "CLEAR_RUNTIME_CACHE") {
    event.waitUntil(
      caches.delete(RUNTIME_CACHE).then(success => {
        log("INFO", "CACHE", "Solicitud de limpieza ejecutada", {
          success
        });
      })
    );

    return;
  }

  if (message.type === "SKIP_WAITING") {
    event.waitUntil(
      self.skipWaiting().then(() => {
        log("INFO", "UPDATE", "Actualización solicitada");
      })
    );

    return;
  }

  if (message.type === "APP_DIAGNOSTIC") {
    log(
      message.level === "ERROR" ? "ERROR" : "INFO",
      "APP",
      message.message || "Mensaje de aplicación",
      message.details || {}
    );
  }
});

/* =========================================
   INICIO
========================================= */

log("INFO", "SYSTEM", "Service Worker cargado", {
  version: VERSION,
  files: APP_FILES.length
});

console.info(
  `[Shunel SW] Diagnóstico activo. Versión ${VERSION}`
);
