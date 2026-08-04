-- ─────────────────────────────────────────────────────────────────────────────
-- TASK TRACKER — pages, the navigable Notion-style hierarchy.
--
-- Daniel's structure, from the Kerkyra United Notion:
--
--   Projects tab  →  the 8 BRANDS (CUFC, SIU, MFL, CIC, USC, Gymnastics,
--                    Prints, Group)
--     → a brand    →  its DEPARTMENTS / areas (Operations, Commercial,
--                     Marketing, Football, Events, Finance …)
--       → an area  →  the PAGES inside it, plus the real projects already
--                     tagged to that brand + area
--         → a page →  content, rendered in a layout chosen PER PAGE
--                     (document, projects table, task list, board)
--
-- 🔴 THE FIRST TWO LEVELS ARE NOT STORED. Brands come from the code constant
-- and areas from tt_areas — both already exist and are already the tags on
-- every project. Materialising them as page rows would create a second source
-- of truth for "what areas are there", and the two would drift the first time
-- someone renamed one. The tree only becomes real rows from level 3 down.
--
-- This is additive: the flat Projects/Tasks views still read exactly the same
-- data. The hierarchy is a way of NAVIGATING to it, not a second copy of it.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS tt_pages (
  id           integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  -- Which brand's section this page lives in. One of the keys in
  -- shared/task-tracker.ts TT_BRANDS ('usg' = the group-wide section).
  brand        text NOT NULL,
  -- The department/area it sits under, keyed to tt_areas.key. NULL means the
  -- page hangs directly off the brand, above the departments — the club-wide
  -- "read me first" page that belongs to no single department.
  area_key     text,
  -- Nesting below the area. 🔴 ON DELETE RESTRICT, never CASCADE: deleting a
  -- page must never silently take a tree of someone's written notes with it.
  -- The app archives a page that still has children.
  parent_id    integer REFERENCES tt_pages(id) ON DELETE RESTRICT,
  title        text NOT NULL,
  emoji        text,
  description  text,
  -- How this page renders. Chosen per page, the way a Notion page can be a
  -- document or a database view: doc | projects | tasks | board | list.
  -- Validated TEXT (shared/task-tracker.ts), never a pg enum or CHECK — a
  -- stale CHECK is how the MFL checkout 500'd.
  view_type    text NOT NULL DEFAULT 'doc',
  -- Markdown body for a 'doc' page. The other view types render live data and
  -- ignore this, but it is kept if someone switches a page's layout back and
  -- forth — silently discarding what they typed would be unforgivable.
  body         text,
  sort_order   integer NOT NULL DEFAULT 0,
  archived     boolean NOT NULL DEFAULT false,
  created_by   integer REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tt_pages_brand_area_idx ON tt_pages (brand, area_key) WHERE archived = false;
CREATE INDEX IF NOT EXISTS tt_pages_parent_idx     ON tt_pages (parent_id);

-- 🔴 RLS, in the migration, for the same reason as every other tt_ table:
-- tables default to RLS off and the Supabase anon key is public by design.
-- Page bodies will hold internal strategy notes.
ALTER TABLE tt_pages ENABLE ROW LEVEL SECURITY;

COMMIT;
