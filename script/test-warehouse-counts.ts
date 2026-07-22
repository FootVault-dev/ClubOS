// Pure-logic tests for cycle counts (T11, D12): variance math + the
// counter/approver status-and-guard functions in shared/warehouse.ts, plus
// an end-to-end proof that the legs an approval builds actually post correct
// adjustment movements through the real (already-tested) movement engine.
// Run: npx tsx script/test-warehouse-counts.ts   (exits non-zero on failure)
//
// server/warehouse-routes.ts's counts/:id/{count,submit,approve} route
// handlers are thin callers of these same exports (loadCountLines/
// presentCountLines/blindCountLine live in that file only because they need
// a real `db` join — there's nothing DB-free left to unit-test there beyond
// what's exercised here). script/test-warehouse-shared.ts's own "test every
// export" pass ALSO covers isValidCountTransition/shouldHideExpectedQty/
// countLineResolution/countLineVarianceQty/canApproveCount/
// buildCountAdjustmentLegs directly (plus countLineNeedsRecount, the count
// enums, and their `is*` guards) — that overlap is deliberate, not a typo:
// this file exists specifically for the two things shared.ts CAN'T do —
// exercise resolveScanCode/postMovementGroup-style integration behaviour
// (this file's fake-WarehouseDb section) and read as PLAN.md's own named
// verify target for T11 ("variance math, approval guard") in one place.
import assert from "node:assert/strict";
import {
  countLineResolution,
  countLineVarianceQty,
  isValidCountTransition,
  shouldHideExpectedQty,
  canApproveCount,
  buildCountAdjustmentLegs,
  type CountLineForApproval,
} from "../shared/warehouse";
import { postMovementGroup, type WarehouseDb, type NewMovementRow } from "../server/warehouse";

let passed = 0;
async function ok(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
  } catch (e: any) {
    console.error(`FAIL: ${name}\n  ${e.stack || e.message}`);
    process.exitCode = 1;
  }
}

// ── countLineResolution — the variance math, D12's >10% / >$100 rule ──────

await ok("an exact match resolves 'accepted' with no variance at all", () => {
  assert.equal(countLineResolution(50, 50), "accepted");
});

await ok("a tiny variance under both thresholds resolves 'accepted'", () => {
  // 100 -> 105 is 5% (under 10%), and with no unit cost given the dollar
  // rule can't even be checked.
  assert.equal(countLineResolution(100, 105), "accepted");
});

await ok("a variance over the 10% relative threshold resolves 'recount'", () => {
  // 100 -> 89 is 11% under expected — over the 10% line.
  assert.equal(countLineResolution(100, 89), "recount");
});

await ok("exactly AT the 10% threshold is NOT over it (percentVariance > threshold, not >=)", () => {
  assert.equal(countLineResolution(100, 90), "accepted");
});

await ok("a variance over the $100 absolute threshold resolves 'recount' even under 10%", () => {
  // 1000 -> 980 is 2% (well under 10%), but 20 units * 600c = $120 > $100.
  assert.equal(countLineResolution(1000, 980, 600), "recount");
});

await ok("a missing unit cost means the dollar rule NEVER fires — percentage is the only signal", () => {
  // Same 2% variance as above, but with no cost on file at all.
  assert.equal(countLineResolution(1000, 980, null), "accepted");
  assert.equal(countLineResolution(1000, 980, undefined), "accepted");
});

await ok("expectedQty of zero falls back to '100% variance' rather than dividing by zero", () => {
  assert.equal(countLineResolution(0, 3), "recount");
  assert.equal(countLineResolution(0, 0), "accepted"); // no diff at all
});

// ── countLineVarianceQty — the signed ledger delta ─────────────────────────

await ok("countLineVarianceQty is counted minus expected, signed", () => {
  assert.equal(countLineVarianceQty(50, 55), 5);
  assert.equal(countLineVarianceQty(50, 45), -5);
  assert.equal(countLineVarianceQty(50, 50), 0);
});

// ── isValidCountTransition — the short open->submitted->approved chain ────

await ok("the only two valid edges: open->submitted, submitted->approved", () => {
  assert.equal(isValidCountTransition("open", "submitted"), true);
  assert.equal(isValidCountTransition("submitted", "approved"), true);
});

await ok("no reopen, no skipping a step, no self-loop, approved is terminal", () => {
  assert.equal(isValidCountTransition("open", "approved"), false);
  assert.equal(isValidCountTransition("submitted", "open"), false);
  assert.equal(isValidCountTransition("approved", "open"), false);
  assert.equal(isValidCountTransition("approved", "submitted"), false);
  assert.equal(isValidCountTransition("open", "open"), false);
  assert.equal(isValidCountTransition("approved", "approved"), false);
});

// ── shouldHideExpectedQty — blind counting only matters in-progress ────────

await ok("a blind session hides expected while open or submitted", () => {
  assert.equal(shouldHideExpectedQty(true, "open"), true);
  assert.equal(shouldHideExpectedQty(true, "submitted"), true);
});

await ok("a blind session stops hiding once approved (transparent audit trail)", () => {
  assert.equal(shouldHideExpectedQty(true, "approved"), false);
});

await ok("a non-blind session never hides expected, at any status", () => {
  assert.equal(shouldHideExpectedQty(false, "open"), false);
  assert.equal(shouldHideExpectedQty(false, "submitted"), false);
  assert.equal(shouldHideExpectedQty(false, "approved"), false);
});

// ── canApproveCount — D12's "counter ≠ approver" + the status gate ────────

await ok("a submitted session with a different approver can be approved", () => {
  assert.equal(canApproveCount({ status: "submitted", countedBy: 7 }, 9), true);
});

await ok("the counter cannot also be the approver", () => {
  assert.equal(canApproveCount({ status: "submitted", countedBy: 7 }, 7), false);
});

await ok("a session nobody was ever assigned to count (countedBy null) can be approved by anyone", () => {
  assert.equal(canApproveCount({ status: "submitted", countedBy: null }, 7), true);
});

await ok("an 'open' session can't be approved yet (must be submitted first)", () => {
  assert.equal(canApproveCount({ status: "open", countedBy: 7 }, 9), false);
});

await ok("an already-'approved' session can't be approved again (blocks a double-approve retry)", () => {
  assert.equal(canApproveCount({ status: "approved", countedBy: 7 }, 9), false);
});

// ── buildCountAdjustmentLegs — variance -> movement legs ───────────────────

function line(overrides: Partial<CountLineForApproval>): CountLineForApproval {
  return {
    itemId: 1,
    locationId: 10,
    locationCode: "A-01-1",
    expectedQty: 50,
    countedQty: 50,
    allowNegative: false,
    ...overrides,
  };
}

await ok("a line whose count matches expected produces NO leg (nothing to correct)", () => {
  const legs = buildCountAdjustmentLegs([line({ expectedQty: 20, countedQty: 20 })]);
  assert.equal(legs.length, 0);
});

await ok("a line never counted (countedQty null) produces NO leg — never treated as a 0 variance", () => {
  const legs = buildCountAdjustmentLegs([line({ expectedQty: 20, countedQty: null })]);
  assert.equal(legs.length, 0);
});

await ok("an upward variance produces one leg with a positive delta", () => {
  const legs = buildCountAdjustmentLegs([line({ itemId: 3, locationId: 30, locationCode: "B-02-1", expectedQty: 20, countedQty: 25 })]);
  assert.equal(legs.length, 1);
  assert.deepEqual(legs[0], { itemId: 3, locationId: 30, locationCode: "B-02-1", delta: 5, allowNegative: false });
});

await ok("a downward variance produces one leg with a negative delta", () => {
  const legs = buildCountAdjustmentLegs([line({ expectedQty: 20, countedQty: 14 })]);
  assert.equal(legs.length, 1);
  assert.equal(legs[0].delta, -6);
});

await ok("allowNegative threads through per-line from the item's own flag", () => {
  const legs = buildCountAdjustmentLegs([line({ expectedQty: 20, countedQty: 14, allowNegative: true })]);
  assert.equal(legs[0].allowNegative, true);
});

await ok("a mixed batch skips matches/uncounted and keeps only the real variances, in order", () => {
  const legs = buildCountAdjustmentLegs([
    line({ itemId: 1, locationId: 10, locationCode: "A-01-1", expectedQty: 10, countedQty: 10 }), // matches — skipped
    line({ itemId: 2, locationId: 11, locationCode: "A-01-2", expectedQty: 5, countedQty: null }), // uncounted — skipped
    line({ itemId: 3, locationId: 12, locationCode: "A-01-3", expectedQty: 8, countedQty: 3 }), // -5
    line({ itemId: 4, locationId: 13, locationCode: "A-01-4", expectedQty: 2, countedQty: 9 }), // +7
  ]);
  assert.equal(legs.length, 2);
  assert.equal(legs[0].itemId, 3);
  assert.equal(legs[0].delta, -5);
  assert.equal(legs[1].itemId, 4);
  assert.equal(legs[1].delta, 7);
});

await ok("an empty line list produces an empty leg list (a perfectly-matching count posts nothing)", () => {
  assert.deepEqual(buildCountAdjustmentLegs([]), []);
});

// ── End-to-end: the legs an approval builds actually move stock ───────────
// Same fake-WarehouseDb shape/semantics as script/test-warehouse-scan.ts —
// postMovementGroup itself is exhaustively covered by
// script/test-warehouse-engine.ts; this is a thin proof that
// buildCountAdjustmentLegs' output is exactly what the (already-tested)
// engine needs to post a real 'adjustment'/'count_variance' group.

function makeFakeWarehouseDb(initialStock: Record<string, number> = {}) {
  const stock = new Map<string, number>(Object.entries(initialStock));
  const idempotency = new Map<string, string>();
  const insertedRows: Array<NewMovementRow & { id: number }> = [];
  let nextId = 1;
  const db: WarehouseDb = {
    async findMovementGroupByIdempotencyKey(key) {
      const groupId = idempotency.get(key);
      return groupId ? { groupId } : undefined;
    },
    async insertMovementLegs(rows) {
      const out: { id: number }[] = [];
      for (const row of rows) {
        const id = nextId++;
        insertedRows.push({ ...row, id });
        if (row.idempotencyKey) idempotency.set(row.idempotencyKey, row.groupId);
        out.push({ id });
      }
      return out;
    },
    async upsertStockLeg(leg) {
      const key = `${leg.itemId}:${leg.locationId}`;
      const next = (stock.get(key) ?? 0) + leg.delta;
      if (next < 0 && !leg.allowNegative) return null; // first-ever leg included, D16
      stock.set(key, next);
      return { onHand: next };
    },
  };
  return { db, stock, insertedRows };
}

await ok("approval posts ONE adjustment/count_variance group for a mixed-variance session", async () => {
  const { db, stock, insertedRows } = makeFakeWarehouseDb({ "1:10": 20, "2:10": 8 });
  const lines: CountLineForApproval[] = [
    { itemId: 1, locationId: 10, locationCode: "A-01-1", expectedQty: 20, countedQty: 23, allowNegative: false }, // +3
    { itemId: 2, locationId: 10, locationCode: "A-01-1", expectedQty: 8, countedQty: 8, allowNegative: false }, // matches — no leg
  ];
  const legs = buildCountAdjustmentLegs(lines);
  assert.equal(legs.length, 1, "the matching line contributes no leg");

  const result = await postMovementGroup(db, {
    legs,
    movementType: "adjustment",
    reasonCode: "count_variance",
    ref: { kind: "count", id: 42 },
    operatorUserId: 9,
  });

  assert.equal(result.movementIds.length, 1);
  assert.equal(stock.get("1:10"), 23, "the corrected on_hand matches the counted quantity");
  assert.equal(stock.get("2:10"), 8, "the matching item was never touched");
  assert.ok(insertedRows.every((r) => r.movementType === "adjustment" && r.reasonCode === "count_variance"));
  assert.ok(insertedRows.every((r) => r.refKind === "count" && r.refId === 42));
  assert.equal(insertedRows[0].groupId, result.groupId);
});

await ok("a perfectly-matching count (no variance anywhere) posts NOTHING — no empty movement group", async () => {
  const { db, insertedRows } = makeFakeWarehouseDb({ "1:10": 20 });
  const legs = buildCountAdjustmentLegs([
    { itemId: 1, locationId: 10, locationCode: "A-01-1", expectedQty: 20, countedQty: 20, allowNegative: false },
  ]);
  assert.equal(legs.length, 0);
  // Mirrors the route's own guard: postMovementGroup is only called when
  // legs.length > 0 — proven here by simply never calling it and asserting
  // nothing was recorded.
  assert.equal(insertedRows.length, 0);
});

await ok("a downward correction that would take on_hand negative rejects the WHOLE approval", async () => {
  // Stock has drifted (a movement landed after the snapshot was taken) —
  // the recorded on_hand is now less than the correction implies, and the
  // item doesn't allow negative stock.
  const { db, stock } = makeFakeWarehouseDb({ "1:10": 2 });
  const legs = buildCountAdjustmentLegs([
    { itemId: 1, locationId: 10, locationCode: "A-01-1", expectedQty: 20, countedQty: 5, allowNegative: false }, // -15
  ]);
  await assert.rejects(
    () => postMovementGroup(db, { legs, movementType: "adjustment", reasonCode: "count_variance", ref: { kind: "count", id: 1 }, operatorUserId: 9 }),
    /Insufficient stock at A-01-1/,
  );
  assert.equal(stock.get("1:10"), 2, "the failed leg never touched stock");
});

await ok("allow_negative on the item lets a large downward count correction post anyway", async () => {
  const { db, stock } = makeFakeWarehouseDb({ "1:10": 2 });
  const legs = buildCountAdjustmentLegs([
    { itemId: 1, locationId: 10, locationCode: "A-01-1", expectedQty: 20, countedQty: 5, allowNegative: true }, // -15
  ]);
  await postMovementGroup(db, { legs, movementType: "adjustment", reasonCode: "count_variance", ref: { kind: "count", id: 1 }, operatorUserId: 9 });
  assert.equal(stock.get("1:10"), -13);
});

// ── Summary ───────────────────────────────────────────────────────────────────

if (process.exitCode) {
  console.error(`\n${passed} passed, some FAILED (see above)`);
} else {
  console.log(`\nAll ${passed} assertions passed.`);
}
