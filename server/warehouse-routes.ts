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
import { and, asc, desc, eq, ilike, inArray, isNotNull, or, sql } from "drizzle-orm";
import { db } from "./db";
import { requireAuth, requireTab } from "./auth";
import {
  whItems, whLocations, whBarcodeAliases, whReservations, whPurchaseOrders, whPoLines,
  whRequisitions, whRequisitionLines,
  shopOrders, shopOrderItems,
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
  type ItemKind, type BrandOwner, type Unit, type LocationKind,
  type RefKind, type MovementType, type ReasonCode, type PoStatus,
} from "@shared/warehouse";
import {
  runReserveStock,
  runReleaseReservation,
  runConsumeReservation,
  runMovementGroup,
  reservationDbFromTx,
  resolveScanCode,
  scanLookupDbFromDb,
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

      // ── Approved requisitions ────────────────────────────────────────
      const approved = await db.select().from(whRequisitions).where(eq(whRequisitions.status, "approved")).orderBy(asc(whRequisitions.neededBy));
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
        // RECEIVABLE_PO_STATUSES. This mirrors GET /pick-queue's own
        // "approved requisitions" filter exactly (T9 owns the actual
        // approve/decline/picking/ready/collected status transitions —
        // this only refuses to dispatch against one that isn't currently
        // approved).
        const [requisition] = await db.select({ status: whRequisitions.status }).from(whRequisitions).where(eq(whRequisitions.id, sourceId));
        if (!requisition) throw new WarehouseRouteError("sourceId does not reference a real requisition");
        if (requisition.status !== "approved") {
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
        if (!movement.alreadyProcessed) {
          await db.update(whRequisitionLines).set({ qtyPicked: String(alreadyPicked + qty) }).where(eq(whRequisitionLines.id, line.id));
        }
        return res.status(movement.alreadyProcessed ? 200 : 201).json({ movement, sourceKind, sourceId, itemId, qty });
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
}
