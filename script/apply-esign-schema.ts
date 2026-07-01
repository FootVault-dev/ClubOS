// One-off migration for the e-Sign module (DocuSign replacement).
// Purely additive — CREATE TABLE IF NOT EXISTS only. Wrapped in a single
// transaction so any failure rolls everything back. Safe against the drifted
// prod DB (never alters existing columns).
//
// Usage: npx tsx --env-file=.env script/apply-esign-schema.ts

import { Pool } from "pg";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const SQL = `
BEGIN;

CREATE TABLE IF NOT EXISTS esign_documents (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title text NOT NULL,
  message text,
  status text NOT NULL DEFAULT 'draft',
  source_file_name text,
  source_pdf text NOT NULL,
  signed_pdf text,
  doc_hash text,
  created_by integer,
  sent_at timestamp,
  completed_at timestamp,
  voided_at timestamp,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS esign_documents_org_idx ON esign_documents (organization_id);
CREATE INDEX IF NOT EXISTS esign_documents_org_status_idx ON esign_documents (organization_id, status);

CREATE TABLE IF NOT EXISTS esign_signers (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  document_id integer NOT NULL REFERENCES esign_documents(id) ON DELETE CASCADE,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  email text NOT NULL,
  signing_order integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending',
  token text NOT NULL UNIQUE,
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

CREATE INDEX IF NOT EXISTS esign_signers_doc_idx ON esign_signers (document_id);
CREATE INDEX IF NOT EXISTS esign_signers_token_idx ON esign_signers (token);

CREATE TABLE IF NOT EXISTS esign_events (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  document_id integer NOT NULL REFERENCES esign_documents(id) ON DELETE CASCADE,
  signer_id integer,
  type text NOT NULL,
  actor_email text,
  ip text,
  user_agent text,
  meta jsonb,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS esign_events_doc_idx ON esign_events (document_id);

COMMIT;
`;

async function main() {
  const client = await pool.connect();
  try {
    console.log("Connected. Applying e-Sign migration in one transaction...");
    await client.query(SQL);
    console.log("✅ Migration applied.");
    for (const t of ["esign_documents", "esign_signers", "esign_events"]) {
      const check = await client.query(`SELECT to_regclass('public.${t}') AS t`);
      if (!check.rows[0]?.t) throw new Error(`${t} table not found after migration`);
      console.log(`  ✓ ${t}`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("❌ Migration failed:", err);
  process.exit(1);
});
