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
import { getDueEvents, markEventSent, canSendNotification, getRecentNotificationMessages, storeNotificationMessage } from "@/lib/scheduled-events";
import { buildNotificationMessage } from "@/lib/notification-messages";
import { getNotificationSettings, isQuietHours } from "@/lib/notification-settings";
import { getSupabaseClient } from "@/lib/supabase-client";
import { sendPushNotification } from "@/lib/push";
import { getUserMemories, formatMemoryForPrompt } from "@/lib/memory";
import { debug } from "@/lib/debug";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  // ── Auth: verify cron secret ──
  // Supports: Vercel Cron (Authorization: Bearer), custom header, or query param
  const authHeader = req.headers.get("authorization");
  const secret = authHeader?.replace("Bearer ", "") || req.headers.get("x-cron-secret") || req.nextUrl.searchParams.get("secret");
  const expected = process.env.CRON_SECRET;

  if (expected && secret !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const apiKey = process.env.NVIDIA_CHAT_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "No API key" }, { status: 500 });
  }

  const events = await getDueEvents();
  if (events.length === 0) {
    return NextResponse.json({ processed: 0 });
  }

  let processed = 0;
  let delayed = 0;

  for (const event of events) {
    try {
      // ── Check quiet hours ──
      const settings = await getNotificationSettings(event.user_id);

      if (!settings.notifications_enabled) {
        // User disabled notifications — cancel the event
        await markEventSent(event.id);
        continue;
      }

      if (isQuietHours(settings)) {
        // Skip for now — will be picked up after quiet hours end
        delayed++;
        continue;
      }

      // ── Notification spacing (Part D): enforce minimum gap ──
      if (!(await canSendNotification(event.user_id))) {
        delayed++;
        continue;
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
          console.warn("[HER Cron] Push failed:", err);
        });
      }

      // ── Mark as sent + store message for repetition guard ──
      await markEventSent(event.id);
      await storeNotificationMessage(event.id, messageText);
      processed++;

      debug(`[HER Cron] Sent ${event.type} (${messageText.length} chars)`);
    } catch (err) {
      console.error(`[HER Cron] Error processing event ${event.id}:`, err);
    }
  }

  return NextResponse.json({ processed, delayed, total: events.length });
}
