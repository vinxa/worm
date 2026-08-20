const DATABASE_NAME = "worm-local-preferences";
const DATABASE_VERSION = 1;
const STORE_NAME = "followedPlayers";
const MESSAGE_PREFIX = "worm:favourites:";

function withStorage(name, operation, fallback, onError) {
    try {
        return operation(globalThis[name]);
    } catch {
        onError?.();
        return fallback;
    }
}

export const withLocalStorage = (operation, fallback, onError) =>
    withStorage("localStorage", operation, fallback, onError);

export const withSessionStorage = (operation, fallback = null, onError) =>
    withStorage("sessionStorage", operation, fallback, onError);

async function request(action, player) {
    const worker = navigator.serviceWorker?.controller;
    if (worker && typeof MessageChannel !== "undefined") {
        const response = await new Promise((resolve) => {
            const channel = new MessageChannel();
            const timeout = window.setTimeout(() => resolve(null), 1500);
            channel.port1.onmessage = (event) => {
                window.clearTimeout(timeout);
                resolve(event.data?.ok ? event.data : null);
            };
            worker.postMessage({ type: `${MESSAGE_PREFIX}${action}`, player }, [channel.port2]);
        });
        if (response?.ok) return response.result;
    }

    const database = await new Promise((resolve, reject) => {
        const openRequest = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
        openRequest.onupgradeneeded = () => {
            const openedDatabase = openRequest.result;
            if (!openedDatabase.objectStoreNames.contains(STORE_NAME)) {
                openedDatabase.createObjectStore(STORE_NAME, { keyPath: "id" });
            }
        };
        openRequest.onsuccess = () => resolve(openRequest.result);
        openRequest.onerror = () => reject(openRequest.error);
    });
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(
            STORE_NAME,
            action === "list" ? "readonly" : "readwrite",
        );
        const store = transaction.objectStore(STORE_NAME);
        const dataRequest = action === "list"
            ? store.getAll()
            : action === "put"
                ? store.put(player)
                : action === "delete"
                    ? store.delete(player.id)
                    : store.clear();
        dataRequest.onsuccess = () => resolve(action === "list" ? dataRequest.result : player);
        dataRequest.onerror = () => reject(dataRequest.error);
        transaction.oncomplete = () => database.close();
        transaction.onerror = () => database.close();
    });
}

export async function loadFollowedPlayers() {
    const players = await request("list");
    return Array.isArray(players) ? players : [];
}

export function saveFollowedPlayer(player) {
    return request("put", player);
}

export function removeFollowedPlayer(player) {
    return request("delete", player);
}

export function clearFollowedPlayers() {
    return request("clear");
}
