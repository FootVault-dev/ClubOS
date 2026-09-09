-- Map by PROGRAMME, not just by category.
--
-- 🔴 Derived from 25 hand-coded payouts: Olga and Natalia do not code "academy",
-- they code FUNiño to 200/05, Technification to 200/07 and the camps to 203. A
-- category-only mapping would post all three to one account and quietly undo the
-- distinction they have been maintaining by hand all year.
--
-- A row with program_id set wins over the category-only row for that category.

ALTER TABLE xero_account_map ADD COLUMN IF NOT EXISTS program_id integer REFERENCES programs(id);

-- The old index was (org, category) — one row per category. Now a category may
-- carry one row per programme PLUS one fallback row with program_id NULL.
DROP INDEX IF EXISTS xero_account_map_org_category_unq;

CREATE UNIQUE INDEX IF NOT EXISTS xero_account_map_org_cat_prog_unq
  ON xero_account_map (organization_id, category, program_id) WHERE program_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS xero_account_map_org_cat_fallback_unq
  ON xero_account_map (organization_id, category) WHERE program_id IS NULL;

-- Where the mapping came from, so a figure can always be traced back to the
-- payouts that evidenced it rather than to somebody's recollection.
ALTER TABLE xero_account_map ADD COLUMN IF NOT EXISTS evidence text;
