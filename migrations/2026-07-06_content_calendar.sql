-- ─────────────────────────────────────────────────────────────────────────────
-- Content Calendar / Media Production System — the media & marketing team's
-- Monday.com-style home inside the United Sports Group workspace.
--
-- Three tables:
--   • content_items    — the piece of content itself. Runs a production pipeline
--     (idea → scripting → to_shoot → editing → review → scheduled → published),
--     carries a PLANNED date + a PUBLISHED date (planned-vs-delivered), brand
--     tags, format/channels, and the three named production roles Daniel asked
--     for: photographer / videographer / editor (+ an accountable owner).
--   • content_sessions — production activities on the calendar that aren't a
--     single post: meetings, planning, scripting, storyboarding, brainstorming,
--     shoots, edit blocks, reviews. Timed, with attendees.
--   • content_tasks    — granular "divvy up the work" checklist under a content
--     item, each with a production role + assignee + due date.
--
-- ADDITIVE ONLY — safe on the live Supabase DB. No enums / no CHECK constraints
-- on the string status columns (validated in the app) to dodge prod enum-drift.
-- All columns nullable / defaulted. Run BEFORE the Fly deploy.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. content_items — the pipeline board + calendar cards ───────────────────
CREATE TABLE IF NOT EXISTS content_items (
  id                integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id   integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title             text NOT NULL,
  brief             text,                                          -- what it's about / the concept
  -- reel | short | long_video | photo | carousel | story | graphic | blog | email | podcast | other
  format            text NOT NULL DEFAULT 'reel',
  -- platforms it targets: instagram | tiktok | youtube | facebook | linkedin | x | website | email | other
  channels          text[] NOT NULL DEFAULT ARRAY[]::text[],
  -- which brand(s) it serves (reuses the BRANDS slugs: cufc/siu/mfl/cic/usc/gymnastics/usg/print/sponsorship)
  brand_tags        text[] NOT NULL DEFAULT ARRAY[]::text[],
  -- pipeline stage: idea | scripting | to_shoot | editing | review | scheduled | published | cancelled
  status            text NOT NULL DEFAULT 'idea',
  priority          text NOT NULL DEFAULT 'medium',                -- low | medium | high | urgent
  planned_date      date,                                          -- when it's PLANNED to go out (calendar anchor)
  published_date    date,                                          -- when it ACTUALLY went out (delivered)
  owner_id          integer REFERENCES users(id) ON DELETE SET NULL,          -- accountable (single)
  photographer_id   integer REFERENCES users(id) ON DELETE SET NULL,
  videographer_id   integer REFERENCES users(id) ON DELETE SET NULL,
  editor_id         integer REFERENCES users(id) ON DELETE SET NULL,
  campaign          text,                                          -- content pillar / campaign label (free text)
  asset_url         text,                                          -- link to raw/edited assets (Drive/Frame.io)
  final_url         text,                                          -- link to the published post
  session_id        integer,                                       -- soft link to content_sessions (FK added below)
  notes             text,
  sort_order        integer NOT NULL DEFAULT 0,
  archived          boolean NOT NULL DEFAULT false,
  created_by        integer REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_content_items_org        ON content_items (organization_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_content_items_status     ON content_items (organization_id, status);
CREATE INDEX IF NOT EXISTS idx_content_items_planned    ON content_items (organization_id, planned_date);
CREATE INDEX IF NOT EXISTS idx_content_items_published  ON content_items (organization_id, published_date);

-- ── 2. content_sessions — production activities on the calendar ──────────────
CREATE TABLE IF NOT EXISTS content_sessions (
  id                integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id   integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title             text NOT NULL,
  -- meeting | planning | scripting | storyboard | brainstorm | shoot | edit | review | other
  session_type      text NOT NULL DEFAULT 'meeting',
  start_at          timestamptz NOT NULL,
  end_at            timestamptz,
  all_day           boolean NOT NULL DEFAULT false,
  location          text,
  brand_tags        text[] NOT NULL DEFAULT ARRAY[]::text[],
  attendee_ids      integer[] NOT NULL DEFAULT ARRAY[]::integer[],
  lead_id           integer REFERENCES users(id) ON DELETE SET NULL,   -- who runs it
  notes             text,
  sort_order        integer NOT NULL DEFAULT 0,
  archived          boolean NOT NULL DEFAULT false,
  created_by        integer REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_content_sessions_org   ON content_sessions (organization_id, start_at);
CREATE INDEX IF NOT EXISTS idx_content_sessions_type  ON content_sessions (organization_id, session_type);

-- Now that content_sessions exists, guard-add the FK from content_items.session_id.
DO $$ BEGIN
  ALTER TABLE content_items
    ADD CONSTRAINT content_items_session_fk FOREIGN KEY (session_id) REFERENCES content_sessions(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 3. content_tasks — divvy-up checklist under a content item ────────────────
CREATE TABLE IF NOT EXISTS content_tasks (
  id                integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id   integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  content_item_id   integer NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  title             text NOT NULL,
  -- photography | videography | editing | scripting | design | publishing | other
  role              text NOT NULL DEFAULT 'other',
  assignee_id       integer REFERENCES users(id) ON DELETE SET NULL,
  due_date          date,
  done              boolean NOT NULL DEFAULT false,
  sort_order        integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_content_tasks_item ON content_tasks (content_item_id, sort_order);
