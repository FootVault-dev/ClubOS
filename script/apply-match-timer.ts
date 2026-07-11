// Apply the match-timer migration. ADDITIVE ONLY (4 columns on tournament_games).
//
//   Rehearse:  npx tsx --env-file=.env script/apply-match-timer.ts --dry-run
//   Apply:     npx tsx --env-file=.env script/apply-match-timer.ts
//
// `--dry-run` runs it inside a transaction it then ROLLS BACK. Adding columns
// with constant defaults is a metadata-only change (no rewrite), safe on the
// live tournament_games. (Prod has drift — never db:push. Run BEFORE fly deploy.)
import { Pool } from "pg";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const DRY_RUN = process.argv.includes("--dry-run");
const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, "..", "migrations", "2026-07-12_match_timer.sql"), "utf8");

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
try {
  console.log(DRY_RUN ? "\nDRY RUN — everything below is rolled back.\n" : "\nAPPLYING to the database.\n");
  await pool.query("BEGIN");
  await pool.query(sql);

  let missing = 0;
  for (const col of ["timer_phase", "timer_running", "timer_started_at", "timer_base_seconds"]) {
    const r = await pool.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'tournament_games' AND column_name = $1",
      [col],
    );
    const ok = r.rows.length > 0;
    if (!ok) missing++;
    console.log(`${ok ? "  ok " : " MISS"}  tournament_games.${col}`);
  }

  if (missing) {
    await pool.query("ROLLBACK");
    console.error(`\n${missing} column(s) missing — DO NOT DEPLOY.`);
    process.exit(1);
  }
  if (DRY_RUN) {
    await pool.query("ROLLBACK");
    console.log("\n✓ Migration is valid. Rolled back — the database is unchanged.\n");
  } else {
    await pool.query("COMMIT");
    console.log("\nAll timer columns present. Safe to deploy.\n");
  }
} catch (e) {
  await pool.query("ROLLBACK").catch(() => {});
  throw e;
} finally {
  await pool.end();
}
