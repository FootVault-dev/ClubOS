/**
 * End-to-end proof of the Play Predictor, against the real database and the
 * real Mainland Football feed.
 *
 * It borrows the next scheduled fixture as a sandbox: posts a handful of
 * predictions through the PUBLIC HTTP endpoint, points the fixture at a match
 * that has actually been played (CUFC 4-1 Selwyn United, 20 June 2026), pulls
 * that result through the same fetcher the admin "sync result" button uses,
 * scores every prediction with the shared engine exactly as the route does,
 * checks the public leaderboard reflects it — then puts everything back.
 *
 * Restores in a `finally` block: the fixture returns to `scheduled` with its
 * own match id and no result, and every test entrant is deleted.
 *
 * Usage (with ClubOS running locally on :5099):
 *   npx tsx --env-file=.env script/verify-predictor-e2e.ts
 */
import assert from "node:assert";
import pg from "pg";
import { fetchMainlandFootballResult } from "../server/mainland-football";
import {
  scorePredictionBreakdown,
  PREDICTOR_AUTO_CATEGORIES,
  PREDICTOR_NO_SCORER,
  parseCategories,
  type PredictorActualResult,
  type PredictorPredictionInput,
} from "../shared/predictor-scoring";

const API = process.env.PREDICTOR_API ?? "http://localhost:5099/api/public/predictor";
/** A finished match: United 4-1 Selwyn, Ernest Boyers hat-trick, first goal 30'. */
const PLAYED_MATCH_ID = "6194804";
const TEST_EMAIL_TAG = "predictor-selftest";

let passed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e: any) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

async function predict(fixtureId: number, who: string, body: Record<string, unknown>) {
  const res = await fetch(`${API}/predict`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fixtureId,
      fullName: `Selftest ${who}`,
      email: `${TEST_EMAIL_TAG}+${who}@example.com`,
      phone: "0210000000",
      ...body,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`predict(${who}) failed: ${JSON.stringify(data)}`);
  return data;
}

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const db = await pool.connect();

  const { rows: [fixture] } = await db.query(
    `SELECT * FROM predictor_fixtures WHERE status = 'scheduled' ORDER BY kickoff_at LIMIT 1`);
  if (!fixture) throw new Error("no scheduled fixture to borrow");
  console.log(`Sandbox fixture #${fixture.id} — v ${fixture.opponent}\n`);

  const original = {
    mf_match_id: fixture.mf_match_id, status: fixture.status,
    cufc_score: fixture.cufc_score, opponent_score: fixture.opponent_score,
    goalscorers: fixture.goalscorers, first_goal_minute: fixture.first_goal_minute,
  };

  try {
    // ── 1. Fans predict, through the real public endpoint ──────────────────
    console.log("Posting predictions through the public API:");
    await predict(fixture.id, "perfect", { cufcScore: 4, opponentScore: 1, firstScorer: "Ernest Boyers", firstGoalMinute: 30 });
    await predict(fixture.id, "close", { cufcScore: 4, opponentScore: 1, firstScorer: "Ernest Boyers", firstGoalMinute: 33 });
    await predict(fixture.id, "partial", { cufcScore: 2, opponentScore: 1, firstScorer: "Callum Kennett", firstGoalMinute: 30 });
    await predict(fixture.id, "wrong", { cufcScore: 0, opponentScore: 2, firstScorer: PREDICTOR_NO_SCORER });
    console.log("  4 predictions in\n");

    // A fan can post `shots` at a fixture that isn't played over shots. The
    // server must drop it rather than store a value it will never score.
    await predict(fixture.id, "perfect", {
      cufcScore: 4, opponentScore: 1, firstScorer: "Ernest Boyers", firstGoalMinute: 30,
      shots: 99, possession: 77,
    });
    const { rows: [ignored] } = await db.query(
      `SELECT p.shots, p.possession FROM predictor_predictions p
       JOIN predictor_entrants e ON e.id = p.entrant_id
       WHERE p.fixture_id = $1 AND e.email = $2`,
      [fixture.id, `${TEST_EMAIL_TAG}+perfect@example.com`]);
    check("a category that is switched off is stored as NULL, not the value posted", () => {
      assert.strictEqual(ignored.shots, null, "shots should not have been stored");
      assert.strictEqual(ignored.possession, null, "possession should not have been stored");
    });

    // ── 2. Pull the real result, exactly as the admin sync button does ─────
    const pulled = await fetchMainlandFootballResult(PLAYED_MATCH_ID);
    assert.ok(pulled, "expected a published result");
    console.log(`Pulled from Mainland Football: United ${pulled!.cufcScore}-${pulled!.opponentScore} ${pulled!.opponent}`);
    console.log(`  scorers: ${pulled!.goalscorers.join(", ")}`);
    console.log(`  first goal: ${pulled!.firstGoalMinute}'\n`);

    await db.query(
      `UPDATE predictor_fixtures
         SET status='final', cufc_score=$1, opponent_score=$2, goalscorers=$3::jsonb, first_goal_minute=$4
       WHERE id=$5`,
      [pulled!.cufcScore, pulled!.opponentScore, JSON.stringify(pulled!.goalscorers), pulled!.firstGoalMinute, fixture.id]);

    // ── 3. Score every prediction, exactly as the route does ──────────────
    const enabled = parseCategories(fixture.categories);
    const actual: PredictorActualResult = {
      cufcScore: pulled!.cufcScore, opponentScore: pulled!.opponentScore,
      goalscorers: pulled!.goalscorers, firstGoalMinute: pulled!.firstGoalMinute,
      shots: null, shotsOnTarget: null, possession: null, corners: null,
    };
    const { rows: predictions } = await db.query(
      `SELECT p.*, e.email FROM predictor_predictions p
       JOIN predictor_entrants e ON e.id = p.entrant_id WHERE p.fixture_id = $1`, [fixture.id]);

    const scored: Record<string, { total: number; maxAvailable: number }> = {};
    for (const p of predictions) {
      const input: PredictorPredictionInput = {
        cufcScore: p.cufc_score, opponentScore: p.opponent_score,
        firstScorer: p.first_scorer, firstGoalMinute: p.first_goal_minute,
        shots: p.shots, shotsOnTarget: p.shots_on_target, possession: p.possession, corners: p.corners,
      };
      const b = scorePredictionBreakdown(input, actual, enabled);
      await db.query(`UPDATE predictor_predictions SET points_awarded=$1, points_breakdown=$2::jsonb WHERE id=$3`,
        [b.total, JSON.stringify(b), p.id]);
      const who = String(p.email).split("+")[1]?.split("@")[0] ?? p.email;
      scored[who] = { total: b.total, maxAvailable: b.maxAvailable };
      console.log(`  ${who.padEnd(9)} ${String(b.total).padStart(3)} / ${b.maxAvailable}`);
    }
    console.log();

    // ── 4. Assert the arithmetic ──────────────────────────────────────────
    check("a perfect entry scores the full 65 (10+10+5+20+20)", () => {
      assert.strictEqual(scored.perfect.total, 65);
      assert.strictEqual(scored.perfect.maxAvailable, 65);
    });
    check("three minutes out costs 12: 53 instead of 65", () => {
      assert.strictEqual(scored.close.total, 53);
    });
    check("right result + opposition goals + exact minute, wrong scorer and United goals = 35", () => {
      // oppGoals 10 + result 5 + minute 20 = 35; cufcGoals 0, firstScorer 0 (Kennett never scored)
      assert.strictEqual(scored.partial.total, 35);
    });
    check("a wholly wrong entry scores 0, and the maximum still stands at 65", () => {
      assert.strictEqual(scored.wrong.total, 0);
      assert.strictEqual(scored.wrong.maxAvailable, 65);
    });

    // ── 5. The public leaderboard must reflect it ─────────────────────────
    const board = await (await fetch(`${API}/leaderboard`)).json();
    check("the season board ranks the perfect entry first, on 65", () => {
      assert.ok(Array.isArray(board.season) && board.season.length >= 4, "expected a populated season board");
      assert.strictEqual(board.season[0].points, 65);
    });
    check("the monthly board exists alongside the season board", () => {
      assert.ok(Array.isArray(board.month), "expected a monthly board");
    });
    check("public names are masked to 'First L.'", () => {
      assert.match(board.season[0].name, /^\S+ \S\.$/, `got "${board.season[0].name}"`);
    });
    check("the last-game board shows what each entrant called", () => {
      assert.ok(board.lastFixture?.rows?.length, "expected a last-game board");
      assert.ok(board.lastFixture.rows[0].predicted, "expected a predicted scoreline");
    });

    console.log(`\n${passed} passed`);
  } finally {
    // ── Restore, always ────────────────────────────────────────────────────
    console.log("\nRestoring…");
    await db.query(`DELETE FROM predictor_predictions WHERE entrant_id IN
      (SELECT id FROM predictor_entrants WHERE email LIKE $1)`, [`%${TEST_EMAIL_TAG}%`]);
    await db.query(`DELETE FROM predictor_entrants WHERE email LIKE $1`, [`%${TEST_EMAIL_TAG}%`]);
    await db.query(
      `UPDATE predictor_fixtures
         SET status=$1, cufc_score=$2, opponent_score=$3, goalscorers=$4, first_goal_minute=$5, mf_match_id=$6
       WHERE id=$7`,
      [original.status, original.cufc_score, original.opponent_score, original.goalscorers,
       original.first_goal_minute, original.mf_match_id, fixture.id]);
    const { rows: [left] } = await db.query(
      `SELECT count(*)::int AS n FROM predictor_entrants WHERE email LIKE $1`, [`%${TEST_EMAIL_TAG}%`]);
    const { rows: [fx] } = await db.query(`SELECT status, cufc_score FROM predictor_fixtures WHERE id=$1`, [fixture.id]);
    console.log(`  fixture #${fixture.id} → ${fx.status}, score ${fx.cufc_score ?? "null"} · ${left.n} test entrants left`);
    db.release();
    await pool.end();
  }
}

main().catch((e) => { console.error("✗ failed:", e.message); process.exit(1); });
