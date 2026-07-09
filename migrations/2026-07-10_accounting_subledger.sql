-- ─────────────────────────────────────────────────────────────────────────────
-- Accounting sub-ledger — Phase 1 (shadow ledger, no Xero writes).
--
-- Run on Supabase prod BEFORE the Fly deploy. DO NOT db:push.
--
-- Background: outputs/budget-automation/00-verified-findings.md (what is true) and
-- outputs/budget-automation/02-architecture.md (why this shape). ClubOS is the
-- sub-ledger (full 805-code granularity, who bought what); Xero stays a lean
-- general ledger. Phase 1 never calls the Xero API — these tables let ClubOS
-- record what it WOULD post, and reconcile it against Stripe, before anyone
-- trusts the numbers.
--
-- Design notes:
--   • `acct_codes` mirrors shared/accounting-codes.ts's `AcctCodeNode` 1:1 (see
--     that file's field-by-field comments) plus `active_from`/`active_to`,
--     carried from 02-architecture.md's column sketch for future code
--     versioning — nothing in Phase 1 writes them yet, they stay NULL.
--     `code` is the natural key (`"01-02-01-T1-[PlayerName]"`), unique but not
--     the PK, so every table keeps the repo's `id identity` convention while
--     FKs elsewhere point at the human-readable code, not a surrogate id.
--   • `acct_mapping_rules` mirrors `AcctMappingRule` in shared/accounting.ts
--     exactly, including `program_type` — NOT the same thing as the
--     `program_type` Postgres enum on `programs.type`. This column is free
--     TEXT because resolve()'s programme-type tier must also match the
--     Stripe-metadata-only `"class"` pseudo-type ClubOS branches on
--     (00-verified-findings.md §5 — `programs.type` has no `"class"` value),
--     which a Postgres enum could never hold without a migration of its own.
--   • `acct_postings` is append-only — see the guardrail below. No CHECK
--     constraint enforces `gross_cents = fee_cents + net_cents`; per this
--     repo's convention (see 2026-07-04_usg_studio_foundation.sql and every
--     migration since — no CHECK/enum on values validated in app) that
--     invariant is proven by a test (T6's fuzzed assertion), not the schema.
--     The one constraint that MUST be a DB guarantee, not application logic,
--     is `idempotency_key` UNIQUE — a replayed Stripe webhook must be
--     mechanically incapable of double-posting, not just politely asked not to.
--   • Never UPDATE a posting. `reversed_by_id` is how a correction is made
--     auditable: a new reversing posting points back at the one it corrects.
--   • All money columns are `bigint` (cents). No floats anywhere near money.
--
-- ADDITIVE ONLY — safe on the live Supabase DB. No enums / no CHECK constraints
-- on the free-text status/type columns (validated in app), matching this
-- repo's established convention.
-- ─────────────────────────────────────────────────────────────────────────────

-- Slava's 01–44 tree, as data. Seeded (not applied by this file) by
-- script/seed-accounting.ts (T10) from shared/accounting-codes.ts.
CREATE TABLE IF NOT EXISTS acct_codes (
  id                   integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code                 text NOT NULL UNIQUE,        -- "01-02-01-T1-[PlayerName]"
  level                integer NOT NULL,            -- 1-5
  type                 text NOT NULL,                -- income | expense
  parent_code          text REFERENCES acct_codes(code),
  root_code            text NOT NULL,                -- the level-1 ancestor, e.g. "01"
  parent_category      text NOT NULL,
  name                 text NOT NULL,
  period               text,                         -- "T1".."T4" or null
  invoice_to           text,
  invoice_description  text,
  basis                text,
  owner                text,
  status               text NOT NULL,                -- verbatim from the workbook, e.g. "To Confirm"
  notes                text,
  is_invoice_stage     boolean NOT NULL DEFAULT false,
  is_template          boolean NOT NULL DEFAULT false,
  -- original_note | expanded_from_original_note | suggested_placeholder — verbatim
  -- from the workbook's own `Source Basis` column. NEVER re-labelled. A
  -- `suggested_placeholder` code is a proposal, not an approved account.
  provenance           text NOT NULL,
  -- Reserved for future code-tree versioning (02-architecture.md). Unused,
  -- always NULL, in Phase 1 — the tree is seeded once and not yet revised.
  active_from          date,
  active_to            date,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS acct_codes_parent_idx ON acct_codes (parent_code);
CREATE INDEX IF NOT EXISTS acct_codes_root_idx   ON acct_codes (root_code);

-- (what was sold) -> (how it's coded). Effective-dated; resolve() in
-- shared/accounting.ts reads these as of the transaction's occurred_at, never
-- "now" — a rule Victor adds in January must never re-code last July.
CREATE TABLE IF NOT EXISTS acct_mapping_rules (
  id                  integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id     integer NOT NULL REFERENCES organizations(id),
  -- All three of program_id / program_option_id / program_type are NULLABLE —
  -- resolve()'s 4-tier specificity (option -> programme -> programme type ->
  -- org default) is which of these three is non-null. Exactly one is, by
  -- construction; that is an application invariant (script/seed-accounting.ts,
  -- shared/accounting.ts), not a DB constraint, matching this repo's
  -- validate-in-app convention.
  program_id          integer REFERENCES programs(id),
  program_option_id   integer REFERENCES program_options(id),
  program_type        text,
  payment_method      text,                          -- null = matches any
  effective_from       date NOT NULL,                 -- inclusive
  effective_to          date,                          -- exclusive end, null = still open
  code                text NOT NULL REFERENCES acct_codes(code),
  xero_account_code   text,                          -- null until Victor supplies real codes
  tracking_1          text,
  tracking_2          text,
  tax_type            text,
  version             integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS acct_mapping_rules_org_idx
  ON acct_mapping_rules (organization_id, effective_from);
CREATE INDEX IF NOT EXISTS acct_mapping_rules_program_idx
  ON acct_mapping_rules (program_id);
CREATE INDEX IF NOT EXISTS acct_mapping_rules_option_idx
  ON acct_mapping_rules (program_option_id);

-- Append-only. NEVER UPDATE a row here — a correction is a new reversing
-- posting whose reversed_by_id (on the ORIGINAL row) points at it.
CREATE TABLE IF NOT EXISTS acct_postings (
  id                    integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id       integer NOT NULL REFERENCES organizations(id),
  -- registration | print | booking | member | shop. Polymorphic on purpose —
  -- source_id has no FK because it points at different tables depending on
  -- source_type (shop_orders doesn't exist on this branch yet; see PLAN.md T5).
  source_type           text NOT NULL,
  source_id             integer NOT NULL,
  -- The double-post guard. A DB constraint, not application logic: a replayed
  -- Stripe webhook must be mechanically incapable of writing a second row.
  idempotency_key       text NOT NULL UNIQUE,
  posted_at             timestamptz NOT NULL DEFAULT now(),  -- when ClubOS wrote this row
  occurred_at           date NOT NULL,                        -- the transaction's NZ business date;
                                                                -- callers MUST derive this via
                                                                -- nzTodayIso() (shared/academy.ts) or
                                                                -- the payment's own dated field —
                                                                -- never new Date().toISOString()
  code                  text NOT NULL REFERENCES acct_codes(code),
  xero_account_code     text,
  tracking_1            text,
  tracking_2            text,
  tax_type              text,
  gross_cents           bigint NOT NULL,
  fee_cents             bigint NOT NULL DEFAULT 0,
  net_cents             bigint NOT NULL,
  tax_cents             bigint,               -- null = not yet determined (GST treatment unresolved,
                                               -- see 00-verified-findings.md §7 question 3) — never 0
                                               -- as a stand-in for "unknown"
  currency              text NOT NULL DEFAULT 'NZD',
  -- Pins the acct_mapping_rules.version that coded this posting, so a later
  -- rule change never silently re-codes history.
  mapping_rule_version  integer NOT NULL,
  reversed_by_id         integer REFERENCES acct_postings(id)
);

CREATE INDEX IF NOT EXISTS acct_postings_source_idx
  ON acct_postings (source_type, source_id);
CREATE INDEX IF NOT EXISTS acct_postings_org_occurred_idx
  ON acct_postings (organization_id, occurred_at);
CREATE INDEX IF NOT EXISTS acct_postings_code_idx
  ON acct_postings (code);

-- Term revenue recognition. A fee taken on 19 July for a term ending 24
-- September is not July's income — this spreads it, one row per calendar
-- month, released pro-rata from the join date (T8).
CREATE TABLE IF NOT EXISTS acct_deferred_schedule (
  id             integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  posting_id     integer NOT NULL REFERENCES acct_postings(id) ON DELETE CASCADE,
  period         text NOT NULL,          -- "2026-08" (calendar year-month, not a date)
  amount_cents   bigint NOT NULL,
  -- Set once the reconciliation/recognition job has released this period's
  -- revenue. NULL = still deferred, not yet recognised.
  recognised_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS acct_deferred_schedule_posting_idx
  ON acct_deferred_schedule (posting_id);
CREATE INDEX IF NOT EXISTS acct_deferred_schedule_period_idx
  ON acct_deferred_schedule (period);

-- Per-posting Xero state. Entirely unused until Phase 3 (draft-then-approve
-- invoice push) — Phase 1 never calls the Xero API, so every row this phase
-- could ever produce is hypothetical. Table exists now so T9's coverage
-- report and later phases don't need another migration to add it.
CREATE TABLE IF NOT EXISTS acct_xero_sync (
  id             integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  posting_id     integer NOT NULL UNIQUE REFERENCES acct_postings(id) ON DELETE CASCADE,
  xero_invoice_id text,
  status         text NOT NULL DEFAULT 'pending',  -- pending | draft | approved | failed
  last_error     text,
  synced_at      timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Drift detection audit. The nightly job (T7) compares ClubOS postings
-- against Stripe (and later Xero) and writes one row per comparison run.
-- Reports drift. Never silently corrects it.
CREATE TABLE IF NOT EXISTS acct_reconciliation_runs (
  id              integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ran_at          timestamptz NOT NULL DEFAULT now(),
  source          text NOT NULL,          -- e.g. "stripe", "xero"
  expected_cents  bigint NOT NULL,
  actual_cents    bigint NOT NULL,
  drift_cents     bigint NOT NULL,
  details         jsonb                   -- offending ids etc., shape owned by T7
);

CREATE INDEX IF NOT EXISTS acct_reconciliation_runs_ran_at_idx
  ON acct_reconciliation_runs (ran_at);
