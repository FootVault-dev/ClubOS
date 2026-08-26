-- ─────────────────────────────────────────────────────────────────────────────
-- CODING BUDGET — the club's chart of accounts, and the transactions mapped
-- against it.
--
-- Run BEFORE the deploy:
--   npx tsx --env-file=.env script/apply-coding-budget.ts --commit
--
-- ADDITIVE. Two new tables. Nothing existing is touched, and in particular the
-- July `acct_*` tables on loop/budget-automation are NOT reused: that work
-- modelled the older 805-row workbook whose "income + 30 = expense" mirror rule
-- this structure has abandoned (income now runs 01–20, expenses 21–30). Reusing
-- it would carry a superseded rule forward silently.
--
-- 🔴 NO BEGIN/COMMIT in this file. Fourteen migrations in this repo carry their
-- own, which ends the wrapper's transaction early and makes `--dry-run` a lie —
-- the inner COMMIT lands and the outer ROLLBACK then runs in autocommit against
-- nothing. The apply script owns the transaction.
--
-- Deliberately NO CHECK constraints on `kind`, `treatment`, `gst_treatment`,
-- `source` or `status`: every one of those vocabularies will grow, and a stale
-- CHECK is how the MFL checkout 500'd on registration_items_product_type_check.
-- They are validated in shared/coding-budget.ts.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS coding_accounts (
  id                integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  organization_id   integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- The full sub-code as Victor writes it: "01", "01-02", "01-02-03-04".
  code              text NOT NULL,
  -- The tree edge. RESTRICT, not CASCADE: deleting a parent must never silently
  -- take 600 descendant codes — and every transaction coded to them — with it.
  parent_id         integer REFERENCES coding_accounts(id) ON DELETE RESTRICT,
  -- The stream this belongs to ("01"). Denormalised because every report starts
  -- by grouping on it, and it is immutable for the life of the row.
  top_code          text NOT NULL,
  depth             integer NOT NULL,

  name              text NOT NULL,
  kind              text NOT NULL,        -- 'income' | 'expense'
  treatment         text NOT NULL,        -- 'entry' | 'coding' | 'subtotal' | 'reserved'

  -- 🔴 NULL is NOT zero. Most lines roll up from their children and carry no
  -- figure at all; a handful carry an explicit 0, which is a real statement
  -- ("we budget nothing here"). No DEFAULT, deliberately.
  budget_excl_cents integer,
  budget_incl_cents integer,

  -- What the workbook SUGGESTS. Victor's to confirm, and kept apart from what
  -- he actually configures, below — a suggestion that quietly becomes the
  -- record of fact is how a draft turns into an accounting decision nobody made.
  xero_account      text,
  xero_tracking     text,
  -- What is ACTUALLY set up in Xero. NULL until Victor maps it.
  xero_account_code text,

  -- 🔴 NULL = undecided, and stays that way until a human says otherwise. The
  -- workbook mixes 15%, zero-rated and out-of-scope lines; donations carry no
  -- GST and FIFA prize money is an overseas supply. There is no safe default,
  -- and defaulting to 15% would assert a tax position nobody chose.
  gst_treatment     text,

  note              text,
  active            boolean NOT NULL DEFAULT true,

  -- 🔴 The invariant that makes double-counting structurally impossible. A
  -- control row totals the codes beneath it; if a transaction can also be coded
  -- TO it, the money is counted twice — which is exactly what Victor's Issues
  -- sheet warns about for field hire. Generated from `treatment` so it can
  -- never fall out of step with it, and referenced by the composite foreign key
  -- on coding_transactions below.
  postable          boolean NOT NULL GENERATED ALWAYS AS
                      (treatment IN ('entry', 'coding')) STORED,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT coding_accounts_depth_sane CHECK (depth BETWEEN 1 AND 8)
);

-- One code, one meaning, per organisation.
CREATE UNIQUE INDEX IF NOT EXISTS coding_accounts_org_code_unq
  ON coding_accounts (organization_id, code);

-- The target of the composite FK below. Redundant on its own; load-bearing as
-- a reference target, because a plain FK to `id` cannot express "and it must be
-- postable".
CREATE UNIQUE INDEX IF NOT EXISTS coding_accounts_id_postable_unq
  ON coding_accounts (id, postable);

CREATE INDEX IF NOT EXISTS coding_accounts_org_top_idx   ON coding_accounts (organization_id, top_code);
CREATE INDEX IF NOT EXISTS coding_accounts_parent_idx    ON coding_accounts (parent_id);
CREATE INDEX IF NOT EXISTS coding_accounts_org_kind_idx  ON coding_accounts (organization_id, kind);


CREATE TABLE IF NOT EXISTS coding_transactions (
  id                integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  organization_id   integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  coding_account_id integer NOT NULL,
  -- Always true. Carried only so the composite foreign key can insist on it:
  -- Postgres has no other way to say "this must point at a postable account",
  -- and the CHECK below pins the column to true so nothing can smuggle a false.
  account_postable  boolean NOT NULL DEFAULT true,

  occurred_on       date NOT NULL,

  -- The Xero contact, and the human the line is really about — a participant,
  -- a player, a supplier. Free text: this table records what the paperwork
  -- says, and forcing it through contacts would block entry when a supplier
  -- has no ClubOS record.
  xero_contact      text,
  party             text,
  reference         text,               -- invoice / bill number
  description       text,

  -- 🔴 Money: two facts stored, the third DERIVED. The workbook this replaces
  -- keeps all three by hand and states four different totals for one term. A
  -- generated column cannot disagree with its own inputs.
  amount_excl_cents integer NOT NULL,
  gst_cents         integer NOT NULL DEFAULT 0,
  amount_incl_cents integer NOT NULL GENERATED ALWAYS AS
                      (amount_excl_cents + gst_cents) STORED,

  status            text NOT NULL DEFAULT 'draft',
  source            text NOT NULL DEFAULT 'manual',
  -- The id in whatever system this came from — a Xero invoice id, a ClubOS
  -- registration. Drives the idempotency index below.
  external_id       text,

  notes             text,
  created_by        integer REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  -- Pins the FK's second column. Without it a row could carry postable=false
  -- and satisfy the foreign key by pointing at a non-postable account.
  CONSTRAINT coding_transactions_postable_true CHECK (account_postable),

  -- 🔴 The rule the whole table exists to keep: money can only be coded to a
  -- line that is allowed to receive it. Enforced by the database, not by a
  -- dropdown that happens to hide the other options.
  CONSTRAINT coding_transactions_account_fk
    FOREIGN KEY (coding_account_id, account_postable)
    REFERENCES coding_accounts (id, postable)
    ON DELETE RESTRICT
);

-- 🔴 Idempotent import. Re-running an importer, or a webhook arriving twice, is
-- a retry — not a second transaction. Only where an external id exists, because
-- hand-entered lines legitimately have none and two identical cash purchases on
-- the same day are two real transactions.
CREATE UNIQUE INDEX IF NOT EXISTS coding_transactions_external_unq
  ON coding_transactions (organization_id, source, external_id)
  WHERE external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS coding_transactions_account_idx ON coding_transactions (coding_account_id, occurred_on);
CREATE INDEX IF NOT EXISTS coding_transactions_org_date_idx ON coding_transactions (organization_id, occurred_on);
CREATE INDEX IF NOT EXISTS coding_transactions_status_idx   ON coding_transactions (organization_id, status);

-- New tables default to RLS OFF, and a Supabase anon key is public by design.
-- Our own connections are service-role (rolbypassrls), so this changes nothing
-- for the app and everything for a leaked key.
ALTER TABLE coding_accounts     ENABLE ROW LEVEL SECURITY;
ALTER TABLE coding_transactions ENABLE ROW LEVEL SECURITY;
