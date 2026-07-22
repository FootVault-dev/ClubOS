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
  reserveStock,
  releaseReservation,
  releaseReservationsForRef,
  consumeReservation,
  InsufficientAvailableError,
  type WarehouseDb,
  type ReconcileDb,
  type ReservationDb,
  type ReservationRow,
  type NewMovementRow,
  type PostMovementGroupInput,
} from "../server/warehouse";
import type { RefKind, ReservationStatus } from "../shared/warehouse";

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
// Mirrors the real atomic-upsert semantics that matter to callers: EVERY
// (item,location) leg is guarded — delta would take on_hand negative ->
// reject, unless allowNegative — including a genuinely first-ever row for
// that (item,location) (real Postgres seeds a zero row first via
// INSERT...ON CONFLICT DO NOTHING, then runs a guarded UPDATE, so the guard
// applies uniformly regardless of whether a row pre-existed — see
// server/warehouse.ts).
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
      const newOnHand = (stock.get(key) ?? 0) + leg.delta;
      if (!leg.allowNegative && newOnHand < 0) {
        return null; // guard failed — 0 rows updated (first-ever leg included, D16)
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

await ok("a genuinely first-ever (item,location) leg is guarded exactly like an existing row (D2/D16)", async () => {
  const { db, stock } = makeFakeDb(); // no seed at all
  await assert.rejects(
    () => postMovementGroup(db, input({ legs: [{ itemId: 9, locationId: 90, locationCode: "NEW-BIN", delta: -1 }] })),
    (err: unknown) => {
      assert.ok(err instanceof InsufficientStockError);
      assert.equal((err as InsufficientStockError).locationCode, "NEW-BIN");
      return true;
    },
  );
  assert.equal(stock.has("9:90"), false, "no negative row was left behind");
});

await ok("a genuinely first-ever (item,location) leg with allow_negative still succeeds (D16)", async () => {
  const { db, stock } = makeFakeDb(); // no seed at all
  await postMovementGroup(
    db,
    input({ legs: [{ itemId: 9, locationId: 90, locationCode: "NEW-BIN", delta: -1, allowNegative: true }] }),
  );
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

// ── Reservations (T5) ─────────────────────────────────────────────────────────
// One combined fake satisfying WarehouseDb & ReservationDb — reserveStock and
// releaseReservation only ever touch the ReservationDb half; consumeReservation
// needs both (it posts a movement AND updates a reservation in one call), and
// the two halves must share the SAME underlying stock map so a consume's
// stock decrement is visible to a subsequent getAvailableForItem call.

function makeFakeCombinedDb(
  opts: {
    /** (item,location) -> starting on_hand. */
    stock?: Array<{ itemId: number; locationId: number; onHand: number }>;
    /** Location ids excluded from `available` (mirrors QUARANTINE/virtual
     *  locations being filtered out of getAvailableForItem's real SQL). */
    nonSellableLocationIds?: number[];
    reservations?: Array<{
      id: number;
      itemId: number;
      qty: number;
      refKind: RefKind;
      refId: number;
      status: ReservationStatus;
    }>;
  } = {},
) {
  const stock = new Map<string, number>();
  for (const s of opts.stock ?? []) stock.set(`${s.itemId}:${s.locationId}`, s.onHand);
  const nonSellable = new Set(opts.nonSellableLocationIds ?? []);
  const reservations = new Map<number, ReservationRow>();
  let nextReservationId = 1;
  for (const r of opts.reservations ?? []) {
    reservations.set(r.id, { ...r });
    nextReservationId = Math.max(nextReservationId, r.id + 1);
  }
  const movementRows: Array<NewMovementRow & { id: number }> = [];
  const idempotency = new Map<string, string>();
  let nextMovementId = 1;
  const calls = {
    findMovementGroupByIdempotencyKey: 0,
    insertMovementLegs: 0,
    upsertStockLeg: 0,
    getAvailableForItem: 0,
    insertReservation: 0,
    markReservationStatus: 0,
  };

  const db: WarehouseDb & ReservationDb = {
    // ── WarehouseDb half ──
    async findMovementGroupByIdempotencyKey(key) {
      calls.findMovementGroupByIdempotencyKey++;
      const groupId = idempotency.get(key);
      return groupId ? { groupId } : undefined;
    },
    async insertMovementLegs(rows) {
      calls.insertMovementLegs++;
      const out: { id: number }[] = [];
      for (const row of rows) {
        const id = nextMovementId++;
        movementRows.push({ ...row, id });
        if (row.idempotencyKey) idempotency.set(row.idempotencyKey, row.groupId);
        out.push({ id });
      }
      return out;
    },
    async upsertStockLeg(leg) {
      calls.upsertStockLeg++;
      const key = `${leg.itemId}:${leg.locationId}`;
      const newOnHand = (stock.get(key) ?? 0) + leg.delta;
      if (!leg.allowNegative && newOnHand < 0) return null; // first-ever leg included, D16
      stock.set(key, newOnHand);
      return { onHand: newOnHand };
    },
    // ── ReservationDb half ──
    async getAvailableForItem(itemId) {
      calls.getAvailableForItem++;
      let onHandSum = 0;
      for (const [key, qty] of stock.entries()) {
        const [itemPart, locPart] = key.split(":").map(Number);
        if (itemPart === itemId && !nonSellable.has(locPart)) onHandSum += qty;
      }
      const reservedSum = Array.from(reservations.values())
        .filter((r) => r.itemId === itemId && r.status === "active")
        .reduce((sum, r) => sum + r.qty, 0);
      return onHandSum - reservedSum;
    },
    async findActiveReservationByRef(ref, itemId) {
      const found = Array.from(reservations.values()).find(
        (r) => r.refKind === ref.kind && r.refId === ref.id && r.itemId === itemId && r.status === "active",
      );
      return found ? { id: found.id } : undefined;
    },
    async findActiveReservationsByRef(ref) {
      return Array.from(reservations.values()).filter(
        (r) => r.refKind === ref.kind && r.refId === ref.id && r.status === "active",
      );
    },
    async getReservationById(id) {
      return reservations.get(id);
    },
    async insertReservation(row) {
      calls.insertReservation++;
      const id = nextReservationId++;
      reservations.set(id, {
        id,
        itemId: row.itemId,
        qty: Number(row.qty),
        refKind: row.refKind,
        refId: row.refId,
        status: "active",
      });
      return { id };
    },
    async markReservationStatus(id, status) {
      calls.markReservationStatus++;
      const r = reservations.get(id);
      if (r) r.status = status;
    },
  };

  return { db, stock, reservations, movementRows, calls };
}

// ── reserveStock ──────────────────────────────────────────────────────────────

await ok("reserveStock: available drops by the reserved qty", async () => {
  const { db } = makeFakeCombinedDb({ stock: [{ itemId: 1, locationId: 10, onHand: 10 }] });
  const before = await db.getAvailableForItem(1);
  assert.equal(before, 10);
  const result = await reserveStock(db, { itemId: 1, qty: 3, ref: { kind: "shop_order", id: 100 } });
  assert.equal(result.alreadyReserved, false);
  const after = await db.getAvailableForItem(1);
  assert.equal(after, 7);
});

await ok("reserveStock: excludes non-sellable (quarantine/virtual) locations from available", async () => {
  const { db } = makeFakeCombinedDb({
    stock: [
      { itemId: 1, locationId: 10, onHand: 2 }, // sellable
      { itemId: 1, locationId: 99, onHand: 100 }, // QUARANTINE — excluded
    ],
    nonSellableLocationIds: [99],
  });
  assert.equal(await db.getAvailableForItem(1), 2);
  await assert.rejects(
    () => reserveStock(db, { itemId: 1, qty: 5, ref: { kind: "shop_order", id: 1 } }),
    (err: unknown) => {
      assert.ok(err instanceof InsufficientAvailableError);
      assert.equal((err as InsufficientAvailableError).available, 2);
      assert.equal((err as InsufficientAvailableError).requestedQty, 5);
      assert.equal((err as InsufficientAvailableError).itemId, 1);
      return true;
    },
  );
});

await ok("reserveStock: insufficient available throws InsufficientAvailableError, nothing inserted", async () => {
  const { db, calls } = makeFakeCombinedDb({ stock: [{ itemId: 1, locationId: 10, onHand: 2 }] });
  await assert.rejects(() => reserveStock(db, { itemId: 1, qty: 3, ref: { kind: "shop_order", id: 1 } }), InsufficientAvailableError);
  assert.equal(calls.insertReservation, 0);
});

await ok("reserveStock: idempotent per (ref, item) — second call is a no-op replay", async () => {
  const { db, calls } = makeFakeCombinedDb({ stock: [{ itemId: 1, locationId: 10, onHand: 10 }] });
  const ref = { kind: "shop_order" as RefKind, id: 42 };
  const first = await reserveStock(db, { itemId: 1, qty: 4, ref });
  assert.equal(first.alreadyReserved, false);
  assert.equal(calls.getAvailableForItem, 1);

  const second = await reserveStock(db, { itemId: 1, qty: 4, ref });
  assert.equal(second.alreadyReserved, true);
  assert.equal(second.reservationId, first.reservationId);
  assert.equal(calls.insertReservation, 1, "no second insert");
  assert.equal(calls.getAvailableForItem, 1, "availability is NOT re-checked on a replay");
});

await ok("reserveStock: rejects unknown ref kind and non-positive qty before touching the DB", async () => {
  const { db, calls } = makeFakeCombinedDb({ stock: [{ itemId: 1, locationId: 10, onHand: 10 }] });
  await assert.rejects(
    () => reserveStock(db, { itemId: 1, qty: 1, ref: { kind: "carrier_pigeon" as any, id: 1 } }),
    /unknown ref kind/,
  );
  await assert.rejects(() => reserveStock(db, { itemId: 1, qty: 0, ref: { kind: "shop_order", id: 1 } }), /greater than zero/);
  await assert.rejects(() => reserveStock(db, { itemId: 1, qty: -1, ref: { kind: "shop_order", id: 1 } }), /greater than zero/);
  assert.equal(calls.insertReservation, 0);
  assert.equal(calls.getAvailableForItem, 0);
});

// ── releaseReservation ────────────────────────────────────────────────────────

await ok("releaseReservation: releases an active reservation and restores available", async () => {
  const { db } = makeFakeCombinedDb({
    stock: [{ itemId: 1, locationId: 10, onHand: 10 }],
    reservations: [{ id: 1, itemId: 1, qty: 4, refKind: "shop_order", refId: 1, status: "active" }],
  });
  assert.equal(await db.getAvailableForItem(1), 6);
  const result = await releaseReservation(db, 1);
  assert.deepEqual(result, { released: true, itemId: 1 });
  assert.equal(await db.getAvailableForItem(1), 10);
});

await ok("releaseReservation: releasing an already-released reservation is a no-op", async () => {
  const { db, calls } = makeFakeCombinedDb({
    reservations: [{ id: 1, itemId: 1, qty: 4, refKind: "shop_order", refId: 1, status: "released" }],
  });
  const result = await releaseReservation(db, 1);
  assert.deepEqual(result, { released: false, itemId: 1 });
  assert.equal(calls.markReservationStatus, 0, "no write on a no-op");
});

await ok("releaseReservation: a consumed reservation can't be released", async () => {
  const { db } = makeFakeCombinedDb({
    reservations: [{ id: 1, itemId: 1, qty: 4, refKind: "shop_order", refId: 1, status: "consumed" }],
  });
  await assert.rejects(() => releaseReservation(db, 1), /already consumed/);
});

await ok("releaseReservation: unknown id throws", async () => {
  const { db } = makeFakeCombinedDb();
  await assert.rejects(() => releaseReservation(db, 999), /not found/);
});

await ok("releaseReservationsForRef: releases every active line of a ref, skips non-active ones", async () => {
  const { db } = makeFakeCombinedDb({
    reservations: [
      { id: 1, itemId: 1, qty: 2, refKind: "shop_order", refId: 5, status: "active" },
      { id: 2, itemId: 2, qty: 3, refKind: "shop_order", refId: 5, status: "active" },
      { id: 3, itemId: 3, qty: 1, refKind: "shop_order", refId: 5, status: "consumed" },
      { id: 4, itemId: 4, qty: 1, refKind: "shop_order", refId: 6, status: "active" }, // different ref
    ],
  });
  const result = await releaseReservationsForRef(db, { kind: "shop_order", id: 5 });
  assert.equal(result.releasedCount, 2);
  assert.deepEqual(result.itemIds.sort(), [1, 2]);
  assert.equal((await db.getReservationById(1))!.status, "released");
  assert.equal((await db.getReservationById(2))!.status, "released");
  assert.equal((await db.getReservationById(3))!.status, "consumed", "untouched — wasn't active");
  assert.equal((await db.getReservationById(4))!.status, "active", "untouched — different ref");
});

// ── consumeReservation ────────────────────────────────────────────────────────

await ok("consumeReservation: posts a dispatch movement, marks consumed, available unchanged", async () => {
  const { db, stock } = makeFakeCombinedDb({ stock: [{ itemId: 1, locationId: 10, onHand: 10 }] });
  const reserved = await reserveStock(db, { itemId: 1, qty: 4, ref: { kind: "shop_order", id: 1 } });
  const availableAfterReserve = await db.getAvailableForItem(1);
  assert.equal(availableAfterReserve, 6);

  const result = await consumeReservation(db, {
    reservationId: reserved.reservationId,
    locationId: 10,
    locationCode: "A-01-1",
    movementType: "dispatch",
    operatorUserId: 7,
  });
  assert.equal(result.movement.alreadyProcessed, false);
  assert.equal(stock.get("1:10"), 6, "on_hand dropped by the reservation's qty");
  assert.equal((await db.getReservationById(reserved.reservationId))!.status, "consumed");
  // Physical truth: it was already promised, now it's actually gone — the
  // AVAILABLE number itself doesn't move across a consume.
  assert.equal(await db.getAvailableForItem(1), availableAfterReserve);
});

await ok("consumeReservation: guard fires against a pre-existing too-low stock row (location-level guard)", async () => {
  // Reserved against 21 units of TOTAL item availability (across two bins),
  // but the specific bin the dispatch scan names only physically holds 1 —
  // the item-level `available` check inside reserveStock can't know in
  // advance which bin will actually be picked from.
  const { db } = makeFakeCombinedDb({
    stock: [
      { itemId: 1, locationId: 10, onHand: 20 }, // enough for the item overall
      { itemId: 1, locationId: 20, onHand: 1 }, // but THIS bin only has 1
    ],
  });
  const reserved = await reserveStock(db, { itemId: 1, qty: 5, ref: { kind: "shop_order", id: 1 } });
  await assert.rejects(
    () =>
      consumeReservation(db, {
        reservationId: reserved.reservationId,
        locationId: 20,
        locationCode: "LOW-BIN",
        movementType: "dispatch",
        operatorUserId: 7,
      }),
    (err: unknown) => {
      assert.ok(err instanceof InsufficientStockError);
      assert.equal((err as InsufficientStockError).locationCode, "LOW-BIN");
      return true;
    },
  );
  // The reservation must NOT have been marked consumed — the whole call threw.
  assert.equal((await db.getReservationById(reserved.reservationId))!.status, "active");
});

await ok("consumeReservation: idempotent replay — reservation untouched, no second stock write", async () => {
  const { db, calls } = makeFakeCombinedDb({ stock: [{ itemId: 1, locationId: 10, onHand: 10 }] });
  const reserved = await reserveStock(db, { itemId: 1, qty: 4, ref: { kind: "shop_order", id: 1 } });
  const input = {
    reservationId: reserved.reservationId,
    locationId: 10,
    locationCode: "A-01-1",
    movementType: "dispatch" as const,
    operatorUserId: 7,
    idempotencyKey: "dispatch-order-1",
  };
  const first = await consumeReservation(db, input);
  assert.equal(first.movement.alreadyProcessed, false);
  assert.equal(calls.markReservationStatus, 1);

  const second = await consumeReservation(db, input);
  assert.equal(second.movement.alreadyProcessed, true);
  assert.equal(calls.markReservationStatus, 1, "not called again on a replay");
  assert.equal((await db.getReservationById(reserved.reservationId))!.status, "consumed");
});

await ok("consumeReservation: a released reservation can't be consumed", async () => {
  const { db } = makeFakeCombinedDb({
    stock: [{ itemId: 1, locationId: 10, onHand: 10 }],
    reservations: [{ id: 1, itemId: 1, qty: 4, refKind: "shop_order", refId: 1, status: "released" }],
  });
  await assert.rejects(
    () =>
      consumeReservation(db, {
        reservationId: 1,
        locationId: 10,
        locationCode: "A-01-1",
        movementType: "dispatch",
        operatorUserId: 7,
      }),
    /was released, not active/,
  );
});

await ok("consumeReservation: unknown reservation id throws", async () => {
  const { db } = makeFakeCombinedDb();
  await assert.rejects(
    () =>
      consumeReservation(db, {
        reservationId: 999,
        locationId: 10,
        locationCode: "A-01-1",
        movementType: "dispatch",
        operatorUserId: 7,
      }),
    /not found/,
  );
});

// ── Summary ───────────────────────────────────────────────────────────────────

if (process.exitCode) {
  console.error(`\n${passed} passed, some FAILED (see above)`);
} else {
  console.log(`\nAll ${passed} assertions passed.`);
}
