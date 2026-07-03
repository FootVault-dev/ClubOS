-- ADDITIVE ONLY — safe to run on the live Supabase DB (prod has schema drift;
-- never `db:push --force`). Run this BEFORE deploying the matching server build.
--
-- API hardening round 2: key rotation lineage, failed-auth log (brute-force
-- protection + alerting), and indexes for the retention pruner.

-- 1. Rotation lineage — new key remembers which key it replaced
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS rotated_from_id integer;

-- 2. Failed key-auth attempts (invalid/expired keys presented)
CREATE TABLE IF NOT EXISTS api_auth_failures (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  ip text,
  path text,
  presented_prefix text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS api_auth_failures_ip_created_idx
  ON api_auth_failures (ip, created_at DESC);

-- 3. Retention pruning + DB-backed rate limiting need a plain time index
CREATE INDEX IF NOT EXISTS api_key_request_logs_created_idx
  ON api_key_request_logs (created_at);
