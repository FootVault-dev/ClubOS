-- OFC Payables Declarations (Document F.05 — "No Overdue Payables towards
-- Players and Club Staff"). A roster-declaration built on the e-Sign primitives:
-- every listed player + club staff member individually confirms, on a branded
-- signing page, that the club has paid all their contractual obligations; the
-- club's authorised signatory then certifies, and the whole thing is collated
-- into ONE master PDF (the OFC template layout) + individual proof + a
-- Certificate of Completion.
--
-- Additive only (CREATE TABLE / INDEX IF NOT EXISTS). Safe on the drifted prod
-- DB. Apply BEFORE deploy. Mirror in shared/schema.ts.

BEGIN;

CREATE TABLE IF NOT EXISTS payables_declarations (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title text NOT NULL,
  criterion text NOT NULL DEFAULT 'F.05',
  season text,                                  -- e.g. '2026/27'
  club_name text NOT NULL,                      -- legal applicant name
  as_of_date text,                              -- YYYY-MM-DD the payables are confirmed paid up to
  statement text NOT NULL,                      -- confirmation wording ({{club}} {{season}} {{as_of}} merged)
  signatory_name text,                          -- authorised signatory of the club
  signatory_title text,                         -- their job title
  signatory_signature_name text,               -- typed name at certification
  signatory_signature_image text,              -- base64 png drawn signature
  signatory_signed_at timestamp,
  signatory_ip text,
  status text NOT NULL DEFAULT 'draft',         -- draft | collecting | completed | voided
  signed_pdf text,                              -- base64 of the finalised master PDF
  doc_hash text,                                -- sha256 of the source render (hashed at finalise)
  created_by integer,                           -- users.id
  sent_at timestamp,
  completed_at timestamp,
  voided_at timestamp,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payables_declaration_signatories (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  declaration_id integer NOT NULL REFERENCES payables_declarations(id) ON DELETE CASCADE,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  group_kind text NOT NULL DEFAULT 'player',    -- 'player' | 'staff'
  name text NOT NULL,
  email text,                                   -- nullable → in-person signing via copy-link
  role_title text,                              -- optional (squad no. / staff role)
  sort_order integer NOT NULL DEFAULT 0,
  token text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending',       -- pending | viewed | signed | declined
  signature_name text,
  signature_image text,
  consented_at timestamp,
  viewed_at timestamp,
  signed_at timestamp,
  ip text,
  user_agent text,
  decline_reason text,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payables_sig_decl_idx ON payables_declaration_signatories (declaration_id);

CREATE TABLE IF NOT EXISTS payables_declaration_events (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  declaration_id integer NOT NULL REFERENCES payables_declarations(id) ON DELETE CASCADE,
  signatory_id integer,
  type text NOT NULL,                           -- created|sent|viewed|signed|declined|reminded|certified|completed|voided
  actor_email text,
  ip text,
  user_agent text,
  meta jsonb,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payables_events_decl_idx ON payables_declaration_events (declaration_id);

COMMIT;
