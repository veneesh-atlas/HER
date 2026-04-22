/**
 * debug — Lightweight, no-op-in-production logger.
 *
 * Why this exists:
 *   - We want diagnostic logging in dev (memory pipeline, temporal events,
 *     vision pipeline, cron jobs) without paying the cost in production.
 *   - Vercel function logs count toward retention quota; a chatty server
 *     burns through it fast.
 *   - Some old `console.log` calls leaked snippets of user content (memory
 *     context, push message bodies, intent summaries). Routing them through
 *     `debug()` ensures they vanish in prod, period.
 *
 * Usage:
 *   import { debug, debugWarn } from "@/lib/debug";
 *   debug("[HER Memory]", "Saved", count, "facts");        // dev only
 *   debugWarn("[HER Push]", "Subscription expired");       // dev only
 *
 * For genuine errors that should ALWAYS surface (failures, 500s, etc.),
 * keep using `console.error` directly — those are signal, not noise.
 */

const isDev = process.env.NODE_ENV !== "production";

/** Verbose info — silent in production. */
export function debug(...args: unknown[]): void {
  if (isDev) console.log(...args);
}

/** Warnings — silent in production. Use console.error for hard failures. */
export function debugWarn(...args: unknown[]): void {
  if (isDev) console.warn(...args);
}

// ── Step 17.X+2: Ghost Debug Mode ─────────────────────────
//
// Standardised, greppable lifecycle log format:
//
//     [HER][<layer>][event:<shortId>] message  { ...meta }
//
// Designed to be tracked by a single `eventId` from intent → delivery →
// follow-up using nothing more than `grep "event:7e5b"` over server logs.
// All log levels (info / warn / error) are emitted in BOTH dev and prod
// because these are operational signal — never user content.

export type HERLayer =
  | "Temporal"
  | "Events"
  | "Cron"
  | "Emotion"
  | "Push"
  | "DevTest";

/** First 8 chars of a UUID — long enough to be unique in practice, short
 *  enough to scan. Falls back to "unknown" for null/undefined. */
export function shortId(eventId: string | null | undefined): string {
  if (!eventId) return "unknown";
  return eventId.replace(/-/g, "").slice(0, 8);
}

function fmt(layer: HERLayer, eventId: string | null | undefined, message: string): string {
  return `[HER][${layer}][event:${shortId(eventId)}] ${message}`;
}

/** Standard info — always logged. Use for lifecycle milestones. */
export function logHER(
  layer: HERLayer,
  eventId: string | null | undefined,
  message: string,
  meta?: Record<string, unknown>
): void {
  if (meta) console.log(fmt(layer, eventId, message), meta);
  else console.log(fmt(layer, eventId, message));
}

/** Warning — always logged. Use for soft failures + skipped deliveries. */
export function warnHER(
  layer: HERLayer,
  eventId: string | null | undefined,
  message: string,
  meta?: Record<string, unknown>
): void {
  if (meta) console.warn(fmt(layer, eventId, message), meta);
  else console.warn(fmt(layer, eventId, message));
}

/** Error — always logged. Use for hard failures (DB inserts, push, LLM). */
export function errorHER(
  layer: HERLayer,
  eventId: string | null | undefined,
  message: string,
  meta?: Record<string, unknown>
): void {
  if (meta) console.error(fmt(layer, eventId, message), meta);
  else console.error(fmt(layer, eventId, message));
}
