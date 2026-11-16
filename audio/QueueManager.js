
/**
 * MEULIFY LOCAL
 * QueueManager.js
 *
 * Gestión de la cola de reproducción.
 */

export class QueueManager {
  constructor(options = {}) {
    this.queue = [];
    this.currentIndex = -1;
    this.maxQueueSize = options.maxQueueSize || 10000;
  }

  get length() {
    return this.queue.length;
  }

  get isEmpty() {
    return this.queue.length === 0;
  }

  get current() {
    return this.getCurrent();
  }

  getCurrent() {
    if (
      this.currentIndex < 0 ||
      this.currentIndex >= this.queue.length
    ) {
      return null;
    }

    return this.queue[this.currentIndex];
  }

  getAll() {
    return [...this.queue];
  }

  getIndex() {
    return this.currentIndex;
  }

  setQueue(songs = [], startIndex = 0) {
    if (!Array.isArray(songs)) {
      throw new TypeError("La cola debe ser un arreglo de canciones.");
    }

    this.queue = songs
      .filter(song => song && typeof song === "object")
      .slice(0, this.maxQueueSize);

    if (!this.queue.length) {
      this.currentIndex = -1;
      return null;
    }

    const index = Number.isInteger(startIndex) ? startIndex : 0;

    this.currentIndex = Math.max(
      0,
      Math.min(index, this.queue.length - 1)
    );

    return this.getCurrent();
  }

  add(song) {
    if (!song || typeof song !== "object") {
      throw new TypeError("La canción no es válida.");
    }

    if (this.queue.length >= this.maxQueueSize) {
      return false;
    }

    this.queue.push(song);

    if (this.currentIndex === -1) {
      this.currentIndex = 0;
    }

    return true;
  }

  addMany(songs = []) {
    if (!Array.isArray(songs)) {
      throw new TypeError("Debes proporcionar un arreglo.");
    }

    let added = 0;

    for (const song of songs) {
      if (this.queue.length >= this.maxQueueSize) break;
      if (!song || typeof song !== "object") continue;

      this.queue.push(song);
      added++;
    }

    if (this.currentIndex === -1 && this.queue.length) {
      this.currentIndex = 0;
    }

    return added;
  }

  insertNext(song) {
    if (!song || typeof song !== "object") {
      throw new TypeError("La canción no es válida.");
    }

    if (this.queue.length >= this.maxQueueSize) return false;

    const position = this.currentIndex < 0
      ? 0
      : this.currentIndex + 1;

    this.queue.splice(position, 0, song);

    if (this.currentIndex === -1) {
      this.currentIndex = 0;
    }

    return true;
  }

  remove(index) {
    if (!Number.isInteger(index)) return null;
    if (index < 0 || index >= this.queue.length) return null;

    const [removed] = this.queue.splice(index, 1);

    if (!this.queue.length) {
      this.currentIndex = -1;
    } else if (index < this.currentIndex) {
      this.currentIndex--;
    } else if (index === this.currentIndex) {
      this.currentIndex = Math.min(
        this.currentIndex,
        this.queue.length - 1
      );
    }

    return removed;
  }

  removeById(id) {
    const index = this.queue.findIndex(song => song.id === id);
    if (index === -1) return null;
    return this.remove(index);
  }

  clear() {
    this.queue = [];
    this.currentIndex = -1;
  }

  setCurrentIndex(index) {
    if (!Number.isInteger(index)) return null;
    if (index < 0 || index >= this.queue.length) return null;

    this.currentIndex = index;
    return this.getCurrent();
  }

  next(options = {}) {
    if (this.isEmpty) return null;

    const wrap = options.wrap !== false;
    const nextIndex = this.currentIndex + 1;

    if (nextIndex < this.queue.length) {
      this.currentIndex = nextIndex;
      return this.getCurrent();
    }

    if (wrap) {
      this.currentIndex = 0;
      return this.getCurrent();
    }

    return null;
  }

  previous(options = {}) {
    if (this.isEmpty) return null;

    const wrap = options.wrap !== false;
    const previousIndex = this.currentIndex - 1;

    if (previousIndex >= 0) {
      this.currentIndex = previousIndex;
      return this.getCurrent();
    }

    if (wrap) {
      this.currentIndex = this.queue.length - 1;
      return this.getCurrent();
    }

    return null;
  }

  findById(id) {
    return this.queue.find(song => song.id === id) || null;
  }

  findIndexById(id) {
    return this.queue.findIndex(song => song.id === id);
  }

  move(fromIndex, toIndex) {
    if (
      !Number.isInteger(fromIndex) ||
      !Number.isInteger(toIndex) ||
      fromIndex < 0 ||
      toIndex < 0 ||
      fromIndex >= this.queue.length ||
      toIndex >= this.queue.length
    ) {
      return false;
    }

    if (fromIndex === toIndex) return true;

    const currentSong = this.getCurrent();
    const [song] = this.queue.splice(fromIndex, 1);
    this.queue.splice(toIndex, 0, song);

    this.currentIndex = this.queue.indexOf(currentSong);

    return true;
  }

  replaceSong(id, updatedSong) {
    if (!updatedSong || typeof updatedSong !== "object") {
      return false;
    }

    const index = this.findIndexById(id);
    if (index === -1) return false;

    this.queue[index] = updatedSong;
    return true;
  }

  snapshot() {
    return {
      queue: this.getAll(),
      currentIndex: this.currentIndex
    };
  }
}

export default QueueManager;
