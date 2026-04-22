/**
 * HER — Notification Settings
 *
 * User preferences for the notification & continuity system:
 *   - Enable/disable notifications
 *   - Quiet hours (e.g. 1AM–5AM)
 *   - Timezone awareness
 *   - Push subscription management
 */

import { getSupabaseClient } from "./supabase-client";

// ── Types ──────────────────────────────────────────────────

export interface NotificationSettings {
  notifications_enabled: boolean;
  quiet_hours_start: string; // "HH:MM"
  quiet_hours_end: string;   // "HH:MM"
  timezone: string;          // IANA timezone e.g. "Asia/Kolkata"
  push_subscription: PushSubscriptionJSON | null;
}

const DEFAULT_SETTINGS: NotificationSettings = {
  notifications_enabled: true,
  quiet_hours_start: "01:00",
  quiet_hours_end: "05:00",
  timezone: "UTC",
  push_subscription: null,
};

// ── CRUD ───────────────────────────────────────────────────

/**
 * Get notification settings for a user. Returns defaults if none saved.
 */
export async function getNotificationSettings(
  userId: string
): Promise<NotificationSettings> {
  const client = getSupabaseClient();
  if (!client) return { ...DEFAULT_SETTINGS };

  try {
    const { data, error } = await client
      .from("notification_settings")
      .select("*")
      .eq("user_id", userId)
      .single();

    if (error || !data) return { ...DEFAULT_SETTINGS };

    return {
      notifications_enabled: data.notifications_enabled ?? true,
      quiet_hours_start: data.quiet_hours_start ?? "01:00",
      quiet_hours_end: data.quiet_hours_end ?? "05:00",
      timezone: data.timezone ?? "UTC",
      push_subscription: data.push_subscription ?? null,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Upsert notification settings for a user.
 */
export async function saveNotificationSettings(
  userId: string,
  settings: Partial<NotificationSettings>
): Promise<boolean> {
  const client = getSupabaseClient();
  if (!client) return false;

  try {
    const { error } = await client
      .from("notification_settings")
      .upsert(
        {
          user_id: userId,
          ...settings,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" }
      );

    if (error) {
      console.warn("[HER Notify] Save settings failed:", error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn("[HER Notify] Save settings exception:", err);
    return false;
  }
}

/**
 * Save the Web Push subscription for a user.
 */
export async function savePushSubscription(
  userId: string,
  subscription: PushSubscriptionJSON
): Promise<boolean> {
  return saveNotificationSettings(userId, { push_subscription: subscription });
}

// ── Quiet Hours ────────────────────────────────────────────

/**
 * Event types that are USER-OWNED (explicitly requested) and must never
 * be suppressed by quiet hours or cooldowns. The user asked for these at
 * a specific time — silently delaying them is a bug, not a courtesy.
 */
const HIGH_PRIORITY_TYPES = new Set(["reminder", "promise"]);

/**
 * Returns true if the event is user-owned (high priority) and therefore
 * MUST bypass quiet hours and cooldown gates.
 */
export function isHighPriorityEvent(type: string): boolean {
  return HIGH_PRIORITY_TYPES.has(type);
}

/**
 * Check if the current time is within quiet hours for a user.
 * Returns true if notifications should be delayed.
 *
 * Short-circuits to `false` when the user has no real timezone set
 * (default "UTC" placeholder). Otherwise an IST user would silently
 * fall into the 01:00–05:00 UTC window every morning.
 */
export function isQuietHours(settings: NotificationSettings): boolean {
  // No real user TZ → don't apply quiet hours at all. Better to occasionally
  // over-deliver than to silently swallow a reminder for the user's morning.
  if (!settings.timezone || settings.timezone === "UTC") {
    return false;
  }

  const now = getCurrentTimeInTimezone(settings.timezone);
  const currentMinutes = now.hours * 60 + now.minutes;

  const [startH, startM] = settings.quiet_hours_start.split(":").map(Number);
  const [endH, endM] = settings.quiet_hours_end.split(":").map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  // Handle overnight quiet hours (e.g. 23:00 to 06:00)
  if (startMinutes > endMinutes) {
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }

  return currentMinutes >= startMinutes && currentMinutes < endMinutes;
}

/**
 * Get the next available notification time after quiet hours end.
 */
export function getNextAvailableTime(settings: NotificationSettings): Date {
  const [endH, endM] = settings.quiet_hours_end.split(":").map(Number);

  // Create a date in the user's timezone at the quiet hours end
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: settings.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(now);
  const year = parts.find((p) => p.type === "year")!.value;
  const month = parts.find((p) => p.type === "month")!.value;
  const day = parts.find((p) => p.type === "day")!.value;

  // Build a date string in the user's timezone and convert back to UTC
  const localStr = `${year}-${month}-${day}T${String(endH).padStart(2, "0")}:${String(endM).padStart(2, "0")}:00`;
  const targetLocal = new Date(localStr);

  // If that time already passed today, use tomorrow
  if (targetLocal <= now) {
    targetLocal.setDate(targetLocal.getDate() + 1);
  }

  return targetLocal;
}

// ── Timezone Helpers ───────────────────────────────────────

function getCurrentTimeInTimezone(timezone: string): { hours: number; minutes: number } {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    });
    const parts = formatter.formatToParts(new Date());
    const hours = parseInt(parts.find((p) => p.type === "hour")!.value, 10);
    const minutes = parseInt(parts.find((p) => p.type === "minute")!.value, 10);
    return { hours, minutes };
  } catch {
    // Fallback to UTC
    const now = new Date();
    return { hours: now.getUTCHours(), minutes: now.getUTCMinutes() };
  }
}

/**
 * Detect the user's timezone from their browser.
 * Call this client-side and send to the settings API.
 */
export function detectUserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}
