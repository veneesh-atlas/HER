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

import { getSupabaseClient } from "./supabase-client";
import type { TemporalIntent } from "./temporal";
import { debug, logHER, warnHER, errorHER } from "./debug";

// ── Types ──────────────────────────────────────────────────

export type ScheduledEventType = "reminder" | "followup" | "nudge" | "promise";
export type ScheduledEventStatus =
  | "pending"
  | "sent"
  | "cancelled"
  | "missed"
  | "completed"
  | "rescheduled";

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
  // ── Step 17.4 lifecycle columns ──
  sent_at?: string | null;
  missed_at?: string | null;
  completed_at?: string | null;
  rescheduled_at?: string | null;
  followup_sent_at?: string | null;
  rescheduled_from_event_id?: string | null;
  reschedule_reason?: string | null;
}

// ── Timing Variance (Part B — Humanized Timing) ───────────

/**
 * Apply natural delivery variance so notifications never fire
 * exactly on the minute. Makes HER feel human, not robotic.
 *
 * Exported for unit testing — production callers should go through
 * `createScheduledEvent({ applyVariance: true })`.
 */
export function applyTimingVariance(triggerAt: string, type: string): string {
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

  // Defense in depth: never schedule background work for guests.
  // The temporal route already gates this, but enforce here too so any
  // caller (cron, dev harness, future tools) can't accidentally bypass.
  if (!params.userId || params.userId === "guest") {
    debug("[HER Events] Guest user — skipping scheduled event");
    return null;
  }

  // If no trigger time, skip — we can't schedule without a when
  if (!params.intent.triggerAt) {
    console.warn("[HER Events] No triggerAt — skipping event creation");
    return null;
  }

  const finalTriggerAt = params.applyVariance
    ? applyTimingVariance(params.intent.triggerAt, params.intent.type)
    : params.intent.triggerAt;

  const insertPayload = {
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
  };

  debug("[HER Events] INSERT payload:", JSON.stringify(insertPayload));

  try {
    const { data, error } = await client
      .from("scheduled_events")
      .insert(insertPayload)
      .select("id")
      .single();

    if (error) {
      // Loud error — surfaces CHECK-constraint failures (e.g. missing
      // 'promise' value in the schema's type CHECK) which previously
      // disappeared into a single warn line.
      const pgErr = error as { code?: string; details?: string; hint?: string; message: string };
      errorHER("Events", null, "INSERT FAILED", {
        code: pgErr.code,
        details: pgErr.details,
        hint: pgErr.hint,
        message: pgErr.message,
        type: params.intent.type,
      });
      return null;
    }

    logHER("Events", data.id as string, "INSERT OK", {
      trigger_at: finalTriggerAt,
      type: params.intent.type,
      weight: params.intent.context.emotionalWeight,
    });

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
            else debug("[HER Events] Pre-reminder scheduled for high-weight event");
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
 * Also writes `sent_at` so the missed-detection pass can compare against
 * the real delivery time (not the planned trigger_at, which can drift
 * with timing variance).
 */
export async function markEventSent(eventId: string): Promise<void> {
  const client = getSupabaseClient();
  if (!client) return;

  try {
    const { error } = await client
      .from("scheduled_events")
      .update({
        status: "sent" as ScheduledEventStatus,
        sent_at: new Date().toISOString(),
      })
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
 * Step 17.X+2 — Active Conversation Suppression.
 *
 * Returns true if the user has sent at least one message in the given
 * conversation within the last `windowMinutes`. Used by the cron to skip
 * notifications when the user is mid-chat — a real person doesn't text you
 * a reminder while you're already talking to them.
 *
 * Lightweight gate only: any failure or missing conversation_id returns
 * false (treat as inactive) so we never block legit notifications on a
 * transient DB error.
 */
export async function isUserActiveRecently(
  userId: string,
  conversationId: string | null,
  windowMinutes: number = 2,
): Promise<boolean> {
  if (!conversationId) return false;
  const client = getSupabaseClient();
  if (!client) return false;

  const since = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();

  try {
    const { count, error } = await client
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("conversation_id", conversationId)
      .eq("role", "user")
      .gte("created_at", since);

    if (error) return false;
    return (count ?? 0) > 0;
  } catch {
    return false;
  }
}

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
      .select("sent_at, trigger_at")
      .eq("user_id", userId)
      .eq("status", "sent")
      .order("sent_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .single();

    if (!data) return true;

    // Prefer real send time; fall back to trigger_at for legacy rows
    const lastSent = new Date(data.sent_at ?? data.trigger_at).getTime();
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
  message: string,
  /** Optional Step 17.5 metadata: which style we chose this round. */
  style?: string | null
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
      const updatedContext: Record<string, unknown> = {
        ...(event.context as Record<string, unknown>),
        lastSentMessage: message,
      };
      if (style) updatedContext.lastStyle = style;
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

// ── Step 17.4: Self-Healing Lifecycle ─────────────────────

/** A "missed" reminder is one we sent but the user never engaged with. */
const MISSED_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Pure helper: given an event and "now", decide if it should be considered
 * missed. The actual "did the user reply?" check is done separately via
 * `userRepliedSince` so this stays trivially testable.
 */
export function detectMissedEvent(
  event: Pick<ScheduledEvent, "sent_at" | "trigger_at" | "status" | "followup_sent_at">,
  now: Date = new Date(),
  thresholdMs: number = MISSED_THRESHOLD_MS
): boolean {
  if (event.status !== "sent") return false;
  if (event.followup_sent_at) return false; // already followed up — never twice
  const sentAt = new Date(event.sent_at ?? event.trigger_at).getTime();
  return now.getTime() - sentAt >= thresholdMs;
}

/**
 * Mark an event as completed (user resolved it positively).
 * Used by the resolution detector when a user message implies success.
 */
export async function markEventCompleted(eventId: string): Promise<void> {
  const client = getSupabaseClient();
  if (!client) return;
  try {
    const { error } = await client
      .from("scheduled_events")
      .update({
        status: "completed" as ScheduledEventStatus,
        completed_at: new Date().toISOString(),
      })
      .eq("id", eventId);
    if (error) warnHER("Events", eventId, "Mark completed failed", { message: error.message });
    else logHER("Events", eventId, "COMPLETED");
  } catch (err) {
    console.warn("[HER Events] Mark completed exception:", err);
  }
}

/**
 * Mark a sent event as missed (no engagement after threshold).
 * Called by the cron's missed-detection pass after sending the soft follow-up.
 */
export async function markEventMissed(eventId: string, deltaMinutes: number): Promise<void> {
  const client = getSupabaseClient();
  if (!client) return;
  try {
    const { error } = await client
      .from("scheduled_events")
      .update({
        status: "missed" as ScheduledEventStatus,
        missed_at: new Date().toISOString(),
      })
      .eq("id", eventId);
    if (error) warnHER("Events", eventId, "Mark missed failed", { message: error.message });
    else logHER("Events", eventId, "MISSED", { deltaMinutes });
  } catch (err) {
    console.warn("[HER Events] Mark missed exception:", err);
  }
}

/**
 * Mark an event as rescheduled and create the linked successor event.
 * Returns the new event id, or null on failure.
 */
export async function rescheduleEvent(params: {
  originalEvent: ScheduledEvent;
  newTriggerAt: string;
  reason: string;
}): Promise<string | null> {
  const client = getSupabaseClient();
  if (!client) return null;

  try {
    // 1. Insert the successor event with provenance
    const { data: created, error: insertErr } = await client
      .from("scheduled_events")
      .insert({
        user_id: params.originalEvent.user_id,
        conversation_id: params.originalEvent.conversation_id,
        type: params.originalEvent.type,
        trigger_at: params.newTriggerAt,
        context: {
          ...params.originalEvent.context,
          source: "rescheduled",
        },
        status: "pending" as ScheduledEventStatus,
        rescheduled_from_event_id: params.originalEvent.id,
        reschedule_reason: params.reason.slice(0, 240),
      })
      .select("id")
      .single();

    if (insertErr || !created) {
      console.error("[HER Events] Reschedule insert failed:", insertErr?.message);
      return null;
    }

    // 2. Mark the original as rescheduled (terminal state, won't reprocess)
    await client
      .from("scheduled_events")
      .update({
        status: "rescheduled" as ScheduledEventStatus,
        rescheduled_at: new Date().toISOString(),
      })
      .eq("id", params.originalEvent.id);

    console.log("[HER Events] RESCHEDULED", {
      eventId: params.originalEvent.id,
      newEventId: created.id,
      newTriggerAt: params.newTriggerAt,
      reason: params.reason.slice(0, 120),
    });

    return created.id as string;
  } catch (err) {
    console.error("[HER Events] Reschedule exception:", err);
    return null;
  }
}

/** Mark that we've sent the one-shot soft follow-up for this event. */
export async function markFollowupSent(eventId: string): Promise<void> {
  const client = getSupabaseClient();
  if (!client) return;
  try {
    await client
      .from("scheduled_events")
      .update({ followup_sent_at: new Date().toISOString() })
      .eq("id", eventId);
  } catch (err) {
    console.warn("[HER Events] markFollowupSent exception:", err);
  }
}

/**
 * Fetch sent events that are old enough to be candidates for the
 * missed-detection pass: still status='sent', no follow-up sent yet,
 * and at least MISSED_THRESHOLD_MS past their sent_at.
 *
 * Excludes nudges (a nudge that gets ignored is the *expected* path —
 * fatigue handling deals with that, not the soft follow-up).
 */
export async function getMissedCandidateEvents(
  thresholdMs: number = MISSED_THRESHOLD_MS,
  limit: number = 20
): Promise<ScheduledEvent[]> {
  const client = getSupabaseClient();
  if (!client) return [];

  const cutoff = new Date(Date.now() - thresholdMs).toISOString();

  try {
    const { data, error } = await client
      .from("scheduled_events")
      .select("*")
      .eq("status", "sent")
      .is("followup_sent_at", null)
      .neq("type", "nudge")
      .lte("sent_at", cutoff)
      .order("sent_at", { ascending: true })
      .limit(limit);

    if (error) {
      console.warn("[HER Events] Missed-candidate query failed:", error.message);
      return [];
    }
    return (data ?? []) as ScheduledEvent[];
  } catch (err) {
    console.warn("[HER Events] Missed-candidate exception:", err);
    return [];
  }
}

/**
 * Did this user post any user-role message in this conversation since `sinceIso`?
 * Used to decide if a sent event was actually engaged with.
 */
export async function userRepliedSince(
  userId: string,
  conversationId: string | null,
  sinceIso: string
): Promise<boolean> {
  const client = getSupabaseClient();
  if (!client) return false;

  try {
    let q = client
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("role", "user")
      .gt("created_at", sinceIso);
    if (conversationId) q = q.eq("conversation_id", conversationId);
    const { count } = await q;
    return (count ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * Find the most recent sent (and not-yet-followed-up) event for a user
 * that the user might be replying to with a postponement message.
 * Window: events sent within the last 90 minutes.
 */
export async function getRecentSentEventForUser(
  userId: string,
  windowMs: number = 90 * 60 * 1000
): Promise<ScheduledEvent | null> {
  const client = getSupabaseClient();
  if (!client) return null;

  const cutoff = new Date(Date.now() - windowMs).toISOString();

  try {
    const { data } = await client
      .from("scheduled_events")
      .select("*")
      .eq("user_id", userId)
      .eq("status", "sent")
      .is("followup_sent_at", null)
      .gte("sent_at", cutoff)
      .order("sent_at", { ascending: false })
      .limit(1)
      .single();
    return (data as ScheduledEvent) ?? null;
  } catch {
    return null;
  }
}

/**
 * Fatigue control: how many low-priority events (nudge/followup) have we
 * sent to this user in the last 24h that the user did NOT reply to?
 *
 * Used by the cron to throttle low-priority delivery — high-priority is
 * never affected.
 */
export async function countIgnoredLowPriority24h(userId: string): Promise<number> {
  const client = getSupabaseClient();
  if (!client) return 0;

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  try {
    const { data } = await client
      .from("scheduled_events")
      .select("id, sent_at, conversation_id")
      .eq("user_id", userId)
      .in("type", ["nudge", "followup"])
      .in("status", ["sent", "missed"])
      .gte("sent_at", since);

    if (!data || data.length === 0) return 0;

    let ignored = 0;
    for (const ev of data as Array<{ id: string; sent_at: string; conversation_id: string | null }>) {
      const replied = await userRepliedSince(userId, ev.conversation_id, ev.sent_at);
      if (!replied) ignored++;
    }
    return ignored;
  } catch {
    return 0;
  }
}

// ── Test / Simulation helper ───────────────────────────────

/**
 * DEV / TEST ONLY — fast-forward a scheduled event by shifting its
 * `trigger_at` (and `sent_at` if present) backward in time. Use this
 * to simulate "this event was scheduled N minutes ago" without waiting
 * real time.
 *
 * @param eventId  Row id in scheduled_events
 * @param minutes  Shift amount (positive = move INTO the past)
 */
export async function shiftEventTime(
  eventId: string,
  minutes: number
): Promise<ScheduledEvent | null> {
  const client = getSupabaseClient();
  if (!client) return null;

  const shiftMs = minutes * 60 * 1000;

  try {
    const { data: existing, error: readErr } = await client
      .from("scheduled_events")
      .select("*")
      .eq("id", eventId)
      .single();
    if (readErr || !existing) {
      console.warn("[HER Events] shiftEventTime: not found", { eventId, err: readErr?.message });
      return null;
    }

    const ev = existing as ScheduledEvent;
    const update: Record<string, string> = {
      trigger_at: new Date(new Date(ev.trigger_at).getTime() - shiftMs).toISOString(),
    };
    if (ev.sent_at) {
      update.sent_at = new Date(new Date(ev.sent_at).getTime() - shiftMs).toISOString();
    }

    const { data: updated, error: updErr } = await client
      .from("scheduled_events")
      .update(update)
      .eq("id", eventId)
      .select("*")
      .single();
    if (updErr) {
      console.warn("[HER Events] shiftEventTime update failed:", updErr.message);
      return null;
    }
    logHER("Events", eventId, "SHIFTED", { minutes, newTriggerAt: update.trigger_at });
    return updated as ScheduledEvent;
  } catch (err) {
    console.warn("[HER Events] shiftEventTime exception:", err);
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
  type TEXT NOT NULL CHECK (type IN ('reminder', 'followup', 'nudge', 'promise')),
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
