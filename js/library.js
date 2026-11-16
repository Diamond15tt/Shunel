import { Storage } from "./storage.js";

export class MusicLibrary {
  constructor() {
    this.library = Storage.getLibrary();
    this.favorites = Storage.getFavorites();
    this.history = Storage.getHistory();
  }

  save(track) {
    if (!track?.videoId) return false;
    if (this.library.some(item => item.videoId === track.videoId)) return false;
    this.library.unshift({ ...track });
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
    this.favorites = exists
      ? this.favorites.filter(item => item.videoId !== track.videoId)
      : [{ ...track }, ...this.favorites];
    Storage.saveFavorites(this.favorites);
    return !exists;
  }

  isFavorite(videoId) {
    return this.favorites.some(item => item.videoId === videoId);
  }

  addHistory(track) {
    if (!track?.videoId) return;
    this.history = [
      { ...track, playedAt: Date.now() },
      ...this.history.filter(item => item.videoId !== track.videoId)
    ].slice(0, 100);
    Storage.saveHistory(this.history);
  }

  getLibrary() { return [...this.library]; }
  getFavorites() { return [...this.favorites]; }
  getHistory() { return [...this.history]; }
}
