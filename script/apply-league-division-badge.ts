// Applies migrations/2026-07-27_league_division_badge.sql and sets the Term 4
// badges, then verifies — the whole thing inside ONE transaction that is rolled
// back unless --apply is passed (there is no local Postgres, so this is how a
// ClubOS migration gets rehearsed against the real prod schema).
//
// Daniel, 27 Jul 2026: put a "New league discount" ribbon on the two nights
// dropped to $400 — Tuesday 7's (zero teams in Term 3) and the new Thursday cage.
//
// Dry run (default):  npx tsx script/apply-league-division-badge.ts
// Apply:              npx tsx script/apply-league-division-badge.ts --apply

import "dotenv/config";
import { readFileSync } from "fs";
import { join } from "path";
import { Pool } from "pg";

const APPLY = process.argv.includes("--apply");
const ORG_ID = 3;
const COMP_NAME = "Mini Football Leagues — Term 4";
const BADGE = "New league discount";
const BADGED = ["Tuesday 7's", "Thursday 5's"];

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1) Migration (additive, IF NOT EXISTS — safe to re-run).
    const sql = readFileSync(join(process.cwd(), "migrations/2026-07-27_league_division_badge.sql"), "utf8");
    await client.query(sql);
    console.log("✓ Migration applied: league_divisions.badge_text");

    // 2) Prove the column is really there and really nullable with no default —
    //    a default would silently badge every existing division in the club.
    const col = await client.query(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_name='league_divisions' AND column_name='badge_text'`);
    if (col.rowCount !== 1) throw new Error("badge_text column missing after migration");
    const c = col.rows[0];
    if (c.is_nullable !== "YES" || c.column_default !== null) {
      throw new Error(`badge_text must be nullable with no default, got nullable=${c.is_nullable} default=${c.column_default}`);
    }
    console.log(`  ${c.data_type}, nullable, no default ✓`);

    const others = await client.query(`SELECT count(*)::int AS n FROM league_divisions WHERE badge_text IS NOT NULL`);
    console.log(`  divisions carrying a badge before we set ours: ${others.rows[0].n} (expect 0)`);

    // 3) Set the two Term 4 badges.
    const comp = await client.query(
      `SELECT id FROM league_competitions WHERE organization_id=$1 AND name=$2`, [ORG_ID, COMP_NAME]);
    if (comp.rowCount !== 1) throw new Error(`Expected 1 "${COMP_NAME}", found ${comp.rowCount}`);
    const compId = comp.rows[0].id;

    for (const name of BADGED) {
      const r = await client.query(
        `UPDATE league_divisions SET badge_text=$1 WHERE competition_id=$2 AND name=$3 RETURNING id, team_cost_cents`,
        [BADGE, compId, name]);
      if (r.rowCount !== 1) throw new Error(`Expected 1 "${name}" in comp ${compId}, updated ${r.rowCount}`);
      console.log(`  ✓ ${name.padEnd(14)} badge "${BADGE}"  ($${(r.rows[0].team_cost_cents / 100).toFixed(2)})`);
    }

    // 4) Final board.
    const board = await client.query(
      `SELECT name, team_cost_cents, badge_text FROM league_divisions WHERE competition_id=$1 ORDER BY sort_order`, [compId]);
    console.log(`\n  Term 4 board:`);
    for (const d of board.rows) {
      console.log(`    ${d.name.padEnd(14)} $${String((d.team_cost_cents / 100).toFixed(2)).padStart(7)}  ${d.badge_text ? `[${d.badge_text}]` : ""}`);
    }

    if (APPLY) {
      await client.query("COMMIT");
      console.log(`\n✓ Committed.`);
    } else {
      await client.query("ROLLBACK");
      console.log(`\n🔍 DRY RUN — rolled back (migration included). Re-run with --apply.`);
    }
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error("Failed:", e.message || e); process.exit(1); });
