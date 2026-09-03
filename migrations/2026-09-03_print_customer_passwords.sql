-- ─────────────────────────────────────────────────────────────────────────────
-- UNITED PRINTS CUSTOMER ACCOUNTS — email + password
--
-- Run BEFORE the deploy:
--   npx tsx --env-file=.env script/apply-print-customer-passwords.ts --commit
--
-- ADDITIVE. Three nullable columns on print_customers. Nothing is dropped, and
-- the login-code table stays exactly as it is — it stops being the way people
-- sign IN and becomes the way they RESET a forgotten password, which is the
-- same mechanism doing the job it is actually best at.
--
-- Daniel, 2026-09-03: "make this email password standard sign up and login."
--
-- 🔴 password_hash is NULLABLE, and that is deliberate, not laziness. Accounts
-- created during the passwordless window exist and have no password. Making the
-- column NOT NULL would need a default, and a default password hash is a shared
-- credential — the exact thing reference/app-baseline-standard.md §1 exists to
-- stop. Those accounts sign in by setting a password through the reset flow,
-- which proves the same thing signing in used to prove: control of the inbox.
--
-- 🔴 A NULL hash therefore means "no password set", NEVER "any password works".
-- The verifier returns false on a NULL, and the login handler checks for it
-- before comparing — blank is its own state, and here the blank state must fail
-- closed.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE print_customers
  -- scrypt, format `s1$salt$hex` — the one scheme shared with
  -- natural-footballers-web, atarangi-lodge and conscious-agency.
  ADD COLUMN IF NOT EXISTS password_hash    text,
  ADD COLUMN IF NOT EXISTS password_set_at  timestamptz,
  -- Proof the person controls the address. Set when they redeem an emailed
  -- code (a reset, or the welcome verification), never on sign-up alone.
  ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;

-- A password that has never been set cannot carry a "set at" date, and one that
-- has been set must. Cheap to enforce, and it is the pair that tells support
-- whether an old account is a legacy passwordless one or a real lockout.
ALTER TABLE print_customers
  DROP CONSTRAINT IF EXISTS print_customers_password_pair;
ALTER TABLE print_customers
  ADD CONSTRAINT print_customers_password_pair
  CHECK ((password_hash IS NULL AND password_set_at IS NULL)
      OR (password_hash IS NOT NULL AND password_set_at IS NOT NULL));

-- 🔴 A stored hash must be a hash, not a password somebody wrote into the
-- column by hand. This refuses anything that is not the house format outright,
-- so a plaintext password can never sit in this column unnoticed.
ALTER TABLE print_customers
  DROP CONSTRAINT IF EXISTS print_customers_password_format;
ALTER TABLE print_customers
  ADD CONSTRAINT print_customers_password_format
  CHECK (password_hash IS NULL OR password_hash ~ '^s1\$[0-9a-f]{32}\$[0-9a-f]{128}$');

-- The reset codes get a purpose, so a code minted for "reset my password"
-- cannot be redeemed by some other endpoint later. Existing rows are logins.
ALTER TABLE print_customer_codes
  ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'login';

CREATE INDEX IF NOT EXISTS print_customer_codes_purpose_idx
  ON print_customer_codes (lower(email), purpose, created_at DESC);
