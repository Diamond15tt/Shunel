const KEYS = {
  library: "shunel_library_v1",
  favorites: "shunel_favorites_v1",
  history: "shunel_history_v1",
  queue: "shunel_queue_v1"
};

function read(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    console.error("[Shunel Storage] No se pudo guardar:", error);
    return false;
  }
}

function validTrack(track) {
  return Boolean(
    track &&
    typeof track.videoId === "string" &&
    /^[a-zA-Z0-9_-]{11}$/.test(track.videoId)
  );
}

export const Storage = {
  getLibrary: () => read(KEYS.library),
  getFavorites: () => read(KEYS.favorites),
  getHistory: () => read(KEYS.history),
  getQueue: () => read(KEYS.queue),

  saveLibrary(items) {
    return write(KEYS.library, items.filter(validTrack));
  },
  saveFavorites(items) {
    return write(KEYS.favorites, items.filter(validTrack));
  },
  saveHistory(items) {
    return write(KEYS.history, items.filter(validTrack).slice(0, 100));
  },
  saveQueue(items) {
    return write(KEYS.queue, items.filter(validTrack));
  }
};
