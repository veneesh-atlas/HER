/**
 * HER — Temporal Intent Detection
 *
 * Two-layer system:
 *   1. hasTemporalSignal() — cheap regex pre-check (no LLM call)
 *   2. detectTemporalIntent() — LLM-based structured extraction
 *
 * This powers HER's ability to remember user plans and follow up
 * naturally, like a close friend would.
 */

// ── Types ────────────────────────────────────────────────────

export type EventType = "reminder" | "followup" | "promise";
export type EmotionalWeight = "low" | "medium" | "high";
export type EventCategory = "event" | "task" | "plan" | "promise";

export interface TemporalIntent {
  type: EventType;
  /** ISO timestamp for when to trigger, or null if unclear */
  triggerAt: string | null;
  context: {
    summary: string;
    emotionalWeight: EmotionalWeight;
    category: EventCategory;
    /** Promise-only: short semantic description of what HER agreed to do/say */
    promiseIntent?: string;
    /** Promise-only: the user's original ask (for delivery context) */
    userRequest?: string;
    /** Promise-only: HER's confirming reply text (for voice continuity) */
    agentReply?: string;
  };
}

// ── Signal Gate (cheap pre-check) ──────────────────────────

/**
 * Fast regex check — returns true if the message contains any
 * time-like, future-intent, or event-like language.
 * If false, we skip the expensive LLM detection entirely.
 */
const TEMPORAL_WORDS =
  /\b(hour|hours|minute|minutes|tomorrow|tonight|today|morning|afternoon|evening|night|week|weeks|month|months|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|am|pm|o'?clock|\d{1,2}:\d{2}|\d{1,2}\/\d{1,2})\b/i;

const FUTURE_INTENT =
  /\b(going to|have to|need to|will|gotta|gonna|should|planning|plan to|scheduled|booked|booking|about to|supposed to|deadline|due|by the time|later|next|upcoming|in a few|in an? |promise|tell me|say|send me|message me|wish me|remind me)\b/i;

const EVENT_NOUNS =
  /\b(interview|meeting|appointment|exam|test|flight|trip|travel|doctor|dentist|class|lecture|presentation|deadline|wedding|birthday|party|reservation|call|date|workout|gym|pickup|drop.?off|checkout|check.?in)\b/i;

export function hasTemporalSignal(message: string): boolean {
  return (
    TEMPORAL_WORDS.test(message) ||
    FUTURE_INTENT.test(message) ||
    EVENT_NOUNS.test(message)
  );
}

// ── LLM-based Detection ────────────────────────────────────

const DETECTION_SYSTEM_PROMPT = `You analyze a user message (and HER's reply, if provided) to detect if they imply a future event, task, or PROMISE that may require a scheduled message.

Return ONLY valid JSON. No markdown, no explanation.

Do NOT assume intent unless it is reasonably clear.
Do NOT hallucinate or guess times. If the time is unclear, set triggerAt to null.
If there is no clear intent, return exactly: null

Classify into one of:
- "reminder" — a task the user must do (book tickets, call someone, submit work)
- "followup" — an event outcome to check on later (interview result, trip, exam)
- "promise" — the USER asked HER to do or say something specific at a future time
  (e.g. "tell me you love me in 2 hours", "send me a hype message at 5pm",
  "remind me you're proud of me tonight", "say good morning at 7am")

CRITICAL rules for "promise":
- ONLY classify as promise if the user clearly asked HER to take an action at a specific time
- ONLY confirm the promise if HER's reply (if provided) ACCEPTS or AGREES — if HER refused, declined, or ignored, return null
- promiseIntent must be a short semantic description of what HER will do ("say I love you", "send a poem about rain", "wish them luck for the meeting")
- userRequest must quote the user's ask, lightly cleaned
- agentReply (if provided) IS HER's confirming words — echo it verbatim in the agentReply field

Output format (use the fields appropriate to the type):
{
  "type": "reminder" | "followup" | "promise",
  "triggerAt": "ISO 8601 timestamp or null",
  "context": {
    "summary": "short natural 5-15 word summary",
    "emotionalWeight": "low" | "medium" | "high",
    "category": "event" | "task" | "plan" | "promise",
    "promiseIntent": "only for promise type",
    "userRequest": "only for promise type",
    "agentReply": "only for promise type, echo HER's confirming words"
  }
}

General rules:
- If no clear intent → return null
- If time is unclear → set triggerAt to null (do NOT guess)
- For promises, time MUST be clear — if not, return null (don't promise vaguely)
- "emotionalWeight" reflects how much it matters to the person
  (interview = high, grocery = low, promise of affection = high)`;

/**
 * Call the LLM to extract structured temporal intent from a message.
 * Returns null if no intent detected or on any failure.
 *
 * @param message      — the user's message text
 * @param now          — current absolute time
 * @param apiKey       — NVIDIA API key
 * @param userTimezone — IANA tz name; required to correctly resolve
 *                       wall-clock references like "tomorrow 9am"
 */
export async function detectTemporalIntent(
  message: string,
  now: Date,
  apiKey: string,
  userTimezone?: string,
  agentReply?: string
): Promise<TemporalIntent | null> {
  const { NVIDIA_CHAT_URL, NVIDIA_CHAT_MODEL } = await import("./provider");
  const { formatLocalTimeView, buildTemporalTimeHeader } = await import("./timezone");
  const timeHeader = buildTemporalTimeHeader(formatLocalTimeView(now, userTimezone));

  const replyBlock = agentReply
    ? `\n\nHER's reply (her confirming words — use this to validate any promise):\n"${agentReply}"`
    : "";
  const userPrompt = `${timeHeader}\n\nUser message:\n"${message}"${replyBlock}`;

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
          { role: "system", content: DETECTION_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 320,
        temperature: 0.1, // Low temp for structured output
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      console.warn("[HER Temporal] LLM detection failed:", res.status);
      return null;
    }

    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content?.trim();

    if (!raw || raw === "null") return null;

    // Parse JSON — handle potential markdown wrapping
    const jsonStr = raw.replace(/^```json?\s*/, "").replace(/\s*```$/, "");
    const parsed = JSON.parse(jsonStr);

    if (!parsed || !parsed.type || !parsed.context?.summary) return null;

    // Validate type
    if (!(["reminder", "followup", "promise"] as const).includes(parsed.type)) return null;

    // Promises require triggerAt + promiseIntent — anything weaker is unsafe to schedule
    if (parsed.type === "promise") {
      if (!parsed.triggerAt || !parsed.context?.promiseIntent) {
        console.warn("[HER Temporal] Promise rejected — missing triggerAt or promiseIntent");
        return null;
      }
    }

    return parsed as TemporalIntent;
  } catch (err) {
    console.warn("[HER Temporal] Detection error:", err);
    return null;
  }
}

// ── Event Resolution Detection ─────────────────────────────

import type { ScheduledEvent } from "./scheduled-events";

const RESOLUTION_SYSTEM_PROMPT = `You are analyzing whether a user's latest message indicates that a previously planned event or task has already been completed, cancelled, or is no longer relevant.

You are given:
1. The user's latest message
2. A list of pending events (each with an id, short summary, and type)

Your job:
- Identify if ANY of the events are no longer relevant
- Only mark an event as resolved if it is clearly implied
- Do NOT guess
- Do NOT assume completion unless it's reasonably clear

Return ONLY valid JSON:
{
  "resolvedEventIds": ["array of event IDs that are resolved"],
  "confidence": 0.0 to 1.0
}

If nothing is resolved, return:
{"resolvedEventIds": [], "confidence": 0.0}`;

/**
 * Check if a user's message resolves (completes/cancels) any pending events.
 * Returns array of event IDs that should be cancelled.
 */
export async function detectEventResolution(
  message: string,
  pendingEvents: ScheduledEvent[],
  apiKey: string
): Promise<string[]> {
  if (pendingEvents.length === 0) return [];

  const { NVIDIA_CHAT_URL, NVIDIA_CHAT_MODEL } = await import("./provider");

  const eventsJson = pendingEvents.map((e) => ({
    id: e.id,
    summary: e.context.summary,
    type: e.type,
  }));

  const userPrompt = `User message:\n"${message}"\n\nPending events:\n${JSON.stringify(eventsJson, null, 2)}`;

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
          { role: "system", content: RESOLUTION_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 150,
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) return [];

    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content?.trim();
    if (!raw) return [];

    const jsonStr = raw.replace(/^```json?\s*/, "").replace(/\s*```$/, "");
    const parsed = JSON.parse(jsonStr);

    // Only apply resolution if confidence > 0.7
    if (!parsed?.resolvedEventIds?.length || (parsed.confidence ?? 0) < 0.7) {
      return [];
    }

    // Cancel the resolved events
    const { cancelEvent } = await import("./scheduled-events");
    for (const eventId of parsed.resolvedEventIds) {
      await cancelEvent(eventId);
    }

    return parsed.resolvedEventIds;
  } catch (err) {
    console.warn("[HER Temporal] Resolution detection error:", err);
    return [];
  }
}

// ── Predictive Follow-Up Detection (Part D) ────────────────

export interface FollowUpIntent {
  shouldSchedule: boolean;
  estimatedTime: string | null;
  reasoning: string;
  confidence: number;
}

const FOLLOWUP_SYSTEM_PROMPT = `You analyze a user's reply to determine if they're implying they'll follow up later, without giving a specific time.

Examples of vague follow-up intent:
- "I'll tell you when I reach"
- "I'll check later"  
- "I'll update you tonight"
- "let me think about it"
- "I'll let you know how it goes"

Your job:
- Determine if they're implying a future update
- Estimate the most probable time window based on context
- Rate your confidence

Current date/time will be provided.

Return ONLY valid JSON:
{
  "shouldSchedule": true | false,
  "estimatedTime": "ISO 8601 timestamp or null",
  "reasoning": "brief explanation of your estimate",
  "confidence": 0.0 to 1.0
}

Rules:
- If no follow-up intent → shouldSchedule: false
- If timing is completely unclear → set estimatedTime to null
- Use context clues: "tonight" = ~9-10 PM, "later" = ~2-4 hours, "when I reach" = ~30-90 min
- Do NOT over-schedule. Only if genuinely implied.
- confidence < 0.5 → not worth scheduling`;

/**
 * Detect vague follow-up intent from a user reply and estimate timing.
 * Used for predictive scheduling when the user doesn't give an exact time.
 */
export async function detectFollowUpIntent(
  message: string,
  recentContext: string,
  now: Date,
  apiKey: string,
  userTimezone?: string
): Promise<FollowUpIntent | null> {
  const { NVIDIA_CHAT_URL, NVIDIA_CHAT_MODEL } = await import("./provider");
  const { formatLocalTimeView, buildTemporalTimeHeader } = await import("./timezone");
  const timeHeader = buildTemporalTimeHeader(formatLocalTimeView(now, userTimezone));

  const userPrompt = `${timeHeader}

Recent conversation context:
${recentContext}

User's latest message:
"${message}"

Analyze for follow-up intent.`;

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
          { role: "system", content: FOLLOWUP_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 200,
        temperature: 0.15,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) return null;

    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content?.trim();
    if (!raw) return null;

    const jsonStr = raw.replace(/^```json?\s*/, "").replace(/\s*```$/, "");
    const parsed = JSON.parse(jsonStr) as FollowUpIntent;

    if (!parsed.shouldSchedule || (parsed.confidence ?? 0) < 0.5) return null;

    return parsed;
  } catch (err) {
    console.warn("[HER Temporal] Follow-up detection error:", err);
    return null;
  }
}

// ── Continuity Learning (Part F) ───────────────────────────

export interface ContinuityUpdate {
  status: "completed" | "reschedule" | "ignore";
  newTime?: string;
}

const CONTINUITY_SYSTEM_PROMPT = `You analyze a user's message in relation to a pending scheduled event to determine what happened.

Determine:
- "completed" — the user did the thing or the event happened
- "reschedule" — the user is delaying or changing plans (extract new time if possible)
- "ignore" — the message is unrelated to the event

Return ONLY valid JSON:
{
  "status": "completed" | "reschedule" | "ignore",
  "newTime": "ISO 8601 timestamp or null (only for reschedule)"
}

Rules:
- Only return "completed" if clearly implied
- Only return "reschedule" if user indicates delay/change
- Default to "ignore" if uncertain`;

/**
 * Detect if a user's message indicates completion, rescheduling, or
 * abandonment of a specific pending event.
 */
export async function detectContinuityUpdate(
  message: string,
  eventSummary: string,
  now: Date,
  apiKey: string,
  userTimezone?: string
): Promise<ContinuityUpdate> {
  const { NVIDIA_CHAT_URL, NVIDIA_CHAT_MODEL } = await import("./provider");
  const { formatLocalTimeView, buildTemporalTimeHeader } = await import("./timezone");
  const timeHeader = buildTemporalTimeHeader(formatLocalTimeView(now, userTimezone));

  const userPrompt = `${timeHeader}

Pending event: "${eventSummary}"

User's message:
"${message}"

What's the status?`;

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
          { role: "system", content: CONTINUITY_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 100,
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(8_000),
    });

    if (!res.ok) return { status: "ignore" };

    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content?.trim();
    if (!raw) return { status: "ignore" };

    const jsonStr = raw.replace(/^```json?\s*/, "").replace(/\s*```$/, "");
    const parsed = JSON.parse(jsonStr) as ContinuityUpdate;

    if (!["completed", "reschedule", "ignore"].includes(parsed.status)) {
      return { status: "ignore" };
    }

    return parsed;
  } catch {
    return { status: "ignore" };
  }
}

// ── Step 17.4: Postponement Detection ──────────────────────

export interface PostponementResult {
  /** True if the user is postponing a recently-sent reminder. */
  shouldReschedule: boolean;
  /** ISO timestamp for the new fire time, or null if uncertain. */
  newTriggerAt: string | null;
  /** Short LLM-inferred reason ("user said 'in a bit'", "moved to evening"). */
  reason: string;
  /** 0–1 confidence; we only act on >= 0.6. */
  confidence: number;
}

const POSTPONEMENT_SYSTEM_PROMPT = `You analyze a user's reply to a reminder HER just sent to determine if they're postponing it.

You are given:
1. The reminder HER just sent (summary)
2. The user's reply
3. The current time + timezone

Examples of postponement:
- "I'll do it later" → ~+2 hours
- "not now" → ~+1 hour
- "in a bit" → ~+30 min
- "tonight" → user's local 8–9pm
- "tomorrow" → next day, similar time
- "after lunch" → user's local ~2pm
- "in 20 minutes" → +20 min exactly

NOT postponement (return shouldReschedule:false):
- "ok thanks" (acknowledged but ambiguous)
- "done" (completed, not postponed)
- "no" alone (ambiguous)
- unrelated topic
- positive engagement without time language

Return ONLY valid JSON:
{
  "shouldReschedule": true | false,
  "newTriggerAt": "ISO 8601 UTC timestamp or null",
  "reason": "short human phrase explaining the inferred new time",
  "confidence": 0.0 to 1.0
}

Rules:
- If unsure → shouldReschedule:false
- newTriggerAt MUST be in the future
- Resolve relative times in the user's local timezone, then convert to UTC
- confidence < 0.6 → not worth acting on`;

/**
 * Given a user message that may be postponing the most-recent sent reminder,
 * infer a new trigger time. Returns shouldReschedule:false when the message
 * doesn't look like a postponement.
 */
export async function detectPostponement(
  message: string,
  eventSummary: string,
  now: Date,
  apiKey: string,
  userTimezone?: string
): Promise<PostponementResult> {
  const NEGATIVE: PostponementResult = {
    shouldReschedule: false,
    newTriggerAt: null,
    reason: "",
    confidence: 0,
  };

  const { NVIDIA_CHAT_URL, NVIDIA_CHAT_MODEL } = await import("./provider");
  const { formatLocalTimeView, buildTemporalTimeHeader } = await import("./timezone");
  const timeHeader = buildTemporalTimeHeader(formatLocalTimeView(now, userTimezone));

  const userPrompt = `${timeHeader}

Reminder HER just sent: "${eventSummary}"

User's reply:
"${message}"

Is this a postponement? If yes, when do they want it instead?`;

  try {
    const res = await fetch(NVIDIA_CHAT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: NVIDIA_CHAT_MODEL,
        messages: [
          { role: "system", content: POSTPONEMENT_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 160,
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(8_000),
    });

    if (!res.ok) return NEGATIVE;

    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content?.trim();
    if (!raw) return NEGATIVE;

    const jsonStr = raw.replace(/^```json?\s*/, "").replace(/\s*```$/, "");
    const parsed = JSON.parse(jsonStr) as PostponementResult;

    if (!parsed?.shouldReschedule) return NEGATIVE;
    if ((parsed.confidence ?? 0) < 0.6) return NEGATIVE;
    if (!parsed.newTriggerAt) return NEGATIVE;

    // Validate: must be in the future
    const newDate = new Date(parsed.newTriggerAt);
    if (isNaN(newDate.getTime()) || newDate.getTime() <= now.getTime()) return NEGATIVE;

    return {
      shouldReschedule: true,
      newTriggerAt: parsed.newTriggerAt,
      reason: parsed.reason || "user-requested postponement",
      confidence: parsed.confidence,
    };
  } catch {
    return NEGATIVE;
  }
}
