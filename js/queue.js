import { Storage } from "./storage.js";

function isValid(track) {
  return track && /^[a-zA-Z0-9_-]{11}$/.test(track.videoId || "");
}

export class QueueManager {
  constructor() {
    this.items = Storage.getQueue().filter(isValid);
    this.current = null;
    this.onChange = () => {};
  }

  setOnChange(callback) {
    this.onChange = typeof callback === "function" ? callback : () => {};
    this.emit();
  }

  emit() {
    Storage.saveQueue(this.items);
    this.onChange(this.getItems());
  }

  getItems() {
    return this.items.map(item => ({ ...item }));
  }

  add(track) {
    if (!isValid(track)) return false;
    this.items.push({ ...track });
    this.emit();
    return true;
  }

  addMany(tracks) {
    tracks.filter(isValid).forEach(track => this.items.push({ ...track }));
    this.emit();
  }

  remove(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.items.length) return;
    this.items.splice(index, 1);
    this.emit();
  }

  clear() {
    this.items = [];
    this.emit();
  }

  takeNext() {
    const next = this.items.shift() || null;
    this.emit();
    return next;
  }

  setCurrent(track) {
    this.current = isValid(track) ? { ...track } : null;
    this.emit();
  }
}
