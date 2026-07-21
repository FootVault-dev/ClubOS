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
import { eq, sql } from "drizzle-orm";
import { whMovements, whStock } from "@shared/schema";
import type { db as realDb } from "./db";
import {
  isMovementType,
  isReasonCode,
  isRefKind,
  legsSumToZero,
  type MovementType,
  type ReasonCode,
  type RefKind,
} from "@shared/warehouse";

// ── Public shapes ────────────────────────────────────────────────────────────

export interface MovementLeg {
  itemId: number;
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
      // Single atomic statement (D2): INSERT ... ON CONFLICT (item,location)
      // DO UPDATE SET on_hand = on_hand + delta WHERE on_hand + delta >= 0
      // RETURNING. The WHERE guard applies only on the conflict/UPDATE path —
      // a genuinely first-ever insert for (item,location) always succeeds,
      // per SPEC §4.2's literal wording. Guard skipped entirely (unconditional
      // TRUE) when the item allows negative stock (D16).
      const result = await tx.execute(sql`
        INSERT INTO wh_stock (item_id, location_id, on_hand, updated_at)
        VALUES (${leg.itemId}, ${leg.locationId}, ${leg.delta}, now())
        ON CONFLICT (item_id, location_id) DO UPDATE
          SET on_hand = wh_stock.on_hand + EXCLUDED.on_hand, updated_at = now()
          WHERE ${leg.allowNegative ? sql`true` : sql`wh_stock.on_hand + EXCLUDED.on_hand >= 0`}
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

function notifyMovementCommitted(itemIds: number[]): void {
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
