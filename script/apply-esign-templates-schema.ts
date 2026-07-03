// Additive migration for e-Sign v2 native templates (agreements as branded
// web pages). CREATE TABLE IF NOT EXISTS + ADD COLUMN IF NOT EXISTS only, in
// one transaction. Safe on the drifted prod DB.
//
// Usage: npx tsx --env-file=.env script/apply-esign-templates-schema.ts

import { Pool } from "pg";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const SQL = `
BEGIN;

CREATE TABLE IF NOT EXISTS esign_templates (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  slug text NOT NULL,
  name text NOT NULL,
  description text,
  brand jsonb NOT NULL,
  content jsonb NOT NULL,
  variables jsonb NOT NULL,
  form jsonb NOT NULL,
  settings jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS esign_templates_org_slug_idx ON esign_templates (organization_id, slug);

ALTER TABLE esign_documents ADD COLUMN IF NOT EXISTS doc_type text NOT NULL DEFAULT 'pdf';
ALTER TABLE esign_documents ADD COLUMN IF NOT EXISTS template_id integer;
ALTER TABLE esign_documents ADD COLUMN IF NOT EXISTS template_data jsonb;

ALTER TABLE esign_signers ADD COLUMN IF NOT EXISTS form_data jsonb;

COMMIT;
`;

async function main() {
  const client = await pool.connect();
  try {
    console.log("Connected. Applying e-Sign templates migration...");
    await client.query(SQL);
    const t = await client.query(`SELECT to_regclass('public.esign_templates') AS t`);
    if (!t.rows[0]?.t) throw new Error("esign_templates not found after migration");
    const cols = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'esign_documents' AND column_name IN ('doc_type','template_id','template_data')`
    );
    if (cols.rows.length !== 3) throw new Error("esign_documents columns missing after migration");
    console.log("✅ Migration applied.  ✓ esign_templates  ✓ esign_documents.doc_type/template_id/template_data  ✓ esign_signers.form_data");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => { console.error("❌ Migration failed:", err); process.exit(1); });
