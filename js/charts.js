/* ==========================================================================
   SHUNEL — COSTA RICA TOP 50
   Cliente del ranking diario de Spotify Costa Rica.

   - Obtención del ranking desde Vercel con timeout por intento y reintentos
     (backoff exponencial con jitter, respeta Retry-After).
   - Validación y normalización estricta de respuestas y canciones.
   - Renderizado seguro mediante textContent (sin innerHTML).
   - Lista semántica (ol/li) con navegación por teclado y etiquetas ARIA.
   - Copia local (stale-while-revalidate) para pintar al instante.
   - Actualización manual y automática sin solapamientos.
   - Pausa la actualización con la pestaña oculta y reanuda al volver.
   - Reanuda al recuperar la conexión.
   - Una sola instancia por contenedor; destroy() limpia todo.
   - Compatibilidad con la API anterior.
   ========================================================================== */

const CHART_ENDPOINT = "/api/charts/cr";
const CHART_REFRESH_MS = 60 * 60 * 1000;
const CHART_ERROR_RETRY_MS = 2 * 60 * 1000;
const CHART_TIMEOUT_MS = 10000;
const CHART_MAX_ATTEMPTS = 3;
const CHART_RETRY_BASE_MS = 800;
const CHART_RETRY_MAX_MS = 8000;
const CHART_LIMIT = 50;

const CACHE_KEY = "shunel:chart:cr:v1";
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const PLAY_NOTICE_MS = 5000;
const SKELETON_ROWS = 8;

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

const STYLE_ID = "shunel-chart-styles";

const SOURCE_URL =
  "https://kworb.net/spotify/country/cr_daily.html";

const streamsFormatter = new Intl.NumberFormat("es-CR");

const dateFormatter = new Intl.DateTimeFormat("es-CR", {
  day: "numeric",
  month: "short",
  year: "numeric"
});

const timeFormatter = new Intl.DateTimeFormat("es-CR", {
  hour: "2-digit",
  minute: "2-digit"
});

/* Una instancia activa por contenedor. */
const instances = new WeakMap();

/* ==========================================================================
   HELPERS
========================================================================== */

function safeText(value) {
  return String(value ?? "");
}

function normalizeNumber(value, fallback = 0) {
  if (
    value === null ||
    value === undefined ||
    value === "" ||
    typeof value === "boolean"
  ) {
    return fallback;
  }

  const number = Number(
    typeof value === "string"
      ? value.replace(/[\s,]/g, "")
      : value
  );

  return Number.isFinite(number)
    ? number
    : fallback;
}

function formatStreams(value) {
  const number = normalizeNumber(value, NaN);

  if (!Number.isFinite(number) || number <= 0) {
    return "Reproducciones no disponibles";
  }

  return `${streamsFormatter.format(number)} reproducciones`;
}

function formatChartDate(value) {
  const text = safeText(value).trim();

  if (!text) return "";

  const match = /^(\d{4})[-/.](\d{2})[-/.](\d{2})/.exec(text);

  const date = match
    ? new Date(
        Number(match[1]),
        Number(match[2]) - 1,
        Number(match[3])
      )
    : new Date(text);

  if (Number.isNaN(date.getTime())) {
    return text;
  }

  return dateFormatter.format(date);
}

function formatTime(timestamp) {
  const date = new Date(timestamp);

  return Number.isNaN(date.getTime())
    ? ""
    : timeFormatter.format(date);
}

function resolveMovement(track, rank) {
  const explicit = safeText(track?.movementType)
    .trim()
    .toLowerCase();

  if (explicit === "new") {
    return { type: "new", movement: 0 };
  }

  if (explicit === "reentry") {
    return { type: "reentry", movement: 0 };
  }

  const previous = normalizeNumber(
    track?.previousPosition,
    NaN
  );

  let movement = normalizeNumber(track?.movement, NaN);

  if (
    !Number.isFinite(movement) &&
    Number.isFinite(previous) &&
    previous > 0
  ) {
    movement = previous - rank;
  }

  if (!Number.isFinite(movement)) {
    movement = 0;
  }

  if (explicit === "up") {
    return { type: "up", movement: Math.abs(movement) };
  }

  if (explicit === "down") {
    return { type: "down", movement: -Math.abs(movement) };
  }

  if (movement > 0) return { type: "up", movement };
  if (movement < 0) return { type: "down", movement };

  return { type: "stable", movement: 0 };
}

function movementLabel(track) {
  const amount = Math.abs(track.movement);

  switch (track.movementType) {
    case "new":
      return "NUEVA";

    case "reentry":
      return "REGRESA";

    case "up":
      return amount > 0 ? `↑ ${amount}` : "↑";

    case "down":
      return amount > 0 ? `↓ ${amount}` : "↓";

    default:
      return "—";
  }
}

function movementText(track) {
  const amount = Math.abs(track.movement);
  const places = amount === 1 ? "puesto" : "puestos";

  switch (track.movementType) {
    case "new":
      return "Nueva entrada";

    case "reentry":
      return "Regresa al ranking";

    case "up":
      return amount > 0
        ? `Sube ${amount} ${places}`
        : "Sube";

    case "down":
      return amount > 0
        ? `Baja ${amount} ${places}`
        : "Baja";

    default:
      return "Sin cambios";
  }
}

function movementClass(track) {
  switch (track.movementType) {
    case "new":
    case "reentry":
      return "is-new";

    case "up":
      return "is-up";

    case "down":
      return "is-down";

    default:
      return "is-stable";
  }
}

function normalizeTrack(track, index) {
  if (!track || typeof track !== "object") {
    return null;
  }

  const artist = safeText(track.artist).trim();
  const title = safeText(track.title).trim();

  if (!artist || !title) {
    return null;
  }

  const rank = Math.max(
    1,
    Math.floor(normalizeNumber(track.rank, index + 1))
  );

  const { type, movement } = resolveMovement(track, rank);

  const streams = normalizeNumber(track.streams, NaN);

  return {
    rank,
    artist,
    title,

    streams:
      Number.isFinite(streams) && streams > 0
        ? streams
        : null,

    movement,
    movementType: type,

    previousPosition: normalizeNumber(
      track.previousPosition,
      0
    )
  };
}

function normalizePayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error(
      "El servidor devolvió una respuesta inválida."
    );
  }

  if (payload.ok === false) {
    throw new Error(
      safeText(payload.error) ||
      "El servidor no pudo obtener el ranking."
    );
  }

  if (!Array.isArray(payload.tracks)) {
    throw new Error(
      "La respuesta no contiene una lista de canciones válida."
    );
  }

  const seen = new Set();

  let tracks = payload.tracks
    .map(normalizeTrack)
    .filter(Boolean)
    .sort((a, b) => a.rank - b.rank)
    .filter(track => {
      const key =
        `${track.artist}\u0000${track.title}`.toLowerCase();

      if (seen.has(key)) return false;

      seen.add(key);
      return true;
    })
    .slice(0, CHART_LIMIT);

  if (!tracks.length) {
    throw new Error(
      "El ranking llegó vacío o no contiene canciones válidas."
    );
  }

  /* Si hay posiciones repetidas, se renumera según el orden recibido. */

  if (new Set(tracks.map(t => t.rank)).size !== tracks.length) {
    tracks = tracks.map((track, index) => ({
      ...track,
      rank: index + 1
    }));
  }

  return {
    ...payload,
    tracks
  };
}

function signatureOf(tracks) {
  return tracks
    .map(t =>
      [
        t.rank,
        t.artist,
        t.title,
        t.streams,
        t.movementType,
        t.movement
      ].join("|")
    )
    .join("\n");
}

/* ==========================================================================
   LOCAL CACHE (stale-while-revalidate)
========================================================================== */

function readCache() {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);

    if (!raw) return null;

    const entry = JSON.parse(raw);

    if (
      !entry ||
      typeof entry.savedAt !== "number" ||
      Date.now() - entry.savedAt > CACHE_MAX_AGE_MS
    ) {
      return null;
    }

    return {
      payload: normalizePayload(entry.payload),
      savedAt: entry.savedAt
    };

  } catch {
    return null;
  }
}

function writeCache(payload) {
  try {
    window.localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        savedAt: Date.now(),
        payload: {
          date: payload.date,
          tracks: payload.tracks
        }
      })
    );
  } catch {
    /* Almacenamiento no disponible o lleno: se ignora. */
  }
}

/* ==========================================================================
   STYLES
========================================================================== */

function injectStyles() {
  if (document.getElementById(STYLE_ID)) {
    return;
  }

  const style = document.createElement("style");

  style.id = STYLE_ID;

  style.textContent = `
    .shunel-chart {
      margin: 34px 0;
      min-width: 0;
      width: 100%;
    }

    .shunel-chart__heading {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 16px;
    }

    .shunel-chart__heading h2 {
      margin: 3px 0 0;
    }

    .shunel-chart__actions {
      display: grid;
      justify-items: end;
      gap: 6px;
    }

    .shunel-chart__meta {
      color: var(--muted, #9299a6);
      font-size: 12px;
      text-align: right;
    }

    .shunel-chart__refresh {
      border: 1px solid var(--border, rgba(255,255,255,.12));
      color: inherit;
      background: transparent;
      border-radius: 999px;
      padding: 8px 12px;
      min-height: 36px;
      font: inherit;
      font-size: 12px;
      cursor: pointer;
      transition: opacity .2s ease, background .2s ease;
    }

    .shunel-chart__refresh:hover:not(:disabled) {
      background: rgba(255,255,255,.07);
      background: color-mix(in srgb, currentColor 8%, transparent);
    }

    .shunel-chart__refresh:disabled {
      opacity: .5;
      cursor: wait;
    }

    .shunel-chart__refresh:focus-visible,
    button.shunel-chart__row:focus-visible {
      outline: 2px solid var(--accent, #6699e8);
      outline-offset: 3px;
    }

    .shunel-chart__list {
      display: grid;
      gap: 2px;
      min-width: 0;
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .shunel-chart__list:empty {
      display: none;
    }

    .shunel-chart__item {
      display: block;
      margin: 0;
      padding: 0;
      min-width: 0;
      content-visibility: auto;
      contain-intrinsic-size: auto 66px;
    }

    .shunel-chart__row {
      display: grid;
      grid-template-columns: 30px 4px minmax(0,1fr) auto;
      align-items: center;
      gap: 11px;
      min-height: 66px;
      padding: 8px 10px;
      border: 0;
      border-bottom: 1px solid var(--border, rgba(255,255,255,.07));
      color: inherit;
      text-align: left;
      background: transparent;
      border-radius: 8px;
      width: 100%;
      box-sizing: border-box;
      font: inherit;
      -webkit-tap-highlight-color: transparent;
    }

    button.shunel-chart__row {
      cursor: pointer;
      transition: background .18s ease, opacity .18s ease;
    }

    .shunel-chart.is-readonly .shunel-chart__row {
      cursor: default;
    }

    @media (hover: hover) {
      button.shunel-chart__row:hover:not([aria-disabled="true"]) {
        background: rgba(255,255,255,.045);
        background: color-mix(in srgb, currentColor 6%, transparent);
      }
    }

    .shunel-chart__row.is-busy,
    .shunel-chart__row[aria-disabled="true"] {
      opacity: .55;
      cursor: wait;
    }

    .shunel-chart__rank {
      color: var(--muted, #9299a6);
      font-size: 13px;
      font-variant-numeric: tabular-nums;
      text-align: center;
    }

    .shunel-chart__cover {
      width: 4px;
      height: 34px;
      border-radius: 3px;
      background: rgba(255,255,255,.13);
    }

    .shunel-chart__cover.is-up {
      background: #66c995;
    }

    .shunel-chart__cover.is-down {
      background: #e28b8b;
    }

    .shunel-chart__cover.is-new {
      background: #8db8ff;
    }

    .shunel-chart__song {
      min-width: 0;
      display: grid;
      gap: 4px;
    }

    .shunel-chart__title {
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      font-size: 14px;
      font-weight: 650;
    }

    .shunel-chart__artist {
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      color: var(--muted, #9299a6);
      font-size: 12px;
    }

    .shunel-chart__stats {
      display: grid;
      justify-items: end;
      gap: 5px;
      white-space: nowrap;
      font-size: 11px;
      color: var(--muted, #9299a6);
    }

    .shunel-chart__movement {
      font-weight: 700;
      font-variant-numeric: tabular-nums;
    }

    .shunel-chart__movement.is-up {
      color: #66c995;
    }

    .shunel-chart__movement.is-down {
      color: #e28b8b;
    }

    .shunel-chart__movement.is-new {
      color: #8db8ff;
    }

    .shunel-chart__movement.is-stable {
      color: var(--muted, #9299a6);
    }

    .shunel-chart__state {
      padding: 18px 0;
      color: var(--muted, #9299a6);
      font-size: 13px;
      line-height: 1.45;
    }

    .shunel-chart__state[data-error="true"] {
      color: var(--danger, #e28b8b);
    }

    .shunel-chart__source {
      margin-top: 12px;
      color: var(--muted, #9299a6);
      font-size: 11px;
    }

    .shunel-chart__source a {
      color: inherit;
      text-underline-offset: 3px;
    }

    .shunel-chart__source a:hover {
      color: var(--text, #e8edf7);
    }

    .shunel-chart__skeleton-bar {
      display: block;
      height: 10px;
      border-radius: 5px;
      background: rgba(255,255,255,.1);
      background: color-mix(in srgb, currentColor 12%, transparent);
      animation: shunel-chart-pulse 1.4s ease-in-out infinite;
    }

    .shunel-chart__skeleton-bar.is-short {
      width: 60%;
    }

    .shunel-chart__skeleton-bar.is-tiny {
      width: 70px;
    }

    @keyframes shunel-chart-pulse {
      0%, 100% { opacity: .45; }
      50% { opacity: 1; }
    }

    @media (max-width: 480px) {
      .shunel-chart__row {
        grid-template-columns: 25px 3px minmax(0,1fr) auto;
        gap: 8px;
        padding-inline: 4px;
      }

      .shunel-chart__stats {
        font-size: 10px;
      }

      .shunel-chart__heading {
        align-items: center;
      }

      .shunel-chart__meta {
        max-width: 150px;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      button.shunel-chart__row,
      .shunel-chart__refresh {
        transition: none;
      }

      .shunel-chart__skeleton-bar {
        animation: none;
      }
    }
  `;

  document.head.appendChild(style);
}

/* ==========================================================================
   DOM HELPERS
========================================================================== */

function createElement(tag, className, text) {
  const element = document.createElement(tag);

  if (className) {
    element.className = className;
  }

  if (text !== undefined) {
    element.textContent = safeText(text);
  }

  return element;
}

function resolveContainer(container) {
  if (
    typeof Element !== "undefined" &&
    container instanceof Element
  ) {
    return container;
  }

  if (typeof container === "string") {
    try {
      const selected = document.querySelector(container);

      if (selected) return selected;
    } catch (error) {
      console.warn(
        "[Shunel Charts] Selector inválido:",
        container
      );
    }
  }

  const existing = document.getElementById(
    "spotifyCostaRicaTop50"
  );

  if (existing) return existing;

  const section = createElement(
    "section",
    "shunel-chart"
  );

  section.id = "spotifyCostaRicaTop50";

  const discover = document.querySelector(".home-discover");

  if (discover?.parentNode) {
    discover.insertAdjacentElement("afterend", section);
    return section;
  }

  const fallback =
    document.querySelector("main") || document.body;

  if (!fallback) {
    throw new Error(
      "No se encontró #spotifyCostaRicaTop50, .home-discover, main ni body. Revisa el HTML."
    );
  }

  fallback.appendChild(section);

  return section;
}

/* ==========================================================================
   LAYOUT
========================================================================== */

function buildLayout(root) {
  root.classList.add("shunel-chart");

  const heading = createElement(
    "div",
    "shunel-chart__heading"
  );

  const titleGroup = document.createElement("div");

  titleGroup.append(
    createElement(
      "p",
      "eyebrow",
      "RANKING DE COSTA RICA"
    ),
    createElement(
      "h2",
      "",
      "Top 50 de Spotify"
    )
  );

  const actions = createElement(
    "div",
    "shunel-chart__actions"
  );

  const refreshButton = createElement(
    "button",
    "shunel-chart__refresh",
    "Actualizar"
  );

  refreshButton.type = "button";

  const meta = createElement(
    "span",
    "shunel-chart__meta",
    ""
  );

  meta.setAttribute("aria-live", "polite");

  actions.append(
    refreshButton,
    meta
  );

  heading.append(
    titleGroup,
    actions
  );

  const state = createElement(
    "p",
    "shunel-chart__state",
    "Cargando ranking..."
  );

  state.setAttribute("role", "status");
  state.setAttribute("aria-live", "polite");

  const list = createElement(
    "ol",
    "shunel-chart__list"
  );

  list.setAttribute(
    "aria-label",
    "Las 50 canciones más escuchadas en Costa Rica"
  );

  const source = createElement(
    "p",
    "shunel-chart__source"
  );

  const sourceLink = document.createElement("a");

  sourceLink.href = SOURCE_URL;
  sourceLink.target = "_blank";
  sourceLink.rel = "noopener noreferrer";

  sourceLink.textContent =
    "Fuente: Kworb · Spotify Daily Chart";

  source.appendChild(sourceLink);

  root.replaceChildren(
    heading,
    state,
    list,
    source
  );

  return {
    refreshButton,
    meta,
    state,
    list
  };
}

/* ==========================================================================
   RENDER
========================================================================== */

function renderSkeleton(list) {
  const fragment = document.createDocumentFragment();

  for (let i = 0; i < SKELETON_ROWS; i++) {
    const item = createElement("li", "shunel-chart__item");

    item.setAttribute("aria-hidden", "true");

    const row = createElement("div", "shunel-chart__row");

    const song = createElement("span", "shunel-chart__song");

    song.append(
      createElement("span", "shunel-chart__skeleton-bar"),
      createElement("span", "shunel-chart__skeleton-bar is-short")
    );

    const stats = createElement("span", "shunel-chart__stats");

    stats.append(
      createElement("span", "shunel-chart__skeleton-bar is-tiny")
    );

    row.append(
      createElement("span", "shunel-chart__rank"),
      createElement("span", "shunel-chart__cover"),
      song,
      stats
    );

    item.appendChild(row);
    fragment.appendChild(item);
  }

  list.replaceChildren(fragment);
  list.setAttribute("aria-busy", "true");
}

function renderTracks(list, tracks, playable) {
  const fragment = document.createDocumentFragment();

  tracks.forEach((track, index) => {
    const item = createElement("li", "shunel-chart__item");

    const row = createElement(
      playable ? "button" : "div",
      "shunel-chart__row"
    );

    row.dataset.index = String(index);
    row.dataset.rank = String(track.rank);

    if (playable) {
      row.type = "button";

      row.title =
        `Reproducir ${track.title} de ${track.artist}`;

      row.setAttribute(
        "aria-label",
        `Puesto ${track.rank}: ${track.title}, ${track.artist}. ${formatStreams(track.streams)}. ${movementText(track)}. Reproducir.`
      );
    }

    const rank = createElement(
      "span",
      "shunel-chart__rank",
      track.rank
    );

    const marker = createElement(
      "span",
      `shunel-chart__cover ${movementClass(track)}`
    );

    marker.setAttribute("aria-hidden", "true");

    const song = createElement(
      "span",
      "shunel-chart__song"
    );

    song.append(
      createElement(
        "span",
        "shunel-chart__title",
        track.title
      ),
      createElement(
        "span",
        "shunel-chart__artist",
        track.artist
      )
    );

    const stats = createElement(
      "span",
      "shunel-chart__stats"
    );

    const movement = createElement(
      "span",
      `shunel-chart__movement ${movementClass(track)}`,
      movementLabel(track)
    );

    movement.title = movementText(track);

    stats.append(
      movement,
      createElement(
        "span",
        "",
        formatStreams(track.streams)
      )
    );

    row.append(
      rank,
      marker,
      song,
      stats
    );

    item.appendChild(row);
    fragment.appendChild(item);
  });

  list.replaceChildren(fragment);
  list.removeAttribute("aria-busy");
}

/* ==========================================================================
   FETCH
========================================================================== */

class ChartError extends Error {
  constructor(message, options = {}) {
    super(message);

    this.name = "ChartError";
    this.status = options.status || 0;
    this.retryable = Boolean(options.retryable);
    this.retryAfterMs = options.retryAfterMs || 0;
    this.code = options.code || "";
  }
}

function makeAbortError() {
  const error = new Error("Petición cancelada.");

  error.name = "AbortError";

  return error;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(makeAbortError());
      return;
    }

    const onAbort = () => {
      clearTimeout(timer);
      reject(makeAbortError());
    };

    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function parseRetryAfter(header) {
  if (!header) return 0;

  const seconds = Number(header);

  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const date = Date.parse(header);

  return Number.isFinite(date)
    ? Math.max(0, date - Date.now())
    : 0;
}

async function fetchOnce(outerSignal) {
  if (outerSignal.aborted) {
    throw makeAbortError();
  }

  const controller = new AbortController();

  let timedOut = false;

  const onOuterAbort = () => controller.abort();

  outerSignal.addEventListener("abort", onOuterAbort, {
    once: true
  });

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, CHART_TIMEOUT_MS);

  const timeoutError = () =>
    new ChartError(
      "El servidor tardó demasiado en responder.",
      { retryable: true, code: "timeout" }
    );

  try {
    let response;

    try {
      response = await fetch(CHART_ENDPOINT, {
        method: "GET",

        headers: {
          Accept: "application/json"
        },

        cache: "no-store",
        credentials: "same-origin",
        signal: controller.signal
      });

    } catch (error) {
      if (outerSignal.aborted) throw makeAbortError();
      if (timedOut) throw timeoutError();

      throw new ChartError(
        "No se pudo conectar con el servidor del ranking.",
        { retryable: true, code: "network" }
      );
    }

    if (!response.ok) {
      let message =
        `Error del servidor (${response.status}).`;

      try {
        const body = await response.json();

        if (body?.error) {
          message = safeText(body.error);
        }
      } catch {}

      throw new ChartError(message, {
        status: response.status,
        retryable: RETRYABLE_STATUS.has(response.status),
        retryAfterMs: parseRetryAfter(
          response.headers.get("Retry-After")
        ),
        code: "http"
      });
    }

    let payload;

    try {
      payload = await response.json();

    } catch (error) {
      if (outerSignal.aborted) throw makeAbortError();
      if (timedOut) throw timeoutError();

      throw new ChartError(
        "El servidor devolvió una respuesta que no es JSON válido.",
        { code: "json" }
      );
    }

    return normalizePayload(payload);

  } finally {
    clearTimeout(timer);
    outerSignal.removeEventListener("abort", onOuterAbort);
  }
}

async function fetchChart(signal) {
  let lastError;

  for (let attempt = 0; attempt < CHART_MAX_ATTEMPTS; attempt++) {
    try {
      return await fetchOnce(signal);

    } catch (error) {
      if (error?.name === "AbortError") {
        throw error;
      }

      lastError = error;

      const offline =
        typeof navigator !== "undefined" &&
        navigator.onLine === false;

      if (
        !error?.retryable ||
        offline ||
        attempt === CHART_MAX_ATTEMPTS - 1
      ) {
        throw error;
      }

      const backoff = Math.min(
        CHART_RETRY_MAX_MS,
        CHART_RETRY_BASE_MS * 2 ** attempt
      );

      const delay = Math.min(
        CHART_RETRY_MAX_MS,
        Math.max(
          error.retryAfterMs || 0,
          backoff + Math.random() * backoff * 0.3
        )
      );

      await sleep(delay, signal);
    }
  }

  throw lastError;
}

/* ==========================================================================
   MAIN INITIALIZER
========================================================================== */

/**
 * Monta el Top 50 y devuelve controles para actualizarlo o desmontarlo.
 *
 * @param {Object} options
 * @param {Function} [options.searchTracks]  Compatibilidad con la API anterior.
 * @param {Function} [options.onPlay]        Recibe la canción pulsada.
 * @param {Element|string} [options.container]
 */

export function initCostaRicaTop50({
  searchTracks,
  onPlay,
  container
} = {}) {

  injectStyles();

  /*
   * searchTracks se mantiene por compatibilidad con la integración
   * anterior. La búsqueda y reproducción se delegan a onPlay,
   * que recibe los datos de cada canción.
   */

  if (
    searchTracks !== undefined &&
    typeof searchTracks !== "function"
  ) {
    throw new TypeError(
      "searchTracks debe ser una función."
    );
  }

  if (
    onPlay !== undefined &&
    typeof onPlay !== "function"
  ) {
    throw new TypeError(
      "onPlay debe ser una función."
    );
  }

  const root = resolveContainer(container);

  if (!root) {
    throw new Error(
      "No se pudo crear el contenedor del Top 50."
    );
  }

  /* Evita instancias duplicadas sobre el mismo contenedor. */

  instances.get(root)?.destroy();

  const chartUI = buildLayout(root);

  const playable = typeof onPlay === "function";

  root.classList.toggle("is-readonly", !playable);

  let lastPayload = null;
  let currentTracks = [];
  let lastSignature = null;
  let lastSuccessAt = 0;
  let fromLocalCache = false;

  let destroyed = false;
  let playing = false;
  let dueWhileHidden = false;

  let activeRequest = null;
  let refreshTimer = null;
  let noticeTimer = null;

  let requestSequence = 0;

  let chartStatus = {
    message: "Cargando ranking...",
    visible: true,
    isError: false
  };

  /* =========================================
     STATUS
  ========================================= */

  function applyStatus(status) {
    chartUI.state.textContent = safeText(status.message);
    chartUI.state.hidden = !status.visible;

    chartUI.state.setAttribute(
      "role",
      status.isError ? "alert" : "status"
    );

    chartUI.state.setAttribute(
      "aria-live",
      status.isError ? "assertive" : "polite"
    );

    chartUI.state.dataset.error =
      status.isError ? "true" : "false";
  }

  function setStatus(message, visible = true, isError = false) {
    chartStatus = {
      message: safeText(message),
      visible,
      isError
    };

    /* Si hay un aviso temporal visible, se restaura al terminar. */

    if (noticeTimer) return;

    applyStatus(chartStatus);
  }

  function showNotice(message) {
    clearTimeout(noticeTimer);

    applyStatus({
      message,
      visible: true,
      isError: true
    });

    noticeTimer = setTimeout(() => {
      noticeTimer = null;

      if (!destroyed) {
        applyStatus(chartStatus);
      }
    }, PLAY_NOTICE_MS);
  }

  function setLoading(loading) {
    chartUI.refreshButton.disabled = loading;

    chartUI.refreshButton.textContent = loading
      ? "Actualizando…"
      : "Actualizar";

    if (loading) {
      root.setAttribute("aria-busy", "true");
    } else {
      root.removeAttribute("aria-busy");
    }
  }

  function updateMeta() {
    if (!lastPayload) return;

    const parts = [];

    const date = formatChartDate(lastPayload.date);

    parts.push(
      date ? `Datos del ${date}` : "Ranking diario"
    );

    parts.push(`${lastPayload.tracks.length} canciones`);

    if (lastPayload.cached) {
      parts.push("Datos guardados");
    }

    if (fromLocalCache) {
      parts.push("Copia local");
    }

    chartUI.meta.textContent = parts.join(" · ");

    chartUI.meta.title = lastSuccessAt
      ? `Última actualización: ${formatTime(lastSuccessAt)}`
      : "";
  }

  /* =========================================
     RENDERING
  ========================================= */

  function renderList() {
    const active = document.activeElement;

    const focusedRank =
      active && chartUI.list.contains(active)
        ? Number(active.dataset?.rank)
        : NaN;

    renderTracks(chartUI.list, currentTracks, playable);

    if (Number.isFinite(focusedRank)) {
      chartUI.list
        .querySelector(
          `.shunel-chart__row[data-rank="${focusedRank}"]`
        )
        ?.focus?.({ preventScroll: true });
    }
  }

  function applyPayload(payload) {
    const signature = signatureOf(payload.tracks);

    lastPayload = payload;
    currentTracks = payload.tracks;

    if (signature !== lastSignature) {
      renderList();
      lastSignature = signature;
    }

    updateMeta();
  }

  /* =========================================
     SCHEDULING
  ========================================= */

  function scheduleNext(delay) {
    clearTimeout(refreshTimer);

    refreshTimer = null;

    if (destroyed) return;

    refreshTimer = setTimeout(() => {
      refreshTimer = null;

      if (destroyed) return;

      /* Con la pestaña oculta no se consulta; se hará al volver. */

      if (document.hidden) {
        dueWhileHidden = true;
        return;
      }

      refresh();
    }, delay);
  }

  /* =========================================
     REFRESH
  ========================================= */

  async function refresh() {
    if (destroyed) return;

    /*
     * Cancela únicamente la petición de esta instancia.
     */

    if (activeRequest) {
      activeRequest.abort();
      activeRequest = null;
    }

    clearTimeout(refreshTimer);

    refreshTimer = null;

    dueWhileHidden = false;

    const controller = new AbortController();

    activeRequest = controller;

    const currentSequence = ++requestSequence;

    let succeeded = false;

    setLoading(true);

    if (!lastPayload) {
      if (lastSignature !== "skeleton") {
        renderSkeleton(chartUI.list);
        lastSignature = "skeleton";
      }

      setStatus("Cargando ranking...");
    }

    try {
      const payload = await fetchChart(controller.signal);

      if (
        destroyed ||
        controller.signal.aborted ||
        currentSequence !== requestSequence
      ) {
        return;
      }

      succeeded = true;
      fromLocalCache = false;
      lastSuccessAt = Date.now();

      applyPayload(payload);
      writeCache(payload);

      setStatus("", false);

    } catch (error) {
      if (destroyed || currentSequence !== requestSequence) {
        return;
      }

      /*
       * Las peticiones canceladas por una actualización nueva
       * no deben mostrar errores.
       */

      if (error?.name === "AbortError") {
        return;
      }

      console.error(
        "[Shunel] Error cargando Top 50:",
        error
      );

      const message =
        error?.message || "No se pudo cargar el ranking.";

      if (lastPayload?.tracks?.length) {
        setStatus(
          `No se pudo actualizar. Se muestran los últimos datos disponibles. ${message}`,
          true,
          true
        );

      } else {
        chartUI.list.replaceChildren();
        chartUI.list.removeAttribute("aria-busy");

        lastSignature = null;

        setStatus(
          `${message} Comprueba tu conexión e inténtalo de nuevo.`,
          true,
          true
        );
      }

    } finally {
      /*
       * Una petición antigua nunca modifica los controles
       * de una petición más reciente.
       */

      if (activeRequest === controller) {
        activeRequest = null;

        setLoading(false);

        scheduleNext(
          succeeded
            ? CHART_REFRESH_MS
            : CHART_ERROR_RETRY_MS
        );
      }
    }
  }

  /* =========================================
     EVENTS
  ========================================= */

  function onRefreshClick() {
    refresh();
  }

  async function onListClick(event) {
    const row = event.target?.closest?.(
      "button.shunel-chart__row"
    );

    if (
      !row ||
      !chartUI.list.contains(row) ||
      !playable ||
      playing ||
      row.getAttribute("aria-disabled") === "true"
    ) {
      return;
    }

    const track = currentTracks[Number(row.dataset.index)];

    if (!track) return;

    playing = true;

    row.setAttribute("aria-disabled", "true");
    row.classList.add("is-busy");

    const originalTitle = row.title;

    row.title = "Buscando canción en YouTube...";

    try {
      await onPlay({
        ...track,
        query: `${track.artist} ${track.title}`.trim()
      });

    } catch (error) {
      console.error(
        "[Shunel] No se pudo reproducir desde el Top 50:",
        error
      );

      if (!destroyed) {
        showNotice(
          "No se pudo reproducir esa canción. Inténtalo de nuevo."
        );
      }

    } finally {
      playing = false;

      if (row.isConnected) {
        row.removeAttribute("aria-disabled");
        row.classList.remove("is-busy");
        row.title = originalTitle;
      }
    }
  }

  function onListKeydown(event) {
    if (
      event.key !== "ArrowDown" &&
      event.key !== "ArrowUp" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }

    const rows = Array.from(
      chartUI.list.querySelectorAll(
        "button.shunel-chart__row"
      )
    );

    if (!rows.length) return;

    const current = rows.indexOf(document.activeElement);

    let next;

    if (event.key === "Home") {
      next = 0;

    } else if (event.key === "End") {
      next = rows.length - 1;

    } else if (current === -1) {
      return;

    } else if (event.key === "ArrowDown") {
      next = Math.min(rows.length - 1, current + 1);

    } else {
      next = Math.max(0, current - 1);
    }

    event.preventDefault();

    rows[next].focus();
  }

  function onVisibilityChange() {
    if (destroyed || document.hidden) return;

    const stale =
      Date.now() - lastSuccessAt >= CHART_REFRESH_MS;

    if ((dueWhileHidden || stale) && !activeRequest) {
      refresh();
    }
  }

  function onOnline() {
    if (
      destroyed ||
      activeRequest ||
      !chartStatus.isError
    ) {
      return;
    }

    refresh();
  }

  chartUI.refreshButton.addEventListener(
    "click",
    onRefreshClick
  );

  chartUI.list.addEventListener("click", onListClick);
  chartUI.list.addEventListener("keydown", onListKeydown);

  document.addEventListener(
    "visibilitychange",
    onVisibilityChange
  );

  window.addEventListener("online", onOnline);

  /* =========================================
     START
  ========================================= */

  const cached = readCache();

  if (cached) {
    lastSuccessAt = cached.savedAt;
    fromLocalCache = true;

    applyPayload(cached.payload);

    setStatus("", false);
  }

  refresh();

  /* =========================================
     PUBLIC API
  ========================================= */

  const api = {
    refresh() {
      return refresh();
    },

    getData() {
      return lastPayload;
    },

    getElement() {
      return root;
    },

    isDestroyed() {
      return destroyed;
    },

    destroy() {
      if (destroyed) return;

      destroyed = true;

      clearTimeout(refreshTimer);
      clearTimeout(noticeTimer);

      refreshTimer = null;
      noticeTimer = null;

      chartUI.refreshButton.removeEventListener(
        "click",
        onRefreshClick
      );

      chartUI.list.removeEventListener("click", onListClick);
      chartUI.list.removeEventListener("keydown", onListKeydown);

      document.removeEventListener(
        "visibilitychange",
        onVisibilityChange
      );

      window.removeEventListener("online", onOnline);

      if (activeRequest) {
        activeRequest.abort();
        activeRequest = null;
      }

      requestSequence++;

      if (instances.get(root) === api) {
        instances.delete(root);
      }

      root.removeAttribute("aria-busy");
      root.classList.remove("is-readonly");
      root.replaceChildren();
    }
  };

  instances.set(root, api);

  return api;
}

export default initCostaRicaTop50;
