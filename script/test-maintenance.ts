// Pure-logic tests for shared/maintenance.ts. Run: npx tsx script/test-maintenance.ts
//
// Covers the specific traps this workspace has been bitten by before: an
// unaudited machine reading as falsely "ok", a retired/archived row still
// nagging, and the NZ/UTC day-boundary bug that once printed the wrong date
// on an invoice.
import assert from "node:assert/strict";
import {
  SUPPLY_CATEGORIES, SUPPLY_STATUSES, STOCK_MOVEMENT_REASONS,
  ASSET_CATEGORIES, ASSET_STATUSES, SERVICE_RECORD_KINDS,
  isSupplyCategory, isSupplyStatus, isStockMovementReason,
  isAssetCategory, isAssetStatus, isServiceRecordKind,
  isIsoDate, nzTodayIso, daysUntil,
  stockStatus, supplyStockStatus,
  serviceStatus, assetServiceStatus, worstServiceStatus,
  dollarsToCents,
  SERVICE_DUE_SOON_DAYS,
} from "../shared/maintenance";

let passed = 0;
function ok(name: string, fn: () => void) {
  try { fn(); passed++; }
  catch (e: any) { console.error(`FAIL: ${name}\n  ${e.message}`); process.exitCode = 1; }
}

// ── Vocabularies ─────────────────────────────────────────────────────────────
ok("supply categories", () => assert.equal(SUPPLY_CATEGORIES.length, 5));
ok("isSupplyCategory", () => { assert.equal(isSupplyCategory("cleaning"), true); assert.equal(isSupplyCategory("food"), false); });
ok("supply statuses", () => assert.deepEqual([...SUPPLY_STATUSES], ["active", "archived"]));
ok("isSupplyStatus", () => { assert.equal(isSupplyStatus("active"), true); assert.equal(isSupplyStatus("deleted"), false); });
ok("stock movement reasons", () => assert.deepEqual([...STOCK_MOVEMENT_REASONS], ["received", "used", "adjusted", "stocktake"]));
ok("isStockMovementReason", () => { assert.equal(isStockMovementReason("stocktake"), true); assert.equal(isStockMovementReason("theft"), false); });
ok("asset categories", () => assert.equal(ASSET_CATEGORIES.length, 6));
ok("isAssetCategory", () => { assert.equal(isAssetCategory("mower"), true); assert.equal(isAssetCategory("car"), false); });
ok("asset statuses", () => assert.deepEqual([...ASSET_STATUSES], ["active", "retired"]));
ok("isAssetStatus", () => { assert.equal(isAssetStatus("retired"), true); assert.equal(isAssetStatus("archived"), false); });
ok("service record kinds", () => assert.deepEqual([...SERVICE_RECORD_KINDS], ["service", "repair", "inspection"]));
ok("isServiceRecordKind", () => { assert.equal(isServiceRecordKind("repair"), true); assert.equal(isServiceRecordKind("wof_check"), false); });

// ── isIsoDate / nzTodayIso / daysUntil ───────────────────────────────────────
ok("isIsoDate accepts a calendar date", () => assert.equal(isIsoDate("2026-07-21"), true));
ok("isIsoDate rejects a timestamp", () => assert.equal(isIsoDate("2026-07-21T00:00:00Z"), false));
ok("isIsoDate rejects a Date instance", () => assert.equal(isIsoDate(new Date()), false));
ok("isIsoDate rejects garbage", () => { assert.equal(isIsoDate("nope"), false); assert.equal(isIsoDate(""), false); assert.equal(isIsoDate(null), false); });

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

ok("daysUntil forward", () => assert.equal(daysUntil("2026-08-01", "2026-07-21"), 11));
ok("daysUntil backward is negative", () => assert.equal(daysUntil("2026-07-01", "2026-07-21"), -20));
ok("daysUntil same day is 0", () => assert.equal(daysUntil("2026-07-21", "2026-07-21"), 0));
ok("daysUntil across NZ DST is whole days", () => assert.equal(daysUntil("2026-09-28", "2026-09-26"), 2));
ok("daysUntil rejects a bad date", () => { assert.equal(daysUntil("nope", "2026-07-21"), null); assert.equal(daysUntil("2026-07-21", "nope"), null); });
ok("daysUntil rejects 31 Feb (Date.UTC would silently roll it over)", () => assert.equal(daysUntil("2026-02-31", "2026-01-01"), null));

// ── stockStatus — priority order ─────────────────────────────────────────────
ok("qty <= 0 is always OUT, even with no reorder level", () => {
  assert.equal(stockStatus(0, null), "out");
  assert.equal(stockStatus(-1, 5), "out");
});
ok("qty at or under the reorder level is LOW", () => {
  assert.equal(stockStatus(5, 5), "low");
  assert.equal(stockStatus(3, 5), "low");
});
ok("qty above the reorder level is OK", () => assert.equal(stockStatus(10, 5), "ok"));
ok("no reorder level set reads NO_LEVEL, not OK", () => assert.equal(stockStatus(50, null), "no_level"));
ok("out beats no_level", () => assert.equal(stockStatus(0, null), "out"));

// ── supplyStockStatus — archived never counts ────────────────────────────────
ok("an active out-of-stock supply reads OUT", () =>
  assert.equal(supplyStockStatus({ status: "active", qtyOnHand: 0, reorderLevel: 5 }), "out"));
ok("an ARCHIVED supply reads OK regardless of quantity — it never counts", () => {
  assert.equal(supplyStockStatus({ status: "archived", qtyOnHand: 0, reorderLevel: 5 }), "ok");
  assert.equal(supplyStockStatus({ status: "archived", qtyOnHand: -5, reorderLevel: null }), "ok");
});

// ── serviceStatus ─────────────────────────────────────────────────────────────
const T = "2026-07-21";
ok("no next-service date reads UNKNOWN, never OK", () => assert.equal(serviceStatus(null, T), "unknown"));
ok("undefined next-service date reads UNKNOWN", () => assert.equal(serviceStatus(undefined, T), "unknown"));
ok("a past due date is OVERDUE", () => assert.equal(serviceStatus("2026-07-01", T), "overdue"));
ok("due today is due_soon (0 days out), not overdue", () => assert.equal(serviceStatus(T, T), "due_soon"));
ok("due within the window is DUE_SOON", () => assert.equal(serviceStatus("2026-08-10", T), "due_soon"));
ok("due right at the edge of the window is DUE_SOON", () => {
  const edge = "2026-08-20"; // exactly SERVICE_DUE_SOON_DAYS (30) out from 2026-07-21
  assert.equal(daysUntil(edge, T), SERVICE_DUE_SOON_DAYS);
  assert.equal(serviceStatus(edge, T), "due_soon");
});
ok("due just past the window is OK", () => assert.equal(serviceStatus("2026-08-21", T), "ok"));
ok("a malformed date reads UNKNOWN, never a throw", () => assert.equal(serviceStatus("not-a-date", T), "unknown"));
ok("a custom due-soon window is respected", () => assert.equal(serviceStatus("2026-07-28", T, 7), "due_soon"));

// ── assetServiceStatus — retired never nags ──────────────────────────────────
ok("an active machine with no service date reads UNKNOWN", () =>
  assert.equal(assetServiceStatus({ status: "active", nextServiceDueOn: null }, T), "unknown"));
ok("an active overdue machine reads OVERDUE", () =>
  assert.equal(assetServiceStatus({ status: "active", nextServiceDueOn: "2026-01-01" }, T), "overdue"));
ok("a RETIRED machine reads OK regardless of its next-service date — it never nags", () => {
  assert.equal(assetServiceStatus({ status: "retired", nextServiceDueOn: null }, T), "ok");
  assert.equal(assetServiceStatus({ status: "retired", nextServiceDueOn: "2020-01-01" }, T), "ok");
});

// ── worstServiceStatus — the rollup ranking ──────────────────────────────────
ok("an empty list is OK", () => assert.equal(worstServiceStatus([]), "ok"));
ok("all ok stays ok", () => assert.equal(worstServiceStatus(["ok", "ok"]), "ok"));
ok("UNKNOWN beats OK — an unaudited machine is not fine", () =>
  assert.equal(worstServiceStatus(["ok", "unknown"]), "unknown"));
ok("due_soon beats unknown", () => assert.equal(worstServiceStatus(["unknown", "due_soon"]), "due_soon"));
ok("overdue beats everything", () => assert.equal(worstServiceStatus(["overdue", "due_soon", "unknown", "ok"]), "overdue"));
ok("order of the input list doesn't matter", () => {
  assert.equal(worstServiceStatus(["ok", "overdue", "unknown"]), "overdue");
  assert.equal(worstServiceStatus(["overdue", "ok", "unknown"]), "overdue");
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
  assert.equal(dollarsToCents("19.99"), 1999);
});

console.log(`\n${passed} assertions passed`);
if (process.exitCode) console.error("SOME TESTS FAILED");
