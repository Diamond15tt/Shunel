
/* =========================================
   SHUNEL — LYRICS ENGINE
   Letras sincronizadas mediante LRCLIB
========================================= */

(() => {
  "use strict";

  const API = "https://lrclib.net/api";
  const audio = document.getElementById("localAudio");

  const state = {
    track: null,
    lyrics: [],
    plainLyrics: "",
    currentLine: -1,
    loading: false,
    requestId: 0,
    cache: new Map()
  };

  const elements = {
    screen: document.getElementById("lyricsScreen"),
    content: document.getElementById("lyricsContent"),
    title: document.getElementById("lyricsTitle"),
    artist: document.getElementById("lyricsArtist"),
    status: document.getElementById("lyricsStatus")
  };

  function normalize(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function getTrack() {
    return window.ShunelPlayer?.getCurrentTrack?.() || null;
  }

  function getTrackKey(track) {
    return `${normalize(track.title)}::${normalize(track.artist)}`;
  }

  function setStatus(message) {
    if (elements.status) {
      elements.status.textContent = message;
    }
  }

  function setTrackInformation(track) {
    if (elements.title) {
      elements.title.textContent = track?.title || "Letras";
    }

    if (elements.artist) {
      elements.artist.textContent = track?.artist || "";
    }
  }

  function renderMessage(message) {
    if (!elements.content) return;

    elements.content.replaceChildren();

    const paragraph = document.createElement("p");
    paragraph.className = "lyrics-message";
    paragraph.textContent = message;

    elements.content.appendChild(paragraph);
  }

  function parseSyncedLyrics(text) {
    if (!text) return [];

    const lines = [];

    for (const rawLine of text.split(/\r?\n/)) {
      const matches = [...rawLine.matchAll(
        /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g
      )];

      const content = rawLine.replace(
        /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g,
        ""
      ).trim();

      for (const match of matches) {
        const minutes = Number(match[1]);
        const seconds = Number(match[2]);
        const fraction = match[3] || "0";

        const timestamp =
          minutes * 60 +
          seconds +
          Number(`0.${fraction}`);

        lines.push({
          time: timestamp,
          text: content
        });
      }
    }

    return lines.sort((a, b) => a.time - b.time);
  }

  async function searchLyrics(track) {
    const title = String(track.title || "").trim();
    const artist = String(track.artist || "").trim();

    if (!title || !artist) {
      throw new Error("Faltan datos de la canción.");
    }

    const params = new URLSearchParams({
      track_name: title,
      artist_name: artist
    });

    const response = await fetch(
      `${API}/get?${params.toString()}`,
      {
        headers: {
          Accept: "application/json"
        }
      }
    );

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error("No se pudo consultar LRCLIB.");
    }

    return response.json();
  }

  async function loadLyrics(track = getTrack()) {
    if (!track) {
      renderMessage("Reproducí una canción para ver sus letras.");
      return;
    }

    const requestId = ++state.requestId;
    const key = getTrackKey(track);

    state.track = track;
    state.lyrics = [];
    state.plainLyrics = "";
    state.currentLine = -1;

    setTrackInformation(track);
    setStatus("Buscando letras...");
    renderMessage("Buscando letras de esta canción...");

    if (state.cache.has(key)) {
      const cached = state.cache.get(key);

      if (requestId === state.requestId) {
        applyLyrics(cached);
      }

      return;
    }

    state.loading = true;

    try {
      const result = await searchLyrics(track);

      if (requestId !== state.requestId) return;

      if (!result) {
        state.cache.set(key, null);
        renderMessage("No encontramos letras para esta canción.");
        setStatus("Letras no disponibles");
        return;
      }

      const synced = parseSyncedLyrics(result.syncedLyrics || "");

      const data = {
        synced,
        plain: result.plainLyrics || ""
      };

      state.cache.set(key, data);
      applyLyrics(data);

    } catch (error) {
      if (requestId !== state.requestId) return;

      console.error("[Shunel Lyrics]", error);

      renderMessage("No se pudieron cargar las letras. Revisá tu conexión e intentá de nuevo.");
      setStatus("Error al cargar letras");

    } finally {
      if (requestId === state.requestId) {
        state.loading = false;
      }
    }
  }

  function applyLyrics(data) {
    state.lyrics = data?.synced || [];
    state.plainLyrics = data?.plain || "";
    state.currentLine = -1;

    if (state.lyrics.length) {
      renderSyncedLyrics();
      setStatus("Letras sincronizadas");
      updateCurrentLine();
      return;
    }

    if (state.plainLyrics) {
      renderPlainLyrics();
      setStatus("Letras disponibles");
      return;
    }

    renderMessage("No encontramos letras para esta canción.");
    setStatus("Letras no disponibles");
  }

  function renderSyncedLyrics() {
    if (!elements.content) return;

    elements.content.replaceChildren();

    const fragment = document.createDocumentFragment();

    state.lyrics.forEach((line, index) => {
      const paragraph = document.createElement("p");

      paragraph.className = "lyrics-line";
      paragraph.dataset.index = String(index);
      paragraph.textContent = line.text || "♪";

      paragraph.addEventListener("click", () => {
        if (!audio || !Number.isFinite(line.time)) return;

        audio.currentTime = line.time;

        if (audio.paused) {
          audio.play().catch(() => {});
        }
      });

      fragment.appendChild(paragraph);
    });

    elements.content.appendChild(fragment);
  }

  function renderPlainLyrics() {
    if (!elements.content) return;

    elements.content.replaceChildren();

    const paragraph = document.createElement("p");
    paragraph.className = "lyrics-plain";
    paragraph.textContent = state.plainLyrics;

    elements.content.appendChild(paragraph);
  }

  function updateCurrentLine() {
    if (!audio || !state.lyrics.length || !elements.content) return;

    const currentTime = audio.currentTime;

    let low = 0;
    let high = state.lyrics.length - 1;
    let found = -1;

    while (low <= high) {
      const middle = Math.floor((low + high) / 2);

      if (state.lyrics[middle].time <= currentTime) {
        found = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }

    if (found === state.currentLine) return;

    state.currentLine = found;

    const lines = elements.content.querySelectorAll(".lyrics-line");

    lines.forEach((line, index) => {
      const active = index === found;

      line.classList.toggle("active", active);
      line.classList.toggle("past", found >= 0 && index < found);
    });

    if (found >= 0) {
      const activeLine = lines[found];

      activeLine?.scrollIntoView({
        behavior: "smooth",
        block: "center"
      });
    }
  }

  function open() {
    elements.screen?.classList.add("active");
    elements.screen?.setAttribute("aria-hidden", "false");

    const current = getTrack();

    if (
      current &&
      state.track &&
      getTrackKey(current) === getTrackKey(state.track)
    ) {
      updateCurrentLine();
    } else {
      loadLyrics(current);
    }
  }

  function close() {
    elements.screen?.classList.remove("active");
    elements.screen?.setAttribute("aria-hidden", "true");
  }

  function handleTrackChange(event) {
    const track = event.detail?.track || getTrack();

    if (!track) return;

    if (
      elements.screen?.classList.contains("active") ||
      elements.screen?.classList.contains("show")
    ) {
      loadLyrics(track);
    } else {
      state.track = track;
      state.lyrics = [];
      state.plainLyrics = "";
      state.currentLine = -1;
    }
  }

  function initialize() {
    if (audio) {
      audio.addEventListener("timeupdate", updateCurrentLine);
      audio.addEventListener("seeked", updateCurrentLine);
    }

    document.addEventListener("shunel:trackchange", handleTrackChange);

    window.ShunelLyrics = {
      open,
      close,
      load: loadLyrics,
      refresh: () => loadLyrics(getTrack()),
      getState: () => ({
        track: state.track,
        lyrics: state.lyrics,
        plainLyrics: state.plainLyrics,
        currentLine: state.currentLine,
        loading: state.loading
      })
    };

    console.info("[Shunel] Lyrics engine iniciado.");
  }

  initialize();

})();
