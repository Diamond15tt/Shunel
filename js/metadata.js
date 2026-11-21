/* SHUNEL — Metadata client
 * Obtiene metadatos y portada desde el backend /api/metadata.
 */
const CACHE_PREFIX = 'shunel_metadata_v1:';
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;

function clean(value, max = 180) {
  return String(value ?? '').trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);
}

function cacheRead(key) {
  try {
    const item = JSON.parse(localStorage.getItem(CACHE_PREFIX + key));
    if (!item || Date.now() - item.savedAt > CACHE_TTL) return null;
    return item.data;
  } catch { return null; }
}

function cacheWrite(key, data) {
  try { localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ savedAt: Date.now(), data })); }
  catch { /* El caché es opcional: no debe bloquear la música. */ }
}

export async function getTrackMetadata(track, options = {}) {
  const title = clean(track?.title || track?.name, 160);
  const artist = clean(track?.artist || track?.channelTitle, 120);
  if (!title) throw new TypeError('Falta el título de la canción.');

  const key = encodeURIComponent(`${title}|${artist}`.toLowerCase());
  if (!options.force) {
    const cached = cacheRead(key);
    if (cached) return cached;
  }

  const params = new URLSearchParams({ title, artist });
  const response = await fetch(`/api/metadata?${params}`, {
    signal: options.signal,
    headers: { Accept: 'application/json' }
  });
  if (!response.ok) throw new Error(`No se pudieron obtener los metadatos (${response.status}).`);
  const data = await response.json();
  if (!data || typeof data !== 'object') throw new Error('Respuesta de metadatos inválida.');
  cacheWrite(key, data);
  return data;
}

export async function enrichTrack(track, options = {}) {
  try {
    const metadata = await getTrackMetadata(track, options);
    return { ...track, metadata, album: metadata.album || track.album || '', artwork: metadata.artwork || track.artwork || track.thumbnail || '' };
  } catch (error) {
    if (options.throwOnError) throw error;
    return { ...track, metadataError: error.message };
  }
}
