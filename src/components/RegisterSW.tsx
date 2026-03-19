"use client";

import { useEffect } from "react";

/**
 * RegisterSW — Registers the service worker for PWA installability.
 * Runs once on mount (client-only). Silent — no UI.
 */
export default function RegisterSW() {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .register("/sw.js")
        .catch(() => {
          // Service worker registration failed — non-critical, ignore silently
        });
    }
  }, []);

  return null;
}
