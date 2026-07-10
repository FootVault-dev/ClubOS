// Pure-logic tests for shared/housing.ts.  Run: npx tsx script/test-housing.ts
//
// The date math here decides who the club chases for money, so it is tested
// against the specific traps that have bitten this workspace before:
// month-end clamping drift, the NZ/UTC day boundary, and "paid late" being
// mistaken for "overdue".
import assert from "node:assert/strict";
import {
  ROOM_TYPES, RENT_FREQUENCIES, UTILITY_KINDS, PAYMENT_METHODS,
  isRoomType, isRentFrequency, isUtilityKind, isPaymentMethod,
  parseIso, toIso, daysInMonth, addDaysIso, addMonthsIso, daysBetween, compareIso,
  nzTodayIso,
  tenancyState, rangesOverlap,
  paymentState, daysOverdue, amountOutstandingCents,
  chargePeriods, annualisedRentCents,
  summariseOccupancy, dollarsToCents,
  MAX_GENERATED_CHARGES,
} from "../shared/housing";

let passed = 0;
function ok(name: string, fn: () => void) {
  try { fn(); passed++; }
  catch (e: any) { console.error(`FAIL: ${name}\n  ${e.message}`); process.exitCode = 1; }
}

// ── Vocabularies ─────────────────────────────────────────────────────────────
ok("room types", () => assert.equal(ROOM_TYPES.length, 6));
ok("isRoomType", () => { assert.equal(isRoomType("ensuite"), true); assert.equal(isRoomType("penthouse"), false); });
ok("rent frequencies", () => assert.deepEqual([...RENT_FREQUENCIES], ["weekly", "fortnightly", "monthly"]));
ok("isRentFrequency", () => { assert.equal(isRentFrequency("monthly"), true); assert.equal(isRentFrequency("daily"), false); });
ok("utility kinds include power + internet", () => {
  assert.equal(isUtilityKind("power"), true);
  assert.equal(isUtilityKind("internet"), true);
  assert.equal(isUtilityKind("netflix"), false);
  assert.equal(UTILITY_KINDS.length, 8);
});
ok("payment methods", () => { assert.equal(isPaymentMethod("bank_transfer"), true); assert.equal(isPaymentMethod("crypto"), false); });

// ── parseIso rejects everything that isn't a calendar date ───────────────────
ok("parseIso good", () => assert.deepEqual(parseIso("2026-07-17"), { y: 2026, m: 7, d: 17 }));
ok("parseIso rejects timestamp", () => assert.equal(parseIso("2026-07-17T00:00:00Z"), null));
ok("parseIso rejects Date", () => assert.equal(parseIso(new Date()), null));
ok("parseIso rejects month 13", () => assert.equal(parseIso("2026-13-01"), null));
ok("parseIso rejects 31 Feb", () => assert.equal(parseIso("2026-02-31"), null));
ok("parseIso accepts 29 Feb in a leap year", () => assert.deepEqual(parseIso("2024-02-29"), { y: 2024, m: 2, d: 29 }));
ok("parseIso rejects 29 Feb in a common year", () => assert.equal(parseIso("2026-02-29"), null));
ok("parseIso rejects empty/null", () => { assert.equal(parseIso(""), null); assert.equal(parseIso(null), null); });

ok("daysInMonth", () => {
  assert.equal(daysInMonth(2026, 2), 28);
  assert.equal(daysInMonth(2024, 2), 29);
  assert.equal(daysInMonth(2026, 7), 31);
  assert.equal(daysInMonth(2026, 6), 30);
});
ok("toIso pads", () => assert.equal(toIso({ y: 2026, m: 3, d: 4 }), "2026-03-04"));

// ── addDaysIso ───────────────────────────────────────────────────────────────
ok("addDays simple", () => assert.equal(addDaysIso("2026-07-17", 7), "2026-07-24"));
ok("addDays crosses month", () => assert.equal(addDaysIso("2026-07-28", 7), "2026-08-04"));
ok("addDays crosses year", () => assert.equal(addDaysIso("2026-12-30", 3), "2027-01-02"));
ok("addDays negative", () => assert.equal(addDaysIso("2026-08-01", -1), "2026-07-31"));
ok("addDays through NZ DST start (late Sep) is still 7 days", () =>
  // Real trap: NZDT begins 27 Sep 2026. UTC-anchored arithmetic must not skip an hour into a new day.
  assert.equal(addDaysIso("2026-09-24", 7), "2026-10-01"));
ok("addDays through NZ DST end (early Apr)", () => assert.equal(addDaysIso("2026-04-02", 7), "2026-04-09"));
ok("addDays leap day", () => assert.equal(addDaysIso("2024-02-28", 1), "2024-02-29"));
ok("addDays bad input", () => assert.equal(addDaysIso("nope", 1), null));

// ── addMonthsIso — the clamping trap ─────────────────────────────────────────
ok("addMonths simple", () => assert.equal(addMonthsIso("2026-01-15", 1), "2026-02-15"));
ok("addMonths clamps 31 Jan → 28 Feb", () => assert.equal(addMonthsIso("2026-01-31", 1), "2026-02-28"));
ok("addMonths clamps 31 Jan → 29 Feb in a leap year", () => assert.equal(addMonthsIso("2024-01-31", 1), "2024-02-29"));
ok("addMonths clamps 31 → 30 Apr", () => assert.equal(addMonthsIso("2026-03-31", 1), "2026-04-30"));
ok("addMonths crosses year", () => assert.equal(addMonthsIso("2026-11-15", 3), "2027-02-15"));
ok("addMonths 12 = same day next year", () => assert.equal(addMonthsIso("2026-07-17", 12), "2027-07-17"));
ok("addMonths negative", () => assert.equal(addMonthsIso("2026-03-31", -1), "2026-02-28"));
ok("addMonths zero is identity", () => assert.equal(addMonthsIso("2026-07-17", 0), "2026-07-17"));

// 🔴 The drift bug this function exists to prevent: stepping month-by-month from
// the previous RESULT walks a 31st tenancy permanently onto the 28th.
ok("anchor-based months do NOT drift after a February clamp", () => {
  const anchor = "2026-01-31";
  assert.equal(addMonthsIso(anchor, 1), "2026-02-28");
  assert.equal(addMonthsIso(anchor, 2), "2026-03-31"); // back to the 31st, not stuck on the 28th
  assert.equal(addMonthsIso(anchor, 3), "2026-04-30");
  assert.equal(addMonthsIso(anchor, 4), "2026-05-31");

  // And prove the naive alternative really would have drifted:
  let drifting = anchor;
  for (let i = 0; i < 2; i++) drifting = addMonthsIso(drifting, 1)!;
  assert.equal(drifting, "2026-03-28"); // ← the wrong answer we are avoiding
});

// ── daysBetween / compareIso ─────────────────────────────────────────────────
ok("daysBetween forward", () => assert.equal(daysBetween("2026-07-10", "2026-07-17"), 7));
ok("daysBetween backward is negative", () => assert.equal(daysBetween("2026-07-17", "2026-07-10"), -7));
ok("daysBetween same day is 0", () => assert.equal(daysBetween("2026-07-17", "2026-07-17"), 0));
ok("daysBetween across NZ DST is whole days", () => assert.equal(daysBetween("2026-09-26", "2026-09-28"), 2));
ok("compareIso", () => {
  assert.equal(compareIso("2026-07-10", "2026-07-17"), -1);
  assert.equal(compareIso("2026-07-17", "2026-07-17"), 0);
  assert.equal(compareIso("2026-08-01", "2026-07-31"), 1);
});

// ── nzTodayIso — the UTC-day-boundary trap ───────────────────────────────────
ok("nzTodayIso reads TOMORROW's NZ date from a late-UTC instant", () => {
  // 2026-07-17T23:00Z is already 11am on the 18th in Auckland (UTC+12).
  assert.equal(nzTodayIso(new Date("2026-07-17T23:00:00Z")), "2026-07-18");
});
ok("nzTodayIso at midday UTC is already tomorrow in NZ", () =>
  assert.equal(nzTodayIso(new Date("2026-07-17T12:30:00Z")), "2026-07-18"));
ok("nzTodayIso early UTC is still the same NZ day", () =>
  assert.equal(nzTodayIso(new Date("2026-07-17T02:00:00Z")), "2026-07-17"));
ok("nzTodayIso is never what toISOString would give at 23:00Z", () => {
  const at = new Date("2026-07-17T23:00:00Z");
  assert.notEqual(nzTodayIso(at), at.toISOString().slice(0, 10));
});

// ── tenancyState ─────────────────────────────────────────────────────────────
const T = "2026-07-17";
ok("tenancy active, open-ended", () => assert.equal(tenancyState("2026-01-01", null, T), "active"));
ok("tenancy active on its first day", () => assert.equal(tenancyState(T, null, T), "active"));
ok("tenancy active on its LAST day (end is inclusive)", () => assert.equal(tenancyState("2026-01-01", T, T), "active"));
ok("tenancy ended the day after its end date", () => assert.equal(tenancyState("2026-01-01", "2026-07-16", T), "ended"));
ok("tenancy upcoming", () => assert.equal(tenancyState("2026-08-01", null, T), "upcoming"));

// ── rangesOverlap — no two tenants in one room ───────────────────────────────
ok("overlap: identical ranges", () => assert.equal(rangesOverlap("2026-01-01", "2026-06-30", "2026-01-01", "2026-06-30"), true));
ok("overlap: touching at the boundary DOES overlap (end is inclusive)", () =>
  assert.equal(rangesOverlap("2026-01-01", "2026-06-30", "2026-06-30", "2026-12-31"), true));
ok("no overlap: back-to-back, next day", () =>
  assert.equal(rangesOverlap("2026-01-01", "2026-06-30", "2026-07-01", "2026-12-31"), false));
ok("overlap: two open-ended tenancies always collide", () =>
  assert.equal(rangesOverlap("2026-01-01", null, "2027-01-01", null), true));
ok("overlap: open-ended swallows a later fixed range", () =>
  assert.equal(rangesOverlap("2026-01-01", null, "2026-09-01", "2026-10-01"), true));
ok("no overlap: fixed range ends before an open-ended one starts", () =>
  assert.equal(rangesOverlap("2026-01-01", "2026-06-30", "2026-07-01", null), false));
ok("overlap is symmetric", () => {
  const a = rangesOverlap("2026-01-01", "2026-06-30", "2026-05-01", null);
  const b = rangesOverlap("2026-05-01", null, "2026-01-01", "2026-06-30");
  assert.equal(a, b); assert.equal(a, true);
});

// ── paymentState — the "paid late" trap ──────────────────────────────────────
ok("unpaid + due in the past = overdue", () => assert.equal(paymentState({ dueOn: "2026-07-01" }, T), "overdue"));
ok("PAID LATE is paid, not overdue", () =>
  assert.equal(paymentState({ dueOn: "2026-07-01", paidOn: "2026-07-15" }, T), "paid"));
ok("waived is waived", () => assert.equal(paymentState({ dueOn: "2026-07-01", waived: true }, T), "waived"));
ok("paid beats waived", () => assert.equal(paymentState({ dueOn: "2026-07-01", paidOn: "2026-07-02", waived: true }, T), "paid"));
ok("due today is NOT overdue", () => assert.equal(paymentState({ dueOn: T }, T), "due_soon"));
ok("due in 7 days is due_soon", () => assert.equal(paymentState({ dueOn: "2026-07-24" }, T), "due_soon"));
ok("due in 8 days is upcoming", () => assert.equal(paymentState({ dueOn: "2026-07-25" }, T), "upcoming"));
ok("daysOverdue counts", () => assert.equal(daysOverdue({ dueOn: "2026-07-10" }, T), 7));
ok("daysOverdue is 0 when paid", () => assert.equal(daysOverdue({ dueOn: "2026-07-10", paidOn: "2026-07-12" }, T), 0));
ok("daysOverdue is 0 when not yet due", () => assert.equal(daysOverdue({ dueOn: "2026-08-10" }, T), 0));

// ── amountOutstandingCents ───────────────────────────────────────────────────
ok("outstanding full", () => assert.equal(amountOutstandingCents({ dueOn: T, amountCents: 30000 }), 30000));
ok("outstanding after part-payment", () =>
  assert.equal(amountOutstandingCents({ dueOn: T, amountCents: 30000, paidAmountCents: 10000 }), 20000));
ok("outstanding never negative on overpayment", () =>
  assert.equal(amountOutstandingCents({ dueOn: T, amountCents: 30000, paidAmountCents: 35000 }), 0));
ok("waived owes nothing", () =>
  assert.equal(amountOutstandingCents({ dueOn: T, amountCents: 30000, waived: true }), 0));

// ── chargePeriods ────────────────────────────────────────────────────────────
ok("weekly: rent is due on the first day of the week it covers", () => {
  // Horizon 2 Aug: the 3 Aug charge has not fallen due yet and must not be created.
  const p = chargePeriods("2026-07-06", null, "weekly", "2026-08-02");
  assert.equal(p.length, 4);
  assert.deepEqual(p[0], { index: 0, periodStart: "2026-07-06", periodEnd: "2026-07-12", dueOn: "2026-07-06" });
  assert.deepEqual(p[3], { index: 3, periodStart: "2026-07-27", periodEnd: "2026-08-02", dueOn: "2026-07-27" });
});
ok("weekly: horizon is inclusive and stops there", () => {
  const p = chargePeriods("2026-07-06", null, "weekly", "2026-07-20");
  assert.deepEqual(p.map(x => x.dueOn), ["2026-07-06", "2026-07-13", "2026-07-20"]);
});
ok("fortnightly steps 14 days", () => {
  const p = chargePeriods("2026-07-06", null, "fortnightly", "2026-08-17");
  assert.deepEqual(p.map(x => x.dueOn), ["2026-07-06", "2026-07-20", "2026-08-03", "2026-08-17"]);
  assert.equal(p[0].periodEnd, "2026-07-19");
});
ok("monthly follows the anchor day and does not drift past February", () => {
  const p = chargePeriods("2026-01-31", null, "monthly", "2026-05-31");
  assert.deepEqual(p.map(x => x.dueOn), ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31"]);
});
ok("monthly period ends the day before the next starts", () => {
  const p = chargePeriods("2026-07-01", null, "monthly", "2026-08-01");
  assert.equal(p[0].periodStart, "2026-07-01");
  assert.equal(p[0].periodEnd, "2026-07-31");
});
ok("a tenancy that ends mid-period is charged only to its last night", () => {
  const p = chargePeriods("2026-07-06", "2026-07-16", "weekly", "2026-12-31");
  assert.equal(p.length, 2);
  assert.equal(p[1].periodStart, "2026-07-13");
  assert.equal(p[1].periodEnd, "2026-07-16"); // clipped to the end date, not 2026-07-19
});
ok("no charge starts after the tenancy ends", () => {
  const p = chargePeriods("2026-07-06", "2026-07-12", "weekly", "2026-12-31");
  assert.equal(p.length, 1);
});
ok("a one-day tenancy still owes one charge", () => {
  const p = chargePeriods("2026-07-06", "2026-07-06", "weekly", "2026-12-31");
  assert.deepEqual(p, [{ index: 0, periodStart: "2026-07-06", periodEnd: "2026-07-06", dueOn: "2026-07-06" }]);
});
ok("horizon before the start yields nothing", () =>
  assert.equal(chargePeriods("2026-08-01", null, "weekly", "2026-07-17").length, 0));
ok("end before start yields nothing (never charge a reversed range)", () =>
  assert.equal(chargePeriods("2026-08-01", "2026-07-01", "weekly", "2026-12-31").length, 0));
ok("bad dates yield nothing, never a throw", () => {
  assert.equal(chargePeriods("nope", null, "weekly", "2026-12-31").length, 0);
  assert.equal(chargePeriods("2026-07-06", null, "weekly", "nope").length, 0);
  assert.equal(chargePeriods("2026-07-06", null, "daily" as any, "2026-12-31").length, 0);
});
ok("the generator is capped", () => {
  const p = chargePeriods("2000-01-01", null, "weekly", "2099-01-01");
  assert.equal(p.length, MAX_GENERATED_CHARGES);
});
ok("generation is IDEMPOTENT — same inputs, same dueOn set", () => {
  const a = chargePeriods("2026-07-06", null, "weekly", "2026-09-30").map(x => x.dueOn);
  const b = chargePeriods("2026-07-06", null, "weekly", "2026-09-30").map(x => x.dueOn);
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, a.length); // and no duplicate due dates within one run
});
ok("extending the horizon only APPENDS — it never renumbers existing charges", () => {
  const short = chargePeriods("2026-07-06", null, "monthly", "2026-09-06").map(x => x.dueOn);
  const long = chargePeriods("2026-07-06", null, "monthly", "2026-12-06").map(x => x.dueOn);
  assert.deepEqual(long.slice(0, short.length), short);
});
ok("no two periods overlap and none skips a day", () => {
  const p = chargePeriods("2026-01-31", null, "monthly", "2026-12-31");
  for (let i = 1; i < p.length; i++) {
    assert.equal(addDaysIso(p[i - 1].periodEnd, 1), p[i].periodStart,
      `gap or overlap between period ${i - 1} and ${i}`);
  }
});

// ── annualisedRentCents ──────────────────────────────────────────────────────
ok("monthly annualises to 12×", () => assert.equal(annualisedRentCents(200000, "monthly"), 2400000));
ok("weekly uses 365.25/7, not 52", () => {
  // $300/wk. 52 weeks would say $15,600 — nearly a week's rent short.
  assert.equal(annualisedRentCents(30000, "weekly"), Math.round(30000 * 365.25 / 7));
  assert.notEqual(annualisedRentCents(30000, "weekly"), 30000 * 52);
});
ok("fortnightly is half the weekly rate for the same money", () =>
  assert.equal(annualisedRentCents(60000, "fortnightly"), annualisedRentCents(30000, "weekly")));

// ── summariseOccupancy ───────────────────────────────────────────────────────
ok("occupancy counts active tenancies only", () => {
  const s = summariseOccupancy([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }], [1, 3]);
  assert.deepEqual(s, { rooms: 4, occupied: 2, vacant: 2, occupancyPct: 50 });
});
ok("occupancy ignores a tenancy pointing at a deleted room", () => {
  const s = summariseOccupancy([{ id: 1 }, { id: 2 }], [1, 99]);
  assert.equal(s.occupied, 1);
});
ok("occupancy of an empty house is 0%, never NaN", () => {
  const s = summariseOccupancy([], []);
  assert.deepEqual(s, { rooms: 0, occupied: 0, vacant: 0, occupancyPct: 0 });
  assert.equal(Number.isNaN(s.occupancyPct), false);
});
ok("occupancy dedupes repeated room ids", () => {
  const s = summariseOccupancy([{ id: 1 }, { id: 2 }], [1, 1, 1]);
  assert.equal(s.occupied, 1);
});

// ── dollarsToCents ───────────────────────────────────────────────────────────
ok("dollars → cents", () => {
  assert.equal(dollarsToCents("300"), 30000);
  assert.equal(dollarsToCents("300.50"), 30050);
  assert.equal(dollarsToCents("$1,250.50"), 125050);
  assert.equal(dollarsToCents(" 45.9 "), 4590);
});
ok("a bad amount is null, never a silent $0", () => {
  assert.equal(dollarsToCents("abc"), null);
  assert.equal(dollarsToCents(""), null);
  assert.equal(dollarsToCents(null), null);
  assert.equal(dollarsToCents("30.005"), null); // sub-cent precision is a typo, not money
});
ok("rounds cleanly, no float dust", () => {
  assert.equal(dollarsToCents("0.07"), 7);
  assert.equal(dollarsToCents("1.10"), 110);
  assert.equal(dollarsToCents("19.99"), 1999);
});


// A rent_frequency that isn't one of the three contributes 0, never NaN.
ok("unknown frequency annualises to 0, not NaN", () => {
  const v = annualisedRentCents(30000, "yearly" as any);
  assert.equal(v, 0);
  assert.equal(Number.isNaN(v), false);
});

console.log(`\n${passed} assertions passed`);
if (process.exitCode) console.error("SOME TESTS FAILED");
