
const YOUTUBE_API_URL = "https://www.googleapis.com/youtube/v3/search";
const YOUTUBE_EMBED_URL = "https://www.youtube.com/embed/";

export class YouTubeSource {
    constructor(options = {}) {
        this.apiKey = options.apiKey || "";
        this.maxResults = Math.min(
            Math.max(Number(options.maxResults) || 15, 1),
            50
        );
        this.regionCode = options.regionCode || "CR";
        this.language = options.language || "es";
    }

    setApiKey(key) {
        this.apiKey = String(key || "").trim();
    }

    getApiKey() {
        return this.apiKey;
    }

    validateVideoId(videoId) {
        return typeof videoId === "string" &&
            /^[a-zA-Z0-9_-]{11}$/.test(videoId);
    }

    normalize(item) {
        const videoId = item?.id?.videoId || item?.videoId;

        if (!this.validateVideoId(videoId)) {
            throw new Error("Identificador de YouTube no válido.");
        }

        const snippet = item.snippet || item;

        return {
            id: `youtube_${videoId}`,
            videoId,
            sourceId: videoId,
            source: "youtube",
            title: snippet.title || "Sin título",
            artist: snippet.channelTitle || "YouTube",
            album: "",
            artwork:
                snippet.thumbnails?.high?.url ||
                snippet.thumbnails?.medium?.url ||
                snippet.thumbnails?.default?.url ||
                "",
            duration: Number(item.duration) || 0,
            playable: true,
            channelId: snippet.channelId || "",
            publishedAt: snippet.publishedAt || null
        };
    }

    async search(query, options = {}) {
        const term = String(query || "").trim();

        if (!term) return [];
        if (!this.apiKey) {
            throw new Error("Falta configurar la API Key de YouTube.");
        }

        const params = new URLSearchParams({
            part: "snippet",
            type: "video",
            videoCategoryId: "10",
            maxResults: String(
                Math.min(Math.max(Number(options.maxResults) || this.maxResults, 1), 50)
            ),
            q: term,
            key: this.apiKey,
            regionCode: options.regionCode || this.regionCode,
            relevanceLanguage: options.language || this.language,
            safeSearch: "moderate"
        });

        const response = await fetch(`${YOUTUBE_API_URL}?${params}`);

        if (!response.ok) {
            let message = "No se pudo realizar la búsqueda de YouTube.";

            try {
                const errorData = await response.json();
                message = errorData.error?.message || message;
            } catch {
                // Se conserva el mensaje general.
            }

            throw new Error(message);
        }

        const data = await response.json();

        return (data.items || [])
            .map(item => {
                try {
                    return this.normalize(item);
                } catch {
                    return null;
                }
            })
            .filter(Boolean);
    }

    getEmbedUrl(videoId, options = {}) {
        if (!this.validateVideoId(videoId)) {
            throw new Error("Identificador de video no válido.");
        }

        const params = new URLSearchParams({
            enablejsapi: "1",
            playsinline: "1",
            rel: "0",
            origin: window.location.origin
        });

        if (options.start) {
            params.set("start", String(Math.max(0, Math.floor(options.start))));
        }

        return `${YOUTUBE_EMBED_URL}${videoId}?${params}`;
    }

    getThumbnail(videoId, quality = "hqdefault") {
        if (!this.validateVideoId(videoId)) {
            throw new Error("Identificador de video no válido.");
        }

        const allowed = new Set([
            "default",
            "mqdefault",
            "hqdefault",
            "sddefault",
            "maxresdefault"
        ]);

        const selected = allowed.has(quality) ? quality : "hqdefault";

        return `https://img.youtube.com/vi/${videoId}/${selected}.jpg`;
    }

    async getVideoDetails(videoId) {
        if (!this.validateVideoId(videoId)) {
            throw new Error("Identificador de video no válido.");
        }

        if (!this.apiKey) {
            throw new Error("Falta configurar la API Key de YouTube.");
        }

        const params = new URLSearchParams({
            part: "snippet,contentDetails",
            id: videoId,
            key: this.apiKey
        });

        const response = await fetch(
            `https://www.googleapis.com/youtube/v3/videos?${params}`
        );

        if (!response.ok) {
            throw new Error("No se pudieron obtener los datos del video.");
        }

        const data = await response.json();
        const item = data.items?.[0];

        if (!item) return null;

        return this.normalize({
            id: { videoId },
            snippet: item.snippet,
            duration: 0
        });
    }
}

export default YouTubeSource;
