-- ─── Schema fixes for migration ──────────────────────────────────────────────
-- Run this in Supabase SQL Editor before re-running the migration script.

-- Points columns: INT overflows for high-scoring events (max INT = 2,147,483,647)
ALTER TABLE tin_man      ALTER COLUMN points TYPE BIGINT;
ALTER TABLE ragnarok     ALTER COLUMN points TYPE BIGINT;
ALTER TABLE weekly_chests ALTER COLUMN points TYPE BIGINT;

-- Level request levels can be decimal in the source data
ALTER TABLE level_requests ALTER COLUMN from_level TYPE NUMERIC(12,4);
ALTER TABLE level_requests ALTER COLUMN to_level   TYPE NUMERIC(12,4);
