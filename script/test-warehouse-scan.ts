// Pure-logic tests for server/warehouse.ts's scan resolver (T7).
// Run: npx tsx script/test-warehouse-scan.ts   (exits non-zero on failure)
//
// resolveScanCode takes a bespoke ScanLookupDb (three simple, unlocked
// lookups — see the file-header/function comments in server/warehouse.ts
// for why this is a seam at all even though nothing here needs row-locking
// the way ReservationDb's getAvailableForItem does) so this whole file runs
// against plain in-memory fakes, no DB. The pure shared/warehouse.ts helpers
// T7 also added (stripLocationPrefix, scanActionsForItem/ForLocation,
// scanQuantityToUnits, buildLocationMoveLegs) are tested alongside every
// other shared export in script/test-warehouse-shared.ts, per that file's
// existing "test every export" discipline — this file is specifically the
// resolveScanCode integration surface named by PLAN.md's verify line (alias
// pack_qty multiplication, unknown-code path), plus a small end-to-end proof
// that a putaway/transfer's two legs actually move stock through the real
// (already-tested) movement engine.
import assert from "node:assert/strict";
import {
  resolveScanCode,
  postMovementGroup,
  type ScanLookupDb,
  type ScanResolvedItem,
  type ScanResolvedLocation,
  type WarehouseDb,
  type NewMovementRow,
} from "../server/warehouse";
import { buildLocationMoveLegs, scanQuantityToUnits } from "../shared/warehouse";

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

// ── Fake ScanLookupDb ─────────────────────────────────────────────────────────
// Keyed exactly the way the real adapter (scanLookupDbFromDb) queries — by
// the SKU/alias-code/location-code string the caller passes in, so these
// tests exercise resolveScanCode's own normalisation/priority logic (not the
// fake's lookup logic).
function makeFakeScanDb(opts: {
  itemsBySku?: Record<string, ScanResolvedItem>;
  aliasesByCode?: Record<string, { item: ScanResolvedItem; packQty: number; aliasCode: string }>;
  locationsByCode?: Record<string, ScanResolvedLocation>;
}) {
  const calls = { findItemBySku: 0, findAliasByCode: 0, findLocationByCode: 0 };
  const db: ScanLookupDb = {
    async findItemBySku(sku) {
      calls.findItemBySku++;
      return opts.itemsBySku?.[sku];
    },
    async findAliasByCode(code) {
      calls.findAliasByCode++;
      return opts.aliasesByCode?.[code];
    },
    async findLocationByCode(code) {
      calls.findLocationByCode++;
      return opts.locationsByCode?.[code];
    },
  };
  return { db, calls };
}

const shirt: ScanResolvedItem = { id: 1, sku: "MFL-SHIRT-BLU-M", name: "MFL Home Shirt (M)", isLoanable: false };
const cone: ScanResolvedItem = { id: 2, sku: "CLUB-CONE-ORG-STD", name: "Training cone", isLoanable: true };
const binA: ScanResolvedLocation = { id: 10, code: "A-01-2", kind: "bin" };
const receiving: ScanResolvedLocation = { id: 11, code: "RECEIVING", kind: "zone" };

// ── LOC:-prefixed codes ────────────────────────────────────────────────────

await ok("LOC:-prefixed code resolves to a location", async () => {
  const { db } = makeFakeScanDb({ locationsByCode: { "A-01-2": binA } });
  const result = await resolveScanCode(db, "LOC:A-01-2");
  assert.equal(result.kind, "location");
  if (result.kind === "location") {
    assert.equal(result.location.code, "A-01-2");
    assert.deepEqual(result.actions, ["putaway", "transfer", "count"]);
  }
});

await ok("LOC: prefix is matched case-insensitively and the code normalised", async () => {
  const { db } = makeFakeScanDb({ locationsByCode: { "A-01-2": binA } });
  const result = await resolveScanCode(db, "loc:a-01-2");
  assert.equal(result.kind, "location");
});

await ok("a virtual location resolves with an empty actions list", async () => {
  const supplier: ScanResolvedLocation = { id: 99, code: "SUPPLIER", kind: "virtual" };
  const { db } = makeFakeScanDb({ locationsByCode: { SUPPLIER: supplier } });
  const result = await resolveScanCode(db, "LOC:SUPPLIER");
  assert.equal(result.kind, "location");
  if (result.kind === "location") assert.deepEqual(result.actions, []);
});

await ok(
  "an unmatched LOC:-prefixed code is unknown and NEVER falls through to item/alias lookups",
  async () => {
    const { db, calls } = makeFakeScanDb({
      itemsBySku: { X: shirt }, // would wrongly match if the resolver fell through
      aliasesByCode: { "LOC:X": { item: shirt, packQty: 1, aliasCode: "LOC:X" } },
      locationsByCode: {}, // no location named X
    });
    const result = await resolveScanCode(db, "LOC:X");
    assert.equal(result.kind, "unknown");
    if (result.kind === "unknown") assert.equal(result.rawCode, "LOC:X");
    assert.equal(calls.findLocationByCode, 1, "the location lookup itself still runs");
    assert.equal(calls.findItemBySku, 0, "must NOT check the item table for a code that announced itself as a location");
    assert.equal(calls.findAliasByCode, 0, "must NOT check the alias table either");
  },
);

// ── Item resolution via SKU ────────────────────────────────────────────────

await ok("an exact SKU match resolves to an item with packQty 1, matchedVia sku", async () => {
  const { db } = makeFakeScanDb({ itemsBySku: { "MFL-SHIRT-BLU-M": shirt } });
  const result = await resolveScanCode(db, "MFL-SHIRT-BLU-M");
  assert.equal(result.kind, "item");
  if (result.kind === "item") {
    assert.equal(result.matchedVia, "sku");
    assert.equal(result.packQty, 1);
    assert.equal(result.aliasCode, undefined);
    assert.deepEqual(result.actions, ["putaway", "pick", "dispatch", "transfer", "consume"]);
  }
});

await ok("a SKU scanned in lower case still resolves (normaliseSku uppercases before lookup)", async () => {
  const { db } = makeFakeScanDb({ itemsBySku: { "MFL-SHIRT-BLU-M": shirt } });
  const result = await resolveScanCode(db, "mfl-shirt-blu-m");
  assert.equal(result.kind, "item");
  if (result.kind === "item") assert.equal(result.matchedVia, "sku");
});

await ok("a loanable item's actions include loan_out and loan_return", async () => {
  const { db } = makeFakeScanDb({ itemsBySku: { "CLUB-CONE-ORG-STD": cone } });
  const result = await resolveScanCode(db, "CLUB-CONE-ORG-STD");
  assert.equal(result.kind, "item");
  if (result.kind === "item") {
    assert.ok(result.actions.includes("loan_out"));
    assert.ok(result.actions.includes("loan_return"));
  }
});

await ok("an item SKU match takes priority over an alias sharing the same raw code", async () => {
  const { db, calls } = makeFakeScanDb({
    itemsBySku: { "MFL-SHIRT-BLU-M": shirt },
    aliasesByCode: { "MFL-SHIRT-BLU-M": { item: cone, packQty: 6, aliasCode: "MFL-SHIRT-BLU-M" } },
  });
  const result = await resolveScanCode(db, "MFL-SHIRT-BLU-M");
  assert.equal(result.kind, "item");
  if (result.kind === "item") assert.equal(result.matchedVia, "sku");
  assert.equal(calls.findAliasByCode, 0, "the alias table is never even consulted once the SKU already matched");
});

// ── Item resolution via barcode alias — pack_qty multiplication ───────────

await ok("an alias match resolves to its item with the alias's own packQty, matchedVia alias", async () => {
  const { db } = makeFakeScanDb({
    aliasesByCode: { "5012345678900": { item: shirt, packQty: 6, aliasCode: "5012345678900" } },
  });
  const result = await resolveScanCode(db, "5012345678900");
  assert.equal(result.kind, "item");
  if (result.kind === "item") {
    assert.equal(result.matchedVia, "alias");
    assert.equal(result.item.id, shirt.id);
    assert.equal(result.aliasCode, "5012345678900");
    assert.equal(result.packQty, 6);
  }
});

await ok("scanQuantityToUnits multiplies scans by the resolved alias's packQty", async () => {
  const { db } = makeFakeScanDb({
    aliasesByCode: { CASE6: { item: shirt, packQty: 6, aliasCode: "CASE6" } },
  });
  const result = await resolveScanCode(db, "CASE6");
  assert.equal(result.kind, "item");
  if (result.kind === "item") {
    // Scanning this case barcode 3 times (or entering "3 cases" once) must
    // post 18 units, never 3 — the whole point of the pack_qty multiplier.
    assert.equal(scanQuantityToUnits(3, result.packQty), 18);
  }
});

await ok("an alias code is looked up verbatim (trim only) — not uppercased like a SKU", async () => {
  const { db } = makeFakeScanDb({
    aliasesByCode: { "abc-123": { item: shirt, packQty: 2, aliasCode: "abc-123" } },
  });
  // No item SKU matches "ABC-123" or "abc-123", so this only resolves if the
  // alias lookup key is NOT uppercased before hitting the alias table.
  const result = await resolveScanCode(db, " abc-123 ");
  assert.equal(result.kind, "item");
  if (result.kind === "item") assert.equal(result.matchedVia, "alias");
});

// ── Bare (unprefixed) location code fallback ──────────────────────────────

await ok("a bare location code (no LOC: prefix) resolves once no item/alias matches", async () => {
  const { db } = makeFakeScanDb({ locationsByCode: { RECEIVING: receiving } });
  const result = await resolveScanCode(db, "RECEIVING");
  assert.equal(result.kind, "location");
  if (result.kind === "location") assert.equal(result.location.code, "RECEIVING");
});

await ok("item/alias lookups run BEFORE the bare-location fallback (SKU wins if it happens to collide)", async () => {
  const { db, calls } = makeFakeScanDb({
    itemsBySku: { RECEIVING: shirt },
    locationsByCode: { RECEIVING: receiving },
  });
  const result = await resolveScanCode(db, "RECEIVING");
  assert.equal(result.kind, "item");
  assert.equal(calls.findLocationByCode, 0, "the bare-location fallback never runs once the SKU already matched");
});

// ── Unknown-code path ──────────────────────────────────────────────────────

await ok("a code matching nothing at all resolves to unknown, preserving the raw input", async () => {
  const { db } = makeFakeScanDb({});
  const result = await resolveScanCode(db, "  totally-unrecognised-987  ");
  assert.equal(result.kind, "unknown");
  if (result.kind === "unknown") assert.equal(result.rawCode, "  totally-unrecognised-987  ");
});

await ok("an empty/whitespace-only code is unknown without touching any lookup", async () => {
  const { db, calls } = makeFakeScanDb({});
  const result = await resolveScanCode(db, "   ");
  assert.equal(result.kind, "unknown");
  assert.equal(calls.findItemBySku, 0);
  assert.equal(calls.findAliasByCode, 0);
  assert.equal(calls.findLocationByCode, 0);
});

await ok("all four lookup paths miss in sequence before landing on unknown", async () => {
  const { db, calls } = makeFakeScanDb({}); // no items, no aliases, no locations anywhere
  const result = await resolveScanCode(db, "NOPE-NOT-A-THING");
  assert.equal(result.kind, "unknown");
  assert.equal(calls.findItemBySku, 1);
  assert.equal(calls.findAliasByCode, 1);
  assert.equal(calls.findLocationByCode, 1, "the bare-location fallback is still attempted");
});

// ── Putaway/transfer: buildLocationMoveLegs through the real engine ───────
// buildLocationMoveLegs itself is unit-tested in script/test-warehouse-
// shared.ts; this proves the two legs it produces actually move stock when
// run through the ALREADY-tested postMovementGroup (script/test-warehouse-
// engine.ts covers postMovementGroup exhaustively — this is a thin
// end-to-end sanity check that T7's route handlers wire the two together
// correctly, using the same fake-WarehouseDb shape/semantics established
// there: every (item,location) leg is guarded, including a first-ever one).

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

await ok("putaway: buildLocationMoveLegs' two legs move stock from source to destination", async () => {
  const { db, stock } = makeFakeWarehouseDb({ "1:10": 10 });
  const legs = buildLocationMoveLegs({ id: 1, allowNegative: false }, { id: 10, code: "RECEIVING" }, { id: 20, code: "A-01-2" }, 4);
  const result = await postMovementGroup(db, { legs, movementType: "putaway", operatorUserId: 9 });
  assert.equal(result.movementIds.length, 2);
  assert.equal(stock.get("1:10"), 6, "4 units left the source");
  assert.equal(stock.get("1:20"), 4, "the same 4 units arrived at the destination");
});

await ok("transfer: same two-leg shape, only the movementType label differs", async () => {
  const { db, stock, insertedRows } = makeFakeWarehouseDb({ "1:10": 10 });
  const legs = buildLocationMoveLegs({ id: 1, allowNegative: false }, { id: 10, code: "A-01-1" }, { id: 20, code: "A-02-1" }, 7);
  await postMovementGroup(db, { legs, movementType: "transfer", operatorUserId: 9 });
  assert.equal(stock.get("1:10"), 3);
  assert.equal(stock.get("1:20"), 7);
  assert.ok(insertedRows.every((r) => r.movementType === "transfer"));
});

await ok("putaway/transfer: insufficient stock at the source rejects the whole move", async () => {
  const { db } = makeFakeWarehouseDb({ "1:10": 2 });
  const legs = buildLocationMoveLegs({ id: 1, allowNegative: false }, { id: 10, code: "A-01-1" }, { id: 20, code: "A-02-1" }, 5);
  await assert.rejects(
    () => postMovementGroup(db, { legs, movementType: "transfer", operatorUserId: 9 }),
    /Insufficient stock at A-01-1/,
  );
});

await ok("putaway/transfer: allow_negative on the item lets the source go negative", async () => {
  const { db, stock } = makeFakeWarehouseDb({ "1:10": 2 });
  const legs = buildLocationMoveLegs({ id: 1, allowNegative: true }, { id: 10, code: "A-01-1" }, { id: 20, code: "A-02-1" }, 5);
  await postMovementGroup(db, { legs, movementType: "putaway", operatorUserId: 9 });
  assert.equal(stock.get("1:10"), -3);
  assert.equal(stock.get("1:20"), 5);
});

// ── Summary ───────────────────────────────────────────────────────────────────

if (process.exitCode) {
  console.error(`\n${passed} passed, some FAILED (see above)`);
} else {
  console.log(`\nAll ${passed} assertions passed.`);
}
