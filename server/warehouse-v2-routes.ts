// Warehouse v2 API — asset instances, self-service field templates, and the
// counter sale (D18–D25). Registered alongside server/warehouse-routes.ts;
// kept in its own module because that file is already 3,200 lines.
//
// Everything here is gated by requireTab("warehouse") exactly like v1. The one
// extra gate is on the FIELD TEMPLATE editor: the source spec asks that only an
// admin may change the shape of the data, while anyone with the tab may create
// and scan items and record movements. In ClubOS terms that is super_admin
// globally, or admin/manager in a workspace — the same definition the Feedback
// board already uses for triage, reused rather than reinvented.
//
// The rules that matter, all enforced server-side:
//   • operator_user_id ALWAYS comes from the session, never the request body
//     (D17) — a client cannot post a movement in someone else's name.
//   • tracking_mode cannot change once an item has any history (D18).
//   • quantity is never written directly; every change is a ledger row.
//   • the counter sale REQUIRES an idempotency key, because the offline queue
//     replays it and an unkeyed replay would sell the same shirt twice.

import type { Express, Request, Response } from "express";
import { and, asc, desc, eq, ilike, inArray, isNotNull, or, sql } from "drizzle-orm";
import { db } from "./db";
import { requireAuth, requireTab } from "./auth";
import { storage } from "./storage";
import { nzTodayIso } from "@shared/academy";
import { whBarcodeAliases, whFieldTemplates, whItemFields, whItemInstances, whItems, whLocations, whMovements, whStock, users } from "@shared/schema";
import {
  FIELD_TYPES,
  INSTANCE_CONDITIONS,
  MOVEMENT_TYPE_LABELS,
  canChangeTrackingMode,
  isFieldAppliesTo,
  isFieldType,
  isInstanceCondition,
  isSellableLocation,
  isValidFieldKey,
  isTrackingMode,
  normaliseAssetTag,
  readFieldValue,
  slugifyFieldKey,
  warrantyStatus,
  type FieldAppliesTo,
  type FieldTemplateLike,
  type FieldType,
  type InstanceCondition,
  type LocationKind,
  QUICK_ITEM_CATEGORY,
  QUICK_ITEM_FIELD_KEYS,
  isValidSku,
  normaliseAliasCode,
  normaliseSku,
  suggestSku,
} from "@shared/warehouse";
import {
  CORE_FIELDS, CORE_FIELD_BY_KEY, defaultLayout, isCoreFieldKey, resolveLayout, validateLayout,
} from "@shared/warehouse-form";
import { runMovementGroup, InsufficientStockError, type MovementLeg } from "./warehouse";
import {
  InstanceError,
  decommissionInstanceTx,
  heldInstanceCounts,
  loadFieldValues,
  moveInstanceTx,
  placeInstanceTx,
  saveFieldValuesTx,
  trackingModeHistory,
} from "./warehouse-instances";

// ── Local helpers (mirroring server/warehouse-routes.ts) ─────────────────────

class V2Error extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const clean = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
};

/** RFC 4180 quoting — a product name with a comma or a quote in it must not
 *  shift every following column in Excel. */
function csvCell(v: string): string {
  const s = String(v ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function parseId(raw: unknown): number | null {
  const n = parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : null;
}

function handleError(res: Response, e: any, context: string) {
  if (e instanceof V2Error) return res.status(e.status).json({ message: e.message });
  if (e instanceof InstanceError) return res.status(400).json({ message: e.message });
  if (e instanceof InsufficientStockError) return res.status(409).json({ message: e.message });
  if (e?.code === "23505") return res.status(409).json({ message: "That code is already in use." });
  if (e?.code === "23503") {
    return res.status(409).json({ message: "This is still referenced elsewhere and can't be removed." });
  }
  console.error(`[Warehouse v2] ${context}:`, e);
  res.status(500).json({ message: "Something went wrong. Nothing was changed." });
}

/** Admin = super_admin globally, or admin/manager in any workspace. Same
 *  definition the Feedback board uses. Only these people may change the SHAPE
 *  of the data (field templates); everyone with the tab can use it. */
async function isWarehouseAdmin(userId: number): Promise<boolean> {
  const user = await storage.getUser(userId);
  if (!user) return false;
  if (user.role === "super_admin") return true;
  const orgs = await storage.getUserOrganizations(userId);
  return (orgs as any[]).some((o) => o.userRole === "admin" || o.userRole === "manager");
}

async function assertAdmin(req: Request): Promise<void> {
  const ok = await isWarehouseAdmin(req.session.userId!);
  if (!ok) {
    throw new V2Error("Only an admin can change which fields an item category has", 403);
  }
}

async function loadTemplatesFor(category: string | null, appliesTo?: FieldAppliesTo): Promise<FieldTemplateLike[]> {
  if (!category) return [];
  const rows = await db
    .select()
    .from(whFieldTemplates)
    .where(
      and(
        eq(whFieldTemplates.category, category),
        eq(whFieldTemplates.active, true),
        appliesTo ? eq(whFieldTemplates.appliesTo, appliesTo) : undefined,
      ),
    )
    .orderBy(asc(whFieldTemplates.sortOrder), asc(whFieldTemplates.id));
  return rows.map((r) => ({
    fieldKey: r.fieldKey,
    label: r.label,
    fieldType: r.fieldType as FieldType,
    options: (r.options as string[] | null) ?? null,
    required: r.required,
  }));
}

export function registerWarehouseV2Routes(app: Express) {
  // ═══════════════════════════════════════════════════════════════════════
  // Field templates — the self-service schema editor (D23).
  // Reading is open to anyone with the tab (the item form needs it to render
  // at all); writing is admin-only.
  // ═══════════════════════════════════════════════════════════════════════

  app.get("/api/admin/warehouse/field-templates", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const category = clean(req.query.category);
      const rows = await db
        .select()
        .from(whFieldTemplates)
        .where(category ? eq(whFieldTemplates.category, category) : undefined)
        .orderBy(asc(whFieldTemplates.category), asc(whFieldTemplates.sortOrder), asc(whFieldTemplates.id));

      // The category list comes from the items themselves, so the editor can
      // only ever attach fields to categories that actually exist.
      const cats = await db
        .selectDistinct({ category: whItems.category })
        .from(whItems)
        .where(sql`${whItems.category} IS NOT NULL AND ${whItems.category} <> ''`)
        .orderBy(asc(whItems.category));

      res.json({
        templates: rows,
        categories: cats.map((c) => c.category).filter(Boolean),
        canEdit: await isWarehouseAdmin(req.session.userId!),
        fieldTypes: FIELD_TYPES,
      });
    } catch (e: any) {
      handleError(res, e, "list field templates");
    }
  });

  app.post("/api/admin/warehouse/field-templates", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      await assertAdmin(req);
      const b = req.body || {};

      const category = clean(b.category);
      if (!category) throw new V2Error("Pick which category these fields belong to");

      const label = clean(b.label);
      if (!label) throw new V2Error("Give the field a label");

      const fieldType = clean(b.fieldType) ?? "text";
      if (!isFieldType(fieldType)) throw new V2Error(`Field type must be one of: ${FIELD_TYPES.join(", ")}`);

      const appliesTo = clean(b.appliesTo) ?? "item";
      if (!isFieldAppliesTo(appliesTo)) throw new V2Error("appliesTo must be 'item' or 'instance'");

      // The key is derived once and then frozen — renaming the label later
      // must never orphan the values already filed under it.
      const fieldKey = clean(b.fieldKey) ? slugifyFieldKey(b.fieldKey) : slugifyFieldKey(label);
      if (!isValidFieldKey(fieldKey)) {
        throw new V2Error("That label doesn't make a usable field name — use letters and numbers");
      }

      let options: string[] | null = null;
      if (fieldType === "select") {
        const raw = Array.isArray(b.options) ? b.options : [];
        const parsed: string[] = raw.map((o: unknown) => String(o).trim()).filter(Boolean);
        if (parsed.length === 0) throw new V2Error("A choose-from-a-list field needs at least one option");
        options = parsed;
      }

      const [created] = await db
        .insert(whFieldTemplates)
        .values({
          category,
          fieldKey,
          label,
          fieldType,
          options,
          required: b.required === true || b.required === "true",
          sortOrder: parseId(b.sortOrder) ?? 0,
          helpText: clean(b.helpText) ?? null,
          appliesTo,
        })
        .returning();

      res.status(201).json(created);
    } catch (e: any) {
      handleError(res, e, "create field template");
    }
  });

  app.patch("/api/admin/warehouse/field-templates/:id", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      await assertAdmin(req);
      const id = parseId(req.params.id);
      if (id === null) throw new V2Error("Bad id");
      const b = req.body || {};

      const patch: Record<string, unknown> = { updatedAt: new Date() };

      // field_key and category are deliberately NOT patchable — both are the
      // address every stored value is filed under. Changing either would
      // orphan real data silently. Delete and recreate instead.
      if (b.label !== undefined) {
        const label = clean(b.label);
        if (!label) throw new V2Error("A field needs a label");
        patch.label = label;
      }
      if (b.required !== undefined) patch.required = b.required === true || b.required === "true";
      if (b.sortOrder !== undefined) patch.sortOrder = parseId(b.sortOrder) ?? 0;
      if (b.helpText !== undefined) patch.helpText = clean(b.helpText) ?? null;
      if (b.active !== undefined) patch.active = b.active === true || b.active === "true";
      if (b.options !== undefined) {
        const raw = Array.isArray(b.options) ? b.options : [];
        const options = raw.map((o: unknown) => String(o).trim()).filter(Boolean);
        patch.options = options.length ? options : null;
      }

      const [updated] = await db.update(whFieldTemplates).set(patch).where(eq(whFieldTemplates.id, id)).returning();
      if (!updated) throw new V2Error("That field no longer exists", 404);
      res.json(updated);
    } catch (e: any) {
      handleError(res, e, "update field template");
    }
  });

  /** Reordering is its own endpoint so dragging a list of fields is ONE
   *  request and one transaction, not N racing PATCHes that can interleave
   *  into a jumbled order. */
  app.post("/api/admin/warehouse/field-templates/reorder", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      await assertAdmin(req);
      const ids: number[] = Array.isArray(req.body?.ids) ? req.body.ids.map(parseId).filter((n: number | null) => n !== null) : [];
      if (ids.length === 0) throw new V2Error("Nothing to reorder");
      await db.transaction(async (tx) => {
        for (let i = 0; i < ids.length; i++) {
          await tx.update(whFieldTemplates).set({ sortOrder: i, updatedAt: new Date() }).where(eq(whFieldTemplates.id, ids[i]));
        }
      });
      res.json({ ok: true, count: ids.length });
    } catch (e: any) {
      handleError(res, e, "reorder field templates");
    }
  });

  app.delete("/api/admin/warehouse/field-templates/:id", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      await assertAdmin(req);
      const id = parseId(req.params.id);
      if (id === null) throw new V2Error("Bad id");

      const [tmpl] = await db.select().from(whFieldTemplates).where(eq(whFieldTemplates.id, id));
      if (!tmpl) throw new V2Error("That field no longer exists", 404);

      // Values already recorded against this key are NOT deleted — someone
      // typed them, and a field removed by mistake would take real data with
      // it. The template goes; the answers wait in case it comes back.
      const [{ n }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(whItemFields)
        .where(eq(whItemFields.fieldKey, tmpl.fieldKey));

      await db.delete(whFieldTemplates).where(eq(whFieldTemplates.id, id));
      res.json({ ok: true, orphanedValues: Number(n) });
    } catch (e: any) {
      handleError(res, e, "delete field template");
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // The item form layout (D26) — which questions New-item asks, in what
  // order. Reading is open to anyone with the tab (the form can't render
  // without it); saving is admin-only, like the field editor.
  // ═══════════════════════════════════════════════════════════════════════

  app.get("/api/admin/warehouse/form-layout", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const mode = clean(req.query.mode) ?? "stock";
      if (!isTrackingMode(mode)) throw new V2Error("mode must be 'stock' or 'asset'");
      const category = clean(req.query.category) ?? null;

      const rows = await db.select().from(whFieldTemplates);
      const layout = resolveLayout(rows as any, mode, category);

      res.json({
        mode,
        category,
        layout,
        // Everything an admin could place, so the editor can offer what isn't
        // on the form yet without hardcoding a second copy of the registry.
        coreFields: CORE_FIELDS.filter((f) => !f.onlyFor || f.onlyFor === mode),
        // True when nothing has been customised — the editor says so rather
        // than pretending an empty table means an empty form.
        isDefault: !rows.some((r) => r.coreField && (r.trackingMode == null || r.trackingMode === mode)),
        canEdit: await isWarehouseAdmin(req.session.userId!),
      });
    } catch (e: any) {
      handleError(res, e, "read form layout");
    }
  });

  /** Body: { mode, fields: [{ coreField, label?, active, required? }] }.
   *  Replaces the whole layout for one mode in a single transaction — a
   *  partially-saved form order would be worse than none. */
  app.put("/api/admin/warehouse/form-layout", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      await assertAdmin(req);
      const b = req.body || {};
      const mode = clean(b.mode);
      if (!isTrackingMode(mode)) throw new V2Error("mode must be 'stock' or 'asset'");

      const incoming: Array<{ coreField: string; label: string; active: boolean; required: boolean }> =
        Array.isArray(b.fields) ? b.fields : [];
      if (incoming.length === 0) throw new V2Error("A form needs at least the fields we key on");

      for (const f of incoming) {
        if (!isCoreFieldKey(f.coreField)) throw new V2Error(`"${f.coreField}" isn't a field we know about`);
      }

      // The mandatory-field guard, server-side. The client shows the same
      // messages, but a layout can also arrive from a script or a stale tab.
      const check = validateLayout(incoming.map((f) => ({ coreField: f.coreField, active: f.active !== false })));
      if (!check.ok) throw new V2Error(check.errors.join(" "), 422);

      await db.transaction(async (tx) => {
        // Replace rather than merge: the incoming array IS the order, and
        // leaving orphans behind would resurrect fields the admin removed.
        await tx
          .delete(whFieldTemplates)
          .where(and(isNotNull(whFieldTemplates.coreField), eq(whFieldTemplates.trackingMode, mode)));

        for (let i = 0; i < incoming.length; i++) {
          const f = incoming[i];
          const def = CORE_FIELD_BY_KEY[f.coreField];
          await tx.insert(whFieldTemplates).values({
            coreField: f.coreField,
            trackingMode: mode,
            category: null,
            fieldKey: f.coreField,
            label: clean(f.label) ?? def.label,
            fieldType: "text",           // unused for a core placement
            required: def.mandatory === true || f.required === true,
            sortOrder: i,
            active: def.mandatory === true ? true : f.active !== false,
          });
        }
      });

      const rows = await db.select().from(whFieldTemplates);
      res.json({ ok: true, layout: resolveLayout(rows as any, mode, null) });
    } catch (e: any) {
      handleError(res, e, "save form layout");
    }
  });

  /** Puts a mode's layout back to the built-in default by clearing its rows. */
  app.delete("/api/admin/warehouse/form-layout", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      await assertAdmin(req);
      const mode = clean(req.query.mode);
      if (!isTrackingMode(mode)) throw new V2Error("mode must be 'stock' or 'asset'");
      await db
        .delete(whFieldTemplates)
        .where(and(isNotNull(whFieldTemplates.coreField), eq(whFieldTemplates.trackingMode, mode)));
      res.json({ ok: true, layout: defaultLayout(mode) });
    } catch (e: any) {
      handleError(res, e, "reset form layout");
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Custom field VALUES for one item or one instance (D22/D24).
  // ═══════════════════════════════════════════════════════════════════════

  app.get("/api/admin/warehouse/fields/:owner/:id", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const ownerKind = req.params.owner;
      const id = parseId(req.params.id);
      if (id === null) throw new V2Error("Bad id");
      if (ownerKind !== "item" && ownerKind !== "instance") throw new V2Error("owner must be 'item' or 'instance'");

      let category: string | null = null;
      if (ownerKind === "item") {
        const [item] = await db.select({ category: whItems.category }).from(whItems).where(eq(whItems.id, id));
        if (!item) throw new V2Error("That item no longer exists", 404);
        category = item.category;
      } else {
        const [row] = await db
          .select({ category: whItems.category })
          .from(whItemInstances)
          .innerJoin(whItems, eq(whItemInstances.itemId, whItems.id))
          .where(eq(whItemInstances.id, id));
        if (!row) throw new V2Error("That asset no longer exists", 404);
        category = row.category;
      }

      const templates = await loadTemplatesFor(category, ownerKind === "item" ? "item" : "instance");
      const values = await loadFieldValues(db, ownerKind === "item" ? { itemId: id } : { instanceId: id });

      res.json({
        category,
        templates,
        values,
        // Rendered value per key, so the client never has to know which typed
        // column a field type lives in.
        display: Object.fromEntries(templates.map((t) => [t.fieldKey, readFieldValue(t.fieldType, values[t.fieldKey] ?? {})])),
      });
    } catch (e: any) {
      handleError(res, e, "read field values");
    }
  });

  app.put("/api/admin/warehouse/fields/:owner/:id", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const ownerKind = req.params.owner;
      const id = parseId(req.params.id);
      if (id === null) throw new V2Error("Bad id");
      if (ownerKind !== "item" && ownerKind !== "instance") throw new V2Error("owner must be 'item' or 'instance'");

      const submitted = req.body?.values;
      if (!submitted || typeof submitted !== "object") throw new V2Error("Nothing submitted");

      let category: string | null = null;
      if (ownerKind === "item") {
        const [item] = await db.select({ category: whItems.category }).from(whItems).where(eq(whItems.id, id));
        if (!item) throw new V2Error("That item no longer exists", 404);
        category = item.category;
      } else {
        const [row] = await db
          .select({ category: whItems.category })
          .from(whItemInstances)
          .innerJoin(whItems, eq(whItemInstances.itemId, whItems.id))
          .where(eq(whItemInstances.id, id));
        if (!row) throw new V2Error("That asset no longer exists", 404);
        category = row.category;
      }

      const templates = await loadTemplatesFor(category, ownerKind === "item" ? "item" : "instance");
      const result = await db.transaction(async (tx) =>
        saveFieldValuesTx(tx, ownerKind === "item" ? { itemId: id } : { instanceId: id }, templates, submitted),
      );
      res.json(result);
    } catch (e: any) {
      handleError(res, e, "save field values");
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Stock take (D27) — walk the racks with a scanner and put real numbers in.
  //
  // Deliberately NOT the blind-count flow (wh_counts): that one hides the
  // expected quantity and requires a second person to approve, which is the
  // right control for a recurring audit and the wrong one for the very first
  // count, where on-hand is zero, there is nothing to audit against, and Dima
  // is on his own in the warehouse.
  //
  // What it keeps: every change is still a ledger movement, still named
  // against the person who did it. Nothing writes quantity directly.
  //
  // 🔴 A stock take SETS the quantity, it does not add to it. Counting 10
  // means "there are 10 on this shelf", so the delta posted is
  // (counted − what we thought), which is +10 from zero and −2 if we thought
  // there were 12. Treating it as an add would double the shelf on a recount.
  // ═══════════════════════════════════════════════════════════════════════

  app.post("/api/admin/warehouse/stock-take", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const b = req.body || {};
      const locationId = parseId(b.locationId);
      if (locationId === null) throw new V2Error("Which location did you count?");

      const [loc] = await db
        .select({ id: whLocations.id, code: whLocations.code, kind: whLocations.kind })
        .from(whLocations)
        .where(eq(whLocations.id, locationId));
      if (!loc) throw new V2Error("That location does not exist");
      if (loc.kind === "virtual") throw new V2Error("Pick a real bin or zone — a virtual location holds nothing to count");

      const lines: Array<{ itemId: number; counted: number }> = Array.isArray(b.lines) ? b.lines : [];
      if (lines.length === 0) throw new V2Error("Nothing counted yet — scan something first");

      // Required, not optional: a phone that loses signal mid-post will retry,
      // and a stock take posted twice would move the shelf twice.
      const idempotencyKey = clean(b.idempotencyKey);
      if (!idempotencyKey) throw new V2Error("idempotencyKey is required for a stock take");

      const itemIds = Array.from(new Set(lines.map((l) => parseId(l.itemId)).filter((n): n is number => n !== null)));
      if (itemIds.length === 0) throw new V2Error("None of those lines name a real item");

      const items = await db
        .select({ id: whItems.id, sku: whItems.sku, name: whItems.name, allowNegative: whItems.allowNegative, trackingMode: whItems.trackingMode })
        .from(whItems)
        .where(inArray(whItems.id, itemIds));
      const itemById = new Map(items.map((i) => [i.id, i]));

      // What we currently think is on that shelf — one query, not one per line.
      const current = await db
        .select({ itemId: whStock.itemId, onHand: whStock.onHand })
        .from(whStock)
        .where(and(eq(whStock.locationId, loc.id), inArray(whStock.itemId, itemIds)));
      const onHandById = new Map(current.map((r) => [r.itemId, Number(r.onHand)]));

      const legs: MovementLeg[] = [];
      const summary: Array<{ itemId: number; sku: string; name: string; before: number; counted: number; delta: number }> = [];

      for (const l of lines) {
        const itemId = parseId(l.itemId);
        if (itemId === null) continue;
        const item = itemById.get(itemId);
        if (!item) throw new V2Error(`Item ${itemId} no longer exists`);
        if (item.trackingMode === "asset") {
          throw new V2Error(`${item.sku} is a tracked asset — count those as individual units on the Assets page, not by quantity`);
        }

        const counted = Number(l.counted);
        if (!Number.isFinite(counted) || counted < 0) throw new V2Error(`${item.sku}: a counted quantity can't be negative`);

        const before = onHandById.get(itemId) ?? 0;
        const delta = counted - before;
        summary.push({ itemId, sku: item.sku, name: item.name, before, counted, delta });

        // A line that matches what we already thought writes nothing — the
        // ledger records changes, and "still 10" is not one.
        if (delta === 0) continue;
        legs.push({
          itemId,
          locationId: loc.id,
          locationCode: loc.code,
          delta,
          allowNegative: item.allowNegative,
        });
      }

      if (legs.length === 0) {
        return res.json({
          movement: null,
          locationId: loc.id,
          locationCode: loc.code,
          lines: summary,
          unchanged: true,
          message: "Everything matched what we already had — nothing to change.",
        });
      }

      const movement = await runMovementGroup({
        legs,
        movementType: "count",
        reasonCode: "stock_take",
        // D17 — the person holding the scanner, from the session.
        operatorUserId: req.session.userId!,
        idempotencyKey,
        note: clean(b.note) ?? `Stock take at ${loc.code}`,
      });

      res.status(movement.alreadyProcessed ? 200 : 201).json({
        movement,
        locationId: loc.id,
        locationCode: loc.code,
        lines: summary,
        replayed: movement.alreadyProcessed,
      });
    } catch (e: any) {
      handleError(res, e, "stock take");
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // D29 — register an item mid-count, without leaving the count.
  //
  // The first physical count is the one moment the warehouse is full of stock
  // that ClubOS has never heard of: a KELME shirt's own EAN means nothing to us
  // until somebody links it once. Before this, scanning one during a stock take
  // produced "not recognised" and the scan was simply lost — so the count could
  // not include the uniform stock, which is most of the room.
  //
  // One transaction creates all three things a scannable, countable item needs:
  // the item, the barcode link, and the apparel attributes. Any one of them
  // failing rolls back the others — a half-registered item is worse than none,
  // because the shelf looks done and the barcode still won't resolve.
  // ═══════════════════════════════════════════════════════════════════════

  app.post("/api/admin/warehouse/quick-item", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const b = req.body || {};
      const vendor = clean(b.vendor);
      const vendorModel = clean(b.vendorModel);
      const colour = clean(b.colour);
      const sizeAsian = clean(b.sizeAsian);
      const sizeEU = clean(b.sizeEU);
      const notes = clean(b.notes);
      const title = clean(b.title);
      // D35 — the rack this variant sits on. Uppercased so 'l1' and 'L1' are
      // one rack in the autocomplete, not two.
      const rackCode = clean(b.rackCode)?.toUpperCase();
      // D32 — which model it belongs to, when registering from an expanded
      // model row. parseId rejects anything that isn't a real id rather than
      // coercing it to NaN and writing null silently.
      const modelId = b.modelId === undefined || b.modelId === null ? null : parseId(b.modelId);
      if (b.modelId !== undefined && b.modelId !== null && !modelId) {
        throw new V2Error("That isn't a model");
      }

      // A name is the one thing the shelf can't be read back without.
      const name = title
        ?? [vendor, vendorModel, colour, sizeAsian ?? sizeEU].filter(Boolean).join(" ")
        ?? "";
      if (!name.trim()) throw new V2Error("Give it a title, or at least a vendor and model");

      const barcodeRaw = clean(b.barcode);
      const barcode = barcodeRaw ? normaliseAliasCode(barcodeRaw) : null;

      // 🔴 A barcode already pointing at another item must never be re-pointed
      // here. Unlike the prototype's in-memory guard this is permanent: every
      // future scan of that EAN would silently count the wrong shirt.
      if (barcode) {
        const [clash] = await db
          .select({ itemId: whBarcodeAliases.itemId, sku: whItems.sku, name: whItems.name })
          .from(whBarcodeAliases)
          .innerJoin(whItems, eq(whItems.id, whBarcodeAliases.itemId))
          .where(eq(whBarcodeAliases.code, barcode));
        if (clash) {
          throw new V2Error(`That barcode is already registered to ${clash.sku} — ${clash.name}. Scan it and it will count.`);
        }
        // A code that is already one of our own SKUs would resolve to that item
        // first (SKU beats alias), so registering it here would be a dead row.
        const [skuClash] = await db
          .select({ sku: whItems.sku, name: whItems.name })
          .from(whItems)
          .where(eq(whItems.sku, normaliseSku(barcode)));
        if (skuClash) {
          throw new V2Error(`That code is already our SKU for ${skuClash.name}. Scan it and it will count.`);
        }
      }

      // The client suggests a SKU; the server always re-derives its own and only
      // accepts an override that is genuinely valid.
      const requested = clean(b.sku);
      let sku = requested ? normaliseSku(requested) : suggestSku({ vendor, vendorModel, colour, size: sizeAsian ?? sizeEU });
      if (!sku) throw new V2Error("Couldn't work out a SKU — type one in");
      if (!isValidSku(sku)) throw new V2Error("SKU must be uppercase letters/digits/dashes, 20 characters or fewer");

      // Two navy shirts of the same size from the same maker do exist (a restock
      // with a new EAN). Suffix rather than reject: the person counting cannot
      // fix a SKU collision from the warehouse floor.
      const taken = new Set(
        (await db.select({ sku: whItems.sku }).from(whItems).where(ilike(whItems.sku, `${sku}%`))).map((r) => r.sku),
      );
      if (taken.has(sku)) {
        const base = sku;
        let n = 2;
        while (n < 100) {
          const suffix = `-${n}`;
          const candidate = `${base.slice(0, 20 - suffix.length).replace(/-+$/, "")}${suffix}`;
          if (!taken.has(candidate)) { sku = candidate; break; }
          n++;
        }
        if (taken.has(sku)) throw new V2Error("Too many items share that SKU — type a different one");
      }

      const created = await db.transaction(async (tx) => {
        const [item] = await tx
          .insert(whItems)
          .values({
            sku,
            name: name.trim(),
            kind: "merch",
            // D18 — counted in bulk. An asset is registered on the Assets page,
            // and the stock take refuses assets anyway.
            trackingMode: "stock",
            brandOwner: clean(b.brandOwner) ?? "club",
            category: clean(b.category) ?? QUICK_ITEM_CATEGORY,
            unit: "ea",
            notes: notes ?? null,
            modelId,
            rackCode: rackCode ?? null,
          })
          .returning();

        if (barcode) {
          await tx.insert(whBarcodeAliases).values({
            code: barcode,
            itemId: item.id,
            packQty: "1",
            note: "Linked during a stock take",
          });
        }

        const values: Record<string, string | undefined> = {
          vendor, vendor_model: vendorModel, colour, size_asian: sizeAsian, size_eu: sizeEU,
        };
        const rows = QUICK_ITEM_FIELD_KEYS
          .filter((k) => (values[k] ?? "").trim().length > 0)
          .map((k) => ({ itemId: item.id, fieldKey: k, valueText: values[k]!.trim() }));
        if (rows.length) await tx.insert(whItemFields).values(rows);

        return item;
      });

      res.status(201).json({
        item: created,
        barcode,
        // Exactly what the counting screen needs to add a line without a re-fetch.
        line: {
          itemId: created.id, sku: created.sku, name: created.name,
          vendor, vendorModel, colour, sizeAsian, sizeEU,
          rackCode: created.rackCode, modelId: created.modelId, notes: created.notes,
        },
      });
    } catch (e: any) {
      handleError(res, e, "quick item");
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // CSV export — what's on the shelves right now.
  // ═══════════════════════════════════════════════════════════════════════

  app.get("/api/admin/warehouse/stock.csv", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const locationId = parseId(req.query.locationId);

      const rows = await db
        .select({
          sku: whItems.sku,
          name: whItems.name,
          kind: whItems.kind,
          brandOwner: whItems.brandOwner,
          category: whItems.category,
          unit: whItems.unit,
          itemId: whItems.id,
          locationCode: whLocations.code,
          locationName: whLocations.name,
          notes: whItems.notes,
          onHand: whStock.onHand,
          updatedAt: whStock.updatedAt,
        })
        .from(whStock)
        .innerJoin(whItems, eq(whStock.itemId, whItems.id))
        .innerJoin(whLocations, eq(whStock.locationId, whLocations.id))
        .where(locationId !== null ? eq(whStock.locationId, locationId) : undefined)
        .orderBy(asc(whItems.sku), asc(whLocations.code));

      // D29 — the apparel attributes live in wh_item_fields, so the export that
      // a human actually reads has to fetch them. One query for every row on the
      // sheet, not one per row.
      const itemIds = Array.from(new Set(rows.map((r) => r.itemId)));
      const attrs = new Map<number, Record<string, string>>();
      if (itemIds.length) {
        const fieldRows = await db
          .select({ itemId: whItemFields.itemId, fieldKey: whItemFields.fieldKey, valueText: whItemFields.valueText })
          .from(whItemFields)
          .where(and(inArray(whItemFields.itemId, itemIds), inArray(whItemFields.fieldKey, [...QUICK_ITEM_FIELD_KEYS])));
        for (const f of fieldRows) {
          if (f.itemId === null) continue;
          const bag = attrs.get(f.itemId) ?? {};
          bag[f.fieldKey] = f.valueText ?? "";
          attrs.set(f.itemId, bag);
        }
      }

      const header = [
        "SKU", "Name", "Vendor", "Vendor model", "Colour", "Asian size", "EU size",
        "Kind", "Brand", "Category", "Unit", "Location", "Location name", "On hand", "Last counted", "Notes",
      ];
      const body = rows.map((r) => {
        const a = attrs.get(r.itemId) ?? {};
        return [
          r.sku, r.name,
          a.vendor ?? "", a.vendor_model ?? "", a.colour ?? "", a.size_asian ?? "", a.size_eu ?? "",
          r.kind, r.brandOwner, r.category ?? "", r.unit, r.locationCode, r.locationName ?? "",
          String(Number(r.onHand)),
          r.updatedAt ? new Date(r.updatedAt).toISOString().slice(0, 10) : "",
          r.notes ?? "",
        ];
      });

      const csv = [header, ...body].map((cells) => cells.map(csvCell).join(",")).join("\r\n");

      const today = nzTodayIso();
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="warehouse-stock-${today}.csv"`);
      // A BOM so Excel on Windows opens it as UTF-8 rather than mangling any
      // accented product name.
      res.send("﻿" + csv);
    } catch (e: any) {
      handleError(res, e, "stock csv");
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Asset instances (D19).
  // ═══════════════════════════════════════════════════════════════════════

  app.get("/api/admin/warehouse/instances", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const itemId = parseId(req.query.itemId);
      const q = clean(req.query.q);
      const condition = clean(req.query.condition);
      const locationId = parseId(req.query.locationId);

      const filters = [
        itemId !== null ? eq(whItemInstances.itemId, itemId) : undefined,
        locationId !== null ? eq(whItemInstances.locationId, locationId) : undefined,
        condition && isInstanceCondition(condition) ? eq(whItemInstances.condition, condition) : undefined,
        q
          ? or(
              ilike(whItemInstances.assetTag, `%${q}%`),
              ilike(whItemInstances.serialNumber, `%${q}%`),
              ilike(whItems.name, `%${q}%`),
              ilike(whItems.sku, `%${q}%`),
            )
          : undefined,
      ].filter(Boolean);

      const rows = await db
        .select({
          id: whItemInstances.id,
          itemId: whItemInstances.itemId,
          assetTag: whItemInstances.assetTag,
          serialNumber: whItemInstances.serialNumber,
          condition: whItemInstances.condition,
          purchaseDate: whItemInstances.purchaseDate,
          warrantyUntil: whItemInstances.warrantyUntil,
          costCents: whItemInstances.costCents,
          notes: whItemInstances.notes,
          locationId: whItemInstances.locationId,
          locationCode: whLocations.code,
          locationKind: whLocations.kind,
          itemSku: whItems.sku,
          itemName: whItems.name,
        })
        .from(whItemInstances)
        .innerJoin(whItems, eq(whItemInstances.itemId, whItems.id))
        .innerJoin(whLocations, eq(whItemInstances.locationId, whLocations.id))
        .where(filters.length ? and(...(filters as any[])) : undefined)
        .orderBy(asc(whItems.name), asc(whItemInstances.assetTag), asc(whItemInstances.id))
        .limit(500);

      // The server sends NZ `today` so the client never computes it from the
      // browser clock (which reads a day behind through toISOString()).
      const today = nzTodayIso();
      res.json({
        today,
        instances: rows.map((r) => ({ ...r, warranty: warrantyStatus(r.warrantyUntil, today) })),
        conditions: INSTANCE_CONDITIONS,
      });
    } catch (e: any) {
      handleError(res, e, "list instances");
    }
  });

  app.post("/api/admin/warehouse/instances", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const b = req.body || {};
      const itemId = parseId(b.itemId);
      if (itemId === null) throw new V2Error("itemId is required");

      const [item] = await db
        .select({ id: whItems.id, sku: whItems.sku, trackingMode: whItems.trackingMode })
        .from(whItems)
        .where(eq(whItems.id, itemId));
      if (!item) throw new V2Error("That item no longer exists", 404);
      if (item.trackingMode !== "asset") {
        throw new V2Error(`${item.sku} is counted as bulk stock — only a tracked asset has individual units`);
      }

      const locationId = parseId(b.locationId);
      if (locationId === null) throw new V2Error("Where is it? Pick a location");
      const [loc] = await db.select().from(whLocations).where(eq(whLocations.id, locationId));
      if (!loc) throw new V2Error("That location does not exist");
      if (loc.kind === "virtual") throw new V2Error("Pick a real bin, a person or a vehicle — not a virtual location");

      const condition = clean(b.condition) ?? "new";
      if (!isInstanceCondition(condition)) throw new V2Error("That is not a condition we record");
      if (condition === "decommissioned") throw new V2Error("You can't add something that's already retired");

      const operatorUserId = req.session.userId!;
      const assetTag = clean(b.assetTag) ? normaliseAssetTag(b.assetTag) : null;

      const created = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(whItemInstances)
          .values({
            itemId,
            assetTag,
            serialNumber: clean(b.serialNumber) ?? null,
            locationId,
            condition,
            purchaseDate: clean(b.purchaseDate) ?? null,
            warrantyUntil: clean(b.warrantyUntil) ?? null,
            costCents: parseId(b.costCents),
            notes: clean(b.notes) ?? null,
          })
          .returning();

        // The row and its first ledger line are born together — an instance
        // that exists but was never received is stock nobody can account for.
        await placeInstanceTx(tx, {
          instanceId: row.id,
          locationId,
          operatorUserId,
          note: clean(b.note) ?? "Asset added",
          idempotencyKey: clean(b.idempotencyKey) ?? null,
        });

        return row;
      });

      res.status(201).json(created);
    } catch (e: any) {
      handleError(res, e, "create instance");
    }
  });

  /** Details that are NOT the thing's location or condition — those move
   *  through the ledger, never through a PATCH. */
  app.patch("/api/admin/warehouse/instances/:id", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) throw new V2Error("Bad id");
      const b = req.body || {};

      if (b.locationId !== undefined) {
        throw new V2Error("Use the move action to change where an asset is — every move is a ledger entry");
      }
      if (b.condition !== undefined) {
        throw new V2Error("Use the move or decommission action to change an asset's condition");
      }

      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (b.assetTag !== undefined) patch.assetTag = clean(b.assetTag) ? normaliseAssetTag(b.assetTag) : null;
      if (b.serialNumber !== undefined) patch.serialNumber = clean(b.serialNumber) ?? null;
      if (b.purchaseDate !== undefined) patch.purchaseDate = clean(b.purchaseDate) ?? null;
      if (b.warrantyUntil !== undefined) patch.warrantyUntil = clean(b.warrantyUntil) ?? null;
      if (b.costCents !== undefined) patch.costCents = parseId(b.costCents);
      if (b.notes !== undefined) patch.notes = clean(b.notes) ?? null;

      const [updated] = await db.update(whItemInstances).set(patch).where(eq(whItemInstances.id, id)).returning();
      if (!updated) throw new V2Error("That asset no longer exists", 404);
      res.json(updated);
    } catch (e: any) {
      handleError(res, e, "update instance");
    }
  });

  app.post("/api/admin/warehouse/instances/:id/move", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) throw new V2Error("Bad id");
      const b = req.body || {};
      const toLocationId = parseId(b.toLocationId);
      if (toLocationId === null) throw new V2Error("Where is it going?");

      const condition = clean(b.condition);
      if (condition && !isInstanceCondition(condition)) throw new V2Error("That is not a condition we record");

      const result = await db.transaction(async (tx) =>
        moveInstanceTx(tx, {
          instanceId: id,
          toLocationId,
          // D17 — from the SESSION, never the body.
          operatorUserId: req.session.userId!,
          condition: (condition as InstanceCondition | undefined) ?? null,
          note: clean(b.note) ?? null,
          idempotencyKey: clean(b.idempotencyKey) ?? null,
        }),
      );
      res.status(result.alreadyProcessed ? 200 : 201).json(result);
    } catch (e: any) {
      handleError(res, e, "move instance");
    }
  });

  app.post("/api/admin/warehouse/instances/:id/decommission", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) throw new V2Error("Bad id");
      const b = req.body || {};
      const result = await db.transaction(async (tx) =>
        decommissionInstanceTx(tx, {
          instanceId: id,
          operatorUserId: req.session.userId!,
          note: clean(b.note) ?? null,
          idempotencyKey: clean(b.idempotencyKey) ?? null,
        }),
      );
      res.status(result.alreadyProcessed ? 200 : 201).json(result);
    } catch (e: any) {
      handleError(res, e, "decommission instance");
    }
  });

  /** One asset's whole life: every movement it has ever been part of. */
  app.get("/api/admin/warehouse/instances/:id/movements", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) throw new V2Error("Bad id");
      const rows = await db
        .select({
          id: whMovements.id,
          delta: whMovements.delta,
          movementType: whMovements.movementType,
          reasonCode: whMovements.reasonCode,
          note: whMovements.note,
          createdAt: whMovements.createdAt,
          locationCode: whLocations.code,
          operatorFirst: users.firstName,
          operatorLast: users.lastName,
        })
        .from(whMovements)
        .innerJoin(whLocations, eq(whMovements.locationId, whLocations.id))
        .leftJoin(users, eq(whMovements.operatorUserId, users.id))
        .where(eq(whMovements.instanceId, id))
        .orderBy(desc(whMovements.createdAt), desc(whMovements.id))
        .limit(300);
      res.json({
        movements: rows.map(({ operatorFirst, operatorLast, ...r }) => ({
          ...r,
          operatorName: [operatorFirst, operatorLast].filter(Boolean).join(" ") || "Unknown",
          typeLabel: MOVEMENT_TYPE_LABELS[r.movementType as keyof typeof MOVEMENT_TYPE_LABELS] ?? r.movementType,
        })),
      });
    } catch (e: any) {
      handleError(res, e, "instance movements");
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Tracking mode (D18) — read the guard, then flip it if it is still safe.
  // ═══════════════════════════════════════════════════════════════════════

  app.get("/api/admin/warehouse/items/:id/tracking-mode", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) throw new V2Error("Bad id");
      const history = await trackingModeHistory(db, id);
      res.json({ ...history, canChange: canChangeTrackingMode(history) });
    } catch (e: any) {
      handleError(res, e, "tracking mode history");
    }
  });

  app.post("/api/admin/warehouse/items/:id/tracking-mode", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      await assertAdmin(req);
      const id = parseId(req.params.id);
      if (id === null) throw new V2Error("Bad id");
      const mode = clean(req.body?.trackingMode);
      if (mode !== "stock" && mode !== "asset") throw new V2Error("trackingMode must be 'stock' or 'asset'");

      // Re-read the history INSIDE the same request that writes, so a
      // movement landing between a UI check and this call still blocks it.
      const history = await trackingModeHistory(db, id);
      if (!canChangeTrackingMode(history)) {
        throw new V2Error(
          `This item already has history (${history.movementCount} movement(s), ${history.instanceCount} unit(s)). ` +
            `Changing how it is tracked now would leave that history describing quantities with nowhere to live — ` +
            `create a new item instead.`,
          409,
        );
      }

      const [updated] = await db
        .update(whItems)
        .set({ trackingMode: mode, updatedAt: new Date() })
        .where(eq(whItems.id, id))
        .returning();
      if (!updated) throw new V2Error("That item no longer exists", 404);
      res.json(updated);
    } catch (e: any) {
      handleError(res, e, "set tracking mode");
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Counter sale (D25) — someone buys something over the desk.
  //
  // Distinct from dispatch, which fulfils an order that already exists. Here
  // the customer is standing there and the movement IS the whole record.
  // ═══════════════════════════════════════════════════════════════════════

  app.post("/api/admin/warehouse/sale", requireAuth, requireTab("warehouse"), async (req, res) => {
    try {
      const b = req.body || {};
      const itemId = parseId(b.itemId);
      if (itemId === null) throw new V2Error("itemId is required");

      const [item] = await db
        .select({ id: whItems.id, sku: whItems.sku, allowNegative: whItems.allowNegative, trackingMode: whItems.trackingMode })
        .from(whItems)
        .where(eq(whItems.id, itemId));
      if (!item) throw new V2Error("That item no longer exists", 404);
      if (item.trackingMode === "asset") {
        throw new V2Error("Tracked assets aren't sold over the counter — move or decommission them instead");
      }

      const locationId = parseId(b.locationId);
      if (locationId === null) throw new V2Error("Which location is it coming out of?");
      const [loc] = await db
        .select({ id: whLocations.id, code: whLocations.code, kind: whLocations.kind })
        .from(whLocations)
        .where(eq(whLocations.id, locationId));
      if (!loc) throw new V2Error("That location does not exist");
      if (!isSellableLocation({ code: loc.code, kind: loc.kind as LocationKind })) {
        throw new V2Error(`Stock at ${loc.code} isn't on the shop floor — it can't be sold from there`);
      }

      const qty = Number(b.qty);
      if (!Number.isFinite(qty) || qty <= 0) throw new V2Error("How many? Enter a quantity above zero");

      // The offline queue replays this endpoint, so the key is REQUIRED, not
      // optional. Without it a retried sale silently sells the shirt twice.
      const idempotencyKey = clean(b.idempotencyKey);
      if (!idempotencyKey) throw new V2Error("idempotencyKey is required for a counter sale");

      const movement = await runMovementGroup({
        legs: [
          {
            itemId,
            locationId: loc.id,
            locationCode: loc.code,
            delta: -qty,
            allowNegative: item.allowNegative,
          },
        ],
        movementType: "sale",
        // D17 — the person signed in at the counter, from the session.
        operatorUserId: req.session.userId!,
        idempotencyKey,
        note: clean(b.note) ?? null,
      });

      res.status(movement.alreadyProcessed ? 200 : 201).json({
        movement,
        itemId,
        sku: item.sku,
        locationId: loc.id,
        locationCode: loc.code,
        qty,
        // Lets the scan station tell "posted" from "we'd already recorded this
        // one" when the offline queue drains.
        replayed: movement.alreadyProcessed,
      });
    } catch (e: any) {
      handleError(res, e, "counter sale");
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Asset overview — the Assets page's summary strip.
  // ═══════════════════════════════════════════════════════════════════════

  app.get("/api/admin/warehouse/assets/overview", requireAuth, requireTab("warehouse"), async (_req, res) => {
    try {
      const today = nzTodayIso();

      const assetItems = await db
        .select({ id: whItems.id, sku: whItems.sku, name: whItems.name, category: whItems.category })
        .from(whItems)
        .where(and(eq(whItems.trackingMode, "asset"), eq(whItems.active, true)))
        .orderBy(asc(whItems.name));

      const counts = await heldInstanceCounts(db);

      const byCondition = await db
        .select({ condition: whItemInstances.condition, n: sql<number>`count(*)::int` })
        .from(whItemInstances)
        .groupBy(whItemInstances.condition);

      // Warranty is judged in SQL against the server's NZ today, never a
      // browser clock, and a missing date is deliberately absent from both
      // buckets rather than counted as fine.
      const [{ expired = 0 } = {}] = await db
        .select({ expired: sql<number>`count(*)::int` })
        .from(whItemInstances)
        .where(sql`${whItemInstances.warrantyUntil} IS NOT NULL AND ${whItemInstances.warrantyUntil} < ${today}
                   AND ${whItemInstances.condition} <> 'decommissioned'`);
      const [{ unknown = 0 } = {}] = await db
        .select({ unknown: sql<number>`count(*)::int` })
        .from(whItemInstances)
        .where(sql`${whItemInstances.warrantyUntil} IS NULL AND ${whItemInstances.condition} <> 'decommissioned'`);

      res.json({
        today,
        items: assetItems.map((i) => ({ ...i, held: counts.get(i.id) ?? 0 })),
        byCondition: Object.fromEntries(byCondition.map((r) => [r.condition, Number(r.n)])),
        warrantyExpired: Number(expired),
        warrantyUnknown: Number(unknown),
      });
    } catch (e: any) {
      handleError(res, e, "assets overview");
    }
  });
}
