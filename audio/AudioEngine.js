/**
 * SHUNEL
 * AudioEngine.js
 *
 * Motor de reproducción para archivos de audio locales.
 * No maneja YouTube (eso lo hace el YouTubePlayer por separado).
 */

export class AudioEngine {
  #audio;
  #listeners = new Map();
  #currentSource = null;
  #destroyed = false;
  #handlers;

  /**
   * @param {Object} [options={}]
   * @param {HTMLAudioElement} [options.audioElement]
   * @param {string} [options.selector="#localAudio"]
   * @param {number} [options.volume=0.75]
   * @param {string} [options.preload="metadata"]
   */
  constructor(options = {}) {
    this.#audio =
      options.audioElement ||
      document.querySelector(options.selector || "#localAudio");

    if (!this.#audio) {
      throw new Error(
        "[Shunel AudioEngine] No se encontró el elemento <audio>. Se esperaba #localAudio."
      );
    }

    this.#audio.preload = options.preload || "metadata";
    this.#audio.volume = this.#clamp(options.volume ?? 0.75, 0, 1);

    // Handlers nativos del elemento audio
    this.#handlers = {
      play: () => this.#emit("play"),
      pause: () => this.#emit("pause"),
      ended: () => this.#emit("ended"),
      waiting: () => this.#emit("waiting"),
      canplay: () => this.#emit("canplay"),
      loadedmetadata: () =>
        this.#emit("loadedmetadata", { duration: this.duration }),
      timeupdate: () =>
        this.#emit("timeupdate", {
          currentTime: this.currentTime,
          duration: this.duration,
          progress: this.progress
        }),
      volumechange: () =>
        this.#emit("volumechange", {
          volume: this.volume,
          muted: this.muted
        }),
      error: () =>
        this.#emit("error", {
          error: this.#audio.error,
          message: this.#getErrorMessage()
        })
    };

    for (const [event, handler] of Object.entries(this.#handlers)) {
      this.#audio.addEventListener(event, handler);
    }
  }

  // ==========================================
  // GETTERS
  // ==========================================

  get currentTime() {
    return Number.isFinite(this.#audio.currentTime)
      ? this.#audio.currentTime
      : 0;
  }

  get duration() {
    return Number.isFinite(this.#audio.duration) ? this.#audio.duration : 0;
  }

  get volume() {
    return this.#audio.volume;
  }

  get muted() {
    return this.#audio.muted;
  }

  get paused() {
    return this.#audio.paused;
  }

  get ended() {
    return this.#audio.ended;
  }

  get progress() {
    if (!this.duration) return 0;
    return (this.currentTime / this.duration) * 100;
  }

  get src() {
    return this.#audio.src || null;
  }

  get isDestroyed() {
    return this.#destroyed;
  }

  // ==========================================
  // EVENTOS INTERNOS
  // ==========================================

  /**
   * @param {string} event
   * @param {Function} callback
   * @returns {Function} Función para desuscribirse
   */
  on(event, callback) {
    if (typeof callback !== "function") {
      throw new TypeError("[Shunel AudioEngine] El callback debe ser una función.");
    }

    if (!this.#listeners.has(event)) {
      this.#listeners.set(event, new Set());
    }

    this.#listeners.get(event).add(callback);

    return () => this.off(event, callback);
  }

  off(event, callback) {
    const set = this.#listeners.get(event);
    if (!set) return;

    set.delete(callback);

    if (set.size === 0) {
      this.#listeners.delete(event);
    }
  }

  #emit(event, detail = null) {
    const callbacks = this.#listeners.get(event);
    if (!callbacks) return;

    for (const callback of [...callbacks]) {
      try {
        callback(detail);
      } catch (error) {
        console.error(`[Shunel AudioEngine] Error en "${event}":`, error);
      }
    }
  }

  // ==========================================
  // CONTROL DE REPRODUCCIÓN
  // ==========================================

  /**
   * Carga una fuente de audio (URL o Blob).
   * @param {string|Blob} source
   * @returns {string} URL final usada
   */
  load(source) {
    this.#ensureActive();

    if (!source) {
      throw new TypeError("[Shunel AudioEngine] Debes proporcionar una fuente de audio.");
    }

    const url =
      source instanceof Blob ? URL.createObjectURL(source) : String(source);

    this.unload();

    this.#currentSource = {
      url,
      isObjectURL: source instanceof Blob
    };

    this.#audio.src = url;
    this.#audio.load();

    this.#emit("sourcechange", { source: url });

    return url;
  }

  /**
   * Reproduce el audio actual.
   * @returns {Promise<boolean>}
   */
  async play() {
    this.#ensureActive();

    if (!this.#audio.src) {
      throw new Error("[Shunel AudioEngine] No hay ningún archivo de audio cargado.");
    }

    try {
      await this.#audio.play();
      return true;
    } catch (error) {
      this.#emit("playerror", {
        error,
        message: error.message
      });
      throw error;
    }
  }

  pause() {
    this.#ensureActive();
    this.#audio.pause();
  }

  /**
   * Alterna entre play y pause.
   * @returns {Promise<boolean>} true si quedó reproduciendo
   */
  async toggle() {
    if (this.paused) {
      return this.play();
    }
    this.pause();
    return false;
  }

  stop() {
    this.#ensureActive();
    this.#audio.pause();

    try {
      this.#audio.currentTime = 0;
    } catch {
      // Puede fallar si aún no hay metadatos
    }

    this.#emit("stop");
  }

  /**
   * Salta a un tiempo específico (segundos).
   * @param {number} seconds
   * @returns {boolean}
   */
  seek(seconds) {
    this.#ensureActive();

    const target = this.#clamp(
      seconds,
      0,
      this.duration || Number.MAX_SAFE_INTEGER
    );

    if (!Number.isFinite(target)) return false;

    try {
      this.#audio.currentTime = target;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Salta a un porcentaje (0-100).
   * @param {number} percent
   * @returns {boolean}
   */
  seekPercent(percent) {
    if (!this.duration) return false;
    const value = this.#clamp(percent, 0, 100);
    return this.seek((value / 100) * this.duration);
  }

  // ==========================================
  // VOLUMEN
  // ==========================================

  setVolume(value) {
    this.#ensureActive();
    this.#audio.volume = this.#clamp(value, 0, 1);
  }

  setMuted(value) {
    this.#ensureActive();
    this.#audio.muted = Boolean(value);
  }

  mute() {
    this.setMuted(true);
  }

  unmute() {
    this.setMuted(false);
  }

  // ==========================================
  // LIMPIEZA
  // ==========================================

  unload() {
    if (!this.#audio) return;

    this.#audio.pause();
    this.#audio.removeAttribute("src");
    this.#audio.load();

    if (this.#currentSource?.isObjectURL) {
      URL.revokeObjectURL(this.#currentSource.url);
    }

    this.#currentSource = null;
  }

  destroy() {
    if (this.#destroyed) return;

    this.unload();

    for (const [event, handler] of Object.entries(this.#handlers)) {
      this.#audio.removeEventListener(event, handler);
    }

    this.#listeners.clear();
    this.#destroyed = true;
  }

  // ==========================================
  // HELPERS PRIVADOS
  // ==========================================

  #clamp(value, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return min;
    return Math.min(max, Math.max(min, number));
  }

  #getErrorMessage() {
    const errors = {
      1: "La reproducción fue interrumpida.",
      2: "Error de red al cargar el audio.",
      3: "El archivo de audio no se pudo decodificar.",
      4: "El formato de audio no es compatible."
    };

    return (
      errors[this.#audio.error?.code] ||
      "No se pudo reproducir el archivo de audio."
    );
  }

  #ensureActive() {
    if (this.#destroyed) {
      throw new Error("[Shunel AudioEngine] Ya fue destruido.");
    }
  }
}

export default AudioEngine;