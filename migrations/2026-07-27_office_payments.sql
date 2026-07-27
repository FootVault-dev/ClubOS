-- Office / walk-up registrations: how they paid, and who served them.
--
-- A parent registers at the counter and pays EFTPOS or cash. Until now the
-- manual-registration path recorded neither the tender nor the staff member,
-- and never even set amount_paid — all 13 existing admin_manual rows read
-- $0.00 while sitting at status 'confirmed'. You could not reconcile the till
-- or the EFTPOS terminal against ClubOS, and if a payment went missing there
-- was no record of who took it.
--
-- Additive only. Every column is nullable: an online Stripe registration has
-- no tender and no server, and must stay that way rather than be backfilled
-- with a guess.

ALTER TABLE registrations ADD COLUMN IF NOT EXISTS payment_method text;
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS payment_reference text;

-- ON DELETE RESTRICT, deliberately — the same reasoning as housing tenants and
-- squad members. Deleting a staff member must never erase the record of who
-- took $360 in cash. If someone leaves, deactivate them (users.active = false);
-- the directory hides them, their history stays.
ALTER TABLE registrations
  ADD COLUMN IF NOT EXISTS served_by_user_id integer REFERENCES users(id) ON DELETE RESTRICT;

-- When the money actually changed hands. Distinct from registered_at: a row
-- entered on Monday can record cash taken on Saturday, and a till reconciliation
-- needs the payment's clock, not the data-entry clock.
--
-- timestamptz, NOT a bare timestamp. registered_at is naive and stores UTC, so
-- reading it back through a JS Date interprets it as NZ local and lands 12
-- hours out — the same trap that once printed "18 July" on an invoice due the
-- 17th. A new column gets the unambiguous type; policy_accepted_at already does.
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS paid_at timestamptz;

-- Idempotent corrective for any environment where this migration ran an earlier
-- version that created paid_at as a bare timestamp. The stored naive values are
-- UTC, so that is what we tell Postgres they are.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'registrations' AND column_name = 'paid_at'
      AND data_type = 'timestamp without time zone'
  ) THEN
    ALTER TABLE registrations
      ALTER COLUMN paid_at TYPE timestamptz USING paid_at AT TIME ZONE 'UTC';
  END IF;
END $$;

-- Partial: only office rows carry these, so the indexes stay tiny.
CREATE INDEX IF NOT EXISTS registrations_served_by_idx
  ON registrations (served_by_user_id) WHERE served_by_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS registrations_payment_method_idx
  ON registrations (payment_method) WHERE payment_method IS NOT NULL;

-- NO CHECK constraint on payment_method, deliberately. A stale CHECK on an
-- enum-ish column is exactly how the MFL checkout started 500ing. The allowed
-- values live in shared/payments.ts and are enforced in app code, where adding
-- one is a deploy rather than a migration.
