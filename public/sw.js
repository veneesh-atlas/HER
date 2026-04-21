// HER — Service Worker
// Minimal, stable caching for PWA installability and offline shell.

// Cache version — bump on each deployment to invalidate stale assets.
// Uses a timestamp so every build gets a fresh cache automatically.
const CACHE_VERSION = "20260421";
const CACHE_NAME = `her-${CACHE_VERSION}`;

// App shell — the minimum needed for the app to render
const APP_SHELL = [
  "/",
  "/chat",
];

// Install: pre-cache the app shell
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  // Activate immediately instead of waiting
  self.skipWaiting();
});

// Activate: clean up old caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  // Take control of all pages immediately
  self.clients.claim();
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
      // If the app is already open, focus it
      for (const client of clientList) {
        if (client.url.includes("/chat") && "focus" in client) {
          return client.focus();
        }
      }
      // Otherwise open a new window
      return self.clients.openWindow(url);
    })
  );
});

// Fetch: network-first with cache fallback
// This keeps content fresh while providing offline resilience.
self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only handle GET — POSTs (e.g. /api/chat) bypass the cache entirely.
  if (request.method !== "GET") return;

  // Skip API routes — always go to network
  if (request.url.includes("/api/")) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        // Cache successful responses for offline use
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      })
      .catch(() => {
        // Network failed — try cache
        return caches.match(request).then((cached) => {
          if (cached) return cached;
          // If it's a navigation request, serve the cached chat page as fallback
          if (request.mode === "navigate") {
            return caches.match("/chat");
          }
          return new Response("Offline", { status: 503 });
        });
      })
  );
});
