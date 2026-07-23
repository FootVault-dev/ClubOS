// Apply migrations/2026-07-24_league_payment_reminders.sql.
// Dry-run by default: runs the whole migration inside a transaction, verifies
// the column + tables exist, then ROLLS BACK. Pass --apply to commit.
//   npx tsx script/apply-league-payment-reminders.ts            (rehearse)
//   npx tsx script/apply-league-payment-reminders.ts --apply    (commit)
import "dotenv/config";
import { Pool } from "pg";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const APPLY = process.argv.includes("--apply");

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "migrations", "2026-07-24_league_payment_reminders.sql"), "utf8");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);

    const col = await client.query(
      `SELECT data_type FROM information_schema.columns WHERE table_name='registrations' AND column_name='weekly_first_charge_date'`);
    const tables = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_name IN ('league_payment_reminders','league_payment_reminder_events') ORDER BY table_name`);
    if (col.rowCount !== 1 || col.rows[0].data_type !== "date") throw new Error("weekly_first_charge_date missing or wrong type");
    if (tables.rowCount !== 2) throw new Error(`expected 2 tables, found ${tables.rowCount}`);
    console.log(`✓ registrations.weekly_first_charge_date: ${col.rows[0].data_type}`);
    console.log(`✓ tables: ${tables.rows.map(r => r.table_name).join(", ")}`);

    if (APPLY) {
      await client.query("COMMIT");
      console.log("✓ COMMITTED");
    } else {
      await client.query("ROLLBACK");
      console.log("✓ dry run OK — rolled back. Re-run with --apply to commit.");
    }
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
