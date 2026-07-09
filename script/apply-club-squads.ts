// Apply the club squads migration. ADDITIVE ONLY.
// Run: npx tsx --env-file=.env script/apply-club-squads.ts
// (Prod has schema drift — never `db:push --force`. Run BEFORE fly deploy.)
import { Pool } from "pg";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, "..", "migrations", "2026-07-10_club_squads.sql"), "utf8");

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
try {
  await pool.query("BEGIN");
  await pool.query(sql);
  await pool.query("COMMIT");

  let missing = 0;
  for (const t of ["club_squads", "club_squad_members"]) {
    const r = await pool.query("SELECT to_regclass($1) AS t", [t]);
    const ok = r.rows[0].t !== null;
    if (!ok) missing++;
    console.log(`${ok ? "  ok " : " MISS"}  table ${t}`);
  }
  for (const idx of [
    "club_squads_org_season_name_key",
    "club_squad_members_unique",
    "club_squad_members_number_key",
  ]) {
    const r = await pool.query("SELECT 1 FROM pg_indexes WHERE indexname = $1", [idx]);
    const ok = r.rows.length > 0;
    if (!ok) missing++;
    console.log(`${ok ? "  ok " : " MISS"}  index ${idx}`);
  }
  if (missing) { console.error(`\n${missing} object(s) missing — DO NOT DEPLOY.`); process.exit(1); }
  console.log("\nAll squad objects present. Safe to deploy.");
} catch (e) {
  await pool.query("ROLLBACK").catch(() => {});
  throw e;
} finally {
  await pool.end();
}
