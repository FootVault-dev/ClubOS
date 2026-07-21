-- ─────────────────────────────────────────────────────────────────────────────
-- MAINTENANCE — the United Sports Centre's cleaning/consumable supplies and
-- its machines & equipment (mowers, tractors, power tools…).
--
-- Lives in the United Sports Centre workspace (org 4, workspace type `venue`),
-- the sibling of housing (migrations/2026-07-10_usc_housing.sql). Built for
-- Riley, the facility/grounds staffer, who is phone-first.
--
-- Two things are DERIVED, never stored, and this schema deliberately has no
-- column for either (see shared/maintenance.ts):
--   * a supply's stock status   (out / low / no_level / ok, from qty vs reorder level)
--   * a machine's service status (overdue / due_soon / unknown / ok, from
--     next_service_due_on vs today-in-NZ)
--
-- ADDITIVE ONLY — safe on the live DB. CREATE ... IF NOT EXISTS, no drops, no
-- ALTER on existing tables. Categories/statuses/reasons/kinds are validated
-- TEXT (shared/maintenance.ts), never pg enums and never DB CHECK constraints
-- on those columns — a stale CHECK is how the MFL checkout 500'd once. The
-- only CHECKs below are plain non-negative-number guards, not enum gates.
-- Run BEFORE the Fly deploy.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Supplies ─────────────────────────────────────────────────────────────────
-- Cleaning products and other maintenance consumables. `location`/`supplier`
-- are free text — Riley knows where things live better than a dropdown would.
CREATE TABLE IF NOT EXISTS maint_supplies (
  id               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id  integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             text NOT NULL,
  category         text NOT NULL DEFAULT 'other',   -- cleaning|consumable|parts|safety|other
  unit             text,                             -- "bottles", "rolls", "L" — free text
  qty_on_hand      integer NOT NULL DEFAULT 0,
  reorder_level    integer,                          -- NULL = no reorder level set yet
  location         text,
  supplier         text,
  cost_cents       integer,                          -- a reference unit cost, not a ledger
  notes            text,
  status           text NOT NULL DEFAULT 'active',    -- active|archived
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT maint_supplies_qty_ck  CHECK (qty_on_hand >= 0),
  CONSTRAINT maint_supplies_reorder_ck CHECK (reorder_level IS NULL OR reorder_level >= 0),
  CONSTRAINT maint_supplies_cost_ck CHECK (cost_cents IS NULL OR cost_cents >= 0)
);
CREATE INDEX IF NOT EXISTS maint_supplies_org_idx ON maint_supplies (organization_id);

-- ── Stock movements ──────────────────────────────────────────────────────────
-- Append-only log. A movement INSERT and the qty_on_hand UPDATE on the parent
-- supply always happen in one transaction (server/maintenance-routes.ts) —
-- qty may never go below 0, rejected with a 400, never silently clamped.
CREATE TABLE IF NOT EXISTS maint_stock_movements (
  id               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  supply_id        integer NOT NULL REFERENCES maint_supplies(id) ON DELETE CASCADE,
  organization_id  integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  delta            integer NOT NULL,                 -- +received / -used
  reason           text NOT NULL,                     -- received|used|adjusted|stocktake
  note             text,
  recorded_by      text,                              -- staff email/name from session
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT maint_stock_movements_delta_ck CHECK (delta <> 0)
);
CREATE INDEX IF NOT EXISTS maint_stock_movements_supply_idx ON maint_stock_movements (supply_id);
CREATE INDEX IF NOT EXISTS maint_stock_movements_org_idx   ON maint_stock_movements (organization_id);

-- ── Assets (machines & equipment) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS maint_assets (
  id                    integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id       integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                  text NOT NULL,
  category              text NOT NULL DEFAULT 'other',   -- mower|tractor|trailer|power_tool|appliance|other
  make                  text,
  model                 text,
  serial                text,
  location              text,
  purchase_date         date,
  purchase_cost_cents   integer,
  last_serviced_on      date,
  next_service_due_on   date,
  status                text NOT NULL DEFAULT 'active',  -- active|retired
  notes                 text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT maint_assets_purchase_cost_ck CHECK (purchase_cost_cents IS NULL OR purchase_cost_cents >= 0)
);
CREATE INDEX IF NOT EXISTS maint_assets_org_idx ON maint_assets (organization_id);

-- ── Service records ──────────────────────────────────────────────────────────
-- Logging a service updates the asset's last_serviced_on (max of existing/new)
-- and, when next_due_on is given, its next_service_due_on — done server-side
-- (server/maintenance-routes.ts), never trusted from the client.
CREATE TABLE IF NOT EXISTS maint_service_records (
  id               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  asset_id         integer NOT NULL REFERENCES maint_assets(id) ON DELETE CASCADE,
  organization_id  integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  serviced_on      date NOT NULL,
  kind             text NOT NULL DEFAULT 'service',  -- service|repair|inspection
  performed_by     text,
  cost_cents       integer,
  next_due_on      date,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT maint_service_records_cost_ck CHECK (cost_cents IS NULL OR cost_cents >= 0)
);
CREATE INDEX IF NOT EXISTS maint_service_records_asset_idx ON maint_service_records (asset_id);
CREATE INDEX IF NOT EXISTS maint_service_records_org_idx   ON maint_service_records (organization_id);
