// Warehouse v2 — asset instances and self-service custom fields (D18–D25).
//
// The half of the warehouse that answers "WHICH one is it" rather than "how
// many do we have": heat presses, laptops, desks, mowers — the things the club
// owns one-by-one. Built for Dima's "everything physical the club owns and
// moves" requirement, extending the live WMS rather than sitting beside it.
//
// The one load-bearing decision (D19): an instance's movements ride the SAME
// `wh_movements` ledger as bulk stock, with `instance_id` set and a delta of
// exactly ±1. So:
//   • wh_stock.on_hand for an asset item at a location IS the number of
//     instances standing there — every existing stock view, dashboard tile and
//     nightly reconcile keeps working with no change at all;
//   • the audit trail is one table, not two, which is the entire reason the
//     ledger is trustworthy in the first place.
// A second parallel movements table would have split it in half.
//
// Every function here writes the instance row and its ledger legs in ONE
// transaction. An instance whose location disagrees with its own ledger is the
// exact failure this module exists to prevent, so there is deliberately no
// code path that updates `wh_item_instances.location_id` on its own.
//
// Tested by script/test-warehouse-instances.ts.

import { and, eq, isNull, sql } from "drizzle-orm";
import type { db as realDb } from "./db";
import { whItemFields, whItemInstances, whLocations, whMovements } from "@shared/schema";
import { postMovementGroup, warehouseDbFromTx, notifyMovementCommitted, type MovementLeg } from "./warehouse";
import {
  SCRAP_ZONE,
  coerceFieldValue,
  isInstanceCondition,
  type FieldTemplateLike,
  type InstanceCondition,
  type LocationKind,
  type TypedFieldValue,
} from "@shared/warehouse";

// ── Errors ───────────────────────────────────────────────────────────────────

/** Anything the operator can fix by choosing differently — surfaced as a 400
 *  with the message shown verbatim, never a 500. */
export class InstanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstanceError";
  }
}

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface InstanceRow {
  id: number;
  itemId: number;
  assetTag: string | null;
  serialNumber: string | null;
  locationId: number;
  condition: InstanceCondition;
  purchaseDate: string | null;
  warrantyUntil: string | null;
  costCents: number | null;
  notes: string | null;
}

export interface MoveInstanceInput {
  instanceId: number;
  toLocationId: number;
  operatorUserId: number;
  /** Optional condition update recorded in the same breath as the move — a
   *  thing usually comes back from a job in a different state than it left. */
  condition?: InstanceCondition | null;
  note?: string | null;
  idempotencyKey?: string | null;
}

export interface DecommissionInstanceInput {
  instanceId: number;
  operatorUserId: number;
  note?: string | null;
  idempotencyKey?: string | null;
}

export interface PlaceInstanceInput {
  instanceId: number;
  locationId: number;
  operatorUserId: number;
  note?: string | null;
  idempotencyKey?: string | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

type Tx = Parameters<Parameters<typeof realDb.transaction>[0]>[0];

async function loadInstance(tx: Tx, instanceId: number): Promise<InstanceRow> {
  const rows = await tx.select().from(whItemInstances).where(eq(whItemInstances.id, instanceId)).limit(1);
  const row = rows[0];
  if (!row) throw new InstanceError("That asset no longer exists");
  return {
    id: row.id,
    itemId: row.itemId,
    assetTag: row.assetTag,
    serialNumber: row.serialNumber,
    locationId: row.locationId,
    condition: row.condition as InstanceCondition,
    purchaseDate: row.purchaseDate,
    warrantyUntil: row.warrantyUntil,
    costCents: row.costCents,
    notes: row.notes,
  };
}

async function loadLocation(tx: Tx, locationId: number): Promise<{ id: number; code: string; kind: LocationKind }> {
  const rows = await tx
    .select({ id: whLocations.id, code: whLocations.code, kind: whLocations.kind })
    .from(whLocations)
    .where(eq(whLocations.id, locationId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new InstanceError("That location does not exist");
  return { id: row.id, code: row.code, kind: row.kind as LocationKind };
}

/** An asset item never allows negative stock: you cannot have minus one heat
 *  press. Hard-coded rather than read from wh_items.allow_negative (D16),
 *  which exists for bulk materials whose paperwork lags behind the shelf. */
const ASSET_ALLOW_NEGATIVE = false;

// ── Placement: an instance arrives for the first time ────────────────────────

/**
 * Puts a newly-created instance somewhere for the first time — a single +1 leg
 * with no matching outbound, exactly like a PO receipt (goods come from
 * outside the system). Called by the create-instance route inside its own
 * transaction so the row and its first ledger line are born together.
 */
export async function placeInstanceTx(tx: Tx, input: PlaceInstanceInput): Promise<{ groupId: string }> {
  const instance = await loadInstance(tx, input.instanceId);
  const location = await loadLocation(tx, input.locationId);

  const legs: MovementLeg[] = [
    {
      itemId: instance.itemId,
      instanceId: instance.id,
      locationId: location.id,
      locationCode: location.code,
      delta: 1,
      allowNegative: ASSET_ALLOW_NEGATIVE,
    },
  ];

  const result = await postMovementGroup(warehouseDbFromTx(tx), {
    legs,
    movementType: "receipt",
    operatorUserId: input.operatorUserId,
    idempotencyKey: input.idempotencyKey ?? null,
    note: input.note ?? null,
  });

  return { groupId: result.groupId };
}

// ── Move: the everyday action ────────────────────────────────────────────────

/**
 * Moves one asset from wherever it is to somewhere else — a bin, a person, a
 * vehicle (D20). Two legs summing to zero, the same shape as an ordinary
 * stock transfer, so the ledger reads identically for both halves of the
 * warehouse.
 *
 * Refuses to move a decommissioned unit: a retired press must not quietly
 * reappear on the floor because someone scanned an old tag.
 */
export async function moveInstanceTx(tx: Tx, input: MoveInstanceInput): Promise<{ groupId: string; alreadyProcessed: boolean }> {
  const instance = await loadInstance(tx, input.instanceId);

  if (instance.condition === "decommissioned") {
    throw new InstanceError("That asset has been decommissioned — reinstate it before moving it");
  }
  if (input.condition != null && !isInstanceCondition(input.condition)) {
    throw new InstanceError("That is not a condition we record");
  }
  if (input.condition === "decommissioned") {
    // Retiring a thing is its own operation with its own ledger story (it
    // moves to SCRAP). Allowing it as a side effect of a move would leave the
    // asset sitting in a real bin while claiming to be retired.
    throw new InstanceError("Use decommission to retire an asset, not a move");
  }

  const from = await loadLocation(tx, instance.locationId);
  const to = await loadLocation(tx, input.toLocationId);

  if (from.id === to.id) {
    throw new InstanceError(`That asset is already at ${to.code}`);
  }
  if (to.kind === "virtual") {
    throw new InstanceError("Assets can't be moved into a virtual location — pick a bin, a person or a vehicle");
  }

  const legs: MovementLeg[] = [
    {
      itemId: instance.itemId,
      instanceId: instance.id,
      locationId: from.id,
      locationCode: from.code,
      delta: -1,
      allowNegative: ASSET_ALLOW_NEGATIVE,
    },
    {
      itemId: instance.itemId,
      instanceId: instance.id,
      locationId: to.id,
      locationCode: to.code,
      delta: 1,
      allowNegative: ASSET_ALLOW_NEGATIVE,
    },
  ];

  const result = await postMovementGroup(warehouseDbFromTx(tx), {
    legs,
    movementType: "transfer",
    operatorUserId: input.operatorUserId,
    idempotencyKey: input.idempotencyKey ?? null,
    note: input.note ?? null,
  });

  // A replay posted nothing, so the instance row must not be touched either —
  // otherwise a retried offline scan would rewrite state the ledger says
  // never happened a second time.
  if (!result.alreadyProcessed) {
    await tx
      .update(whItemInstances)
      .set({
        locationId: to.id,
        ...(input.condition ? { condition: input.condition } : {}),
        updatedAt: new Date(),
      })
      .where(eq(whItemInstances.id, instance.id));
  }

  return { groupId: result.groupId, alreadyProcessed: result.alreadyProcessed };
}

// ── Decommission: it leaves service, its history stays ───────────────────────

/**
 * Retires an asset. It moves to the SCRAP virtual location on a real ledger
 * row rather than simply ceasing to be counted — the same treatment a
 * written-off loan line already gets (D14/D15), and the reason the write-off
 * stays auditable years later.
 *
 * The row is never deleted. Retire, never delete.
 */
export async function decommissionInstanceTx(
  tx: Tx,
  input: DecommissionInstanceInput,
): Promise<{ groupId: string; alreadyProcessed: boolean }> {
  const instance = await loadInstance(tx, input.instanceId);
  if (instance.condition === "decommissioned") {
    throw new InstanceError("That asset is already decommissioned");
  }

  const from = await loadLocation(tx, instance.locationId);

  const scrapRows = await tx
    .select({ id: whLocations.id, code: whLocations.code })
    .from(whLocations)
    .where(eq(whLocations.code, SCRAP_ZONE))
    .limit(1);
  const scrap = scrapRows[0];
  if (!scrap) {
    throw new InstanceError("No SCRAP location is set up yet — create one before decommissioning anything");
  }

  const legs: MovementLeg[] = [
    {
      itemId: instance.itemId,
      instanceId: instance.id,
      locationId: from.id,
      locationCode: from.code,
      delta: -1,
      allowNegative: ASSET_ALLOW_NEGATIVE,
    },
    {
      itemId: instance.itemId,
      instanceId: instance.id,
      locationId: scrap.id,
      locationCode: scrap.code,
      delta: 1,
      allowNegative: ASSET_ALLOW_NEGATIVE,
    },
  ];

  const result = await postMovementGroup(warehouseDbFromTx(tx), {
    legs,
    movementType: "decommission",
    reasonCode: "write_off",
    operatorUserId: input.operatorUserId,
    idempotencyKey: input.idempotencyKey ?? null,
    note: input.note ?? null,
  });

  if (!result.alreadyProcessed) {
    await tx
      .update(whItemInstances)
      .set({ locationId: scrap.id, condition: "decommissioned", updatedAt: new Date() })
      .where(eq(whItemInstances.id, instance.id));
  }

  return { groupId: result.groupId, alreadyProcessed: result.alreadyProcessed };
}

// ── Transaction wrappers most routes call ────────────────────────────────────

export async function runMoveInstance(input: MoveInstanceInput) {
  const { db } = await import("./db");
  const result = await db.transaction(async (tx) => moveInstanceTx(tx, input));
  if (!result.alreadyProcessed) notifyMovementCommitted([]);
  return result;
}

export async function runDecommissionInstance(input: DecommissionInstanceInput) {
  const { db } = await import("./db");
  return db.transaction(async (tx) => decommissionInstanceTx(tx, input));
}

// ── Custom field values (D22/D24) ────────────────────────────────────────────

export type FieldOwner = { itemId: number; instanceId?: undefined } | { instanceId: number; itemId?: undefined };

/**
 * Writes a batch of custom-field values against one owner, each coerced into
 * the typed column its template declares (D24). All-or-nothing: one bad value
 * rejects the whole submission rather than saving half a form, because a
 * half-saved asset record is worse than one the operator has to fix and
 * resubmit.
 *
 * A blank optional value DELETES its row rather than storing an empty string,
 * so "never answered" and "answered with nothing" stay distinguishable —
 * which is what makes missingRequiredFields() meaningful.
 */
export async function saveFieldValuesTx(
  tx: Tx,
  owner: FieldOwner,
  templates: FieldTemplateLike[],
  submitted: Record<string, unknown>,
): Promise<{ saved: number; cleared: number }> {
  const byKey = new Map(templates.map((t) => [t.fieldKey, t]));

  // Validate everything BEFORE writing anything.
  const writes: Array<{ key: string; value: TypedFieldValue }> = [];
  for (const [key, raw] of Object.entries(submitted)) {
    const template = byKey.get(key);
    // A key with no template is silently ignored rather than erroring: a
    // field removed from the template while someone had the form open should
    // not block them saving the rest of it.
    if (!template) continue;
    const coerced = coerceFieldValue(template, raw);
    if (!coerced.ok) throw new InstanceError(coerced.error);
    writes.push({ key, value: coerced.value });
  }

  const ownerCol = owner.itemId != null ? whItemFields.itemId : whItemFields.instanceId;
  const ownerId = owner.itemId != null ? owner.itemId : owner.instanceId!;

  let saved = 0;
  let cleared = 0;

  for (const { key, value } of writes) {
    const isEmpty =
      value.valueText === null && value.valueNumber === null && value.valueDate === null && value.valueBoolean === null;

    if (isEmpty) {
      const deleted = await tx
        .delete(whItemFields)
        .where(and(eq(ownerCol, ownerId), eq(whItemFields.fieldKey, key)))
        .returning({ id: whItemFields.id });
      cleared += deleted.length;
      continue;
    }

    const row = {
      itemId: owner.itemId ?? null,
      instanceId: owner.instanceId ?? null,
      fieldKey: key,
      valueText: value.valueText,
      valueNumber: value.valueNumber === null ? null : String(value.valueNumber),
      valueDate: value.valueDate,
      valueBoolean: value.valueBoolean,
      updatedAt: new Date(),
    };

    // Targets the partial unique index for whichever owner this is — the two
    // indexes are mutually exclusive by the table's own CHECK, so exactly one
    // can ever conflict.
    await tx
      .insert(whItemFields)
      .values(row)
      .onConflictDoUpdate({
        target: owner.itemId != null ? [whItemFields.itemId, whItemFields.fieldKey] : [whItemFields.instanceId, whItemFields.fieldKey],
        targetWhere: owner.itemId != null ? sql`item_id IS NOT NULL` : sql`instance_id IS NOT NULL`,
        set: {
          valueText: row.valueText,
          valueNumber: row.valueNumber,
          valueDate: row.valueDate,
          valueBoolean: row.valueBoolean,
          updatedAt: row.updatedAt,
        },
      });
    saved++;
  }

  return { saved, cleared };
}

/** Reads every stored value for one owner, keyed by field_key, ready to hand
 *  straight to readFieldValue() alongside its template. */
export async function loadFieldValues(
  database: Pick<typeof realDb, "select">,
  owner: FieldOwner,
): Promise<Record<string, TypedFieldValue>> {
  const where =
    owner.itemId != null
      ? and(eq(whItemFields.itemId, owner.itemId), isNull(whItemFields.instanceId))
      : and(eq(whItemFields.instanceId, owner.instanceId!), isNull(whItemFields.itemId));

  const rows = await database
    .select({
      fieldKey: whItemFields.fieldKey,
      valueText: whItemFields.valueText,
      valueNumber: whItemFields.valueNumber,
      valueDate: whItemFields.valueDate,
      valueBoolean: whItemFields.valueBoolean,
    })
    .from(whItemFields)
    .where(where);

  const out: Record<string, TypedFieldValue> = {};
  for (const r of rows) {
    out[r.fieldKey] = {
      valueText: r.valueText,
      // numeric comes back as a string from Drizzle (AGENTS.md) — coerced here
      // once so nothing downstream has to remember to.
      valueNumber: r.valueNumber === null ? null : Number(r.valueNumber),
      valueDate: r.valueDate,
      valueBoolean: r.valueBoolean,
    };
  }
  return out;
}

/** How many live units of an asset item the club holds, and where. Derived
 *  from the instance rows (excluding decommissioned ones) — never a stored
 *  count that a missed update could leave lying. */
export async function countHeldInstances(
  database: Pick<typeof realDb, "select">,
  itemId: number,
): Promise<number> {
  const rows = await database
    .select({ n: sql<number>`count(*)::int` })
    .from(whItemInstances)
    .where(and(eq(whItemInstances.itemId, itemId), sql`${whItemInstances.condition} <> 'decommissioned'`));
  return Number(rows[0]?.n ?? 0);
}

/** Guard behind D18's "fixed at creation": an item can only change tracking
 *  mode while it has no history whatsoever. */
export async function trackingModeHistory(
  database: Pick<typeof realDb, "select">,
  itemId: number,
): Promise<{ movementCount: number; instanceCount: number }> {
  const [movements] = await database
    .select({ n: sql<number>`count(*)::int` })
    .from(whMovements)
    .where(eq(whMovements.itemId, itemId));
  const [instances] = await database
    .select({ n: sql<number>`count(*)::int` })
    .from(whItemInstances)
    .where(eq(whItemInstances.itemId, itemId));
  return { movementCount: Number(movements?.n ?? 0), instanceCount: Number(instances?.n ?? 0) };
}

/** Every asset item's live unit count in one query — for the items list, so a
 *  page of 50 assets costs one round trip rather than 50. */
export async function heldInstanceCounts(
  database: Pick<typeof realDb, "select">,
): Promise<Map<number, number>> {
  const rows = await database
    .select({ itemId: whItemInstances.itemId, n: sql<number>`count(*)::int` })
    .from(whItemInstances)
    .where(sql`${whItemInstances.condition} <> 'decommissioned'`)
    .groupBy(whItemInstances.itemId);
  return new Map(rows.map((r) => [r.itemId, Number(r.n)]));
}

