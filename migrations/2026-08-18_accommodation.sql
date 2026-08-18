-- ─────────────────────────────────────────────────────────────────────────────
-- ACCOMMODATION — the CUFC residency at 482A Yaldhurst Road.
--
-- Extends the housing_* tables built on 2026-07-10 (which were applied to prod
-- and then never seeded — all six were empty at 0 rows on 2026-08-18) so they
-- can hold what the club's real run sheet holds: the agreement each occupant is
-- on, the power contribution charged alongside rent, the key and condition
-- audit, the compliance actions, and the non-resident squad list.
--
-- The tab is called "Accommodation" and lives in the United Sports Group
-- workspace. The tables keep the `housing_` prefix: renaming live tables to
-- match a UI label buys nothing and breaks every doc that references them.
--
-- THREE THINGS THIS MIGRATION DELIBERATELY DOES NOT DO
--
--  1. It does not add a `total_due` column. What an occupant owes is rate x
--     weeks minus any holiday deduction — derived on read from figures that are
--     all present. A stored total is a second answer that drifts the moment a
--     date is corrected, and the source spreadsheet has four different totals
--     for one term precisely because it stored them.
--
--  2. It does not add `is_occupied` or `status` to a room. Occupancy is "has an
--     active tenancy today". The original migration made this call; nothing
--     here walks it back.
--
--  3. It does not make room_id required. The source records four rooms holding
--     two people at once, and the exclusion constraint correctly refuses the
--     second of each pair. Those tenancies are real and their money is real, so
--     they import with the room left blank and flagged — never guessed into a
--     room nobody has said they were in.
--
-- ADDITIVE ONLY. Safe on the live DB: every statement is IF NOT EXISTS or an
-- ADD COLUMN. No drops, no data rewrites, no CHECK constraints on the enum-ish
-- text columns (a stale CHECK is what 500'd the MFL checkout).
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── Billing periods ──────────────────────────────────────────────────────────
-- The club lets these rooms by TERM, not by calendar month: "Jan–May 2026" then
-- "May–Sep 2026". Every invoice, every subtotal and every reconciliation in the
-- source workbook is per term, so the term is a real object rather than a date
-- range someone has to re-derive. Two periods today; one more every season.
CREATE TABLE IF NOT EXISTS housing_periods (
  id               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id  integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             text NOT NULL,                    -- "Jan–May 2026"
  start_date       date NOT NULL,
  end_date         date NOT NULL,                    -- INCLUSIVE, as everywhere else here
  -- What the source document claimed this term totalled. Kept ONLY so the tab
  -- can show the club's own historic figure beside the recomputed one and name
  -- the variance. Never used as an amount owed by anybody.
  stated_total_cents integer,
  stated_total_note  text,
  notes            text,
  closed_at        timestamptz,                      -- reconciled and closed off
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT housing_periods_dates_ck CHECK (end_date >= start_date)
);
CREATE UNIQUE INDEX IF NOT EXISTS housing_periods_org_name_unq
  ON housing_periods (organization_id, lower(name));

-- ── Rooms: the master directory columns ──────────────────────────────────────
ALTER TABLE housing_rooms ADD COLUMN IF NOT EXISTS bed_config          text;
ALTER TABLE housing_rooms ADD COLUMN IF NOT EXISTS occupant_type       text;
-- What an occupant contributes toward power each week, kept apart from rent.
-- These are different debts: in the Jan–May term power was rolled into an
-- inclusive rent, and from May–Sep it is invoiced as its own $30/wk line. One
-- combined number cannot express both, which is why the source sheet's single
-- "Rent p/w & Power" column reads $30 for a player whose rent is $0.
ALTER TABLE housing_rooms ADD COLUMN IF NOT EXISTS default_utilities_cents integer NOT NULL DEFAULT 0;
ALTER TABLE housing_rooms ADD COLUMN IF NOT EXISTS key_code            text;
ALTER TABLE housing_rooms ADD COLUMN IF NOT EXISTS condition_status    text;
ALTER TABLE housing_rooms ADD COLUMN IF NOT EXISTS condition_checked_on date;
ALTER TABLE housing_rooms ADD COLUMN IF NOT EXISTS property_lead       text;
-- A reserve room is a sick / quarantine / overflow bed. It is NOT lettable, so
-- counting the two of them in the denominator would report the residency as 85%
-- full when every room that can earn rent is taken.
ALTER TABLE housing_rooms ADD COLUMN IF NOT EXISTS is_reserve          boolean NOT NULL DEFAULT false;
-- The status word the source document used, kept verbatim for audit. The room's
-- real occupancy is always derived; this is never read as truth.
ALTER TABLE housing_rooms ADD COLUMN IF NOT EXISTS source_status       text;

-- ── Tenancies: agreement, money and the check-in audit ───────────────────────
ALTER TABLE housing_tenancies ADD COLUMN IF NOT EXISTS period_id      integer REFERENCES housing_periods(id) ON DELETE SET NULL;
ALTER TABLE housing_tenancies ADD COLUMN IF NOT EXISTS utilities_cents integer NOT NULL DEFAULT 0;
-- true = the rent figure already covers power (the Jan–May arrangement).
ALTER TABLE housing_tenancies ADD COLUMN IF NOT EXISTS utilities_included boolean NOT NULL DEFAULT false;
-- licence_to_occupy | boarding_agreement | short_term_rental | club_remuneration
-- | residential_tenancy | undecided.  Which of these applies is ACT-005, still
-- open with Harcourts — so `undecided` is a first-class value, not a blank.
ALTER TABLE housing_tenancies ADD COLUMN IF NOT EXISTS agreement_type text;
ALTER TABLE housing_tenancies ADD COLUMN IF NOT EXISTS occupant_category text;
-- 🔴 Rent of $0 does NOT mean nobody is paying. For a contracted player the room
-- is part of the remuneration package — the club is paying for it in wages. A
-- flag keeps "housed as part of their contract" apart from "owes nothing", which
-- a bare 0 cannot, and stops the rent roll reporting eight players as freeloaders.
ALTER TABLE housing_tenancies ADD COLUMN IF NOT EXISTS is_remuneration boolean NOT NULL DEFAULT false;
-- Weeks the occupant was away and not charged (the club's own Christmas
-- deduction). This is what reconciles 23 calendar weeks to the 21 billed.
ALTER TABLE housing_tenancies ADD COLUMN IF NOT EXISTS holiday_weeks numeric(5,2) NOT NULL DEFAULT 0;
ALTER TABLE housing_tenancies ADD COLUMN IF NOT EXISTS key_issued     boolean NOT NULL DEFAULT false;
ALTER TABLE housing_tenancies ADD COLUMN IF NOT EXISTS key_returned_on date;
-- signed | pending | returned | none
ALTER TABLE housing_tenancies ADD COLUMN IF NOT EXISTS condition_report text;
ALTER TABLE housing_tenancies ADD COLUMN IF NOT EXISTS agreement_signed_on date;
-- What the source document said this tenancy totalled, for the variance panel.
-- Never treated as an amount owed — the amount owed is always recomputed.
ALTER TABLE housing_tenancies ADD COLUMN IF NOT EXISTS stated_total_cents integer;
ALTER TABLE housing_tenancies ADD COLUMN IF NOT EXISTS source_payment_status text;
-- Natural key from the source workbook (JM-01, MS-09…). Makes the import
-- idempotent: re-running updates the same row instead of creating a second one.
ALTER TABLE housing_tenancies ADD COLUMN IF NOT EXISTS source_ref     text;
-- Set ONLY when room_id is null, so a tenancy whose room is disputed still
-- attaches its money to the right house. When room_id is set the house always
-- comes from the room — this column is not consulted at all.
ALTER TABLE housing_tenancies ADD COLUMN IF NOT EXISTS unconfirmed_house_id integer REFERENCES housing_houses(id) ON DELETE SET NULL;
ALTER TABLE housing_tenancies ADD COLUMN IF NOT EXISTS room_conflict_note text;

-- 🔴 A tenancy may have no room. See note 3 at the top of this file. NULL room
-- rows never trip the exclusion constraint (GiST `=` is never true for NULL),
-- so this does not weaken "one room, one tenant" for the rooms we do know.
ALTER TABLE housing_tenancies ALTER COLUMN room_id DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS housing_tenancies_source_ref_unq
  ON housing_tenancies (organization_id, source_ref) WHERE source_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS housing_tenancies_period_idx ON housing_tenancies (period_id);

-- ── Rent charges: which term an invoice belongs to ───────────────────────────
ALTER TABLE housing_rent_charges ADD COLUMN IF NOT EXISTS period_id integer REFERENCES housing_periods(id) ON DELETE SET NULL;
-- rent | utilities | combined — a term where power was billed inside the rent
-- produces one `combined` charge; a term where it is a separate $30/wk line
-- produces one `rent` and one `utilities` charge, so each can be chased and
-- paid on its own.
ALTER TABLE housing_rent_charges ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'rent';
ALTER TABLE housing_rent_charges ADD COLUMN IF NOT EXISTS source_ref text;
CREATE INDEX IF NOT EXISTS housing_rent_charges_period_idx ON housing_rent_charges (period_id);

-- ── The accommodation roster ─────────────────────────────────────────────────
-- Everyone the accommodation manager tracks, INCLUDING the twelve squad players
-- who live off-site. They have no tenancy by definition, so a tenancy-only view
-- cannot show them, and "who still needs housing" is the question this list
-- exists to answer.
--
-- Their accommodation status is DERIVED (active tenancy = resident, past
-- tenancy = former, neither = non-resident) and has no column here: a stored
-- status is wrong from the moment a tenancy ends.
CREATE TABLE IF NOT EXISTS housing_roster (
  id               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id  integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- RESTRICT for the same reason as housing_tenancies: deleting a person must
  -- never quietly remove them from the housing record.
  contact_id       integer NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
  role_label       text,                             -- "Senior Squad Player"
  -- 🔴 The legal name is a separate fact from the name people use. Two occupants
  -- cannot be issued an agreement until theirs is confirmed (ACT-001), and a
  -- signature page in the wrong name is not binding. Unverified is the default;
  -- nothing infers a legal name from a display name.
  legal_name       text,
  legal_name_verified boolean NOT NULL DEFAULT false,
  emergency_contact_name  text,
  emergency_contact_phone text,
  notes            text,
  archived_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS housing_roster_org_contact_unq
  ON housing_roster (organization_id, contact_id);

-- ── Actions and data conflicts ───────────────────────────────────────────────
-- Two kinds in one table because they are the same object to the person working
-- the list: something that needs a decision before this system is trustworthy.
-- `kind='conflict'` rows record where the source documents disagree with each
-- other — kept visible rather than silently resolved, because picking one of
-- four totals for a term is a finance decision and not an import decision.
--
-- Deliberately small and deliberately NOT a fourth project-management system.
-- Anything that becomes real project work belongs in the Task Tracker; this is
-- the compliance list that has to sit beside the data it blocks.
CREATE TABLE IF NOT EXISTS housing_action_items (
  id               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id  integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind             text NOT NULL DEFAULT 'action',   -- action | conflict
  ref              text,                             -- ACT-001, CONF-006
  priority         text NOT NULL DEFAULT 'medium',   -- high | medium | low
  category         text,
  title            text NOT NULL,
  detail           text,
  owner_label      text,                             -- "Head of Football Ops" — a role, not a login
  assigned_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  status           text NOT NULL DEFAULT 'open',     -- open|in_progress|under_review|pending|completed|dismissed
  target_date      date,
  resolution_notes text,
  completed_on     date,
  -- Which rows this concerns, so the tenancy list can show its own flags.
  related          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS housing_action_items_org_ref_unq
  ON housing_action_items (organization_id, ref) WHERE ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS housing_action_items_open_idx
  ON housing_action_items (organization_id, status) WHERE status <> 'completed' AND status <> 'dismissed';

COMMIT;

-- ── Row level security ───────────────────────────────────────────────────────
-- New tables default to RLS OFF and a Supabase anon key is public by design.
-- The app connects as postgres/service-role (rolbypassrls), so this changes
-- nothing for ClubOS and everything for a leaked key. Run scripts/security/
-- rls_guard.mjs after applying.
ALTER TABLE housing_periods      ENABLE ROW LEVEL SECURITY;
ALTER TABLE housing_roster       ENABLE ROW LEVEL SECURITY;
ALTER TABLE housing_action_items ENABLE ROW LEVEL SECURITY;
