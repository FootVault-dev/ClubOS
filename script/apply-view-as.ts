// Applies migrations/2026-08-13_view_as_events.sql, then verifies.
// Additive only: one new table, no existing table touched.
import "dotenv/config";
import { Pool } from "pg";
import { readFileSync } from "fs";

const dry = process.argv.includes("--dry-run");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const sqlText = readFileSync("migrations/2026-08-13_view_as_events.sql", "utf8");
const c = await pool.connect();
try {
  await c.query("BEGIN");
  await c.query(sqlText);
  const t = await c.query(`SELECT to_regclass('public.view_as_events') AS t`);
  const rls = await c.query(`SELECT relrowsecurity FROM pg_class WHERE relname='view_as_events'`);
  const fks = await c.query(`
    SELECT conname, confdeltype FROM pg_constraint
    WHERE conrelid='view_as_events'::regclass AND contype='f'`);
  console.log("table:", t.rows[0].t);
  console.log("RLS on:", rls.rows[0]?.relrowsecurity);
  console.log("FKs:", fks.rows.map((r:any)=>`${r.conname}=${r.confdeltype}`).join(", "), "(r = RESTRICT)");
  if (dry) { await c.query("ROLLBACK"); console.log("\n--dry-run → rolled back"); }
  else { await c.query("COMMIT"); console.log("\n✓ committed"); }
} catch (e:any) { await c.query("ROLLBACK"); console.error("rolled back:", e.message); process.exit(1); }
finally { c.release(); await pool.end(); }
