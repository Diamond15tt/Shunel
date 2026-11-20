
import { Storage } from "./storage.js";

/* =========================================
   SHUNEL — QUEUE MANAGER 3.0
   Smart Queue / History / Repeat / Shuffle
   Storage / Events / Playback Management
========================================= */

const CONFIG = Object.freeze({
  MAX_QUEUE_SIZE: 500,
  MAX_HISTORY_SIZE: 100,
  MAX_TEXT_LENGTH: 500,
  DEFAULT_REPEAT_MODE: "off",
  VALID_REPEAT_MODES: ["off", "one", "all"]
});

/* =========================================
   01. VALIDATION AND UTILITIES
========================================= */

function isValid(track) {
  return (
    track !== null &&
    typeof track === "object" &&
    !Array.isArray(track) &&
    typeof track.videoId === "string" &&
    /^[a-zA-Z0-9_-]{11}$/.test(track.videoId)
  );
}

function cleanText(value, maxLength = CONFIG.MAX_TEXT_LENGTH) {
  if (typeof value !== "string") return "";

  return value
    .trim()
    .slice(0, maxLength);
}

function cloneTrack(track) {
  if (!isValid(track)) return null;

  const clone = {};

  for (const [key, value] of Object.entries(track)) {
    if (typeof key !== "string") continue;

    if (
      value === null ||
      typeof value === "boolean" ||
      typeof value === "number"
    ) {
      clone[key] = value;
      continue;
    }

    if (typeof value === "string") {
      clone[key] = cleanText(value, 2000);
    }
  }

  clone.videoId = track.videoId;

  return clone;
}

function normalizeTracks(tracks) {
  if (!Array.isArray(tracks)) return [];

  return tracks
    .filter(isValid)
    .map(cloneTrack)
    .filter(Boolean);
}

function getDuration(track) {
  if (!track) return 0;

  const value =
    track.durationSeconds ??
    track.duration ??
    track.length ??
    0;

  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, value);
  }

  if (typeof value === "string") {
    const parts = value.split(":").map(Number);

    if (
      parts.length >= 2 &&
      parts.length <= 3 &&
      parts.every(Number.isFinite)
    ) {
      return parts.reduce((total, part) => total * 60 + part, 0);
    }
  }

  return 0;
}

function shuffleArray(array) {
  const result = [...array];

  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));

    [result[i], result[j]] = [result[j], result[i]];
  }

  return result;
}

/* =========================================
   02. QUEUE MANAGER
========================================= */

export class QueueManager {
  constructor(options = {}) {
    this.maxQueueSize = Number.isInteger(options.maxQueueSize)
      ? Math.max(1, options.maxQueueSize)
      : CONFIG.MAX_QUEUE_SIZE;

    this.maxHistorySize = Number.isInteger(options.maxHistorySize)
      ? Math.max(1, options.maxHistorySize)
      : CONFIG.MAX_HISTORY_SIZE;

    this.items = this.loadQueue();

    this.current = null;
    this.history = [];

    this.repeat = CONFIG.DEFAULT_REPEAT_MODE;

    this.shuffleEnabled = false;
    this.originalOrder = null;

    this.onChange = () => {};

    this.listeners = new Map();

    this.isMutating = false;
    this.lastError = null;
  }

  /* =========================================
     03. STORAGE
  ========================================= */

  loadQueue() {
    try {
      const stored = Storage.getQueue();

      return normalizeTracks(stored)
        .slice(0, this.maxQueueSize || CONFIG.MAX_QUEUE_SIZE);
    } catch (error) {
      this.lastError = error;
      return [];
    }
  }

  save() {
    try {
      Storage.saveQueue(this.items.map(cloneTrack));
      this.lastError = null;
      return true;
    } catch (error) {
      this.lastError = error;
      return false;
    }
  }

  getLastError() {
    return this.lastError;
  }

  /* =========================================
     04. EVENT SYSTEM
  ========================================= */

  setOnChange(callback) {
    this.onChange =
      typeof callback === "function"
        ? callback
        : () => {};

    this.onChange(this.getItems());
  }

  on(event, callback) {
    if (
      typeof event !== "string" ||
      typeof callback !== "function"
    ) {
      return () => {};
    }

    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }

    const callbacks = this.listeners.get(event);

    callbacks.add(callback);

    return () => {
      callbacks.delete(callback);

      if (callbacks.size === 0) {
        this.listeners.delete(event);
      }
    };
  }

  off(event, callback) {
    this.listeners.get(event)?.delete(callback);
  }

  emitEvent(event, payload = {}) {
    const callbacks = this.listeners.get(event);

    if (!callbacks) return;

    for (const callback of [...callbacks]) {
      try {
        callback(payload);
      } catch (error) {
        console.error(`[Shunel Queue] Event "${event}":`, error);
      }
    }
  }

  emit(event = "change", payload = {}) {
    this.save();

    const state = {
      items: this.getItems(),
      current: this.getCurrent(),
      history: this.getHistory(),
      repeat: this.repeat,
      shuffle: this.shuffleEnabled
    };

    try {
      this.onChange(state.items);
    } catch (error) {
      console.error("[Shunel Queue] onChange:", error);
    }

    this.emitEvent("change", state);
    this.emitEvent(event, payload);
  }

  /* =========================================
     05. STATE ACCESS
  ========================================= */

  getItems() {
    return this.items.map(cloneTrack);
  }

  getCurrent() {
    return cloneTrack(this.current);
  }

  getHistory() {
    return this.history.map(cloneTrack);
  }

  getNextItems(limit = 5) {
    const amount = Math.max(0, Math.floor(Number(limit) || 0));

    return this.items
      .slice(0, amount)
      .map(cloneTrack);
  }

  getLength() {
    return this.items.length;
  }

  isEmpty() {
    return this.items.length === 0;
  }

  hasNext() {
    return this.items.length > 0 || this.repeat === "all";
  }

  hasPrevious() {
    return this.history.length > 0;
  }

  contains(videoId) {
    return this.items.some(track => track.videoId === videoId);
  }

  find(videoId) {
    const track = this.items.find(
      item => item.videoId === videoId
    );

    return cloneTrack(track);
  }

  getPosition(videoId) {
    return this.items.findIndex(
      item => item.videoId === videoId
    );
  }

  /* =========================================
     06. ADD TRACKS
  ========================================= */

  add(track, options = {}) {
    if (!isValid(track)) return false;

    const item = cloneTrack(track);

    if (!item) return false;

    const allowDuplicate = options.allowDuplicate !== false;

    if (
      !allowDuplicate &&
      this.items.some(existing => existing.videoId === item.videoId)
    ) {
      return false;
    }

    if (this.items.length >= this.maxQueueSize) {
      return false;
    }

    this.items.push(item);

    this.emit("add", {
      track: cloneTrack(item),
      position: this.items.length - 1
    });

    return true;
  }

  addNext(track, options = {}) {
    if (!isValid(track)) return false;

    const item = cloneTrack(track);

    if (!item) return false;

    if (this.items.length >= this.maxQueueSize) {
      return false;
    }

    if (
      options.allowDuplicate === false &&
      this.items.some(existing => existing.videoId === item.videoId)
    ) {
      return false;
    }

    this.items.unshift(item);

    this.emit("add", {
      track: cloneTrack(item),
      position: 0,
      next: true
    });

    return true;
  }

  addMany(tracks, options = {}) {
    const validTracks = normalizeTracks(tracks);

    if (!validTracks.length) return 0;

    const allowDuplicate = options.allowDuplicate !== false;

    const availableSlots = Math.max(
      0,
      this.maxQueueSize - this.items.length
    );

    if (availableSlots === 0) return 0;

    const existingIds = new Set(
      this.items.map(track => track.videoId)
    );

    const accepted = [];

    for (const track of validTracks) {
      if (
        !allowDuplicate &&
        existingIds.has(track.videoId)
      ) {
        continue;
      }

      accepted.push(track);

      if (!allowDuplicate) {
        existingIds.add(track.videoId);
      }

      if (accepted.length >= availableSlots) break;
    }

    if (!accepted.length) return 0;

    this.items.push(...accepted);

    this.emit("addMany", {
      tracks: accepted.map(cloneTrack),
      count: accepted.length
    });

    return accepted.length;
  }

  insertAfterCurrent(track) {
    return this.addNext(track);
  }

  /* =========================================
     07. REMOVE TRACKS
  ========================================= */

  remove(index) {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= this.items.length
    ) {
      return null;
    }

    const [removed] = this.items.splice(index, 1);

    this.emit("remove", {
      track: cloneTrack(removed),
      index
    });

    return cloneTrack(removed);
  }

  removeById(videoId) {
    const index = this.getPosition(videoId);

    if (index === -1) return null;

    return this.remove(index);
  }

  removeMany(indices = []) {
    if (!Array.isArray(indices)) return 0;

    const validIndices = [...new Set(indices)]
      .filter(index =>
        Number.isInteger(index) &&
        index >= 0 &&
        index < this.items.length
      )
      .sort((a, b) => b - a);

    if (!validIndices.length) return 0;

    const removed = [];

    for (const index of validIndices) {
      removed.push(this.items.splice(index, 1)[0]);
    }

    this.emit("removeMany", {
      tracks: removed.map(cloneTrack),
      count: removed.length
    });

    return removed.length;
  }

  clear() {
    if (!this.items.length) return false;

    const previousItems = this.getItems();

    this.items = [];
    this.originalOrder = null;
    this.shuffleEnabled = false;

    this.emit("clear", {
      tracks: previousItems
    });

    return true;
  }

  clearUpcoming() {
    return this.clear();
  }

  /* =========================================
     08. REORDERING
  ========================================= */

  move(from, to) {
    if (
      !Number.isInteger(from) ||
      !Number.isInteger(to) ||
      from < 0 ||
      to < 0 ||
      from >= this.items.length ||
      to >= this.items.length ||
      from === to
    ) {
      return false;
    }

    const [item] = this.items.splice(from, 1);

    this.items.splice(to, 0, item);

    this.emit("move", {
      track: cloneTrack(item),
      from,
      to
    });

    return true;
  }

  moveToTop(index) {
    return this.move(index, 0);
  }

  replaceQueue(tracks) {
    const validTracks = normalizeTracks(tracks)
      .slice(0, this.maxQueueSize);

    this.items = validTracks;
    this.originalOrder = null;
    this.shuffleEnabled = false;

    this.emit("replace", {
      tracks: this.getItems()
    });

    return this.items.length;
  }

  /* =========================================
     09. SHUFFLE
  ========================================= */

  shuffle() {
    if (this.items.length < 2) return false;

    if (!this.shuffleEnabled) {
      this.originalOrder = this.getItems();
    }

    this.items = shuffleArray(this.items);
    this.shuffleEnabled = true;

    this.emit("shuffle", {
      enabled: true
    });

    return true;
  }

  restoreOrder() {
    if (!this.originalOrder) return false;

    const currentIds = new Set(
      this.items.map(track => track.videoId)
    );

    const restored = [];

    for (const track of this.originalOrder) {
      if (currentIds.has(track.videoId)) {
        restored.push(cloneTrack(track));
        currentIds.delete(track.videoId);
      }
    }

    for (const track of this.items) {
      if (currentIds.has(track.videoId)) {
        restored.push(cloneTrack(track));
        currentIds.delete(track.videoId);
      }
    }

    this.items = restored;
    this.originalOrder = null;
    this.shuffleEnabled = false;

    this.emit("shuffle", {
      enabled: false
    });

    return true;
  }

  isShuffled() {
    return this.shuffleEnabled;
  }

  /* =========================================
     10. CURRENT TRACK
  ========================================= */

  setCurrent(track, options = {}) {
    if (track !== null && !isValid(track)) {
      return false;
    }

    const next = cloneTrack(track);

    if (
      this.current &&
      next &&
      this.current.videoId === next.videoId
    ) {
      this.current = next;
      return true;
    }

    if (this.current && options.saveHistory !== false) {
      this.pushHistory(this.current);
    }

    this.current = next;

    this.emit("current", {
      track: this.getCurrent()
    });

    return true;
  }

  /* =========================================
     11. HISTORY
  ========================================= */

  pushHistory(track) {
    if (!isValid(track)) return false;

    this.history.push(cloneTrack(track));

    if (this.history.length > this.maxHistorySize) {
      this.history.shift();
    }

    return true;
  }

  clearHistory() {
    if (!this.history.length) return false;

    this.history = [];

    this.emit("historyClear");

    return true;
  }

  /* =========================================
     12. PLAYBACK CONTROL
  ========================================= */

  takeNext() {
    if (this.repeat === "one" && this.current) {
      return this.getCurrent();
    }

    if (!this.items.length && this.repeat === "all") {
      this.restoreRepeatQueue();
    }

    if (!this.items.length) {
      return null;
    }

    const next = this.items.shift();

    if (this.current) {
      this.pushHistory(this.current);
    }

    this.current = cloneTrack(next);

    this.emit("play", {
      track: this.getCurrent()
    });

    return cloneTrack(next);
  }

  playNext() {
    return this.takeNext();
  }

  playPrevious() {
    if (!this.history.length) return null;

    const previous = this.history.pop();

    if (this.current) {
      this.items.unshift(cloneTrack(this.current));
    }

    this.current = cloneTrack(previous);

    this.trimQueue();

    this.emit("previous", {
      track: this.getCurrent()
    });

    return cloneTrack(previous);
  }

  peekNext() {
    if (this.items.length) {
      return cloneTrack(this.items[0]);
    }

    if (this.repeat === "one") {
      return this.getCurrent();
    }

    if (this.repeat === "all" && this.history.length) {
      return cloneTrack(this.history[0]);
    }

    return null;
  }

  restoreRepeatQueue() {
    if (!this.history.length) return false;

    this.items = this.history
      .filter(track =>
        !this.current ||
        track.videoId !== this.current.videoId
      )
      .map(cloneTrack)
      .filter(Boolean)
      .slice(0, this.maxQueueSize);

    if (!this.items.length) return false;

    this.history = [];

    return true;
  }

  trimQueue() {
    if (this.items.length > this.maxQueueSize) {
      this.items = this.items.slice(0, this.maxQueueSize);
    }
  }

  /* =========================================
     13. REPEAT MODE
  ========================================= */

  repeatMode(mode) {
    if (mode === undefined) {
      return this.repeat;
    }

    if (!CONFIG.VALID_REPEAT_MODES.includes(mode)) {
      return false;
    }

    if (this.repeat === mode) return true;

    this.repeat = mode;

    this.emit("repeat", {
      mode
    });

    return true;
  }

  getRepeatMode() {
    return this.repeat;
  }

  /* =========================================
     14. QUEUE INFORMATION
  ========================================= */

  getQueueDuration() {
    return this.items.reduce(
      (total, track) => total + getDuration(track),
      0
    );
  }

  getTotalDuration() {
    return this.getQueueDuration();
  }

  getCurrentPosition() {
    if (!this.current) return -1;

    return this.getPosition(this.current.videoId);
  }

  getSnapshot() {
    return {
      current: this.getCurrent(),
      items: this.getItems(),
      history: this.getHistory(),
      repeat: this.repeat,
      shuffle: this.shuffleEnabled,
      length: this.getLength(),
      duration: this.getQueueDuration()
    };
  }

  /* =========================================
     15. RESET
  ========================================= */

  reset() {
    this.items = [];
    this.current = null;
    this.history = [];

    this.repeat = CONFIG.DEFAULT_REPEAT_MODE;

    this.shuffleEnabled = false;
    this.originalOrder = null;

    this.emit("reset");

    return true;
  }

  /* =========================================
     16. DESTROY
  ========================================= */

  destroy() {
    this.listeners.clear();
    this.onChange = () => {};
  }
}
