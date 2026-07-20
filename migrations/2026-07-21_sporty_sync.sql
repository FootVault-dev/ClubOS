-- Sporty / NZ Football NRS outbound registration push — sync state, audit log,
-- reference-data cache. ADDITIVE ONLY (prod-DB-drift rule): new tables, no
-- changes to existing objects. Safe to run before OR after deploy — the old app
-- simply never touches these tables.
--
-- Doctrine (see shared/schema.ts + shared/sporty.ts):
--  · sporty_sync_state.sporty_id is the NRS registration id. Sporty requires it
--    to be saved from ANY response that carries one (including errors) and sent
--    on every later RegisterPerson — so contact deletion is RESTRICTed while a
--    sync row exists: losing the linkage risks double-registering a child.
--  · status/block_reason/outcome are text, validated app-side — no CHECK
--    constraints (a stale CHECK is how the MFL checkout once 500'd).

CREATE TABLE IF NOT EXISTS sporty_sync_state (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id integer NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
  sporty_id integer,
  person_fifa_id text,
  status text NOT NULL DEFAULT 'pending',
  block_reason text,
  last_error text,
  last_payload_hash text,
  last_pushed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  excluded_reason text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT sporty_sync_state_contact_unique UNIQUE (contact_id)
);

CREATE INDEX IF NOT EXISTS sporty_sync_state_org_status_idx
  ON sporty_sync_state (organization_id, status);

CREATE TABLE IF NOT EXISTS sporty_push_log (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id integer REFERENCES contacts(id) ON DELETE SET NULL,
  endpoint text NOT NULL,
  base_url text NOT NULL,
  outcome text NOT NULL,
  http_status integer,
  sporty_id integer,
  message text,
  request_payload jsonb,
  response_body jsonb,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sporty_push_log_contact_idx
  ON sporty_push_log (contact_id, created_at);
CREATE INDEX IF NOT EXISTS sporty_push_log_org_idx
  ON sporty_push_log (organization_id, created_at);

CREATE TABLE IF NOT EXISTS sporty_reference_cache (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sporty_reference_cache_kind_unique UNIQUE (kind)
);
