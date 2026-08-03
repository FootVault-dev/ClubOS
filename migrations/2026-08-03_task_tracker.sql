-- ─────────────────────────────────────────────────────────────────────────────
-- TASK TRACKER — the organisation-wide project & task system.
--
-- One shared dataset for the WHOLE organisation, reachable from every
-- workspace's sidebar (the Chat / Feedback universal-tab pattern). Modelled on
-- the Notion setup Travis ran at Kerkyra United: Projects (and Goals) → Tasks,
-- with an owner, "org areas" and brand tags on every project.
--
-- 🔴 DELIBERATELY NOT ORG-SCOPED. Every other planning table in this database
-- carries organization_id; these do not, and that is the point. Travis oversees
-- work across every brand, so a container-per-workspace would force the same
-- duplication that made Monday.com unusable here: a Marketing task for MFL has
-- to live either in Marketing or in MFL, and whichever you pick, half the work
-- is always in the wrong place. Instead BRAND IS A TAG (`brands text[]`) —
-- "everything for MFL" and "all of Marketing" are two filters over the same
-- rows, nothing is duplicated, and nothing is in the wrong place.
--
-- Design doctrine (house rules, same as plan_* / maint_* / wh_*):
--   * Status columns are DATA (tt_project_statuses / tt_task_statuses), each
--     carrying a machine-readable `kind` (todo|active|blocked|done). Logic keys
--     on KIND, never on a label — so renaming "Done" → "Shipped" can never
--     break completion, overdue or progress maths.
--   * `blocked` is its own kind, not a flag. A blocked task is neither
--     progressing nor finished, and must never be swept in with "in progress"
--     where it looks healthy.
--   * OVERDUE IS DERIVED (due_date < today-in-NZ AND kind <> 'done'), never
--     stored. So is project progress ("29/29") and staleness. A stored
--     percentage is wrong the instant anybody ticks anything.
--   * completed_at and status_changed_at are stamped SERVER-SIDE on the
--     transition; the client never sends them.
--   * Dates are bare YYYY-MM-DD end to end, never round-tripped through a JS
--     Date (midnight UTC is the previous day in New Zealand).
--   * Vocabulary columns are validated TEXT (shared/task-tracker.ts), never pg
--     enums and never CHECK gates — a stale CHECK is how the MFL checkout
--     500'd. The only CHECKs here are plain shape guards.
--   * ONE accountable owner per task, plus any number of helpers
--     (tt_task_assignees). Two accountable people means nobody is.
--
-- Additive only. No existing table is touched.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── Areas — the "org. area" taxonomy, editable in-app (no deploy to add one) ──
CREATE TABLE IF NOT EXISTS tt_areas (
  id           integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  key          text NOT NULL,
  label        text NOT NULL,
  color        text NOT NULL DEFAULT '#6366f1',
  sort_order   integer NOT NULL DEFAULT 0,
  archived     boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- A key is the stable handle stored in tt_projects.areas[]; it must be unique
-- among LIVE areas. Archived rows keep their key so historic projects still
-- resolve a label instead of showing a raw slug.
CREATE UNIQUE INDEX IF NOT EXISTS tt_areas_key_live_uq
  ON tt_areas (key) WHERE archived = false;

-- ── Status columns ───────────────────────────────────────────────────────────
-- Global (not per-project) on purpose. Per-project columns are right for a
-- single team's board, but this tracker's whole job is cross-project views —
-- My Work, the accountability board, "everything overdue" — and those are
-- incoherent if "Done" means something different in every project.

CREATE TABLE IF NOT EXISTS tt_project_statuses (
  id           integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  label        text NOT NULL,
  kind         text NOT NULL DEFAULT 'todo',   -- todo|active|blocked|done
  color        text NOT NULL DEFAULT '#64748b',
  sort_order   integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tt_task_statuses (
  id           integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  label        text NOT NULL,
  kind         text NOT NULL DEFAULT 'todo',   -- todo|active|blocked|done
  color        text NOT NULL DEFAULT '#64748b',
  sort_order   integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ── Projects (and Goals — one database, like the Notion this replaces) ───────
-- Kerkyra's board mixes "School Partnership" (a project) with "100,000 euros of
-- partnership revenue" (a goal/KPI). Keeping them in one table with a `kind`
-- preserves that: a goal is the parent a project ladders up to, and both want
-- an owner, an area, a date and a status.

CREATE TABLE IF NOT EXISTS tt_projects (
  id           integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  name         text NOT NULL,
  emoji        text,
  description  text,
  kind         text NOT NULL DEFAULT 'project',  -- project|goal
  status_id    integer NOT NULL REFERENCES tt_project_statuses(id) ON DELETE RESTRICT,
  -- A project may ladder up to a goal row in this same table. Nullable and
  -- unused by v1's UI, but the column is cheap now and expensive to retrofit
  -- once there are thousands of rows. RESTRICT so deleting a goal can never
  -- silently orphan the projects that justified it.
  parent_goal_id integer REFERENCES tt_projects(id) ON DELETE RESTRICT,
  -- The single accountable person. NOT NULL is deliberately NOT enforced: an
  -- unowned project is a real, visible state ("nobody owns this yet") and the
  -- board flags it. Inventing an owner to satisfy a constraint is worse.
  owner_id     integer REFERENCES users(id) ON DELETE SET NULL,
  areas        text[] NOT NULL DEFAULT '{}'::text[],
  brands       text[] NOT NULL DEFAULT '{}'::text[],
  start_date   date,
  target_date  date,
  -- For a goal: the target in plain words ("100,000 euros of partnership
  -- revenue"). Free text on purpose — a number column would force us to invent
  -- a unit for every kind of goal the club sets.
  target_note  text,
  sort_order   integer NOT NULL DEFAULT 0,
  archived     boolean NOT NULL DEFAULT false,
  created_by   integer REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tt_projects_status_idx ON tt_projects (status_id);
CREATE INDEX IF NOT EXISTS tt_projects_owner_idx  ON tt_projects (owner_id);
CREATE INDEX IF NOT EXISTS tt_projects_live_idx   ON tt_projects (archived, sort_order);
-- Array containment lookups for the brand/area filters.
CREATE INDEX IF NOT EXISTS tt_projects_areas_gin  ON tt_projects USING gin (areas);
CREATE INDEX IF NOT EXISTS tt_projects_brands_gin ON tt_projects USING gin (brands);

-- ── Tasks ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tt_tasks (
  id           integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  -- 🔴 ON DELETE SET NULL, never CASCADE. Deleting a project must not silently
  -- destroy the record of work people actually did; the task falls into the
  -- "No project" bucket where it is visible and can be re-filed. (The app
  -- ARCHIVES a project that still has tasks, so this is the backstop.)
  project_id   integer REFERENCES tt_projects(id) ON DELETE SET NULL,
  status_id    integer NOT NULL REFERENCES tt_task_statuses(id) ON DELETE RESTRICT,
  title        text NOT NULL,
  description  text,
  priority     text NOT NULL DEFAULT 'medium',   -- low|medium|high|urgent
  -- The one accountable person. Helpers live in tt_task_assignees.
  owner_id     integer REFERENCES users(id) ON DELETE SET NULL,
  start_date   date,
  due_date     date,
  tags         text[] NOT NULL DEFAULT '{}'::text[],
  sort_order   integer NOT NULL DEFAULT 0,
  -- Stamped server-side when the task enters a done-kind column; cleared when
  -- it leaves. Re-entering never rewrites an existing stamp.
  completed_at    timestamptz,
  -- When the status last changed — the "sitting in In Progress for 3 weeks"
  -- signal. Distinct from updated_at, which any edit bumps.
  status_changed_at timestamptz NOT NULL DEFAULT now(),
  archived     boolean NOT NULL DEFAULT false,
  created_by   integer REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tt_tasks_project_idx  ON tt_tasks (project_id);
CREATE INDEX IF NOT EXISTS tt_tasks_status_idx   ON tt_tasks (status_id);
CREATE INDEX IF NOT EXISTS tt_tasks_owner_idx    ON tt_tasks (owner_id);
CREATE INDEX IF NOT EXISTS tt_tasks_due_idx      ON tt_tasks (due_date) WHERE archived = false;
CREATE INDEX IF NOT EXISTS tt_tasks_tags_gin     ON tt_tasks USING gin (tags);

-- ── Helpers on a task (the multi-avatar stack) ───────────────────────────────
-- The owner column above answers "who is accountable"; this answers "who else
-- is on it". Both appear in My Work, only the owner counts in the
-- accountability board.
CREATE TABLE IF NOT EXISTS tt_task_assignees (
  id           integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  task_id      integer NOT NULL REFERENCES tt_tasks(id) ON DELETE CASCADE,
  user_id      integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS tt_task_assignees_uq ON tt_task_assignees (task_id, user_id);
CREATE INDEX IF NOT EXISTS tt_task_assignees_user_idx  ON tt_task_assignees (user_id);

-- ── Checklists + comments ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tt_checklist_items (
  id           integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  task_id      integer NOT NULL REFERENCES tt_tasks(id) ON DELETE CASCADE,
  title        text NOT NULL,
  done         boolean NOT NULL DEFAULT false,
  sort_order   integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tt_checklist_task_idx ON tt_checklist_items (task_id);

CREATE TABLE IF NOT EXISTS tt_comments (
  id           integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  task_id      integer NOT NULL REFERENCES tt_tasks(id) ON DELETE CASCADE,
  author_id    integer REFERENCES users(id) ON DELETE SET NULL,
  -- Denormalised snapshot (the recordedBy doctrine): who said it survives the
  -- account being deleted.
  author_name  text,
  body         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tt_comments_task_idx ON tt_comments (task_id);

-- ── Seed the vocabulary ──────────────────────────────────────────────────────
-- Status columns must exist before anything can be created, so they are seeded
-- here rather than by a script. Areas are seeded too, but they are ordinary
-- editable data from that moment on.
--
-- Idempotent: re-running this migration adds nothing.

INSERT INTO tt_project_statuses (label, kind, color, sort_order)
SELECT * FROM (VALUES
  ('Backlog',     'todo',    '#64748b', 0),
  ('Planning',    'todo',    '#3b82f6', 1),
  ('In progress', 'active',  '#f59e0b', 2),
  ('On hold',     'blocked', '#a855f7', 3),
  ('Done',        'done',    '#22c55e', 4)
) AS v(label, kind, color, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM tt_project_statuses);

INSERT INTO tt_task_statuses (label, kind, color, sort_order)
SELECT * FROM (VALUES
  ('To do',       'todo',    '#64748b', 0),
  ('In progress', 'active',  '#f59e0b', 1),
  ('Blocked',     'blocked', '#ef4444', 2),
  ('Done',        'done',    '#22c55e', 3)
) AS v(label, kind, color, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM tt_task_statuses);

INSERT INTO tt_areas (key, label, color, sort_order)
SELECT * FROM (VALUES
  ('operations',  'Operations',              '#8b5cf6', 0),
  ('commercial',  'Commercial & Sponsorship','#f59e0b', 1),
  ('marketing',   'Marketing & Content',     '#ec4899', 2),
  ('football',    'Football & Academy',      '#22c55e', 3),
  ('events',      'Events & Tournaments',    '#06b6d4', 4),
  ('facilities',  'Facilities & Venue',      '#64748b', 5),
  ('finance',     'Finance & Admin',         '#0ea5e9', 6),
  ('technology',  'Technology',              '#6366f1', 7),
  ('merchandise', 'Merchandise & Retail',    '#ef4444', 8),
  ('people',      'People & Culture',        '#14b8a6', 9)
) AS v(key, label, color, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM tt_areas);

-- ── Row Level Security ───────────────────────────────────────────────────────
-- 🔴 NON-NEGOTIABLE, and easy to forget: tables created by a migration default
-- to RLS OFF, and a Supabase anon key is public by design (it ships in browser
-- bundles). Off + public key = the world can read, and usually write. That
-- exact combination exposed 13 hada_* tables (real client records) on
-- 2026-08-03 and 17 DanielMeynOS tables before that.
--
-- ClubOS connects as `postgres` / service-role, both of which bypass RLS, so
-- enabling this changes nothing about how the app works — it is the SECOND
-- wall, the one that catches a leaked key. No policies = deny anon and
-- authenticated outright, which is correct: nothing here is public data. Task
-- content names staff and describes internal club business.
--
-- Verify with scripts/security/rls_guard.mjs after applying.
ALTER TABLE tt_areas            ENABLE ROW LEVEL SECURITY;
ALTER TABLE tt_project_statuses ENABLE ROW LEVEL SECURITY;
ALTER TABLE tt_task_statuses    ENABLE ROW LEVEL SECURITY;
ALTER TABLE tt_projects         ENABLE ROW LEVEL SECURITY;
ALTER TABLE tt_tasks            ENABLE ROW LEVEL SECURITY;
ALTER TABLE tt_task_assignees   ENABLE ROW LEVEL SECURITY;
ALTER TABLE tt_checklist_items  ENABLE ROW LEVEL SECURITY;
ALTER TABLE tt_comments         ENABLE ROW LEVEL SECURITY;

COMMIT;
