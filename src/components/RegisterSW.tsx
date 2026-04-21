"use client";

import { useEffect } from "react";

/**
 * RegisterSW — Registers the service worker for PWA installability.
 *
 * Also actively checks for updates on mount and forces a one-time
 * reload when a fresh SW takes control. This rescues users stuck on
 * a stale cached shell after a broken deploy.
 */
export default function RegisterSW() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => {
        // Poll for an updated SW on every mount
        reg.update().catch(() => {});
      })
      .catch(() => {
        // Registration failed — non-critical, ignore silently
      });

    // When a new SW takes control, reload once so the page picks up fresh assets.
    let reloaded = false;
    const onControllerChange = () => {
      if (reloaded) return;
      reloaded = true;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    return () => {
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);

  return null;
}
