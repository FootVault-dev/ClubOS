-- ─────────────────────────────────────────────────────────────────────────────
-- HOUSING — the on-site residency houses, their rooms, their tenants, the rent
-- owed, and the power/wifi/water bills the club has to pay.
--
-- Lives in the United Sports Centre workspace (org 4, workspace type `venue`),
-- alongside the facilities it already manages. A house is NOT a `facility`:
-- facilities are booked by the hour with `price_per_hour_cents`, houses are let
-- by the week with a tenant living in them. Overloading facility_type with
-- "bedroom" would have put a person's tenancy inside the pitch-hire calendar.
--
-- A tenant is a `contacts` row, not a new person table. Residency players are
-- already contacts (and squad members); forking them would fork the club's
-- database. Same reasoning as club_squad_members.
--
-- Two things are DERIVED, never stored, and this schema deliberately has no
-- column for either:
--   * `overdue` — a stored status is only true until the day nobody runs the
--     job that flips it. It is `paid_on IS NULL AND due_on < today-in-NZ`.
--   * room occupancy — an `is_occupied` flag goes stale the instant a tenancy
--     ends and nobody clicks. It is "has an active tenancy today".
--
-- ADDITIVE ONLY — safe on the live DB. CREATE ... IF NOT EXISTS, no drops.
-- Statuses/kinds are TEXT validated in shared/housing.ts, not pg enums (this DB
-- has documented enum drift). Run BEFORE the Fly deploy.
-- ─────────────────────────────────────────────────────────────────────────────

-- `btree_gist` lets an exclusion constraint mix `=` on room_id with `&&` on a
-- daterange. Without it, "two tenants in one bedroom" is only ever an app-level
-- check that a race, a retry or a second admin tab can walk straight through.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- A tenant who is already a player or a staff member keeps the type they have —
-- we only need a type for someone who exists in ClubOS solely because they rent
-- a room. Runs OUTSIDE the transaction below: Postgres forbids using a new enum
-- value in the same transaction that adds it, and this way nothing can try.
ALTER TYPE contact_type ADD VALUE IF NOT EXISTS 'tenant';

BEGIN;

-- ── Houses ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS housing_houses (
  id               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id  integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             text NOT NULL,                       -- "House 1", "12 Lismore St"
  address          text,
  notes            text,
  -- Archive, never delete: a house with tenancy history is a financial record.
  archived_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS housing_houses_org_name_unq
  ON housing_houses (organization_id, lower(name));

-- ── Rooms ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS housing_rooms (
  id                       integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  house_id                 integer NOT NULL REFERENCES housing_houses(id) ON DELETE CASCADE,
  organization_id          integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                     text NOT NULL,               -- "Room 1", "Master ensuite"
  room_type                text NOT NULL DEFAULT 'single',   -- single|double|twin|ensuite|studio|other
  -- The room's asking rent. The TENANCY carries the rent actually agreed, so a
  -- later price rise never rewrites what a sitting tenant owes.
  default_rent_cents       integer NOT NULL DEFAULT 0,
  default_rent_frequency   text NOT NULL DEFAULT 'weekly',   -- weekly|fortnightly|monthly
  notes                    text,
  archived_at              timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS housing_rooms_house_name_unq
  ON housing_rooms (house_id, lower(name));
CREATE INDEX IF NOT EXISTS housing_rooms_org_idx ON housing_rooms (organization_id);

-- ── Tenancies ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS housing_tenancies (
  id               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_id          integer NOT NULL REFERENCES housing_rooms(id) ON DELETE CASCADE,
  organization_id  integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- RESTRICT, not CASCADE: deleting a person must never silently erase the rent
  -- they owed. Detach the tenancy first, deliberately.
  contact_id       integer NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
  rent_cents       integer NOT NULL DEFAULT 0,
  rent_frequency   text NOT NULL DEFAULT 'weekly',
  start_date       date NOT NULL,
  end_date         date,                                -- NULL = ongoing. INCLUSIVE: the last night.
  bond_cents       integer NOT NULL DEFAULT 0,
  bond_returned_on date,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT housing_tenancies_dates_ck CHECK (end_date IS NULL OR end_date >= start_date),
  CONSTRAINT housing_tenancies_rent_ck  CHECK (rent_cents >= 0 AND bond_cents >= 0)
);
CREATE INDEX IF NOT EXISTS housing_tenancies_room_idx    ON housing_tenancies (room_id);
CREATE INDEX IF NOT EXISTS housing_tenancies_contact_idx ON housing_tenancies (contact_id);
CREATE INDEX IF NOT EXISTS housing_tenancies_org_idx     ON housing_tenancies (organization_id);

-- 🔴 One room, one tenant, at any one moment — enforced by the database.
-- `daterange(start, end, '[]')` makes end_date inclusive; a NULL end is
-- unbounded ("still living there"). Two tenancies that merely touch — one ends
-- 30 Jun, the next starts 1 Jul — do not overlap and are allowed.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'housing_tenancies_no_overlap') THEN
    ALTER TABLE housing_tenancies
      ADD CONSTRAINT housing_tenancies_no_overlap
      EXCLUDE USING gist (
        room_id WITH =,
        daterange(start_date, end_date, '[]') WITH &&
      );
  END IF;
END $$;

-- ── Rent charges ─────────────────────────────────────────────────────────────
-- One row per rent instalment. Generated deterministically from the tenancy by
-- shared/housing.ts `chargePeriods()`; the (tenancy_id, due_on) unique index is
-- what makes re-running the generator idempotent instead of double-charging.
CREATE TABLE IF NOT EXISTS housing_rent_charges (
  id                integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenancy_id        integer NOT NULL REFERENCES housing_tenancies(id) ON DELETE CASCADE,
  organization_id   integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period_start      date NOT NULL,
  period_end        date NOT NULL,
  due_on            date NOT NULL,                      -- rent in advance: the first day of the period
  amount_cents      integer NOT NULL,
  paid_on           date,                               -- NULL = unpaid. Overdue is derived from this.
  paid_amount_cents integer,
  method            text,                               -- bank_transfer|automatic_payment|cash|card|other
  reference         text,
  waived            boolean NOT NULL DEFAULT false,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT housing_rent_charges_amount_ck CHECK (amount_cents >= 0),
  CONSTRAINT housing_rent_charges_period_ck CHECK (period_end >= period_start)
);
CREATE UNIQUE INDEX IF NOT EXISTS housing_rent_charges_tenancy_due_unq
  ON housing_rent_charges (tenancy_id, due_on);
-- The chase list: unpaid charges, oldest first.
CREATE INDEX IF NOT EXISTS housing_rent_charges_unpaid_idx
  ON housing_rent_charges (organization_id, due_on) WHERE paid_on IS NULL AND waived = false;

-- ── Utility accounts (power, wifi, water…) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS housing_utility_accounts (
  id                    integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  house_id              integer NOT NULL REFERENCES housing_houses(id) ON DELETE CASCADE,
  organization_id       integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind                  text NOT NULL,                  -- power|internet|water|gas|rates|insurance|waste|other
  provider              text,                           -- "Meridian", "2degrees"
  account_number        text,
  billing_frequency     text NOT NULL DEFAULT 'monthly',
  expected_amount_cents integer NOT NULL DEFAULT 0,     -- a budgeting hint, never what gets paid
  notes                 text,
  archived_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS housing_utility_accounts_house_idx ON housing_utility_accounts (house_id);
CREATE INDEX IF NOT EXISTS housing_utility_accounts_org_idx   ON housing_utility_accounts (organization_id);

-- ── Utility bills ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS housing_utility_bills (
  id                 integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  utility_account_id integer NOT NULL REFERENCES housing_utility_accounts(id) ON DELETE CASCADE,
  organization_id    integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period_label       text,                              -- "June 2026" — free text, providers disagree
  due_on             date NOT NULL,
  amount_cents       integer NOT NULL,
  paid_on            date,
  paid_amount_cents  integer,
  method             text,
  reference          text,
  waived             boolean NOT NULL DEFAULT false,
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT housing_utility_bills_amount_ck CHECK (amount_cents >= 0)
);
CREATE INDEX IF NOT EXISTS housing_utility_bills_account_idx ON housing_utility_bills (utility_account_id);
CREATE INDEX IF NOT EXISTS housing_utility_bills_unpaid_idx
  ON housing_utility_bills (organization_id, due_on) WHERE paid_on IS NULL AND waived = false;

COMMIT;
