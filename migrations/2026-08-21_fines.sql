-- ─────────────────────────────────────────────────────────────────────────────
-- FINES — paid and unpaid fines, in both directions, with their paperwork.
--
-- Run BEFORE the deploy:
--   npx tsx --env-file=.env script/apply-fines.ts --commit
--
-- ADDITIVE. Two new tables, nothing existing is touched.
--
-- A fine the club owes (a parking ticket, a Mainland Football misconduct
-- charge) and a fine owed to the club (a disciplinary fine on a player) are the
-- same object pointing opposite ways — an amount, a due date, a payment, and a
-- piece of paper. One table with a `direction`, because two tables would drift.
--
-- Deliberately NO CHECK constraints on `direction`, `category` or an attachment
-- `kind`: those value sets will grow, and a stale CHECK is how the MFL checkout
-- 500'd on registration_items_product_type_check. They are validated
-- application-side in shared/fines.ts.
--
-- The CHECKs that ARE here encode things that can never need to grow: a fine
-- cannot be for a negative amount, a file cannot have negative bytes, and a
-- fine cannot be both paid and waived — if money left the account it was paid,
-- whatever anyone later decided to call it.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS fines (
  id                  integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  organization_id     integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- 'club_owes' | 'owed_to_club'. See shared/fines.ts.
  direction           text NOT NULL,
  category            text NOT NULL DEFAULT 'other',

  -- The notice / infringement number as printed on the paper.
  reference           text,
  -- Who issued it (club_owes), or what it is for (owed_to_club).
  counterparty        text NOT NULL,
  description         text,

  -- Who it concerns: the driver at the time of the offence, or the person who
  -- owes the club. RESTRICT because deleting a person must never silently erase
  -- money they owed — the same reasoning as housing tenants and served_by.
  person_contact_id   integer REFERENCES contacts(id) ON DELETE RESTRICT,
  -- 🔴 The driver is RECORDED, never derived from the fleet assignment history.
  -- In New Zealand the registered owner is liable unless liability is formally
  -- transferred to the driver, so naming a driver is a legal assertion a human
  -- makes. The app offers the assignment history as a hint and stores nothing
  -- until someone confirms it.
  vehicle_id          integer REFERENCES fleet_vehicles(id) ON DELETE RESTRICT,

  amount_cents        integer NOT NULL,

  -- When the offence happened, which is NOT when the notice was issued and can
  -- be weeks earlier. It is the date that decides who was driving.
  offence_on          date,
  issued_on           date,
  due_on              date,

  -- Paid is a FACT. Overdue is computed from this being null — never stored.
  paid_on             date,
  paid_reference      text,
  -- Successfully challenged, or written off. Not "paid": no money moved.
  waived_on           date,
  waived_reason       text,

  notes               text,
  created_by          integer REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fines_amount_nonneg     CHECK (amount_cents >= 0),
  CONSTRAINT fines_not_paid_and_waived CHECK (paid_on IS NULL OR waived_on IS NULL)
);

-- 🔴 The same fine entered twice is the actual failure mode here: a notice
-- arrives by post and by email, two people log it, and the club pays once but
-- shows a permanent phantom debt. A notice number is unique, so the database
-- refuses the duplicate. Case-insensitive, and only where a reference exists —
-- plenty of fines arrive without one.
CREATE UNIQUE INDEX IF NOT EXISTS fines_org_reference_unq
  ON fines (organization_id, upper(reference))
  WHERE reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS fines_org_direction_idx ON fines (organization_id, direction);
CREATE INDEX IF NOT EXISTS fines_org_due_idx       ON fines (organization_id, due_on);
CREATE INDEX IF NOT EXISTS fines_vehicle_idx       ON fines (vehicle_id);
CREATE INDEX IF NOT EXISTS fines_person_idx        ON fines (person_contact_id);


CREATE TABLE IF NOT EXISTS fine_attachments (
  id                integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  organization_id   integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  fine_id           integer NOT NULL REFERENCES fines(id) ON DELETE CASCADE,

  -- 'notice' | 'payment_confirmation' | 'correspondence' | 'other'.
  -- Keeping the receipt distinguishable from the notice is the point: "has this
  -- been paid" is answerable at a glance only if the two are not one pile.
  kind              text NOT NULL DEFAULT 'other',

  filename          text NOT NULL,
  content_type      text NOT NULL,
  size_bytes        integer NOT NULL,
  -- Opaque. Addressed through server/drive-storage.ts, never parsed, so these
  -- files move to R2 with the rest of the club's storage and no schema change.
  storage_key       text NOT NULL,
  storage_backend   text NOT NULL,
  checksum          text,

  uploaded_by       integer REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fine_attachments_size_nonneg CHECK (size_bytes >= 0)
);

CREATE INDEX IF NOT EXISTS fine_attachments_fine_idx ON fine_attachments (fine_id, uploaded_at);
CREATE INDEX IF NOT EXISTS fine_attachments_org_idx  ON fine_attachments (organization_id);
