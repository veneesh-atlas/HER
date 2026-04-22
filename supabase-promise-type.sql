-- HER — Allow 'promise' as a scheduled_events.type
--
-- The temporal detector classifies user-directed asks ("remind me…",
-- "tell me…", "wish me…") as type='promise'. The original CHECK
-- constraint only allowed ('reminder','followup','nudge') so every
-- promise insert silently failed with Postgres error 23514, and
-- /api/temporal returned {detected:false} with no event scheduled.
--
-- Run this once in the Supabase SQL editor.

ALTER TABLE scheduled_events
  DROP CONSTRAINT IF EXISTS scheduled_events_type_check;

ALTER TABLE scheduled_events
  ADD CONSTRAINT scheduled_events_type_check
  CHECK (type IN ('reminder', 'followup', 'nudge', 'promise'));
