/**
 * HER — Timezone-Aware Time Formatting
 *
 * Single source of truth for converting absolute UTC time into a
 * user-local view. Used by:
 *   - System prompt (so HER quotes the user's wall-clock time correctly)
 *   - Temporal detection (so "tomorrow at 9am" resolves in user's local TZ)
 *   - Notification message generation
 *
 * Design:
 *   - All timestamps stored/transmitted as UTC ISO
 *   - User TZ (IANA name like "Asia/Kolkata") flows in from browser via
 *     `Intl.DateTimeFormat().resolvedOptions().timeZone`
 *   - Server NEVER assumes a timezone — falls back to a clear UTC label
 *     when none provided, so the model knows to be cautious about times
 */

export interface LocalTimeView {
  /** IANA timezone name (e.g. "Asia/Kolkata", "America/Los_Angeles") */
  timezone: string;
  /** True if a real user timezone was provided (not a fallback) */
  isUserTimezone: boolean;
  /** Absolute UTC ISO timestamp */
  utcIso: string;
  /** Human-friendly UTC label, e.g. "2026-04-20 10:54 UTC" */
  utcLabel: string;
  /** Human-friendly user-local label, e.g. "Monday, April 20, 2026, 4:24 PM IST" */
  localLabel: string;
  /** Short user-local time only, e.g. "4:24 PM" */
  localShortTime: string;
  /** Detected short timezone abbreviation (e.g. "IST", "PST") — best effort */
  tzAbbreviation: string;
}

/**
 * Format an instant for both UTC and the user's local timezone.
 *
 * @param now      The instant to format (defaults to current server time)
 * @param timezone IANA tz name from the browser. Falls back to UTC.
 */
export function formatLocalTimeView(
  now: Date = new Date(),
  timezone?: string | null
): LocalTimeView {
  const isUserTimezone = isValidTimezone(timezone);
  const tz = isUserTimezone ? (timezone as string) : "UTC";

  const utcIso = now.toISOString();
  const utcLabel = formatInTimezone(now, "UTC", {
    weekday: undefined,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });

  const localLabel = formatInTimezone(now, tz, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  });

  const localShortTime = formatInTimezone(now, tz, {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  const tzAbbreviation = extractTimezoneAbbreviation(now, tz);

  return {
    timezone: tz,
    isUserTimezone,
    utcIso,
    utcLabel,
    localLabel,
    localShortTime,
    tzAbbreviation,
  };
}

/**
 * Build the standard "current time" block injected into LLM prompts so
 * the model always anchors on the user's wall-clock — never quotes server
 * UTC time when answering questions like "what time is it now?".
 */
export function buildCurrentTimePromptBlock(view: LocalTimeView): string {
  if (!view.isUserTimezone) {
    return [
      `CURRENT DATE & TIME (UTC — user timezone unknown):`,
      `  ${view.utcLabel}`,
      `Note: when the user mentions wall-clock times, ask them what timezone they're in before quoting any specific local time.`,
    ].join("\n");
  }
  return [
    `CURRENT DATE & TIME:`,
    `  User local: ${view.localLabel}`,
    `  Absolute  : ${view.utcLabel}`,
    `  Timezone  : ${view.timezone}`,
    `When the user asks what time it is, or you reference a clock time in your reply, ALWAYS use their local time (${view.localShortTime} ${view.tzAbbreviation}). Never quote UTC at them. When you say "in 2 hours" or "tomorrow at 9am", interpret in their local timezone.`,
  ].join("\n");
}

/**
 * Build the standard temporal-detection prompt header so the LLM resolves
 * relative ("in 2 hours") and absolute ("tomorrow 9am") references correctly
 * in the user's local timezone, then returns triggerAt as UTC ISO.
 */
export function buildTemporalTimeHeader(view: LocalTimeView): string {
  if (!view.isUserTimezone) {
    return [
      `Current absolute time (UTC): ${view.utcIso}`,
      `User timezone: UNKNOWN — if the user mentions wall-clock times like "9am tomorrow", set triggerAt to null instead of guessing.`,
    ].join("\n");
  }
  return [
    `Current absolute time (UTC): ${view.utcIso}`,
    `User local time: ${view.localLabel}`,
    `User timezone: ${view.timezone}`,
    `Interpret all wall-clock references ("9am tomorrow", "tonight", "in the morning") in the user's local timezone, then return triggerAt as a UTC ISO timestamp.`,
  ].join("\n");
}

// ── Internals ──────────────────────────────────────────────

function isValidTimezone(tz?: string | null): boolean {
  if (!tz || typeof tz !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function formatInTimezone(
  now: Date,
  timezone: string,
  options: Intl.DateTimeFormatOptions
): string {
  try {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: timezone }).format(now);
  } catch {
    // Fallback to UTC if formatting fails for any reason
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(now);
  }
}

function extractTimezoneAbbreviation(now: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "short",
    }).formatToParts(now);
    const tzPart = parts.find((p) => p.type === "timeZoneName");
    return tzPart?.value || timezone;
  } catch {
    return timezone;
  }
}
