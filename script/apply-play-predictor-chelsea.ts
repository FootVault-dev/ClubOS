// Widen the Play Predictor schema to the nine Chelsea scoring categories.
// ADDITIVE ONLY — never db:push (prod schema drift). Run BEFORE the deploy.
// Usage: npx tsx --env-file=.env script/apply-play-predictor-chelsea.ts
import { readFileSync } from "fs";
import pg from "pg";

const sql = readFileSync("migrations/2026-07-09_play_predictor_chelsea.sql", "utf8");

/** Columns this migration must leave behind, per table. */
const EXPECTED: Record<string, string[]> = {
  predictor_fixtures: [
    "categories", "first_goal_minute", "shots", "shots_on_target", "possession", "corners", "mf_match_id",
  ],
  predictor_predictions: [
    "first_scorer", "first_goal_minute", "shots", "shots_on_target", "possession", "corners", "points_breakdown",
  ],
  predictor_squad: ["shirt_number"],
};

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");

    let missing = 0;
    for (const [table, columns] of Object.entries(EXPECTED)) {
      const { rows } = await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
        [table],
      );
      const present = new Set(rows.map((r) => r.column_name));
      for (const c of columns) {
        if (!present.has(c)) { console.error(`  ✗ ${table}.${c} MISSING`); missing++; }
      }
      console.log(`  ✓ ${table} — ${columns.filter((c) => present.has(c)).length}/${columns.length} new columns present`);
    }

    // The old three-scorer array must no longer be NOT NULL, or inserts break.
    const { rows: nullable } = await client.query(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_name = 'predictor_predictions' AND column_name = 'goalscorers'`,
    );
    if (nullable[0]?.is_nullable !== "YES") {
      console.error("  ✗ predictor_predictions.goalscorers is still NOT NULL");
      missing++;
    } else {
      console.log("  ✓ predictor_predictions.goalscorers is nullable");
    }

    if (missing > 0) throw new Error(`${missing} expected change(s) missing after migration`);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().then(() => { console.log("✓ Chelsea predictor schema applied"); process.exit(0); })
  .catch((e) => { console.error("✗ failed:", e.message); process.exit(1); });
