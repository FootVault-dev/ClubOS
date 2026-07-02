-- CUGC Free Sessions (trial bookings) + ad attribution on paid enrolments.
-- ADDITIVE ONLY — safe to run on the live Supabase DB (prod has schema drift;
-- never `db:push --force`). Run this BEFORE deploying the matching server build.

CREATE TABLE IF NOT EXISTS cugc_free_sessions (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  program_slug  text NOT NULL,
  program_name  text NOT NULL,
  session_label text NOT NULL,
  session_date  text NOT NULL,
  child_name    text NOT NULL,
  child_age     integer,
  parent_name   text NOT NULL,
  email         text NOT NULL,
  phone         text,
  notes         text,
  staff_notes   text,
  status        text NOT NULL DEFAULT 'booked',
  attended_at   timestamptz,
  source_url    text,
  attribution   jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- First/last-touch ad attribution on paid enrolments (CAC/LTV reporting).
ALTER TABLE cugc_registrations ADD COLUMN IF NOT EXISTS attribution jsonb;
