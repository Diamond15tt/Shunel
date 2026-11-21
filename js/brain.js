/* =========================================================================
   SHUNEL — brain.js (v1)
   El "cerebro" musical: perfil de gusto, ranking de autoplay, shuffle
   inteligente y utilidades de texto. No toca el DOM (lógica pura), así
   app.js solo orquesta y este archivo se puede probar por separado.

   // Inspiración (resumen de la investigación):
   // - Spotify: lo que buscas, escuchas, saltas y guardas forma tu "taste
   //   profile". Un saltado rápido pesa mucho más que una escucha completa.
   //   Una reproducción cuenta como "stream" a partir de 30 s.
   // - Spotify Shuffle 2014: repartir las canciones de cada artista a lo largo
   //   de la lista con un desfase aleatorio y un pequeño "jitter".
   // - Spotify Shuffle 2025 ("Fewer repeats"): generar varias secuencias
   //   aleatorias y quedarse con la de mayor "frescura" (lo escuchado hace
   //   poco se empuja hacia el final).
   // - Apple Music AutoPlay: se queda en el estilo de lo que estás
   //   escuchando y no repite lo mismo en el mismo orden.
   // - Quejas en Reddit sobre autoplay: siempre los mismos 5–8 artistas y
   //   canciones repetidas → aquí hay castigo por repetición, bonus por
   //   novedad y re-ranking por diversidad (tipo MMR).
   ========================================================================= */

// // ---------------------------------------------------------------------
// // 1. CONSTANTES
// // ---------------------------------------------------------------------

const STORAGE_KEY = "shunel_brain_v1";
const SESSION_KEY = "shunel_brain_session_v1";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

// // Vida media del gusto: una señal de hace 21 días vale la mitad
const TASTE_HALF_LIFE = 21 * DAY;

// // Límites para que localStorage no crezca sin control
const MAX_TRACKS = 600;
const MAX_ARTISTS = 300;
const MAX_SESSION = 40;

// // Umbrales de escucha (segundos)
const FAST_SKIP = 5;       // // saltar antes de 5 s = rechazo fuerte
const SHORT_SKIP = 30;     // // antes de 30 s = no contó como "stream"
const COMPLETE_RATIO = 0.8; // // 80 % escuchado = completa

// // Peso de cada señal en el perfil
const SIGNAL = {
  fastSkip: -3,
  shortSkip: -1.5,
  lateSkip: -0.3,
  complete: 1,
  replay: 2,
  like: 3,
  unlike: -1,
  error: 0
};

// // Versiones alternativas que casi nunca quieres por sorpresa en autoplay
const VARIANT_RE = /\b(cover|karaoke|instrumental|8d|slowed|sped ?up|nightcore|reverb|bass ?boosted|remix|live|en vivo|ac[uú]stic[oa]|acoustic|tutorial|reaction|reaccion)\b/i;

// // Ruido típico en títulos de YouTube
const TITLE_NOISE_RE = new RegExp(
  [
    "\\((?:[^)]*?)(?:official|oficial|video|v[ií]deo|audio|lyric|letra|visualizer|visualiser|clip|hd|hq|4k|mv|m\\/v)(?:[^)]*?)\\)",
    "\\[(?:[^\\]]*?)(?:official|oficial|video|v[ií]deo|audio|lyric|letra|visualizer|visualiser|clip|hd|hq|4k|mv|m\\/v)(?:[^\\]]*?)\\]",
    "\\b(?:official|oficial)\\s+(?:music\\s+)?(?:video|v[ií]deo|audio)\\b",
    "\\b(?:video|v[ií]deo)\\s+(?:official|oficial)\\b",
    "\\b(?:lyrics?|letra)\\b",
    "\\b(?:hd|hq|4k)\\b"
  ].join("|"),
  "gi"
);

// // ---------------------------------------------------------------------
// // 2. TEXTO: normalizar, limpiar títulos, similitud
// // ---------------------------------------------------------------------

// // minúsculas + sin tildes + sin signos → "Canción Ñ!" → "cancion n"
export function normalizeText(value) {
  return String(value ?? "")
    .toLocaleLowerCase("es")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ø/g, "o")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// // "Køddy G - Topic" / "KoddyGVEVO" / "Køddy G Oficial" → "Køddy G"
export function cleanArtist(value) {
  return String(value ?? "")
    .replace(/\s*-\s*topic$/i, "")
    .replace(/vevo$/i, "")
    .replace(/\s+(official|oficial)$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

// // Quita "(Video Oficial)", "[Lyrics]", "HD"… pero respeta el resto
export function cleanTitle(value) {
  return String(value ?? "")
    .replace(TITLE_NOISE_RE, " ")
    .replace(/\(\s*\)|\[\s*\]/g, " ")
    .replace(/\s*[|•·]\s*$/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+-\s*$/g, "")
    .trim();
}

// // Separa "Artista - Canción" cuando el título lo trae así.
// // Si el canal coincide con un lado, ese lado es el artista.
export function parseTitle(title, channel = "") {
  const clean = cleanTitle(title);
  const artistGuess = cleanArtist(channel);
  const parts = clean.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) {
    const [left, ...rest] = parts;
    const right = rest.join(" - ");
    const nLeft = normalizeText(left);
    const nRight = normalizeText(right);
    const nArtist = normalizeText(artistGuess);
    if (nArtist && nRight.includes(nArtist) && !nLeft.includes(nArtist)) {
      return { artist: right.trim(), song: left.trim() };
    }
    return { artist: left.trim(), song: right.trim() };
  }
  return { artist: artistGuess, song: clean };
}

// // Clave "misma canción" aunque sean subidas distintas:
// // "Peli de Terror (Video Oficial)" y "PELI DE TERROR - Letra" → igual
export function songKey(track) {
  const title = track?.title || track?.name || "";
  const channel = track?.artist || track?.channel || track?.channelTitle || "";
  const { song } = parseTitle(title, channel);
  const base = normalizeText(song)
    .replace(/\b(feat|ft|featuring|con|prod)\b.*$/, "")
    .trim();
  return base || normalizeText(title);
}

export function artistKey(track) {
  const raw = typeof track === "string"
    ? track
    : track?.artist || track?.channel || track?.channelTitle || "";
  return normalizeText(cleanArtist(raw));
}

export function isVariant(track) {
  return VARIANT_RE.test(String(track?.title || ""));
}

// // Coeficiente de Dice con bigramas: 0 (nada) → 1 (igual).
// // Tolera tildes, mayúsculas y pequeñas diferencias.
export function similarity(a, b) {
  const x = normalizeText(a).replace(/\s/g, "");
  const y = normalizeText(b).replace(/\s/g, "");
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const grams = new Map();
  for (let i = 0; i < x.length - 1; i++) {
    const g = x.slice(i, i + 2);
    grams.set(g, (grams.get(g) || 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < y.length - 1; i++) {
    const g = y.slice(i, i + 2);
    const n = grams.get(g) || 0;
    if (n > 0) { grams.set(g, n - 1); hits++; }
  }
  return (2 * hits) / (x.length + y.length - 2);
}

// // Elige el mejor resultado de YouTube para una canción del Top 50.
// // Premia: título y artista parecidos, canales "- Topic"/VEVO (audio oficial).
// // Castiga: covers, karaoke, slowed, 8D… salvo que se pidan.
export function scoreSearchMatch(result, wanted) {
  const title = result?.title || result?.name || "";
  const channel = result?.channel || result?.artist || result?.channelTitle || "";
  const wantedTitle = wanted?.title || "";
  const wantedArtist = wanted?.artist || "";
  const titleSim = Math.max(
    similarity(cleanTitle(title), wantedTitle),
    similarity(parseTitle(title, channel).song, wantedTitle)
  );
  const artistSim = Math.max(
    similarity(cleanArtist(channel), wantedArtist),
    normalizeText(title).includes(normalizeText(wantedArtist)) ? 0.9 : 0
  );
  let score = titleSim * 10 + artistSim * 7;
  if (/-\s*topic$/i.test(channel) || /vevo$/i.test(channel)) score += 2;
  if (/\b(official|oficial)\b/i.test(title)) score += 1;
  if (VARIANT_RE.test(title) && !VARIANT_RE.test(wantedTitle)) score -= 6;
  if (result?.videoId) score += 1;
  return score;
}

// // ---------------------------------------------------------------------
// // 3. UTILIDADES
// // ---------------------------------------------------------------------

function now() { return Date.now(); }

function decay(value, since, halfLife = TASTE_HALF_LIFE) {
  if (!value) return 0;
  const age = Math.max(0, now() - (since || 0));
  return value * Math.pow(0.5, age / halfLife);
}

function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

// // Fisher–Yates: barajado uniforme (sin sesgo)
export function fisherYates(list, random = Math.random) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function safeRead(storage, key, fallback) {
  try {
    const raw = storage?.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}

function safeWrite(storage, key, value) {
  try { storage?.setItem(key, JSON.stringify(value)); return true; }
  catch { return false; } // // cuota llena o modo privado: la música sigue
}

function getLocal() { try { return window.localStorage; } catch { return null; } }
function getSession() { try { return window.sessionStorage; } catch { return null; } }

// // ---------------------------------------------------------------------
// // 4. CEREBRO: perfil de gusto + sesión
// // ---------------------------------------------------------------------

export class ShunelBrain {
  constructor() {
    const data = safeRead(getLocal(), STORAGE_KEY, null);
    this.tracks = data?.tracks && typeof data.tracks === "object" ? data.tracks : {};
    this.artists = data?.artists && typeof data.artists === "object" ? data.artists : {};
    this.blocked = data?.blocked && typeof data.blocked === "object" ? data.blocked : {};
    this.settings = {
      autoplay: true,
      shuffle: false,
      ...(data?.settings && typeof data.settings === "object" ? data.settings : {})
    };
    // // La sesión vive en sessionStorage: se reinicia al cerrar la app
    const session = safeRead(getSession(), SESSION_KEY, []);
    this.session = Array.isArray(session) ? session.slice(-MAX_SESSION) : [];
    this.saveTimer = null;
    this.pruneBlocked();
  }

  // // 4.1 Persistencia con debounce (máximo una escritura cada 1.5 s)
  save(immediate = false) {
    clearTimeout(this.saveTimer);
    const write = () => {
      this.prune();
      safeWrite(getLocal(), STORAGE_KEY, {
        v: 1,
        tracks: this.tracks,
        artists: this.artists,
        blocked: this.blocked,
        settings: this.settings
      });
      safeWrite(getSession(), SESSION_KEY, this.session.slice(-MAX_SESSION));
    };
    if (immediate) write();
    else this.saveTimer = setTimeout(write, 1500);
  }

  // // 4.2 Recorta lo menos relevante cuando se pasa del límite
  prune() {
    const trim = (map, max) => {
      const keys = Object.keys(map);
      if (keys.length <= max) return;
      keys
        .sort((a, b) => Math.abs(decay(map[a].score, map[a].last)) - Math.abs(decay(map[b].score, map[b].last)) || (map[a].last || 0) - (map[b].last || 0))
        .slice(0, keys.length - max)
        .forEach(key => delete map[key]);
    };
    trim(this.tracks, MAX_TRACKS);
    trim(this.artists, MAX_ARTISTS);
  }

  pruneBlocked() {
    const t = now();
    for (const [id, until] of Object.entries(this.blocked)) if (!(until > t)) delete this.blocked[id];
  }

  // // 4.3 Señales
  applySignal(track, delta, extra = {}) {
    const id = track?.videoId;
    if (!id) return;
    const t = now();
    const entry = this.tracks[id] || { plays: 0, completes: 0, skips: 0, fastSkips: 0, likes: 0, score: 0, last: 0 };
    entry.score = clamp(decay(entry.score, entry.last) + delta, -20, 40);
    entry.title = String(track.title || "").slice(0, 120);
    entry.artist = cleanArtist(track.artist || track.channel || track.channelTitle || "").slice(0, 80);
    entry.key = songKey(track).slice(0, 80);
    entry.last = t;
    for (const [field, inc] of Object.entries(extra)) entry[field] = (entry[field] || 0) + inc;
    this.tracks[id] = entry;

    const aKey = artistKey(track);
    if (aKey) {
      const artist = this.artists[aKey] || { score: 0, plays: 0, skips: 0, last: 0, name: entry.artist };
      artist.score = clamp(decay(artist.score, artist.last) + delta * 0.5, -20, 60);
      artist.last = t;
      artist.name = entry.artist || artist.name;
      if (extra.plays) artist.plays += extra.plays;
      if (extra.skips || extra.fastSkips) artist.skips += 1;
      this.artists[aKey] = artist;
    }
    this.save();
  }

  // // Se llama al terminar/cambiar una canción con cuánto se escuchó
  recordListen(track, { listened = 0, duration = 0, reason = "switch" } = {}) {
    if (!track?.videoId) return null;
    const ratio = duration > 0 ? listened / duration : 0;
    let outcome = "partial";
    let delta = 0;
    const extra = {};

    if (reason === "error") {
      outcome = "error";
    } else if (reason === "ended" || ratio >= COMPLETE_RATIO) {
      outcome = "complete";
      delta = SIGNAL.complete;
      extra.completes = 1;
    } else if (reason === "skip" || reason === "switch") {
      if (listened < FAST_SKIP) { outcome = "fastSkip"; delta = SIGNAL.fastSkip; extra.fastSkips = 1; }
      else if (listened < SHORT_SKIP) { outcome = "shortSkip"; delta = SIGNAL.shortSkip; extra.skips = 1; }
      else { outcome = "lateSkip"; delta = SIGNAL.lateSkip; extra.skips = 1; }
      // // Cambiar de canción a mano (no "siguiente") castiga la mitad
      if (reason === "switch") delta *= 0.5;
    }

    // // Regla de Spotify: cuenta como reproducción desde 30 s
    if (listened >= SHORT_SKIP) extra.plays = 1;

    // // Volver a poner la misma canción en la sesión = señal muy positiva
    const key = songKey(track);
    const replays = this.session.filter(item => item.key === key && item.outcome !== "fastSkip").length;
    if (replays >= 1 && outcome === "complete") delta += SIGNAL.replay;

    if (delta || Object.keys(extra).length) this.applySignal(track, delta, extra);

    this.session.push({
      videoId: track.videoId,
      key,
      artist: artistKey(track),
      at: now(),
      outcome,
      listened: Math.round(listened)
    });
    if (this.session.length > MAX_SESSION) this.session.splice(0, this.session.length - MAX_SESSION);
    this.save();
    return outcome;
  }

  recordLike(track, liked) {
    this.applySignal(track, liked ? SIGNAL.like : SIGNAL.unlike, liked ? { likes: 1 } : {});
  }

  // // 4.4 Videos que YouTube no deja reproducir (error 100/101/150)
  block(videoId, ms = 7 * DAY) {
    if (!videoId) return;
    this.blocked[videoId] = now() + ms;
    this.save();
  }

  isBlocked(videoId) {
    const until = this.blocked[videoId];
    return Boolean(until && until > now());
  }

  // // 4.5 Consultas
  trackAffinity(track) {
    const entry = this.tracks[track?.videoId];
    const artist = this.artists[artistKey(track)];
    return decay(entry?.score || 0, entry?.last) + decay(artist?.score || 0, artist?.last) * 0.6;
  }

  playedRecently(track, windowMs = 90 * 60 * 1000) {
    const key = songKey(track);
    const t = now();
    if (this.session.some(item => (item.videoId === track?.videoId || item.key === key) && t - item.at < windowMs)) return true;
    const entry = this.tracks[track?.videoId];
    return Boolean(entry && t - entry.last < windowMs && (entry.plays || entry.completes));
  }

  // // ¿El usuario rechaza este artista en esta sesión? (2+ saltos rápidos)
  artistRejected(track) {
    const aKey = artistKey(track);
    if (!aKey) return false;
    return this.session.filter(item => item.artist === aKey && item.outcome === "fastSkip").length >= 2;
  }

  sessionArtists(limit = 6) {
    const out = [];
    for (let i = this.session.length - 1; i >= 0 && out.length < limit; i--) {
      const item = this.session[i];
      if (item.outcome === "fastSkip" || !item.artist) continue;
      if (!out.includes(item.artist)) out.push(item.artist);
    }
    return out;
  }

  topArtists(limit = 5) {
    return Object.values(this.artists)
      .map(a => ({ name: a.name, score: decay(a.score, a.last) }))
      .filter(a => a.name && a.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(a => a.name);
  }

  // // ---------------------------------------------------------------------
  // // 5. RANKING DE AUTOPLAY ("Infinity" estilo Apple Music)
  // // candidates: [{ track, source: "recs"|"favorites"|"library"|"history"|"radio", rank }]
  // // ---------------------------------------------------------------------
  rankCandidates(candidates, seed, { limit = 5, exclude = [], explore = 0.15, random = Math.random } = {}) {
    const seedArtist = artistKey(seed);
    const seedKey = songKey(seed);
    const seedVariant = isVariant(seed);
    const sessionArtists = this.sessionArtists();
    const excludeIds = new Set(exclude.map(t => t?.videoId).filter(Boolean));
    const excludeKeys = new Set(exclude.map(t => songKey(t)));
    const sourceWeight = { recs: 1, radio: 1, favorites: 0.8, library: 0.6, history: 0.45 };

    // // 5.1 Filtrar + puntuar
    const seen = new Set();
    const scored = [];
    for (const item of candidates) {
      const track = item?.track;
      const id = track?.videoId;
      if (!id || !/^[a-zA-Z0-9_-]{11}$/.test(id)) continue;
      const key = songKey(track);
      if (id === seed?.videoId || key === seedKey) continue;
      if (seen.has(id) || seen.has(`k:${key}`)) continue;
      if (excludeIds.has(id) || excludeKeys.has(key)) continue;
      if (this.isBlocked(id)) continue;
      if (this.playedRecently(track)) continue;
      const entry = this.tracks[id];
      if (entry && (entry.fastSkips || 0) >= 2 && decay(entry.score, entry.last) < -2) continue;
      seen.add(id); seen.add(`k:${key}`);

      const aKey = artistKey(track);
      let score = (sourceWeight[item.source] ?? 0.5);
      if (Number.isFinite(item.rank) && item.total > 0) score += 0.5 * (1 - item.rank / item.total);
      if (aKey && aKey === seedArtist) score += 0.6;          // // se queda en el estilo
      else if (sessionArtists.includes(aKey)) score += 0.3;   // // coherente con la sesión
      score += clamp(this.trackAffinity(track), -6, 10) * 0.08;
      if (!entry) score += 0.25;                               // // novedad: algo que no has oído
      if (this.artistRejected(track)) score -= 1.2;
      if (isVariant(track) && !seedVariant) score -= 0.8;
      scored.push({ track, score, artist: aKey, source: item.source });
    }

    // // 5.2 Re-ranking por diversidad (estilo MMR): castiga repetir artista
    const lastArtists = this.session.slice(-3).map(s => s.artist);
    const picked = [];
    const pool = [...scored].sort((a, b) => b.score - a.score);
    while (picked.length < limit && pool.length) {
      let bestIndex = 0;
      let bestValue = -Infinity;
      for (let i = 0; i < pool.length; i++) {
        const c = pool[i];
        let redundancy = 0;
        if (picked.length && picked[picked.length - 1].artist === c.artist) redundancy += 1;
        redundancy += picked.filter(p => p.artist === c.artist).length * 0.5;
        if (lastArtists.includes(c.artist)) redundancy += 0.3;
        const value = c.score - 0.7 * redundancy;
        if (value > bestValue) { bestValue = value; bestIndex = i; }
      }
      // // 5.3 Exploración (epsilon-greedy): a veces una opción de la mitad alta
      if (pool.length > 3 && random() < explore) {
        bestIndex = Math.floor(random() * Math.ceil(pool.length / 2));
      }
      picked.push(pool.splice(bestIndex, 1)[0]);
    }
    return picked.map(p => ({ ...p.track, source: "autoplay", autoplaySource: p.source }));
  }

  // // ---------------------------------------------------------------------
  // // 6. SHUFFLE INTELIGENTE
  // // 2014: reparte cada artista con desfase aleatorio + jitter.
  // // 2025: genera N secuencias y elige la más "fresca".
  // // ---------------------------------------------------------------------
  spreadShuffle(tracks, random = Math.random) {
    const groups = new Map();
    for (const track of tracks) {
      const key = artistKey(track) || `_${track.videoId}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(track);
    }
    const placed = [];
    for (const group of groups.values()) {
      const songs = fisherYates(group, random);
      const n = songs.length;
      const spacing = 1 / n;
      const offset = random() * spacing;
      songs.forEach((track, i) => {
        const jitter = (random() - 0.5) * spacing * 0.2;
        placed.push({ track, pos: offset + i * spacing + jitter });
      });
    }
    return placed.sort((a, b) => a.pos - b.pos).map(p => p.track);
  }

  freshness(order) {
    const t = now();
    let penalty = 0;
    order.slice(0, 12).forEach((track, index) => {
      const entry = this.tracks[track.videoId];
      const recent = this.session.some(s => s.videoId === track.videoId);
      const age = entry?.last ? t - entry.last : Infinity;
      const recency = recent ? 1 : Number.isFinite(age) ? Math.exp(-age / (6 * HOUR)) : 0;
      penalty += recency / (index + 1);
    });
    return -penalty;
  }

  smartShuffle(tracks, { candidates = 8, random = Math.random } = {}) {
    const list = (Array.isArray(tracks) ? tracks : []).filter(t => t?.videoId);
    if (list.length < 3) return fisherYates(list, random);
    let best = null;
    let bestScore = -Infinity;
    for (let i = 0; i < candidates; i++) {
      const order = this.spreadShuffle(list, random);
      const score = this.freshness(order);
      if (score > bestScore) { bestScore = score; best = order; }
    }
    return best;
  }

  // // ---------------------------------------------------------------------
  // // 7. AJUSTES Y DIAGNÓSTICO
  // // ---------------------------------------------------------------------
  setSetting(name, value) {
    this.settings[name] = value;
    this.save();
  }

  stats() {
    return {
      tracks: Object.keys(this.tracks).length,
      artists: Object.keys(this.artists).length,
      blocked: Object.keys(this.blocked).length,
      session: this.session.length,
      topArtists: this.topArtists(5),
      settings: { ...this.settings }
    };
  }

  exportData() {
    return { v: 1, tracks: this.tracks, artists: this.artists, settings: this.settings };
  }

  importData(data) {
    if (!data || typeof data !== "object") return false;
    if (data.tracks && typeof data.tracks === "object") this.tracks = data.tracks;
    if (data.artists && typeof data.artists === "object") this.artists = data.artists;
    if (data.settings && typeof data.settings === "object") this.settings = { ...this.settings, ...data.settings };
    this.save(true);
    return true;
  }

  reset() {
    this.tracks = {};
    this.artists = {};
    this.blocked = {};
    this.session = [];
    this.save(true);
  }
}
