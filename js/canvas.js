
/* =========================================
   SHUNEL — AUDIO VISUALIZER
   Barras, ondas y modo circular
   Version: 2.0.0
========================================= */

(() => {
  "use strict";

  if (window.ShunelCanvas) return;

  const state = {
    canvas: null,
    context: null,
    analyser: null,
    animationFrame: null,
    frequencyData: null,
    timeData: null,
    mode: "bars",
    enabled: true,
    initialized: false,
    width: 0,
    height: 0,
    dpr: 1,
    sensitivity: 1.25,
    smoothing: 0.72,
    barCount: 64,
    color: "#d8b56d"
  };

  const MODES = [
    "bars",
    "wave",
    "circle"
  ];

  function emit(name, detail = {}) {
    if (window.ShunelEvents) {
      window.ShunelEvents.emit(name, detail);
    } else {
      window.dispatchEvent(
        new CustomEvent(`shunel:${name}`, { detail })
      );
    }
  }

  function getEngine() {
    return window.ShunelAudioEngine || null;
  }

  function getAnalyser() {
    const engine = getEngine();

    if (!engine) return null;

    try {
      if (!engine.getState().initialized) {
        engine.initialize();
      }

      return engine.getAnalyser();
    } catch (error) {
      console.warn(
        "[Shunel Canvas] No se pudo obtener el analizador:",
        error
      );

      return null;
    }
  }

  function resize() {
    if (!state.canvas || !state.context) return;

    const rect = state.canvas.getBoundingClientRect();

    if (!rect.width || !rect.height) return;

    state.dpr = Math.min(
      window.devicePixelRatio || 1,
      2
    );

    state.width = rect.width;
    state.height = rect.height;

    state.canvas.width = Math.round(
      rect.width * state.dpr
    );

    state.canvas.height = Math.round(
      rect.height * state.dpr
    );

    state.context.setTransform(
      state.dpr,
      0,
      0,
      state.dpr,
      0,
      0
    );
  }

  function clear() {
    if (!state.context) return;

    state.context.clearRect(
      0,
      0,
      state.width,
      state.height
    );
  }

  function getFrequencyData() {
    if (!state.analyser || !state.frequencyData) {
      return null;
    }

    state.analyser.getByteFrequencyData(
      state.frequencyData
    );

    return state.frequencyData;
  }

  function getTimeData() {
    if (!state.analyser || !state.timeData) {
      return null;
    }

    state.analyser.getByteTimeDomainData(
      state.timeData
    );

    return state.timeData;
  }

  function drawBars() {
    const ctx = state.context;
    const data = getFrequencyData();

    if (!data) return;

    const width = state.width;
    const height = state.height;

    const count = Math.min(
      state.barCount,
      data.length
    );

    const gap = 3;
    const barWidth = Math.max(
      1,
      (width - gap * (count - 1)) / count
    );

    const step = Math.floor(data.length / count);

    for (let i = 0; i < count; i++) {
      const value = data[i * step] / 255;

      const barHeight = Math.max(
        2,
        value * height * state.sensitivity
      );

      const x = i * (barWidth + gap);
      const y = height - barHeight;

      const opacity = 0.45 + value * 0.55;

      ctx.fillStyle = state.color;
      ctx.globalAlpha = opacity;

      ctx.fillRect(
        x,
        y,
        barWidth,
        barHeight
      );
    }

    ctx.globalAlpha = 1;
  }

  function drawWave() {
    const ctx = state.context;
    const data = getTimeData();

    if (!data) return;

    const width = state.width;
    const height = state.height;

    ctx.beginPath();

    ctx.lineWidth = 2;
    ctx.strokeStyle = state.color;
    ctx.globalAlpha = 0.95;

    const sliceWidth = width / data.length;

    for (let i = 0; i < data.length; i++) {
      const value = data[i] / 128;
      const y = value * height / 2;
      const x = i * sliceWidth;

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }

    ctx.stroke();

    ctx.beginPath();
    ctx.globalAlpha = 0.2;

    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);

    ctx.stroke();

    ctx.globalAlpha = 1;
  }

  function drawCircle() {
    const ctx = state.context;
    const data = getFrequencyData();

    if (!data) return;

    const width = state.width;
    const height = state.height;

    const centerX = width / 2;
    const centerY = height / 2;

    const baseRadius = Math.min(
      width,
      height
    ) * 0.23;

    const count = Math.min(
      100,
      data.length
    );

    const step = Math.floor(data.length / count);

    ctx.lineWidth = 3;
    ctx.strokeStyle = state.color;

    for (let i = 0; i < count; i++) {
      const value = data[i * step] / 255;

      const angle =
        (i / count) * Math.PI * 2;

      const innerRadius = baseRadius;
      const outerRadius =
        baseRadius +
        value * baseRadius * state.sensitivity;

      const x1 =
        centerX + Math.cos(angle) * innerRadius;

      const y1 =
        centerY + Math.sin(angle) * innerRadius;

      const x2 =
        centerX + Math.cos(angle) * outerRadius;

      const y2 =
        centerY + Math.sin(angle) * outerRadius;

      ctx.globalAlpha = 0.4 + value * 0.6;

      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    ctx.globalAlpha = 1;

    ctx.beginPath();
    ctx.arc(
      centerX,
      centerY,
      baseRadius * 0.85,
      0,
      Math.PI * 2
    );

    ctx.strokeStyle = state.color;
    ctx.globalAlpha = 0.3;
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.globalAlpha = 1;
  }

  function draw() {
    if (!state.enabled || !state.initialized) {
      return;
    }

    if (!state.context || !state.analyser) {
      return;
    }

    clear();

    switch (state.mode) {
      case "wave":
        drawWave();
        break;

      case "circle":
        drawCircle();
        break;

      default:
        drawBars();
        break;
    }

    state.animationFrame = requestAnimationFrame(draw);
  }

  function start() {
    if (!state.initialized || !state.enabled) {
      return false;
    }

    if (state.animationFrame) {
      return true;
    }

    const engine = getEngine();

    if (engine) {
      engine.resume().catch(() => {});
    }

    state.analyser = getAnalyser();

    if (!state.analyser) {
      return false;
    }

    state.frequencyData = new Uint8Array(
      state.analyser.frequencyBinCount
    );

    state.timeData = new Uint8Array(
      state.analyser.fftSize
    );

    resize();

    state.animationFrame = requestAnimationFrame(draw);

    emit("visualizer:start", {
      mode: state.mode
    });

    return true;
  }

  function stop() {
    if (state.animationFrame) {
      cancelAnimationFrame(state.animationFrame);
      state.animationFrame = null;
    }

    clear();

    emit("visualizer:stop", {});
  }

  function setMode(mode) {
    if (!MODES.includes(mode)) {
      return false;
    }

    state.mode = mode;

    if (state.canvas) {
      state.canvas.dataset.visualizerMode = mode;
    }

    emit("visualizer:modechange", { mode });

    if (state.animationFrame) {
      stop();
      start();
    }

    return true;
  }

  function setSensitivity(value) {
    const number = Number(value);

    if (!Number.isFinite(number)) return;

    state.sensitivity = Math.max(
      0.3,
      Math.min(3, number)
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

  function enable() {
    state.enabled = true;
    return start();
  }

  function disable() {
    state.enabled = false;
    stop();

    return true;
  }

  function initialize() {
    if (state.initialized) return true;

    state.canvas =
      document.getElementById("visualizerCanvas") ||
      document.querySelector("[data-shunel-visualizer]");

    if (!state.canvas) {
      console.warn(
        "[Shunel Canvas] No se encontró el canvas."
      );

      return false;
    }

    state.context = state.canvas.getContext("2d", {
      alpha: true
    });

    if (!state.context) return false;

    state.initialized = true;

    resize();

    window.addEventListener("resize", resize);

    if ("ResizeObserver" in window) {
      const observer = new ResizeObserver(resize);
      observer.observe(state.canvas);
      state.resizeObserver = observer;
    }

    emit("visualizer:ready", {
      modes: [...MODES]
    });

    console.info(
      "[Shunel Canvas] Visualizador preparado."
    );

    return true;
  }

  function dispose() {
    stop();

    window.removeEventListener("resize", resize);

    state.resizeObserver?.disconnect();

    state.initialized = false;
    state.canvas = null;
    state.context = null;
    state.analyser = null;
    state.frequencyData = null;
    state.timeData = null;
  }

  window.ShunelCanvas = Object.freeze({
    initialize,
    start,
    stop,
    enable,
    disable,
    setMode,
    setSensitivity,
    setColor,
    getState() {
      return {
        initialized: state.initialized,
        enabled: state.enabled,
        mode: state.mode,
        sensitivity: state.sensitivity,
        color: state.color
      };
    },
    dispose
  });

  initialize();

})();
