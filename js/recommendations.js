
/* =========================================================
   SHUNEL — RECOMMENDATION ENGINE 3.0
   Music Intelligence · Smart Radio · Adaptive Ranking

   Compatible:
   - iOS Safari / PWA
   - Vercel API: /api/recommend
   - Existing player and queue integrations

   Public exports:
   - getRecommendations()
   - resolveRecommendation()
   - startArtistRadio()

   No changes required in other files.

   Features:
   - Smart cache + LRU + negative cache
   - Request deduplication
   - Retry + global timeout
   - Circuit breaker
   - AbortSignal support
   - YouTube ID validation
   - Track resolution
   - Version-aware deduplication
   - Music ranking
   - Artist diversity
   - History and preference filtering
   - Recommendation reasons
   - Adaptive radio
========================================================= */

const ENDPOINT = "/api/recommend";

const CACHE_KEY = "shunel_recs_v3";
const RESOLVE_KEY = "shunel_resolve_v2";
const BREAKER_KEY = "shunel_recs_breaker_v2";

const TTL_RECS = 30 * 60 * 1000;
const TTL_EMPTY = 5 * 60 * 1000;
const TTL_RESOLVE = 7 * 24 * 3600 * 1000;
const TTL_MISS = 60 * 60 * 1000;

const TIMEOUT_MS = 9000;
const MAX_RETRIES = 1;

const MAX_MEMORY = 60;
const MAX_RECOMMENDATIONS = 20;
const MAX_RESOLVE_ENTRIES = 400;

const BREAKER_THRESHOLD = 3;
const BREAKER_DURATION = 2 * 60 * 1000;

const memory = new Map();
const inflight = new Map();
const resolving = new Map();

let failures = 0;

/* =========================================================
   1. UTILITIES
========================================================= */

function abortError() {
  try {
    return new DOMException("Aborted", "AbortError");
  } catch {
    const error = new Error("Aborted");
    error.name = "AbortError";
    return error;
  }
}

function isAbort(error) {
  return error?.name === "AbortError";
}

function isObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function validVideoId(value) {
  return /^[\w-]{11}$/.test(String(value || "").trim());
}

function getStorage(type) {
  try {
    if (typeof window === "undefined") return null;

    return type === "local"
      ? window.localStorage
      : window.sessionStorage;
  } catch {
    return null;
  }
}

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(feat|ft|featuring)\b.*$/i, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function normalizeVersion(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[()[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function trackIdentity(track) {
  const artist = normalizeText(track?.artist);
  const title = normalizeVersion(track?.title);

  return `${artist}|${title}`;
}

function artistIdentity(track) {
  return normalizeText(
    typeof track === "string"
      ? track
      : track?.artist || track?.channelTitle || ""
  );
}

function isValidString(value, max = 300) {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= max;
}

function uniqueStrings(values, normalizer = normalizeText) {
  const seen = new Set();
  const result = [];

  for (const value of values || []) {
    const key = normalizer(value);

    if (!key || seen.has(key)) continue;

    seen.add(key);
    result.push(String(value).trim());
  }

  return result;
}

/* =========================================================
   2. STORAGE
========================================================= */

function readStore(storage, key) {
  if (!storage) return {};

  try {
    const value = JSON.parse(storage.getItem(key) || "null");

    return isObject(value) ? value : {};
  } catch {
    return {};
  }
}

function writeStore(storage, key, value, max = MAX_MEMORY) {
  if (!storage || !isObject(value)) return false;

  try {
    const now = Date.now();

    const entries = Object.entries(value)
      .filter(([, item]) => (
        isObject(item) &&
        Number(item.exp) > now
      ))
      .sort((a, b) => (
        Number(b[1].lastUsed || b[1].exp) -
        Number(a[1].lastUsed || a[1].exp)
      ))
      .slice(0, max);

    storage.setItem(
      key,
      JSON.stringify(Object.fromEntries(entries))
    );

    return true;
  } catch {
    return false;
  }
}

function updateStoredEntry(storage, key, store, entry) {
  if (!storage) return;

  store[key] = {
    ...entry,
    lastUsed: Date.now()
  };

  writeStore(storage, key, store);
}

/* =========================================================
   3. SMART CACHE
========================================================= */

function touchMemory(key, entry) {
  memory.delete(key);
  memory.set(key, {
    ...entry,
    lastUsed: Date.now()
  });

  while (memory.size > MAX_MEMORY) {
    memory.delete(memory.keys().next().value);
  }
}

function cacheGet(key) {
  const now = Date.now();

  const hit = memory.get(key);

  if (hit) {
    if (hit.exp > now && Array.isArray(hit.tracks)) {
      touchMemory(key, hit);
      return hit;
    }

    memory.delete(key);
  }

  const storage = getStorage("session");
  const store = readStore(storage, CACHE_KEY);
  const entry = store[key];

  if (
    !isObject(entry) ||
    Number(entry.exp) <= now ||
    !Array.isArray(entry.tracks)
  ) {
    return null;
  }

  touchMemory(key, entry);

  updateStoredEntry(storage, CACHE_KEY, store, entry);

  return entry;
}

function cacheSet(key, tracks, degraded = false) {
  const entry = {
    exp: Date.now() + (
      tracks.length ? TTL_RECS : TTL_EMPTY
    ),
    tracks,
    degraded: Boolean(degraded),
    lastUsed: Date.now()
  };

  touchMemory(key, entry);

  const storage = getStorage("session");

  if (!storage) return;

  const store = readStore(storage, CACHE_KEY);

  store[key] = entry;

  writeStore(storage, CACHE_KEY, store);
}

function cacheClear() {
  memory.clear();

  const storage = getStorage("session");

  try {
    storage?.removeItem(CACHE_KEY);
  } catch {}
}

/* =========================================================
   4. CIRCUIT BREAKER
========================================================= */

function breakerOpen() {
  const storage = getStorage("session");

  if (!storage) return false;

  try {
    const until = Number(
      storage.getItem(BREAKER_KEY)
    ) || 0;

    if (until <= Date.now()) {
      storage.removeItem(BREAKER_KEY);
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

function openBreaker(ms = BREAKER_DURATION) {
  const storage = getStorage("session");

  try {
    storage?.setItem(
      BREAKER_KEY,
      String(Date.now() + ms)
    );
  } catch {}
}

function resetBreaker() {
  failures = 0;

  const storage = getStorage("session");

  try {
    storage?.removeItem(BREAKER_KEY);
  } catch {}
}

function recordFailure(error) {
  if (isAbort(error)) return;

  failures += 1;

  if (failures >= BREAKER_THRESHOLD) {
    failures = 0;
    openBreaker();
  }
}

/* =========================================================
   5. CANCELLATION
========================================================= */

function withSignal(promise, signal) {
  if (!signal) return promise;

  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }

    let settled = false;

    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };

    const onAbort = () => {
      if (settled) return;

      settled = true;
      cleanup();
      reject(abortError());
    };

    signal.addEventListener("abort", onAbort, {
      once: true
    });

    promise.then(
      value => {
        if (settled) return;

        settled = true;
        cleanup();
        resolve(value);
      },
      error => {
        if (settled) return;

        settled = true;
        cleanup();
        reject(error);
      }
    );
  });
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }

    let timer;

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    const onAbort = () => {
      cleanup();
      reject(abortError());
    };

    signal?.addEventListener("abort", onAbort, {
      once: true
    });

    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
  });
}

/* =========================================================
   6. TRACK NORMALIZATION
========================================================= */

function seedFrom(track) {
  if (!isObject(track)) return null;

  const candidates = [
    track.videoId,
    track.id
  ];

  const videoId = candidates.find(validVideoId) || "";

  const title = String(
    track.title || track.name || ""
  ).trim();

  const artist = String(
    track.artist ||
    track.channelTitle ||
    track.channel ||
    ""
  ).trim();

  if (!videoId && !title && !artist) return null;

  return {
    videoId,
    title,
    artist,
    key: videoId || `${normalizeText(artist)}|${normalizeText(title)}`
  };
}

function normalizeRec(item) {
  if (!isObject(item)) return null;

  const candidates = [
    item.videoId,
    item.id
  ];

  const rawId = candidates.find(validVideoId) || "";

  const title = String(item.title || "").trim();

  const artist = String(
    item.artist ||
    item.channelTitle ||
    item.channel ||
    ""
  ).trim();

  if (!title || title.length > 300) return null;

  const needsResolve = !rawId;

  if (needsResolve && !artist) return null;

  const result = {
    videoId: rawId,
    id: rawId,
    title,
    artist,
    channel: String(item.channel || item.channelTitle || artist),
    channelTitle: String(item.channelTitle || item.channel || artist),
    thumbnail: String(item.thumbnail || ""),
    duration: item.duration || undefined,
    source: needsResolve ? "catalog" : "youtube",
    needsResolve,
    searchQuery: needsResolve
      ? String(item.searchQuery || `${artist} ${title}`)
      : undefined,
    sources: Array.isArray(item.sources)
      ? item.sources.slice(0, 10)
      : []
  };

  // Optional metadata, preserved when supplied by the API.
  if (Array.isArray(item.genres)) {
    result.genres = item.genres
      .filter(value => typeof value === "string")
      .slice(0, 15);
  }

  if (Number.isFinite(Number(item.popularity))) {
    result.popularity = clamp(
      Number(item.popularity),
      0,
      100
    );
  }

  if (Number.isFinite(Number(item.durationSeconds))) {
    result.durationSeconds = Math.max(
      0,
      Number(item.durationSeconds)
    );
  }

  if (typeof item.isOfficial === "boolean") {
    result.isOfficial = item.isOfficial;
  }

  if (typeof item.explicit === "boolean") {
    result.explicit = item.explicit;
  }

  if (typeof item.reason === "string") {
    result.reason = item.reason.slice(0, 180);
  }

  if (Number.isFinite(Number(item.score))) {
    result.score = Number(item.score);
  }

  return result;
}

/* =========================================================
   7. DEDUPLICATION
========================================================= */

function dedupe(list) {
  const ids = new Set();
  const names = new Set();
  const output = [];

  for (const item of list) {
    if (!item) continue;

    const id = item.videoId || "";
    const nameKey = trackIdentity(item);

    if (id && ids.has(id)) continue;

    if (nameKey !== "|" && names.has(nameKey)) continue;

    if (id) ids.add(id);

    if (nameKey !== "|") names.add(nameKey);

    output.push(item);
  }

  return output;
}

/* =========================================================
   8. API REQUESTS
========================================================= */

async function requestOnce(payload, signal) {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify(payload),
    signal,
    cache: "no-store"
  });

  let data;

  try {
    data = await response.json();
  } catch {
    return {
      ok: false,
      status: response.status,
      data: null,
      parseError: true
    };
  }

  if (!isObject(data)) {
    return {
      ok: false,
      status: response.status,
      data: null,
      parseError: true
    };
  }

  return {
    ok: response.ok,
    status: response.status,
    data,
    parseError: false
  };
}

async function requestWithRetry(payload, options = {}) {
  const { signal } = options;

  if (
    typeof navigator !== "undefined" &&
    navigator.onLine === false
  ) {
    throw new Error(
      "Sin conexión. Revisa tu internet."
    );
  }

  if (signal?.aborted) throw abortError();

  const controller = new AbortController();

  let timedOut = false;

  const onExternalAbort = () => {
    controller.abort();
  };

  signal?.addEventListener(
    "abort",
    onExternalAbort,
    { once: true }
  );

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TIMEOUT_MS);

  let lastResult = null;
  let lastError = null;

  try {
    for (
      let attempt = 0;
      attempt <= MAX_RETRIES;
      attempt++
    ) {
      if (signal?.aborted) throw abortError();

      try {
        const result = await requestOnce(
          payload,
          controller.signal
        );

        lastResult = result;

        if (result.ok) return result;

        const retryable = (
          result.parseError ||
          result.status === 429 ||
          result.status >= 500
        );

        if (!retryable) return result;

        if (attempt >= MAX_RETRIES) break;
      } catch (error) {
        if (signal?.aborted) throw abortError();

        if (timedOut) {
          throw new Error(
            "Las recomendaciones tardaron demasiado."
          );
        }

        if (isAbort(error)) throw error;

        lastError = error;

        if (attempt >= MAX_RETRIES) break;
      }

      await delay(
        350 + Math.random() * 250,
        controller.signal
      );
    }

    if (timedOut) {
      throw new Error(
        "Las recomendaciones tardaron demasiado."
      );
    }

    if (lastError && !lastResult) {
      throw lastError;
    }

    return lastResult || {
      ok: false,
      status: 0,
      data: null
    };

  } finally {
    clearTimeout(timer);

    signal?.removeEventListener(
      "abort",
      onExternalAbort
    );
  }
}

/* =========================================================
   9. RECOMMENDATION PROVIDER
========================================================= */

async function fetchRecommendations(seed, lazy) {
  let result;

  try {
    result = await requestWithRetry({
      videoId: seed.videoId || undefined,
      title: seed.title,
      artist: seed.artist,
      limit: MAX_RECOMMENDATIONS,
      lazy: Boolean(lazy)
    });
  } catch (error) {
    recordFailure(error);
    throw error;
  }

  if (!result?.ok) {
    const status = Number(result?.status || 0);

    if (
      status === 429 ||
      status >= 500 ||
      status === 0 ||
      result?.parseError
    ) {
      recordFailure(
        new Error(`HTTP ${status || "network"}`)
      );
    }

    const message = result?.data?.error;

    throw new Error(
      typeof message === "string"
        ? message.slice(0, 250)
        : "No se pudieron cargar las recomendaciones."
    );
  }

  resetBreaker();

  const raw = Array.isArray(result.data.tracks)
    ? result.data.tracks
    : [];

  const tracks = dedupe(
    raw.map(normalizeRec).filter(Boolean)
  );

  const degraded = Boolean(result.data.degraded);

  if (degraded && !tracks.length) {
    openBreaker(5 * 60 * 1000);
  }

  return {
    tracks,
    degraded
  };
}

/* =========================================================
   10. EXCLUSIONS AND HISTORY
========================================================= */

function getExcludedIds(items) {
  const ids = new Set();

  for (const item of items || []) {
    if (typeof item === "string") {
      if (validVideoId(item)) ids.add(item);
      continue;
    }

    const id = item?.videoId || item?.id;

    if (validVideoId(id)) ids.add(id);
  }

  return ids;
}

function getExcludedNames(items) {
  return new Set(
    (items || [])
      .map(item => (
        typeof item === "string"
          ? normalizeText(item)
          : trackIdentity(item)
      ))
      .filter(Boolean)
  );
}

function isExcluded(track, options) {
  const ids = getExcludedIds(options.exclude);

  if (track.videoId && ids.has(track.videoId)) {
    return true;
  }

  const historyIds = getExcludedIds(
    options.history
  );

  if (
    track.videoId &&
    historyIds.has(track.videoId)
  ) {
    return true;
  }

  const blockedArtists = new Set(
    (options.blockedArtists || [])
      .map(artistIdentity)
      .filter(Boolean)
  );

  if (
    track.artist &&
    blockedArtists.has(artistIdentity(track))
  ) {
    return true;
  }

  const blockedNames = getExcludedNames(
    options.excludeTracks
  );

  if (blockedNames.has(trackIdentity(track))) {
    return true;
  }

  return false;
}

/* =========================================================
   11. MUSIC RANKING
========================================================= */

function getRecommendationScore(track, seed, options = {}) {
  let score = Number(track.score) || 0;

  const candidateArtist = artistIdentity(track);
  const seedArtist = artistIdentity(seed);

  const preferred = new Set(
    (options.preferredArtists || [])
      .map(artistIdentity)
      .filter(Boolean)
  );

  const favorites = new Set(
    (options.favoriteArtists || [])
      .map(artistIdentity)
      .filter(Boolean)
  );

  const followed = new Set(
    (options.followedArtists || [])
      .map(artistIdentity)
      .filter(Boolean)
  );

  if (candidateArtist && candidateArtist === seedArtist) {
    score += 25;
  }

  if (candidateArtist && preferred.has(candidateArtist)) {
    score += 20;
  }

  if (candidateArtist && favorites.has(candidateArtist)) {
    score += 30;
  }

  if (candidateArtist && followed.has(candidateArtist)) {
    score += 15;
  }

  if (Number.isFinite(track.popularity)) {
    score += track.popularity * 0.08;
  }

  if (track.isOfficial === true) {
    score += 5;
  }

  if (track.isOfficial === false) {
    score -= 5;
  }

  const recentArtists = new Set(
    (options.history || [])
      .slice(0, 20)
      .map(artistIdentity)
      .filter(Boolean)
  );

  if (
    candidateArtist &&
    recentArtists.has(candidateArtist)
  ) {
    score -= 8;
  }

  if (options.discover) {
    if (candidateArtist !== seedArtist) {
      score += 10;
    }
  }

  if (options.explicit === false && track.explicit) {
    score -= 100;
  }

  return score;
}

function recommendationReason(track, seed, options = {}) {
  const artist = artistIdentity(track);
  const seedArtist = artistIdentity(seed);

  if (track.reason) return track.reason;

  if (artist && artist === seedArtist) {
    return "Del mismo artista";
  }

  const favorites = new Set(
    (options.favoriteArtists || []).map(artistIdentity)
  );

  if (favorites.has(artist)) {
    return "De uno de tus artistas favoritos";
  }

  const followed = new Set(
    (options.followedArtists || []).map(artistIdentity)
  );

  if (followed.has(artist)) {
    return "De un artista que sigues";
  }

  if (track.popularity >= 75) {
    return "Canción popular";
  }

  return "Para descubrir música nueva";
}

/* =========================================================
   12. ARTIST DIVERSITY
========================================================= */

function diversifyTracks(tracks, options = {}) {
  const maxPerArtist = clamp(
    Number(options.maxPerArtist) || 3,
    1,
    20
  );

  if (options.diversify === false) {
    return tracks;
  }

  const output = [];
  const remaining = [...tracks];
  const counts = new Map();

  while (remaining.length) {
    let index = remaining.findIndex(track => {
      const artist = artistIdentity(track);
      const count = counts.get(artist) || 0;

      return !artist || count < maxPerArtist;
    });

    if (index < 0) {
      output.push(...remaining);
      break;
    }

    const [track] = remaining.splice(index, 1);

    const artist = artistIdentity(track);

    counts.set(
      artist,
      (counts.get(artist) || 0) + 1
    );

    output.push(track);
  }

  return output;
}

/* =========================================================
   13. RESULT FLAGS
========================================================= */

function withFlag(list, degraded = false) {
  Object.defineProperty(list, "degraded", {
    value: Boolean(degraded),
    writable: true,
    configurable: true,
    enumerable: false
  });

  return list;
}

/* =========================================================
   14. MAIN RECOMMENDATIONS
========================================================= */

export async function getRecommendations(
  track,
  options = {}
) {
  const {
    signal,
    limit = 20,
    exclude = [],
    lazy = false
  } = options;

  const seed = seedFrom(track);

  if (!seed) return withFlag([], false);

  if (signal?.aborted) throw abortError();

  const want = clamp(
    Number(limit) || 20,
    1,
    MAX_RECOMMENDATIONS
  );

  const key = `${seed.key}|${lazy ? 1 : 0}`;

  // Always use available cache before checking the breaker.
  const cached = cacheGet(key);

  let tracks;
  let degraded = false;

  if (cached) {
    tracks = cached.tracks;
    degraded = cached.degraded;

  } else {
    if (breakerOpen()) {
      return withFlag([], true);
    }

    let pending = inflight.get(key);

    if (!pending) {
      pending = fetchRecommendations(seed, lazy)
        .then(result => {
          cacheSet(
            key,
            result.tracks,
            result.degraded
          );

          return result;
        })
        .finally(() => {
          inflight.delete(key);
        });

      inflight.set(key, pending);
    }

    const result = await withSignal(
      pending,
      signal
    );

    tracks = result.tracks;
    degraded = result.degraded;
  }

  if (signal?.aborted) throw abortError();

  const seedId = seed.videoId;

  const seedName = trackIdentity(seed);

  const candidates = tracks.filter(item => {
    if (seedId && item.videoId === seedId) {
      return false;
    }

    if (
      seed.title &&
      trackIdentity(item) === seedName
    ) {
      return false;
    }

    return !isExcluded(item, {
      ...options,
      exclude
    });
  });

  const ranked = candidates
    .map(item => ({
      ...item,
      recommendationScore: getRecommendationScore(
        item,
        seed,
        options
      ),
      recommendationReason: recommendationReason(
        item,
        seed,
        options
      )
    }))
    .sort((a, b) => (
      b.recommendationScore -
      a.recommendationScore
    ));

  const diversified = diversifyTracks(
    ranked,
    options
  );

  return withFlag(
    diversified.slice(0, want),
    degraded && !diversified.length
  );
}

/* =========================================================
   15. RESOLUTION CACHE
========================================================= */

function resolveCacheGet(key) {
  const storage = getStorage("local");

  const store = readStore(storage, RESOLVE_KEY);

  const entry = store[key];

  if (
    !isObject(entry) ||
    Number(entry.exp) <= Date.now()
  ) {
    return {
      hit: false,
      track: null
    };
  }

  const track = entry.track
    ? normalizeRec(entry.track)
    : null;

  if (entry.track && (!track || !track.videoId)) {
    return {
      hit: false,
      track: null
    };
  }

  updateStoredEntry(
    storage,
    RESOLVE_KEY,
    store,
    entry
  );

  return {
    hit: true,
    track
  };
}

function resolveCacheSet(key, track, negative = false) {
  const storage = getStorage("local");

  if (!storage) return;

  const store = readStore(storage, RESOLVE_KEY);

  store[key] = {
    exp: Date.now() + (
      negative ? TTL_MISS : TTL_RESOLVE
    ),
    lastUsed: Date.now(),
    track: negative ? null : track
  };

  writeStore(
    storage,
    RESOLVE_KEY,
    store,
    MAX_RESOLVE_ENTRIES
  );
}

/* =========================================================
   16. TRACK RESOLUTION
========================================================= */

export async function resolveRecommendation(
  track,
  { signal } = {}
) {
  if (!isObject(track)) return null;

  const artist = String(
    track.artist ||
    track.channelTitle ||
    ""
  ).trim();

  const title = String(
    track.title || ""
  ).trim();

  if (
    !isValidString(artist, 200) ||
    !isValidString(title, 300)
  ) {
    return null;
  }

  if (signal?.aborted) throw abortError();

  const existingId = (
    validVideoId(track.videoId)
      ? track.videoId
      : validVideoId(track.id)
        ? track.id
        : ""
  );

  if (existingId) {
    return {
      ...normalizeRec({
        ...track,
        videoId: existingId
      })
    };
  }

  const key = `${normalizeText(artist)}|${normalizeText(title)}`;

  const cached = resolveCacheGet(key);

  if (cached.hit) {
    return cached.track
      ? { ...cached.track }
      : null;
  }

  let pending = resolving.get(key);

  if (!pending) {
    pending = (async () => {
      const result = await requestWithRetry({
        action: "resolve",
        artist,
        title
      });

      if (!result?.ok) {
        const status = Number(result?.status || 0);

        if (
          status === 429 ||
          status >= 500 ||
          status === 0
        ) {
          recordFailure(
            new Error(`HTTP ${status || "network"}`)
          );
        }

        throw new Error(
          result?.data?.error ||
          "No se pudo buscar la canción."
        );
      }

      resetBreaker();

      const found = normalizeRec(
        result.data?.track
      );

      const resolved = (
        found?.videoId &&
        validVideoId(found.videoId)
      )
        ? found
        : null;

      if (resolved) {
        resolveCacheSet(key, resolved);
      } else if (!result.data?.degraded) {
        resolveCacheSet(key, null, true);
      }

      return resolved;
    })().finally(() => {
      resolving.delete(key);
    });

    resolving.set(key, pending);
  }

  const resolved = await withSignal(
    pending,
    signal
  );

  return resolved
    ? { ...resolved }
    : null;
}

/* =========================================================
   17. ARTIST RADIO
========================================================= */

export async function startArtistRadio(
  artist,
  options = {}
) {
  const name = String(artist || "")
    .trim()
    .slice(0, 120);

  if (!name) return withFlag([], false);

  const {
    signal,
    limit = 15
  } = options;

  const want = clamp(
    Number(limit) || 15,
    1,
    MAX_RECOMMENDATIONS
  );

  const list = await getRecommendations(
    {
      artist: name,
      title: ""
    },
    {
      ...options,
      signal,
      limit: MAX_RECOMMENDATIONS,
      lazy: true,
      maxPerArtist: options.maxPerArtist || 5
    }
  );

  const own = normalizeText(name);

  const sorted = [...list].sort((a, b) => {
    const aOwn = normalizeText(a.artist) === own;
    const bOwn = normalizeText(b.artist) === own;

    return Number(bOwn) - Number(aOwn);
  });

  return withFlag(
    sorted.slice(0, want),
    list.degraded
  );
}

/* =========================================================
   18. OPTIONAL CACHE UTILITIES
========================================================= */

export function clearRecommendationCache() {
  cacheClear();
}

export function clearResolutionCache() {
  const storage = getStorage("local");

  try {
    storage?.removeItem(RESOLVE_KEY);
  } catch {}
}

export function clearRecommendationState() {
  cacheClear();
  clearResolutionCache();
  resetBreaker();

  inflight.clear();
  resolving.clear();
}

export function getRecommendationStatus() {
  return {
    cacheEntries: memory.size,
    pendingRecommendations: inflight.size,
    pendingResolutions: resolving.size,
    circuitBreakerOpen: breakerOpen(),
    failures
  };
}
