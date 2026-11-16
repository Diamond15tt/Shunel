import { storageManager } from "../storage/StorageManager.js";

export class HistoryManager {
  #storage;
  #maxEntries;
  #listeners;

  constructor(storage = storageManager, maxEntries = 500) {
    if (!storage || typeof storage.init !== "function") {
      throw new TypeError("HistoryManager requiere un gestor de almacenamiento válido.");
    }

    this.#storage = storage;
    this.#maxEntries = Number(maxEntries) > 0 ? Number(maxEntries) : 500;
    this.#listeners = new Set();
  }

  async init() {
    await this.#storage.init();
    return this;
  }

  subscribe(callback) {
    if (typeof callback !== "function") {
      throw new TypeError("El listener debe ser una función.");
    }

    this.#listeners.add(callback);
    
    // Retorna función de desuscripción limpia
    return () => {
      this.#listeners.delete(callback);
    };
  }

  async notify() {
    try {
      const history = await this.getAll();
      // Usar Array.from previene problemas si un listener se modifica durante la ejecución
      for (const callback of Array.from(this.#listeners)) {
        try {
          callback(history);
        } catch (error) {
          console.error("Error en un listener del historial:", error);
        }
      }
    } catch (error) {
      console.error("Error al notificar el historial:", error);
    }
  }

  async add(songOrId, metadata = {}) {
    const songId = typeof songOrId === "object" ? songOrId?.id : songOrId;

    if (!songId) {
      throw new Error("No se puede añadir al historial: ID de canción no válido.");
    }

    const songData = typeof songOrId === "object" ? songOrId : {};

    const record = await this.#storage.addHistory(songId, {
      id: this.#storage.createId("history"),
      songId,
      title: songData.title || metadata.title || "",
      artist: songData.artist || metadata.artist || "",
      artwork: songData.artwork || metadata.artwork || "",
      source: songData.source || metadata.source || "",
      playedAt: Date.now()
    });

    await this.trim();
    await this.notify();

    return record;
  }

  async getAll(limit = this.#maxEntries) {
    const safeLimit = Number(limit) > 0 ? Number(limit) : this.#maxEntries;
    const records = await this.#storage.getHistory(safeLimit);
    const songs = await this.#storage.getSongs();
    const songMap = new Map(songs.map(song => [song.id, song]));

    return records.map(record => ({
      ...(songMap.get(record.songId) || {}),
      ...record
    }));
  }

  async getRecent(limit = 20) {
    return this.getAll(limit);
  }

  async remove(songOrId) {
    const songId = typeof songOrId === "object" ? songOrId?.id : songOrId;

    if (!songId) return false;

    // Delegamos la operación al StorageManager para mantener el encapsulamiento
    const success = await this.#storage.removeHistoryBySongId(songId);

    if (success) {
      await this.notify();
    }

    return success;
  }

  async clear() {
    await this.#storage.clearHistory();
    await this.notify();
  }

  async trim() {
    try {
      // Obtenemos los registros excedentes mediante el storage si soporta paginación o límite
      const records = await this.#storage.getHistory(this.#maxEntries + 100);

      if (records.length <= this.#maxEntries) return;

      const sorted = records.sort((a, b) => b.playedAt - a.playedAt);
      const itemsToRemove = sorted.slice(this.#maxEntries);

      for (const record of itemsToRemove) {
        // Aseguramos el uso del método de borrado del storage
        if (typeof this.#storage.deleteHistoryRecord === "function") {
          await this.#storage.deleteHistoryRecord(record.id);
        } else if (this.#storage.db) {
          // Fallback seguro por si el storage expone la DB directamente
          await this.#storage.db.delete("history", record.id);
        }
      }
    } catch (error) {
      console.error("Error al recortar el historial (trim):", error);
    }
  }
}

export const historyManager = new HistoryManager();
export default historyManager;
