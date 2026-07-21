// ─────────────────────────────────────────────────────────────────────────────
// MAINTENANCE — cleaning/consumable supplies and machines & equipment at the
// United Sports Centre. Sibling of housing-routes.ts (same workspace, same
// house style): admin only (session + the "maintenance" tab), org-scoped to
// the workspace the request came from. No public surface.
//
//   GET    /api/admin/maintenance/overview
//   GET    /api/admin/maintenance/supplies              POST /api/admin/maintenance/supplies
//   PATCH  /api/admin/maintenance/supplies/:id          DELETE (archives if it has movements)
//   GET    /api/admin/maintenance/supplies/:id/movements  POST — record a stock movement
//   GET    /api/admin/maintenance/assets                POST /api/admin/maintenance/assets
//   PATCH  /api/admin/maintenance/assets/:id            DELETE (retires if it has service records)
//   GET    /api/admin/maintenance/assets/:id/services     POST — log a service
//
// Money is integer cents on the wire and in the DB; the client renders dollars.
// Dates are ISO calendar strings, never round-tripped through a `Date`. Stock
// and service status are DERIVED (shared/maintenance.ts) — never trusted from
// a stored column. Every list endpoint includes `today` (NZ) so the client
// never has to invent one.
// ─────────────────────────────────────────────────────────────────────────────
import type { Express, Request, Response } from "express";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "./db";
import { requireAuth, requireTab } from "./auth";
import { storage } from "./storage";
import {
  organizations,
  maintSupplies, maintStockMovements, maintAssets, maintServiceRecords,
} from "@shared/schema";
import {
  isSupplyCategory, isSupplyStatus, isStockMovementReason,
  isAssetCategory, isAssetStatus, isServiceRecordKind,
  isIsoDate, nzTodayIso,
  supplyStockStatus, assetServiceStatus,
} from "@shared/maintenance";

// ── Small helpers (mirrors server/housing-routes.ts) ────────────────────────
const s = (v: any, max = 500): string => String(v ?? "").trim().slice(0, max);
const sOrNull = (v: any, max = 500): string | null => { const t = s(v, max); return t ? t : null; };
const truthy = (v: any) => v === true || v === "true" || v === "1";

/** Parse an integer cents amount from the request. Rejects NaN, negatives and
 *  floats — a bad amount must be a 400, never a silent 0. */
function cents(v: any, { allowNull = false } = {}): number | null | undefined {
  if (v === null || v === undefined || v === "") return allowNull ? null : undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 1_000_000_000) return undefined;
  return n;
}

/** Parse a plain (non-money) quantity — a whole number, zero or positive. */
function qty(v: any, { allowNull = false } = {}): number | null | undefined {
  if (v === null || v === undefined || v === "") return allowNull ? null : undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 10_000_000) return undefined;
  return n;
}

/** A stock movement's delta may be positive or negative, but never zero — a
 *  zero-quantity movement is not an event worth logging. */
function nonZeroDelta(v: any): number | undefined {
  const n = Number(v);
  if (!Number.isInteger(n) || n === 0 || Math.abs(n) > 10_000_000) return undefined;
  return n;
}

/** Accept only a bare `YYYY-MM-DD`. A timestamp here is how dates slip a day.
 *  With `allowNull`, an empty string or omission clears/leaves-null the field —
 *  what an empty `<input type="date">` sends. */
function isoDate(v: any, { allowNull = false } = {}): string | null | undefined {
  if (v === null || v === undefined || v === "") return allowNull ? null : undefined;
  const raw = s(v, 10);
  return isIsoDate(raw) ? raw : undefined;
}

const id = (v: any): number | null => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

class BadRequestErr extends Error {}
class NotFoundErr extends Error {}

// ── Org scoping (mirrors workspaceOrg in routes.ts, which isn't exported) ─────
async function workspaceOrg(req: Request): Promise<{ id: number; slug: string } | null> {
  const slug = String(req.headers["x-workspace-slug"] || "").trim();
  if (!slug) return null;
  const [org] = await db.select().from(organizations).where(eq(organizations.slug, slug));
  return org ? { id: org.id, slug: org.slug } : null;
}

/** Every handler starts here. A missing/unknown workspace header is a 400, not
 *  an unscoped query — a maintenance row must never leak across workspaces. */
async function orgOr400(req: Request, res: Response): Promise<{ id: number } | null> {
  const org = await workspaceOrg(req);
  if (!org) {
    res.status(400).json({ message: "X-Workspace-Slug header required" });
    return null;
  }
  return org;
}

const fail = (res: Response, e: any) => {
  console.error("[maintenance]", e?.message || e);
  res.status(500).json({ message: e?.message || "Maintenance request failed" });
};

/** Who did this? Best-effort — falls back to null rather than blocking the
 *  action if the session lookup fails for any reason. */
async function recordedByFromSession(req: Request): Promise<string | null> {
  const userId = req.session.userId;
  if (!userId) return null;
  const user = await storage.getUser(userId).catch(() => null);
  if (!user) return null;
  const name = `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim();
  return name || user.email || null;
}

export function registerMaintenanceRoutes(app: Express) {
  const tab = requireTab("maintenance");

  // ── Overview ───────────────────────────────────────────────────────────────
  app.get("/api/admin/maintenance/overview", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const today = nzTodayIso();

      const [supplies, assets] = await Promise.all([
        db.select().from(maintSupplies).where(eq(maintSupplies.organizationId, org.id)),
        db.select().from(maintAssets).where(eq(maintAssets.organizationId, org.id)),
      ]);

      // Archived supplies / retired assets never count — supplyStockStatus and
      // assetServiceStatus both read "ok" for those, so filtering isn't even
      // needed here: the wrapper functions already zero them out.
      const outOfStock = supplies.filter((sp) => supplyStockStatus(sp) === "out").length;
      const lowStock = supplies.filter((sp) => supplyStockStatus(sp) === "low").length;
      const servicesOverdue = assets.filter((a) => assetServiceStatus(a, today) === "overdue").length;
      const servicesDueSoon = assets.filter((a) => assetServiceStatus(a, today) === "due_soon").length;
      const unauditedMachines = assets.filter((a) => assetServiceStatus(a, today) === "unknown").length;

      res.json({ today, outOfStock, lowStock, servicesOverdue, servicesDueSoon, unauditedMachines });
    } catch (e) { fail(res, e); }
  });

  // ── Supplies ───────────────────────────────────────────────────────────────
  app.get("/api/admin/maintenance/supplies", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const today = nzTodayIso();
      const includeArchived = truthy(req.query.includeArchived);

      const rows = await db.select().from(maintSupplies)
        .where(includeArchived
          ? eq(maintSupplies.organizationId, org.id)
          : and(eq(maintSupplies.organizationId, org.id), eq(maintSupplies.status, "active")))
        .orderBy(asc(maintSupplies.name));

      res.json({ today, supplies: rows.map((r) => ({ ...r, stockStatus: supplyStockStatus(r) })) });
    } catch (e) { fail(res, e); }
  });

  app.post("/api/admin/maintenance/supplies", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const name = s(req.body?.name, 160);
      if (!name) return res.status(400).json({ message: "Supply name is required" });

      const category = s(req.body?.category, 20) || "other";
      if (!isSupplyCategory(category)) return res.status(400).json({ message: "Unknown category" });

      const qtyOnHand = qty(req.body?.qtyOnHand ?? 0);
      if (qtyOnHand === undefined) return res.status(400).json({ message: "Quantity on hand must be a whole number, zero or more" });
      const reorderLevel = qty(req.body?.reorderLevel, { allowNull: true });
      if (reorderLevel === undefined) return res.status(400).json({ message: "Reorder level must be a whole number, zero or more" });
      const costCents = cents(req.body?.costCents, { allowNull: true });
      if (costCents === undefined) return res.status(400).json({ message: "Cost must be a whole number of cents" });

      const [row] = await db.insert(maintSupplies).values({
        organizationId: org.id, name, category,
        unit: sOrNull(req.body?.unit, 40),
        qtyOnHand: qtyOnHand ?? 0,
        reorderLevel: reorderLevel ?? null,
        location: sOrNull(req.body?.location, 200),
        supplier: sOrNull(req.body?.supplier, 200),
        costCents: costCents ?? null,
        notes: sOrNull(req.body?.notes, 2000),
      }).returning();
      res.status(201).json({ ...row, stockStatus: supplyStockStatus(row) });
    } catch (e) { fail(res, e); }
  });

  app.patch("/api/admin/maintenance/supplies/:id", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const supplyId = id(req.params.id);
      if (!supplyId) return res.status(400).json({ message: "Bad id" });

      // Quantity changes go through POST .../movements ONLY — that's what keeps
      // the stock-movement log complete. A direct PATCH to qtyOnHand would let
      // stock drift with no record of why.
      if (req.body?.qtyOnHand !== undefined) {
        return res.status(400).json({ message: "Adjust stock via a stock movement, not a direct edit" });
      }

      const patch: Record<string, any> = { updatedAt: new Date() };
      if (req.body?.name !== undefined) {
        const name = s(req.body.name, 160);
        if (!name) return res.status(400).json({ message: "Supply name is required" });
        patch.name = name;
      }
      if (req.body?.category !== undefined) {
        if (!isSupplyCategory(req.body.category)) return res.status(400).json({ message: "Unknown category" });
        patch.category = req.body.category;
      }
      if (req.body?.unit !== undefined) patch.unit = sOrNull(req.body.unit, 40);
      if (req.body?.reorderLevel !== undefined) {
        const v = qty(req.body.reorderLevel, { allowNull: true });
        if (v === undefined) return res.status(400).json({ message: "Reorder level must be a whole number, zero or more" });
        patch.reorderLevel = v;
      }
      if (req.body?.location !== undefined) patch.location = sOrNull(req.body.location, 200);
      if (req.body?.supplier !== undefined) patch.supplier = sOrNull(req.body.supplier, 200);
      if (req.body?.costCents !== undefined) {
        const v = cents(req.body.costCents, { allowNull: true });
        if (v === undefined) return res.status(400).json({ message: "Cost must be a whole number of cents" });
        patch.costCents = v;
      }
      if (req.body?.notes !== undefined) patch.notes = sOrNull(req.body.notes, 2000);
      if (req.body?.status !== undefined) {
        if (!isSupplyStatus(req.body.status)) return res.status(400).json({ message: "Unknown status" });
        patch.status = req.body.status;
      }

      const [row] = await db.update(maintSupplies).set(patch)
        .where(and(eq(maintSupplies.id, supplyId), eq(maintSupplies.organizationId, org.id))).returning();
      if (!row) return res.status(404).json({ message: "Supply not found" });
      res.json({ ...row, stockStatus: supplyStockStatus(row) });
    } catch (e) { fail(res, e); }
  });

  // Deleting a supply that has ever had a stock movement ARCHIVES it instead —
  // the movement log is a record of what happened, not a disposable list.
  app.delete("/api/admin/maintenance/supplies/:id", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const supplyId = id(req.params.id);
      if (!supplyId) return res.status(400).json({ message: "Bad id" });

      const movements = await db.select({ id: maintStockMovements.id }).from(maintStockMovements)
        .where(eq(maintStockMovements.supplyId, supplyId));

      if (movements.length > 0) {
        const [row] = await db.update(maintSupplies).set({ status: "archived", updatedAt: new Date() })
          .where(and(eq(maintSupplies.id, supplyId), eq(maintSupplies.organizationId, org.id))).returning();
        if (!row) return res.status(404).json({ message: "Supply not found" });
        return res.json({ archived: true, reason: `${movements.length} stock movement(s) kept` });
      }

      const [row] = await db.delete(maintSupplies)
        .where(and(eq(maintSupplies.id, supplyId), eq(maintSupplies.organizationId, org.id))).returning();
      if (!row) return res.status(404).json({ message: "Supply not found" });
      res.json({ deleted: true });
    } catch (e) { fail(res, e); }
  });

  // ── Stock movements ────────────────────────────────────────────────────────
  app.get("/api/admin/maintenance/supplies/:id/movements", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const supplyId = id(req.params.id);
      if (!supplyId) return res.status(400).json({ message: "Bad id" });

      const [supply] = await db.select().from(maintSupplies)
        .where(and(eq(maintSupplies.id, supplyId), eq(maintSupplies.organizationId, org.id)));
      if (!supply) return res.status(404).json({ message: "Supply not found" });

      const rows = await db.select().from(maintStockMovements)
        .where(eq(maintStockMovements.supplyId, supplyId))
        .orderBy(desc(maintStockMovements.createdAt));

      res.json({ today: nzTodayIso(), movements: rows });
    } catch (e) { fail(res, e); }
  });

  // A movement INSERT and the qty_on_hand UPDATE happen in one transaction, and
  // the UPDATE's WHERE clause is the real guarantee against going negative —
  // guarding with a separate SELECT-then-UPDATE would leave a race between two
  // concurrent adjustments. Reject with 400; never clamp to 0 silently.
  app.post("/api/admin/maintenance/supplies/:id/movements", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const supplyId = id(req.params.id);
      if (!supplyId) return res.status(400).json({ message: "Bad id" });

      const delta = nonZeroDelta(req.body?.delta);
      if (delta === undefined) return res.status(400).json({ message: "Amount must be a non-zero whole number" });
      const reason = s(req.body?.reason, 20);
      if (!isStockMovementReason(reason)) return res.status(400).json({ message: "Unknown reason" });
      const note = sOrNull(req.body?.note, 1000);
      const recordedBy = await recordedByFromSession(req);

      const result = await db.transaction(async (tx) => {
        const updated = await tx.update(maintSupplies)
          .set({ qtyOnHand: sql`${maintSupplies.qtyOnHand} + ${delta}`, updatedAt: new Date() })
          .where(and(
            eq(maintSupplies.id, supplyId),
            eq(maintSupplies.organizationId, org.id),
            sql`${maintSupplies.qtyOnHand} + ${delta} >= 0`,
          ))
          .returning();

        if (updated.length === 0) {
          const [supply] = await tx.select().from(maintSupplies)
            .where(and(eq(maintSupplies.id, supplyId), eq(maintSupplies.organizationId, org.id)));
          if (!supply) throw new NotFoundErr("Supply not found");
          throw new BadRequestErr(`Not enough stock — ${supply.qtyOnHand} on hand, ${Math.abs(delta)} requested`);
        }

        const [movement] = await tx.insert(maintStockMovements).values({
          supplyId, organizationId: org.id, delta, reason, note, recordedBy,
        }).returning();

        return { movement, supply: updated[0] };
      });

      res.status(201).json({ ...result, supply: { ...result.supply, stockStatus: supplyStockStatus(result.supply) } });
    } catch (e: any) {
      if (e instanceof NotFoundErr) return res.status(404).json({ message: e.message });
      if (e instanceof BadRequestErr) return res.status(400).json({ message: e.message });
      fail(res, e);
    }
  });

  // ── Assets (machines & equipment) ─────────────────────────────────────────
  app.get("/api/admin/maintenance/assets", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const today = nzTodayIso();
      const includeRetired = truthy(req.query.includeRetired);

      const rows = await db.select().from(maintAssets)
        .where(includeRetired
          ? eq(maintAssets.organizationId, org.id)
          : and(eq(maintAssets.organizationId, org.id), eq(maintAssets.status, "active")))
        .orderBy(asc(maintAssets.name));

      res.json({ today, assets: rows.map((r) => ({ ...r, serviceStatus: assetServiceStatus(r, today) })) });
    } catch (e) { fail(res, e); }
  });

  app.post("/api/admin/maintenance/assets", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const name = s(req.body?.name, 160);
      if (!name) return res.status(400).json({ message: "Asset name is required" });

      const category = s(req.body?.category, 20) || "other";
      if (!isAssetCategory(category)) return res.status(400).json({ message: "Unknown category" });

      const purchaseDate = isoDate(req.body?.purchaseDate, { allowNull: true });
      if (purchaseDate === undefined) return res.status(400).json({ message: "Purchase date must be YYYY-MM-DD" });
      const purchaseCostCents = cents(req.body?.purchaseCostCents, { allowNull: true });
      if (purchaseCostCents === undefined) return res.status(400).json({ message: "Purchase cost must be a whole number of cents" });
      const lastServicedOn = isoDate(req.body?.lastServicedOn, { allowNull: true });
      if (lastServicedOn === undefined) return res.status(400).json({ message: "Last serviced date must be YYYY-MM-DD" });
      const nextServiceDueOn = isoDate(req.body?.nextServiceDueOn, { allowNull: true });
      if (nextServiceDueOn === undefined) return res.status(400).json({ message: "Next service due date must be YYYY-MM-DD" });

      const [row] = await db.insert(maintAssets).values({
        organizationId: org.id, name, category,
        make: sOrNull(req.body?.make, 120),
        model: sOrNull(req.body?.model, 120),
        serial: sOrNull(req.body?.serial, 120),
        location: sOrNull(req.body?.location, 200),
        purchaseDate: purchaseDate ?? null,
        purchaseCostCents: purchaseCostCents ?? null,
        lastServicedOn: lastServicedOn ?? null,
        nextServiceDueOn: nextServiceDueOn ?? null,
        notes: sOrNull(req.body?.notes, 2000),
      }).returning();

      const today = nzTodayIso();
      res.status(201).json({ ...row, serviceStatus: assetServiceStatus(row, today) });
    } catch (e) { fail(res, e); }
  });

  app.patch("/api/admin/maintenance/assets/:id", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const assetId = id(req.params.id);
      if (!assetId) return res.status(400).json({ message: "Bad id" });

      // last_serviced_on / next_service_due_on are set by logging a service
      // (POST .../services) so the dates on screen always trace to a record of
      // why they changed. A direct edit here would let them drift silently.
      if (req.body?.lastServicedOn !== undefined || req.body?.nextServiceDueOn !== undefined) {
        return res.status(400).json({ message: "Log a service to change service dates, not a direct edit" });
      }

      const patch: Record<string, any> = { updatedAt: new Date() };
      if (req.body?.name !== undefined) {
        const name = s(req.body.name, 160);
        if (!name) return res.status(400).json({ message: "Asset name is required" });
        patch.name = name;
      }
      if (req.body?.category !== undefined) {
        if (!isAssetCategory(req.body.category)) return res.status(400).json({ message: "Unknown category" });
        patch.category = req.body.category;
      }
      if (req.body?.make !== undefined) patch.make = sOrNull(req.body.make, 120);
      if (req.body?.model !== undefined) patch.model = sOrNull(req.body.model, 120);
      if (req.body?.serial !== undefined) patch.serial = sOrNull(req.body.serial, 120);
      if (req.body?.location !== undefined) patch.location = sOrNull(req.body.location, 200);
      if (req.body?.purchaseDate !== undefined) {
        const v = isoDate(req.body.purchaseDate, { allowNull: true });
        if (v === undefined) return res.status(400).json({ message: "Purchase date must be YYYY-MM-DD" });
        patch.purchaseDate = v;
      }
      if (req.body?.purchaseCostCents !== undefined) {
        const v = cents(req.body.purchaseCostCents, { allowNull: true });
        if (v === undefined) return res.status(400).json({ message: "Purchase cost must be a whole number of cents" });
        patch.purchaseCostCents = v;
      }
      if (req.body?.notes !== undefined) patch.notes = sOrNull(req.body.notes, 2000);
      if (req.body?.status !== undefined) {
        if (!isAssetStatus(req.body.status)) return res.status(400).json({ message: "Unknown status" });
        patch.status = req.body.status;
      }

      const [row] = await db.update(maintAssets).set(patch)
        .where(and(eq(maintAssets.id, assetId), eq(maintAssets.organizationId, org.id))).returning();
      if (!row) return res.status(404).json({ message: "Asset not found" });
      const today = nzTodayIso();
      res.json({ ...row, serviceStatus: assetServiceStatus(row, today) });
    } catch (e) { fail(res, e); }
  });

  // Deleting an asset that has ever had a service record RETIRES it instead —
  // service history is what proves the mower was looked after.
  app.delete("/api/admin/maintenance/assets/:id", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const assetId = id(req.params.id);
      if (!assetId) return res.status(400).json({ message: "Bad id" });

      const records = await db.select({ id: maintServiceRecords.id }).from(maintServiceRecords)
        .where(eq(maintServiceRecords.assetId, assetId));

      if (records.length > 0) {
        const [row] = await db.update(maintAssets).set({ status: "retired", updatedAt: new Date() })
          .where(and(eq(maintAssets.id, assetId), eq(maintAssets.organizationId, org.id))).returning();
        if (!row) return res.status(404).json({ message: "Asset not found" });
        return res.json({ retired: true, reason: `${records.length} service record(s) kept` });
      }

      const [row] = await db.delete(maintAssets)
        .where(and(eq(maintAssets.id, assetId), eq(maintAssets.organizationId, org.id))).returning();
      if (!row) return res.status(404).json({ message: "Asset not found" });
      res.json({ deleted: true });
    } catch (e) { fail(res, e); }
  });

  // ── Service records ────────────────────────────────────────────────────────
  app.get("/api/admin/maintenance/assets/:id/services", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const assetId = id(req.params.id);
      if (!assetId) return res.status(400).json({ message: "Bad id" });

      const [asset] = await db.select().from(maintAssets)
        .where(and(eq(maintAssets.id, assetId), eq(maintAssets.organizationId, org.id)));
      if (!asset) return res.status(404).json({ message: "Asset not found" });

      const rows = await db.select().from(maintServiceRecords)
        .where(eq(maintServiceRecords.assetId, assetId))
        .orderBy(desc(maintServiceRecords.servicedOn), desc(maintServiceRecords.createdAt));

      res.json({ today: nzTodayIso(), services: rows });
    } catch (e) { fail(res, e); }
  });

  // Logging a service updates the asset's last_serviced_on (MAX of existing vs
  // new — a backdated record must never rewind the most recent service date)
  // and, only when the request actually included nextDueOn, next_service_due_on.
  // Both happen in the same transaction as the record insert.
  app.post("/api/admin/maintenance/assets/:id/services", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const assetId = id(req.params.id);
      if (!assetId) return res.status(400).json({ message: "Bad id" });

      const [asset] = await db.select().from(maintAssets)
        .where(and(eq(maintAssets.id, assetId), eq(maintAssets.organizationId, org.id)));
      if (!asset) return res.status(404).json({ message: "Asset not found" });

      const servicedOn = isoDate(req.body?.servicedOn);
      if (!servicedOn) return res.status(400).json({ message: "Service date must be YYYY-MM-DD" });
      const kind = s(req.body?.kind, 20) || "service";
      if (!isServiceRecordKind(kind)) return res.status(400).json({ message: "Unknown service kind" });
      const costCents = cents(req.body?.costCents, { allowNull: true });
      if (costCents === undefined) return res.status(400).json({ message: "Cost must be a whole number of cents" });

      const nextDueOnGiven = req.body?.nextDueOn !== undefined;
      const nextDueOn = isoDate(req.body?.nextDueOn, { allowNull: true });
      if (nextDueOn === undefined) return res.status(400).json({ message: "Next due date must be YYYY-MM-DD" });

      const performedBy = sOrNull(req.body?.performedBy, 160);
      const notes = sOrNull(req.body?.notes, 2000);

      const result = await db.transaction(async (tx) => {
        const [record] = await tx.insert(maintServiceRecords).values({
          assetId, organizationId: org.id, servicedOn, kind,
          performedBy, costCents: costCents ?? null, nextDueOn: nextDueOn ?? null, notes,
        }).returning();

        // MAX via plain string comparison — ISO dates compare correctly
        // lexicographically, so no Date round-trip is needed.
        const newLast = !asset.lastServicedOn || servicedOn > asset.lastServicedOn ? servicedOn : asset.lastServicedOn;
        const patch: Record<string, any> = { lastServicedOn: newLast, updatedAt: new Date() };
        if (nextDueOnGiven) patch.nextServiceDueOn = nextDueOn;

        const [updatedAsset] = await tx.update(maintAssets).set(patch)
          .where(eq(maintAssets.id, assetId)).returning();

        return { record, asset: updatedAsset };
      });

      const today = nzTodayIso();
      res.status(201).json({ ...result, asset: { ...result.asset, serviceStatus: assetServiceStatus(result.asset, today) } });
    } catch (e) { fail(res, e); }
  });
}
