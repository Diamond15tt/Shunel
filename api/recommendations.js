/* Vercel Function — recomendaciones a través de YouTube Data API */
function text(value, max = 160) { return String(value || '').trim().slice(0, max); }
function send(res, status, body) { res.status(status).setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=3600').json(body); }

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Método no permitido.' });
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return send(res, 503, { error: 'Falta configurar YOUTUBE_API_KEY en Vercel.' });
  const title = text(req.body?.title);
  const artist = text(req.body?.artist, 120);
  const videoId = text(req.body?.videoId, 32);
  const limit = Math.min(20, Math.max(5, Number(req.body?.limit) || 10));
  if (!artist && !title) return send(res, 400, { error: 'Falta la canción o el artista.' });

  try {
    const query = artist && title ? `${artist} canciones similares a ${title}` : `${artist || title} canciones populares`;
    const url = new URL('https://www.googleapis.com/youtube/v3/search');
    url.search = new URLSearchParams({ part: 'snippet', type: 'video', videoCategoryId: '10', maxResults: String(limit + 5), q: query, key }).toString();
    const response = await fetch(url);
    const data = await response.json();
    if (!response.ok) return send(res, response.status === 403 ? 503 : response.status, { error: data.error?.message || 'YouTube no pudo buscar recomendaciones.' });

    const tracks = (data.items || []).filter(item => item.id?.videoId && item.id.videoId !== videoId).slice(0, limit).map(item => ({
      videoId: item.id.videoId,
      id: item.id.videoId,
      title: item.snippet?.title || 'Sin título',
      artist: item.snippet?.channelTitle || '',
      channelTitle: item.snippet?.channelTitle || '',
      thumbnail: item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.medium?.url || '',
      source: 'youtube'
    }));
    return send(res, 200, { tracks, source: 'youtube-search' });
  } catch {
    return send(res, 500, { error: 'No se pudieron cargar las recomendaciones.' });
  }
};
