
const DB_NAME = "MeulifyDB";
const DB_VERSION = 1;

const STORES = {
    songs: "songs",
    playlists: "playlists",
    favorites: "favorites",
    history: "history",
    settings: "settings"
};

export class DBManager {
    constructor() {
        this.db = null;
        this.opening = null;
    }

    async init() {
        if (this.db) return this.db;
        if (this.opening) return this.opening;

        if (!("indexedDB" in window)) {
            throw new Error("IndexedDB no está disponible en este navegador.");
        }

        this.opening = new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                if (!db.objectStoreNames.contains(STORES.songs)) {
                    const store = db.createObjectStore(STORES.songs, {
                        keyPath: "id"
                    });
                    store.createIndex("source", "source", { unique: false });
                    store.createIndex("title", "title", { unique: false });
                }

                if (!db.objectStoreNames.contains(STORES.playlists)) {
                    db.createObjectStore(STORES.playlists, {
                        keyPath: "id"
                    });
                }

                if (!db.objectStoreNames.contains(STORES.favorites)) {
                    db.createObjectStore(STORES.favorites, {
                        keyPath: "id"
                    });
                }

                if (!db.objectStoreNames.contains(STORES.history)) {
                    const store = db.createObjectStore(STORES.history, {
                        keyPath: "id"
                    });
                    store.createIndex("playedAt", "playedAt", {
                        unique: false
                    });
                }

                if (!db.objectStoreNames.contains(STORES.settings)) {
                    db.createObjectStore(STORES.settings, {
                        keyPath: "key"
                    });
                }
            };

            request.onsuccess = () => {
                this.db = request.result;

                this.db.onversionchange = () => {
                    this.db.close();
                    this.db = null;
                };

                resolve(this.db);
            };

            request.onerror = () => {
                reject(request.error || new Error("No se pudo abrir IndexedDB."));
            };

            request.onblocked = () => {
                reject(new Error("La base de datos está bloqueada por otra pestaña."));
            };
        });

        try {
            return await this.opening;
        } finally {
            this.opening = null;
        }
    }

    async getStore(storeName, mode = "readonly") {
        await this.init();

        if (!Object.values(STORES).includes(storeName)) {
            throw new Error(`Almacén desconocido: ${storeName}`);
        }

        const transaction = this.db.transaction(storeName, mode);
        return {
            transaction,
            store: transaction.objectStore(storeName)
        };
    }

    async request(storeName, mode, operation) {
        const { transaction, store } = await this.getStore(storeName, mode);

        return new Promise((resolve, reject) => {
            let result;
            let request;

            try {
                request = operation(store, transaction);
            } catch (error) {
                reject(error);
                return;
            }

            if (request) {
                request.onsuccess = () => {
                    result = request.result;
                };
                request.onerror = () => reject(request.error);
            }

            transaction.oncomplete = () => resolve(result);
            transaction.onerror = () => {
                reject(transaction.error || new Error("Error en la transacción."));
            };
            transaction.onabort = () => {
                reject(transaction.error || new Error("Transacción cancelada."));
            };
        });
    }

    put(storeName, value) {
        return this.request(storeName, "readwrite", store => store.put(value));
    }

    add(storeName, value) {
        return this.request(storeName, "readwrite", store => store.add(value));
    }

    get(storeName, id) {
        return this.request(storeName, "readonly", store => store.get(id));
    }

    getAll(storeName) {
        return this.request(storeName, "readonly", store => store.getAll());
    }

    delete(storeName, id) {
        return this.request(storeName, "readwrite", store => store.delete(id));
    }

    clear(storeName) {
        return this.request(storeName, "readwrite", store => store.clear());
    }

    count(storeName) {
        return this.request(storeName, "readonly", store => store.count());
    }

    async getAllByIndex(storeName, indexName, value) {
        return this.request(storeName, "readonly", store => {
            return store.index(indexName).getAll(value);
        });
    }

    async exportAll() {
        const data = {};

        for (const name of Object.values(STORES)) {
            data[name] = await this.getAll(name);
        }

        return {
            database: DB_NAME,
            version: DB_VERSION,
            exportedAt: new Date().toISOString(),
            data
        };
    }

    async clearAll() {
        for (const name of Object.values(STORES)) {
            await this.clear(name);
        }
    }

    close() {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }
}

export const dbManager = new DBManager();
export default dbManager;
