
/* SHUNEL — Mod packs de portadas por canción */

const STORAGE_KEY = 'shunel_mods_v2';
const LEGACY_KEY = 'shunel_mods_v1';

const packs = new Map();
let enabledId = null;

const THEME_PROPERTIES = [
  '--shunel-accent',
  '--shunel-background',
  '--shunel-surface',
  '--shunel-text'
];

function isObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function clean(value, max = 180) {
  return String(value ?? '')
    .trim()
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .slice(0, max);
}

function safeArtwork(value) {
  if (typeof value !== 'string') return '';

  const url = value.trim();

  return /^https:\/\//i.test(url) ||
    /^\/assets\/[a-z0-9_./-]+$/i.test(url)
    ? url.slice(0, 1000)
    : '';
}

function normalise(value) {
  return clean(value, 180)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function validPack(pack) {
  return isObject(pack) &&
    typeof pack.id === 'string' &&
    /^[a-z0-9_-]{2,48}$/i.test(pack.id) &&
    typeof pack.name === 'string';
}

function normalisePack(pack) {
  const tracks = Array.isArray(pack.tracks)
    ? pack.tracks.slice(0, 2000).filter(isObject).map(item => ({
        title: clean(item.title, 160),
        artist: clean(item.artist, 120),
        album: clean(item.album, 160),
        aliases: Array.isArray(item.aliases)
          ? item.aliases.filter(v => typeof v === 'string')
              .slice(0, 12).map(v => clean(v, 160))
          : [],
        videoId: clean(item.videoId, 32),
        artwork: safeArtwork(item.artwork)
      })).filter(item => item.title && item.artist && item.artwork)
    : [];

  const themeInput = isObject(pack.theme) ? pack.theme : {};
  const theme = {};

  for (const property of THEME_PROPERTIES) {
    const value = themeInput[property];

    if (
      typeof value === 'string' &&
      /^(#[\da-f]{3,8}|rgb\([\d\s,.%]+\)|hsl\([\d\s,.%deg]+\))$/i.test(value.trim())
    ) {
      theme[property] = value.trim();
    }
  }

  return {
    id: pack.id,
    name: clean(pack.name, 80),
    description: clean(pack.description, 240),
    tracks,
    theme
  };
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      enabledId,
      packs: [...packs.values()]
    }));
  } catch {
    /* El almacenamiento es opcional. */
  }
}

function readState() {
  try {
    let state = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');

    if (!state) {
      const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || '{}');

      state = {
        enabledId: null,
        packs: Array.isArray(legacy.packs) ? legacy.packs : []
      };
    }

    if (Array.isArray(state.packs)) {
      for (const item of state.packs) {
        if (!validPack(item)) continue;

        const pack = normalisePack(item);
        packs.set(pack.id, pack);
      }
    }

    enabledId =
      typeof state.enabledId === 'string' && packs.has(state.enabledId)
        ? state.enabledId
        : null;

  } catch {
    enabledId = null;
  }
}

export function registerModPack(input) {
  if (!validPack(input)) {
    throw new TypeError('El pack debe incluir un id y un nombre válidos.');
  }

  const pack = normalisePack(input);
  packs.set(pack.id, pack);
  saveState();

  return pack;
}

export function importModPack(json) {
  const pack = typeof json === 'string' ? JSON.parse(json) : json;
  return registerModPack(pack);
}

export function listModPacks() {
  return [...packs.values()].map(pack => ({
    ...pack,
    enabled: pack.id === enabledId,
    trackCount: pack.tracks.length
  }));
}

export function getEnabledModPack() {
  return enabledId ? packs.get(enabledId) || null : null;
}

function matchesTrack(entry, track) {
  const title = normalise(track?.title || track?.name);
  const artist = normalise(track?.artist || track?.channelTitle);
  const videoId = String(track?.videoId || track?.id || '');

  if (entry.videoId && entry.videoId === videoId) return true;

  const titles = [entry.title, ...entry.aliases].map(normalise);
  const titleMatch = titles.some(value => value && value === title);

  const artistMatch = normalise(entry.artist) === artist;

  return titleMatch && artistMatch;
}

export function getTrackArtworkEntry(track) {
  const pack = getEnabledModPack();

  if (!pack || !track) return null;

  return pack.tracks.find(entry => matchesTrack(entry, track)) || null;
}

export function getArtistArtworkEntry() {
  return null;
}

export function enableModPack(id) {
  if (id !== null && !packs.has(id)) {
    throw new Error('Ese pack no está registrado.');
  }

  enabledId = id;
  saveState();
  applyActiveMod();

  document.dispatchEvent(new CustomEvent('shunel:mods-changed', {
    detail: { enabledId }
  }));
}

export function disableModPack() {
  enableModPack(null);
}

export function applyModToTrack(track) {
  if (!track) return track;

  const entry = getTrackArtworkEntry(track);

  if (!entry) return track;

  return {
    ...track,
    album: entry.album || track.album || '',
    artwork: entry.artwork,
    modPackId: enabledId
  };
}

export function applyActiveMod() {
  const root = document.documentElement;
  const pack = getEnabledModPack();

  root.removeAttribute('data-shunel-mod');

  for (const property of THEME_PROPERTIES) {
    root.style.removeProperty(property);
  }

  if (!pack) return;

  root.dataset.shunelMod = pack.id;

  for (const property of THEME_PROPERTIES) {
    if (pack.theme[property]) {
      root.style.setProperty(property, pack.theme[property]);
    }
  }
}

readState();
