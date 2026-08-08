// Registers the offline service worker.
//
// `root` is how far up the app root sits from the calling page — "./" from
// the landing page, "../" from /send/, /receive/ and friends. It matters
// because the worker's SCOPE is derived from where the worker file lives: a
// worker registered at /send/sw.js could only ever control /send/, and the
// file is at the app root anyway. Vite builds with base "./" so the app can
// be served from any subpath, which rules out absolute URLs here.
export function registerOfflineWorker(root = "./"): void {
  // Never in dev: a cache-first worker would serve yesterday's bundle and
  // make every change look like it did nothing.
  const env = (import.meta as unknown as { env?: { PROD?: boolean } }).env;
  if (env?.PROD !== true) return;
  if (!("serviceWorker" in navigator)) return;
  // Best-effort. An unsupported or blocked worker must not stop the app
  // loading — everything works online without it.
  window.addEventListener("load", () => {
    const sw = new URL(`${root}sw.js`, document.baseURI);
    const scope = new URL(root, document.baseURI);
    void navigator.serviceWorker.register(sw, { scope: scope.href }).catch(() => undefined);
  });
}
