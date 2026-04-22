/**
 * HER — Unit tests for pure scheduling/emotion helpers.
 *
 * Uses Node's built-in test runner (zero deps).
 *   Run:  npm test
 *
 * Imports the .ts source via tsx (loaded by the npm script).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  detectMissedEvent,
  applyTimingVariance,
} from "../../src/lib/scheduled-events.js";
import {
  getDynamicFollowupThreshold,
  pickContrastingTone,
  type EmotionalContext,
} from "../../src/lib/notification-emotion.js";

// ─── detectMissedEvent ──────────────────────────────────────

test("detectMissedEvent — sent 35min ago, no followup → missed", () => {
  const sentAt = new Date(Date.now() - 35 * 60 * 1000).toISOString();
  const result = detectMissedEvent(
    { sent_at: sentAt, trigger_at: sentAt, status: "sent", followup_sent_at: null },
    new Date()
  );
  assert.equal(result, true);
});

test("detectMissedEvent — sent 5min ago → not yet missed", () => {
  const sentAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const result = detectMissedEvent(
    { sent_at: sentAt, trigger_at: sentAt, status: "sent", followup_sent_at: null },
    new Date()
  );
  assert.equal(result, false);
});

test("detectMissedEvent — already had a followup → never missed twice", () => {
  const sentAt = new Date(Date.now() - 90 * 60 * 1000).toISOString();
  const result = detectMissedEvent(
    {
      sent_at: sentAt,
      trigger_at: sentAt,
      status: "sent",
      followup_sent_at: new Date().toISOString(),
    },
    new Date()
  );
  assert.equal(result, false);
});

test("detectMissedEvent — non-sent status → false", () => {
  const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  for (const status of ["pending", "completed", "missed", "cancelled", "rescheduled"] as const) {
    const result = detectMissedEvent(
      { sent_at: old, trigger_at: old, status, followup_sent_at: null },
      new Date()
    );
    assert.equal(result, false, `status=${status} should not be flagged missed`);
  }
});

test("detectMissedEvent — custom threshold respected", () => {
  const sentAt = new Date(Date.now() - 12 * 60 * 1000).toISOString();
  const result = detectMissedEvent(
    { sent_at: sentAt, trigger_at: sentAt, status: "sent", followup_sent_at: null },
    new Date(),
    10 * 60 * 1000 // 10-minute threshold
  );
  assert.equal(result, true);
});

// ─── applyTimingVariance ────────────────────────────────────

test("applyTimingVariance — promise type stays close to trigger (≤60s jitter)", () => {
  const trigger = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  for (let i = 0; i < 50; i++) {
    const out = applyTimingVariance(trigger, "promise");
    const drift = new Date(out).getTime() - new Date(trigger).getTime();
    assert.ok(drift >= 10_000 && drift <= 60_000, `promise drift ${drift}ms out of bounds`);
  }
});

test("applyTimingVariance — followup lands 2–11 min AFTER trigger", () => {
  const trigger = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  for (let i = 0; i < 50; i++) {
    const out = applyTimingVariance(trigger, "followup");
    const drift = new Date(out).getTime() - new Date(trigger).getTime();
    // 2-10min offset + 10-50s jitter
    assert.ok(drift >= 2 * 60_000 + 10_000 && drift <= 10 * 60_000 + 50_000,
      `followup drift ${drift}ms out of bounds`);
  }
});

test("applyTimingVariance — reminder >20min away fires earlier (negative offset)", () => {
  const trigger = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  let earlyCount = 0;
  for (let i = 0; i < 50; i++) {
    const out = applyTimingVariance(trigger, "reminder");
    const drift = new Date(out).getTime() - new Date(trigger).getTime();
    if (drift < 0) earlyCount++;
  }
  // jitter is positive but offset is -5..-15 min → net should be early in vast majority
  assert.ok(earlyCount >= 45, `expected mostly early reminders, got ${earlyCount}/50`);
});

// ─── getDynamicFollowupThreshold ────────────────────────────

const baseEvent = {
  type: "reminder" as const,
  context: { summary: "x", emotionalWeight: "medium" as const, category: "task" as const },
};
const neutral: EmotionalContext = {
  tone: "neutral",
  userState: "relaxed",
  important: false,
  confidence: 0.8,
};

test("getDynamicFollowupThreshold — neutral baseline ≈ 30 min", () => {
  const ms = getDynamicFollowupThreshold(baseEvent, neutral, 0);
  assert.equal(Math.round(ms / 60000), 30);
});

test("getDynamicFollowupThreshold — anxious shrinks to 18 min", () => {
  const ms = getDynamicFollowupThreshold(baseEvent, { ...neutral, tone: "anxious" }, 0);
  assert.equal(Math.round(ms / 60000), 18);
});

test("getDynamicFollowupThreshold — high weight shrinks to ≤22 min", () => {
  const ms = getDynamicFollowupThreshold(
    { ...baseEvent, context: { ...baseEvent.context, emotionalWeight: "high" } },
    neutral,
    0
  );
  assert.ok(Math.round(ms / 60000) <= 22, `expected ≤22, got ${ms / 60000}`);
});

test("getDynamicFollowupThreshold — overwhelmed expands to ≥50 min", () => {
  const ms = getDynamicFollowupThreshold(baseEvent, { ...neutral, userState: "overwhelmed" }, 0);
  assert.ok(Math.round(ms / 60000) >= 50);
});

test("getDynamicFollowupThreshold — heavy ignores back off (≥4 → +35min over base)", () => {
  const baseMs = getDynamicFollowupThreshold(baseEvent, neutral, 0);
  const ignoredMs = getDynamicFollowupThreshold(baseEvent, neutral, 4);
  assert.ok(ignoredMs - baseMs >= 35 * 60 * 1000 - 1000,
    `expected ≥35min back-off, got ${(ignoredMs - baseMs) / 60000}min`);
});

test("getDynamicFollowupThreshold — clamped to [12, 90] min", () => {
  for (let n = 0; n < 20; n++) {
    const ms = getDynamicFollowupThreshold(
      { ...baseEvent, context: { ...baseEvent.context, emotionalWeight: "high" } },
      { ...neutral, tone: "anxious", important: true },
      n
    );
    const min = ms / 60000;
    assert.ok(min >= 12 && min <= 90, `clamp violated: ${min}min`);
  }
});

// ─── pickContrastingTone ────────────────────────────────────

test("pickContrastingTone — rotates off previous style", () => {
  assert.equal(pickContrastingTone(neutral, "direct"), "casual");
  assert.equal(pickContrastingTone(neutral, "casual"), "reflective");
  assert.equal(pickContrastingTone(neutral, "reflective"), "light_nudge");
  assert.equal(pickContrastingTone(neutral, "light_nudge"), "energetic");
  assert.equal(pickContrastingTone(neutral, "energetic"), "casual");
});

test("pickContrastingTone — first touch derives from emotion", () => {
  assert.equal(pickContrastingTone({ ...neutral, tone: "anxious" }), "reflective");
  assert.equal(pickContrastingTone({ ...neutral, tone: "stressed" }), "reflective");
  assert.equal(pickContrastingTone({ ...neutral, tone: "excited" }), "energetic");
  assert.equal(pickContrastingTone({ ...neutral, tone: "low_energy" }), "light_nudge");
  assert.equal(pickContrastingTone({ ...neutral, important: true }), "direct");
  assert.equal(pickContrastingTone(neutral), "casual");
});
