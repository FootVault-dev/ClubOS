-- ─────────────────────────────────────────────────────────────────────────────
-- MANAGEMENT COLLABORATORS — per-project people + roles for the planning
-- workspace (Daniel's directive, 2026-07-22 evening).
--
-- The Google-Docs model, enforced SERVER-side per project:
--   viewer < commenter < editor < admin  (shared/management.ts ROLE_RANK)
--
-- `plan_projects.default_role` = what anyone with the Management tab gets
-- when not explicitly listed: none|viewer|commenter|editor|admin. Defaults
-- to 'admin' so every EXISTING project behaves exactly as before this
-- migration (the tab was all-access) — dialling a project down is a
-- deliberate act in its settings, never a silent regression. 'none' makes a
-- project private to its listed collaborators.
--
-- Effective role (shared/management.ts effectiveRole): super_admin → admin ·
-- explicit row → its role · project creator → admin (can never be locked
-- out) · else default_role. Roles are validated TEXT, never pg enums.
--
-- ADDITIVE ONLY — one new table + one new column with a default. Run BEFORE
-- the Fly deploy.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE plan_projects ADD COLUMN IF NOT EXISTS default_role text NOT NULL DEFAULT 'admin';

CREATE TABLE IF NOT EXISTS plan_collaborators (
  id               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id  integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id       integer NOT NULL REFERENCES plan_projects(id) ON DELETE CASCADE,
  user_id          integer NOT NULL,
  role             text NOT NULL DEFAULT 'editor',   -- viewer|commenter|editor|admin
  added_by         integer,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plan_collaborators_uq UNIQUE (project_id, user_id)
);
CREATE INDEX IF NOT EXISTS plan_collaborators_project_idx ON plan_collaborators (project_id);
CREATE INDEX IF NOT EXISTS plan_collaborators_user_idx    ON plan_collaborators (user_id);
CREATE INDEX IF NOT EXISTS plan_collaborators_org_idx     ON plan_collaborators (organization_id);
