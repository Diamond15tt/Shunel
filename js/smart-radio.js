
/* =========================================
   SHUNEL — SMART RADIO
   Recomendaciones y reproducción continua
   Version: 2.0.0
========================================= */

(() => {
  "use strict";

  if (window.ShunelRadio) return;

  const CONFIG = {
    storageKey: "shunel_data",
    maxHistory: 30,
    maxRecommendations: 15,
    repeatPenalty: 100,
    artistMatchBonus: 30,
    genreMatchBonus: 25
  };

  const state = {
    initialized: false,
    active: false,
    loading: false,
    seed: null,
    candidates: [],
    played: [],
    history: [],
    currentBatch: [],
    provider: null,
    lastTrackId: null
  };

  function emit(name, detail = {}) {
    if (window.ShunelEvents) {
      window.ShunelEvents.emit(name, detail);
    } else {
      window.dispatchEvent(
        new CustomEvent(`shunel:${name}`, { detail })
      );
    }
  }

  function normalize(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();
  }

  function trackId(track) {
    if (!track) return null;

    return String(
      track.id ||
      track.videoId ||
      track.audioUrl ||
      `${normalize(track.title)}-${normalize(track.artist)}`
    );
  }

  function normalizeTrack(track) {
    if (!track || typeof track !== "object") {
      return null;
    }

    const title = String(track.title || "").trim();
    const artist = String(track.artist || "").trim();

    if (!title) return null;

    return {
      ...track,
      title,
      artist: artist || "Artista desconocido",
      id: trackId(track)
    };
  }

  function readStorage() {
    try {
      const raw = localStorage.getItem(CONFIG.storageKey);

      if (!raw) return {};

      const data = JSON.parse(raw);

      return data && typeof data === "object"
        ? data
        : {};
    } catch (error) {
      console.warn(
        "[Shunel Radio] No se pudo leer la biblioteca:",
        error
      );

      return {};
    }
  }

  function collectTracks() {
    const data = readStorage();

    const collections = [
      data.songs,
      data.tracks,
      data.favorites,
      data.history,
      data.recentlyPlayed,
      data.library
    ];

    const tracks = new Map();

    collections.forEach(collection => {
      if (!Array.isArray(collection)) return;

      collection.forEach(item => {
        const track = normalizeTrack(item);

        if (!track) return;

        const id = trackId(track);

        if (!tracks.has(id)) {
          tracks.set(id, track);
        }
      });
    });

    if (Array.isArray(state.candidates)) {
      state.candidates.forEach(item => {
        const track = normalizeTrack(item);

        if (track) {
          tracks.set(trackId(track), track);
        }
      });
    }

    return [...tracks.values()];
  }

  function getCurrentTrack() {
    return window.ShunelPlayer
      ?.getCurrentTrack?.() || null;
  }

  function getQueue() {
    const queue = window.ShunelPlayer
      ?.getQueue?.();

    return Array.isArray(queue) ? queue : [];
  }

  function getSeed(track) {
    return normalizeTrack(
      track || getCurrentTrack() || state.seed
    );
  }

  function getGenres(track) {
    const genres = track?.genres || track?.genre || [];

    if (Array.isArray(genres)) {
      return genres.map(normalize);
    }

    return String(genres)
      .split(",")
      .map(normalize)
      .filter(Boolean);
  }

  function scoreTrack(candidate, seed) {
    if (!candidate || !seed) return 0;

    const candidateId = trackId(candidate);
    const seedId = trackId(seed);

    if (!candidateId || candidateId === seedId) {
      return -Infinity;
    }

    let score = Math.random() * 5;

    if (
      normalize(candidate.artist) ===
      normalize(seed.artist)
    ) {
      score += CONFIG.artistMatchBonus;
    }

    const candidateGenres = getGenres(candidate);
    const seedGenres = getGenres(seed);

    const sharedGenres = candidateGenres.filter(
      genre => seedGenres.includes(genre)
    );

    score +=
      sharedGenres.length * CONFIG.genreMatchBonus;

    if (
      candidate.album &&
      normalize(candidate.album) === normalize(seed.album)
    ) {
      score += 10;
    }

    if (state.played.includes(candidateId)) {
      score -= CONFIG.repeatPenalty;
    }

    const currentQueueIds = new Set(
      getQueue().map(trackId)
    );

    if (currentQueueIds.has(candidateId)) {
      score -= 20;
    }

    return score;
  }

  function rankTracks(seed) {
    const currentId = trackId(getCurrentTrack());

    return collectTracks()
      .map(track => ({
        track,
        score: scoreTrack(track, seed)
      }))
      .filter(item => Number.isFinite(item.score))
      .filter(item => trackId(item.track) !== currentId)
      .sort((a, b) => b.score - a.score)
      .slice(0, CONFIG.maxRecommendations)
      .map(item => item.track);
  }

  function rememberPlayed(track) {
    const id = trackId(track);

    if (!id) return;

    state.played = [
      ...state.played.filter(item => item !== id),
      id
    ].slice(-CONFIG.maxHistory);
  }

  function getRecommendations(seed = null) {
    const base = getSeed(seed);

    if (!base) return [];

    return rankTracks(base);
  }

  async function requestExternalRecommendations(seed) {
    if (typeof state.provider !== "function") {
      return [];
    }

    try {
      const result = await state.provider(seed);

      if (!Array.isArray(result)) return [];

      return result
        .map(normalizeTrack)
        .filter(Boolean);

    } catch (error) {
      console.error(
        "[Shunel Radio] Error del proveedor:",
        error
      );

      return [];
    }
  }

  async function buildRecommendations(seed = null) {
    if (state.loading) return [];

    const base = getSeed(seed);

    if (!base) {
      emit("radio:error", {
        message: "No hay una canción para iniciar la radio."
      });

      return [];
    }

    state.loading = true;
    state.seed = base;

    try {
      let recommendations = getRecommendations(base);

      if (
        recommendations.length <
        CONFIG.maxRecommendations
      ) {
        const external = await requestExternalRecommendations(
          base
        );

        const existing = new Set(
          recommendations.map(trackId)
        );

        external.forEach(track => {
          const id = trackId(track);

          if (
            id !== trackId(base) &&
            !existing.has(id) &&
            !state.played.includes(id)
          ) {
            existing.add(id);
            recommendations.push(track);
          }
        });
      }

      state.currentBatch = recommendations;

      emit("radio:recommendations", {
        seed: base,
        tracks: recommendations
      });

      return recommendations;

    } finally {
      state.loading = false;
    }
  }

  function addToQueue(tracks) {
    const player = window.ShunelPlayer;

    if (!player || typeof player.addToQueue !== "function") {
      return 0;
    }

    let added = 0;

    tracks.forEach(track => {
      const result = player.addToQueue(track);

      if (result !== false) {
        added++;
      }
    });

    return added;
  }

  async function start(seed = null) {
    if (!window.ShunelPlayer) {
      emit("radio:error", {
        message: "El reproductor no está disponible."
      });

      return false;
    }

    const base = getSeed(seed);

    if (!base) {
      emit("radio:error", {
        message: "Selecciona una canción primero."
      });

      return false;
    }

    state.active = true;
    state.seed = base;
    state.played = [];

    rememberPlayed(base);

    const recommendations =
      await buildRecommendations(base);

    if (!state.active) return false;

    if (!recommendations.length) {
      emit("radio:empty", {
        message: "No encontramos más canciones relacionadas."
      });

      return false;
    }

    const added = addToQueue(recommendations);

    emit("radio:start", {
      seed: base,
      recommendations: recommendations.length,
      added
    });

    return added > 0;
  }

  async function refill() {
    if (!state.active || state.loading) {
      return false;
    }

    const seed = state.seed || getCurrentTrack();

    const recommendations =
      await buildRecommendations(seed);

    if (!state.active) return false;

    const available = recommendations.filter(
      track => !state.played.includes(trackId(track))
    );

    if (!available.length) {
      emit("radio:empty", {
        message: "No quedan recomendaciones disponibles."
      });

      return false;
    }

    const added = addToQueue(available);

    emit("radio:refill", {
      added,
      tracks: available
    });

    return added > 0;
  }

  async function playNext() {
    if (!state.active) return false;

    const recommendations =
      await buildRecommendations(state.seed);

    if (!recommendations.length) {
      return false;
    }

    const player = window.ShunelPlayer;

    if (!player) return false;

    const nextTrack = recommendations.find(
      track => !state.played.includes(trackId(track))
    );

    if (!nextTrack) return false;

    rememberPlayed(nextTrack);

    const result = await player.playTrack(nextTrack);

    emit("radio:next", {
      track: nextTrack
    });

    return result !== false;
  }

  function stop() {
    state.active = false;
    state.loading = false;
    state.currentBatch = [];

    emit("radio:stop", {});

    return true;
  }

  function setProvider(callback) {
    if (
      callback !== null &&
      typeof callback !== "function"
    ) {
      return false;
    }

    state.provider = callback;

    return true;
  }

  function handleTrackChange(detail) {
    const track = normalizeTrack(detail?.track);

    if (!track) return;

    state.lastTrackId = trackId(track);

    if (state.active) {
      rememberPlayed(track);

      if (!state.seed) {
        state.seed = track;
      }
    }
  }

  function handleQueueEnd() {
    if (!state.active) return;

    refill().then(added => {
      if (!added) {
        emit("radio:finished", {});
      }
    });
  }

  function bindEvents() {
    if (window.ShunelEvents) {
      window.ShunelEvents.on(
        "trackchange",
        handleTrackChange
      );

      window.ShunelEvents.on(
        "queueend",
        handleQueueEnd
      );
    } else {
      window.addEventListener(
        "shunel:trackchange",
        event => handleTrackChange(event.detail)
      );

      window.addEventListener(
        "shunel:queueend",
        handleQueueEnd
      );
    }
  }

  function initialize() {
    if (state.initialized) return true;

    bindEvents();

    state.initialized = true;

    emit("radio:ready", {});

    console.info("[Shunel Radio] Sistema preparado.");

    return true;
  }

  window.ShunelRadio = Object.freeze({
    initialize,
    start,
    stop,
    refill,
    playNext,
    getRecommendations,
    buildRecommendations,
    setProvider,

    getState() {
      return {
        initialized: state.initialized,
        active: state.active,
        loading: state.loading,
        seed: state.seed,
        played: [...state.played],
        recommendations: state.currentBatch.length
      };
    }
  });

  initialize();

})();
