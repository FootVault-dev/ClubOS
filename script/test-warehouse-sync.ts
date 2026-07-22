// Pure-logic tests for server/warehouse-sync.ts (channel sync — T12).
// Run: npx tsx script/test-warehouse-sync.ts   (exits non-zero on failure)
//
// No real DB, no real network: every DB-touching function under test takes a
// bespoke SyncDb / ReservationOps seam (fakes below, recording calls — same
// "inject a fake tx/db object that records calls" discipline as
// test-warehouse-engine.ts) and every Shopify-touching function takes an
// injected `fetch` (a fake below recording request bodies). Debounce timing
// is proven with an injected TimerFns fake too, so nothing here waits on a
// real clock.
import assert from "node:assert/strict";
import {
  isSyncEnabled,
  getShopifyPushConfig,
  getShopifyWebhookSecret,
  verifyShopifyWebhookHmac,
  toSafeRefId,
  roundQty,
  Debouncer,
  type TimerFns,
  isEchoOfOurPush,
  computeDrift,
  fanOutTargets,
  pushInventoryToShopify,
  pushItemUsing,
  processShopifyOrderCreate,
  processShopifyOrderCancelled,
  processShopifyRefundCreate,
  processInventoryLevelsUpdate,
  handleShopifyWebhookEvent,
  reconcilePollUsing,
  type SyncDb,
  type ReservationOps,
  type MappedItemForSync,
  type SyncSiblingLink,
  type SyncStateRow,
} from "../server/warehouse-sync";
import type { ShopifyStoreKey, SyncStore, RefKind } from "../shared/warehouse";
import { createHmac } from "node:crypto";

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

// ── Fakes ─────────────────────────────────────────────────────────────────

interface FakeItem {
  id: number;
  shopVariantId: number | null;
  shopifyStore: ShopifyStoreKey | null;
  shopifyInventoryItemId: string | null;
  shopifyVariantId: string | null;
  available: number;
}

function makeFakeSyncDb(opts: {
  items?: FakeItem[];
  siblingLinks?: Record<number, SyncSiblingLink[]>;
  variantIndex?: Record<string, number>;
  inventoryIndex?: Record<string, number>;
  syncState?: Record<string, SyncStateRow>;
} = {}) {
  const items = new Map(opts.items?.map((i) => [i.id, i]) ?? []);
  const siblingLinks = opts.siblingLinks ?? {};
  const variantIndex = new Map(Object.entries(opts.variantIndex ?? {}));
  const inventoryIndex = new Map(Object.entries(opts.inventoryIndex ?? {}));
  const syncState = new Map(Object.entries(opts.syncState ?? {}));
  const events = new Set<string>();
  const drift: Array<{ itemId: number; store: SyncStore; note: string; at: Date }> = [];
  const nativeUpdates: Array<{ shopVariantId: number; qty: number }> = [];
  const syncStateUpserts: Array<{ itemId: number; store: SyncStore; qty: number; pushedAt: Date }> = [];
  const calls = { recordShopifyEvent: 0, getAvailableForItem: 0, getSyncState: 0, getSiblingLinks: 0 };

  const sdb: SyncDb = {
    async getItemForSync(itemId): Promise<MappedItemForSync | null> {
      const it = items.get(itemId);
      if (!it) return null;
      return {
        id: it.id,
        shopVariantId: it.shopVariantId,
        shopifyStore: it.shopifyStore,
        shopifyInventoryItemId: it.shopifyInventoryItemId,
        shopifyVariantId: it.shopifyVariantId,
      };
    },
    async getSiblingLinks(itemId) {
      calls.getSiblingLinks++;
      return siblingLinks[itemId] ?? [];
    },
    async getAvailableForItem(itemId) {
      calls.getAvailableForItem++;
      return items.get(itemId)?.available ?? 0;
    },
    async getSyncState(itemId, store) {
      calls.getSyncState++;
      return syncState.get(`${itemId}:${store}`) ?? null;
    },
    async upsertSyncState(itemId, store, qty, pushedAt) {
      syncState.set(`${itemId}:${store}`, { lastPushedQty: qty, lastPushedAt: pushedAt });
      syncStateUpserts.push({ itemId, store, qty, pushedAt });
    },
    async recordDrift(itemId, store, note, at) {
      drift.push({ itemId, store, note, at });
    },
    async updateNativeStock(shopVariantId, qty) {
      nativeUpdates.push({ shopVariantId, qty });
    },
    async findItemIdByShopifyVariant(store, variantId) {
      return variantIndex.get(`${store}:${variantId}`) ?? null;
    },
    async findItemIdByShopifyInventoryItem(store, inventoryItemId) {
      return inventoryIndex.get(`${store}:${inventoryItemId}`) ?? null;
    },
    async recordShopifyEvent(webhookId) {
      calls.recordShopifyEvent++;
      if (events.has(webhookId)) return false;
      events.add(webhookId);
      return true;
    },
    async listMappedItemIds() {
      return Array.from(items.values())
        .filter((i) => i.shopVariantId != null || i.shopifyVariantId != null)
        .map((i) => i.id);
    },
  };
  return { sdb, drift, nativeUpdates, syncStateUpserts, calls, events };
}

function makeFakeReservationOps() {
  const reserveCalls: Array<{ itemId: number; qty: number; ref: { kind: RefKind; id: number } }> = [];
  const releaseAllCalls: Array<{ kind: RefKind; id: number }> = [];
  const releaseItemCalls: Array<{ ref: { kind: RefKind; id: number }; itemId: number }> = [];
  const ops: ReservationOps = {
    async reserve(itemId, qty, ref) {
      reserveCalls.push({ itemId, qty, ref });
    },
    async releaseAllForRef(ref) {
      releaseAllCalls.push(ref);
    },
    async releaseForRefItem(ref, itemId) {
      releaseItemCalls.push({ ref, itemId });
    },
  };
  return { ops, reserveCalls, releaseAllCalls, releaseItemCalls };
}

function makeFakeFetch(behavior?: (url: string, body: any) => { ok: boolean; status?: number; json?: any; text?: string }) {
  const calls: Array<{ url: string; body: any }> = [];
  const fetchImpl = (async (url: any, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(url), body });
    const result = behavior?.(String(url), body) ?? {
      ok: true,
      json: { data: { inventorySetQuantities: { inventoryAdjustmentGroup: { id: "adj-1" }, userErrors: [] } } },
    };
    return {
      ok: result.ok,
      status: result.status ?? (result.ok ? 200 : 500),
      json: async () => result.json,
      text: async () => result.text ?? "",
    } as any;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

// ── isSyncEnabled / env config (T12: "ALL behind env flags") ───────────────

ok("isSyncEnabled: only the literal '1' turns it on", () => {
  assert.equal(isSyncEnabled({ WH_SYNC_ENABLED: "1" } as any), true);
  assert.equal(isSyncEnabled({ WH_SYNC_ENABLED: "true" } as any), false);
  assert.equal(isSyncEnabled({} as any), false);
});

ok("getShopifyPushConfig: null unless ALL three vars are set (inert without config)", () => {
  assert.equal(getShopifyPushConfig("siu", {} as any), null);
  assert.equal(getShopifyPushConfig("siu", { WH_SHOPIFY_SIU_DOMAIN: "x.myshopify.com" } as any), null);
  assert.equal(
    getShopifyPushConfig("siu", { WH_SHOPIFY_SIU_DOMAIN: "x.myshopify.com", WH_SHOPIFY_SIU_TOKEN: "tok" } as any),
    null,
  );
  const full = getShopifyPushConfig("siu", {
    WH_SHOPIFY_SIU_DOMAIN: "x.myshopify.com",
    WH_SHOPIFY_SIU_TOKEN: "tok",
    WH_SHOPIFY_SIU_LOCATION_GID: "gid://shopify/Location/1",
  } as any);
  assert.deepEqual(full, { domain: "x.myshopify.com", token: "tok", locationGid: "gid://shopify/Location/1" });
});

ok("getShopifyPushConfig: cufc and siu read independent env vars", () => {
  const env = {
    WH_SHOPIFY_CUFC_DOMAIN: "cufc.myshopify.com",
    WH_SHOPIFY_CUFC_TOKEN: "cufc-tok",
    WH_SHOPIFY_CUFC_LOCATION_GID: "gid://shopify/Location/2",
  } as any;
  assert.equal(getShopifyPushConfig("siu", env), null);
  assert.equal(getShopifyPushConfig("cufc", env)?.domain, "cufc.myshopify.com");
});

ok("getShopifyWebhookSecret: null when unset, the value when set", () => {
  assert.equal(getShopifyWebhookSecret("siu", {} as any), null);
  assert.equal(getShopifyWebhookSecret("siu", { WH_SHOPIFY_SIU_WEBHOOK_SECRET: "shh" } as any), "shh");
});

// ── HMAC verification ───────────────────────────────────────────────────────

ok("verifyShopifyWebhookHmac: a correctly-signed body verifies true", () => {
  const secret = "test-secret";
  const body = JSON.stringify({ id: 123 });
  const sig = createHmac("sha256", secret).update(body, "utf8").digest("base64");
  assert.equal(verifyShopifyWebhookHmac(body, sig, secret), true);
});
ok("verifyShopifyWebhookHmac: a tampered body fails verification", () => {
  const secret = "test-secret";
  const sig = createHmac("sha256", secret).update(JSON.stringify({ id: 123 }), "utf8").digest("base64");
  assert.equal(verifyShopifyWebhookHmac(JSON.stringify({ id: 456 }), sig, secret), false);
});
ok("verifyShopifyWebhookHmac: the wrong secret fails verification", () => {
  const body = JSON.stringify({ id: 123 });
  const sig = createHmac("sha256", "right-secret").update(body, "utf8").digest("base64");
  assert.equal(verifyShopifyWebhookHmac(body, sig, "wrong-secret"), false);
});
ok("verifyShopifyWebhookHmac: a missing header fails closed", () => {
  assert.equal(verifyShopifyWebhookHmac("{}", undefined, "secret"), false);
});
ok("verifyShopifyWebhookHmac: mismatched-length signature fails without throwing", () => {
  assert.equal(verifyShopifyWebhookHmac("{}", "short", "secret"), false);
});

// ── toSafeRefId / roundQty ───────────────────────────────────────────────────

ok("toSafeRefId: a normal Shopify-scale numeric id passes through", () => {
  assert.equal(toSafeRefId(6060927369976, "shopify order"), 6060927369976);
  assert.equal(toSafeRefId("6060927369976", "shopify order"), 6060927369976);
});
ok("toSafeRefId: throws on a non-finite / non-safe-integer value rather than silently truncating", () => {
  assert.throws(() => toSafeRefId(Number.MAX_SAFE_INTEGER + 10, "x"), /not a safe integer/);
  assert.throws(() => toSafeRefId("not-a-number", "x"), /not a safe integer/);
  assert.throws(() => toSafeRefId(undefined, "x"), /not a safe integer/);
});
ok("roundQty: rounds to the nearest whole unit", () => {
  assert.equal(roundQty(4.4), 4);
  assert.equal(roundQty(4.5), 5);
  assert.equal(roundQty(-0.4), -0);
});

// ── Debouncer (~5s collapse, PLAN's own "debounce" requirement) ─────────────

function makeFakeTimerFns() {
  const scheduled: Array<{ handle: number; fn: () => void; ms: number }> = [];
  const cleared: number[] = [];
  let nextHandle = 1;
  const timerFns: TimerFns = {
    setTimeout: (fn, ms) => {
      const handle = nextHandle++;
      scheduled.push({ handle, fn, ms });
      return handle as any;
    },
    clearTimeout: (h) => {
      cleared.push(h as any);
    },
  };
  return { timerFns, scheduled, cleared };
}

await ok("Debouncer: N rapid schedule() calls for the same key fire exactly ONCE", async () => {
  const { timerFns, scheduled, cleared } = makeFakeTimerFns();
  const fired: number[] = [];
  const deb = new Debouncer<number>(5000, (k) => fired.push(k), timerFns);
  deb.schedule(7);
  deb.schedule(7);
  deb.schedule(7);
  assert.equal(scheduled.length, 3, "setTimeout called once per schedule()");
  assert.equal(scheduled.every((s) => s.ms === 5000), true);
  assert.equal(cleared.length, 2, "the first two timers were cancelled before they could fire");
  assert.deepEqual(deb.pendingKeys(), [7]);
  // Simulate the clock elapsing on the LAST (surviving) timer only.
  scheduled[scheduled.length - 1].fn();
  assert.deepEqual(fired, [7], "fired exactly once despite 3 schedule() calls");
  assert.deepEqual(deb.pendingKeys(), [], "no longer pending once fired");
});

await ok("Debouncer: separate keys are tracked independently, neither cancels the other", async () => {
  const { timerFns, scheduled, cleared } = makeFakeTimerFns();
  const fired: number[] = [];
  const deb = new Debouncer<number>(5000, (k) => fired.push(k), timerFns);
  deb.schedule(1);
  deb.schedule(2);
  assert.equal(cleared.length, 0, "different keys never cancel each other's timer");
  assert.deepEqual(deb.pendingKeys().sort(), [1, 2]);
  for (const s of scheduled) s.fn();
  assert.deepEqual(fired.sort(), [1, 2]);
});

// ── Echo suppression + drift (D9) ────────────────────────────────────────────

ok("isEchoOfOurPush: same qty within the window is our own echo", () => {
  const now = new Date("2026-07-22T10:00:00Z");
  const lastPushedAt = new Date("2026-07-22T09:59:30Z"); // 30s ago
  assert.equal(isEchoOfOurPush({ incomingQty: 10, lastPushedQty: 10, lastPushedAt, now }), true);
});
ok("isEchoOfOurPush: same qty but OUTSIDE the window is not treated as our echo", () => {
  const now = new Date("2026-07-22T10:00:00Z");
  const lastPushedAt = new Date("2026-07-22T09:00:00Z"); // 1hr ago
  assert.equal(isEchoOfOurPush({ incomingQty: 10, lastPushedQty: 10, lastPushedAt, now }), false);
});
ok("isEchoOfOurPush: a different qty is never an echo, even a second later", () => {
  const now = new Date("2026-07-22T10:00:00Z");
  assert.equal(isEchoOfOurPush({ incomingQty: 9, lastPushedQty: 10, lastPushedAt: now, now }), false);
});
ok("isEchoOfOurPush: no baseline (never pushed) can never be an echo", () => {
  assert.equal(isEchoOfOurPush({ incomingQty: 10, lastPushedQty: null, lastPushedAt: null }), false);
});

ok("computeDrift: an echo is never drift", () => {
  assert.deepEqual(computeDrift({ incomingQty: 10, lastPushedQty: 10, isEcho: true }), { isDrift: false, note: null });
});
ok("computeDrift: no baseline yet — nothing to drift FROM, so no false-positive alert", () => {
  assert.deepEqual(computeDrift({ incomingQty: 10, lastPushedQty: null, isEcho: false }), { isDrift: false, note: null });
});
ok("computeDrift: matching qty is not drift even when not flagged as echo (e.g. window elapsed)", () => {
  assert.deepEqual(computeDrift({ incomingQty: 10, lastPushedQty: 10, isEcho: false }), { isDrift: false, note: null });
});
ok("computeDrift: a genuine mismatch is drift with an explanatory note naming both numbers", () => {
  const r = computeDrift({ incomingQty: 3, lastPushedQty: 10, isEcho: false });
  assert.equal(r.isDrift, true);
  assert.match(r.note!, /Shopify reports 3/);
  assert.match(r.note!, /we last pushed 10/);
});

// ── SIU sibling-variant fan-out (D9/§4.3 — pure) ────────────────────────────

ok("fanOutTargets: primary alone when there are no siblings", () => {
  const t = fanOutTargets({ store: "siu", shopifyInventoryItemId: "inv-1", shopifyVariantId: "var-1" }, []);
  assert.deepEqual(t, [{ shopifyInventoryItemId: "inv-1", shopifyVariantId: "var-1" }]);
});
ok("fanOutTargets: includes every same-store sibling, de-duped by inventory item id", () => {
  const t = fanOutTargets(
    { store: "siu", shopifyInventoryItemId: "inv-1", shopifyVariantId: "var-1" },
    [
      { store: "siu", shopifyInventoryItemId: "inv-2", shopifyVariantId: "var-2" }, // Player
      { store: "siu", shopifyInventoryItemId: "inv-3", shopifyVariantId: "var-3" }, // Custom
      { store: "siu", shopifyInventoryItemId: "inv-2", shopifyVariantId: "var-2" }, // duplicate row
    ],
  );
  assert.equal(t.length, 3, "3 targets: primary + 2 unique siblings");
  assert.deepEqual(t.map((x) => x.shopifyInventoryItemId), ["inv-1", "inv-2", "inv-3"]);
});
ok("fanOutTargets: a sibling tagged with a DIFFERENT store than the item's own is skipped (data-error guard)", () => {
  const t = fanOutTargets(
    { store: "siu", shopifyInventoryItemId: "inv-1", shopifyVariantId: "var-1" },
    [{ store: "cufc", shopifyInventoryItemId: "inv-9", shopifyVariantId: "var-9" }],
  );
  assert.equal(t.length, 1);
});

// ── pushInventoryToShopify (mocked fetch — request shape + error handling) ──

await ok("pushInventoryToShopify: posts the right URL/headers/body shape", async () => {
  const { fetchImpl, calls } = makeFakeFetch();
  const config = { domain: "siu-test.myshopify.com", token: "tok-abc", locationGid: "gid://shopify/Location/1" };
  await pushInventoryToShopify(config, "gid://shopify/InventoryItem/9", 4.7, "idem-key-1", fetchImpl);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/siu-test\.myshopify\.com\/admin\/api\/.+\/graphql\.json$/);
  assert.equal(calls[0].body.query.includes("inventorySetQuantities"), true);
  const q = calls[0].body.variables.input.quantities[0];
  assert.equal(q.inventoryItemId, "gid://shopify/InventoryItem/9");
  assert.equal(q.locationId, "gid://shopify/Location/1");
  assert.equal(q.quantity, 5, "quantity is rounded before it goes over the wire");
  assert.equal(calls[0].body.variables.input.ignoreCompareQuantity, true);
});

await ok("pushInventoryToShopify: throws on a Shopify userErrors response", async () => {
  const { fetchImpl } = makeFakeFetch(() => ({
    ok: true,
    json: { data: { inventorySetQuantities: { inventoryAdjustmentGroup: null, userErrors: [{ field: null, message: "bad location" }] } } },
  }));
  await assert.rejects(
    () => pushInventoryToShopify({ domain: "x.myshopify.com", token: "t", locationGid: "g" }, "inv-1", 1, "k", fetchImpl),
    /bad location/,
  );
});

await ok("pushInventoryToShopify: throws on a non-ok HTTP response", async () => {
  const { fetchImpl } = makeFakeFetch(() => ({ ok: false, status: 401, text: "unauthorized" }));
  await assert.rejects(
    () => pushInventoryToShopify({ domain: "x.myshopify.com", token: "t", locationGid: "g" }, "inv-1", 1, "k", fetchImpl),
    /HTTP 401/,
  );
});

// ── pushItemUsing — the full push (native + Shopify fan-out, mocked fetch) ──

await ok("pushItemUsing: an item mapped to BOTH native and Shopify (with 2 siblings) pushes to all 4 targets", async () => {
  const { sdb, nativeUpdates, syncStateUpserts } = makeFakeSyncDb({
    items: [{ id: 1, shopVariantId: 55, shopifyStore: "siu", shopifyInventoryItemId: "inv-1", shopifyVariantId: "var-1", available: 8 }],
    siblingLinks: { 1: [
      { store: "siu", shopifyInventoryItemId: "inv-2", shopifyVariantId: "var-2" },
      { store: "siu", shopifyInventoryItemId: "inv-3", shopifyVariantId: "var-3" },
    ] },
  });
  const { fetchImpl, calls } = makeFakeFetch();
  const outcome = await pushItemUsing(
    sdb,
    1,
    () => ({ domain: "siu.myshopify.com", token: "tok", locationGid: "gid://shopify/Location/1" }),
    fetchImpl,
    new Date("2026-07-22T10:00:00Z"),
  );
  assert.equal(outcome.available, 8);
  assert.equal(outcome.nativePushed, true);
  assert.equal(outcome.shopifyPushed, true);
  assert.equal(outcome.shopifyTargets, 3, "primary + 2 siblings");
  assert.equal(calls.length, 3, "one Shopify GraphQL call per fan-out target");
  assert.deepEqual(
    calls.map((c) => c.body.variables.input.quantities[0].inventoryItemId).sort(),
    ["inv-1", "inv-2", "inv-3"],
  );
  assert.deepEqual(nativeUpdates, [{ shopVariantId: 55, qty: 8 }]);
  // Both channels recorded under the SAME item — native and siu are separate rows.
  assert.equal(syncStateUpserts.length, 2);
  assert.equal(syncStateUpserts.some((s) => s.store === "native" && s.qty === 8), true);
  assert.equal(syncStateUpserts.some((s) => s.store === "siu" && s.qty === 8), true);
});

await ok("pushItemUsing: native-only item never touches fetch at all", async () => {
  const { sdb, nativeUpdates } = makeFakeSyncDb({
    items: [{ id: 2, shopVariantId: 77, shopifyStore: null, shopifyInventoryItemId: null, shopifyVariantId: null, available: 3 }],
  });
  const { fetchImpl, calls } = makeFakeFetch();
  const outcome = await pushItemUsing(sdb, 2, () => null, fetchImpl, new Date());
  assert.equal(outcome.shopifyPushed, false);
  assert.equal(calls.length, 0);
  assert.deepEqual(nativeUpdates, [{ shopVariantId: 77, qty: 3 }]);
});

await ok("pushItemUsing: negative available clamps to 0 on the native storefront push", async () => {
  const { sdb, nativeUpdates } = makeFakeSyncDb({
    items: [{ id: 3, shopVariantId: 99, shopifyStore: null, shopifyInventoryItemId: null, shopifyVariantId: null, available: -2 }],
  });
  await pushItemUsing(sdb, 3, () => null, makeFakeFetch().fetchImpl, new Date());
  assert.deepEqual(nativeUpdates, [{ shopVariantId: 99, qty: 0 }]);
});

await ok("pushItemUsing: a Shopify-mapped item with no store config configured is skipped, not thrown", async () => {
  const { sdb } = makeFakeSyncDb({
    items: [{ id: 4, shopVariantId: null, shopifyStore: "cufc", shopifyInventoryItemId: "inv-4", shopifyVariantId: "var-4", available: 5 }],
  });
  const { fetchImpl, calls } = makeFakeFetch();
  const outcome = await pushItemUsing(sdb, 4, () => null, fetchImpl, new Date());
  assert.equal(outcome.shopifyPushed, false);
  assert.equal(calls.length, 0);
  assert.match(outcome.skippedReason || "", /not fully configured/);
});

await ok("pushItemUsing: an unmapped/unknown item is a clean no-op", async () => {
  const { sdb } = makeFakeSyncDb({});
  const outcome = await pushItemUsing(sdb, 999, () => null, makeFakeFetch().fetchImpl, new Date());
  assert.equal(outcome.nativePushed, false);
  assert.equal(outcome.shopifyPushed, false);
  assert.equal(outcome.skippedReason, "item not found");
});

// ── processShopifyOrderCreate — sibling aggregation (the "two lines, one item" fix) ──

await ok("processShopifyOrderCreate: two order lines mapping to the SAME item (via siblings) reserve their SUMMED qty in ONE call", async () => {
  const { sdb } = makeFakeSyncDb({
    variantIndex: { "siu:var-plain": 1, "siu:var-custom": 1 }, // both variants → the same wh_item
  });
  const { ops, reserveCalls } = makeFakeReservationOps();
  const { reservedItemIds } = await processShopifyOrderCreate(
    sdb, ops, "siu", 555,
    [{ variantId: "var-plain", quantity: 2 }, { variantId: "var-custom", quantity: 3 }],
  );
  assert.deepEqual(reservedItemIds, [1]);
  assert.equal(reserveCalls.length, 1, "aggregated into ONE reserve() call, not two");
  assert.deepEqual(reserveCalls[0], { itemId: 1, qty: 5, ref: { kind: "shopify_order", id: 555 } });
});

await ok("processShopifyOrderCreate: an unmapped variant line is skipped (nothing to reserve)", async () => {
  const { sdb } = makeFakeSyncDb({ variantIndex: {} });
  const { ops, reserveCalls } = makeFakeReservationOps();
  const { reservedItemIds } = await processShopifyOrderCreate(sdb, ops, "siu", 1, [{ variantId: "unknown-variant", quantity: 1 }]);
  assert.deepEqual(reservedItemIds, []);
  assert.equal(reserveCalls.length, 0);
});

await ok("processShopifyOrderCreate: a zero/negative quantity line is skipped", async () => {
  const { sdb } = makeFakeSyncDb({ variantIndex: { "siu:v": 1 } });
  const { ops, reserveCalls } = makeFakeReservationOps();
  await processShopifyOrderCreate(sdb, ops, "siu", 1, [{ variantId: "v", quantity: 0 }]);
  assert.equal(reserveCalls.length, 0);
});

await ok("processShopifyOrderCancelled: releases every reservation on the order via releaseAllForRef", async () => {
  const { ops, releaseAllCalls } = makeFakeReservationOps();
  await processShopifyOrderCancelled(ops, 777);
  assert.deepEqual(releaseAllCalls, [{ kind: "shopify_order", id: 777 }]);
});

// ── processShopifyRefundCreate — partial refund releases only refunded items ─

await ok("processShopifyRefundCreate: only restock-eligible lines release, no_restock lines don't", async () => {
  const { sdb } = makeFakeSyncDb({ variantIndex: { "siu:a": 1, "siu:b": 2 } });
  const { ops, releaseItemCalls } = makeFakeReservationOps();
  const { releasedItemIds } = await processShopifyRefundCreate(sdb, ops, "siu", 1, [
    { variantId: "a", noRestock: false },
    { variantId: "b", noRestock: true }, // merchant said don't restock this one
  ]);
  assert.deepEqual(releasedItemIds, [1]);
  assert.deepEqual(releaseItemCalls, [{ ref: { kind: "shopify_order", id: 1 }, itemId: 1 }]);
});

await ok("processShopifyRefundCreate: two refund lines mapping to the same item de-dupe to ONE release call", async () => {
  const { sdb } = makeFakeSyncDb({ variantIndex: { "siu:plain": 9, "siu:custom": 9 } });
  const { ops, releaseItemCalls } = makeFakeReservationOps();
  await processShopifyRefundCreate(sdb, ops, "siu", 2, [
    { variantId: "plain", noRestock: false },
    { variantId: "custom", noRestock: false },
  ]);
  assert.equal(releaseItemCalls.length, 1);
  assert.equal(releaseItemCalls[0].itemId, 9);
});

// ── processInventoryLevelsUpdate — drift monitor only, echo-aware ───────────

await ok("processInventoryLevelsUpdate: our own echo does NOT record drift or trigger a re-push", async () => {
  const now = new Date("2026-07-22T10:00:00Z");
  const { sdb, drift } = makeFakeSyncDb({
    inventoryIndex: { "siu:inv-1": 1 },
    syncState: { "1:siu": { lastPushedQty: 10, lastPushedAt: new Date("2026-07-22T09:59:50Z") } },
  });
  const scheduled: number[] = [];
  const r = await processInventoryLevelsUpdate(sdb, "siu", { inventoryItemId: "inv-1", available: 10 }, (id) => scheduled.push(id), now);
  assert.equal(r.isEcho, true);
  assert.equal(r.isDrift, false);
  assert.equal(drift.length, 0);
  assert.deepEqual(scheduled, []);
});

await ok("processInventoryLevelsUpdate: a genuine mismatch records drift AND schedules a re-push (WMS is master)", async () => {
  const now = new Date("2026-07-22T10:00:00Z");
  const { sdb, drift } = makeFakeSyncDb({
    inventoryIndex: { "siu:inv-1": 1 },
    syncState: { "1:siu": { lastPushedQty: 10, lastPushedAt: new Date("2026-07-22T09:00:00Z") } }, // an hour ago — not an echo window
  });
  const scheduled: number[] = [];
  const r = await processInventoryLevelsUpdate(sdb, "siu", { inventoryItemId: "inv-1", available: 4 }, (id) => scheduled.push(id), now);
  assert.equal(r.isEcho, false);
  assert.equal(r.isDrift, true);
  assert.equal(drift.length, 1);
  assert.equal(drift[0].itemId, 1);
  assert.deepEqual(scheduled, [1], "auto-heal re-schedules a push for the drifted item");
});

await ok("processInventoryLevelsUpdate: an inventory item we don't map to anything is a clean no-op", async () => {
  const { sdb, drift } = makeFakeSyncDb({});
  const r = await processInventoryLevelsUpdate(sdb, "siu", { inventoryItemId: "unmapped", available: 4 }, () => {}, new Date());
  assert.equal(r.itemId, null);
  assert.equal(drift.length, 0);
});

// ── handleShopifyWebhookEvent — dedupe + full dispatch (PLAN's own "dedupe") ─

await ok("handleShopifyWebhookEvent: dedupes on webhook id — a redelivered event is NOT processed twice", async () => {
  const { sdb, calls } = makeFakeSyncDb({ variantIndex: { "siu:v1": 1 } });
  const { ops, reserveCalls } = makeFakeReservationOps();
  const payload = { id: 42, line_items: [{ variant_id: "v1", quantity: 2 }] };

  const first = await handleShopifyWebhookEvent(sdb, ops, "siu", "wh-abc-123", "orders/create", payload, () => {});
  assert.equal(first.deduped, false);
  assert.equal(reserveCalls.length, 1);

  // Shopify redelivers the SAME webhook id (it does this routinely).
  const second = await handleShopifyWebhookEvent(sdb, ops, "siu", "wh-abc-123", "orders/create", payload, () => {});
  assert.equal(second.deduped, true);
  assert.equal(reserveCalls.length, 1, "still just one reservation — the redelivery did NOT double-reserve");
  assert.equal(calls.recordShopifyEvent, 2, "the dedupe check itself still ran both times");
});

await ok("handleShopifyWebhookEvent: a DIFFERENT webhook id for the same order IS processed (not falsely deduped)", async () => {
  const { sdb } = makeFakeSyncDb({ variantIndex: { "siu:v1": 1 } });
  const { ops, reserveCalls } = makeFakeReservationOps();
  await handleShopifyWebhookEvent(sdb, ops, "siu", "wh-1", "orders/create", { id: 1, line_items: [{ variant_id: "v1", quantity: 1 }] }, () => {});
  await handleShopifyWebhookEvent(sdb, ops, "siu", "wh-2", "orders/create", { id: 1, line_items: [{ variant_id: "v1", quantity: 1 }] }, () => {});
  assert.equal(reserveCalls.length, 2);
});

await ok("handleShopifyWebhookEvent: dispatches orders/cancelled to releaseAllForRef", async () => {
  const { sdb } = makeFakeSyncDb({});
  const { ops, releaseAllCalls } = makeFakeReservationOps();
  await handleShopifyWebhookEvent(sdb, ops, "siu", "wh-cancel-1", "orders/cancelled", { id: 88 }, () => {});
  assert.deepEqual(releaseAllCalls, [{ kind: "shopify_order", id: 88 }]);
});

await ok("handleShopifyWebhookEvent: dispatches refunds/create respecting no_restock", async () => {
  const { sdb } = makeFakeSyncDb({ variantIndex: { "siu:v1": 5 } });
  const { ops, releaseItemCalls } = makeFakeReservationOps();
  await handleShopifyWebhookEvent(
    sdb, ops, "siu", "wh-refund-1", "refunds/create",
    { order_id: 88, refund_line_items: [{ restock_type: "restock", line_item: { variant_id: "v1" } }] },
    () => {},
  );
  assert.deepEqual(releaseItemCalls, [{ ref: { kind: "shopify_order", id: 88 }, itemId: 5 }]);
});

await ok("handleShopifyWebhookEvent: an unknown topic is ignored cleanly (still marked processed)", async () => {
  const { sdb } = makeFakeSyncDb({});
  const { ops } = makeFakeReservationOps();
  const r = await handleShopifyWebhookEvent(sdb, ops, "siu", "wh-x", "products/update", {}, () => {});
  assert.equal(r.deduped, false);
});

// ── reconcilePollUsing — every 10 min, auto-heal / alert ────────────────────

await ok("reconcilePollUsing: a genuine live-Shopify mismatch heals (schedules push) and is alerted", async () => {
  const { sdb } = makeFakeSyncDb({
    items: [{ id: 1, shopVariantId: null, shopifyStore: "siu", shopifyInventoryItemId: "inv-1", shopifyVariantId: "var-1", available: 10 }],
    syncState: { "1:siu": { lastPushedQty: 10, lastPushedAt: new Date("2026-07-22T08:00:00Z") } },
  });
  const scheduled: number[] = [];
  const result = await reconcilePollUsing(
    sdb,
    () => ({ domain: "siu.myshopify.com", token: "t", locationGid: "g" }),
    async () => 2, // Shopify's live number disagrees with our last push (10)
    (id) => scheduled.push(id),
    new Date("2026-07-22T10:00:00Z"),
  );
  assert.equal(result.checked, 1);
  assert.equal(result.healed, 1);
  assert.equal(result.alerts.length, 1);
  assert.deepEqual(scheduled, [1]);
});

await ok("reconcilePollUsing: agreement across the board checks everything but heals nothing", async () => {
  const { sdb } = makeFakeSyncDb({
    items: [{ id: 1, shopVariantId: null, shopifyStore: "siu", shopifyInventoryItemId: "inv-1", shopifyVariantId: "var-1", available: 10 }],
    syncState: { "1:siu": { lastPushedQty: 7, lastPushedAt: new Date("2026-07-22T08:00:00Z") } },
  });
  const result = await reconcilePollUsing(
    sdb,
    () => ({ domain: "siu.myshopify.com", token: "t", locationGid: "g" }),
    async () => 7, // matches our last push exactly
    () => {},
    new Date("2026-07-22T10:00:00Z"),
  );
  assert.equal(result.checked, 1);
  assert.equal(result.healed, 0);
  assert.equal(result.alerts.length, 0);
});

await ok("reconcilePollUsing: native-only items are skipped (nothing external to poll)", async () => {
  const { sdb } = makeFakeSyncDb({
    items: [{ id: 1, shopVariantId: 42, shopifyStore: null, shopifyInventoryItemId: null, shopifyVariantId: null, available: 10 }],
  });
  const result = await reconcilePollUsing(sdb, () => null, async () => 999, () => {}, new Date());
  assert.equal(result.checked, 0);
});

await ok("reconcilePollUsing: a store missing its config is skipped, not thrown", async () => {
  const { sdb } = makeFakeSyncDb({
    items: [{ id: 1, shopVariantId: null, shopifyStore: "cufc", shopifyInventoryItemId: "inv-1", shopifyVariantId: "var-1", available: 10 }],
  });
  const result = await reconcilePollUsing(sdb, () => null, async () => 5, () => {}, new Date());
  assert.equal(result.checked, 0);
});

// ── Summary ───────────────────────────────────────────────────────────────

if (process.exitCode) {
  console.error(`\n${passed} passed, some FAILED (see above)`);
} else {
  console.log(`\nAll ${passed} assertions passed.`);
}
