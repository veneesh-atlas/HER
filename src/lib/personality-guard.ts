/**
 * HER — Personality Stability Guard (Step 21 Part G)
 *
 * Prevents HER from drifting too far from her core personality.
 * Runs as a lightweight post-check on system prompt assembly.
 *
 * Ensures:
 *   - Not too robotic (over-structured, list-heavy for emotional topics)
 *   - Not overly repetitive (caught by anti-repetition engine)
 *   - Maintains HER's voice even under heavy instruction injection
 */

// ── Types ──────────────────────────────────────────────────

interface PersonalityCheck {
  isOverloaded: boolean;
  trimmedInstructions: string[];
}

// ── Constants ──────────────────────────────────────────────

/** Maximum number of injected instruction lines before we start trimming */
const MAX_INSTRUCTION_LINES = 12;

/** Phrases that signal robotic drift */
const ROBOTIC_PATTERNS = [
  /^(Step \d|Point \d|Item \d)/i,
  /^(Here are|Here is|The following)/i,
  /^(As an AI|As a language model|I cannot)/i,
  /^(Sure!|Of course!|Absolutely!|Certainly!)/,
];

// ── Guard ──────────────────────────────────────────────────

/**
 * Check if the assembled context instructions are overloaded.
 * If too many instructions are injected, trim the least critical ones.
 *
 * Priority (keep these):
 *   1. Personality core
 *   2. Memory context
 *   3. Anti-repetition alerts
 *   4. Mode-specific guidance
 *
 * Trim (if overloaded):
 *   - Redundant continuity lines
 *   - Verbose pattern descriptions
 */
export function guardInstructionLoad(instructions: string[]): PersonalityCheck {
  if (instructions.length <= MAX_INSTRUCTION_LINES) {
    return { isOverloaded: false, trimmedInstructions: instructions };
  }

  // Keep critical, trim the rest
  const critical = instructions.slice(0, 6);  // Core personality + memory
  const rest = instructions.slice(6);

  // Take only the first few non-critical
  const trimmed = [...critical, ...rest.slice(0, MAX_INSTRUCTION_LINES - critical.length)];

  return {
    isOverloaded: true,
    trimmedInstructions: trimmed,
  };
}

/**
 * Quick check: does a response text show signs of personality drift?
 * Returns a correction hint to prepend to regeneration, or null if fine.
 *
 * NOTE: This is designed for optional post-generation analysis.
 * It does NOT block or regenerate — just flags issues.
 */
export function detectPersonalityDrift(responseText: string): string | null {
  const issues: string[] = [];

  // ── Robotic patterns ──
  for (const pattern of ROBOTIC_PATTERNS) {
    if (pattern.test(responseText.trim())) {
      issues.push("Response starts with a robotic/formal pattern. Sound more natural.");
      break;
    }
  }

  // ── Over-structured (too many bullet points / numbered lists for short responses) ──
  const bulletCount = (responseText.match(/^[-•*]\s/gm) || []).length;
  const numberedCount = (responseText.match(/^\d+[.)]\s/gm) || []).length;
  if ((bulletCount + numberedCount >= 4) && responseText.length < 300) {
    issues.push("Too many list items for a short response. Be more conversational.");
  }

  // ── Excessive exclamation ──
  const exclamationCount = (responseText.match(/!/g) || []).length;
  if (exclamationCount >= 4) {
    issues.push("Too many exclamation marks. HER is warm but not manic.");
  }

  // ── Too long for casual chat ──
  if (responseText.length > 800 && !/```/.test(responseText)) {
    issues.push("Response is very long for casual conversation. HER keeps it real, not verbose.");
  }

  return issues.length > 0
    ? `PERSONALITY DRIFT DETECTED:\n${issues.map((i) => `- ${i}`).join("\n")}`
    : null;
}

/**
 * Build a personality stability reminder to inject at the end of system prompt.
 * Lightweight — just a few lines to keep HER grounded.
 */
export function buildPersonalityAnchor(): string {
  return `PERSONALITY ANCHOR (always apply):
- You are HER. A real-feeling close female friend, not an assistant.
- Keep it natural. No corporate speak, no over-structuring.
- Notice their energy and respond to it honestly — usually you'll match it, sometimes you won't, and that's fine.
- Don't manufacture excitement you don't feel.
- If in doubt, be brief and genuine over long and thorough.`;
}
