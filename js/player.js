/* =========================================
   SHUNEL — YOUTUBE PLAYER
   YouTube IFrame Player API (iOS & LockScreen Ready)
========================================= */

const IFRAME_API = "https://www.youtube.com/iframe_api";

let apiPromise = null;

export class YouTubePlayer {
  constructor(hostId, callbacks = {}) {
    this.hostId = hostId;
    this.callbacks = callbacks;

    this.player = null;

    this.ready = false;
    this.initializing = false;
    this.destroyed = false;

    this.pendingVideoId = null;
    this.lastState = -1;

    this.volume = 70;
  }

  /* =========================================
     INITIALIZATION
  ========================================= */

  async init() {
    if (this.destroyed) {
      throw new Error("El reproductor fue destruido.");
    }

    if (this.ready && this.player) {
      return this.player;
    }

    if (this.initializing) {
      return this.initPromise;
    }

    this.initializing = true;

    this.initPromise = (async () => {
      await this.loadAPI();

      if (this.destroyed) {
        throw new Error("El reproductor fue destruido.");
      }

      const host = document.getElementById(this.hostId);

      if (!host) {
        throw new Error(
          `No se encontró el contenedor: ${this.hostId}`
        );
      }

      return new Promise((resolve, reject) => {
        try {
          this.player = new window.YT.Player(this.hostId, {
            width: "100%",
            height: "100%",

            playerVars: {
              autoplay: 0,
              controls: 1,
              playsinline: 0,
              fs: 1,
              rel: 0,
              modestbranding: 1,
              enablejsapi: 1,
              origin: window.location.origin
            },

            events: {
              onReady: event => {
                this.ready = true;
                this.initializing = false;

                this.player = event.target;

                this.setVolume(this.volume);

                this.callbacks.onReady?.();

                // Reproducir la última canción solicitada.
                if (this.pendingVideoId) {
                  const videoId = this.pendingVideoId;

                  this.pendingVideoId = null;

                  this.play(videoId);
                }

                resolve(this.player);
              },

              onStateChange: event => {
                this.handleState(event);
              },

              onError: event => {
                this.callbacks.onError?.(event.data);
              }
            }
          });

        } catch (error) {
          this.initializing = false;
          reject(error);
        }
      });
    })();

    try {
      return await this.initPromise;
    } catch (error) {
      this.initializing = false;
      this.initPromise = null;
      throw error;
    }
  }

  /* =========================================
     LOAD YOUTUBE API
  ========================================= */

  loadAPI() {
    if (window.YT?.Player) {
      return Promise.resolve();
    }

    if (apiPromise) {
      return apiPromise;
    }

    apiPromise = new Promise((resolve, reject) => {
      const previousCallback =
        window.onYouTubeIframeAPIReady;

      let settled = false;

      const finish = () => {
        if (settled) return;

        settled = true;

        if (window.YT?.Player) {
          resolve();
        } else {
          reject(
            new Error(
              "La API de YouTube no se inicializó correctamente."
            )
          );
        }
      };

      window.onYouTubeIframeAPIReady = () => {
        try {
          previousCallback?.();
        } finally {
          finish();
        }
      };

      let script = document.querySelector(
        `script[src="${IFRAME_API}"]`
      );

      if (!script) {
        script = document.createElement("script");

        script.src = IFRAME_API;
        script.async = true;

        script.onerror = () => {
          apiPromise = null;

          reject(
            new Error(
              "No se pudo cargar el reproductor de YouTube."
            )
          );
        };

        document.head.appendChild(script);
      }
    });

    return apiPromise;
  }

  /* =========================================
     PLAYBACK
  ========================================= */

  play(videoId) {
    if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId || "")) {
      console.warn("[Shunel] ID de video inválido:", videoId);
      return;
    }

    if (!this.ready || !this.player) {
      this.pendingVideoId = videoId;

      this.init().catch(error => {
        console.error("[Shunel] Player error:", error);
        this.callbacks.onError?.(error.message);
      });

      return;
    }

    this.pendingVideoId = null;

    this.player.loadVideoById({
      videoId,
      suggestedQuality: "default"
    });
  }

  toggle() {
    if (!this.ready || !this.player) return;

    const state = this.player.getPlayerState();

    if (state === window.YT.PlayerState.PLAYING) {
      this.pause();
    } else {
      this.resume();
    }
  }

  pause() {
    if (!this.ready || !this.player) return;

    this.player.pauseVideo();
  }

  resume() {
    if (!this.ready || !this.player) return;

    this.player.playVideo();
  }

  stop() {
    if (!this.ready || !this.player) return;

    this.player.stopVideo();
  }

  /* =========================================
     VOLUME
  ========================================= */

  setVolume(value) {
    const volume = Number(value);

    if (!Number.isFinite(volume)) return;

    this.volume = Math.max(
      0,
      Math.min(100, volume)
    );

    if (this.ready && this.player) {
      this.player.setVolume(this.volume);
    }
  }

  mute() {
    if (this.ready && this.player) {
      this.player.mute();
    }
  }

  unmute() {
    if (this.ready && this.player) {
      this.player.unMute();
      this.player.setVolume(this.volume);
    }
  }

  /* =========================================
     PROGRESS
  ========================================= */

  seekTo(seconds) {
    const time = Number(seconds);

    if (
      !this.ready ||
      !this.player ||
      !Number.isFinite(time)
    ) {
      return;
    }

    this.player.seekTo(
      Math.max(0, time),
      true
    );
  }

  getCurrentTime() {
    if (!this.ready || !this.player) return 0;

    return this.player.getCurrentTime() || 0;
  }

  getDuration() {
    if (!this.ready || !this.player) return 0;

    return this.player.getDuration() || 0;
  }

  getPlayerState() {
    if (!this.ready || !this.player) return -1;

    return this.player.getPlayerState();
  }

  /* =========================================
     PLAYER STATE
  ========================================= */

  handleState(event) {
    this.lastState = event.data;

    const states = window.YT.PlayerState;

    this.callbacks.onStateChange?.(event.data);

    if (event.data === states.ENDED) {
      this.callbacks.onEnded?.();
    }
  }

  /* =========================================
     DESTROY
  ========================================= */

  destroy() {
    this.destroyed = true;
    this.ready = false;
    this.initializing = false;

    this.pendingVideoId = null;

    if (this.player) {
      this.player.destroy();
      this.player = null;
    }

    this.lastState = -1;
  }
}
