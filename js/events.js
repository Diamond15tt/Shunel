
/* =========================================
   SHUNEL — EVENT MANAGER
   Sistema central de comunicación
   Version: 1.0.0
========================================= */

(() => {
  "use strict";

  if (window.ShunelEvents) {
    console.warn("[Shunel Events] Ya está inicializado.");
    return;
  }

  const listeners = new Map();
  const history = [];
  const MAX_HISTORY = 100;

  let initialized = false;

  function normalizeName(name) {
    const value = String(name || "").trim();

    if (!value) {
      throw new TypeError("El nombre del evento es obligatorio.");
    }

    return value.startsWith("shunel:")
      ? value
      : `shunel:${value}`;
  }

  function emit(name, detail = {}) {
    const eventName = normalizeName(name);

    const eventDetail = {
      ...(
        detail &&
        typeof detail === "object" &&
        !Array.isArray(detail)
          ? detail
          : { value: detail }
      ),
      eventName,
      timestamp: Date.now()
    };

    const event = new CustomEvent(eventName, {
      detail: eventDetail
    });

    history.push({
      name: eventName,
      timestamp: eventDetail.timestamp
    });

    if (history.length > MAX_HISTORY) {
      history.shift();
    }

    window.dispatchEvent(event);

    return event;
  }

  function on(name, callback, options = {}) {
    const eventName = normalizeName(name);

    if (typeof callback !== "function") {
      throw new TypeError("El callback debe ser una función.");
    }

    const handler = event => {
      callback(event.detail, event);
    };

    window.addEventListener(
      eventName,
      handler,
      options
    );

    if (!listeners.has(eventName)) {
      listeners.set(eventName, new Set());
    }

    const subscription = {
      callback,
      handler
    };

    listeners.get(eventName).add(subscription);

    return () => {
      off(eventName, subscription);
    };
  }

  function once(name, callback) {
    let unsubscribe;

    unsubscribe = on(name, (detail, event) => {
      unsubscribe?.();
      callback(detail, event);
    });

    return unsubscribe;
  }

  function off(name, callback) {
    const eventName = normalizeName(name);
    const subscriptions = listeners.get(eventName);

    if (!subscriptions) return false;

    if (!callback) {
      subscriptions.forEach(subscription => {
        window.removeEventListener(
          eventName,
          subscription.handler
        );
      });

      listeners.delete(eventName);
      return true;
    }

    for (const subscription of subscriptions) {
      if (
        subscription.callback === callback ||
        subscription === callback
      ) {
        window.removeEventListener(
          eventName,
          subscription.handler
        );

        subscriptions.delete(subscription);
      }
    }

    if (!subscriptions.size) {
      listeners.delete(eventName);
    }

    return true;
  }

  function clear() {
    for (const [eventName, subscriptions] of listeners) {
      subscriptions.forEach(subscription => {
        window.removeEventListener(
          eventName,
          subscription.handler
        );
      });
    }

    listeners.clear();
  }

  function getHistory(limit = 20) {
    const amount = Math.max(
      0,
      Math.min(MAX_HISTORY, Number(limit) || 0)
    );

    return history.slice(-amount);
  }

  function getState() {
    return {
      initialized,
      eventTypes: listeners.size,
      activeListeners: [...listeners.values()]
        .reduce((total, set) => total + set.size, 0),
      historySize: history.length
    };
  }

  function initialize() {
    if (initialized) return;

    initialized = true;

    console.info("[Shunel Events] Sistema preparado.");

    emit("events:ready", {
      version: "1.0.0"
    });
  }

  window.ShunelEvents = Object.freeze({
    emit,
    on,
    once,
    off,
    clear,
    getHistory,
    getState
  });

  initialize();

})();
