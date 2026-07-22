-- ─────────────────────────────────────────────────────────────────────────────
-- MANAGEMENT — the planning workspace (projects → tasks → checklists, with
-- board / table / calendar / Gantt views over one shared dataset). First home:
-- the United Prints workspace (org 8), but the tables are org-scoped and the
-- tab is generic — any workspace can get a "management" tab later without a
-- schema change.
--
-- This is the PLANNING layer (growth projects, marketing pushes, equipment
-- purchases, shop fit-outs) — production job tracking stays in print_orders.
--
-- Design doctrine (house rules):
--   * Statuses are PER-PROJECT rows (plan_statuses), Monday/ClickUp-style
--     custom columns, seeded To do / In progress / Done on project creation.
--     Each carries a `kind` (todo|active|done) so "done" semantics survive
--     any renaming — progress %, overdue and completion logic key on kind,
--     never on a label string.
--   * Overdue is DERIVED (due_date < today-in-NZ AND not done), never stored.
--   * completed_at is stamped SERVER-SIDE when a task enters a kind='done'
--     status (and cleared when it leaves) — the client never sends it.
--   * Dates are date-only ISO strings end to end; never round-tripped
--     through a JS Date (the UTC off-by-one trap).
--   * Vocabulary columns (status kind, priority, project status) are
--     validated TEXT (shared/management.ts), never pg enums and never DB
--     CHECK gates — a stale CHECK is how the MFL checkout 500'd once. The
--     only CHECKs below are plain numeric/shape guards.
--   * Dependencies (plan_task_deps) are finish-to-start edges for the Gantt;
--     cycle prevention is enforced server-side on create.
--
-- ADDITIVE ONLY — safe on the live DB. CREATE ... IF NOT EXISTS, no drops,
-- no ALTERs on existing tables. Run BEFORE the Fly deploy.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Projects ─────────────────────────────────────────────────────────────────
-- The board/container (Monday board / Asana project / Trello board). `color`
-- is the project's identity everywhere — group headers, Gantt swimlanes,
-- calendar pills.
CREATE TABLE IF NOT EXISTS plan_projects (
  id               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id  integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             text NOT NULL,
  description      text,
  color            text NOT NULL DEFAULT '#6366f1',
  status           text NOT NULL DEFAULT 'active',   -- active|completed|archived
  start_date       date,
  target_date      date,
  sort_order       integer NOT NULL DEFAULT 0,
  created_by       integer,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS plan_projects_org_idx ON plan_projects (organization_id);

-- ── Statuses (per-project workflow columns) ──────────────────────────────────
-- Board columns, table groups, and the machine-readable `kind` that survives
-- renames. Deleting a status with tasks is a 400 unless the request names a
-- column to move them to (server-side; the FK below is the backstop).
CREATE TABLE IF NOT EXISTS plan_statuses (
  id               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id  integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id       integer NOT NULL REFERENCES plan_projects(id) ON DELETE CASCADE,
  label            text NOT NULL,
  color            text NOT NULL DEFAULT '#64748b',
  kind             text NOT NULL DEFAULT 'todo',     -- todo|active|done
  sort_order       integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS plan_statuses_project_idx ON plan_statuses (project_id);
CREATE INDEX IF NOT EXISTS plan_statuses_org_idx     ON plan_statuses (organization_id);

-- ── Tasks ────────────────────────────────────────────────────────────────────
-- start_date + due_date give the Gantt its bar (either alone = a 1-day bar;
-- both = an inclusive span). `milestone` renders as a diamond. `progress` is
-- the OWNER'S manual estimate (nullable); when a checklist exists the UI
-- shows done/total instead — user intent and derived state never share a
-- column. `tags` is a free text[] (house pattern, like content brand_tags).
CREATE TABLE IF NOT EXISTS plan_tasks (
  id               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id  integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id       integer NOT NULL REFERENCES plan_projects(id) ON DELETE CASCADE,
  status_id        integer NOT NULL REFERENCES plan_statuses(id) ON DELETE RESTRICT,
  title            text NOT NULL,
  description      text,
  priority         text NOT NULL DEFAULT 'medium',   -- low|medium|high|urgent
  assignee_id      integer,
  start_date       date,
  due_date         date,
  milestone        boolean NOT NULL DEFAULT false,
  progress         integer,
  tags             text[] NOT NULL DEFAULT '{}',
  sort_order       integer NOT NULL DEFAULT 0,
  completed_at     timestamptz,
  archived         boolean NOT NULL DEFAULT false,
  created_by       integer,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plan_tasks_progress_ck CHECK (progress IS NULL OR (progress >= 0 AND progress <= 100))
);
CREATE INDEX IF NOT EXISTS plan_tasks_project_idx  ON plan_tasks (project_id);
CREATE INDEX IF NOT EXISTS plan_tasks_org_idx      ON plan_tasks (organization_id);
CREATE INDEX IF NOT EXISTS plan_tasks_status_idx   ON plan_tasks (status_id);
CREATE INDEX IF NOT EXISTS plan_tasks_assignee_idx ON plan_tasks (assignee_id);

-- ── Dependencies (finish-to-start, the Gantt arrows) ─────────────────────────
-- One row = "successor can start once predecessor finishes". The UNIQUE stops
-- duplicate edges; the CHECK stops self-loops; longer cycles are refused
-- server-side by walking the graph before insert.
CREATE TABLE IF NOT EXISTS plan_task_deps (
  id               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id  integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  predecessor_id   integer NOT NULL REFERENCES plan_tasks(id) ON DELETE CASCADE,
  successor_id     integer NOT NULL REFERENCES plan_tasks(id) ON DELETE CASCADE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plan_task_deps_no_self_ck CHECK (predecessor_id <> successor_id),
  CONSTRAINT plan_task_deps_edge_uq UNIQUE (predecessor_id, successor_id)
);
CREATE INDEX IF NOT EXISTS plan_task_deps_succ_idx ON plan_task_deps (successor_id);
CREATE INDEX IF NOT EXISTS plan_task_deps_org_idx  ON plan_task_deps (organization_id);

-- ── Checklist items (the divvy-up under a task) ──────────────────────────────
CREATE TABLE IF NOT EXISTS plan_checklist_items (
  id               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id  integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  task_id          integer NOT NULL REFERENCES plan_tasks(id) ON DELETE CASCADE,
  title            text NOT NULL,
  done             boolean NOT NULL DEFAULT false,
  assignee_id      integer,
  sort_order       integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS plan_checklist_task_idx ON plan_checklist_items (task_id);
CREATE INDEX IF NOT EXISTS plan_checklist_org_idx  ON plan_checklist_items (organization_id);

-- ── Comments ─────────────────────────────────────────────────────────────────
-- author_name is a denormalized snapshot (recordedBy doctrine) — a comment
-- must still read correctly years after the author's account is gone.
CREATE TABLE IF NOT EXISTS plan_comments (
  id               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id  integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  task_id          integer NOT NULL REFERENCES plan_tasks(id) ON DELETE CASCADE,
  author_id        integer,
  author_name      text,
  body             text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS plan_comments_task_idx ON plan_comments (task_id);
CREATE INDEX IF NOT EXISTS plan_comments_org_idx  ON plan_comments (organization_id);
