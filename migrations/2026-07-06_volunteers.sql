-- Volunteers module — reusable across workspaces (CIC, CUFC academy, SIU, events).
-- Full signup + rostering pipeline: people, allocatable tasks, per-day assignments
-- with hours (drives the academy volunteer-hours ledger). ADDITIVE ONLY.

BEGIN;

CREATE TABLE IF NOT EXISTS volunteers (
  id                 INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id    INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  first_name         TEXT NOT NULL,
  last_name          TEXT,
  email              TEXT NOT NULL,
  phone              TEXT,
  date_of_birth      DATE,
  location           TEXT,
  status             TEXT NOT NULL DEFAULT 'new',
  is_academy_player  BOOLEAN NOT NULL DEFAULT false,
  academy_age_group  TEXT,
  hours_target       DOUBLE PRECISION,
  availability       TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
  interests          TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
  emergency_contact  TEXT,
  tshirt_size        TEXT,
  notes              TEXT,
  review_notes       TEXT,
  source_url         TEXT,
  created_at         TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS volunteers_org_idx ON volunteers (organization_id, created_at);

CREATE TABLE IF NOT EXISTS volunteer_task_types (
  id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id  INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  color            TEXT NOT NULL DEFAULT '#60a5fa',
  active           BOOLEAN NOT NULL DEFAULT true,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMP NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS volunteer_task_types_org_name_unq
  ON volunteer_task_types (organization_id, name);

CREATE TABLE IF NOT EXISTS volunteer_assignments (
  id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id  INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  volunteer_id     INTEGER NOT NULL REFERENCES volunteers(id) ON DELETE CASCADE,
  task_type_id     INTEGER REFERENCES volunteer_task_types(id) ON DELETE SET NULL,
  assignment_date  DATE NOT NULL,
  hours            DOUBLE PRECISION NOT NULL DEFAULT 6,
  completed        BOOLEAN NOT NULL DEFAULT false,
  notes            TEXT,
  created_at       TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS volunteer_assignments_org_date_idx
  ON volunteer_assignments (organization_id, assignment_date);
CREATE UNIQUE INDEX IF NOT EXISTS volunteer_assignments_vol_date_unq
  ON volunteer_assignments (volunteer_id, assignment_date);

COMMIT;
