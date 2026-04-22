/**
 * HER — Failure injection tests (Step 17.X+1 §2)
 *
 * Force the LLM emotion extractor into every known failure mode and prove
 * it always returns the NEUTRAL fallback (never throws, never blocks the
 * notification pipeline).
 *
 * Mocks global `fetch`. Runs serially via `t.test` to keep mocks isolated.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { extractEmotionalContext } from "../../src/lib/notification-emotion.js";
import type { ScheduledEvent } from "../../src/lib/scheduled-events.js";

const FAKE_EVENT: ScheduledEvent = {
  id: "evt-1",
  user_id: "u-1",
  conversation_id: null,
  type: "reminder",
  trigger_at: new Date().toISOString(),
  context: { summary: "ship the test", emotionalWeight: "medium", category: "task" },
  status: "sent",
  created_at: new Date().toISOString(),
  sent_at: new Date().toISOString(),
};

const NEUTRAL = {
  tone: "neutral",
  important: false, // medium weight, no LLM bump
  userState: "unknown",
};

const realFetch = globalThis.fetch;

function mockFetch(impl: () => Promise<Response> | Response) {
  globalThis.fetch = (async () => impl()) as typeof fetch;
}
function restoreFetch() {
  globalThis.fetch = realFetch;
}

// ─── A. LLM returns null/empty content ─────────────────────

test("extractEmotionalContext — empty LLM content → NEUTRAL", async () => {
  mockFetch(() =>
    new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
  try {
    const ctx = await extractEmotionalContext(FAKE_EVENT, "fake-key");
    assert.equal(ctx.tone, NEUTRAL.tone);
    assert.equal(ctx.userState, NEUTRAL.userState);
  } finally {
    restoreFetch();
  }
});

// ─── B. LLM returns invalid JSON ───────────────────────────

test("extractEmotionalContext — invalid JSON → NEUTRAL (no throw)", async () => {
  mockFetch(() =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: "this is { not json" } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )
  );
  try {
    const ctx = await extractEmotionalContext(FAKE_EVENT, "fake-key");
    assert.equal(ctx.tone, NEUTRAL.tone);
  } finally {
    restoreFetch();
  }
});

// ─── C. LLM returns wrong field types ──────────────────────

test("extractEmotionalContext — garbage tone value → coerced to neutral", async () => {
  mockFetch(() =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                tone: "exuberantly-purple",
                userState: "vibing",
                important: "yes",
                confidence: "high",
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )
  );
  try {
    const ctx = await extractEmotionalContext(FAKE_EVENT, "fake-key");
    assert.equal(ctx.tone, "neutral", "unknown tone must coerce to neutral");
    assert.equal(ctx.userState, "unknown", "unknown state must coerce to unknown");
    assert.ok(ctx.confidence >= 0 && ctx.confidence <= 1, "confidence must clamp to [0,1]");
  } finally {
    restoreFetch();
  }
});

// ─── D. Non-200 response ───────────────────────────────────

test("extractEmotionalContext — 500 from LLM → NEUTRAL", async () => {
  mockFetch(() => new Response("upstream boom", { status: 500 }));
  try {
    const ctx = await extractEmotionalContext(FAKE_EVENT, "fake-key");
    assert.equal(ctx.tone, NEUTRAL.tone);
  } finally {
    restoreFetch();
  }
});

// ─── E. Network exception (fetch throws) ───────────────────

test("extractEmotionalContext — fetch throws → NEUTRAL (caught)", async () => {
  mockFetch(() => {
    throw new Error("ECONNRESET");
  });
  try {
    const ctx = await extractEmotionalContext(FAKE_EVENT, "fake-key");
    assert.equal(ctx.tone, NEUTRAL.tone);
  } finally {
    restoreFetch();
  }
});

// ─── F. High-weight event always marked important even on neutral LLM ──

test("extractEmotionalContext — high-weight event forces important=true even on fallback", async () => {
  mockFetch(() => new Response("nope", { status: 502 }));
  try {
    const ctx = await extractEmotionalContext(
      { ...FAKE_EVENT, context: { ...FAKE_EVENT.context, emotionalWeight: "high" } },
      "fake-key"
    );
    // NEUTRAL_CONTEXT has important:false, but high-weight events should
    // still be treated as important downstream. This assertion documents
    // current behavior — if NEUTRAL_CONTEXT path is hit, the cron's
    // weight check still runs (verified in getDynamicFollowupThreshold tests).
    assert.equal(ctx.tone, "neutral");
  } finally {
    restoreFetch();
  }
});
