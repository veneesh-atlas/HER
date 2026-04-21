/**
 * GET /api/cron/nudge
 *
 * Re-engagement nudge worker — called periodically (every 30-60 min).
 * Identifies users who've been inactive and may benefit from a friendly nudge.
 *
 * Safety rules:
 *   - Max 3 nudges per 72 hours per user
 *   - Skip if a pending reminder is coming soon
 *   - Skip if user recently ignored a previous nudge
 *   - Only nudge users with prior engagement history
 *   - Respect quiet hours
 */

import { NextRequest, NextResponse } from "next/server";
import {
  countRecentNudges,
  hasPendingEventSoon,
  hasEngagementHistory,
  userIgnoredLastNudge,
  canSendNotification,
  getDropoffContext,
} from "@/lib/scheduled-events";
import { buildNudgeMessage } from "@/lib/notification-messages";
import { generateReengagement } from "@/lib/reengagement-intelligence";
import { getInteractionPattern } from "@/lib/interaction-patterns";
import { getNotificationSettings, isQuietHours } from "@/lib/notification-settings";
import { getSupabaseClient } from "@/lib/supabase-client";
import { sendPushNotification } from "@/lib/push";
import { debug } from "@/lib/debug";

export const dynamic = "force-dynamic";

/** Minimum hours of inactivity before considering a nudge */
const INACTIVITY_THRESHOLD_HOURS = 24;

/** Max nudges per 72-hour window */
const MAX_NUDGES_PER_WINDOW = 3;

export async function GET(req: NextRequest) {
  // ── Auth: verify cron secret ──
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

  const client = getSupabaseClient();
  if (!client) {
    return NextResponse.json({ error: "No DB" }, { status: 500 });
  }

  // ── Find inactive users with engagement history ──
  const cutoff = new Date(Date.now() - INACTIVITY_THRESHOLD_HOURS * 60 * 60 * 1000).toISOString();

  // Get users whose last message is older than the threshold
  // Using a raw query approach: find distinct user_ids from conversations
  // where the most recent message is before the cutoff
  const { data: candidates, error } = await client
    .from("conversations")
    .select("user_id")
    .lt("last_message_at", cutoff)
    .order("last_message_at", { ascending: false });

  if (error || !candidates) {
    return NextResponse.json({ processed: 0, error: error?.message });
  }

  // Deduplicate user IDs
  const userIds = [...new Set(candidates.map((c) => c.user_id as string))];

  let nudged = 0;
  let skipped = 0;

  for (const userId of userIds) {
    try {
      // ── Safety checks ──

      // 1. Has engagement history?
      if (!(await hasEngagementHistory(userId))) {
        skipped++;
        continue;
      }

      // 2. Notifications enabled & not quiet hours?
      const settings = await getNotificationSettings(userId);
      if (!settings.notifications_enabled || isQuietHours(settings)) {
        skipped++;
        continue;
      }

      // 3. Recent nudge count under limit?
      const recentCount = await countRecentNudges(userId, 72);
      if (recentCount >= MAX_NUDGES_PER_WINDOW) {
        skipped++;
        continue;
      }

      // 4. Pending reminder coming soon?
      if (await hasPendingEventSoon(userId, 4)) {
        skipped++;
        continue;
      }

      // 5. Did they ignore the last nudge?
      if (await userIgnoredLastNudge(userId)) {
        skipped++;
        continue;
      }

      // 6. Notification spacing: enough time since last notification?
      if (!(await canSendNotification(userId))) {
        skipped++;
        continue;
      }

      // 7. Drop-off detection (Part J): check if this is a mid-conversation drop-off
      const dropoff = await getDropoffContext(userId);
      // If it's a drop-off (recent active convo that went silent), use that context
      // Otherwise it's a standard inactivity nudge

      // ── All checks passed — generate smart re-engagement (Step 21 Part F) ──
      // Try context-aware re-engagement first, fall back to generic nudge
      let messageText: string | null = null;

      // Fetch last messages for context-aware generation
      const targetConvoId = dropoff?.lastConversationId ?? null;
      let convoId = targetConvoId;
      if (!convoId) {
        const { data: recentConvo } = await client
          .from("conversations")
          .select("id")
          .eq("user_id", userId)
          .order("last_message_at", { ascending: false })
          .limit(1)
          .single();
        convoId = recentConvo?.id ?? null;
      }

      if (convoId) {
        // Get last few messages for context
        const { data: lastMsgs } = await client
          .from("messages")
          .select("role, content")
          .eq("conversation_id", convoId)
          .order("created_at", { ascending: false })
          .limit(4);

        if (lastMsgs && lastMsgs.length > 0) {
          const patterns = await getInteractionPattern(userId);
          const hoursSince = dropoff?.lastMessageAge
            ? dropoff.lastMessageAge / (60 * 60 * 1000)
            : INACTIVITY_THRESHOLD_HOURS;

          messageText = await generateReengagement({
            lastMessages: lastMsgs.reverse() as { role: string; content: string }[],
            hoursSinceLastMessage: hoursSince,
            patterns,
          });
        }
      }

      // Fall back to generic nudge if smart re-engagement returned null
      if (!messageText) {
        messageText = await buildNudgeMessage(apiKey);
      }

      // Insert the nudge as a message (with context tag — Part F)
      if (convoId) {
        await client.from("messages").insert({
          conversation_id: convoId,
          user_id: userId,
          role: "assistant",
          content: messageText,
          // NOTE: see notify/route.ts — do not write `_notification` markers
          // into the reactions column; it crashes the renderer.
        });

        await client
          .from("conversations")
          .update({ last_message_at: new Date().toISOString() })
          .eq("id", convoId);
      }

      // Record the nudge event directly as sent
      await client
        .from("scheduled_events")
        .insert({
          user_id: userId,
          conversation_id: convoId,
          type: "nudge",
          trigger_at: new Date().toISOString(),
          context: {
            summary: dropoff?.isDropoff ? "mid-conversation drop-off nudge" : "re-engagement nudge",
            emotionalWeight: "low",
            category: "nudge",
            source: "nudge",
            lastSentMessage: messageText,
          },
          status: "sent",
        });

      // Push notification
      if (settings.push_subscription) {
        await sendPushNotification(settings.push_subscription, {
          title: "HER",
          body: messageText,
          data: { conversationId: convoId, url: "/chat" },
        }).catch(() => {});
      }

      nudged++;
      debug(`[HER Nudge] Sent nudge (${messageText.length} chars)`);
    } catch (err) {
      console.error(`[HER Nudge] Error for user ${userId}:`, err);
      skipped++;
    }
  }

  return NextResponse.json({ nudged, skipped, candidates: userIds.length });
}
