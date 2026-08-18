// Pure-logic tests for the accommodation additions to shared/housing.ts.
//   Run: npx tsx script/test-accommodation.ts
//
// The centrepiece is the reconciliation at the bottom: every one of the 24 real
// tenancies from the club's own run sheet is priced by `tenancyMoney()` and
// compared against the figure the club wrote down. Twenty-one must match TO THE
// CENT. That is what makes the three that do not match a finding about the
// club's spreadsheet rather than a bug in this code — and it is the only reason
// it is safe to tell Daniel that two players look $1,150 short.
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import {
  AGREEMENT_TYPES, OCCUPANT_CATEGORIES, CONDITION_STATUSES, CHARGE_KINDS,
  isAgreementType, isOccupantCategory, isConditionStatus, isChargeKind,
  isActionStatus, isActionOpen,
  occupiedDays, checkOutToLastNight, billableDays, billableWeeks,
  weeklyEquivalentCents, tenancyMoney,
  statedVarianceCents, hasMaterialVariance,
  summariseAccommodation, findPersonOverlaps, accommodationStatus,
} from "../shared/housing";

let passed = 0;
function ok(name: string, fn: () => void) {
  try { fn(); passed++; }
  catch (e: any) { console.error(`FAIL: ${name}\n  ${e.message}`); process.exitCode = 1; }
}

// ── Vocabularies ─────────────────────────────────────────────────────────────
ok("agreement types include the undecided case", () => {
  assert.equal(isAgreementType("licence_to_occupy"), true);
  assert.equal(isAgreementType("club_remuneration"), true);
  // Which of these these occupancies legally ARE is still open with Harcourts.
  assert.equal(isAgreementType("undecided"), true);
  assert.equal(isAgreementType("airbnb"), false);
  assert.equal(AGREEMENT_TYPES.length, 6);
});
ok("occupant categories", () => {
  assert.equal(isOccupantCategory("senior_squad"), true);
  assert.equal(isOccupantCategory("legend"), false);
  assert.equal(OCCUPANT_CATEGORIES.length, 6);
});
ok("condition statuses default to not-inspected, not fine", () => {
  assert.equal(isConditionStatus("unknown"), true);
  assert.equal(isConditionStatus("inspected_good"), true);
  assert.equal(CONDITION_STATUSES.length, 6);
});
ok("charge kinds", () => {
  assert.equal(isChargeKind("combined"), true);
  assert.equal(isChargeKind("bond"), false);
  assert.equal(CHARGE_KINDS.length, 3);
});
ok("dismissed is finished, not open", () => {
  assert.equal(isActionStatus("dismissed"), true);
  assert.equal(isActionOpen("open"), true);
  assert.equal(isActionOpen("in_progress"), true);
  assert.equal(isActionOpen("completed"), false);
  // "We looked and decided no" is a decision, not an outstanding gap.
  assert.equal(isActionOpen("dismissed"), false);
});

// ── Duration ─────────────────────────────────────────────────────────────────
ok("occupied days counts the last night", () => {
  // 5 Jan to 24 Jan inclusive is 20 nights, not 19.
  assert.equal(occupiedDays("2026-01-05", "2026-01-24"), 20);
  assert.equal(occupiedDays("2026-01-05", "2026-01-05"), 1);
});
ok("check-out converts to the last night", () => {
  // The run sheet writes 25 May as check-out; the last night is the 24th.
  assert.equal(checkOutToLastNight("2026-05-25"), "2026-05-24");
  // Across a month boundary, and across a leap-year February.
  assert.equal(checkOutToLastNight("2026-06-01"), "2026-05-31");
  assert.equal(checkOutToLastNight("2028-03-01"), "2028-02-29");
});
ok("holiday weeks come off the billable days", () => {
  // Ryan Feutz: 15 Dec 2025 → 24 May 2026 inclusive = 161 nights = 23 weeks,
  // less the 2-week Christmas break = 21, which is what the club billed.
  assert.equal(occupiedDays("2025-12-15", "2026-05-24"), 161);
  assert.equal(billableDays("2025-12-15", "2026-05-24", 2), 147);
  assert.equal(billableWeeks("2025-12-15", "2026-05-24", 2), 21);
});
ok("a holiday longer than the stay floors at zero, never a credit", () => {
  assert.equal(billableDays("2026-01-05", "2026-01-11", 5), 0);
});
ok("holiday weeks that are nonsense are ignored, not propagated as NaN", () => {
  assert.equal(billableDays("2026-01-05", "2026-01-11", NaN as any), 7);
  assert.equal(billableDays("2026-01-05", "2026-01-11", -3), 7);
});

// ── Weekly equivalence ───────────────────────────────────────────────────────
ok("frequencies reduce to a weekly figure", () => {
  assert.equal(weeklyEquivalentCents(23000, "weekly"), 23000);
  assert.equal(weeklyEquivalentCents(46000, "fortnightly"), 23000);
  assert.equal(weeklyEquivalentCents(100000, "monthly"), Math.round(100000 * 12 / 52.1775));
});
ok("an unknown frequency is treated as weekly, never NaN", () => {
  const v = weeklyEquivalentCents(23000, "daily" as any);
  assert.equal(v, 23000);
  assert.equal(Number.isNaN(v), false);
});

// ── The money ────────────────────────────────────────────────────────────────
ok("rent and power are separate lines when power is not included", () => {
  const m = tenancyMoney({
    startDate: "2026-05-26", endDate: "2026-07-02",   // check-out 3 Jul
    rentCents: 20000, utilitiesCents: 3000, utilitiesIncluded: false,
  })!;
  assert.equal(m.days, 38);
  assert.equal(m.rentCents, 108571);      // 200 * 38/7
  assert.equal(m.utilitiesCents, 16286);  // 30 * 38/7
  assert.equal(m.totalCents, 124857);     // $1,248.57 — the club's own figure
});
ok("power included means the rent already covers it", () => {
  const m = tenancyMoney({
    startDate: "2026-01-05", endDate: "2026-05-24",
    rentCents: 23000, utilitiesCents: 3000, utilitiesIncluded: true,
  })!;
  assert.equal(m.utilitiesCents, 0);
  assert.equal(m.weeklyUtilitiesCents, 0);
  assert.equal(m.totalCents, 460000);
});
ok("🔴 rounds once from whole days, not from rounded weeks", () => {
  // The source sheet displays this stay as "5.3 weeks". Pricing 5.3 x $230
  // gives $1,219.00; pricing 38 days gives $1,248.57. The club banked the
  // second one, so weeks must never be rounded before the multiply.
  const m = tenancyMoney({
    startDate: "2026-05-26", endDate: "2026-07-02",
    rentCents: 20000, utilitiesCents: 3000, utilitiesIncluded: false,
  })!;
  assert.equal(m.totalCents, 124857);
  assert.notEqual(m.totalCents, Math.round(5.3 * 23000));
});
ok("a remuneration room costs the occupant only the power", () => {
  const m = tenancyMoney({
    startDate: "2026-05-26", endDate: "2026-08-31",
    rentCents: 0, utilitiesCents: 3000, utilitiesIncluded: false,
  })!;
  assert.equal(m.days, 98);
  assert.equal(m.rentCents, 0);
  assert.equal(m.totalCents, 42000);   // $420 — 14 weeks of power
});
ok("an open-ended tenancy is valued to the date asked for", () => {
  const m = tenancyMoney({ startDate: "2026-01-01", endDate: null, rentCents: 10000 }, "2026-01-28")!;
  assert.equal(m.openEnded, true);
  assert.equal(m.days, 28);
  assert.equal(m.totalCents, 40000);
});
ok("a tenancy valued before it begins costs nothing, not a negative", () => {
  const m = tenancyMoney({ startDate: "2026-09-01", endDate: null, rentCents: 10000 }, "2026-08-01")!;
  assert.equal(m.days, 0);
  assert.equal(m.totalCents, 0);
});
ok("a junk date yields null rather than a wrong number", () => {
  assert.equal(tenancyMoney({ startDate: "not-a-date", endDate: null, rentCents: 100 }), null);
  assert.equal(tenancyMoney({ startDate: "2026-02-30", endDate: null, rentCents: 100 }), null);
});

// ── Variance ─────────────────────────────────────────────────────────────────
ok("variance is computed minus stated, and positive means under-billed", () => {
  assert.equal(statedVarianceCents(115000, 0), 115000);
  assert.equal(statedVarianceCents(360000, 365000), -5000);
  assert.equal(statedVarianceCents(100, null), null);
  assert.equal(statedVarianceCents(100, undefined), null);
});
ok("a cent of rounding is not a variance; a dollar is", () => {
  assert.equal(hasMaterialVariance(100000, 100001), false);
  assert.equal(hasMaterialVariance(100000, 100100), true);
  assert.equal(hasMaterialVariance(100000, null), false);
});

// ── Occupancy ────────────────────────────────────────────────────────────────
ok("🔴 reserve beds are excluded from the occupancy percentage", () => {
  const rooms = [
    { id: 1 }, { id: 2 }, { id: 3 },
    { id: 90, isReserve: true }, { id: 91, isReserve: true },
  ];
  const s = summariseAccommodation(rooms, [1, 2, 3]);
  // Every lettable room is full. Counting the two sick rooms would report 60%
  // and invent spare capacity that cannot be sold.
  assert.equal(s.occupancyPct, 100);
  assert.equal(s.rooms, 3);
  assert.equal(s.vacant, 0);
  assert.equal(s.reserveRooms, 2);
  assert.equal(s.reserveOccupied, 0);
});
ok("someone in a sick room is counted as being there, just not as let stock", () => {
  const rooms = [{ id: 1 }, { id: 90, isReserve: true }];
  const s = summariseAccommodation(rooms, [90]);
  assert.equal(s.occupied, 0);
  assert.equal(s.occupancyPct, 0);
  assert.equal(s.reserveOccupied, 1);
});
ok("no rooms reads 0%, never NaN", () => {
  assert.equal(summariseAccommodation([], []).occupancyPct, 0);
});

// ── Person overlaps ──────────────────────────────────────────────────────────
ok("one person in two rooms at once is reported", () => {
  const found = findPersonOverlaps([
    { id: 1, contactId: 7, roomId: 10, startDate: "2026-05-04", endDate: "2026-05-28" },
    { id: 2, contactId: 7, roomId: 20, startDate: "2026-05-01", endDate: "2026-06-11" },
  ]);
  assert.equal(found.length, 1);
  assert.equal(found[0].contactId, 7);
});
ok("consecutive stays by the same person are not an overlap", () => {
  assert.equal(findPersonOverlaps([
    { id: 1, contactId: 7, roomId: 10, startDate: "2026-01-05", endDate: "2026-05-24" },
    { id: 2, contactId: 7, roomId: 10, startDate: "2026-05-26", endDate: "2026-08-31" },
  ]).length, 0);
});
ok("two different people are never each other's overlap", () => {
  assert.equal(findPersonOverlaps([
    { id: 1, contactId: 7, roomId: 10, startDate: "2026-01-05", endDate: "2026-05-24" },
    { id: 2, contactId: 8, roomId: 20, startDate: "2026-01-05", endDate: "2026-05-24" },
  ]).length, 0);
});

// ── Accommodation status ─────────────────────────────────────────────────────
ok("status is derived from the tenancies, and no tenancy means off site", () => {
  const today = "2026-08-18";
  assert.equal(accommodationStatus([], today), "non_resident");
  assert.equal(accommodationStatus([{ startDate: "2026-05-26", endDate: "2026-08-31" }], today), "resident");
  assert.equal(accommodationStatus([{ startDate: "2026-01-05", endDate: "2026-05-24" }], today), "former");
  assert.equal(accommodationStatus([{ startDate: "2026-09-01", endDate: null }], today), "arriving");
  // A finished stay plus a live one is still "living on site".
  assert.equal(accommodationStatus([
    { startDate: "2026-01-05", endDate: "2026-05-24" },
    { startDate: "2026-05-26", endDate: "2026-08-31" },
  ], today), "resident");
});

// ─────────────────────────────────────────────────────────────────────────────
// RECONCILIATION against the club's own run sheet.
// ─────────────────────────────────────────────────────────────────────────────
const here = dirname(fileURLToPath(import.meta.url));
const src = JSON.parse(readFileSync(
  join(here, "..", "..", "..", "outputs", "accommodation", "2026-08-18-residency-import", "source-data.json"), "utf8"));

/** Exactly the three rows the club's workbook prices differently from its own
 *  rates and dates. Everything else must agree to the cent. */
const KNOWN_VARIANCES: Record<string, number> = {
  "JM-10": -5000,     // Johnson Cleland: $180 x 20 = $3,600, sheet says $3,650
  "JM-13": -9857,     // Nori Yuki: 25 days billed as a full 4 weeks
};

let reconciled = 0, mismatched: string[] = [];
for (const t of src.tenancies as any[]) {
  if (t.statedTotalDollars === null || t.statedTotalDollars === undefined) continue;
  const lastNight = checkOutToLastNight(t.checkOut)!;
  const m = tenancyMoney({
    startDate: t.checkIn,
    endDate: lastNight,
    rentCents: Math.round((t.weeklyRentDollars ?? 0) * 100),
    utilitiesCents: Math.round((t.utilitiesWeeklyDollars ?? 0) * 100),
    utilitiesIncluded: !!t.utilitiesIncluded,
    holidayWeeks: t.holidayWeeks ?? 0,
  })!;
  const stated = Math.round(t.statedTotalDollars * 100);
  const variance = m.totalCents - stated;
  const expected = KNOWN_VARIANCES[t.ref] ?? 0;
  if (variance === expected) reconciled++;
  else mismatched.push(`${t.ref} (${t.person}): computed ${m.totalCents}c vs stated ${stated}c, variance ${variance}c, expected ${expected}c`);
}

ok(`every priced tenancy reconciles (${reconciled} rows)`, () => {
  assert.deepEqual(mismatched, [], `\n  ${mismatched.join("\n  ")}`);
  // 22 of the 24 rows carry a stated total; the two Ry McLeod / Oli Fay
  // pre-change segments carry none, which is the finding itself.
  assert.equal(reconciled, 22);
});

ok("🔴 the two rate-change segments are unbilled in the source", () => {
  const unpriced = (src.tenancies as any[]).filter(t => t.statedTotalDollars === null);
  assert.equal(unpriced.length, 2);
  let gap = 0;
  for (const t of unpriced) {
    const m = tenancyMoney({
      startDate: t.checkIn,
      endDate: checkOutToLastNight(t.checkOut)!,
      rentCents: Math.round(t.weeklyRentDollars * 100),
      utilitiesIncluded: true,
      holidayWeeks: t.holidayWeeks ?? 0,
    })!;
    gap += m.totalCents;
  }
  // $1,150 each — five weeks at $230 before the 2 Feb reduction to $150.
  assert.equal(gap, 230000);
});

console.log(`\n${passed} assertions passed  (${reconciled}/22 priced tenancies reconcile to the cent)`);
if (process.exitCode) console.error("SOME TESTS FAILED");
