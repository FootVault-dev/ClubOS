-- ADDITIVE ONLY — safe to run on the live Supabase DB (prod has schema drift;
-- never `db:push --force`). Run this BEFORE deploying the matching server build.
--
-- Scoped API keys: multi-org binding + per-request audit trail, and an explicit
-- scope upgrade for the legacy full-access key (scopes used to be stored but
-- never enforced — the deploy that pairs with this migration starts enforcing).

-- 1. Multi-org binding for keys (NULL = key's single organization_id, as before)
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS allowed_org_ids integer[];

-- 2. Audit trail — one row per authenticated /api/v1/* request
CREATE TABLE IF NOT EXISTS api_key_request_logs (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  api_key_id integer NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  method text NOT NULL,
  path text NOT NULL,
  status integer,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS api_key_request_logs_key_created_idx
  ON api_key_request_logs (api_key_id, created_at DESC);

-- 3. Upgrade legacy keys that carry the old unenforced ['read'] marker to an
--    explicit full read-scope set across all workspaces (this is Daniel's
--    "AIOS Production" key — the only key in existence at migration time).
--    New keys are created with explicit least-privilege scopes from now on.
UPDATE api_keys
SET
  scopes = ARRAY[
    'overview:read','analytics:read','customers:read','camps:read',
    'registrations:read','league:read','tournament:read','cic7s:read','sporty:read'
  ],
  allowed_org_ids = (SELECT array_agg(id ORDER BY id) FROM organizations)
WHERE scopes = ARRAY['read']::text[];
