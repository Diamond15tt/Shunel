
import { storageManager } from "../storage/StorageManager.js";

const SUPPORTED_TYPES = new Set([
    "audio/mpeg",
    "audio/mp3",
    "audio/wav",
    "audio/x-wav",
    "audio/ogg",
    "audio/flac",
    "audio/mp4",
    "audio/aac",
    "audio/x-m4a",
    "audio/webm"
]);

const SUPPORTED_EXTENSIONS = /\.(mp3|wav|ogg|flac|m4a|aac|mp4|webm)$/i;

export class LocalAudioSource {
    constructor(options = {}) {
        this.storage = options.storage || storageManager;
        this.audio = options.audio || null;
        this.urls = new Map();
    }

    setAudioElement(audioElement) {
        if (!(audioElement instanceof HTMLAudioElement)) {
            throw new TypeError("Se necesita un elemento HTMLAudioElement.");
        }

        this.audio = audioElement;
        return this;
    }

    validateFile(file) {
        if (!(file instanceof Blob)) {
            throw new TypeError("El archivo seleccionado no es válido.");
        }

        const validType = SUPPORTED_TYPES.has(file.type);
        const validExtension = SUPPORTED_EXTENSIONS.test(file.name || "");

        if (!validType && !validExtension) {
            throw new Error("Formato de audio no compatible.");
        }

        if (file.size === 0) {
            throw new Error("El archivo está vacío.");
        }

        return true;
    }

    async readMetadata(file) {
        const url = URL.createObjectURL(file);

        try {
            return await new Promise((resolve, reject) => {
                const audio = document.createElement("audio");
                audio.preload = "metadata";
                audio.src = url;

                audio.onloadedmetadata = () => {
                    resolve({
                        duration: Number.isFinite(audio.duration)
                            ? audio.duration
                            : 0
                    });
                };

                audio.onerror = () => reject(
                    new Error("No se pudieron leer los datos del audio.")
                );
            });
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    async importFile(file) {
        this.validateFile(file);
        await this.storage.init();

        const metadata = await this.readMetadata(file);
        const id = this.storage.createId("local");

        const song = {
            id,
            title: (file.name || "Audio").replace(/\.[^/.]+$/, ""),
            artist: "Archivo local",
            album: "",
            artwork: "",
            duration: metadata.duration,
            source: "local",
            sourceId: id,
            playable: true,
            fileName: file.name || "audio",
            mimeType: file.type || "application/octet-stream",
            size: file.size,
            blob: file,
            addedAt: Date.now()
        };

        await this.storage.saveSong(song);

        return song;
    }

    async importFiles(fileList) {
        const files = Array.from(fileList || []);
        const imported = [];
        const errors = [];

        for (const file of files) {
            try {
                imported.push(await this.importFile(file));
            } catch (error) {
                errors.push({
                    file: file?.name || "Archivo desconocido",
                    message: error.message
                });
            }
        }

        return { imported, errors };
    }

    async getFile(songOrId) {
        const id = typeof songOrId === "object"
            ? songOrId?.id
            : songOrId;

        if (!id) throw new Error("ID de canción no válido.");

        const song = await this.storage.getSong(id);

        if (!song || song.source !== "local" || !(song.blob instanceof Blob)) {
            throw new Error("No se encontró el archivo de audio guardado.");
        }

        return song.blob;
    }

    async createObjectURL(songOrId) {
        const id = typeof songOrId === "object"
            ? songOrId?.id
            : songOrId;

        if (this.urls.has(id)) return this.urls.get(id);

        const blob = await this.getFile(id);
        const url = URL.createObjectURL(blob);

        this.urls.set(id, url);
        return url;
    }

    async load(songOrId, audioElement = this.audio) {
        if (!audioElement) {
            throw new Error("No se ha configurado el reproductor de audio.");
        }

        const url = await this.createObjectURL(songOrId);

        audioElement.pause();
        audioElement.src = url;
        audioElement.load();

        return url;
    }

    async play(songOrId, audioElement = this.audio) {
        await this.load(songOrId, audioElement);
        await audioElement.play();
        return true;
    }

    pause(audioElement = this.audio) {
        if (!audioElement) return;
        audioElement.pause();
    }

    revoke(songOrId) {
        const id = typeof songOrId === "object"
            ? songOrId?.id
            : songOrId;

        const url = this.urls.get(id);

        if (url) {
            URL.revokeObjectURL(url);
            this.urls.delete(id);
        }
    }

    revokeAll() {
        for (const url of this.urls.values()) {
            URL.revokeObjectURL(url);
        }

        this.urls.clear();
    }

    async delete(songOrId) {
        const id = typeof songOrId === "object"
            ? songOrId?.id
            : songOrId;

        if (!id) return false;

        if (this.audio?.src === this.urls.get(id)) {
            this.audio.pause();
            this.audio.removeAttribute("src");
            this.audio.load();
        }

        this.revoke(id);
        await this.storage.deleteSong(id);

        return true;
    }

    destroy() {
        this.pause();
        this.revokeAll();
        this.audio = null;
    }
}

export default LocalAudioSource;
