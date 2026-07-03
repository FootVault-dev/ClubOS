-- OFC Pro League licensing tracker (SIU workspace) — a live workbook of every
-- licensing criterion + its evidence sub-items, feedback and working status.
-- ADDITIVE ONLY — safe on the live Supabase DB. Run BEFORE the Fly deploy that
-- ships the endpoints (per the prod-DB rule: never db:push --force).

CREATE TABLE IF NOT EXISTS licensing_criteria (
  id                INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id   INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code              TEXT NOT NULL,                              -- 'S.01', 'P.12', 'Article 21.2(d)'
  category          TEXT NOT NULL,                              -- 'Sporting', 'Legal', 'Financial'...
  name              TEXT NOT NULL,
  grade             TEXT NOT NULL DEFAULT 'A',                  -- 'A' | 'B' | 'C'
  requirement_type  TEXT,                                       -- 'Essential'...
  owner             TEXT,                                       -- 'Ryan' | 'Dan' | 'Zach' | null
  deadline          DATE,
  status            TEXT NOT NULL DEFAULT 'not_started',        -- workflow (see client)
  assessment        TEXT,                                       -- OFC-material assessment (Needs light edit...)
  priority          TEXT,                                       -- 'High' | 'Medium' | 'Low'
  maturity_target   INTEGER,                                    -- 1 or 3 (score-3 bar)
  action_required   TEXT,
  evidence_2025     TEXT,
  key_risk          TEXT,
  source_urls       TEXT,
  ofc_feedback      TEXT,                                       -- OFC review feedback → resubmit
  resubmit_needed   BOOLEAN NOT NULL DEFAULT false,
  notes             TEXT,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_licensing_criteria_org
  ON licensing_criteria (organization_id, sort_order);
CREATE UNIQUE INDEX IF NOT EXISTS idx_licensing_criteria_org_code
  ON licensing_criteria (organization_id, code);

CREATE TABLE IF NOT EXISTS licensing_subtasks (
  id                INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id   INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  criterion_id      INTEGER NOT NULL REFERENCES licensing_criteria(id) ON DELETE CASCADE,
  code              TEXT NOT NULL,                              -- parent criterion code (denormalised)
  item_num          TEXT,                                       -- '1.0', '2.0'
  description       TEXT NOT NULL,
  grade             TEXT,
  required          BOOLEAN NOT NULL DEFAULT true,
  due_date          DATE,
  status            TEXT NOT NULL DEFAULT 'not_started',        -- 'not_started' | 'in_progress' | 'done' | 'na'
  evidence_2025     TEXT,
  action_required   TEXT,
  source_urls       TEXT,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_licensing_subtasks_org
  ON licensing_subtasks (organization_id);
CREATE INDEX IF NOT EXISTS idx_licensing_subtasks_criterion
  ON licensing_subtasks (criterion_id, sort_order);
