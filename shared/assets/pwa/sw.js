// IRLCTRL service worker — served at the origin root (/sw.js, scope "/") by
// shared/pwa.ts so it can control the whole UI (control server and device).
//
// Strategy:
//  - /assets/* (hashed bundles, incl. the manifest) and the icons:
//    network-first. The server rebuilds the bundle on every start, so a
//    stale copy in Cache Storage must never shadow the new one; the cache
//    is only an offline fallback.
//  - page navigations: network-first; the last good copy of each page is kept
//    so the installed app still opens its shell offline.
//  - everything else (the device/dashboard APIs, i18n catalogs, the device
//    page websockets) is never intercepted and never cached.
// Bump on every sw change so activate() drops the previous cache, including
// its now-orphaned /assets/* chunks.
const CACHE = "irlctrl-shell-v2";
const PRECACHE = ["/icons/icon-192.png", "/icons/icon-512.png"];

const isLive = (url) =>
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/chat/") ||
    url.pathname.startsWith("/i18n/") ||
    url.pathname === "/device" ||
    url.pathname === "/healthz" ||
    url.pathname.endsWith("/ws");

self.addEventListener("install", (e) => {
    e.waitUntil(
        caches
            .open(CACHE)
            .then((c) => c.addAll(PRECACHE))
            .then(() => self.skipWaiting()),
    );
});

self.addEventListener("activate", (e) => {
    e.waitUntil(
        caches
            .keys()
            .then((keys) =>
                Promise.all(
                    keys
                        .filter((k) => k !== CACHE)
                        .map((k) => caches.delete(k)),
                ),
            )
            .then(() => self.clients.claim()),
    );
});

self.addEventListener("fetch", (e) => {
    const { request } = e;
    if (request.method !== "GET") return;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin || isLive(url)) return;

    if (url.pathname.startsWith("/assets/")) {
        // Network-first: a rebuild changes the chunk hashes, so the cache is
        // only consulted when the network fails (offline). Old chunks are
        // evicted on activate, which also caps the cache's growth.
        e.respondWith(
            fetch(request)
                .then((res) => {
                    if (res.ok) {
                        const copy = res.clone();
                        caches
                            .open(CACHE)
                            .then((c) => c.put(request, copy));
                    }
                    return res;
                })
                .catch(() => caches.match(request).then((hit) => hit || Response.error())),
        );
        return;
    }

    if (request.mode === "navigate") {
        e.respondWith(
            fetch(request)
                .then((res) => {
                    // Only a final 200 page is a shell worth keeping (a redirect to
                    // /login or an error page is not).
                    if (res.ok && !res.redirected) {
                        const copy = res.clone();
                        caches.open(CACHE).then((c) => c.put(request, copy));
                    }
                    return res;
                })
                .catch(() =>
                    caches
                        .match(request)
                        .then((hit) => hit || Response.error()),
                ),
        );
        return;
    }

    if (PRECACHE.includes(url.pathname)) {
        e.respondWith(
            caches.match(request).then((hit) => hit || fetch(request)),
        );
    }
});
