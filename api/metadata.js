/* Vercel Function — MusicBrainz + Cover Art Archive metadata */
const USER_AGENT = 'Shunel/1.0 (https://github.com/Diamond15tt/Shunel)';

function text(value, max = 160) { return String(value || '').trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max); }
function send(res, status, body) { res.status(status).setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800').json(body); }

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, { error: 'Método no permitido.' });
  const title = text(req.query?.title);
  const artist = text(req.query?.artist, 120);
  if (!title) return send(res, 400, { error: 'Falta el título.' });

  try {
    const query = [`release:${title}`, artist ? `artist:${artist}` : ''].filter(Boolean).join(' AND ');
    const url = new URL('https://musicbrainz.org/ws/2/release-group/');
    url.search = new URLSearchParams({ query, fmt: 'json', limit: '5' }).toString();
    const lookup = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
    if (!lookup.ok) return send(res, lookup.status === 503 ? 503 : 502, { error: 'MusicBrainz no respondió correctamente.' });
    const payload = await lookup.json();
    const groups = Array.isArray(payload['release-groups']) ? payload['release-groups'] : [];
    const best = groups[0];
    if (!best?.id) return send(res, 200, { title, artist, album: '', artwork: '', source: 'none' });

    let artwork = '';
    const coverUrl = `https://coverartarchive.org/release-group/${encodeURIComponent(best.id)}/front-500`;
    const cover = await fetch(coverUrl, { method: 'HEAD', redirect: 'follow', headers: { 'User-Agent': USER_AGENT } }).catch(() => null);
    if (cover?.ok) artwork = cover.url || coverUrl;
    return send(res, 200, {
      title: best.title || title,
      artist: best['artist-credit']?.map(item => item.name || item.artist?.name).filter(Boolean).join('') || artist,
      album: best.title || '',
      date: best['first-release-date'] || '',
      artwork,
      musicbrainzId: best.id,
      source: artwork ? 'musicbrainz-cover-art-archive' : 'musicbrainz'
    });
  } catch {
    return send(res, 500, { error: 'No se pudieron consultar los metadatos.' });
  }
};
