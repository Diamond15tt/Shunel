
/* =========================================
   SHUNEL — YOUTUBE API
   Búsqueda segura desde Vercel
========================================= */

const YOUTUBE_API = "https://www.googleapis.com/youtube/v3/search";

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

function cleanQuery(value) {
  return String(value || "")
    .trim()
    .slice(0, 150);
}

export default async function handler(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Allow": "GET, OPTIONS",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      }
    });
  }

  if (request.method !== "GET") {
    return jsonResponse({
      error: "Método no permitido."
    }, 405);
  }

  try {
    const apiKey = process.env.YOUTUBE_API_KEY;

    if (!apiKey) {
      return jsonResponse({
        error: "La API de YouTube no está configurada en Vercel."
      }, 500);
    }

    const url = new URL(request.url);

    const query = cleanQuery(url.searchParams.get("q"));
    const maxResults = Math.min(
      20,
      Math.max(
        1,
        Number.parseInt(url.searchParams.get("limit") || "10", 10) || 10
      )
    );

    const pageToken = cleanQuery(
      url.searchParams.get("pageToken")
    );

    if (!query || query.length < 2) {
      return jsonResponse({
        error: "Escribí al menos dos caracteres para buscar."
      }, 400);
    }

    const params = new URLSearchParams({
      part: "snippet",
      q: `${query} music`,
      type: "video",
      videoCategoryId: "10",
      maxResults: String(maxResults),
      safeSearch: "moderate",
      key: apiKey
    });

    if (pageToken) {
      params.set("pageToken", pageToken);
    }

    const response = await fetch(
      `${YOUTUBE_API}?${params.toString()}`,
      {
        headers: {
          Accept: "application/json"
        }
      }
    );

    const result = await response.json();

    if (!response.ok) {
      console.error(
        "[Shunel YouTube] Error de API:",
        result.error?.code || response.status
      );

      return jsonResponse({
        error: "YouTube no pudo completar la búsqueda.",
        code: result.error?.code || response.status
      }, response.status === 403 ? 502 : response.status);
    }

    const videos = (result.items || [])
      .filter(item => item.id?.videoId)
      .map(item => ({
        id: item.id.videoId,
        videoId: item.id.videoId,
        title: item.snippet?.title || "Sin título",
        artist: item.snippet?.channelTitle || "Artista desconocido",
        description: item.snippet?.description || "",
        artwork:
          item.snippet?.thumbnails?.high?.url ||
          item.snippet?.thumbnails?.medium?.url ||
          item.snippet?.thumbnails?.default?.url ||
          "",
        publishedAt: item.snippet?.publishedAt || "",
        source: "youtube",
        url: `https://www.youtube.com/watch?v=${item.id.videoId}`
      }));

    return jsonResponse({
      success: true,
      query,
      results: videos,
      nextPageToken: result.nextPageToken || null,
      totalResults: result.pageInfo?.totalResults || 0
    });

  } catch (error) {
    console.error("[Shunel YouTube] Error interno:", error);

    return jsonResponse({
      error: "Ocurrió un error al buscar música."
    }, 500);
  }
}
