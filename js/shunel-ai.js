
/* =========================================
   SHUNEL — AI ASSISTANT
   Asistente musical inteligente
   Version: 2.0.0
========================================= */

(() => {
  "use strict";

  if (window.ShunelAI) return;

  const CONFIG = {
    endpoint: "/api/chat",
    timeout: 30000,
    maxHistory: 20,
    storageKey: "shunel_ai_history",
    systemPrompt: `
Eres Shunel AI, el asistente musical integrado
en la aplicación Shunel.

Tu trabajo es ayudar al usuario con música,
artistas, canciones, recomendaciones y funciones
del reproductor.

Responde en español de forma natural y directa.

No afirmes que has realizado una acción si el
sistema no te ha confirmado que se ejecutó.

Si no tienes información suficiente, dilo.
No inventes canciones, artistas ni resultados.
`
  };

  const state = {
    initialized: false,
    loading: false,
    history: [],
    abortController: null,
    requestId: 0,
    provider: null
  };

  function emit(name, detail = {}) {
    if (window.ShunelEvents) {
      window.ShunelEvents.emit(name, detail);
    } else {
      window.dispatchEvent(
        new CustomEvent(`shunel:${name}`, { detail })
      );
    }
  }

  function getPlayer() {
    return window.ShunelPlayer || null;
  }

  function getRadio() {
    return window.ShunelRadio || null;
  }

  function getCurrentTrack() {
    return getPlayer()?.getCurrentTrack?.() || null;
  }

  function getHistory() {
    try {
      const saved = JSON.parse(
        localStorage.getItem(CONFIG.storageKey) || "[]"
      );

      return Array.isArray(saved) ? saved : [];
    } catch {
      return [];
    }
  }

  function saveHistory() {
    try {
      localStorage.setItem(
        CONFIG.storageKey,
        JSON.stringify(
          state.history.slice(-CONFIG.maxHistory)
        )
      );
    } catch (error) {
      console.warn(
        "[Shunel AI] No se pudo guardar el historial:",
        error
      );
    }
  }

  function addMessage(role, content) {
    const message = {
      role,
      content: String(content || ""),
      timestamp: Date.now()
    };

    state.history.push(message);

    state.history = state.history.slice(
      -CONFIG.maxHistory
    );

    saveHistory();

    emit("ai:message", message);

    return message;
  }

  function getContext() {
    const player = getPlayer();

    return {
      currentTrack: getCurrentTrack(),
      playback: player?.getState?.() || null,
      queue: player?.getQueue?.() || [],
      radio: getRadio()?.getState?.() || null
    };
  }

  async function requestAI(message, requestId) {
    const controller = new AbortController();

    state.abortController = controller;

    const timeout = setTimeout(
      () => controller.abort(),
      CONFIG.timeout
    );

    try {
      const response = await fetch(CONFIG.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          message,
          history: state.history
            .slice(-CONFIG.maxHistory)
            .map(item => ({
              role: item.role,
              content: item.content
            })),
          context: getContext(),
          system: CONFIG.systemPrompt
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(
          `El servidor respondió ${response.status}.`
        );
      }

      const data = await response.json();

      if (requestId !== state.requestId) {
        return null;
      }

      const answer =
        data.reply ||
        data.message ||
        data.response ||
        data.choices?.[0]?.message?.content;

      if (typeof answer !== "string" || !answer.trim()) {
        throw new Error(
          "El servidor no devolvió una respuesta válida."
        );
      }

      return answer.trim();

    } finally {
      clearTimeout(timeout);

      if (state.abortController === controller) {
        state.abortController = null;
      }
    }
  }

  function extractCommand(message) {
    const text = message.toLowerCase().trim();

    const patterns = [
      {
        type: "play",
        regex: /^(reproduce|reproducir|pon|ponme|escucha|quiero escuchar)\s+(.+)$/i
      },
      {
        type: "pause",
        regex: /^(pausa|pausar|detén la música|detener música)$/i
      },
      {
        type: "resume",
        regex: /^(continúa|continuar|reanuda|reanudar|sigue reproduciendo)$/i
      },
      {
        type: "next",
        regex: /^(siguiente|próxima|otra canción|cambia de canción)$/i
      },
      {
        type: "previous",
        regex: /^(anterior|canción anterior|vuelve a la anterior)$/i
      },
      {
        type: "radio",
        regex: /^(inicia|iniciar|activa|activar)\s+(la\s+)?radio(\s+inteligente)?$/i
      },
      {
        type: "shuffle",
        regex: /^(activa|activar|desactiva|desactivar)\s+el\s+aleatorio$/i
      }
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern.regex);

      if (match) {
        return {
          type: pattern.type,
          argument: match[2] || null,
          original: text
        };
      }
    }

    return null;
  }

  async function executeCommand(command) {
    const player = getPlayer();

    if (!player) {
      return {
        success: false,
        message: "El reproductor todavía no está disponible."
      };
    }

    try {
      let result = false;

      switch (command.type) {
        case "play": {
          const query = command.argument;

          if (!query) {
            return {
              success: false,
              message: "No especificaste qué canción quieres escuchar."
            };
          }

          const search = window.ShunelApp?.searchMusic;

          if (typeof search !== "function") {
            return {
              success: false,
              message: "La búsqueda musical todavía no está conectada."
            };
          }

          result = await search(query);

          if (result === false || result == null) {
            return {
              success: false,
              message: "No pude encontrar o reproducir esa canción."
            };
          }

          return {
            success: true,
            message: `Solicitud de reproducción enviada para: ${query}.`
          };
        }

        case "pause":
          if (!player.getState().isPlaying) {
            return {
              success: false,
              message: "La música ya está pausada."
            };
          }

          player.pause();
          result = !player.getState().isPlaying;
          break;

        case "resume":
          if (player.getState().isPlaying) {
            return {
              success: false,
              message: "La música ya está reproduciéndose."
            };
          }

          result = await player.play();
          break;

        case "next":
          result = await player.next();
          break;

        case "previous":
          result = await player.previous();
          break;

        case "radio": {
          const radio = getRadio();

          if (!radio) {
            return {
              success: false,
              message: "La radio inteligente no está disponible."
            };
          }

          result = await radio.start();
          break;
        }

        case "shuffle":
          player.toggleShuffle();

          return {
            success: true,
            message: player.getState().shuffle
              ? "Modo aleatorio activado."
              : "Modo aleatorio desactivado."
          };

        default:
          return {
            success: false,
            message: "No reconozco esa acción."
          };
      }

      if (result === false || result == null) {
        return {
          success: false,
          message: "El reproductor no pudo completar la acción."
        };
      }

      return {
        success: true,
        message: "Acción ejecutada correctamente."
      };

    } catch (error) {
      console.error(
        "[Shunel AI] Error ejecutando acción:",
        error
      );

      return {
        success: false,
        message: "Ocurrió un error al ejecutar la acción."
      };
    }
  }

  async function send(message) {
    const text = String(message || "").trim();

    if (!text) return null;

    if (state.loading) {
      emit("ai:error", {
        message: "Espera a que termine la respuesta anterior."
      });

      return null;
    }

    const requestId = ++state.requestId;

    state.loading = true;

    addMessage("user", text);

    emit("ai:thinking", { active: true });

    try {
      const command = extractCommand(text);

      if (command) {
        const result = await executeCommand(command);

        if (requestId !== state.requestId) {
          return null;
        }

        addMessage("assistant", result.message);

        emit(
          result.success ? "ai:action-success" : "ai:action-error",
          {
            command,
            result
          }
        );

        return result.message;
      }

      const response = await requestAI(text, requestId);

      if (!response || requestId !== state.requestId) {
        return null;
      }

      addMessage("assistant", response);

      emit("ai:response", {
        message: response
      });

      return response;

    } catch (error) {
      if (requestId !== state.requestId) {
        return null;
      }

      const message = error.name === "AbortError"
        ? "La solicitud tardó demasiado."
        : "No pude comunicarme con Shunel AI.";

      emit("ai:error", {
        message,
        error: error.message
      });

      return null;

    } finally {
      if (requestId === state.requestId) {
        state.loading = false;

        emit("ai:thinking", {
          active: false
        });
      }
    }
  }

  function cancel() {
    state.requestId++;

    state.abortController?.abort();

    state.abortController = null;
    state.loading = false;

    emit("ai:thinking", {
      active: false
    });

    return true;
  }

  function clearHistory() {
    state.history = [];

    try {
      localStorage.removeItem(CONFIG.storageKey);
    } catch {}

    emit("ai:history-cleared", {});

    return true;
  }

  function setProvider(callback) {
    if (
      callback !== null &&
      typeof callback !== "function"
    ) {
      return false;
    }

    state.provider = callback;

    return true;
  }

  function initialize() {
    if (state.initialized) return;

    state.history = getHistory();

    state.initialized = true;

    emit("ai:ready", {});

    console.info("[Shunel AI] Sistema preparado.");
  }

  window.ShunelAI = Object.freeze({
    initialize,
    send,
    cancel,
    clearHistory,
    getContext,
    getHistory() {
      return [...state.history];
    },
    getState() {
      return {
        initialized: state.initialized,
        loading: state.loading,
        messageCount: state.history.length
      };
    }
  });

  initialize();

})();
