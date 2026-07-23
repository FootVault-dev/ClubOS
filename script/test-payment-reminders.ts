// Pure tests for the missed-payment derivation (shared/league-weekly.ts).
// No DB, no Stripe. Run: npx tsx script/test-payment-reminders.ts
import { missedPayments, weeklyAnchorMs, subscriptionIdFromInvoice } from "../shared/league-weekly";

let passed = 0, failed = 0;
function eq(name: string, got: any, want: any) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { passed++; } else { failed++; console.error(`✗ ${name}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`); }
}

const D = (iso: string) => new Date(iso + "T00:00:00Z").getTime();

// ── weeklyAnchorMs ────────────────────────────────────────────────────────────
eq("anchor: stored date wins", weeklyAnchorMs({ weeklyFirstChargeDate: "2026-07-22", compStartDate: "2026-07-20", registeredAt: "2026-07-01T00:00:00Z" }), D("2026-07-22"));
eq("anchor: early signup falls back to comp start", weeklyAnchorMs({ weeklyFirstChargeDate: null, compStartDate: "2026-07-20", registeredAt: "2026-07-01T00:00:00Z" }), D("2026-07-20"));
eq("anchor: LATE signup anchors at signup+2d, not comp start", weeklyAnchorMs({ weeklyFirstChargeDate: null, compStartDate: "2026-07-20", registeredAt: "2026-07-22T00:00:00Z" }), D("2026-07-24"));
eq("anchor: nothing known → null", weeklyAnchorMs({ weeklyFirstChargeDate: null, compStartDate: null, registeredAt: null }), null);

// ── weekly plans ─────────────────────────────────────────────────────────────
const weekly = {
  status: "confirmed", paymentMode: "deposit_weekly",
  weeksTotal: 8, weeksPaid: 0, weeklyAmountCents: 4750,
  weeklyFirstChargeDate: "2026-07-20", compStartDate: "2026-07-20", registeredAt: "2026-07-13T00:00:00Z",
};

// Before the first charge is due: nothing missed, full payoff.
eq("weekly: pre-start → nothing missed",
  missedPayments({ ...weekly, nowMs: D("2026-07-19") }),
  { missedCount: 0, missedCents: 0, payoffCents: 8 * 4750, kind: null });

// Due day itself gets grace (strictly past-due, matches the breakdown's <).
eq("weekly: due day itself is not yet missed",
  missedPayments({ ...weekly, nowMs: D("2026-07-20") }),
  { missedCount: 0, missedCents: 0, payoffCents: 8 * 4750, kind: null });

// 3 weeks due (20 Jul, 27 Jul, 3 Aug), 1 paid → 2 missed.
eq("weekly: 3 due, 1 paid → 2 missed",
  missedPayments({ ...weekly, weeksPaid: 1, nowMs: D("2026-08-05") }),
  { missedCount: 2, missedCents: 9500, payoffCents: 7 * 4750, kind: "weekly_missed" });

// Same date, up to date → nothing missed.
eq("weekly: on schedule → nothing missed",
  missedPayments({ ...weekly, weeksPaid: 3, nowMs: D("2026-08-05") }),
  { missedCount: 0, missedCents: 0, payoffCents: 5 * 4750, kind: null });

// Fully paid → nothing, zero payoff.
eq("weekly: fully paid",
  missedPayments({ ...weekly, weeksPaid: 8, nowMs: D("2026-12-01") }),
  { missedCount: 0, missedCents: 0, payoffCents: 0, kind: null });

// Every week past-due and none paid → all 8 missed (never more than weeksTotal).
eq("weekly: long past the end caps at weeksTotal",
  missedPayments({ ...weekly, weeksPaid: 0, nowMs: D("2027-06-01") }),
  { missedCount: 8, missedCents: 8 * 4750, payoffCents: 8 * 4750, kind: "weekly_missed" });

// Late registrant WITHOUT a stored anchor: comp start 20 Jul, signed up 22 Jul
// → first charge 24 Jul; on 23 Jul nothing is missed (comp-start maths would
// have wrongly flagged one).
eq("weekly: late registrant not falsely flagged",
  missedPayments({ ...weekly, weeklyFirstChargeDate: null, registeredAt: "2026-07-22T00:00:00Z", nowMs: D("2026-07-23") }),
  { missedCount: 0, missedCents: 0, payoffCents: 8 * 4750, kind: null });

// No anchor at all → report nothing missed rather than invent an overdue.
eq("weekly: unknowable schedule → nothing missed",
  missedPayments({ ...weekly, weeklyFirstChargeDate: null, compStartDate: null, registeredAt: null, nowMs: D("2026-08-05") }),
  { missedCount: 0, missedCents: 0, payoffCents: 8 * 4750, kind: null });

// Refunded team never flags.
eq("weekly: refunded → nothing",
  missedPayments({ ...weekly, status: "refunded", weeksPaid: 0, nowMs: D("2026-12-01") }),
  { missedCount: 0, missedCents: 0, payoffCents: 0, kind: null });

// ── instalments ──────────────────────────────────────────────────────────────
eq("installment: failed balance → 1 missed",
  missedPayments({ status: "confirmed", paymentMode: "installment", balanceStatus: "failed", balanceCents: 38000, nowMs: D("2026-08-05") }),
  { missedCount: 1, missedCents: 38000, payoffCents: 38000, kind: "balance_failed" });

eq("installment: scheduled balance → nothing",
  missedPayments({ status: "confirmed", paymentMode: "installment", balanceStatus: "scheduled", balanceCents: 38000, nowMs: D("2026-08-05") }),
  { missedCount: 0, missedCents: 0, payoffCents: 0, kind: null });

// ── other modes ──────────────────────────────────────────────────────────────
eq("split teams never flag here (Player Pay tab owns that)",
  missedPayments({ status: "confirmed", paymentMode: "split", nowMs: D("2026-08-05") }),
  { missedCount: 0, missedCents: 0, payoffCents: 0, kind: null });

eq("upfront card → nothing",
  missedPayments({ status: "confirmed", paymentMode: "upfront", nowMs: D("2026-08-05") }),
  { missedCount: 0, missedCents: 0, payoffCents: 0, kind: null });

// ── invoice → subscription id across Stripe API versions ────────────────────
eq("invoice sub id: pre-basil top-level string", subscriptionIdFromInvoice({ subscription: "sub_1" }), "sub_1");
eq("invoice sub id: expanded object", subscriptionIdFromInvoice({ subscription: { id: "sub_2" } }), "sub_2");
eq("invoice sub id: basil/clover nested field", subscriptionIdFromInvoice({ parent: { subscription_details: { subscription: "sub_3" } } }), "sub_3");
eq("invoice sub id: nested expanded object", subscriptionIdFromInvoice({ parent: { subscription_details: { subscription: { id: "sub_4" } } } }), "sub_4");
eq("invoice sub id: non-subscription invoice → undefined", subscriptionIdFromInvoice({ parent: { quote_details: null } }), undefined);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
