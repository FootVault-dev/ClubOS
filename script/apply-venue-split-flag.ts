// Additive migration: venue_settings.split_enabled (Player Pay kill switch).
// Adds the column (default false) and turns it ON for existing venue sites (USC),
// so Player Pay is live but instantly revertible. Idempotent.
//   npx tsx script/apply-venue-split-flag.ts   (writes to DATABASE_URL in .env)
import "dotenv/config";
import { Pool } from "pg";

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query(`ALTER TABLE venue_settings ADD COLUMN IF NOT EXISTS split_enabled boolean DEFAULT false;`);
    const upd = await client.query(`UPDATE venue_settings SET split_enabled = true WHERE split_enabled IS NOT TRUE RETURNING organization_id, split_enabled;`);
    console.log(`✓ venue_settings.split_enabled ready. Enabled for ${upd.rowCount} venue site(s):`, upd.rows);
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
