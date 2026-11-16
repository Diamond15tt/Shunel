
/* =========================================
   SHUNEL — SMART RADIO
   Radio musical basada en gustos e historial
========================================= */

(() => {
  "use strict";

  const STORAGE_KEY = "shunel_radio_history";
  const MAX_HISTORY = 100;

  const state = {
    active: false,
    seedTrack: null,
    tracks: [],
    played: [],
    loading: false,
    requestId: 0,
    excluded: new Set()
  };

  const player = () => window.ShunelPlayer || null;

  function normalize(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function trackKey(track) {
    return `${normalize(track.title)}::${normalize(track.artist)}`;
  }

  function getHistory() {
    try {
      return JSON.parse(
        localStorage.getItem(STORAGE_KEY) || "[]"
      );
    } catch {
      return [];
    }
  }

  function saveHistory() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(state.played.slice(-MAX_HISTORY))
      );
    } catch (error) {
      console.warn("[Shunel Radio] No se pudo guardar el historial.", error);
    }
  }

  function rememberTrack(track) {
    if (!track?.title || !track?.artist) return;

    const item = {
      title: track.title,
      artist: track.artist,
      artwork: track.artwork || track.artworkUrl || track.artwork_url || "",
      source: track.source || "unknown",
      playedAt: Date.now()
    };

    state.played.push(item);

    if (state.played.length > MAX_HISTORY) {
      state.played.shift();
    }

    saveHistory();
  }

  function getFavoriteTracks() {
    try {
      const raw = localStorage.getItem("shunel_data");

      if (!raw) return [];

      const data = JSON.parse(raw);

      return Array.isArray(data.favorites)
        ? data.favorites
        : [];
    } catch {
      return [];
    }
  }

  function getSeedTrack() {
    return player()?.getCurrentTrack?.() || null;
  }

  function createRecommendationPool(seed) {
    const history = getHistory();
    const favorites = getFavoriteTracks();

    const pool = [
      ...favorites,
      ...history
    ];

    if (seed) pool.unshift(seed);

    return pool.filter(track =>
      track &&
      track.title &&
      track.artist
    );
  }

  function getArtistFrequency(pool) {
    const frequency = new Map();

    pool.forEach(track => {
      const artist = normalize(track.artist);

      if (!artist) return;

      frequency.set(
        artist,
        (frequency.get(artist) || 0) + 1
      );
    });

    return frequency;
  }

  function buildRadio(seed) {
    const pool = createRecommendationPool(seed);

    const frequency = getArtistFrequency(pool);

    const recommendations = new Map();

    pool.forEach(track => {
      const key = trackKey(track);

      if (!key || state.excluded.has(key)) return;

      const artist = normalize(track.artist);

      const score = frequency.get(artist) || 0;

      const existing = recommendations.get(key);

      if (!existing || score > existing.score) {
        recommendations.set(key, {
          ...track,
          score
        });
      }
    });

    return [...recommendations.values()]
      .sort((a, b) => {
        return b.score - a.score || Math.random() - 0.5;
      });
  }

  function formatTrack(track) {
    return {
      ...track,
      title: String(track.title || "Sin título"),
      artist: String(track.artist || "Artista desconocido"),
      artwork:
        track.artwork ||
        track.artworkUrl ||
        track.artwork_url ||
        "",
      audioUrl:
        track.audioUrl ||
        track.audio_url ||
        track.url ||
        track.src ||
        null
    };
  }

  function renderRadio() {
    const container = document.getElementById("smartRadioTracks");

    if (!container) return;

    container.replaceChildren();

    if (!state.tracks.length) {
      const message = document.createElement("p");
      message.textContent = "Escuchá más música para crear tu radio.";
      container.appendChild(message);
      return;
    }

    const fragment = document.createDocumentFragment();

    state.tracks.forEach((track, index) => {
      const item = document.createElement("button");

      item.type = "button";
      item.className = "smart-radio-track";

      const artwork = document.createElement("img");
      artwork.src = track.artwork || "";
      artwork.alt = "";
      artwork.loading = "lazy";

      const information = document.createElement("span");
      information.className = "smart-radio-information";

      const title = document.createElement("strong");
      title.textContent = track.title;

      const artist = document.createElement("small");
      artist.textContent = track.artist;

      information.append(title, artist);
      item.append(artwork, information);

      item.addEventListener("click", () => {
        playRecommendation(index);
      });

      fragment.appendChild(item);
    });

    container.appendChild(fragment);
  }

  function playRecommendation(index = 0) {
    const track = state.tracks[index];

    if (!track) return false;

    const formatted = formatTrack(track);

    if (!formatted.audioUrl) {
      document.dispatchEvent(
        new CustomEvent("shunel:radio-track-unavailable", {
          detail: { track: formatted }
        })
      );

      return false;
    }

    state.excluded.add(trackKey(track));

    const tracks = state.tracks.map(formatTrack);

    const result = player()?.playTrack?.(
      formatted,
      tracks
    );

    return result !== undefined;
  }

  function start(seed = getSeedTrack()) {
    if (state.loading) return false;

    state.active = true;
    state.seedTrack = seed;
    state.excluded.clear();

    state.tracks = buildRadio(seed);

    renderRadio();

    document.dispatchEvent(
      new CustomEvent("shunel:radio-start", {
        detail: {
          seed,
          tracks: state.tracks
        }
      })
    );

    if (state.tracks.length) {
      const playableIndex = state.tracks.findIndex(track =>
        Boolean(
          track.audioUrl ||
          track.audio_url ||
          track.url ||
          track.src
        )
      );

      if (playableIndex >= 0) {
        playRecommendation(playableIndex);
      }
    }

    return state.tracks;
  }

  function stop() {
    state.active = false;
    state.loading = false;

    document.dispatchEvent(
      new CustomEvent("shunel:radio-stop")
    );
  }

  function refresh() {
    state.excluded.clear();
    state.tracks = buildRadio(state.seedTrack);

    renderRadio();

    return state.tracks;
  }

  function handleTrackChange(event) {
    const track = event.detail?.track || getSeedTrack();

    if (!track) return;

    rememberTrack(track);

    if (!state.active) return;

    const key = trackKey(track);

    state.excluded.add(key);

    if (state.excluded.size >= Math.max(1, state.tracks.length)) {
      refresh();
    }
  }

  function initialize() {
    state.played = getHistory();

    document.addEventListener(
      "shunel:trackchange",
      handleTrackChange
    );

    document.addEventListener(
      "shunel:radio-button",
      () => start()
    );

    window.ShunelRadio = {
      start,
      stop,
      refresh,
      getTracks: () => [...state.tracks],
      getHistory: () => getHistory(),
      getState: () => ({
        active: state.active,
        seedTrack: state.seedTrack,
        trackCount: state.tracks.length
      })
    };

    console.info("[Shunel Radio] Radio inteligente preparada.");
  }

  initialize();

})();
