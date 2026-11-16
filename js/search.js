const SEARCH_ENDPOINT = "/api/search";

export async function searchTracks(query, signal) {
  const cleanQuery = String(query || "").trim();

  if (!cleanQuery) throw new Error("Escribe qué música quieres buscar.");
  if (cleanQuery.length > 150) throw new Error("La búsqueda es demasiado larga.");

  const url = new URL(SEARCH_ENDPOINT, window.location.origin);
  url.searchParams.set("q", cleanQuery);

  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "No se pudo buscar en YouTube.");
  }

  if (!Array.isArray(data.items)) {
    throw new Error("YouTube devolvió una respuesta inesperada.");
  }

  return data.items.filter(track =>
    track &&
    typeof track.videoId === "string" &&
    /^[a-zA-Z0-9_-]{11}$/.test(track.videoId)
  );
}
