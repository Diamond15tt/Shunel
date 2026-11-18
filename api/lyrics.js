export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const { videoId } = req.query;
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: "videoId inválido" });
  }

  try {
    // Obtener el HTML de la página del video para extraer las pistas de subtítulos nativas sin dependencias externas
    const watchRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: { "Accept-Language": "es,en;q=0.9" }
    });
    const html = await watchRes.text();

    const captionMatch = html.match(/"captionTracks":(\[.*?\])/);
    if (!captionMatch) {
      return res.status(404).json({ error: "El video no tiene subtítulos" });
    }

    const tracks = JSON.parse(captionMatch[1]);
    if (!tracks.length) {
      return res.status(404).json({ error: "Sin pistas disponibles" });
    }

    // Descargar el XML de los subtítulos y limpiar etiquetas
    const subRes = await fetch(tracks[0].baseUrl);
    const xml = await subRes.text();

    const text = [...xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)]
      .map(m =>
        m[1]
          .replace(/&amp;/g, "&")
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/<[^>]+>/g, "")
          .trim()
      )
      .filter(Boolean)
      .join("\n");

    return res.status(200).json({ text });
  } catch (err) {
    return res.status(500).json({ error: "Error extrayendo subtítulos" });
  }
}
