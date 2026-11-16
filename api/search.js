
/* =========================================
   SHUNEL — MUSIC SEARCH API
   YouTube Data API v3
   Version: 1.0.0
========================================= */

"use strict";

const YOUTUBE_API = "https://www.googleapis.com/youtube/v3";

module.exports = async function handler(req, res) {
  // Solo aceptar solicitudes GET
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({
      success: false,
      error: "METHOD_NOT_ALLOWED",
      message: "Método no permitido."
    });
  }

  // Leer búsqueda
  const query = String(req.query?.q || "").trim();

  if (!query) {
    return res.status(400).json({
      success: false,
      error: "EMPTY_QUERY",
      message: "Escribe el nombre de una canción o artista."
    });
  }

  if (query.length > 100) {
    return res.status(400).json({
      success: false,
      error: "QUERY_TOO_LONG",
      message: "La búsqueda es demasiado larga."
    });
  }

  // API key privada
  const apiKey = process.env.YOUTUBE_API_KEY;

  if (!apiKey) {
    console.error("[Shunel Search] Falta YOUTUBE_API_KEY");

    return res.status(500).json({
      success: false,
      error: "SERVER_CONFIGURATION_ERROR",
      message: "El servicio de búsqueda no está configurado."
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    // Buscar videos musicales
    const searchURL = new URL(`${YOUTUBE_API}/search`);

    searchURL.search = new URLSearchParams({
      part: "snippet",
      q: query,
      type: "video",
      videoCategoryId: "10",
      maxResults: "20",
      order: "relevance",
      safeSearch: "none",
      key: apiKey
    }).toString();

    const searchResponse = await fetch(searchURL, {
      signal: controller.signal
    });

    const searchData = await searchResponse.json();

    if (!searchResponse.ok) {
      console.error(
        "[Shunel Search] YouTube error:",
        searchData.error?.code,
        searchData.error?.message
      );

      return res.status(502).json({
        success: false,
        error: "YOUTUBE_API_ERROR",
        message: "No se pudo consultar YouTube.",
        details: searchData.error?.message || null
      });
    }

    const videos = searchData.items || [];

    if (!videos.length) {
      return res.status(200).json({
        success: true,
        query,
        total: 0,
        results: []
      });
    }

    const videoIds = videos
      .map(video => video.id?.videoId)
      .filter(Boolean);

    // Obtener duración y disponibilidad para insertar
    const detailsURL = new URL(`${YOUTUBE_API}/videos`);

    detailsURL.search = new URLSearchParams({
      part: "contentDetails,status",
      id: videoIds.join(","),
      key: apiKey
    }).toString();

    const detailsResponse = await fetch(detailsURL, {
      signal: controller.signal
    });

    const detailsData = detailsResponse.ok
      ? await detailsResponse.json()
      : { items: [] };

    const detailsMap = new Map(
      (detailsData.items || []).map(video => [
        video.id,
        video
      ])
    );

    // Formatear resultados
    const results = videos
      .map(video => {
        const id = video.id?.videoId;
        const snippet = video.snippet;

        if (!id || !snippet) return null;

        const details = detailsMap.get(id);

        return {
          id,
          videoId: id,
          title: snippet.title || "Sin título",
          artist: snippet.channelTitle || "Artista desconocido",
          channelTitle: snippet.channelTitle || "",
          description: snippet.description || "",
          thumbnail:
            snippet.thumbnails?.high?.url ||
            snippet.thumbnails?.medium?.url ||
            snippet.thumbnails?.default?.url ||
            "",
          duration: details?.contentDetails?.duration || null,
          embeddable: details?.status?.embeddable ?? true,
          source: "youtube",
          url: `https://www.youtube.com/watch?v=${id}`
        };
      })
      .filter(Boolean);

    return res.status(200).json({
      success: true,
      query,
      total: results.length,
      results
    });

  } catch (error) {
    console.error("[Shunel Search] Error:", error);

    const isTimeout = error.name === "AbortError";

    return res.status(isTimeout ? 504 : 500).json({
      success: false,
      error: isTimeout ? "REQUEST_TIMEOUT" : "SEARCH_FAILED",
      message: isTimeout
        ? "YouTube tardó demasiado en responder."
        : "Ocurrió un error al buscar música."
    });

  } finally {
    clearTimeout(timeout);
  }
};
