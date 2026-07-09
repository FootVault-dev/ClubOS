/**
 * Play Predictor scoring — a faithful implementation of the Chelsea FC Play
 * Predictor scoring system ("Annex 2 – Scoring System" of their T&Cs), applied
 * to the Christchurch United first team.
 *
 * Pure, deterministic and server-authoritative. Shared by the ClubOS server
 * (points recomputation when a result is entered) and the CUFC website (live
 * "points available" readout and the post-match breakdown).
 * Tested by script/test-predictor-scoring.ts.
 *
 * ── The nine categories (verbatim point values) ───────────────────────────────
 *   cufcGoals        10 exact
 *   oppGoals         10 exact
 *   result            5 correct win/draw/loss
 *   firstScorer      20 exact · 5 if that player scores anytime in the match
 *   firstGoalMinute  20 exact · then 10,9,8,7,6,5,4,3,2,1 for within 1..10 min
 *   shots            10 exact · 5 within 1 · 3 within 2 · 1 within 3
 *   shotsOnTarget    10 exact · 5 within 1 · 3 within 2 · 1 within 3
 *   possession       10 exact · 5 within 1pp · 4 within 2 · 3 within 3 · 2 within 4 · 1 within 5
 *   corners          10 exact · 5 within 1 · 3 within 2 · 1 within 3
 *   → 105 points maximum per match with every category live.
 *
 * ── Why categories are switchable ────────────────────────────────────────────
 * Chelsea's game is fed by Opta. New Zealand football has no equivalent: the
 * Mainland Football / NZ Football (Sporty) systems publish goals, scorers and
 * goal minutes, but shots, shots on target, possession and corners are never
 * recorded — not merely unpublished (verified 2026-07-09 by probing the
 * match-centre API and decompiling its own widget bundle).
 *
 * So each fixture declares which categories are live. A category that is not
 * enabled is never asked for and never scored. A category that IS enabled but
 * whose actual value is missing at result time is VOIDED: it scores zero for
 * everybody and is excluded from the match maximum, so nobody is punished for
 * data we failed to capture. This mirrors Chelsea's own rule that a cancelled
 * match awards no points rather than awarding wrong ones.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Categories
// ─────────────────────────────────────────────────────────────────────────────

export const PREDICTOR_CATEGORIES = [
  "cufcGoals",
  "oppGoals",
  "result",
  "firstScorer",
  "firstGoalMinute",
  "shots",
  "shotsOnTarget",
  "possession",
  "corners",
] as const;

export type PredictorCategory = (typeof PREDICTOR_CATEGORIES)[number];

/**
 * The categories we can settle from published data (Mainland Football's
 * match-centre timeline + line-up). On by default for every fixture.
 */
export const PREDICTOR_AUTO_CATEGORIES: PredictorCategory[] = [
  "cufcGoals",
  "oppGoals",
  "result",
  "firstScorer",
  "firstGoalMinute",
];

/**
 * Chelsea's remaining four. No NZ data source records them, so they only score
 * if a staff member logs them after the match. Off unless a fixture opts in.
 */
export const PREDICTOR_MANUAL_CATEGORIES: PredictorCategory[] = [
  "shots",
  "shotsOnTarget",
  "possession",
  "corners",
];

/** Maximum points each category can pay. Sums to 105 across all nine. */
export const PREDICTOR_CATEGORY_MAX: Record<PredictorCategory, number> = {
  cufcGoals: 10,
  oppGoals: 10,
  result: 5,
  firstScorer: 20,
  firstGoalMinute: 20,
  shots: 10,
  shotsOnTarget: 10,
  possession: 10,
  corners: 10,
};

export const PREDICTOR_CATEGORY_LABEL: Record<PredictorCategory, string> = {
  cufcGoals: "Christchurch United goals",
  oppGoals: "Opposition goals",
  result: "Correct result",
  firstScorer: "First United goalscorer",
  firstGoalMinute: "Minute of United's first goal",
  shots: "United shots",
  shotsOnTarget: "United shots on target",
  possession: "United possession %",
  corners: "United corners",
};

/**
 * Sentinel a fan picks to say "Christchurch United will not score". It wins the
 * full 20 when United are kept out. Chelsea's T&Cs are silent on a goalless
 * game; without this, a 0-x prediction has no scorer pick to make.
 */
export const PREDICTOR_NO_SCORER = "__NO_SCORER__";

/**
 * Sentinel the admin records when United's first goal was an own goal by the
 * opposition. It counts on the scoreboard but has no United scorer, so the
 * firstScorer category voids for that fixture. The minute still scores.
 */
export const PREDICTOR_OWN_GOAL = "__OWN_GOAL__";

/** Sanity bounds — also enforced at the API boundary. */
export const PREDICTOR_LIMITS = {
  maxGoals: 20,
  minMinute: 1,
  maxMinute: 90,
  maxShots: 60,
  maxShotsOnTarget: 40,
  maxCorners: 30,
} as const;

/**
 * Predictions lock five minutes before kickoff — Chelsea's deadline, verbatim:
 * "5 minutes before kick-off of the applicable match."
 */
export const PREDICTOR_LOCK_BEFORE_KICKOFF_MS = 5 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Proximity ladders — [maximum absolute miss, points awarded], best first.
// ─────────────────────────────────────────────────────────────────────────────

type Ladder = ReadonlyArray<readonly [number, number]>;

/** 20 exact, then 10 down to 1 for each further minute out, up to 10 minutes. */
const MINUTE_LADDER: Ladder = [
  [0, 20], [1, 10], [2, 9], [3, 8], [4, 7], [5, 6], [6, 5], [7, 4], [8, 3], [9, 2], [10, 1],
];

/** Shots, shots on target and corners all share this ladder. */
const COUNT_LADDER: Ladder = [[0, 10], [1, 5], [2, 3], [3, 1]];

/** Possession is graded in percentage points. */
const POSSESSION_LADDER: Ladder = [[0, 10], [1, 5], [2, 4], [3, 3], [4, 2], [5, 1]];

function ladderPoints(predicted: number, actual: number, ladder: Ladder): number {
  const miss = Math.abs(predicted - actual);
  for (const [within, points] of ladder) {
    if (miss <= within) return points;
  }
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────

/** What a fan submits. Fields for disabled categories may be null. */
export interface PredictorPredictionInput {
  cufcScore: number;
  opponentScore: number;
  /** A squad player's name, or PREDICTOR_NO_SCORER. */
  firstScorer: string | null;
  firstGoalMinute: number | null;
  shots: number | null;
  shotsOnTarget: number | null;
  possession: number | null;
  corners: number | null;
}

/** What actually happened, as recorded by an admin or synced from the feed. */
export interface PredictorActualResult {
  cufcScore: number;
  opponentScore: number;
  /**
   * Every United goal, in the order they were scored. Use PREDICTOR_OWN_GOAL
   * for an opposition own goal. Empty when United fail to score.
   */
  goalscorers: string[];
  /** Minute of United's first goal (stoppage time folded to 45 or 90). */
  firstGoalMinute: number | null;
  shots: number | null;
  shotsOnTarget: number | null;
  possession: number | null;
  corners: number | null;
}

export type PredictorCategoryStatus = "scored" | "void";

export interface PredictorCategoryResult {
  category: PredictorCategory;
  status: PredictorCategoryStatus;
  points: number;
  /** Points this category contributed to the match maximum (0 when void). */
  max: number;
  /** Plain-English explanation, safe to show a fan. */
  detail: string;
}

export interface PredictorScoreBreakdown {
  total: number;
  /** Sum of `max` across non-void categories — what a perfect entry would score. */
  maxAvailable: number;
  categories: PredictorCategoryResult[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Trim, squash internal whitespace, lowercase. Sentinels pass through intact. */
function normaliseName(name: string): string {
  return String(name ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function sameName(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return normaliseName(a) === normaliseName(b);
}

export function resultOf(cufcScore: number, opponentScore: number): "W" | "D" | "L" {
  return cufcScore > opponentScore ? "W" : cufcScore < opponentScore ? "L" : "D";
}

export const PREDICTOR_RESULT_LABEL: Record<"W" | "D" | "L", string> = {
  W: "United win",
  D: "Draw",
  L: "United lose",
};

/**
 * Chelsea, verbatim: "If a goal is scored in stoppage time, such goal will be
 * recorded as being scored on 45+ or 90+ minutes as applicable." We fold
 * first-half stoppage to 45 and second-half stoppage to 90, so a 45+2' goal and
 * a 45' goal are the same answer.
 */
export function normaliseGoalMinute(minute: number | null | undefined, stoppage?: number | null): number | null {
  if (minute == null || !Number.isFinite(minute)) return null;
  const base = Math.round(minute);
  if (base <= 0) return PREDICTOR_LIMITS.minMinute;
  if ((stoppage ?? 0) > 0) {
    // A stoppage-time goal belongs to the end of its half.
    return base <= 45 ? 45 : PREDICTOR_LIMITS.maxMinute;
  }
  return Math.min(base, PREDICTOR_LIMITS.maxMinute);
}

/** United players who scored at any point (own goals excluded — not a United scorer). */
function anytimeScorers(actual: PredictorActualResult): Set<string> {
  return new Set(
    (actual.goalscorers || [])
      .filter((n) => n && n !== PREDICTOR_OWN_GOAL)
      .map(normaliseName),
  );
}

/** The first United goal's scorer: a player name, PREDICTOR_OWN_GOAL, or null. */
function firstScorerOf(actual: PredictorActualResult): string | null {
  const list = (actual.goalscorers || []).filter(Boolean);
  return list.length > 0 ? list[0] : null;
}

/** Total points a perfect entry could score given the enabled categories. */
export function predictorMaxPoints(enabled: PredictorCategory[]): number {
  return enabled.reduce((sum, c) => sum + (PREDICTOR_CATEGORY_MAX[c] ?? 0), 0);
}

/** Every category, in canonical display order, filtered to those enabled. */
export function orderCategories(enabled: PredictorCategory[]): PredictorCategory[] {
  const set = new Set(enabled);
  return PREDICTOR_CATEGORIES.filter((c) => set.has(c));
}

/** Parse whatever is stored in the fixture's `categories` column into a safe list. */
export function parseCategories(raw: unknown): PredictorCategory[] {
  if (!Array.isArray(raw)) return [...PREDICTOR_AUTO_CATEGORIES];
  const valid = raw.filter((c): c is PredictorCategory =>
    typeof c === "string" && (PREDICTOR_CATEGORIES as readonly string[]).includes(c));
  return valid.length > 0 ? orderCategories(valid) : [...PREDICTOR_AUTO_CATEGORIES];
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-category scoring
// ─────────────────────────────────────────────────────────────────────────────

const VOID = (category: PredictorCategory, detail: string): PredictorCategoryResult =>
  ({ category, status: "void", points: 0, max: 0, detail });

const SCORED = (category: PredictorCategory, points: number, detail: string): PredictorCategoryResult =>
  ({ category, status: "scored", points, max: PREDICTOR_CATEGORY_MAX[category], detail });

function scoreCategory(
  category: PredictorCategory,
  pred: PredictorPredictionInput,
  actual: PredictorActualResult,
): PredictorCategoryResult {
  switch (category) {
    case "cufcGoals": {
      const hit = pred.cufcScore === actual.cufcScore;
      return SCORED("cufcGoals", hit ? 10 : 0, hit
        ? `United scored ${actual.cufcScore} — called it.`
        : `You said ${pred.cufcScore}, United scored ${actual.cufcScore}.`);
    }

    case "oppGoals": {
      const hit = pred.opponentScore === actual.opponentScore;
      return SCORED("oppGoals", hit ? 10 : 0, hit
        ? `The opposition scored ${actual.opponentScore} — called it.`
        : `You said ${pred.opponentScore}, they scored ${actual.opponentScore}.`);
    }

    case "result": {
      const predResult = resultOf(pred.cufcScore, pred.opponentScore);
      const realResult = resultOf(actual.cufcScore, actual.opponentScore);
      const hit = predResult === realResult;
      return SCORED("result", hit ? 5 : 0, hit
        ? `${PREDICTOR_RESULT_LABEL[realResult]} — right call.`
        : `You called ${PREDICTOR_RESULT_LABEL[predResult].toLowerCase()}, it was ${PREDICTOR_RESULT_LABEL[realResult].toLowerCase()}.`);
    }

    case "firstScorer": {
      const first = firstScorerOf(actual);

      // United kept out — the "no goalscorer" pick is the winning answer.
      if (actual.cufcScore === 0 || first === null) {
        if (pred.firstScorer === PREDICTOR_NO_SCORER) {
          return SCORED("firstScorer", 20, "You called United to be kept out. They were.");
        }
        return SCORED("firstScorer", 0, "United didn't score, so no goalscorer landed.");
      }

      // An own goal opened the scoring — there was no United scorer to pick.
      if (first === PREDICTOR_OWN_GOAL) {
        return VOID("firstScorer", "United's first goal was an own goal, so this category was voided for everyone.");
      }

      if (!pred.firstScorer || pred.firstScorer === PREDICTOR_NO_SCORER) {
        return SCORED("firstScorer", 0, `You called United to be kept out. ${first} opened the scoring.`);
      }

      if (sameName(pred.firstScorer, first)) {
        return SCORED("firstScorer", 20, `${first} scored first — exactly as you called it.`);
      }

      if (anytimeScorers(actual).has(normaliseName(pred.firstScorer))) {
        return SCORED("firstScorer", 5, `${pred.firstScorer} scored, but ${first} got there first.`);
      }

      return SCORED("firstScorer", 0, `${first} scored first. ${pred.firstScorer} didn't score.`);
    }

    case "firstGoalMinute": {
      if (actual.cufcScore === 0) {
        return VOID("firstGoalMinute", "United didn't score, so there was no first-goal minute to call.");
      }
      if (actual.firstGoalMinute == null) {
        return VOID("firstGoalMinute", "The minute of United's first goal wasn't recorded, so this category was voided.");
      }
      if (pred.firstGoalMinute == null) {
        return SCORED("firstGoalMinute", 0, `You didn't call a minute. United scored on ${actual.firstGoalMinute}'.`);
      }
      const points = ladderPoints(pred.firstGoalMinute, actual.firstGoalMinute, MINUTE_LADDER);
      const miss = Math.abs(pred.firstGoalMinute - actual.firstGoalMinute);
      return SCORED("firstGoalMinute", points, miss === 0
        ? `Bang on — United scored on ${actual.firstGoalMinute}'.`
        : `You said ${pred.firstGoalMinute}', they scored on ${actual.firstGoalMinute}' — ${miss} minute${miss === 1 ? "" : "s"} out.`);
    }

    case "shots":
    case "shotsOnTarget":
    case "corners": {
      const actualValue = actual[category];
      if (actualValue == null) {
        return VOID(category, `${PREDICTOR_CATEGORY_LABEL[category]} wasn't recorded for this match, so this category was voided.`);
      }
      const predValue = pred[category];
      if (predValue == null) {
        return SCORED(category, 0, `You didn't make a call. The answer was ${actualValue}.`);
      }
      const points = ladderPoints(predValue, actualValue, COUNT_LADDER);
      const miss = Math.abs(predValue - actualValue);
      return SCORED(category, points, miss === 0
        ? `Exactly ${actualValue} — called it.`
        : `You said ${predValue}, it was ${actualValue}.`);
    }

    case "possession": {
      if (actual.possession == null) {
        return VOID("possession", "Possession wasn't recorded for this match, so this category was voided.");
      }
      if (pred.possession == null) {
        return SCORED("possession", 0, `You didn't make a call. United had ${actual.possession}%.`);
      }
      const points = ladderPoints(pred.possession, actual.possession, POSSESSION_LADDER);
      const miss = Math.abs(pred.possession - actual.possession);
      return SCORED("possession", points, miss === 0
        ? `Exactly ${actual.possession}% — called it.`
        : `You said ${pred.possession}%, United had ${actual.possession}%.`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Score one prediction against the actual result, over the fixture's enabled
 * categories. Void categories contribute 0 points and 0 to `maxAvailable`.
 */
export function scorePredictionBreakdown(
  pred: PredictorPredictionInput,
  actual: PredictorActualResult,
  enabled: PredictorCategory[] = PREDICTOR_AUTO_CATEGORIES,
): PredictorScoreBreakdown {
  const categories = orderCategories(enabled).map((c) => scoreCategory(c, pred, actual));
  return {
    total: categories.reduce((sum, c) => sum + c.points, 0),
    maxAvailable: categories.reduce((sum, c) => sum + c.max, 0),
    categories,
  };
}

/** Total points only. */
export function scorePrediction(
  pred: PredictorPredictionInput,
  actual: PredictorActualResult,
  enabled: PredictorCategory[] = PREDICTOR_AUTO_CATEGORIES,
): number {
  return scorePredictionBreakdown(pred, actual, enabled).total;
}

/** True once predictions have closed for a kickoff (Chelsea: KO − 5 minutes). */
export function predictionsClosed(kickoffAt: Date | string | number, now: number = Date.now()): boolean {
  const ko = kickoffAt instanceof Date ? kickoffAt.getTime() : new Date(kickoffAt).getTime();
  return now >= ko - PREDICTOR_LOCK_BEFORE_KICKOFF_MS;
}

/** Milliseconds until predictions close (negative once closed). */
export function msUntilLock(kickoffAt: Date | string | number, now: number = Date.now()): number {
  const ko = kickoffAt instanceof Date ? kickoffAt.getTime() : new Date(kickoffAt).getTime();
  return ko - PREDICTOR_LOCK_BEFORE_KICKOFF_MS - now;
}
