/* SHUNEL — Artwork manager
 * Compatible con los IDs del reproductor presentes en index.html.
 */
import { getTrackMetadata } from './metadata.js';

const FALLBACK = '/assets/logo.png';
let activeTrackKey = '';
let requestController = null;

function trackKey(track) { return `${track?.videoId || track?.id || ''}|${track?.title || ''}|${track?.artist || track?.channelTitle || ''}`; }

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
  image.src = url || FALLBACK;
}

export function applyArtwork(track, url = '') {
  const artwork = url || track?.artwork || track?.thumbnail || track?.metadata?.artwork || FALLBACK;
  for (const image of imageTargets()) setImage(image, artwork, `${track?.title || 'Canción'}${track?.artist ? ` — ${track.artist}` : ''}`);
  document.documentElement.style.setProperty('--shunel-artwork', `url("${artwork.replace(/["\\]/g, '')}")`);
  document.dispatchEvent(new CustomEvent('shunel:artwork-updated', { detail: { track, artwork } }));
  return artwork;
}

export async function loadArtwork(track, options = {}) {
  if (!track) return FALLBACK;
  const key = trackKey(track);
  if (key === activeTrackKey && !options.force) return track.artwork || track.thumbnail || FALLBACK;
  activeTrackKey = key;
  requestController?.abort();
  requestController = new AbortController();
  const signal = options.signal || requestController.signal;

  const immediate = track.artwork || track.thumbnail || track.metadata?.artwork;
  if (immediate) applyArtwork(track, immediate);

  try {
    const metadata = await getTrackMetadata(track, { signal, force: options.force });
    if (key !== activeTrackKey) return immediate || FALLBACK;
    const artwork = metadata.artwork || immediate || FALLBACK;
    applyArtwork({ ...track, metadata }, artwork);
    return artwork;
  } catch {
    return immediate || FALLBACK;
  }
}

export function initArtwork() {
  document.addEventListener('shunel:track-change', event => {
    const track = event.detail?.track || event.detail;
    if (track) void loadArtwork(track);
  });
  document.addEventListener('shunel:play-request', event => {
    const track = event.detail?.track || event.detail;
    if (track) void loadArtwork(track);
  });
}
