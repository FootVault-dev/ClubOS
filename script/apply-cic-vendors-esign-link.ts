// Additive migration: link a CIC vendor to its e-Sign agreement document so
// contract_status syncs automatically (pending -> sent -> signed).
// ALTER TABLE ... ADD COLUMN IF NOT EXISTS only. Safe on the drifted prod DB.
//
// Usage: npx tsx --env-file=.env script/apply-cic-vendors-esign-link.ts

import { Pool } from "pg";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const SQL = `
BEGIN;
ALTER TABLE cic_vendors ADD COLUMN IF NOT EXISTS esign_document_id integer;
COMMIT;
`;

async function main() {
  const client = await pool.connect();
  try {
    console.log("Connected. Adding cic_vendors.esign_document_id...");
    await client.query(SQL);
    const check = await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'cic_vendors' AND column_name = 'esign_document_id'`,
    );
    if (!check.rows.length) throw new Error("Column not found after migration");
    console.log("Done — esign_document_id present.");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
