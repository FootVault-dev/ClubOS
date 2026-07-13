-- ─────────────────────────────────────────────────────────────────────────────
-- Print Quotes — indicative quotes submitted from the unitedprints.co.nz
-- "Instant Quote" page, awaiting Dima's Approve/Reject before they become a
-- real print_orders row in the existing production pipeline.
--
-- A quote is deliberately NOT a print_orders row from the moment it lands —
-- the customer's self-served total is indicative only, and nothing should
-- enter the Orders/production board until a human has looked at it. Approve
-- materialises it into print_orders (+ items + a 'created' event); Reject
-- just closes it out. `promoted_order_id` links a quote to the order it
-- became, once approved.
--
-- ADDITIVE ONLY — safe on the live DB. CREATE TABLE / CREATE INDEX IF NOT
-- EXISTS only, no drops, no enums (statuses are validated in the app to dodge
-- prod enum-drift, matching the hiring/vehicles/housing convention). Run
-- BEFORE the Fly deploy.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS print_quotes (
  id                  integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id     integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- Random 48-hex token, for a future customer-facing quote view. Not used
  -- for admin auth (that's the session + tab), only for a possible public link.
  token               text NOT NULL,

  status              text NOT NULL DEFAULT 'new',  -- new | approved | rejected

  customer_name       text,
  customer_email      text,
  customer_phone      text,

  source              text,        -- e.g. "United Prints — Instant Quote"
  source_url          text,        -- e.g. "unitedprints.co.nz/instant-quote"

  subtotal_cents      integer NOT NULL DEFAULT 0,
  gst_cents           integer NOT NULL DEFAULT 0,
  total_cents         integer NOT NULL DEFAULT 0,

  -- Always true today — the website only ever sends indicative self-serve
  -- totals, never a confirmed price. Kept as a column (not hardcoded) so a
  -- future "confirmed quote" flow doesn't need a schema change.
  indicative          boolean NOT NULL DEFAULT true,

  note                text,

  reviewed_by         integer REFERENCES users(id) ON DELETE SET NULL,
  decided_at          timestamptz,
  rejected_reason     text,
  promoted_order_id   integer REFERENCES print_orders(id) ON DELETE SET NULL,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS print_quotes_org_idx ON print_quotes (organization_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS print_quotes_token_unq ON print_quotes (token);

CREATE TABLE IF NOT EXISTS print_quote_items (
  id                  integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  quote_id            integer NOT NULL REFERENCES print_quotes(id) ON DELETE CASCADE,

  design_name         text,
  material            text,
  size_label          text,
  area_m2             numeric,
  quantity            integer NOT NULL DEFAULT 1,
  line_ex_gst_cents   integer NOT NULL DEFAULT 0,
  design_file_name    text,

  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS print_quote_items_quote_idx ON print_quote_items (quote_id);

COMMIT;
