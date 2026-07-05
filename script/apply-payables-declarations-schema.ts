// Additive migration for OFC Payables Declarations (Document F.05). Creates the
// three tables the roster-declaration feature needs. CREATE TABLE / INDEX IF NOT
// EXISTS only, in one transaction — safe on the drifted prod DB.
//
// Usage: npx tsx --env-file=.env script/apply-payables-declarations-schema.ts

import { Pool } from "pg";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const SQL = `
BEGIN;

CREATE TABLE IF NOT EXISTS payables_declarations (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title text NOT NULL,
  criterion text NOT NULL DEFAULT 'F.05',
  season text,
  club_name text NOT NULL,
  as_of_date text,
  statement text NOT NULL,
  signatory_name text,
  signatory_title text,
  signatory_signature_name text,
  signatory_signature_image text,
  signatory_signed_at timestamp,
  signatory_ip text,
  status text NOT NULL DEFAULT 'draft',
  signed_pdf text,
  doc_hash text,
  created_by integer,
  sent_at timestamp,
  completed_at timestamp,
  voided_at timestamp,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payables_declaration_signatories (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  declaration_id integer NOT NULL REFERENCES payables_declarations(id) ON DELETE CASCADE,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  group_kind text NOT NULL DEFAULT 'player',
  name text NOT NULL,
  email text,
  role_title text,
  sort_order integer NOT NULL DEFAULT 0,
  token text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending',
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
  type text NOT NULL,
  actor_email text,
  ip text,
  user_agent text,
  meta jsonb,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payables_events_decl_idx ON payables_declaration_events (declaration_id);

COMMIT;
`;

async function main() {
  const client = await pool.connect();
  try {
    await client.query(SQL);
    console.log("✅ payables_declarations schema applied");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => { console.error("❌ Migration failed:", err); process.exit(1); });
