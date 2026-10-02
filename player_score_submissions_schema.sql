-- ─── PLAYER SCORE SUBMISSIONS ────────────────────────────────────────────────
-- Stores self-reported scores submitted by players via screenshot upload.
-- AI extracts name + score from the screenshot; auto-approved on submission.

-- 1. Add manual_report flag to definitions
--    Safe to run even if column already exists.
ALTER TABLE definitions ADD COLUMN IF NOT EXISTS manual_report BOOLEAN DEFAULT false;
ALTER TABLE definitions ADD COLUMN IF NOT EXISTS manual_report_label TEXT; -- friendly display name override

-- 2. Mark which events are manual (run once, update as needed)
-- Example — update these to match your actual event names in definitions:
-- UPDATE definitions SET manual_report = true, manual_report_label = 'Rise of Ancients'
--   WHERE name ILIKE '%rise of ancients%';

-- 3. player_score_submissions table
CREATE TABLE IF NOT EXISTS player_score_submissions (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id        TEXT        REFERENCES players(id) ON DELETE SET NULL,
  player_name      TEXT        NOT NULL,
  clan             TEXT        NOT NULL,
  event_id         TEXT,                          -- definitions.id if available
  event_name       TEXT        NOT NULL,
  event_date       DATE        NOT NULL,          -- from the event calendar
  extracted_name   TEXT,                          -- what the AI read from the screenshot
  extracted_score  BIGINT,                        -- what the AI read from the screenshot
  score            BIGINT      NOT NULL,          -- confirmed score (from extracted)
  screenshot_url   TEXT,                          -- Storage path if we save the image
  status           TEXT        NOT NULL DEFAULT 'approved', -- auto-approve
  submitted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes            TEXT                           -- any AI confidence notes
);

CREATE INDEX IF NOT EXISTS pss_player_id_idx   ON player_score_submissions(player_id);
CREATE INDEX IF NOT EXISTS pss_event_date_idx  ON player_score_submissions(event_date DESC);
CREATE INDEX IF NOT EXISTS pss_clan_idx        ON player_score_submissions(clan);
CREATE INDEX IF NOT EXISTS pss_event_name_idx  ON player_score_submissions(event_name);

-- 4. RLS — anon can INSERT (players submit); anon can SELECT their own clan
ALTER TABLE player_score_submissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_insert" ON player_score_submissions
  FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "anon_select" ON player_score_submissions
  FOR SELECT TO anon USING (true);

GRANT SELECT, INSERT ON player_score_submissions TO anon, authenticated;
