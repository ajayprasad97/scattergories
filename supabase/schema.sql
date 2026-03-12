-- ─────────────────────────────────────────────
-- Scattergories — Supabase Schema
-- Run this in your Supabase SQL Editor once.
-- ─────────────────────────────────────────────

-- Every game session
CREATE TABLE IF NOT EXISTS game_sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_code    TEXT NOT NULL,
  letter       TEXT NOT NULL,
  duration_sec INT NOT NULL,
  question_count INT NOT NULL,
  categories   TEXT[] NOT NULL,       -- array of category strings used that round
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at     TIMESTAMPTZ
);

-- Every player who participated in a session
CREATE TABLE IF NOT EXISTS game_players (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   UUID NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  player_name  TEXT NOT NULL,
  final_score  INT NOT NULL DEFAULT 0,
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Every answer submitted (one row per player per category)
CREATE TABLE IF NOT EXISTS game_answers (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   UUID NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  player_id    UUID NOT NULL REFERENCES game_players(id) ON DELETE CASCADE,
  category     TEXT NOT NULL,
  answer       TEXT NOT NULL DEFAULT '',
  valid        BOOLEAN NOT NULL DEFAULT TRUE,   -- false = flagged/duplicate
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_sessions_code    ON game_sessions(game_code);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON game_sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_players_session  ON game_players(session_id);
CREATE INDEX IF NOT EXISTS idx_answers_session  ON game_answers(session_id);
CREATE INDEX IF NOT EXISTS idx_answers_player   ON game_answers(player_id);
