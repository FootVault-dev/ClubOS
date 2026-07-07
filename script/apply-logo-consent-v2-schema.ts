// Additive migration for Club Logo Licence v2 — adds the document_hash proof
// column (and ensures club_id exists for auto-matching). ADD COLUMN IF NOT EXISTS
// only, one transaction. Safe on the drifted prod DB.
//
// Usage: npx tsx --env-file=.env script/apply-logo-consent-v2-schema.ts

import { Pool } from "pg";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const SQL = `
BEGIN;

ALTER TABLE club_logo_consents ADD COLUMN IF NOT EXISTS document_hash text;
ALTER TABLE club_logo_consents ADD COLUMN IF NOT EXISTS club_id integer;

CREATE INDEX IF NOT EXISTS club_logo_consents_org_idx ON club_logo_consents (organization_id);
CREATE INDEX IF NOT EXISTS club_logo_consents_club_idx ON club_logo_consents (club_id);

COMMIT;
`;

async function main() {
  const client = await pool.connect();
  try {
    console.log("Connected. Applying logo-consent v2 migration...");
    await client.query(SQL);
    console.log("✓ Done — document_hash + club_id present, indexes ensured.");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
