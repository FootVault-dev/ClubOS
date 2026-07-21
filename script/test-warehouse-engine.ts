// Pure-logic tests for server/warehouse.ts (the movement engine).
// Run: npx tsx script/test-warehouse-engine.ts   (exits non-zero on failure)
//
// No real DB: postMovementGroup/reconcileStock take a bespoke WarehouseDb /
// ReconcileDb (see the file-header comment in server/warehouse.ts for why —
// short version: the two real queries here (a computed guarded upsert, a
// full-outer-join aggregate) aren't practically fakeable via drizzle's raw
// query-builder chain the way server/accounting/post.ts's single
// onConflictDoNothing() call was, so the fake below implements the seam
// interfaces directly against in-memory Maps instead of pretending to be
// drizzle).
import assert from "node:assert/strict";
import {
  postMovementGroup,
  reconcileStock,
  InsufficientStockError,
  type WarehouseDb,
  type ReconcileDb,
  type NewMovementRow,
  type PostMovementGroupInput,
} from "../server/warehouse";

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

// ── Fake WarehouseDb ─────────────────────────────────────────────────────────
// Mirrors the real atomic-upsert semantics that matter to callers: a
// PRE-EXISTING (item,location) row is guarded (delta would take on_hand
// negative -> reject, unless allowNegative); a genuinely first-ever row for
// that (item,location) always succeeds (mirrors real Postgres
// INSERT...ON CONFLICT...DO UPDATE...WHERE — the guard only fires on the
// conflict/UPDATE path, never the plain INSERT path — SPEC §4.2's literal
// wording, restated in server/warehouse.ts).
function makeFakeDb(initialStock: Record<string, number> = {}) {
  const stock = new Map<string, number>(Object.entries(initialStock));
  const idempotency = new Map<string, string>();
  const insertedRows: Array<NewMovementRow & { id: number }> = [];
  let nextId = 1;
  const calls = { findIdempotency: 0, insertMovementLegs: 0, upsertStockLeg: 0 };

  const db: WarehouseDb = {
    async findMovementGroupByIdempotencyKey(key) {
      calls.findIdempotency++;
      const groupId = idempotency.get(key);
      return groupId ? { groupId } : undefined;
    },
    async insertMovementLegs(rows) {
      calls.insertMovementLegs++;
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
      calls.upsertStockLeg++;
      const key = `${leg.itemId}:${leg.locationId}`;
      const hadExisting = stock.has(key);
      const newOnHand = (hadExisting ? stock.get(key)! : 0) + leg.delta;
      if (hadExisting && !leg.allowNegative && newOnHand < 0) {
        return null; // guard failed — 0 rows updated
      }
      stock.set(key, newOnHand);
      return { onHand: newOnHand };
    },
  };

  return { db, stock, insertedRows, calls };
}

function input(overrides: Partial<PostMovementGroupInput> = {}): PostMovementGroupInput {
  return {
    legs: [{ itemId: 1, locationId: 10, locationCode: "A-01-1", delta: -3 }],
    movementType: "pick",
    operatorUserId: 7,
    ...overrides,
  };
}

// ── Validation — rejected before any DB call ─────────────────────────────────

await ok("delta 0 rejected, no DB calls made", async () => {
  const { db, calls } = makeFakeDb();
  await assert.rejects(
    () => postMovementGroup(db, input({ legs: [{ itemId: 1, locationId: 10, locationCode: "A-01-1", delta: 0 }] })),
    /non-zero/,
  );
  assert.equal(calls.findIdempotency, 0);
  assert.equal(calls.insertMovementLegs, 0);
  assert.equal(calls.upsertStockLeg, 0);
});

await ok("unknown movement type rejected", async () => {
  const { db } = makeFakeDb();
  await assert.rejects(
    () => postMovementGroup(db, input({ movementType: "teleport" as any })),
    /unknown movement type/,
  );
});

await ok("unknown reason code rejected", async () => {
  const { db } = makeFakeDb();
  await assert.rejects(() => postMovementGroup(db, input({ reasonCode: "lost_in_space" as any })), /unknown reason code/);
});

await ok("unknown leg-level reason code rejected", async () => {
  const { db } = makeFakeDb();
  await assert.rejects(
    () =>
      postMovementGroup(
        db,
        input({ legs: [{ itemId: 1, locationId: 10, locationCode: "A", delta: -1, reasonCode: "nonsense" as any }] }),
      ),
    /unknown leg reason code/,
  );
});

await ok("unknown ref kind rejected", async () => {
  const { db } = makeFakeDb();
  await assert.rejects(
    () => postMovementGroup(db, input({ ref: { kind: "carrier_pigeon" as any, id: 1 } })),
    /unknown ref kind/,
  );
});

await ok("missing operatorUserId rejected (D17)", async () => {
  const { db } = makeFakeDb();
  await assert.rejects(() => postMovementGroup(db, input({ operatorUserId: 0 })), /operatorUserId is required/);
});

await ok("empty legs array rejected", async () => {
  const { db } = makeFakeDb();
  await assert.rejects(() => postMovementGroup(db, input({ legs: [] })), /at least one leg/);
});

await ok("transfer legs must sum to zero", async () => {
  const { db, calls } = makeFakeDb();
  await assert.rejects(
    () =>
      postMovementGroup(
        db,
        input({
          movementType: "transfer",
          legs: [
            { itemId: 1, locationId: 10, locationCode: "A", delta: -5 },
            { itemId: 1, locationId: 20, locationCode: "B", delta: 3 },
          ],
        }),
      ),
    /transfer legs must sum to zero/,
  );
  assert.equal(calls.insertMovementLegs, 0, "no ledger row written when validation fails");
});

// ── Idempotent replay ─────────────────────────────────────────────────────────

await ok("idempotent replay returns prior result, touches nothing else", async () => {
  const { db, calls, stock } = makeFakeDb({ "1:10": 10 });
  const call = input({
    idempotencyKey: "webhook-abc",
    legs: [{ itemId: 1, locationId: 10, locationCode: "A-01-1", delta: -3 }],
  });

  const first = await postMovementGroup(db, call);
  assert.equal(first.alreadyProcessed, false);
  assert.equal(stock.get("1:10"), 7);
  assert.equal(calls.insertMovementLegs, 1);
  assert.equal(calls.upsertStockLeg, 1);
  assert.equal(calls.findIdempotency, 1);

  // Replay — same idempotencyKey, DB state must not move an inch.
  const second = await postMovementGroup(db, call);
  assert.equal(second.alreadyProcessed, true);
  assert.equal(second.groupId, first.groupId);
  assert.deepEqual(second.movementIds, []);
  assert.deepEqual(second.affectedItemIds, []);
  assert.equal(stock.get("1:10"), 7, "stock must be untouched by a replay");
  assert.equal(calls.insertMovementLegs, 1, "no second ledger insert");
  assert.equal(calls.upsertStockLeg, 1, "no second stock upsert");
  assert.equal(calls.findIdempotency, 2, "the idempotency lookup itself still runs every call");
});

await ok("only the first leg's row carries the idempotency key", async () => {
  const { db, insertedRows } = makeFakeDb({ "1:10": 10, "1:20": 10 });
  await postMovementGroup(
    db,
    input({
      movementType: "transfer",
      idempotencyKey: "xfer-1",
      legs: [
        { itemId: 1, locationId: 10, locationCode: "A", delta: -4 },
        { itemId: 1, locationId: 20, locationCode: "B", delta: 4 },
      ],
    }),
  );
  const keyed = insertedRows.filter((r) => r.idempotencyKey === "xfer-1");
  assert.equal(keyed.length, 1, "the unique idempotency_key column can only carry one non-null value per group");
  assert.equal(insertedRows.filter((r) => r.idempotencyKey === null).length, 1);
});

// ── Insufficient stock rejects the whole group ───────────────────────────────

await ok("insufficient stock on ANY leg throws InsufficientStockError", async () => {
  const { db, calls } = makeFakeDb({ "1:10": 10, "2:20": 2 });
  const call = input({
    legs: [
      { itemId: 1, locationId: 10, locationCode: "A-01-1", delta: -5 }, // would succeed alone (10 -> 5)
      { itemId: 2, locationId: 20, locationCode: "QUARANTINE", delta: -5 }, // 2 - 5 = -3, guarded
    ],
  });
  await assert.rejects(() => postMovementGroup(db, call), (err: unknown) => {
    assert.ok(err instanceof InsufficientStockError);
    assert.equal((err as InsufficientStockError).locationCode, "QUARANTINE");
    assert.equal((err as InsufficientStockError).itemId, 2);
    return true;
  });
  // The ledger insert happens BEFORE the stock loop (SPEC §4.2 step order) —
  // in production this is inside a real db.transaction(), so the throw rolls
  // the whole thing back. This fake has no transaction to roll back, which is
  // why the reliance is documented rather than asserted away here.
  assert.equal(calls.insertMovementLegs, 1);
  assert.equal(calls.upsertStockLeg, 2, "both legs are attempted — the SECOND one is what fails");
});

// ── allow_negative bypass (D16) ───────────────────────────────────────────────

await ok("allow_negative bypasses the guard", async () => {
  const { db, stock } = makeFakeDb({ "1:10": 2 });
  const result = await postMovementGroup(
    db,
    input({
      legs: [{ itemId: 1, locationId: 10, locationCode: "MATERIALS", delta: -10, allowNegative: true }],
    }),
  );
  assert.equal(result.alreadyProcessed, false);
  assert.equal(stock.get("1:10"), -8);
});

await ok("a genuinely first-ever row always succeeds regardless of sign (no prior row to guard)", async () => {
  const { db, stock } = makeFakeDb(); // no seed at all
  await postMovementGroup(db, input({ legs: [{ itemId: 9, locationId: 90, locationCode: "NEW-BIN", delta: -1 }] }));
  assert.equal(stock.get("9:90"), -1);
});

// ── Transfer happy path — multi-leg groups share one groupId ─────────────────

await ok("transfer: two legs, shared groupId, correct resulting stock", async () => {
  const { db, stock, insertedRows } = makeFakeDb({ "1:10": 20 });
  const result = await postMovementGroup(
    db,
    input({
      movementType: "transfer",
      legs: [
        { itemId: 1, locationId: 10, locationCode: "A", delta: -5 },
        { itemId: 1, locationId: 20, locationCode: "B", delta: 5 },
      ],
    }),
  );
  assert.equal(stock.get("1:10"), 15);
  assert.equal(stock.get("1:20"), 5);
  assert.equal(result.movementIds.length, 2);
  const group = insertedRows.filter((r) => r.id === result.movementIds[0] || r.id === result.movementIds[1]);
  assert.equal(group.length, 2);
  assert.ok(group.every((r) => r.groupId === result.groupId));
  assert.ok(group.every((r) => r.movementType === "transfer"));
  assert.deepEqual(result.affectedItemIds, [1]);
});

// ── Leg-level reasonCode override ────────────────────────────────────────────

await ok("leg-level reasonCode overrides the group default", async () => {
  const { db, insertedRows } = makeFakeDb();
  await postMovementGroup(
    db,
    input({
      movementType: "receipt",
      reasonCode: undefined,
      legs: [
        { itemId: 1, locationId: 10, locationCode: "RECEIVING", delta: 8 },
        { itemId: 1, locationId: 90, locationCode: "QUARANTINE", delta: 2, reasonCode: "damaged" },
      ],
    }),
  );
  const good = insertedRows.find((r) => r.locationId === 10);
  const damaged = insertedRows.find((r) => r.locationId === 90);
  assert.equal(good?.reasonCode, null);
  assert.equal(damaged?.reasonCode, "damaged");
});

// ── Nightly reconcile ─────────────────────────────────────────────────────────

function makeFakeReconcileDb(
  rows: Array<{ itemId: number; locationId: number; cachedOnHand: number; ledgerSum: number }>,
) {
  const repairs: Array<{ itemId: number; locationId: number; correctOnHand: number }> = [];
  const db: ReconcileDb = {
    async listStockVsLedger() {
      return rows;
    },
    async repairStock(itemId, locationId, correctOnHand) {
      repairs.push({ itemId, locationId, correctOnHand });
    },
  };
  return { db, repairs };
}

await ok("reconcile: no drift means nothing is repaired", async () => {
  const { db, repairs } = makeFakeReconcileDb([
    { itemId: 1, locationId: 10, cachedOnHand: 5, ledgerSum: 5 },
    { itemId: 2, locationId: 20, cachedOnHand: 0, ledgerSum: 0 },
  ]);
  const result = await reconcileStock(db);
  assert.equal(result.checked, 2);
  assert.deepEqual(result.drifts, []);
  assert.equal(repairs.length, 0);
});

await ok("reconcile: drift is repaired from the ledger and reported", async () => {
  const { db, repairs } = makeFakeReconcileDb([
    { itemId: 1, locationId: 10, cachedOnHand: 5, ledgerSum: 5 }, // clean
    { itemId: 2, locationId: 20, cachedOnHand: 9, ledgerSum: 4 }, // drifted — cache is stale
  ]);
  const result = await reconcileStock(db);
  assert.equal(result.checked, 2);
  assert.equal(result.drifts.length, 1);
  assert.deepEqual(result.drifts[0], { itemId: 2, locationId: 20, cachedOnHand: 9, ledgerSum: 4 });
  assert.equal(repairs.length, 1);
  assert.deepEqual(repairs[0], { itemId: 2, locationId: 20, correctOnHand: 4 });
});

// ── Summary ───────────────────────────────────────────────────────────────────

if (process.exitCode) {
  console.error(`\n${passed} passed, some FAILED (see above)`);
} else {
  console.log(`\nAll ${passed} assertions passed.`);
}
