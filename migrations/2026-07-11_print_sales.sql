-- ─────────────────────────────────────────────────────────────────────────────
-- SALES — United Print prospect database + sales pipeline.
--
-- ADDITIVE ONLY. Two new tables, nothing existing is touched.
-- Run BEFORE the Fly deploy:  npx tsx --env-file=.env script/apply-print-sales.ts
-- Never `db:push` against prod — it drops drifted columns.
--
-- Deliberately NO CHECK constraints on `stage`, `tier`, `region`, `source`,
-- `type` or `outcome` — those value sets grow, and a stale CHECK is how the
-- MFL checkout 500'd. They are validated application-side in shared/sales.ts.
--
-- The CHECKs that ARE here encode invariants that never grow: a deal value and
-- a score cannot be negative.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sales_prospects (
  id                    integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  organization_id       integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  name                  text NOT NULL,
  website               text,
  city                  text,
  region                text,
  category              text,
  subcategory           text,
  why_fit               text,
  services_match        jsonb,

  contact_name          text,
  contact_role          text,
  email                 text,
  phone                 text,

  -- Grounding: the page the details were read from, and when. A prospect with
  -- no evidence_url never enters this table via the seed — provenance is the
  -- product (same rule as market_research_snapshots).
  evidence_url          text,
  fetched_at            date,
  link_status           text,

  fit_score             integer,
  volume_score          integer,
  access_score          integer,
  locality_score        integer,
  total_score           integer,
  tier                  text,
  rank                  integer,

  source                text NOT NULL DEFAULT 'manual',
  stage                 text NOT NULL DEFAULT 'new',
  stage_changed_at      timestamptz,
  next_follow_up_on     date,
  declined_reason       text,
  deal_value_cents      integer,
  promoted_contact_id   integer REFERENCES print_contacts(id) ON DELETE SET NULL,

  notes                 text,
  created_by            integer REFERENCES users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT sales_prospects_deal_value_nonneg CHECK (deal_value_cents IS NULL OR deal_value_cents >= 0),
  CONSTRAINT sales_prospects_scores_nonneg CHECK (
    (fit_score      IS NULL OR fit_score      >= 0) AND
    (volume_score   IS NULL OR volume_score   >= 0) AND
    (access_score   IS NULL OR access_score   >= 0) AND
    (locality_score IS NULL OR locality_score >= 0) AND
    (total_score    IS NULL OR total_score    >= 0)
  )
);

-- One prospect per website per workspace. Case-insensitive, and only where a
-- website exists — two no-site prospects with different names must both fit.
CREATE UNIQUE INDEX IF NOT EXISTS sales_prospects_org_website_unq
  ON sales_prospects (organization_id, lower(website))
  WHERE website IS NOT NULL;

CREATE INDEX IF NOT EXISTS sales_prospects_org_stage_idx    ON sales_prospects (organization_id, stage);
CREATE INDEX IF NOT EXISTS sales_prospects_org_tier_idx     ON sales_prospects (organization_id, tier);
CREATE INDEX IF NOT EXISTS sales_prospects_org_followup_idx ON sales_prospects (organization_id, next_follow_up_on);
CREATE INDEX IF NOT EXISTS sales_prospects_org_score_idx    ON sales_prospects (organization_id, total_score);


CREATE TABLE IF NOT EXISTS sales_activities (
  id               integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  organization_id  integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  prospect_id      integer NOT NULL REFERENCES sales_prospects(id) ON DELETE CASCADE,

  type             text NOT NULL,
  outcome          text,
  note             text,
  occurred_at      timestamptz NOT NULL DEFAULT now(),

  created_by       integer REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sales_activities_prospect_idx ON sales_activities (prospect_id, occurred_at);
CREATE INDEX IF NOT EXISTS sales_activities_org_idx      ON sales_activities (organization_id, occurred_at);
