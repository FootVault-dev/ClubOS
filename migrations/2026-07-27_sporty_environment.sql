-- Namespace Sporty sync state and reference data by ENVIRONMENT (uat | prod).
--
-- Why this exists (found the day UAT keys arrived, 2026-07-27):
--   A SportyId only means something inside the environment that issued it.
--   Registration 41822 in UAT is a test row; 41822 in production is somebody's
--   child. The SportyId doctrine (see shared/schema.ts + SPORTY.md) sends any
--   STORED id on every later push — so a UAT id sitting in the row the live
--   push reads would be sent to the real National Registration System, either
--   updating a stranger's registration or failing loudly at the worst moment.
--   sporty_push_log already recorded base_url; sync state and the reference
--   cache did not, and both are read back to make decisions.
--
--   ClubOS runs a single DATABASE_URL, so UAT testing and production pushes
--   share one database by design. Environment is therefore part of the natural
--   key, not a nice-to-have.
--
-- ADDITIVE + IDEMPOTENT. Both tables are empty at time of writing (verified),
-- so the backfill below is a no-op; it is written to be correct anyway.
--
-- NOTE: environment is NOT NULL with NO DEFAULT on purpose. A writer that does
-- not name its environment must fail loudly rather than silently claim to be
-- production. Every insert in server/sporty-engine.ts supplies it explicitly.

-- ── sporty_sync_state ───────────────────────────────────────────────────────

ALTER TABLE sporty_sync_state ADD COLUMN IF NOT EXISTS environment text;

-- Any pre-existing row predates UAT credentials, so it can only have come from
-- a production-configured push. (Currently zero rows.)
UPDATE sporty_sync_state SET environment = 'prod' WHERE environment IS NULL;

ALTER TABLE sporty_sync_state ALTER COLUMN environment SET NOT NULL;
ALTER TABLE sporty_sync_state ALTER COLUMN environment DROP DEFAULT;

-- One state row per contact PER environment (was: per contact).
ALTER TABLE sporty_sync_state DROP CONSTRAINT IF EXISTS sporty_sync_state_contact_unique;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sporty_sync_state_contact_env_unique'
      AND conrelid = 'sporty_sync_state'::regclass
  ) THEN
    ALTER TABLE sporty_sync_state
      ADD CONSTRAINT sporty_sync_state_contact_env_unique UNIQUE (contact_id, environment);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS sporty_sync_state_env_idx
  ON sporty_sync_state (environment, organization_id);

-- ── sporty_reference_cache ──────────────────────────────────────────────────
-- UAT's country/gender/ethnicity vocabulary is not proof of what production
-- accepts. Mapping against the wrong list is how bad data reaches a register.

ALTER TABLE sporty_reference_cache ADD COLUMN IF NOT EXISTS environment text;

UPDATE sporty_reference_cache SET environment = 'prod' WHERE environment IS NULL;

ALTER TABLE sporty_reference_cache ALTER COLUMN environment SET NOT NULL;
ALTER TABLE sporty_reference_cache ALTER COLUMN environment DROP DEFAULT;

ALTER TABLE sporty_reference_cache DROP CONSTRAINT IF EXISTS sporty_reference_cache_kind_unique;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sporty_reference_cache_kind_env_unique'
      AND conrelid = 'sporty_reference_cache'::regclass
  ) THEN
    ALTER TABLE sporty_reference_cache
      ADD CONSTRAINT sporty_reference_cache_kind_env_unique UNIQUE (kind, environment);
  END IF;
END $$;
