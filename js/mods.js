/* SHUNEL — Mods: packs locales de personalización */
const STORAGE_KEY = 'shunel_mods_v1';
const packs = new Map();
let enabledId = null;

function validPack(pack) {
  return Boolean(pack && typeof pack === 'object' && typeof pack.id === 'string' && /^[a-z0-9_-]{2,48}$/i.test(pack.id) && typeof pack.name === 'string');
}

function readState() {
  try {
    const state = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    enabledId = typeof state.enabledId === 'string' ? state.enabledId : null;
  } catch { enabledId = null; }
}

function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ enabledId })); } catch { /* storage opcional */ }
}

export function registerModPack(pack) {
  if (!validPack(pack)) throw new TypeError('El pack debe incluir id y name válidos.');
  const safe = {
    id: pack.id,
    name: pack.name.slice(0, 80),
    description: String(pack.description || '').slice(0, 240),
    match: {
      title: String(pack.match?.title || '').slice(0, 160),
      artist: String(pack.match?.artist || '').slice(0, 120),
      videoId: String(pack.match?.videoId || '').slice(0, 32)
    },
    override: {
      title: String(pack.override?.title || '').slice(0, 160),
      artist: String(pack.override?.artist || '').slice(0, 120),
      artwork: String(pack.override?.artwork || '').slice(0, 1000)
    },
    theme: pack.theme && typeof pack.theme === 'object' ? pack.theme : {}
  };
  packs.set(safe.id, safe);
  return safe;
}

export function importModPack(json) {
  const pack = typeof json === 'string' ? JSON.parse(json) : json;
  return registerModPack(pack);
}

export function listModPacks() { return [...packs.values()].map(pack => ({ ...pack, enabled: pack.id === enabledId })); }

export function enableModPack(id) {
  if (id !== null && !packs.has(id)) throw new Error('Ese pack no está registrado.');
  enabledId = id;
  saveState();
  applyActiveMod();
  document.dispatchEvent(new CustomEvent('shunel:mods-changed', { detail: { enabledId } }));
}

export function disableModPack() { enableModPack(null); }

function matches(pack, track) {
  const m = pack.match;
  if (m.videoId && m.videoId !== String(track?.videoId || track?.id || '')) return false;
  if (m.title && !String(track?.title || '').toLowerCase().includes(m.title.toLowerCase())) return false;
  if (m.artist && !String(track?.artist || track?.channelTitle || '').toLowerCase().includes(m.artist.toLowerCase())) return false;
  return Boolean(m.videoId || m.title || m.artist);
}

export function applyModToTrack(track) {
  const pack = packs.get(enabledId);
  if (!pack || !matches(pack, track)) return track;
  return {
    ...track,
    title: pack.override.title || track.title,
    artist: pack.override.artist || track.artist || track.channelTitle,
    artwork: pack.override.artwork || track.artwork || track.thumbnail,
    modPackId: pack.id
  };
}

export function applyActiveMod() {
  const pack = packs.get(enabledId);
  const root = document.documentElement;
  root.removeAttribute('data-shunel-mod');
  if (!pack) return;
  root.dataset.shunelMod = pack.id;
  const allowed = ['--shunel-accent', '--shunel-background', '--shunel-surface', '--shunel-text'];
  for (const property of allowed) {
    const value = pack.theme[property];
    if (typeof value === 'string' && /^(#[\da-f]{3,8}|rgb\([\d\s,.%]+\)|hsl\([\d\s,.%deg]+\))$/i.test(value)) root.style.setProperty(property, value);
  }
}

readState();
