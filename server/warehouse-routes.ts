// ─────────────────────────────────────────────────────────────────────────────
// Warehouse (WMS) — master data: items, locations, barcode aliases.
//
// United Prints workspace. Everything here is gated by requireTab("warehouse")
// (dark-launched — super_admin only until T17 adds "warehouse" to
// shared/tabs.ts's SUPER_ADMIN_ONLY_TABS + printsTabs; requireTab already
// short-circuits to `next()` for super_admin regardless of tab wiring, so
// these routes work today even though the tab doesn't exist in the UI yet).
//
// This file owns the CRUD + search + label-payload surface (T4), the
// reservations surface (T5: `available`, reserve/release/consume), PO
// receiving (T6), and the scan resolver + putaway/transfer (T7). Master
// data (items/locations/aliases) still never touches wh_movements/wh_stock
// directly — only the reservations/receiving/scan-move sections call into
// server/warehouse.ts's reserve/release/consume + postMovementGroup (T3),
// same as later route groups will (T8 pick/dispatch, T9 requisitions,
// T10 loans, T11 counts).
//
// House rules followed (AGENTS.md): no DB CHECKs on open value sets — every
// enum-ish field (kind, brandOwner, unit, locationKind, refKind,
// movementType, reasonCode) is validated against shared/warehouse.ts;
// quantities are numeric(12,3) columns that Drizzle maps to strings,
// converted explicitly at this edge; money (costCents) is integer cents;
// unique-violation (23505) and FK-restrict-violation (23503) Postgres error
// codes, plus the engine's InsufficientStockError/InsufficientAvailableError,
// are caught and turned into clean 409s rather than raw 500s.
// ─────────────────────────────────────────────────────────────────────────────
import type { Express, Request, Response } from "express";
import { and, asc, desc, eq, ilike, inArray, isNotNull, lt, ne, or, sql } from "drizzle-orm";
import { db } from "./db";
import { requireAuth, requireTab } from "./auth";
import { nzTodayIso } from "@shared/academy";
import {
  whItems, whLocations, whBarcodeAliases, whReservations, whPurchaseOrders, whPoLines,
  whRequisitions, whRequisitionLines, whMovements,
  whLoans, whLoanLines,
  whStock, whCounts, whCountLines, whSyncState,
  shopOrders, shopOrderItems,
  printOrders,
  users, contacts,
} from "@shared/schema";
import {
  ITEM_KINDS, isItemKind,
  BRAND_OWNERS, isBrandOwner,
  UNITS, isUnit,
  LOCATION_KINDS, isLocationKind,
  isValidLocationCode, normaliseLocationCode, deriveLocationZone,
  isValidSku, normaliseSku,
  normaliseAliasCode,
  locationBarcodePayload,
  REF_KINDS, isRefKind,
  isReservationStatus,
  MOVEMENT_TYPES, isMovementType,
  REASON_CODES, isReasonCode,
  PO_STATUSES, isPoStatus,
  isValidDateOnly,
  computeReceiveDiscrepancy, receiveDiscrepancyNote, derivePoStatusFromLines,
  QUARANTINE_ZONE,
  buildLocationMoveLegs,
  DISPATCH_SOURCE_KINDS, isDispatchSourceKind, nextOrderStatusAfterDispatch,
  REQUISITION_STATUSES, isRequisitionStatus, isValidRequisitionTransition,
  isValidMonth, deriveRequisitionStatusFromLines,
  LOAN_STATUSES, isLoanStatus, isLoanOverdue,
  deriveLoanStatusFromLines, reasonCodeForConditionGrade,
  CONDITION_GRADES, isConditionGrade,
  COUNT_STATUSES, isCountStatus,
  isValidCountTransition, shouldHideExpectedQty,
  countLineNeedsRecount, countLineResolution, countLineVarianceQty,
  canApproveCount, buildCountAdjustmentLegs,
  type ItemKind, type BrandOwner, type Unit, type LocationKind,
  type RefKind, type MovementType, type ReasonCode, type PoStatus, type RequisitionStatus,
  type LoanStatus, type ConditionGrade, type CountStatus, type CountLineResolution,
} from "@shared/warehouse";
import {
  runReserveStock,
  runReleaseReservation,
  runConsumeReservation,
  runMovementGroup,
  reservationDbFromTx,
  resolveScanCode,
  scanLookupDbFromDb,
  postMovementGroup,
  warehouseDbFromTx,
  notifyMovementCommitted,
  InsufficientAvailableError,
  InsufficientStockError,
  type MovementLeg,
} from "./warehouse";

// ── Shared helpers ───────────────────────────────────────────────────────────

class WarehouseRouteError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function handleWarehouseError(res: Response, e: any, context: string) {
  if (e instanceof WarehouseRouteError) return res.status(e.status).json({ message: e.message });
  // The engine's own stock-guard errors (T3/T5) — a real conflict, not a bug.
  if (e instanceof InsufficientStockError || e instanceof InsufficientAvailableError) {
    return res.status(409).json({ message: e.message });
  }
  // 23505 = unique_violation, 23503 = foreign_key_violation (Postgres error codes).
  if (e?.code === "23505") {
    return res.status(409).json({ message: "That code is already in use." });
  }
  if (e?.code === "23503") {
    return res.status(409).json({
      message: "This is still referenced elsewhere (stock, movements, or another record) and can't be deleted. Mark it inactive instead.",
    });
  }
  console.error(`[Warehouse] ${context} error:`, e);
  return res.status(500).json({ message: "Something went wrong. Please try again." });
}

const clean = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;

function parseId(raw: unknown): number | null {
  const n = parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : null;
}

/** `?ids=1,2,3` → deduped, finite, positive integer ids. Never throws — an
 *  unparsable id is just dropped, so a stray typo drops that one label rather
 *  than failing the whole print run. */
function parseIdList(raw: unknown): number[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  const ids = raw.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n) && n > 0);
  return Array.from(new Set(ids));
}

function parseActiveFilter(raw: unknown): boolean | undefined {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return undefined;
}

/** Quantities are numeric(12,3) columns — Drizzle maps them to strings.
 *  `undefined` means "field not supplied, leave unchanged" (PATCH); `null` or
 *  `""` clears the field; anything else must parse as a finite number. */
function toNumericString(v: unknown, field: string): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new WarehouseRouteError(`${field} must be a number`);
  return String(n);
}

/** costCents is integer NZD cents (house rule: money in cents). */
function toCents(v: unknown, field: string): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new WarehouseRouteError(`${field} must be a whole number of cents`);
  return n;
}

function toBool(v: unknown, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  return !!v;
}

/** A replacement charge (T10) is money in cents like costCents, but unlike
 *  costCents (a reference figure that could theoretically be zero/absent) a
 *  charge that's supplied at all must be a real non-negative amount — a
 *  negative "charge" makes no sense. */
function toChargeCents(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) {
    throw new WarehouseRouteError("replacementChargedCents must be zero or a positive whole number of cents");
  }
  return n;
}

// ── PO receiving helpers (T6) ────────────────────────────────────────────────
// qty_received is NEVER a stored column (schema.ts's own comment on
// wh_po_lines) — it's derived by summing every receipt movement referencing
// a line (ref_kind='po', ref_id=line id, movement_type='receipt'). A single
// raw aggregate (with a FILTER clause splitting good vs damaged by
// reason_code) rather than drizzle's query builder, same "computed aggregate
// isn't practically expressed via the builder" reasoning as
// server/warehouse.ts's reconcile query.

interface PoLineReceiptTotals {
  good: number;
  damaged: number;
}

async function getPoLineReceiptTotals(lineIds: number[]): Promise<Map<number, PoLineReceiptTotals>> {
  const totals = new Map<number, PoLineReceiptTotals>();
  if (lineIds.length === 0) return totals;
  const result = await db.execute(sql`
    SELECT ref_id AS po_line_id,
      COALESCE(SUM(delta) FILTER (WHERE reason_code IS DISTINCT FROM 'damaged'), 0) AS good,
      COALESCE(SUM(delta) FILTER (WHERE reason_code = 'damaged'), 0) AS damaged
    FROM wh_movements
    WHERE ref_kind = 'po' AND movement_type = 'receipt'
      AND ref_id IN (${sql.join(lineIds.map((id) => sql`${id}`), sql`, `)})
    GROUP BY ref_id
  `);
  for (const row of result.rows as Array<{ po_line_id: number | string; good: string; damaged: string }>) {
    totals.set(Number(row.po_line_id), { good: Number(row.good), damaged: Number(row.damaged) });
  }
  return totals;
}

/** Every line of a PO, joined to its item, with the derived receiving
 *  position layered on (never a stored column — see the comment above).
 *  Shared by the PO detail GET and the receive endpoint's own status
 *  recompute, so the two can never drift on how "received" is calculated. */
async function loadPoLinesWithReceipts(poId: number) {
  const rows = await db
    .select({ line: whPoLines, itemSku: whItems.sku, itemName: whItems.name })
    .from(whPoLines)
    .innerJoin(whItems, eq(whPoLines.itemId, whItems.id))
    .where(eq(whPoLines.poId, poId))
    .orderBy(asc(whPoLines.id));

  const totals = await getPoLineReceiptTotals(rows.map((r) => r.line.id));

  return rows.map((r) => {
    const t = totals.get(r.line.id) ?? { good: 0, damaged: 0 };
    const qtyOrdered = Number(r.line.qtyOrdered);
    const qtyReceivedGood = t.good;
    const qtyReceivedDamaged = t.damaged;
    const qtyReceived = qtyReceivedGood + qtyReceivedDamaged;
    return {
      ...r.line,
      itemSku: r.itemSku,
      itemName: r.itemName,
      qtyReceivedGood,
      qtyReceivedDamaged,
      qtyReceived,
      qtyRemaining: Math.max(qtyOrdered - qtyReceived, 0),
    };
  });
}

/** PO statuses a receive-scan is allowed against. Not 'draft' (nothing has
 *  been sent to the supplier yet) and not the terminal 'cancelled'/'closed'
 *  (a human closed the PO out on purpose). 'received' stays receivable too —
 *  a supplier occasionally sends a late top-up after the line already read
 *  fully received, and that's still real stock arriving at the dock. */
const RECEIVABLE_PO_STATUSES: ReadonlySet<PoStatus> = new Set<PoStatus>(["sent", "partial", "received"]);

// ── Scan / location-move helpers (T7) ───────────────────────────────────────
// Loads + validates a location for a putaway/transfer leg — must exist and
// must NOT be virtual (SUPPLIER/CUSTOMER/SCRAP/PRODUCTION are movement
// ENDPOINTS chosen from a dropdown by a receipt/dispatch/write-off flow,
// never somewhere a human walks a trolley to — see
// shared/warehouse.ts's scanActionsForLocation for the same call made on the
// scan-resolver side).
async function resolveRealLocationForMove(rawId: unknown, field: string) {
  const locId = parseId(rawId);
  if (locId === null) throw new WarehouseRouteError(`${field} is required`);
  const [loc] = await db
    .select({ id: whLocations.id, code: whLocations.code, kind: whLocations.kind })
    .from(whLocations)
    .where(eq(whLocations.id, locId));
  if (!loc) throw new WarehouseRouteError(`${field} does not reference a real location`);
  if (loc.kind === "virtual") {
    throw new WarehouseRouteError(`${field} can't be a virtual location — choose a real bin or zone`);
  }
  return loc;
}

/**
 * Body: { itemId, fromLocationId, toLocationId, qty, note?, idempotencyKey? }.
 * Shared by putaway (moving newly-received stock off a receiving/staging
 * zone into its home bin) and transfer (any other bin-to-bin move) — the two
 * are the exact same two-leg shape (shared/warehouse.ts's
 * buildLocationMoveLegs), only the `movementType` label differs.
 */
async function handleLocationMove(req: Request, res: Response, movementType: "putaway" | "transfer") {
  try {
    const b = req.body || {};
    const itemId = parseId(b.itemId);
    if (itemId === null) throw new WarehouseRouteError("itemId is required");
    const [item] = await db
      .select({ id: whItems.id, allowNegative: whItems.allowNegative })
      .from(whItems)
      .where(eq(whItems.id, itemId));
    if (!item) throw new WarehouseRouteError("itemId does not reference a real item");

    const fromLocation = await resolveRealLocationForMove(b.fromLocationId, "fromLocationId");
    const toLocation = await resolveRealLocationForMove(b.toLocationId, "toLocationId");
    if (fromLocation.id === toLocation.id) {
      throw new WarehouseRouteError("fromLocationId and toLocationId must be different locations");
    }

    const qty = Number(b.qty);
    if (!Number.isFinite(qty) || qty <= 0) throw new WarehouseRouteError("qty must be a positive number");

    const legs = buildLocationMoveLegs(item, fromLocation, toLocation, qty);
    const operatorUserId = req.session.userId!;
    const movement = await runMovementGroup({
      legs,
      movementType,
      operatorUserId,
      idempotencyKey: clean(b.idempotencyKey) ?? null,
      note: clean(b.note) ?? null,
    });
    res.status(movement.alreadyProcessed ? 200 : 201).json(movement);
  } catch (e: any) {
    handleWarehouseError(res, e, movementType);
  }
}

export function registerWarehouseRoutes(app: Express) {
  // ═══════════════════════════════════════════════════════════════════════
  // Dashboard (T16a) — one aggregated read for the /admin/warehouse landing
  // page: stock health, pending requisitions, overdue loans, sync drift
  // alerts, and the ledger's recent tail. Every number is computed fresh on
  // each call (no cached "stats" row) — this is an admin page loaded a
  // handful of times a day, not a hot path, and nothing here writes.
  // ═══════════════════════════════════════════════════════════════════════

  app.get("/api/admin/warehouse/dashboard", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const today = nzTodayIso();

      // Low stock — Σ on_hand across REAL (non-virtual) locations vs the
      // item's own min_qty reorder threshold. An item with no min_qty set
      // has opted out of this alert (not everything needs reordering); a
      // computed multi-row aggregate joined across 3 tables isn't something
      // the query builder expresses cleanly (same reasoning as T6's
      // getPoLineReceiptTotals), so this is one raw SQL statement.
      const lowStockResult = await db.execute(sql`
        SELECT i.id, i.sku, i.name, i.brand_owner, i.min_qty,
          COALESCE(SUM(s.on_hand) FILTER (WHERE l.kind <> 'virtual'), 0) AS on_hand
        FROM wh_items i
        LEFT JOIN wh_stock s ON s.item_id = i.id
        LEFT JOIN wh_locations l ON l.id = s.location_id
        WHERE i.active = true AND i.min_qty IS NOT NULL
        GROUP BY i.id
        HAVING COALESCE(SUM(s.on_hand) FILTER (WHERE l.kind <> 'virtual'), 0) < i.min_qty
        ORDER BY i.sku
      `);
      const lowStockItems = (
        lowStockResult.rows as Array<{
          id: number; sku: string; name: string; brand_owner: string; min_qty: string; on_hand: string;
        }>
      ).map((r) => ({
        id: r.id,
        sku: r.sku,
        name: r.name,
        brandOwner: r.brand_owner,
        minQty: Number(r.min_qty),
        onHand: Number(r.on_hand),
      }));

      const [{ count: activeItemCountRaw }] = await db
        .select({ count: sql<string>`COUNT(*)` })
        .from(whItems)
        .where(eq(whItems.active, true));

      // Pending requisitions — anything not yet collected or declined.
      const PENDING_REQUISITION_STATUSES: RequisitionStatus[] = ["submitted", "approved", "picking", "ready"];
      const pendingReqRows = await db
        .select({
          id: whRequisitions.id,
          chargeTo: whRequisitions.chargeTo,
          status: whRequisitions.status,
          neededBy: whRequisitions.neededBy,
          createdAt: whRequisitions.createdAt,
          requesterFirst: users.firstName,
          requesterLast: users.lastName,
        })
        .from(whRequisitions)
        .leftJoin(users, eq(whRequisitions.requestedBy, users.id))
        .where(inArray(whRequisitions.status, PENDING_REQUISITION_STATUSES))
        .orderBy(asc(whRequisitions.neededBy))
        .limit(10);
      const pendingRequisitions = pendingReqRows.map(({ requesterFirst, requesterLast, ...r }) => ({
        ...r,
        requesterName: fullName(requesterFirst, requesterLast),
      }));
      const [{ count: pendingRequisitionsCountRaw }] = await db
        .select({ count: sql<string>`COUNT(*)` })
        .from(whRequisitions)
        .where(inArray(whRequisitions.status, PENDING_REQUISITION_STATUSES));

      // Overdue loans — status='out' AND due_on < today (D14's own derived
      // definition, isLoanOverdue — filtered directly in SQL for this
      // advisory top-10 rather than loading every 'out' loan into JS first).
      const overdueLoanCondition = and(eq(whLoans.status, "out"), lt(whLoans.dueOn, today));
      const overdueLoanRows = await db
        .select()
        .from(whLoans)
        .where(overdueLoanCondition)
        .orderBy(asc(whLoans.dueOn))
        .limit(10);
      const overdueLoans = overdueLoanRows.map(withOverdue);
      const [{ count: overdueLoansCountRaw }] = await db
        .select({ count: sql<string>`COUNT(*)` })
        .from(whLoans)
        .where(overdueLoanCondition);

      // Drift alerts — wh_sync_state rows where the sync engine (T12) has
      // logged a genuine unexplained mismatch (never our own echo).
      const driftRows = await db
        .select({
          itemId: whSyncState.itemId,
          store: whSyncState.store,
          lastPushedQty: whSyncState.lastPushedQty,
          lastDriftAt: whSyncState.lastDriftAt,
          driftNote: whSyncState.driftNote,
          itemSku: whItems.sku,
          itemName: whItems.name,
        })
        .from(whSyncState)
        .innerJoin(whItems, eq(whSyncState.itemId, whItems.id))
        .where(isNotNull(whSyncState.lastDriftAt))
        .orderBy(desc(whSyncState.lastDriftAt))
        .limit(10);
      const [{ count: driftAlertsCountRaw }] = await db
        .select({ count: sql<string>`COUNT(*)` })
        .from(whSyncState)
        .where(isNotNull(whSyncState.lastDriftAt));

      // Recent movements feed — the ledger's own tail, newest first.
      const recentMovementRows = await db
        .select({
          id: whMovements.id,
          groupId: whMovements.groupId,
          delta: whMovements.delta,
          movementType: whMovements.movementType,
          reasonCode: whMovements.reasonCode,
          refKind: whMovements.refKind,
          refId: whMovements.refId,
          note: whMovements.note,
          createdAt: whMovements.createdAt,
          itemSku: whItems.sku,
          itemName: whItems.name,
          locationCode: whLocations.code,
          operatorFirst: users.firstName,
          operatorLast: users.lastName,
        })
        .from(whMovements)
        .innerJoin(whItems, eq(whMovements.itemId, whItems.id))
        .innerJoin(whLocations, eq(whMovements.locationId, whLocations.id))
        .leftJoin(users, eq(whMovements.operatorUserId, users.id))
        .orderBy(desc(whMovements.id))
        .limit(20);
      const recentMovements = recentMovementRows.map(({ operatorFirst, operatorLast, ...m }) => ({
        ...m,
        operatorName: fullName(operatorFirst, operatorLast),
      }));

      res.json({
        activeItemCount: Number(activeItemCountRaw),
        lowStockItems,
        lowStockCount: lowStockItems.length,
        pendingRequisitions,
        pendingRequisitionsCount: Number(pendingRequisitionsCountRaw),
        overdueLoans,
        overdueLoansCount: Number(overdueLoansCountRaw),
        driftAlerts: driftRows,
        driftAlertsCount: Number(driftAlertsCountRaw),
        recentMovements,
      });
    } catch (e: any) {
      handleWarehouseError(res, e, "dashboard");
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Locations — bins, named zones, virtual locations (D8).
  // ═══════════════════════════════════════════════════════════════════════

  app.get("/api/admin/warehouse/locations", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const q = clean(req.query.q as string | undefined);
      const kind = clean(req.query.kind as string | undefined);
      const active = parseActiveFilter(req.query.active);

      const conditions = [];
      if (q) conditions.push(ilike(whLocations.code, `%${q}%`));
      if (kind && isLocationKind(kind)) conditions.push(eq(whLocations.kind, kind));
      if (active !== undefined) conditions.push(eq(whLocations.active, active));

      const rows = await db
        .select()
        .from(whLocations)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(asc(whLocations.code));
      res.json(rows);
    } catch (e: any) {
      handleWarehouseError(res, e, "locations list");
    }
  });

  app.get("/api/admin/warehouse/locations/:id", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Bad id" });
      const [row] = await db.select().from(whLocations).where(eq(whLocations.id, id));
      if (!row) return res.status(404).json({ message: "Location not found" });
      res.json(row);
    } catch (e: any) {
      handleWarehouseError(res, e, "location get");
    }
  });

  app.post("/api/admin/warehouse/locations", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const rawCode = clean(req.body?.code);
      if (!rawCode) throw new WarehouseRouteError("A location code is required");
      const code = normaliseLocationCode(rawCode);
      if (!isValidLocationCode(code)) {
        throw new WarehouseRouteError(
          "Location codes must be a virtual code, a named zone, or a shallow ZONE-AISLE-BAY-LEVEL bin code (2-4 uppercase alphanumeric segments)",
        );
      }
      const kindRaw = clean(req.body?.kind) ?? "bin";
      if (!isLocationKind(kindRaw)) {
        throw new WarehouseRouteError(`kind must be one of: ${LOCATION_KINDS.join(", ")}`);
      }
      const kind = kindRaw as LocationKind;

      const [created] = await db
        .insert(whLocations)
        .values({
          code,
          zone: deriveLocationZone(code, kind),
          kind,
          active: toBool(req.body?.active, true),
        })
        .returning();
      res.status(201).json(created);
    } catch (e: any) {
      handleWarehouseError(res, e, "location create");
    }
  });

  app.patch("/api/admin/warehouse/locations/:id", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Bad id" });
      const [existing] = await db.select().from(whLocations).where(eq(whLocations.id, id));
      if (!existing) return res.status(404).json({ message: "Location not found" });

      const b = req.body || {};
      const patch: Record<string, any> = {};
      let nextCode = existing.code;
      let nextKind = existing.kind as LocationKind;

      if (b.code !== undefined) {
        const rawCode = clean(b.code);
        if (!rawCode) throw new WarehouseRouteError("Location code can't be blank");
        nextCode = normaliseLocationCode(rawCode);
        if (!isValidLocationCode(nextCode)) {
          throw new WarehouseRouteError(
            "Location codes must be a virtual code, a named zone, or a shallow ZONE-AISLE-BAY-LEVEL bin code (2-4 uppercase alphanumeric segments)",
          );
        }
        patch.code = nextCode;
      }
      if (b.kind !== undefined) {
        if (!isLocationKind(b.kind)) throw new WarehouseRouteError(`kind must be one of: ${LOCATION_KINDS.join(", ")}`);
        nextKind = b.kind;
        patch.kind = nextKind;
      }
      if (b.code !== undefined || b.kind !== undefined) {
        // Zone is always derived, never a free-text field that could drift
        // out of sync with the code (see shared/warehouse.ts).
        patch.zone = deriveLocationZone(nextCode, nextKind);
      }
      if (b.active !== undefined) patch.active = !!b.active;

      const [updated] = await db.update(whLocations).set(patch).where(eq(whLocations.id, id)).returning();
      res.json(updated);
    } catch (e: any) {
      handleWarehouseError(res, e, "location update");
    }
  });

  app.delete("/api/admin/warehouse/locations/:id", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Bad id" });
      const [deleted] = await db.delete(whLocations).where(eq(whLocations.id, id)).returning({ id: whLocations.id });
      if (!deleted) return res.status(404).json({ message: "Location not found" });
      res.json({ ok: true });
    } catch (e: any) {
      handleWarehouseError(res, e, "location delete");
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Items — everything stocked (D4: brand_owner is part of an item's
  // identity, never a pooled row across brands).
  // ═══════════════════════════════════════════════════════════════════════

  app.get("/api/admin/warehouse/items", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const q = clean(req.query.q as string | undefined);
      const kind = clean(req.query.kind as string | undefined);
      const brandOwner = clean(req.query.brandOwner as string | undefined);
      const active = parseActiveFilter(req.query.active);

      const conditions = [];
      if (q) {
        conditions.push(
          or(
            ilike(whItems.sku, `%${q}%`),
            ilike(whItems.name, `%${q}%`),
            ilike(whItems.category, `%${q}%`),
          ),
        );
      }
      if (kind && isItemKind(kind)) conditions.push(eq(whItems.kind, kind));
      if (brandOwner && isBrandOwner(brandOwner)) conditions.push(eq(whItems.brandOwner, brandOwner));
      if (active !== undefined) conditions.push(eq(whItems.active, active));

      const rows = await db
        .select({
          item: whItems,
          defaultLocationCode: whLocations.code,
        })
        .from(whItems)
        .leftJoin(whLocations, eq(whItems.defaultLocationId, whLocations.id))
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(asc(whItems.sku));

      res.json(rows.map((r) => ({ ...r.item, defaultLocationCode: r.defaultLocationCode ?? null })));
    } catch (e: any) {
      handleWarehouseError(res, e, "items list");
    }
  });

  app.get("/api/admin/warehouse/items/:id", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Bad id" });

      const [row] = await db
        .select({ item: whItems, defaultLocationCode: whLocations.code })
        .from(whItems)
        .leftJoin(whLocations, eq(whItems.defaultLocationId, whLocations.id))
        .where(eq(whItems.id, id));
      if (!row) return res.status(404).json({ message: "Item not found" });

      const aliases = await db
        .select()
        .from(whBarcodeAliases)
        .where(eq(whBarcodeAliases.itemId, id))
        .orderBy(asc(whBarcodeAliases.code));

      res.json({ ...row.item, defaultLocationCode: row.defaultLocationCode ?? null, aliases });
    } catch (e: any) {
      handleWarehouseError(res, e, "item get");
    }
  });

  app.post("/api/admin/warehouse/items", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const b = req.body || {};
      const name = clean(b.name);
      if (!name) throw new WarehouseRouteError("A name is required");
      const rawSku = clean(b.sku);
      if (!rawSku) throw new WarehouseRouteError("A SKU is required");
      const sku = normaliseSku(rawSku);
      if (!isValidSku(sku)) {
        throw new WarehouseRouteError("SKU must be uppercase letters/digits/dashes, 20 characters or fewer, once normalised");
      }

      const kind = (clean(b.kind) ?? "merch") as ItemKind;
      if (!isItemKind(kind)) throw new WarehouseRouteError(`kind must be one of: ${ITEM_KINDS.join(", ")}`);
      const brandOwner = (clean(b.brandOwner) ?? "club") as BrandOwner;
      if (!isBrandOwner(brandOwner)) throw new WarehouseRouteError(`brandOwner must be one of: ${BRAND_OWNERS.join(", ")}`);
      const unit = (clean(b.unit) ?? "ea") as Unit;
      if (!isUnit(unit)) throw new WarehouseRouteError(`unit must be one of: ${UNITS.join(", ")}`);
      let purchaseUnit: Unit | undefined;
      if (b.purchaseUnit !== undefined && clean(b.purchaseUnit) !== undefined) {
        const pu = clean(b.purchaseUnit)!;
        if (!isUnit(pu)) throw new WarehouseRouteError(`purchaseUnit must be one of: ${UNITS.join(", ")}`);
        purchaseUnit = pu as Unit;
      }

      let defaultLocationId: number | null = null;
      if (b.defaultLocationId !== undefined && b.defaultLocationId !== null && b.defaultLocationId !== "") {
        const locId = parseId(b.defaultLocationId);
        if (locId === null) throw new WarehouseRouteError("defaultLocationId must be a number");
        const [loc] = await db.select({ id: whLocations.id }).from(whLocations).where(eq(whLocations.id, locId));
        if (!loc) throw new WarehouseRouteError("defaultLocationId does not reference a real location");
        defaultLocationId = locId;
      }

      const [created] = await db
        .insert(whItems)
        .values({
          sku,
          name,
          kind,
          brandOwner,
          category: clean(b.category) ?? null,
          unit,
          purchaseUnit: purchaseUnit ?? null,
          purchaseQty: toNumericString(b.purchaseQty, "purchaseQty") ?? null,
          allowNegative: toBool(b.allowNegative, false),
          isLoanable: toBool(b.isLoanable, false),
          minQty: toNumericString(b.minQty, "minQty") ?? null,
          costCents: toCents(b.costCents, "costCents") ?? null,
          defaultLocationId,
          active: toBool(b.active, true),
          notes: clean(b.notes) ?? null,
          shopVariantId: b.shopVariantId !== undefined && b.shopVariantId !== null ? parseId(b.shopVariantId) : null,
          shopifyStore: clean(b.shopifyStore) ?? null,
          shopifyInventoryItemId: clean(b.shopifyInventoryItemId) ?? null,
          shopifyVariantId: clean(b.shopifyVariantId) ?? null,
        })
        .returning();
      res.status(201).json(created);
    } catch (e: any) {
      handleWarehouseError(res, e, "item create");
    }
  });

  app.patch("/api/admin/warehouse/items/:id", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Bad id" });
      const [existing] = await db.select().from(whItems).where(eq(whItems.id, id));
      if (!existing) return res.status(404).json({ message: "Item not found" });

      const b = req.body || {};
      const patch: Record<string, any> = { updatedAt: new Date() };

      if (b.name !== undefined) {
        const name = clean(b.name);
        if (!name) throw new WarehouseRouteError("Name can't be blank");
        patch.name = name;
      }
      if (b.sku !== undefined) {
        const rawSku = clean(b.sku);
        if (!rawSku) throw new WarehouseRouteError("SKU can't be blank");
        const sku = normaliseSku(rawSku);
        if (!isValidSku(sku)) throw new WarehouseRouteError("SKU must be uppercase letters/digits/dashes, 20 characters or fewer, once normalised");
        patch.sku = sku;
      }
      if (b.kind !== undefined) {
        if (!isItemKind(b.kind)) throw new WarehouseRouteError(`kind must be one of: ${ITEM_KINDS.join(", ")}`);
        patch.kind = b.kind;
      }
      if (b.brandOwner !== undefined) {
        if (!isBrandOwner(b.brandOwner)) throw new WarehouseRouteError(`brandOwner must be one of: ${BRAND_OWNERS.join(", ")}`);
        patch.brandOwner = b.brandOwner;
      }
      if (b.category !== undefined) patch.category = clean(b.category) ?? null;
      if (b.unit !== undefined) {
        if (!isUnit(b.unit)) throw new WarehouseRouteError(`unit must be one of: ${UNITS.join(", ")}`);
        patch.unit = b.unit;
      }
      if (b.purchaseUnit !== undefined) {
        const pu = clean(b.purchaseUnit);
        if (pu !== undefined && !isUnit(pu)) throw new WarehouseRouteError(`purchaseUnit must be one of: ${UNITS.join(", ")}`);
        patch.purchaseUnit = pu ?? null;
      }
      if (b.purchaseQty !== undefined) patch.purchaseQty = toNumericString(b.purchaseQty, "purchaseQty");
      if (b.allowNegative !== undefined) patch.allowNegative = !!b.allowNegative;
      if (b.isLoanable !== undefined) patch.isLoanable = !!b.isLoanable;
      if (b.minQty !== undefined) patch.minQty = toNumericString(b.minQty, "minQty");
      if (b.costCents !== undefined) patch.costCents = toCents(b.costCents, "costCents");
      if (b.defaultLocationId !== undefined) {
        if (b.defaultLocationId === null || b.defaultLocationId === "") {
          patch.defaultLocationId = null;
        } else {
          const locId = parseId(b.defaultLocationId);
          if (locId === null) throw new WarehouseRouteError("defaultLocationId must be a number");
          const [loc] = await db.select({ id: whLocations.id }).from(whLocations).where(eq(whLocations.id, locId));
          if (!loc) throw new WarehouseRouteError("defaultLocationId does not reference a real location");
          patch.defaultLocationId = locId;
        }
      }
      if (b.active !== undefined) patch.active = !!b.active;
      if (b.notes !== undefined) patch.notes = clean(b.notes) ?? null;
      if (b.shopVariantId !== undefined) patch.shopVariantId = b.shopVariantId === null ? null : parseId(b.shopVariantId);
      if (b.shopifyStore !== undefined) patch.shopifyStore = clean(b.shopifyStore) ?? null;
      if (b.shopifyInventoryItemId !== undefined) patch.shopifyInventoryItemId = clean(b.shopifyInventoryItemId) ?? null;
      if (b.shopifyVariantId !== undefined) patch.shopifyVariantId = clean(b.shopifyVariantId) ?? null;

      const [updated] = await db.update(whItems).set(patch).where(eq(whItems.id, id)).returning();
      res.json(updated);
    } catch (e: any) {
      handleWarehouseError(res, e, "item update");
    }
  });

  app.delete("/api/admin/warehouse/items/:id", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Bad id" });
      const [deleted] = await db.delete(whItems).where(eq(whItems.id, id)).returning({ id: whItems.id });
      if (!deleted) return res.status(404).json({ message: "Item not found" });
      res.json({ ok: true });
    } catch (e: any) {
      handleWarehouseError(res, e, "item delete");
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Barcode aliases — manufacturer EANs / any scanned code that isn't the
  // item's own SKU, looked up verbatim (D5). Many aliases can point at one
  // item; `packQty` lets a case barcode post a multi-unit movement later.
  // ═══════════════════════════════════════════════════════════════════════

  // Flat list across all items — `itemId` narrows to one item's aliases (the
  // per-item detail view above already nests them; this is for an
  // all-aliases admin table + search by scanned code).
  app.get("/api/admin/warehouse/aliases", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const q = clean(req.query.q as string | undefined);
      const itemId = req.query.itemId !== undefined ? parseId(req.query.itemId) : null;

      const conditions = [];
      if (q) conditions.push(ilike(whBarcodeAliases.code, `%${q}%`));
      if (itemId !== null) conditions.push(eq(whBarcodeAliases.itemId, itemId));

      const rows = await db
        .select({
          alias: whBarcodeAliases,
          itemSku: whItems.sku,
          itemName: whItems.name,
        })
        .from(whBarcodeAliases)
        .innerJoin(whItems, eq(whBarcodeAliases.itemId, whItems.id))
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(asc(whBarcodeAliases.code));

      res.json(rows.map((r) => ({ ...r.alias, itemSku: r.itemSku, itemName: r.itemName })));
    } catch (e: any) {
      handleWarehouseError(res, e, "aliases list");
    }
  });

  app.get("/api/admin/warehouse/items/:itemId/aliases", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const itemId = parseId(req.params.itemId);
      if (itemId === null) return res.status(400).json({ message: "Bad item id" });
      const rows = await db
        .select()
        .from(whBarcodeAliases)
        .where(eq(whBarcodeAliases.itemId, itemId))
        .orderBy(asc(whBarcodeAliases.code));
      res.json(rows);
    } catch (e: any) {
      handleWarehouseError(res, e, "item aliases list");
    }
  });

  app.post("/api/admin/warehouse/items/:itemId/aliases", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const itemId = parseId(req.params.itemId);
      if (itemId === null) return res.status(400).json({ message: "Bad item id" });
      const [item] = await db.select({ id: whItems.id }).from(whItems).where(eq(whItems.id, itemId));
      if (!item) return res.status(404).json({ message: "Item not found" });

      const rawCode = clean(req.body?.code);
      if (!rawCode) throw new WarehouseRouteError("An alias code is required");
      const code = normaliseAliasCode(rawCode);

      const packQty = toNumericString(req.body?.packQty, "packQty") ?? "1";

      const [created] = await db
        .insert(whBarcodeAliases)
        .values({
          code,
          itemId,
          packQty,
          note: clean(req.body?.note) ?? null,
        })
        .returning();
      res.status(201).json(created);
    } catch (e: any) {
      handleWarehouseError(res, e, "alias create");
    }
  });

  app.patch("/api/admin/warehouse/aliases/:id", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Bad id" });
      const [existing] = await db.select().from(whBarcodeAliases).where(eq(whBarcodeAliases.id, id));
      if (!existing) return res.status(404).json({ message: "Alias not found" });

      const b = req.body || {};
      const patch: Record<string, any> = {};
      if (b.code !== undefined) {
        const rawCode = clean(b.code);
        if (!rawCode) throw new WarehouseRouteError("Alias code can't be blank");
        patch.code = normaliseAliasCode(rawCode);
      }
      if (b.packQty !== undefined) {
        const packQty = toNumericString(b.packQty, "packQty");
        patch.packQty = packQty ?? "1";
      }
      if (b.note !== undefined) patch.note = clean(b.note) ?? null;
      if (b.itemId !== undefined) {
        const itemId = parseId(b.itemId);
        if (itemId === null) throw new WarehouseRouteError("itemId must be a number");
        const [item] = await db.select({ id: whItems.id }).from(whItems).where(eq(whItems.id, itemId));
        if (!item) throw new WarehouseRouteError("itemId does not reference a real item");
        patch.itemId = itemId;
      }

      const [updated] = await db.update(whBarcodeAliases).set(patch).where(eq(whBarcodeAliases.id, id)).returning();
      res.json(updated);
    } catch (e: any) {
      handleWarehouseError(res, e, "alias update");
    }
  });

  app.delete("/api/admin/warehouse/aliases/:id", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Bad id" });
      const [deleted] = await db.delete(whBarcodeAliases).where(eq(whBarcodeAliases.id, id)).returning({ id: whBarcodeAliases.id });
      if (!deleted) return res.status(404).json({ message: "Alias not found" });
      res.json({ ok: true });
    } catch (e: any) {
      handleWarehouseError(res, e, "alias delete");
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Item detail extras (T16a) — per-location stock breakdown + movement
  // history for the Items admin page's detail view. Read-only, no engine
  // involvement (same "master data never touches wh_stock/wh_movements
  // directly" doctrine as the rest of this section — these two endpoints
  // only ever SELECT).
  // ═══════════════════════════════════════════════════════════════════════

  app.get("/api/admin/warehouse/items/:id/stock", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Bad id" });
      const rows = await db
        .select({
          locationId: whStock.locationId,
          onHand: whStock.onHand,
          updatedAt: whStock.updatedAt,
          locationCode: whLocations.code,
          locationZone: whLocations.zone,
          locationKind: whLocations.kind,
        })
        .from(whStock)
        .innerJoin(whLocations, eq(whStock.locationId, whLocations.id))
        .where(eq(whStock.itemId, id))
        .orderBy(asc(whLocations.code));
      res.json(rows);
    } catch (e: any) {
      handleWarehouseError(res, e, "item stock");
    }
  });

  // The ledger filtered to one item, newest first — the full cross-item
  // audit trail (any item/location/date) is T16c's warehouse-ledger.tsx.
  app.get("/api/admin/warehouse/items/:id/movements", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Bad id" });
      const limitRaw = parseInt(String(req.query.limit ?? "100"), 10);
      const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 100;

      const rows = await db
        .select({
          id: whMovements.id,
          groupId: whMovements.groupId,
          delta: whMovements.delta,
          movementType: whMovements.movementType,
          reasonCode: whMovements.reasonCode,
          refKind: whMovements.refKind,
          refId: whMovements.refId,
          note: whMovements.note,
          createdAt: whMovements.createdAt,
          locationCode: whLocations.code,
          operatorFirst: users.firstName,
          operatorLast: users.lastName,
        })
        .from(whMovements)
        .innerJoin(whLocations, eq(whMovements.locationId, whLocations.id))
        .leftJoin(users, eq(whMovements.operatorUserId, users.id))
        .where(eq(whMovements.itemId, id))
        .orderBy(desc(whMovements.id))
        .limit(limit);

      res.json(
        rows.map(({ operatorFirst, operatorLast, ...m }) => ({
          ...m,
          operatorName: fullName(operatorFirst, operatorLast),
        })),
      );
    } catch (e: any) {
      handleWarehouseError(res, e, "item movements");
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Reservations (T5, D2/D3) — `available` for an item, and the
  // reserve/release/consume lifecycle. Every stock-affecting step goes
  // through server/warehouse.ts (reserveStock/releaseReservation/
  // consumeReservation) — this section only validates input, resolves ids,
  // and translates engine errors into clean HTTP responses.
  // ═══════════════════════════════════════════════════════════════════════

  app.get("/api/admin/warehouse/items/:id/available", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Bad id" });
      const [item] = await db.select({ id: whItems.id }).from(whItems).where(eq(whItems.id, id));
      if (!item) return res.status(404).json({ message: "Item not found" });
      // Read-only — no need to open an explicit transaction; the row locks
      // taken inside getAvailableForItem release the instant this statement
      // completes (each is its own implicit transaction), which is fine for
      // a plain GET that isn't trying to serialize against a concurrent
      // reserveStock call.
      const available = await reservationDbFromTx(db).getAvailableForItem(id);
      res.json({ itemId: id, available });
    } catch (e: any) {
      handleWarehouseError(res, e, "item available");
    }
  });

  app.get("/api/admin/warehouse/reservations", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const itemId = req.query.itemId !== undefined ? parseId(req.query.itemId) : null;
      const refKind = clean(req.query.refKind as string | undefined);
      const refId = req.query.refId !== undefined ? parseId(req.query.refId) : null;
      const status = clean(req.query.status as string | undefined);

      const conditions = [];
      if (itemId !== null) conditions.push(eq(whReservations.itemId, itemId));
      if (refKind && isRefKind(refKind)) conditions.push(eq(whReservations.refKind, refKind));
      if (refId !== null) conditions.push(eq(whReservations.refId, refId));
      if (status && isReservationStatus(status)) conditions.push(eq(whReservations.status, status));

      const rows = await db
        .select({ reservation: whReservations, itemSku: whItems.sku, itemName: whItems.name })
        .from(whReservations)
        .innerJoin(whItems, eq(whReservations.itemId, whItems.id))
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(whReservations.createdAt));

      res.json(rows.map((r) => ({ ...r.reservation, itemSku: r.itemSku, itemName: r.itemName })));
    } catch (e: any) {
      handleWarehouseError(res, e, "reservations list");
    }
  });

  // Body: { itemId, qty, refKind, refId }. Idempotent per (refKind, refId,
  // itemId) — calling this again for the same ref+item returns the existing
  // reservation (alreadyReserved: true) rather than double-booking.
  app.post("/api/admin/warehouse/reservations", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const b = req.body || {};
      const itemId = parseId(b.itemId);
      if (itemId === null) throw new WarehouseRouteError("itemId is required");
      const [item] = await db.select({ id: whItems.id }).from(whItems).where(eq(whItems.id, itemId));
      if (!item) throw new WarehouseRouteError("itemId does not reference a real item");

      const qty = Number(b.qty);
      if (!Number.isFinite(qty) || qty <= 0) throw new WarehouseRouteError("qty must be a positive number");

      const refKind = clean(b.refKind);
      if (!refKind || !isRefKind(refKind)) throw new WarehouseRouteError(`refKind must be one of: ${REF_KINDS.join(", ")}`);
      const refId = parseId(b.refId);
      if (refId === null) throw new WarehouseRouteError("refId is required");

      const result = await runReserveStock({ itemId, qty, ref: { kind: refKind as RefKind, id: refId } });
      res.status(result.alreadyReserved ? 200 : 201).json(result);
    } catch (e: any) {
      handleWarehouseError(res, e, "reservation create");
    }
  });

  // Idempotent — releasing an already-released reservation is a no-op
  // (released: false); releasing a consumed one is a real error (the stock
  // has already left the building).
  app.post("/api/admin/warehouse/reservations/:id/release", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Bad id" });
      const result = await runReleaseReservation(id);
      res.json(result);
    } catch (e: any) {
      handleWarehouseError(res, e, "reservation release");
    }
  });

  // Body: { locationId, movementType?, reasonCode?, note?, idempotencyKey? }.
  // Posts the movement that removes the reservation's full qty from the
  // named sellable bin and marks it consumed. movementType defaults to
  // 'dispatch' (the common case — fulfilling a paid order); T7/T8's scan
  // flows will usually pass 'pick' or 'dispatch' explicitly.
  app.post("/api/admin/warehouse/reservations/:id/consume", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Bad id" });

      const b = req.body || {};
      const locationId = parseId(b.locationId);
      if (locationId === null) throw new WarehouseRouteError("locationId is required");
      const [location] = await db.select({ code: whLocations.code }).from(whLocations).where(eq(whLocations.id, locationId));
      if (!location) throw new WarehouseRouteError("locationId does not reference a real location");

      const movementTypeRaw = clean(b.movementType) ?? "dispatch";
      if (!isMovementType(movementTypeRaw)) {
        throw new WarehouseRouteError(`movementType must be one of: ${MOVEMENT_TYPES.join(", ")}`);
      }
      let reasonCode: ReasonCode | null = null;
      if (b.reasonCode !== undefined && b.reasonCode !== null && b.reasonCode !== "") {
        if (!isReasonCode(b.reasonCode)) throw new WarehouseRouteError(`reasonCode must be one of: ${REASON_CODES.join(", ")}`);
        reasonCode = b.reasonCode;
      }

      const operatorUserId = req.session.userId!;
      const result = await runConsumeReservation({
        reservationId: id,
        locationId,
        locationCode: location.code,
        movementType: movementTypeRaw as MovementType,
        reasonCode,
        operatorUserId,
        idempotencyKey: clean(b.idempotencyKey) ?? null,
        note: clean(b.note) ?? null,
      });
      res.json(result);
    } catch (e: any) {
      handleWarehouseError(res, e, "reservation consume");
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Purchase orders + receiving (T6). PO/PO-line CRUD is plain master-data
  // (never touches wh_movements/wh_stock directly — same doctrine as the
  // items/locations/aliases CRUD above); the receive-scan endpoint is the one
  // place in this section that calls into the movement engine.
  // ═══════════════════════════════════════════════════════════════════════

  app.get("/api/admin/warehouse/pos", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const q = clean(req.query.q as string | undefined);
      const status = clean(req.query.status as string | undefined);

      const conditions = [];
      if (q) conditions.push(ilike(whPurchaseOrders.supplierName, `%${q}%`));
      if (status && isPoStatus(status)) conditions.push(eq(whPurchaseOrders.status, status));

      const pos = await db
        .select()
        .from(whPurchaseOrders)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(whPurchaseOrders.createdAt));

      // Per-PO line count + total ordered qty — a second, small aggregate
      // query rather than a GROUP BY on the main select (keeps the primary
      // list query simple and filterable; this repo's other list+aggregate
      // endpoints — e.g. items' defaultLocationCode join — follow the same
      // "merge two queries in JS" shape rather than fighting drizzle's
      // builder into one).
      const poIds = pos.map((p) => p.id);
      const lineCounts = new Map<number, { lineCount: number; totalOrderedQty: number }>();
      if (poIds.length > 0) {
        const agg = await db
          .select({
            poId: whPoLines.poId,
            lineCount: sql<string>`COUNT(*)`,
            totalOrderedQty: sql<string>`COALESCE(SUM(${whPoLines.qtyOrdered}), 0)`,
          })
          .from(whPoLines)
          .where(inArray(whPoLines.poId, poIds))
          .groupBy(whPoLines.poId);
        for (const row of agg) {
          lineCounts.set(row.poId, { lineCount: Number(row.lineCount), totalOrderedQty: Number(row.totalOrderedQty) });
        }
      }

      res.json(
        pos.map((p) => ({
          ...p,
          lineCount: lineCounts.get(p.id)?.lineCount ?? 0,
          totalOrderedQty: lineCounts.get(p.id)?.totalOrderedQty ?? 0,
        })),
      );
    } catch (e: any) {
      handleWarehouseError(res, e, "POs list");
    }
  });

  app.get("/api/admin/warehouse/pos/:id", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Bad id" });
      const [po] = await db.select().from(whPurchaseOrders).where(eq(whPurchaseOrders.id, id));
      if (!po) return res.status(404).json({ message: "Purchase order not found" });

      const lines = await loadPoLinesWithReceipts(id);
      res.json({ ...po, lines });
    } catch (e: any) {
      handleWarehouseError(res, e, "PO get");
    }
  });

  app.post("/api/admin/warehouse/pos", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const b = req.body || {};
      const supplierName = clean(b.supplierName);
      if (!supplierName) throw new WarehouseRouteError("A supplier name is required");

      const statusRaw = clean(b.status) ?? "draft";
      if (!isPoStatus(statusRaw)) throw new WarehouseRouteError(`status must be one of: ${PO_STATUSES.join(", ")}`);

      let expectedOn: string | null = null;
      if (b.expectedOn !== undefined && b.expectedOn !== null && b.expectedOn !== "") {
        if (!isValidDateOnly(b.expectedOn)) throw new WarehouseRouteError("expectedOn must be a YYYY-MM-DD date");
        expectedOn = b.expectedOn;
      }

      const operatorUserId = req.session.userId!;
      const [created] = await db
        .insert(whPurchaseOrders)
        .values({
          supplierName,
          status: statusRaw,
          expectedOn,
          notes: clean(b.notes) ?? null,
          createdBy: operatorUserId,
        })
        .returning();
      res.status(201).json({ ...created, lines: [] });
    } catch (e: any) {
      handleWarehouseError(res, e, "PO create");
    }
  });

  app.patch("/api/admin/warehouse/pos/:id", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Bad id" });
      const [existing] = await db.select().from(whPurchaseOrders).where(eq(whPurchaseOrders.id, id));
      if (!existing) return res.status(404).json({ message: "Purchase order not found" });

      const b = req.body || {};
      const patch: Record<string, any> = { updatedAt: new Date() };
      if (b.supplierName !== undefined) {
        const supplierName = clean(b.supplierName);
        if (!supplierName) throw new WarehouseRouteError("Supplier name can't be blank");
        patch.supplierName = supplierName;
      }
      if (b.status !== undefined) {
        if (!isPoStatus(b.status)) throw new WarehouseRouteError(`status must be one of: ${PO_STATUSES.join(", ")}`);
        patch.status = b.status;
      }
      if (b.expectedOn !== undefined) {
        if (b.expectedOn === null || b.expectedOn === "") {
          patch.expectedOn = null;
        } else {
          if (!isValidDateOnly(b.expectedOn)) throw new WarehouseRouteError("expectedOn must be a YYYY-MM-DD date");
          patch.expectedOn = b.expectedOn;
        }
      }
      if (b.notes !== undefined) patch.notes = clean(b.notes) ?? null;

      const [updated] = await db.update(whPurchaseOrders).set(patch).where(eq(whPurchaseOrders.id, id)).returning();
      res.json(updated);
    } catch (e: any) {
      handleWarehouseError(res, e, "PO update");
    }
  });

  app.delete("/api/admin/warehouse/pos/:id", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Bad id" });
      const lineIds = (await db.select({ id: whPoLines.id }).from(whPoLines).where(eq(whPoLines.poId, id))).map((r) => r.id);
      if (lineIds.length > 0) {
        const totals = await getPoLineReceiptTotals(lineIds);
        const anyReceived = Array.from(totals.values()).some((t) => t.good + t.damaged > 0);
        if (anyReceived) {
          throw new WarehouseRouteError(
            "This PO already has receiving history — it can't be deleted (the audit trail would lose its reference). Cancel it instead.",
            409,
          );
        }
      }
      const [deleted] = await db.delete(whPurchaseOrders).where(eq(whPurchaseOrders.id, id)).returning({ id: whPurchaseOrders.id });
      if (!deleted) return res.status(404).json({ message: "Purchase order not found" });
      res.json({ ok: true });
    } catch (e: any) {
      handleWarehouseError(res, e, "PO delete");
    }
  });

  // ── PO lines ─────────────────────────────────────────────────────────────

  app.get("/api/admin/warehouse/pos/:poId/lines", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const poId = parseId(req.params.poId);
      if (poId === null) return res.status(400).json({ message: "Bad PO id" });
      const [po] = await db.select({ id: whPurchaseOrders.id }).from(whPurchaseOrders).where(eq(whPurchaseOrders.id, poId));
      if (!po) return res.status(404).json({ message: "Purchase order not found" });
      res.json(await loadPoLinesWithReceipts(poId));
    } catch (e: any) {
      handleWarehouseError(res, e, "PO lines list");
    }
  });

  app.post("/api/admin/warehouse/pos/:poId/lines", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const poId = parseId(req.params.poId);
      if (poId === null) return res.status(400).json({ message: "Bad PO id" });
      const [po] = await db.select({ id: whPurchaseOrders.id }).from(whPurchaseOrders).where(eq(whPurchaseOrders.id, poId));
      if (!po) return res.status(404).json({ message: "Purchase order not found" });

      const b = req.body || {};
      const itemId = parseId(b.itemId);
      if (itemId === null) throw new WarehouseRouteError("itemId is required");
      const [item] = await db.select({ id: whItems.id, sku: whItems.sku, name: whItems.name }).from(whItems).where(eq(whItems.id, itemId));
      if (!item) throw new WarehouseRouteError("itemId does not reference a real item");

      const qtyOrdered = Number(b.qtyOrdered);
      if (!Number.isFinite(qtyOrdered) || qtyOrdered <= 0) throw new WarehouseRouteError("qtyOrdered must be a positive number");

      const [created] = await db
        .insert(whPoLines)
        .values({
          poId,
          itemId,
          qtyOrdered: String(qtyOrdered),
          unitCostCents: toCents(b.unitCostCents, "unitCostCents") ?? null,
          notes: clean(b.notes) ?? null,
        })
        .returning();
      res.status(201).json({ ...created, itemSku: item.sku, itemName: item.name });
    } catch (e: any) {
      handleWarehouseError(res, e, "PO line create");
    }
  });

  app.patch("/api/admin/warehouse/pos/lines/:id", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Bad id" });
      const [existing] = await db.select().from(whPoLines).where(eq(whPoLines.id, id));
      if (!existing) return res.status(404).json({ message: "PO line not found" });

      const b = req.body || {};
      const patch: Record<string, any> = {};

      if (b.qtyOrdered !== undefined) {
        const totals = await getPoLineReceiptTotals([id]);
        const received = totals.get(id);
        if (received && received.good + received.damaged > 0) {
          throw new WarehouseRouteError("Can't change the quantity ordered once receiving has started on this line.", 409);
        }
        const qtyOrdered = Number(b.qtyOrdered);
        if (!Number.isFinite(qtyOrdered) || qtyOrdered <= 0) throw new WarehouseRouteError("qtyOrdered must be a positive number");
        patch.qtyOrdered = String(qtyOrdered);
      }
      if (b.unitCostCents !== undefined) patch.unitCostCents = toCents(b.unitCostCents, "unitCostCents");
      if (b.notes !== undefined) patch.notes = clean(b.notes) ?? null;

      const [updated] = await db.update(whPoLines).set(patch).where(eq(whPoLines.id, id)).returning();
      res.json(updated);
    } catch (e: any) {
      handleWarehouseError(res, e, "PO line update");
    }
  });

  app.delete("/api/admin/warehouse/pos/lines/:id", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Bad id" });
      const totals = await getPoLineReceiptTotals([id]);
      const received = totals.get(id);
      if (received && received.good + received.damaged > 0) {
        throw new WarehouseRouteError("Can't delete a PO line that already has receiving history.", 409);
      }
      const [deleted] = await db.delete(whPoLines).where(eq(whPoLines.id, id)).returning({ id: whPoLines.id });
      if (!deleted) return res.status(404).json({ message: "PO line not found" });
      res.json({ ok: true });
    } catch (e: any) {
      handleWarehouseError(res, e, "PO line delete");
    }
  });

  // ── Receiving ────────────────────────────────────────────────────────────
  // Body: { poLineId, locationId?, qtyGood?, qtyDamaged?, expectedQty?, note?,
  // idempotencyKey? }. locationId is required only when qtyGood > 0 (a
  // 100%-damaged receipt never needs a sellable destination). Posts up to two
  // legs in ONE movement group: qtyGood → locationId, qtyDamaged →
  // QUARANTINE (reason 'damaged') — then recomputes the PO's derived status
  // (SPEC §4.1/T6: qty_received is never a stored column).
  app.post("/api/admin/warehouse/pos/:poId/receive", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const poId = parseId(req.params.poId);
      if (poId === null) return res.status(400).json({ message: "Bad PO id" });
      const [po] = await db.select().from(whPurchaseOrders).where(eq(whPurchaseOrders.id, poId));
      if (!po) return res.status(404).json({ message: "Purchase order not found" });
      if (!RECEIVABLE_PO_STATUSES.has(po.status as PoStatus)) {
        if (po.status === "draft") {
          throw new WarehouseRouteError("This PO hasn't been sent yet — mark it sent before receiving against it.");
        }
        throw new WarehouseRouteError(`This PO is ${po.status} — it can't receive any more stock.`);
      }

      const b = req.body || {};
      const poLineId = parseId(b.poLineId);
      if (poLineId === null) throw new WarehouseRouteError("poLineId is required");
      const [line] = await db.select().from(whPoLines).where(eq(whPoLines.id, poLineId));
      if (!line || line.poId !== poId) throw new WarehouseRouteError("poLineId does not reference a line on this PO");

      const qtyGood = b.qtyGood !== undefined ? Number(b.qtyGood) : 0;
      const qtyDamaged = b.qtyDamaged !== undefined ? Number(b.qtyDamaged) : 0;
      if (!Number.isFinite(qtyGood) || qtyGood < 0) throw new WarehouseRouteError("qtyGood must be zero or a positive number");
      if (!Number.isFinite(qtyDamaged) || qtyDamaged < 0) throw new WarehouseRouteError("qtyDamaged must be zero or a positive number");
      if (qtyGood === 0 && qtyDamaged === 0) {
        throw new WarehouseRouteError("Nothing to receive — qtyGood and/or qtyDamaged must be greater than zero");
      }

      let goodLocation: { id: number; code: string; kind: string } | undefined;
      if (qtyGood > 0) {
        const locationId = parseId(b.locationId);
        if (locationId === null) throw new WarehouseRouteError("locationId is required to receive undamaged stock");
        const [loc] = await db
          .select({ id: whLocations.id, code: whLocations.code, kind: whLocations.kind })
          .from(whLocations)
          .where(eq(whLocations.id, locationId));
        if (!loc) throw new WarehouseRouteError("locationId does not reference a real location");
        if (loc.kind === "virtual") {
          throw new WarehouseRouteError("Can't receive stock into a virtual location — choose a real bin or zone");
        }
        goodLocation = loc;
      }

      let quarantineLocation: { id: number; code: string } | undefined;
      if (qtyDamaged > 0) {
        const [loc] = await db
          .select({ id: whLocations.id, code: whLocations.code })
          .from(whLocations)
          .where(eq(whLocations.code, QUARANTINE_ZONE));
        if (!loc) throw new WarehouseRouteError("No QUARANTINE location is set up yet — create one before receiving damaged stock");
        quarantineLocation = loc;
      }

      // expectedQty defaults to what's still outstanding on the line
      // (derived from prior receipts) — a packing-slip-driven override lets
      // the operator compare against what the supplier's paperwork actually
      // says, rather than the PO's original order quantity.
      const priorTotals = (await getPoLineReceiptTotals([poLineId])).get(poLineId) ?? { good: 0, damaged: 0 };
      const priorReceived = priorTotals.good + priorTotals.damaged;
      const outstanding = Math.max(Number(line.qtyOrdered) - priorReceived, 0);
      let expectedQty = outstanding;
      if (b.expectedQty !== undefined && b.expectedQty !== null && b.expectedQty !== "") {
        const ex = Number(b.expectedQty);
        if (!Number.isFinite(ex) || ex < 0) throw new WarehouseRouteError("expectedQty must be zero or a positive number");
        expectedQty = ex;
      }

      const discrepancy = computeReceiveDiscrepancy(expectedQty, qtyGood, qtyDamaged);
      const autoNote = receiveDiscrepancyNote(discrepancy);
      const combinedNote = [clean(b.note), autoNote].filter(Boolean).join(" — ") || null;

      const legs: MovementLeg[] = [];
      if (qtyGood > 0 && goodLocation) {
        legs.push({ itemId: line.itemId, locationId: goodLocation.id, locationCode: goodLocation.code, delta: qtyGood });
      }
      if (qtyDamaged > 0 && quarantineLocation) {
        legs.push({
          itemId: line.itemId,
          locationId: quarantineLocation.id,
          locationCode: quarantineLocation.code,
          delta: qtyDamaged,
          reasonCode: "damaged",
        });
      }

      const operatorUserId = req.session.userId!;
      const movement = await runMovementGroup({
        legs,
        movementType: "receipt",
        ref: { kind: "po", id: poLineId },
        operatorUserId,
        idempotencyKey: clean(b.idempotencyKey) ?? null,
        note: combinedNote,
      });

      // Recompute the PO's status from every line's derived receipt total —
      // safe to run even on an idempotent replay (recomputing from unchanged
      // totals just re-writes the same status).
      const lines = await loadPoLinesWithReceipts(poId);
      const nextStatus = derivePoStatusFromLines(
        po.status as PoStatus,
        lines.map((l) => ({ qtyOrdered: Number(l.qtyOrdered), qtyReceived: l.qtyReceived })),
      );
      let updatedPo = po;
      if (nextStatus !== po.status) {
        const [saved] = await db
          .update(whPurchaseOrders)
          .set({ status: nextStatus, updatedAt: new Date() })
          .where(eq(whPurchaseOrders.id, poId))
          .returning();
        updatedPo = saved;
      }

      res.status(movement.alreadyProcessed ? 200 : 201).json({
        movement,
        discrepancy,
        po: updatedPo,
        line: lines.find((l) => l.id === poLineId),
      });
    } catch (e: any) {
      handleWarehouseError(res, e, "PO receive");
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Scan resolver + putaway/transfer (T7). The scan station's core loop:
  // scan any code → resolve to item | location | unknown + valid next
  // actions (server/warehouse.ts's resolveScanCode — a bespoke ScanLookupDb
  // seam, same reasoning as WarehouseDb/ReservationDb there); putaway and
  // transfer both post a plain two-leg movement group via runMovementGroup —
  // no new engine machinery beyond what T3 already built, only a different
  // movementType label distinguishes the two (handleLocationMove above).
  // ═══════════════════════════════════════════════════════════════════════

  // Body: { code }. Never mutates anything — a pure lookup the scan station
  // calls on every single scan before deciding which action sheet to show.
  app.post("/api/admin/warehouse/scan", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const code = clean(req.body?.code);
      if (!code) throw new WarehouseRouteError("A scanned code is required");
      const result = await resolveScanCode(scanLookupDbFromDb(db), code);
      res.json(result);
    } catch (e: any) {
      handleWarehouseError(res, e, "scan resolve");
    }
  });

  app.post("/api/admin/warehouse/putaway", requireAuth, requireTab("warehouse"), (req, res) =>
    handleLocationMove(req, res, "putaway"),
  );
  app.post("/api/admin/warehouse/transfer", requireAuth, requireTab("warehouse"), (req, res) =>
    handleLocationMove(req, res, "transfer"),
  );

  // Body: { itemId, locationId, qty, printOrderId, reasonCode?, note?,
  // idempotencyKey? }. Materials consumed against a print job (SPEC
  // §4.4's "Consume→print job", §4.5's v1 scope: a human scans/enters what a
  // job used — no automated BOM consumption yet). One outbound leg, no
  // incoming leg — the same "stock leaves the building with nothing local
  // absorbing it" shape as T8's requisition pick / shop-order dispatch, just
  // referencing ref_kind 'print_order' instead. Not in scanActionsForItem's
  // advisory list (that only covers what T7 itself wired up) — T15's scan
  // station always offers "Consume" for any resolved item and this endpoint
  // is what it calls. reasonCode is optional and, if given, must be one of
  // the existing D15 codes (store_use fits production use best) — no new
  // taxonomy invented for this, same discipline as T6's damaged-only-
  // quarantine call.
  app.post("/api/admin/warehouse/consume", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const b = req.body || {};
      const itemId = parseId(b.itemId);
      if (itemId === null) throw new WarehouseRouteError("itemId is required");
      const [item] = await db
        .select({ id: whItems.id, allowNegative: whItems.allowNegative })
        .from(whItems)
        .where(eq(whItems.id, itemId));
      if (!item) throw new WarehouseRouteError("itemId does not reference a real item");

      const location = await resolveRealLocationForMove(b.locationId, "locationId");

      const qty = Number(b.qty);
      if (!Number.isFinite(qty) || qty <= 0) throw new WarehouseRouteError("qty must be a positive number");

      const printOrderId = parseId(b.printOrderId);
      if (printOrderId === null) throw new WarehouseRouteError("printOrderId is required");
      const [printOrder] = await db.select({ id: printOrders.id }).from(printOrders).where(eq(printOrders.id, printOrderId));
      if (!printOrder) throw new WarehouseRouteError("printOrderId does not reference a real print order");

      let reasonCode: ReasonCode | null = null;
      if (b.reasonCode !== undefined && b.reasonCode !== null && b.reasonCode !== "") {
        const rc = clean(b.reasonCode);
        if (!rc || !isReasonCode(rc)) throw new WarehouseRouteError(`reasonCode must be one of: ${REASON_CODES.join(", ")}`);
        reasonCode = rc;
      }

      const operatorUserId = req.session.userId!;
      const movement = await runMovementGroup({
        legs: [{ itemId, locationId: location.id, locationCode: location.code, delta: -qty, allowNegative: item.allowNegative, reasonCode }],
        movementType: "consume",
        ref: { kind: "print_order", id: printOrderId },
        operatorUserId,
        idempotencyKey: clean(b.idempotencyKey) ?? null,
        note: clean(b.note) ?? null,
      });

      res.status(movement.alreadyProcessed ? 200 : 201).json({ movement, itemId, locationId: location.id, qty, printOrderId });
    } catch (e: any) {
      handleWarehouseError(res, e, "consume");
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Label-payload endpoints — bulk lookup by id so an admin can select
  // several items/locations and print one label sheet (T14 renders the
  // actual QR SVGs client-side from these payload strings; this endpoint
  // never generates an image, only the string each QR encodes).
  // ═══════════════════════════════════════════════════════════════════════

  app.get("/api/admin/warehouse/labels/items", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const ids = parseIdList(req.query.ids);
      if (ids.length === 0) return res.json({ labels: [] });
      const rows = await db
        .select({ id: whItems.id, sku: whItems.sku, name: whItems.name })
        .from(whItems)
        .where(inArray(whItems.id, ids));
      // Item labels encode the SKU verbatim (D5/§4.4) — no prefix, so a
      // manufacturer alias scan can never be confused with a location scan
      // (locations always carry the LOC: prefix below).
      res.json({ labels: rows.map((r) => ({ id: r.id, sku: r.sku, name: r.name, payload: r.sku })) });
    } catch (e: any) {
      handleWarehouseError(res, e, "item labels");
    }
  });

  app.get("/api/admin/warehouse/labels/locations", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const ids = parseIdList(req.query.ids);
      if (ids.length === 0) return res.json({ labels: [] });
      const rows = await db
        .select({ id: whLocations.id, code: whLocations.code })
        .from(whLocations)
        .where(inArray(whLocations.id, ids));
      res.json({ labels: rows.map((r) => ({ id: r.id, code: r.code, payload: locationBarcodePayload(r.code) })) });
    } catch (e: any) {
      handleWarehouseError(res, e, "location labels");
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Requisitions end-to-end (T9/D13). Submitting is requireAuth ONLY — any
  // staff member, any workspace, can ask the warehouse for stock (same
  // universal-access spirit as the Feedback board). Everything past
  // submission — seeing the FULL queue, approve/decline, and closing the
  // loop at collection — is an operator decision behind
  // requireTab("warehouse"). 'picking'/'ready' are never accepted from a
  // client here — see the dispatch endpoint below, which recomputes them
  // from real picking activity via deriveRequisitionStatusFromLines
  // (shared/warehouse.ts). 'approve'/'decline'/'collect' stay explicit,
  // each validated against REQUISITION_TRANSITIONS.
  // ═══════════════════════════════════════════════════════════════════════

  async function loadRequisitionLines(requisitionId: number) {
    const lines = await db
      .select({
        id: whRequisitionLines.id,
        itemId: whRequisitionLines.itemId,
        qtyRequested: whRequisitionLines.qtyRequested,
        qtyPicked: whRequisitionLines.qtyPicked,
        itemSku: whItems.sku,
        itemName: whItems.name,
      })
      .from(whRequisitionLines)
      .innerJoin(whItems, eq(whRequisitionLines.itemId, whItems.id))
      .where(eq(whRequisitionLines.requisitionId, requisitionId));
    return lines.map((l) => ({ ...l, qtyRequested: Number(l.qtyRequested), qtyPicked: Number(l.qtyPicked ?? 0) }));
  }

  function fullName(first: string | null | undefined, last: string | null | undefined): string {
    return [first, last].filter(Boolean).join(" ") || "Unknown";
  }

  // ── Submit (any staff — D13) ─────────────────────────────────────────────
  app.post("/api/admin/warehouse/requisitions", requireAuth, async (req, res) => {
    try {
      const b = req.body || {};
      const chargeTo = clean(b.chargeTo);
      if (!chargeTo) throw new WarehouseRouteError("chargeTo is required (which brand/department to bill)");

      let neededBy: string | null = null;
      if (b.neededBy !== undefined && b.neededBy !== null && b.neededBy !== "") {
        if (!isValidDateOnly(b.neededBy)) throw new WarehouseRouteError("neededBy must be a YYYY-MM-DD date");
        neededBy = b.neededBy;
      }

      const rawLines = Array.isArray(b.lines) ? b.lines : [];
      if (rawLines.length === 0) throw new WarehouseRouteError("At least one line is required");
      const parsedLines: { itemId: number; qtyRequested: number }[] = [];
      for (const raw of rawLines) {
        const itemId = parseId(raw?.itemId);
        if (itemId === null) throw new WarehouseRouteError("Every line needs an itemId");
        const qtyRequested = Number(raw?.qtyRequested);
        if (!Number.isFinite(qtyRequested) || qtyRequested <= 0) {
          throw new WarehouseRouteError("Every line's qtyRequested must be a positive number");
        }
        parsedLines.push({ itemId, qtyRequested });
      }

      // Validate every itemId up front, before any insert — so a bad line
      // never leaves a lineless requisition orphaned behind it.
      const itemIds = Array.from(new Set(parsedLines.map((l) => l.itemId)));
      const items = await db
        .select({ id: whItems.id, sku: whItems.sku, name: whItems.name })
        .from(whItems)
        .where(inArray(whItems.id, itemIds));
      const itemById = new Map(items.map((i) => [i.id, i]));
      for (const l of parsedLines) {
        if (!itemById.has(l.itemId)) throw new WarehouseRouteError(`itemId ${l.itemId} does not reference a real item`);
      }

      const requestedBy = req.session.userId!;
      const [created] = await db
        .insert(whRequisitions)
        .values({ requestedBy, chargeTo, status: "submitted", neededBy, notes: clean(b.notes) ?? null })
        .returning();

      const insertedLines = await db
        .insert(whRequisitionLines)
        .values(parsedLines.map((l) => ({ requisitionId: created.id, itemId: l.itemId, qtyRequested: String(l.qtyRequested) })))
        .returning();

      res.status(201).json({
        ...created,
        lines: insertedLines.map((l) => ({
          ...l,
          qtyRequested: Number(l.qtyRequested),
          qtyPicked: 0,
          itemSku: itemById.get(l.itemId)!.sku,
          itemName: itemById.get(l.itemId)!.name,
        })),
      });
    } catch (e: any) {
      handleWarehouseError(res, e, "requisition submit");
    }
  });

  // ── Own requisitions (any staff — D13) ───────────────────────────────────
  app.get("/api/admin/warehouse/requisitions/mine", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const rows = await db
        .select()
        .from(whRequisitions)
        .where(eq(whRequisitions.requestedBy, userId))
        .orderBy(desc(whRequisitions.createdAt));
      const result: any[] = [];
      for (const r of rows) result.push({ ...r, lines: await loadRequisitionLines(r.id) });
      res.json(result);
    } catch (e: any) {
      handleWarehouseError(res, e, "my requisitions");
    }
  });

  // ── Full list + detail (operators) ──────────────────────────────────────
  app.get("/api/admin/warehouse/requisitions", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const statusRaw = clean(req.query.status as string | undefined);
      const chargeTo = clean(req.query.chargeTo as string | undefined);
      const conditions = [];
      if (statusRaw) {
        if (!isRequisitionStatus(statusRaw)) throw new WarehouseRouteError(`status must be one of: ${REQUISITION_STATUSES.join(", ")}`);
        conditions.push(eq(whRequisitions.status, statusRaw));
      }
      if (chargeTo) conditions.push(eq(whRequisitions.chargeTo, chargeTo));

      const rows = await db
        .select({
          id: whRequisitions.id,
          requestedBy: whRequisitions.requestedBy,
          chargeTo: whRequisitions.chargeTo,
          status: whRequisitions.status,
          neededBy: whRequisitions.neededBy,
          approvedBy: whRequisitions.approvedBy,
          collectedAt: whRequisitions.collectedAt,
          notes: whRequisitions.notes,
          createdAt: whRequisitions.createdAt,
          updatedAt: whRequisitions.updatedAt,
          requesterFirst: users.firstName,
          requesterLast: users.lastName,
        })
        .from(whRequisitions)
        .leftJoin(users, eq(whRequisitions.requestedBy, users.id))
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(whRequisitions.createdAt));

      const reqIds = rows.map((r) => r.id);
      const lineAgg = new Map<number, { lineCount: number; totalQtyRequested: number; totalQtyPicked: number }>();
      if (reqIds.length > 0) {
        const agg = await db
          .select({
            requisitionId: whRequisitionLines.requisitionId,
            lineCount: sql<string>`COUNT(*)`,
            totalQtyRequested: sql<string>`COALESCE(SUM(${whRequisitionLines.qtyRequested}), 0)`,
            totalQtyPicked: sql<string>`COALESCE(SUM(${whRequisitionLines.qtyPicked}), 0)`,
          })
          .from(whRequisitionLines)
          .where(inArray(whRequisitionLines.requisitionId, reqIds))
          .groupBy(whRequisitionLines.requisitionId);
        for (const row of agg) {
          lineAgg.set(row.requisitionId, {
            lineCount: Number(row.lineCount),
            totalQtyRequested: Number(row.totalQtyRequested),
            totalQtyPicked: Number(row.totalQtyPicked),
          });
        }
      }

      res.json(
        rows.map(({ requesterFirst, requesterLast, ...r }) => ({
          ...r,
          requesterName: fullName(requesterFirst, requesterLast),
          ...(lineAgg.get(r.id) ?? { lineCount: 0, totalQtyRequested: 0, totalQtyPicked: 0 }),
        })),
      );
    } catch (e: any) {
      handleWarehouseError(res, e, "requisitions list");
    }
  });

  app.get("/api/admin/warehouse/requisitions/:id", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Bad id" });
      const [r] = await db
        .select({ req: whRequisitions, requesterFirst: users.firstName, requesterLast: users.lastName })
        .from(whRequisitions)
        .leftJoin(users, eq(whRequisitions.requestedBy, users.id))
        .where(eq(whRequisitions.id, id));
      if (!r) return res.status(404).json({ message: "Requisition not found" });
      res.json({
        ...r.req,
        requesterName: fullName(r.requesterFirst, r.requesterLast),
        lines: await loadRequisitionLines(id),
      });
    } catch (e: any) {
      handleWarehouseError(res, e, "requisition get");
    }
  });

  // ── Explicit human decisions (operators) — approve/decline/collect are
  // the ONLY requisition status changes a client ever asks for directly,
  // each validated against REQUISITION_TRANSITIONS (shared/warehouse.ts).
  // 'picking'/'ready' are never set here — see the dispatch endpoint below.
  async function transitionRequisition(
    req: Request,
    res: Response,
    to: RequisitionStatus,
    verb: string,
    extra: (existing: typeof whRequisitions.$inferSelect) => Record<string, any>,
  ) {
    try {
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Bad id" });
      const [existing] = await db.select().from(whRequisitions).where(eq(whRequisitions.id, id));
      if (!existing) return res.status(404).json({ message: "Requisition not found" });
      if (!isValidRequisitionTransition(existing.status as RequisitionStatus, to)) {
        throw new WarehouseRouteError(`This requisition is ${existing.status} — it can't be ${verb} right now.`, 409);
      }
      const [updated] = await db
        .update(whRequisitions)
        .set({ status: to, updatedAt: new Date(), ...extra(existing) })
        .where(eq(whRequisitions.id, id))
        .returning();
      res.json({ ...updated, lines: await loadRequisitionLines(id) });
    } catch (e: any) {
      handleWarehouseError(res, e, `requisition ${verb}`);
    }
  }

  app.post("/api/admin/warehouse/requisitions/:id/approve", requireAuth, requireTab("warehouse"), (req, res) =>
    transitionRequisition(req, res, "approved", "approved", () => ({ approvedBy: req.session.userId! })),
  );

  app.post("/api/admin/warehouse/requisitions/:id/decline", requireAuth, requireTab("warehouse"), (req, res) =>
    transitionRequisition(req, res, "declined", "declined", (existing) => {
      const reason = clean(req.body?.reason);
      const notes = reason ? [existing.notes, `Declined: ${reason}`].filter(Boolean).join(" — ") : existing.notes;
      return { approvedBy: req.session.userId!, notes };
    }),
  );

  app.post("/api/admin/warehouse/requisitions/:id/collect", requireAuth, requireTab("warehouse"), (req, res) =>
    transitionRequisition(req, res, "collected", "collected", () => ({ collectedAt: new Date() })),
  );

  // ── Monthly chargeback report (D13's second deterrent) ──────────────────
  // Sums every 'pick' movement posted against a requisition (ref_kind=
  // 'requisition', ref_id=the requisition itself — see the dispatch
  // endpoint's requisition branch below) within an NZ calendar month, priced
  // at each item's own cost_cents (a reference figure Daniel/Dima set on the
  // item, never invented here), grouped by chargeTo. Defaults to the
  // current NZ month when none is given.
  app.get("/api/admin/warehouse/chargeback-report", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const month = clean(req.query.month as string | undefined) ?? nzTodayIso().slice(0, 7);
      if (!isValidMonth(month)) throw new WarehouseRouteError("month must be YYYY-MM");

      const rows = await db
        .select({
          chargeTo: whRequisitions.chargeTo,
          totalCentsRaw: sql<string>`COALESCE(SUM(ABS(${whMovements.delta}) * COALESCE(${whItems.costCents}, 0)), 0)`,
          totalQtyRaw: sql<string>`COALESCE(SUM(ABS(${whMovements.delta})), 0)`,
          movementCountRaw: sql<string>`COUNT(*)`,
        })
        .from(whMovements)
        .innerJoin(whRequisitions, eq(whMovements.refId, whRequisitions.id))
        .innerJoin(whItems, eq(whMovements.itemId, whItems.id))
        .where(
          and(
            eq(whMovements.refKind, "requisition"),
            eq(whMovements.movementType, "pick"),
            sql`to_char(${whMovements.createdAt} AT TIME ZONE 'Pacific/Auckland', 'YYYY-MM') = ${month}`,
          ),
        )
        .groupBy(whRequisitions.chargeTo);

      const lines = rows
        .map((r) => ({
          chargeTo: r.chargeTo,
          totalCents: Math.round(Number(r.totalCentsRaw)),
          totalQty: Number(r.totalQtyRaw),
          movementCount: Number(r.movementCountRaw),
        }))
        .sort((a, b) => b.totalCents - a.totalCents);

      res.json({ month, lines, grandTotalCents: lines.reduce((sum, l) => sum + l.totalCents, 0) });
    } catch (e: any) {
      handleWarehouseError(res, e, "chargeback report");
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Pick queue + dispatch (T8) — see shared/warehouse.ts's DISPATCH_SOURCE_
  // KINDS comment for the three-source design (native paid orders, Shopify
  // reservations, approved requisitions).
  // ═══════════════════════════════════════════════════════════════════════

  app.get("/api/admin/warehouse/pick-queue", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      // ── Native shop orders (MFL/CIC) ────────────────────────────────
      const mappedItems = await db
        .select({ id: whItems.id, sku: whItems.sku, name: whItems.name, shopVariantId: whItems.shopVariantId })
        .from(whItems)
        .where(isNotNull(whItems.shopVariantId));
      const itemByVariantId = new Map(mappedItems.map((i) => [i.shopVariantId as number, i]));

      let nativeOrders: any[] = [];
      if (mappedItems.length > 0) {
        const paidOrders = await db
          .select({ id: shopOrders.id, orderNumber: shopOrders.orderNumber, firstName: shopOrders.firstName, lastName: shopOrders.lastName, createdAt: shopOrders.createdAt })
          .from(shopOrders)
          .where(eq(shopOrders.status, "paid"))
          .orderBy(asc(shopOrders.createdAt))
          .limit(200);

        if (paidOrders.length > 0) {
          const orderIds = paidOrders.map((o) => o.id);
          const variantIds = mappedItems.map((i) => i.shopVariantId as number);
          const lines = await db
            .select({ orderId: shopOrderItems.orderId, variantId: shopOrderItems.variantId, qty: shopOrderItems.qty })
            .from(shopOrderItems)
            .where(and(inArray(shopOrderItems.orderId, orderIds), inArray(shopOrderItems.variantId, variantIds)));

          const reservations = await db
            .select({ refId: whReservations.refId, itemId: whReservations.itemId, status: whReservations.status })
            .from(whReservations)
            .where(and(eq(whReservations.refKind, "shop_order"), inArray(whReservations.refId, orderIds)));
          const reservationStatus = new Map(reservations.map((r) => [`${r.refId}:${r.itemId}`, r.status]));

          const byOrder = new Map<number, any[]>();
          for (const line of lines) {
            if (line.variantId === null) continue;
            const item = itemByVariantId.get(line.variantId);
            if (!item) continue;
            const status = reservationStatus.get(`${line.orderId}:${item.id}`);
            if (status === "consumed") continue; // already dispatched
            const arr = byOrder.get(line.orderId) ?? [];
            arr.push({ itemId: item.id, sku: item.sku, name: item.name, qty: line.qty, reserved: status === "active" });
            byOrder.set(line.orderId, arr);
          }
          nativeOrders = paidOrders
            .filter((o) => byOrder.has(o.id))
            .map((o) => ({
              sourceKind: "shop_order" as const,
              orderId: o.id,
              orderNumber: o.orderNumber,
              customerName: `${o.firstName} ${o.lastName}`.trim(),
              createdAt: o.createdAt,
              items: byOrder.get(o.id)!,
            }));
        }
      }

      // ── Shopify-reserved orders (SIU/CUFC) ──────────────────────────
      const shopifyReservations = await db
        .select({ refId: whReservations.refId, itemId: whReservations.itemId, qty: whReservations.qty, itemSku: whItems.sku, itemName: whItems.name })
        .from(whReservations)
        .innerJoin(whItems, eq(whReservations.itemId, whItems.id))
        .where(and(eq(whReservations.refKind, "shopify_order"), eq(whReservations.status, "active")))
        .orderBy(asc(whReservations.createdAt));
      const shopifyByOrder = new Map<number, any[]>();
      for (const r of shopifyReservations) {
        const arr = shopifyByOrder.get(r.refId) ?? [];
        arr.push({ itemId: r.itemId, sku: r.itemSku, name: r.itemName, qty: Number(r.qty), reserved: true });
        shopifyByOrder.set(r.refId, arr);
      }
      const shopifyOrders = Array.from(shopifyByOrder.entries()).map(([refId, items]) => ({
        sourceKind: "shopify_order" as const,
        orderId: refId,
        items,
      }));

      // ── Approved + in-progress requisitions ─────────────────────────
      // 'picking' (T9) is included alongside 'approved' — a requisition
      // auto-advances to 'picking' the moment its FIRST line is picked
      // (deriveRequisitionStatusFromLines, in the dispatch branch below), and
      // must keep surfacing here for its remaining lines until it's fully
      // picked (at which point it's 'ready' and every line's remaining
      // qty is 0 anyway, so the byReq filter below drops it naturally).
      const approved = await db
        .select()
        .from(whRequisitions)
        .where(inArray(whRequisitions.status, ["approved", "picking"]))
        .orderBy(asc(whRequisitions.neededBy));
      let requisitions: any[] = [];
      if (approved.length > 0) {
        const reqIds = approved.map((r) => r.id);
        const lines = await db
          .select({ requisitionId: whRequisitionLines.requisitionId, itemId: whRequisitionLines.itemId, qtyRequested: whRequisitionLines.qtyRequested, qtyPicked: whRequisitionLines.qtyPicked, itemSku: whItems.sku, itemName: whItems.name })
          .from(whRequisitionLines)
          .innerJoin(whItems, eq(whRequisitionLines.itemId, whItems.id))
          .where(inArray(whRequisitionLines.requisitionId, reqIds));
        const byReq = new Map<number, any[]>();
        for (const l of lines) {
          const remaining = Number(l.qtyRequested) - Number(l.qtyPicked ?? 0);
          if (remaining <= 0) continue;
          const arr = byReq.get(l.requisitionId) ?? [];
          arr.push({ itemId: l.itemId, sku: l.itemSku, name: l.itemName, qtyRemaining: remaining });
          byReq.set(l.requisitionId, arr);
        }
        requisitions = approved
          .filter((r) => byReq.has(r.id))
          .map((r) => ({
            sourceKind: "requisition" as const,
            requisitionId: r.id,
            chargeTo: r.chargeTo,
            neededBy: r.neededBy,
            requestedBy: r.requestedBy,
            items: byReq.get(r.id)!,
          }));
      }

      res.json({ nativeOrders, shopifyOrders, requisitions });
    } catch (e: any) {
      handleWarehouseError(res, e, "pick queue");
    }
  });

  // Shopify fulfilment is stubbed behind an env flag — T12's warehouse-sync.ts
  // owns the real GraphQL fulfillmentCreate call once it exists (TODO-verify
  // (live) against current shopify.dev syntax then). T8's job is only to
  // prove dispatch calls out at the right moment.
  async function notifyShopifyFulfilled(refId: number, itemId: number): Promise<void> {
    if (process.env.WH_SHOPIFY_FULFIL !== "1") return;
    console.log(`[Warehouse] (stub) would mark Shopify order ${refId} item ${itemId} fulfilled`);
  }

  // Body: { sourceKind, sourceId, itemId, locationId, qty?, idempotencyKey?,
  // note? }. sourceId is the order id (shop_order/shopify_order) or the
  // requisition id. See shared/warehouse.ts's DISPATCH_SOURCE_KINDS comment
  // for why requisitions skip the reservation path entirely.
  app.post("/api/admin/warehouse/dispatch", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const b = req.body || {};
      const sourceKind = clean(b.sourceKind);
      if (!sourceKind || !isDispatchSourceKind(sourceKind)) {
        throw new WarehouseRouteError(`sourceKind must be one of: ${DISPATCH_SOURCE_KINDS.join(", ")}`);
      }
      const sourceId = parseId(b.sourceId);
      if (sourceId === null) throw new WarehouseRouteError("sourceId is required");
      const itemId = parseId(b.itemId);
      if (itemId === null) throw new WarehouseRouteError("itemId is required");
      // allowNegative (D16) matters here — unlike the receiving/putaway
      // legs elsewhere in this file, a requisition draw builds its leg
      // directly below (not via buildLocationMoveLegs/consumeReservation),
      // so it must fetch + apply the item's own flag itself or a bulk
      // material with allow_negative=true would wrongly hit the
      // non-negative guard on an internal stock draw.
      const [item] = await db.select({ id: whItems.id, allowNegative: whItems.allowNegative }).from(whItems).where(eq(whItems.id, itemId));
      if (!item) throw new WarehouseRouteError("itemId does not reference a real item");

      const location = await resolveRealLocationForMove(b.locationId, "locationId");
      const operatorUserId = req.session.userId!;
      const idempotencyKey = clean(b.idempotencyKey) ?? null;
      const note = clean(b.note) ?? null;

      if (sourceKind === "requisition") {
        // The whole point of the approval step (D13) is that stock can't
        // leave the building on a requisition nobody signed off on — so
        // this needs its own status gate here, at the point stock actually
        // moves, the same way T6's receive endpoint gates on
        // RECEIVABLE_PO_STATUSES. 'picking' is included alongside 'approved'
        // (T9) — the FIRST pick against an approved requisition auto-advances
        // it to 'picking' below, and a second/later dispatch call against the
        // SAME (now 'picking') requisition must still be allowed; only
        // GET /pick-queue's own query needed the parallel update (T9) since
        // this is the only place status is actually read for the gate.
        const [requisition] = await db.select({ status: whRequisitions.status }).from(whRequisitions).where(eq(whRequisitions.id, sourceId));
        if (!requisition) throw new WarehouseRouteError("sourceId does not reference a real requisition");
        if (requisition.status !== "approved" && requisition.status !== "picking") {
          throw new WarehouseRouteError(`This requisition is ${requisition.status} — it can't be picked against right now.`);
        }

        const [line] = await db
          .select()
          .from(whRequisitionLines)
          .where(and(eq(whRequisitionLines.requisitionId, sourceId), eq(whRequisitionLines.itemId, itemId)));
        if (!line) throw new WarehouseRouteError("No requisition line for this item on this requisition");
        const alreadyPicked = Number(line.qtyPicked ?? 0);
        const remaining = Number(line.qtyRequested) - alreadyPicked;
        if (remaining <= 0) throw new WarehouseRouteError("This line has already been fully picked");
        const qty = b.qty !== undefined ? Number(b.qty) : remaining;
        if (!Number.isFinite(qty) || qty <= 0) throw new WarehouseRouteError("qty must be a positive number");
        if (qty > remaining) throw new WarehouseRouteError(`Only ${remaining} remaining to pick on this line`);

        const movement = await runMovementGroup({
          legs: [{ itemId, locationId: location.id, locationCode: location.code, delta: -qty, allowNegative: item.allowNegative }],
          movementType: "pick",
          ref: { kind: "requisition", id: sourceId },
          operatorUserId,
          idempotencyKey,
          note,
        });
        let updatedRequisitionStatus: RequisitionStatus = requisition.status as RequisitionStatus;
        if (!movement.alreadyProcessed) {
          await db.update(whRequisitionLines).set({ qtyPicked: String(alreadyPicked + qty) }).where(eq(whRequisitionLines.id, line.id));

          // T9: recompute the requisition's own status from EVERY line's
          // freshly-updated picked total — the ledger's own activity trail
          // (this movement) is what drives approved→picking→ready, never a
          // client PATCH (shared/warehouse.ts's deriveRequisitionStatusFromLines).
          const allLines = await db
            .select({ qtyRequested: whRequisitionLines.qtyRequested, qtyPicked: whRequisitionLines.qtyPicked })
            .from(whRequisitionLines)
            .where(eq(whRequisitionLines.requisitionId, sourceId));
          const nextStatus = deriveRequisitionStatusFromLines(
            requisition.status as RequisitionStatus,
            allLines.map((l) => ({ qtyRequested: Number(l.qtyRequested), qtyPicked: Number(l.qtyPicked ?? 0) })),
          );
          if (nextStatus !== requisition.status) {
            await db.update(whRequisitions).set({ status: nextStatus, updatedAt: new Date() }).where(eq(whRequisitions.id, sourceId));
          }
          updatedRequisitionStatus = nextStatus;
        }
        return res.status(movement.alreadyProcessed ? 200 : 201).json({
          movement,
          sourceKind,
          sourceId,
          itemId,
          qty,
          requisitionStatus: updatedRequisitionStatus,
        });
      }

      if (sourceKind === "shopify_order") {
        const [reservation] = await db
          .select({ id: whReservations.id })
          .from(whReservations)
          .where(and(
            eq(whReservations.refKind, "shopify_order"),
            eq(whReservations.refId, sourceId),
            eq(whReservations.itemId, itemId),
            eq(whReservations.status, "active"),
          ));
        if (!reservation) throw new WarehouseRouteError("No active reservation for this Shopify order + item");

        const result = await runConsumeReservation({
          reservationId: reservation.id,
          locationId: location.id,
          locationCode: location.code,
          movementType: "dispatch",
          operatorUserId,
          idempotencyKey,
          note,
        });
        if (!result.movement.alreadyProcessed) await notifyShopifyFulfilled(sourceId, itemId);
        return res.status(result.movement.alreadyProcessed ? 200 : 201).json({ ...result, sourceKind, sourceId });
      }

      // sourceKind === "shop_order" — no reservation exists yet (T13 hasn't
      // wired payment-time reserveStock); reserve (idempotent, T5) then
      // consume in the same call, backfilling what T13 will one day do
      // earlier in the order's life.
      const [order] = await db.select().from(shopOrders).where(eq(shopOrders.id, sourceId));
      if (!order) throw new WarehouseRouteError("sourceId does not reference a real order");
      if (order.status !== "paid") throw new WarehouseRouteError(`Order is ${order.status}, not paid — nothing to dispatch`);

      const [line] = await db
        .select({ qty: shopOrderItems.qty })
        .from(shopOrderItems)
        .innerJoin(whItems, eq(whItems.shopVariantId, shopOrderItems.variantId))
        .where(and(eq(shopOrderItems.orderId, sourceId), eq(whItems.id, itemId)));
      if (!line) throw new WarehouseRouteError("This item isn't on this order (or isn't WMS-mapped)");

      const reserved = await runReserveStock({ itemId, qty: line.qty, ref: { kind: "shop_order", id: sourceId } });
      const result = await runConsumeReservation({
        reservationId: reserved.reservationId,
        locationId: location.id,
        locationCode: location.code,
        movementType: "dispatch",
        operatorUserId,
        idempotencyKey,
        note,
      });

      // Mark source: once every WMS-mapped item on the order is dispatched,
      // advance it past 'paid' into shop-routes.ts's existing fulfilment
      // pipeline. A partially-dispatched order stays 'paid' so its
      // remaining lines still surface in this same pick queue.
      if (!result.movement.alreadyProcessed) {
        const orderItems = await db.select({ variantId: shopOrderItems.variantId }).from(shopOrderItems).where(eq(shopOrderItems.orderId, sourceId));
        const variantIds = orderItems.map((o) => o.variantId).filter((v): v is number => v !== null);
        const mappedOrderItemIds = variantIds.length > 0
          ? await db.select({ id: whItems.id }).from(whItems).where(inArray(whItems.shopVariantId, variantIds))
          : [];
        const consumedReservations = await db
          .select({ itemId: whReservations.itemId })
          .from(whReservations)
          .where(and(eq(whReservations.refKind, "shop_order"), eq(whReservations.refId, sourceId), eq(whReservations.status, "consumed")));
        const consumedIds = new Set(consumedReservations.map((r) => r.itemId));
        const fullyDispatched = mappedOrderItemIds.length > 0 && mappedOrderItemIds.every((i) => consumedIds.has(i.id));
        if (fullyDispatched) {
          // Same convention shop-routes.ts itself already uses in three
          // places (admin order detail, order-share view, resend-
          // confirmation) to tell a shipped order from a pickup one — a
          // pickup/no-shipping order never has addressLine1 populated.
          // Cheaper and more consistent than joining shop_shipping_options,
          // which can lag/disagree with what was actually captured at
          // checkout time.
          const requiresAddress = !!order.addressLine1;
          const nextStatus = nextOrderStatusAfterDispatch(requiresAddress);
          await db.update(shopOrders).set({ status: nextStatus, updatedAt: new Date() }).where(eq(shopOrders.id, sourceId));
        }
      }

      res.status(result.movement.alreadyProcessed ? 200 : 201).json({ ...result, sourceKind, sourceId });
    } catch (e: any) {
      handleWarehouseError(res, e, "dispatch");
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Equipment loans (T10/D14) — library/tool-crib model. Check-out creates
  // the wh_loans/wh_loan_lines parent rows AND posts the outbound loan_out
  // movement (one leg per line, no incoming leg — a borrower isn't a
  // wh_location, exactly the same "stock leaves the building with nothing
  // local absorbing it" shape as T8's requisition pick/shop-order dispatch)
  // in ONE database transaction — unlike every other route in this file,
  // this is the first case where a NEW parent record is created in the same
  // call as a stock movement, so an insufficient-stock failure must roll
  // back the loan record too (never leave a dangling "checked out" row with
  // no movement behind it). Return posts loan_return legs to a real bin the
  // operator names, then stamps each line's condition grade — the derived
  // signal (shared/warehouse.ts's deriveLoanStatusFromLines) that flips the
  // loan's own stored status once every line has one. Only one grade per
  // line (no partial-quantity return, same v1 scope-cut as T5's
  // consumeReservation always consuming a reservation's full qty).
  // ═══════════════════════════════════════════════════════════════════════

  async function loadLoanLines(loanId: number) {
    const lines = await db
      .select({
        id: whLoanLines.id,
        loanId: whLoanLines.loanId,
        itemId: whLoanLines.itemId,
        qty: whLoanLines.qty,
        conditionGrade: whLoanLines.conditionGrade,
        conditionNote: whLoanLines.conditionNote,
        replacementChargedCents: whLoanLines.replacementChargedCents,
        itemSku: whItems.sku,
        itemName: whItems.name,
      })
      .from(whLoanLines)
      .innerJoin(whItems, eq(whLoanLines.itemId, whItems.id))
      .where(eq(whLoanLines.loanId, loanId))
      .orderBy(asc(whLoanLines.id));
    return lines.map((l) => ({ ...l, qty: Number(l.qty) }));
  }

  function withOverdue<T extends { status: string; dueOn: string }>(loan: T): T & { overdue: boolean } {
    return { ...loan, overdue: isLoanOverdue({ status: loan.status as LoanStatus, dueOn: loan.dueOn }, nzTodayIso()) };
  }

  // ── List + detail ─────────────────────────────────────────────────────────
  app.get("/api/admin/warehouse/loans", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const statusRaw = clean(req.query.status as string | undefined);
      const overdueOnly = req.query.overdue === "true";
      const q = clean(req.query.q as string | undefined);
      const borrowerContactId = req.query.borrowerContactId !== undefined ? parseId(req.query.borrowerContactId) : null;

      const conditions = [];
      if (statusRaw) {
        if (!isLoanStatus(statusRaw)) throw new WarehouseRouteError(`status must be one of: ${LOAN_STATUSES.join(", ")}`);
        conditions.push(eq(whLoans.status, statusRaw));
      }
      if (borrowerContactId !== null) conditions.push(eq(whLoans.borrowerContactId, borrowerContactId));
      if (q) conditions.push(ilike(whLoans.borrowerName, `%${q}%`));

      const rows = await db
        .select()
        .from(whLoans)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(asc(whLoans.dueOn));

      let result = rows.map(withOverdue);
      if (overdueOnly) result = result.filter((r) => r.overdue);

      const loanIds = result.map((r) => r.id);
      const lineAgg = new Map<number, { lineCount: number; totalQty: number }>();
      if (loanIds.length > 0) {
        const agg = await db
          .select({
            loanId: whLoanLines.loanId,
            lineCount: sql<string>`COUNT(*)`,
            totalQty: sql<string>`COALESCE(SUM(${whLoanLines.qty}), 0)`,
          })
          .from(whLoanLines)
          .where(inArray(whLoanLines.loanId, loanIds))
          .groupBy(whLoanLines.loanId);
        for (const row of agg) lineAgg.set(row.loanId, { lineCount: Number(row.lineCount), totalQty: Number(row.totalQty) });
      }

      res.json(result.map((r) => ({ ...r, ...(lineAgg.get(r.id) ?? { lineCount: 0, totalQty: 0 }) })));
    } catch (e: any) {
      handleWarehouseError(res, e, "loans list");
    }
  });

  app.get("/api/admin/warehouse/loans/:id", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Bad id" });
      const [loan] = await db.select().from(whLoans).where(eq(whLoans.id, id));
      if (!loan) return res.status(404).json({ message: "Loan not found" });
      res.json({ ...withOverdue(loan), lines: await loadLoanLines(id) });
    } catch (e: any) {
      handleWarehouseError(res, e, "loan get");
    }
  });

  // ── Check-out ─────────────────────────────────────────────────────────────
  // Body: { borrowerName, borrowerContactId?, dueOn, notes?, lines: [{itemId,
  // qty, locationId?}], note? }. Deliberately does NOT accept a client
  // idempotencyKey (unlike receive/putaway/dispatch/reservations) — a retry
  // of this endpoint always inserts a brand-new wh_loans/wh_loan_lines row
  // (same "no dedup on the parent record" reality as PO/requisition create,
  // neither of which take one either), so honouring a replayed key on JUST
  // the movement half would short-circuit postMovementGroup against a PRIOR
  // loan's movement group while a second, phantom loan row still commits —
  // a confusing mismatch, not real retry-safety. locationId per line is
  // optional only when the item has its own defaultLocationId set — the loan
  // has to know a real bin to draw stock FROM (wh_loan_lines itself carries
  // no location column; it's only ever used to build the movement leg, same
  // as a PO line's receive-time locationId is never stored on the line
  // either).
  app.post("/api/admin/warehouse/loans", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const b = req.body || {};
      const borrowerName = clean(b.borrowerName);
      if (!borrowerName) throw new WarehouseRouteError("borrowerName is required");

      if (!isValidDateOnly(b.dueOn)) throw new WarehouseRouteError("dueOn must be a YYYY-MM-DD date");
      const dueOn = b.dueOn as string;

      let borrowerContactId: number | null = null;
      if (b.borrowerContactId !== undefined && b.borrowerContactId !== null && b.borrowerContactId !== "") {
        const cid = parseId(b.borrowerContactId);
        if (cid === null) throw new WarehouseRouteError("borrowerContactId must be a number");
        const [contact] = await db.select({ id: contacts.id }).from(contacts).where(eq(contacts.id, cid));
        if (!contact) throw new WarehouseRouteError("borrowerContactId does not reference a real contact");
        borrowerContactId = cid;
      }

      const rawLines = Array.isArray(b.lines) ? b.lines : [];
      if (rawLines.length === 0) throw new WarehouseRouteError("At least one line is required");
      const parsedLines: { itemId: number; qty: number; locationIdRaw: unknown }[] = [];
      for (const raw of rawLines) {
        const itemId = parseId(raw?.itemId);
        if (itemId === null) throw new WarehouseRouteError("Every line needs an itemId");
        const qty = Number(raw?.qty);
        if (!Number.isFinite(qty) || qty <= 0) throw new WarehouseRouteError("Every line's qty must be a positive number");
        parsedLines.push({ itemId, qty, locationIdRaw: raw?.locationId });
      }

      // Validate every itemId (and that it's actually loanable, D14) up
      // front, before any insert — same "no bad line leaves an orphaned
      // parent record behind" discipline as requisition submit (T9).
      const itemIds = Array.from(new Set(parsedLines.map((l) => l.itemId)));
      const items = await db
        .select({
          id: whItems.id, sku: whItems.sku, name: whItems.name,
          isLoanable: whItems.isLoanable, allowNegative: whItems.allowNegative,
          defaultLocationId: whItems.defaultLocationId,
        })
        .from(whItems)
        .where(inArray(whItems.id, itemIds));
      const itemById = new Map(items.map((i) => [i.id, i]));
      for (const l of parsedLines) {
        const item = itemById.get(l.itemId);
        if (!item) throw new WarehouseRouteError(`itemId ${l.itemId} does not reference a real item`);
        if (!item.isLoanable) throw new WarehouseRouteError(`${item.sku} is not marked as loanable — mark it is_loanable before it can be checked out`);
      }

      // Resolve + validate each line's real (non-virtual) checkout location —
      // an explicit locationId per line, or the item's own defaultLocationId
      // when the caller doesn't name one.
      const legs: MovementLeg[] = [];
      for (const l of parsedLines) {
        const item = itemById.get(l.itemId)!;
        const candidate = l.locationIdRaw ?? item.defaultLocationId;
        if (candidate === null || candidate === undefined || candidate === "") {
          throw new WarehouseRouteError(`No locationId given for ${item.sku} and it has no default location set — pass one explicitly`);
        }
        const location = await resolveRealLocationForMove(candidate, `locationId for ${item.sku}`);
        legs.push({ itemId: item.id, locationId: location.id, locationCode: location.code, delta: -l.qty, allowNegative: item.allowNegative });
      }

      const operatorUserId = req.session.userId!;
      const note = clean(b.note) ?? null;

      // ONE transaction: the loan/lines rows and the loan_out movement commit
      // or roll back together (see this section's header comment for why —
      // unlike PO/requisition creation, a loan's parent row and its stock
      // movement are the same real-world event). No idempotencyKey here — see
      // the header comment above for why one can't safely apply to only half
      // of this operation.
      const { loan, insertedLines, movement } = await db.transaction(async (tx) => {
        const [loanRow] = await tx
          .insert(whLoans)
          .values({ borrowerName, borrowerContactId, dueOn, status: "out", operatorUserId, notes: clean(b.notes) ?? null })
          .returning();
        const lines = await tx
          .insert(whLoanLines)
          .values(parsedLines.map((l) => ({ loanId: loanRow.id, itemId: l.itemId, qty: String(l.qty) })))
          .returning();
        const movementResult = await postMovementGroup(warehouseDbFromTx(tx), {
          legs,
          movementType: "loan_out",
          ref: { kind: "loan", id: loanRow.id },
          operatorUserId,
          idempotencyKey: null,
          note,
        });
        return { loan: loanRow, insertedLines: lines, movement: movementResult };
      });
      if (!movement.alreadyProcessed) notifyMovementCommitted(movement.affectedItemIds);

      res.status(201).json({
        ...withOverdue(loan),
        lines: insertedLines.map((l) => ({
          ...l,
          qty: Number(l.qty),
          itemSku: itemById.get(l.itemId)!.sku,
          itemName: itemById.get(l.itemId)!.name,
        })),
        movement,
      });
    } catch (e: any) {
      handleWarehouseError(res, e, "loan check-out");
    }
  });

  // ── Return ────────────────────────────────────────────────────────────────
  // Body: { lines: [{loanLineId, locationId, conditionGrade, conditionNote?,
  // replacementChargedCents?}], idempotencyKey?, note? }. Posts ONE movement
  // group (one inbound leg per returned line — a receive-shaped, N-leg group
  // like T6's receive endpoint, generalised past 2 legs) THEN — only for a
  // genuinely new movement, never a replay — stamps each line's condition
  // grade and recomputes the loan's own derived status. A line already
  // graded can't be returned again (guards a real double-process, not just
  // the exact-replay case idempotencyKey already covers).
  app.post("/api/admin/warehouse/loans/:id/return", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Bad id" });
      const [loan] = await db.select().from(whLoans).where(eq(whLoans.id, id));
      if (!loan) return res.status(404).json({ message: "Loan not found" });
      if (loan.status === "returned") throw new WarehouseRouteError("This loan has already been fully returned");

      const b = req.body || {};
      const rawLines = Array.isArray(b.lines) ? b.lines : [];
      if (rawLines.length === 0) throw new WarehouseRouteError("At least one line is required");
      // The same loanLineId can't appear twice in one call — the
      // conditionGrade-already-set guard below only protects against
      // returning a line that was graded in a PRIOR call; within this same
      // batch every line starts "ungraded" in existingById, so a duplicate
      // would otherwise post two inbound legs for one physical item and
      // silently double-credit stock.
      const rawLoanLineIds = rawLines.map((raw: any) => raw?.loanLineId);
      if (new Set(rawLoanLineIds).size !== rawLoanLineIds.length) {
        throw new WarehouseRouteError("The same loanLineId was given more than once in this return");
      }

      const existingLines = await loadLoanLines(id);
      const existingById = new Map(existingLines.map((l) => [l.id, l]));

      interface ParsedReturnLine {
        loanLineId: number;
        locationId: number;
        locationCode: string;
        conditionGrade: ConditionGrade;
        conditionNote: string | null;
        replacementChargedCents: number | null;
        qty: number;
        itemId: number;
      }
      const parsed: ParsedReturnLine[] = [];
      for (const raw of rawLines) {
        const loanLineId = parseId(raw?.loanLineId);
        if (loanLineId === null) throw new WarehouseRouteError("Every line needs a loanLineId");
        const existing = existingById.get(loanLineId);
        if (!existing) throw new WarehouseRouteError(`loanLineId ${loanLineId} does not reference a line on this loan`);
        if (existing.conditionGrade != null) throw new WarehouseRouteError(`${existing.itemSku} on this loan has already been returned`);

        const conditionGrade = clean(raw?.conditionGrade);
        if (!conditionGrade || !isConditionGrade(conditionGrade)) {
          throw new WarehouseRouteError(`conditionGrade must be one of: ${CONDITION_GRADES.join(", ")}`);
        }
        const location = await resolveRealLocationForMove(raw?.locationId, `locationId for ${existing.itemSku}`);
        parsed.push({
          loanLineId,
          locationId: location.id,
          locationCode: location.code,
          conditionGrade,
          conditionNote: clean(raw?.conditionNote) ?? null,
          replacementChargedCents: toChargeCents(raw?.replacementChargedCents),
          qty: existing.qty,
          itemId: existing.itemId,
        });
      }

      const legs: MovementLeg[] = parsed.map((l) => ({
        itemId: l.itemId,
        locationId: l.locationId,
        locationCode: l.locationCode,
        delta: l.qty,
        reasonCode: reasonCodeForConditionGrade(l.conditionGrade),
      }));

      const operatorUserId = req.session.userId!;
      const movement = await runMovementGroup({
        legs,
        movementType: "loan_return",
        ref: { kind: "loan", id },
        operatorUserId,
        idempotencyKey: clean(b.idempotencyKey) ?? null,
        note: clean(b.note) ?? null,
      });

      let updatedLoan = loan;
      if (!movement.alreadyProcessed) {
        for (const l of parsed) {
          await db
            .update(whLoanLines)
            .set({
              conditionGrade: l.conditionGrade,
              conditionNote: l.conditionNote,
              replacementChargedCents: l.replacementChargedCents,
            })
            .where(eq(whLoanLines.id, l.loanLineId));
        }

        // Recompute the loan's own status from EVERY line's freshly-updated
        // grade (D14's sibling of derivePoStatusFromLines/deriveRequisition-
        // StatusFromLines) — never accepted directly from the client.
        const allLines = await loadLoanLines(id);
        const nextStatus = deriveLoanStatusFromLines(
          loan.status as LoanStatus,
          allLines.map((l) => ({ conditionGrade: l.conditionGrade as ConditionGrade | null })),
        );
        if (nextStatus !== loan.status) {
          const [saved] = await db
            .update(whLoans)
            .set({ status: nextStatus, returnedAt: nextStatus === "returned" ? new Date() : loan.returnedAt })
            .where(eq(whLoans.id, id))
            .returning();
          updatedLoan = saved;
        }
      }

      res.status(movement.alreadyProcessed ? 200 : 201).json({ ...withOverdue(updatedLoan), lines: await loadLoanLines(id), movement });
    } catch (e: any) {
      handleWarehouseError(res, e, "loan return");
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Cycle counts (T11, D12) — blind sessions, snapshot-then-count, variance
  // review, counter≠approver, approved variance posts adjustment movements.
  //
  // Session lifecycle is the short chain in shared/warehouse.ts
  // (COUNT_TRANSITIONS/isValidCountTransition): open -> submitted -> approved,
  // no reopen. `expected_qty` is snapshotted from wh_stock the INSTANT the
  // session is created (never recomputed later, even if other movements land
  // in the same bins while counting is in progress — a count is a snapshot
  // of a moment, not a live query) and is hidden from every line the API
  // returns whenever shouldHideExpectedQty(blind, status) says so — the ONE
  // place that decision is made, so no route accidentally leaks it a
  // different way. A separate, ALWAYS-full "variance" endpoint exists
  // for the approver's review before deciding whether to approve (PLAN's own
  // "variance list" deliverable) — both endpoints are still requireTab
  // ("warehouse")-gated staff-only; the blind/full split is a process
  // safeguard against the counter anchoring on the expected number, not an
  // access-control boundary between two kinds of login.
  // ═══════════════════════════════════════════════════════════════════════

  async function loadCountLines(countId: number) {
    const rows = await db
      .select({
        id: whCountLines.id,
        countId: whCountLines.countId,
        itemId: whCountLines.itemId,
        locationId: whCountLines.locationId,
        expectedQty: whCountLines.expectedQty,
        countedQty: whCountLines.countedQty,
        resolution: whCountLines.resolution,
        itemSku: whItems.sku,
        itemName: whItems.name,
        costCents: whItems.costCents,
        allowNegative: whItems.allowNegative,
        locationCode: whLocations.code,
      })
      .from(whCountLines)
      .innerJoin(whItems, eq(whCountLines.itemId, whItems.id))
      .innerJoin(whLocations, eq(whCountLines.locationId, whLocations.id))
      .where(eq(whCountLines.countId, countId))
      .orderBy(asc(whLocations.code), asc(whItems.sku));

    return rows.map((r) => {
      const expectedQty = Number(r.expectedQty);
      const countedQty = r.countedQty != null ? Number(r.countedQty) : null;
      return {
        id: r.id,
        countId: r.countId,
        itemId: r.itemId,
        locationId: r.locationId,
        locationCode: r.locationCode,
        itemSku: r.itemSku,
        itemName: r.itemName,
        costCents: r.costCents,
        allowNegative: r.allowNegative,
        expectedQty,
        countedQty,
        resolution: r.resolution as CountLineResolution | null,
        varianceQty: countedQty !== null ? countLineVarianceQty(expectedQty, countedQty) : null,
        needsRecount: countedQty !== null ? countLineNeedsRecount(expectedQty, countedQty, r.costCents) : false,
      };
    });
  }

  /** Strips everything that would leak (or let a counter reverse-engineer)
   *  the expected quantity — used whenever shouldHideExpectedQty says the
   *  session is still blind and in progress. */
  function blindCountLine(l: Awaited<ReturnType<typeof loadCountLines>>[number]) {
    return {
      id: l.id, countId: l.countId, itemId: l.itemId, locationId: l.locationId,
      locationCode: l.locationCode, itemSku: l.itemSku, itemName: l.itemName,
      countedQty: l.countedQty,
    };
  }

  function presentCountLines(lines: Awaited<ReturnType<typeof loadCountLines>>, count: { blind: boolean; status: string }) {
    return shouldHideExpectedQty(count.blind, count.status as CountStatus) ? lines.map(blindCountLine) : lines;
  }

  // ── Create session (scope zone/class, blind default true) ───────────────
  // Auto-populates lines from CURRENT wh_stock in the given scope — the
  // scope selects which EXISTING (item, location) stock rows get
  // snapshotted, never a synthetic full cross-product of every item against
  // every bin, and never a virtual location (no printed label anyone would
  // ever count against). Validated non-empty BEFORE any insert so a scope
  // matching nothing never creates an orphaned, lineless session.
  app.post("/api/admin/warehouse/counts", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const b = req.body || {};
      const scopeZone = clean(b.scopeZone) ?? null;
      const scopeClass = clean(b.scopeClass) ?? null;
      const blindFlag = toBool(b.blind, true);

      let countedBy: number | null = req.session.userId!;
      if (b.countedBy !== undefined && b.countedBy !== null && b.countedBy !== "") {
        const cid = parseId(b.countedBy);
        if (cid === null) throw new WarehouseRouteError("countedBy must be a number");
        const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, cid));
        if (!user) throw new WarehouseRouteError("countedBy does not reference a real user");
        countedBy = cid;
      }

      const scopeConditions = [ne(whLocations.kind, "virtual")];
      if (scopeZone) scopeConditions.push(eq(whLocations.zone, scopeZone));
      if (scopeClass) scopeConditions.push(eq(whItems.category, scopeClass));
      const stockRows = await db
        .select({ itemId: whStock.itemId, locationId: whStock.locationId, onHand: whStock.onHand })
        .from(whStock)
        .innerJoin(whLocations, eq(whStock.locationId, whLocations.id))
        .innerJoin(whItems, eq(whStock.itemId, whItems.id))
        .where(and(...scopeConditions));
      if (stockRows.length === 0) {
        throw new WarehouseRouteError("No stock found matching that scope — nothing to count");
      }

      const { created, lineCount } = await db.transaction(async (tx) => {
        const [countRow] = await tx
          .insert(whCounts)
          .values({ scopeZone, scopeClass, blind: blindFlag, countedBy, status: "open" })
          .returning();
        const lines = await tx
          .insert(whCountLines)
          .values(
            stockRows.map((r) => ({
              countId: countRow.id,
              itemId: r.itemId,
              locationId: r.locationId,
              expectedQty: r.onHand, // already the numeric column's string form — no round-trip needed
            })),
          )
          .returning({ id: whCountLines.id });
        return { created: countRow, lineCount: lines.length };
      });

      res.status(201).json({ ...created, lineCount });
    } catch (e: any) {
      handleWarehouseError(res, e, "count create");
    }
  });

  // ── List + detail ─────────────────────────────────────────────────────────
  app.get("/api/admin/warehouse/counts", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const statusRaw = clean(req.query.status as string | undefined);
      const scopeZone = clean(req.query.scopeZone as string | undefined);
      const scopeClass = clean(req.query.scopeClass as string | undefined);

      const conditions = [];
      if (statusRaw) {
        if (!isCountStatus(statusRaw)) throw new WarehouseRouteError(`status must be one of: ${COUNT_STATUSES.join(", ")}`);
        conditions.push(eq(whCounts.status, statusRaw));
      }
      if (scopeZone) conditions.push(eq(whCounts.scopeZone, scopeZone));
      if (scopeClass) conditions.push(eq(whCounts.scopeClass, scopeClass));

      const rows = await db
        .select()
        .from(whCounts)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(whCounts.createdAt));

      const countIds = rows.map((r) => r.id);
      const agg = new Map<number, { lineCount: number; countedLineCount: number; recountLineCount: number }>();
      if (countIds.length > 0) {
        const aggRows = await db
          .select({
            countId: whCountLines.countId,
            lineCount: sql<string>`COUNT(*)`,
            countedLineCount: sql<string>`COUNT(*) FILTER (WHERE ${whCountLines.countedQty} IS NOT NULL)`,
            recountLineCount: sql<string>`COUNT(*) FILTER (WHERE ${whCountLines.resolution} = 'recount')`,
          })
          .from(whCountLines)
          .where(inArray(whCountLines.countId, countIds))
          .groupBy(whCountLines.countId);
        for (const r of aggRows) {
          agg.set(r.countId, {
            lineCount: Number(r.lineCount),
            countedLineCount: Number(r.countedLineCount),
            recountLineCount: Number(r.recountLineCount),
          });
        }
      }

      res.json(rows.map((r) => ({ ...r, ...(agg.get(r.id) ?? { lineCount: 0, countedLineCount: 0, recountLineCount: 0 }) })));
    } catch (e: any) {
      handleWarehouseError(res, e, "counts list");
    }
  });

  app.get("/api/admin/warehouse/counts/:id", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Bad id" });
      const [count] = await db.select().from(whCounts).where(eq(whCounts.id, id));
      if (!count) return res.status(404).json({ message: "Count not found" });
      const lines = await loadCountLines(id);
      res.json({ ...count, lines: presentCountLines(lines, count) });
    } catch (e: any) {
      handleWarehouseError(res, e, "count get");
    }
  });

  // ── Variance list (D12) — the approver's ALWAYS-full review, regardless
  // of blind/status. This is deliberately a SEPARATE endpoint from the
  // detail GET above (which honours shouldHideExpectedQty) rather than a
  // query flag on it — a query-param toggle on the same route would make
  // "show me the expected quantity" one character away for whoever built the
  // counter-facing screen, where a distinct URL has to be deliberately
  // called by the approval screen instead. ─────────────────────────────────
  app.get("/api/admin/warehouse/counts/:id/variance", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Bad id" });
      const [count] = await db.select().from(whCounts).where(eq(whCounts.id, id));
      if (!count) return res.status(404).json({ message: "Count not found" });
      const lines = await loadCountLines(id);
      const varianceLines = lines.filter((l) => l.varianceQty !== null && l.varianceQty !== 0);
      res.json({
        ...count,
        lines: varianceLines,
        recountFlaggedCount: varianceLines.filter((l) => l.resolution === "recount").length,
      });
    } catch (e: any) {
      handleWarehouseError(res, e, "count variance");
    }
  });

  // ── Record counted quantities (counter, one or more lines per call) ─────
  app.post("/api/admin/warehouse/counts/:id/count", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Bad id" });
      const [count] = await db.select().from(whCounts).where(eq(whCounts.id, id));
      if (!count) return res.status(404).json({ message: "Count not found" });
      if (count.status === "approved") throw new WarehouseRouteError("This count has already been approved");

      const rawLines = Array.isArray(req.body?.lines) ? req.body.lines : [];
      if (rawLines.length === 0) throw new WarehouseRouteError("At least one line is required");
      const rawLineIds = rawLines.map((raw: any) => raw?.lineId);
      if (new Set(rawLineIds).size !== rawLineIds.length) {
        throw new WarehouseRouteError("The same lineId was given more than once in this call");
      }

      const existingById = new Map((await loadCountLines(id)).map((l) => [l.id, l]));
      const updates: { lineId: number; countedQty: number; resolution: CountLineResolution }[] = [];
      for (const raw of rawLines) {
        const lineId = parseId(raw?.lineId);
        if (lineId === null) throw new WarehouseRouteError("Every line needs a lineId");
        const existing = existingById.get(lineId);
        if (!existing) throw new WarehouseRouteError(`lineId ${lineId} does not reference a line on this count`);
        const countedQty = Number(raw?.countedQty);
        if (!Number.isFinite(countedQty) || countedQty < 0) {
          throw new WarehouseRouteError(`${existing.itemSku} at ${existing.locationCode}: countedQty must be a non-negative number`);
        }
        updates.push({
          lineId,
          countedQty,
          resolution: countLineResolution(existing.expectedQty, countedQty, existing.costCents),
        });
      }

      for (const u of updates) {
        await db
          .update(whCountLines)
          .set({ countedQty: String(u.countedQty), resolution: u.resolution })
          .where(eq(whCountLines.id, u.lineId));
      }

      const updatedLines = await loadCountLines(id);
      const touchedIds = new Set(updates.map((u) => u.lineId));
      const touched = updatedLines.filter((l) => touchedIds.has(l.id));
      res.json({ id: count.id, status: count.status, lines: presentCountLines(touched, count) });
    } catch (e: any) {
      handleWarehouseError(res, e, "count record");
    }
  });

  // ── Submit (open -> submitted) — every line must have a count on file ───
  app.post("/api/admin/warehouse/counts/:id/submit", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Bad id" });
      const [count] = await db.select().from(whCounts).where(eq(whCounts.id, id));
      if (!count) return res.status(404).json({ message: "Count not found" });
      if (!isValidCountTransition(count.status as CountStatus, "submitted")) {
        throw new WarehouseRouteError(`This count is ${count.status} — it can't be submitted right now.`, 409);
      }

      const lines = await loadCountLines(id);
      const uncounted = lines.filter((l) => l.countedQty === null);
      if (uncounted.length > 0) {
        throw new WarehouseRouteError(`${uncounted.length} line(s) still need a count before this session can be submitted`);
      }

      const [updated] = await db
        .update(whCounts)
        .set({ status: "submitted", submittedAt: new Date() })
        .where(eq(whCounts.id, id))
        .returning();
      res.json({ ...updated, lines: presentCountLines(lines, updated) });
    } catch (e: any) {
      handleWarehouseError(res, e, "count submit");
    }
  });

  // ── Approve (submitted -> approved) — counter ≠ approver (D12); posts ONE
  // adjustment movement group (reason 'count_variance') for every line whose
  // count actually differed, then flips the session's own status. The
  // movement post and the status flip share ONE db.transaction() (not
  // runMovementGroup's self-contained one) so a retry after a partial
  // failure can never re-post the same adjustments — approve takes no
  // client idempotencyKey at all, same reasoning as requisition approve/
  // decline/collect: canApproveCount's status check is what makes a second
  // call a clean 409 once the first one has actually committed. ──────────
  app.post("/api/admin/warehouse/counts/:id/approve", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Bad id" });
      const [count] = await db.select().from(whCounts).where(eq(whCounts.id, id));
      if (!count) return res.status(404).json({ message: "Count not found" });

      const approverUserId = req.session.userId!;
      if (!canApproveCount({ status: count.status as CountStatus, countedBy: count.countedBy }, approverUserId)) {
        if (!isValidCountTransition(count.status as CountStatus, "approved")) {
          throw new WarehouseRouteError(`This count is ${count.status} — it can't be approved right now.`, 409);
        }
        throw new WarehouseRouteError("The person who counted this session can't also approve it — get a different approver.", 409);
      }

      const lines = await loadCountLines(id);
      const legs = buildCountAdjustmentLegs(lines);
      const note = clean(req.body?.note) ?? null;

      const { movement, updatedCount } = await db.transaction(async (tx) => {
        let movementResult: Awaited<ReturnType<typeof postMovementGroup>> | null = null;
        if (legs.length > 0) {
          movementResult = await postMovementGroup(warehouseDbFromTx(tx), {
            legs,
            movementType: "adjustment",
            reasonCode: "count_variance",
            ref: { kind: "count", id },
            operatorUserId: approverUserId,
            idempotencyKey: null,
            note,
          });
        }
        const [saved] = await tx
          .update(whCounts)
          .set({ status: "approved", approvedBy: approverUserId, approvedAt: new Date() })
          .where(eq(whCounts.id, id))
          .returning();
        return { movement: movementResult, updatedCount: saved };
      });
      if (movement && !movement.alreadyProcessed) notifyMovementCommitted(movement.affectedItemIds);

      res.json({ ...updatedCount, lines: await loadCountLines(id), movement });
    } catch (e: any) {
      handleWarehouseError(res, e, "count approve");
    }
  });
}
