// Additive migration: sequential signing order on e-Sign envelopes.
// ALTER TABLE ... ADD COLUMN IF NOT EXISTS only. Safe on the drifted prod DB.
//
// Usage: npx tsx --env-file=.env script/apply-esign-sequential-schema.ts

import { Pool } from "pg";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const SQL = `
BEGIN;
ALTER TABLE esign_documents ADD COLUMN IF NOT EXISTS sequential boolean NOT NULL DEFAULT false;
COMMIT;
`;

async function main() {
  const client = await pool.connect();
  try {
    console.log("Connected. Adding esign_documents.sequential...");
    await client.query(SQL);
    const check = await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'esign_documents' AND column_name = 'sequential'`,
    );
    if (!check.rows.length) throw new Error("Column not found after migration");
    console.log("Done — sequential present.");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
