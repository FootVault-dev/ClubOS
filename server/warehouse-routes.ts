// ─────────────────────────────────────────────────────────────────────────────
// Warehouse (WMS) — master data: items, locations, barcode aliases.
//
// United Prints workspace. Everything here is gated by requireTab("warehouse")
// (dark-launched — super_admin only until T17 adds "warehouse" to
// shared/tabs.ts's SUPER_ADMIN_ONLY_TABS + printsTabs; requireTab already
// short-circuits to `next()` for super_admin regardless of tab wiring, so
// these routes work today even though the tab doesn't exist in the UI yet).
//
// This file owns the CRUD + search + label-payload surface (T4). It does NOT
// touch wh_movements/wh_stock — no stock is ever created, changed or moved
// here; that is exclusively server/warehouse.ts's postMovementGroup (T3),
// called by later route groups (T5 reservations, T6 receiving, T7 scan,
// T8 pick/dispatch, T9 requisitions, T10 loans, T11 counts).
//
// House rules followed (AGENTS.md): no DB CHECKs on open value sets — every
// enum-ish field (kind, brandOwner, unit, locationKind) is validated against
// shared/warehouse.ts; quantities are numeric(12,3) columns that Drizzle maps
// to strings, converted explicitly at this edge; money (costCents) is integer
// cents; unique-violation (23505) and FK-restrict-violation (23503) Postgres
// error codes are caught and turned into clean 409s rather than raw 500s.
// ─────────────────────────────────────────────────────────────────────────────
import type { Express, Response } from "express";
import { and, asc, eq, ilike, inArray, or } from "drizzle-orm";
import { db } from "./db";
import { requireAuth, requireTab } from "./auth";
import { whItems, whLocations, whBarcodeAliases } from "@shared/schema";
import {
  ITEM_KINDS, isItemKind,
  BRAND_OWNERS, isBrandOwner,
  UNITS, isUnit,
  LOCATION_KINDS, isLocationKind,
  isValidLocationCode, normaliseLocationCode, deriveLocationZone,
  isValidSku, normaliseSku,
  normaliseAliasCode,
  locationBarcodePayload,
  type ItemKind, type BrandOwner, type Unit, type LocationKind,
} from "@shared/warehouse";

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
}
