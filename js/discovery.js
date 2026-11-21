/* SHUNEL — Discovery */
const SEARCH_ENDPOINT = '/api/search';

export async function discoverTracks(query, options = {}) {
  const value = String(query || '').trim().slice(0, 180);
  if (!value) return [];
  const params = new URLSearchParams({ q: value });
  const response = await fetch(`${SEARCH_ENDPOINT}?${params}`, { signal: options.signal, headers: { Accept: 'application/json' } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'No se pudo completar el descubrimiento.');
  const tracks = Array.isArray(data.tracks) ? data.tracks : Array.isArray(data.items) ? data.items : [];
  document.dispatchEvent(new CustomEvent('shunel:discovery-results', { detail: { query: value, tracks } }));
  return tracks;
}

export async function discoverByMood(mood, options = {}) {
  const moods = {
    energia: 'música energética canciones populares',
    tranquilo: 'música tranquila chill',
    fiesta: 'música para fiesta hits',
    romantico: 'música romántica canciones',
    enfoque: 'música instrumental para concentrarse'
  };
  const key = String(mood || '').toLowerCase();
  if (!Object.hasOwn(moods, key)) throw new TypeError('Estado de ánimo no reconocido.');
  return discoverTracks(moods[key], options);
}
