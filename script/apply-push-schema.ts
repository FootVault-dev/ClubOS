// Apply the push-notifications schema (device_push_tokens + push_campaigns)
// to the live Supabase DB. ADDITIVE ONLY — never db:push (prod schema drift).
// Usage: npx tsx --env-file=.env script/apply-push-schema.ts
import { readFileSync } from "fs";
import pg from "pg";

const sql = readFileSync("migrations/2026-07-02_push_notifications.sql", "utf8");

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
    const check = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_name IN ('device_push_tokens','push_campaigns') ORDER BY table_name`,
    );
    console.log("Tables present:", check.rows.map((r) => r.table_name).join(", "));
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().then(() => { console.log("✓ push schema applied"); process.exit(0); })
  .catch((e) => { console.error("✗ failed:", e.message); process.exit(1); });
