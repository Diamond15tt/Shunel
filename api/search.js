export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ success: false, error: "Método no permitido." });
  }

  const query = String(req.query.q || "").trim();

  if (!query || query.length > 150) {
    return res.status(400).json({ success: false, error: "Escribe una búsqueda válida (máximo 150 caracteres)." });
  }

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    console.error("[Shunel API] Falta YOUTUBE_API_KEY.");
    return res.status(500).json({ success: false, error: "El servicio de búsqueda no está configurado." });
  }

  try {
    const params = new URLSearchParams({
      part: "snippet",
      q: query,
      type: "video",
      videoEmbeddable: "true",
      maxResults: "15",
      safeSearch: "moderate",
      key: apiKey
    });

    const response = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`);
    const data = await response.json();

    if (!response.ok) {
      console.error("[Shunel API] YouTube API:", data.error?.code, data.error?.message);
      const status = data.error?.code === 403 ? 502 : 502;
      return res.status(status).json({
        success: false,
        error: "YouTube rechazó la búsqueda. Revisa la API Key, las restricciones y la cuota del proyecto."
      });
    }

    const items = (data.items || [])
      .filter(item => item.id?.videoId && item.snippet)
      .map(item => ({
        videoId: item.id.videoId,
        title: item.snippet.title || "Sin título",
        channelTitle: item.snippet.channelTitle || "Canal desconocido",
        description: item.snippet.description || "",
        publishedAt: item.snippet.publishedAt || null,
        thumbnail:
          item.snippet.thumbnails?.high?.url ||
          item.snippet.thumbnails?.medium?.url ||
          item.snippet.thumbnails?.default?.url ||
          null
      }));

    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
    return res.status(200).json({
      success: true,
      query,
      total: items.length,
      items
    });
  } catch (error) {
    console.error("[Shunel API] Error:", error);
    return res.status(500).json({ success: false, error: "Error interno al buscar música." });
  }
}
