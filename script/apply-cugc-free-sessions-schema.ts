// Apply the CUGC Free Sessions migration to the live DB. ADDITIVE ONLY.
// Run: npx tsx --env-file=.env script/apply-cugc-free-sessions-schema.ts
// (Prod has schema drift — never `db:push --force`. Run BEFORE fly deploy.)
import { Pool } from "pg";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, "..", "migrations", "2026-07-02_cugc_free_sessions.sql"), "utf8");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  await pool.query("BEGIN");
  await pool.query(sql);
  await pool.query("COMMIT");
  const t = await pool.query("SELECT to_regclass('cugc_free_sessions') AS table");
  const c = await pool.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='cugc_registrations' AND column_name='attribution'",
  );
  console.log("cugc_free_sessions:", t.rows[0].table);
  console.log("cugc_registrations.attribution:", c.rows.length ? "present" : "MISSING");
} catch (e) {
  await pool.query("ROLLBACK").catch(() => {});
  throw e;
} finally {
  await pool.end();
}
