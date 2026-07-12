-- ─────────────────────────────────────────────────────────────────────────────
-- Sponsor Traffic — tracks how much website traffic the club sends to its
-- sponsors' sites via tracked redirect links (app.usg.co.nz/s/{shortCode}),
-- plus a sponsor-site health check. Built because a sponsor's site went down
-- and we only found out because a friend mentioned it.
--
-- One `sponsors` row = one PLACEMENT (a sponsor on one brand site) — a shared
-- sponsor (e.g. Moana Skies on both CUFC and SIU) gets a row per brand because
-- the destination URL and tracked link differ per brand.
--
-- ADDITIVE ONLY — safe to run against the live Supabase DB (new tables only).
-- Run BEFORE the Fly deploy.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sponsors (
  id                integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id   integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name              text NOT NULL,
  brand             text NOT NULL,
  website_url       text NOT NULL,
  short_code        text NOT NULL UNIQUE,
  logo_url          text,
  tier              text,
  -- Health check: ok | down | unknown (default until first check runs).
  site_status       text NOT NULL DEFAULT 'unknown',
  site_status_code  integer,
  site_checked_at   timestamp,
  active            boolean NOT NULL DEFAULT true,
  notes             text,
  open_count        integer NOT NULL DEFAULT 0,
  last_opened_at    timestamp,
  created_at        timestamp NOT NULL DEFAULT now(),
  updated_at        timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sponsors_org_idx        ON sponsors(organization_id);
CREATE INDEX IF NOT EXISTS sponsors_short_code_idx ON sponsors(short_code);
CREATE INDEX IF NOT EXISTS sponsors_brand_idx       ON sponsors(brand);

CREATE TABLE IF NOT EXISTS sponsor_link_events (
  id           integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sponsor_id   integer NOT NULL REFERENCES sponsors(id) ON DELETE CASCADE,
  kind         text NOT NULL DEFAULT 'click',
  visitor_id   text,
  device       text,
  user_agent   text,
  referrer     text,
  source       text,
  country      text,
  is_internal  boolean NOT NULL DEFAULT false,
  meta_json    jsonb,
  occurred_at  timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sponsor_link_events_sponsor_idx ON sponsor_link_events(sponsor_id, occurred_at);
CREATE INDEX IF NOT EXISTS sponsor_link_events_kind_idx    ON sponsor_link_events(sponsor_id, kind);
