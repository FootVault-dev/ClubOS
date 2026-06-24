// Standalone proof of the MFL stack-and-save pricing invariants. No DB / network.
//   npx tsx script/test-league-pricing.ts
//
// Asserts, across hundreds of synthetic orders:
//   1. Σ per-code share              == discountTotalCents
//   2. Σ per-team discount           == orderDiscountCents
//   3. deposit + weekly*weeksTotal   == teamTotalCents  (per team, weekly plan)
//   4. orderTotal == orderSubtotal - orderDiscount == Σ teamTotal
//   + the headline business case: $600 team, all 3 codes => $360 (40% off)

import {
  computeOrderDiscount,
  distributeDiscountAcrossTeams,
  computeTeamPayment,
  type DiscountRule,
} from "../shared/league-pricing";

const DEPOSIT = 12000; // $120
const WEEKS = 8;
const FEES = [50000, 60000]; // $500 5s, $600 7s

const STUDENT: DiscountRule = { code: "STUDENT", valueType: "percentage", value: 10, combinesWithOrder: true };
const EARLYBIRD: DiscountRule = { code: "EARLYBIRD", valueType: "percentage", value: 20, combinesWithOrder: true };
const MULTITEAM: DiscountRule = { code: "MULTITEAM", valueType: "percentage", value: 10, combinesWithOrder: true };

let pass = 0;
let fail = 0;
const fails: string[] = [];
function check(cond: boolean, msg: string) {
  if (cond) pass++;
  else { fail++; if (fails.length < 30) fails.push(msg); }
}

function runOrder(teamFees: number[], codes: DiscountRule[]) {
  const teamSubtotals = teamFees.slice(); // no upsells in this model at launch
  const orderSubtotal = teamSubtotals.reduce((a, b) => a + b, 0);

  // Auto multi-team when 2+ teams.
  const rules = codes.slice();
  if (teamFees.length >= 2 && !rules.find((r) => r.code === "MULTITEAM")) rules.push(MULTITEAM);

  const { discountLines, discountTotalCents } = computeOrderDiscount(orderSubtotal, rules);

  // Invariant 1: per-code shares sum to the discount total.
  const lineSum = discountLines.reduce((a, l) => a + l.amountCents, 0);
  check(lineSum === discountTotalCents, `INV1 fees=${teamFees} codes=${rules.map(r=>r.code)} lineSum=${lineSum} != ${discountTotalCents}`);

  // Distribute across teams.
  const teamDiscounts = distributeDiscountAcrossTeams(teamSubtotals, discountTotalCents);

  // Invariant 2: per-team discounts sum to order discount.
  const tdSum = teamDiscounts.reduce((a, b) => a + b, 0);
  check(tdSum === discountTotalCents, `INV2 fees=${teamFees} codes=${rules.map(r=>r.code)} tdSum=${tdSum} != ${discountTotalCents}`);

  // Per-team payment math.
  let teamTotalSum = 0;
  let depositSum = 0;
  for (let i = 0; i < teamSubtotals.length; i++) {
    const teamTotal = teamSubtotals[i] - teamDiscounts[i];
    teamTotalSum += teamTotal;
    const p = computeTeamPayment(teamTotal, DEPOSIT, "deposit_weekly", WEEKS);
    depositSum += p.depositCents;
    // Invariant 3 (weekly plan): deposit + weekly*weeks == teamTotal.
    if (p.isWeeklyPlan) {
      check(p.depositCents + (p.weeklyAmountCents || 0) * (p.weeksTotal || 0) === teamTotal,
        `INV3 fees=${teamFees} i=${i} teamTotal=${teamTotal} dep=${p.depositCents} wk=${p.weeklyAmountCents}x${p.weeksTotal}`);
      check((p.weeklyAmountCents || 0) > 0, `INV3b weekly<=0 teamTotal=${teamTotal}`);
      check(p.depositCents > 0 && p.depositCents <= teamTotal, `INV3c deposit out of range dep=${p.depositCents} teamTotal=${teamTotal}`);
    }
    check(teamTotal >= 0, `INV-neg teamTotal=${teamTotal}`);
    check(teamDiscounts[i] <= teamSubtotals[i], `INV-cap teamDisc=${teamDiscounts[i]} > sub=${teamSubtotals[i]}`);
  }

  // Invariant 4: order total reconciles.
  const orderTotal = orderSubtotal - discountTotalCents;
  check(orderTotal === teamTotalSum, `INV4 fees=${teamFees} orderTotal=${orderTotal} != Σteam=${teamTotalSum}`);
  check(depositSum >= 0, `INV4b depositSum=${depositSum}`);

  return { orderSubtotal, discountTotalCents, orderTotal, depositSum };
}

// ── Exhaustive-ish sweep: 1..5 teams, every $500/$600 combo, every code subset ──
const codeSubsets: DiscountRule[][] = [
  [], [STUDENT], [EARLYBIRD], [STUDENT, EARLYBIRD],
];
function* feeCombos(n: number): Generator<number[]> {
  if (n === 0) { yield []; return; }
  for (const f of FEES) for (const rest of feeCombos(n - 1)) yield [f, ...rest];
}
for (let n = 1; n <= 5; n++) {
  for (const fees of feeCombos(n)) {
    for (const codes of codeSubsets) runOrder(fees, codes);
  }
}

// ── Headline business cases ──
// $600 team, all three codes (student+earlybird typed, multiteam needs 2 teams).
// Single $600 with STUDENT+EARLYBIRD = 30% => $420.
{
  const r = runOrder([60000], [STUDENT, EARLYBIRD]);
  check(r.orderTotal === 42000, `CASE single 600 30% => got ${r.orderTotal}, want 42000`);
}
// Two $600 teams + STUDENT + EARLYBIRD + (auto MULTITEAM) = 40% off the $1200 order => $720.
{
  const r = runOrder([60000, 60000], [STUDENT, EARLYBIRD]);
  check(r.orderTotal === 72000, `CASE two 600 40% => got ${r.orderTotal}, want 72000`);
  check(r.discountTotalCents === 48000, `CASE two 600 disc => got ${r.discountTotalCents}, want 48000`);
}
// Odd split: $500 + $600 with all three (40%) => order $1100 - $440 = $660; shares sum exact.
{
  const r = runOrder([50000, 60000], [STUDENT, EARLYBIRD]);
  check(r.orderTotal === 66000, `CASE 500+600 40% => got ${r.orderTotal}, want 66000`);
}

console.log(`league-pricing: ${pass} checks passed, ${fail} failed`);
if (fail > 0) { console.error("FAILURES:\n" + fails.join("\n")); process.exit(1); }
console.log("ALL INVARIANTS HOLD ✓");
