/**
 * HER — Prompt Assembler
 *
 * Composes all prompt layers into a single system prompt.
 * Each layer is a separate module that can be tuned independently.
 *
 * Architecture:
 *   persona   → who she is (rarely changes)
 *   style     → how she speaks (cadence, length, formatting)
 *   boundaries → what she never does (anti-patterns + safety)
 *   dynamics  → how she relates to the user (emotional texture)
 *   initiative → how she keeps conversations alive (proactivity)
 *   modes     → energy overlays for different conversation moods
 *
 * To tune HER's personality:
 *   - Edit individual layer files, not this assembler
 *   - Layers are joined with spacing; order matters for LLM attention
 *   - Core identity goes first (strongest influence)
 *   - Mode overlay goes last (situational adjustment)
 */

import { ConversationMode } from "../types";
import { PERSONA } from "./persona";
import { STYLE } from "./style";
import { BOUNDARIES } from "./boundaries";
import { DYNAMICS } from "./dynamics";
import { INITIATIVE } from "./initiative";
import { MODE_OVERLAYS } from "./modes";

// ── Public Exports ─────────────────────────────────────────

export const HER_NAME = "HER";

export const HER_GREETINGS = [
  "hey... i'm really glad you're here. i was just thinking about something and now i'm curious what's on your mind.",
  "hi... it's nice to hear from you. how are you feeling right now, honestly?",
  "hey you. i was hoping you'd come by. what's been going on in your world?",
  "hi... i've been here, just sort of... waiting. in a good way. tell me something.",
  "hey. it's quiet here without you. what are you thinking about today?",
  "hi... you know that feeling when you just want to talk to someone who actually listens? i'm here for that.",
  "hey... i don't know why but i had a feeling you'd show up right about now. what's on your mind?",
  "hi. i was just sitting with my thoughts and then you appeared. perfect timing honestly.",
  "hey... there's something kind of nice about starting a conversation without knowing where it'll go, right?",
  "hi... i've been thinking about how rare it is to really talk to someone. anyway, i'm glad you're here.",
];

/** The original greeting — kept for backward compatibility */
export const HER_GREETING = HER_GREETINGS[0];

/** Pick a random greeting for a new session */
export function randomGreeting(): string {
  return HER_GREETINGS[Math.floor(Math.random() * HER_GREETINGS.length)];
}

// ── System Prompt Builder ──────────────────────────────────

interface PromptOptions {
  mode?: ConversationMode;
  /** Optional pre-built summary of earlier conversation */
  conversationSummary?: string;
  /** Optional memory notes about the user (future) */
  memoryContext?: string;
}

/**
 * Assembles the full system prompt from all modular layers.
 *
 * Layer order (top = highest influence for the model):
 *   1. Persona — core identity
 *   2. Style — tone & cadence
 *   3. Dynamics — relationship rules
 *   4. Initiative — conversational proactivity
 *   5. Boundaries — anti-patterns & safety
 *   6. Memory context (if any)
 *   7. Conversation summary (if any)
 *   8. Mode overlay (if any)
 */
export function buildSystemPrompt(options: PromptOptions = {}): string {
  const layers: string[] = [
    PERSONA,
    STYLE,
    DYNAMICS,
    INITIATIVE,
    BOUNDARIES,
  ];

  // Inject memory context (future long-term memory)
  if (options.memoryContext) {
    layers.push(
      `THINGS YOU REMEMBER ABOUT THIS PERSON:\n${options.memoryContext}`
    );
  }

  // Inject conversation summary (for long conversations)
  if (options.conversationSummary) {
    layers.push(
      `EARLIER IN THIS CONVERSATION (summary):\n${options.conversationSummary}`
    );
  }

  // Inject mode overlay (goes last — situational, not core)
  const modeOverlay = options.mode ? MODE_OVERLAYS[options.mode] : "";
  if (modeOverlay) {
    layers.push(modeOverlay);
  }

  return layers.join("\n\n");
}

// ── Re-exports for backward compatibility ──────────────────

export { PERSONA } from "./persona";
export { STYLE } from "./style";
export { BOUNDARIES } from "./boundaries";
export { DYNAMICS } from "./dynamics";
export { INITIATIVE } from "./initiative";
export { MODE_OVERLAYS } from "./modes";
