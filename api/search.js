
/* =========================================
   SHUNEL — YOUTUBE SEARCH API
   Backend de búsqueda musical
   Version: 2.1.0
========================================= */

"use strict";

const YOUTUBE_API =
  "https://www.googleapis.com/youtube/v3/search";

const MAX_RESULTS = 20;

function sendJSON(res, status, data) {
  res.status(status)
    .setHeader("Content-Type", "application/json; charset=utf-8")
    .setHeader("Cache-Control", "no-store")
    .json(data);
}

function normalizeVideo(item) {
  const videoId = item?.id?.videoId;
  const snippet = item?.snippet;

  if (!videoId || !snippet) return null;

  const thumbnails = snippet.thumbnails || {};

  const thumbnail =
    thumbnails.high?.url ||
    thumbnails.medium?.url ||
    thumbnails.default?.url ||
    "";

  return {
    id: `youtube:${videoId}`,
    videoId,
    youtubeId: videoId,

    title: snippet.title || "Sin título",
    artist: snippet.channelTitle || "Artista desconocido",
    channelTitle: snippet.channelTitle || "",

    thumbnail,
    artwork: thumbnail,

    source: "youtube",
    duration: 0,

    metadata: {
      platform: "YouTube",
      description: snippet.description || "",
      publishedAt: snippet.publishedAt || "",
      channelId: snippet.channelId || ""
    }
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");

    return sendJSON(res, 405, {
      error: "Método no permitido."
    });
  }

  const query = String(req.query?.q || "").trim();

  if (!query) {
    return sendJSON(res, 400, {
      error: "Debes escribir una búsqueda."
    });
  }

  if (query.length > 150) {
    return sendJSON(res, 400, {
      error: "La búsqueda es demasiado larga."
    });
  }

  const apiKey = process.env.YOUTUBE_API_KEY;

  if (!apiKey) {
    console.error("[Shunel API] Falta YOUTUBE_API_KEY.");

    return sendJSON(res, 500, {
      error: "El servicio de búsqueda no está configurado."
    });
  }

  const requestedLimit = Number(req.query?.maxResults);

  const maxResults = Number.isInteger(requestedLimit)
    ? Math.max(1, Math.min(MAX_RESULTS, requestedLimit))
    : 10;

  const params = new URLSearchParams({
    part: "snippet",
    q: query,
    type: "video",
    videoEmbeddable: "true",
    videoSyndicated: "true",
    maxResults: String(maxResults),
    safeSearch: "moderate",
    key: apiKey
  });

  try {
    const response = await fetch(
      `${YOUTUBE_API}?${params.toString()}`
    );

    const data = await response.json();

    if (!response.ok) {
      console.error(
        "[Shunel API] YouTube respondió:",
        data
      );

      if (response.status === 403) {
        return sendJSON(res, 502, {
          error: "YouTube rechazó la búsqueda. Revisa la API Key y su cuota."
        });
      }

      return sendJSON(res, 502, {
        error: "YouTube no pudo completar la búsqueda."
      });
    }

    const results = (data.items || [])
      .map(normalizeVideo)
      .filter(Boolean);

    return sendJSON(res, 200, {
      success: true,
      query,
      totalResults: data.pageInfo?.totalResults || 0,
      results
    });

  } 
} catch (error) {
  console.error("[Shunel] Error de búsqueda:", error);
  console.error("Nombre:", error?.name);
  console.error("Mensaje:", error?.message);
  console.error("Stack:", error?.stack);

  if (requestId !== state.searchRequestId) {
    return false;
  }

  if (error?.name === "AbortError") {
    notify("La búsqueda fue cancelada o tardó demasiado.");
  } else {
    notify(error?.message || "No se pudo realizar la búsqueda.");
  }

  emit("search:error", {
    query: searchQuery,
    name: error?.name || "Error",
    message: error?.message || "Error desconocido"
  });

  return false;
}


    return sendJSON(res, 500, {
      error: "Error interno al buscar canciones."
    });
  }
};
