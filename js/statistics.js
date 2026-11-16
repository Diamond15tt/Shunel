
/* =========================================
   SHUNEL — STATISTICS ENGINE
   Reproducciones y estadísticas musicales
   Version: 2.0.0
========================================= */

(() => {
  "use strict";

  if (window.ShunelStatistics) return;

  const CONFIG = {
    storageKey: "shunel_statistics",
    table: "user_statistics",
    minimumPlaySeconds: 30,
    saveInterval: 10000,
    maxRecentTracks: 100
  };

  const state = {
    initialized: false,
    userId: null,
    currentTrack: null,
    currentTrackId: null,
    startedAt: null,
    lastTick: null,
    accumulatedSeconds: 0,
    totalSeconds: 0,
    totalPlays: 0,
    uniqueTracks: [],
    recentTracks: [],
    countedCurrentTrack: false,
    saving: false,
    sessionId: null
  };

  let saveTimer = null;

  function emit(name, detail = {}) {
    if (window.ShunelEvents) {
      window.ShunelEvents.emit(name, detail);
    } else {
      window.dispatchEvent(
        new CustomEvent(`shunel:${name}`, { detail })
      );
    }
  }

  function getClient() {
    return (
      window.shunelSupabase ||
      window.supabaseClient ||
      window._supabase ||
      null
    );
  }

  function getPlayer() {
    return window.ShunelPlayer || null;
  }

  function getTrackId(track) {
    if (!track) return null;

    return String(
      track.id ||
      track.videoId ||
      track.audioUrl ||
      `${track.title || ""}-${track.artist || ""}`
    );
  }

  function createEmptyData() {
    return {
      totalSeconds: 0,
      totalPlays: 0,
      uniqueTracks: [],
      recentTracks: [],
      updatedAt: null
    };
  }

  function normalizeData(data = {}) {
    return {
      totalSeconds: Math.max(
        0,
        Number(data.totalSeconds) || 0
      ),

      totalPlays: Math.max(
        0,
        Number(data.totalPlays) || 0
      ),

      uniqueTracks: Array.isArray(data.uniqueTracks)
        ? [...new Set(data.uniqueTracks)]
        : [],

      recentTracks: Array.isArray(data.recentTracks)
        ? data.recentTracks.slice(0, CONFIG.maxRecentTracks)
        : [],

      updatedAt: data.updatedAt || null
    };
  }

  function readLocal() {
    try {
      const saved = JSON.parse(
        localStorage.getItem(CONFIG.storageKey) || "{}"
      );

      return normalizeData(saved);
    } catch {
      return createEmptyData();
    }
  }

  function saveLocal() {
    try {
      const data = {
        totalSeconds: state.totalSeconds,
        totalPlays: state.totalPlays,
        uniqueTracks: state.uniqueTracks,
        recentTracks: state.recentTracks,
        updatedAt: new Date().toISOString()
      };

      localStorage.setItem(
        CONFIG.storageKey,
        JSON.stringify(data)
      );

      return true;
    } catch (error) {
      console.warn(
        "[Shunel Statistics] Error guardando:",
        error
      );

      return false;
    }
  }

  function applyData(data) {
    const normalized = normalizeData(data);

    state.totalSeconds = normalized.totalSeconds;
    state.totalPlays = normalized.totalPlays;
    state.uniqueTracks = normalized.uniqueTracks;
    state.recentTracks = normalized.recentTracks;
  }

  function updateRecentTrack(track) {
    const id = getTrackId(track);

    if (!id) return;

    state.recentTracks = [
      {
        id,
        title: track.title || "Canción desconocida",
        artist: track.artist || "Artista desconocido",
        artwork: track.artwork || track.cover || null,
        playedAt: new Date().toISOString()
      },
      ...state.recentTracks.filter(item => item.id !== id)
    ].slice(0, CONFIG.maxRecentTracks);
  }

  function countPlay() {
    if (!state.currentTrack || state.countedCurrentTrack) {
      return false;
    }

    state.countedCurrentTrack = true;
    state.totalPlays++;

    const id = state.currentTrackId;

    if (id && !state.uniqueTracks.includes(id)) {
      state.uniqueTracks.push(id);
    }

    updateRecentTrack(state.currentTrack);

    saveLocal();

    emit("statistics:play", {
      track: state.currentTrack,
      totalPlays: state.totalPlays
    });

    return true;
  }

  function beginTrack(track) {
    if (!track) return;

    stopCounting();

    state.currentTrack = track;
    state.currentTrackId = getTrackId(track);
    state.startedAt = Date.now();
    state.lastTick = null;
    state.accumulatedSeconds = 0;
    state.countedCurrentTrack = false;

    if (getPlayer()?.getState?.().isPlaying) {
      startCounting();
    }
  }

  function startCounting() {
    if (!state.currentTrack || state.lastTick !== null) {
      return false;
    }

    state.lastTick = Date.now();

    emit("statistics:counting", {
      active: true
    });

    return true;
  }

  function stopCounting() {
    if (state.lastTick === null) return;

    const now = Date.now();

    const elapsed = Math.max(
      0,
      (now - state.lastTick) / 1000
    );

    state.accumulatedSeconds += elapsed;
    state.lastTick = null;

    if (
      state.accumulatedSeconds >=
      CONFIG.minimumPlaySeconds
    ) {
      countPlay();
    }

    state.totalSeconds += elapsed;

    saveLocal();

    emit("statistics:counting", {
      active: false
    });
  }

  function tick() {
    if (state.lastTick === null) return;

    const now = Date.now();

    const elapsed = Math.max(
      0,
      (now - state.lastTick) / 1000
    );

    state.accumulatedSeconds += elapsed;
    state.totalSeconds += elapsed;
    state.lastTick = now;

    if (
      state.accumulatedSeconds >=
      CONFIG.minimumPlaySeconds
    ) {
      countPlay();
    }
  }

  function handlePlay() {
    startCounting();
  }

  function handlePause() {
    stopCounting();
    saveLocal();
  }

  function handleEnded() {
    stopCounting();
    saveLocal();

    state.currentTrack = null;
    state.currentTrackId = null;
    state.startedAt = null;
    state.accumulatedSeconds = 0;
    state.countedCurrentTrack = false;
  }

  function handleTrackChange(detail) {
    const track = detail?.track;

    if (!track) {
      handleEnded();
      return;
    }

    beginTrack(track);
  }

  function getDurationFormatted(seconds) {
    const total = Math.floor(
      Math.max(0, Number(seconds) || 0)
    );

    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);

    if (hours > 0) {
      return `${hours} h ${minutes} min`;
    }

    return `${minutes} min`;
  }

  function getStats() {
    const currentSessionSeconds =
      state.accumulatedSeconds +
      (
        state.lastTick !== null
          ? (Date.now() - state.lastTick) / 1000
          : 0
      );

    return {
      totalSeconds: Math.floor(state.totalSeconds),
      totalMinutes: Math.floor(state.totalSeconds / 60),
      totalHours: Number(
        (state.totalSeconds / 3600).toFixed(2)
      ),
      formattedTime: getDurationFormatted(
        state.totalSeconds
      ),
      totalPlays: state.totalPlays,
      uniqueTracks: state.uniqueTracks.length,
      recentTracks: [...state.recentTracks],
      currentSessionSeconds: Math.floor(
        currentSessionSeconds
      )
    };
  }

  async function getAuthenticatedUser() {
    const client = getClient();

    if (!client?.auth) return null;

    const { data, error } = await client.auth.getUser();

    if (error) throw error;

    return data?.user || null;
  }

  async function loadFromServer() {
    const client = getClient();

    if (!client) return null;

    const user = await getAuthenticatedUser();

    if (!user) {
      state.userId = null;
      return null;
    }

    state.userId = user.id;

    const { data, error } = await client
      .from(CONFIG.table)
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();

    if (error) throw error;

    if (!data) return null;

    return normalizeData({
      totalSeconds: data.total_seconds,
      totalPlays: data.total_plays,
      uniqueTracks: data.unique_tracks,
      recentTracks: data.recent_tracks,
      updatedAt: data.updated_at
    });
  }

  async function sync() {
    if (state.saving) return false;

    const client = getClient();

    if (!client || !state.userId) {
      saveLocal();
      return false;
    }

    state.saving = true;

    try {
      const payload = {
        user_id: state.userId,
        total_seconds: Math.floor(state.totalSeconds),
        total_plays: state.totalPlays,
        unique_tracks: state.uniqueTracks,
        recent_tracks: state.recentTracks,
        updated_at: new Date().toISOString()
      };

      const { error } = await client
        .from(CONFIG.table)
        .upsert(payload, {
          onConflict: "user_id"
        });

      if (error) throw error;

      saveLocal();

      emit("statistics:synced", {
        userId: state.userId
      });

      return true;

    } catch (error) {
      console.error(
        "[Shunel Statistics] Error sincronizando:",
        error
      );

      emit("statistics:sync-error", {
        message: error.message
      });

      return false;

    } finally {
      state.saving = false;
    }
  }

  async function load() {
    const local = readLocal();

    applyData(local);

    try {
      const remote = await loadFromServer();

      if (remote) {
        /*
          No sumamos los valores locales y remotos:
          podrían representar los mismos datos.

          Por ahora se utiliza el servidor como fuente
          principal. Una sincronización acumulativa
          requerirá eventos únicos por reproducción.
        */

        applyData(remote);
        saveLocal();
      }

      emit("statistics:loaded", getStats());

      return getStats();

    } catch (error) {
      console.warn(
        "[Shunel Statistics] Se utilizarán datos locales:",
        error
      );

      emit("statistics:offline", getStats());

      return getStats();
    }
  }

  function scheduleSync() {
    if (saveTimer) {
      clearInterval(saveTimer);
    }

    saveTimer = setInterval(() => {
      if (state.lastTick !== null) {
        tick();
      }

      sync();
    }, CONFIG.saveInterval);
  }

  function bindEvents() {
    if (window.ShunelEvents) {
      window.ShunelEvents.on(
        "trackchange",
        handleTrackChange
      );

      window.ShunelEvents.on(
        "play",
        handlePlay
      );

      window.ShunelEvents.on(
        "pause",
        handlePause
      );

      window.ShunelEvents.on(
        "ended",
        handleEnded
      );
    } else {
      window.addEventListener(
        "shunel:trackchange",
        event => handleTrackChange(event.detail)
      );

      window.addEventListener(
        "shunel:play",
        handlePlay
      );

      window.addEventListener(
        "shunel:pause",
        handlePause
      );

      window.addEventListener(
        "shunel:ended",
        handleEnded
      );
    }

    const audio = getPlayer()?.getAudio?.();

    audio?.addEventListener("play", handlePlay);
    audio?.addEventListener("pause", handlePause);
    audio?.addEventListener("ended", handleEnded);
  }

  function initialize() {
    if (state.initialized) return true;

    applyData(readLocal());

    state.sessionId =
      globalThis.crypto?.randomUUID?.() ||
      `${Date.now()}-${Math.random()}`;

    bindEvents();
    scheduleSync();

    state.initialized = true;

    emit("statistics:ready", getStats());

    console.info(
      "[Shunel Statistics] Sistema preparado."
    );

    return true;
  }

  function dispose() {
    stopCounting();

    if (saveTimer) {
      clearInterval(saveTimer);
      saveTimer = null;
    }

    sync();

    state.initialized = false;
  }

  window.ShunelStatistics = Object.freeze({
    initialize,
    load,
    sync,
    getStats,
    getState: getStats,
    dispose
  });

  initialize();

})();
