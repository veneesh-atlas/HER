/**
 * HER — Context Builder
 *
 * Manages the context window sent to the model.
 * Instead of sending the entire conversation forever,
 * this builds a smart rolling window that keeps:
 *
 *   1. The system prompt (always)
 *   2. A conversation summary (when available — future)
 *   3. The most recent N messages (rolling window)
 *
 * This keeps costs down, avoids context overflow,
 * and preserves emotional continuity.
 *
 * Architecture:
 *   Full message history → buildContext() → ModelMessage[]
 *   (system prompt + optional summary + recent messages)
 */

import { Message, ModelMessage, ConversationMode } from "./types";
import { buildSystemPrompt } from "./prompts/index";

// ── Configuration ──────────────────────────────────────────

/**
 * Context window settings.
 * Tune these to balance quality vs. token cost.
 */
export const CONTEXT_CONFIG = {
  /** Max recent messages to include in the rolling window */
  recentMessageCount: 40,

  /** Min messages to always keep (even in aggressive trimming) */
  minMessages: 6,

  /**
   * Rough char budget for the conversation portion.
   * Not a hard limit — just a guideline for future smart trimming.
   * (System prompt chars are separate.)
   */
  softCharBudget: 12_000,
} as const;

// ── Summary Placeholder ────────────────────────────────────

/**
 * Placeholder for conversation summarization.
 *
 * In the future, when a conversation exceeds a threshold,
 * older messages will be summarized into a compact block
 * that preserves emotional context and key facts.
 *
 * For now this returns null. When implemented, it will:
 *   1. Take messages older than the rolling window
 *   2. Summarize them via an LLM call (or local heuristic)
 *   3. Return a string like:
 *      "Earlier, you talked about their love of rain, a hard day
 *       at work, and a childhood memory about their grandmother.
 *       The mood was warm and reflective."
 */
export function buildConversationSummary(
  _olderMessages: Message[]
): string | null {
  // TODO: Implement summarization
  return null;
}

// ── Context Builder ────────────────────────────────────────

export interface ContextOptions {
  mode?: ConversationMode;
  /** Override the rolling window size */
  recentCount?: number;
  /** Externally provided memory context */
  memoryContext?: string;
  /** Compact continuity context for anti-repetition */
  continuityContext?: string;
  /** Rapport level (0–4) for progressive bonding */
  rapportLevel?: number;
  /** Response mode instruction from adaptive intelligence (Step 21) */
  responseModeInstruction?: string;
  /** Anti-repetition variation instruction (Step 21 Part C) */
  antiRepetitionInstruction?: string;
  /** IANA timezone name from the user's browser */
  userTimezone?: string;
}

/**
 * Builds the full model context from a conversation history.
 *
 * Returns a clean ModelMessage[] array:
 *   [system prompt, ...recent conversation messages]
 *
 * The system prompt includes all personality layers,
 * any available memory/summary context, and the mode overlay.
 *
 * This is the ONLY function the API route / conversation builder
 * should call to prepare messages for the provider.
 */
export function buildContext(
  messages: Message[],
  options: ContextOptions = {}
): ModelMessage[] {
  const recentCount = options.recentCount ?? CONTEXT_CONFIG.recentMessageCount;

  // Split messages into "older" (summarizable) and "recent" (kept verbatim)
  const splitIndex = Math.max(0, messages.length - recentCount);
  const olderMessages = messages.slice(0, splitIndex);
  const recentMessages = messages.slice(splitIndex);

  // Build summary of older messages (future — returns null for now)
  const summary = olderMessages.length > 0
    ? buildConversationSummary(olderMessages)
    : null;

  // Build memory context (supplied externally by the client via /api/memory)
  const memory = options.memoryContext ?? null;

  // Assemble system prompt with all layers
  const systemContent = buildSystemPrompt({
    mode: options.mode,
    rapportLevel: (options.rapportLevel ?? 0) as import("./rapport").RapportLevel,
    conversationSummary: summary ?? undefined,
    memoryContext: memory ?? undefined,
    userTimezone: options.userTimezone,
    continuityContext: [
      options.continuityContext,
      options.responseModeInstruction,
      options.antiRepetitionInstruction,
    ].filter(Boolean).join("\n") || undefined,
  });

  const systemMessage: ModelMessage = {
    role: "system",
    content: systemContent,
  };

  // Convert recent messages to ModelMessage format
  const conversationMessages: ModelMessage[] = recentMessages.map((msg) => ({
    role: msg.role,
    content: msg.content,
  }));

  return [systemMessage, ...conversationMessages];
}
