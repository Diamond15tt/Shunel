
import { storageManager } from "../storage/StorageManager.js";

export class FavoritesManager {
    constructor(storage = storageManager) {
        this.storage = storage;
        this.listeners = new Set();
    }

    async init() {
        await this.storage.init();
        return this;
    }

    subscribe(callback) {
        if (typeof callback !== "function") {
            throw new TypeError("El listener debe ser una función.");
        }

        this.listeners.add(callback);
        return () => this.listeners.delete(callback);
    }

    notify() {
        this.getAll().then(favorites => {
            for (const callback of this.listeners) {
                try {
                    callback(favorites);
                } catch (error) {
                    console.error("Error en listener de favoritos:", error);
                }
            }
        }).catch(error => console.error(error));
    }

    async add(songOrId) {
        const songId = typeof songOrId === "object"
            ? songOrId?.id
            : songOrId;

        if (!songId) throw new Error("Canción no válida.");

        await this.storage.addFavorite(songId);
        this.notify();
        return true;
    }

    async remove(songOrId) {
        const songId = typeof songOrId === "object"
            ? songOrId?.id
            : songOrId;

        if (!songId) return false;

        await this.storage.removeFavorite(songId);
        this.notify();
        return true;
    }

    async toggle(songOrId) {
        const songId = typeof songOrId === "object"
            ? songOrId?.id
            : songOrId;

        if (!songId) throw new Error("Canción no válida.");

        const exists = await this.isFavorite(songId);

        if (exists) {
            await this.remove(songId);
            return false;
        }

        await this.add(songId);
        return true;
    }

    async isFavorite(songId) {
        return this.storage.isFavorite(songId);
    }

    async getAll() {
        const records = await this.storage.getFavorites();
        const songs = await this.storage.getSongs();
        const songMap = new Map(songs.map(song => [song.id, song]));

        return records
            .map(record => songMap.get(record.songId || record.id))
            .filter(Boolean);
    }

    async getIds() {
        const records = await this.storage.getFavorites();
        return records.map(record => record.songId || record.id);
    }

    async clear() {
        const records = await this.storage.getFavorites();

        for (const record of records) {
            await this.storage.removeFavorite(record.songId || record.id);
        }

        this.notify();
    }
}

export const favoritesManager = new FavoritesManager();
export default favoritesManager;
