/**
 * HER — Web Push Notification Support
 *
 * Handles sending push notifications via the Web Push API.
 * Uses VAPID keys from environment variables.
 *
 * Setup:
 *   1. npm install web-push
 *   2. Generate VAPID keys: npx web-push generate-vapid-keys
 *   3. Add to .env.local:
 *      NEXT_PUBLIC_VAPID_PUBLIC_KEY=...
 *      VAPID_PRIVATE_KEY=...
 *      VAPID_SUBJECT=mailto:your@email.com
 */

// ── Types ──────────────────────────────────────────────────

export interface PushPayload {
  title: string;
  body: string;
  data?: {
    conversationId?: string | null;
    url?: string;
  };
}

// ── Send Push ──────────────────────────────────────────────

/**
 * Send a push notification to a subscriber.
 * Uses the Web Push protocol (VAPID).
 * Gracefully fails — push is best-effort.
 * If web-push is not installed, silently skips.
 */
export async function sendPushNotification(
  subscription: PushSubscriptionJSON,
  payload: PushPayload
): Promise<boolean> {
  const vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
  const vapidSubject = process.env.VAPID_SUBJECT || "mailto:her@example.com";

  if (!vapidPublicKey || !vapidPrivateKey) {
    console.warn("[HER Push] Missing VAPID keys — skipping push");
    return false;
  }

  if (!subscription.endpoint) {
    console.warn("[HER Push] Invalid subscription — no endpoint");
    return false;
  }

  try {
    // Dynamic import — gracefully fails if web-push isn't installed
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const webPush = require("web-push") as {
      setVapidDetails: (subject: string, publicKey: string, privateKey: string) => void;
      sendNotification: (sub: unknown, payload: string, options?: { TTL?: number }) => Promise<unknown>;
    };

    webPush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);

    await webPush.sendNotification(
      subscription,
      JSON.stringify(payload),
      { TTL: 60 * 60 }
    );

    return true;
  } catch (err: unknown) {
    const error = err as { statusCode?: number; code?: string; body?: string };
    if (error.code === "MODULE_NOT_FOUND") {
      console.warn("[HER Push] web-push not installed — skipping. Run: npm install web-push");
      return false;
    }
    console.error("[HER Push] sendNotification failed", {
      statusCode: error.statusCode,
      code: error.code,
      body: error.body,
      endpoint: subscription.endpoint?.slice(0, 60),
      expired: error.statusCode === 410,
    });
    return false;
  }
}
