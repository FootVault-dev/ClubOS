// Pure pricing math for MFL "stack & save" multi-team registration.
//
// No DB / Stripe / env access — just deterministic integer-cent arithmetic so it
// can be unit-tested standalone and reused by both the live-preview endpoint and
// the authoritative register endpoint. The server validates discount eligibility
// (dates / usage / org) BEFORE calling in here; this module is pure math.
//
// Invariants this module guarantees (asserted by script/test-league-pricing.ts):
//   1. Σ per-code share              == discountTotalCents   (largest-remainder)
//   2. Σ per-team discount           == orderDiscountCents   (largest-remainder)
//   3. deposit + weekly*weeksTotal   == teamTotalCents        (deposit absorbs remainder)
//   4. orderTotal == orderSubtotal - orderDiscount == Σ teamTotal

export interface DiscountRule {
  code: string;
  label?: string;
  valueType: "percentage" | "fixed";
  /** percent (e.g. 10) for "percentage"; dollars (e.g. 50) for "fixed". */
  value: number;
  combinesWithOrder: boolean;
}

export interface DiscountLine {
  code: string;
  label: string;
  valueType: "percentage" | "fixed";
  value: number;
  /** This code's share of discountTotalCents (shares sum exactly to the total). */
  amountCents: number;
}

/**
 * Additive stacking: sum the percentages, sum any fixed amounts, apply once to
 * the subtotal, cap at the subtotal. Combinability rule: to stack more than one
 * discount they must ALL set combinesWithOrder=true; if a non-combinable code is
 * present alongside others, only that one applies (it wins, on its own).
 *
 * Returns per-code shares (largest-remainder) that sum EXACTLY to
 * discountTotalCents — used for the line breakdown + per-code usage recording.
 */
export function computeOrderDiscount(
  subtotalCents: number,
  rules: DiscountRule[],
): { discountLines: DiscountLine[]; discountTotalCents: number } {
  if (subtotalCents <= 0 || rules.length === 0) {
    return { discountLines: [], discountTotalCents: 0 };
  }

  // Combinability gate.
  let applied = rules;
  if (rules.length > 1) {
    const nonComb = rules.find((r) => !r.combinesWithOrder);
    if (nonComb) applied = [nonComb];
  }

  // Additive total: Σ% then Σfixed, capped at the subtotal.
  let pctSum = 0;
  let fixedCents = 0;
  for (const r of applied) {
    if (r.valueType === "percentage") pctSum += r.value;
    else fixedCents += Math.round(r.value * 100);
  }
  if (pctSum < 0) pctSum = 0;
  if (pctSum > 100) pctSum = 100;
  let discountTotalCents = Math.round((subtotalCents * pctSum) / 100) + fixedCents;
  if (discountTotalCents > subtotalCents) discountTotalCents = subtotalCents;
  if (discountTotalCents < 0) discountTotalCents = 0;

  // Per-code share, weighted by each code's contribution, summing to the total.
  const weights = applied.map((r) =>
    r.valueType === "percentage" ? (subtotalCents * r.value) / 100 : Math.round(r.value * 100),
  );
  const shares = largestRemainder(weights, discountTotalCents);
  const discountLines: DiscountLine[] = applied.map((r, i) => ({
    code: r.code,
    label: r.label || r.code,
    valueType: r.valueType,
    value: r.value,
    amountCents: shares[i],
  }));

  return { discountLines, discountTotalCents };
}

/**
 * Split an order-level discount across teams proportional to each team's
 * subtotal, largest-remainder so the per-team discounts sum EXACTLY to
 * orderDiscountCents and never exceed an individual team's subtotal.
 */
export function distributeDiscountAcrossTeams(
  teamSubtotalsCents: number[],
  orderDiscountCents: number,
): number[] {
  const total = teamSubtotalsCents.reduce((a, b) => a + b, 0);
  if (total <= 0 || orderDiscountCents <= 0) return teamSubtotalsCents.map(() => 0);
  if (orderDiscountCents >= total) return teamSubtotalsCents.slice(); // fully discounted
  const shares = largestRemainder(teamSubtotalsCents, orderDiscountCents);
  // Safety: never let a team's discount exceed its own subtotal.
  for (let i = 0; i < shares.length; i++) {
    if (shares[i] > teamSubtotalsCents[i]) shares[i] = teamSubtotalsCents[i];
  }
  return shares;
}

export interface TeamPayment {
  paymentMode: "deposit_weekly" | "installment" | "upfront";
  depositCents: number;
  balanceCents: number;
  weeklyAmountCents: number | null;
  weeksTotal: number | null;
  isInstalment: boolean;
  isWeeklyPlan: boolean;
}

/**
 * Per-team deposit / weekly split on the team's (already discounted) total.
 * Mirrors the original single-team server logic exactly: the weekly charge is
 * even and the deposit absorbs the rounding remainder, so
 * deposit + weekly*weeksTotal == teamTotalCents to the cent.
 */
export function computeTeamPayment(
  teamTotalCents: number,
  programDepositCents: number | null,
  paymentPlan: string,
  numWeeks: number,
): TeamPayment {
  const hasDeposit = !!programDepositCents && programDepositCents > 0 && teamTotalCents > programDepositCents;
  const isWeeklyPlan = hasDeposit && paymentPlan === "deposit_weekly" && numWeeks > 0;
  const isInstalment = hasDeposit && !isWeeklyPlan;

  let depositCents = hasDeposit ? programDepositCents! : teamTotalCents;
  let weeklyAmountCents: number | null = null;
  let weeksTotal: number | null = null;
  if (isWeeklyPlan) {
    weeklyAmountCents = Math.round((teamTotalCents - programDepositCents!) / numWeeks);
    weeksTotal = numWeeks;
    depositCents = teamTotalCents - weeklyAmountCents * numWeeks;
  }
  const balanceCents = hasDeposit ? teamTotalCents - depositCents : 0;
  const paymentMode = isWeeklyPlan ? "deposit_weekly" : isInstalment ? "installment" : "upfront";
  return { paymentMode, depositCents, balanceCents, weeklyAmountCents, weeksTotal, isInstalment, isWeeklyPlan };
}

/**
 * Largest-remainder apportionment: split `totalCents` across buckets weighted by
 * `weights`, returning integer cents that sum EXACTLY to totalCents. Exported for
 * per-code usage attribution on payment success.
 */
export function apportion(weights: number[], totalCents: number): number[] {
  return largestRemainder(weights, totalCents);
}

function largestRemainder(weights: number[], totalCents: number): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const wSum = weights.reduce((a, b) => a + b, 0);
  if (wSum <= 0 || totalCents <= 0) return weights.map(() => 0);

  const raw = weights.map((w) => (totalCents * w) / wSum);
  const floors = raw.map((x) => Math.floor(x));
  let remainder = totalCents - floors.reduce((a, b) => a + b, 0);

  const byFrac = raw
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  const shares = floors.slice();
  for (let k = 0; remainder > 0 && k < byFrac.length; k++, remainder--) {
    shares[byFrac[k].i] += 1;
  }
  // If rounding somehow left remainder > buckets (can't with floors, but be safe)
  let i = 0;
  while (remainder > 0) {
    shares[byFrac[i % n].i] += 1;
    remainder--;
    i++;
  }
  return shares;
}
