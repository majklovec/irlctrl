// IRLCTRL service worker — served at the origin root (/sw.js, scope "/") by
// shared/pwa.ts so it can control the whole UI (control server and device).
//
// Strategy:
//  - /assets/* (hashed bundles, incl. the manifest) and the icons: cache-first.
//  - page navigations: network-first; the last good copy of each page is kept
//    so the installed app still opens its shell offline.
//  - everything else (the device/dashboard APIs, i18n catalogs, the device
//    page websockets) is never intercepted and never cached.
const CACHE = "irlctrl-shell-v1";
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
        e.respondWith(
            caches.match(request).then(
                (hit) =>
                    hit ||
                    fetch(request).then((res) => {
                        if (res.ok) {
                            const copy = res.clone();
                            caches
                                .open(CACHE)
                                .then((c) => c.put(request, copy));
                        }
                        return res;
                    }),
            ),
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
