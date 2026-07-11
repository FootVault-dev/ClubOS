-- ─────────────────────────────────────────────────────────────────────────────
-- USG Invoices — tracked, payable invoices owned by the United Sports Group
-- workspace (organization_id 7).
--
-- The public payable page (apps/invoices, e.g. usg-invoices.vercel.app/i/:token)
-- is a SEPARATE Vercel app that calls GET/POST /api/public/invoices/:token* here.
-- ClubOS is the system of record; the page is only the face of one.
--
-- Named usg_* (not bare `invoices`) to dodge this schema's documented naming-
-- collision history (hiring_*, cic7s_*, etc. all exist for the same reason —
-- see migrations/2026-07-10_hiring.sql).
--
-- The token is the public identifier (unguessable — an invoice carries bank
-- details, so it must never be enumerable). `id`/`organization_id` never leave
-- the admin surface.
--
-- Deliberately NO 'overdue' status. Overdue is DERIVED from due_on at read time
-- (due_on < today AND status NOT IN ('paid','void')) — a stored 'overdue' goes
-- stale the moment a scheduled job doesn't run, and would need its own reversal
-- logic if a due date is later pushed out. status is one of: draft | sent |
-- paid | void, validated in the app — no pg enum (this schema has a documented
-- history of prod enum drift; see the orphaned invoice_status_enum this table
-- deliberately does NOT reuse).
--
-- usg_invoice_events is the append-only audit/tracking log behind the admin
-- timeline (created → sent → opened ×N → reminder_sent → paid/voided) — the
-- same shape as the Proposal Tracker's proposal_events.
--
-- ADDITIVE ONLY — safe on the live DB. CREATE TABLE / CREATE INDEX IF NOT
-- EXISTS only, no drops, no enums. Run BEFORE the Fly deploy.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS usg_invoices (
  id                       integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id          integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  token                    text NOT NULL UNIQUE,               -- unguessable public id — invoices carry bank details
  number                   text NOT NULL UNIQUE,                -- e.g. CUFC-2026-002
  status                   text NOT NULL DEFAULT 'draft',       -- draft | sent | paid | void (validated app-side; NO 'overdue' — derived from due_on)

  brand                    text NOT NULL DEFAULT 'siu',         -- which brand face the page wears (siu | cufc)

  recipient_name           text NOT NULL,
  recipient_email          text,
  recipient_address        jsonb,                               -- string[] address lines

  title                    text NOT NULL,
  intro                    text,

  spend_summary            jsonb,                               -- { label, rows:[{label,amountCents}], totalLabel } | null
  lines                    jsonb NOT NULL,                       -- [{ description, detail?, amountCents }]
  notes                    jsonb,                                -- string[] | null

  gst_treatment            text NOT NULL DEFAULT 'inclusive',   -- inclusive | exclusive

  subtotal_cents           integer NOT NULL,
  gst_cents                integer NOT NULL,
  total_cents              integer NOT NULL,

  issued_on                date NOT NULL,
  due_on                   date NOT NULL,
  terms_label              text,

  card_enabled             boolean NOT NULL DEFAULT false,

  is_draft                 boolean NOT NULL DEFAULT true,
  draft_reasons            jsonb,                               -- string[] | null

  bank_account_name        text,
  bank_account_number      text,
  bank_reference            text,
  bank_particulars         text,
  bank_code                text,

  paid_at                  timestamp,
  paid_method               text,                                -- card | bank
  paid_amount_cents        integer,
  stripe_payment_intent_id text,

  created_at               timestamp NOT NULL DEFAULT now(),
  updated_at               timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS usg_invoices_token_unq ON usg_invoices (token);
CREATE INDEX IF NOT EXISTS usg_invoices_org_status_idx ON usg_invoices (organization_id, status);

CREATE TABLE IF NOT EXISTS usg_invoice_events (
  id           integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  invoice_id   integer NOT NULL REFERENCES usg_invoices(id) ON DELETE CASCADE,

  kind         text NOT NULL,                        -- created | sent | opened | reminder_sent | paid | voided
  at           timestamp NOT NULL DEFAULT now(),

  ip_hash      text,                                  -- sha256(ip + salt) — never the raw IP
  user_agent   text,
  referrer     text,
  is_staff     boolean NOT NULL DEFAULT false,        -- our own opens (logged-in ClubOS session) don't pollute the count
  meta         jsonb
);

CREATE INDEX IF NOT EXISTS usg_invoice_events_invoice_at_idx ON usg_invoice_events (invoice_id, at DESC);

COMMIT;
