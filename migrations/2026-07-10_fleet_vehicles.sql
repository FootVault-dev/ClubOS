-- ─────────────────────────────────────────────────────────────────────────────
-- FLEET — company vehicles, assignments, insurance, servicing, running costs.
--
-- ADDITIVE ONLY. Five new tables, nothing existing is touched.
-- Run BEFORE the Fly deploy:  npx tsx --env-file=.env script/apply-fleet-vehicles.ts
-- Never `db:push` against prod — it drops drifted columns.
--
-- Deliberately NO CHECK constraints on `status`, `category`, `service_type`,
-- `cover_type`, `fuel_type` or `vehicle_type`. Those value sets will grow, and
-- a stale CHECK is how the MFL checkout 500'd on `registration_items_
-- product_type_check` — code shipped a new value the database had never heard
-- of. They are validated application-side in shared/vehicles.ts instead.
--
-- The CHECKs that ARE here encode invariants that can never need to grow:
-- you cannot return a vehicle before you were given it, a policy cannot expire
-- before it starts, and an odometer cannot read negative.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS fleet_vehicles (
  id                    integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  organization_id       integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  plate                 text NOT NULL,
  make                  text NOT NULL,
  model                 text NOT NULL,
  variant               text,
  year                  integer,
  colour                text,
  vin                   text,
  engine_number         text,
  vehicle_type          text NOT NULL DEFAULT 'car',
  fuel_type             text NOT NULL DEFAULT 'petrol',
  transmission          text,
  seats                 integer,

  odometer_km           integer,
  odometer_at           date,

  compliance_type       text NOT NULL DEFAULT 'wof',
  wof_expires_on        date,
  cof_expires_on        date,
  rego_expires_on       date,

  ruc_required          boolean NOT NULL DEFAULT false,
  ruc_valid_to_km       integer,

  ownership             text NOT NULL DEFAULT 'owned',
  lessor                text,
  lease_ends_on         date,
  lease_monthly_cents   integer,
  purchased_on          date,
  purchase_price_cents  integer,
  supplier              text,
  disposed_on           date,
  disposal_price_cents  integer,

  status                text NOT NULL DEFAULT 'active',

  next_service_due_on   date,
  next_service_due_km   integer,

  fbt_private_use       boolean NOT NULL DEFAULT false,
  fbt_exemption         text NOT NULL DEFAULT 'none',
  fbt_notes             text,

  notes                 text,
  created_by            integer REFERENCES users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fleet_vehicles_odometer_nonneg CHECK (odometer_km IS NULL OR odometer_km >= 0),
  CONSTRAINT fleet_vehicles_ruc_km_nonneg   CHECK (ruc_valid_to_km IS NULL OR ruc_valid_to_km >= 0)
);

-- A plate is unique in New Zealand — but it can be transferred off a disposed
-- vehicle onto a replacement, so uniqueness holds among LIVE vehicles only.
-- Case-insensitive: someone will type "abc123".
CREATE UNIQUE INDEX IF NOT EXISTS fleet_vehicles_org_plate_live_unq
  ON fleet_vehicles (organization_id, upper(plate))
  WHERE status <> 'disposed';

CREATE INDEX IF NOT EXISTS fleet_vehicles_org_status_idx ON fleet_vehicles (organization_id, status);
CREATE INDEX IF NOT EXISTS fleet_vehicles_org_plate_idx  ON fleet_vehicles (organization_id, plate);


CREATE TABLE IF NOT EXISTS fleet_assignments (
  id                  integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  organization_id     integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  vehicle_id          integer NOT NULL REFERENCES fleet_vehicles(id) ON DELETE CASCADE,

  holder_user_id      integer REFERENCES users(id) ON DELETE SET NULL,
  holder_name         text NOT NULL,
  holder_email        text,
  holder_phone        text,
  licence_class       text,
  licence_expires_on  date,

  assigned_on         date NOT NULL,
  returned_on         date,
  odometer_start_km   integer,
  odometer_end_km     integer,

  purpose             text,
  notes               text,
  created_by          integer REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fleet_assignments_returned_after_assigned
    CHECK (returned_on IS NULL OR returned_on >= assigned_on)
);

-- Two people cannot hold the same vehicle at once. The DATABASE says so, rather
-- than the application hoping so — the same reason the Meet booking system uses
-- an exclusion constraint instead of a read-then-write check.
CREATE UNIQUE INDEX IF NOT EXISTS fleet_assignments_one_open_unq
  ON fleet_assignments (vehicle_id)
  WHERE returned_on IS NULL;

CREATE INDEX IF NOT EXISTS fleet_assignments_vehicle_idx ON fleet_assignments (vehicle_id, assigned_on);
CREATE INDEX IF NOT EXISTS fleet_assignments_org_idx     ON fleet_assignments (organization_id);


CREATE TABLE IF NOT EXISTS fleet_insurance_policies (
  id                  integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  organization_id     integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  vehicle_id          integer NOT NULL REFERENCES fleet_vehicles(id) ON DELETE CASCADE,

  insurer             text NOT NULL,
  policy_number       text NOT NULL,
  cover_type          text NOT NULL DEFAULT 'comprehensive',
  starts_on           date NOT NULL,
  expires_on          date NOT NULL,
  excess_cents        integer,
  premium_cents       integer,
  agreed_value_cents  integer,
  contact_name        text,
  contact_phone       text,

  notes               text,
  created_by          integer REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fleet_insurance_expires_after_starts CHECK (expires_on >= starts_on)
);

CREATE INDEX IF NOT EXISTS fleet_insurance_vehicle_expiry_idx ON fleet_insurance_policies (vehicle_id, expires_on);
CREATE INDEX IF NOT EXISTS fleet_insurance_org_idx            ON fleet_insurance_policies (organization_id);


CREATE TABLE IF NOT EXISTS fleet_service_records (
  id                   integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  organization_id      integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  vehicle_id           integer NOT NULL REFERENCES fleet_vehicles(id) ON DELETE CASCADE,

  serviced_on          date NOT NULL,
  service_type         text NOT NULL DEFAULT 'service',
  provider             text,
  odometer_km          integer,
  description          text,
  cost_cents           integer,
  invoice_ref          text,
  next_service_due_on  date,
  next_service_due_km  integer,

  notes                text,
  created_by           integer REFERENCES users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fleet_service_odometer_nonneg CHECK (odometer_km IS NULL OR odometer_km >= 0)
);

CREATE INDEX IF NOT EXISTS fleet_service_vehicle_idx ON fleet_service_records (vehicle_id, serviced_on);
CREATE INDEX IF NOT EXISTS fleet_service_org_idx     ON fleet_service_records (organization_id);


CREATE TABLE IF NOT EXISTS fleet_costs (
  id               integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  organization_id  integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  vehicle_id       integer NOT NULL REFERENCES fleet_vehicles(id) ON DELETE CASCADE,

  incurred_on      date NOT NULL,
  category         text NOT NULL,
  -- GST-inclusive, as it appears on the docket. Signed: a credit or refund is a
  -- negative cost, so no non-negative constraint here.
  amount_cents     integer NOT NULL,
  supplier         text,
  reference        text,
  odometer_km      integer,
  litres           double precision,

  notes            text,
  created_by       integer REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fleet_costs_odometer_nonneg CHECK (odometer_km IS NULL OR odometer_km >= 0),
  CONSTRAINT fleet_costs_litres_positive CHECK (litres IS NULL OR litres > 0)
);

CREATE INDEX IF NOT EXISTS fleet_costs_vehicle_idx      ON fleet_costs (vehicle_id, incurred_on);
CREATE INDEX IF NOT EXISTS fleet_costs_org_category_idx ON fleet_costs (organization_id, category);
