// The movement engine (SPEC.md §4.2) — the ONE function every stock-changing
// flow in the warehouse goes through. `wh_movements` is the append-only
// ledger of truth (D1); `wh_stock` is a same-transaction cache maintained by
// an atomic non-negative-guarded upsert (D2). No UPDATE/DELETE code path may
// ever touch wh_movements — a correction is a new adjustment movement.
//
// 🔴 THERE IS NO DATABASE IN THIS ENVIRONMENT. This module must be safely
// importable (by tsc and by script/test-warehouse-engine.ts) with no
// DATABASE_URL set. server/db.ts THROWS at module-load time if
// DATABASE_URL is missing, so — same trick as server/accounting/post.ts —
// the real `db` is only ever reached via a LAZY `await import("./db")`
// inside a function body (runMovementGroup, reconcileStock's default), never
// as a top-level value import. `import type` below is erased at compile
// time and never executes the module.
//
// Testability seam: `postMovementGroup` takes a `WarehouseDb` — three narrow,
// named async operations — instead of a raw drizzle transaction object.
// Unlike server/accounting/post.ts's single onConflictDoNothing().returning()
// call (fakeable by comparing the VALUES an insert receives), this engine
// needs a computed guarded upsert (SET on_hand = on_hand + delta WHERE
// on_hand + delta >= 0) and a batch ledger insert — conditions built from
// drizzle's `sql` template aren't practically introspectable by a plain
// object-literal fake. So the fake implements WarehouseDb directly (in-memory
// Maps — script/test-warehouse-engine.ts), while `warehouseDbFromTx` is the
// ONLY adapter that ever talks to real drizzle, type-checked against
// shared/schema.ts but never unit-tested directly (would need a live
// Postgres — exercised for real only after a human runs the migration).
import { randomUUID } from "crypto";
import { and, eq, sql } from "drizzle-orm";
import { whMovements, whReservations, whStock, whItems, whLocations, whBarcodeAliases, whItemInstances } from "@shared/schema";
import type { db as realDb } from "./db";
import {
  isMovementType,
  isReasonCode,
  isRefKind,
  legsSumToZero,
  QUARANTINE_ZONE,
  normaliseSku,
  normaliseAliasCode,
  normaliseLocationCode,
  stripLocationPrefix,
  scanActionsForItem,
  scanActionsForLocation,
  scanActionsForInstance,
  stripInstancePrefix,
  normaliseAssetTag,
  type MovementType,
  type ReasonCode,
  type RefKind,
  type ReservationStatus,
  type LocationKind,
  type InstanceCondition,
} from "@shared/warehouse";

// ── Public shapes ────────────────────────────────────────────────────────────

export interface MovementLeg {
  itemId: number;
  /** D19 — set for an asset item's leg, where `delta` is always exactly ±1.
   *  The SAME ledger carries both stock and assets, so wh_stock.on_hand for an
   *  asset item at a location is just the count of instances standing there
   *  and no existing query needed changing. Null for ordinary bulk stock. */
  instanceId?: number | null;
  locationId: number;
  /** The location's own code (e.g. 'A-01-2', 'QUARANTINE') — used ONLY for a
   *  clean "insufficient stock at <LOCATION>" error message. The caller
   *  already resolved the location row (scan/route layer already has it), so
   *  the engine never runs its own SELECT against wh_locations. */
  locationCode: string;
  /** Signed quantity change. Must be non-zero — mirrors the DB CHECK
   *  (delta<>0) on wh_movements; validated here too so the WHOLE group is
   *  rejected before a single row is written (a partially-posted group would
   *  be worse than no group at all). */
  delta: number;
  /** wh_items.allow_negative for THIS item (D16), resolved by the caller (who
   *  already has the item row from resolving the scan/SKU) — the engine
   *  never runs its own SELECT against wh_items. Defaults to false (the
   *  non-negative guard applies). */
  allowNegative?: boolean;
  /** Overrides the group's reasonCode for just this leg — e.g. one receiving
   *  group where most units land in a sellable bin (no reason) but a damaged
   *  few land in QUARANTINE (reason='damaged'). Defaults to the group's
   *  reasonCode when omitted. */
  reasonCode?: ReasonCode | null;
}

export interface PostMovementGroupInput {
  legs: MovementLeg[];
  movementType: MovementType;
  /** Default reason for every leg — see MovementLeg.reasonCode to override
   *  per leg. */
  reasonCode?: ReasonCode | null;
  /** Polymorphic reference shared by the whole group (a receipt group all
   *  references the same PO, a dispatch group the same order, etc). */
  ref?: { kind: RefKind; id: number } | null;
  /** D17 — every movement is named against a person, never anonymous. */
  operatorUserId: number;
  /** Stable across replays (e.g. a webhook delivery id). A second call with
   *  the SAME key is a no-op that returns the first call's group — see
   *  PostMovementGroupResult.alreadyProcessed. */
  idempotencyKey?: string | null;
  note?: string | null;
}

export interface PostMovementGroupResult {
  groupId: string;
  /** true when idempotencyKey matched an already-posted group — no new rows
   *  were written and stock was NOT touched again. */
  alreadyProcessed: boolean;
  movementIds: number[];
  affectedItemIds: number[];
}

/** Thrown when a leg's guarded stock upsert affects zero rows (D2/D16) — the
 *  caller's `db.transaction()` rolls back the WHOLE group on this throw
 *  (standard drizzle/Postgres behaviour, same reliance every other
 *  transaction-wrapped flow in this repo already has — e.g.
 *  finalizeShopOrderPaid). Never caught and swallowed inside this module. */
export class InsufficientStockError extends Error {
  constructor(
    public readonly locationCode: string,
    public readonly itemId: number,
  ) {
    super(`Insufficient stock at ${locationCode}`);
    this.name = "InsufficientStockError";
  }
}

/** The seam a fake test double implements directly (no drizzle involved) —
 *  see the file-header comment for why this is bespoke rather than a
 *  `Pick<typeof realDb, ...>` slice. */
export interface WarehouseDb {
  findMovementGroupByIdempotencyKey(key: string): Promise<{ groupId: string } | undefined>;
  insertMovementLegs(rows: NewMovementRow[]): Promise<{ id: number }[]>;
  upsertStockLeg(leg: {
    itemId: number;
    locationId: number;
    delta: number;
    allowNegative: boolean;
  }): Promise<{ onHand: number } | null>;
}

export interface NewMovementRow {
  groupId: string;
  itemId: number;
  instanceId: number | null;
  locationId: number;
  delta: string; // numeric column — Drizzle maps numeric to string (AGENTS.md)
  movementType: MovementType;
  reasonCode: ReasonCode | null;
  refKind: RefKind | null;
  refId: number | null;
  operatorUserId: number;
  note: string | null;
  idempotencyKey: string | null;
}

// ── Real adapter (never unit-tested directly — needs a live Postgres) ───────

/**
 * Wraps an open drizzle transaction (or the top-level db) so production code
 * always exercises the ACTUAL drizzle insert/select/execute API, type-checked
 * against shared/schema.ts. Tests never call this — they inject a plain
 * object literal satisfying WarehouseDb instead
 * (script/test-warehouse-engine.ts).
 */
export function warehouseDbFromTx(tx: Pick<typeof realDb, "insert" | "select" | "execute">): WarehouseDb {
  return {
    async findMovementGroupByIdempotencyKey(key) {
      const rows = await tx
        .select({ groupId: whMovements.groupId })
        .from(whMovements)
        .where(eq(whMovements.idempotencyKey, key))
        .limit(1);
      return rows[0];
    },
    async insertMovementLegs(rows) {
      return tx.insert(whMovements).values(rows).returning({ id: whMovements.id });
    },
    async upsertStockLeg(leg) {
      // D2/D16 — two-statement atomic guard (AGENTS.md's documented
      // algorithm), both inside the caller's already-open transaction:
      //   1. Seed a zero row for this (item,location) if it has never been
      //      touched before — a harmless no-op via ON CONFLICT DO NOTHING
      //      when the row already exists.
      //   2. Run a guarded UPDATE — WHERE on_hand + delta >= 0 — and take
      //      whatever it returns.
      // A single INSERT ... ON CONFLICT ... DO UPDATE ... WHERE statement is
      // NOT sufficient on its own: Postgres only evaluates that WHERE clause
      // on the conflict/UPDATE path, so a genuinely first-ever leg for
      // (item,location) would insert unconditionally and could go negative
      // on its very first movement. Seeding the zero row first forces every
      // leg — first-ever or not — through the same guarded UPDATE. Guard
      // skipped entirely (unconditional TRUE) when the item allows negative
      // stock (D16).
      await tx.execute(sql`
        INSERT INTO wh_stock (item_id, location_id, on_hand, updated_at)
        VALUES (${leg.itemId}, ${leg.locationId}, 0, now())
        ON CONFLICT (item_id, location_id) DO NOTHING
      `);
      const result = await tx.execute(sql`
        UPDATE wh_stock
          SET on_hand = on_hand + ${leg.delta}, updated_at = now()
          WHERE item_id = ${leg.itemId} AND location_id = ${leg.locationId}
            AND ${leg.allowNegative ? sql`true` : sql`on_hand + ${leg.delta} >= 0`}
        RETURNING on_hand
      `);
      const rows = result.rows as Array<{ on_hand: string }>;
      return rows[0] ? { onHand: Number(rows[0].on_hand) } : null;
    },
  };
}

// ── Validation (shared/warehouse.ts — no DB CHECKs on open value sets) ──────

function assertValidGroup(input: PostMovementGroupInput): void {
  if (!isMovementType(input.movementType)) {
    throw new Error(`postMovementGroup: unknown movement type "${input.movementType}"`);
  }
  if (input.reasonCode != null && !isReasonCode(input.reasonCode)) {
    throw new Error(`postMovementGroup: unknown reason code "${input.reasonCode}"`);
  }
  if (input.ref != null && !isRefKind(input.ref.kind)) {
    throw new Error(`postMovementGroup: unknown ref kind "${input.ref.kind}"`);
  }
  if (!input.operatorUserId) {
    throw new Error("postMovementGroup: operatorUserId is required (D17 — every movement is named)");
  }
  if (!input.legs || input.legs.length === 0) {
    throw new Error("postMovementGroup: at least one leg is required");
  }
  for (const leg of input.legs) {
    if (leg.delta === 0) {
      throw new Error(
        `postMovementGroup: leg delta must be non-zero (item ${leg.itemId} at ${leg.locationCode})`,
      );
    }
    if (leg.reasonCode != null && !isReasonCode(leg.reasonCode)) {
      throw new Error(`postMovementGroup: unknown leg reason code "${leg.reasonCode}"`);
    }
    // D19 — an instance IS one physical object. A leg claiming to move 3 of a
    // specific heat press is nonsense, and would silently corrupt wh_stock
    // (whose on_hand for an asset item is a count of instances).
    if (leg.instanceId != null && Math.abs(leg.delta) !== 1) {
      throw new Error(
        `postMovementGroup: an instance leg must move exactly one unit (instance ${leg.instanceId} got delta ${leg.delta})`,
      );
    }
  }
  if (input.movementType === "transfer" && !legsSumToZero(input.legs.map((l) => l.delta))) {
    throw new Error("postMovementGroup: transfer legs must sum to zero");
  }
}

// ── The engine ────────────────────────────────────────────────────────────────

/**
 * Post one movement group inside an ALREADY-OPEN WarehouseDb. Composable —
 * callers that need more than one group atomically (e.g. dispatch = consume
 * a reservation + post the dispatch movement, T8) call this twice against
 * the same underlying transaction. Most routes should call
 * `runMovementGroup` instead, which opens its own transaction and fires the
 * post-commit channel-sync hooks (§4.3 / T12).
 *
 * Steps (SPEC §4.2):
 *  1. Validate the taxonomy (shared/warehouse.ts — no DB CHECKs).
 *  2. Idempotency short-circuit: an existing row with this idempotencyKey
 *     means this exact call already happened — return its prior groupId,
 *     touching NOTHING else (not stock, not a new ledger row).
 *  3. Insert one ledger row per leg, all sharing one fresh groupId.
 *  4. For each leg, an atomic guarded upsert on wh_stock. Zero rows updated
 *     (guard failed) throws InsufficientStockError, which — because this
 *     always runs inside a real db.transaction() at the caller — rolls back
 *     the WHOLE group, not just the failing leg (an oversold transfer must
 *     never leave stock removed from the source with nothing arriving at the
 *     destination).
 */
export async function postMovementGroup(
  tx: WarehouseDb,
  input: PostMovementGroupInput,
): Promise<PostMovementGroupResult> {
  assertValidGroup(input);

  if (input.idempotencyKey) {
    const prior = await tx.findMovementGroupByIdempotencyKey(input.idempotencyKey);
    if (prior) {
      return { groupId: prior.groupId, alreadyProcessed: true, movementIds: [], affectedItemIds: [] };
    }
  }

  const groupId = randomUUID();
  const rows: NewMovementRow[] = input.legs.map((leg, i) => ({
    groupId,
    itemId: leg.itemId,
    instanceId: leg.instanceId ?? null,
    locationId: leg.locationId,
    delta: String(leg.delta),
    movementType: input.movementType,
    reasonCode: leg.reasonCode ?? input.reasonCode ?? null,
    refKind: input.ref?.kind ?? null,
    refId: input.ref?.id ?? null,
    operatorUserId: input.operatorUserId,
    note: input.note ?? null,
    // Only the FIRST row carries the idempotency key — the column is unique
    // across the whole table, so every OTHER leg of the same group must be
    // null (a partial unique index tolerates any number of nulls).
    idempotencyKey: i === 0 ? (input.idempotencyKey ?? null) : null,
  }));

  const inserted = await tx.insertMovementLegs(rows);

  for (const leg of input.legs) {
    const result = await tx.upsertStockLeg({
      itemId: leg.itemId,
      locationId: leg.locationId,
      delta: leg.delta,
      allowNegative: leg.allowNegative ?? false,
    });
    if (!result) {
      throw new InsufficientStockError(leg.locationCode, leg.itemId);
    }
  }

  return {
    groupId,
    alreadyProcessed: false,
    movementIds: inserted.map((r) => r.id),
    affectedItemIds: Array.from(new Set(input.legs.map((l) => l.itemId))),
  };
}

// ── Post-commit channel-sync hooks (§4.3 / T12 registers into this) ─────────

type MovementCommittedHook = (affectedItemIds: number[]) => void;
const movementHooks: MovementCommittedHook[] = [];

/** T12's warehouse-sync.ts calls this once at startup to register its
 *  debounced Shopify/native push. Kept generic here so this engine module
 *  never imports the sync module (no circular dependency). */
export function onMovementCommitted(hook: MovementCommittedHook): void {
  movementHooks.push(hook);
}

/**
 * Exported (unlike the rest of this section) because T10's loan check-out
 * route needs to open its OWN transaction (it inserts the wh_loans/
 * wh_loan_lines parent rows AND posts the outbound movement atomically — an
 * insufficient-stock failure must roll back the loan record too, not leave a
 * dangling "checked out" row with no movement behind it — see
 * server/warehouse-routes.ts's loan check-out handler), so it can't go
 * through runMovementGroup's self-contained transaction. It calls
 * postMovementGroup + this function directly instead, mirroring exactly what
 * runMovementGroup does internally for every other caller.
 */
export function notifyMovementCommitted(itemIds: number[]): void {
  if (itemIds.length === 0) return;
  for (const hook of movementHooks) {
    try {
      hook(itemIds);
    } catch (e) {
      console.error("[Warehouse] movement-committed hook failed:", e);
    }
  }
}

/**
 * Convenience wrapper most routes call — opens its own transaction, runs
 * postMovementGroup inside it, and (only for a genuinely NEW group, never a
 * replay) fires the post-commit channel-sync hooks. Lazily imports the real
 * db so this module stays loadable with no DATABASE_URL (tests never call
 * this function — they call postMovementGroup directly with a fake).
 */
export async function runMovementGroup(input: PostMovementGroupInput): Promise<PostMovementGroupResult> {
  const { db } = await import("./db");
  const result = await db.transaction(async (tx) => postMovementGroup(warehouseDbFromTx(tx), input));
  if (!result.alreadyProcessed) notifyMovementCommitted(result.affectedItemIds);
  return result;
}

// ── Reservations (D2/D3) ─────────────────────────────────────────────────────
// Hard reservations for every paid-but-unfulfilled order (native + Shopify) —
// physical truth stays true: the shirt is on the shelf until it's picked.
// `wh_reservations` (shared/schema.ts) is ITEM-level, not (item, location) —
// the warehouse promises a QUANTITY of an item out of whichever sellable
// bins currently hold it, never a specific bin. `available(item)` is DERIVED
// (D2): Σ on_hand across sellable bins − Σ qty of its active reservations —
// computed by ReservationDb.getAvailableForItem, never a stored column
// anywhere (mirrors wh_stock.on_hand's own derived-`available` doctrine one
// level up the stack).
//
// Three transitions, matching RESERVATION_STATUSES exactly:
//   reserveStock         active created (or found — idempotent per ref+item;
//                        D3's partial-unique index is the DB-level half of
//                        this, this is the app-level half).
//   releaseReservation   active -> released (order cancelled/refunded — T12's
//                        webhook path).
//   consumeReservation   active -> consumed, AND posts the movement that
//                        actually removes the physical stock (dispatch scan,
//                        T8) — after consume, on_hand and the
//                        active-reservation sum both drop by the same qty,
//                        so `available` doesn't move (it was already
//                        "promised", now it's actually gone).
//
// Same testability seam as WarehouseDb/ReconcileDb (see this file's header
// comment) — getAvailableForItem needs row-locking across two tables to
// serialize concurrent reserve() calls, which isn't meaningfully fakeable via
// drizzle's query builder, so ReservationDb is bespoke: a plain in-memory
// fake in script/test-warehouse-engine.ts, and `reservationDbFromTx` (real
// drizzle, never unit-tested directly — needs a live Postgres) in production.

export interface ReservationRow {
  id: number;
  itemId: number;
  qty: number;
  refKind: RefKind;
  refId: number;
  status: ReservationStatus;
}

/** Thrown when reserveStock would take `available` negative — the item-level
 *  sibling of InsufficientStockError (which is location-level). */
export class InsufficientAvailableError extends Error {
  constructor(
    public readonly itemId: number,
    public readonly available: number,
    public readonly requestedQty: number,
  ) {
    super(`Insufficient available stock for item ${itemId}: requested ${requestedQty}, only ${available} available`);
    this.name = "InsufficientAvailableError";
  }
}

export interface ReservationDb {
  /** Σ on_hand across sellable bins for this item, minus Σ qty of its active
   *  reservations (D2/D3) — the number reserveStock must not oversell past.
   *  The real adapter takes row locks on every wh_stock/wh_reservations row
   *  it reads so two concurrent reserveStock calls against the same item
   *  can't both read the same number and both succeed past it (the SECOND
   *  call blocks until the first commits, then re-reads the now-lower
   *  number) — the multi-row-aggregate equivalent of postMovementGroup's
   *  single-row `UPDATE ... WHERE` guard. */
  getAvailableForItem(itemId: number): Promise<number>;
  /** The active reservation already on file for this (ref, item), if any —
   *  read back for reserveStock's idempotent no-op path (a second call for
   *  the same ref+item is a replay, not a double-book; mirrors the DB's own
   *  partial-unique index invariant). */
  findActiveReservationByRef(ref: { kind: RefKind; id: number }, itemId: number): Promise<{ id: number } | undefined>;
  /** Every active reservation for a ref, across all its items — releasing a
   *  whole order (cancel/refund) touches every line, not just one item. */
  findActiveReservationsByRef(ref: { kind: RefKind; id: number }): Promise<ReservationRow[]>;
  getReservationById(id: number): Promise<ReservationRow | undefined>;
  insertReservation(row: { itemId: number; qty: string; refKind: RefKind; refId: number }): Promise<{ id: number }>;
  markReservationStatus(id: number, status: ReservationStatus): Promise<void>;
}

/** Real adapter — never unit-tested directly (needs a live Postgres for the
 *  row-locking to mean anything). Same status as warehouseDbFromTx /
 *  reconcileDbFromRealDb. */
export function reservationDbFromTx(
  tx: Pick<typeof realDb, "insert" | "select" | "update" | "execute">,
): ReservationDb {
  return {
    async getAvailableForItem(itemId) {
      // Two locked SELECTs, not one aggregate — Postgres doesn't allow
      // FOR UPDATE on a query with GROUP BY/aggregate functions, and locking
      // is the whole point (it's what serializes concurrent callers).
      const stockRows = await tx.execute(sql`
        SELECT s.on_hand
        FROM wh_stock s
        JOIN wh_locations l ON l.id = s.location_id
        WHERE s.item_id = ${itemId}
          AND l.kind <> 'virtual'
          AND UPPER(l.code) <> ${QUARANTINE_ZONE}
        FOR UPDATE OF s
      `);
      const reservedRows = await tx.execute(sql`
        SELECT qty FROM wh_reservations
        WHERE item_id = ${itemId} AND status = 'active'
        FOR UPDATE
      `);
      const onHandSum = (stockRows.rows as Array<{ on_hand: string }>).reduce((sum, r) => sum + Number(r.on_hand), 0);
      const reservedSum = (reservedRows.rows as Array<{ qty: string }>).reduce((sum, r) => sum + Number(r.qty), 0);
      return onHandSum - reservedSum;
    },
    async findActiveReservationByRef(ref, itemId) {
      const rows = await tx
        .select({ id: whReservations.id })
        .from(whReservations)
        .where(
          and(
            eq(whReservations.refKind, ref.kind),
            eq(whReservations.refId, ref.id),
            eq(whReservations.itemId, itemId),
            eq(whReservations.status, "active"),
          ),
        )
        .limit(1);
      return rows[0];
    },
    async findActiveReservationsByRef(ref) {
      const rows = await tx
        .select()
        .from(whReservations)
        .where(
          and(
            eq(whReservations.refKind, ref.kind),
            eq(whReservations.refId, ref.id),
            eq(whReservations.status, "active"),
          ),
        );
      return rows.map(toReservationRow);
    },
    async getReservationById(id) {
      const rows = await tx.select().from(whReservations).where(eq(whReservations.id, id)).limit(1);
      return rows[0] ? toReservationRow(rows[0]) : undefined;
    },
    async insertReservation(row) {
      const [created] = await tx.insert(whReservations).values(row).returning({ id: whReservations.id });
      return created;
    },
    async markReservationStatus(id, status) {
      await tx.update(whReservations).set({ status, updatedAt: new Date() }).where(eq(whReservations.id, id));
    },
  };
}

function toReservationRow(row: typeof whReservations.$inferSelect): ReservationRow {
  return {
    id: row.id,
    itemId: row.itemId,
    qty: Number(row.qty),
    refKind: row.refKind as RefKind,
    refId: row.refId,
    status: row.status as ReservationStatus,
  };
}

/** Combines both seams behind one object for consumeReservation's real path
 *  (a movement post + a reservation-status update, same transaction). An
 *  explicit return type keeps the spread's assignability check in ONE place
 *  rather than at every call site. */
function combinedDbFromTx(
  tx: Pick<typeof realDb, "insert" | "select" | "update" | "execute">,
): WarehouseDb & ReservationDb {
  return { ...warehouseDbFromTx(tx), ...reservationDbFromTx(tx) };
}

// ── reserveStock ──────────────────────────────────────────────────────────────

export interface ReserveInput {
  itemId: number;
  /** Must be > 0 — a reservation for zero or negative units makes no sense
   *  (unlike a movement leg's signed delta, a reservation qty is always a
   *  positive promise). */
  qty: number;
  ref: { kind: RefKind; id: number };
}

export interface ReserveResult {
  reservationId: number;
  /** true when an active reservation already existed for this (ref, item) —
   *  idempotent no-op: no new row, availability was NOT re-checked or
   *  touched (mirrors postMovementGroup's own idempotency semantics). */
  alreadyReserved: boolean;
}

export async function reserveStock(db: ReservationDb, input: ReserveInput): Promise<ReserveResult> {
  if (!isRefKind(input.ref.kind)) {
    throw new Error(`reserveStock: unknown ref kind "${input.ref.kind}"`);
  }
  if (!(input.qty > 0)) {
    throw new Error("reserveStock: qty must be greater than zero");
  }
  const existing = await db.findActiveReservationByRef(input.ref, input.itemId);
  if (existing) {
    return { reservationId: existing.id, alreadyReserved: true };
  }
  const available = await db.getAvailableForItem(input.itemId);
  if (available < input.qty) {
    throw new InsufficientAvailableError(input.itemId, available, input.qty);
  }
  const created = await db.insertReservation({
    itemId: input.itemId,
    qty: String(input.qty),
    refKind: input.ref.kind,
    refId: input.ref.id,
  });
  return { reservationId: created.id, alreadyReserved: false };
}

// ── releaseReservation ───────────────────────────────────────────────────────

export interface ReleaseResult {
  /** false when the reservation was already released — idempotent no-op. */
  released: boolean;
  itemId: number;
}

export async function releaseReservation(db: ReservationDb, reservationId: number): Promise<ReleaseResult> {
  const reservation = await db.getReservationById(reservationId);
  if (!reservation) {
    throw new Error(`releaseReservation: reservation ${reservationId} not found`);
  }
  if (reservation.status === "released") {
    return { released: false, itemId: reservation.itemId }; // idempotent no-op
  }
  if (reservation.status === "consumed") {
    throw new Error(
      `releaseReservation: reservation ${reservationId} was already consumed — the stock has left the building, it can't be released`,
    );
  }
  await db.markReservationStatus(reservationId, "released");
  return { released: true, itemId: reservation.itemId };
}

/** Releases every active reservation for a ref (e.g. every line of a
 *  cancelled/refunded order) — T12's webhook path calls this rather than
 *  looping releaseReservation() per item itself. */
export async function releaseReservationsForRef(
  db: ReservationDb,
  ref: { kind: RefKind; id: number },
): Promise<{ releasedCount: number; itemIds: number[] }> {
  const active = await db.findActiveReservationsByRef(ref);
  for (const r of active) {
    await db.markReservationStatus(r.id, "released");
  }
  return { releasedCount: active.length, itemIds: active.map((r) => r.itemId) };
}

// ── consumeReservation ────────────────────────────────────────────────────────

export interface ConsumeReservationInput {
  reservationId: number;
  /** The sellable bin actually being picked from (caller/scan already
   *  resolved this — the engine never runs its own SELECT). */
  locationId: number;
  locationCode: string;
  movementType: MovementType;
  reasonCode?: ReasonCode | null;
  operatorUserId: number;
  idempotencyKey?: string | null;
  note?: string | null;
  /** Overrides the movement's ref — defaults to the reservation's own ref
   *  (the order it was reserved for). */
  ref?: { kind: RefKind; id: number } | null;
}

export interface ConsumeReservationResult {
  reservation: ReservationRow;
  movement: PostMovementGroupResult;
}

/**
 * Fulfils a reservation: posts the movement that removes the reservation's
 * FULL qty from the named sellable bin, then marks the reservation
 * 'consumed' — but only when the movement was genuinely new. A replayed
 * idempotencyKey short-circuits inside postMovementGroup (alreadyProcessed),
 * and this function then does NOTHING further (reservation untouched),
 * exactly like postMovementGroup's own "touches nothing else" replay
 * contract one level up. (v1 always consumes the reservation's full qty —
 * there's no partial-ship state in RESERVATION_STATUSES; a partial dispatch
 * is a T8-level concern, out of scope here.)
 */
export async function consumeReservation(
  db: WarehouseDb & ReservationDb,
  input: ConsumeReservationInput,
): Promise<ConsumeReservationResult> {
  const reservation = await db.getReservationById(input.reservationId);
  if (!reservation) {
    throw new Error(`consumeReservation: reservation ${input.reservationId} not found`);
  }
  if (reservation.status === "released") {
    throw new Error(`consumeReservation: reservation ${input.reservationId} was released, not active`);
  }

  const movement = await postMovementGroup(db, {
    legs: [
      {
        itemId: reservation.itemId,
        locationId: input.locationId,
        locationCode: input.locationCode,
        delta: -reservation.qty,
      },
    ],
    movementType: input.movementType,
    reasonCode: input.reasonCode ?? null,
    ref: input.ref ?? { kind: reservation.refKind, id: reservation.refId },
    operatorUserId: input.operatorUserId,
    idempotencyKey: input.idempotencyKey ?? null,
    note: input.note ?? null,
  });

  if (!movement.alreadyProcessed) {
    // Reached only for a genuinely NEW movement. reservation.status here can
    // only legitimately be 'active' — a 'consumed' reservation paired with a
    // brand-new (non-replay) movement means some caller reused a stale
    // reservation id with a fresh idempotencyKey, which is a bug, not
    // something to paper over by re-marking it consumed.
    if (reservation.status !== "active") {
      throw new Error(
        `consumeReservation: reservation ${input.reservationId} is not active (status=${reservation.status}) and this was not an idempotent replay`,
      );
    }
    await db.markReservationStatus(input.reservationId, "consumed");
  }

  return { reservation, movement };
}

// ── Route-facing wrappers (open their own transaction + fire the sync hook) ──
// Same shape as runMovementGroup above: lazily import the real db (this
// module must stay importable with no DATABASE_URL), open one transaction,
// run the already-tested pure-logic function against the real adapter, and
// only fire the channel-sync hook for a genuine change (never a replay / a
// no-op release).

export async function runReserveStock(input: ReserveInput): Promise<ReserveResult> {
  const { db } = await import("./db");
  const result = await db.transaction(async (tx) => reserveStock(reservationDbFromTx(tx), input));
  if (!result.alreadyReserved) notifyMovementCommitted([input.itemId]);
  return result;
}

export async function runReleaseReservation(reservationId: number): Promise<ReleaseResult> {
  const { db } = await import("./db");
  const result = await db.transaction(async (tx) => releaseReservation(reservationDbFromTx(tx), reservationId));
  if (result.released) notifyMovementCommitted([result.itemId]);
  return result;
}

export async function runReleaseReservationsForRef(
  ref: { kind: RefKind; id: number },
): Promise<{ releasedCount: number; itemIds: number[] }> {
  const { db } = await import("./db");
  const result = await db.transaction(async (tx) => releaseReservationsForRef(reservationDbFromTx(tx), ref));
  if (result.itemIds.length) notifyMovementCommitted(result.itemIds);
  return result;
}

export async function runConsumeReservation(input: ConsumeReservationInput): Promise<ConsumeReservationResult> {
  const { db } = await import("./db");
  const result = await db.transaction(async (tx) => consumeReservation(combinedDbFromTx(tx), input));
  if (!result.movement.alreadyProcessed) notifyMovementCommitted(result.movement.affectedItemIds);
  return result;
}

// ── Nightly reconcile (D1) ───────────────────────────────────────────────────
// Asserts wh_stock.on_hand == Σ wh_movements.delta per (item, location);
// repairs any drift from the ledger (the ledger is truth) and reports every
// repair — a repair happening at all means some code path bypassed the
// engine, so every entry here is worth a human's attention even though the
// number itself gets fixed automatically.

export interface ReconcileDrift {
  itemId: number;
  locationId: number;
  cachedOnHand: number;
  ledgerSum: number;
}

export interface ReconcileResult {
  checked: number;
  drifts: ReconcileDrift[];
}

/** Same bespoke-fake-seam reasoning as WarehouseDb — a full outer join +
 *  group-by aggregate isn't meaningfully fakeable via drizzle's query
 *  builder, so the fake (script/test-warehouse-engine.ts) implements this
 *  directly against an in-memory ledger + stock cache. */
export interface ReconcileDb {
  /** Every (item,location) pair that has either a wh_stock row or at least
   *  one wh_movements row, with the cache's current on_hand and the ledger's
   *  own SUM(delta) for that pair — reconcile's whole job is comparing these
   *  two numbers. */
  listStockVsLedger(): Promise<Array<{ itemId: number; locationId: number; cachedOnHand: number; ledgerSum: number }>>;
  /** Overwrites wh_stock.on_hand with the ledger-derived correct value (the
   *  ledger is truth, D1) — an upsert so a cache row that's missing entirely
   *  (drift = "no cache row at all") is also repaired. */
  repairStock(itemId: number, locationId: number, correctOnHand: number): Promise<void>;
}

/** Real adapter — same "never unit-tested directly, needs a live Postgres"
 *  status as warehouseDbFromTx. */
export function reconcileDbFromRealDb(database: Pick<typeof realDb, "execute">): ReconcileDb {
  return {
    async listStockVsLedger() {
      const result = await database.execute(sql`
        SELECT
          COALESCE(s.item_id, m.item_id)         AS item_id,
          COALESCE(s.location_id, m.location_id) AS location_id,
          COALESCE(s.on_hand, 0)                 AS cached_on_hand,
          COALESCE(SUM(m.delta), 0)              AS ledger_sum
        FROM wh_stock s
        FULL OUTER JOIN wh_movements m
          ON m.item_id = s.item_id AND m.location_id = s.location_id
        GROUP BY COALESCE(s.item_id, m.item_id), COALESCE(s.location_id, m.location_id), s.on_hand
      `);
      const rows = result.rows as Array<{
        item_id: number | string;
        location_id: number | string;
        cached_on_hand: string;
        ledger_sum: string;
      }>;
      return rows.map((r) => ({
        itemId: Number(r.item_id),
        locationId: Number(r.location_id),
        cachedOnHand: Number(r.cached_on_hand),
        ledgerSum: Number(r.ledger_sum),
      }));
    },
    async repairStock(itemId, locationId, correctOnHand) {
      await database.execute(sql`
        INSERT INTO wh_stock (item_id, location_id, on_hand, updated_at)
        VALUES (${itemId}, ${locationId}, ${correctOnHand}, now())
        ON CONFLICT (item_id, location_id) DO UPDATE
          SET on_hand = ${correctOnHand}, updated_at = now()
      `);
    },
  };
}

/**
 * Nightly reconcile job. Pure logic against a ReconcileDb — unit tested with
 * a fake (script/test-warehouse-engine.ts). With no `database` argument, it
 * lazily imports the real db (never at module load — see file header).
 */
export async function reconcileStock(database?: ReconcileDb): Promise<ReconcileResult> {
  const reconcileDb = database ?? reconcileDbFromRealDb((await import("./db")).db);
  const rows = await reconcileDb.listStockVsLedger();
  const drifts: ReconcileDrift[] = [];
  for (const row of rows) {
    if (row.cachedOnHand !== row.ledgerSum) {
      await reconcileDb.repairStock(row.itemId, row.locationId, row.ledgerSum);
      drifts.push({
        itemId: row.itemId,
        locationId: row.locationId,
        cachedOnHand: row.cachedOnHand,
        ledgerSum: row.ledgerSum,
      });
      console.error(
        `[Warehouse] reconcile: repaired drift at item ${row.itemId} / location ${row.locationId} ` +
          `(cache was ${row.cachedOnHand}, ledger says ${row.ledgerSum})`,
      );
    }
  }
  return { checked: rows.length, drifts };
}

// ── Scan resolution (T7) ─────────────────────────────────────────────────────
// resolveScanCode is the ONE place a scanned/typed code becomes an item, a
// location, or "unknown" (§4.4). Three simple, UNLOCKED lookups — unlike
// ReservationDb's getAvailableForItem, nothing here needs to serialize
// concurrent callers, so a plain read has no reason to take a row lock —
// wrapped in a bespoke ScanLookupDb seam purely so script/test-warehouse-
// scan.ts can fake it with plain in-memory objects instead of needing a live
// Postgres (same spirit as WarehouseDb/ReservationDb/ReconcileDb above, for
// a much simpler reason: keeping the DB entirely out of a DB-free test run).

export interface ScanResolvedItem {
  id: number;
  sku: string;
  name: string;
  isLoanable: boolean;
}

export interface ScanResolvedLocation {
  id: number;
  code: string;
  /** D28 — the human name, when the location has one. Display only; the scan
   *  still resolves on `code`, which is what the label encodes. */
  name: string | null;
  kind: LocationKind;
}

/** D19 — ONE physical asset, identified by the label stuck on it. Carries
 *  enough for the scan station to show what it is and where it currently
 *  lives without a second round trip. */
export interface ScanResolvedInstance {
  id: number;
  assetTag: string | null;
  serialNumber: string | null;
  condition: InstanceCondition;
  itemId: number;
  itemSku: string;
  itemName: string;
  isLoanable: boolean;
  locationId: number;
  locationCode: string;
}

export type ScanResolution =
  | {
      kind: "item";
      item: ScanResolvedItem;
      /** 'sku' = the code IS the item's own SKU (packQty always 1 — our own
       *  scheme has no multiplier). 'alias' = a barcode alias matched
       *  instead (packQty comes off that alias row — see
       *  shared/warehouse.ts's scanQuantityToUnits for how it's applied). */
      matchedVia: "sku" | "alias";
      aliasCode?: string;
      packQty: number;
      actions: MovementType[];
    }
  | { kind: "location"; location: ScanResolvedLocation; actions: MovementType[] }
  | { kind: "instance"; instance: ScanResolvedInstance; actions: MovementType[] }
  | { kind: "unknown"; rawCode: string };

export interface ScanLookupDb {
  findItemBySku(sku: string): Promise<ScanResolvedItem | undefined>;
  findAliasByCode(code: string): Promise<{ item: ScanResolvedItem; packQty: number; aliasCode: string } | undefined>;
  findLocationByCode(code: string): Promise<ScanResolvedLocation | undefined>;
  findInstanceByAssetTag(tag: string): Promise<ScanResolvedInstance | undefined>;
}

/**
 * Resolution order (D5/D7/D8), first match wins:
 *  1. `LOC:`-prefixed → a location, full stop. A miss here is "unknown" —
 *     never falls through to an item/alias lookup (see
 *     shared/warehouse.ts's stripLocationPrefix comment for why).
 *  2. Our own SKU scheme (D7) — we own this format, so it's checked before
 *     the alias table.
 *  3. A barcode alias (manufacturer EAN etc., D5) — looked up verbatim.
 *  4. A bare (unprefixed) location code — an operator typing a bin code by
 *     hand at a desk rather than scanning its printed LOC:-prefixed label.
 *  5. Nothing matched → unknown. `rawCode` is preserved exactly as given
 *     (untrimmed) for a future "did you mean" UI — only the code actually
 *     used for lookups is trimmed/normalised.
 */
export async function resolveScanCode(db: ScanLookupDb, rawCode: string): Promise<ScanResolution> {
  const code = rawCode.trim();
  if (!code) return { kind: "unknown", rawCode };

  const stripped = stripLocationPrefix(code);
  if (stripped.isLocationCode) {
    const location = await db.findLocationByCode(stripped.code);
    if (!location) return { kind: "unknown", rawCode };
    return { kind: "location", location, actions: scanActionsForLocation(location) };
  }

  // D19 — an `AST:`-prefixed code is ONE physical asset and nothing else. Same
  // hard stop as `LOC:`: a miss is "unknown" rather than falling through to a
  // SKU lookup that might match something unrelated and move the wrong thing.
  const asset = stripInstancePrefix(code);
  if (asset.isInstanceCode) {
    const instance = await db.findInstanceByAssetTag(asset.code);
    if (!instance) return { kind: "unknown", rawCode };
    return { kind: "instance", instance, actions: scanActionsForInstance(instance) };
  }

  const item = await db.findItemBySku(normaliseSku(code));
  if (item) {
    return { kind: "item", item, matchedVia: "sku", packQty: 1, actions: scanActionsForItem(item) };
  }

  const alias = await db.findAliasByCode(normaliseAliasCode(code));
  if (alias) {
    return {
      kind: "item",
      item: alias.item,
      matchedVia: "alias",
      aliasCode: alias.aliasCode,
      packQty: alias.packQty,
      actions: scanActionsForItem(alias.item),
    };
  }

  // A bare (unprefixed) asset tag — someone reading a worn label and typing it
  // in by hand, or a supplier's own asset sticker registered as the tag.
  // After the SKU/alias lookups so our own item scheme always wins a tie.
  const bareInstance = await db.findInstanceByAssetTag(normaliseAssetTag(code));
  if (bareInstance) {
    return { kind: "instance", instance: bareInstance, actions: scanActionsForInstance(bareInstance) };
  }

  const bareLocation = await db.findLocationByCode(normaliseLocationCode(code));
  if (bareLocation) {
    return { kind: "location", location: bareLocation, actions: scanActionsForLocation(bareLocation) };
  }

  return { kind: "unknown", rawCode };
}

/** Real adapter — plain unlocked reads, so unlike warehouseDbFromTx/
 *  reservationDbFromTx this never needs to be handed an open transaction;
 *  the top-level `db` works fine (never unit-tested directly all the same —
 *  see the file-header comment — this one just doesn't NEED a live Postgres
 *  to be trustworthy the way a guarded upsert or a row lock does, it's only
 *  kept out of the test run for consistency with the rest of this file). */
export function scanLookupDbFromDb(database: Pick<typeof realDb, "select">): ScanLookupDb {
  return {
    async findItemBySku(sku) {
      const rows = await database
        .select({ id: whItems.id, sku: whItems.sku, name: whItems.name, isLoanable: whItems.isLoanable })
        .from(whItems)
        .where(eq(whItems.sku, sku))
        .limit(1);
      return rows[0];
    },
    async findAliasByCode(code) {
      const rows = await database
        .select({
          aliasCode: whBarcodeAliases.code,
          packQty: whBarcodeAliases.packQty,
          itemId: whItems.id,
          itemSku: whItems.sku,
          itemName: whItems.name,
          itemIsLoanable: whItems.isLoanable,
        })
        .from(whBarcodeAliases)
        .innerJoin(whItems, eq(whBarcodeAliases.itemId, whItems.id))
        .where(eq(whBarcodeAliases.code, code))
        .limit(1);
      const row = rows[0];
      if (!row) return undefined;
      return {
        aliasCode: row.aliasCode,
        packQty: Number(row.packQty),
        item: { id: row.itemId, sku: row.itemSku, name: row.itemName, isLoanable: row.itemIsLoanable },
      };
    },
    async findLocationByCode(code) {
      const rows = await database
        .select({ id: whLocations.id, code: whLocations.code, name: whLocations.name, kind: whLocations.kind })
        .from(whLocations)
        .where(eq(whLocations.code, code))
        .limit(1);
      const row = rows[0];
      return row ? { id: row.id, code: row.code, name: row.name ?? null, kind: row.kind as LocationKind } : undefined;
    },
    async findInstanceByAssetTag(tag) {
      const rows = await database
        .select({
          id: whItemInstances.id,
          assetTag: whItemInstances.assetTag,
          serialNumber: whItemInstances.serialNumber,
          condition: whItemInstances.condition,
          itemId: whItems.id,
          itemSku: whItems.sku,
          itemName: whItems.name,
          isLoanable: whItems.isLoanable,
          locationId: whLocations.id,
          locationCode: whLocations.code,
        })
        .from(whItemInstances)
        .innerJoin(whItems, eq(whItemInstances.itemId, whItems.id))
        .innerJoin(whLocations, eq(whItemInstances.locationId, whLocations.id))
        .where(eq(whItemInstances.assetTag, tag))
        .limit(1);
      const row = rows[0];
      if (!row) return undefined;
      return { ...row, condition: row.condition as InstanceCondition };
    },
  };
}
