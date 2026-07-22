-- CUFC Open Trainings (2026-07-21). ADDITIVE ONLY.
--
-- U9–U20 academy programmes are invite-only (Daniel's directive): the public
-- open-training request form on cufc.co.nz replaces the direct checkout for
-- those age bands (and sits alongside it for U4–U8). Requests land here, staff
-- approve or decline them in the CUFC workspace "Open Trainings" tab, and an
-- approval emails the family their session confirmation.
--
-- No CHECK constraints on the enum-ish columns (age_group, status) — statuses
-- are validated in the app; a stale CHECK on drifted prod is how the MFL
-- checkout 500'd. child_dob is ISO text on purpose: a `date` column read via
-- node-postgres renders a day out in NZ.
BEGIN;

CREATE TABLE IF NOT EXISTS cufc_open_trainings (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  age_group text NOT NULL,
  child_first_name text NOT NULL,
  child_last_name text NOT NULL,
  child_dob text NOT NULL,
  age_grade integer,
  guardian_name text NOT NULL,
  email text NOT NULL,
  phone text NOT NULL,
  current_club text,
  notes text,
  status text NOT NULL DEFAULT 'pending',
  session_details text,
  staff_notes text,
  decided_at timestamptz,
  decided_by text,
  source text,
  source_url text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cufc_open_trainings_org_status_idx
  ON cufc_open_trainings (organization_id, status, created_at);

COMMIT;
