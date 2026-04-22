-- HER — Step 17.4: Self-Healing & Intelligent Notification System
--
-- Adds lifecycle tracking columns to scheduled_events so the cron can:
--   1. Detect missed reminders (sent but no user reply within window)
--   2. Send a single soft follow-up per event
--   3. Track adaptive reschedules (linked back to the original event)
--   4. Power memory integration (completed vs missed signals)
--
-- Lifecycle:
--   pending → sent → (missed | completed | rescheduled | cancelled)
--
-- Run once in Supabase SQL editor.

-- ── 1. Lifecycle timestamps ────────────────────────────────
ALTER TABLE scheduled_events
  ADD COLUMN IF NOT EXISTS sent_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS missed_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rescheduled_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS followup_sent_at TIMESTAMPTZ;

-- ── 2. Reschedule provenance ───────────────────────────────
ALTER TABLE scheduled_events
  ADD COLUMN IF NOT EXISTS rescheduled_from_event_id UUID
    REFERENCES scheduled_events(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reschedule_reason TEXT;

-- ── 3. Expand status CHECK to include new lifecycle states ─
ALTER TABLE scheduled_events
  DROP CONSTRAINT IF EXISTS scheduled_events_status_check;

ALTER TABLE scheduled_events
  ADD CONSTRAINT scheduled_events_status_check
  CHECK (status IN ('pending','sent','cancelled','missed','completed','rescheduled'));

-- ── 4. Index for the missed-detection pass ─────────────────
-- The cron's missed-pass query is:
--   status='sent' AND followup_sent_at IS NULL AND sent_at <= now() - threshold
CREATE INDEX IF NOT EXISTS idx_scheduled_events_followup_pending
  ON scheduled_events (status, followup_sent_at, sent_at)
  WHERE status = 'sent' AND followup_sent_at IS NULL;

-- ── 5. Backfill sent_at for events already marked sent ─────
UPDATE scheduled_events
   SET sent_at = COALESCE(sent_at, trigger_at)
 WHERE status = 'sent' AND sent_at IS NULL;
