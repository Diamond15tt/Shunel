/**
 * SHUNEL
 * StorageManager.js
 *
 * Capa de alto nivel sobre IndexedDB.
 * Gestiona canciones, playlists, favoritos, historial y ajustes.
 */

import { dbManager } from "./DBManager.js";

export class StorageManager {
  #db;
  #initialized = false;

  /**
   * @param {Object} [database=dbManager]
   */
  constructor(database = dbManager) {
    this.#db = database;
  }

  get isReady() {
    return this.#initialized;
  }

  /**
   * Inicializa la base de datos.
   * @returns {Promise<this>}
   */
  async init() {
    if (this.#initialized) return this;
    await this.#db.init();
    this.#initialized = true;
    return this;
  }

  async #ensureReady() {
    if (!this.#initialized) {
      await this.init();
    }
  }

  /**
   * Genera un ID único.
   * @param {string} [prefix="item"]
   * @returns {string}
   */
  createId(prefix = "item") {
    if (globalThis.crypto?.randomUUID) {
      return `${prefix}_${crypto.randomUUID()}`;
    }
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  // ==========================================
  // CANCIONES
  // ==========================================

  /**
   * Guarda o actualiza una canción.
   * @param {Object} song
   * @returns {Promise<Object>}
   */
  async saveSong(song) {
    await this.#ensureReady();

    if (!song?.id) {
      throw new Error("[Shunel StorageManager] La canción necesita un ID.");
    }

    const record = {
      ...song,
      updatedAt: Date.now()
    };

    await this.#db.put("songs", record);
    return record;
  }

  async getSong(id) {
    await this.#ensureReady();
    return this.#db.get("songs", id);
  }

  async getSongs() {
    await this.#ensureReady();
    return this.#db.getAll("songs");
  }

  /**
   * Elimina una canción y limpia referencias (favoritos, historial, playlists).
   * @param {string} id
   */
  async deleteSong(id) {
    await this.#ensureReady();

    await this.#db.delete("songs", id);
    await this.removeFavorite(id);
    await this.removeSongFromHistory(id);

    const playlists = await this.getPlaylists();

    for (const playlist of playlists) {
      const songs = (playlist.songs || []).filter((songId) => songId !== id);

      if (songs.length !== (playlist.songs || []).length) {
        await this.savePlaylist({
          ...playlist,
          songs
        });
      }
    }
  }

  // ==========================================
  // PLAYLISTS
  // ==========================================

  /**
   * Guarda o actualiza una playlist.
   * @param {Object} playlist
   * @returns {Promise<Object>}
   */
  async savePlaylist(playlist) {
    await this.#ensureReady();

    if (!playlist?.id) {
      throw new Error("[Shunel StorageManager] La playlist necesita un ID.");
    }

    const record = {
      songs: [],
      createdAt: Date.now(),
      ...playlist,
      updatedAt: Date.now()
    };

    // Eliminar duplicados
    record.songs = [...new Set(record.songs || [])];

    await this.#db.put("playlists", record);
    return record;
  }

  async getPlaylist(id) {
    await this.#ensureReady();
    return this.#db.get("playlists", id);
  }

  async getPlaylists() {
    await this.#ensureReady();
    return this.#db.getAll("playlists");
  }

  async deletePlaylist(id) {
    await this.#ensureReady();
    return this.#db.delete("playlists", id);
  }

  /**
   * Añade una canción a una playlist (sin duplicados).
   * @param {string} playlistId
   * @param {string} songId
   * @returns {Promise<Object|null>}
   */
  async addSongToPlaylist(playlistId, songId) {
    await this.#ensureReady();

    const playlist = await this.getPlaylist(playlistId);
    if (!playlist) return null;

    const songs = playlist.songs || [];
    if (songs.includes(songId)) return playlist;

    return this.savePlaylist({
      ...playlist,
      songs: [...songs, songId]
    });
  }

  /**
   * Quita una canción de una playlist.
   * @param {string} playlistId
   * @param {string} songId
   * @returns {Promise<Object|null>}
   */
  async removeSongFromPlaylist(playlistId, songId) {
    await this.#ensureReady();

    const playlist = await this.getPlaylist(playlistId);
    if (!playlist) return null;

    return this.savePlaylist({
      ...playlist,
      songs: (playlist.songs || []).filter((id) => id !== songId)
    });
  }

  // ==========================================
  // FAVORITOS
  // ==========================================

  async addFavorite(songId) {
    await this.#ensureReady();

    if (!songId) {
      throw new Error("[Shunel StorageManager] ID de canción no válido.");
    }

    return this.#db.put("favorites", {
      id: songId,
      songId,
      addedAt: Date.now()
    });
  }

  async removeFavorite(songId) {
    await this.#ensureReady();
    return this.#db.delete("favorites", songId);
  }

  async getFavorites() {
    await this.#ensureReady();
    return this.#db.getAll("favorites");
  }

  async isFavorite(songId) {
    await this.#ensureReady();
    return Boolean(await this.#db.get("favorites", songId));
  }

  /**
   * Alterna el estado de favorito.
   * @param {string} songId
   * @returns {Promise<boolean>} true si quedó como favorito
   */
  async toggleFavorite(songId) {
    const isFav = await this.isFavorite(songId);

    if (isFav) {
      await this.removeFavorite(songId);
      return false;
    }

    await this.addFavorite(songId);
    return true;
  }

  // ==========================================
  // HISTORIAL
  // ==========================================

  async addHistory(songId, metadata = {}) {
    await this.#ensureReady();

    if (!songId) {
      throw new Error("[Shunel StorageManager] ID de canción no válido.");
    }

    const record = {
      id: songId,
      songId,
      playedAt: Date.now(),
      ...metadata
    };

    await this.#db.put("history", record);
    return record;
  }

  /**
   * Obtiene el historial ordenado (más reciente primero).
   * @param {number} [limit=100]
   * @returns {Promise<Object[]>}
   */
  async getHistory(limit = 100) {
    await this.#ensureReady();

    const records = await this.#db.getAll("history");
    return records
      .sort((a, b) => (b.playedAt || 0) - (a.playedAt || 0))
      .slice(0, Math.max(0, limit));
  }

  async removeSongFromHistory(songId) {
    await this.#ensureReady();
    return this.#db.delete("history", songId);
  }

  async clearHistory() {
    await this.#ensureReady();
    return this.#db.clear("history");
  }

  // ==========================================
  // AJUSTES
  // ==========================================

  async saveSetting(key, value) {
    await this.#ensureReady();

    if (!key) {
      throw new Error("[Shunel StorageManager] La configuración necesita una clave.");
    }

    return this.#db.put("settings", {
      key,
      value,
      updatedAt: Date.now()
    });
  }

  async getSetting(key, fallback = null) {
    await this.#ensureReady();

    const record = await this.#db.get("settings", key);
    return record ? record.value : fallback;
  }

  async getAllSettings() {
    await this.#ensureReady();
    return this.#db.getAll("settings");
  }

  // ==========================================
  // UTILIDADES
  // ==========================================

  async exportData() {
    await this.#ensureReady();
    return this.#db.exportAll?.() ?? null;
  }

  async clearAllData() {
    await this.#ensureReady();
    await this.#db.clearAll?.();
  }

  close() {
    this.#db.close?.();
    this.#initialized = false;
  }
}

// Instancia singleton lista para usar
export const storageManager = new StorageManager();
export default storageManager;