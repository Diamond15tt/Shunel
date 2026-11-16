/**
 * SHUNEL
 * PlaybackManager.js
 *
 * Coordinador principal de reproducción.
 * Une AudioEngine + Queue + Shuffle + Repeat + Volume.
 */

import AudioEngine from "./AudioEngine.js";
import QueueManager from "./QueueManager.js";
import RepeatController from "./RepeatController.js";
import ShuffleController from "./ShuffleController.js";
import VolumeController from "./VolumeController.js";

export class PlaybackManager {
  #audioEngine;
  #queueManager;
  #repeatController;
  #shuffleController;
  #volumeController;
  #youtubePlayer = null;
  #getLocalSource = null;
  #currentSong = null;
  #listeners = new Map();
  #destroyed = false;
  #lastSource = null;

  /**
   * @param {Object} [options={}]
   */
  constructor(options = {}) {
    this.#audioEngine =
      options.audioEngine ||
      new AudioEngine({
        audioElement: options.audioElement,
        selector: options.audioSelector || "#localAudio",
        volume: options.volume ?? 0.75
      });

    this.#queueManager = options.queueManager || new QueueManager();
    this.#repeatController = options.repeatController || new RepeatController();
    this.#shuffleController = options.shuffleController || new ShuffleController();
    this.#volumeController =
      options.volumeController ||
      new VolumeController({
        audioEngine: this.#audioEngine,
        volume: options.volume ?? 0.75
      });

    this.#youtubePlayer = options.youtubePlayer || null;
    this.#getLocalSource = options.getLocalSource || null;

    // Escuchar eventos del motor de audio local
    this.#audioEngine.on("ended", () => this.#handleEnded());
    this.#audioEngine.on("timeupdate", (detail) => {
      if (this.#currentSong?.source === "local") {
        this.#emit("timeupdate", detail);
      }
    });
    this.#audioEngine.on("play", () => {
      if (this.#currentSong?.source === "local") {
        this.#emit("play", this.#currentSong);
      }
    });
    this.#audioEngine.on("pause", () => {
      if (this.#currentSong?.source === "local") {
        this.#emit("pause", this.#currentSong);
      }
    });
    this.#audioEngine.on("error", (detail) => this.#emit("error", detail));

    // Propagar cambios de los controladores
    this.#repeatController.onChange((detail) => this.#emit("repeatchange", detail));
    this.#shuffleController.onChange((detail) => this.#emit("shufflechange", detail));
    this.#volumeController.onChange((detail) => this.#emit("volumechange", detail));
  }

  // ========== GETTERS PÚBLICOS ==========
  get audioEngine() { return this.#audioEngine; }
  get queueManager() { return this.#queueManager; }
  get repeatController() { return this.#repeatController; }
  get shuffleController() { return this.#shuffleController; }
  get volumeController() { return this.#volumeController; }
  get isDestroyed() { return this.#destroyed; }

  // ========== EVENTOS ==========
  on(event, callback) {
    if (typeof callback !== "function") {
      throw new TypeError("[Shunel PlaybackManager] El callback debe ser una función.");
    }
    if (!this.#listeners.has(event)) {
      this.#listeners.set(event, new Set());
    }
    this.#listeners.get(event).add(callback);
    return () => this.off(event, callback);
  }

  off(event, callback) {
    this.#listeners.get(event)?.delete(callback);
    if (this.#listeners.get(event)?.size === 0) {
      this.#listeners.delete(event);
    }
  }

  #emit(event, detail = null) {
    for (const callback of [...(this.#listeners.get(event) || [])]) {
      try {
        callback(detail);
      } catch (error) {
        console.error(`[Shunel PlaybackManager] Error en "${event}":`, error);
      }
    }
  }

  // ========== CONFIGURACIÓN ==========
  setLocalSourceResolver(callback) {
    if (typeof callback !== "function") {
      throw new TypeError("[Shunel PlaybackManager] El resolver debe ser una función.");
    }
    this.#getLocalSource = callback;
  }

  setYouTubePlayer(player) {
    this.#youtubePlayer = player || null;
    this.#volumeController.setYouTubePlayer?.(this.#youtubePlayer);
  }

  // ========== COLA ==========
  setQueue(songs, startIndex = 0) {
    this.#ensureActive();
    const current = this.#queueManager.setQueue(songs, startIndex);
    this.#shuffleController.reset();

    if (this.#shuffleController.isEnabled()) {
      this.#shuffleController.createOrder(
        this.#queueManager.length,
        this.#queueManager.getIndex()
      );
    }

    this.#emit("queuechange", this.#queueManager.snapshot());
    return current;
  }

  addToQueue(song) {
    this.#ensureActive();
    const added = this.#queueManager.add(song);
    if (added) {
      this.#shuffleController.syncQueue(
        this.#queueManager.length,
        this.#queueManager.getIndex()
      );
      this.#emit("queuechange", this.#queueManager.snapshot());
    }
    return added;
  }

  addManyToQueue(songs) {
    this.#ensureActive();
    const count = this.#queueManager.addMany(songs);
    this.#shuffleController.syncQueue(
      this.#queueManager.length,
      this.#queueManager.getIndex()
    );
    this.#emit("queuechange", this.#queueManager.snapshot());
    return count;
  }

  // ========== REPRODUCCIÓN ==========
  async playSong(song, options = {}) {
    this.#ensureActive();

    if (!song || typeof song !== "object") {
      throw new TypeError("[Shunel PlaybackManager] La canción no es válida.");
    }
    if (!song.id || !song.source) {
      throw new Error("[Shunel PlaybackManager] La canción debe tener id y source.");
    }

    const addToQueue = options.addToQueue !== false;
    const index = this.#queueManager.findIndexById(song.id);

    if (index !== -1) {
      this.#queueManager.setCurrentIndex(index);
    } else if (addToQueue) {
      this.#queueManager.setQueue([song], 0);
      this.#shuffleController.reset();
    } else {
      this.#queueManager.setQueue([song], 0);
    }

    this.#currentSong = song;
    this.#lastSource = song.source;

    this.#emit("songchange", {
      song,
      index: this.#queueManager.getIndex()
    });

    try {
      if (song.source === "local") {
        await this.#playLocal(song);
      } else if (song.source === "youtube") {
        this.#playYouTube(song);
      } else {
        throw new Error(`Fuente no compatible: ${song.source}`);
      }
      return song;
    } catch (error) {
      this.#emit("error", { error, message: error.message, song });
      throw error;
    }
  }

  async #playLocal(song) {
    if (this.#youtubePlayer) {
      try { this.#youtubePlayer.stopVideo(); } catch {}
    }

    if (typeof this.#getLocalSource !== "function") {
      throw new Error("[Shunel PlaybackManager] No se configuró el acceso a archivos locales.");
    }

    const source = await this.#getLocalSource(song);
    if (!source) {
      throw new Error("[Shunel PlaybackManager] No se encontró el archivo local.");
    }

    this.#audioEngine.load(source);
    await this.#audioEngine.play();
  }

  #playYouTube(song) {
    this.#audioEngine.pause();

    if (!this.#youtubePlayer) {
      throw new Error("[Shunel PlaybackManager] El reproductor de YouTube no está disponible.");
    }
    if (typeof this.#youtubePlayer.loadVideoById !== "function") {
      throw new Error("[Shunel PlaybackManager] La instancia de YouTube no es válida.");
    }
    if (!song.videoId) {
      throw new Error("[Shunel PlaybackManager] La canción no tiene videoId.");
    }

    this.#youtubePlayer.loadVideoById(song.videoId);
    this.#volumeController.apply?.();
  }

  async play() {
    this.#ensureActive();

    if (!this.#currentSong) {
      const song = this.#queueManager.getCurrent();
      if (!song) {
        this.#emit("empty");
        return false;
      }
      return this.playSong(song, { addToQueue: false });
    }

    if (this.#currentSong.source === "local") {
      await this.#audioEngine.play();
      return true;
    }

    if (this.#currentSong.source === "youtube" && this.#youtubePlayer) {
      this.#youtubePlayer.playVideo();
      return true;
    }

    return false;
  }

  pause() {
    this.#ensureActive();
    if (!this.#currentSong) return;

    if (this.#currentSong.source === "local") {
      this.#audioEngine.pause();
    } else if (this.#currentSong.source === "youtube" && this.#youtubePlayer) {
      this.#youtubePlayer.pauseVideo();
    }
  }

  async togglePlayback() {
    this.#ensureActive();

    if (!this.#currentSong) return this.play();

    if (this.isPlaying()) {
      this.pause();
      return false;
    }

    await this.play();
    return true;
  }

  isPlaying() {
    if (!this.#currentSong) return false;

    if (this.#currentSong.source === "local") {
      return !this.#audioEngine.paused;
    }

    if (this.#currentSong.source === "youtube" && this.#youtubePlayer) {
      try {
        return this.#youtubePlayer.getPlayerState() === 1;
      } catch {
        return false;
      }
    }

    return false;
  }

  stop() {
    this.#ensureActive();
    this.#audioEngine.stop();

    if (this.#youtubePlayer) {
      try { this.#youtubePlayer.stopVideo(); } catch {}
    }

    this.#emit("stop", this.#currentSong);
  }

  // ========== NAVEGACIÓN ==========
  async next() {
    this.#ensureActive();

    if (this.#repeatController.shouldRepeatCurrent()) {
      return this.restartCurrent();
    }

    const currentIndex = this.#queueManager.getIndex();
    let nextIndex;

    if (this.#shuffleController.isEnabled()) {
      nextIndex = this.#shuffleController.getNextIndex(
        currentIndex,
        this.#queueManager.length
      );

      if (nextIndex === -1 && this.#repeatController.shouldContinueAtEnd()) {
        this.#shuffleController.reshuffle(currentIndex, this.#queueManager.length);
        nextIndex = this.#shuffleController.getNextIndex(
          currentIndex,
          this.#queueManager.length
        );
      }
    } else {
      nextIndex = currentIndex + 1;
      if (nextIndex >= this.#queueManager.length) {
        if (this.#repeatController.shouldContinueAtEnd()) {
          nextIndex = 0;
        } else {
          this.#emit("queueended");
          return null;
        }
      }
    }

    if (nextIndex < 0 || nextIndex >= this.#queueManager.length) {
      this.#emit("queueended");
      return null;
    }

    const song = this.#queueManager.setCurrentIndex(nextIndex);
    this.#emit("queuechange", this.#queueManager.snapshot());
    return this.playSong(song, { addToQueue: false });
  }

  async previous() {
    this.#ensureActive();

    if (this.getCurrentTime() > 3) {
      return this.restartCurrent();
    }

    const currentIndex = this.#queueManager.getIndex();
    let previousIndex;

    if (this.#shuffleController.isEnabled()) {
      previousIndex = this.#shuffleController.getPreviousIndex(
        currentIndex,
        this.#queueManager.length
      );
    } else {
      previousIndex = currentIndex - 1;
    }

    if (previousIndex < 0 || previousIndex >= this.#queueManager.length) {
      return this.restartCurrent();
    }

    const song = this.#queueManager.setCurrentIndex(previousIndex);
    this.#emit("queuechange", this.#queueManager.snapshot());
    return this.playSong(song, { addToQueue: false });
  }

  async restartCurrent() {
    if (!this.#currentSong) return false;

    if (this.#currentSong.source === "local") {
      this.#audioEngine.seek(0);
      await this.#audioEngine.play();
      return true;
    }

    if (this.#currentSong.source === "youtube" && this.#youtubePlayer) {
      this.#youtubePlayer.seekTo(0, true);
      this.#youtubePlayer.playVideo();
      return true;
    }

    return false;
  }

  #handleEnded() {
    if (this.#repeatController.shouldRepeatCurrent()) {
      this.restartCurrent().catch((error) => {
        this.#emit("error", { error, message: error.message });
      });
      return;
    }

    this.next().catch((error) => {
      this.#emit("error", { error, message: error.message });
    });
  }

  handleYouTubeState(state) {
    if (!this.#currentSong || this.#currentSong.source !== "youtube") return;

    if (state === 1) this.#emit("play", this.#currentSong);
    else if (state === 2) this.#emit("pause", this.#currentSong);
    else if (state === 0) this.#handleEnded();
  }

  // ========== SEEK & TIEMPO ==========
  seek(seconds) {
    if (!this.#currentSong) return false;

    if (this.#currentSong.source === "local") {
      return this.#audioEngine.seek(seconds);
    }

    if (this.#currentSong.source === "youtube" && this.#youtubePlayer) {
      this.#youtubePlayer.seekTo(seconds, true);
      return true;
    }

    return false;
  }

  seekPercent(percent) {
    const value = Math.max(0, Math.min(100, Number(percent) || 0));
    if (!this.#currentSong) return false;

    if (this.#currentSong.source === "local") {
      return this.#audioEngine.seekPercent(value);
    }

    const duration = this.getDuration();
    if (this.#currentSong.source === "youtube" && this.#youtubePlayer && duration > 0) {
      this.#youtubePlayer.seekTo((duration * value) / 100, true);
      return true;
    }

    return false;
  }

  getCurrentTime() {
    if (this.#currentSong?.source === "local") return this.#audioEngine.currentTime;
    if (this.#currentSong?.source === "youtube" && this.#youtubePlayer) {
      try { return this.#youtubePlayer.getCurrentTime() || 0; } catch { return 0; }
    }
    return 0;
  }

  getDuration() {
    if (this.#currentSong?.source === "local") return this.#audioEngine.duration;
    if (this.#currentSong?.source === "youtube" && this.#youtubePlayer) {
      try { return this.#youtubePlayer.getDuration() || 0; } catch { return 0; }
    }
    return 0;
  }

  getProgress() {
    const duration = this.getDuration();
    if (!duration) return 0;
    return (this.getCurrentTime() / duration) * 100;
  }

  // ========== VOLUMEN / SHUFFLE / REPEAT ==========
  setVolume(value) {
    return this.#volumeController.setVolume(value);
  }

  toggleMute() {
    return this.#volumeController.toggleMute();
  }

  setShuffle(enabled) {
    const currentIndex = this.#queueManager.getIndex();
    this.#shuffleController.setEnabled(
      enabled,
      Math.max(0, currentIndex),
      this.#queueManager.length
    );
    return this.#shuffleController.isEnabled();
  }

  toggleShuffle() {
    return this.setShuffle(!this.#shuffleController.isEnabled());
  }

  setRepeat(mode) {
    return this.#repeatController.setMode(mode);
  }

  toggleRepeat() {
    return this.#repeatController.toggle();
  }

  getCurrentSong() {
    return this.#currentSong;
  }

  getQueue() {
    return this.#queueManager.getAll();
  }

  // ========== LIMPIEZA ==========
  destroy() {
    if (this.#destroyed) return;

    this.pause();
    this.#audioEngine.destroy();
    this.#volumeController.destroy?.();
    this.#repeatController.destroy?.();
    this.#shuffleController.destroy?.();

    this.#listeners.clear();
    this.#destroyed = true;
  }

  #ensureActive() {
    if (this.#destroyed) {
      throw new Error("[Shunel PlaybackManager] Ya fue destruido.");
    }
  }
}

export default PlaybackManager;