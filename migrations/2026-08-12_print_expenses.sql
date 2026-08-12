-- ─────────────────────────────────────────────────────────────────────────────
-- Print expenses — every purchase the print shop makes, with its invoice
--
-- Merchandise, materials, a printer, a service. Today these live in Dima's
-- email; the shop's real cost base can't be answered without them, which is the
-- same gap the budget work found on the revenue side.
--
-- 🔴 GST is RECORDED per expense, never inferred from a rate. NZ is 15%, but a
-- supplier invoice can be GST-inclusive, plus-GST, zero-rated, or from overseas
-- with no GST at all — and an overseas purchase attracts customs GST on a
-- different document entirely. Assuming a rate would quietly manufacture a
-- wrong GST claim, which is the one thing the /reconcile tooling refuses to do.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS print_expenses (
  id                 integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  organization_id    integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  category           text NOT NULL,          -- merchandise | materials | equipment | services | freight | software | other
  supplier           text,
  description        text NOT NULL,
  reference          text,                   -- supplier invoice / order number

  -- Money in cents. total_cents is what left the bank; gst_cents is the GST
  -- inside it (0 for overseas / zero-rated). The net is DERIVED on read — two
  -- stored columns that must agree is one too many.
  total_cents        integer NOT NULL DEFAULT 0,
  gst_cents          integer NOT NULL DEFAULT 0,
  gst_treatment      text NOT NULL DEFAULT 'inclusive',  -- inclusive | plus_gst | zero_rated | overseas_no_gst

  -- The invoice date as a bare ISO date, never a timestamp.
  spent_on           date NOT NULL,
  paid_with          text,

  -- The invoice PDF itself, base64 — same pattern as esign_documents.source_pdf,
  -- because ClubOS Supabase storage is egress-restricted (402). Validated and
  -- capped in server/print-expense-routes.ts.
  invoice_file_name  text,
  invoice_mime       text,
  invoice_data       text,

  notes              text,
  created_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamp NOT NULL DEFAULT now(),
  updated_at         timestamp NOT NULL DEFAULT now()
);

-- No CHECK constraints on the enum-ish columns: a stale one in prod is how the
-- MFL checkout 500'd. Validation lives in the app.

CREATE INDEX IF NOT EXISTS print_expenses_org_date_idx
  ON print_expenses (organization_id, spent_on DESC);
CREATE INDEX IF NOT EXISTS print_expenses_category_idx
  ON print_expenses (organization_id, category);

-- 🔴 New tables default to RLS OFF and a Supabase anon key is public by design.
ALTER TABLE print_expenses ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE print_expenses IS
  'Purchases made by the print shop, with the invoice PDF stored inline. ClubOS → United Prints → Expenses. GST is recorded per expense, never inferred.';
