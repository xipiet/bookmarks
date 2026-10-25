// Offline fallback for the start page.
//
// Handles two kinds of requests, everything else (API, logo) goes to the
// network untouched:
// - The page itself (GET /): network first. If the network fails, takes
//   longer than TIMEOUT_MS, or returns something that isn't this app (e.g.
//   Cloudflare's 525 page when the name is resolved publicly, outside the LAN
//   without VPN), the last good copy is served instead.
// - Bookmark icons (GET /favicon?url=…): the cached copy right away while a
//   fresh one is fetched in the background, so the icons are there offline too.
// The bookmark data is not cached here: app.js keeps its own snapshot and
// switches to read-only while the server is out of reach.
//
// Emergency off switch: replace this file with
//   self.addEventListener('install', () => self.skipWaiting());
//   self.addEventListener('activate', (e) => e.waitUntil(caches.keys()
//     .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
//     .then(() => self.registration.unregister())));

const CACHE = 'bookmarks-page-v1';
const ICON_CACHE = 'bookmarks-icons-v1';
const PAGE = '/';
const TIMEOUT_MS = 3000;

// Worth caching / serving: a 2xx that this app actually produced.
const fromApp = (r) => !!r && r.ok && r.headers.get('X-Bookmarks-App') === '1';

async function remember(response) {
    if (fromApp(response)) await (await caches.open(CACHE)).put(PAGE, response.clone());
    return response;
}

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        // The first visit happened before this worker existed, so fetch the
        // page once now. If that fails the cache stays empty until the next
        // successful visit; installing must not fail because of it.
        try {
            await remember(await fetch(PAGE, { cache: 'no-store' }));
        } catch {}
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        for (const key of await caches.keys()) {
            if (key !== CACHE && key !== ICON_CACHE) await caches.delete(key);
        }
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    const url = new URL(req.url);
    if (req.method !== 'GET' || url.origin !== self.location.origin) return;
    if (url.pathname === '/favicon') handleIcon(event);
    else if (url.pathname === PAGE && req.mode === 'navigate') handlePage(event);
});

function handlePage(event) {
    const network = fetch(event.request).then(remember);
    // Let the cache update finish even if the cached copy was served first.
    event.waitUntil(network.catch(() => {}));

    event.respondWith((async () => {
        const timeout = new Promise((resolve) => setTimeout(resolve, TIMEOUT_MS, null));
        try {
            const response = await Promise.race([network, timeout]);
            if (fromApp(response)) return response;
        } catch {}
        const cached = await caches.match(PAGE, { cacheName: CACHE });
        if (cached) return cached;
        // Nothing cached yet: pass on whatever the network delivers.
        try {
            return await network;
        } catch {
            return Response.error();
        }
    })());
}

function handleIcon(event) {
    const req = event.request;
    const network = fetch(req).then(async (response) => {
        if (fromApp(response)) await (await caches.open(ICON_CACHE)).put(req, response.clone());
        return response;
    });
    event.waitUntil(network.catch(() => {}));
    event.respondWith((async () => {
        const cached = await caches.match(req, { cacheName: ICON_CACHE });
        return cached || network;
    })());
}
