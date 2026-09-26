-- ─── CHESTS TABLE ────────────────────────────────────────────────────────────
-- Stores individual CT chest scan readings — one row per chest opening.
-- Synced from GET /v1/chests via the sync-chests Edge Function.
-- Completely separate from epic_chests (tournament results).

CREATE TABLE IF NOT EXISTS chests (
  id            TEXT        PRIMARY KEY,            -- CT's own record UUID (stored as text to match players.id)
  player_id     TEXT        REFERENCES players(id) ON DELETE SET NULL,
  clan          TEXT        NOT NULL,               -- "69R" / "69S"
  chest_name    TEXT,                               -- e.g. "Golden Guardian Epic Chest"
  chest_source  TEXT,                               -- e.g. "Epic Ancient Squad" / "Rise of the Ancients Event"
  chest_type    TEXT,                               -- CT definition type field
  quantity      INTEGER     DEFAULT 1,              -- chests opened in this scan
  points        INTEGER,                            -- CT point value for this chest type
  generated_at  TIMESTAMPTZ,                        -- when the chest was opened in-game
  reward        JSONB,                              -- e.g. { "lumber": 250000, "gold": 6000 }
  synced_at     TIMESTAMPTZ DEFAULT NOW()           -- when this row was last written
);

-- Indexes for the most common query patterns
CREATE INDEX IF NOT EXISTS chests_player_id_idx    ON chests(player_id);
CREATE INDEX IF NOT EXISTS chests_generated_at_idx ON chests(generated_at DESC);
CREATE INDEX IF NOT EXISTS chests_clan_idx         ON chests(clan);
CREATE INDEX IF NOT EXISTS chests_chest_source_idx ON chests(chest_source);

-- ─── HOURLY PG_CRON SCHEDULE ─────────────────────────────────────────────────
-- Calls the sync-chests Edge Function every hour at :00.
-- The function itself reads config.chestsSync.lookbackHours (default 1) and
-- config.chestsSync.initialLookbackDays (default 21) to control the window.
-- On first run (no lastSyncAt in config) it pulls the last 21 days.
--
-- IMPORTANT: Run this AFTER deploying the sync-chests Edge Function.
-- Replace <YOUR_SUPABASE_URL> and <YOUR_SERVICE_ROLE_KEY> with real values,
-- or use the pg_net helper pattern below if those settings are already configured.

SELECT cron.schedule(
  'sync-chests-hourly',
  '0 * * * *',
  $$
  SELECT net.http_post(
    url     := 'https://jssybjxthkhrzxbzpslx.supabase.co/functions/v1/sync-chests',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
    ),
    body    := '{}'::jsonb
  ) AS request_id;
  $$
);
