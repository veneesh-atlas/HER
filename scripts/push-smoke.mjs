#!/usr/bin/env node
/**
 * HER — 30-second push smoke test
 *
 * Drives the "manual local push test" runbook (Step 17.X+3) without you
 * needing to copy-paste URLs into a browser.
 *
 * Flow:
 *   1. Preflight  — dev server reachable? CRON_SECRET set?
 *   2. Status     — show the most recent N events for `--user`
 *   3. Cron tick  — call /api/cron/notify and pretty-print delivered/delayed
 *   4. Status     — show the same events again so you can see what changed
 *
 * Usage:
 *   node scripts/push-smoke.mjs                 # uses test-user
 *   node scripts/push-smoke.mjs --user <uuid>   # your real auth user_id
 *   node scripts/push-smoke.mjs --watch         # keep ticking every 5s
 *
 * Env:
 *   HER_BASE_URL       (default http://localhost:3000)
 *   CRON_SECRET        (must match server)
 *   DEV_TEST_SECRET    (default 'her-dev')
 */

const BASE = process.env.HER_BASE_URL || "http://localhost:3000";
const CRON = process.env.CRON_SECRET || "";
const DEV  = process.env.DEV_TEST_SECRET || "her-dev";

const args = process.argv.slice(2);
const userId = (() => {
  const i = args.indexOf("--user");
  return i >= 0 ? args[i + 1] : "test-user";
})();
const watch = args.includes("--watch");

const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m",
  cyan: "\x1b[36m", magenta: "\x1b[35m",
};
const ok   = (m) => console.log(`${c.green}✔${c.reset} ${m}`);
const warn = (m) => console.log(`${c.yellow}⚠${c.reset} ${m}`);
const fail = (m) => console.log(`${c.red}✘${c.reset} ${m}`);
const step = (m) => console.log(`\n${c.cyan}▸ ${m}${c.reset}`);

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

// ─── 1. Preflight ──────────────────────────────────────────

async function preflight() {
  step("1. Preflight");
  // Server reachable?
  try {
    const r = await get("/");
    if (r.status >= 500) { fail(`Dev server returned ${r.status}`); return false; }
    ok(`Dev server reachable at ${BASE}`);
  } catch (e) {
    fail(`Dev server not reachable: ${e.message}`);
    fail("→ run `npm run dev` in another terminal");
    return false;
  }
  if (!CRON) {
    warn("CRON_SECRET unset locally — cron will reject if server requires it");
    warn("→ export CRON_SECRET=<value from .env.local> and re-run");
  } else {
    ok("CRON_SECRET present");
  }
  return true;
}

// ─── 2 / 4. Show recent events for user ────────────────────

async function showEvents(label) {
  step(`${label} — last 10 events for user="${userId}"`);
  const r = await get(`/api/dev/test-notification?secret=${DEV}&action=status&userId=${encodeURIComponent(userId)}`);
  if (r.status !== 200) {
    fail(`status action returned ${r.status}: ${JSON.stringify(r.body)}`);
    return [];
  }
  const events = r.body.events ?? [];
  if (events.length === 0) {
    warn("No events found.");
    warn(`→ in chat as user "${userId}", send: "remind me in 30 seconds to test notifications"`);
    return [];
  }
  for (const e of events.slice(0, 10)) {
    const id = e.id?.slice(0, 8);
    const trig = new Date(e.trigger_at).toLocaleTimeString();
    const sent = e.sent_at ? new Date(e.sent_at).toLocaleTimeString() : "—";
    const stat = e.status.padEnd(11);
    const fu   = e.followup_sent_at ? "  +followup" : "";
    console.log(`  ${c.dim}[${id}]${c.reset} ${stat}  type=${e.type.padEnd(8)}  trig=${trig}  sent=${sent}${fu}`);
  }
  return events;
}

// ─── 3. Cron tick ──────────────────────────────────────────

async function cronTick() {
  step("3. Cron tick");
  const r = await get(`/api/cron/notify?secret=${encodeURIComponent(CRON)}`);
  if (r.status === 401) {
    fail("401 — CRON_SECRET mismatch. Check .env.local on the server side.");
    return null;
  }
  if (r.status !== 200) {
    fail(`Cron returned ${r.status}: ${JSON.stringify(r.body)}`);
    return null;
  }
  const b = r.body;
  console.log(`  ${c.bold}processed${c.reset}=${b.processed}  delayed=${b.delayed}  followups=${b.followups ?? 0}  missedSilent=${b.missedSilent ?? 0}  total=${b.total ?? "—"}`);
  if (b.processed >= 1) ok("At least one event was DELIVERED — check the device for a push");
  else if (b.delayed >= 1) warn("Event was DELAYED (quiet hours / cooldown / fatigue). Check server logs.");
  else if (b.followups >= 1) ok(`${b.followups} soft follow-up(s) sent`);
  else warn("Cron found nothing to do. Either no due events, or already processed.");
  return b;
}

// ─── 5. Diagnostic hints based on outcome ──────────────────

function diagnose(before, cron, after) {
  step("5. Diagnostic");
  if (!cron) { fail("Cron failed — see error above"); return; }

  const beforeStatus = new Map(before.map((e) => [e.id, e.status]));
  const transitions = after
    .filter((e) => beforeStatus.get(e.id) !== e.status)
    .map((e) => `  [${e.id.slice(0,8)}] ${beforeStatus.get(e.id) ?? "(new)"} → ${e.status}`);

  if (transitions.length > 0) {
    ok("State transitions this tick:");
    transitions.forEach((t) => console.log(t));
  } else {
    warn("No event states changed this tick.");
  }

  // Hints
  if (cron.processed === 0 && cron.delayed === 0 && before.length === 0) {
    console.log(`\n${c.yellow}Hint:${c.reset} no events exist for user "${userId}".`);
    console.log("  • In chat, send a message that creates a temporal intent.");
    console.log("  • Or test the pipeline with: npm run test:pipeline");
  } else if (cron.processed === 0 && before.some((e) => e.status === "pending")) {
    console.log(`\n${c.yellow}Hint:${c.reset} pending events exist but cron didn't pick any.`);
    console.log("  • Their trigger_at may be in the future. Check the trig= column above.");
    console.log("  • If you sent 'in 30 seconds', wait 30 seconds and try again.");
  }
  if (cron.processed >= 1 && !after.some((e) => e.context?.lastSentMessage || e.sent_at)) {
    warn("Cron reported processed but no event shows sent_at — schema/race condition?");
  }
}

// ─── Main ──────────────────────────────────────────────────

async function runOnce() {
  const before = await showEvents("2. Before tick");
  const cron = await cronTick();
  const after = await showEvents("4. After tick");
  diagnose(before, cron ?? { processed: 0, delayed: 0 }, after);
}

(async () => {
  console.log(`${c.bold}HER Push Smoke Test${c.reset}  ${c.dim}target=${BASE}  user=${userId}${c.reset}`);
  if (!(await preflight())) process.exit(1);

  if (watch) {
    console.log(`\n${c.magenta}Watch mode — Ctrl+C to stop. Ticking every 5s.${c.reset}`);
    while (true) {
      await runOnce();
      await new Promise((r) => setTimeout(r, 5000));
    }
  } else {
    await runOnce();
    console.log(`\n${c.dim}Re-run with --watch to keep ticking every 5s.${c.reset}`);
  }
})().catch((e) => { fail(e.message); process.exit(1); });
