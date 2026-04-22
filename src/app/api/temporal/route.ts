/**
 * POST /api/temporal
 *
 * Detects temporal intent from a user message.
 * Called fire-and-forget by the client after sending a message.
 * If intent is found, creates a scheduled_event in Supabase.
 *
 * AUTH-GATED: Only authenticated users. Guests are skipped (zero cost).
 * SELECTIVE: Filters out low-confidence, low-weight, and far-future events.
 * RESOLUTION: Also checks if the message resolves any pending events.
 */

import { NextRequest, NextResponse } from "next/server";
import { validateApiRequest } from "@/lib/api-auth";
import {
  hasTemporalSignal,
  detectTemporalIntent,
  detectEventResolution,
  detectFollowUpIntent,
  detectContinuityUpdate,
  detectPostponement,
} from "@/lib/temporal";
import {
  createScheduledEvent,
  getPendingEventsForUser,
  cancelEvent,
  markEventCompleted,
  rescheduleEvent,
  getRecentSentEventForUser,
} from "@/lib/scheduled-events";
import { saveNotificationSettings } from "@/lib/notification-settings";
import { saveMemoryEntries } from "@/lib/memory";
import { debug } from "@/lib/debug";

export async function POST(req: NextRequest) {
  try {
    const auth = await validateApiRequest(req);
    if (auth.error) return auth.error;

    // ── Auth gate: guests get zero background cost ──
    if (auth.userId === "guest") {
      return NextResponse.json({ skipped: true }, { status: 200 });
    }

    const body = await req.json();
    const { message, conversationId, recentContext, userTimezone, agentReply } = body;

    // ── Persist user timezone EARLY (Part C) ──
    // Many users never open the Notifications panel, so their
    // notification_settings row never gets created and getNotificationSettings()
    // falls back to timezone:"UTC". That default makes the cron's quiet-hours
    // check apply IST 9:45 AM → 04:15 UTC → inside the 01:00–05:00 window →
    // reminders silently delayed. Save the browser-detected TZ on first
    // contact so the cron always has correct local time.
    if (userTimezone && typeof userTimezone === "string") {
      saveNotificationSettings(auth.userId, { timezone: userTimezone }).catch(() => {});
    }

    if (!message || typeof message !== "string") {
      return NextResponse.json({ detected: false }, { status: 200 });
    }

    const apiKey = process.env.NVIDIA_CHAT_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ detected: false }, { status: 200 });
    }

    // ── Step 17.4: Postponement on a recently-sent reminder ──
    // If HER just sent a reminder/promise and the user replies with "in a bit",
    // "later", "tonight" etc., reschedule the existing event into a new one
    // and link them. Runs before the resolution + intent detectors so a
    // postponement doesn't get re-classified as a brand-new reminder.
    const recentSent = await getRecentSentEventForUser(auth.userId);
    if (recentSent) {
      const postpone = await detectPostponement(
        message,
        recentSent.context.summary,
        new Date(),
        apiKey,
        userTimezone
      );
      if (postpone.shouldReschedule && postpone.newTriggerAt) {
        const newId = await rescheduleEvent({
          originalEvent: recentSent,
          newTriggerAt: postpone.newTriggerAt,
          reason: postpone.reason,
        });
        if (newId) {
          return NextResponse.json({
            detected: true,
            type: "reschedule",
            triggerAt: postpone.newTriggerAt,
            originalEventId: recentSent.id,
            eventId: newId,
            reason: postpone.reason,
          });
        }
      }
    }

    // ── Event Resolution: check if this message resolves pending events ──
    const pendingEvents = await getPendingEventsForUser(auth.userId);
    if (pendingEvents.length > 0) {
      // Full resolution check (completed/cancelled)
      const resolved = await detectEventResolution(message, pendingEvents, apiKey);
      if (resolved.length > 0) {
        debug(`[HER Temporal] Resolved ${resolved.length} events for user ${auth.userId}`);
      }

      // ── Continuity learning (Step 18 Part F): detect reschedules ──
      for (const event of pendingEvents) {
        if (resolved.includes(event.id)) continue; // Already resolved
        const update = await detectContinuityUpdate(message, event.context.summary, new Date(), apiKey, userTimezone);
        if (update.status === "completed") {
          // Step 17.4: explicit completed state + light memory write for
          // events that genuinely mattered (medium/high weight). Low-weight
          // tasks aren't worth filling memory with.
          await markEventCompleted(event.id);
          if (event.context.emotionalWeight !== "low") {
            // Step 17.5 Part E: store an emotional outcome signal so future
            // events of the same category can adapt tone (e.g. if user was
            // anxious during prior "interview" events, future interview
            // reminders trend calmer).
            const lowerMsg = message.toLowerCase();
            const stressedHit = /stress|nervous|anxious|panick|overwhelm|exhausted|drain/.test(lowerMsg);
            const positiveHit = /great|awesome|amazing|love|perfect|finally|nailed|crushed|smooth/.test(lowerMsg);
            const outcome = stressedHit ? "stressed" : positiveHit ? "positive" : "neutral";
            saveMemoryEntries(auth.userId, [
              {
                fact: `they followed through on: ${event.context.summary} (outcome: ${outcome}, category: ${event.context.category})`,
                category: outcome === "stressed" ? "emotional" : "context",
                confidence: 0.7,
              },
            ]).catch(() => {});
          }
          debug(`[HER Temporal] Continuity: event ${event.id} completed`);
        } else if (update.status === "reschedule" && update.newTime) {
          await cancelEvent(event.id);
          await createScheduledEvent({
            userId: auth.userId,
            conversationId: conversationId || null,
            intent: {
              type: event.type === "nudge" ? "followup" : event.type as "reminder" | "followup",
              triggerAt: update.newTime,
              context: {
                summary: event.context.summary,
                emotionalWeight: event.context.emotionalWeight,
                category: event.context.category === "nudge" ? "plan" : event.context.category as "event" | "task" | "plan",
              },
            },
            originalMessage: event.context.originalMessage || "",
            applyVariance: true,
          });
          debug(`[HER Temporal] Continuity: event ${event.id} rescheduled → ${update.newTime}`);
        }
      }
    }

    // ── Step 1: Cheap signal gate ──
    if (!hasTemporalSignal(message)) {
      // Even if no temporal signal, the predictive follow-up may still apply
      // for vague future intent — fall through to it below.
    } else {
      // ── Step 2: LLM-based detection (handles reminder / followup / promise) ──
      // This runs BEFORE the predictive follow-up so explicit promises don't
      // get misclassified as generic followups.
      const intent = await detectTemporalIntent(message, new Date(), apiKey, userTimezone, agentReply);

      console.log("[HER Temporal] LLM intent:", JSON.stringify({
        userId: auth.userId,
        message: message.slice(0, 120),
        userTimezone,
        type: intent?.type,
        triggerAt: intent?.triggerAt,
        hasTriggerAt: !!intent?.triggerAt,
        summary: intent?.context?.summary,
      }));

      if (intent && intent.triggerAt) {
        // ── Step 3: Selective triggering filter ──
        const triggerDate = new Date(intent.triggerAt);
        const daysFuture = (triggerDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24);

        if (intent.context.emotionalWeight === "low" && daysFuture > 7) {
          debug("[HER Temporal] Skipping low-weight far-future event");
          return NextResponse.json({ detected: false, reason: "low-weight-far-future" });
        }
        if (daysFuture > 30) {
          debug("[HER Temporal] Skipping event >30 days out");
          return NextResponse.json({ detected: false, reason: "too-far-future" });
        }

        // ── Step 4: Persist scheduled event (with humanized timing) ──
        const eventId = await createScheduledEvent({
          userId: auth.userId,
          conversationId: conversationId || null,
          intent,
          originalMessage: message,
          applyVariance: true,
        });

        debug(
          `[HER Temporal] ${intent.type} detected for user ${auth.userId}: "${intent.context.summary}" → ${intent.triggerAt}`
        );

        return NextResponse.json({
          detected: true,
          type: intent.type,
          triggerAt: intent.triggerAt,
          summary: intent.context.summary,
          eventId,
        });
      }
    }

    // ── Predictive follow-up fallback (Step 18 Part D) ──
    // Only runs if the main detector didn't pick up an explicit promise/reminder.
    if (recentContext) {
      const followUp = await detectFollowUpIntent(message, recentContext, new Date(), apiKey, userTimezone);
      if (followUp?.shouldSchedule && followUp.estimatedTime && followUp.confidence >= 0.6) {
        const eventId = await createScheduledEvent({
          userId: auth.userId,
          conversationId: conversationId || null,
          intent: {
            type: "followup",
            triggerAt: followUp.estimatedTime,
            context: {
              summary: followUp.reasoning,
              emotionalWeight: "medium",
              category: "plan",
            },
          },
          originalMessage: message,
          applyVariance: true,
        });
        debug(`[HER Temporal] Predictive follow-up scheduled: "${followUp.reasoning}" → ${followUp.estimatedTime} (confidence: ${followUp.confidence})`);
        if (eventId) {
          return NextResponse.json({
            detected: true,
            type: "followup",
            triggerAt: followUp.estimatedTime,
            summary: followUp.reasoning,
            eventId,
            predictive: true,
          });
        }
      }
    }

    return NextResponse.json({ detected: false }, { status: 200 });
  } catch (err) {
    console.error("[HER Temporal] Error:", err);
    return NextResponse.json({ detected: false }, { status: 200 });
  }
}
