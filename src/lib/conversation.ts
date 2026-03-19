/**
 * Conversation Builder — Assembles the message payload for the model.
 *
 * This is the bridge between the UI and the API.
 * It takes raw chat messages and builds a properly structured
 * payload with system prompt, memory context, and mode tone.
 *
 * Architecture:
 *   UI Messages → buildPayload() → ModelMessage[] → API route → LLM
 *
 * Step 6: Now delegates to lib/context.ts for smart context
 * window management with rolling window + summary placeholder.
 */

import {
  Message,
  ModelMessage,
  ConversationConfig,
  ConversationMode,
} from "./types";
import { buildContext, ContextOptions } from "./context";

// ── Defaults ───────────────────────────────────────────────

const DEFAULT_CONFIG: ConversationConfig = {
  mode: "default",
  maxMessages: 20,
};

// ── Message Payload Builder ────────────────────────────────

/**
 * Builds the complete message payload for the model.
 *
 * Returns an array of ModelMessage objects:
 * [system, ...conversation history]
 *
 * Usage:
 *   const payload = buildPayload(messages);
 *   const payload = buildPayload(messages, { mode: "comfort" });
 *   const payload = buildPayload(messages, { mode: "deep", maxMessages: 30 });
 */
export function buildPayload(
  messages: Message[],
  config?: Partial<ConversationConfig>
): ModelMessage[] {
  const fullConfig: ConversationConfig = { ...DEFAULT_CONFIG, ...config };

  const contextOptions: ContextOptions = {
    mode: fullConfig.mode,
    recentCount: fullConfig.maxMessages,
    memoryContext: fullConfig.memoryContext,
  };

  return buildContext(messages, contextOptions);
}

// ── Utilities ──────────────────────────────────────────────

/**
 * Get a human-readable label for a conversation mode.
 */
export function getModeLabel(mode: ConversationMode): string {
  const labels: Record<ConversationMode, string> = {
    default: "just talking",
    comfort: "comfort mode",
    playful: "playful mode",
    deep: "deep conversation",
    curious: "explorer mode",
  };
  return labels[mode];
}

/**
 * Get a brief description of what a mode does.
 */
export function getModeDescription(mode: ConversationMode): string {
  const descriptions: Record<ConversationMode, string> = {
    default: "natural conversation, wherever it goes",
    comfort: "gentle, warm, emotionally supportive",
    playful: "light, teasing, fun energy",
    deep: "reflective, philosophical, meaningful",
    curious: "exploring ideas, stories, and questions",
  };
  return descriptions[mode];
}

/**
 * All available conversation modes.
 */
export const CONVERSATION_MODES: ConversationMode[] = [
  "default",
  "comfort",
  "playful",
  "deep",
  "curious",
];
