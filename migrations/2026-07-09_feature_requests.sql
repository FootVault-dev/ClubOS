-- ─────────────────────────────────────────────────────────────────────────────
-- Feature Requests / Bug Reports — the staff feedback board inside ClubOS.
--
-- One place for any staff member to report a BUG ("it's not working") or ask for
-- a FEATURE / IMPROVEMENT ("can we change / add this"), instead of scattered
-- WhatsApp messages. Daniel (and workspace managers) triage the list — set a
-- status (new → planned → in_progress → done, or declined), a priority, and
-- notes — and work through them one by one.
--
-- Deliberately NOT org-scoped: this is a single, shared, club-wide backlog so
-- everything lands in one clean list. An optional free-text `area` tag records
-- which app/brand/system a request relates to.
--
-- ADDITIVE ONLY — safe on the live Supabase DB. No enums / no CHECK constraints
-- on the string columns (validated in the app) to dodge prod enum-drift. All
-- columns nullable / defaulted. Run BEFORE the Fly deploy.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS feature_requests (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- what kind of request: bug | feature | improvement
  type          text NOT NULL DEFAULT 'bug',
  title         text NOT NULL,
  description   text,
  -- optional: which app / brand / system it relates to (free tag —
  -- clubos | cufc | siu | mfl | cic | cugc | print | website | app | other)
  area          text,
  -- optional: a link to where they saw it (the page URL, a screenshot link)
  page_url      text,
  -- triage stage: new | planned | in_progress | done | declined
  status        text NOT NULL DEFAULT 'new',
  priority      text NOT NULL DEFAULT 'normal',   -- low | normal | high | urgent
  admin_notes   text,                             -- triage notes (managers only)
  created_by    integer REFERENCES users(id) ON DELETE SET NULL,   -- the submitter
  resolved_by   integer REFERENCES users(id) ON DELETE SET NULL,
  resolved_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feature_requests_status  ON feature_requests (status);
CREATE INDEX IF NOT EXISTS idx_feature_requests_type    ON feature_requests (type);
CREATE INDEX IF NOT EXISTS idx_feature_requests_created ON feature_requests (created_at DESC);
