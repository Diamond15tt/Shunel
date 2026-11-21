/* SHUNEL — Artist Radio */
import { startArtistRadio } from './recommendations.js';

let currentRadio = null;
let generation = 0;

export async function startRadio(artist, options = {}) {
  const name = String(artist || '').trim().slice(0, 120);
  if (!name) throw new TypeError('Indica el nombre de un artista.');
  const requestId = ++generation;
  currentRadio?.controller.abort();
  const controller = new AbortController();
  currentRadio = { artist: name, controller, tracks: [], index: 0 };
  const tracks = await startArtistRadio(name, { signal: options.signal || controller.signal, limit: options.limit || 15 });
  if (requestId !== generation) return [];
  currentRadio.tracks = tracks;
  document.dispatchEvent(new CustomEvent('shunel:radio-started', { detail: { artist: name, tracks } }));
  return tracks;
}

export function getRadioState() {
  if (!currentRadio) return null;
  return { artist: currentRadio.artist, tracks: [...currentRadio.tracks], index: currentRadio.index };
}

export function stopRadio() {
  generation++;
  currentRadio?.controller.abort();
  currentRadio = null;
  document.dispatchEvent(new CustomEvent('shunel:radio-stopped'));
}

export function playRadioTrack(index = 0) {
  if (!currentRadio || !Number.isInteger(index) || index < 0 || index >= currentRadio.tracks.length) return false;
  currentRadio.index = index;
  const track = currentRadio.tracks[index];
  document.dispatchEvent(new CustomEvent('shunel:play-request', { detail: { track, source: 'artist-radio' } }));
  return true;
}

document.addEventListener('shunel:radio-ready', event => {
  const tracks = event.detail?.tracks;
  if (Array.isArray(tracks)) document.dispatchEvent(new CustomEvent('shunel:radio-results', { detail: event.detail }));
});
