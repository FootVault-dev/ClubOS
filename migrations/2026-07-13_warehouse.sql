-- ─────────────────────────────────────────────────────────────────────────────
-- Warehouse Management System (WMS) — United Prints workspace.
--
-- One physical warehouse at United Sports Centre holds four brands' sellable
-- merch (MFL + CIC on our own ClubOS commerce engine, SIU + CUFC on two
-- Shopify stores), United Prints raw materials, club training equipment, and
-- event stock. Today it's "managed" by logging in and out of Shopify — this
-- is the append-only movement ledger + derived-stock model that replaces that.
-- Design authority: outputs/deep-research/2026-07-13-warehouse-management-system/
-- synthesis.md · SPEC.md §4.1 (decisions D1–D17).
--
-- Design notes:
--   • `wh_movements` is THE LEDGER — append-only, signed deltas. No UPDATE or
--     DELETE code path may ever touch it; a correction is a new adjustment row.
--   • `wh_stock` is a same-transaction CACHE, never the truth. `available`
--     (on_hand minus active reservations) is DERIVED — computed in queries,
--     never a stored column anywhere in this migration.
--   • Enum-ish text columns (kind, brand_owner, status, movement_type,
--     reason_code, ref_kind…) carry NO CHECK constraints — an open value set
--     validated in shared/warehouse.ts (a stale CHECK once 500'd the MFL
--     checkout). The one true invariant — a movement can never be a zero delta
--     — IS a CHECK, because it's a numeric fact, not an enum.
--   • Identical physical products owned by different brands are DIFFERENT
--     `wh_items` rows (brand_owner is part of identity, never a pooled row).
--   • Not org-scoped — this is ONE shared warehouse (like feature_requests),
--     not a per-workspace list. Access is gated by requireTab("warehouse").
--
-- ADDITIVE ONLY. Rehearse with (never runs against a live DB in this
-- environment — a human runs it later, BEFORE the Fly deploy):
--   npx tsx --env-file=.env script/apply-warehouse.ts            (dry-run, rolls back)
--   npx tsx --env-file=.env script/apply-warehouse.ts --apply    (commits)
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) Locations — bins, named zones, and virtual locations (D8). Every
-- movement always has a real from/to story: goods arrive FROM a supplier,
-- leave TO a customer, vanish TO scrap, or move FROM/TO production.
CREATE TABLE IF NOT EXISTS wh_locations (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        text NOT NULL,                     -- 'A-01-2', 'QUARANTINE', 'SUPPLIER'…
  zone        text,                               -- first segment of a bin code, or the zone itself
  kind        text NOT NULL DEFAULT 'bin',        -- 'bin' | 'zone' | 'virtual' (shared/warehouse.ts)
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamp NOT NULL DEFAULT now()
);
-- Explicitly named (not relying on Postgres's implicit inline-UNIQUE naming)
-- so script/apply-warehouse.ts can verify every index by exact name.
CREATE UNIQUE INDEX IF NOT EXISTS wh_locations_code_unique ON wh_locations (code);
CREATE INDEX IF NOT EXISTS wh_locations_zone_idx ON wh_locations (zone);

-- 2) Items — everything stocked: sellable merch + uniforms, print-shop
-- materials, club equipment, event stock (D4). Channel mappings are nullable +
-- partial-unique so an item can be unmapped, native-mapped, or Shopify-mapped.
CREATE TABLE IF NOT EXISTS wh_items (
  id                          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sku                         text NOT NULL,               -- BRAND-CAT-STYLE-COLOUR-SIZE (D7)
  name                        text NOT NULL,
  kind                        text NOT NULL DEFAULT 'merch',       -- 'merch'|'material'|'equipment'|'event'
  brand_owner                 text NOT NULL DEFAULT 'club',        -- 'cufc'|'siu'|'mfl'|'cic'|'up'|'club'
  category                    text,
  unit                        text NOT NULL DEFAULT 'ea',          -- 'ea'|'m'|'roll'|'box'
  purchase_unit               text,
  purchase_qty                numeric(12,3),
  allow_negative              boolean NOT NULL DEFAULT false,      -- D16 — bulk materials where paperwork lags
  is_loanable                 boolean NOT NULL DEFAULT false,
  min_qty                     numeric(12,3),                       -- reorder alert threshold
  cost_cents                  integer,                             -- reference only, NZD cents
  default_location_id         integer REFERENCES wh_locations(id) ON DELETE SET NULL,
  active                      boolean NOT NULL DEFAULT true,
  notes                       text,
  shop_variant_id             integer REFERENCES shop_variants(id) ON DELETE SET NULL,
  shopify_store               text,                                -- 'siu' | 'cufc'
  shopify_inventory_item_id   text,
  shopify_variant_id          text,
  created_at                  timestamp NOT NULL DEFAULT now(),
  updated_at                  timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS wh_items_sku_unique ON wh_items (sku);
CREATE UNIQUE INDEX IF NOT EXISTS wh_items_shop_variant_unique
  ON wh_items (shop_variant_id)
  WHERE shop_variant_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS wh_items_shopify_mapping_unique
  ON wh_items (shopify_store, shopify_variant_id)
  WHERE shopify_variant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS wh_items_brand_kind_idx ON wh_items (brand_owner, kind);
CREATE INDEX IF NOT EXISTS wh_items_default_location_idx ON wh_items (default_location_id);

-- 3) Barcode aliases — manufacturer EANs / any scanned code that isn't the
-- item's own SKU (D5). pack_qty lets one scan of a multipack alias post a
-- multi-unit movement (e.g. a case barcode = 12 eaches).
CREATE TABLE IF NOT EXISTS wh_barcode_aliases (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        text NOT NULL,
  item_id     integer NOT NULL REFERENCES wh_items(id) ON DELETE CASCADE,
  pack_qty    numeric(12,3) NOT NULL DEFAULT 1,
  note        text,
  created_at  timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS wh_barcode_aliases_code_unique ON wh_barcode_aliases (code);
CREATE INDEX IF NOT EXISTS wh_barcode_aliases_item_idx ON wh_barcode_aliases (item_id);

-- 4) THE LEDGER (D1). Append-only — no UPDATE/DELETE code path, ever; stock
-- corrections are new adjustment movements. group_id links every leg of one
-- multi-leg operation (a transfer = a -row at the source + a +row at the
-- destination sharing one group_id). `delta <> 0` is a true numeric invariant
-- — the only CHECK constraint in this whole migration.
CREATE TABLE IF NOT EXISTS wh_movements (
  id                  integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id            uuid NOT NULL DEFAULT gen_random_uuid(),
  item_id             integer NOT NULL REFERENCES wh_items(id) ON DELETE RESTRICT,
  location_id         integer NOT NULL REFERENCES wh_locations(id) ON DELETE RESTRICT,
  delta               numeric(12,3) NOT NULL,
  movement_type       text NOT NULL,             -- receipt|putaway|pick|dispatch|transfer|adjustment|
                                                  -- count|consume|return|loan_out|loan_return (D15)
  reason_code         text,                       -- damaged|shrinkage|count_variance|sample|write_off|
                                                  -- store_use|event_use (D15) — validated app-side, no CHECK
  ref_kind            text,                       -- shop_order|shopify_order|print_order|requisition|loan|po|count
  ref_id              integer,
  operator_user_id    integer NOT NULL REFERENCES users(id),  -- D17 — every movement is scanned against a person
  note                text,
  idempotency_key     text,
  created_at          timestamp NOT NULL DEFAULT now(),
  CONSTRAINT wh_movements_delta_nonzero_chk CHECK (delta <> 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS wh_movements_idempotency_key_unique
  ON wh_movements (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS wh_movements_item_location_idx ON wh_movements (item_id, location_id);
CREATE INDEX IF NOT EXISTS wh_movements_group_idx ON wh_movements (group_id);
CREATE INDEX IF NOT EXISTS wh_movements_ref_idx ON wh_movements (ref_kind, ref_id);
CREATE INDEX IF NOT EXISTS wh_movements_created_idx ON wh_movements (created_at);

-- 5) Stock cache (D1/D2) — maintained in the SAME transaction as the ledger
-- insert via an atomic non-negative-guarded upsert (server/warehouse.ts
-- postMovementGroup). Nightly reconcile asserts on_hand == Σ ledger deltas.
CREATE TABLE IF NOT EXISTS wh_stock (
  id           integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id      integer NOT NULL REFERENCES wh_items(id) ON DELETE CASCADE,
  location_id  integer NOT NULL REFERENCES wh_locations(id) ON DELETE CASCADE,
  on_hand      numeric(12,3) NOT NULL DEFAULT 0,
  updated_at   timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS wh_stock_item_location_unique
  ON wh_stock (item_id, location_id);

-- 6) Reservations (D3) — hard reservations for every paid-but-unfulfilled
-- order (native + Shopify): the shirt is on the shelf until it's picked.
-- Partial-unique so at most one ACTIVE reservation exists per (ref, item).
CREATE TABLE IF NOT EXISTS wh_reservations (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id     integer NOT NULL REFERENCES wh_items(id) ON DELETE RESTRICT,
  qty         numeric(12,3) NOT NULL,
  ref_kind    text NOT NULL,
  ref_id      integer NOT NULL,
  status      text NOT NULL DEFAULT 'active',    -- 'active' | 'released' | 'consumed'
  created_at  timestamp NOT NULL DEFAULT now(),
  updated_at  timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS wh_reservations_active_ref_item_unique
  ON wh_reservations (ref_kind, ref_id, item_id)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS wh_reservations_item_status_idx ON wh_reservations (item_id, status);

-- 7) Purchase orders + lines. qty_received is DERIVED from receipt movements
-- referencing a po_line (ref_kind='po', ref_id=line id) — never stored here.
CREATE TABLE IF NOT EXISTS wh_purchase_orders (
  id             integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  supplier_name  text NOT NULL,
  status         text NOT NULL DEFAULT 'draft',  -- draft|sent|partial|received|closed|cancelled
  expected_on    date,
  notes          text,
  created_by     integer REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamp NOT NULL DEFAULT now(),
  updated_at     timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wh_purchase_orders_status_idx ON wh_purchase_orders (status);

CREATE TABLE IF NOT EXISTS wh_po_lines (
  id               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  po_id            integer NOT NULL REFERENCES wh_purchase_orders(id) ON DELETE CASCADE,
  item_id          integer NOT NULL REFERENCES wh_items(id) ON DELETE RESTRICT,
  qty_ordered      numeric(12,3) NOT NULL,
  unit_cost_cents  integer,
  notes            text
);
CREATE INDEX IF NOT EXISTS wh_po_lines_po_idx ON wh_po_lines (po_id);
CREATE INDEX IF NOT EXISTS wh_po_lines_item_idx ON wh_po_lines (item_id);

-- 8) Requisitions (D13) — any staff submits (requireAuth, same universal
-- pattern as the Feedback board); operators approve/pick/ready/collect.
-- charge_to drives the monthly chargeback report (free text — Daniel names
-- the real department/brand list at seed time).
CREATE TABLE IF NOT EXISTS wh_requisitions (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  requested_by  integer NOT NULL REFERENCES users(id),
  charge_to     text NOT NULL,
  status        text NOT NULL DEFAULT 'submitted', -- submitted|approved|picking|ready|collected|declined
  needed_by     date,
  approved_by   integer REFERENCES users(id) ON DELETE SET NULL,
  collected_at  timestamp,
  notes         text,
  created_at    timestamp NOT NULL DEFAULT now(),
  updated_at    timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wh_requisitions_status_idx ON wh_requisitions (status);
CREATE INDEX IF NOT EXISTS wh_requisitions_requested_by_idx ON wh_requisitions (requested_by);
CREATE INDEX IF NOT EXISTS wh_requisitions_charge_to_idx ON wh_requisitions (charge_to);

CREATE TABLE IF NOT EXISTS wh_requisition_lines (
  id               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  requisition_id   integer NOT NULL REFERENCES wh_requisitions(id) ON DELETE CASCADE,
  item_id          integer NOT NULL REFERENCES wh_items(id) ON DELETE RESTRICT,
  qty_requested    numeric(12,3) NOT NULL,
  qty_picked       numeric(12,3)
);
CREATE INDEX IF NOT EXISTS wh_requisition_lines_requisition_idx ON wh_requisition_lines (requisition_id);
CREATE INDEX IF NOT EXISTS wh_requisition_lines_item_idx ON wh_requisition_lines (item_id);

-- 9) Equipment loans (D14) — library/tool-crib model. overdue is DERIVED
-- (due_on < today AND status='out') — never a stored column. borrower_contact_id
-- is nullable — coaches may lack a ClubOS login, so borrower_name always works.
CREATE TABLE IF NOT EXISTS wh_loans (
  id                   integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  borrower_name        text NOT NULL,
  borrower_contact_id  integer REFERENCES contacts(id) ON DELETE SET NULL,
  due_on               date NOT NULL,
  status               text NOT NULL DEFAULT 'out',  -- 'out' | 'returned'
  operator_user_id     integer NOT NULL REFERENCES users(id),  -- D17 — named at checkout
  notes                text,
  created_at           timestamp NOT NULL DEFAULT now(),
  returned_at          timestamp
);
CREATE INDEX IF NOT EXISTS wh_loans_status_due_idx ON wh_loans (status, due_on);
CREATE INDEX IF NOT EXISTS wh_loans_borrower_contact_idx ON wh_loans (borrower_contact_id);

CREATE TABLE IF NOT EXISTS wh_loan_lines (
  id                          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  loan_id                     integer NOT NULL REFERENCES wh_loans(id) ON DELETE CASCADE,
  item_id                     integer NOT NULL REFERENCES wh_items(id) ON DELETE RESTRICT,
  qty                         numeric(12,3) NOT NULL,
  condition_grade             text,               -- 'A'|'B'|'C'|'D' — set on return
  condition_note              text,
  replacement_charged_cents   integer
);
CREATE INDEX IF NOT EXISTS wh_loan_lines_loan_idx ON wh_loan_lines (loan_id);
CREATE INDEX IF NOT EXISTS wh_loan_lines_item_idx ON wh_loan_lines (item_id);

-- 10) Cycle counts (D12) — blind by default (counter never sees expected_qty,
-- snapshotted server-side and hidden from the counter's UI). counted_by <>
-- approved_by is enforced app-side (shared/warehouse.ts) — both are the same
-- users FK, so a same-table CHECK couldn't express "different row" anyway.
CREATE TABLE IF NOT EXISTS wh_counts (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scope_zone    text,
  scope_class   text,                              -- ABC cadence class, if class-scoped
  blind         boolean NOT NULL DEFAULT true,
  counted_by    integer REFERENCES users(id) ON DELETE SET NULL,
  approved_by   integer REFERENCES users(id) ON DELETE SET NULL,
  status        text NOT NULL DEFAULT 'open',       -- 'open' | 'submitted' | 'approved'
  created_at    timestamp NOT NULL DEFAULT now(),
  submitted_at  timestamp,
  approved_at   timestamp
);
CREATE INDEX IF NOT EXISTS wh_counts_status_idx ON wh_counts (status);

-- expected_qty is the snapshot taken when the session opens — never sent to
-- the counter's UI. Approval posts an adjustment movement group for every line
-- whose resolution is 'accepted' with a variance.
CREATE TABLE IF NOT EXISTS wh_count_lines (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  count_id      integer NOT NULL REFERENCES wh_counts(id) ON DELETE CASCADE,
  item_id       integer NOT NULL REFERENCES wh_items(id) ON DELETE RESTRICT,
  location_id   integer NOT NULL REFERENCES wh_locations(id) ON DELETE RESTRICT,
  expected_qty  numeric(12,3) NOT NULL,
  counted_qty   numeric(12,3),
  resolution    text                               -- 'accepted' | 'recount'
);
CREATE UNIQUE INDEX IF NOT EXISTS wh_count_lines_count_item_location_unique
  ON wh_count_lines (count_id, item_id, location_id);

-- 11) Shopify webhook dedupe (D9) — Shopify can and does redeliver. Unique on
-- the provider's own webhook id, never our own generated key.
CREATE TABLE IF NOT EXISTS wh_shopify_events (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  webhook_id    text NOT NULL,
  topic         text NOT NULL,
  store         text NOT NULL,                     -- 'siu' | 'cufc'
  processed_at  timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS wh_shopify_events_webhook_id_unique ON wh_shopify_events (webhook_id);

-- 12) Per mapped item x store push state — echo suppression + drift detection
-- (D9) + the sync dashboard's data. One row per (item, store).
CREATE TABLE IF NOT EXISTS wh_sync_state (
  id               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id          integer NOT NULL REFERENCES wh_items(id) ON DELETE CASCADE,
  store            text NOT NULL,                  -- 'siu' | 'cufc' | 'native'
  last_pushed_qty  numeric(12,3),
  last_pushed_at   timestamp,
  pending          boolean NOT NULL DEFAULT false,
  last_drift_at    timestamp,
  drift_note       text
);
CREATE UNIQUE INDEX IF NOT EXISTS wh_sync_state_item_store_unique
  ON wh_sync_state (item_id, store);
