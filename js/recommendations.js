/* SHUNEL — Recommendations client */
function clean(value, max = 160) { return String(value ?? '').trim().slice(0, max); }

export async function getRecommendations(track, options = {}) {
  const title = clean(track?.title || track?.name);
  const artist = clean(track?.artist || track?.channelTitle, 120);
  if (!title && !artist) throw new TypeError('Se necesita una canción o artista.');
  const response = await fetch('/api/recommendations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ title, artist, videoId: clean(track?.videoId || track?.id, 32), limit: options.limit || 10 }),
    signal: options.signal
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'No se pudieron cargar recomendaciones.');
  return Array.isArray(data.tracks) ? data.tracks : [];
}

export async function startArtistRadio(artist, options = {}) {
  const tracks = await getRecommendations({ artist }, options);
  document.dispatchEvent(new CustomEvent('shunel:radio-ready', { detail: { artist, tracks } }));
  return tracks;
}
