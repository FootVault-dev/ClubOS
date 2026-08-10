// Warehouse models API (D32–D35) — the model layer above the barcoded
// variants, and the autocomplete/CSV the counting cockpit runs on.
//
// Source requirement: Dima's "AIMS Stocktake Module — Spec v3" (apps/stocktake/).
// Its first named gap was that the model→variant hierarchy did not exist; the
// migration gave it a home, this gives it an API.
//
// Registered alongside warehouse-routes.ts and warehouse-v2-routes.ts, in its
// own module for the same reason v2 exists — those two are already 3,200 and
// 1,000 lines. Every route is gated by requireTab("warehouse"), exactly as they
// are.
//
// 🔴 The one non-obvious rule in here: a seeded variant's colour and size do
// NOT live in wh_item_fields. Only the ~1 item registered by hand (D29) has
// those. The other 4,726 came from the shop catalogue and carry their colour
// and size on shop_variants / shop_product_colours. THAT is why the counting
// screen used to guess a model's name from common word prefixes — the
// attributes it needed were never where it was looking. variantDetails()
// therefore reads the hand-entered field first and falls back to the shop
// record, so a count shows real colours and sizes for the whole catalogue
// instead of forty near-identical full-length names.
import type { Express, Response } from "express";
import { and, asc, eq, ilike, inArray, isNotNull, or, sql } from "drizzle-orm";
import { db } from "./db";
import { requireAuth, requireTab } from "./auth";
import {
  whItems, whModels, whItemFields, whBarcodeAliases, whLocations, whStock,
  shopVariants, shopProductColours,
} from "@shared/schema";

class ModelError extends Error {
  constructor(message: string) { super(message); this.name = "ModelError"; }
}

const clean = (v: unknown): string | undefined => {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s.length ? s : undefined;
};

function parseId(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function handleError(res: Response, e: any, context: string) {
  if (e instanceof ModelError) return res.status(400).json({ message: e.message });
  console.error(`[warehouse models] ${context}:`, e);
  res.status(500).json({ message: "Something went wrong" });
}

/** CSV cell — quote anything that could break a row, and neutralise the leading
 *  characters Excel treats as a formula. A barcode or a rack code is arbitrary
 *  text typed by whoever was holding the scanner. */
function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export interface VariantDetail {
  itemId: number;
  modelId: number | null;
  modelTitle: string | null;
  modelVendor: string | null;
  modelVendorModel: string | null;
  colour: string | null;
  sizeAsian: string | null;
  sizeEU: string | null;
  rackCode: string | null;
  locationId: number | null;
  barcode: string | null;
}

/**
 * Everything the counting screen needs to render a scanned line under the right
 * model, for a batch of items. Batched on purpose: the old screen fired one
 * request per new line, which on a real count is a request per garment.
 */
export async function variantDetails(itemIds: number[]): Promise<VariantDetail[]> {
  if (!itemIds.length) return [];
  const ids = Array.from(new Set(itemIds)).filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return [];

  const rows = await db
    .select({
      itemId: whItems.id,
      modelId: whItems.modelId,
      rackCode: whItems.rackCode,
      locationId: whItems.defaultLocationId,
      modelTitle: whModels.title,
      modelVendor: whModels.vendor,
      modelVendorModel: whModels.vendorModel,
      // The shop record — real colour and size for the seeded catalogue.
      shopSize: shopVariants.size,
      shopColour: shopProductColours.name,
    })
    .from(whItems)
    .leftJoin(whModels, eq(whModels.id, whItems.modelId))
    .leftJoin(shopVariants, eq(shopVariants.id, whItems.shopVariantId))
    .leftJoin(shopProductColours, eq(shopProductColours.id, shopVariants.colourId))
    .where(inArray(whItems.id, ids));

  // Hand-entered attributes (D29) win over the shop record: someone standing at
  // the shelf who typed "Navy" is correcting what the catalogue said.
  const fields = await db
    .select({ itemId: whItemFields.itemId, fieldKey: whItemFields.fieldKey, valueText: whItemFields.valueText })
    .from(whItemFields)
    .where(and(isNotNull(whItemFields.itemId), inArray(whItemFields.itemId, ids)));
  const byItem = new Map<number, Record<string, string>>();
  for (const f of fields) {
    if (f.itemId === null) continue;
    const m = byItem.get(f.itemId) ?? {};
    if (f.valueText) m[f.fieldKey] = f.valueText;
    byItem.set(f.itemId, m);
  }

  // One barcode per variant is Dima's model; an item may legitimately carry
  // several aliases (a case code as well as a unit code, D5). Show the first
  // registered — the CSV names one barcode per row and inventing a join row per
  // alias would double-count the export.
  const aliases = await db
    .select({ itemId: whBarcodeAliases.itemId, code: whBarcodeAliases.code, id: whBarcodeAliases.id })
    .from(whBarcodeAliases)
    .where(inArray(whBarcodeAliases.itemId, ids))
    .orderBy(asc(whBarcodeAliases.id));
  const firstAlias = new Map<number, string>();
  for (const a of aliases) if (!firstAlias.has(a.itemId)) firstAlias.set(a.itemId, a.code);

  return rows.map((r) => {
    const f = byItem.get(r.itemId) ?? {};
    return {
      itemId: r.itemId,
      modelId: r.modelId ?? null,
      modelTitle: r.modelTitle ?? null,
      modelVendor: f.vendor ?? r.modelVendor ?? null,
      modelVendorModel: f.vendor_model ?? r.modelVendorModel ?? null,
      colour: f.colour ?? r.shopColour ?? null,
      sizeAsian: f.size_asian ?? r.shopSize ?? null,
      sizeEU: f.size_eu ?? null,
      rackCode: r.rackCode ?? null,
      locationId: r.locationId ?? null,
      barcode: firstAlias.get(r.itemId) ?? null,
    };
  });
}

export function registerWarehouseModelRoutes(app: Express) {
  // ── Variant details for a batch of items ──────────────────────────────────
  app.post("/api/admin/warehouse/variant-details", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const raw = Array.isArray(req.body?.itemIds) ? req.body.itemIds : [];
      // A count of a big rack can name a lot of items; cap the batch rather
      // than letting one request build an unbounded IN list.
      if (raw.length > 500) throw new ModelError("Too many items in one request");
      res.json({ details: await variantDetails(raw.map(Number)) });
    } catch (e: any) {
      handleError(res, e, "variant details");
    }
  });

  // ── The model picker ──────────────────────────────────────────────────────
  app.get("/api/admin/warehouse/models", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const q = clean(req.query.q);
      const where = q
        ? or(
            ilike(whModels.title, `%${q}%`),
            ilike(whModels.vendor, `%${q}%`),
            ilike(whModels.vendorModel, `%${q}%`),
            ilike(whModels.sku, `%${q}%`),
          )
        : undefined;

      const models = await db
        .select({
          id: whModels.id,
          vendor: whModels.vendor,
          title: whModels.title,
          vendorModel: whModels.vendorModel,
          sku: whModels.sku,
          notes: whModels.notes,
          imageUrl: whModels.imageUrl,
          active: whModels.active,
        })
        .from(whModels)
        .where(where)
        .orderBy(asc(whModels.vendor), asc(whModels.title))
        .limit(500);

      // 🔴 Counted with an explicit GROUP BY, not a correlated subquery in a
      // sql`` template. Drizzle rendered `${whModels.id}` inside that template
      // without correlating it to the outer row, so EVERY model reported
      // variantCount 0 — a list where every row says "0 variants" reads as a
      // broken backfill, which is exactly the wrong thing to tell Dima on his
      // first look. Caught by the live verification, not by tsc: the types were
      // perfectly happy.
      const counts = await db
        .select({ modelId: whItems.modelId, n: sql<number>`count(*)::int` })
        .from(whItems)
        .where(isNotNull(whItems.modelId))
        .groupBy(whItems.modelId);
      const byModel = new Map(counts.map((c) => [c.modelId, Number(c.n)]));

      res.json(models.map((m) => ({ ...m, variantCount: byModel.get(m.id) ?? 0 })));
    } catch (e: any) {
      handleError(res, e, "list models");
    }
  });

  // ── One model, expanded to its variants (the list view's tap) ─────────────
  app.get("/api/admin/warehouse/models/:id/variants", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (!id) throw new ModelError("Which model?");

      const items = await db
        .select({ id: whItems.id, sku: whItems.sku, name: whItems.name, notes: whItems.notes, active: whItems.active })
        .from(whItems)
        .where(eq(whItems.modelId, id))
        .orderBy(asc(whItems.sku));

      const details = await variantDetails(items.map((i) => i.id));
      const byId = new Map(details.map((d) => [d.itemId, d]));

      res.json(items.map((i) => ({ ...i, ...(byId.get(i.id) ?? {}) })));
    } catch (e: any) {
      handleError(res, e, "model variants");
    }
  });

  // ── Create / edit a model ─────────────────────────────────────────────────
  app.post("/api/admin/warehouse/models", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const title = clean(req.body?.title);
      if (!title) throw new ModelError("Give the model a title");
      const [model] = await db
        .insert(whModels)
        .values({
          title,
          vendor: clean(req.body?.vendor) ?? null,
          vendorModel: clean(req.body?.vendorModel) ?? null,
          sku: clean(req.body?.sku) ?? null,
          notes: clean(req.body?.notes) ?? null,
        })
        .returning();
      res.status(201).json(model);
    } catch (e: any) {
      handleError(res, e, "create model");
    }
  });

  app.patch("/api/admin/warehouse/models/:id", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (!id) throw new ModelError("Which model?");
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      // Only fields actually present in the body are touched — a form that
      // omits a field must never blank it.
      for (const k of ["vendor", "title", "vendorModel", "sku", "notes"] as const) {
        if (k in (req.body ?? {})) patch[k] = clean(req.body[k]) ?? null;
      }
      if (patch.title === null) throw new ModelError("A model needs a title");
      if ("active" in (req.body ?? {})) patch.active = Boolean(req.body.active);

      const [model] = await db.update(whModels).set(patch).where(eq(whModels.id, id)).returning();
      if (!model) throw new ModelError("That model no longer exists");
      res.json(model);
    } catch (e: any) {
      handleError(res, e, "update model");
    }
  });

  // 🔴 Deleting a model UN-GROUPS its variants (D33 — the FK is ON DELETE SET
  // NULL). It never deletes stock, and the response says how many variants were
  // released so the confirmation modal can state it before it happens.
  app.delete("/api/admin/warehouse/models/:id", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (!id) throw new ModelError("Which model?");
      const [{ n }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(whItems)
        .where(eq(whItems.modelId, id));
      await db.delete(whModels).where(eq(whModels.id, id));
      res.json({ ok: true, ungrouped: n });
    } catch (e: any) {
      handleError(res, e, "delete model");
    }
  });

  // ── Where a variant physically sits (D35) ─────────────────────────────────
  app.patch("/api/admin/warehouse/items/:id/placement", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (!id) throw new ModelError("Which item?");
      const patch: Record<string, unknown> = { updatedAt: new Date() };

      if ("rackCode" in (req.body ?? {})) {
        // Free text by design (D35), but normalised so 'l1' and 'L1' are one
        // rack in the autocomplete rather than two.
        const rack = clean(req.body.rackCode);
        patch.rackCode = rack ? rack.toUpperCase() : null;
      }
      if ("locationId" in (req.body ?? {})) {
        const loc = parseId(req.body.locationId);
        if (req.body.locationId !== null && !loc) throw new ModelError("That isn't a location");
        patch.defaultLocationId = loc;
      }
      if ("modelId" in (req.body ?? {})) {
        const modelId = parseId(req.body.modelId);
        if (req.body.modelId !== null && !modelId) throw new ModelError("That isn't a model");
        patch.modelId = modelId;
      }

      const [item] = await db.update(whItems).set(patch).where(eq(whItems.id, id)).returning();
      if (!item) throw new ModelError("That item no longer exists");
      res.json(item);
    } catch (e: any) {
      handleError(res, e, "item placement");
    }
  });

  // ── Autocomplete (spec §5) ────────────────────────────────────────────────
  // Built from values already in use, never a fixed enum table. Stops
  // Blue/blue/BLUE drift without forcing a taxonomy on a catalogue that is
  // still being entered for the first time.
  app.get("/api/admin/warehouse/suggestions", requireAuth, requireTab("warehouse"), async (_req, res) => {
    try {
      const distinctField = async (key: string) => {
        const rows = await db
          .selectDistinct({ v: whItemFields.valueText })
          .from(whItemFields)
          .where(and(eq(whItemFields.fieldKey, key), isNotNull(whItemFields.valueText)))
          .limit(300);
        return rows.map((r) => r.v!).filter(Boolean);
      };

      const [vendorsFromFields, colours, sizesAsian, sizesEU] = await Promise.all([
        distinctField("vendor"),
        distinctField("colour"),
        distinctField("size_asian"),
        distinctField("size_eu"),
      ]);

      // The seeded catalogue's colours and sizes live on the shop record, so an
      // autocomplete built only from wh_item_fields would be empty on day one —
      // exactly when it is most needed.
      const [shopColours, shopSizes, modelVendors, racks] = await Promise.all([
        db.selectDistinct({ v: shopProductColours.name }).from(shopProductColours).limit(300),
        db.selectDistinct({ v: shopVariants.size }).from(shopVariants).limit(300),
        db.selectDistinct({ v: whModels.vendor }).from(whModels).where(isNotNull(whModels.vendor)).limit(300),
        db.selectDistinct({ v: whItems.rackCode }).from(whItems).where(isNotNull(whItems.rackCode)).limit(300),
      ]);

      const merge = (...lists: (string | null)[][]) =>
        Array.from(new Set(lists.flat().map((s) => (s ?? "").trim()).filter(Boolean)))
          .sort((a, b) => a.localeCompare(b, "en-NZ", { numeric: true }));

      res.json({
        vendor: merge(vendorsFromFields, modelVendors.map((r) => r.v)),
        colour: merge(colours, shopColours.map((r) => r.v)),
        sizeAsian: merge(sizesAsian, shopSizes.map((r) => r.v)),
        sizeEU: merge(sizesEU),
        rackCode: merge(racks.map((r) => r.v)),
      });
    } catch (e: any) {
      handleError(res, e, "suggestions");
    }
  });

  // ── CSV export (spec §10) ─────────────────────────────────────────────────
  // Dima's exact column order. Separate endpoint from the existing stock.csv,
  // which has its own shape and its own consumers — changing that one's columns
  // to suit this screen would break whatever already reads it.
  app.get("/api/admin/warehouse/catalogue.csv", requireAuth, requireTab("warehouse"), async (_req, res) => {
    try {
      const items = await db
        .select({
          id: whItems.id,
          sku: whItems.sku,
          name: whItems.name,
          notes: whItems.notes,
          modelId: whItems.modelId,
          rackCode: whItems.rackCode,
          modelTitle: whModels.title,
          modelVendor: whModels.vendor,
          modelVendorModel: whModels.vendorModel,
          modelSku: whModels.sku,
          modelNotes: whModels.notes,
          locationCode: whLocations.code,
          locationName: whLocations.name,
        })
        .from(whItems)
        .leftJoin(whModels, eq(whModels.id, whItems.modelId))
        .leftJoin(whLocations, eq(whLocations.id, whItems.defaultLocationId))
        .orderBy(asc(whModels.vendor), asc(whModels.title), asc(whItems.sku));

      const details = new Map((await variantDetails(items.map((i) => i.id))).map((d) => [d.itemId, d]));

      // Quantity is on-hand across every location — the ledger's number, not a
      // half-finished count sitting in someone's browser.
      const stock = await db
        .select({ itemId: whStock.itemId, onHand: sql<number>`sum(${whStock.onHand})::int` })
        .from(whStock)
        .groupBy(whStock.itemId);
      const qty = new Map(stock.map((s) => [s.itemId, s.onHand]));

      const header = [
        "ID", "Vendor", "Title", "Vendor Model", "Our SKU", "Item Notes",
        "Colour", "Asian size", "EU size", "Location", "Barcode", "Quantity", "Variant Notes",
      ];
      const lines = [header.join(",")];

      // A model with no variants still emits one row, so nothing silently
      // disappears from the export (spec §10).
      const modelsWithVariants = new Set(items.map((i) => i.modelId).filter(Boolean) as number[]);
      const emptyModels = await db
        .select({ id: whModels.id, vendor: whModels.vendor, title: whModels.title, vendorModel: whModels.vendorModel, sku: whModels.sku, notes: whModels.notes })
        .from(whModels);

      for (const i of items) {
        const d = details.get(i.id);
        const place = [i.locationName ?? i.locationCode, i.rackCode].filter(Boolean).join(" · ");
        lines.push([
          i.id,
          i.modelVendor ?? d?.modelVendor ?? "",
          i.modelTitle ?? i.name,
          i.modelVendorModel ?? d?.modelVendorModel ?? "",
          i.modelSku ?? i.sku,
          i.modelNotes ?? "",
          d?.colour ?? "",
          d?.sizeAsian ?? "",
          d?.sizeEU ?? "",
          place,
          d?.barcode ?? "",
          qty.get(i.id) ?? 0,
          i.notes ?? "",
        ].map(csvCell).join(","));
      }
      for (const m of emptyModels) {
        if (modelsWithVariants.has(m.id)) continue;
        lines.push([m.id, m.vendor ?? "", m.title, m.vendorModel ?? "", m.sku ?? "", m.notes ?? "", "", "", "", "", "", "", ""]
          .map(csvCell).join(","));
      }

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="warehouse-catalogue.csv"`);
      res.send(lines.join("\n"));
    } catch (e: any) {
      handleError(res, e, "catalogue csv");
    }
  });
}
