// Additive migration for e-Sign fillable fields (DocuSign-style field placement).
// CREATE TABLE IF NOT EXISTS only, in one transaction. Safe on the drifted prod DB.
//
// Usage: npx tsx --env-file=.env script/apply-esign-fields-schema.ts

import { Pool } from "pg";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const SQL = `
BEGIN;

CREATE TABLE IF NOT EXISTS esign_fields (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  document_id integer NOT NULL REFERENCES esign_documents(id) ON DELETE CASCADE,
  signer_id integer NOT NULL REFERENCES esign_signers(id) ON DELETE CASCADE,
  page integer NOT NULL DEFAULT 0,
  x double precision NOT NULL,
  y double precision NOT NULL,
  w double precision NOT NULL,
  h double precision NOT NULL,
  type text NOT NULL,
  required boolean NOT NULL DEFAULT true,
  label text,
  value text,
  value_image text,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS esign_fields_doc_idx ON esign_fields (document_id);
CREATE INDEX IF NOT EXISTS esign_fields_signer_idx ON esign_fields (signer_id);

COMMIT;
`;

async function main() {
  const client = await pool.connect();
  try {
    console.log("Connected. Applying e-Sign fields migration...");
    await client.query(SQL);
    const check = await client.query(`SELECT to_regclass('public.esign_fields') AS t`);
    if (!check.rows[0]?.t) throw new Error("esign_fields not found after migration");
    console.log("✅ Migration applied.  ✓ esign_fields");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => { console.error("❌ Migration failed:", err); process.exit(1); });
