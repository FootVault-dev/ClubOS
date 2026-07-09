-- Market Research (Sandbox workspace) — competitor + category intelligence snapshots.
--
-- Purely additive: one new table, no changes to any existing column or index.
-- Nothing else in ClubOS reads or writes it.
--
-- Design note: the research corpus is a document, not a relational model. Storing
-- each brief as jsonb keeps the schema stable while the research shape evolves,
-- and lets the seed script be re-run idempotently (upsert on slug+kind).
--
-- Access: super_admin only, via requireTab("market-research") + SUPER_ADMIN_ONLY_TABS.

CREATE TABLE IF NOT EXISTS market_research_snapshots (
  id            serial PRIMARY KEY,
  slug          text NOT NULL,
  kind          text NOT NULL,             -- 'master' | 'vertical' | 'sources'
  title         text NOT NULL,
  -- when the RESEARCH ran, not when the row was written
  generated_at  timestamptz NOT NULL,
  payload       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT market_research_snapshots_kind_chk
    CHECK (kind IN ('master', 'vertical', 'sources'))
);

-- One row per (slug, kind) so a re-run replaces rather than duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS market_research_snapshots_slug_kind_idx
  ON market_research_snapshots (slug, kind);

CREATE INDEX IF NOT EXISTS market_research_snapshots_generated_idx
  ON market_research_snapshots (generated_at DESC);
