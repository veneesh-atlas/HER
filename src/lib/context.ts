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
  recentMessageCount: 20,

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
  // This is the hook for long-term conversation memory.
  // When ready, this function will:
  //   - Detect when olderMessages.length > 0
  //   - Summarize them (LLM call or heuristic)
  //   - Return a concise emotional + factual summary
  return null;
}

/**
 * Placeholder for long-term memory retrieval.
 *
 * In the future, this pulls stored facts/notes about the user
 * from a persistence layer (DB, vector store, etc.).
 *
 * For now returns null.
 */
export function buildMemoryContext(): string | null {
  // TODO: Implement memory retrieval
  // Will eventually return things like:
  //   "Their name is Alex. They love rainy days.
  //    Last time you talked about a book called Piranesi."
  return null;
}

// ── Context Builder ────────────────────────────────────────

export interface ContextOptions {
  mode?: ConversationMode;
  /** Override the rolling window size */
  recentCount?: number;
  /** Externally provided memory context */
  memoryContext?: string;
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

  // Build memory context
  const memory = options.memoryContext ?? buildMemoryContext();

  // Assemble system prompt with all layers
  const systemContent = buildSystemPrompt({
    mode: options.mode,
    conversationSummary: summary ?? undefined,
    memoryContext: memory ?? undefined,
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
