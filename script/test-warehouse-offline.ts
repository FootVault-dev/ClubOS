// Tests for the counter-sale offline queue (D25).
// Run: npx tsx script/test-warehouse-offline.ts   (exits non-zero on failure)
//
// This queue is the one place in the warehouse where the client holds stock
// truth for a while, so the property that matters is narrow and absolute:
// a sale must never post twice, and a sale must never silently vanish.
//
// localStorage is shimmed in-memory BEFORE the module is imported (hence the
// dynamic import below — ESM hoists static ones above this setup).

import assert from "node:assert/strict";

// ── localStorage shim ────────────────────────────────────────────────────────
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
};

const { enqueueSale, flushSales, mintSaleKey, pendingSales, pendingCount, removeSale } = await import(
  "../client/src/lib/warehouse-offline-queue"
);

let passed = 0;
async function ok(name: string, fn: () => Promise<void> | void) {
  try {
    store.clear();
    await fn();
    passed++;
  } catch (e: any) {
    console.error(`FAIL: ${name}\n  ${e.stack || e.message}`);
    process.exitCode = 1;
  }
}

const sale = (over: Partial<Parameters<typeof enqueueSale>[0]> = {}) => ({
  idempotencyKey: "sale-1-10-123-abc",
  itemId: 1,
  itemSku: "MFL-SHIRT-BLU-M",
  locationId: 10,
  locationCode: "A-01-1",
  qty: 2,
  ...over,
});

// ── Keys ─────────────────────────────────────────────────────────────────────

await ok("minted keys are unique even for the same item and till", () => {
  const keys = new Set(Array.from({ length: 500 }, () => mintSaleKey(1, 10)));
  assert.equal(keys.size, 500, "two sales must never share an idempotency key");
});

// ── Queueing ─────────────────────────────────────────────────────────────────

await ok("a queued sale survives being read back", () => {
  enqueueSale(sale());
  const rows = pendingSales();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].itemSku, "MFL-SHIRT-BLU-M");
  assert.equal(rows[0].qty, 2);
  assert.equal(rows[0].attempts, 0);
  assert.ok(rows[0].queuedAt, "queuedAt is what makes a pending row legible later");
});

await ok("the same key can't be queued twice — a double-tap offline is one sale", () => {
  enqueueSale(sale());
  enqueueSale(sale());
  assert.equal(pendingCount(), 1);
});

await ok("different sales of the same item both queue", () => {
  enqueueSale(sale({ idempotencyKey: "a" }));
  enqueueSale(sale({ idempotencyKey: "b" }));
  assert.equal(pendingCount(), 2);
});

await ok("a corrupt queue reads as empty rather than throwing", () => {
  store.set("wh_pending_sales_v1", "{not json");
  assert.deepEqual(pendingSales(), [], "losing an unsent sale is bad; refusing to open the till is worse");
});

await ok("discarding removes exactly one row", () => {
  enqueueSale(sale({ idempotencyKey: "a" }));
  enqueueSale(sale({ idempotencyKey: "b" }));
  removeSale("a");
  assert.deepEqual(pendingSales().map((r) => r.idempotencyKey), ["b"]);
});

// ── Flushing ─────────────────────────────────────────────────────────────────

await ok("a successful flush empties the queue and replays the SAME key", async () => {
  enqueueSale(sale());
  const seen: any[] = [];
  const r = await flushSales(async (body) => {
    seen.push(body);
    return { ok: true, status: 201 };
  });
  assert.equal(r.posted, 1);
  assert.equal(r.remaining, 0);
  assert.equal(pendingCount(), 0);
  // The stored key — not a fresh one — is what makes the retry safe.
  assert.equal(seen[0].idempotencyKey, "sale-1-10-123-abc");
});

await ok("a replay is counted separately from a fresh post", async () => {
  enqueueSale(sale());
  const r = await flushSales(async () => ({ ok: true, status: 200, replayed: true }));
  assert.equal(r.replayed, 1);
  assert.equal(r.posted, 0, "must not claim to have sold something a second time");
  assert.equal(pendingCount(), 0);
});

await ok("a network throw KEEPS the sale and counts the attempt", async () => {
  enqueueSale(sale());
  const r = await flushSales(async () => {
    throw new Error("Failed to fetch");
  });
  assert.equal(r.remaining, 1);
  const rows = pendingSales();
  assert.equal(rows[0].attempts, 1);
  assert.equal(rows[0].lastError, "Failed to fetch");
});

await ok("a 5xx KEEPS the sale — the server is there but struggling", async () => {
  enqueueSale(sale());
  const r = await flushSales(async () => ({ ok: false, status: 503, message: "unavailable" }));
  assert.equal(r.remaining, 1);
  assert.equal(r.failed, 0);
});

await ok("429 and 408 keep the sale too", async () => {
  for (const status of [429, 408]) {
    store.clear();
    enqueueSale(sale());
    const r = await flushSales(async () => ({ ok: false, status }));
    assert.equal(r.remaining, 1, `status ${status} should be retried`);
  }
});

await ok("a permanent 4xx DROPS the sale and reports it, rather than wedging the queue", async () => {
  enqueueSale(sale({ idempotencyKey: "bad" }));
  enqueueSale(sale({ idempotencyKey: "good" }));
  const r = await flushSales(async (body) =>
    body.idempotencyKey === "bad"
      ? { ok: false, status: 400, message: "That location can't sell" }
      : { ok: true, status: 201 },
  );
  assert.equal(r.failed, 1);
  assert.equal(r.posted, 1);
  assert.equal(r.remaining, 0, "a sale the server will never accept must not block the ones behind it");
});

await ok("a 409 is retried, not dropped", async () => {
  enqueueSale(sale());
  const r = await flushSales(async () => ({ ok: false, status: 409, message: "Insufficient stock at A-01-1" }));
  assert.equal(r.failed, 0);
  assert.equal(r.remaining, 1, "a stock conflict may clear once a receipt lands");
});

await ok("flushing an empty queue is a no-op that calls nothing", async () => {
  let calls = 0;
  const r = await flushSales(async () => {
    calls++;
    return { ok: true, status: 201 };
  });
  assert.equal(calls, 0);
  assert.deepEqual(r, { posted: 0, replayed: 0, failed: 0, remaining: 0 });
});

await ok("a partial flush leaves exactly the unsent ones behind, in order", async () => {
  enqueueSale(sale({ idempotencyKey: "a" }));
  enqueueSale(sale({ idempotencyKey: "b" }));
  enqueueSale(sale({ idempotencyKey: "c" }));
  const r = await flushSales(async (body) =>
    body.idempotencyKey === "b" ? { ok: false, status: 500 } : { ok: true, status: 201 },
  );
  assert.equal(r.posted, 2);
  assert.equal(r.remaining, 1);
  assert.deepEqual(pendingSales().map((x) => x.idempotencyKey), ["b"]);
});

if (process.exitCode) {
  console.error(`\n${passed} passed, at least one FAILED.`);
} else {
  console.log(`✅ warehouse offline queue: ${passed} test groups passed.`);
}
