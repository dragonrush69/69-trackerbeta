-- ─── 69 Tracker Beta — Supabase Schema ───────────────────────────────────────
-- Paste ALL of this into Supabase SQL Editor and click Run.
-- Safe to re-run: all tables use CREATE TABLE IF NOT EXISTS.
-- RLS is disabled for the beta — tighten after production migration.

-- ── Players ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS players (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  clan        TEXT NOT NULL,         -- '69R' or '69S'
  active      BOOLEAN NOT NULL DEFAULT true,
  hero        TEXT,
  level       INT,
  might       BIGINT,
  rank_g      INT,
  rank_m      INT,
  rank_s      INT,
  rank_e      INT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE players DISABLE ROW LEVEL SECURITY;

-- ── Level Requests ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS level_requests (
  id              TEXT PRIMARY KEY,
  player_id       TEXT REFERENCES players(id),
  player_name     TEXT NOT NULL,
  clan            TEXT NOT NULL,
  level_type      TEXT,
  from_level      INT,
  to_level        INT,
  status          TEXT NOT NULL DEFAULT 'pending',
  date            DATE,
  resolved_date   DATE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE level_requests DISABLE ROW LEVEL SECURITY;

-- ── Rotation Log ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rotation_log (
  id          TEXT PRIMARY KEY,
  player_id   TEXT REFERENCES players(id),
  player_name TEXT NOT NULL,
  from_clan   TEXT NOT NULL,
  to_clan     TEXT NOT NULL,
  date        DATE NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE rotation_log DISABLE ROW LEVEL SECURITY;

-- ── Fragment Distributions ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fragment_distributions (
  id                TEXT PRIMARY KEY,
  clan              TEXT NOT NULL,
  event_id          TEXT NOT NULL,
  date              DATE,
  score_entry_date  DATE,
  total_fragments   INT,
  config            JSONB,       -- distribution config object
  allocations       JSONB,       -- per-player allocation map
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE fragment_distributions DISABLE ROW LEVEL SECURITY;

-- ── Config (key/value) ────────────────────────────────────────────────────────
-- Stores: pins, norms, ctSync, ctAliases, ctIgnored, lastBackup
CREATE TABLE IF NOT EXISTS config (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE config DISABLE ROW LEVEL SECURITY;

-- ── Weekly Chests ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS weekly_chests (
  id          BIGSERIAL PRIMARY KEY,
  week_start  DATE NOT NULL,
  clan        TEXT NOT NULL,
  player_id   TEXT NOT NULL REFERENCES players(id),
  points      INT NOT NULL DEFAULT 0,
  synced_at   TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (week_start, clan, player_id)
);
ALTER TABLE weekly_chests DISABLE ROW LEVEL SECURITY;

-- ── Tin Man (Rise of the Ancients) ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tin_man (
  id          BIGSERIAL PRIMARY KEY,
  week_start  DATE NOT NULL,
  clan        TEXT NOT NULL,
  player_id   TEXT NOT NULL REFERENCES players(id),
  points      INT NOT NULL DEFAULT 0,
  synced_at   TIMESTAMPTZ,
  source      TEXT NOT NULL DEFAULT 'manual',   -- 'manual' | 'api' | 'screenshot'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (week_start, clan, player_id)
);
ALTER TABLE tin_man DISABLE ROW LEVEL SECURITY;

-- ── Ragnarok ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ragnarok (
  id          BIGSERIAL PRIMARY KEY,
  week_start  DATE NOT NULL,
  clan        TEXT NOT NULL,
  player_id   TEXT NOT NULL REFERENCES players(id),
  points      INT NOT NULL DEFAULT 0,
  synced_at   TIMESTAMPTZ,
  source      TEXT NOT NULL DEFAULT 'manual',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (week_start, clan, player_id)
);
ALTER TABLE ragnarok DISABLE ROW LEVEL SECURITY;

-- ── Omens of Gods ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS omens (
  id          BIGSERIAL PRIMARY KEY,
  week_start  DATE NOT NULL,
  clan        TEXT NOT NULL,
  player_id   TEXT NOT NULL REFERENCES players(id),
  essence     INT NOT NULL DEFAULT 0,
  damage      BIGINT NOT NULL DEFAULT 0,
  chests      INT NOT NULL DEFAULT 0,
  synced_at   TIMESTAMPTZ,
  source      TEXT NOT NULL DEFAULT 'manual',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (week_start, clan, player_id)
);
ALTER TABLE omens DISABLE ROW LEVEL SECURITY;

-- ── Olympus ───────────────────────────────────────────────────────────────────
-- Expanded vs production: chest breakdown columns added
CREATE TABLE IF NOT EXISTS olympus (
  id                  BIGSERIAL PRIMARY KEY,
  week_start          DATE NOT NULL,
  clan                TEXT NOT NULL,
  player_id           TEXT NOT NULL REFERENCES players(id),
  score               BIGINT NOT NULL DEFAULT 0,
  total_chests        INT NOT NULL DEFAULT 0,
  regular_chests      INT,
  gold_chests         INT,
  epic_chests         INT,
  legendary_chests    INT,
  synced_at           TIMESTAMPTZ,
  source              TEXT NOT NULL DEFAULT 'manual',   -- 'manual' | 'api' | 'screenshot'
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (week_start, clan, player_id)
);
ALTER TABLE olympus DISABLE ROW LEVEL SECURITY;

-- ── Epic Chests ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS epic_chests (
  id          BIGSERIAL PRIMARY KEY,
  week_start  DATE NOT NULL,
  clan        TEXT NOT NULL,
  player_id   TEXT NOT NULL REFERENCES players(id),
  total_score INT NOT NULL DEFAULT 0,   -- sum across all monsters
  synced_at   TIMESTAMPTZ,
  source      TEXT NOT NULL DEFAULT 'api',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (week_start, clan, player_id)
);
ALTER TABLE epic_chests DISABLE ROW LEVEL SECURITY;

-- ── Epic Chest Breakdown (per monster) ───────────────────────────────────────
-- One row per player per monster per week
CREATE TABLE IF NOT EXISTS epic_chest_breakdown (
  id              BIGSERIAL PRIMARY KEY,
  epic_chest_id   BIGINT NOT NULL REFERENCES epic_chests(id) ON DELETE CASCADE,
  monster_name    TEXT NOT NULL,
  chest_count     INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (epic_chest_id, monster_name)
);
ALTER TABLE epic_chest_breakdown DISABLE ROW LEVEL SECURITY;

-- ── Daily Chests ──────────────────────────────────────────────────────────────
-- Daily CT API pull — breakdown by chest type per player
CREATE TABLE IF NOT EXISTS daily_chests (
  id                  BIGSERIAL PRIMARY KEY,
  date                DATE NOT NULL,
  clan                TEXT NOT NULL,
  player_id           TEXT NOT NULL REFERENCES players(id),
  total_chests        INT NOT NULL DEFAULT 0,
  regular_chests      INT NOT NULL DEFAULT 0,
  gold_chests         INT NOT NULL DEFAULT 0,
  epic_chests         INT NOT NULL DEFAULT 0,
  legendary_chests    INT NOT NULL DEFAULT 0,
  synced_at           TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (date, clan, player_id)
);
ALTER TABLE daily_chests DISABLE ROW LEVEL SECURITY;

-- ── Screenshots ───────────────────────────────────────────────────────────────
-- Tracks uploaded screenshots and their extraction status
CREATE TABLE IF NOT EXISTS screenshots (
  id                  BIGSERIAL PRIMARY KEY,
  event_type          TEXT NOT NULL,   -- 'olympus' | 'tin_man' | 'omens' | etc.
  week_start          DATE NOT NULL,
  clan                TEXT NOT NULL,
  file_path           TEXT,            -- Supabase Storage path
  extraction_status   TEXT NOT NULL DEFAULT 'pending',  -- 'pending'|'processing'|'complete'|'failed'
  extracted_data      JSONB,           -- raw extraction result before validation
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE screenshots DISABLE ROW LEVEL SECURITY;

-- ── Registered Users (future player-based auth) ──────────────────────────────
-- Ties a Supabase Auth user to a player record.
-- Not wired up yet — PIN auth is used in the beta.
-- When auth is enabled: RLS policies will use this table to restrict data access.
CREATE TABLE IF NOT EXISTS registered_users (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  player_id   TEXT REFERENCES players(id),
  clan        TEXT,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE registered_users DISABLE ROW LEVEL SECURITY;

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_players_clan         ON players(clan);
CREATE INDEX IF NOT EXISTS idx_weekly_chests_week   ON weekly_chests(week_start, clan);
CREATE INDEX IF NOT EXISTS idx_tin_man_week         ON tin_man(week_start, clan);
CREATE INDEX IF NOT EXISTS idx_ragnarok_week        ON ragnarok(week_start, clan);
CREATE INDEX IF NOT EXISTS idx_omens_week           ON omens(week_start, clan);
CREATE INDEX IF NOT EXISTS idx_olympus_week         ON olympus(week_start, clan);
CREATE INDEX IF NOT EXISTS idx_epic_chests_week     ON epic_chests(week_start, clan);
CREATE INDEX IF NOT EXISTS idx_daily_chests_date    ON daily_chests(date, clan);
CREATE INDEX IF NOT EXISTS idx_screenshots_event    ON screenshots(event_type, week_start, clan);
