// HER — Service Worker
// Minimal, stable caching for PWA installability and offline shell.

const CACHE_NAME = "her-v1";

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

// Fetch: network-first with cache fallback
// This keeps content fresh while providing offline resilience.
self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Skip non-GET requests (POST to /api/chat, etc.)
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
