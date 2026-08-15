-- ─────────────────────────────────────────────────────────────────────────────
-- Club Drive — make search use its indexes.
--
-- 🔴 THE PROBLEM, measured rather than guessed. With 4,900 files imported,
-- `EXPLAIN ANALYZE` showed a **Seq Scan, 6.5 seconds**: the OR branches
-- (`lower(name) LIKE '%q%'` and `similarity(...) > 0.3`) cannot use the FTS
-- index, so Postgres fell back to scanning every row — and for each one it
-- recomputed `to_tsvector` over the file's ENTIRE extracted text. Every
-- keystroke re-tokenised the whole drive.
--
-- Two changes fix it:
--
--  1. The tsvector becomes a STORED GENERATED column, computed once when a row
--     is written instead of on every read, with its own GIN index.
--
--  2. The name branches use operators the trigram index can actually serve —
--     `%` (similarity) rather than the `similarity()` FUNCTION, and LIKE, which
--     pg_trgm supports even with a leading wildcard. All three branches become
--     bitmap index scans that Postgres can OR together.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE drive_nodes
  ADD COLUMN IF NOT EXISTS search_vec tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(extracted_text, '')), 'C')
  ) STORED;

CREATE INDEX IF NOT EXISTS drive_nodes_search_vec_idx ON drive_nodes USING gin (search_vec);

-- The old expression index can never be used now that the column exists, and it
-- costs a full re-tokenise on every write.
DROP INDEX IF EXISTS drive_nodes_fts_idx;

-- Already created by the first migration, but stated here because the name
-- branches now depend on it being present to avoid a sequential scan.
CREATE INDEX IF NOT EXISTS drive_nodes_name_trgm_idx ON drive_nodes USING gin (lower(name) gin_trgm_ops);

ANALYZE drive_nodes;
