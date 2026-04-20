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
    console.log(`[HER Notify] Attempt ${attempt + 1}: too similar, regenerating`);
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
