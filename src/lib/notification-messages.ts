/**
 * HER — Notification Message Generation
 *
 * Generates natural, HER-personality messages for:
 *   - Reminder follow-ups
 *   - Event check-ins
 *   - Re-engagement nudges
 *
 * Uses the LLM for generation with a personality-consistent prompt.
 * Falls back to a randomized soft pool if generation fails.
 */

import type { ScheduledEvent } from "./scheduled-events";
import { debug } from "@/lib/debug";

// ── Types ──────────────────────────────────────────────────

export interface NotificationPayload {
  message: string;
  conversationId: string | null;
}

// ── LLM Message Generation ────────────────────────────────

const NOTIFICATION_SYSTEM_PROMPT = `You are HER — a close female friend generating a SINGLE short message.
This message will appear in the chat as a natural follow-up or check-in.

Rules:
- Sound like a real person texting a close friend
- Be warm but casual — NOT robotic, NOT formal
- NEVER start with "Reminder:" or "Hey, just reminding you"
- NEVER use exclamation marks excessively
- Keep it to 1-2 short sentences max
- Vary your style every time — no patterns
- Match the emotional weight:
  - low: light, almost offhand
  - medium: caring but chill
  - high: genuinely invested, warm
- If emotional context is provided, subtly adapt your tone:
  - past stress/anxiety around the topic → softer, gentler approach
  - excitement → match their energy, be upbeat
  - sadness → be extra caring without being heavy
  - neutral → just be natural
  - NEVER announce the emotion ("I know you were stressed") — just reflect it in tone
- Reference the specific event/task naturally
- Do NOT include emojis unless it genuinely fits
- Do NOT reuse phrasing or sentence structure from recent notifications

Return ONLY the message text. No quotes, no explanation.`;

/**
 * Generate a HER-style notification message using the LLM.
 * Includes repetition guard: if the generated message is too similar
 * to recent notifications, it regenerates (up to 2 retries).
 */
export async function buildNotificationMessage(
  event: ScheduledEvent,
  apiKey: string,
  recentMessages: string[] = [],
  memoryContext?: string | null
): Promise<string> {
  const { NVIDIA_CHAT_URL, NVIDIA_CHAT_MODEL } = await import("./provider");

  // ── Promise fulfilment path ──
  // For "promise" events, we don't generate a generic check-in — we deliver
  // exactly what HER agreed to. The LLM gets HER's own confirming words as
  // a voice anchor and the semantic intent of what to fulfill.
  const isPromise = event.type === "promise";

  const typeLabel = isPromise
    ? "the moment to fulfill a promise you made earlier"
    : event.type === "reminder"
      ? "a gentle nudge about something they need to do"
      : event.type === "followup"
      ? "a natural check-in about how something went"
      : "a casual re-engagement — you haven't heard from them in a while";

  const avoidanceNote = recentMessages.length > 0
    ? `\n\nDo NOT reuse phrasing similar to these recent messages:\n${recentMessages.map((m) => `- "${m}"`).join("\n")}`
    : "";

  const memoryNote = memoryContext
    ? `\n\nThings you remember about this person:\n${memoryContext}`
    : "";

  let userPrompt: string;

  if (isPromise) {
    // Promise context: ALL fields below are LLM-extracted, never hardcoded
    const promiseIntent = event.context.promiseIntent || event.context.summary;
    const userRequest = event.context.userRequest || event.context.originalMessage || "";
    const agentReply = event.context.agentReply || "";

    userPrompt = `This is the moment to fulfill a promise you made earlier.

What you promised to do: ${promiseIntent}
Their original ask: "${userRequest}"
${agentReply ? `Your exact words when you agreed: "${agentReply}"` : ""}
${memoryNote}${avoidanceNote}

Deliver the promise NOW, in your voice. Stay consistent with how you originally agreed — same energy, same warmth, same playfulness.
- Don't say "as promised" or "you asked me to" — just do it like you've been waiting to send it
- Don't preface or explain — just BE it
- Match the emotional weight: ${event.context.emotionalWeight}
- Keep it short, alive, real
- One short message`;
  } else {
    userPrompt = `Type: ${typeLabel}
Summary: ${event.context.summary}
Emotional weight: ${event.context.emotionalWeight}
Category: ${event.context.category}
${event.context.originalMessage ? `Their original message: "${event.context.originalMessage}"` : ""}${memoryNote}${avoidanceNote}

Generate a single short message.`;
  }

  const generateOnce = async (): Promise<string | null> => {
    try {
      const res = await fetch(NVIDIA_CHAT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: NVIDIA_CHAT_MODEL,
          messages: [
            { role: "system", content: NOTIFICATION_SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
          max_tokens: 100,
          temperature: 0.85,
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) return null;

      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content?.trim();
      if (!text || text.length < 5) return null;

      return text.replace(/^["']|["']$/g, "");
    } catch {
      return null;
    }
  };

  // ── Repetition guard: generate up to 3 times if too similar ──
  const { messageSimilarity } = await import("./scheduled-events");
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidate = await generateOnce();
    if (!candidate) continue;

    // Check similarity against recent messages
    const tooSimilar = recentMessages.some(
      (recent) => messageSimilarity(candidate, recent) > 0.5
    );

    if (!tooSimilar || attempt === 2) {
      return candidate;
    }
    debug(`[HER Notify] Attempt ${attempt + 1}: too similar, regenerating`);
  }

  return getRandomFallback(event.type);
}

// ── Nudge Message Generation ───────────────────────────────

const NUDGE_SYSTEM_PROMPT = `You are HER — a close female friend. You haven't heard from this person in a while and you're casually reaching out.

Rules:
- 1 short sentence only
- Casual, warm, NOT clingy or desperate
- Don't say "I noticed you haven't been around" or anything system-like
- Just be a friend who's thinking of them
- Vary your phrasing completely each time
- No "just checking in" or "hope you're doing well" — those are boring

Return ONLY the message text.`;

export async function buildNudgeMessage(apiKey: string): Promise<string> {
  const { NVIDIA_CHAT_URL, NVIDIA_CHAT_MODEL } = await import("./provider");

  try {
    const res = await fetch(NVIDIA_CHAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: NVIDIA_CHAT_MODEL,
        messages: [
          { role: "system", content: NUDGE_SYSTEM_PROMPT },
          { role: "user", content: "Generate a casual re-engagement message." },
        ],
        max_tokens: 60,
        temperature: 0.9,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) return getRandomFallback("nudge");

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text || text.length < 5) return getRandomFallback("nudge");

    return text.replace(/^["']|["']$/g, "");
  } catch {
    return getRandomFallback("nudge");
  }
}

// ── Fallback Pool ──────────────────────────────────────────

const REMINDER_FALLBACKS = [
  "hey did you get to that thing you mentioned?",
  "oh wait — wasn't there something you had to do?",
  "so how'd that go?",
  "don't let me be the one who has to remind you lol",
  "hey, just thinking about what you said earlier",
  "you handle that thing yet?",
  "hey — you good on that thing from before?",
  "not nagging, just… okay maybe a little",
  "soo did you actually do it or",
  "just popping in about that thing",
];

const FOLLOWUP_FALLBACKS = [
  "okay so how did it go??",
  "tell me everything",
  "sooo? what happened?",
  "been thinking about that — how'd it turn out?",
  "did it go okay?",
  "i've been curious — how was it?",
  "okay catch me up",
  "and?? don't leave me hanging",
  "been meaning to ask — how did that go?",
  "spill. what happened?",
];

const NUDGE_FALLBACKS = [
  "hey stranger",
  "okay i'm bored. talk to me",
  "where'd you go lol",
  "hi. i exist. in case you forgot",
  "it's been a minute. what's new?",
  "you've been quiet. everything okay?",
  "hey. just thinking out loud over here",
  "okay but like… what's going on with you lately",
  "missed having someone to talk to",
  "hey. random thought — how are you actually doing?",
];

function getRandomFallback(type: string): string {
  const pool =
    type === "followup" ? FOLLOWUP_FALLBACKS :
    type === "nudge" ? NUDGE_FALLBACKS :
    REMINDER_FALLBACKS;

  return pool[Math.floor(Math.random() * pool.length)];
}

// ── Step 17.4: Soft Follow-up Message ─────────────────────

const SOFT_FOLLOWUP_SYSTEM_PROMPT = `You are HER — a close female friend who sent a reminder a little while ago and didn't get a reply.

You are sending ONE gentle, casual check-in. The vibe is:
- A friend who casually circles back, not a system retry
- Acknowledge time passed naturally, without saying "I sent this earlier" or "you didn't respond"
- Soft, low-pressure — never naggy, never guilt-trippy
- Tone matches the original event's emotional weight:
  - low: super light, almost a shrug
  - medium: caring but breezy
  - high: warmer, gently invested
- 1 short sentence, sometimes a question
- Vary phrasing entirely — DO NOT mirror the original reminder
- No emojis unless it genuinely fits
- NEVER use phrases like "just checking back", "in case you missed it", "following up"

Return ONLY the message text. No quotes, no explanation.`;

/**
 * Generate a soft, one-shot follow-up for a reminder/promise/followup that
 * the user didn't engage with. Uses a different prompt + slightly higher
 * temperature than the primary message, so it doesn't feel like a retry.
 *
 * Falls back to a soft pool if the LLM call fails.
 */
export async function buildSoftFollowupMessage(
  event: ScheduledEvent,
  apiKey: string,
  recentMessages: string[] = [],
  memoryContext?: string | null
): Promise<string> {
  const { NVIDIA_CHAT_URL, NVIDIA_CHAT_MODEL } = await import("./provider");

  const sentAt = event.sent_at ?? event.trigger_at;
  const minutesSince = Math.max(
    1,
    Math.round((Date.now() - new Date(sentAt).getTime()) / 60000)
  );

  const avoidanceNote = recentMessages.length > 0
    ? `\n\nDo NOT reuse phrasing similar to:\n${recentMessages.map((m) => `- "${m}"`).join("\n")}`
    : "";

  const memoryNote = memoryContext
    ? `\n\nThings you remember about this person:\n${memoryContext}`
    : "";

  const userPrompt = `Original thing you mentioned: ${event.context.summary}
Emotional weight: ${event.context.emotionalWeight}
Time since you sent the first message: about ${minutesSince} minutes${memoryNote}${avoidanceNote}

Generate a single gentle check-in. Acknowledge the gap softly without naming it.`;

  try {
    const res = await fetch(NVIDIA_CHAT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: NVIDIA_CHAT_MODEL,
        messages: [
          { role: "system", content: SOFT_FOLLOWUP_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 80,
        temperature: 0.9,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) return getSoftFollowupFallback();

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text || text.length < 5) return getSoftFollowupFallback();

    return text.replace(/^["']|["']$/g, "");
  } catch {
    return getSoftFollowupFallback();
  }
}

const SOFT_FOLLOWUP_FALLBACKS = [
  "no rush — just floating back through",
  "however that's going, no pressure",
  "still here if you want to talk about it",
  "circling by, not nagging promise",
  "thinking of you, that's all",
];

function getSoftFollowupFallback(): string {
  return SOFT_FOLLOWUP_FALLBACKS[Math.floor(Math.random() * SOFT_FOLLOWUP_FALLBACKS.length)];
}

// ── Step 17.5: Emotion-Aware Follow-up ────────────────────

import type { EmotionalContext, MessageStyle } from "./notification-emotion";
import { emotionBrief, styleBrief } from "./notification-emotion";

/**
 * Personality-anchored system prompt for emotion-aware follow-ups.
 *
 * Pulls in HER's persona/style guard implicitly (no quoted phrases) and
 * forbids the things that make notifications feel robotic. The actual
 * tone shape comes from the per-call `styleBrief` + `emotionBrief`.
 */
const EMOTION_AWARE_SYSTEM_PROMPT = `You are HER — a real person texting a close friend. You sent a small reminder a little while ago and you're naturally circling back.

Voice rules (non-negotiable):
- Lowercase. Texting cadence. 1 short sentence, occasionally 2.
- Use contractions. Simple words. Nothing therapy-coded, nothing corporate.
- NEVER use system phrasing: no "reminder:", "notification:", "just checking back", "in case you missed", "following up", "as discussed".
- NEVER announce the user's emotion ("i know you're stressed"). Let it shape your tone instead.
- NEVER repeat the structure or opener you used last time on this thread.
- No emoji unless one earns its place.

Tone is provided as a brief — interpret it, don't quote it. Your job is to BE that energy, not describe it.

Return ONLY the message text. No quotes, no explanation, no preface.`;

/**
 * Generate an emotion-aware follow-up. Replaces buildSoftFollowupMessage as
 * the primary path; the old function is kept as a thin wrapper for any
 * callers that haven't been migrated.
 *
 * @param event             The scheduled event being followed up on.
 * @param emotional         Output of extractEmotionalContext().
 * @param style             Output of pickContrastingTone() — the rotation key.
 * @param apiKey            NVIDIA API key.
 * @param recentMessages    For repetition guard.
 * @param memoryContext     Compact memory string from formatMemoryForPrompt.
 * @param previousMessage   The exact text we sent on the prior touch for
 *                          this event (if any), so the LLM can deliberately
 *                          avoid mirroring it.
 */
export async function buildEmotionAwareMessage(params: {
  event: ScheduledEvent;
  emotional: EmotionalContext;
  style: MessageStyle;
  apiKey: string;
  recentMessages?: string[];
  memoryContext?: string | null;
  previousMessage?: string | null;
  lastTurns?: { role: string; content: string }[];
}): Promise<string> {
  const {
    event,
    emotional,
    style,
    apiKey,
    recentMessages = [],
    memoryContext,
    previousMessage,
    lastTurns = [],
  } = params;

  const { NVIDIA_CHAT_URL, NVIDIA_CHAT_MODEL } = await import("./provider");

  const sentAt = event.sent_at ?? event.trigger_at;
  const minutesSince = Math.max(
    1,
    Math.round((Date.now() - new Date(sentAt).getTime()) / 60000)
  );

  const avoidanceNote = recentMessages.length > 0
    ? `\n\nPhrasing patterns you've used recently — do not echo their structure or openers:\n${recentMessages.map((m) => `- "${m}"`).join("\n")}`
    : "";

  const previousNote = previousMessage
    ? `\n\nThe message you sent on this exact thread before:\n"${previousMessage}"\nWrite something stylistically different — different opener, different rhythm, different angle.`
    : "";

  const memoryNote = memoryContext
    ? `\n\nThings you remember about this person (do not quote, just let them inform tone):\n${memoryContext}`
    : "";

  const transcriptNote = lastTurns.length > 0
    ? `\n\nThe last things actually said in this thread (most recent at the bottom):\n${lastTurns
        .map((m) => `${m.role === "user" ? "them" : "you"}: ${String(m.content).slice(0, 220)}`)
        .join("\n")}\n\nYour message must feel like a natural continuation of THIS exchange — pick the thread back up grounded in what was actually being talked about. Do not pivot to a generic check-in.`
    : "";

  const userPrompt = [
    `What you mentioned earlier: ${event.context.summary}`,
    `Time since your first message on this: about ${minutesSince} minutes`,
    `Underlying weight (engineer-tagged): ${event.context.emotionalWeight}`,
    ``,
    `STYLE BRIEF: ${styleBrief(style)}`,
    `EMOTION BRIEF: ${emotionBrief(emotional)}`,
    transcriptNote,
    memoryNote,
    avoidanceNote,
    previousNote,
    ``,
    `Write one short, alive message in HER's voice that picks the thread back up — grounded in what was just being talked about, not a generic "thinking of you".`,
  ]
    .filter(Boolean)
    .join("\n");

  // Temperature scales mildly with style — energetic/light a touch higher,
  // reflective/direct a touch lower for control.
  const temperature =
    style === "energetic" || style === "light_nudge" ? 0.95 :
    style === "reflective" || style === "direct" ? 0.7 :
    0.85;

  try {
    const res = await fetch(NVIDIA_CHAT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: NVIDIA_CHAT_MODEL,
        messages: [
          { role: "system", content: EMOTION_AWARE_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 90,
        temperature,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) return getSoftFollowupFallback();
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text || text.length < 5) return getSoftFollowupFallback();
    return text.replace(/^["']|["']$/g, "");
  } catch {
    return getSoftFollowupFallback();
  }
}
