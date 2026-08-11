-- ─────────────────────────────────────────────────────────────────────────────
-- Warehouse — models above variants, and the two-level warehouse address.
--
-- Source requirement: Dima's "AIMS Stocktake Module — Spec v3" (2026-08-10),
-- archived with its prototype at apps/stocktake/. His first named gap:
--
--   "the most common gap is treating this as 'a barcode field on an item form.'
--    It isn't. Two-level hierarchy (Item -> Variant) with the barcode living on
--    the VARIANT, not the item."
--
-- He is right. wh_items is flat: a navy shirt in size L is its own top-level
-- row. The stock-take screen FAKES the tree at read time — groupKeyFor()
-- buckets rows by vendor+model and groupTitle() infers the model's name from
-- the words the item names happen to share
-- (client/src/pages/warehouse-stock-take.tsx:80-142). It renders correctly and
-- it is not real: there is no model record to edit once, no single photo per
-- model, nothing for "+ add a variant" to attach to, and the grouping collapses
-- the moment a vendor field is blank or two names diverge.
--
-- ADDITIVE ONLY. Nothing is dropped, renamed or re-typed. Every one of the
-- 4,727 existing wh_items rows is valid, unchanged, the instant this lands.
--
-- Decisions locked here (D32-D35 — continuing SPEC.md's D1-D29, and realising
-- D30/D31 which Daniel decided on 2026-08-10):
--
--   D32  A model is its OWN table, not a self-referencing parent wh_items row.
--        A model holds no stock, no barcode, no tracking mode and no location.
--        Modelling it as an item would force every stock, dashboard, reconcile
--        and count query in the module to remember to exclude parent rows —
--        and the first one that forgot would double-count the warehouse. The
--        cost of a second table is one join; the cost of the other shape is a
--        silent inventory error nobody can see.
--
--   D33  wh_items.model_id is NULLABLE, and ON DELETE SET NULL.
--        Nullable because an item without a model must keep behaving exactly
--        as it does today — that is what makes this migration a no-op for the
--        existing rows, and it is also how Riley's mowers, print materials and
--        event stock stay out of a garment hierarchy they do not belong in.
--        SET NULL (never CASCADE, never RESTRICT) because deleting a model is
--        a cataloguing decision, and it must neither destroy the stock beneath
--        it nor be blocked by it. Deleting a model UN-GROUPS its variants.
--
--   D34  The backfill is a JOIN, not a heuristic.
--        4,726 of the 4,727 items map one-to-one to a shop_variants row, and
--        those variants already sit under 117 real shop_products. The model
--        relationship therefore already EXISTS as reviewed data. Re-deriving
--        it by guessing common prefixes off item names, when the record is
--        right there, would be inventing a relationship we can simply read.
--        wh_models.shop_product_id keeps that provenance visible forever.
--        (Backfill lives in script/backfill-warehouse-models.ts, not here —
--        structure and data land separately so the data pass stays reviewable
--        and re-runnable.)
--
--   D35  The warehouse address is TWO levels, realising D30.
--        Dima's spec puts a flat rack code (L1/C3/R2/T1 — left, centre, right,
--        rear wall) as free text on the variant. ClubOS already has real
--        locations the ledger counts against (USC Warehouse, Big Shed, Office,
--        Print Shop). These are not competing, they are two levels of one
--        address: the BUILDING is wh_items.default_location_id, which already
--        exists; the RACK is wh_items.rack_code, added here. Collapsing them
--        into one free-text field would end per-building stock and orphan the
--        Big Shed / Office / Print Shop split.
--        rack_code is deliberately free text with autocomplete, NOT an enum
--        and NOT a wh_locations row: the racks get rearranged by people
--        carrying boxes, and that must never require a data migration.
--        wh_stock stays the single source of truth for quantity per location.
--
-- Rehearse:  npx tsx --env-file=.env script/apply-warehouse-models.ts --dry-run
-- Apply:     npx tsx --env-file=.env script/apply-warehouse-models.ts
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) D32 — the model: what a person points at and calls "the KELME shorts".
CREATE TABLE IF NOT EXISTS wh_models (
  id              integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- The manufacturer. Nullable and NEVER inferred: the seeded catalogue is a
  -- mix of KELME kit and CIC-branded merch, and organization_id tells you who
  -- SELLS a product, not who MADE it. A wrong vendor is worse than a blank one.
  vendor          text,
  -- D-spec: title is a SEPARATE field from vendor_model. Dima's own mid-build
  -- correction, because "KELME, then what?" is not answerable from a vendor
  -- and an article number alone.
  title           text NOT NULL,
  vendor_model    text,
  -- Our internal code for the model line. Deliberately NOT unique and NOT
  -- namespaced against wh_items.sku — an item's SKU identifies one scannable
  -- variant, this identifies a family, and forcing them to share a uniqueness
  -- rule would make one of the two impossible to fill in.
  sku             text,
  notes           text,
  -- Nullable, and no upload path ships with this migration: ClubOS Supabase
  -- storage is egress-restricted (402) and has been since before D29, which is
  -- why the mid-count registration sheet has no photo field either. The column
  -- costs nothing to carry and means the UI can light up the day storage is
  -- paid for, with no second migration.
  image_url       text,
  -- D34 — provenance. Where this model came from, so a future reader can tell
  -- a backfilled row from one Dima typed. SET NULL: unlisting a product from
  -- the shop must not delete the warehouse's knowledge of the garment.
  shop_product_id integer REFERENCES shop_products(id) ON DELETE SET NULL,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamp NOT NULL DEFAULT now(),
  updated_at      timestamp NOT NULL DEFAULT now()
);

-- One model per shop product. Partial, so the many models Dima types by hand
-- (which carry no shop_product_id) are never forced to be unique against each
-- other — two genuinely different garments may share a title.
CREATE UNIQUE INDEX IF NOT EXISTS wh_models_shop_product_unique
  ON wh_models (shop_product_id)
  WHERE shop_product_id IS NOT NULL;

-- The list view sorts and searches on these.
CREATE INDEX IF NOT EXISTS wh_models_vendor_title_idx ON wh_models (vendor, title);
CREATE INDEX IF NOT EXISTS wh_models_active_idx ON wh_models (active);

-- 2) D33 — items learn which model they are a variant of.
ALTER TABLE wh_items
  ADD COLUMN IF NOT EXISTS model_id integer REFERENCES wh_models(id) ON DELETE SET NULL;

-- Expanding a model to its variants is THE query the counting screen runs on
-- every tap, and it runs it per model.
CREATE INDEX IF NOT EXISTS wh_items_model_idx
  ON wh_items (model_id)
  WHERE model_id IS NOT NULL;

-- 3) D35 — the rack half of the warehouse address.
ALTER TABLE wh_items
  ADD COLUMN IF NOT EXISTS rack_code text;

-- Autocomplete is built from codes already in use, and "show me everything on
-- L1" is a real question someone standing at L1 asks.
CREATE INDEX IF NOT EXISTS wh_items_rack_code_idx
  ON wh_items (rack_code)
  WHERE rack_code IS NOT NULL;

-- 4) RLS. New tables default to RLS OFF and a Supabase anon key is public by
-- design, so off + public key = the world can read this. Enabled here rather
-- than left for scripts/security/rls_guard.mjs to catch afterwards. The app
-- connects as postgres/service-role (both rolbypassrls), so this changes
-- nothing about how ClubOS reads the table — it is the second wall.
ALTER TABLE wh_models ENABLE ROW LEVEL SECURITY;
