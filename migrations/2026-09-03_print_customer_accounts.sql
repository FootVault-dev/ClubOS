-- ─────────────────────────────────────────────────────────────────────────────
-- UNITED PRINTS — CUSTOMER ACCOUNTS
--
-- Run BEFORE the deploy:
--   npx tsx --env-file=.env script/apply-print-customer-accounts.ts --commit
--
-- ADDITIVE. Four new tables. Nothing existing is touched — in particular
-- print_orders gains NO column.
--
-- A customer signs in at join.unitedprints.co.nz/account and sees their own
-- orders, their own quotes, and — once Dima approves them — their own prices.
--
-- ── Why the orders are found by EMAIL and not by a foreign key ───────────────
--
-- print_orders.customer_email already holds who an order belongs to, on rows
-- going back to the shop's first job. A customer_id column would be NULL on
-- every one of them, so the portal would open empty for exactly the customers
-- with the longest history, and a backfill would have to GUESS which of two
-- similar rows is the same human.
--
-- So the session carries a VERIFIED email and the order list is re-resolved on
-- every request, which is the parent-accounts doctrine (server/parent-routes.ts,
-- rule 2) applied to a second population: a merge, a corrected address or a new
-- order shows up immediately, with no backfill and no second source of truth
-- about who owns what.
--
-- ── The CHECKs that are here, and the ones deliberately absent ───────────────
--
-- `tier` has NO CHECK. That value set will grow (trade, club, wholesale,
-- reseller) and a stale CHECK is how the MFL checkout 500'd on
-- registration_items_product_type_check. It is validated in shared/print-account.ts.
--
-- The CHECKs that ARE here encode things that can never need to grow:
--
--   * a discount below 0 is a surcharge, and above 100 is the shop paying the
--     customer to take the sign away;
--   * 🔴 A DISCOUNT ABOVE ZERO MUST CARRY A NAMED APPROVER. This is the whole
--     commercial control. Daniel's decision (2026-09-03) is that signing up
--     gets you an account, and Dima decides who gets trade pricing — so "money
--     off" and "a human who approved it" are one fact, and the database refuses
--     to hold half of it. Without this, any code path that creates a customer
--     could set a discount, and nobody could say afterwards who agreed to it.
--   * a login code cannot be recorded as consumed before it was created.
--
-- approved_by_user_id is ON DELETE RESTRICT for the same reason
-- served_by_user_id is on a registration: deleting a staff member must never
-- erase who authorised a price.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── The account ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS print_customers (
  id                   integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,

  -- Stored lowercase. The unique index below is on lower(email) as well, so a
  -- customer who types Dima@Example.com cannot create a second account.
  email                text NOT NULL,
  name                 text,
  phone                text,
  company              text,

  -- 'standard' | 'trade' | … — see shared/print-account.ts. No CHECK, on purpose.
  tier                 text NOT NULL DEFAULT 'standard',

  -- Whole percent off the public rate. 0 means "public pricing", which is what
  -- every account starts on and what they all sit on until Dima types a real
  -- number. There is deliberately no non-zero default anywhere in this file.
  discount_pct         integer NOT NULL DEFAULT 0,

  approved_by_user_id  integer REFERENCES users(id) ON DELETE RESTRICT,
  approved_at          timestamptz,
  approval_note        text,

  -- Access is withdrawn by disabling, never by deleting: the orders and the
  -- money are still the shop's records.
  disabled_at          timestamptz,

  last_login_at        timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT print_customers_discount_range
    CHECK (discount_pct >= 0 AND discount_pct <= 100),

  -- 🔴 Money off requires a named human who said yes.
  CONSTRAINT print_customers_discount_needs_approver
    CHECK (discount_pct = 0 OR (approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS print_customers_email_lower_key
  ON print_customers (lower(email));

-- ── Sign-in codes ───────────────────────────────────────────────────────────
-- Rows are keyed by EMAIL, not by customer, because requesting a code is also
-- how an account is created: the first person to prove they own an address
-- gets the account for it.
--
-- 🔴 The code itself is never stored. A dump of this table cannot sign anyone in.
CREATE TABLE IF NOT EXISTS print_customer_codes (
  id           integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  email        text NOT NULL,
  code_hash    text NOT NULL,
  expires_at   timestamptz NOT NULL,
  attempts     integer NOT NULL DEFAULT 0,
  consumed_at  timestamptz,
  request_ip   text,
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT print_customer_codes_consumed_after_created
    CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);

CREATE INDEX IF NOT EXISTS print_customer_codes_email_idx
  ON print_customer_codes (lower(email), created_at DESC);

-- ── Sessions ────────────────────────────────────────────────────────────────
-- 🔴 Server-side and revocable, not a self-contained signed token. "Sign out
-- everywhere", and Dima disabling an account, both have to bite NOW rather than
-- whenever a token happens to expire — and a stateless token cannot do that.
-- Only the hash is stored, so this table is not a set of working credentials.
CREATE TABLE IF NOT EXISTS print_customer_sessions (
  id           integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  customer_id  integer NOT NULL REFERENCES print_customers(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  ip           text,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS print_customer_sessions_customer_idx
  ON print_customer_sessions (customer_id, created_at DESC);

-- ── Audit ───────────────────────────────────────────────────────────────────
-- A row for every attempt, successful or not. Append-only by convention.
-- customer_id is nullable because most failures are for an address that has no
-- account — which is itself the thing worth being able to see.
CREATE TABLE IF NOT EXISTS print_customer_auth_events (
  id           integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  email        text,
  customer_id  integer REFERENCES print_customers(id) ON DELETE SET NULL,
  event        text NOT NULL,
  detail       text,
  ip           text,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS print_customer_auth_events_email_idx
  ON print_customer_auth_events (lower(email), created_at DESC);

-- ── updated_at ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION print_customers_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS print_customers_touch_updated_at ON print_customers;
CREATE TRIGGER print_customers_touch_updated_at
  BEFORE UPDATE ON print_customers
  FOR EACH ROW EXECUTE FUNCTION print_customers_touch();

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- 🔴 New tables default to RLS OFF, and the Supabase anon key is public by
-- design — it ships in a browser bundle. Off + public key has meant "the world
-- can read this table" twice in this workspace already. These four hold
-- customers' email addresses, phone numbers, what discount each was given, and
-- session material. RLS on, no policies: our own server connects as
-- service-role and bypasses it; a leaked anon key reaches nothing.
ALTER TABLE print_customers            ENABLE ROW LEVEL SECURITY;
ALTER TABLE print_customer_codes       ENABLE ROW LEVEL SECURITY;
ALTER TABLE print_customer_sessions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE print_customer_auth_events ENABLE ROW LEVEL SECURITY;
