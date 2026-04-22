#!/usr/bin/env node
/**
 * HER — End-to-end notification pipeline simulation.
 *
 * Drives the full stack against a running dev server WITHOUT waiting
 * real time:
 *
 *   1. Cleanup any prior test data
 *   2. Create a "reminder" scheduled in the recent past
 *   3. Trigger /api/cron/notify (main pass)        → expect delivery
 *   4. Shift the event 40 min into the past
 *   5. Trigger cron again (missed pass)            → expect soft follow-up
 *   6. Print final event status (sent/missed/followup_sent_at flags)
 *
 * Requires:
 *   - dev server running on http://localhost:3000  (npm run dev)
 *   - DEV_TEST_SECRET in .env.local (or default "her-dev")
 *   - CRON_SECRET     in .env.local
 *
 * Run:  node scripts/test-pipeline.mjs
 */

const BASE = process.env.HER_BASE_URL || "http://localhost:3000";
const DEV_SECRET = process.env.DEV_TEST_SECRET || "her-dev";
const CRON_SECRET = process.env.CRON_SECRET || "";
const USER_ID = "test-user";

const c = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m",
};
const log = (label, data) => console.log(`${c.cyan}▸ ${label}${c.reset}`, data ?? "");
const ok  = (msg) => console.log(`${c.green}✔ ${msg}${c.reset}`);
const warn= (msg) => console.log(`${c.yellow}⚠ ${msg}${c.reset}`);
const err = (msg) => console.log(`${c.red}✘ ${msg}${c.reset}`);

async function hit(path) {
  const url = `${BASE}${path}`;
  const res = await fetch(url);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) throw new Error(`${res.status} ${url} → ${typeof body === "string" ? body : JSON.stringify(body)}`);
  return body;
}

async function dev(action, extra = "") {
  return hit(`/api/dev/test-notification?secret=${DEV_SECRET}&action=${action}${extra}`);
}

async function fireCron() {
  if (!CRON_SECRET) {
    warn("CRON_SECRET not set — cron may reject. Set it in env to silence this.");
  }
  return hit(`/api/cron/notify?secret=${encodeURIComponent(CRON_SECRET)}`);
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

(async () => {
  console.log(`${c.bold}\nHER Notification Pipeline Simulation${c.reset}`);
  console.log(`${c.dim}Target: ${BASE}${c.reset}\n`);

  try {
    // ── Step 1: cleanup
    log("1. Cleanup prior test events");
    const cleanup = await dev("cleanup", `&userId=${USER_ID}`);
    ok(`Removed ${cleanup.deleted} stale event(s)`);

    // ── Step 2: create event in recent past
    log("2. Create reminder (5 min ago, weight=medium)");
    const created = await dev("create", "&type=reminder&minutesAgo=5&weight=medium&summary=ship%20the%20test");
    ok(`Event ${created.eventId} created  trigger=${created.triggerAt}`);
    const eventId = created.eventId;

    // ── Step 3: first cron pass — main delivery
    log("3. Trigger cron (main pass) — expect delivery");
    const cron1 = await fireCron();
    log("   cron result", cron1);
    if (cron1.processed >= 1) ok(`Main pass processed ${cron1.processed} event(s)`);
    else warn("Main pass did not process the event — check quiet-hours / push subscription");

    await sleep(250); // let DB writes settle
    let status = await dev("status", `&eventId=${eventId}`);
    log("   event after main pass", {
      status: status.event?.status,
      sent_at: status.event?.sent_at,
      followup_sent_at: status.event?.followup_sent_at,
    });

    // ── Step 4: fast-forward into the past so missed-pass triggers
    log("4. Shift event 40 min into the past");
    const shifted = await dev("shift", `&eventId=${eventId}&minutes=40`);
    ok(`trigger_at=${shifted.trigger_at}  sent_at=${shifted.sent_at ?? "(none)"}`);

    // ── Step 5: second cron pass — missed follow-up
    log("5. Trigger cron (missed pass) — expect soft follow-up");
    const cron2 = await fireCron();
    log("   cron result", cron2);
    if (cron2.followups >= 1) ok(`Missed pass sent ${cron2.followups} follow-up(s)`);
    else warn("No follow-up sent — likely no push subscription, fatigue gate, or already followed up");

    await sleep(250);
    status = await dev("status", `&eventId=${eventId}`);

    // ── Step 6: final report
    console.log(`\n${c.bold}Final event state${c.reset}`);
    console.log({
      id: status.event?.id,
      type: status.event?.type,
      status: status.event?.status,
      sent_at: status.event?.sent_at,
      missed_at: status.event?.missed_at,
      followup_sent_at: status.event?.followup_sent_at,
    });

    const e = status.event;
    if (e?.sent_at && e?.followup_sent_at) {
      ok("Pipeline verified end-to-end (sent → missed → followup)");
    } else if (e?.sent_at) {
      warn("Sent but no follow-up — verify missed-pass logs");
    } else {
      err("Event was never sent — verify cron auth + push subscription");
    }
  } catch (e) {
    err(e.message);
    process.exitCode = 1;
  }
})();
