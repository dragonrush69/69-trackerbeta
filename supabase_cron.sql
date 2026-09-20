-- ─── Schedule sync-epic-chests to run every hour ─────────────────────────────
-- Paste this into Supabase Dashboard → SQL Editor and click Run.
--
-- Prerequisites:
--   1. pg_net extension must be enabled:
--      Supabase Dashboard → Database → Extensions → search "pg_net" → Enable
--   2. pg_cron is already enabled on all Supabase projects.
--
-- Your Edge Function URL and anon key are pre-filled below.

-- Step 1: Enable pg_net (safe to run even if already enabled)
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Step 2: Remove any previous version of this job (safe to run on first setup too)
SELECT cron.unschedule('sync-epic-chests-hourly')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'sync-epic-chests-hourly'
);

-- Step 3: Schedule the Edge Function to run at the top of every hour
SELECT cron.schedule(
  'sync-epic-chests-hourly',   -- job name
  '0 * * * *',                 -- every hour at :00
  $$
  SELECT net.http_post(
    url     := 'https://jssybjxthkhrzxbzpslx.supabase.co/functions/v1/sync-epic-chests',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Impzc3lianh0aGtocnp4Ynpwc2x4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk4Nzk5NTQsImV4cCI6MjEwNTQ1NTk1NH0.d5yGivZXVuiangjMgAHxSu8Qs5i7wW8jn6hSJZdgMD4'
    ),
    body    := '{}'::jsonb
  ) AS request_id;
  $$
);

-- ── Verify it was created ──────────────────────────────────────────────────────
-- Run this separately to confirm the job exists:
-- SELECT jobname, schedule, command FROM cron.job WHERE jobname = 'sync-epic-chests-hourly';

-- ── To remove the schedule later ─────────────────────────────────────────────
-- SELECT cron.unschedule('sync-epic-chests-hourly');
