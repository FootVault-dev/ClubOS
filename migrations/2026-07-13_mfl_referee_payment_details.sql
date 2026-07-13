-- MFL referee payment/invoice details — additive, nullable columns on
-- league_referees. MFL referees are paid per game, and the MFL coordinator
-- fills a per-ref invoice fortnightly — this was missing the bank account to
-- pay into, the referee's address, and an optional GST number entirely.
-- ADDITIVE ONLY — safe to run against the live table; refs who signed up
-- before this migration simply have NULLs here (the admin UI says so
-- plainly rather than guessing at payment details). Run on Supabase prod
-- BEFORE the Fly deploy. DO NOT db:push.

ALTER TABLE league_referees ADD COLUMN IF NOT EXISTS bank_account_name text;
ALTER TABLE league_referees ADD COLUMN IF NOT EXISTS bank_account_number text;
ALTER TABLE league_referees ADD COLUMN IF NOT EXISTS bank_name text;
ALTER TABLE league_referees ADD COLUMN IF NOT EXISTS address text;
ALTER TABLE league_referees ADD COLUMN IF NOT EXISTS gst_number text;
