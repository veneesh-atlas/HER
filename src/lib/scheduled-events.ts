/**
 * HER — Scheduled Events Persistence
 *
 * Manages the scheduled_events table in Supabase for:
 *   - Reminders (tasks the user needs to do)
 *   - Follow-ups (events to check on)
 *   - Nudges (re-engagement when user is absent)
 *
 * All operations are fire-and-forget: failures are logged
 * but never block the chat UI.
 */

import { getSupabaseClient, isSupabaseConfigured } from "./supabase-client";
import type { TemporalIntent } from "./temporal";

// ── Types ──────────────────────────────────────────────────

export type ScheduledEventType = "reminder" | "followup" | "nudge" | "promise";
export type ScheduledEventStatus = "pending" | "sent" | "cancelled";

export interface ScheduledEvent {
  id: string;
  user_id: string;
  conversation_id: string | null;
  type: ScheduledEventType;
  trigger_at: string; // ISO timestamp
  context: {
    summary: string;
    emotionalWeight: "low" | "medium" | "high";
    category: "event" | "task" | "plan" | "nudge" | "promise";
    /** Original user message that triggered this (for HER's reference) */
    originalMessage?: string;
    /** Promise-only: short semantic description of what HER agreed to do/say */
    promiseIntent?: string;
    /** Promise-only: the user's original ask (for delivery context) */
    userRequest?: string;
    /** Promise-only: HER's confirming reply text (for voice continuity) */
    agentReply?: string;
  };
  status: ScheduledEventStatus;
  created_at: string;
}

// ── Timing Variance (Part B — Humanized Timing) ───────────

/**
 * Apply natural delivery variance so notifications never fire
 * exactly on the minute. Makes HER feel human, not robotic.
 */
function applyTimingVariance(triggerAt: string, type: string): string {
  const trigger = new Date(triggerAt);
  let offsetMs: number;

  switch (type) {
    case "followup":
      // 2–10 minutes AFTER the event
      offsetMs = (2 + Math.random() * 8) * 60 * 1000;
      break;
    case "reminder": {
      // 5–15 minutes BEFORE the event (if at least 20 min away)
      const msUntilTrigger = trigger.getTime() - Date.now();
      if (msUntilTrigger > 20 * 60 * 1000) {
        offsetMs = -(5 + Math.random() * 10) * 60 * 1000;
      } else {
        // Too close — add 2–5 minutes instead
        offsetMs = (2 + Math.random() * 3) * 60 * 1000;
      }
      break;
    }
    case "nudge":
      // ±30 minutes random within safe window
      offsetMs = (Math.random() - 0.5) * 60 * 60 * 1000;
      break;
    case "promise":
      // Promises must land close to the asked time. The 5-min cron already
      // adds 0–5 min slack, so we keep the offset at zero (jitter only).
      offsetMs = 0;
      break;
    default:
      offsetMs = (1 + Math.random() * 4) * 60 * 1000;
  }

  // Never fire exactly on a minute boundary — add 10–50 second jitter
  const jitterMs = (10 + Math.random() * 40) * 1000;

  return new Date(trigger.getTime() + offsetMs + jitterMs).toISOString();
}

// ── Create ─────────────────────────────────────────────────

/**
 * Insert a scheduled event from a detected temporal intent.
 * Returns the event ID or null on failure.
 */
export async function createScheduledEvent(params: {
  userId: string;
  conversationId: string | null;
  intent: TemporalIntent;
  originalMessage: string;
  /** Apply humanized timing variance (default: false) */
  applyVariance?: boolean;
}): Promise<string | null> {
  const client = getSupabaseClient();
  if (!client) return null;

  // If no trigger time, skip — we can't schedule without a when
  if (!params.intent.triggerAt) {
    console.warn("[HER Events] No triggerAt — skipping event creation");
    return null;
  }

  const finalTriggerAt = params.applyVariance
    ? applyTimingVariance(params.intent.triggerAt, params.intent.type)
    : params.intent.triggerAt;

  try {
    const { data, error } = await client
      .from("scheduled_events")
      .insert({
        user_id: params.userId,
        conversation_id: params.conversationId,
        type: params.intent.type,
        trigger_at: finalTriggerAt,
        context: {
          ...params.intent.context,
          originalMessage: params.originalMessage.slice(0, 500),
          source: params.intent.type, // Context tag for continuity (Part F)
        },
        status: "pending" as ScheduledEventStatus,
      })
      .select("id")
      .single();

    if (error) {
      console.warn("[HER Events] Create failed:", error.message);
      return null;
    }

    console.log("[HER Events] Created:", data.id, params.intent.context.summary,
      params.applyVariance ? `(variance applied: ${finalTriggerAt})` : "");

    // ── Pre-emptive reminder for high-weight events (Part I) ──
    if (
      params.intent.context.emotionalWeight === "high" &&
      params.intent.type === "followup"
    ) {
      const triggerDate = new Date(params.intent.triggerAt);
      const msUntil = triggerDate.getTime() - Date.now();

      // If event is > 2 hours away, schedule a soft pre-reminder 30–60 min before
      if (msUntil > 2 * 60 * 60 * 1000) {
        const preReminderAt = new Date(
          triggerDate.getTime() - (30 + Math.random() * 30) * 60 * 1000
        ).toISOString();

        await client
          .from("scheduled_events")
          .insert({
            user_id: params.userId,
            conversation_id: params.conversationId,
            type: "reminder",
            trigger_at: applyTimingVariance(preReminderAt, "reminder"),
            context: {
              summary: `heads up: ${params.intent.context.summary}`,
              emotionalWeight: "medium",
              category: params.intent.context.category,
              originalMessage: params.originalMessage.slice(0, 500),
              source: "pre-reminder",
              parentEventId: data.id,
            },
            status: "pending",
          })
          .then(({ error: preErr }) => {
            if (preErr) console.warn("[HER Events] Pre-reminder create failed:", preErr.message);
            else console.log("[HER Events] Pre-reminder scheduled for high-weight event");
          });
      }
    }

    return data.id as string;
  } catch (err) {
    console.warn("[HER Events] Create exception:", err);
    return null;
  }
}

// ── Query ──────────────────────────────────────────────────

/**
 * Fetch all pending events that are due (trigger_at <= now).
 * Used by the cron worker.
 */
export async function getDueEvents(): Promise<ScheduledEvent[]> {
  const client = getSupabaseClient();
  if (!client) return [];

  try {
    const { data, error } = await client
      .from("scheduled_events")
      .select("*")
      .eq("status", "pending")
      .lte("trigger_at", new Date().toISOString())
      .order("trigger_at", { ascending: true })
      .limit(20); // Process max 20 per tick

    if (error) {
      console.warn("[HER Events] Query due events failed:", error.message);
      return [];
    }

    return (data ?? []) as ScheduledEvent[];
  } catch (err) {
    console.warn("[HER Events] Query due events exception:", err);
    return [];
  }
}

/**
 * Check if a user has any pending events triggering within a time window.
 * Used to avoid sending nudges when a reminder is coming soon.
 */
export async function hasPendingEventSoon(
  userId: string,
  withinHours: number = 4
): Promise<boolean> {
  const client = getSupabaseClient();
  if (!client) return false;

  const windowEnd = new Date(Date.now() + withinHours * 60 * 60 * 1000).toISOString();

  try {
    const { count, error } = await client
      .from("scheduled_events")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("status", "pending")
      .lte("trigger_at", windowEnd);

    if (error) return false;
    return (count ?? 0) > 0;
  } catch {
    return false;
  }
}

// ── Update ─────────────────────────────────────────────────

/**
 * Mark an event as sent after delivering the notification.
 */
export async function markEventSent(eventId: string): Promise<void> {
  const client = getSupabaseClient();
  if (!client) return;

  try {
    const { error } = await client
      .from("scheduled_events")
      .update({ status: "sent" as ScheduledEventStatus })
      .eq("id", eventId);

    if (error) console.warn("[HER Events] Mark sent failed:", error.message);
  } catch (err) {
    console.warn("[HER Events] Mark sent exception:", err);
  }
}

/**
 * Cancel a pending event.
 */
export async function cancelEvent(eventId: string): Promise<void> {
  const client = getSupabaseClient();
  if (!client) return;

  try {
    const { error } = await client
      .from("scheduled_events")
      .update({ status: "cancelled" as ScheduledEventStatus })
      .eq("id", eventId);

    if (error) console.warn("[HER Events] Cancel failed:", error.message);
  } catch (err) {
    console.warn("[HER Events] Cancel exception:", err);
  }
}

// ── Nudge Helpers ──────────────────────────────────────────

/**
 * Get the last activity timestamp for a user (last message time).
 */
export async function getUserLastActivity(userId: string): Promise<Date | null> {
  const client = getSupabaseClient();
  if (!client) return null;

  try {
    const { data, error } = await client
      .from("messages")
      .select("created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (error || !data) return null;
    return new Date(data.created_at);
  } catch {
    return null;
  }
}

/**
 * Count nudges sent to a user in the last N hours.
 * Used to enforce the 3-4 nudges per 72 hours limit.
 */
export async function countRecentNudges(
  userId: string,
  withinHours: number = 72
): Promise<number> {
  const client = getSupabaseClient();
  if (!client) return 99; // Return high count to prevent nudges when DB is down

  const since = new Date(Date.now() - withinHours * 60 * 60 * 1000).toISOString();

  try {
    const { count, error } = await client
      .from("scheduled_events")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("type", "nudge")
      .eq("status", "sent")
      .gte("trigger_at", since);

    if (error) return 99;
    return count ?? 0;
  } catch {
    return 99;
  }
}

/**
 * Check if user has enough engagement history to warrant nudges.
 * Requires at least 2 conversations and 10 messages.
 */
export async function hasEngagementHistory(userId: string): Promise<boolean> {
  const client = getSupabaseClient();
  if (!client) return false;

  try {
    const { count: convoCount } = await client
      .from("conversations")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId);

    if ((convoCount ?? 0) < 2) return false;

    const { count: msgCount } = await client
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("role", "user");

    return (msgCount ?? 0) >= 10;
  } catch {
    return false;
  }
}

/**
 * Check if the user recently ignored a nudge (sent a nudge but user didn't respond).
 * Returns true if the last nudge was sent but the user hasn't messaged since.
 */
export async function userIgnoredLastNudge(userId: string): Promise<boolean> {
  const client = getSupabaseClient();
  if (!client) return true; // Err on side of not nudging

  try {
    // Get the most recent sent nudge
    const { data: nudge } = await client
      .from("scheduled_events")
      .select("trigger_at")
      .eq("user_id", userId)
      .eq("type", "nudge")
      .eq("status", "sent")
      .order("trigger_at", { ascending: false })
      .limit(1)
      .single();

    if (!nudge) return false; // No previous nudge — OK to send

    // Check if user sent a message after the nudge
    const { count } = await client
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("role", "user")
      .gt("created_at", nudge.trigger_at);

    return (count ?? 0) === 0; // Ignored = no messages since nudge
  } catch {
    return true;
  }
}

// ── Query: Pending Events for User ─────────────────────────

/**
 * Get all pending events for a specific user.
 * Used by event resolution detection to check if user messages
 * resolve/complete any pending events.
 */
export async function getPendingEventsForUser(userId: string): Promise<ScheduledEvent[]> {
  const client = getSupabaseClient();
  if (!client) return [];

  try {
    const { data, error } = await client
      .from("scheduled_events")
      .select("*")
      .eq("user_id", userId)
      .eq("status", "pending")
      .order("trigger_at", { ascending: true })
      .limit(20);

    if (error) return [];
    return (data ?? []) as ScheduledEvent[];
  } catch {
    return [];
  }
}

// ── Notification Spacing (Part D) ──────────────────────────

/** Minimum gap between notifications: 30 minutes */
const MIN_NOTIFICATION_GAP_MS = 30 * 60 * 1000;

/**
 * Check if enough time has passed since the last notification to this user.
 * Returns true if it's safe to send, false if too recent.
 */
export async function canSendNotification(userId: string): Promise<boolean> {
  const client = getSupabaseClient();
  if (!client) return true;

  try {
    const { data } = await client
      .from("scheduled_events")
      .select("trigger_at")
      .eq("user_id", userId)
      .eq("status", "sent")
      .order("trigger_at", { ascending: false })
      .limit(1)
      .single();

    if (!data) return true;

    const lastSent = new Date(data.trigger_at).getTime();
    return Date.now() - lastSent >= MIN_NOTIFICATION_GAP_MS;
  } catch {
    return true;
  }
}

// ── Repetition Guard (Part E) ──────────────────────────────

/**
 * Get the last N notification messages sent to a user.
 * Used to compare and prevent repetitive phrasing.
 */
export async function getRecentNotificationMessages(
  userId: string,
  limit: number = 5
): Promise<string[]> {
  const client = getSupabaseClient();
  if (!client) return [];

  try {
    // Get recent assistant messages that came from notifications
    // (messages with no preceding user message = notification-inserted)
    const { data } = await client
      .from("scheduled_events")
      .select("context")
      .eq("user_id", userId)
      .eq("status", "sent")
      .order("trigger_at", { ascending: false })
      .limit(limit);

    if (!data) return [];

    return data
      .map((e) => (e.context as Record<string, unknown>)?.lastSentMessage as string)
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Store the message that was actually sent for a notification event,
 * so the repetition guard can compare future messages.
 */
export async function storeNotificationMessage(
  eventId: string,
  message: string
): Promise<void> {
  const client = getSupabaseClient();
  if (!client) return;

  try {
    // Update the event's context to include the sent message
    const { data: event } = await client
      .from("scheduled_events")
      .select("context")
      .eq("id", eventId)
      .single();

    if (event) {
      const updatedContext = {
        ...(event.context as Record<string, unknown>),
        lastSentMessage: message,
      };
      await client
        .from("scheduled_events")
        .update({ context: updatedContext })
        .eq("id", eventId);
    }
  } catch {
    // Silent fail
  }
}

/**
 * Simple string similarity check (Jaccard on word-level bigrams).
 * Returns 0.0–1.0 where 1.0 = identical.
 */
export function messageSimilarity(a: string, b: string): number {
  const getBigrams = (s: string): Set<string> => {
    const words = s.toLowerCase().split(/\s+/).filter(Boolean);
    const bigrams = new Set<string>();
    for (let i = 0; i < words.length - 1; i++) {
      bigrams.add(`${words[i]} ${words[i + 1]}`);
    }
    return bigrams;
  };

  const bigramsA = getBigrams(a);
  const bigramsB = getBigrams(b);
  if (bigramsA.size === 0 && bigramsB.size === 0) return 1;
  if (bigramsA.size === 0 || bigramsB.size === 0) return 0;

  let intersection = 0;
  for (const bg of bigramsA) {
    if (bigramsB.has(bg)) intersection++;
  }

  return intersection / (bigramsA.size + bigramsB.size - intersection);
}

// ── Drop-off Detection (Part J) ────────────────────────────

/**
 * Check if a user dropped off mid-conversation.
 * Returns context for the LLM to decide if a nudge is appropriate.
 */
export async function getDropoffContext(userId: string): Promise<{
  isDropoff: boolean;
  recentMessageCount: number;
  lastMessageAge: number; // minutes since last message
  lastConversationId: string | null;
} | null> {
  const client = getSupabaseClient();
  if (!client) return null;

  try {
    // Get the most recent conversation
    const { data: convo } = await client
      .from("conversations")
      .select("id, last_message_at")
      .eq("user_id", userId)
      .order("last_message_at", { ascending: false })
      .limit(1)
      .single();

    if (!convo) return null;

    const lastActivity = new Date(convo.last_message_at).getTime();
    const minutesSince = (Date.now() - lastActivity) / (1000 * 60);

    // Not a drop-off if too recent (<15 min) or too old (>120 min → becomes a nudge instead)
    if (minutesSince < 15 || minutesSince > 120) return null;

    // Count recent messages in this conversation (last hour window)
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count } = await client
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("conversation_id", convo.id)
      .gte("created_at", oneHourAgo);

    const recentCount = count ?? 0;

    // Only a "drop-off" if there was active engagement (3+ messages in the window)
    return {
      isDropoff: recentCount >= 3,
      recentMessageCount: recentCount,
      lastMessageAge: Math.round(minutesSince),
      lastConversationId: convo.id,
    };
  } catch {
    return null;
  }
}

// ── SQL for table creation ─────────────────────────────────
// Run this in your Supabase SQL editor:
/*

CREATE TABLE IF NOT EXISTS scheduled_events (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN ('reminder', 'followup', 'nudge')),
  trigger_at TIMESTAMPTZ NOT NULL,
  context JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'cancelled')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for the cron worker query
CREATE INDEX idx_scheduled_events_pending
  ON scheduled_events (status, trigger_at)
  WHERE status = 'pending';

-- Index for per-user queries
CREATE INDEX idx_scheduled_events_user
  ON scheduled_events (user_id, status);

-- Notification settings per user
CREATE TABLE IF NOT EXISTS notification_settings (
  user_id TEXT PRIMARY KEY,
  notifications_enabled BOOLEAN DEFAULT true,
  quiet_hours_start TEXT DEFAULT '01:00',  -- HH:MM in user's timezone
  quiet_hours_end TEXT DEFAULT '05:00',
  timezone TEXT DEFAULT 'UTC',
  push_subscription JSONB,  -- Web Push subscription object
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

*/
