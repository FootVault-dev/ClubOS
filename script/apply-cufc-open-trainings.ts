// Apply the CUFC Open Trainings migration. ADDITIVE ONLY.
//
//   Rehearse:  npx tsx --env-file=.env script/apply-cufc-open-trainings.ts --dry-run
//   Apply:     npx tsx --env-file=.env script/apply-cufc-open-trainings.ts
//
// `--dry-run` runs the whole migration and every verification inside a
// transaction it then ROLLS BACK — proving the SQL parses and the
// organizations FK resolves without changing anything. (Prod has schema
// drift — never `db:push --force`. Run BEFORE fly deploy.)
import { Pool } from "pg";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const DRY_RUN = process.argv.includes("--dry-run");

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, "..", "migrations", "2026-07-21_cufc_open_trainings.sql"), "utf8");

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
try {
  console.log(DRY_RUN ? "\nDRY RUN — everything below is rolled back.\n" : "\nAPPLYING to the database.\n");
  await pool.query("BEGIN");
  await pool.query(sql);

  let missing = 0;
  {
    const r = await pool.query("SELECT to_regclass($1) AS t", ["cufc_open_trainings"]);
    const ok = r.rows[0].t !== null;
    if (!ok) missing++;
    console.log(`${ok ? "  ok " : " MISS"}  table cufc_open_trainings`);
  }
  {
    const r = await pool.query("SELECT 1 FROM pg_indexes WHERE indexname = $1", ["cufc_open_trainings_org_status_idx"]);
    const ok = r.rows.length > 0;
    if (!ok) missing++;
    console.log(`${ok ? "  ok " : " MISS"}  index cufc_open_trainings_org_status_idx`);
  }

  if (missing) {
    await pool.query("ROLLBACK");
    console.error(`\n${missing} object(s) missing — DO NOT DEPLOY.`);
    process.exit(1);
  }

  if (DRY_RUN) {
    await pool.query("ROLLBACK");
    console.log("\n✓ Migration is valid. Rolled back — the database is unchanged.");
    console.log("  Re-run without --dry-run to apply it for real.\n");
  } else {
    await pool.query("COMMIT");
    console.log("\ncufc_open_trainings present. Safe to deploy.\n");
  }
} catch (e) {
  await pool.query("ROLLBACK").catch(() => {});
  throw e;
} finally {
  await pool.end();
}
