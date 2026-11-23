const ENDPOINT = "/api/recommend";
const CACHE_KEY = "shunel_recs_v2";
const RESOLVE_KEY = "shunel_resolve_v1";
const BREAKER_KEY = "shunel_recs_breaker_v1";
const TTL_RECS = 30 * 60 * 1000;
const TTL_RESOLVE = 7 * 24 * 3600 * 1000;
const TTL_MISS = 60 * 60 * 1000;
const TIMEOUT_MS = 9000;
const MAX_STORED = 30;

const memory = new Map();
const inflight = new Map();
const resolving = new Map();
let failures = 0;

function abortError() {
  return new DOMException("Aborted", "AbortError");
}

function norm(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\b(feat|ft|featuring)\b.*$/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function readStore(storage, key) {
  try {
    const value = JSON.parse(storage.getItem(key) || "null");
    return value && typeof value === "object" ? value : {};
  } catch { return {}; }
}

function writeStore(storage, key, value, max = MAX_STORED) {
  try {
    const entries = Object.entries(value)
      .filter(([, item]) => item && item.exp > Date.now())
      .sort((a, b) => b[1].exp - a[1].exp)
      .slice(0, max);
    storage.setItem(key, JSON.stringify(Object.fromEntries(entries)));
  } catch {}
}

function cacheGet(key) {
  const hit = memory.get(key);
  if (hit && hit.exp > Date.now()) return hit.tracks;
  memory.delete(key);
  try {
    const stored = readStore(sessionStorage, CACHE_KEY)[key];
    if (stored && stored.exp > Date.now() && Array.isArray(stored.tracks)) {
      memory.set(key, stored);
      return stored.tracks;
    }
  } catch {}
  return null;
}

function cacheSet(key, tracks) {
  const entry = { exp: Date.now() + TTL_RECS, tracks };
  memory.set(key, entry);
  if (memory.size > 60) memory.delete(memory.keys().next().value);
  try {
    const store = readStore(sessionStorage, CACHE_KEY);
    store[key] = entry;
    writeStore(sessionStorage, CACHE_KEY, store);
  } catch {}
}

function breakerOpen() {
  try {
    const until = Number(sessionStorage.getItem(BREAKER_KEY)) || 0;
    return until > Date.now();
  } catch { return false; }
}

function openBreaker(ms) {
  try { sessionStorage.setItem(BREAKER_KEY, String(Date.now() + ms)); } catch {}
}

function withSignal(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => { signal.removeEventListener("abort", onAbort); resolve(value); },
      error => { signal.removeEventListener("abort", onAbort); reject(error); }
    );
  });
}

function seedFrom(track) {
  if (!track) return null;
  const videoId = String(track.videoId || track.id || "").trim();
  const title = String(track.title || track.name || "").trim();
  const artist = String(track.artist || track.channel || track.channelTitle || "").trim();
  if (!videoId && !title && !artist) return null;
  const id = /^[\w-]{11}$/.test(videoId) ? videoId : "";
  return { videoId: id, title, artist, key: id || `${norm(artist)}|${norm(title)}` };
}

function normalizeRec(item) {
  const videoId = String(item?.videoId || item?.id || "").trim();
  const title = String(item?.title || "").trim();
  if (!title) return null;
  const artist = String(item?.artist || item?.channelTitle || "").trim();
  const needsResolve = !/^[\w-]{11}$/.test(videoId);
  if (needsResolve && !artist) return null;
  return {
    videoId: needsResolve ? "" : videoId,
    id: needsResolve ? "" : videoId,
    title,
    artist,
    channel: item.channelTitle || artist,
    channelTitle: item.channelTitle || artist,
    thumbnail: item.thumbnail || "",
    duration: item.duration || undefined,
    source: needsResolve ? "catalog" : "youtube",
    needsResolve,
    searchQuery: needsResolve ? (item.searchQuery || `${artist} ${title}`) : undefined,
    sources: Array.isArray(item.sources) ? item.sources : []
  };
}

function dedupe(list) {
  const ids = new Set();
  const names = new Set();
  const out = [];
  for (const track of list) {
    const nameKey = `${norm(track.artist)}|${norm(track.title)}`;
    if ((track.videoId && ids.has(track.videoId)) || names.has(nameKey)) continue;
    if (track.videoId) ids.add(track.videoId);
    names.add(nameKey);
    out.push(track);
  }
  return out;
}

async function requestOnce(payload) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, TIMEOUT_MS);
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const data = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, data };
  } catch (error) {
    if (timedOut) throw new Error("Las recomendaciones tardaron demasiado.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function requestWithRetry(payload) {
  if (typeof navigator !== "undefined" && navigator.onLine === false) throw new Error("Sin conexión. Revisa tu internet.");
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await requestOnce(payload);
      if (result.ok || (result.status < 500 && result.status !== 429)) return result;
      last = result;
    } catch (error) {
      last = { error };
    }
    if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 350 + Math.random() * 250));
  }
  if (last?.error) throw last.error;
  return last;
}

async function fetchRecommendations(seed, lazy) {
  const result = await requestWithRetry({
    videoId: seed.videoId || undefined,
    title: seed.title,
    artist: seed.artist,
    limit: 20,
    lazy
  });
  if (!result.ok) {
    failures += 1;
    if (failures >= 3) { failures = 0; openBreaker(2 * 60 * 1000); }
    throw new Error(result.data?.error || "No se pudieron cargar las recomendaciones.");
  }
  failures = 0;
  const tracks = dedupe((Array.isArray(result.data?.tracks) ? result.data.tracks : []).map(normalizeRec).filter(Boolean));
  const degraded = Boolean(result.data?.degraded) && !tracks.length;
  if (degraded) openBreaker(5 * 60 * 1000);
  return { tracks, degraded };
}

function withFlag(list, degraded) {
  list.degraded = degraded;
  return list;
}

export async function getRecommendations(track, options = {}) {
  const { signal, limit = 20, exclude = [], lazy = false } = options;
  const seed = seedFrom(track);
  if (!seed) return withFlag([], false);
  if (signal?.aborted) throw abortError();
  if (breakerOpen()) return withFlag([], true);

  const want = Math.min(20, Math.max(5, Number(limit) || 20));
  const key = `${seed.key}|${lazy ? 1 : 0}`;
  let tracks = cacheGet(key);
  let degraded = false;

  if (!tracks) {
    let pending = inflight.get(key);
    if (!pending) {
      pending = fetchRecommendations(seed, lazy).finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    const result = await withSignal(pending, signal);
    tracks = result.tracks;
    degraded = result.degraded;
    if (tracks.length) cacheSet(key, tracks);
  }

  const skip = new Set(
    (Array.isArray(exclude) ? exclude : [])
      .map(item => (typeof item === "string" ? item : item?.videoId || item?.id))
      .filter(Boolean)
  );
  if (seed.videoId) skip.add(seed.videoId);
  const seedName = `${norm(seed.artist)}|${norm(seed.title)}`;
  const filtered = tracks.filter(item => {
    if (item.videoId && skip.has(item.videoId)) return false;
    return !seed.title || `${norm(item.artist)}|${norm(item.title)}` !== seedName;
  });
  return withFlag(filtered.slice(0, want), degraded && !filtered.length);
}

export async function resolveRecommendation(track, { signal } = {}) {
  const artist = String(track?.artist || track?.channelTitle || "").trim();
  const title = String(track?.title || "").trim();
  if (!artist || !title) return null;
  if (signal?.aborted) throw abortError();

  const key = `${norm(artist)}|${norm(title)}`;
  const store = readStore(localStorage, RESOLVE_KEY);
  const stored = store[key];
  if (stored && stored.exp > Date.now()) {
    return stored.track ? { ...stored.track } : null;
  }

  let pending = resolving.get(key);
  if (!pending) {
    pending = (async () => {
      const result = await requestWithRetry({ action: "resolve", artist, title });
      if (!result.ok) throw new Error(result.data?.error || "No se pudo buscar la canción.");
      const found = normalizeRec(result.data?.track);
      const resolved = found && found.videoId ? found : null;
      if (resolved || !result.data?.degraded) {
        const next = readStore(localStorage, RESOLVE_KEY);
        next[key] = { exp: Date.now() + (resolved ? TTL_RESOLVE : TTL_MISS), track: resolved };
        writeStore(localStorage, RESOLVE_KEY, next, 400);
      }
      return resolved;
    })().finally(() => resolving.delete(key));
    resolving.set(key, pending);
  }
  return withSignal(pending, signal);
}
