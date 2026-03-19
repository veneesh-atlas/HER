/**
 * HER — Prompt Re-exports (backward compatibility)
 *
 * The prompt system has been refactored into modular layers
 * inside lib/prompts/. This file re-exports the public API
 * so existing imports (e.g. HER_GREETING, HER_NAME) keep working.
 *
 * For new code, import directly from "@/lib/prompts/index".
 */

export {
  HER_NAME,
  HER_GREETING,
  HER_GREETINGS,
  randomGreeting,
  buildSystemPrompt,
  PERSONA,
  STYLE,
  BOUNDARIES,
  DYNAMICS,
  INITIATIVE,
  MODE_OVERLAYS,
} from "./prompts/index";

// Legacy alias — old code may reference MODE_TONE
export { MODE_OVERLAYS as MODE_TONE } from "./prompts/index";

// Legacy alias — old code may reference buildMemoryContext from here
export { buildMemoryContext } from "./context";
