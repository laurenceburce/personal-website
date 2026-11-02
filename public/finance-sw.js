/* Finance deliberately caches no account pages, API responses, or personal data. */
const ICON_CACHE = "personal-finance-icons-v1";
const ICON_PATHS = ["/finance-icon.svg", "/finance-icon-192.png", "/finance-icon-512.png", "/finance-apple-touch.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(ICON_CACHE).then((cache) => cache.addAll(ICON_PATHS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(names
      .filter((name) => name.startsWith("personal-finance-icons-") && name !== ICON_CACHE)
      .map((name) => caches.delete(name))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  if (ICON_PATHS.includes(url.pathname)) {
    event.respondWith(caches.open(ICON_CACHE).then(async (cache) => (await cache.match(request)) || fetch(request)));
    return;
  }

  if (request.mode !== "navigate" || !(url.pathname === "/finance" || url.pathname.startsWith("/finance/"))) return;

  event.respondWith(fetch(request, { cache: "no-store" }).catch(() => new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#16765b"><title>Personal Finance · Offline</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f7f8fa;color:#22362e;font:16px/1.6 system-ui,sans-serif}main{max-width:360px;padding:36px}img{width:64px;height:64px;border-radius:16px}h1{font-size:26px;margin:20px 0 8px}p{color:#65746d}a{display:inline-block;padding:10px 18px;margin-top:12px;border-radius:10px;background:#16765b;color:white;text-decoration:none}</style><main><img src="/finance-icon.svg" alt=""><h1>You're offline</h1><p>Connect to the internet to open your private finance planner and save changes.</p><a href="/finance">Try again</a></main></html>`,
    { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
  )));
});
