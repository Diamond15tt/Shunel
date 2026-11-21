
/* ==========================================================================
   SHUNEL — COSTA RICA TOP 50
   Cliente del ranking diario de Spotify Costa Rica.
   ========================================================================== */

const CHART_ENDPOINT = "/api/charts/cr";
const CHART_REFRESH_MS = 60 * 60 * 1000;
const STYLE_ID = "shunel-chart-styles";

let activeRequest = null;
let refreshTimer = null;

function escapeText(value) {
  return String(value ?? "");
}

function formatStreams(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return "Reproducciones no disponibles";
  }

  return `${new Intl.NumberFormat("es-CR").format(number)} reproducciones`;
}

function movementLabel(track) {
  if (track.movementType === "new") return "NUEVA";
  if (track.movementType === "reentry") return "REGRESA";
  if (!track.movement) return "—";

  return track.movement > 0
    ? `↑ ${track.movement}`
    : `↓ ${Math.abs(track.movement)}`;
}

function movementClass(track) {
  if (track.movementType === "new") return "is-new";
  if (track.movementType === "reentry") return "is-new";
  if (track.movement > 0) return "is-up";
  if (track.movement < 0) return "is-down";

  return "is-stable";
}

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement("style");

  style.id = STYLE_ID;

  style.textContent = `
    .shunel-chart {
      margin: 34px 0;
      min-width: 0;
    }

    .shunel-chart__heading {
      display: flex;
      align-items: end;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 16px;
    }

    .shunel-chart__heading h2 {
      margin: 3px 0 0;
    }

    .shunel-chart__meta {
      color: var(--muted, #9299a6);
      font-size: 12px;
    }

    .shunel-chart__refresh {
      border: 1px solid var(--border, rgba(255,255,255,.12));
      color: inherit;
      background: transparent;
      border-radius: 999px;
      padding: 8px 12px;
      font: inherit;
      font-size: 12px;
      cursor: pointer;
    }

    .shunel-chart__refresh:disabled {
      opacity: .5;
      cursor: wait;
    }

    .shunel-chart__list {
      display: grid;
      gap: 2px;
    }

    .shunel-chart__row {
      display: grid;
      grid-template-columns: 30px 4px minmax(0,1fr) auto;
      align-items: center;
      gap: 11px;
      min-height: 66px;
      padding: 8px 10px;
      border-bottom: 1px solid var(--border, rgba(255,255,255,.07));
      color: inherit;
      text-align: left;
      background: transparent;
      border-radius: 8px;
      width: 100%;
      cursor: pointer;
    }

    .shunel-chart__row:hover {
      background: rgba(255,255,255,.045);
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

    .shunel-chart__state {
      padding: 18px 0;
      color: var(--muted, #9299a6);
      font-size: 13px;
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
    }
  `;

  document.head.appendChild(style);
}

function createElement(tag, className, text) {
  const element = document.createElement(tag);

  if (className) {
    element.className = className;
  }

  if (text !== undefined) {
    element.textContent = escapeText(text);
  }

  return element;
}

function resolveContainer(container) {
  if (container instanceof Element) {
    return container;
  }

  const existing = document.getElementById(
    "spotifyCostaRicaTop50"
  );

  if (existing) return existing;

  const discover = document.querySelector(".home-discover");

  if (!discover?.parentNode) {
    throw new Error(
      "No se encontró .home-discover para insertar el Top 50."
    );
  }

  const section = createElement("section", "shunel-chart");

  section.id = "spotifyCostaRicaTop50";

  discover.insertAdjacentElement("afterend", section);

  return section;
}

function buildLayout(root) {
  root.classList.add("shunel-chart");
  root.replaceChildren();

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

  const actions = document.createElement("div");

  actions.style.display = "grid";
  actions.style.justifyItems = "end";
  actions.style.gap = "6px";

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

  actions.append(refreshButton, meta);

  heading.append(titleGroup, actions);

  const state = createElement(
    "p",
    "shunel-chart__state",
    "Cargando ranking..."
  );

  state.setAttribute("role", "status");
  state.setAttribute("aria-live", "polite");

  const list = createElement(
    "div",
    "shunel-chart__list"
  );

  list.setAttribute(
    "aria-label",
    "Las 50 canciones más escuchadas en Costa Rica"
  );

  const source = createElement(
    "p",
    "shunel-chart__source",
    ""
  );

  const sourceLink = document.createElement("a");

  sourceLink.href =
    "https://kworb.net/spotify/country/cr_daily.html";

  sourceLink.target = "_blank";
  sourceLink.rel = "noopener noreferrer";

  sourceLink.textContent =
    "Fuente: Kworb · Spotify Daily Chart";

  source.append(sourceLink);

  root.append(heading, state, list, source);

  return {
    refreshButton,
    meta,
    state,
    list
  };
}

function renderTracks(list, tracks, onPlay) {
  list.replaceChildren();

  const fragment = document.createDocumentFragment();

  tracks.forEach(track => {
    const row = createElement(
      "button",
      "shunel-chart__row"
    );

    row.type = "button";

    row.title =
      `Reproducir ${track.title} de ${track.artist}`;

    row.setAttribute(
      "aria-label",
      `Puesto ${track.rank}: ${track.title}, ${track.artist}. ${formatStreams(track.streams)}.`
    );

    const rank = createElement(
      "span",
      "shunel-chart__rank",
      track.rank
    );

    const marker = createElement(
      "span",
      `shunel-chart__cover ${movementClass(track)}`
    );

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

    stats.append(
      createElement(
        "span",
        `shunel-chart__movement ${movementClass(track)}`,
        movementLabel(track)
      ),
      createElement(
        "span",
        "",
        formatStreams(track.streams)
      )
    );

    row.append(rank, marker, song, stats);

    row.addEventListener("click", async () => {
      if (typeof onPlay !== "function") return;

      row.disabled = true;

      const originalTitle = row.title;

      row.title = "Buscando canción en YouTube...";

      try {
        await onPlay(track);
      } catch (error) {
        console.error(
          "[Shunel] No se pudo reproducir desde el Top 50:",
          error
        );
      } finally {
        row.disabled = false;
        row.title = originalTitle;
      }
    });

    fragment.appendChild(row);
  });

  list.appendChild(fragment);
}

async function fetchChart(signal) {
  const response = await fetch(CHART_ENDPOINT, {
    method: "GET",
    headers: {
      Accept: "application/json"
    },
    cache: "no-store",
    signal
  });

  if (!response.ok) {
    let message = "No se pudo cargar el Top 50.";

    try {
      const payload = await response.json();

      if (payload?.error) {
        message = payload.error;
      }
    } catch {}

    throw new Error(message);
  }

  const payload = await response.json();

  if (
    !Array.isArray(payload.tracks) ||
    payload.tracks.length === 0
  ) {
    throw new Error(
      "El ranking llegó vacío o tiene un formato inesperado."
    );
  }

  return payload;
}

/**
 * Monta el Top 50 y devuelve controles para actualizarlo o desmontarlo.
 *
 * @param {Object} options
 * @param {Function} options.searchTracks
 * @param {Function} options.onPlay
 * @param {Element|string} [options.container]
 */

export function initCostaRicaTop50({
  searchTracks,
  onPlay,
  container
} = {}) {
  if (typeof searchTracks !== "function") {
    throw new TypeError(
      "initCostaRicaTop50 necesita searchTracks."
    );
  }

  injectStyles();

  const root = typeof container === "string"
    ? document.querySelector(container)
    : resolveContainer(container);

  if (!root) {
    throw new Error(
      "No se pudo crear el contenedor del Top 50."
    );
  }

  const ui = buildLayout(root);

  let lastPayload = null;
  let destroyed = false;

  async function refresh() {
    if (destroyed) return;

    activeRequest?.abort();

    const controller = new AbortController();

    activeRequest = controller;

    ui.refreshButton.disabled = true;

    ui.state.hidden = false;

    ui.state.textContent = lastPayload
      ? "Actualizando ranking..."
      : "Cargando ranking...";

    try {
      const payload = await fetchChart(controller.signal);

      if (controller.signal.aborted || destroyed) {
        return;
      }

      lastPayload = payload;

      renderTracks(
        ui.list,
        payload.tracks.slice(0, 50),
        onPlay
      );

      ui.state.hidden = true;

      const date = payload.date
        ? `Datos del ${payload.date}`
        : "Ranking diario";

      ui.meta.textContent = payload.cached
        ? `${date} · Datos guardados`
        : date;

    } catch (error) {
      if (error.name === "AbortError") {
        return;
      }

      console.error(
        "[Shunel] Error cargando Top 50:",
        error
      );

      if (lastPayload?.tracks?.length) {
        ui.state.hidden = false;

        ui.state.textContent =
          "No se pudo actualizar. Se muestran los últimos datos disponibles.";
      } else {
        ui.state.hidden = false;

        ui.state.textContent =
          `${error.message} Intenta actualizar de nuevo.`;
      }

    } finally {
      if (activeRequest === controller) {
        activeRequest = null;
      }

      ui.refreshButton.disabled = false;
    }
  }

  ui.refreshButton.addEventListener(
    "click",
    refresh
  );

  refresh();

  clearInterval(refreshTimer);

  refreshTimer = setInterval(
    refresh,
    CHART_REFRESH_MS
  );

  return {
    refresh,

    getData: () => lastPayload,

    destroy() {
      destroyed = true;

      activeRequest?.abort();

      clearInterval(refreshTimer);

      refreshTimer = null;

      root.replaceChildren();
    }
  };
}

export default initCostaRicaTop50;
