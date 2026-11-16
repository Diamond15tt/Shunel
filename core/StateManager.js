/**
 * MEULIFY LOCAL
 * StateManager.js
 * Estado central de la aplicación.
 */

function clone(value) {
    if (typeof structuredClone === "function") {
        return structuredClone(value);
    }

    return JSON.parse(JSON.stringify(value));
}

function getNestedValue(object, path) {
    return path.split(".").reduce(
        (current, key) => current?.[key],
        object
    );
}

function setNestedValue(object, path, value) {
    const keys = path.split(".");
    const lastKey = keys.pop();

    let current = object;

    for (const key of keys) {
        if (
            current[key] === null ||
            typeof current[key] !== "object"
        ) {
            current[key] = {};
        }

        current = current[key];
    }

    current[lastKey] = value;
}

export class StateManager {
    constructor(options = {}) {
        this.storageKey = options.storageKey || "meulify_state";
        this.persist = options.persist !== false;

        this.listeners = new Set();
        this.state = this.createInitialState();

        this.load();
    }

    createInitialState() {
        return {
            app: {
                initialized: false,
                currentPage: "home",
                theme: "dark"
            },

            player: {
                currentSong: null,
                isPlaying: false,
                isPaused: false,
                currentTime: 0,
                duration: 0,
                volume: 0.8,
                muted: false,
                repeatMode: "off",
                shuffle: false
            },

            queue: {
                songs: [],
                currentIndex: -1
            },

            library: {
                songs: [],
                albums: [],
                artists: [],
                favorites: [],
                recentlyPlayed: [],
                playlists: []
            },

            search: {
                query: "",
                results: [],
                loading: false,
                history: []
            },

            settings: {
                autoplay: true,
                crossfade: false,
                equalizerEnabled: false,
                notifications: true
            }
        };
    }

    getState() {
        return clone(this.state);
    }

    get(path) {
        if (!path) return this.getState();

        const value = getNestedValue(this.state, path);

        return value === undefined ? undefined : clone(value);
    }

    set(path, value) {
        if (typeof path !== "string" || !path.trim()) {
            throw new TypeError("La ruta del estado no es válida.");
        }

        const previousState = this.getState();

        setNestedValue(this.state, path, clone(value));

        this.notify({
            type: "set",
            path,
            value: clone(value),
            previousState
        });

        this.save();

        return this.get(path);
    }

    update(path, updater) {
        if (typeof updater !== "function") {
            throw new TypeError("Updater debe ser una función.");
        }

        const currentValue = this.get(path);
        const nextValue = updater(currentValue);

        return this.set(path, nextValue);
    }

    merge(path, values) {
        if (
            values === null ||
            typeof values !== "object" ||
            Array.isArray(values)
        ) {
            throw new TypeError("Los valores deben ser un objeto.");
        }

        return this.update(path, (current) => ({
            ...(current || {}),
            ...values
        }));
    }

    subscribe(callback) {
        if (typeof callback !== "function") {
            throw new TypeError("El listener debe ser una función.");
        }

        this.listeners.add(callback);

        return () => {
            this.listeners.delete(callback);
        };
    }

    notify(change) {
        const snapshot = this.getState();

        for (const listener of [...this.listeners]) {
            try {
                listener(change, snapshot);
            } catch (error) {
                console.error(
                    "[Meulify StateManager] Error en listener:",
                    error
                );
            }
        }
    }

    transaction(callback) {
        if (typeof callback !== "function") {
            throw new TypeError("La transacción debe ser una función.");
        }

        const previousState = this.getState();
        const draft = clone(this.state);

        try {
            const result = callback(draft);

            if (result && typeof result.then === "function") {
                throw new Error(
                    "StateManager.transaction no admite callbacks asíncronos."
                );
            }

            this.state = draft;

            this.notify({
                type: "transaction",
                previousState
            });

            this.save();

            return result;
        } catch (error) {
            this.state = previousState;
            throw error;
        }
    }

    save() {
        if (!this.persist || typeof localStorage === "undefined") {
            return false;
        }

        try {
            localStorage.setItem(
                this.storageKey,
                JSON.stringify(this.state)
            );

            return true;
        } catch (error) {
            console.error(
                "[Meulify StateManager] No se pudo guardar:",
                error
            );

            return false;
        }
    }

    load() {
        if (!this.persist || typeof localStorage === "undefined") {
            return false;
        }

        try {
            const stored = localStorage.getItem(this.storageKey);

            if (!stored) return false;

            const parsed = JSON.parse(stored);

            if (
                !parsed ||
                typeof parsed !== "object" ||
                Array.isArray(parsed)
            ) {
                return false;
            }

            this.state = this.mergeInitialState(parsed);

            return true;
        } catch (error) {
            console.error(
                "[Meulify StateManager] No se pudo cargar:",
                error
            );

            return false;
        }
    }

    mergeInitialState(savedState) {
        const initial = this.createInitialState();

        const mergeObjects = (target, source) => {
            for (const key of Object.keys(source)) {
                if (
                    source[key] &&
                    typeof source[key] === "object" &&
                    !Array.isArray(source[key]) &&
                    target[key] &&
                    typeof target[key] === "object" &&
                    !Array.isArray(target[key])
                ) {
                    mergeObjects(target[key], source[key]);
                } else {
                    target[key] = source[key];
                }
            }

            return target;
        };

        return mergeObjects(initial, savedState);
    }

    reset() {
        const previousState = this.getState();

        this.state = this.createInitialState();

        this.notify({
            type: "reset",
            previousState
        });

        this.save();

        return this.getState();
    }

    destroy() {
        this.listeners.clear();
    }
}

export const stateManager = new StateManager();

export default stateManager;