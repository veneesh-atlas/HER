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
} from "@/lib/temporal";
import { createScheduledEvent, getPendingEventsForUser, cancelEvent } from "@/lib/scheduled-events";

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

    if (!message || typeof message !== "string") {
      return NextResponse.json({ detected: false }, { status: 200 });
    }

    const apiKey = process.env.NVIDIA_CHAT_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ detected: false }, { status: 200 });
    }

    // ── Event Resolution: check if this message resolves pending events ──
    const pendingEvents = await getPendingEventsForUser(auth.userId);
    if (pendingEvents.length > 0) {
      // Full resolution check (completed/cancelled)
      const resolved = await detectEventResolution(message, pendingEvents, apiKey);
      if (resolved.length > 0) {
        console.log(`[HER Temporal] Resolved ${resolved.length} events for user ${auth.userId}`);
      }

      // ── Continuity learning (Step 18 Part F): detect reschedules ──
      for (const event of pendingEvents) {
        if (resolved.includes(event.id)) continue; // Already resolved
        const update = await detectContinuityUpdate(message, event.context.summary, new Date(), apiKey, userTimezone);
        if (update.status === "completed") {
          await cancelEvent(event.id);
          console.log(`[HER Temporal] Continuity: event ${event.id} completed`);
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
          console.log(`[HER Temporal] Continuity: event ${event.id} rescheduled → ${update.newTime}`);
        }
      }
    }

    // ── Predictive follow-up (Step 18 Part D): detect vague future intent ──
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
        console.log(`[HER Temporal] Predictive follow-up scheduled: "${followUp.reasoning}" → ${followUp.estimatedTime} (confidence: ${followUp.confidence})`);
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

    // ── Step 1: Cheap signal gate ──
    if (!hasTemporalSignal(message)) {
      return NextResponse.json({ detected: false }, { status: 200 });
    }

    // ── Step 2: LLM-based detection ──
    const intent = await detectTemporalIntent(message, new Date(), apiKey, userTimezone, agentReply);

    if (!intent || !intent.triggerAt) {
      return NextResponse.json({ detected: false }, { status: 200 });
    }

    // ── Step 3: Selective triggering filter ──
    // Skip low-confidence, low-weight, or far-future events
    const triggerDate = new Date(intent.triggerAt);
    const daysFuture = (triggerDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24);

    if (intent.context.emotionalWeight === "low" && daysFuture > 7) {
      console.log("[HER Temporal] Skipping low-weight far-future event");
      return NextResponse.json({ detected: false, reason: "low-weight-far-future" });
    }
    if (daysFuture > 30) {
      console.log("[HER Temporal] Skipping event >30 days out");
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

    console.log(
      `[HER Temporal] ${intent.type} detected for user ${auth.userId}: "${intent.context.summary}" → ${intent.triggerAt}`
    );

    return NextResponse.json({
      detected: true,
      type: intent.type,
      triggerAt: intent.triggerAt,
      summary: intent.context.summary,
      eventId,
    });
  } catch (err) {
    console.error("[HER Temporal] Error:", err);
    return NextResponse.json({ detected: false }, { status: 200 });
  }
}
