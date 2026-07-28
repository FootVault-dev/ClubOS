-- ─────────────────────────────────────────────────────────────────────────────
-- Warehouse v2 — asset tracking, self-service custom fields, richer locations.
--
-- Extends the LIVE WMS (migrations/2026-07-13_warehouse.sql, prod v335) rather
-- than replacing it. Source requirement: Dima's "ClubOS — Warehouse Module
-- Specification (v1)", which asks for everything physical the club owns and
-- moves — not just the stock that is counted, but the equipment, furniture and
-- fittings that are owned one-by-one.
--
-- Decisions locked here (D18–D25 — continuing SPEC.md's D1–D17):
--
--   D18  `wh_items.tracking_mode` = 'stock' | 'asset'. Defaults to 'stock', so
--        every one of the ~2,900 existing rows is unchanged by this migration.
--        Fixed at creation and enforced app-side, never a UI toggle: flipping
--        it changes which child table holds the item's physical reality.
--
--   D19  ONE ledger, not two. An asset movement is an ordinary `wh_movements`
--        row with the new `instance_id` set and `delta` of exactly ±1. So
--        `wh_stock.on_hand` for an asset item at a location is simply the
--        count of instances standing there, every existing dashboard/stock/
--        reconcile query keeps working untouched, and the append-only audit
--        trail covers assets from the first scan. A second parallel movement
--        table would have split the audit trail in half.
--
--   D20  Assignment IS a location. The source spec carries both a free-text
--        `assigned_to` and a `location_id`, while its own golden rule 3 says a
--        person must be a location type. Two sources of truth for "where is
--        it" is precisely how a warehouse drifts, so there is no assigned_to
--        column: `wh_locations.kind` gains 'person' and 'vehicle', and "issued
--        to Riley" means the instance sits at PERSON-RILEY. Lending an asset
--        to an outside party already has `wh_loans` (D14) and is not re-modelled.
--
--   D21  A 'person' or 'vehicle' location is NOT sellable and derives no zone
--        (shared/warehouse.ts). A shirt in someone's car boot is out of the
--        building; counting it as available is how a shop oversells.
--
--   D22  A custom field hangs off an item OR one instance, never both. The
--        spec's own worked example — "all vehicles with WOF expiring this
--        month" — is per-instance: a WOF date belongs to one van, not to the
--        idea of a van. The exactly-one CHECK stays because it is a structural
--        invariant like wh_movements' delta<>0, not an open value set.
--
--   D23  Templates key on `wh_items.category`. The spec's hierarchy is
--        tracking_mode → category (fixed) → subcategory (extensible leaf).
--        Ours is kind (fixed) → category (free text) — our `category` already
--        IS its `subcategory`, so this needs no new column and no third level.
--
--   D24  Typed value columns, one per field_type — never one generic text
--        column. "Every WOF expiring this month" has to be an indexed date
--        comparison in Postgres, not a string sort in JavaScript.
--
--   D25  No CHECK constraints on the enum-ish columns (tracking_mode,
--        condition, field_type, applies_to) — the house rule, validated in
--        shared/warehouse.ts instead. A stale CHECK once 500'd the MFL
--        checkout. The two CHECKs added here are structural, not taxonomic.
--
-- ADDITIVE ONLY — no column is dropped, no existing row is rewritten.
-- Rehearse (rolls back), then apply:
--   npx tsx --env-file=.env script/apply-warehouse-v2.ts
--   npx tsx --env-file=.env script/apply-warehouse-v2.ts --apply
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) D18 — how this item's physical reality is held: counted in bulk ('stock',
-- via wh_stock) or owned one-by-one ('asset', via wh_item_instances below).
ALTER TABLE wh_items
  ADD COLUMN IF NOT EXISTS tracking_mode text NOT NULL DEFAULT 'stock';

CREATE INDEX IF NOT EXISTS wh_items_tracking_mode_idx ON wh_items (tracking_mode);

-- 2) D20 — location hierarchy (a bin within a zone, a shelf within a vehicle).
-- Self-referencing and nullable; ON DELETE SET NULL so removing a parent zone
-- orphans its children rather than cascading a delete through real stock.
ALTER TABLE wh_locations
  ADD COLUMN IF NOT EXISTS parent_location_id integer REFERENCES wh_locations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS wh_locations_parent_idx ON wh_locations (parent_location_id);

-- `kind` gains 'person' and 'vehicle' — no DDL, it is free text validated in
-- shared/warehouse.ts (D25). Listed here so the value set is discoverable from
-- the migration alone: 'bin' | 'zone' | 'virtual' | 'person' | 'vehicle'.

-- 3) D19 — one physical unit of an asset item. Serial numbers, condition, the
-- warranty clock, and where it is right now.
CREATE TABLE IF NOT EXISTS wh_item_instances (
  id              integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- RESTRICT, never CASCADE: deleting an item definition must never silently
  -- erase the history of the physical objects that were bought under it —
  -- same reasoning as club_squad_members and housing tenants.
  item_id         integer NOT NULL REFERENCES wh_items(id) ON DELETE RESTRICT,
  -- Our own printed label, scannable at the station. Distinct from
  -- serial_number, which is the manufacturer's and may be missing, duplicated
  -- across brands, or physically unreadable on a worn plate.
  asset_tag       text,
  serial_number   text,
  location_id     integer NOT NULL REFERENCES wh_locations(id) ON DELETE RESTRICT,
  -- 'new' | 'working' | 'damaged' | 'decommissioned' (shared/warehouse.ts).
  -- 'decommissioned' IS retirement — a decommissioned instance keeps its whole
  -- ledger. Retire, never delete (the Vehicles-tab doctrine).
  condition       text NOT NULL DEFAULT 'working',
  purchase_date   date,
  warranty_until  date,
  cost_cents      integer,
  notes           text,
  created_at      timestamp NOT NULL DEFAULT now(),
  updated_at      timestamp NOT NULL DEFAULT now()
);

-- An asset tag is the thing a person scans — it must resolve to exactly one
-- physical object, forever.
CREATE UNIQUE INDEX IF NOT EXISTS wh_item_instances_asset_tag_unique
  ON wh_item_instances (asset_tag)
  WHERE asset_tag IS NOT NULL;
-- Two live units of the same item cannot carry the same manufacturer serial.
CREATE UNIQUE INDEX IF NOT EXISTS wh_item_instances_item_serial_unique
  ON wh_item_instances (item_id, serial_number)
  WHERE serial_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS wh_item_instances_item_condition_idx
  ON wh_item_instances (item_id, condition);
CREATE INDEX IF NOT EXISTS wh_item_instances_location_idx
  ON wh_item_instances (location_id);
CREATE INDEX IF NOT EXISTS wh_item_instances_warranty_idx
  ON wh_item_instances (warranty_until)
  WHERE warranty_until IS NOT NULL;

-- 4) D19 — the ledger learns about instances. Nullable: every existing row and
-- every future bulk-stock row leaves it null. RESTRICT for the same reason as
-- item_id above — an instance's movements are the proof of where it has been.
ALTER TABLE wh_movements
  ADD COLUMN IF NOT EXISTS instance_id integer REFERENCES wh_item_instances(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS wh_movements_instance_idx
  ON wh_movements (instance_id)
  WHERE instance_id IS NOT NULL;

-- 5) D23 — admin-editable schema-in-data. Adding, reordering or removing a
-- field here changes what renders on the item card. It must never require a
-- schema migration or a developer, which is the entire point of the table.
CREATE TABLE IF NOT EXISTS wh_field_templates (
  id           integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  category     text NOT NULL,                       -- wh_items.category — the extensible leaf (D23)
  field_key    text NOT NULL,                       -- slugified from label, stable once created
  label        text NOT NULL,
  field_type   text NOT NULL DEFAULT 'text',        -- text|number|date|select|boolean (shared/warehouse.ts)
  options      jsonb,                               -- string[] for 'select'
  required     boolean NOT NULL DEFAULT false,
  sort_order   integer NOT NULL DEFAULT 0,
  help_text    text,
  -- D22 — does this field describe the DEFINITION ('item', e.g. "vinyl width")
  -- or one physical unit ('instance', e.g. "WOF expiry")?
  applies_to   text NOT NULL DEFAULT 'item',
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamp NOT NULL DEFAULT now(),
  updated_at   timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS wh_field_templates_category_key_unique
  ON wh_field_templates (category, field_key);
CREATE INDEX IF NOT EXISTS wh_field_templates_category_sort_idx
  ON wh_field_templates (category, sort_order);

-- 6) D22/D24 — the values. One row per (owner, field_key); the value lands in
-- the column matching the template's field_type so Postgres can filter and
-- sort it.
CREATE TABLE IF NOT EXISTS wh_item_fields (
  id             integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id        integer REFERENCES wh_items(id) ON DELETE CASCADE,
  instance_id    integer REFERENCES wh_item_instances(id) ON DELETE CASCADE,
  field_key      text NOT NULL,
  value_text     text,
  value_number   numeric(14,4),
  value_date     date,
  value_boolean  boolean,
  updated_at     timestamp NOT NULL DEFAULT now(),
  -- Structural, not taxonomic (D25): a value describes an item or one
  -- instance. Both set, or neither, is a corrupt row with no owner.
  CONSTRAINT wh_item_fields_one_owner_chk CHECK (
    (item_id IS NOT NULL AND instance_id IS NULL)
    OR (item_id IS NULL AND instance_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS wh_item_fields_item_key_unique
  ON wh_item_fields (item_id, field_key)
  WHERE item_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS wh_item_fields_instance_key_unique
  ON wh_item_fields (instance_id, field_key)
  WHERE instance_id IS NOT NULL;
-- Cross-item filtering ("every WOF expiring this month") scans by key first.
CREATE INDEX IF NOT EXISTS wh_item_fields_key_date_idx
  ON wh_item_fields (field_key, value_date)
  WHERE value_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS wh_item_fields_key_number_idx
  ON wh_item_fields (field_key, value_number)
  WHERE value_number IS NOT NULL;
