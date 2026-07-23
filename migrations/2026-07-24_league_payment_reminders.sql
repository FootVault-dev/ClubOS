-- MFL missed-payment visibility + payment reminders (2026-07-24)
--
-- 1. registrations.weekly_first_charge_date — the REAL anchor of a
--    Play Now, Pay Later weekly schedule (the Stripe subscription's
--    trial_end). Persisted at creation from now on; backfilled once from
--    Stripe for existing weekly registrations
--    (script/backfill-weekly-anchor.ts). Without it, missed-payment maths
--    anchored on the competition start wrongly flags teams that registered
--    after the term began (their first charge is signup + 2 days).
--
-- 2. league_payment_reminders — one row per reminder email actually sent to
--    a captain who is behind (weekly charges missed, or an instalment
--    balance that failed). The token tags the pay link + tracking pixel and
--    is non-enumerable (24 random bytes, base64url).
--
-- 3. league_payment_reminder_events — opens, DERIVED into analytics at read
--    time (never stored counters): 'email_open' from the pixel
--    (proxy-inflated — approximate by nature) and 'page_open' from the pay
--    page (bot-filtered — the honest signal). Same doctrine as invoice pages.
--
-- Additive and idempotent. Safe to run before the deploy — everything is
-- inert until the code that reads it ships.

ALTER TABLE registrations
  ADD COLUMN IF NOT EXISTS weekly_first_charge_date date;

COMMENT ON COLUMN registrations.weekly_first_charge_date IS
  'First weekly charge date (Stripe subscription trial_end) for deposit_weekly plans. The anchor for the whole weekly schedule; NULL = derive from max(comp start, signup+2d).';

CREATE TABLE IF NOT EXISTS league_payment_reminders (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  registration_id integer NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  kind text NOT NULL DEFAULT 'weekly_missed',
  sent_to text NOT NULL,
  sent_by_user_id integer,
  sent_by_name text,
  missed_count integer NOT NULL DEFAULT 0,
  missed_cents integer NOT NULL DEFAULT 0,
  payoff_cents integer NOT NULL DEFAULT 0,
  sent_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS league_payment_reminders_reg_idx
  ON league_payment_reminders (registration_id, sent_at);

CREATE TABLE IF NOT EXISTS league_payment_reminder_events (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  reminder_id integer NOT NULL REFERENCES league_payment_reminders(id) ON DELETE CASCADE,
  kind text NOT NULL,
  user_agent text,
  occurred_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS league_payment_reminder_events_rem_idx
  ON league_payment_reminder_events (reminder_id, occurred_at);
