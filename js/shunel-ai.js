
/* =========================================
   SHUNEL — AI ASSISTANT
   Asistente musical inteligente
========================================= */

(() => {
  "use strict";

  const state = {
    messages: [],
    loading: false,
    initialized: false,
    maxMessages: 100
  };

  const selectors = {
    form: "#aiForm",
    input: "#aiInput",
    send: "#aiSendButton",
    messages: "#aiMessages",
    clear: "#aiClearButton"
  };

  const $ = selector => document.querySelector(selector);

  function getPlayer() {
    return window.ShunelPlayer || null;
  }

  function getCurrentTrack() {
    return getPlayer()?.getCurrentTrack?.() || null;
  }

  function getMessagesElement() {
    return $(selectors.messages) ||
      document.querySelector("[data-ai-messages]");
  }

  function getInputElement() {
    return $(selectors.input) ||
      document.querySelector("[data-ai-input]");
  }

  function normalize(text) {
    return String(text || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();
  }

  function addMessage(role, content) {
    const message = {
      role,
      content: String(content || ""),
      timestamp: Date.now()
    };

    state.messages.push(message);

    if (state.messages.length > state.maxMessages) {
      state.messages.shift();
    }

    renderMessage(message);

    document.dispatchEvent(
      new CustomEvent("shunel:ai-message", {
        detail: message
      })
    );

    return message;
  }

  function renderMessage(message) {
    const container = getMessagesElement();

    if (!container) return;

    const article = document.createElement("article");

    article.className = `ai-message ai-message-${message.role}`;
    article.dataset.role = message.role;

    const content = document.createElement("p");
    content.textContent = message.content;

    article.appendChild(content);
    container.appendChild(article);

    container.scrollTop = container.scrollHeight;
  }

  function setLoading(value) {
    state.loading = Boolean(value);

    const sendButton = $(selectors.send);
    const input = getInputElement();

    if (sendButton) {
      sendButton.disabled = state.loading;
    }

    if (input) {
      input.disabled = state.loading;
    }

    document.dispatchEvent(
      new CustomEvent("shunel:ai-loading", {
        detail: { loading: state.loading }
      })
    );
  }

  function getTrackDescription() {
    const track = getCurrentTrack();

    if (!track) {
      return "No hay ninguna canción reproduciéndose.";
    }

    return `Estás escuchando ${track.title || "una canción"} de ${track.artist || "un artista desconocido"}.`;
  }

  function executeCommand(message) {
    const text = normalize(message);
    const player = getPlayer();

    if (!player) return null;

    if (
      /^(pausa|pausar|detener|stop|para la musica|pausa la musica)$/.test(text)
    ) {
      player.pause();
      return "Listo, pausé la música.";
    }

    if (
      /^(reanuda|reanudar|continua|continuar|reproducir|seguir escuchando)$/.test(text)
    ) {
      player.play();
      return "Continuamos con la música.";
    }

    if (
      /^(siguiente|otra cancion|cambia la cancion|next)$/.test(text)
    ) {
      player.next();
      return "Vamos con la siguiente canción.";
    }

    if (
      /^(anterior|cancion anterior|vuelve a la anterior)$/.test(text)
    ) {
      player.previous();
      return "Volviendo a la canción anterior.";
    }

    if (
      /^(que estoy escuchando|cancion actual|que cancion suena|que suena)$/.test(text)
    ) {
      return getTrackDescription();
    }

    if (
      /^(abre letras|mostrar letras|quiero ver las letras)$/.test(text)
    ) {
      window.ShunelLyrics?.open();
      return "Abriendo las letras.";
    }

    if (
      /^(abre visualizador|mostrar visualizador|visualizador)$/.test(text)
    ) {
      window.ShunelCanvas?.open();
      return "Abriendo el visualizador.";
    }

    if (
      /^(activa radio|iniciar radio|pon radio|radio inteligente)$/.test(text)
    ) {
      window.ShunelRadio?.start();
      return "Preparando tu radio musical.";
    }

    if (
      /^(activa aleatorio|activar aleatorio|modo aleatorio)$/.test(text)
    ) {
      player.toggleShuffle();
      return "Cambié el modo aleatorio.";
    }

    if (
      /^(activa repetir|activar repetir|repetir cancion)$/.test(text)
    ) {
      player.toggleRepeat();
      return "Cambié el modo de repetición.";
    }

    return null;
  }

  async function askAI(message) {
    const provider = window.ShunelAIProvider;

    if (typeof provider === "function") {
      return await provider({
        message,
        history: state.messages.slice(-20),
        currentTrack: getCurrentTrack()
      });
    }

    document.dispatchEvent(
      new CustomEvent("shunel:ai-request", {
        detail: {
          message,
          history: state.messages.slice(-20),
          currentTrack: getCurrentTrack()
        }
      })
    );

    return null;
  }

  async function ask(message) {
    const question = String(message || "").trim();

    if (!question || state.loading) return null;

    addMessage("user", question);

    const commandResponse = executeCommand(question);

    if (commandResponse) {
      addMessage("assistant", commandResponse);
      return commandResponse;
    }

    setLoading(true);

    try {
      const response = await askAI(question);

      if (response === null || response === undefined || response === "") {
        const fallback =
          "Todavía estoy esperando la conexión con el modelo de IA. Por ahora puedo controlar la reproducción, abrir las letras y activar tu radio.";

        addMessage("assistant", fallback);
        return fallback;
      }

      const answer = typeof response === "string"
        ? response
        : response.message || response.text || "";

      if (!answer) {
        throw new Error("La respuesta del asistente está vacía.");
      }

      addMessage("assistant", answer);

      return answer;

    } catch (error) {
      console.error("[Shunel AI]", error);

      const fallback =
        "No pude completar la solicitud. Revisá tu conexión e intentá nuevamente.";

      addMessage("assistant", fallback);

      return fallback;

    } finally {
      setLoading(false);
    }
  }

  function clear() {
    state.messages = [];

    const container = getMessagesElement();

    if (container) {
      container.replaceChildren();
    }

    document.dispatchEvent(
      new CustomEvent("shunel:ai-clear")
    );
  }

  function open() {
    const page = document.getElementById("aiPage");

    page?.classList.add("active");

    document.dispatchEvent(
      new CustomEvent("shunel:ai-open")
    );

    getInputElement()?.focus();
  }

  function close() {
    document.dispatchEvent(
      new CustomEvent("shunel:ai-close")
    );
  }

  function handleSubmit(event) {
    event.preventDefault();

    const input = getInputElement();

    if (!input) return;

    const message = input.value.trim();

    if (!message) return;

    input.value = "";

    ask(message);
  }

  function initialize() {
    if (state.initialized) return;

    state.initialized = true;

    const form = $(selectors.form);
    const sendButton = $(selectors.send);
    const clearButton = $(selectors.clear);

    form?.addEventListener("submit", handleSubmit);

    sendButton?.addEventListener("click", () => {
      if (!form) {
        const input = getInputElement();

        if (input) {
          const message = input.value.trim();

          if (message) {
            input.value = "";
            ask(message);
          }
        }
      }
    });

    clearButton?.addEventListener("click", clear);

    window.ShunelAI = {
      ask,
      open,
      close,
      clear,

      getHistory: () => [...state.messages],

      getState: () => ({
        loading: state.loading,
        messageCount: state.messages.length,
        connected: typeof window.ShunelAIProvider === "function"
      }),

      setProvider(provider) {
        if (typeof provider !== "function") {
          throw new TypeError("El proveedor debe ser una función.");
        }

        window.ShunelAIProvider = provider;
      }
    };

    console.info("[Shunel AI] Asistente preparado.");
  }

  initialize();

})();
