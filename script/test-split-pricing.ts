// Standalone proof of the Split Pay equal-split invariants. No DB / network.
//   npx tsx script/test-split-pricing.ts
//
// Asserts, across every fee × headcount in range plus the headline cases:
//   5. Σ equalSplit(total, n)        == total          (largest-remainder, n>=1)
//   6. max(share) - min(share)       <= 1 cent         (as even as cents allow)
//   7. provisionalShareCents(total,n)== max(share)     (display never understates)
//   + re-split stays exact as the roster changes (fixed total, varying n)
//   + headline cases: $600/10=$60, $600/8=$75, $600/12=$50, $500/3 sums exact

import { equalSplit, provisionalShareCents } from "../shared/league-pricing";

let pass = 0;
let fail = 0;
const fails: string[] = [];
function check(cond: boolean, msg: string) {
  if (cond) pass++;
  else { fail++; if (fails.length < 30) fails.push(msg); }
}

function runSplit(totalCents: number, n: number) {
  const shares = equalSplit(totalCents, n);

  // Invariant 5: shares sum to the fee exactly (club always collects the full fee).
  const sum = shares.reduce((a, b) => a + b, 0);
  check(sum === totalCents, `INV5 total=${totalCents} n=${n} sum=${sum} != ${totalCents}`);

  // Right count, all positive (for total>0), integer cents.
  check(shares.length === n, `LEN total=${totalCents} n=${n} got ${shares.length}`);
  for (const s of shares) {
    check(Number.isInteger(s), `INT total=${totalCents} n=${n} share=${s}`);
    check(s >= 0, `NEG total=${totalCents} n=${n} share=${s}`);
  }

  if (n > 0 && totalCents > 0) {
    const max = Math.max(...shares);
    const min = Math.min(...shares);
    // Invariant 6: as even as integer cents allow.
    check(max - min <= 1, `INV6 total=${totalCents} n=${n} spread=${max - min}`);
    // Invariant 7: provisional display == largest actual share (never understates).
    const prov = provisionalShareCents(totalCents, n);
    check(prov === max, `INV7 total=${totalCents} n=${n} prov=${prov} != max=${max}`);
    for (const s of shares) check(s <= prov, `INV7b share ${s} > prov ${prov}`);
  }
  return shares;
}

// ── Sweep: every realistic fee, every headcount 1..40 ──
const FEES = [50000, 60000, 49900, 59900, 99000, 120000, 75000, 100, 333, 1]; // incl. odd/edge totals
for (const fee of FEES) {
  for (let n = 1; n <= 40; n++) runSplit(fee, n);
}

// ── Re-split stays exact as the roster changes (fixed total, varying n) ──
// This IS the "someone drops / is added" contingency before lock: the live share
// recomputes but always reconciles to the fixed fee.
for (const fee of [60000, 50000, 59900]) {
  for (const n of [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]) {
    const shares = runSplit(fee, n);
    check(shares.reduce((a, b) => a + b, 0) === fee, `RESPLIT fee=${fee} n=${n} drift`);
  }
}

// ── Edge cases ──
check(equalSplit(60000, 0).length === 0, "EDGE n=0 => []");
check(equalSplit(60000, 1)[0] === 60000, "EDGE n=1 => [total]");
check(provisionalShareCents(60000, 0) === 0, "EDGE prov n=0 => 0");
check(equalSplit(0, 5).every((s) => s === 0), "EDGE total=0 => all 0");

// ── Headline business cases (the ones in the plan) ──
{
  const s = equalSplit(60000, 10); // $600 / 10
  check(s.every((x) => x === 6000) && s.length === 10, `CASE 600/10 => want 10×$60, got ${s}`);
}
{
  const s = equalSplit(60000, 8); // $600 / 8 (re-split UP after 2 drop)
  check(s.every((x) => x === 7500) && s.length === 8, `CASE 600/8 => want 8×$75, got ${s}`);
}
{
  const s = equalSplit(60000, 12); // $600 / 12 (re-split DOWN after 2 added)
  check(s.every((x) => x === 5000) && s.length === 12, `CASE 600/12 => want 12×$50, got ${s}`);
}
{
  const s = equalSplit(50000, 3); // $500 / 3 — uneven, must still sum to $500
  check(s.reduce((a, b) => a + b, 0) === 50000, `CASE 500/3 sum => ${s}`);
  check(Math.max(...s) - Math.min(...s) <= 1, `CASE 500/3 spread => ${s}`);
}

console.log(`split-pricing: ${pass} checks passed, ${fail} failed`);
if (fail > 0) { console.error("FAILURES:\n" + fails.join("\n")); process.exit(1); }
console.log("ALL INVARIANTS HOLD ✓");
