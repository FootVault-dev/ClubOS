// Apply the CIC interest-registrations schema to the live Supabase DB.
// ADDITIVE ONLY — never db:push (prod schema drift).
// Usage: npx tsx --env-file=.env script/apply-cic-interest-schema.ts
import { readFileSync } from "fs";
import pg from "pg";

const sql = readFileSync("migrations/2026-07-05_cic_interest_registrations.sql", "utf8");

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
    const check = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'cic_interest_registrations' ORDER BY ordinal_position`,
    );
    console.log("Columns:", check.rows.map((r) => r.column_name).join(", "));
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().then(() => { console.log("✓ cic interest schema applied"); process.exit(0); })
  .catch((e) => { console.error("✗ failed:", e.message); process.exit(1); });
