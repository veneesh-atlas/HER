// HER — Service Worker
// Strategy: never cache HTML or Next chunks. Cache only static assets
// (icons, images, fonts) on use. This makes deploys instantly take effect
// and prevents the "page couldn't load" failure caused by stale HTML
// referencing old build hashes.

const CACHE_VERSION = "20260421-2";
const CACHE_NAME = `her-static-${CACHE_VERSION}`;

// Install: take over immediately, no pre-caching of pages.
self.addEventListener("install", () => {
  self.skipWaiting();
});

// Activate: nuke ALL old caches (any name, any version) and claim clients.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

// Push notifications: display notification when received from server
self.addEventListener("push", (event) => {
  if (!event.data) return;

  try {
    const payload = event.data.json();
    const title = payload.title || "HER";
    const options = {
      body: payload.body || "",
      icon: "/icons/icon-192x192.png",
      badge: "/icons/icon-72x72.png",
      tag: "her-notification",
      renotify: true,
      data: payload.data || {},
    };

    event.waitUntil(self.registration.showNotification(title, options));
  } catch (err) {
    console.warn("[HER SW] Push parse error:", err);
  }
});

// Notification click: open or focus the chat page
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const url = event.notification.data?.url || "/chat";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes("/chat") && "focus" in client) {
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});

// Fetch strategy:
// - Navigation (HTML)         → network only. Never cache. Inline offline page on failure.
// - Next.js build assets      → network only. Stale chunks = broken hydration.
// - API routes                → network only.
// - Static assets (icons etc) → cache-first with background update.
self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Same-origin only — leave cross-origin (CDN, fonts) to the browser.
  if (url.origin !== self.location.origin) return;

  // Navigation requests → network only with offline fallback page.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(
        () =>
          new Response(
            `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HER — Offline</title><style>body{font-family:system-ui;background:#F7F2EA;color:#3a2f2a;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;padding:24px;text-align:center}h1{color:#C96E5A;margin:0 0 8px;font-weight:500}p{margin:0;opacity:.7}</style></head><body><div><h1>you're offline</h1><p>i'll be here when you're back.</p></div></body></html>`,
            { headers: { "Content-Type": "text/html; charset=utf-8" }, status: 200 }
          )
      )
    );
    return;
  }

  // Next.js build chunks + API → network only, no cache.
  if (url.pathname.startsWith("/_next/") || url.pathname.startsWith("/api/")) {
    return; // let the browser handle it
  }

  // Static assets (icons, manifest, etc.) → cache-first.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      });
    })
  );
});
