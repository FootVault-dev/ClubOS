// Play Predictor scoring tests — plain tsx + node assert (same pattern as
// script/test-league-pricing.ts). Run: npx tsx script/test-predictor-scoring.ts
//
// Every point value below is checked against the Chelsea FC Play Predictor
// "Annex 2 – Scoring System" table, transcribed verbatim in
// outputs/deep-research/2026-07-07-nz-play-predictor/01-chelsea-premier-league.md
import assert from "node:assert";
import {
  scorePrediction,
  scorePredictionBreakdown,
  predictorMaxPoints,
  predictionsClosed,
  normaliseGoalMinute,
  parseCategories,
  resultOf,
  PREDICTOR_CATEGORIES,
  PREDICTOR_AUTO_CATEGORIES,
  PREDICTOR_MANUAL_CATEGORIES,
  PREDICTOR_NO_SCORER,
  PREDICTOR_OWN_GOAL,
  PREDICTOR_LOCK_BEFORE_KICKOFF_MS,
  type PredictorCategory,
  type PredictorPredictionInput,
  type PredictorActualResult,
} from "../shared/predictor-scoring";

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e: any) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    process.exitCode = 1;
  }
}

const ALL: PredictorCategory[] = [...PREDICTOR_CATEGORIES];

/** A prediction with everything null unless overridden. */
function P(over: Partial<PredictorPredictionInput> = {}): PredictorPredictionInput {
  return {
    cufcScore: 0, opponentScore: 0, firstScorer: null, firstGoalMinute: null,
    shots: null, shotsOnTarget: null, possession: null, corners: null, ...over,
  };
}

/** An actual result with everything null unless overridden. */
function A(over: Partial<PredictorActualResult> = {}): PredictorActualResult {
  return {
    cufcScore: 0, opponentScore: 0, goalscorers: [], firstGoalMinute: null,
    shots: null, shotsOnTarget: null, possession: null, corners: null, ...over,
  };
}

/** Points for a single category, in isolation. */
function cat(c: PredictorCategory, p: PredictorPredictionInput, a: PredictorActualResult): number {
  return scorePrediction(p, a, [c]);
}

console.log("predictor-scoring (Chelsea Annex 2)");

// ── Category maxima ──────────────────────────────────────────────────────────

test("all nine categories total 105 points", () => {
  assert.strictEqual(predictorMaxPoints(ALL), 105);
});

test("the five auto categories total 65 points", () => {
  assert.strictEqual(predictorMaxPoints(PREDICTOR_AUTO_CATEGORIES), 65);
});

test("the four manual categories total 40 points", () => {
  assert.strictEqual(predictorMaxPoints(PREDICTOR_MANUAL_CATEGORIES), 40);
});

// ── Goals + result (10 / 10 / 5) ─────────────────────────────────────────────

test("United goals: 10 for the exact number", () => {
  assert.strictEqual(cat("cufcGoals", P({ cufcScore: 3 }), A({ cufcScore: 3 })), 10);
  assert.strictEqual(cat("cufcGoals", P({ cufcScore: 2 }), A({ cufcScore: 3 })), 0);
});

test("opposition goals: 10 for the exact number", () => {
  assert.strictEqual(cat("oppGoals", P({ opponentScore: 1 }), A({ opponentScore: 1 })), 10);
  assert.strictEqual(cat("oppGoals", P({ opponentScore: 0 }), A({ opponentScore: 1 })), 0);
});

test("result: 5 for the correct win/draw/loss", () => {
  // Right outcome, wrong scoreline.
  assert.strictEqual(cat("result", P({ cufcScore: 2, opponentScore: 1 }), A({ cufcScore: 3, opponentScore: 0 })), 5);
  assert.strictEqual(cat("result", P({ cufcScore: 1, opponentScore: 1 }), A({ cufcScore: 2, opponentScore: 2 })), 5);
  assert.strictEqual(cat("result", P({ cufcScore: 0, opponentScore: 1 }), A({ cufcScore: 2, opponentScore: 1 })), 0);
});

test("resultOf maps scorelines to W/D/L", () => {
  assert.strictEqual(resultOf(2, 1), "W");
  assert.strictEqual(resultOf(1, 1), "D");
  assert.strictEqual(resultOf(0, 1), "L");
});

test("a perfect 2-1 scoreline pays 10 + 10 + 5 = 25 before scorer/minute", () => {
  const p = P({ cufcScore: 2, opponentScore: 1 });
  const a = A({ cufcScore: 2, opponentScore: 1 });
  assert.strictEqual(scorePrediction(p, a, ["cufcGoals", "oppGoals", "result"]), 25);
});

// ── First goalscorer (20 exact / 5 anytime) ──────────────────────────────────

test("first goalscorer: 20 for the exact first scorer", () => {
  const a = A({ cufcScore: 2, goalscorers: ["Ernest Boyers", "Cory Mitchell"], firstGoalMinute: 30 });
  assert.strictEqual(cat("firstScorer", P({ cufcScore: 2, firstScorer: "Ernest Boyers" }), a), 20);
});

test("first goalscorer: 5 when your pick scores, but not first", () => {
  const a = A({ cufcScore: 2, goalscorers: ["Ernest Boyers", "Cory Mitchell"], firstGoalMinute: 30 });
  assert.strictEqual(cat("firstScorer", P({ cufcScore: 2, firstScorer: "Cory Mitchell" }), a), 5);
});

test("first goalscorer: 0 when your pick doesn't score at all", () => {
  const a = A({ cufcScore: 2, goalscorers: ["Ernest Boyers", "Cory Mitchell"], firstGoalMinute: 30 });
  assert.strictEqual(cat("firstScorer", P({ cufcScore: 2, firstScorer: "Someone Else" }), a), 0);
});

test("first goalscorer: name matching ignores case and extra spaces", () => {
  const a = A({ cufcScore: 1, goalscorers: ["Ernest Boyers"], firstGoalMinute: 12 });
  assert.strictEqual(cat("firstScorer", P({ cufcScore: 1, firstScorer: "  ernest   BOYERS " }), a), 20);
});

test("first goalscorer: 'no goalscorer' pick wins 20 when United are kept out", () => {
  const a = A({ cufcScore: 0, opponentScore: 1, goalscorers: [] });
  assert.strictEqual(cat("firstScorer", P({ firstScorer: PREDICTOR_NO_SCORER }), a), 20);
});

test("first goalscorer: picking a player scores 0 when United are kept out", () => {
  const a = A({ cufcScore: 0, opponentScore: 1, goalscorers: [] });
  assert.strictEqual(cat("firstScorer", P({ firstScorer: "Ernest Boyers" }), a), 0);
});

test("first goalscorer: 'no goalscorer' pick scores 0 when United do score", () => {
  const a = A({ cufcScore: 1, goalscorers: ["Ernest Boyers"], firstGoalMinute: 12 });
  assert.strictEqual(cat("firstScorer", P({ cufcScore: 0, firstScorer: PREDICTOR_NO_SCORER }), a), 0);
});

test("first goalscorer: an opening own goal VOIDS the category for everyone", () => {
  const a = A({ cufcScore: 2, goalscorers: [PREDICTOR_OWN_GOAL, "Ernest Boyers"], firstGoalMinute: 20 });
  const b = scorePredictionBreakdown(P({ cufcScore: 2, firstScorer: "Ernest Boyers" }), a, ["firstScorer"]);
  assert.strictEqual(b.categories[0].status, "void");
  assert.strictEqual(b.total, 0);
  assert.strictEqual(b.maxAvailable, 0, "a void category must not count toward the maximum");
});

test("first goalscorer: an own goal is never an 'anytime' scorer", () => {
  const a = A({ cufcScore: 2, goalscorers: ["Ernest Boyers", PREDICTOR_OWN_GOAL], firstGoalMinute: 20 });
  assert.strictEqual(cat("firstScorer", P({ cufcScore: 2, firstScorer: PREDICTOR_OWN_GOAL }), a), 0);
});

// ── Minute of first goal (20 exact, ladder 10→1) ─────────────────────────────

test("first-goal minute: 20 for the exact minute", () => {
  const a = A({ cufcScore: 1, goalscorers: ["Boyers"], firstGoalMinute: 30 });
  assert.strictEqual(cat("firstGoalMinute", P({ cufcScore: 1, firstGoalMinute: 30 }), a), 20);
});

test("first-goal minute: the full Chelsea ladder, 1..10 minutes out", () => {
  const a = A({ cufcScore: 1, goalscorers: ["Boyers"], firstGoalMinute: 30 });
  const expected: Record<number, number> = { 1: 10, 2: 9, 3: 8, 4: 7, 5: 6, 6: 5, 7: 4, 8: 3, 9: 2, 10: 1 };
  for (const [miss, points] of Object.entries(expected)) {
    const m = Number(miss);
    assert.strictEqual(cat("firstGoalMinute", P({ cufcScore: 1, firstGoalMinute: 30 + m }), a), points, `+${m} min should pay ${points}`);
    assert.strictEqual(cat("firstGoalMinute", P({ cufcScore: 1, firstGoalMinute: 30 - m }), a), points, `-${m} min should pay ${points}`);
  }
});

test("first-goal minute: 0 once you are more than 10 minutes out", () => {
  const a = A({ cufcScore: 1, goalscorers: ["Boyers"], firstGoalMinute: 30 });
  assert.strictEqual(cat("firstGoalMinute", P({ cufcScore: 1, firstGoalMinute: 41 }), a), 0);
});

test("first-goal minute: VOIDS when United don't score", () => {
  const a = A({ cufcScore: 0, opponentScore: 2, goalscorers: [] });
  const b = scorePredictionBreakdown(P({ firstGoalMinute: 30 }), a, ["firstGoalMinute"]);
  assert.strictEqual(b.categories[0].status, "void");
  assert.strictEqual(b.maxAvailable, 0);
});

test("first-goal minute: VOIDS when the minute wasn't recorded", () => {
  const a = A({ cufcScore: 1, goalscorers: ["Boyers"], firstGoalMinute: null });
  const b = scorePredictionBreakdown(P({ cufcScore: 1, firstGoalMinute: 30 }), a, ["firstGoalMinute"]);
  assert.strictEqual(b.categories[0].status, "void");
});

test("first-goal minute: an own-goal opener still scores the minute", () => {
  const a = A({ cufcScore: 1, goalscorers: [PREDICTOR_OWN_GOAL], firstGoalMinute: 30 });
  assert.strictEqual(cat("firstGoalMinute", P({ cufcScore: 1, firstGoalMinute: 30 }), a), 20);
});

test("normaliseGoalMinute folds stoppage time to 45 and 90", () => {
  assert.strictEqual(normaliseGoalMinute(45, 2), 45, "45+2 → 45");
  assert.strictEqual(normaliseGoalMinute(90, 4), 90, "90+4 → 90");
  assert.strictEqual(normaliseGoalMinute(30, 0), 30);
  assert.strictEqual(normaliseGoalMinute(93, 0), 90, "clamped to 90");
  assert.strictEqual(normaliseGoalMinute(0, 0), 1, "a 0' goal is minute 1");
  assert.strictEqual(normaliseGoalMinute(null), null);
});

// ── Shots / shots on target / corners (10 / 5 / 3 / 1) ───────────────────────

for (const c of ["shots", "shotsOnTarget", "corners"] as const) {
  test(`${c}: 10 exact, 5 within 1, 3 within 2, 1 within 3, then 0`, () => {
    const a = A({ [c]: 12 } as Partial<PredictorActualResult>);
    const at = (v: number) => cat(c, P({ [c]: v } as Partial<PredictorPredictionInput>), a);
    assert.strictEqual(at(12), 10);
    assert.strictEqual(at(13), 5);
    assert.strictEqual(at(11), 5);
    assert.strictEqual(at(14), 3);
    assert.strictEqual(at(10), 3);
    assert.strictEqual(at(15), 1);
    assert.strictEqual(at(9), 1);
    assert.strictEqual(at(16), 0);
    assert.strictEqual(at(8), 0);
  });

  test(`${c}: VOIDS when nobody recorded it`, () => {
    const b = scorePredictionBreakdown(P({ [c]: 12 } as Partial<PredictorPredictionInput>), A(), [c]);
    assert.strictEqual(b.categories[0].status, "void");
    assert.strictEqual(b.maxAvailable, 0);
  });
}

// ── Possession (10 / 5 / 4 / 3 / 2 / 1) ──────────────────────────────────────

test("possession: 10 exact, then 5,4,3,2,1 for 1..5 percentage points out", () => {
  const a = A({ possession: 55 });
  const at = (v: number) => cat("possession", P({ possession: v }), a);
  assert.strictEqual(at(55), 10);
  assert.strictEqual(at(56), 5);
  assert.strictEqual(at(57), 4);
  assert.strictEqual(at(58), 3);
  assert.strictEqual(at(59), 2);
  assert.strictEqual(at(60), 1);
  assert.strictEqual(at(61), 0);
  assert.strictEqual(at(50), 1);
  assert.strictEqual(at(49), 0);
});

test("possession: VOIDS when nobody recorded it", () => {
  const b = scorePredictionBreakdown(P({ possession: 55 }), A(), ["possession"]);
  assert.strictEqual(b.categories[0].status, "void");
});

// ── Whole-match totals ───────────────────────────────────────────────────────

test("a perfect nine-category entry scores exactly 105", () => {
  const a = A({
    cufcScore: 2, opponentScore: 1, goalscorers: ["Ernest Boyers", "Cory Mitchell"],
    firstGoalMinute: 30, shots: 14, shotsOnTarget: 6, possession: 58, corners: 7,
  });
  const p = P({
    cufcScore: 2, opponentScore: 1, firstScorer: "Ernest Boyers",
    firstGoalMinute: 30, shots: 14, shotsOnTarget: 6, possession: 58, corners: 7,
  });
  const b = scorePredictionBreakdown(p, a, ALL);
  assert.strictEqual(b.total, 105);
  assert.strictEqual(b.maxAvailable, 105);
});

test("a perfect five-category (auto) entry scores exactly 65", () => {
  const a = A({ cufcScore: 2, opponentScore: 1, goalscorers: ["Ernest Boyers"], firstGoalMinute: 30 });
  const p = P({ cufcScore: 2, opponentScore: 1, firstScorer: "Ernest Boyers", firstGoalMinute: 30 });
  const b = scorePredictionBreakdown(p, a, PREDICTOR_AUTO_CATEGORIES);
  assert.strictEqual(b.total, 65);
  assert.strictEqual(b.maxAvailable, 65);
});

test("a fully wrong entry scores 0 but the maximum still stands", () => {
  const a = A({ cufcScore: 3, opponentScore: 0, goalscorers: ["Ernest Boyers"], firstGoalMinute: 80 });
  const p = P({ cufcScore: 0, opponentScore: 2, firstScorer: "Nobody Here", firstGoalMinute: 5 });
  const b = scorePredictionBreakdown(p, a, PREDICTOR_AUTO_CATEGORIES);
  assert.strictEqual(b.total, 0);
  assert.strictEqual(b.maxAvailable, 65);
});

test("a goalless draw called perfectly scores 10 + 10 + 5 + 20, minute voided", () => {
  const a = A({ cufcScore: 0, opponentScore: 0, goalscorers: [] });
  const p = P({ cufcScore: 0, opponentScore: 0, firstScorer: PREDICTOR_NO_SCORER });
  const b = scorePredictionBreakdown(p, a, PREDICTOR_AUTO_CATEGORIES);
  assert.strictEqual(b.total, 45);
  assert.strictEqual(b.maxAvailable, 45, "the voided minute must leave the maximum at 45");
});

test("only the enabled categories are scored", () => {
  const a = A({ cufcScore: 2, opponentScore: 1, goalscorers: ["Boyers"], firstGoalMinute: 30, shots: 14 });
  const p = P({ cufcScore: 2, opponentScore: 1, firstScorer: "Boyers", firstGoalMinute: 30, shots: 14 });
  const b = scorePredictionBreakdown(p, a, ["cufcGoals", "oppGoals"]);
  assert.strictEqual(b.total, 20);
  assert.strictEqual(b.categories.length, 2);
});

test("categories come back in canonical order regardless of input order", () => {
  const b = scorePredictionBreakdown(P(), A(), ["corners", "result", "cufcGoals"] as PredictorCategory[]);
  assert.deepStrictEqual(b.categories.map((c) => c.category), ["cufcGoals", "result", "corners"]);
});

// ── Fixture category parsing ─────────────────────────────────────────────────

test("parseCategories falls back to the auto set on junk input", () => {
  assert.deepStrictEqual(parseCategories(null), PREDICTOR_AUTO_CATEGORIES);
  assert.deepStrictEqual(parseCategories([]), PREDICTOR_AUTO_CATEGORIES);
  assert.deepStrictEqual(parseCategories(["nonsense"]), PREDICTOR_AUTO_CATEGORIES);
});

test("parseCategories keeps valid categories and drops invalid ones", () => {
  assert.deepStrictEqual(parseCategories(["corners", "bogus", "result"]), ["result", "corners"]);
});

// ── The deadline (kickoff − 5 minutes) ───────────────────────────────────────

test("predictions close exactly 5 minutes before kickoff", () => {
  const ko = new Date("2026-07-11T18:00:00+12:00");
  const koMs = ko.getTime();
  assert.strictEqual(PREDICTOR_LOCK_BEFORE_KICKOFF_MS, 5 * 60 * 1000);
  assert.strictEqual(predictionsClosed(ko, koMs - 5 * 60 * 1000 - 1), false, "5m01s before KO is still open");
  assert.strictEqual(predictionsClosed(ko, koMs - 5 * 60 * 1000), true, "exactly 5m before KO is closed");
  assert.strictEqual(predictionsClosed(ko, koMs), true, "kickoff is closed");
});

console.log(`\n${passed} passed`);
if (process.exitCode) console.error("SOME TESTS FAILED");
