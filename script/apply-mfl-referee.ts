// Apply the MFL referee scoring migration. ADDITIVE ONLY.
//
//   Rehearse:  npx tsx --env-file=.env script/apply-mfl-referee.ts --dry-run
//   Apply:     npx tsx --env-file=.env script/apply-mfl-referee.ts
//
// `--dry-run` runs the whole migration and every verification inside a
// transaction it then ROLLS BACK. Postgres DDL is transactional, so this
// proves the SQL parses, the organizations / users / league_games /
// league_teams / league_competitions foreign keys resolve, and the indexes
// build — while changing nothing. There is no local Postgres to rehearse
// against, and a typo found during the real run is a typo found with the
// deploy already half-done.
//
// (Prod has schema drift — never db:push --force. Run BEFORE fly deploy.)
import { Pool } from "pg";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const DRY_RUN = process.argv.includes("--dry-run");

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, "..", "migrations", "2026-07-13_mfl_referee_scoring.sql"), "utf8");

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
try {
  console.log(DRY_RUN ? "\nDRY RUN — everything below is rolled back.\n" : "\nAPPLYING to the database.\n");
  await pool.query("BEGIN");
  await pool.query(sql);
  // Verification runs INSIDE the transaction, so a dry run checks the objects
  // it just built before throwing them away.

  let missing = 0;

  for (const t of ["league_referees", "league_referee_assignments", "league_goals", "league_cards", "league_media"]) {
    const r = await pool.query("SELECT to_regclass($1) AS t", [t]);
    const ok = r.rows[0].t !== null;
    if (!ok) missing++;
    console.log(`${ok ? "  ok " : " MISS"}  table ${t}`);
  }

  for (const idx of [
    "league_referees_org_email_unq",
    "league_referees_status_idx",
    "league_referee_assignments_unq",
    "league_referee_assignments_game_idx",
    "league_goals_game_idx",
    "league_cards_game_idx",
    "league_media_org_published_idx",
  ]) {
    const r = await pool.query("SELECT 1 FROM pg_indexes WHERE indexname = $1", [idx]);
    const ok = r.rows.length > 0;
    if (!ok) missing++;
    console.log(`${ok ? "  ok " : " MISS"}  index ${idx}`);
  }

  // The additive columns on the existing league_games / league_competitions tables.
  for (const col of [
    "last_scored_by_referee_id",
    "last_scored_at",
    "timer_phase",
    "timer_running",
    "timer_started_at",
    "timer_base_seconds",
  ]) {
    const r = await pool.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'league_games' AND column_name = $1",
      [col],
    );
    const ok = r.rows.length > 0;
    if (!ok) missing++;
    console.log(`${ok ? "  ok " : " MISS"}  league_games.${col}`);
  }
  for (const col of ["half_length_minutes", "break_minutes"]) {
    const r = await pool.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'league_competitions' AND column_name = $1",
      [col],
    );
    const ok = r.rows.length > 0;
    if (!ok) missing++;
    console.log(`${ok ? "  ok " : " MISS"}  league_competitions.${col}`);
  }

  // The two unique indexes are the load-bearing ones: one account per email per
  // workspace, one assignment per (referee, game). Prove they are genuinely
  // UNIQUE — a plain index here would let a duplicate signup or a double
  // assignment through, which would look like an app bug rather than a
  // migration bug. Also prove the email index is the case-insensitive
  // expression index.
  const defs = await pool.query(
    `SELECT indexname, indexdef FROM pg_indexes
      WHERE indexname IN ('league_referees_org_email_unq', 'league_referee_assignments_unq')`,
  );
  for (const row of defs.rows) {
    const ok = /UNIQUE INDEX/i.test(row.indexdef);
    if (!ok) missing++;
    console.log(`${ok ? "  ok " : " MISS"}  ${row.indexname} is unique`);
  }
  const emailDef = defs.rows.find((r) => r.indexname === "league_referees_org_email_unq");
  const emailCI = !!emailDef && /lower\(/i.test(emailDef.indexdef);
  if (!emailCI) missing++;
  console.log(`${emailCI ? "  ok " : " MISS"}  league_referees_org_email_unq is case-insensitive`);

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
    console.log("\nAll MFL referee-scoring objects present. Safe to deploy.\n");
  }
} catch (e) {
  await pool.query("ROLLBACK").catch(() => {});
  throw e;
} finally {
  await pool.end();
}
