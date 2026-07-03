-- Work Management System — Phase 1 foundation
-- ADDITIVE ONLY — safe on the live Supabase DB. Run BEFORE the Fly deploy.
--
-- Turns the barely-used group "projects" tab into a full work-management system:
--   • DEPARTMENT axis (the team that owns work) alongside the existing brand tags
--     → every task now carries BOTH a department (owns) and brand(s) (serves): the matrix.
--   • RAG status (on_track / at_risk / off_track) — the colour leadership reads.
--   • GOALS ladder: Vision → Season Goals → Priorities ("Rocks"), 3 levels, self-referential,
--     with lead/lag measures. Tasks link up to a Priority via goal_id.
--   • Extra task fields the weekly staff meeting needs: start_date (backward planning),
--     next_step, is_issue (raise as a blocker), helper_ids (collaborators; owner stays single).
--
-- No new enums / no CHECK constraints on the string-status columns (validated in app) to avoid
-- prod enum-drift. All new columns are nullable / defaulted so existing rows are untouched.

-- ── 1. Departments (org-scoped, seeded, editable in settings) ─────────────────
CREATE TABLE IF NOT EXISTS departments (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  slug            TEXT NOT NULL,
  color           TEXT NOT NULL DEFAULT '#3b82f6',
  lead_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  archived        BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
DO $$ BEGIN
  ALTER TABLE departments ADD CONSTRAINT departments_org_slug_unique UNIQUE (organization_id, slug);
EXCEPTION WHEN duplicate_table THEN NULL; WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_departments_org ON departments (organization_id, sort_order);

-- Seed the 7 default departments for the United Sports Group workspace (idempotent).
INSERT INTO departments (organization_id, name, slug, color, sort_order)
SELECT o.id, d.name, d.slug, d.color, d.sort_order
FROM organizations o
CROSS JOIN (VALUES
  ('Commercial & Sponsorship',     'commercial',  '#ef4444', 1),
  ('Marketing & Content',          'marketing',   '#06b6d4', 2),
  ('Football Ops & Programmes',    'football-ops','#3b82f6', 3),
  ('Events & Tournaments',         'events',      '#a855f7', 4),
  ('Facilities & Operations',      'facilities',  '#22c55e', 5),
  ('Finance & Admin',              'finance',     '#f59e0b', 6),
  ('Product & Technology',         'product',     '#8b5cf6', 7)
) AS d(name, slug, color, sort_order)
WHERE o.slug = 'united-sports-group'
ON CONFLICT (organization_id, slug) DO NOTHING;

-- ── 2. Extend project_tasks (the second axis + meeting fields) ─────────────────
ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL;
ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS rag_status TEXT NOT NULL DEFAULT 'none';   -- none|on_track|at_risk|off_track
ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS start_date DATE;                            -- start-by, for backward planning
ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS next_step TEXT;
ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS is_issue BOOLEAN NOT NULL DEFAULT false;    -- raised as a blocker for the meeting
ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS helper_ids INTEGER[] NOT NULL DEFAULT ARRAY[]::integer[];
ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS goal_id INTEGER;  -- FK added after goals table exists (below)

CREATE INDEX IF NOT EXISTS idx_project_tasks_department ON project_tasks (department_id);
CREATE INDEX IF NOT EXISTS idx_project_tasks_goal ON project_tasks (goal_id);

-- ── 3. Goals ladder: Vision → Season Goal → Priority ("Rock") ─────────────────
-- One self-referential table; `level` distinguishes the three tiers. `parent_id`
-- links a Priority to its Season Goal, a Season Goal to the Vision. Brand is a TAG
-- at every level (never a parallel tree). Department is who owns it.
CREATE TABLE IF NOT EXISTS goals (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  level           TEXT NOT NULL DEFAULT 'priority',   -- vision | season | priority
  parent_id       INTEGER REFERENCES goals(id) ON DELETE SET NULL,
  title           TEXT NOT NULL,
  description     TEXT,
  owner_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  department_id   INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  brand_tags      TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
  rag_status      TEXT NOT NULL DEFAULT 'on_track',   -- none|on_track|at_risk|off_track
  period          TEXT,                               -- '2026' (season) or '2026-Q3' (priority)
  target_date     DATE,
  archived        BOOLEAN NOT NULL DEFAULT false,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_by      INTEGER REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_goals_org ON goals (organization_id, level, sort_order);
CREATE INDEX IF NOT EXISTS idx_goals_parent ON goals (parent_id);

-- Now that goals exists, guard-add the FK from tasks.goal_id → goals.id.
DO $$ BEGIN
  ALTER TABLE project_tasks
    ADD CONSTRAINT project_tasks_goal_fk FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 4. Goal measures (lead / lag metrics) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS goal_measures (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  goal_id      INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  measure_type TEXT NOT NULL DEFAULT 'lead',   -- lead | lag
  target_value NUMERIC,
  current_value NUMERIC DEFAULT 0,
  unit         TEXT,                            -- '$', 'teams', 'conversations', '%'
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_goal_measures_goal ON goal_measures (goal_id, sort_order);
