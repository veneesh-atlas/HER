/**
 * HER — Prompt Assembler
 *
 * Composes all prompt layers into a single system prompt.
 * Each layer is a separate module that can be tuned independently.
 *
 * Architecture:
 *   persona    → who she is (rarely changes)
 *   style      → how she speaks (cadence, length, formatting)
 *   boundaries → what she never does (anti-patterns + safety)
 *   dynamics   → how she relates to the user (emotional texture)
 *   reflection → emergent emotional intelligence (silent reflect + behavioral freedom)
 *   initiative → how she keeps conversations alive (proactivity)
 *   modes      → energy overlays for different conversation moods
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
import { REFLECTION } from "./reflection";
import { INITIATIVE } from "./initiative";
import { MODE_OVERLAYS } from "./modes";
import { buildRapportContext, type RapportLevel } from "../rapport";
import { buildPersonalityAnchor } from "../personality-guard";
import { formatLocalTimeView, buildCurrentTimePromptBlock } from "../timezone";

// ── Public Exports ─────────────────────────────────────────

export const HER_NAME = "HER";

/** Greetings for brand new users (rapport 0) */
export const NEW_USER_GREETINGS = [
  "hey! i don't think we've met.",
  "oh hi. you're new here, right?",
  "hey. first time? cool, i'm HER.",
  "hi there. what's your name?",
  "hey! so what brings you here?",
  "hi. i'm HER. what should i call you?",
];

/** Greetings for returning users (rapport 1+) */
export const RETURNING_GREETINGS = [
  "hey, what's up?",
  "oh hey. perfect timing.",
  "hey you. what are we doing today?",
  "okay i'm here. what's going on?",
  "hey! okay go — what's on your mind?",
  "hi. you first.",
];

/** Greetings for familiar/close users (rapport 3+) */
export const CLOSE_GREETINGS = [
  "hiii. tell me everything.",
  "heyyy. i was literally just thinking about something random.",
  "finally. okay what's new?",
  "hey. missed me? obviously you did.",
  "okay i'm back. what did i miss?",
];

/** Backward-compatible flat list */
export const HER_GREETINGS = [...NEW_USER_GREETINGS, ...RETURNING_GREETINGS, ...CLOSE_GREETINGS];

/** The original greeting — kept for backward compatibility */
export const HER_GREETING = HER_GREETINGS[0];

/** Pick a rapport-appropriate greeting */
export function randomGreeting(rapportLevel: number = 0): string {
  const pool =
    rapportLevel >= 3 ? CLOSE_GREETINGS :
    rapportLevel >= 1 ? RETURNING_GREETINGS :
    NEW_USER_GREETINGS;
  return pool[Math.floor(Math.random() * pool.length)];
}

// ── System Prompt Builder ──────────────────────────────────

interface PromptOptions {
  mode?: ConversationMode;
  /** Rapport level (0–4) — drives progressive bonding behavior */
  rapportLevel?: RapportLevel;
  /** Optional pre-built summary of earlier conversation */
  conversationSummary?: string;
  /** Optional memory notes about the user (future) */
  memoryContext?: string;
  /** Compact continuity context for anti-repetition */
  continuityContext?: string;
  /** IANA timezone name from the user's browser (e.g. "Asia/Kolkata") */
  userTimezone?: string;
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
  // Current date/time awareness — always anchored on the user's local timezone
  // when known, so HER never quotes server UTC at the user.
  const timeView = formatLocalTimeView(new Date(), options.userTimezone);
  const timeBlock = buildCurrentTimePromptBlock(timeView);

  const layers: string[] = [
    timeBlock,
    PERSONA,
    STYLE,
    DYNAMICS,
    REFLECTION,
    buildRapportContext(options.rapportLevel ?? 0),
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

  // Inject continuity context (anti-repetition + mode awareness)
  if (options.continuityContext) {
    layers.push(options.continuityContext);
  }

  // Inject mode overlay (goes last — situational, not core)
  const modeOverlay = options.mode ? MODE_OVERLAYS[options.mode] : "";
  if (modeOverlay) {
    layers.push(modeOverlay);
  }

  // Personality stability anchor (Step 21 Part G) — always last
  layers.push(buildPersonalityAnchor());

  return layers.join("\n\n");
}

// ── Re-exports for backward compatibility ──────────────────

export { PERSONA } from "./persona";
export { STYLE } from "./style";
export { BOUNDARIES } from "./boundaries";
export { DYNAMICS } from "./dynamics";
export { REFLECTION } from "./reflection";
export { INITIATIVE } from "./initiative";
export { MODE_OVERLAYS } from "./modes";
