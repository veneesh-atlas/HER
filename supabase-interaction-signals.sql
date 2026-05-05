-- ═══════════════════════════════════════════════════════════
-- HER — Interaction Signals Table (Step EXP+1)
--
-- Stores BEHAVIORAL signals about each interaction.
-- IMPORTANT: This table NEVER stores emotion labels.
-- Only observable interaction patterns and engagement signals.
--
-- Run in Supabase SQL Editor:
--   Project Dashboard → SQL Editor → New query → Paste → Run
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS interaction_signals (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL,
  conversation_id UUID,
  message_id TEXT,

  -- Behavioral pattern (NOT emotion)
  interaction_pattern TEXT NOT NULL CHECK (interaction_pattern IN (
    'repetitive', 'exploratory', 'goal_oriented',
    'uncertain', 'multi_topic', 'deepening', 'casual'
  )),

  -- How the conversation is evolving
  engagement_trend TEXT NOT NULL CHECK (engagement_trend IN (
    'increasing', 'stable', 'decreasing', 'fluctuating'
  )),

  -- How clear the user's intent is
  user_intent_clarity TEXT NOT NULL CHECK (user_intent_clarity IN (
    'clear', 'somewhat_clear', 'unclear', 'shifting'
  )),

  -- How HER replied (used for continuity, not emotion)
  response_style TEXT NOT NULL CHECK (response_style IN (
    'short', 'balanced', 'detailed', 'playful', 'serious', 'direct'
  )),

  -- Detected transition since the previous turn
  conversation_shift TEXT NOT NULL CHECK (conversation_shift IN (
    'none', 'topic_change', 'tone_shift', 'goal_change'
  )),

  confidence NUMERIC(3, 2) NOT NULL DEFAULT 0.5
    CHECK (confidence >= 0 AND confidence <= 1),

  created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_interaction_signals_user
  ON interaction_signals (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_interaction_signals_conversation
  ON interaction_signals (conversation_id, created_at DESC);

-- Row level security
ALTER TABLE interaction_signals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own interaction signals"
  ON interaction_signals
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════
-- Done.
-- ═══════════════════════════════════════════════════════════
