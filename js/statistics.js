
/* =========================================
   SHUNEL — STATISTICS ENGINE
   Estadísticas y actividad musical
========================================= */

(() => {
  "use strict";

  const STORAGE_KEY = "shunel_statistics";
  const MAX_HISTORY = 1000;
  const MIN_PLAY_TIME = 30;

  const state = {
    plays: 0,
    totalSeconds: 0,
    history: [],
    currentTrack: null,
    startedAt: null,
    countedCurrentTrack: false,
    initialized: false,
    saving: false
  };

  function getSupabase() {
    return (
      window.shunelSupabase ||
      window.supabaseClient ||
      window._supabase ||
      null
    );
  }

  function getAudio() {
    return (
      window.ShunelPlayer?.getAudio?.() ||
      document.getElementById("localAudio")
    );
  }

  function dispatch(name, detail = {}) {
    document.dispatchEvent(
      new CustomEvent(name, { detail })
    );
  }

  function normalizeTrack(track) {
    if (!track) return null;

    return {
      id: String(track.id || track.track_id || ""),
      title: String(track.title || "Sin título"),
      artist: String(track.artist || "Artista desconocido"),
      artwork: String(
        track.artwork ||
        track.artworkUrl ||
        track.artwork_url ||
        ""
      ),
      source: String(track.source || "unknown")
    };
  }

  function loadLocal() {
    try {
      const saved = JSON.parse(
        localStorage.getItem(STORAGE_KEY) || "{}"
      );

      state.plays = Number(saved.plays) || 0;
      state.totalSeconds = Number(saved.totalSeconds) || 0;

      state.history = Array.isArray(saved.history)
        ? saved.history.slice(-MAX_HISTORY)
        : [];

    } catch (error) {
      console.warn("[Shunel Stats] Error leyendo estadísticas:", error);
    }
  }

  function saveLocal() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          plays: state.plays,
          totalSeconds: state.totalSeconds,
          history: state.history.slice(-MAX_HISTORY)
        })
      );

      return true;

    } catch (error) {
      console.warn("[Shunel Stats] Error guardando estadísticas:", error);
      return false;
    }
  }

  function getArtistStats() {
    const artists = new Map();

    state.history.forEach(item => {
      const name = item.artist || "Desconocido";

      const current = artists.get(name) || {
        artist: name,
        plays: 0,
        seconds: 0
      };

      current.plays += 1;
      current.seconds += Number(item.duration_seconds) || 0;

      artists.set(name, current);
    });

    return [...artists.values()]
      .sort((a, b) => b.plays - a.plays);
  }

  function getTrackStats() {
    const tracks = new Map();

    state.history.forEach(item => {
      const key = `${item.title}::${item.artist}`;

      const current = tracks.get(key) || {
        title: item.title,
        artist: item.artist,
        artwork: item.artwork_url || "",
        plays: 0,
        seconds: 0
      };

      current.plays += 1;
      current.seconds += Number(item.duration_seconds) || 0;

      tracks.set(key, current);
    });

    return [...tracks.values()]
      .sort((a, b) => b.plays - a.plays);
  }

  function getDailyStats(days = 7) {
    const result = [];

    for (let i = days - 1; i >= 0; i--) {
      const date = new Date();

      date.setDate(date.getDate() - i);

      const start = new Date(date);
      start.setHours(0, 0, 0, 0);

      const end = new Date(start);
      end.setDate(end.getDate() + 1);

      const entries = state.history.filter(item => {
        const time = new Date(item.played_at).getTime();

        return time >= start.getTime() &&
          time < end.getTime();
      });

      result.push({
        date: start.toISOString().slice(0, 10),
        plays: entries.length,
        seconds: entries.reduce(
          (sum, item) => sum + (Number(item.duration_seconds) || 0),
          0
        )
      });
    }

    return result;
  }

  async function getUser() {
    const client = getSupabase();

    if (!client?.auth) return null;

    const { data, error } = await client.auth.getUser();

    if (error) throw error;

    return data?.user || null;
  }

  async function syncHistory(item) {
    const client = getSupabase();

    if (!client) return;

    try {
      const user = await getUser();

      if (!user) return;

      const { error } = await client
        .from("listening_history")
        .insert({
          user_id: user.id,
          track_id: item.track_id,
          title: item.title,
          artist: item.artist,
          artwork_url: item.artwork_url,
          played_at: item.played_at,
          duration_seconds: item.duration_seconds
        });

      if (error) {
        console.warn("[Shunel Stats] Error sincronizando historial:", error);
      }

    } catch (error) {
      console.warn("[Shunel Stats] Sincronización pendiente:", error);
    }
  }

  async function syncTotals() {
    const client = getSupabase();

    if (!client || state.saving) return;

    state.saving = true;

    try {
      const user = await getUser();

      if (!user) return;

      const totalMinutes = Math.floor(state.totalSeconds / 60);

      const { data: existing, error: readError } = await client
        .from("user_stats")
        .select("user_id")
        .eq("user_id", user.id)
        .maybeSingle();

      if (readError) throw readError;

      const payload = {
        user_id: user.id,
        total_plays: state.plays,
        total_minutes: totalMinutes,
        updated_at: new Date().toISOString()
      };

      const { error } = existing
        ? await client
            .from("user_stats")
            .update(payload)
            .eq("user_id", user.id)
        : await client
            .from("user_stats")
            .insert(payload);

      if (error) {
        console.warn("[Shunel Stats] Error sincronizando totales:", error);
      }

    } catch (error) {
      console.warn("[Shunel Stats] No se pudieron sincronizar totales:", error);
    } finally {
      state.saving = false;
    }
  }

  function recordTrack(track, durationSeconds) {
    if (!track) return;

    const normalized = normalizeTrack(track);

    const seconds = Math.max(
      0,
      Math.floor(Number(durationSeconds) || 0)
    );

    if (seconds < MIN_PLAY_TIME) return;

    const item = {
      track_id: normalized.id || `${normalized.title}::${normalized.artist}`,
      title: normalized.title,
      artist: normalized.artist,
      artwork_url: normalized.artwork,
      source: normalized.source,
      played_at: new Date().toISOString(),
      duration_seconds: seconds
    };

    state.plays += 1;
    state.totalSeconds += seconds;

    state.history.push(item);

    if (state.history.length > MAX_HISTORY) {
      state.history = state.history.slice(-MAX_HISTORY);
    }

    saveLocal();
    syncHistory(item);
    syncTotals();

    dispatch("shunel:stats-updated", getStats());
  }

  function startTracking(track) {
    if (state.currentTrack && state.startedAt !== null) {
      finishTracking();
    }

    state.currentTrack = normalizeTrack(track);
    state.startedAt = Date.now();
    state.countedCurrentTrack = false;
  }

  function finishTracking() {
    if (!state.currentTrack || state.startedAt === null) return;

    const elapsed = Math.floor(
      (Date.now() - state.startedAt) / 1000
    );

    recordTrack(state.currentTrack, elapsed);

    state.currentTrack = null;
    state.startedAt = null;
    state.countedCurrentTrack = false;
  }

  function handleTrackChange(event) {
    const track = event.detail?.track ||
      window.ShunelPlayer?.getCurrentTrack?.();

    if (track) {
      startTracking(track);
    }
  }

  function handlePlay() {
    if (!state.currentTrack) {
      const track = window.ShunelPlayer?.getCurrentTrack?.();

      if (track) startTracking(track);
      return;
    }

    if (state.startedAt === null) {
      state.startedAt = Date.now();
    }
  }

  function handlePause() {
    if (state.startedAt === null) return;

    const elapsed = Math.floor(
      (Date.now() - state.startedAt) / 1000
    );

    // Se acumula el tiempo reproducido hasta la pausa.
    state.pausedSeconds =
      (state.pausedSeconds || 0) + elapsed;

    state.startedAt = null;
  }

  function getStats() {
    return {
      plays: state.plays,
      totalSeconds: state.totalSeconds,
      totalMinutes: Math.floor(state.totalSeconds / 60),
      totalHours: Number((state.totalSeconds / 3600).toFixed(1)),
      artists: getArtistStats(),
      tracks: getTrackStats(),
      daily: getDailyStats(7),
      history: [...state.history].reverse()
    };
  }

  function getRecentHistory(limit = 20) {
    return [...state.history]
      .reverse()
      .slice(0, Math.max(1, limit));
  }

  function resetLocal() {
    state.plays = 0;
    state.totalSeconds = 0;
    state.history = [];

    saveLocal();

    dispatch("shunel:stats-updated", getStats());
  }

  function render(container) {
    if (!container) return;

    const stats = getStats();

    container.replaceChildren();

    const fragment = document.createDocumentFragment();

    const metrics = [
      ["Reproducciones", stats.plays],
      ["Minutos escuchados", stats.totalMinutes],
      ["Horas escuchadas", stats.totalHours],
      ["Artistas escuchados", stats.artists.length]
    ];

    metrics.forEach(([label, value]) => {
      const section = document.createElement("section");
      section.className = "statistic-item";

      const heading = document.createElement("span");
      heading.textContent = label;

      const number = document.createElement("strong");
      number.textContent = String(value);

      section.append(heading, number);
      fragment.appendChild(section);
    });

    const artistsTitle = document.createElement("h3");
    artistsTitle.textContent = "Artistas más escuchados";

    fragment.appendChild(artistsTitle);

    stats.artists.slice(0, 5).forEach((artist, index) => {
      const row = document.createElement("p");
      row.className = "statistic-row";
      row.textContent = `${index + 1}. ${artist.artist} · ${artist.plays} reproducciones`;

      fragment.appendChild(row);
    });

    container.appendChild(fragment);
  }

  function initialize() {
    if (state.initialized) return;

    state.initialized = true;
    state.pausedSeconds = 0;

    loadLocal();

    document.addEventListener(
      "shunel:trackchange",
      handleTrackChange
    );

    document.addEventListener(
      "shunel:play",
      handlePlay
    );

    document.addEventListener(
      "shunel:pause",
      handlePause
    );

    const audio = getAudio();

    if (audio) {
      audio.addEventListener("ended", finishTracking);
    }

    window.addEventListener("pagehide", () => {
      finishTracking();
    });

    window.ShunelStatistics = {
      getStats,
      getRecentHistory,
      getArtistStats,
      getTrackStats,
      getDailyStats,
      recordTrack,
      render,
      resetLocal,
      syncTotals
    };

    const currentTrack = window.ShunelPlayer?.getCurrentTrack?.();

    if (currentTrack && !audio?.paused) {
      startTracking(currentTrack);
    }

    console.info("[Shunel Stats] Estadísticas preparadas.");
  }

  initialize();

})();
