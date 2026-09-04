-- Team Pay — how a team pays: the manager settles it, or the squad splits it.
--
-- Daniel, 2026-09-04: "allow people after register interest to be able to pay
-- and have option for player pay too."
--
-- Team Pay shipped split-only: every charge was ceil(fee / squadSize) against
-- one player's invite token, and there was no path for a manager to simply pay
-- the $800. That is the commonest case for a team that already has the money —
-- one person fronts it and collects from their mates however they like — and it
-- had no route through the product at all.
--
-- 🔴 The mode decides WHO IS ASKED, never what is owed. The fee is the fee. A
-- team owes fee_cents whichever way it pays, so both paths settle against ONE
-- balance and neither can collect past it. That is why the team payment lives
-- on the entry rather than being modelled as the manager's player row paying a
-- giant share: a share is fee ÷ squad by definition, and a row claiming to have
-- paid sixteen shares would make every derived figure on the manager's
-- dashboard read wrong.
--
-- Additive and idempotent. No existing column is altered, and split entries
-- created before today keep working untouched.

-- 🔴 No BEGIN/COMMIT here on purpose: the apply script owns the transaction, and
-- a COMMIT inside the file ends it early so --dry-run would roll back nothing.

-- ── how this team pays ───────────────────────────────────────────────────────
--
-- 'split' — every player pays their own share.   (the existing behaviour)
-- 'whole' — the manager pays the team fee.       (new)
--
-- Deliberately NO CHECK constraint. This is an enum-ish column and a stale
-- CHECK is how the MFL checkout once 500'd; the vocabulary is validated in app
-- code, in one place (PAYMENT_MODES in shared/teampay.ts).
--
-- Defaulting to 'split' is what makes this migration safe to run against live
-- rows: an entry that existed a minute ago is still a split entry.
ALTER TABLE teampay_entries
  ADD COLUMN IF NOT EXISTS payment_mode text NOT NULL DEFAULT 'split';

-- ── what the manager has paid on behalf of the team ──────────────────────────
--
-- 🔴 Nothing here stores a TOTAL. team_paid_cents is what this entry's own
-- team-level charge collected — a fact read back off a Stripe PaymentIntent —
-- and the team's position is still recomputed on read as
--   fee − (sum of player payments) − team_paid_cents.
-- The Accommodation import found a workbook stating four different figures for
-- one term; a stored total is exactly how that happens.
ALTER TABLE teampay_entries
  ADD COLUMN IF NOT EXISTS team_paid_cents               integer;
ALTER TABLE teampay_entries
  ADD COLUMN IF NOT EXISTS team_paid_at                  timestamp;
ALTER TABLE teampay_entries
  ADD COLUMN IF NOT EXISTS team_stripe_payment_intent_id text;
ALTER TABLE teampay_entries
  ADD COLUMN IF NOT EXISTS team_stripe_customer_id       text;

-- 🔴 Paid always carries an amount. Same rule the players table already
-- enforces, and for the same reason: "Paid — $0.00" on a manager's dashboard is
-- worse than no row at all, because somebody acts on it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'teampay_entries_team_paid_pair'
  ) THEN
    ALTER TABLE teampay_entries
      ADD CONSTRAINT teampay_entries_team_paid_pair
      CHECK ((team_paid_at IS NULL) = (team_paid_cents IS NULL));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'teampay_entries_team_paid_sane'
  ) THEN
    ALTER TABLE teampay_entries
      ADD CONSTRAINT teampay_entries_team_paid_sane
      CHECK (team_paid_cents IS NULL OR team_paid_cents >= 0);
  END IF;
END $$;

-- 🔴 A team payment can never exceed the fee this entry was quoted.
--
-- The amount is computed server-side from the outstanding balance and the
-- browser never sends one, so this constraint should be unreachable. It is here
-- because "should be unreachable" is what everyone says about the path that
-- later turns out to double-charge: a retried confirm, two managers on the link
-- at once, a Stripe amount read back from the wrong intent. The database is the
-- only place that can refuse it after the money has already moved in Stripe —
-- which is precisely when a human needs to be told, loudly, rather than the row
-- quietly recording an over-collection.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'teampay_entries_team_paid_not_over_fee'
  ) THEN
    ALTER TABLE teampay_entries
      ADD CONSTRAINT teampay_entries_team_paid_not_over_fee
      CHECK (team_paid_cents IS NULL OR team_paid_cents <= fee_cents);
  END IF;
END $$;

-- One team-level intent per entry, so a confirm can never be attributed to
-- another team's payment.
CREATE UNIQUE INDEX IF NOT EXISTS teampay_entries_team_intent_unique
  ON teampay_entries (team_stripe_payment_intent_id)
  WHERE team_stripe_payment_intent_id IS NOT NULL;


-- ── the squad-size freeze has to know about team payments too ────────────────
--
-- 🔴 The existing trigger froze squad size once a PLAYER had paid. In whole
-- mode no player ever pays, so without this the manager could pay $800 and then
-- resize the squad — which is harmless for the money (the fee is frozen on the
-- entry) but silently re-prices every player's share afterwards if they later
-- switch back to split. Money having landed is money having landed, from
-- whichever direction.
CREATE OR REPLACE FUNCTION teampay_freeze_squad_size() RETURNS trigger AS $$
BEGIN
  IF NEW.squad_size IS DISTINCT FROM OLD.squad_size
     AND (
       EXISTS (SELECT 1 FROM teampay_players WHERE entry_id = OLD.id AND paid_at IS NOT NULL)
       OR OLD.team_paid_at IS NOT NULL
     )
  THEN
    RAISE EXCEPTION 'teampay: squad size is fixed once money has been paid (entry %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS teampay_entries_freeze_squad_size ON teampay_entries;
CREATE TRIGGER teampay_entries_freeze_squad_size
  BEFORE UPDATE ON teampay_entries
  FOR EACH ROW EXECUTE FUNCTION teampay_freeze_squad_size();


-- ── the bridge: a registration of interest becomes a real entry ──────────────
--
-- Phase 1 of the Ethnic Cup module put the ethniccup.com form into ClubOS, and
-- gave a registration the status 'entered' — but that was a word a staff member
-- typed, with nothing behind it. This makes it a fact: the row points at the
-- team entry it became.
--
-- ON DELETE SET NULL, not RESTRICT. An entry in this system is withdrawn, not
-- deleted; if one genuinely is deleted the registration should stop claiming to
-- be entered rather than block the delete.
ALTER TABLE ethnic_cup_registrations
  ADD COLUMN IF NOT EXISTS teampay_entry_id integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ethnic_cup_registrations_teampay_entry_id_fkey'
  ) THEN
    ALTER TABLE ethnic_cup_registrations
      ADD CONSTRAINT ethnic_cup_registrations_teampay_entry_id_fkey
      FOREIGN KEY (teampay_entry_id) REFERENCES teampay_entries(id) ON DELETE SET NULL;
  END IF;
END $$;

-- 🔴 One registration per entry, and one entry per registration. Without this,
-- a staff member double-clicking "Create entry" gives one community two teams
-- in the draw, each holding half a squad — and the second one is invisible on
-- the registration it came from.
CREATE UNIQUE INDEX IF NOT EXISTS ethnic_cup_registrations_entry_unique
  ON ethnic_cup_registrations (teampay_entry_id)
  WHERE teampay_entry_id IS NOT NULL;
