-- Family linking — parents and children visible from both sides.
--
-- Purely additive: three indexes on a table that had nothing but its primary
-- key. No column is added, altered or dropped, and no row is written. The
-- feature itself needs no schema change — the links were already there.
--
-- Verified against prod before writing (2026-08-02):
--   4,466 edges · 0 duplicate (guardian_id, player_id) pairs · 0 self-edges
-- so the unique index below cannot fail on existing data.

-- Both directions are read on every family page. Without these, each lookup is
-- a sequential scan; the table is small today but it grows with every child.
CREATE INDEX IF NOT EXISTS contact_relationships_guardian_idx
  ON contact_relationships (guardian_id);

CREATE INDEX IF NOT EXISTS contact_relationships_player_idx
  ON contact_relationships (player_id);

-- One edge per (guardian, child). Linking the same pair twice is never
-- meaningful, and a duplicate edge would render the same parent twice on the
-- child's page. This also backs the ON CONFLICT in the link endpoint, which
-- makes a double-tapped "Link parent" button idempotent instead of an error.
CREATE UNIQUE INDEX IF NOT EXISTS contact_relationships_pair_uniq
  ON contact_relationships (guardian_id, player_id);

-- Camp children are looked up by parent on every family page.
CREATE INDEX IF NOT EXISTS children_parent_idx
  ON children (parent_id);

-- Registrations are resolved by guardian (a parent's children) and by contact
-- (a child's programmes) on every family page.
CREATE INDEX IF NOT EXISTS registrations_guardian_idx
  ON registrations (guardian_id) WHERE guardian_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS registration_items_child_idx
  ON registration_items (child_id) WHERE child_id IS NOT NULL;
