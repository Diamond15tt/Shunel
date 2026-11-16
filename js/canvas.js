
/* =========================================
   SHUNEL — CANVAS VISUALIZER
   Visualizador de audio en tiempo real
========================================= */

(() => {
  "use strict";

  const audio = document.getElementById("localAudio");

  const canvas = document.getElementById("visualizerCanvas");
  const screen = document.getElementById("canvasScreen");

  if (!audio || !canvas) {
    console.warn(
      "[Shunel Canvas] Falta #localAudio o #visualizerCanvas en el HTML."
    );
    return;
  }

  const ctx = canvas.getContext("2d");

  if (!ctx) return;

  const state = {
    active: false,
    initialized: false,
    animationFrame: null,
    audioContext: null,
    analyser: null,
    source: null,
    data: null,
    mode: "bars",
    sensitivity: 1,
    color: "#6699E8",
    lastWidth: 0,
    lastHeight: 0
  };

  const MODES = ["bars", "wave", "circle"];

  function getSize() {
    const rect = canvas.getBoundingClientRect();

    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    const ratio = Math.min(window.devicePixelRatio || 1, 2);

    if (
      width !== state.lastWidth ||
      height !== state.lastHeight
    ) {
      state.lastWidth = width;
      state.lastHeight = height;

      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);

      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    }

    return { width, height };
  }

  async function initializeAudio() {
    if (state.initialized) {
      return true;
    }

    const AudioContextClass =
      window.AudioContext || window.webkitAudioContext;

    if (!AudioContextClass) {
      console.warn("[Shunel Canvas] Web Audio no está disponible.");
      return false;
    }

    try {
      state.audioContext = new AudioContextClass();

      state.analyser = state.audioContext.createAnalyser();
      state.analyser.fftSize = 256;
      state.analyser.smoothingTimeConstant = 0.82;

      // Se conecta el audio una sola vez.
      // No se conecta directamente el analyser a los parlantes.
      state.source = state.audioContext.createMediaElementSource(audio);

      state.source.connect(state.analyser);
      state.analyser.connect(state.audioContext.destination);

      state.data = new Uint8Array(
        state.analyser.frequencyBinCount
      );

      state.initialized = true;

      return true;

    } catch (error) {
      console.error("[Shunel Canvas] Error de audio:", error);
      return false;
    }
  }

  async function resumeAudio() {
    const ready = await initializeAudio();

    if (!ready) return false;

    if (state.audioContext.state === "suspended") {
      await state.audioContext.resume();
    }

    return true;
  }

  function clear() {
    const { width, height } = getSize();

    ctx.clearRect(0, 0, width, height);
  }

  function getFrequencyData() {
    if (!state.analyser || !state.data) return null;

    state.analyser.getByteFrequencyData(state.data);

    return state.data;
  }

  function drawBars(data, width, height) {
    const count = 48;
    const gap = 3;
    const barWidth = Math.max(1, (width - gap * count) / count);

    for (let i = 0; i < count; i++) {
      const index = Math.floor(
        i * data.length / count
      );

      const value = data[index] / 255;
      const barHeight = Math.max(
        2,
        value * height * 0.85 * state.sensitivity
      );

      const x = i * (barWidth + gap);
      const y = height - barHeight;

      ctx.globalAlpha = 0.35 + value * 0.65;
      ctx.fillStyle = state.color;

      ctx.fillRect(
        x,
        y,
        barWidth,
        barHeight
      );
    }

    ctx.globalAlpha = 1;
  }

  function drawWave(data, width, height) {
    const center = height / 2;

    ctx.beginPath();
    ctx.lineWidth = 2;
    ctx.strokeStyle = state.color;

    const points = Math.min(data.length, 128);

    for (let i = 0; i < points; i++) {
      const value = data[i] / 255;
      const x = (i / (points - 1)) * width;

      const y =
        center -
        (value - 0.5) * height * 1.2 * state.sensitivity;

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }

    ctx.stroke();
  }

  function drawCircle(data, width, height) {
    const centerX = width / 2;
    const centerY = height / 2;

    const baseRadius = Math.min(width, height) * 0.2;
    const count = 80;

    ctx.lineWidth = 2;
    ctx.strokeStyle = state.color;

    for (let i = 0; i < count; i++) {
      const index = Math.floor(
        i * data.length / count
      );

      const value = data[index] / 255;
      const angle = (i / count) * Math.PI * 2;

      const length =
        value * baseRadius * state.sensitivity;

      const innerRadius = baseRadius;
      const outerRadius = baseRadius + length;

      const x1 = centerX + Math.cos(angle) * innerRadius;
      const y1 = centerY + Math.sin(angle) * innerRadius;

      const x2 = centerX + Math.cos(angle) * outerRadius;
      const y2 = centerY + Math.sin(angle) * outerRadius;

      ctx.globalAlpha = 0.35 + value * 0.65;

      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    ctx.globalAlpha = 1;

    ctx.beginPath();
    ctx.arc(centerX, centerY, baseRadius * 0.82, 0, Math.PI * 2);

    ctx.fillStyle = "rgba(102, 153, 232, 0.08)";
    ctx.fill();
  }

  function render() {
    if (!state.active) return;

    const { width, height } = getSize();

    ctx.clearRect(0, 0, width, height);

    const data = getFrequencyData();

    if (data && !audio.paused) {
      if (state.mode === "wave") {
        drawWave(data, width, height);
      } else if (state.mode === "circle") {
        drawCircle(data, width, height);
      } else {
        drawBars(data, width, height);
      }
    }

    state.animationFrame = requestAnimationFrame(render);
  }

  async function open() {
    screen?.classList.add("active");
    screen?.setAttribute("aria-hidden", "false");

    state.active = true;

    const ready = await resumeAudio();

    if (!ready) {
      clear();
      return false;
    }

    if (state.animationFrame === null) {
      render();
    }

    return true;
  }

  function close() {
    state.active = false;

    if (state.animationFrame !== null) {
      cancelAnimationFrame(state.animationFrame);
      state.animationFrame = null;
    }

    screen?.classList.remove("active");
    screen?.setAttribute("aria-hidden", "true");

    clear();
  }

  function setMode(mode) {
    if (!MODES.includes(mode)) return false;

    state.mode = mode;

    return true;
  }

  function setSensitivity(value) {
    const number = Number(value);

    if (!Number.isFinite(number)) return;

    state.sensitivity = Math.max(
      0.3,
      Math.min(2.5, number)
    );
  }

  function setColor(color) {
    if (
      typeof color !== "string" ||
      !/^#[0-9a-f]{6}$/i.test(color)
    ) {
      return false;
    }

    state.color = color;

    return true;
  }

  function initializeControls() {
    document.querySelectorAll("[data-visualizer-mode]").forEach(button => {
      button.addEventListener("click", () => {
        const mode = button.dataset.visualizerMode;

        if (!setMode(mode)) return;

        document.querySelectorAll("[data-visualizer-mode]").forEach(item => {
          item.classList.toggle("active", item === button);
        });
      });
    });

    const sensitivityInput = document.getElementById(
      "visualizerSensitivity"
    );

    sensitivityInput?.addEventListener("input", () => {
      setSensitivity(sensitivityInput.value);
    });

    const colorInput = document.getElementById(
      "visualizerColor"
    );

    colorInput?.addEventListener("input", () => {
      setColor(colorInput.value);
    });
  }

  function initialize() {
    initializeControls();

    window.ShunelCanvas = {
      open,
      close,
      setMode,
      setColor,
      setSensitivity,

      getState: () => ({
        active: state.active,
        initialized: state.initialized,
        mode: state.mode,
        sensitivity: state.sensitivity,
        color: state.color
      })
    };

    window.addEventListener("resize", () => {
      if (state.active) getSize();
    });

    console.info("[Shunel Canvas] Visualizador preparado.");
  }

  initialize();

})();
