// Offline service worker.
//
// This is what makes the air-gap claim true on a PHONE rather than only on a
// laptop. A phone cannot serve itself over localhost, and opening the HTML
// from Files gives a file:// origin — which is not a secure context, so
// getUserMedia does not exist there and the camera is simply absent. Install
// the page once over https and everything below is cached; after that the
// device never needs a network again and the origin stays secure, so the
// camera keeps working.
//
// Cache-first, deliberately. For an offline transfer tool a deterministic
// known-good copy beats a fresher one: an update should be an explicit act
// (bump VERSION), never something that happens mid-transfer.

const VERSION = "decimen-v1";

// The shell. Everything else — hashed JS/CSS chunks, and the ~940 KB zxing
// WASM the receiver lazy-loads — is cached on first use by the fetch handler.
// The WASM is the one that matters: a receiver that has never been started
// has not downloaded its decoder yet, so "install, then run the receiver
// once" is the real readiness condition.
const SHELL = [
  "./",
  "./index.html",
  "./send/",
  "./receive/",
  "./bench/",
  "./kaleido/",
  "./manifest.webmanifest",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(VERSION)
      // addAll is atomic — one 404 would reject the whole install and leave
      // no cache at all, so add individually and tolerate misses.
      .then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => undefined))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.match(req, { ignoreSearch: false }).then((hit) => {
      if (hit) return hit;
      return fetch(req)
        .then((res) => {
          // Only cache real successes. Opaque and error responses would
          // poison the cache with something that fails silently later.
          if (res.ok && res.type === "basic") {
            const copy = res.clone();
            void caches.open(VERSION).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(async () => {
          // Offline and uncached. For a navigation, fall back to the shell so
          // the app opens instead of showing a browser error page.
          if (req.mode === "navigate") {
            const shell = await caches.match("./index.html");
            if (shell) return shell;
          }
          return new Response("offline and not cached", {
            status: 504,
            headers: { "content-type": "text/plain" },
          });
        });
    }),
  );
});
