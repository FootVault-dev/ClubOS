// ─────────────────────────────────────────────────────────────────────────────
// Warehouse (WMS) — channel sync (SPEC.md §4.3 / D9 / PLAN.md T12).
//
// WMS is master (D9): stock never gets adjusted by hand in Shopify or in
// shop_variants again. This file is the ONE place that pushes our own
// computed `available` OUT to the two Shopify stores (SIU/CUFC) and to the
// native commerce engine (MFL/CIC, via shop_variants.stock — D11), and the
// ONE place that consumes Shopify's INBOUND webhooks (a paid order → a hard
// reservation; a cancel/refund → release/restock; an inventory edit made
// BY HAND in Shopify → a drift alert, never blindly trusted, D9's "WMS is
// master" doctrine).
//
// 🔴 THERE IS NO DATABASE IN THIS ENVIRONMENT (same constraint as
// server/warehouse.ts — see its own header comment). This module must stay
// safely importable by `tsx script/test-warehouse-sync.ts` with no
// DATABASE_URL set: `import type { db as realDb }` for TYPES ONLY (erased at
// compile time), and the real db is only ever reached via a lazy
// `await import("./db")` inside a function body. Every piece of logic that
// needs to be unit-testable (debounce, echo suppression, drift, sibling
// fan-out, webhook line-aggregation) is split into a DB-free "*Using"/"process*"
// core that takes a bespoke `SyncDb` seam + injected fetch/timer/ops
// functions — mirroring T3/T5/T7's WarehouseDb/ReservationDb/ScanLookupDb
// precedent — and a thin real wrapper that does the lazy import and nothing
// else. The real adapter (`syncDbFromDb`) is type-checked against
// shared/schema.ts but never unit-tested directly (needs a live Postgres).
//
// ALL of this is inert without config (AGENTS.md): every Shopify credential
// is read lazily per-store from env (`WH_SHOPIFY_<STORE>_*`), the whole
// push-queue registration checks `WH_SYNC_ENABLED==='1'`, and a webhook for a
// store missing its secret just 200s an ignored event rather than crashing.
//
// 🔴 TODO-verify(live) markers below flag GraphQL mutation/query shapes
// written from SPEC.md's prose (never executed against a real store) — D9
// specifically calls out that Shopify's `@idempotent` client directive
// became REQUIRED from API version 2026-04; confirm current syntax on
// shopify.dev before this file's first real push.
// ─────────────────────────────────────────────────────────────────────────────
import type { Express, Request, Response } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, isNotNull, or, sql } from "drizzle-orm";
import { whItems, whShopifyVariantLinks, whShopifyEvents, whSyncState, shopVariants } from "@shared/schema";
import type { db as realDb } from "./db";
import {
  isShopifyStoreKey,
  type ShopifyStoreKey,
  type SyncStore,
  QUARANTINE_ZONE,
  type RefKind,
} from "@shared/warehouse";
import {
  onMovementCommitted,
  notifyMovementCommitted,
  runReserveStock,
  runReleaseReservationsForRef,
  reservationDbFromTx,
  releaseReservation,
} from "./warehouse";

// ── Env / config (lazy — never cached at module load) ──────────────────────

export function isSyncEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WH_SYNC_ENABLED === "1";
}

function envStorePrefix(store: ShopifyStoreKey): string {
  return `WH_SHOPIFY_${store.toUpperCase()}`;
}

export interface ShopifyPushConfig {
  /** myshopify domain, e.g. 'south-island-united.myshopify.com'. */
  domain: string;
  /** Admin API access token. */
  token: string;
  /** gid://shopify/Location/... — the warehouse's Shopify location. */
  locationGid: string;
}

/** Returns null the moment ANY required var is missing — a store's push is
 *  then a clean skip (logged), never a crash. */
export function getShopifyPushConfig(store: ShopifyStoreKey, env: NodeJS.ProcessEnv = process.env): ShopifyPushConfig | null {
  const prefix = envStorePrefix(store);
  const domain = env[`${prefix}_DOMAIN`];
  const token = env[`${prefix}_TOKEN`];
  const locationGid = env[`${prefix}_LOCATION_GID`];
  if (!domain || !token || !locationGid) return null;
  return { domain, token, locationGid };
}

export function getShopifyWebhookSecret(store: ShopifyStoreKey, env: NodeJS.ProcessEnv = process.env): string | null {
  return env[`${envStorePrefix(store)}_WEBHOOK_SECRET`] || null;
}

// ── HMAC verification (Shopify webhook signatures) ──────────────────────────
// Same shape as apps/siu-inventory-sync/lib/verify.ts's proven pattern —
// equal-length check before timingSafeEqual (mismatched-length buffers throw
// rather than compare, in Node's crypto).

export function verifyShopifyWebhookHmac(rawBody: string, hmacHeader: string | undefined, secret: string): boolean {
  if (!hmacHeader) return false;
  const computed = createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  const a = Buffer.from(computed, "utf8");
  const b = Buffer.from(hmacHeader, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** A Shopify order/refund numeric id must fit a JS-safe integer (our
 *  wh_movements/wh_reservations.ref_id columns are bigint w/ mode:'number' —
 *  see shared/schema.ts's comment on whMovements.refId for why they're
 *  bigint, not plain integer, specifically BECAUSE of this). Refuses rather
 *  than silently truncating an out-of-range id. */
export function toSafeRefId(raw: unknown, label: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isSafeInteger(n)) {
    throw new Error(`${label} id "${String(raw)}" is not a safe integer — refusing to use it as a ref_id`);
  }
  return n;
}

export function roundQty(qty: number): number {
  return Math.round(qty);
}

// ── Debounced push queue (~5s, D9/§4.3) ─────────────────────────────────────

export const SYNC_DEBOUNCE_MS = 5_000;

type TimerHandle = ReturnType<typeof setTimeout>;
export interface TimerFns {
  setTimeout: (fn: () => void, ms: number) => TimerHandle;
  clearTimeout: (handle: TimerHandle) => void;
}
const REAL_TIMER_FNS: TimerFns = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h) };

/**
 * Collapses N rapid `schedule(key)` calls for the same key into ONE eventual
 * `fire(key)` — a busy pick/dispatch session touching the same item 10 times
 * in a few seconds must push Shopify once, not 10 times. Generic over the key
 * type + injectable timer functions so script/test-warehouse-sync.ts can
 * prove the collapsing behaviour with zero real waiting (a fake TimerFns
 * captures the scheduled callback and the test invokes it directly).
 */
export class Debouncer<K> {
  private readonly timers = new Map<K, TimerHandle>();
  constructor(
    private readonly delayMs: number,
    private readonly fire: (key: K) => void,
    private readonly timerFns: TimerFns = REAL_TIMER_FNS,
  ) {}

  schedule(key: K): void {
    const existing = this.timers.get(key);
    if (existing !== undefined) this.timerFns.clearTimeout(existing);
    const handle = this.timerFns.setTimeout(() => {
      this.timers.delete(key);
      this.fire(key);
    }, this.delayMs);
    this.timers.set(key, handle);
  }

  /** Test/inspection only — which keys currently have a live timer. */
  pendingKeys(): K[] {
    return Array.from(this.timers.keys());
  }
}

// ── Echo suppression + drift detection (D9) ─────────────────────────────────
// `inventory_levels/update` is consumed ONLY as a drift monitor (D9) — never
// as a source of truth. Two questions, in order: (1) is this webhook just
// Shopify echoing back the number WE just pushed? (2) if not, is it a
// genuine mismatch worth alerting + auto-healing?

export const DEFAULT_ECHO_WINDOW_MS = 2 * 60_000; // generous vs a 5s debounce + Shopify's own webhook latency

export interface EchoCheckInput {
  incomingQty: number;
  lastPushedQty: number | null;
  lastPushedAt: Date | null;
  now?: Date;
  windowMs?: number;
}

/** No baseline (never pushed) → can't be our echo. Same qty as our last push,
 *  within the window → almost certainly our own push arriving back as an
 *  inventory_levels/update webhook, not a human editing Shopify. */
export function isEchoOfOurPush(input: EchoCheckInput): boolean {
  if (input.lastPushedQty === null || input.lastPushedAt === null) return false;
  if (input.incomingQty !== input.lastPushedQty) return false;
  const now = input.now ?? new Date();
  const windowMs = input.windowMs ?? DEFAULT_ECHO_WINDOW_MS;
  return now.getTime() - input.lastPushedAt.getTime() <= windowMs;
}

export interface DriftResult {
  isDrift: boolean;
  note: string | null;
}

/** No baseline yet → nothing to drift FROM, not a false-positive alert. Our
 *  own echo → never drift, by definition. Otherwise: does the number Shopify
 *  is reporting differ from the number we last told it to have? */
export function computeDrift(input: { incomingQty: number; lastPushedQty: number | null; isEcho: boolean }): DriftResult {
  if (input.isEcho) return { isDrift: false, note: null };
  if (input.lastPushedQty === null) return { isDrift: false, note: null };
  if (input.incomingQty === input.lastPushedQty) return { isDrift: false, note: null };
  return {
    isDrift: true,
    note: `Shopify reports ${input.incomingQty}, we last pushed ${input.lastPushedQty} — someone edited Shopify's inventory directly.`,
  };
}

// ── SIU sibling-variant fan-out (D9/§4.3) ───────────────────────────────────

export interface ShopifyPushTarget {
  shopifyInventoryItemId: string;
  shopifyVariantId: string;
}

/** The item's own PRIMARY mapping (whItems.shopify*) plus every sibling link
 *  that shares the SAME store — a sibling tagged with a different store than
 *  the item's own primary mapping is a data error, skipped rather than
 *  pushed at the wrong store. De-dupes by inventory item id (a sibling row
 *  accidentally duplicating the primary's own variant would otherwise push
 *  the same target twice). */
export function fanOutTargets(
  primary: { store: ShopifyStoreKey; shopifyInventoryItemId: string; shopifyVariantId: string },
  siblings: readonly { store: string; shopifyInventoryItemId: string; shopifyVariantId: string }[],
): ShopifyPushTarget[] {
  const targets: ShopifyPushTarget[] = [
    { shopifyInventoryItemId: primary.shopifyInventoryItemId, shopifyVariantId: primary.shopifyVariantId },
  ];
  const seen = new Set([primary.shopifyInventoryItemId]);
  for (const s of siblings) {
    if (s.store !== primary.store) continue;
    if (seen.has(s.shopifyInventoryItemId)) continue;
    seen.add(s.shopifyInventoryItemId);
    targets.push({ shopifyInventoryItemId: s.shopifyInventoryItemId, shopifyVariantId: s.shopifyVariantId });
  }
  return targets;
}

// ── Minimal fetch-based Shopify GraphQL client (D9 — GraphQL only) ──────────

const SHOPIFY_API_VERSION = "2026-01"; // 🔴 TODO-verify(live): confirm still current/stable before first real push.

interface ShopifyGraphqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

async function shopifyGraphql<T>(
  config: ShopifyPushConfig,
  query: string,
  variables: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<T> {
  const res = await fetchImpl(`https://${config.domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": config.token, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`Shopify GraphQL HTTP ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as ShopifyGraphqlResponse<T>;
  if (json.errors?.length) {
    throw new Error(`Shopify GraphQL errors: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  if (!json.data) throw new Error("Shopify GraphQL returned no data");
  return json.data;
}

// 🔴 TODO-verify(live): D9 — the `@idempotent` client directive is REQUIRED
// on mutations from API version 2026-04 onward. This was written from
// SPEC.md's prose, never executed against a live store — confirm the exact
// directive/argument syntax on shopify.dev before this ever runs for real.
// The idempotencyKey is threaded through the call site regardless so the
// plumbing (a fresh key per push attempt) is ready the day the syntax lands.
const INVENTORY_SET_QUANTITIES_MUTATION = `#graphql
  mutation InventorySetQuantities($input: InventorySetQuantitiesInput!) {
    inventorySetQuantities(input: $input) {
      inventoryAdjustmentGroup { id }
      userErrors { field message }
    }
  }
`;

interface InventorySetQuantitiesResponse {
  inventorySetQuantities: {
    inventoryAdjustmentGroup: { id: string } | null;
    userErrors: Array<{ field: string[] | null; message: string }>;
  };
}

/** D9: `inventorySetQuantities` with `name:'available'` + `ignoreCompareQuantity:true`
 *  — Shopify's documented "I am the source of truth, just set it" mode. One
 *  call per fan-out target (the caller loops `fanOutTargets()`'s result). */
export async function pushInventoryToShopify(
  config: ShopifyPushConfig,
  inventoryItemGid: string,
  quantity: number,
  idempotencyKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const data = await shopifyGraphql<InventorySetQuantitiesResponse>(
    config,
    INVENTORY_SET_QUANTITIES_MUTATION,
    {
      input: {
        name: "available",
        reason: "correction",
        ignoreCompareQuantity: true,
        quantities: [{ inventoryItemId: inventoryItemGid, locationId: config.locationGid, quantity: roundQty(quantity) }],
      },
    },
    fetchImpl,
  );
  const errs = data.inventorySetQuantities.userErrors;
  if (errs?.length) {
    throw new Error(`Shopify inventorySetQuantities userErrors (idempotencyKey ${idempotencyKey}): ${errs.map((e) => e.message).join("; ")}`);
  }
}

// 🔴 TODO-verify(live): confirm this query shape (InventoryLevel connection,
// `quantities(names:[...])`) against current shopify.dev docs — used only by
// the 10-min reconcile poll, not the hot push/webhook path.
const INVENTORY_LEVEL_QUERY = `#graphql
  query InventoryLevelForItem($id: ID!, $locationId: ID!) {
    inventoryItem(id: $id) {
      inventoryLevel(locationId: $locationId) {
        quantities(names: ["available"]) { quantity }
      }
    }
  }
`;

interface InventoryLevelQueryResponse {
  inventoryItem: {
    inventoryLevel: { quantities: Array<{ quantity: number }> } | null;
  } | null;
}

export async function fetchShopifyAvailable(
  config: ShopifyPushConfig,
  inventoryItemGid: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number | null> {
  const data = await shopifyGraphql<InventoryLevelQueryResponse>(
    config,
    INVENTORY_LEVEL_QUERY,
    { id: inventoryItemGid, locationId: config.locationGid },
    fetchImpl,
  );
  const qty = data.inventoryItem?.inventoryLevel?.quantities?.[0]?.quantity;
  return typeof qty === "number" ? qty : null;
}

// 🔴 TODO-verify(live): T8's warehouse-routes.ts stub (notifyShopifyFulfilled,
// behind WH_SHOPIFY_FULFIL=1) explicitly defers the real fulfillmentCreate
// call to this file — built here so the plumbing exists, but NOT wired into
// that stub (would touch T8's already-committed file beyond the one flagged
// edit AGENTS.md reserves for T13; wiring it in is a follow-up task's job).
const FULFILLMENT_CREATE_MUTATION = `#graphql
  mutation FulfillmentCreate($fulfillment: FulfillmentInput!) {
    fulfillmentCreate(fulfillment: $fulfillment) {
      fulfillment { id }
      userErrors { field message }
    }
  }
`;

interface FulfillmentCreateResponse {
  fulfillmentCreate: {
    fulfillment: { id: string } | null;
    userErrors: Array<{ field: string[] | null; message: string }>;
  };
}

export async function fulfillShopifyOrderLine(
  config: ShopifyPushConfig,
  fulfillmentOrderLineItemId: string,
  quantity: number,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const data = await shopifyGraphql<FulfillmentCreateResponse>(
    config,
    FULFILLMENT_CREATE_MUTATION,
    { fulfillment: { lineItemsByFulfillmentOrder: [{ fulfillmentOrderLineItems: [{ id: fulfillmentOrderLineItemId, quantity }] }] } },
    fetchImpl,
  );
  const errs = data.fulfillmentCreate.userErrors;
  if (errs?.length) {
    throw new Error(`Shopify fulfillmentCreate userErrors: ${errs.map((e) => e.message).join("; ")}`);
  }
}

// ── SyncDb — the bespoke DB seam (same reasoning as WarehouseDb/ReservationDb/
// ScanLookupDb: a plain object-literal fake in script/test-warehouse-sync.ts,
// syncDbFromDb() the only real adapter, never unit-tested directly) ─────────

export interface MappedItemForSync {
  id: number;
  shopVariantId: number | null;
  shopifyStore: ShopifyStoreKey | null;
  shopifyInventoryItemId: string | null;
  shopifyVariantId: string | null;
}

export interface SyncSiblingLink {
  store: string;
  shopifyVariantId: string;
  shopifyInventoryItemId: string;
}

export interface SyncStateRow {
  lastPushedQty: number | null;
  lastPushedAt: Date | null;
}

export interface SyncDb {
  getItemForSync(itemId: number): Promise<MappedItemForSync | null>;
  getSiblingLinks(itemId: number): Promise<SyncSiblingLink[]>;
  /** Σ on_hand across sellable bins − Σ active reservations (D2/D3) — same
   *  math as server/warehouse.ts's ReservationDb.getAvailableForItem, minus
   *  the FOR UPDATE row-locking (this is a background read triggered after a
   *  movement already committed, not a concurrency guard on a new one). */
  getAvailableForItem(itemId: number): Promise<number>;
  getSyncState(itemId: number, store: SyncStore): Promise<SyncStateRow | null>;
  upsertSyncState(itemId: number, store: SyncStore, qty: number, pushedAt: Date): Promise<void>;
  recordDrift(itemId: number, store: SyncStore, note: string, at: Date): Promise<void>;
  updateNativeStock(shopVariantId: number, qty: number): Promise<void>;
  /** Checks the item's own PRIMARY mapping first, then wh_shopify_variant_links. */
  findItemIdByShopifyVariant(store: ShopifyStoreKey, shopifyVariantId: string): Promise<number | null>;
  findItemIdByShopifyInventoryItem(store: ShopifyStoreKey, shopifyInventoryItemId: string): Promise<number | null>;
  /** true = newly recorded (process this event); false = a redelivery
   *  (Shopify does redeliver) already seen — dedupe on ITS OWN webhook id,
   *  never a key we generate. */
  recordShopifyEvent(webhookId: string, topic: string, store: ShopifyStoreKey): Promise<boolean>;
  /** Every item with ANY channel mapping (native or Shopify) — the reconcile
   *  poll's target set. */
  listMappedItemIds(): Promise<number[]>;
}

export function syncDbFromDb(database: Pick<typeof realDb, "select" | "insert" | "update" | "execute">): SyncDb {
  return {
    async getItemForSync(itemId) {
      const rows = await database
        .select({
          id: whItems.id,
          shopVariantId: whItems.shopVariantId,
          shopifyStore: whItems.shopifyStore,
          shopifyInventoryItemId: whItems.shopifyInventoryItemId,
          shopifyVariantId: whItems.shopifyVariantId,
        })
        .from(whItems)
        .where(eq(whItems.id, itemId))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id,
        shopVariantId: row.shopVariantId,
        shopifyStore: isShopifyStoreKey(row.shopifyStore) ? row.shopifyStore : null,
        shopifyInventoryItemId: row.shopifyInventoryItemId,
        shopifyVariantId: row.shopifyVariantId,
      };
    },
    async getSiblingLinks(itemId) {
      return database
        .select({
          store: whShopifyVariantLinks.store,
          shopifyVariantId: whShopifyVariantLinks.shopifyVariantId,
          shopifyInventoryItemId: whShopifyVariantLinks.shopifyInventoryItemId,
        })
        .from(whShopifyVariantLinks)
        .where(eq(whShopifyVariantLinks.itemId, itemId));
    },
    async getAvailableForItem(itemId) {
      // Two plain SELECTs (no FOR UPDATE — this isn't a concurrency guard,
      // see this function's own interface doc) mirroring
      // ReservationDb.getAvailableForItem's exact sellable-bin filter.
      const stockRows = await database.execute(sql`
        SELECT s.on_hand
        FROM wh_stock s
        JOIN wh_locations l ON l.id = s.location_id
        WHERE s.item_id = ${itemId}
          AND l.kind <> 'virtual'
          AND UPPER(l.code) <> ${QUARANTINE_ZONE}
      `);
      const reservedRows = await database.execute(sql`
        SELECT qty FROM wh_reservations WHERE item_id = ${itemId} AND status = 'active'
      `);
      const onHandSum = (stockRows.rows as Array<{ on_hand: string }>).reduce((s, r) => s + Number(r.on_hand), 0);
      const reservedSum = (reservedRows.rows as Array<{ qty: string }>).reduce((s, r) => s + Number(r.qty), 0);
      return onHandSum - reservedSum;
    },
    async getSyncState(itemId, store) {
      const rows = await database
        .select({ lastPushedQty: whSyncState.lastPushedQty, lastPushedAt: whSyncState.lastPushedAt })
        .from(whSyncState)
        .where(and(eq(whSyncState.itemId, itemId), eq(whSyncState.store, store)))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      return {
        lastPushedQty: row.lastPushedQty === null ? null : Number(row.lastPushedQty),
        lastPushedAt: row.lastPushedAt,
      };
    },
    async upsertSyncState(itemId, store, qty, pushedAt) {
      // `pending` (schema comment: "the sync dashboard's data") is always
      // written false here — this call only ever runs AFTER a push actually
      // completed. Setting it true while an item sits in the debounce window
      // would need a DB write on every movement commit just for a cosmetic
      // dashboard flag; deferred to T16c (which can just read
      // pushDebouncer.pendingKeys() in-process for "currently queued" instead
      // of persisting it) rather than adding that write to this hot path now.
      await database
        .insert(whSyncState)
        .values({ itemId, store, lastPushedQty: String(qty), lastPushedAt: pushedAt, pending: false })
        .onConflictDoUpdate({
          target: [whSyncState.itemId, whSyncState.store],
          set: { lastPushedQty: String(qty), lastPushedAt: pushedAt, pending: false },
        });
    },
    async recordDrift(itemId, store, note, at) {
      await database
        .update(whSyncState)
        .set({ lastDriftAt: at, driftNote: note })
        .where(and(eq(whSyncState.itemId, itemId), eq(whSyncState.store, store)));
    },
    async updateNativeStock(shopVariantId, qty) {
      await database.update(shopVariants).set({ stock: qty }).where(eq(shopVariants.id, shopVariantId));
    },
    async findItemIdByShopifyVariant(store, shopifyVariantId) {
      const primary = await database
        .select({ id: whItems.id })
        .from(whItems)
        .where(and(eq(whItems.shopifyStore, store), eq(whItems.shopifyVariantId, shopifyVariantId)))
        .limit(1);
      if (primary[0]) return primary[0].id;
      const sibling = await database
        .select({ itemId: whShopifyVariantLinks.itemId })
        .from(whShopifyVariantLinks)
        .where(and(eq(whShopifyVariantLinks.store, store), eq(whShopifyVariantLinks.shopifyVariantId, shopifyVariantId)))
        .limit(1);
      return sibling[0]?.itemId ?? null;
    },
    async findItemIdByShopifyInventoryItem(store, shopifyInventoryItemId) {
      const primary = await database
        .select({ id: whItems.id })
        .from(whItems)
        .where(and(eq(whItems.shopifyStore, store), eq(whItems.shopifyInventoryItemId, shopifyInventoryItemId)))
        .limit(1);
      if (primary[0]) return primary[0].id;
      const sibling = await database
        .select({ itemId: whShopifyVariantLinks.itemId })
        .from(whShopifyVariantLinks)
        .where(and(eq(whShopifyVariantLinks.store, store), eq(whShopifyVariantLinks.shopifyInventoryItemId, shopifyInventoryItemId)))
        .limit(1);
      return sibling[0]?.itemId ?? null;
    },
    async recordShopifyEvent(webhookId, topic, store) {
      const inserted = await database
        .insert(whShopifyEvents)
        .values({ webhookId, topic, store })
        .onConflictDoNothing()
        .returning({ id: whShopifyEvents.id });
      return inserted.length > 0;
    },
    async listMappedItemIds() {
      const rows = await database
        .select({ id: whItems.id })
        .from(whItems)
        .where(or(isNotNull(whItems.shopVariantId), isNotNull(whItems.shopifyVariantId)));
      return rows.map((r) => r.id);
    },
  };
}

// ── Reservation ops seam — lets webhook-processing logic be unit-tested with
// a fake recording object, exactly like AGENTS.md's "inject a fake tx/db
// object that records calls" instruction. server/warehouse.ts's own
// runReserveStock/runReleaseReservationsForRef lazily import "./db" the
// moment they're CALLED (not merely referenced) — calling them from a
// DB-free test would throw, so the webhook-processing functions below take
// this seam instead and never call those directly. ──────────────────────────

export interface ReservationOps {
  reserve(itemId: number, qty: number, ref: { kind: RefKind; id: number }): Promise<void>;
  releaseAllForRef(ref: { kind: RefKind; id: number }): Promise<void>;
  releaseForRefItem(ref: { kind: RefKind; id: number }, itemId: number): Promise<void>;
}

/** Releases just ONE (ref, item)'s reservation — for a partial Shopify
 *  refund (only some lines restocked), unlike orders/cancelled which
 *  legitimately releases every item on the order. Composed entirely from
 *  server/warehouse.ts's EXISTING exports (reservationDbFromTx +
 *  releaseReservation) rather than adding a new export there — no edit to
 *  that file needed. */
async function releaseReservationForRefItemReal(ref: { kind: RefKind; id: number }, itemId: number): Promise<void> {
  const { db } = await import("./db");
  const result = await db.transaction(async (tx) => {
    const rdb = reservationDbFromTx(tx);
    const existing = await rdb.findActiveReservationByRef(ref, itemId);
    if (!existing) return null; // never reserved (or already released/consumed) — nothing to do
    return releaseReservation(rdb, existing.id);
  });
  if (result?.released) notifyMovementCommitted([itemId]);
}

const realReservationOps: ReservationOps = {
  async reserve(itemId, qty, ref) {
    await runReserveStock({ itemId, qty, ref });
  },
  async releaseAllForRef(ref) {
    await runReleaseReservationsForRef(ref);
  },
  async releaseForRefItem(ref, itemId) {
    await releaseReservationForRefItemReal(ref, itemId);
  },
};

// ── Webhook line-processing (DB-free-testable core) ─────────────────────────

export interface OrderCreateLine {
  variantId: string;
  quantity: number;
}

/**
 * Aggregates order lines to wh_item BEFORE reserving — the critical fix the
 * sibling fan-out (T12) makes newly necessary: two lines in the SAME order
 * that map (directly, or via a sibling link) to the SAME wh_item — e.g. a
 * Plain shirt AND a Custom-printed shirt of the same size, genuinely two
 * physical blanks — must reserve their SUMMED qty in ONE reserveStock call.
 * reserveStock's own idempotency is keyed per (ref,item) (server/warehouse.ts):
 * a SECOND call for an item already reserved against this order returns the
 * EXISTING reservation untouched, so calling it once per LINE would silently
 * drop every line after the first that shares an item. Aggregating first
 * makes one call per unique item, with the correct total.
 */
export async function processShopifyOrderCreate(
  sdb: SyncDb,
  ops: ReservationOps,
  store: ShopifyStoreKey,
  orderId: number,
  lines: readonly OrderCreateLine[],
): Promise<{ reservedItemIds: number[] }> {
  const qtyByItem = new Map<number, number>();
  for (const line of lines) {
    if (!(line.quantity > 0) || !line.variantId) continue;
    const itemId = await sdb.findItemIdByShopifyVariant(store, line.variantId);
    if (itemId === null) continue; // not a WMS-mapped variant — nothing to reserve
    qtyByItem.set(itemId, (qtyByItem.get(itemId) ?? 0) + line.quantity);
  }
  for (const [itemId, qty] of Array.from(qtyByItem)) {
    await ops.reserve(itemId, qty, { kind: "shopify_order", id: orderId });
  }
  return { reservedItemIds: Array.from(qtyByItem.keys()) };
}

/** A full order cancellation releases every active reservation on the order
 *  (every item), unlike a refund which may only cover some lines. */
export async function processShopifyOrderCancelled(ops: ReservationOps, orderId: number): Promise<void> {
  await ops.releaseAllForRef({ kind: "shopify_order", id: orderId });
}

export interface RefundLine {
  variantId: string;
  /** Shopify's own refund_line_items[].restock_type === 'no_restock' — the
   *  merchant explicitly said "don't put this back on the shelf". */
  noRestock: boolean;
}

/** A refund can be partial — only release the specific items refunded (never
 *  the whole order's reservations), and only the ones actually meant to
 *  restock. De-dupes across multiple refund lines mapping to the same item
 *  (release is a one-shot state flip, not a quantity — calling it twice for
 *  the same item would be a harmless no-op via releaseReservation's own
 *  idempotency, but there's no reason to call it twice). */
export async function processShopifyRefundCreate(
  sdb: SyncDb,
  ops: ReservationOps,
  store: ShopifyStoreKey,
  orderId: number,
  lines: readonly RefundLine[],
): Promise<{ releasedItemIds: number[] }> {
  const itemIds = new Set<number>();
  for (const line of lines) {
    if (line.noRestock || !line.variantId) continue;
    const itemId = await sdb.findItemIdByShopifyVariant(store, line.variantId);
    if (itemId === null) continue;
    itemIds.add(itemId);
  }
  for (const itemId of Array.from(itemIds)) {
    await ops.releaseForRefItem({ kind: "shopify_order", id: orderId }, itemId);
  }
  return { releasedItemIds: Array.from(itemIds) };
}

export interface InventoryLevelsUpdatePayload {
  inventoryItemId: string;
  available: number;
}

/** D9: inventory_levels/update is a DRIFT MONITOR only, never a write path —
 *  echo-check first, then flag+auto-heal a genuine mismatch (schedules a
 *  re-push of OUR number; WMS is master, so healing means reasserting our
 *  own value, never adopting Shopify's). */
export async function processInventoryLevelsUpdate(
  sdb: SyncDb,
  store: ShopifyStoreKey,
  payload: InventoryLevelsUpdatePayload,
  schedulePushFn: (itemId: number) => void,
  now: Date = new Date(),
): Promise<{ itemId: number | null; isEcho: boolean; isDrift: boolean }> {
  const itemId = await sdb.findItemIdByShopifyInventoryItem(store, payload.inventoryItemId);
  if (itemId === null) return { itemId: null, isEcho: false, isDrift: false };
  const state = await sdb.getSyncState(itemId, store);
  const isEcho = isEchoOfOurPush({
    incomingQty: payload.available,
    lastPushedQty: state?.lastPushedQty ?? null,
    lastPushedAt: state?.lastPushedAt ?? null,
    now,
  });
  const { isDrift, note } = computeDrift({ incomingQty: payload.available, lastPushedQty: state?.lastPushedQty ?? null, isEcho });
  if (isDrift && note) {
    await sdb.recordDrift(itemId, store, note, now);
    schedulePushFn(itemId);
  }
  return { itemId, isEcho, isDrift };
}

// ── Push (outbound) — DB-free-testable core + real wrapper ──────────────────

export interface PushOutcome {
  itemId: number;
  available: number;
  nativePushed: boolean;
  shopifyPushed: boolean;
  shopifyTargets: number;
  skippedReason?: string;
}

/** Computes `available` once, then pushes it to whichever channel(s) this
 *  item is mapped to — native (shop_variants.stock, D11) and/or Shopify
 *  (fanned out to every sibling variant, D9/§4.3). Both get the SAME sync
 *  key (item×store) in wh_sync_state regardless of how many Shopify variants
 *  physically received the push — they always carry the identical number by
 *  construction. */
export async function pushItemUsing(
  sdb: SyncDb,
  itemId: number,
  getConfig: (store: ShopifyStoreKey) => ShopifyPushConfig | null,
  fetchImpl: typeof fetch,
  now: Date = new Date(),
): Promise<PushOutcome> {
  const item = await sdb.getItemForSync(itemId);
  if (!item) return { itemId, available: 0, nativePushed: false, shopifyPushed: false, shopifyTargets: 0, skippedReason: "item not found" };

  const available = await sdb.getAvailableForItem(itemId);
  let nativePushed = false;
  let shopifyPushed = false;
  let shopifyTargets = 0;
  let skippedReason: string | undefined;

  if (item.shopVariantId != null) {
    const qty = Math.max(0, roundQty(available)); // native storefront never shows negative stock
    await sdb.updateNativeStock(item.shopVariantId, qty);
    await sdb.upsertSyncState(itemId, "native", qty, now);
    nativePushed = true;
  }

  if (item.shopifyStore && item.shopifyInventoryItemId) {
    const config = getConfig(item.shopifyStore);
    if (!config) {
      skippedReason = `WH_SHOPIFY_${item.shopifyStore.toUpperCase()}_* not fully configured — push skipped`;
    } else {
      const siblings = await sdb.getSiblingLinks(itemId);
      const targets = fanOutTargets(
        { store: item.shopifyStore, shopifyInventoryItemId: item.shopifyInventoryItemId, shopifyVariantId: item.shopifyVariantId ?? "" },
        siblings,
      );
      for (const target of targets) {
        const idempotencyKey = `wms-${itemId}-${target.shopifyInventoryItemId}-${now.getTime()}`;
        await pushInventoryToShopify(config, target.shopifyInventoryItemId, available, idempotencyKey, fetchImpl);
      }
      await sdb.upsertSyncState(itemId, item.shopifyStore, roundQty(available), now);
      shopifyPushed = true;
      shopifyTargets = targets.length;
    }
  }

  return { itemId, available, nativePushed, shopifyPushed, shopifyTargets, skippedReason };
}

export async function pushItemNow(itemId: number): Promise<PushOutcome> {
  const { db } = await import("./db");
  const sdb = syncDbFromDb(db);
  return pushItemUsing(sdb, itemId, (store) => getShopifyPushConfig(store), fetch);
}

const pushDebouncer = new Debouncer<number>(SYNC_DEBOUNCE_MS, (itemId) => {
  pushItemNow(itemId).catch((e) => console.error(`[Warehouse Sync] push failed for item ${itemId}:`, e));
});

function schedulePush(itemId: number): void {
  pushDebouncer.schedule(itemId);
}

/** Item ids currently sitting in the debounce window, awaiting their push —
 *  the in-process alternative to a persisted `pending` flag (see
 *  upsertSyncState's comment). A future T16c sync dashboard can call this for
 *  a live "currently queued" list without any extra DB write on the hot
 *  movement-commit path. */
export function getPendingPushItemIds(): number[] {
  return pushDebouncer.pendingKeys();
}

/** Registered into server/warehouse.ts's onMovementCommitted (§4.3's own
 *  comment: "T12's warehouse-sync.ts calls this once at startup"). Gated by
 *  WH_SYNC_ENABLED so the whole subsystem is inert without config even
 *  though the hook itself is always registered. */
function handlePushTrigger(itemIds: number[]): void {
  if (!isSyncEnabled()) return;
  for (const id of itemIds) schedulePush(id);
}

// ── Reconcile poll (D9 — every 10 min, auto-heal / alert) ───────────────────

export const RECONCILE_POLL_INTERVAL_MS = 10 * 60_000;

export interface ReconcilePollResult {
  checked: number;
  healed: number;
  alerts: Array<{ itemId: number; note: string }>;
}

export async function reconcilePollUsing(
  sdb: SyncDb,
  getConfig: (store: ShopifyStoreKey) => ShopifyPushConfig | null,
  fetchAvailable: (config: ShopifyPushConfig, inventoryItemGid: string) => Promise<number | null>,
  schedulePushFn: (itemId: number) => void,
  now: Date = new Date(),
): Promise<ReconcilePollResult> {
  const itemIds = await sdb.listMappedItemIds();
  const result: ReconcilePollResult = { checked: 0, healed: 0, alerts: [] };
  for (const itemId of itemIds) {
    const item = await sdb.getItemForSync(itemId);
    // Native items are always "in sync" — we're the only writer of
    // shop_variants.stock, so there's nothing external to poll for drift.
    if (!item?.shopifyStore || !item.shopifyInventoryItemId) continue;
    const config = getConfig(item.shopifyStore);
    if (!config) continue;
    result.checked++;
    const liveQty = await fetchAvailable(config, item.shopifyInventoryItemId);
    if (liveQty === null) continue;
    const state = await sdb.getSyncState(itemId, item.shopifyStore);
    const isEcho = isEchoOfOurPush({
      incomingQty: liveQty,
      lastPushedQty: state?.lastPushedQty ?? null,
      lastPushedAt: state?.lastPushedAt ?? null,
      now,
    });
    const { isDrift, note } = computeDrift({ incomingQty: liveQty, lastPushedQty: state?.lastPushedQty ?? null, isEcho });
    if (isDrift && note) {
      await sdb.recordDrift(itemId, item.shopifyStore, note, now);
      schedulePushFn(itemId);
      result.healed++;
      result.alerts.push({ itemId, note });
    }
  }
  return result;
}

/** Intended to be wired to a cron (T19's runbook) — not wired here (no cron
 *  scheduling framework is part of this task's scope; PLAN.md's own T12 line
 *  asks for "a reconcile poll function", not its scheduling). */
export async function runReconcilePoll(): Promise<ReconcilePollResult> {
  const { db } = await import("./db");
  const sdb = syncDbFromDb(db);
  return reconcilePollUsing(sdb, (store) => getShopifyPushConfig(store), (cfg, id) => fetchShopifyAvailable(cfg, id), schedulePush);
}

// ── Express routes: inbound Shopify webhooks ────────────────────────────────
// Public (no requireAuth/requireTab — Shopify itself calls these), verified
// by HMAC instead. req.rawBody is already captured globally by
// server/index.ts's express.json({verify}) middleware (same pattern as the
// existing /api/public/cugc/stripe-webhook route in server/routes.ts) — no
// separate express.raw() route needed.

/**
 * The whole "verified webhook body → effect" pipeline, EXCLUDING signature
 * verification and header parsing (Express/HMAC concerns) — dedupe on
 * webhookId first (Shopify redelivers), then dispatch by topic. Pulled out
 * of the route handler so it's directly unit-testable with a fake SyncDb +
 * fake ReservationOps (AGENTS.md's "inject a fake tx/db object that records
 * calls"), covering the "dedupe" requirement PLAN.md's T12 line names
 * explicitly without needing an HTTP test harness (none exists in this repo).
 */
export async function handleShopifyWebhookEvent(
  sdb: SyncDb,
  ops: ReservationOps,
  store: ShopifyStoreKey,
  webhookId: string,
  topic: string,
  payload: any,
  schedulePushFn: (itemId: number) => void,
): Promise<{ deduped: boolean }> {
  const isNew = await sdb.recordShopifyEvent(webhookId, topic, store);
  if (!isNew) return { deduped: true };

  if (topic === "orders/create") {
    const orderId = toSafeRefId(payload?.id, "shopify order");
    const lines: OrderCreateLine[] = (Array.isArray(payload?.line_items) ? payload.line_items : [])
      .map((li: any) => ({ variantId: String(li?.variant_id ?? ""), quantity: Number(li?.quantity ?? 0) }))
      .filter((l: OrderCreateLine) => l.variantId && l.quantity > 0);
    await processShopifyOrderCreate(sdb, ops, store, orderId, lines);
  } else if (topic === "orders/cancelled") {
    const orderId = toSafeRefId(payload?.id, "shopify order");
    await processShopifyOrderCancelled(ops, orderId);
  } else if (topic === "refunds/create") {
    const orderId = toSafeRefId(payload?.order_id, "shopify order");
    const lines: RefundLine[] = (Array.isArray(payload?.refund_line_items) ? payload.refund_line_items : [])
      .map((rli: any) => ({
        variantId: String(rli?.line_item?.variant_id ?? ""),
        noRestock: rli?.restock_type === "no_restock",
      }))
      .filter((l: RefundLine) => l.variantId);
    await processShopifyRefundCreate(sdb, ops, store, orderId, lines);
  } else if (topic === "inventory_levels/update") {
    const inventoryItemId = String(payload?.inventory_item_id ?? "");
    const available = Number(payload?.available ?? NaN);
    if (inventoryItemId && Number.isFinite(available)) {
      await processInventoryLevelsUpdate(sdb, store, { inventoryItemId, available }, schedulePushFn);
    }
  } else {
    console.log(`[Warehouse Sync] ignoring topic "${topic}"`);
  }

  return { deduped: false };
}

export function registerWarehouseSyncRoutes(app: Express): void {
  // Wires the debounced push queue into the movement engine's post-commit
  // hook. Always registered (cheap); WH_SYNC_ENABLED gates whether it does
  // anything (handlePushTrigger's own check) — "inert without config".
  onMovementCommitted(handlePushTrigger);

  app.post("/api/public/warehouse/shopify/:store/webhook", async (req: Request, res: Response) => {
    const storeParam = req.params.store;
    if (!isShopifyStoreKey(storeParam)) {
      return res.status(404).json({ message: "unknown store" });
    }
    const store: ShopifyStoreKey = storeParam;

    const secret = getShopifyWebhookSecret(store);
    if (!secret) {
      // Not configured yet — 200 so Shopify doesn't hammer retries against a
      // store we haven't wired credentials for.
      console.warn(`[Warehouse Sync] webhook received for ${store} but WH_SHOPIFY_${store.toUpperCase()}_WEBHOOK_SECRET isn't set — ignored`);
      return res.status(200).json({ ok: false, ignored: true, reason: "not configured" });
    }

    const hmacHeader = req.headers["x-shopify-hmac-sha256"] as string | undefined;
    const raw = req.rawBody as Buffer | undefined;
    if (!raw || !verifyShopifyWebhookHmac(raw.toString("utf8"), hmacHeader, secret)) {
      console.warn(`[Warehouse Sync] webhook HMAC verification failed for ${store}`);
      return res.status(401).json({ message: "invalid signature" });
    }

    const webhookId = req.headers["x-shopify-webhook-id"] as string | undefined;
    const topic = (req.headers["x-shopify-topic"] as string | undefined) || "";
    if (!webhookId) return res.status(400).json({ message: "missing X-Shopify-Webhook-Id" });

    const { db } = await import("./db");
    const sdb = syncDbFromDb(db);

    try {
      const { deduped } = await handleShopifyWebhookEvent(sdb, realReservationOps, store, webhookId, topic, req.body || {}, schedulePush);
      return res.status(200).json({ ok: true, topic, deduped });
    } catch (e) {
      // recordShopifyEvent already ran (inside handleShopifyWebhookEvent)
      // before any processing that could throw, so a retry of the SAME
      // webhook id would just dedupe — safe to 200 rather than ask Shopify
      // to hammer retries against a processing bug forever. Logged for a human.
      console.error(`[Warehouse Sync] webhook processing error (${topic}, ${store}):`, e);
      return res.status(200).json({ ok: false, topic, error: "processing error, logged" });
    }
  });
}
