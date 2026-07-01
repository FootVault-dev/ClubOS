-- CUGC gymnastics enrolments (from the cugc.co.nz marketing site).
-- ADDITIVE ONLY — safe to run on the live Supabase DB. Run this BEFORE the Fly deploy
-- that ships the new endpoints (per the prod-DB rule: never db:push --force).

CREATE TABLE IF NOT EXISTS cugc_registrations (
  id                    INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id       INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  program_slug          TEXT NOT NULL,
  program_name          TEXT NOT NULL,
  option_label          TEXT NOT NULL,
  session_time          TEXT,
  price_cents           INTEGER NOT NULL,          -- what they pay today (may be prorated)
  full_price_cents      INTEGER NOT NULL,          -- advertised full-term price
  term                  TEXT,
  gymnast_name          TEXT NOT NULL,
  gymnast_dob           TEXT,
  parent_name           TEXT NOT NULL,
  email                 TEXT NOT NULL,
  phone                 TEXT,
  emergency_name        TEXT,
  emergency_phone       TEXT,
  medical               TEXT,
  photo_consent         TEXT,
  heard_via             TEXT,
  status                TEXT NOT NULL DEFAULT 'pending_payment', -- 'pending_payment' | 'paid' | 'cancelled'
  stripe_session_id     TEXT,
  stripe_payment_intent TEXT,
  paid_at               TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cugc_registrations_org
  ON cugc_registrations (organization_id, created_at DESC);
