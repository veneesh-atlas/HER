/**
 * GET /api/cron/notify
 *
 * Background cron endpoint — called every ~5 minutes by an external scheduler
 * (e.g. cron-job.org). Processes pending scheduled events that are due.
 *
 * Cadence rationale: at 5 min, average delivery latency is ~2.5 min and worst
 * case is ~5 min — invisible for day-scale reminders/follow-ups, while keeping
 * Vercel function invocations ~80% lower than a 1-min schedule.
 *
 * For each due event:
 *   1. Check quiet hours → delay if needed
 *   2. Generate a HER-style message
 *   3. Insert into messages table
 *   4. Send push notification (if subscribed)
 *   5. Mark event as "sent"
 *
 * Secure this endpoint with a CRON_SECRET env var (passed via Authorization
 * header, x-cron-secret header, or ?secret= query param).
 */

import { NextRequest, NextResponse } from "next/server";
import {
  getDueEvents,
  markEventSent,
  canSendNotification,
  getRecentNotificationMessages,
  storeNotificationMessage,
  getMissedCandidateEvents,
  userRepliedSince,
  markEventMissed,
  markFollowupSent,
  countIgnoredLowPriority24h,
  detectMissedEvent,
} from "@/lib/scheduled-events";
import { buildNotificationMessage, buildEmotionAwareMessage } from "@/lib/notification-messages";
import { getNotificationSettings, isQuietHours, isHighPriorityEvent } from "@/lib/notification-settings";
import { getSupabaseClient } from "@/lib/supabase-client";
import { sendPushNotification } from "@/lib/push";
import { getUserMemories, formatMemoryForPrompt } from "@/lib/memory";
import {
  extractEmotionalContext,
  getDynamicFollowupThreshold,
  pickContrastingTone,
  type MessageStyle,
} from "@/lib/notification-emotion";
import { debug, logHER, warnHER, errorHER } from "@/lib/debug";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  // ── Auth: verify cron secret ──
  // Supports: Vercel Cron (Authorization: Bearer), custom header, or query param
  const authHeader = req.headers.get("authorization");
  const secret = authHeader?.replace("Bearer ", "") || req.headers.get("x-cron-secret") || req.nextUrl.searchParams.get("secret");
  const expected = process.env.CRON_SECRET;

  logHER("Cron", "tick", "TICK", {
    ts: new Date().toISOString(),
    hasSecret: !!secret,
    secretMatches: !expected || secret === expected,
    ua: req.headers.get("user-agent"),
  });

  if (expected && secret !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const apiKey = process.env.NVIDIA_CHAT_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "No API key" }, { status: 500 });
  }

  const events = await getDueEvents();
  console.log(
    "[HER Cron] Due events:",
    events.length,
    events.map((e) => ({ id: e.id, user: e.user_id, type: e.type, trigger_at: e.trigger_at }))
  );
  if (events.length === 0) {
    return NextResponse.json({ processed: 0 });
  }

  let processed = 0;
  let delayed = 0;

  for (const event of events) {
    try {
      const settings = await getNotificationSettings(event.user_id);

      // ── Priority routing (Part A) ─────────────────────────
      // HIGH priority (reminder, promise) = user-owned. The user explicitly
      // asked for these at a specific time, so they MUST bypass quiet hours
      // and cooldown gates.
      // LOW priority (followup, nudge) = system-initiated. These respect
      // quiet hours, cooldowns, and inactivity patterns.
      const highPriority = isHighPriorityEvent(event.type);
      const inQuiet = isQuietHours(settings);

      logHER("Cron", event.id, "picked", {
        type: event.type,
        highPriority,
        enabled: settings.notifications_enabled,
        tz: settings.timezone,
        quiet: `${settings.quiet_hours_start}-${settings.quiet_hours_end}`,
        inQuiet,
        hasPush: !!settings.push_subscription,
      });

      if (!settings.notifications_enabled) {
        // User disabled notifications — cancel the event
        warnHER("Cron", event.id, "SKIP", { reason: "notifications disabled" });
        await markEventSent(event.id);
        continue;
      }

      // ── Quiet hours gate (Part B) — only for low-priority events ──
      if (inQuiet && !highPriority) {
        warnHER("Cron", event.id, "DELAYED", {
          reason: "quiet hours",
          tz: settings.timezone,
          nowUtc: new Date().toISOString(),
        });
        delayed++;
        continue;
      }

      // ── Cooldown gate (30 min) — only for low-priority events ──
      if (!highPriority) {
        const canSend = await canSendNotification(event.user_id);
        if (!canSend) {
          warnHER("Cron", event.id, "DELAYED", { reason: "cooldown" });
          delayed++;
          continue;
        }

        // ── Fatigue gate (Step 17.4 Part D) ──
        // If the user has ignored ≥3 low-priority pings in the last 24h,
        // back off. High-priority is never throttled.
        const ignored24h = await countIgnoredLowPriority24h(event.user_id);
        if (ignored24h >= 3) {
          warnHER("Cron", event.id, "FATIGUE", {
            reason: "throttling low-priority",
            type: event.type,
            ignored24h,
          });
          // Cancel rather than infinitely delay: the user is clearly disengaged
          // for now; the next genuinely user-initiated event will reset things.
          await markEventSent(event.id); // terminal state, won't reprocess
          continue;
        }
      }

      // ── Repetition guard (Part E): get recent messages to avoid ──
      const recentMessages = await getRecentNotificationMessages(event.user_id, 5);

      // ── Memory context (Step 18): make notifications personality-aware ──
      const memories = await getUserMemories(event.user_id);
      const memoryContext = formatMemoryForPrompt(memories);

      // ── Generate HER-style message (with repetition avoidance + memory) ──
      const messageText = await buildNotificationMessage(event, apiKey, recentMessages, memoryContext);

      // ── Insert into messages table (with context tag — Part F) ──
      const client = getSupabaseClient();
      if (client && event.conversation_id) {
        await client.from("messages").insert({
          conversation_id: event.conversation_id,
          user_id: event.user_id,
          role: "assistant",
          content: messageText,
          // NOTE: previously stored a `_notification` marker under `reactions`,
          // but that column is shaped Record<string, string[]> and the marker
          // crashed the chat renderer when these rows were paged in. The marker
          // was never read anywhere, so we just drop it.
        });

        // Touch conversation timestamp
        await client
          .from("conversations")
          .update({ last_message_at: new Date().toISOString() })
          .eq("id", event.conversation_id);
      }

      // ── Send push notification ──
      if (settings.push_subscription) {
        await sendPushNotification(settings.push_subscription, {
          title: "HER",
          body: messageText,
          data: {
            conversationId: event.conversation_id,
            url: "/chat",
          },
        }).catch((err) => {
          warnHER("Push", event.id, "send failed", { err: err instanceof Error ? err.message : String(err) });
        });
      }

      // ── Mark as sent + store message for repetition guard ──
      await markEventSent(event.id);
      await storeNotificationMessage(event.id, messageText);
      processed++;

      logHER("Cron", event.id, "DELIVERED", {
        type: event.type,
        msgChars: messageText.length,
        pushed: !!settings.push_subscription,
      });
      debug(`[HER Cron] Sent ${event.type} (${messageText.length} chars)`);
    } catch (err) {
      errorHER("Cron", event.id, "processing error", { err: err instanceof Error ? err.message : String(err) });
    }
  }

  // ── Step 17.4 + 17.5: Missed-Reminder Pass ────────────────────
  // For each candidate, decide a *dynamic* threshold based on emotion + the
  // user's recent fatigue level, then re-check missed-ness. Build the
  // follow-up via the emotion-aware path with anti-repetition style rotation.
  let followups = 0;
  let missedSilent = 0;
  // Pull with the smallest possible threshold (12 min) so that anxious /
  // important-event windows can fire faster than the legacy 30 min default.
  const candidates = await getMissedCandidateEvents(12 * 60 * 1000);
  if (candidates.length > 0) {
    console.log("[HER Cron] Missed-pass candidates:", candidates.length);
  }

  for (const event of candidates) {
    try {
      const sentAt = event.sent_at ?? event.trigger_at;
      const ageMs = Date.now() - new Date(sentAt).getTime();

      // Cheap pre-check: emotion extraction is the most expensive step here,
      // so don't run it on events that obviously aren't ready under any rule.
      if (ageMs < 12 * 60 * 1000) continue;

      const emotional = await extractEmotionalContext(event, apiKey);
      const ignored24h = await countIgnoredLowPriority24h(event.user_id);
      const dynamicThreshold = getDynamicFollowupThreshold(event, emotional, ignored24h);

      logHER("Emotion", event.id, "context", {
        tone: emotional.tone,
        userState: emotional.userState,
        important: emotional.important,
        confidence: emotional.confidence,
        thresholdMin: Math.round(dynamicThreshold / 60000),
        ignored24h,
      });

      // Per-event dynamic gate (replaces the 30-min hard rule).
      if (ageMs < dynamicThreshold) continue;
      if (!detectMissedEvent(event, new Date(), dynamicThreshold)) continue;

      const deltaMin = Math.round(ageMs / 60000);

      const replied = await userRepliedSince(event.user_id, event.conversation_id, sentAt);
      if (replied) {
        await markFollowupSent(event.id);
        missedSilent++;
        logHER("Events", event.id, "ENGAGED", { reason: "user replied", deltaMin });
        continue;
      }

      const settings = await getNotificationSettings(event.user_id);
      if (!settings.notifications_enabled) {
        await markFollowupSent(event.id);
        continue;
      }

      const highPriority = isHighPriorityEvent(event.type);
      if (isQuietHours(settings) && !highPriority) continue;

      // ── Style rotation (Part D) ──
      const previousStyle =
        ((event.context as unknown as { lastStyle?: MessageStyle }).lastStyle) ?? null;
      const previousMessage =
        ((event.context as unknown as { lastSentMessage?: string }).lastSentMessage) ?? null;
      const style = pickContrastingTone(emotional, previousStyle);

      const recent = await getRecentNotificationMessages(event.user_id, 5);
      const memories = await getUserMemories(event.user_id);
      const memoryContext = formatMemoryForPrompt(memories);

      const messageText = await buildEmotionAwareMessage({
        event,
        emotional,
        style,
        apiKey,
        recentMessages: recent,
        memoryContext,
        previousMessage,
      });

      const client = getSupabaseClient();
      if (client && event.conversation_id) {
        await client.from("messages").insert({
          conversation_id: event.conversation_id,
          user_id: event.user_id,
          role: "assistant",
          content: messageText,
        });
        await client
          .from("conversations")
          .update({ last_message_at: new Date().toISOString() })
          .eq("id", event.conversation_id);
      }

      if (settings.push_subscription) {
        await sendPushNotification(settings.push_subscription, {
          title: "HER",
          body: messageText,
          data: { conversationId: event.conversation_id, url: "/chat" },
        }).catch((err) => warnHER("Push", event.id, "follow-up push failed", { err: err instanceof Error ? err.message : String(err) }));
      }

      await markFollowupSent(event.id);
      await markEventMissed(event.id, deltaMin);
      await storeNotificationMessage(event.id, messageText, style);
      followups++;

      logHER("Events", event.id, "FOLLOW-UP SENT", {
        type: event.type,
        deltaMin,
        chars: messageText.length,
        style,
        tone: emotional.tone,
        thresholdMin: Math.round(dynamicThreshold / 60000),
      });
    } catch (err) {
      errorHER("Cron", event.id, "missed-pass error", { err: err instanceof Error ? err.message : String(err) });
    }
  }

  return NextResponse.json({
    processed,
    delayed,
    total: events.length,
    followups,
    missedSilent,
    missedCandidates: candidates.length,
  });
}
