const CACHE_NAME = "worm-static-__BUILD_ID__";
const FAVOURITES_DATABASE = "worm-local-preferences";
const FAVOURITES_DATABASE_VERSION = 1;
const FAVOURITES_STORE = "followedPlayers";

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll([
        "./static/images/worm.png",
        "./static/images/worm-192.png",
        "./static/images/worm-512.png",
      ])
    ).catch(() => {})
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).catch(() => caches.match("./index.html"))
    );
    return;
  }

  const isStatic =
    url.pathname.includes("/static/images/") ||
    url.pathname.includes("/static/vendor/");

  if (!isStatic) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetchAndUpdate = fetch(event.request).then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return resp;
      });
      return cached || fetchAndUpdate;
    })
  );
});

self.addEventListener("message", (event) => {
  const prefix = "worm:favourites:";
  const type = event.data?.type;
  if (typeof type !== "string" || !type.startsWith(prefix)) return;
  const action = type.slice(prefix.length);
  if (!["list", "put", "delete", "clear"].includes(action)) return;
  const responsePort = event.ports?.[0];
  const databaseRequest = indexedDB.open(FAVOURITES_DATABASE, FAVOURITES_DATABASE_VERSION);
  event.waitUntil(
    new Promise((resolve, reject) => {
      databaseRequest.onupgradeneeded = () => {
        const database = databaseRequest.result;
        if (!database.objectStoreNames.contains(FAVOURITES_STORE)) {
          database.createObjectStore(FAVOURITES_STORE, { keyPath: "id" });
        }
      };
      databaseRequest.onsuccess = () => resolve(databaseRequest.result);
      databaseRequest.onerror = () => reject(databaseRequest.error);
    })
      .then((database) => new Promise((resolve, reject) => {
        const transaction = database.transaction(
          FAVOURITES_STORE,
          action === "list" ? "readonly" : "readwrite"
        );
        const store = transaction.objectStore(FAVOURITES_STORE);
        const player = event.data?.player;
        const request = action === "list"
          ? store.getAll()
          : action === "put"
            ? store.put(player)
            : action === "delete"
              ? store.delete(player.id)
              : store.clear();
        request.onsuccess = () => resolve(action === "list" ? request.result : player);
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => database.close();
        transaction.onerror = () => database.close();
      }))
      .then((result) => responsePort?.postMessage({ ok: true, result }))
      .catch((error) => responsePort?.postMessage({ ok: false, error: String(error) }))
  );
});
