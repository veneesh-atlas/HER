/**
 * HER — Notification Emotion Layer (Step 17.5)
 *
 * Lightweight, opinionated helpers that make scheduled notifications feel
 * emotionally aware without adding heavy pipelines:
 *
 *   1. extractEmotionalContext()       — one short LLM call → structured tone
 *   2. getDynamicFollowupThreshold()   — rule-based, zero LLM
 *   3. pickContrastingTone()           — anti-repetition style rotation
 *
 * Design constraints (Step 17.5 Part H):
 *   - Reuse the existing NVIDIA chat provider; no new deps.
 *   - Cap the extraction call at ~1.5s with a hard timeout — fall back to
 *     a neutral context on any failure so we never block delivery.
 *   - Threshold + tone rotation are pure functions: free, deterministic,
 *     and trivially testable.
 */

import type { ScheduledEvent } from "./scheduled-events";
import { getSupabaseClient } from "./supabase-client";

// ── Types ──────────────────────────────────────────────────

export type EmotionalTone =
  | "anxious"
  | "stressed"
  | "excited"
  | "low_energy"
  | "neutral";

export type UserState = "busy" | "distracted" | "overwhelmed" | "relaxed" | "unknown";

export type MessageStyle =
  | "direct"        // clear and a touch firm — for high-stakes / important
  | "casual"        // breezy, default
  | "reflective"    // thoughtful, slower cadence — for low-energy / heavy
  | "light_nudge"   // featherweight, almost a shrug
  | "energetic";    // matches excitement

export interface EmotionalContext {
  tone: EmotionalTone;
  /** True when the underlying event genuinely matters to the user. */
  important: boolean;
  userState: UserState;
  /** 0–1; gates whether we trust the extraction enough to act on it. */
  confidence: number;
}

const NEUTRAL_CONTEXT: EmotionalContext = {
  tone: "neutral",
  important: false,
  userState: "unknown",
  confidence: 0,
};

// ── Part A: Emotional Context Extraction ───────────────────

const EMOTION_SYSTEM_PROMPT = `You read a short slice of a conversation and the underlying event the assistant is about to follow up on. Return a compact emotional read.

Return ONLY valid JSON (no markdown):
{
  "tone": "anxious" | "stressed" | "excited" | "low_energy" | "neutral",
  "important": true | false,
  "userState": "busy" | "distracted" | "overwhelmed" | "relaxed" | "unknown",
  "confidence": 0.0 to 1.0
}

Rules:
- Default to {"tone":"neutral","important":false,"userState":"unknown","confidence":0.4} if signals are weak.
- "important" is about the EVENT, not the message ("interview"/"flight"/"exam" → true).
- Do NOT invent emotions. If the user sounds level, say neutral.
- confidence < 0.5 means "I'm guessing" — caller will downgrade behaviour.`;

/**
 * Pull recent conversation snippets (assistant + user) for a user's most
 * recent conversation. Capped at ~6 messages and ~1200 chars total to keep
 * the LLM call cheap.
 */
async function getRecentConversationSlice(
  userId: string,
  conversationId: string | null
): Promise<string> {
  const client = getSupabaseClient();
  if (!client || !conversationId) return "";

  try {
    const { data } = await client
      .from("messages")
      .select("role, content, created_at")
      .eq("user_id", userId)
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(6);
    if (!data) return "";
    return (data as Array<{ role: string; content: string }>)
      .reverse()
      .map((m) => `${m.role}: ${String(m.content).slice(0, 200)}`)
      .join("\n");
  } catch {
    return "";
  }
}

/**
 * Extract an EmotionalContext for a scheduled event.
 *
 * Cost: one chat-completion call, ~150 tokens out, hard 1500ms timeout.
 * Falls back to NEUTRAL_CONTEXT on any failure — we never block delivery.
 */
export async function extractEmotionalContext(
  event: ScheduledEvent,
  apiKey: string
): Promise<EmotionalContext> {
  try {
    const { NVIDIA_CHAT_URL, NVIDIA_CHAT_MODEL } = await import("./provider");

    const recentSlice = await getRecentConversationSlice(event.user_id, event.conversation_id);
    const userPrompt = [
      `Event the assistant is about to follow up on:`,
      `  summary: ${event.context.summary}`,
      `  category: ${event.context.category}`,
      `  emotionalWeight (engineer-tagged): ${event.context.emotionalWeight}`,
      event.context.originalMessage
        ? `  user's original message: "${event.context.originalMessage}"`
        : "",
      "",
      recentSlice ? `Recent conversation:\n${recentSlice}` : "No recent conversation context.",
    ]
      .filter(Boolean)
      .join("\n");

    const res = await fetch(NVIDIA_CHAT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: NVIDIA_CHAT_MODEL,
        messages: [
          { role: "system", content: EMOTION_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 120,
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(1500),
    });

    if (!res.ok) return NEUTRAL_CONTEXT;
    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content?.trim();
    if (!raw) return NEUTRAL_CONTEXT;

    const jsonStr = raw.replace(/^```json?\s*/, "").replace(/\s*```$/, "");
    const parsed = JSON.parse(jsonStr) as Partial<EmotionalContext>;

    const tone: EmotionalTone =
      (["anxious", "stressed", "excited", "low_energy", "neutral"] as const).includes(
        parsed.tone as EmotionalTone
      )
        ? (parsed.tone as EmotionalTone)
        : "neutral";

    const userState: UserState =
      (["busy", "distracted", "overwhelmed", "relaxed", "unknown"] as const).includes(
        parsed.userState as UserState
      )
        ? (parsed.userState as UserState)
        : "unknown";

    const confidenceRaw = Number(parsed.confidence ?? 0.4);
    const confidence = Number.isFinite(confidenceRaw)
      ? Math.max(0, Math.min(1, confidenceRaw))
      : 0.4;

    const ctx: EmotionalContext = {
      tone,
      important: !!parsed.important || event.context.emotionalWeight === "high",
      userState,
      confidence,
    };

    console.log("[HER Emotion] Context Extracted", {
      eventId: event.id,
      tone: ctx.tone,
      important: ctx.important,
      userState: ctx.userState,
      confidence: ctx.confidence,
    });

    return ctx;
  } catch {
    return NEUTRAL_CONTEXT;
  }
}

// ── Part C: Dynamic Follow-up Threshold ────────────────────

/** Smallest threshold we'll ever return — protects against accidental spam. */
const MIN_THRESHOLD_MS = 12 * 60 * 1000;
/** Largest threshold — past this the user has clearly moved on. */
const MAX_THRESHOLD_MS = 90 * 60 * 1000;

/**
 * Decide how long to wait after `sent_at` before we consider an event
 * "missed" enough to send a soft follow-up. Pure rules — no LLM.
 *
 * Base = 30 min (matches Step 17.4). Adjustments stack but get clamped
 * to [MIN, MAX].
 *
 * @param ignoredCount  Number of low-priority pings the user has ignored
 *                       in the last 24h (from countIgnoredLowPriority24h).
 *                       Higher → expand the interval to avoid hassling.
 */
export function getDynamicFollowupThreshold(
  event: Pick<ScheduledEvent, "type" | "context">,
  emotional: EmotionalContext,
  ignoredCount: number = 0
): number {
  let ms = 30 * 60 * 1000; // base

  // Anxious / stressed users want a quicker, gentler nudge.
  if (emotional.tone === "anxious" || emotional.tone === "stressed") {
    ms = 18 * 60 * 1000;
  }

  // Low-energy or distracted users — give them more breathing room.
  if (emotional.tone === "low_energy" || emotional.userState === "overwhelmed") {
    ms = Math.max(ms, 50 * 60 * 1000);
  }

  // Low-priority types (followup) — slower follow-ups.
  if (event.type === "followup") {
    ms = Math.max(ms, 45 * 60 * 1000);
  }

  // High emotional weight — tighter window so we don't leave them hanging.
  if (event.context.emotionalWeight === "high" || emotional.important) {
    ms = Math.min(ms, 22 * 60 * 1000);
  }

  // Repeated ignores → back off.
  if (ignoredCount >= 2) ms += 15 * 60 * 1000;
  if (ignoredCount >= 4) ms += 20 * 60 * 1000;

  const clamped = Math.max(MIN_THRESHOLD_MS, Math.min(MAX_THRESHOLD_MS, ms));

  console.log("[HER Emotion] Threshold Adjusted", {
    type: event.type,
    tone: emotional.tone,
    weight: event.context.emotionalWeight,
    ignoredCount,
    thresholdMin: Math.round(clamped / 60000),
  });

  return clamped;
}

// ── Part D: Contextual Rephrasing — Tone Rotation ──────────

const STYLE_ROTATION: Record<MessageStyle, MessageStyle> = {
  direct: "casual",
  casual: "reflective",
  reflective: "light_nudge",
  light_nudge: "energetic",
  energetic: "casual",
};

/**
 * Pick a message style for THIS follow-up. If we know the previous style
 * (stored on the event by the cron), rotate to a contrasting one. Otherwise
 * derive a sensible style from the emotional context.
 */
export function pickContrastingTone(
  emotional: EmotionalContext,
  previousStyle?: MessageStyle | null
): MessageStyle {
  // If we already used a style on this event, deliberately move off it.
  if (previousStyle && STYLE_ROTATION[previousStyle]) {
    const next = STYLE_ROTATION[previousStyle];
    console.log("[HER Emotion] Tone Applied", {
      previousStyle,
      chosenStyle: next,
      rotation: true,
    });
    return next;
  }

  // First-touch — derive from emotional read.
  let style: MessageStyle = "casual";
  if (emotional.tone === "anxious" || emotional.tone === "stressed") style = "reflective";
  else if (emotional.tone === "excited") style = "energetic";
  else if (emotional.tone === "low_energy") style = "light_nudge";
  else if (emotional.important) style = "direct";

  console.log("[HER Emotion] Tone Applied", {
    previousStyle: null,
    chosenStyle: style,
    rotation: false,
  });
  return style;
}

// ── Style Briefs (consumed by the message LLM) ─────────────

/**
 * Short, behavioural brief for the chat LLM. NOT a template — just guardrails.
 * The actual phrasing is always generated; nothing here is sent verbatim.
 */
export function styleBrief(style: MessageStyle): string {
  switch (style) {
    case "direct":
      return "Be a touch more direct than usual. Still warm, still you. One clear sentence is fine.";
    case "casual":
      return "Default texture: casual, light, like you're texting a close friend mid-day.";
    case "reflective":
      return "Slower cadence. Acknowledge the moment without naming it. Fewer words, more weight.";
    case "light_nudge":
      return "Featherweight. Almost a shrug. Don't ask anything heavy.";
    case "energetic":
      return "Match their energy — a little bright, a little playful. Don't overdo it.";
  }
}

/**
 * Short brief on the user's emotional state for the chat LLM. Again, NOT
 * a template — the LLM uses this to colour tone, never to repeat words.
 */
export function emotionBrief(ctx: EmotionalContext): string {
  if (ctx.confidence < 0.4) return "No strong emotional read — be your normal self.";

  const stateBits: string[] = [];
  if (ctx.tone === "anxious") stateBits.push("they may be anxious — soften the edges, no pressure");
  if (ctx.tone === "stressed") stateBits.push("they sound stretched thin — be gentle, not heavy");
  if (ctx.tone === "excited") stateBits.push("they're in good spirits — match the energy without overdoing it");
  if (ctx.tone === "low_energy") stateBits.push("low-energy vibe — keep it tiny and undemanding");
  if (ctx.userState === "busy") stateBits.push("they're busy — get in and out quickly");
  if (ctx.userState === "overwhelmed") stateBits.push("they're overwhelmed — explicitly give them an out");
  if (ctx.important) stateBits.push("the underlying thing actually matters to them — show you remember why");

  if (stateBits.length === 0) return "Read is neutral — be your normal self.";
  return stateBits.join("; ") + ". Never name the emotion out loud — just let it shape your tone.";
}
