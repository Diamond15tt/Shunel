
import { storageManager } from "../storage/StorageManager.js";

export class PlaylistManager {
    constructor(storage = storageManager) {
        this.storage = storage;
        this.listeners = new Set();
    }

    async init() {
        await this.storage.init();
        return this;
    }

    subscribe(callback) {
        this.listeners.add(callback);
        return () => this.listeners.delete(callback);
    }

    notify() {
        this.getAll().then(playlists => {
            for (const callback of this.listeners) {
                try {
                    callback(playlists);
                } catch (error) {
                    console.error("Error en listener de playlists:", error);
                }
            }
        }).catch(error => console.error(error));
    }

    async create(name, description = "") {
        const cleanName = String(name || "").trim();

        if (!cleanName) {
            throw new Error("El nombre de la playlist no puede estar vacío.");
        }

        const playlist = {
            id: this.storage.createId("playlist"),
            name: cleanName,
            description: String(description || "").trim(),
            songs: [],
            createdAt: Date.now(),
            updatedAt: Date.now()
        };

        await this.storage.savePlaylist(playlist);
        this.notify();

        return playlist;
    }

    async getAll() {
        const playlists = await this.storage.getPlaylists();

        return playlists.sort(
            (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)
        );
    }

    async getById(id) {
        if (!id) return null;

        const playlist = await this.storage.getPlaylist(id);
        if (!playlist) return null;

        const songs = await this.storage.getSongs();
        const songMap = new Map(songs.map(song => [song.id, song]));

        return {
            ...playlist,
            songs: (playlist.songs || [])
                .map(songId => songMap.get(songId))
                .filter(Boolean)
        };
    }

    async rename(id, newName) {
        const playlist = await this.storage.getPlaylist(id);
        const cleanName = String(newName || "").trim();

        if (!playlist) throw new Error("Playlist no encontrada.");
        if (!cleanName) throw new Error("El nombre no puede estar vacío.");

        playlist.name = cleanName;
        playlist.updatedAt = Date.now();

        await this.storage.savePlaylist(playlist);
        this.notify();

        return playlist;
    }

    async updateDescription(id, description) {
        const playlist = await this.storage.getPlaylist(id);
        if (!playlist) throw new Error("Playlist no encontrada.");

        playlist.description = String(description || "").trim();
        playlist.updatedAt = Date.now();

        await this.storage.savePlaylist(playlist);
        this.notify();

        return playlist;
    }

    async addSong(playlistId, songOrId) {
        const songId = typeof songOrId === "object"
            ? songOrId?.id
            : songOrId;

        const playlist = await this.storage.getPlaylist(playlistId);
        if (!playlist) throw new Error("Playlist no encontrada.");
        if (!songId) throw new Error("Canción no válida.");

        const song = await this.storage.getSong(songId);
        if (!song) throw new Error("La canción no está guardada en la biblioteca.");

        playlist.songs = playlist.songs || [];

        if (!playlist.songs.includes(songId)) {
            playlist.songs.push(songId);
            playlist.updatedAt = Date.now();
            await this.storage.savePlaylist(playlist);
            this.notify();
        }

        return playlist;
    }

    async removeSong(playlistId, songOrId) {
        const songId = typeof songOrId === "object"
            ? songOrId?.id
            : songOrId;

        const playlist = await this.storage.getPlaylist(playlistId);
        if (!playlist) throw new Error("Playlist no encontrada.");

        playlist.songs = (playlist.songs || []).filter(id => id !== songId);
        playlist.updatedAt = Date.now();

        await this.storage.savePlaylist(playlist);
        this.notify();

        return playlist;
    }

    async reorder(playlistId, orderedSongIds) {
        const playlist = await this.storage.getPlaylist(playlistId);
        if (!playlist) throw new Error("Playlist no encontrada.");
        if (!Array.isArray(orderedSongIds)) {
            throw new TypeError("Se esperaba una lista de canciones.");
        }

        const existing = new Set(playlist.songs || []);
        const requested = orderedSongIds.filter(id => existing.has(id));

        playlist.songs = [...new Set(requested)];
        playlist.updatedAt = Date.now();

        await this.storage.savePlaylist(playlist);
        this.notify();

        return playlist;
    }

    async delete(id) {
        if (!id) return false;

        await this.storage.deletePlaylist(id);
        this.notify();

        return true;
    }

    async clear() {
        const playlists = await this.storage.getPlaylists();

        for (const playlist of playlists) {
            await this.storage.deletePlaylist(playlist.id);
        }

        this.notify();
    }
}

export const playlistManager = new PlaylistManager();
export default playlistManager;
