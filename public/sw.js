// HER — Service Worker
// Strategy: never cache HTML or Next chunks. Cache only static assets
// (icons, images, fonts) on use. This makes deploys instantly take effect
// and prevents the "page couldn't load" failure caused by stale HTML
// referencing old build hashes.

const CACHE_VERSION = "20260421-11";
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

// Notification click: open or focus the correct conversation.
// If the notification carries a conversationId, the URL becomes /chat?c=<id>
// so the chat page can switch to that conversation on load. If the app is
// already open, we postMessage the id so the page can switch in-place
// without a navigation.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const data = event.notification.data || {};
  const convoId = data.conversationId || null;
  const targetUrl = convoId ? `/chat?c=${encodeURIComponent(convoId)}` : (data.url || "/chat");

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes("/chat") && "focus" in client) {
          // Tell the live page to switch — no full reload needed.
          if (convoId) {
            client.postMessage({ type: "her:open-conversation", conversationId: convoId });
          }
          return client.focus();
        }
      }
      return self.clients.openWindow(targetUrl);
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
