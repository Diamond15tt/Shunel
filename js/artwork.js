
/* SHUNEL — Artwork manager
 * Portadas por canción + portadas de artista desde el pack activo.
 */

import { getTrackMetadata } from './metadata.js';

import {
  applyModToTrack,
  getArtistArtworkEntry
} from './mods.js';

const FALLBACK = '/assets/logo.png';
const DEEZER_PROXY = 'https://proxy.cors.dev/https://api.deezer.com';
const CACHE_KEY = 'shunel_artist_artwork_v1';

let activeTrackKey = '';
let activeArtwork = FALLBACK;
let activeTrack = null;
let requestController = null;
let initialized = false;

const artistRequests = new Map();

function trackKey(track) {
  return `${track?.videoId || track?.id || ''}|${track?.title || ''}|${track?.artist || track?.channelTitle || ''}`;
}

function normaliseArtist(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function validImageUrl(value) {
  return typeof value === 'string' && (
    /^https:\/\//i.test(value) ||
    /^\/assets\/[a-z0-9_./-]+$/i.test(value)
  );
}

function imageTargets() {
  return [
    document.getElementById('currentThumbnail'),
    document.getElementById('fullPlayerThumbnail'),
    ...document.querySelectorAll('[data-shunel-artwork]')
  ].filter(Boolean);
}

function setImage(image, url, alt) {
  if (!(image instanceof HTMLImageElement)) return;

  image.loading = 'lazy';
  image.decoding = 'async';
  image.alt = alt || 'Portada de la canción';

  image.onerror = () => {
    image.onerror = null;
    image.src = FALLBACK;
  };

  image.src = validImageUrl(url) ? url : FALLBACK;
}

export function applyArtwork(track, url = '') {
  const artwork = validImageUrl(url)
    ? url
    : validImageUrl(track?.artwork)
      ? track.artwork
      : validImageUrl(track?.thumbnail)
        ? track.thumbnail
        : FALLBACK;

  activeArtwork = artwork;

  for (const image of imageTargets()) {
    setImage(
      image,
      artwork,
      `${track?.title || 'Canción'}${track?.artist ? ` — ${track.artist}` : ''}`
    );
  }

  const cssUrl = artwork.replace(/["\\\n\r]/g, '');

  document.documentElement.style.setProperty(
    '--shunel-artwork',
    `url("${cssUrl}")`
  );

  document.dispatchEvent(
    new CustomEvent('shunel:artwork-updated', {
      detail: { track, artwork }
    })
  );

  return artwork;
}

function readArtworkCache() {
  try {
    const value = JSON.parse(
      localStorage.getItem(CACHE_KEY) || '{}'
    );

    return value &&
      typeof value === 'object' &&
      !Array.isArray(value)
        ? value
        : {};

  } catch {
    return {};
  }
}

function writeArtworkCache(cache) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* Caché opcional. */
  }
}

async function fetchArtistArtwork(name, signal) {
  const key = normaliseArtist(name);

  if (!key) return '';

  const cache = readArtworkCache();

  if (validImageUrl(cache[key])) {
    return cache[key];
  }

  if (artistRequests.has(key)) {
    return artistRequests.get(key);
  }

  const request = (async () => {
    const url =
      `${DEEZER_PROXY}/search/artist?q=${encodeURIComponent(name)}&limit=5`;

    const response = await fetch(url, {
      method: 'GET',
      credentials: 'omit',
      signal,
      headers: {
        Accept: 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(
        `No se pudo consultar la portada (${response.status}).`
      );
    }

    const data = await response.json();

    if (data?.error || !Array.isArray(data?.data)) {
      throw new Error(
        'Respuesta inválida al buscar el artista.'
      );
    }

    const match = data.data.find(item =>
      normaliseArtist(item?.name) === key
    );

    const artwork =
      match?.picture_xl ||
      match?.picture_big ||
      match?.picture_medium ||
      '';

    if (!validImageUrl(artwork)) return '';

    cache[key] = artwork;
    writeArtworkCache(cache);

    return artwork;

  })().finally(() => {
    artistRequests.delete(key);
  });

  artistRequests.set(key, request);

  return request;
}

export async function loadArtwork(track, options = {}) {
  if (!track) return FALLBACK;

  const key = trackKey(track);

  if (key === activeTrackKey && !options.force) {
    return activeArtwork;
  }

  activeTrack = track;
  activeTrackKey = key;

  requestController?.abort();
  requestController = new AbortController();

  const signal = options.signal || requestController.signal;

  const moddedTrack = applyModToTrack(track);

  const originalArtwork =
    track.artwork ||
    track.thumbnail ||
    track.metadata?.artwork ||
    '';

  const trackOverride =
    moddedTrack?.modPackId &&
    moddedTrack.artwork !== originalArtwork
      ? moddedTrack.artwork
      : '';

  const artistEntry = getArtistArtworkEntry(track);

  if (validImageUrl(trackOverride)) {
    return applyArtwork(moddedTrack, trackOverride);
  }

  if (validImageUrl(artistEntry?.artwork)) {
    return applyArtwork(track, artistEntry.artwork);
  }

  if (validImageUrl(originalArtwork)) {
    applyArtwork(track, originalArtwork);
  }

  if (artistEntry?.name) {
    try {
      const artistArtwork = await fetchArtistArtwork(
        artistEntry.name,
        signal
      );

      if (key !== activeTrackKey) return activeArtwork;

      if (validImageUrl(artistArtwork)) {
        return applyArtwork(track, artistArtwork);
      }

    } catch (error) {
      if (error?.name === 'AbortError') {
        return activeArtwork;
      }
    }
  }

  try {
    const metadata = await getTrackMetadata(track, {
      signal,
      force: options.force
    });

    if (key !== activeTrackKey) return activeArtwork;

    const artwork =
      metadata?.artwork ||
      originalArtwork ||
      FALLBACK;

    return applyArtwork({
      ...track,
      metadata
    }, artwork);

  } catch (error) {
    if (error?.name === 'AbortError') {
      return activeArtwork;
    }

    return validImageUrl(originalArtwork)
      ? originalArtwork
      : FALLBACK;
  }
}

export function initArtwork() {
  if (initialized) return;

  initialized = true;

  document.addEventListener('shunel:track-change', event => {
    const track = event.detail?.track || event.detail;

    if (track) {
      void loadArtwork(track);
    }
  });

  document.addEventListener('shunel:play-request', event => {
    const track = event.detail?.track || event.detail;

    if (track) {
      void loadArtwork(track);
    }
  });

  document.addEventListener('shunel:mods-changed', () => {
    if (activeTrack) {
      void loadArtwork(activeTrack, { force: true });
    }
  });
}
