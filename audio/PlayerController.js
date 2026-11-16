/**
 * SHUNEL
 * PlayerController.js
 *
 * Conecta el PlaybackManager con la interfaz HTML de forma
 * eficiente, segura y con buena gestión de memoria.
 */

export class PlayerController {
  #playback;
  #root;
  #options;
  #elements = {};
  #unsubscribers = new Set();
  #pollTimer = null;
  #bound = false;
  #destroyed = false;

  // Callbacks externos
  #onFavorite = null;
  #onFavoriteState = null;
  #onSongChange = null;
  #onError = null;

  /**
   * @param {Object} options
   * @param {Object} options.playbackManager - Instancia de PlaybackManager (obligatorio)
   * @param {Document|HTMLElement} [options.rootElement]
   * @param {number} [options.pollInterval=500]
   * @param {Function} [options.onFavorite]
   * @param {Function} [options.onFavoriteState]
   * @param {Function} [options.onSongChange]
   * @param {Function} [options.onError]
   */
  constructor(options = {}) {
    if (!options.playbackManager) {
      throw new Error(
        "[Shunel PlayerController] Se necesita una instancia válida de PlaybackManager."
      );
    }

    this.#options = Object.freeze({
      pollInterval: 500,
      ...options
    });

    this.#playback = options.playbackManager;
    this.#root = options.rootElement || options.document || document;

    this.#onFavorite =
      typeof options.onFavorite === "function" ? options.onFavorite : null;
    this.#onFavoriteState =
      typeof options.onFavoriteState === "function"
        ? options.onFavoriteState
        : null;
    this.#onSongChange =
      typeof options.onSongChange === "function" ? options.onSongChange : null;
    this.#onError =
      typeof options.onError === "function" ? options.onError : null;

    // Caché de elementos
    this.#elements = {
      play: this.#getElement("playButton"),
      next: this.#getElement("nextButton"),
      previous: this.#getElement("previousButton"),
      progress: this.#getElement("progress"),
      currentTime: this.#getElement("currentTime"),
      duration: this.#getElement("duration"),
      title: this.#getElement("currentTitle"),
      artist: this.#getElement("currentArtist"),
      cover: this.#getElement("currentCover"),
      favorite: this.#getElement("favoriteCurrent"),
      volume: this.#getElement("volume"),
      volumeButton: this.#getElement("volumeButton"),
      shuffle: this.#getElement("shuffleSetting"),
      repeat: this.#getElement("repeatSetting")
    };

    this.#bind();
    this.#subscribe();
    this.renderSettings();
    this.renderVolume();
    this.#startProgressPolling();
  }

  // ==========================================
  // API PÚBLICA
  // ==========================================

  get isDestroyed() {
    return this.#destroyed;
  }

  setFavoriteStateProvider(callback) {
    this.#onFavoriteState =
      typeof callback === "function" ? callback : null;

    const song = this.#playback.getCurrentSong?.();
    if (song) this.#renderFavoriteState(song);
  }

  setYouTubePlayer(player) {
    this.#ensureActive();
    this.#playback.setYouTubePlayer?.(player);
  }

  setLocalSourceResolver(callback) {
    this.#ensureActive();
    this.#playback.setLocalSourceResolver?.(callback);
  }

  async playSong(song, options = {}) {
    this.#ensureActive();
    return this.#playback.playSong(song, options);
  }

  destroy() {
    if (this.#destroyed) return;

    this.#stopProgressPolling();

    for (const unsubscribe of this.#unsubscribers) {
      try {
        unsubscribe();
      } catch (error) {
        console.error(
          "[Shunel PlayerController] Error al desconectar listener:",
          error
        );
      }
    }

    this.#unsubscribers.clear();
    this.#bound = false;
    this.#destroyed = true;
    this.#elements = null;
    this.#playback = null;
  }

  // ==========================================
  // BINDING DE EVENTOS DE UI
  // ==========================================

  #bind() {
    if (this.#bound) return;
    this.#bound = true;

    this.#addListener(this.#elements.play, "click", () => {
      this.#ensureActive();
      this.#playback.togglePlayback?.().catch((err) => this.#handleError(err));
    });

    this.#addListener(this.#elements.next, "click", () => {
      this.#ensureActive();
      this.#playback.next?.().catch((err) => this.#handleError(err));
    });

    this.#addListener(this.#elements.previous, "click", () => {
      this.#ensureActive();
      this.#playback.previous?.().catch((err) => this.#handleError(err));
    });

    this.#addListener(this.#elements.progress, "input", (event) => {
      const percent = Number(event.target.value);
      this.#renderCurrentTimePreview(percent);
    });

    this.#addListener(this.#elements.progress, "change", (event) => {
      this.#ensureActive();
      this.#playback.seekPercent?.(Number(event.target.value));
    });

    this.#addListener(this.#elements.volume, "input", (event) => {
      this.#ensureActive();
      this.#playback.setVolume?.(Number(event.target.value) / 100);
      this.renderVolume();
    });

    this.#addListener(this.#elements.volumeButton, "click", () => {
      this.#ensureActive();
      this.#playback.toggleMute?.();
      this.renderVolume();
    });

    this.#addListener(this.#elements.favorite, "click", () => {
      this.#ensureActive();
      const song = this.#playback.getCurrentSong?.();
      if (song && this.#onFavorite) {
        this.#onFavorite(song);
      }
    });

    this.#addListener(this.#elements.shuffle, "click", () => {
      this.#ensureActive();
      this.#playback.toggleShuffle?.();
      this.renderSettings();
    });

    this.#addListener(this.#elements.repeat, "click", () => {
      this.#ensureActive();
      this.#playback.toggleRepeat?.();
      this.renderSettings();
    });
  }

  #subscribe() {
    const add = (unsub) => {
      if (typeof unsub === "function") this.#unsubscribers.add(unsub);
    };

    add(
      this.#playback.on?.("songchange", (detail) => {
        const song = detail?.song || null;
        this.#renderSong(song);
        if (this.#onSongChange) this.#onSongChange(song);
      })
    );

    add(this.#playback.on?.("play", () => this.#renderPlayButton(true)));
    add(this.#playback.on?.("pause", () => this.#renderPlayButton(false)));
    add(this.#playback.on?.("stop", () => this.#renderPlayButton(false)));
    add(this.#playback.on?.("timeupdate", () => this.#renderProgress()));
    add(this.#playback.on?.("volumechange", () => this.renderVolume()));
    add(this.#playback.on?.("shufflechange", () => this.renderSettings()));
    add(this.#playback.on?.("repeatchange", () => this.renderSettings()));
    add(this.#playback.on?.("queueended", () => this.#renderPlayButton(false)));

    add(
      this.#playback.on?.("error", (detail) => {
        this.#handleError(
          detail?.error ||
            new Error(detail?.message || "Error de reproducción desconocido.")
        );
      })
    );
  }

  // ==========================================
  // RENDERIZADO
  // ==========================================

  #renderSong(song) {
    if (!song) {
      this.#setText(this.#elements.title, "Nada reproduciéndose");
      this.#setText(this.#elements.artist, "Selecciona una canción");

      if (this.#elements.cover) {
        this.#elements.cover.replaceChildren(
          document.createTextNode("♫")
        );
      }

      this.#renderFavorite(false);
      this.#renderPlayButton(false);
      this.#renderProgress(true);
      return;
    }

    this.#setText(this.#elements.title, song.title || "Sin título");
    this.#setText(this.#elements.artist, song.artist || "Artista desconocido");

    if (this.#elements.cover) {
      this.#elements.cover.replaceChildren();

      const safeArtwork = this.#sanitizeURL(song.artwork);
      if (safeArtwork) {
        const img = document.createElement("img");
        img.src = safeArtwork;
        img.alt = "";
        img.loading = "lazy";
        this.#elements.cover.appendChild(img);
      } else {
        this.#elements.cover.textContent = "♫";
      }
    }

    this.#renderProgress(true);
    this.#renderPlayButton(this.#playback.isPlaying?.() ?? false);

    if (this.#onFavorite) {
      this.#renderFavoriteState(song);
    }
  }

  #renderFavoriteState(song) {
    if (!this.#elements.favorite || !this.#onFavoriteState) return;
    this.#renderFavorite(Boolean(this.#onFavoriteState(song)));
  }

  #renderFavorite(isFavorite) {
    if (!this.#elements.favorite) return;

    const text = isFavorite ? "♥" : "♡";
    const label = isFavorite ? "Quitar de favoritos" : "Añadir a favoritos";

    if (this.#elements.favorite.textContent !== text) {
      this.#elements.favorite.textContent = text;
    }
    if (this.#elements.favorite.getAttribute("aria-label") !== label) {
      this.#elements.favorite.setAttribute("aria-label", label);
    }
  }

  #renderPlayButton(isPlaying) {
    if (!this.#elements.play) return;

    const text = isPlaying ? "Ⅱ" : "▶";
    const label = isPlaying ? "Pausar" : "Reproducir";

    if (this.#elements.play.textContent !== text) {
      this.#elements.play.textContent = text;
    }
    if (this.#elements.play.getAttribute("aria-label") !== label) {
      this.#elements.play.setAttribute("aria-label", label);
    }
  }

  #renderProgress(reset = false) {
    if (reset) {
      if (this.#elements.progress) this.#elements.progress.value = "0";
      this.#setText(this.#elements.currentTime, "0:00");
      this.#setText(this.#elements.duration, "0:00");
      return;
    }

    const current = this.#playback.getCurrentTime?.() ?? 0;
    const total = this.#playback.getDuration?.() ?? 0;
    const progress = this.#playback.getProgress?.() ?? 0;

    if (this.#elements.progress) {
      const str = String(progress);
      if (this.#elements.progress.value !== str) {
        this.#elements.progress.value = str;
      }
    }

    this.#setText(this.#elements.currentTime, this.#formatTime(current));
    this.#setText(this.#elements.duration, this.#formatTime(total));
  }

  #renderCurrentTimePreview(percent) {
    const duration = this.#playback.getDuration?.() ?? 0;
    if (!duration) return;

    const current =
      (duration * Math.max(0, Math.min(100, percent))) / 100;
    this.#setText(this.#elements.currentTime, this.#formatTime(current));
  }

  renderVolume() {
    const controller = this.#playback.volumeController;
    if (!controller) return;

    if (this.#elements.volume) {
      const str = String(controller.getVolumePercent?.() ?? 75);
      if (this.#elements.volume.value !== str) {
        this.#elements.volume.value = str;
      }
    }

    if (this.#elements.volumeButton) {
      const isMutedOrZero =
        controller.isMuted?.() || controller.getVolume?.() === 0;
      const text = isMutedOrZero ? "×" : "♪";
      const label = controller.isMuted?.()
        ? "Activar sonido"
        : "Silenciar";

      if (this.#elements.volumeButton.textContent !== text) {
        this.#elements.volumeButton.textContent = text;
      }
      if (this.#elements.volumeButton.getAttribute("aria-label") !== label) {
        this.#elements.volumeButton.setAttribute("aria-label", label);
      }
    }
  }

  renderSettings() {
    const shuffleEnabled =
      this.#playback.shuffleController?.isEnabled?.() ?? false;
    const repeatMode =
      this.#playback.repeatController?.getMode?.() ?? "off";

    if (this.#elements.shuffle) {
      const text = shuffleEnabled ? "Activado" : "Activar";
      if (this.#elements.shuffle.textContent !== text) {
        this.#elements.shuffle.textContent = text;
      }
    }

    if (this.#elements.repeat) {
      const labels = {
        off: "Desactivado",
        one: "Una canción",
        all: "Toda la cola"
      };
      const text = labels[repeatMode] || "Desactivado";
      if (this.#elements.repeat.textContent !== text) {
        this.#elements.repeat.textContent = text;
      }
    }
  }

  // ==========================================
  // POLLING DE PROGRESO
  // ==========================================

  #startProgressPolling() {
    if (this.#pollTimer !== null) return;

    this.#pollTimer = setInterval(() => {
      if (this.#destroyed) return;

      const song = this.#playback.getCurrentSong?.();
      if (!song) return;

      // Solo actualizamos si está reproduciendo
      if (this.#playback.isPlaying?.()) {
        this.#renderProgress();
      }
    }, this.#options.pollInterval);
  }

  #stopProgressPolling() {
    if (this.#pollTimer !== null) {
      clearInterval(this.#pollTimer);
      this.#pollTimer = null;
    }
  }

  // ==========================================
  // HELPERS
  // ==========================================

  #getElement(id) {
    if (typeof this.#root.getElementById === "function") {
      return this.#root.getElementById(id);
    }
    return this.#root.querySelector?.(`#${id}`) || null;
  }

  #addListener(element, event, callback) {
    if (!element) return;

    element.addEventListener(event, callback);

    const unsubscribe = () => {
      element.removeEventListener(event, callback);
    };

    this.#unsubscribers.add(unsubscribe);
  }

  #sanitizeURL(url) {
    if (!url) return "";
    try {
      const parsed = new URL(url, location.origin);
      return ["http:", "https:", "blob:"].includes(parsed.protocol)
        ? parsed.href
        : "";
    } catch {
      return "";
    }
  }

  #formatTime(seconds) {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value < 0) return "0:00";

    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    const remaining = Math.floor(value % 60);
    const sec = String(remaining).padStart(2, "0");

    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, "0")}:${sec}`;
    }
    return `${minutes}:${sec}`;
  }

  #setText(element, value) {
    if (!element) return;
    const str = String(value ?? "");
    if (element.textContent !== str) {
      element.textContent = str;
    }
  }

  #handleError(error) {
    console.error("[Shunel PlayerController]", error);
    if (this.#onError) {
      try {
        this.#onError(error);
      } catch (err) {
        console.error(
          "[Shunel PlayerController] Error dentro de onError:",
          err
        );
      }
    }
  }

  #ensureActive() {
    if (this.#destroyed) {
      throw new Error(
        "[Shunel PlayerController] No se pueden realizar acciones en un controlador destruido."
      );
    }
  }
}

export default PlayerController;