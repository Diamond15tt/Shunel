
const PLACEHOLDER = "/assets/placeholder.svg";

const SVG_NS = "http://www.w3.org/2000/svg";

export class ShunelUI {
  constructor() {
    this.toastTimer = null;

    this.elements = {
      // Search
      form: document.getElementById("searchForm"),
      input: document.getElementById("searchInput"),
      searchButton: document.getElementById("searchButton"),
      status: document.getElementById("status"),
      results: document.getElementById("results"),
      resultCount: document.getElementById("resultCount"),

      // Collections
      homeRecent: document.getElementById("homeRecentList"),
      library: document.getElementById("libraryList"),
      favorites: document.getElementById("favoritesList"),
      history: document.getElementById("historyList"),

      // Mini player
      currentThumbnail: document.getElementById("currentThumbnail"),
      currentTitle: document.getElementById("currentTitle"),
      currentChannel: document.getElementById("currentChannel"),
      favoriteCurrent: document.getElementById("favoriteCurrent"),
      playButton: document.getElementById("playButton"),
      previousButton: document.getElementById("previousButton"),
      nextButton: document.getElementById("nextButton"),
      currentTime: document.getElementById("currentTime"),
      duration: document.getElementById("duration"),
      progressBar: document.getElementById("progressBar"),
      volumeBar: document.getElementById("volumeBar"),

      // Full player
      fullPlayer: document.getElementById("fullPlayer"),
      expandPlayer: document.getElementById("expandPlayer"),
      closeFullPlayer: document.getElementById("closeFullPlayer"),
      fullThumbnail: document.getElementById("fullPlayerThumbnail"),
      fullTitle: document.getElementById("fullPlayerTitle"),
      fullChannel: document.getElementById("fullPlayerChannel"),
      fullFavorite: document.getElementById("fullPlayerFavorite"),
      fullPlayButton: document.getElementById("fullPlayButton"),
      fullPreviousButton: document.getElementById("fullPreviousButton"),
      fullNextButton: document.getElementById("fullNextButton"),
      fullProgressBar: document.getElementById("fullProgressBar"),
      fullCurrentTime: document.getElementById("fullCurrentTime"),
      fullDuration: document.getElementById("fullDuration"),
      fullQueueButton: document.getElementById("fullQueueToggle"),

      // Queue
      queuePanel: document.getElementById("queuePanel"),
      queueList: document.getElementById("queueList"),
      queueToggle: document.getElementById("queueToggle"),

      // Notifications
      toast: document.getElementById("toast")
    };
  }

  /* =========================================
     HELPERS
  ========================================= */

  on(id, event, callback) {
    const element = document.getElementById(id);

    if (element) {
      element.addEventListener(event, callback);
    }
  }

  setIcon(button, iconName) {
    if (!button) return;

    const svg = document.createElementNS(SVG_NS, "svg");
    const use = document.createElementNS(SVG_NS, "use");

    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");

    use.setAttribute("href", `#icon-${iconName}`);

    svg.appendChild(use);
    button.replaceChildren(svg);
  }

  setImage(image, source) {
    if (!image) return;

    image.onerror = () => {
      image.onerror = null;
      image.src = PLACEHOLDER;
    };

    image.src = source || PLACEHOLDER;
  }

  /* =========================================
     SEARCH
  ========================================= */

  setStatus(message) {
    if (this.elements.status) {
      this.elements.status.textContent = message;
    }
  }

  setSearching(value) {
    const button = this.elements.searchButton;

    if (!button) return;

    button.disabled = Boolean(value);
    button.textContent = value ? "Buscando..." : "Buscar";
  }

  setResultCount(count) {
    if (!this.elements.resultCount) return;

    this.elements.resultCount.textContent =
      count ? `${count} canciones` : "";
  }

  /* =========================================
     EMPTY STATES
  ========================================= */

  showEmpty(container, message) {
    if (!container) return;

    container.replaceChildren();

    const empty = document.createElement("div");

    empty.className = "empty-state";
    empty.textContent = message;

    container.appendChild(empty);
  }

  /* =========================================
     TRACK ACTIONS
  ========================================= */

  makeAction(icon, label) {
    const button = document.createElement("button");

    button.type = "button";
    button.className = "track-action";
    button.title = label;
    button.setAttribute("aria-label", label);

    const icons = {
      play: "play",
      favorite: "heart",
      add: "queue",
      save: "library",
      remove: "close"
    };

    const iconName = icons[icon];

    if (iconName) {
      const svg = document.createElementNS(SVG_NS, "svg");
      const use = document.createElementNS(SVG_NS, "use");

      svg.setAttribute("viewBox", "0 0 24 24");
      use.setAttribute("href", `#icon-${iconName}`);

      svg.appendChild(use);
      button.appendChild(svg);
    } else {
      button.textContent = icon;
    }

    return button;
  }

  makeTrackRow(track, actions = {}) {
    const row = document.createElement("article");

    row.className = "track-row";

    const image = document.createElement("img");

    image.className = "track-art";
    image.alt = "";
    image.loading = "lazy";

    this.setImage(image, track.thumbnail);

    const main = document.createElement("div");

    main.className = "track-main";

    const title = document.createElement("div");

    title.className = "track-name";
    title.textContent = track.title || "Canción sin título";

    const channel = document.createElement("div");

    channel.className = "track-channel";
    channel.textContent = track.channelTitle || "YouTube";

    main.append(title, channel);

    const buttons = document.createElement("div");

    buttons.className = "track-actions";

    const play = this.makeAction("play", "Reproducir");

    play.addEventListener("click", () => {
      actions.play?.(track);
    });

    buttons.appendChild(play);

    if (actions.favorite) {
      const fav = this.makeAction("favorite", "Favorito");

      if (actions.isFavorite) {
        fav.classList.add("is-favorite");
      }

      fav.addEventListener("click", () => {
        actions.favorite(track);
      });

      buttons.appendChild(fav);
    }

    if (actions.save) {
      const save = this.makeAction("save", "Guardar en biblioteca");

      save.addEventListener("click", () => {
        actions.save(track);
      });

      buttons.appendChild(save);
    }

    if (actions.add) {
      const add = this.makeAction("add", "Agregar a la cola");

      add.addEventListener("click", () => {
        actions.add(track);
      });

      buttons.appendChild(add);
    }

    if (actions.remove) {
      const remove = this.makeAction("remove", "Eliminar");

      remove.addEventListener("click", () => {
        actions.remove(track);
      });

      buttons.appendChild(remove);
    }

    row.append(image, main, buttons);

    return row;
  }

  renderTracks(container, tracks, actions, emptyMessage) {
    if (!container) return;

    container.replaceChildren();

    if (!tracks.length) {
      this.showEmpty(container, emptyMessage);
      return;
    }

    const fragment = document.createDocumentFragment();

    tracks.forEach(track => {
      const trackActions = actions(track);

      fragment.appendChild(
        this.makeTrackRow(track, trackActions)
      );
    });

    container.appendChild(fragment);
  }

  /* =========================================
     SEARCH RESULTS
  ========================================= */

  renderSearchResults(tracks, actions) {
    this.renderTracks(
      this.elements.results,
      tracks,
      actions,
      "No encontramos canciones. Prueba con otro nombre."
    );

    this.setResultCount(tracks.length);
  }

  /* =========================================
     COLLECTIONS
  ========================================= */

  renderCollection(type, tracks, actions) {
    const targets = {
      library: this.elements.library,
      favorites: this.elements.favorites,
      history: this.elements.history
    };

    const target = targets[type];

    if (!target) return;

    this.renderTracks(
      target,
      tracks,
      actions,
      "Todavía no hay canciones aquí."
    );
  }

  renderRecent(tracks, actions) {
    this.renderTracks(
      this.elements.homeRecent,
      tracks,
      actions,
      "Todavía no has escuchado música."
    );
  }

  /* =========================================
     CURRENT TRACK
  ========================================= */

  setCurrentTrack(track, favorite = false) {
    const thumbnail = track?.thumbnail || PLACEHOLDER;
    const title = track?.title || "Elige una canción";
    const channel = track?.channelTitle || "Tu música comienza aquí";

    // Mini player
    this.setImage(this.elements.currentThumbnail, thumbnail);

    if (this.elements.currentTitle) {
      this.elements.currentTitle.textContent = title;
    }

    if (this.elements.currentChannel) {
      this.elements.currentChannel.textContent = channel;
    }

    // Full player
    this.setImage(this.elements.fullThumbnail, thumbnail);

    if (this.elements.fullTitle) {
      this.elements.fullTitle.textContent = title;
    }

    if (this.elements.fullChannel) {
      this.elements.fullChannel.textContent = channel;
    }

    // Favorite buttons
    const favoriteButtons = [
      this.elements.favoriteCurrent,
      this.elements.fullFavorite
    ];

    favoriteButtons.forEach(button => {
      if (!button) return;

      button.classList.toggle("is-favorite", Boolean(favorite));

      button.disabled = !track;

      button.setAttribute(
        "aria-label",
        favorite ? "Eliminar de favoritos" : "Agregar a favoritos"
      );
    });
  }

  /* =========================================
     PLAY / PAUSE
  ========================================= */

  setPlaying(playing) {
    const buttons = [
      this.elements.playButton,
      this.elements.fullPlayButton
    ];

    buttons.forEach(button => {
      if (!button) return;

      this.setIcon(button, playing ? "pause" : "play");

      button.setAttribute(
        "aria-label",
        playing ? "Pausar" : "Reproducir"
      );

      button.setAttribute(
        "aria-pressed",
        String(Boolean(playing))
      );
    });
  }

  /* =========================================
     PROGRESS
  ========================================= */

  setProgress(current, duration) {
    const safeDuration =
      Number.isFinite(duration) && duration > 0
        ? duration
        : 0;

    const safeCurrent =
      Number.isFinite(current) && current >= 0
        ? Math.min(current, safeDuration)
        : 0;

    const formattedCurrent = this.formatTime(safeCurrent);
    const formattedDuration = this.formatTime(safeDuration);

    // Mini player
    if (this.elements.currentTime) {
      this.elements.currentTime.textContent = formattedCurrent;
    }

    if (this.elements.duration) {
      this.elements.duration.textContent = formattedDuration;
    }

    if (this.elements.progressBar) {
      this.elements.progressBar.max = String(safeDuration || 100);
      this.elements.progressBar.value = String(safeCurrent);
      this.elements.progressBar.disabled = !safeDuration;
    }

    // Full player
    if (this.elements.fullCurrentTime) {
      this.elements.fullCurrentTime.textContent = formattedCurrent;
    }

    if (this.elements.fullDuration) {
      this.elements.fullDuration.textContent = formattedDuration;
    }

    if (this.elements.fullProgressBar) {
      this.elements.fullProgressBar.max = String(safeDuration || 100);
      this.elements.fullProgressBar.value = String(safeCurrent);
      this.elements.fullProgressBar.disabled = !safeDuration;
    }
  }

  formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) {
      return "0:00";
    }

    const mins = Math.floor(seconds / 60);

    const secs = Math.floor(seconds % 60)
      .toString()
      .padStart(2, "0");

    return `${mins}:${secs}`;
  }

  /* =========================================
     FULL PLAYER
  ========================================= */

  toggleFullPlayer(open) {
    const player = this.elements.fullPlayer;

    if (!player) return;

    const shouldOpen = Boolean(open);

    player.classList.toggle("active", shouldOpen);

    player.setAttribute(
      "aria-hidden",
      String(!shouldOpen)
    );

    document.body.classList.toggle(
      "full-player-open",
      shouldOpen
    );
  }

  /* =========================================
     QUEUE
  ========================================= */

  renderQueue(tracks, currentId, onPlay, onRemove) {
    const container = this.elements.queueList;

    if (!container) return;

    container.replaceChildren();

    if (!tracks.length) {
      this.showEmpty(container, "Tu cola está vacía.");
      return;
    }

    tracks.forEach((track, index) => {
      const row = document.createElement("div");

      row.className = "queue-item";

      if (track.videoId === currentId) {
        row.classList.add("active");
      }

      const image = document.createElement("img");

      image.alt = "";

      this.setImage(image, track.thumbnail);

      const info = document.createElement("div");

      info.className = "queue-item-info";

      const title = document.createElement("div");

      title.className = "queue-item-title";
      title.textContent = track.title || "Sin título";

      const channel = document.createElement("div");

      channel.className = "queue-item-artist";
      channel.textContent = track.channelTitle || "YouTube";

      info.append(title, channel);

      const remove = document.createElement("button");

      remove.type = "button";
      remove.className = "track-action";
      remove.textContent = "×";
      remove.setAttribute("aria-label", "Quitar de la cola");

      remove.addEventListener("click", event => {
        event.stopPropagation();
        onRemove(index);
      });

      row.addEventListener("click", () => {
        onPlay(track);
      });

      row.append(image, info, remove);

      container.appendChild(row);
    });
  }

  toggleQueue(open) {
    const panel = this.elements.queuePanel;

    if (!panel) return;

    const shouldOpen = Boolean(open);

    panel.classList.toggle("active", shouldOpen);

    panel.setAttribute(
      "aria-hidden",
      String(!shouldOpen)
    );
  }

  /* =========================================
     TOAST
  ========================================= */

  toastMessage(message) {
    const toast = this.elements.toast;

    if (!toast) return;

    toast.textContent = message;
    toast.classList.add("visible");

    window.clearTimeout(this.toastTimer);

    this.toastTimer = window.setTimeout(() => {
      toast.classList.remove("visible");
    }, 2200);
  }

  /* =========================================
     NAVIGATION
  ========================================= */

  showView(name) {
    document.querySelectorAll(".view").forEach(view => {
      const active = view.id === `view-${name}`;

      view.classList.toggle("active", active);

      view.setAttribute(
        "aria-hidden",
        String(!active)
      );
    });

    document.querySelectorAll(".bottom-nav-item").forEach(button => {
      const active = button.dataset.view === name;

      button.classList.toggle("active", active);

      button.setAttribute(
        "aria-current",
        active ? "page" : "false"
      );
    });
  }
}
