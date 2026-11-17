import { Storage } from "./storage.js";

/* =========================================
   SHUNEL — MUSIC LIBRARY MANAGER
========================================= */

export class MusicLibrary {
  constructor() {
    this.library = Storage.getLibrary();
    this.favorites = Storage.getFavorites();
    this.history = Storage.getHistory();
  }

  save(track) {
    if (!track?.videoId) return false;
    if (this.library.some(item => item.videoId === track.videoId)) return false;

    // Normalizar la estructura del track asegurando compatibilidad de carátula y metadatos
    const normalizedTrack = {
      videoId: track.videoId,
      title: track.title || track.name || "Desconocido",
      channel: track.channel || track.artist || "Shunel",
      thumbnail: track.thumbnail || track.thumbnailUrl || track.image || "/assets/placeholder.svg",
      savedAt: Date.now()
    };

    this.library.unshift(normalizedTrack);
    Storage.saveLibrary(this.library);
    return true;
  }

  remove(videoId) {
    this.library = this.library.filter(item => item.videoId !== videoId);
    Storage.saveLibrary(this.library);
  }

  toggleFavorite(track) {
    if (!track?.videoId) return false;
    const exists = this.favorites.some(item => item.videoId === track.videoId);

    if (exists) {
      this.favorites = this.favorites.filter(item => item.videoId !== track.videoId);
    } else {
      const normalizedTrack = {
        videoId: track.videoId,
        title: track.title || track.name || "Desconocido",
        channel: track.channel || track.artist || "Shunel",
        thumbnail: track.thumbnail || track.thumbnailUrl || track.image || "/assets/placeholder.svg",
        favoritedAt: Date.now()
      };
      this.favorites = [normalizedTrack, ...this.favorites];
    }

    Storage.saveFavorites(this.favorites);
    return !exists;
  }

  isFavorite(videoId) {
    return this.favorites.some(item => item.videoId === videoId);
  }

  addHistory(track) {
    if (!track?.videoId) return;

    const normalizedTrack = {
      videoId: track.videoId,
      title: track.title || track.name || "Desconocido",
      channel: track.channel || track.artist || "Shunel",
      thumbnail: track.thumbnail || track.thumbnailUrl || track.image || "/assets/placeholder.svg",
      playedAt: Date.now()
    };

    this.history = [
      normalizedTrack,
      ...this.history.filter(item => item.videoId !== track.videoId)
    ].slice(0, 100);

    Storage.saveHistory(this.history);
  }

  getLibrary() { return [...this.library]; }
  getFavorites() { return [...this.favorites]; }
  getHistory() { return [...this.history]; }
}
