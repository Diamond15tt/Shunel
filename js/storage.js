
/* =========================================
   SHUNEL — STORAGE ENGINE 2.0
   Persistent Storage / Validation / Recovery
   Queue State / Playback / History
========================================= */

const KEYS = Object.freeze({
  library: "shunel_library_v1",
  favorites: "shunel_favorites_v1",
  history: "shunel_history_v1",
  queue: "shunel_queue_v1",
  queueState: "shunel_queue_state_v2"
});

const LIMITS = Object.freeze({
  library: 2000,
  favorites: 2000,
  history: 100,
  queue: 500,
  text: 2000
});

const VALID_REPEAT_MODES = ["off", "one", "all"];

/* =========================================
   01. STORAGE ACCESS
========================================= */

function getStorage() {
  try {
    return typeof localStorage !== "undefined"
      ? localStorage
      : null;
  } catch {
    return null;
  }
}

/* =========================================
   02. SAFE READ
========================================= */

function readRaw(key, fallback = null) {
  try {
    const storage = getStorage();

    if (!storage) return fallback;

    const value = storage.getItem(key);

    if (value === null) return fallback;

    return JSON.parse(value);
  } catch (error) {
    console.error("[Shunel Storage] Error al leer:", key, error);
    return fallback;
  }
}

/* =========================================
   03. SAFE WRITE
========================================= */

function write(key, value) {
  try {
    const storage = getStorage();

    if (!storage) return false;

    const serialized = JSON.stringify(value);

    if (typeof serialized !== "string") {
      return false;
    }

    storage.setItem(key, serialized);

    return true;
  } catch (error) {
    console.error("[Shunel Storage] No se pudo guardar:", key, error);
    return false;
  }
}

/* =========================================
   04. SAFE REMOVE
========================================= */

function remove(key) {
  try {
    const storage = getStorage();

    if (!storage) return false;

    storage.removeItem(key);

    return true;
  } catch (error) {
    console.error("[Shunel Storage] No se pudo eliminar:", error);
    return false;
  }
}

/* =========================================
   05. TRACK VALIDATION
========================================= */

function validTrack(track) {
  return Boolean(
    track &&
    typeof track === "object" &&
    !Array.isArray(track) &&
    typeof track.videoId === "string" &&
    /^[a-zA-Z0-9_-]{11}$/.test(track.videoId)
  );
}

/* =========================================
   06. TRACK NORMALIZATION
========================================= */

function normalizeTrack(track) {
  if (!validTrack(track)) return null;

  const result = {};

  for (const [key, value] of Object.entries(track)) {
    if (typeof key !== "string") continue;

    if (
      value === null ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      result[key] = value;
      continue;
    }

    if (typeof value === "string") {
      result[key] = value.slice(0, LIMITS.text);
    }
  }

  return result;
}

/* =========================================
   07. ARRAY NORMALIZATION
========================================= */

function normalizeTracks(items, limit = LIMITS.queue) {
  if (!Array.isArray(items)) return [];

  return items
    .filter(validTrack)
    .map(normalizeTrack)
    .filter(Boolean)
    .slice(0, limit);
}

/* =========================================
   08. ARRAY READ
========================================= */

function readArray(key, limit) {
  const value = readRaw(key, []);

  if (!Array.isArray(value)) return [];

  return normalizeTracks(value, limit);
}

/* =========================================
   09. ARRAY WRITE
========================================= */

function writeArray(key, items, limit) {
  if (!Array.isArray(items)) return false;

  return write(
    key,
    normalizeTracks(items, limit)
  );
}

/* =========================================
   10. QUEUE STATE DEFAULTS
========================================= */

function defaultQueueState() {
  return {
    version: 2,
    current: null,
    repeat: "off",
    shuffle: false,
    originalOrder: null,
    updatedAt: Date.now()
  };
}

/* =========================================
   11. QUEUE STATE READ
========================================= */

function readQueueState() {
  const stored = readRaw(KEYS.queueState, null);

  if (
    !stored ||
    typeof stored !== "object" ||
    Array.isArray(stored)
  ) {
    return defaultQueueState();
  }

  return {
    version: 2,

    current: validTrack(stored.current)
      ? normalizeTrack(stored.current)
      : null,

    repeat: VALID_REPEAT_MODES.includes(stored.repeat)
      ? stored.repeat
      : "off",

    shuffle: stored.shuffle === true,

    originalOrder: Array.isArray(stored.originalOrder)
      ? normalizeTracks(stored.originalOrder, LIMITS.queue)
      : null,

    updatedAt:
      Number.isFinite(stored.updatedAt)
        ? stored.updatedAt
        : Date.now()
  };
}

/* =========================================
   12. QUEUE STATE WRITE
========================================= */

function writeQueueState(state = {}) {
  if (
    !state ||
    typeof state !== "object" ||
    Array.isArray(state)
  ) {
    return false;
  }

  const normalized = {
    version: 2,

    current: validTrack(state.current)
      ? normalizeTrack(state.current)
      : null,

    repeat: VALID_REPEAT_MODES.includes(state.repeat)
      ? state.repeat
      : "off",

    shuffle: state.shuffle === true,

    originalOrder: Array.isArray(state.originalOrder)
      ? normalizeTracks(state.originalOrder, LIMITS.queue)
      : null,

    updatedAt: Date.now()
  };

  return write(KEYS.queueState, normalized);
}

/* =========================================
   13. STORAGE API
========================================= */

export const Storage = {

  /* =====================================
     LIBRARY
  ===================================== */

  getLibrary() {
    return readArray(KEYS.library, LIMITS.library);
  },

  saveLibrary(items) {
    return writeArray(
      KEYS.library,
      items,
      LIMITS.library
    );
  },

  /* =====================================
     FAVORITES
  ===================================== */

  getFavorites() {
    return readArray(KEYS.favorites, LIMITS.favorites);
  },

  saveFavorites(items) {
    return writeArray(
      KEYS.favorites,
      items,
      LIMITS.favorites
    );
  },

  /* =====================================
     HISTORY
  ===================================== */

  getHistory() {
    return readArray(KEYS.history, LIMITS.history);
  },

  saveHistory(items) {
    return writeArray(
      KEYS.history,
      items,
      LIMITS.history
    );
  },

  addToHistory(track) {
    const normalized = normalizeTrack(track);

    if (!normalized) return false;

    const history = this.getHistory();

    history.push(normalized);

    return this.saveHistory(history);
  },

  clearHistory() {
    return writeArray(KEYS.history, [], LIMITS.history);
  },

  /* =====================================
     QUEUE
  ===================================== */

  getQueue() {
    return readArray(KEYS.queue, LIMITS.queue);
  },

  saveQueue(items) {
    return writeArray(
      KEYS.queue,
      items,
      LIMITS.queue
    );
  },

  clearQueue() {
    return writeArray(KEYS.queue, [], LIMITS.queue);
  },

  /* =====================================
     QUEUE STATE
  ===================================== */

  getQueueState() {
    return readQueueState();
  },

  saveQueueState(state) {
    return writeQueueState(state);
  },

  getCurrentTrack() {
    return readQueueState().current;
  },

  saveCurrentTrack(track) {
    const state = readQueueState();

    state.current = validTrack(track)
      ? normalizeTrack(track)
      : null;

    return writeQueueState(state);
  },

  getRepeatMode() {
    return readQueueState().repeat;
  },

  saveRepeatMode(mode) {
    if (!VALID_REPEAT_MODES.includes(mode)) {
      return false;
    }

    const state = readQueueState();

    state.repeat = mode;

    return writeQueueState(state);
  },

  getShuffleState() {
    return readQueueState().shuffle;
  },

  saveShuffleState(enabled, originalOrder = null) {
    const state = readQueueState();

    state.shuffle = enabled === true;

    state.originalOrder = Array.isArray(originalOrder)
      ? normalizeTracks(originalOrder, LIMITS.queue)
      : null;

    return writeQueueState(state);
  },

  /* =====================================
     UTILITIES
  ===================================== */

  exists(key) {
    try {
      return getStorage()?.getItem(key) !== null;
    } catch {
      return false;
    }
  },

  getStorageInfo() {
    const storage = getStorage();

    if (!storage) {
      return {
        available: false,
        keys: 0
      };
    }

    return {
      available: true,
      keys: storage.length
    };
  },

  exportData() {
    return {
      version: 2,
      exportedAt: new Date().toISOString(),

      library: this.getLibrary(),
      favorites: this.getFavorites(),
      history: this.getHistory(),
      queue: this.getQueue(),
      queueState: this.getQueueState()
    };
  },

  importData(data) {
    if (
      !data ||
      typeof data !== "object" ||
      Array.isArray(data)
    ) {
      return false;
    }

    const results = [];

    if (Array.isArray(data.library)) {
      results.push(this.saveLibrary(data.library));
    }

    if (Array.isArray(data.favorites)) {
      results.push(this.saveFavorites(data.favorites));
    }

    if (Array.isArray(data.history)) {
      results.push(this.saveHistory(data.history));
    }

    if (Array.isArray(data.queue)) {
      results.push(this.saveQueue(data.queue));
    }

    if (data.queueState) {
      results.push(this.saveQueueState(data.queueState));
    }

    return results.length > 0 && results.every(Boolean);
  },

  clearAll() {
    const results = [
      remove(KEYS.library),
      remove(KEYS.favorites),
      remove(KEYS.history),
      remove(KEYS.queue),
      remove(KEYS.queueState)
    ];

    return results.every(Boolean);
  }
};
