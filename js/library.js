import { Storage as DefaultStorage } from "./storage.js";

/* =========================================================
   SHUNEL — MUSIC LIBRARY MANAGER 2.0

   Compatible con la API original:
     save, remove, toggleFavorite, isFavorite, addHistory,
     getLibrary, getFavorites, getHistory

   Cambios importantes respecto a 1.x
   - Los tracks son inmutables (Object.freeze). Para cambiarlos
     usa update(); asignar propiedades lanza TypeError.
   - save() sigue devolviendo boolean; saveTrack() devuelve un
     resultado { ok, status, track, reason, code }.
   - list() devuelve un array congelado sin copiar; getLibrary(),
     getFavorites() y getHistory() siguen devolviendo copias.
   - El historial se carga de forma perezosa.
   - Los datos antiguos se migran solos (con copia de respaldo).

   Formato en Storage: sigue siendo un array de tracks por
   colección. El esquema y los hashes de integridad viven aparte,
   bajo el prefijo "shunel:library:v2:".

   Funciones que NO están aquí porque dependen de otras piezas:
   API asíncrona/IndexedDB, compresión, Service Worker, UI,
   playlists, sincronización con backend y cola offline.
========================================================= */

/* =======================================================
   01. CONSTANTES
======================================================= */

export const SCHEMA_VERSION = 2;
export const PLACEHOLDER_THUMB = "/assets/placeholder.svg";
export const DEFAULT_TITLE = "Desconocido";
export const DEFAULT_CHANNEL = "Shunel";
export const HISTORY_LIMIT = 100;

export const LibraryEvents = Object.freeze({
  READY: "ready",
  CHANGE: "change",
  LIBRARY: "library",
  FAVORITES: "favorites",
  HISTORY: "history",
  BATCH: "batch",
  EXTERNAL: "external",
  ERROR: "error",
  STORAGE_UNAVAILABLE: "storage-unavailable"
});

export const ErrorCodes = Object.freeze({
  INVALID: "E_INVALID",
  DUPLICATE: "E_DUPLICATE",
  NOT_FOUND: "E_NOT_FOUND",
  LIMIT: "E_LIMIT",
  STORAGE: "E_STORAGE",
  CONFIRM: "E_CONFIRM",
  DISPOSED: "E_DISPOSED"
});

const E = ErrorCodes;
const KEYS = Object.freeze(["library", "favorites", "history"]);
const KIND_FIELD = Object.freeze({
  library: "savedAt",
  favorites: "favoritedAt",
  history: "playedAt"
});
const STORAGE_METHODS = Object.freeze({
  library: { read: "getLibrary", write: "saveLibrary" },
  favorites: { read: "getFavorites", write: "saveFavorites" },
  history: { read: "getHistory", write: "saveHistory" }
});
const PATCH_FIELDS = Object.freeze([
  "title", "channel", "thumbnail", "duration", "tags", "hasLyrics", "source"
]);
const SORT_KEYS = new Set([
  "title", "channel", "savedAt", "createdAt", "updatedAt", "favoritedAt",
  "playedAt", "lastPlayedAt", "duration", "playCount"
]);
const TIME_FIELDS = Object.freeze([
  "createdAt", "updatedAt", "savedAt", "favoritedAt", "playedAt",
  "lastPlayedAt", "pinned", "playCount"
]);

const FUTURE_TOLERANCE = 60_000;
const MAX_DURATION = 172_800;
const MAX_TAGS = 20;

export const DEFAULT_OPTIONS = Object.freeze({
  storage: null,
  kv: null,
  now: () => Date.now(),
  locale: undefined,

  historyLimit: HISTORY_LIMIT,
  libraryLimit: 5000,
  favoritesLimit: 2000,
  historyMaxAgeDays: 0,
  historyMaxBytes: 200_000,
  historyDedupeWindowMs: 3000,
  historyDebounceMs: 0,
  uniqueHistory: true,
  minPlaySeconds: 0,

  maxTitleLength: 200,
  maxChannelLength: 120,
  maxThumbnailLength: 2048,
  allowedThumbnailHosts: Object.freeze([
    "i.ytimg.com", "i9.ytimg.com", "img.youtube.com",
    "yt3.ggpht.com", "yt3.googleusercontent.com"
  ]),
  placeholderThumbnail: PLACEHOLDER_THUMB,
  defaultTitle: DEFAULT_TITLE,
  defaultChannel: DEFAULT_CHANNEL,
  cleanTitleNoise: false,

  favoriteAutoSaves: false,
  removeFavoritesWithLibrary: false,
  pruneHistoryOnRemove: false,
  trackPlaysInLibrary: false,

  integrity: true,
  syncTabs: true,
  channelName: "shunel:library",
  undoLimit: 20,
  slowOperationMs: 150,

  incognito: false,
  strict: false,
  debug: false,
  logger: typeof console !== "undefined" ? console : null,

  hooks: Object.freeze({ onError: null, onSave: null, onLoad: null }),
  messages: Object.freeze({
    invalidTrack: "El track no es válido",
    invalidId: "El videoId no es válido (11 caracteres: letras, números, _ o -)",
    duplicate: "La canción ya está en la biblioteca",
    notFound: "No se encontró la canción",
    libraryFull: "La biblioteca alcanzó su límite",
    favoritesFull: "La lista de favoritos alcanzó su límite",
    confirmRequired: "Pasa { confirm: true } para confirmar el borrado",
    storageFailed: "No se pudo guardar en el almacenamiento",
    disposed: "La biblioteca ya fue liberada",
    nothingToUndo: "No hay nada que deshacer"
  })
});

/* =======================================================
   02. TIPOS (JSDoc)
======================================================= */

/**
 * @typedef {Object} Track
 * @property {string} videoId
 * @property {string} title
 * @property {string} channel
 * @property {string} thumbnail
 * @property {string} [artist]       Derivado de "Artista - Canción".
 * @property {string} [song]
 * @property {number} [duration]     Segundos.
 * @property {readonly string[]} [tags]
 * @property {boolean} [hasLyrics]
 * @property {string} [source]
 * @property {boolean} [pinned]      Solo en favoritos.
 * @property {number} [playCount]
 * @property {number} [lastPlayedAt]
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {number} [savedAt]      Compatibilidad (biblioteca).
 * @property {number} [favoritedAt]  Compatibilidad (favoritos).
 * @property {number} [playedAt]     Compatibilidad (historial).
 */

/**
 * @typedef {Object} Result
 * @property {boolean} ok
 * @property {string} [code]   Uno de ErrorCodes cuando ok es false.
 * @property {string} [reason]
 */

export class LibraryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "LibraryError";
    this.code = code;
    this.details = details;
  }
}

/* =======================================================
   03. UTILIDADES PURAS
======================================================= */

const freeze = Object.freeze;
const EMPTY = freeze([]);

const CustomEventCtor =
  typeof CustomEvent === "function"
    ? CustomEvent
    : class extends Event {
        constructor(type, init = {}) {
          super(type);
          this.detail = init.detail;
        }
      };

function isObject(value) {
  return value !== null && typeof value === "object";
}

/** Lee una propiedad propia (ignora el prototipo). */
function pick(obj, key) {
  return isObject(obj) && Object.hasOwn(obj, key) ? obj[key] : undefined;
}

const ok = (extra = {}) => ({ ok: true, ...extra });
const fail = (code, reason, extra = {}) => ({ ok: false, code, reason, ...extra });

const nowMs = () => globalThis.performance?.now?.() ?? Date.now();

function positiveInt(value, fallback) {
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

function nonNegative(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function toTime(value) {
  if (value instanceof Date) return value.getTime();
  return Number(value);
}

function isQuotaError(error) {
  return (
    error?.name === "QuotaExceededError" ||
    error?.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    error?.code === 22 ||
    error?.code === 1014
  );
}

function hashOf(value) {
  const text = JSON.stringify(value) ?? "";
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

export function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

/** Minúsculas y sin tildes, para comparar y buscar. */
export function foldText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .trim();
}

const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === "#") {
      const code = entity[1].toLowerCase() === "x"
        ? parseInt(entity.slice(2), 16)
        : parseInt(entity.slice(1), 10);
      if (Number.isInteger(code) && code > 0 && code <= 0x10ffff) {
        return String.fromCodePoint(code);
      }
      return match;
    }
    const name = entity.toLowerCase();
    return Object.hasOwn(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : match;
  });
}

const INVISIBLE_RE =
  /[\u0000-\u001F\u007F-\u009F\u200B\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/**
 * Limpia texto: entidades HTML, Unicode NFC, caracteres de control y de
 * dirección (RTL override), comillas tipográficas y espacios múltiples.
 */
export function cleanText(value, max, { decode = true } = {}) {
  if (typeof value === "number" || typeof value === "boolean") value = String(value);
  if (typeof value !== "string" || !value) return "";

  let text = value.slice(0, max * 4);
  if (decode) text = decodeEntities(text);

  text = text
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .replace(INVISIBLE_RE, "")
    .replace(/[\u2018\u2019\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .trim();

  const chars = Array.from(text);
  if (chars.length > max) {
    text = `${chars.slice(0, Math.max(1, max - 1)).join("").trimEnd()}…`;
  }
  return text;
}

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export function normalizeVideoId(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const id = String(value).trim();
  return VIDEO_ID_RE.test(id) ? id : null;
}

function toId(input) {
  return isObject(input)
    ? normalizeVideoId(pick(input, "videoId"))
    : normalizeVideoId(input);
}

function normalizeTime(value, now) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return value > now + FUTURE_TOLERANCE ? now : Math.round(value);
}

function parseDuration(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 && value <= MAX_DURATION
      ? Math.round(value)
      : undefined;
  }
  if (typeof value === "string") {
    const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i.exec(value.trim());
    if (m && (m[1] || m[2] || m[3])) {
      const seconds = (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
      return seconds <= MAX_DURATION ? seconds : undefined;
    }
  }
  return undefined;
}

function normalizeTags(value) {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set();
  const out = [];
  for (const raw of value) {
    const tag = cleanText(raw, 32, { decode: false });
    const key = foldText(tag);
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out.length ? freeze(out) : undefined;
}

function pickApiThumbnail(thumbs) {
  if (!isObject(thumbs)) return undefined;
  for (const key of ["high", "medium", "standard", "maxres", "default"]) {
    const url = pick(pick(thumbs, key), "url");
    if (typeof url === "string" && url) return url;
  }
  return undefined;
}

function sanitizeThumbnail(raw, videoId, o) {
  const fallback = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  if (isObject(raw)) raw = pickApiThumbnail(raw);
  if (typeof raw !== "string") return fallback;

  const value = raw.trim();
  if (!value || value.length > o.maxThumbnailLength) return fallback;
  if (value === o.placeholderThumbnail) return value;

  // Ruta local relativa (nunca "//host" ni "/\host").
  if (value.startsWith("/") && !/^\/[/\\]/.test(value)) return value;

  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return fallback;
    if (!o.allowedThumbnailHosts.includes(url.hostname.toLowerCase())) return fallback;
    return url.href;
  } catch {
    return fallback;
  }
}

const NOISE_RE =
  /\s*[([]\s*(?:official\s+)?(?:music\s+)?(?:video|audio|lyric\s+video|lyrics?|visualizer|video\s+oficial|audio\s+oficial|letra)\s*[)\]]/gi;
const ARTIST_SONG_RE = /^(.{1,80}?)\s[-–—]\s(.{1,200})$/u;

/** Clave canónica para detectar el mismo tema subido varias veces. */
export function canonicalKey(track) {
  const clean = text =>
    foldText(text)
      .replace(/[([][^)\]]*[)\]]/g, " ")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  return `${clean(track.artist || track.channel)}|${clean(track.song || track.title)}`;
}

/**
 * Normaliza cualquier entrada (formato de la app o de la API de YouTube).
 * Solo lee una lista blanca de campos; el resto se descarta.
 * @returns {{ok:true, track:Track}|{ok:false, code:string, reason:string}}
 */
export function normalizeTrack(input, o, now, kind = "library", { touch = false } = {}) {
  if (!isObject(input)) {
    return fail(E.INVALID, o.messages.invalidTrack);
  }

  const snippet = pick(input, "snippet");
  const idField = pick(input, "id");
  const videoId = normalizeVideoId(
    pick(input, "videoId") ?? pick(idField, "videoId") ?? idField
  );
  if (!videoId) return fail(E.INVALID, o.messages.invalidId);

  const titleRaw = pick(input, "title") ?? pick(input, "name") ?? pick(snippet, "title");
  const channelRaw =
    pick(input, "channel") ?? pick(input, "artist") ?? pick(snippet, "channelTitle");
  const thumbRaw =
    pick(input, "thumbnail") ??
    pick(input, "thumbnailUrl") ??
    pick(input, "image") ??
    pickApiThumbnail(pick(snippet, "thumbnails") ?? pick(input, "thumbnails"));

  let title = cleanText(titleRaw, o.maxTitleLength);
  title = title.replace(/^[\p{Extended_Pictographic}\uFE0F\s]+/u, "").trim();
  if (o.cleanTitleNoise) title = title.replace(NOISE_RE, "").trim();
  title = title || o.defaultTitle;

  let channel = cleanText(channelRaw, o.maxChannelLength)
    .replace(/\s*-\s*topic$/i, "")
    .replace(/\s*(?:vevo|official)$/i, "")
    .trim();
  channel = channel || o.defaultChannel;

  const t = { videoId, title, channel };
  t.thumbnail = sanitizeThumbnail(thumbRaw, videoId, o);

  const split = ARTIST_SONG_RE.exec(title);
  if (split) {
    t.artist = split[1].trim();
    t.song = split[2].trim();
  }

  const duration = parseDuration(
    pick(input, "duration") ?? pick(pick(input, "contentDetails"), "duration")
  );
  if (duration !== undefined) t.duration = duration;

  const tags = normalizeTags(pick(input, "tags"));
  if (tags) t.tags = tags;

  const hasLyrics = pick(input, "hasLyrics");
  if (typeof hasLyrics === "boolean") t.hasLyrics = hasLyrics;

  const source =
    cleanText(pick(input, "source"), 24, { decode: false }) ||
    (isObject(snippet) ? "youtube-api" : "");
  if (source) t.source = source;

  if (kind === "favorites" && pick(input, "pinned") === true) t.pinned = true;

  const pc = pick(input, "playCount");
  if (Number.isInteger(pc) && pc > 0) t.playCount = Math.min(pc, 1_000_000);
  else if (kind === "history") t.playCount = 1;

  const lastPlayedAt = normalizeTime(pick(input, "lastPlayedAt"), now);
  if (lastPlayedAt !== undefined) t.lastPlayedAt = lastPlayedAt;

  const legacy = normalizeTime(pick(input, KIND_FIELD[kind]), now);
  let createdAt;
  let updatedAt;

  if (kind === "history") {
    const playedAt = legacy ?? lastPlayedAt ?? now;
    createdAt = Math.min(normalizeTime(pick(input, "createdAt"), now) ?? playedAt, playedAt);
    updatedAt = touch ? now : normalizeTime(pick(input, "updatedAt"), now) ?? playedAt;
    t.lastPlayedAt = playedAt;
    t.playedAt = playedAt;
  } else {
    createdAt = normalizeTime(pick(input, "createdAt"), now) ?? legacy ?? now;
    updatedAt = touch ? now : normalizeTime(pick(input, "updatedAt"), now) ?? createdAt;
    t[KIND_FIELD[kind]] = createdAt;
  }

  t.createdAt = createdAt;
  t.updatedAt = Math.max(updatedAt, createdAt);

  return { ok: true, track: freeze(t) };
}

function stripTimes(input) {
  if (!isObject(input)) return input;
  const copy = { ...input };
  for (const field of TIME_FIELDS) delete copy[field];
  return copy;
}

function without(list, idSet) {
  return list.some(t => idSet.has(t.videoId))
    ? freeze(list.filter(t => !idSet.has(t.videoId)))
    : list;
}

function indexBy(list) {
  const map = new Map();
  for (const t of list) if (!map.has(t.videoId)) map.set(t.videoId, t);
  return map;
}

function partitionPinned(list) {
  const pinned = list.filter(t => t.pinned);
  if (!pinned.length || pinned.length === list.length) return list;
  return [...pinned, ...list.filter(t => !t.pinned)];
}

function insertAfterPinned(list, track) {
  const i = list.findIndex(t => !t.pinned);
  const at = i < 0 ? list.length : i;
  return freeze([...list.slice(0, at), track, ...list.slice(at)]);
}

function withinDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return false;
    prev = cur;
  }
  return prev[b.length] <= max;
}

function localDayKey(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function resolveOptions(user) {
  const src = isObject(user) ? user : {};
  const o = { ...DEFAULT_OPTIONS, ...src };

  o.hooks = { ...DEFAULT_OPTIONS.hooks, ...(isObject(src.hooks) ? src.hooks : {}) };
  o.messages = { ...DEFAULT_OPTIONS.messages, ...(isObject(src.messages) ? src.messages : {}) };

  for (const k of [
    "historyLimit", "libraryLimit", "favoritesLimit", "maxTitleLength",
    "maxChannelLength", "maxThumbnailLength", "undoLimit"
  ]) o[k] = positiveInt(o[k], DEFAULT_OPTIONS[k]);

  for (const k of [
    "historyMaxAgeDays", "historyMaxBytes", "historyDedupeWindowMs",
    "historyDebounceMs", "minPlaySeconds", "slowOperationMs"
  ]) o[k] = nonNegative(o[k], DEFAULT_OPTIONS[k]);

  o.allowedThumbnailHosts = Array.isArray(o.allowedThumbnailHosts)
    ? o.allowedThumbnailHosts.filter(h => typeof h === "string").map(h => h.toLowerCase())
    : [...DEFAULT_OPTIONS.allowedThumbnailHosts];

  if (typeof o.now !== "function") o.now = DEFAULT_OPTIONS.now;
  return o;
}

function createKV(namespace) {
  const memory = new Map();
  let ls = null;

  try {
    const store = globalThis.localStorage;
    if (store) {
      const probe = `${namespace}__probe`;
      store.setItem(probe, "1");
      store.removeItem(probe);
      ls = store;
    }
  } catch {
    ls = null;
  }

  return {
    available: ls !== null,
    get(key) {
      try {
        if (ls) {
          const raw = ls.getItem(namespace + key);
          return raw ? JSON.parse(raw) : null;
        }
      } catch { /* cae a memoria */ }
      return memory.get(key) ?? null;
    },
    set(key, value) {
      memory.set(key, value);
      if (ls) {
        try {
          ls.setItem(namespace + key, JSON.stringify(value));
        } catch {
          return false;
        }
      }
      return true;
    }
  };
}

/** Storage en memoria con la misma interfaz que ./storage.js (útil para pruebas). */
export function createMemoryStorage(initial = {}) {
  const data = {
    library: initial.library ?? [],
    favorites: initial.favorites ?? [],
    history: initial.history ?? []
  };
  return {
    data,
    getLibrary: () => structuredClone(data.library),
    getFavorites: () => structuredClone(data.favorites),
    getHistory: () => structuredClone(data.history),
    saveLibrary: v => { data.library = structuredClone(v); },
    saveFavorites: v => { data.favorites = structuredClone(v); },
    saveHistory: v => { data.history = structuredClone(v); }
  };
}

/* =======================================================
   04. CLASE PRINCIPAL
======================================================= */

export class MusicLibrary extends EventTarget {
  #o;
  #storage;
  #now;
  #kv;
  #id;
  #collator;
  #segmenter;

  #library = EMPTY;
  #favorites = EMPTY;
  #history = EMPTY;
  #maps = { library: new Map(), favorites: new Map(), history: new Map() };
  #historyLoaded = false;
  #ready = false;
  #disposed = false;
  #version = 0;

  #batchDepth = 0;
  #batchSnap = null;
  #batchChanged = new Set();
  #batchEvents = [];
  #batchUndoable = false;
  #undo = [];

  #incognito = false;
  #historyPaused = false;
  #memoryOnly = false;
  #historyDirty = false;
  #historyTimer = null;

  #lastError = null;
  #stats = {
    saved: 0, rejected: 0, duplicates: 0, removed: 0,
    saves: 0, failures: 0, quotaTrims: 0, loads: 0, plays: 0
  };
  #rejections = [];
  #integrityWarnings = [];
  #loadInfo = null;

  #abort = new AbortController();
  #channel = null;
  #cacheVersion = -1;
  #searchCache = new Map();
  #positionCache = new Map();
  #keyCache = new WeakMap();

  /**
   * @param {Partial<typeof DEFAULT_OPTIONS>} [options]
   */
  constructor(options = {}) {
    super();
    this.#o = resolveOptions(options);
    this.#storage = this.#o.storage ?? DefaultStorage;
    this.#now = this.#o.now;
    this.#kv = this.#o.kv ?? createKV(`shunel:library:v${SCHEMA_VERSION}:`);
    this.#id = `${Number(this.#now()).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.#incognito = Boolean(this.#o.incognito);

    try {
      this.#collator = new Intl.Collator(this.#o.locale, { sensitivity: "base", numeric: true });
    } catch {
      this.#collator = { compare: (a, b) => (a < b ? -1 : a > b ? 1 : 0) };
    }
    try {
      this.#segmenter = typeof Intl.Segmenter === "function"
        ? new Intl.Segmenter(this.#o.locale, { granularity: "word" })
        : null;
    } catch {
      this.#segmenter = null;
    }

    this.#historyPaused = this.#kv.get("meta")?.historyPaused === true;

    this.load();
    this.#bindLifecycle();
  }

  static create(options) {
    return new MusicLibrary(options);
  }

  /** Crea una biblioteca desde datos exportados. Pasa `storage` para no pisar el real. */
  static fromJSON(data, options) {
    const lib = new MusicLibrary(options);
    lib.importData(data, { mode: "replace" });
    return lib;
  }

  static normalizeTrack(input, options) {
    return normalizeTrack(input, resolveOptions(options), Date.now(), "library");
  }

  static normalizeVideoId = normalizeVideoId;
  static escapeHTML = escapeHTML;
  static foldText = foldText;
  static canonicalKey = canonicalKey;

  /** Prueba de rendimiento en memoria. */
  static benchmark(count = 10_000) {
    const lib = new MusicLibrary({
      storage: createMemoryStorage(), syncTabs: false, integrity: false,
      libraryLimit: Math.max(count, DEFAULT_OPTIONS.libraryLimit)
    });
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
    const items = Array.from({ length: count }, (_, i) => {
      let n = i;
      let id = "";
      for (let k = 0; k < 11; k++) { id += alphabet[n % 64]; n = Math.floor(n / 64); }
      return { videoId: id, title: `Canción ${i}`, channel: `Canal ${i % 50}` };
    });
    const time = fn => { const t = nowMs(); fn(); return Math.round(nowMs() - t); };
    const out = {};
    out.saveManyMs = time(() => lib.saveMany(items));
    out.searchMs = time(() => lib.search("cancion 99"));
    out.sortMs = time(() => lib.sortBy("title"));
    out.size = lib.size;
    lib.dispose();
    return out;
  }

  /* -----------------------------------------------------
     Carga
  ----------------------------------------------------- */

  get ready() { return this.#ready; }

  /** Vuelve a leer todo desde Storage. */
  load() {
    return this.#timed("load", () => {
      const t0 = nowMs();
      const meta = this.#kv.get("meta");
      this.#integrityWarnings = [];

      const lib = this.#readCollection("library", meta);
      const fav = this.#readCollection("favorites", meta);

      this.#library = lib.items;
      this.#favorites = fav.items;
      this.#history = EMPTY;
      this.#historyLoaded = false;
      this.#reindex();
      this.#version++;
      this.#undo.length = 0;

      this.#finishAdopt("library", lib);
      this.#finishAdopt("favorites", fav);

      this.#stats.loads++;
      const durationMs = Math.round(nowMs() - t0);
      this.#loadInfo = {
        durationMs,
        library: lib.items.length,
        favorites: fav.items.length,
        discarded: lib.discarded + fav.discarded,
        duplicates: lib.duplicates + fav.duplicates,
        migrated: lib.legacy + fav.legacy,
        reasons: [...lib.reasons, ...fav.reasons].slice(0, 10)
      };
      this.#ready = true;

      try { this.#o.hooks.onLoad?.({ ...this.#loadInfo }); } catch { /* hook */ }
      this.#dispatch(LibraryEvents.READY, { ...this.#loadInfo });
      return { ...this.#loadInfo };
    });
  }

  reload() {
    return this.load();
  }

  #readCollection(key, meta) {
    let raw = [];
    try {
      const value = this.#storage[STORAGE_METHODS[key].read]();
      raw = Array.isArray(value) ? value : [];
    } catch (error) {
      this.#recordFailure(error, key, "read");
    }

    const stored = meta?.hash?.[key];
    if (this.#o.integrity && stored && hashOf(raw) !== stored) {
      this.#integrityWarnings.push(key);
    }

    return { ...this.#normalizeList(raw, key), raw };
  }

  #normalizeList(raw, kind) {
    const now = this.#now();
    const res = {
      items: EMPTY, discarded: 0, duplicates: 0, legacy: 0,
      trimmed: false, reasons: [], needsRewrite: false
    };
    const parsed = [];

    for (const item of raw) {
      const n = normalizeTrack(item, this.#o, now, kind);
      if (!n.ok) {
        res.discarded++;
        if (res.reasons.length < 10) res.reasons.push(n.reason);
        continue;
      }
      if (isObject(item) && !Object.hasOwn(item, "createdAt")) res.legacy++;
      parsed.push(n.track);
    }

    if (kind === "history") parsed.sort((a, b) => b.playedAt - a.playedAt);

    const unique = kind !== "history" || this.#o.uniqueHistory;
    const seen = new Set();
    let out = [];
    for (const t of parsed) {
      if (unique) {
        if (seen.has(t.videoId)) { res.duplicates++; continue; }
        seen.add(t.videoId);
      }
      out.push(t);
    }

    if (kind === "favorites") out = partitionPinned(out);

    const limit = this.#limit(kind);
    if (out.length > limit) {
      out = out.slice(0, limit);
      res.trimmed = true;
    }

    res.items = freeze(out);
    res.needsRewrite = res.discarded > 0 || res.duplicates > 0 || res.legacy > 0 || res.trimmed;
    return res;
  }

  /** Si los datos venían en formato antiguo o dañados, respalda y reescribe. */
  #finishAdopt(key, res) {
    if (!res.needsRewrite || this.#incognito) return;
    this.#backup(key, res.raw);
    const written = this.#writeCollection(key, { allowRevert: false });
    if (written.ok) this.#updateMeta([key]);
    this.#log("info", `Colección "${key}" migrada/reparada`, {
      legacy: res.legacy, discarded: res.discarded, duplicates: res.duplicates
    });
  }

  #ensureHistory() {
    if (this.#historyLoaded) return;
    this.#historyLoaded = true;
    const res = this.#readCollection("history", this.#kv.get("meta"));
    this.#history = res.items;
    this.#reindex();
    this.#finishAdopt("history", res);
    if (this.#o.historyMaxAgeDays > 0) this.pruneHistory();
  }

  #limit(kind) {
    return kind === "library"
      ? this.#o.libraryLimit
      : kind === "favorites"
        ? this.#o.favoritesLimit
        : this.#o.historyLimit;
  }

  /* -----------------------------------------------------
     Estado interno
  ----------------------------------------------------- */

  #coll(key) {
    switch (key) {
      case "library": return this.#library;
      case "favorites": return this.#favorites;
      case "history": return this.#history;
      default: throw new TypeError(`Colección desconocida: ${key}`);
    }
  }

  #listFor(name) {
    if (name === "history") this.#ensureHistory();
    return this.#coll(name);
  }

  #state() {
    return { library: this.#library, favorites: this.#favorites, history: this.#history };
  }

  #applyState(s) {
    this.#library = s.library;
    this.#favorites = s.favorites;
    this.#history = s.history;
    this.#reindex();
    this.#version++;
  }

  #reindex() {
    this.#maps = {
      library: indexBy(this.#library),
      favorites: indexBy(this.#favorites),
      history: this.#historyLoaded ? indexBy(this.#history) : new Map()
    };
  }

  #syncCaches() {
    if (this.#cacheVersion === this.#version) return;
    this.#cacheVersion = this.#version;
    this.#searchCache.clear();
    this.#positionCache.clear();
  }

  #msg(key) {
    return this.#o.messages[key] ?? key;
  }

  #fail(code, msgKey, extra = {}) {
    return fail(code, this.#msg(msgKey), extra);
  }

  #out(result, op) {
    if (!result.ok) {
      if (result.code === E.DUPLICATE) this.#stats.duplicates++;
      else if (result.code === E.INVALID) this.#stats.rejected++;
      this.#rejections.push({
        at: this.#now(), op, code: result.code, reason: result.reason,
        videoId: result.videoId
      });
      if (this.#rejections.length > 20) this.#rejections.shift();
      if (this.#o.strict) throw new LibraryError(result.code, result.reason, result);
    }
    return result;
  }

  #log(level, message, data) {
    const order = { debug: 0, info: 1, warn: 2, error: 3 };
    if (order[level] < (this.#o.debug ? 0 : 2)) return;
    try {
      const logger = this.#o.logger;
      const fn = logger?.[level] ?? logger?.log;
      fn?.call(logger, `[MusicLibrary] ${message}`, ...(data === undefined ? [] : [data]));
    } catch { /* el logger nunca debe romper la biblioteca */ }
  }

  #timed(name, fn) {
    const t0 = nowMs();
    try {
      return fn();
    } finally {
      const d = nowMs() - t0;
      try { globalThis.performance?.mark?.(`shunel:library:${name}`); } catch { /* opcional */ }
      if (d > this.#o.slowOperationMs) this.#log("warn", `${name} tardó ${d.toFixed(1)} ms`);
    }
  }

  #dispatch(name, detail) {
    try {
      this.dispatchEvent(new CustomEventCtor(name, { detail }));
    } catch (error) {
      this.#log("warn", `Error al emitir "${name}"`, error?.message);
    }
  }

  /* -----------------------------------------------------
     Commit, persistencia y eventos
  ----------------------------------------------------- */

  #commit(action, next, detail = {}, { undoable = true } = {}) {
    if (this.#disposed) return this.#fail(E.DISPOSED, "disposed");

    const before = this.#state();
    const after = { ...before, ...next };
    const changed = KEYS.filter(k => after[k] !== before[k]);
    if (!changed.length) return ok({ changed, noop: true });

    this.#applyState(after);

    if (this.#batchDepth > 0) {
      changed.forEach(k => this.#batchChanged.add(k));
      if (undoable) this.#batchUndoable = true;
      this.#batchEvents.push({ action, changed, ...detail });
      return ok({ changed, deferred: true });
    }

    const persisted = this.#persist(changed);
    if (!persisted.ok && persisted.revert) {
      this.#applyState(before);
      return this.#fail(E.STORAGE, "storageFailed", { error: persisted.error });
    }

    if (undoable) this.#pushUndo(action, before, changed);
    this.#emitChange(action, changed, before, after, detail);
    if (this.#o.debug) this.#debugValidate();

    return ok({ changed, persisted: persisted.ok });
  }

  #persist(keys) {
    if (this.#incognito) return { ok: true, skipped: true };

    const written = [];
    for (const key of keys) {
      if (key === "history" && this.#o.historyDebounceMs > 0) {
        this.#scheduleHistorySave();
        continue;
      }
      const r = this.#writeCollection(key);
      if (!r.ok) return r;
      written.push(key);
    }

    if (written.length) {
      this.#updateMeta(written);
      this.#broadcast(written);
    }
    return { ok: true };
  }

  #writeCollection(key, { allowRevert = true } = {}) {
    const method = STORAGE_METHODS[key].write;
    let trimmed = false;

    for (;;) {
      try {
        this.#storage[method]([...this.#coll(key)]);
        this.#stats.saves++;
        this.#memoryOnly = false;
        try {
          this.#o.hooks.onSave?.({ collection: key, count: this.#coll(key).length });
        } catch { /* hook */ }
        return { ok: true };
      } catch (error) {
        if (isQuotaError(error)) {
          if (!trimmed && this.#history.length > 1) {
            trimmed = true;
            this.#history = freeze(this.#history.slice(0, Math.floor(this.#history.length / 2)));
            this.#reindex();
            this.#stats.quotaTrims++;
            this.#log("warn", "Cuota llena: se recortó el historial a la mitad");
            if (key !== "history") {
              try {
                this.#storage.saveHistory([...this.#history]);
                this.#updateMeta(["history"]);
              } catch { /* se reintenta la colección original */ }
            }
            continue;
          }
          this.#recordFailure(error, key, "write");
          return { ok: false, revert: allowRevert, quota: true, error };
        }

        this.#recordFailure(error, key, "write");
        if (!this.#memoryOnly) {
          this.#memoryOnly = true;
          this.#dispatch(LibraryEvents.STORAGE_UNAVAILABLE, { error: this.#lastError });
        }
        return { ok: false, revert: false, error };
      }
    }
  }

  #recordFailure(error, key, phase) {
    this.#lastError = {
      code: E.STORAGE,
      collection: key,
      phase,
      name: error?.name,
      message: String(error?.message ?? error),
      at: this.#now()
    };
    this.#stats.failures++;
    this.#log("warn", `Fallo de almacenamiento (${phase}:${key})`, error?.name);
    try { this.#o.hooks.onError?.({ ...this.#lastError }); } catch { /* hook */ }
    this.#dispatch(LibraryEvents.ERROR, { ...this.#lastError });
  }

  #updateMeta(keys) {
    const meta = this.#kv.get("meta") ?? {};
    meta.schemaVersion = SCHEMA_VERSION;
    meta.historyPaused = this.#historyPaused;
    meta.updatedAt = this.#now();
    meta.hash = { ...(meta.hash ?? {}) };
    if (this.#o.integrity) {
      for (const k of keys) meta.hash[k] = hashOf(this.#coll(k));
    }
    this.#kv.set("meta", meta);
  }

  #backup(key, data) {
    try {
      this.#kv.set(`backup:${key}`, { at: this.#now(), data });
    } catch { /* el respaldo es opcional */ }
  }

  /** Último respaldo hecho antes de una migración o reparación. */
  getBackup(collection) {
    return this.#kv.get(`backup:${collection}`)?.data ?? null;
  }

  #broadcast(keys) {
    try {
      this.#channel?.postMessage({ type: "changed", sender: this.#id, keys });
    } catch { /* opcional */ }
  }

  #scheduleHistorySave() {
    this.#historyDirty = true;
    if (this.#historyTimer !== null) return;
    this.#historyTimer = setTimeout(() => {
      this.#historyTimer = null;
      this.flush();
    }, this.#o.historyDebounceMs);
    this.#historyTimer?.unref?.();
  }

  /** Fuerza el guardado pendiente (historial diferido). */
  flush() {
    if (this.#historyTimer !== null) {
      clearTimeout(this.#historyTimer);
      this.#historyTimer = null;
    }
    if (!this.#historyDirty) return ok({ flushed: false });
    this.#historyDirty = false;

    const r = this.#writeCollection("history", { allowRevert: false });
    if (r.ok) {
      this.#updateMeta(["history"]);
      this.#broadcast(["history"]);
      return ok({ flushed: true });
    }
    return this.#out(this.#fail(E.STORAGE, "storageFailed", { error: r.error }), "flush");
  }

  #emitChange(action, changed, before, after, detail) {
    for (const key of changed) {
      this.#dispatch(LibraryEvents[key.toUpperCase()], {
        action, collection: key, before: before[key], after: after[key], ...detail
      });
    }
    this.#dispatch(LibraryEvents.CHANGE, { action, changed, before, after, ...detail });
  }

  #pushUndo(action, before, changed) {
    const prev = {};
    for (const k of changed) prev[k] = before[k];
    this.#undo.push({ action, prev });
    if (this.#undo.length > this.#o.undoLimit) this.#undo.shift();
  }

  #bindLifecycle() {
    const { signal } = this.#abort;
    try {
      globalThis.addEventListener?.("pagehide", () => this.flush(), { signal });
      globalThis.document?.addEventListener?.("visibilitychange", () => {
        if (globalThis.document.visibilityState === "hidden") this.flush();
      }, { signal });
    } catch { /* entorno sin eventos de página */ }

    if (this.#o.syncTabs && typeof BroadcastChannel === "function") {
      try {
        this.#channel = new BroadcastChannel(this.#o.channelName);
        this.#channel.unref?.();
        this.#channel.onmessage = event => {
          const data = event?.data;
          if (data?.type === "changed" && data.sender !== this.#id) this.#onExternal(data);
        };
      } catch {
        this.#channel = null;
      }
    }
  }

  #onExternal(data) {
    if (this.#incognito || this.#disposed || this.#batchDepth > 0) return;
    const before = this.#state();
    this.load();
    const after = this.#state();
    this.#dispatch(LibraryEvents.EXTERNAL, { keys: data.keys, before, after });
    this.#dispatch(LibraryEvents.CHANGE, { action: "external", changed: data.keys, before, after });
  }

  #debugValidate() {
    const errors = this.validate().issues.filter(i => i.severity === "error");
    if (errors.length) this.#log("error", "Invariantes rotas", errors.slice(0, 5));
  }

  /** Libera listeners, timers y el canal entre pestañas. */
  dispose() {
    if (this.#disposed) return;
    this.flush();
    this.#disposed = true;
    this.#abort.abort();
    try { this.#channel?.close(); } catch { /* ya cerrado */ }
    this.#channel = null;
  }

  /* -----------------------------------------------------
     Eventos
  ----------------------------------------------------- */

  /** @returns {() => void} función para darse de baja */
  subscribe(name, fn) {
    const handler = event => fn(event.detail, event);
    this.addEventListener(name, handler);
    return () => this.removeEventListener(name, handler);
  }

  once(name, fn) {
    const off = this.subscribe(name, (detail, event) => {
      off();
      fn(detail, event);
    });
    return off;
  }

  /* -----------------------------------------------------
     Lotes y deshacer
  ----------------------------------------------------- */

  /**
   * Agrupa varios cambios en un solo guardado y un solo evento.
   * Si `fn` lanza (o el guardado falla) se restaura el estado anterior.
   * `fn` debe ser síncrona.
   */
  batch(fn) {
    if (typeof fn !== "function") throw new TypeError("batch() requiere una función");
    const outermost = this.#batchDepth === 0;

    if (outermost) {
      this.#ensureHistory();
      this.#batchSnap = this.#state();
      this.#batchChanged = new Set();
      this.#batchEvents = [];
      this.#batchUndoable = false;
    }

    this.#batchDepth++;
    let value;
    try {
      value = fn(this);
    } catch (error) {
      this.#batchDepth--;
      if (outermost) {
        this.#applyState(this.#batchSnap);
        this.#batchSnap = null;
      }
      throw error;
    }
    this.#batchDepth--;

    if (!outermost) return value;

    const before = this.#batchSnap;
    const after = this.#state();
    const changed = KEYS.filter(k => after[k] !== before[k]);
    const events = this.#batchEvents;
    const undoable = this.#batchUndoable;
    this.#batchSnap = null;
    this.#batchEvents = [];

    if (!changed.length) return value;

    const persisted = this.#persist(changed);
    if (!persisted.ok && persisted.revert) {
      this.#applyState(before);
      throw new LibraryError(E.STORAGE, this.#msg("storageFailed"), { error: persisted.error });
    }

    if (undoable) this.#pushUndo("batch", before, changed);

    for (const key of changed) {
      this.#dispatch(LibraryEvents[key.toUpperCase()], {
        action: "batch", collection: key, before: before[key], after: after[key]
      });
    }
    this.#dispatch(LibraryEvents.BATCH, { changed, actions: events, before, after });
    this.#dispatch(LibraryEvents.CHANGE, { action: "batch", changed, before, after });
    return value;
  }

  get canUndo() { return this.#undo.length > 0; }

  clearUndo() { this.#undo.length = 0; }

  /** Deshace el último cambio (solo las colecciones que ese cambio tocó). */
  undo() {
    const entry = this.#undo.pop();
    if (!entry) return this.#out(this.#fail(E.NOT_FOUND, "nothingToUndo"), "undo");
    const r = this.#commit("undo", entry.prev, { undone: entry.action }, { undoable: false });
    if (!r.ok) this.#undo.push(entry);
    return this.#out({ ...r, undone: entry.action }, "undo");
  }

  /* -----------------------------------------------------
     Biblioteca: escritura
  ----------------------------------------------------- */

  /**
   * Guarda un track.
   * @param {object} input
   * @param {{bump?: boolean}} [opts] bump: si ya existe, súbelo al principio.
   * @returns {Result & {status: "saved"|"duplicate"|"invalid"|"limit", track?: Track}}
   */
  saveTrack(input, { bump = false } = {}) {
    const n = normalizeTrack(stripTimes(input), this.#o, this.#now(), "library");
    if (!n.ok) return this.#out({ ...n, status: "invalid" }, "saveTrack");

    const { track } = n;
    const existing = this.#maps.library.get(track.videoId);

    if (existing) {
      if (bump) {
        const r = this.moveToTop(track.videoId);
        return { ...r, status: "duplicate", bumped: r.ok, track: existing };
      }
      return this.#out(
        this.#fail(E.DUPLICATE, "duplicate", {
          status: "duplicate", track: existing, videoId: track.videoId
        }),
        "saveTrack"
      );
    }

    if (this.#library.length >= this.#o.libraryLimit) {
      return this.#out(this.#fail(E.LIMIT, "libraryFull", { status: "limit" }), "saveTrack");
    }

    const r = this.#commit(
      "save", { library: freeze([track, ...this.#library]) }, { videoId: track.videoId }
    );
    if (r.ok) this.#stats.saved++;
    return this.#out({ ...r, status: r.ok ? "saved" : "invalid", track }, "saveTrack");
  }

  /** Compatible con 1.x: devuelve true si se guardó. Acepta un array. */
  save(trackOrTracks, opts) {
    if (Array.isArray(trackOrTracks)) return this.saveMany(trackOrTracks).saved.length > 0;
    return this.saveTrack(trackOrTracks, opts).ok;
  }

  /**
   * Guarda varios tracks con un solo guardado. El primero del array queda arriba.
   * @returns {Result & {saved: Track[], duplicates: string[], invalid: object[], overflow: string[]}}
   */
  saveMany(items) {
    return this.#timed("saveMany", () => {
      if (!Array.isArray(items)) {
        return this.#out(
          this.#fail(E.INVALID, "invalidTrack", { saved: [], duplicates: [], invalid: [], overflow: [] }),
          "saveMany"
        );
      }

      const now = this.#now();
      const seen = new Set(this.#maps.library.keys());
      const room = this.#o.libraryLimit - this.#library.length;
      const saved = [];
      const duplicates = [];
      const invalid = [];
      const overflow = [];

      items.forEach((item, index) => {
        const n = normalizeTrack(stripTimes(item), this.#o, now, "library");
        if (!n.ok) { invalid.push({ index, reason: n.reason }); return; }
        const id = n.track.videoId;
        if (seen.has(id)) { duplicates.push(id); return; }
        if (saved.length >= room) { overflow.push(id); return; }
        seen.add(id);
        saved.push(n.track);
      });

      let committed = ok({ changed: [] });
      if (saved.length) {
        committed = this.#commit(
          "saveMany", { library: freeze([...saved, ...this.#library]) }, { count: saved.length }
        );
      }
      this.#stats.saved += committed.ok ? saved.length : 0;
      this.#stats.duplicates += duplicates.length;
      this.#stats.rejected += invalid.length;

      return this.#out(
        { ...committed, saved: committed.ok ? saved : [], duplicates, invalid, overflow },
        "saveMany"
      );
    });
  }

  #removalPlan(idSet) {
    const next = { library: without(this.#library, idSet) };
    if (this.#o.removeFavoritesWithLibrary) next.favorites = without(this.#favorites, idSet);
    if (this.#o.pruneHistoryOnRemove) {
      this.#ensureHistory();
      next.history = without(this.#history, idSet);
    }
    return next;
  }

  /** @returns {Result & {track?: Track}} */
  removeTrack(input) {
    const id = toId(input);
    if (!id) return this.#out(this.#fail(E.INVALID, "invalidId"), "remove");

    const existing = this.#maps.library.get(id);
    if (!existing) {
      return this.#out(this.#fail(E.NOT_FOUND, "notFound", { videoId: id }), "remove");
    }

    const r = this.#commit("remove", this.#removalPlan(new Set([id])), { videoId: id });
    if (r.ok) this.#stats.removed++;
    return this.#out({ ...r, track: existing }, "remove");
  }

  /** Compatible con 1.x. Acepta un track o un videoId. */
  remove(input) {
    return this.removeTrack(input).ok;
  }

  /** @returns {string[]} los IDs realmente eliminados */
  removeMany(ids) {
    if (!Array.isArray(ids)) return [];
    const wanted = new Set(ids.map(toId).filter(Boolean));
    const removed = this.#library.filter(t => wanted.has(t.videoId)).map(t => t.videoId);
    if (!removed.length) return [];

    const r = this.#commit("removeMany", this.#removalPlan(new Set(removed)), { count: removed.length });
    this.#out(r, "removeMany");
    if (!r.ok) return [];
    this.#stats.removed += removed.length;
    return removed;
  }

  /** Cambia campos permitidos y propaga los cambios a favoritos e historial. */
  update(input, patch) {
    const id = toId(input);
    if (!id) return this.#out(this.#fail(E.INVALID, "invalidId"), "update");
    if (!isObject(patch)) return this.#out(this.#fail(E.INVALID, "invalidTrack"), "update");

    const allowed = {};
    for (const field of PATCH_FIELDS) {
      if (Object.hasOwn(patch, field)) allowed[field] = patch[field];
    }

    this.#ensureHistory();
    const now = this.#now();
    const next = {};
    let updated = null;

    for (const key of KEYS) {
      if (!this.#maps[key].has(id)) continue;
      const fields = { ...allowed };
      if (key !== "library") delete fields.tags;

      const apply = t => {
        const n = normalizeTrack({ ...t, ...fields }, this.#o, now, key, { touch: true });
        return n.ok ? n.track : t;
      };
      next[key] = freeze(this.#coll(key).map(t => (t.videoId === id ? apply(t) : t)));
      if (key === "library") updated = apply(this.#maps.library.get(id));
    }

    if (!Object.keys(next).length) {
      return this.#out(this.#fail(E.NOT_FOUND, "notFound", { videoId: id }), "update");
    }
    const r = this.#commit("update", next, { videoId: id });
    return this.#out({ ...r, track: updated }, "update");
  }

  addTag(input, tag) {
    const track = this.getById(input);
    if (!track) return this.#out(this.#fail(E.NOT_FOUND, "notFound"), "addTag");
    return this.update(track.videoId, { tags: [...(track.tags ?? []), tag] });
  }

  removeTag(input, tag) {
    const track = this.getById(input);
    if (!track) return this.#out(this.#fail(E.NOT_FOUND, "notFound"), "removeTag");
    const key = foldText(tag);
    return this.update(track.videoId, {
      tags: (track.tags ?? []).filter(t => foldText(t) !== key)
    });
  }

  getByTag(tag) {
    const key = foldText(tag);
    return this.#library.filter(t => t.tags?.some(x => foldText(x) === key));
  }

  /** @returns {{tag: string, count: number}[]} */
  getTags() {
    const counts = new Map();
    for (const t of this.#library) {
      for (const tag of t.tags ?? []) {
        const key = foldText(tag);
        const entry = counts.get(key) ?? { tag, count: 0 };
        entry.count++;
        counts.set(key, entry);
      }
    }
    return [...counts.values()].sort(
      (a, b) => b.count - a.count || this.#collator.compare(a.tag, b.tag)
    );
  }

  /**
   * Mueve un track delante de otro (o al final si targetId es null).
   * @param {"library"|"favorites"} [collection]
   */
  moveBefore(input, targetId = null, collection = "library") {
    if (collection !== "library" && collection !== "favorites") {
      throw new TypeError('Solo se puede reordenar "library" o "favorites"');
    }
    const id = toId(input);
    const target = targetId == null ? null : toId(targetId);
    const list = [...this.#coll(collection)];
    const from = list.findIndex(t => t.videoId === id);
    if (!id || from < 0) return this.#out(this.#fail(E.NOT_FOUND, "notFound"), "moveBefore");

    const [item] = list.splice(from, 1);
    let to = list.length;
    if (target !== null) {
      to = list.findIndex(t => t.videoId === target);
      if (to < 0) return this.#out(this.#fail(E.NOT_FOUND, "notFound"), "moveBefore");
    }
    list.splice(to, 0, item);

    const next = collection === "favorites" ? partitionPinned(list) : list;
    const unchanged = next.every((t, i) => t === this.#coll(collection)[i]);
    if (unchanged) return ok({ changed: [], noop: true });

    const r = this.#commit("move", { [collection]: freeze(next) }, { videoId: id });
    return this.#out(r, "moveBefore");
  }

  moveToTop(input, collection = "library") {
    const first = this.#coll(collection)[0];
    if (!first) return this.#out(this.#fail(E.NOT_FOUND, "notFound"), "moveToTop");
    if (toId(input) === first.videoId) return ok({ changed: [], noop: true });
    return this.moveBefore(input, first.videoId, collection);
  }

  /**
   * Reemplaza una colección entera tras validarla.
   * Por defecto falla si alguna entrada es inválida.
   */
  replaceAll(tracks, { allowInvalid = false, collection = "library" } = {}) {
    return this.#timed("replaceAll", () => {
      if (!Array.isArray(tracks)) {
        return this.#out(this.#fail(E.INVALID, "invalidTrack"), "replaceAll");
      }
      if (collection === "history") this.#ensureHistory();
      const res = this.#normalizeList(tracks, collection);

      if (!allowInvalid && res.discarded > 0) {
        return this.#out(
          this.#fail(E.INVALID, "invalidTrack", { invalid: res.discarded, reasons: res.reasons }),
          "replaceAll"
        );
      }
      const r = this.#commit("replaceAll", { [collection]: res.items }, { count: res.items.length });
      return this.#out({ ...r, count: res.items.length, discarded: res.discarded }, "replaceAll");
    });
  }

  /**
   * Fusiona datos de otra biblioteca o de un export.
   * @param {"keep-local"|"keep-remote"|"newest"} [strategy]
   */
  merge(other, strategy = "newest") {
    return this.#timed("merge", () => {
      if (!["keep-local", "keep-remote", "newest"].includes(strategy)) {
        throw new TypeError(`Estrategia desconocida: ${strategy}`);
      }
      const data = other instanceof MusicLibrary ? other.exportData() : other;
      if (!isObject(data)) return this.#out(this.#fail(E.INVALID, "invalidTrack"), "merge");

      const summary = { added: 0, updated: 0, kept: 0 };
      const next = {};

      for (const key of KEYS) {
        if (!Array.isArray(data[key])) continue;
        if (key === "history") this.#ensureHistory();

        const incoming = this.#normalizeList(data[key], key).items;
        const local = this.#coll(key);
        const localMap = this.#maps[key];
        const fresh = [];
        const replace = new Map();

        for (const remote of incoming) {
          const mine = localMap.get(remote.videoId);
          if (!mine) { fresh.push(remote); summary.added++; continue; }
          const takeRemote =
            strategy === "keep-remote" ||
            (strategy === "newest" && remote.updatedAt > mine.updatedAt);
          if (takeRemote) { replace.set(remote.videoId, remote); summary.updated++; }
          else summary.kept++;
        }
        if (!fresh.length && !replace.size) continue;

        fresh.sort((a, b) => b.createdAt - a.createdAt);
        let merged = [...fresh, ...local.map(t => replace.get(t.videoId) ?? t)];
        if (key === "history") merged.sort((a, b) => b.playedAt - a.playedAt);
        if (key === "favorites") merged = partitionPinned(merged);
        next[key] = freeze(merged.slice(0, this.#limit(key)));
      }

      if (!Object.keys(next).length) return ok({ ...summary, changed: [] });
      const r = this.#commit("merge", next, summary);
      return this.#out({ ...r, ...summary }, "merge");
    });
  }

  /** Elimina duplicados por videoId en todas las colecciones. */
  dedupe() {
    this.#ensureHistory();
    const next = {};
    let removed = 0;

    for (const key of KEYS) {
      if (key === "history" && !this.#o.uniqueHistory) continue;
      const seen = new Set();
      const list = this.#coll(key);
      const out = list.filter(t => {
        if (seen.has(t.videoId)) return false;
        seen.add(t.videoId);
        return true;
      });
      if (out.length !== list.length) {
        removed += list.length - out.length;
        next[key] = freeze(out);
      }
    }
    if (!removed) return ok({ removed: 0 });
    const r = this.#commit("dedupe", next, { removed });
    return this.#out({ ...r, removed: r.ok ? removed : 0 }, "dedupe");
  }

  clearLibrary({ confirm = false } = {}) {
    if (confirm !== true) return this.#out(this.#fail(E.CONFIRM, "confirmRequired"), "clearLibrary");
    const removed = this.#library.length;
    const ids = new Set(this.#library.map(t => t.videoId));
    const next = this.#removalPlan(ids);
    next.library = EMPTY;
    const r = this.#commit("clearLibrary", next, { removed });
    return this.#out({ ...r, removed: r.ok ? removed : 0 }, "clearLibrary");
  }

  /* -----------------------------------------------------
     Favoritos
  ----------------------------------------------------- */

  /**
   * Marca o desmarca un favorito de forma idempotente.
   * Un favorito no necesita estar en la biblioteca (a menos que actives favoriteAutoSaves).
   * @returns {Result & {favorite: boolean, changed: boolean, track: Track|null}}
   */
  setFavorite(input, value = true) {
    const id = toId(input);
    if (!id) return this.#out(this.#fail(E.INVALID, "invalidId"), "setFavorite");

    const existing = this.#maps.favorites.get(id);
    if (Boolean(value) === Boolean(existing)) {
      return ok({ favorite: Boolean(existing), changed: false, track: existing ?? null });
    }

    if (!value) {
      const r = this.#commit(
        "favorite",
        { favorites: without(this.#favorites, new Set([id])) },
        { videoId: id, favorite: false }
      );
      return this.#out({ ...r, favorite: false, changed: r.ok, track: existing }, "setFavorite");
    }

    if (this.#favorites.length >= this.#o.favoritesLimit) {
      return this.#out(this.#fail(E.LIMIT, "favoritesFull"), "setFavorite");
    }

    const libTrack = this.#maps.library.get(id);
    let source;
    if (isObject(input)) source = { ...stripTimes(libTrack ?? {}), ...stripTimes(input) };
    else source = libTrack;

    if (!source) {
      return this.#out(this.#fail(E.NOT_FOUND, "notFound", { videoId: id }), "setFavorite");
    }

    const now = this.#now();
    const n = normalizeTrack(stripTimes(source), this.#o, now, "favorites");
    if (!n.ok) return this.#out(n, "setFavorite");

    const next = { favorites: insertAfterPinned(this.#favorites, n.track) };
    if (
      this.#o.favoriteAutoSaves &&
      !libTrack &&
      this.#library.length < this.#o.libraryLimit
    ) {
      const ln = normalizeTrack(stripTimes(source), this.#o, now, "library");
      if (ln.ok) next.library = freeze([ln.track, ...this.#library]);
    }

    const r = this.#commit("favorite", next, { videoId: id, favorite: true });
    return this.#out({ ...r, favorite: true, changed: r.ok, track: n.track }, "setFavorite");
  }

  /** Compatible con 1.x: true si quedó como favorito. Acepta un track o un videoId. */
  toggleFavorite(input) {
    const id = toId(input);
    if (!id) return false;
    const r = this.setFavorite(input, !this.#maps.favorites.has(id));
    return r.ok && r.favorite;
  }

  /** @returns {Result & {favorite: boolean, track: Track|null}} */
  toggleFavoriteDetailed(input) {
    const id = toId(input);
    if (!id) return this.#out(this.#fail(E.INVALID, "invalidId"), "toggleFavorite");
    return this.setFavorite(input, !this.#maps.favorites.has(id));
  }

  removeFavorite(input) {
    const r = this.setFavorite(input, false);
    return r.ok && r.changed;
  }

  isFavorite(input) {
    const id = toId(input);
    return id !== null && this.#maps.favorites.has(id);
  }

  /** @returns {Set<string>} */
  getFavoriteIds() {
    return new Set(this.#maps.favorites.keys());
  }

  /** Fija o desfija un favorito (los fijados van primero). */
  setPinned(input, value = true) {
    const id = toId(input);
    const existing = id ? this.#maps.favorites.get(id) : null;
    if (!existing) return this.#out(this.#fail(E.NOT_FOUND, "notFound"), "setPinned");
    if (Boolean(existing.pinned) === Boolean(value)) return ok({ changed: [], noop: true });

    const n = normalizeTrack(
      { ...existing, pinned: Boolean(value) }, this.#o, this.#now(), "favorites", { touch: true }
    );
    if (!n.ok) return this.#out(n, "setPinned");

    const rest = this.#favorites.filter(t => t.videoId !== id);
    const favorites = value
      ? freeze([n.track, ...rest])
      : insertAfterPinned(rest, n.track);
    const r = this.#commit("pin", { favorites }, { videoId: id, pinned: Boolean(value) });
    return this.#out({ ...r, track: n.track }, "setPinned");
  }

  clearFavorites({ confirm = false } = {}) {
    if (confirm !== true) return this.#out(this.#fail(E.CONFIRM, "confirmRequired"), "clearFavorites");
    const removed = this.#favorites.length;
    const r = this.#commit("clearFavorites", { favorites: EMPTY }, { removed });
    return this.#out({ ...r, removed: r.ok ? removed : 0 }, "clearFavorites");
  }

  /** Favoritos que ya no están en la biblioteca. */
  getOrphanFavorites() {
    return this.#favorites.filter(t => !this.#maps.library.has(t.videoId));
  }

  /* -----------------------------------------------------
     Historial
  ----------------------------------------------------- */

  /**
   * Registra una reproducción.
   * @param {object} input
   * @param {{playedSeconds?: number, force?: boolean}} [opts]
   * @returns {Track|null} la entrada creada (o la existente si fue una repetición inmediata)
   */
  addHistory(input, { playedSeconds, force = false } = {}) {
    if (this.#incognito || this.#historyPaused) return null;

    if (
      !force &&
      this.#o.minPlaySeconds > 0 &&
      typeof playedSeconds === "number" &&
      playedSeconds < this.#o.minPlaySeconds
    ) return null;

    this.#ensureHistory();
    const now = this.#now();
    const n = normalizeTrack(stripTimes(input), this.#o, now, "history");
    if (!n.ok) { this.#out(n, "addHistory"); return null; }

    const id = n.track.videoId;
    const newest = this.#history[0];

    if (
      newest &&
      newest.videoId === id &&
      now - newest.playedAt < this.#o.historyDedupeWindowMs
    ) return newest;

    // Si el reloj retrocede, se conserva el orden.
    const playedAt = Math.max(now, newest?.playedAt ?? 0);
    const unique = this.#o.uniqueHistory;
    const prev = unique ? this.#maps.history.get(id) : null;

    const entry = freeze({
      ...n.track,
      playedAt,
      lastPlayedAt: playedAt,
      createdAt: prev?.createdAt ?? playedAt,
      updatedAt: playedAt,
      playCount: (prev?.playCount ?? 0) + 1
    });

    let list = unique
      ? [entry, ...this.#history.filter(h => h.videoId !== id)]
      : [entry, ...this.#history];

    list = list.slice(0, this.#o.historyLimit);

    if (this.#o.historyMaxAgeDays > 0) {
      const cutoff = now - this.#o.historyMaxAgeDays * 86_400_000;
      list = list.filter(h => h.playedAt >= cutoff);
    }

    if (this.#o.historyMaxBytes > 0) {
      let bytes = 0;
      let keep = 0;
      for (const h of list) {
        bytes += JSON.stringify(h).length;
        if (bytes > this.#o.historyMaxBytes && keep > 0) break;
        keep++;
      }
      list = list.slice(0, keep);
    }

    const next = { history: freeze(list) };
    const libTrack = this.#maps.library.get(id);
    if (this.#o.trackPlaysInLibrary && libTrack) {
      const n2 = normalizeTrack(
        { ...libTrack, lastPlayedAt: playedAt, playCount: (libTrack.playCount ?? 0) + 1 },
        this.#o, now, "library"
      );
      if (n2.ok) next.library = freeze(this.#library.map(t => (t.videoId === id ? n2.track : t)));
    }

    const r = this.#commit("history", next, { videoId: id }, { undoable: false });
    if (!r.ok) return null;
    this.#stats.plays++;
    return entry;
  }

  removeFromHistory(input) {
    const id = toId(input);
    if (!id) return this.#out(this.#fail(E.INVALID, "invalidId"), "removeFromHistory");
    this.#ensureHistory();
    const next = without(this.#history, new Set([id]));
    const removed = this.#history.length - next.length;
    if (!removed) return ok({ removed: 0 });
    const r = this.#commit("removeFromHistory", { history: next }, { videoId: id });
    return this.#out({ ...r, removed: r.ok ? removed : 0 }, "removeFromHistory");
  }

  /**
   * Borra el historial. Sin `before` exige confirm: true.
   * @param {{confirm?: boolean, before?: number|Date}} [opts]
   */
  clearHistory({ confirm = false, before } = {}) {
    if (before === undefined && confirm !== true) {
      return this.#out(this.#fail(E.CONFIRM, "confirmRequired"), "clearHistory");
    }
    this.#ensureHistory();

    let kept = EMPTY;
    if (before !== undefined) {
      const limit = toTime(before);
      if (!Number.isFinite(limit)) return this.#out(this.#fail(E.INVALID, "invalidTrack"), "clearHistory");
      kept = freeze(this.#history.filter(h => h.playedAt >= limit));
    }
    const removed = this.#history.length - kept.length;
    if (!removed) return ok({ removed: 0 });
    const r = this.#commit("clearHistory", { history: kept }, { removed });
    return this.#out({ ...r, removed: r.ok ? removed : 0 }, "clearHistory");
  }

  /** Borra entradas más viejas que maxAgeMs (por defecto historyMaxAgeDays). */
  pruneHistory(maxAgeMs = this.#o.historyMaxAgeDays * 86_400_000) {
    this.#ensureHistory();
    if (!(maxAgeMs > 0)) return ok({ removed: 0 });
    const cutoff = this.#now() - maxAgeMs;
    const kept = this.#history.filter(h => h.playedAt >= cutoff);
    const removed = this.#history.length - kept.length;
    if (!removed) return ok({ removed: 0 });
    const r = this.#commit("pruneHistory", { history: freeze(kept) }, { removed }, { undoable: false });
    return this.#out({ ...r, removed: r.ok ? removed : 0 }, "pruneHistory");
  }

  setHistoryPaused(value) {
    this.#historyPaused = Boolean(value);
    this.#updateMeta([]);
    return this.#historyPaused;
  }

  get historyPaused() { return this.#historyPaused; }

  isHistoryPaused() { return this.#historyPaused; }

  /** Copia mutable del historial, con filtros y paginación opcionales. */
  getHistory({ limit, offset = 0, from, to } = {}) {
    this.#ensureHistory();
    let list = this.#history;
    if (from !== undefined) { const t = toTime(from); list = list.filter(h => h.playedAt >= t); }
    if (to !== undefined) { const t = toTime(to); list = list.filter(h => h.playedAt <= t); }
    return list.slice(offset, limit === undefined ? undefined : offset + limit);
  }

  getLastPlayed() {
    this.#ensureHistory();
    return this.#history[0] ?? null;
  }

  getRecentlyPlayed(n = 10) {
    this.#ensureHistory();
    return this.#history.slice(0, n);
  }

  /** @returns {{track: Track, playCount: number, lastPlayedAt: number}[]} */
  getMostPlayed(n = 10) {
    this.#ensureHistory();
    const agg = new Map();
    for (const h of this.#history) {
      const count = h.playCount ?? 1;
      const entry = agg.get(h.videoId);
      if (entry) {
        entry.playCount += count;
        entry.lastPlayedAt = Math.max(entry.lastPlayedAt, h.playedAt);
      } else {
        agg.set(h.videoId, { track: h, playCount: count, lastPlayedAt: h.playedAt });
      }
    }
    return [...agg.values()]
      .sort((a, b) => b.playCount - a.playCount || b.lastPlayedAt - a.lastPlayedAt)
      .slice(0, n);
  }

  /** @returns {{date: string, entries: Track[]}[]} fechas locales YYYY-MM-DD, la más reciente primero */
  getHistoryByDay() {
    this.#ensureHistory();
    const groups = [];
    for (const h of this.#history) {
      const date = localDayKey(h.playedAt);
      const last = groups[groups.length - 1];
      if (last && last.date === date) last.entries.push(h);
      else groups.push({ date, entries: [h] });
    }
    return groups;
  }

  /** Días consecutivos con reproducciones (limitado por el tamaño del historial). */
  getListeningStreak() {
    this.#ensureHistory();
    const day = ts => Math.floor((ts - new Date(ts).getTimezoneOffset() * 60_000) / 86_400_000);
    const days = new Set(this.#history.map(h => day(h.playedAt)));
    let cursor = day(this.#now());
    if (!days.has(cursor)) cursor--;
    let streak = 0;
    while (days.has(cursor)) { streak++; cursor--; }
    return streak;
  }

  /** @returns {{channel: string, plays: number}[]} */
  getTopChannels(n = 5) {
    this.#ensureHistory();
    const counts = new Map();
    for (const h of this.#history) {
      const key = foldText(h.channel);
      const entry = counts.get(key) ?? { channel: h.channel, plays: 0 };
      entry.plays += h.playCount ?? 1;
      counts.set(key, entry);
    }
    return [...counts.values()]
      .sort((a, b) => b.plays - a.plays || this.#collator.compare(a.channel, b.channel))
      .slice(0, n);
  }

  /* -----------------------------------------------------
     Consultas
  ----------------------------------------------------- */

  /** Array congelado (sin copiar). Es la forma más barata de leer la biblioteca. */
  list() { return this.#library; }

  /** @deprecated Usa list(). Devuelve una copia mutable. */
  getLibrary() { return [...this.#library]; }

  getFavorites() { return [...this.#favorites]; }

  get size() { return this.#library.length; }
  get count() { return this.#library.length; }
  get favoritesCount() { return this.#favorites.length; }
  get historyCount() { this.#ensureHistory(); return this.#history.length; }
  get isEmpty() { return this.#library.length === 0; }
  get hasFavorites() { return this.#favorites.length > 0; }
  get incognito() { return this.#incognito; }

  *[Symbol.iterator]() {
    yield* this.#library;
  }

  isInLibrary(input) {
    const id = toId(input);
    return id !== null && this.#maps.library.has(id);
  }

  has(input) { return this.isInLibrary(input); }

  getById(input) {
    const id = toId(input);
    return id ? this.#maps.library.get(id) ?? null : null;
  }

  find(predicate) {
    return this.#library.find(predicate);
  }

  /**
   * @param {Function|{favorite?: boolean, channel?: string, from?: number|Date, to?: number|Date, tag?: string, query?: string}} criteria
   */
  filter(criteria = {}) {
    if (typeof criteria === "function") return this.#library.filter(criteria);
    const { favorite, channel, from, to, tag, query } = criteria;
    const base = query ? this.search(query, { limit: Infinity }) : this.#library;
    const ch = channel ? foldText(channel) : null;
    const tg = tag ? foldText(tag) : null;
    const t0 = from === undefined ? null : toTime(from);
    const t1 = to === undefined ? null : toTime(to);

    return base.filter(t =>
      (favorite === undefined || this.#maps.favorites.has(t.videoId) === favorite) &&
      (!ch || foldText(t.channel) === ch) &&
      (t0 === null || t.createdAt >= t0) &&
      (t1 === null || t.createdAt <= t1) &&
      (!tg || t.tags?.some(x => foldText(x) === tg))
    );
  }

  getByChannel(channel) {
    return this.filter({ channel });
  }

  /** @returns {{channel: string, count: number}[]} */
  getChannels() {
    const counts = new Map();
    for (const t of this.#library) {
      const key = foldText(t.channel);
      const entry = counts.get(key) ?? { channel: t.channel, count: 0 };
      entry.count++;
      counts.set(key, entry);
    }
    return [...counts.values()].sort(
      (a, b) => b.count - a.count || this.#collator.compare(a.channel, b.channel)
    );
  }

  getRecentlyAdded(n = 10) {
    return this.sortBy("createdAt", "desc").slice(0, n);
  }

  getPage(page = 1, size = 50, { collection = "library" } = {}) {
    const list = this.#listFor(collection);
    const pageSize = positiveInt(size, 50);
    const totalPages = Math.max(1, Math.ceil(list.length / pageSize));
    const current = Math.min(Math.max(1, Math.floor(page) || 1), totalPages);
    const start = (current - 1) * pageSize;
    return {
      items: list.slice(start, start + pageSize),
      page: current,
      pageSize,
      total: list.length,
      totalPages
    };
  }

  /**
   * Devuelve una copia ordenada. El orden es estable: los empates se
   * resuelven por videoId y luego por posición original.
   */
  sortBy(key = "createdAt", direction = "asc", collection = "library") {
    if (!SORT_KEYS.has(key)) throw new TypeError(`Clave de orden no válida: ${key}`);
    const dir = direction === "desc" ? -1 : 1;
    const text = key === "title" || key === "channel";

    return this.#listFor(collection)
      .map((t, i) => ({ t, i }))
      .sort((a, b) => {
        const va = a.t[key];
        const vb = b.t[key];
        if (va === undefined || vb === undefined) {
          if (va === vb) return a.i - b.i;
          return va === undefined ? 1 : -1;
        }
        const c = text ? this.#collator.compare(va, vb) : va - vb;
        if (c !== 0) return c * dir;
        if (a.t.videoId !== b.t.videoId) return a.t.videoId < b.t.videoId ? -1 : 1;
        return a.i - b.i;
      })
      .map(x => x.t);
  }

  #tokenize(text) {
    if (this.#segmenter) {
      return [...this.#segmenter.segment(text)]
        .filter(s => s.isWordLike)
        .map(s => s.segment);
    }
    return text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  }

  #searchEntry(track) {
    let entry = this.#keyCache.get(track);
    if (!entry) {
      const text = foldText(
        [track.title, track.channel, track.artist, ...(track.tags ?? [])]
          .filter(Boolean)
          .join(" ")
      );
      entry = { text, words: [...new Set(this.#tokenize(text))] };
      this.#keyCache.set(track, entry);
    }
    return entry;
  }

  /**
   * Búsqueda sin tildes ni mayúsculas, por palabras, con puntuación de
   * relevancia y tolerancia a errores de escritura.
   */
  search(query, { limit = 50, collection = "library", fuzzy = true } = {}) {
    const q = foldText(cleanText(query, 200, { decode: false }));
    if (!q) return [];

    const list = this.#listFor(collection);
    this.#syncCaches();

    const cacheKey = `${collection}|${fuzzy}|${limit}|${q}`;
    const cached = this.#searchCache.get(cacheKey);
    if (cached) return [...cached];

    const tokens = this.#tokenize(q);
    if (!tokens.length) return [];

    const scored = [];
    list.forEach((track, index) => {
      const entry = this.#searchEntry(track);
      let score = 0;

      for (const token of tokens) {
        let best = 0;
        for (const word of entry.words) {
          if (word === token) { best = 3; break; }
          if (word.startsWith(token)) { if (best < 2) best = 2; continue; }
          if (best < 1) {
            if (word.includes(token)) best = 1;
            else if (
              fuzzy && token.length >= 4 && word.length <= 64 &&
              withinDistance(word, token, token.length >= 8 ? 2 : 1)
            ) best = 1;
          }
        }
        if (!best) return;
        score += best;
      }

      if (entry.text.startsWith(q)) score += 2;
      else if (entry.text.includes(q)) score += 1;
      scored.push({ track, index, score });
    });

    scored.sort((a, b) => b.score - a.score || a.index - b.index);
    const result = scored.slice(0, limit).map(x => x.track);

    if (this.#searchCache.size >= 50) this.#searchCache.delete(this.#searchCache.keys().next().value);
    this.#searchCache.set(cacheKey, result);
    return [...result];
  }

  /** Elementos al azar sin repetir. */
  getRandom(n = 1, { collection = "library" } = {}) {
    const pool = [...this.#listFor(collection)];
    const count = Math.min(Math.max(0, Math.floor(n)), pool.length);
    for (let i = 0; i < count; i++) {
      const j = i + Math.floor(Math.random() * (pool.length - i));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, count);
  }

  #positions(collection) {
    this.#syncCaches();
    let map = this.#positionCache.get(collection);
    if (!map) {
      map = new Map();
      this.#listFor(collection).forEach((t, i) => { if (!map.has(t.videoId)) map.set(t.videoId, i); });
      this.#positionCache.set(collection, map);
    }
    return map;
  }

  indexOf(input, collection = "library") {
    const id = toId(input);
    return id ? this.#positions(collection).get(id) ?? -1 : -1;
  }

  /** previous = posición anterior en la lista, next = la siguiente. */
  getNeighbors(input, collection = "library") {
    const index = this.indexOf(input, collection);
    if (index < 0) return { index, previous: null, next: null };
    const list = this.#coll(collection);
    return { index, previous: list[index - 1] ?? null, next: list[index + 1] ?? null };
  }

  /** Biblioteca con `isFavorite` calculado (objetos nuevos y mutables). */
  getLibraryWithFlags() {
    return this.#library.map(t => ({ ...t, isFavorite: this.#maps.favorites.has(t.videoId) }));
  }

  /** Mismo tema con distinto videoId (por artista + título normalizados). */
  findSimilar(input, { collection = "library" } = {}) {
    const n = normalizeTrack(stripTimes(input), this.#o, this.#now(), "library");
    if (!n.ok) return [];
    const target = canonicalKey(n.track);
    return this.#listFor(collection).filter(
      t => t.videoId !== n.track.videoId && canonicalKey(t) === target
    );
  }

  getStats() {
    this.#ensureHistory();
    let plays = 0;
    for (const h of this.#history) plays += h.playCount ?? 1;
    return {
      library: this.#library.length,
      favorites: this.#favorites.length,
      pinned: this.#favorites.filter(t => t.pinned).length,
      orphanFavorites: this.getOrphanFavorites().length,
      history: this.#history.length,
      totalPlays: plays,
      channels: this.getChannels().length,
      topChannel: this.getChannels()[0]?.channel ?? null,
      tags: this.getTags().length
    };
  }

  /* -----------------------------------------------------
     Exportar, importar y copias
  ----------------------------------------------------- */

  exportData({ includeHistory = true } = {}) {
    const data = {
      application: "Shunel Music Library",
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date(this.#now()).toISOString(),
      library: [...this.#library],
      favorites: [...this.#favorites]
    };
    if (includeHistory) {
      this.#ensureHistory();
      data.history = [...this.#history];
    }
    return data;
  }

  toJSON() { return this.exportData(); }

  /**
   * @param {object|Array} data  Objeto exportado, o un array de tracks.
   * @param {{mode?: "merge"|"replace", strategy?: string}} [opts]
   */
  importData(data, { mode = "merge", strategy = "newest" } = {}) {
    const payload = Array.isArray(data) ? { library: data } : data;
    if (!isObject(payload)) return this.#out(this.#fail(E.INVALID, "invalidTrack"), "importData");

    if (mode === "merge") return this.merge(payload, strategy);

    try {
      this.batch(() => {
        for (const key of KEYS) {
          if (Array.isArray(payload[key])) {
            this.replaceAll(payload[key], { allowInvalid: true, collection: key });
          }
        }
      });
      return ok({ mode });
    } catch (error) {
      if (error instanceof LibraryError) {
        return this.#out(fail(error.code, error.message), "importData");
      }
      throw error;
    }
  }

  /** Copia del estado completo. Restáurala con restore(). */
  snapshot() {
    return this.exportData({ includeHistory: true });
  }

  restore(snapshot) {
    return this.importData(snapshot, { mode: "replace" });
  }

  /* -----------------------------------------------------
     Consistencia y reparación
  ----------------------------------------------------- */

  /** @returns {{ok: boolean, issues: {severity: string, code: string, collection: string, videoId?: string, message: string}[]}} */
  validate() {
    const issues = [];
    const now = this.#now();
    const push = (severity, code, collection, videoId, message) =>
      issues.push({ severity, code, collection, videoId, message });

    for (const key of KEYS) {
      if (key === "history" && !this.#historyLoaded) continue;
      const list = this.#coll(key);
      const unique = key !== "history" || this.#o.uniqueHistory;
      const seen = new Set();

      for (const t of list) {
        if (!normalizeVideoId(t.videoId)) push("error", "invalid-id", key, t.videoId, "videoId inválido");
        if (unique && seen.has(t.videoId)) push("error", "duplicate", key, t.videoId, "videoId duplicado");
        seen.add(t.videoId);

        for (const f of ["createdAt", "updatedAt"]) {
          if (!Number.isFinite(t[f]) || t[f] <= 0 || t[f] > now + FUTURE_TOLERANCE) {
            push("error", "invalid-date", key, t.videoId, `${f} inválido`);
          }
        }
        if (t.updatedAt < t.createdAt) push("error", "date-order", key, t.videoId, "updatedAt < createdAt");
      }

      if (list.length > this.#limit(key)) push("error", "over-limit", key, undefined, "supera el límite");

      if (key === "favorites") {
        let sawUnpinned = false;
        for (const t of list) {
          if (!t.pinned) sawUnpinned = true;
          else if (sawUnpinned) { push("error", "pin-order", key, t.videoId, "fijado después de no fijados"); break; }
        }
      }

      if (unique && this.#maps[key].size !== new Set(list.map(t => t.videoId)).size) {
        push("error", "index-mismatch", key, undefined, "el índice no coincide con la lista");
      }
    }

    for (const t of this.#favorites) {
      const lib = this.#maps.library.get(t.videoId);
      if (!lib) { push("info", "orphan", "favorites", t.videoId, "favorito fuera de la biblioteca"); continue; }
      if (lib.title !== t.title || lib.channel !== t.channel || lib.thumbnail !== t.thumbnail) {
        push("warn", "metadata-mismatch", "favorites", t.videoId, "metadatos distintos a la biblioteca");
      }
    }

    return { ok: !issues.some(i => i.severity === "error"), issues };
  }

  /** Corrige lo que validate() reporta como error y sincroniza metadatos. */
  repair() {
    this.#ensureHistory();
    const now = this.#now();
    const next = {};

    for (const key of KEYS) {
      const current = this.#coll(key);
      const res = this.#normalizeList(current, key);
      if (JSON.stringify(res.items) !== JSON.stringify(current)) next[key] = res.items;
    }

    // Sincroniza metadatos con la versión más reciente de cada track.
    const lists = {
      library: next.library ?? this.#library,
      favorites: next.favorites ?? this.#favorites,
      history: next.history ?? this.#history
    };
    const latest = new Map();
    for (const key of KEYS) {
      for (const t of lists[key]) {
        const best = latest.get(t.videoId);
        if (!best || t.updatedAt > best.updatedAt) latest.set(t.videoId, t);
      }
    }
    for (const key of KEYS) {
      let changed = false;
      const out = lists[key].map(t => {
        const best = latest.get(t.videoId);
        if (
          best === t ||
          (best.title === t.title && best.channel === t.channel && best.thumbnail === t.thumbnail)
        ) return t;
        const n = normalizeTrack(
          { ...t, title: best.title, channel: best.channel, thumbnail: best.thumbnail, updatedAt: best.updatedAt },
          this.#o, now, key
        );
        if (!n.ok) return t;
        changed = true;
        return n.track;
      });
      if (changed) next[key] = freeze(out);
    }

    const keys = Object.keys(next);
    if (!keys.length) return ok({ fixed: 0 });
    for (const key of keys) this.#backup(key, this.#coll(key));
    const r = this.#commit("repair", next, { collections: keys });
    return this.#out({ ...r, fixed: r.ok ? keys.length : 0 }, "repair");
  }

  repairAll() { return this.repair(); }

  /* -----------------------------------------------------
     Salud y diagnóstico
  ----------------------------------------------------- */

  getStorageUsage() {
    this.#ensureHistory();
    const encoder = typeof TextEncoder === "function" ? new TextEncoder() : null;
    const collections = {};
    let totalBytes = 0;
    let totalChars = 0;
    for (const key of KEYS) {
      const text = JSON.stringify(this.#coll(key));
      const bytes = encoder ? encoder.encode(text).length : text.length;
      collections[key] = { chars: text.length, bytes };
      totalChars += text.length;
      totalBytes += bytes;
    }
    return { estimated: true, totalChars, totalBytes, collections };
  }

  getStorageHealth() {
    return {
      persistent: !this.#memoryOnly && !this.#incognito,
      memoryOnly: this.#memoryOnly,
      incognito: this.#incognito,
      metaPersistent: Boolean(this.#kv.available),
      lastError: this.#lastError,
      usageBytes: this.getStorageUsage().totalBytes
    };
  }

  /** Modo incógnito: no guarda ni lee cambios. Al desactivarlo se descartan los cambios hechos. */
  setIncognito(value) {
    const next = Boolean(value);
    if (next === this.#incognito) return next;
    if (next) this.flush();
    this.#incognito = next;
    if (!next) this.load();
    return next;
  }

  get lastError() { return this.#lastError; }

  getOptions() {
    const { storage, kv, ...rest } = this.#o;
    return freeze({ ...rest });
  }

  diagnostics() {
    return {
      schemaVersion: SCHEMA_VERSION,
      ready: this.#ready,
      disposed: this.#disposed,
      counts: {
        library: this.#library.length,
        favorites: this.#favorites.length,
        history: this.#historyLoaded ? this.#history.length : null
      },
      stats: { ...this.#stats },
      lastError: this.#lastError,
      rejections: [...this.#rejections],
      integrityWarnings: [...this.#integrityWarnings],
      loadInfo: this.#loadInfo,
      health: this.getStorageHealth(),
      undoDepth: this.#undo.length,
      batchDepth: this.#batchDepth,
      historyPaused: this.#historyPaused
    };
  }
}

/* =======================================================
   05. INSTANCIA COMPARTIDA
======================================================= */

let shared = null;

/** Instancia compartida perezosa (se crea la primera vez que se pide). */
export function getSharedLibrary(options) {
  shared ??= new MusicLibrary(options);
  return shared;
}

export default MusicLibrary;
