-- ─────────────────────────────────────────────────────────────────────────────
-- Club Drive — the club's own file store.
--
-- The problem it removes: every document the organisation depends on lives in
-- a Google Drive nobody can search properly and no ClubOS feature can reach.
-- A contract cannot be linked from a proposal, a policy cannot be attached in
-- Chat, and Rambo cannot read any of it. This is where the files come home.
--
-- Deliberately NOT org-scoped — same as staff_chat / feature_requests / tt_* /
-- kb_articles: a universal tab in every workspace. Brand is a TAG on the node,
-- so "United Prints files" is a filter over one tree rather than eight copies.
--
-- ONE TABLE for folders and files (`kind`), because a folder tree with a
-- self-referencing parent is what makes move, breadcrumb and — the important
-- one — permission INHERITANCE simple and provable.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS drive_nodes (
  id                 integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,

  -- 🔴 RESTRICT, never CASCADE. Deleting a folder must never silently take a
  -- decade of club records with it. The app trashes (see trashed_at) and the
  -- database refuses to orphan.
  parent_id          integer REFERENCES drive_nodes(id) ON DELETE RESTRICT,

  kind               text NOT NULL DEFAULT 'file',   -- folder | file
  name               text NOT NULL,

  -- ── Bytes (files only) ────────────────────────────────────────────────────
  -- storage_key is opaque and backend-agnostic on purpose: today it addresses
  -- an object in the Supabase bucket, tomorrow the same string addresses an R2
  -- object. Nothing above the storage adapter is allowed to parse it.
  storage_key        text,
  storage_backend    text NOT NULL DEFAULT 'supabase',  -- supabase | r2 | google
  mime_type          text,
  size_bytes         bigint,
  -- sha256 of the bytes. Not used to dedupe storage in v1 — recorded so we can
  -- prove a file is intact and find duplicates later without re-reading blobs.
  checksum           text,

  -- 'all' or a KB_BRANDS key (cufc | siu | mfl | cic | cugc | prints | usc | usg).
  -- Free text, not an enum: a stale CHECK constraint in prod is how the MFL
  -- checkout 500'd. Validation lives in the app where it can be changed.
  brand              text NOT NULL DEFAULT 'all',

  -- 🔴 The visibility rule. NULL = every staff member may read it, which is the
  -- normal case: the uniform order form is not a secret. Set it to a ClubOS tab
  -- slug and the node becomes readable only by people who can reach that tab —
  -- the SAME decider the Knowledge Base and Rambo use (shared/knowledge-base.ts
  -- → viewerCanReachTab). One rule, three surfaces, so a document can never be
  -- more open than the tab its contents came from.
  --
  -- Gates INHERIT DOWN and only ever ADD. See the drive_node_gates view: a file
  -- inside a gated folder is gated by that folder no matter what it says about
  -- itself, so nothing can be smuggled into the open by moving it or by setting
  -- a laxer gate on the child.
  required_tab       text,
  required_workspace text,   -- org slug to judge required_tab in; NULL = any of theirs

  -- ── Search ────────────────────────────────────────────────────────────────
  -- The text pulled out of the file (PDF pages, spreadsheet cells, doc body).
  -- This column, not the bytes, is what makes "find the thing I forgot the name
  -- of" work. NULL means not-yet-extracted, which is deliberately distinct from
  -- '' (extracted and genuinely empty, e.g. a photo).
  extracted_text     text,
  extract_status     text,   -- NULL=pending | done | unsupported | failed
  extract_error      text,
  description        text,
  keywords           text[] NOT NULL DEFAULT '{}',

  -- ── Provenance ────────────────────────────────────────────────────────────
  -- Where this came from, so an import can run twice without duplicating and we
  -- can always point at the original.
  source             text NOT NULL DEFAULT 'clubos',   -- clubos | google_drive
  source_id          text,          -- e.g. the Google Drive file id
  source_url         text,
  source_modified_at timestamp,

  -- ── Lifecycle ─────────────────────────────────────────────────────────────
  -- 🔴 Soft delete only. A club's files are legal records — employment
  -- contracts, NZF audit evidence, sponsorship agreements. Nothing here issues
  -- a DELETE; the UI trashes and an admin restores.
  trashed_at         timestamp,
  trashed_by         integer REFERENCES users(id) ON DELETE SET NULL,

  -- SET NULL, not RESTRICT: deleting a staff account must not be blocked by a
  -- file they once uploaded. The UI reads null as "unowned", never as "nobody".
  owner_user_id      integer REFERENCES users(id) ON DELETE SET NULL,
  created_by         integer REFERENCES users(id) ON DELETE SET NULL,
  updated_by         integer REFERENCES users(id) ON DELETE SET NULL,

  view_count         integer NOT NULL DEFAULT 0,
  last_opened_at     timestamp,

  created_at         timestamp NOT NULL DEFAULT now(),
  updated_at         timestamp NOT NULL DEFAULT now()
);

-- Sibling names unique among LIVE nodes only, so trashing "Budget 2026.xlsx"
-- doesn't block re-uploading it. Two partial indexes because Postgres treats
-- every NULL parent (a root) as distinct, which would let duplicate roots in.
CREATE UNIQUE INDEX IF NOT EXISTS drive_nodes_sibling_name_idx
  ON drive_nodes (parent_id, lower(name))
  WHERE trashed_at IS NULL AND parent_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS drive_nodes_root_name_idx
  ON drive_nodes (lower(name))
  WHERE trashed_at IS NULL AND parent_id IS NULL;

-- An import must be re-runnable. One row per source file, forever.
CREATE UNIQUE INDEX IF NOT EXISTS drive_nodes_source_idx
  ON drive_nodes (source, source_id)
  WHERE source_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS drive_nodes_parent_idx  ON drive_nodes (parent_id) WHERE trashed_at IS NULL;
CREATE INDEX IF NOT EXISTS drive_nodes_brand_idx   ON drive_nodes (brand)     WHERE trashed_at IS NULL;
CREATE INDEX IF NOT EXISTS drive_nodes_trashed_idx ON drive_nodes (trashed_at) WHERE trashed_at IS NOT NULL;

-- Full text over name + description + extracted text. The name matters most
-- (people half-remember filenames), so it is weighted A.
-- The doubled parentheses are required: an index expression that is not a bare
-- column or a simple function call has to be wrapped, or Postgres reads the ||
-- as the start of a second index column and fails to parse.
CREATE INDEX IF NOT EXISTS drive_nodes_fts_idx ON drive_nodes
  USING gin ((
    setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(extracted_text, '')), 'C')
  ));

-- Typo tolerance on names — "buget" should still find "Budget".
CREATE INDEX IF NOT EXISTS drive_nodes_name_trgm_idx ON drive_nodes USING gin (lower(name) gin_trgm_ops);

-- ─────────────────────────────────────────────────────────────────────────────
-- The effective gate on every node.
--
-- 🔴 Gates ACCUMULATE down the tree and are never released. A node's own gate
-- is ADDED to everything its ancestors carry, so putting a file inside "Club
-- Budgets" gates it on the budget tab whether or not the file says so, and
-- setting a laxer gate on a child cannot open a door its parent closed.
-- A viewer must satisfy EVERY entry to read the node.
--
-- Encoded as `tab@workspace` (workspace may be empty = judge in any of theirs)
-- so one text[] carries the pair without a second structure.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW drive_node_gates AS
WITH RECURSIVE walk AS (
  SELECT
    n.id,
    n.parent_id,
    CASE
      WHEN n.required_tab IS NOT NULL
        THEN ARRAY[n.required_tab || '@' || coalesce(n.required_workspace, '')]
      ELSE ARRAY[]::text[]
    END AS gates
  FROM drive_nodes n
  WHERE n.parent_id IS NULL

  UNION ALL

  SELECT
    c.id,
    c.parent_id,
    w.gates ||
    CASE
      WHEN c.required_tab IS NOT NULL
        THEN ARRAY[c.required_tab || '@' || coalesce(c.required_workspace, '')]
      ELSE ARRAY[]::text[]
    END
  FROM drive_nodes c
  JOIN walk w ON c.parent_id = w.id
)
SELECT id, gates FROM walk;

-- ─────────────────────────────────────────────────────────────────────────────
-- Who opened what. Not analytics — an audit trail. When a contract or a child's
-- record is in here, "who read this, and when" is a question that gets asked.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS drive_access_log (
  id         integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  node_id    integer REFERENCES drive_nodes(id) ON DELETE CASCADE,
  user_id    integer REFERENCES users(id) ON DELETE SET NULL,
  action     text NOT NULL,          -- view | download | upload | move | rename | trash | restore | share
  detail     text,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS drive_access_log_node_idx ON drive_access_log (node_id, created_at DESC);
CREATE INDEX IF NOT EXISTS drive_access_log_user_idx ON drive_access_log (user_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 🔴 RLS. New tables default to OFF, and the Supabase anon key is public by
-- design — it ships in browser bundles. A table indexing every contract the
-- club holds is the worst possible one to leave open. The app connects as
-- postgres/service-role (both rolbypassrls), so this changes nothing for us and
-- is the second wall if a key ever leaks. See scripts/security/rls_guard.mjs.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE drive_nodes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE drive_access_log ENABLE ROW LEVEL SECURITY;
