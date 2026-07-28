-- ─────────────────────────────────────────────────────────────────────────────
-- Warehouse — the item form becomes data (D26).
--
-- Dima decides which questions the New-item form asks and in what order, with
-- no developer and no deploy. `wh_field_templates` already held CUSTOM fields
-- (D22–D24); it now also holds PLACEMENTS of the built-in ones.
--
--   core_field IS NULL      → a custom field, stored in wh_item_fields.
--                             Exactly as before; every existing row is one.
--   core_field = 'sku' …    → a placement of a real wh_items column (or the
--                             barcode editor). label / sort_order / active
--                             apply; the value still goes to its own column.
--
--   tracking_mode NULL      → shows for both stock and asset items.
--   tracking_mode 'stock'   → only when adding stock. Likewise 'asset'.
--
-- 🔴 `sku` and `name` can never be removed or hidden — they are NOT NULL on
-- wh_items and the whole warehouse keys on SKU (scanning, labels, channel
-- mapping, the ledger). shared/warehouse-form.ts refuses such a layout on
-- save AND re-inserts them on read, so a hand-edited row can't break the form.
--
-- ADDITIVE ONLY. Zero rows are written: with no core_field rows present the
-- form falls back to the built-in default layout, so behaviour is unchanged
-- until somebody deliberately customises it.
--
-- Rehearse (rolls back), then apply:
--   npx tsx --env-file=.env script/apply-warehouse-form.ts
--   npx tsx --env-file=.env script/apply-warehouse-form.ts --apply
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE wh_field_templates
  ADD COLUMN IF NOT EXISTS core_field text;

ALTER TABLE wh_field_templates
  ADD COLUMN IF NOT EXISTS tracking_mode text;

-- `category` is NOT NULL for custom fields but meaningless for a core-field
-- placement (a placement belongs to the whole form, not to one category), so
-- it has to become nullable.
ALTER TABLE wh_field_templates
  ALTER COLUMN category DROP NOT NULL;

-- One placement per core field per tracking mode. Partial, so it constrains
-- only the new rows and leaves every existing custom field alone.
CREATE UNIQUE INDEX IF NOT EXISTS wh_field_templates_core_mode_unique
  ON wh_field_templates (core_field, coalesce(tracking_mode, ''))
  WHERE core_field IS NOT NULL;

CREATE INDEX IF NOT EXISTS wh_field_templates_mode_sort_idx
  ON wh_field_templates (tracking_mode, sort_order);

-- The existing (category, field_key) unique index only makes sense for custom
-- fields — two core placements share a NULL category. Rebuild it partial.
DROP INDEX IF EXISTS wh_field_templates_category_key_unique;
CREATE UNIQUE INDEX IF NOT EXISTS wh_field_templates_category_key_unique
  ON wh_field_templates (category, field_key)
  WHERE core_field IS NULL;
