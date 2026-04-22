/**
 * HER — DEV / TEST notification pipeline harness.
 *
 * SECURITY: Only enabled when NODE_ENV !== "production" AND a matching
 * DEV_TEST_SECRET query/header is provided. Returns 404 otherwise so
 * the route is invisible in prod.
 *
 *   GET  /api/dev/test-notification?secret=...&action=create&type=reminder&minutesAgo=5
 *   GET  /api/dev/test-notification?secret=...&action=shift&eventId=<uuid>&minutes=40
 *   GET  /api/dev/test-notification?secret=...&action=status&eventId=<uuid>
 *   GET  /api/dev/test-notification?secret=...&action=cleanup&userId=test-user
 *
 * Pair with `scripts/test-pipeline.mjs` for orchestrated runs.
 */

import { NextRequest, NextResponse } from "next/server";
import { createScheduledEvent, shiftEventTime } from "@/lib/scheduled-events";
import type { EventType } from "@/lib/temporal";
import { getSupabaseClient } from "@/lib/supabase-client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TEST_USER = "test-user";
const TEST_CONVO = "00000000-0000-0000-0000-00000000beef"; // fixed UUID for repeatable cleanup

function notFound() {
  return new NextResponse("Not Found", { status: 404 });
}

function gate(req: NextRequest): boolean {
  if (process.env.NODE_ENV === "production") return false;
  const expected = process.env.DEV_TEST_SECRET || "her-dev";
  const secret =
    req.nextUrl.searchParams.get("secret") ||
    req.headers.get("x-dev-secret") ||
    req.headers.get("authorization")?.replace("Bearer ", "");
  return secret === expected;
}

export async function GET(req: NextRequest) {
  if (!gate(req)) return notFound();

  const params = req.nextUrl.searchParams;
  const action = params.get("action") ?? "create";

  try {
    switch (action) {
      case "create":
        return await actionCreate(params);
      case "shift":
        return await actionShift(params);
      case "status":
        return await actionStatus(params);
      case "cleanup":
        return await actionCleanup(params);
      default:
        return NextResponse.json({ error: `unknown action: ${action}` }, { status: 400 });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[HER DevTest] action failed", { action, message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// ─── action: create ────────────────────────────────────────

async function actionCreate(params: URLSearchParams) {
  const type = (params.get("type") ?? "reminder") as EventType;
  const minutesAgo = Number(params.get("minutesAgo") ?? "5"); // schedule in past so cron fires now
  const weight = (params.get("weight") ?? "medium") as "low" | "medium" | "high";
  const summary = params.get("summary") ?? "test notification";
  const userId = params.get("userId") ?? TEST_USER;
  const conversationId = params.get("conversationId") ?? TEST_CONVO;

  const triggerAt = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();

  const eventId = await createScheduledEvent({
    userId,
    conversationId,
    intent: {
      type,
      triggerAt,
      context: {
        summary,
        emotionalWeight: weight,
        category: type === "promise" ? "promise" : "task",
      },
    },
    originalMessage: `[dev-test] ${summary}`,
    applyVariance: false, // tests want deterministic timing
  });

  if (!eventId) {
    return NextResponse.json({ error: "createScheduledEvent returned null" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, action: "create", eventId, type, triggerAt, userId });
}

// ─── action: shift ─────────────────────────────────────────

async function actionShift(params: URLSearchParams) {
  const eventId = params.get("eventId");
  const minutes = Number(params.get("minutes") ?? "30");
  if (!eventId) return NextResponse.json({ error: "eventId required" }, { status: 400 });

  const updated = await shiftEventTime(eventId, minutes);
  if (!updated) return NextResponse.json({ error: "event not found" }, { status: 404 });

  return NextResponse.json({
    ok: true,
    action: "shift",
    eventId,
    minutes,
    trigger_at: updated.trigger_at,
    sent_at: updated.sent_at,
    status: updated.status,
  });
}

// ─── action: status ────────────────────────────────────────

async function actionStatus(params: URLSearchParams) {
  const eventId = params.get("eventId");
  const client = getSupabaseClient();
  if (!client) return NextResponse.json({ error: "no supabase client" }, { status: 500 });

  if (eventId) {
    const { data, error } = await client
      .from("scheduled_events")
      .select("*")
      .eq("id", eventId)
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 404 });
    return NextResponse.json({ ok: true, event: data });
  }

  const userId = params.get("userId") ?? TEST_USER;
  const { data, error } = await client
    .from("scheduled_events")
    .select("id, type, status, trigger_at, sent_at, missed_at, completed_at, followup_sent_at, context")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, count: data?.length ?? 0, events: data ?? [] });
}

// ─── action: cleanup ───────────────────────────────────────

async function actionCleanup(params: URLSearchParams) {
  const userId = params.get("userId") ?? TEST_USER;
  const client = getSupabaseClient();
  if (!client) return NextResponse.json({ error: "no supabase client" }, { status: 500 });

  const { error, count } = await client
    .from("scheduled_events")
    .delete({ count: "exact" })
    .eq("user_id", userId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  console.log("[HER DevTest] CLEANUP", { userId, deleted: count });
  return NextResponse.json({ ok: true, action: "cleanup", userId, deleted: count ?? 0 });
}
