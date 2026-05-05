/**
 * HER — Interaction Signal Extraction & Storage (Step EXP+1)
 *
 * Extracts BEHAVIORAL signals from each turn and stores them.
 *
 * STRICT RULES:
 *   - We DO NOT store emotion labels (no happy/sad/angry/etc.)
 *   - We only store observable interaction patterns and engagement signals
 *   - Extraction is best-effort: any failure is silent and non-blocking
 *
 * The signals are read back into the system prompt as a compact "RECENT
 * INTERACTION TEXTURE" block so HER's behavior subtly evolves over time
 * without rigid rules or emotion classification.
 */

import { getSupabaseClient } from "./supabase-client";
import { nvidiaChat } from "./multimodal";
import { debug } from "./debug";

// ── Allowed Values (single source of truth) ────────────────

export const INTERACTION_PATTERNS = [
  "repetitive",
  "exploratory",
  "goal_oriented",
  "uncertain",
  "multi_topic",
  "deepening",
  "casual",
] as const;

export const ENGAGEMENT_TRENDS = [
  "increasing",
  "stable",
  "decreasing",
  "fluctuating",
] as const;

export const USER_INTENT_CLARITIES = [
  "clear",
  "somewhat_clear",
  "unclear",
  "shifting",
] as const;

export const RESPONSE_STYLES = [
  "short",
  "balanced",
  "detailed",
  "playful",
  "serious",
  "direct",
] as const;

export const CONVERSATION_SHIFTS = [
  "none",
  "topic_change",
  "tone_shift",
  "goal_change",
] as const;

export type InteractionPattern = (typeof INTERACTION_PATTERNS)[number];
export type EngagementTrend = (typeof ENGAGEMENT_TRENDS)[number];
export type UserIntentClarity = (typeof USER_INTENT_CLARITIES)[number];
export type ResponseStyle = (typeof RESPONSE_STYLES)[number];
export type ConversationShift = (typeof CONVERSATION_SHIFTS)[number];

export interface InteractionSignal {
  interactionPattern: InteractionPattern;
  engagementTrend: EngagementTrend;
  userIntentClarity: UserIntentClarity;
  responseStyle: ResponseStyle;
  conversationShift: ConversationShift;
  confidence: number;
}

export interface StoredInteractionSignal extends InteractionSignal {
  id?: string;
  user_id?: string;
  conversation_id?: string | null;
  message_id?: string | null;
  created_at?: string;
}

// ── Emotion-Word Guard ─────────────────────────────────────

/**
 * Banned tokens — if any of these appear in the model's raw output we
 * reject the extraction. This is a hard guard against the LLM smuggling
 * emotion labels into a "pattern" field despite the prompt forbidding it.
 *
 * Word-boundary checked to avoid catching "happy_path" style false hits
 * in unrelated text — but we only ever scan the JSON values, not the
 * surrounding prose, so collisions are unlikely in practice.
 */
const EMOTION_WORDS = [
  "happy", "sad", "angry", "anxious", "afraid", "scared", "fearful",
  "joy", "joyful", "depressed", "depression", "lonely", "loneliness",
  "frustrated", "frustration", "annoyed", "annoyance", "irritated",
  "excited", "excitement", "bored", "boredom", "tired", "exhausted",
  "love", "hate", "disgusted", "disgust", "ashamed", "shame",
  "guilty", "guilt", "proud", "pride", "hopeful", "hopeless",
  "calm", "stressed", "stress", "worried", "worry", "nervous",
  "content", "miserable", "ecstatic", "upset", "hurt", "grief",
  "emotion", "emotional", "feeling", "feelings", "mood",
];

const EMOTION_RE = new RegExp(
  `\\b(${EMOTION_WORDS.join("|")})\\b`,
  "i"
);

function containsEmotionWord(text: string): boolean {
  return EMOTION_RE.test(text);
}

/** Test-only export of the emotion-word guard (Step EXP+2 verification). */
export const _containsEmotionWord = containsEmotionWord;

// ── Validation ─────────────────────────────────────────────

/**
 * Validate and coerce a raw object into a strict InteractionSignal.
 * Returns null if any required field is missing, out-of-range, or contains
 * a banned emotion word.
 */
export function validateSignal(raw: unknown): InteractionSignal | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  const pattern = String(obj.interactionPattern ?? "").toLowerCase().trim();
  const trend = String(obj.engagementTrend ?? "").toLowerCase().trim();
  const clarity = String(obj.userIntentClarity ?? "").toLowerCase().trim();
  const style = String(obj.responseStyle ?? "").toLowerCase().trim();
  const shift = String(obj.conversationShift ?? "").toLowerCase().trim();

  if (!(INTERACTION_PATTERNS as readonly string[]).includes(pattern)) return null;
  if (!(ENGAGEMENT_TRENDS as readonly string[]).includes(trend)) return null;
  if (!(USER_INTENT_CLARITIES as readonly string[]).includes(clarity)) return null;
  if (!(RESPONSE_STYLES as readonly string[]).includes(style)) return null;
  if (!(CONVERSATION_SHIFTS as readonly string[]).includes(shift)) return null;

  const conf = Number(obj.confidence);
  if (!Number.isFinite(conf) || conf < 0 || conf > 1) return null;

  return {
    interactionPattern: pattern as InteractionPattern,
    engagementTrend: trend as EngagementTrend,
    userIntentClarity: clarity as UserIntentClarity,
    responseStyle: style as ResponseStyle,
    conversationShift: shift as ConversationShift,
    confidence: conf,
  };
}

// ── Extraction Prompt ──────────────────────────────────────

const EXTRACTION_PROMPT = `You analyze the BEHAVIOR of a chat conversation. You output ONLY structured JSON.

ABSOLUTE RULES — break any of these and the output is rejected:
- DO NOT output emotion labels. Never use words like: happy, sad, angry, anxious, frustrated, excited, lonely, stressed, hurt, mood, feeling, etc.
- DO NOT infer feelings. Only describe observable interaction behavior.
- Output ONLY a single JSON object. No prose, no markdown fences, no explanation.

You return a JSON object with EXACTLY these fields and EXACTLY these allowed values:

{
  "interactionPattern": one of ["repetitive","exploratory","goal_oriented","uncertain","multi_topic","deepening","casual"],
  "engagementTrend":    one of ["increasing","stable","decreasing","fluctuating"],
  "userIntentClarity":  one of ["clear","somewhat_clear","unclear","shifting"],
  "responseStyle":      one of ["short","balanced","detailed","playful","serious","direct"],
  "conversationShift":  one of ["none","topic_change","tone_shift","goal_change"],
  "confidence":         number between 0 and 1
}

Field meanings:
- interactionPattern  → observable user behavior across the recent turns
- engagementTrend     → how the back-and-forth is evolving
- userIntentClarity   → how clear the user's goal/topic is from their words
- responseStyle       → how HER's latest reply was shaped (length/register)
- conversationShift   → whether this turn marks a transition from the previous turn
- confidence          → your certainty. If unsure, return 0.5 or lower.

DISAMBIGUATION (read carefully):
- "repetitive"   = user keeps restating the same point or asking the same thing
- "exploratory"  = user is curious, poking around ideas with no fixed goal yet
- "goal_oriented"= user is clearly trying to accomplish a concrete task
- "uncertain"    = user knows roughly what they want but is hedging or second-guessing
- "unclear"      (clarity field) = the WORDS themselves are ambiguous — you can't tell what they mean
- "uncertain"    vs "unclear": uncertain is about the user's confidence; unclear is about the message itself
- "multi_topic"  = user jumped between two or more unrelated topics in a short span
- "exploratory"  vs "multi_topic": exploratory stays within one topic and digs in; multi_topic switches between several
- "deepening"    = the conversation got more personal, reflective, or substantive
- "deepening"    vs "goal_oriented": deepening is about emotional/reflective depth, not task completion
- "casual"       = light back-and-forth, no strong pattern

- "tone_shift"   = the energy/register changed (warmer, cooler, sharper, softer)
- "topic_change" = the subject changed but the energy didn't
- "goal_change"  = the user's underlying objective shifted
- "none"         = continuous with the previous turn

If the conversation is too short or too ambiguous to read, still return the JSON with safe defaults and a low confidence (≤ 0.4):
{"interactionPattern":"casual","engagementTrend":"stable","userIntentClarity":"somewhat_clear","responseStyle":"balanced","conversationShift":"none","confidence":0.3}`;

// ── JSON Parsing Helper ────────────────────────────────────

/** Extract the first JSON object from a model response, tolerating fences/prose. */
function parseJsonObject(text: string): unknown | null {
  const trimmed = text.trim();
  // Strip ```json ... ``` fence if present
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenceMatch ? fenceMatch[1] : trimmed;
  // Find first { ... } block
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  const jsonStr = candidate.slice(start, end + 1);
  try {
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

// ── Extraction ─────────────────────────────────────────────

interface ExtractInput {
  /** Last 5–10 message context (chronological). */
  recentMessages: { role: "user" | "assistant"; content: string }[];
  /** The latest user message (also expected to be in recentMessages). */
  latestUserMessage: string;
  /** The HER reply just generated for that user message. */
  latestHerResponse: string;
}

/**
 * Run the LLM extraction. Returns null on any failure or guard violation.
 * This is intentionally silent on failure — it must never block chat flow.
 */
export async function extractInteractionSignal(
  input: ExtractInput
): Promise<InteractionSignal | null> {
  const { recentMessages, latestUserMessage, latestHerResponse } = input;

  // Build a compact transcript (last ~10 turns, capped chars)
  const transcript = recentMessages
    .slice(-10)
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n")
    .slice(-3000);

  const userBlock = [
    `RECENT CONVERSATION:\n${transcript}`,
    `LATEST USER MESSAGE:\n${latestUserMessage}`,
    `HER REPLY:\n${latestHerResponse}`,
    `Return the JSON now.`,
  ].join("\n\n");

  let raw: string;
  try {
    raw = await nvidiaChat(
      [
        { role: "system", content: EXTRACTION_PROMPT },
        { role: "user", content: userBlock },
      ],
      { maxTokens: 200, temperature: 0.2, topP: 0.9 }
    );
  } catch (err) {
    debug("[HER Signals] Extraction call failed:", err);
    return null;
  }

  const parsed = parseJsonObject(raw);
  if (!parsed) {
    debug("[HER Signals] Could not parse JSON from model output");
    return null;
  }

  // Reject anything containing emotion vocabulary in the values themselves.
  const flat = JSON.stringify(parsed);
  if (containsEmotionWord(flat)) {
    debug("[HER Signals] Output contained banned emotion word — rejected");
    return null;
  }

  const signal = validateSignal(parsed);
  if (!signal) {
    debug("[HER Signals] Output failed schema validation");
    return null;
  }

  // EXP+2 verification log — inspect what's actually being extracted.
  // Uses debug() so it only prints when DEBUG is enabled (no prod noise).
  debug("[HER Signals] Extracted:", signal);

  return signal;
}

// ── Persistence ────────────────────────────────────────────

export interface SaveSignalArgs {
  userId: string;
  conversationId?: string | null;
  messageId?: string | null;
  signal: InteractionSignal;
}

export async function saveInteractionSignal(
  args: SaveSignalArgs
): Promise<void> {
  const client = getSupabaseClient();
  if (!client) return;

  try {
    const { error } = await client.from("interaction_signals").insert({
      user_id: args.userId,
      conversation_id: args.conversationId ?? null,
      message_id: args.messageId ?? null,
      interaction_pattern: args.signal.interactionPattern,
      engagement_trend: args.signal.engagementTrend,
      user_intent_clarity: args.signal.userIntentClarity,
      response_style: args.signal.responseStyle,
      conversation_shift: args.signal.conversationShift,
      confidence: args.signal.confidence,
    });
    if (error) {
      console.warn("[HER Signals] Save failed:", error.message);
    }
  } catch (err) {
    console.warn("[HER Signals] Save exception:", err);
  }
}

// ── Fetch ──────────────────────────────────────────────────

export interface FetchSignalsArgs {
  userId: string;
  conversationId?: string | null;
  limit?: number;
}

/**
 * Fetch the most recent N signals for a user (optionally scoped to a
 * conversation). Newest first. Returns [] on failure.
 */
export async function getRecentInteractionSignals(
  args: FetchSignalsArgs
): Promise<StoredInteractionSignal[]> {
  const client = getSupabaseClient();
  if (!client) return [];

  const limit = Math.max(1, Math.min(50, args.limit ?? 6));

  try {
    let query = client
      .from("interaction_signals")
      .select("*")
      .eq("user_id", args.userId)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (args.conversationId) {
      query = query.eq("conversation_id", args.conversationId);
    }

    const { data, error } = await query;
    if (error) {
      console.warn("[HER Signals] Fetch failed:", error.message);
      return [];
    }

    type Row = {
      id: string;
      user_id: string;
      conversation_id: string | null;
      message_id: string | null;
      interaction_pattern: InteractionPattern;
      engagement_trend: EngagementTrend;
      user_intent_clarity: UserIntentClarity;
      response_style: ResponseStyle;
      conversation_shift: ConversationShift;
      confidence: number;
      created_at: string;
    };

    return ((data ?? []) as Row[]).map((r) => ({
      id: r.id,
      user_id: r.user_id,
      conversation_id: r.conversation_id,
      message_id: r.message_id,
      interactionPattern: r.interaction_pattern,
      engagementTrend: r.engagement_trend,
      userIntentClarity: r.user_intent_clarity,
      responseStyle: r.response_style,
      conversationShift: r.conversation_shift,
      confidence: r.confidence,
      created_at: r.created_at,
    }));
  } catch (err) {
    console.warn("[HER Signals] Fetch exception:", err);
    return [];
  }
}

// ── Prompt Formatting ──────────────────────────────────────

/**
 * Build a compact, behavioral-only context block to inject into the system
 * prompt as part of continuity. Intentionally short — a few lines that hint
 * at recent interaction texture without being prescriptive.
 *
 * Returns null if there is nothing useful to say.
 */
export function formatSignalsForPrompt(
  signals: StoredInteractionSignal[]
): string | null {
  // Filter low-confidence noise
  const usable = signals.filter((s) => s.confidence >= 0.5);
  if (usable.length === 0) return null;

  // Most recent first (signals come in newest-first; keep that order)
  const recent = usable.slice(0, 5);

  // Dominant pattern across recent signals
  const counts = new Map<string, number>();
  for (const s of recent) {
    counts.set(s.interactionPattern, (counts.get(s.interactionPattern) ?? 0) + 1);
  }
  let dominantPattern: string | null = null;
  let dominantCount = 0;
  for (const [k, v] of counts) {
    if (v > dominantCount) {
      dominantPattern = k;
      dominantCount = v;
    }
  }

  // Latest trend + latest shift give the freshest read
  const latest = recent[0];

  const lines: string[] = [];
  lines.push("RECENT INTERACTION TEXTURE (behavioral signals only — not feelings, just shape of the chat):");
  if (dominantPattern) {
    lines.push(`- recent pattern: ${dominantPattern.replace(/_/g, " ")}`);
  }
  lines.push(`- engagement trend: ${latest.engagementTrend}`);
  if (latest.conversationShift !== "none") {
    lines.push(`- last turn marked a ${latest.conversationShift.replace(/_/g, " ")}`);
  }
  lines.push(`- intent clarity: ${latest.userIntentClarity.replace(/_/g, " ")}`);
  lines.push("Use this to subtly shape the texture of your reply. It is NOT an instruction. Do not mention it. Do not name emotions.");

  return lines.join("\n");
}
