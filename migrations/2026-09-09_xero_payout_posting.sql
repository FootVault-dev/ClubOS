-- Stripe payout → Xero, pre-split.
--
-- Two tables of DATA and one of record:
--   xero_account_map    what each category posts to in Xero (Victor owns this)
--   xero_payout_rules   how to categorise a charge no ClubOS table can answer
--   xero_payout_posts   what we have actually posted, so a re-run is a retry
--
-- 🔴 No account code, tax type or tracking option appears in application code.
-- Victor changes an account by editing a row; nothing is deployed. This is the
-- same reasoning as United Prints' materials: the person who owns the number
-- edits the number.

CREATE TABLE IF NOT EXISTS xero_account_map (
  id                serial PRIMARY KEY,
  organization_id   integer NOT NULL REFERENCES organizations(id),
  -- Matches XERO_CATEGORIES in shared/xero-payout.ts.
  category          text    NOT NULL,
  -- 🔴 NULL means "nobody has said yet" — NOT a default account. A category with
  -- no mapping blocks its payout from posting rather than guessing a code, the
  -- same rule the Xero push already follows (it throws rather than assume "200").
  xero_account_code text,
  xero_tax_type     text,
  xero_tracking_name   text,
  xero_tracking_option text,
  -- Set when a human has confirmed it, so a seeded guess can never read as agreed.
  confirmed_by      text,
  confirmed_at      timestamp,
  note              text,
  created_at        timestamp NOT NULL DEFAULT now(),
  updated_at        timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS xero_account_map_org_category_unq
  ON xero_account_map (organization_id, category);

-- A charge that no ClubOS table owns: another app billing the same Stripe
-- account (the CIC Content Marketplace, USC AdSpace), or a one-off.
--
-- 🔴 Matching is on the PaymentIntent DESCRIPTION, which this club's own apps
-- write, and it is anchored with a prefix rather than a loose contains, so a
-- customer cannot land in a category by naming their team after one.
CREATE TABLE IF NOT EXISTS xero_payout_rules (
  id              serial PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id),
  match_kind      text    NOT NULL DEFAULT 'description_prefix',
  match_value     text    NOT NULL,
  category        text    NOT NULL,
  label           text,
  active          boolean NOT NULL DEFAULT true,
  created_by      text,
  created_at      timestamp NOT NULL DEFAULT now(),
  CONSTRAINT xero_payout_rules_kind CHECK (match_kind IN ('description_prefix', 'metadata_key')),
  CONSTRAINT xero_payout_rules_value_len CHECK (length(btrim(match_value)) >= 4)
);

CREATE UNIQUE INDEX IF NOT EXISTS xero_payout_rules_unq
  ON xero_payout_rules (organization_id, match_kind, match_value) WHERE active;

-- What we posted. The record of truth for "has this payout been done".
CREATE TABLE IF NOT EXISTS xero_payout_posts (
  id                serial PRIMARY KEY,
  organization_id   integer NOT NULL REFERENCES organizations(id),
  stripe_payout_id  text    NOT NULL,
  stripe_account    text    NOT NULL DEFAULT 'club',
  arrival_date      date    NOT NULL,
  currency          text    NOT NULL,
  payout_cents      integer NOT NULL,
  -- The split exactly as posted, so what Xero received can be re-read here
  -- without calling Stripe again and without recomputing (a later code change
  -- would produce a different split for the same payout).
  split_json        jsonb   NOT NULL,
  xero_bank_txn_id  text,
  posted_at         timestamp,
  posted_by         text,
  status            text    NOT NULL DEFAULT 'pending',
  error             text,
  created_at        timestamp NOT NULL DEFAULT now(),
  updated_at        timestamp NOT NULL DEFAULT now(),
  CONSTRAINT xero_payout_posts_status CHECK (status IN ('pending', 'posted', 'failed', 'skipped')),
  -- 🔴 Posted always carries the Xero document it created. Without this a failed
  -- post that half-succeeded could read as done and the payout would never be
  -- looked at again.
  CONSTRAINT xero_payout_posts_posted_has_doc
    CHECK (status <> 'posted' OR (xero_bank_txn_id IS NOT NULL AND posted_at IS NOT NULL)),
  CONSTRAINT xero_payout_posts_amount CHECK (payout_cents <> 0)
);

-- 🔴 ONE post per payout per Stripe account. This is what makes re-running the
-- poster a retry rather than a second Receive Money in Xero for the same money —
-- the single most damaging mistake this system could make.
CREATE UNIQUE INDEX IF NOT EXISTS xero_payout_posts_payout_unq
  ON xero_payout_posts (stripe_account, stripe_payout_id);

CREATE INDEX IF NOT EXISTS xero_payout_posts_status_idx
  ON xero_payout_posts (organization_id, status, arrival_date DESC);

ALTER TABLE xero_account_map   ENABLE ROW LEVEL SECURITY;
ALTER TABLE xero_payout_rules  ENABLE ROW LEVEL SECURITY;
ALTER TABLE xero_payout_posts  ENABLE ROW LEVEL SECURITY;
