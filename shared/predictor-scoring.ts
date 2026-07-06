/**
 * Play Predictor scoring — pure logic shared by the server (points
 * recomputation when a fixture result is entered) and anything that wants to
 * show a breakdown. Tested by script/test-predictor-scoring.ts.
 *
 * Points:
 *   - Exact score (both goals right)           → 5
 *   - Otherwise correct result (W/D/L)         → 2
 *   - Each correctly-picked goalscorer          → +1
 *     (an entrant picks up to 3 DISTINCT names; each pick earns 1 point if
 *      that player appears in the fixture's actual goalscorers list —
 *      case-insensitive name match, duplicate picks never double-count)
 */

export const PREDICTOR_POINTS = {
  exactScore: 5,
  correctResult: 2,
  perScorer: 1,
} as const;

/** Max distinct goalscorer picks per prediction. */
export const PREDICTOR_MAX_SCORERS = 3;

export interface PredictorScoreline {
  cufcScore: number;
  opponentScore: number;
  goalscorers: string[];
}

export interface PredictorScoreBreakdown {
  /** Both goal counts matched exactly. */
  exactScore: boolean;
  /** W/D/L outcome matched (true whenever exactScore is true). */
  correctResult: boolean;
  /** The entrant's picks that appear in the actual scorers list (deduped). */
  scorersMatched: string[];
  /** Points from the scoreline (5 exact / 2 result / 0). */
  scorePoints: number;
  /** Points from goalscorer picks (+1 each). */
  scorerPoints: number;
  total: number;
}

/** Normalise a name for comparison — trim, squash spaces, case-insensitive. */
function normaliseName(name: string): string {
  return String(name || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function resultOf(cufcScore: number, opponentScore: number): "W" | "D" | "L" {
  return cufcScore > opponentScore ? "W" : cufcScore < opponentScore ? "L" : "D";
}

/**
 * Full breakdown of a prediction against the actual result. Defensive on
 * input: duplicate picks are deduped case-insensitively and only the first
 * PREDICTOR_MAX_SCORERS distinct picks count.
 */
export function scorePredictionBreakdown(
  pred: PredictorScoreline,
  actual: PredictorScoreline,
): PredictorScoreBreakdown {
  const exactScore = pred.cufcScore === actual.cufcScore && pred.opponentScore === actual.opponentScore;
  const correctResult = resultOf(pred.cufcScore, pred.opponentScore) === resultOf(actual.cufcScore, actual.opponentScore);

  // Distinct picks, capped — a duplicate pick can never earn twice.
  const seen = new Set<string>();
  const picks: string[] = [];
  for (const raw of pred.goalscorers || []) {
    const key = normaliseName(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    picks.push(String(raw).trim());
    if (picks.length >= PREDICTOR_MAX_SCORERS) break;
  }

  const actualNames = new Set((actual.goalscorers || []).map(normaliseName).filter(Boolean));
  const scorersMatched = picks.filter((p) => actualNames.has(normaliseName(p)));

  const scorePoints = exactScore
    ? PREDICTOR_POINTS.exactScore
    : correctResult
      ? PREDICTOR_POINTS.correctResult
      : 0;
  const scorerPoints = scorersMatched.length * PREDICTOR_POINTS.perScorer;

  return {
    exactScore,
    correctResult,
    scorersMatched,
    scorePoints,
    scorerPoints,
    total: scorePoints + scorerPoints,
  };
}

/** Total points for a prediction against the actual result. */
export function scorePrediction(pred: PredictorScoreline, actual: PredictorScoreline): number {
  return scorePredictionBreakdown(pred, actual).total;
}
