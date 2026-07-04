-- ─────────────────────────────────────────────────────────────────────────────
-- Proposal Tracker — a CRM + link-analytics layer over every proposal Daniel &
-- Ryan send (sponsorship / investor / development / partnership / client), sorted
-- by type + category, each with a tracked short link (app.usg.co.nz/r/{code})
-- whose opens land in proposal_events.
--
-- ADDITIVE ONLY — safe to run against the live Supabase DB (new tables + a small
-- idempotent category seed for the USG workspace). Run BEFORE the Fly deploy.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS proposals (
  id                 integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id    integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title              text NOT NULL,
  company            text,
  proposal_type      text NOT NULL DEFAULT 'sponsorship',
  category           text,
  brand_tags         text[] NOT NULL DEFAULT ARRAY[]::text[],
  status             text NOT NULL DEFAULT 'draft',
  value_cents        integer,
  currency           text NOT NULL DEFAULT 'NZD',
  owner              text,
  contact_name       text,
  contact_email      text,
  contact_phone      text,
  link_url           text,
  short_code         text UNIQUE,
  source_tag         text,
  -- Soft link to a USG Studio proposal page (no FK: studio_documents isn't live
  -- in prod yet). Holds a studio_documents.id once Studio ships.
  studio_document_id integer,
  notes              text,
  sent_at            timestamp,
  decision_at        timestamp,
  last_opened_at     timestamp,
  open_count         integer NOT NULL DEFAULT 0,
  created_by         integer REFERENCES users(id),
  archived           boolean NOT NULL DEFAULT false,
  created_at         timestamp NOT NULL DEFAULT now(),
  updated_at         timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS proposals_org_idx        ON proposals(organization_id);
CREATE INDEX IF NOT EXISTS proposals_type_idx       ON proposals(organization_id, proposal_type);
CREATE INDEX IF NOT EXISTS proposals_status_idx     ON proposals(organization_id, status);
CREATE INDEX IF NOT EXISTS proposals_short_code_idx ON proposals(short_code);

CREATE TABLE IF NOT EXISTS proposal_categories (
  id              integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  proposal_type   text,
  color           text NOT NULL DEFAULT '#3b82f6',
  sort_order      integer NOT NULL DEFAULT 0,
  archived        boolean NOT NULL DEFAULT false,
  created_at      timestamp NOT NULL DEFAULT now(),
  CONSTRAINT proposal_categories_org_name_unique UNIQUE (organization_id, name)
);

CREATE TABLE IF NOT EXISTS proposal_events (
  id           integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  proposal_id  integer NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  kind         text NOT NULL DEFAULT 'open',
  visitor_id   text,
  device       text,
  user_agent   text,
  referrer     text,
  country      text,
  is_internal  boolean NOT NULL DEFAULT false,
  meta_json    jsonb,
  occurred_at  timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS proposal_events_proposal_idx ON proposal_events(proposal_id, occurred_at);
CREATE INDEX IF NOT EXISTS proposal_events_kind_idx     ON proposal_events(proposal_id, kind);

-- ── Seed starter categories for United Sports Group ──────────────────────────
-- Idempotent (ON CONFLICT on the org+name unique). These are the buckets Daniel
-- named; he can add/rename/recolour more from the Proposals tab.
DO $$
DECLARE v_org integer;
BEGIN
  SELECT id INTO v_org FROM organizations WHERE slug = 'united-sports-group' LIMIT 1;
  IF v_org IS NULL THEN
    RAISE NOTICE 'united-sports-group org not found — skipping proposal category seed';
    RETURN;
  END IF;

  -- CUFC/USG commercial proposals ONLY. Agency/client work (Conscious Studio —
  -- Core Pilates, DF Hair, etc.) is a SEPARATE business and must never be mixed
  -- in here. See memory feedback_conscious_studio_not_clubos.
  INSERT INTO proposal_categories (organization_id, name, proposal_type, color, sort_order) VALUES
    (v_org, 'Breweries / Beer', 'sponsorship',  '#d97706', 0),
    (v_org, 'Gyms & Fitness',   'partnership',  '#22c55e', 1),
    (v_org, 'La Liga',          'partnership',  '#8b5cf6', 3),
    (v_org, 'Padel / USC Dev',  'development',  '#06b6d4', 4),
    (v_org, 'Investor',         'investor',     '#f59e0b', 5),
    (v_org, 'General',          'sponsorship',  '#3b82f6', 6)
  ON CONFLICT (organization_id, name) DO NOTHING;
END $$;
