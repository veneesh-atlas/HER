/**
 * HER — Edge case unit tests (Step 17.X+1 §5)
 *
 * Pure-function level guarantees for situations that historically broke
 * notification systems:
 *   - Guest users (must NOT schedule)
 *   - Missing trigger time
 *   - Missing/UTC timezone (quiet-hours short-circuit)
 *   - Quiet-hours bypass for high-priority types
 *   - High-priority type set membership
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createScheduledEvent } from "../../src/lib/scheduled-events.js";
import {
  isQuietHours,
  isHighPriorityEvent,
  type NotificationSettings,
} from "../../src/lib/notification-settings.js";

const baseSettings: NotificationSettings = {
  notifications_enabled: true,
  quiet_hours_start: "01:00",
  quiet_hours_end: "05:00",
  timezone: "UTC",
  push_subscription: null,
};

// ─── Guest guard ───────────────────────────────────────────

test("createScheduledEvent — guest user returns null (no DB write)", async () => {
  const id = await createScheduledEvent({
    userId: "guest",
    conversationId: null,
    intent: {
      type: "reminder",
      triggerAt: new Date(Date.now() + 60_000).toISOString(),
      context: { summary: "x", emotionalWeight: "low", category: "task" },
    },
    originalMessage: "x",
  });
  assert.equal(id, null);
});

test("createScheduledEvent — empty userId returns null", async () => {
  const id = await createScheduledEvent({
    userId: "",
    conversationId: null,
    intent: {
      type: "reminder",
      triggerAt: new Date(Date.now() + 60_000).toISOString(),
      context: { summary: "x", emotionalWeight: "low", category: "task" },
    },
    originalMessage: "x",
  });
  assert.equal(id, null);
});

test("createScheduledEvent — missing triggerAt returns null", async () => {
  const id = await createScheduledEvent({
    userId: "real-user",
    conversationId: null,
    intent: {
      type: "reminder",
      triggerAt: "", // missing
      context: { summary: "x", emotionalWeight: "low", category: "task" },
    },
    originalMessage: "x",
  });
  assert.equal(id, null);
});

// ─── Quiet hours / timezone safety ─────────────────────────

test("isQuietHours — UTC (placeholder TZ) short-circuits to false", () => {
  // Without a real TZ, we never gate — better to over-deliver than swallow
  // a morning reminder for an IST/PST/etc. user.
  assert.equal(isQuietHours(baseSettings), false);
});

test("isQuietHours — explicitly disabled timezone field also short-circuits", () => {
  assert.equal(isQuietHours({ ...baseSettings, timezone: "" }), false);
});

// ─── High-priority gate ────────────────────────────────────

test("isHighPriorityEvent — reminder + promise are high-priority", () => {
  assert.equal(isHighPriorityEvent("reminder"), true);
  assert.equal(isHighPriorityEvent("promise"), true);
});

test("isHighPriorityEvent — followup + nudge are NOT high-priority", () => {
  assert.equal(isHighPriorityEvent("followup"), false);
  assert.equal(isHighPriorityEvent("nudge"), false);
});

test("isHighPriorityEvent — unknown types are NOT high-priority", () => {
  assert.equal(isHighPriorityEvent("garbage"), false);
  assert.equal(isHighPriorityEvent(""), false);
});
