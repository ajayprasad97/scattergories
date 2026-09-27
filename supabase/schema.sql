-- ─────────────────────────────────────────────
-- Scattergories — Supabase Schema
-- Run this in your Supabase SQL Editor.
-- Safe to re-run: it creates what's missing and upgrades older
-- databases (from before rounds were stored) in place.
-- ─────────────────────────────────────────────

-- Every game (one row per game, however many rounds it has)
CREATE TABLE IF NOT EXISTS game_sessions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_code      TEXT NOT NULL,
  duration_sec   INT NOT NULL,
  question_count INT NOT NULL,
  total_rounds   INT,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at       TIMESTAMPTZ               -- set when the last round is finalised; NULL = abandoned
);

-- Every player who participated in a game
CREATE TABLE IF NOT EXISTS game_players (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   UUID NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  player_name  TEXT NOT NULL,
  final_score  INT NOT NULL DEFAULT 0,      -- running total, updated after every round
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Every finalised round of a game
CREATE TABLE IF NOT EXISTS game_rounds (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   UUID NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  round_number INT NOT NULL,
  letter       TEXT NOT NULL,
  categories   TEXT[] NOT NULL,             -- categories used that round, in order
  ended_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, round_number)
);

-- Every answer submitted (one row per player per category per round)
CREATE TABLE IF NOT EXISTS game_answers (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id     UUID NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  player_id      UUID NOT NULL REFERENCES game_players(id) ON DELETE CASCADE,
  round_id       UUID REFERENCES game_rounds(id) ON DELETE CASCADE,
  round_number   INT,
  category       TEXT NOT NULL,
  answer         TEXT NOT NULL DEFAULT '',
  valid          BOOLEAN NOT NULL DEFAULT TRUE,   -- false = flagged
  points         INT,                             -- 0, 1 or 2 (double points)
  invalid_reason TEXT,                            -- empty / too short / wrong letter / duplicate / voted out
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Upgrade databases created before rounds were stored ──────────────────────
-- Letter and categories used to live on game_sessions (one row per round);
-- they're per-round now, so old rows keep them and new rows leave them NULL.
ALTER TABLE game_sessions ADD COLUMN IF NOT EXISTS letter     TEXT;
ALTER TABLE game_sessions ADD COLUMN IF NOT EXISTS categories TEXT[];
ALTER TABLE game_sessions ALTER COLUMN letter     DROP NOT NULL;
ALTER TABLE game_sessions ALTER COLUMN categories DROP NOT NULL;
ALTER TABLE game_sessions ADD COLUMN IF NOT EXISTS total_rounds INT;

ALTER TABLE game_answers ADD COLUMN IF NOT EXISTS round_id       UUID REFERENCES game_rounds(id) ON DELETE CASCADE;
ALTER TABLE game_answers ADD COLUMN IF NOT EXISTS round_number   INT;
ALTER TABLE game_answers ADD COLUMN IF NOT EXISTS points         INT;
ALTER TABLE game_answers ADD COLUMN IF NOT EXISTS invalid_reason TEXT;

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_sessions_code    ON game_sessions(game_code);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON game_sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_players_session  ON game_players(session_id);
CREATE INDEX IF NOT EXISTS idx_rounds_session   ON game_rounds(session_id);
CREATE INDEX IF NOT EXISTS idx_answers_session  ON game_answers(session_id);
CREATE INDEX IF NOT EXISTS idx_answers_player   ON game_answers(player_id);
CREATE INDEX IF NOT EXISTS idx_answers_round    ON game_answers(round_id);
