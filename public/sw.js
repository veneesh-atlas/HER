// HER — Service Worker
// Strategy: never cache HTML or Next chunks. Cache only static assets
// (icons, images, fonts) on use. This makes deploys instantly take effect
// and prevents the "page couldn't load" failure caused by stale HTML
// referencing old build hashes.

const CACHE_VERSION = "20260421-3";
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
// - Navigation (HTML)         → DO NOT INTERCEPT. Let the browser handle it natively.
//                                Intercepting can break Supabase auth redirects and
//                                produce "page couldn't load" errors on mobile PWAs.
// - Next.js build assets      → DO NOT INTERCEPT. Browser handles + caches naturally.
// - API routes                → DO NOT INTERCEPT.
// - Static assets (icons etc) → cache-first with background update.
self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Same-origin only.
  if (url.origin !== self.location.origin) return;

  // Navigation, _next chunks, API → pass through to browser, no interception.
  if (
    request.mode === "navigate" ||
    url.pathname.startsWith("/_next/") ||
    url.pathname.startsWith("/api/")
  ) {
    return;
  }

  // Static assets only (icons, manifest, favicons) → cache-first.
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
