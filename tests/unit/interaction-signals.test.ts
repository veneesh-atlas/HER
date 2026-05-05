/**
 * HER — Interaction Signals (Step EXP+1) — pure function tests
 *
 * Tests the validator and formatter only. The LLM extraction and Supabase
 * I/O paths are intentionally not covered here — they require network /
 * env config and are exercised by smoke tests.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  validateSignal,
  formatSignalsForPrompt,
  _containsEmotionWord,
  type StoredInteractionSignal,
} from "../../src/lib/interaction-signals.js";

// ── validateSignal ─────────────────────────────────────────

test("validateSignal — accepts a well-formed object", () => {
  const ok = validateSignal({
    interactionPattern: "repetitive",
    engagementTrend: "decreasing",
    userIntentClarity: "clear",
    responseStyle: "short",
    conversationShift: "tone_shift",
    confidence: 0.82,
  });
  assert.ok(ok);
  assert.equal(ok!.interactionPattern, "repetitive");
  assert.equal(ok!.confidence, 0.82);
});

test("validateSignal — rejects unknown enum values", () => {
  const bad = validateSignal({
    interactionPattern: "angry", // not a valid pattern
    engagementTrend: "stable",
    userIntentClarity: "clear",
    responseStyle: "short",
    conversationShift: "none",
    confidence: 0.7,
  });
  assert.equal(bad, null);
});

test("validateSignal — rejects out-of-range confidence", () => {
  const bad = validateSignal({
    interactionPattern: "casual",
    engagementTrend: "stable",
    userIntentClarity: "clear",
    responseStyle: "short",
    conversationShift: "none",
    confidence: 1.5,
  });
  assert.equal(bad, null);
});

test("validateSignal — rejects missing fields", () => {
  const bad = validateSignal({ interactionPattern: "casual" });
  assert.equal(bad, null);
});

test("validateSignal — rejects non-object input", () => {
  assert.equal(validateSignal(null), null);
  assert.equal(validateSignal("repetitive"), null);
  assert.equal(validateSignal(42), null);
});

test("validateSignal — coerces casing on enum values", () => {
  const ok = validateSignal({
    interactionPattern: "Goal_Oriented",
    engagementTrend: "STABLE",
    userIntentClarity: "Clear",
    responseStyle: "Direct",
    conversationShift: "None",
    confidence: 0.6,
  });
  assert.ok(ok);
  assert.equal(ok!.interactionPattern, "goal_oriented");
});

// ── formatSignalsForPrompt ─────────────────────────────────

function makeSignal(
  partial: Partial<StoredInteractionSignal> = {},
): StoredInteractionSignal {
  return {
    interactionPattern: "casual",
    engagementTrend: "stable",
    userIntentClarity: "clear",
    responseStyle: "balanced",
    conversationShift: "none",
    confidence: 0.7,
    ...partial,
  };
}

test("formatSignalsForPrompt — returns null when empty", () => {
  assert.equal(formatSignalsForPrompt([]), null);
});

test("formatSignalsForPrompt — drops low-confidence signals", () => {
  const out = formatSignalsForPrompt([makeSignal({ confidence: 0.2 })]);
  assert.equal(out, null);
});

test("formatSignalsForPrompt — never names emotions", () => {
  const out = formatSignalsForPrompt([
    makeSignal({ interactionPattern: "repetitive", engagementTrend: "decreasing" }),
    makeSignal({ interactionPattern: "repetitive", conversationShift: "tone_shift" }),
  ]);
  assert.ok(out);
  // Hard guard: the prompt must not leak any emotion vocabulary
  const banned = /\b(happy|sad|angry|anxious|frustrated|excited|lonely|stressed|hurt|mood|feeling)\b/i;
  assert.equal(banned.test(out!), false);
});

test("formatSignalsForPrompt — surfaces dominant pattern + latest trend", () => {
  const signals = [
    makeSignal({ interactionPattern: "deepening", engagementTrend: "increasing" }),
    makeSignal({ interactionPattern: "deepening" }),
    makeSignal({ interactionPattern: "casual" }),
  ];
  const out = formatSignalsForPrompt(signals);
  assert.ok(out);
  assert.match(out!, /deepening/);
  assert.match(out!, /increasing/);
});

test("formatSignalsForPrompt — mentions a non-none shift", () => {
  const out = formatSignalsForPrompt([
    makeSignal({ conversationShift: "topic_change" }),
  ]);
  assert.ok(out);
  assert.match(out!, /topic change/);
});

test("formatSignalsForPrompt — omits shift line when 'none'", () => {
  const out = formatSignalsForPrompt([makeSignal({ conversationShift: "none" })]);
  assert.ok(out);
  assert.equal(/shift|topic change|tone shift|goal change/.test(out!), false);
});

// ── EXP+2 emotion-leak guard ───────────────────────────────

test("emotion guard — catches LLM smuggling 'frustrated' into a value", () => {
  // Simulates the worst case: the model ignored the prompt and dropped an
  // emotion word into one of the JSON values. The post-extraction regex
  // must reject this before it ever reaches Supabase.
  const leaked = JSON.stringify({
    interactionPattern: "frustrated", // ❌ emotion smuggled in as a "pattern"
    engagementTrend: "decreasing",
    userIntentClarity: "clear",
    responseStyle: "short",
    conversationShift: "tone_shift",
    confidence: 0.8,
  });
  assert.equal(_containsEmotionWord(leaked), true);
});

test("emotion guard — catches all common emotion words", () => {
  const cases = [
    "happy", "sad", "angry", "anxious", "frustrated", "excited",
    "lonely", "stressed", "hurt", "mood", "feeling", "depressed",
  ];
  for (const word of cases) {
    assert.equal(_containsEmotionWord(`...${word}...`), true, `should catch "${word}"`);
  }
});

test("emotion guard — does NOT false-positive on neutral behavioral text", () => {
  // The serialized form of a clean signal must pass the guard.
  const clean = JSON.stringify({
    interactionPattern: "repetitive",
    engagementTrend: "decreasing",
    userIntentClarity: "clear",
    responseStyle: "short",
    conversationShift: "tone_shift",
    confidence: 0.82,
  });
  assert.equal(_containsEmotionWord(clean), false);
});

test("validation rejects a 'frustrated' pattern even if guard somehow misses it", () => {
  // Defense-in-depth: even if the regex changed, the schema still rejects
  // anything not in the allowed enum.
  assert.equal(
    validateSignal({
      interactionPattern: "frustrated",
      engagementTrend: "decreasing",
      userIntentClarity: "clear",
      responseStyle: "short",
      conversationShift: "tone_shift",
      confidence: 0.82,
    }),
    null,
  );
});
