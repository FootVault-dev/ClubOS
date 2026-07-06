// Play Predictor scoring tests — plain tsx + node assert (same pattern as
// script/test-league-pricing.ts). Run: npx tsx script/test-predictor-scoring.ts
import assert from "node:assert";
import { scorePrediction, scorePredictionBreakdown, PREDICTOR_MAX_SCORERS } from "../shared/predictor-scoring";

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

const pred = (cufcScore: number, opponentScore: number, goalscorers: string[] = []) =>
  ({ cufcScore, opponentScore, goalscorers });

console.log("predictor-scoring");

test("exact score = 5", () => {
  assert.strictEqual(scorePrediction(pred(2, 1), pred(2, 1)), 5);
});

test("exact 0-0 draw = 5", () => {
  assert.strictEqual(scorePrediction(pred(0, 0), pred(0, 0)), 5);
});

test("correct result only (win) = 2", () => {
  assert.strictEqual(scorePrediction(pred(3, 1), pred(2, 0)), 2);
});

test("correct result only (draw) = 2", () => {
  assert.strictEqual(scorePrediction(pred(1, 1), pred(2, 2)), 2);
});

test("correct result only (loss) = 2", () => {
  assert.strictEqual(scorePrediction(pred(0, 1), pred(1, 3)), 2);
});

test("wrong result = 0", () => {
  assert.strictEqual(scorePrediction(pred(2, 1), pred(0, 1)), 0);
});

test("exact score never stacks with the result bonus", () => {
  const b = scorePredictionBreakdown(pred(2, 1), pred(2, 1));
  assert.strictEqual(b.exactScore, true);
  assert.strictEqual(b.correctResult, true);
  assert.strictEqual(b.scorePoints, 5); // 5, not 5 + 2
});

test("+1 per correctly-picked goalscorer, even on a wrong result", () => {
  const actual = pred(0, 2, ["Willem Ebbinge"]);
  assert.strictEqual(scorePrediction(pred(2, 0, ["Willem Ebbinge"]), actual), 1);
});

test("multiple correct scorers each earn a point", () => {
  const actual = pred(3, 1, ["Willem Ebbinge", "Joel Peterson", "Max Hall"]);
  assert.strictEqual(scorePrediction(pred(1, 2, ["Willem Ebbinge", "Joel Peterson"]), actual), 2);
});

test("exact score + scorers stack", () => {
  const actual = pred(2, 1, ["Willem Ebbinge", "Joel Peterson"]);
  assert.strictEqual(scorePrediction(pred(2, 1, ["Willem Ebbinge", "Joel Peterson"]), actual), 7);
});

test("correct result + one scorer = 3", () => {
  const actual = pred(2, 0, ["Willem Ebbinge", "Joel Peterson"]);
  assert.strictEqual(scorePrediction(pred(1, 0, ["Willem Ebbinge"]), actual), 3);
});

test("scorer match is case-insensitive (and whitespace-tolerant)", () => {
  const actual = pred(1, 0, ["Willem Ebbinge"]);
  assert.strictEqual(scorePrediction(pred(1, 0, ["  willem   EBBINGE "]), actual), 6);
});

test("duplicate picks of the same scorer never double-count", () => {
  const actual = pred(1, 0, ["Willem Ebbinge"]);
  const b = scorePredictionBreakdown(pred(0, 1, ["Willem Ebbinge", "willem ebbinge", "WILLEM EBBINGE"]), actual);
  assert.strictEqual(b.scorerPoints, 1);
  assert.deepStrictEqual(b.scorersMatched, ["Willem Ebbinge"]);
});

test("a scorer with a brace still only earns 1 point per pick", () => {
  const actual = pred(2, 0, ["Willem Ebbinge", "Willem Ebbinge"]);
  const b = scorePredictionBreakdown(pred(0, 0, ["Willem Ebbinge"]), actual);
  assert.strictEqual(b.scorerPoints, 1);
});

test(`only the first ${PREDICTOR_MAX_SCORERS} distinct picks count`, () => {
  const actual = pred(0, 0, ["Fourth Pick"]);
  // 4 distinct picks — the 4th (the only correct one) is over the cap.
  const b = scorePredictionBreakdown(pred(1, 1, ["A One", "B Two", "C Three", "Fourth Pick"]), actual);
  assert.strictEqual(b.scorerPoints, 0);
});

test("empty / blank picks are ignored", () => {
  const actual = pred(1, 0, ["Willem Ebbinge"]);
  assert.strictEqual(scorePrediction(pred(0, 0, ["", "   "]), actual), 0);
});

test("no picks + exact score = 5", () => {
  assert.strictEqual(scorePrediction(pred(4, 2, []), pred(4, 2, ["Willem Ebbinge"])), 5);
});

if (process.exitCode) {
  console.error("\n✗ predictor-scoring tests FAILED");
} else {
  console.log(`\n✓ all ${passed} predictor-scoring tests passed`);
}
