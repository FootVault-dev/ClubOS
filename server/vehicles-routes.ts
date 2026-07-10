// ─────────────────────────────────────────────────────────────────────────────
// FLEET — company vehicles. USG workspace, super-admin only.
//
//   GET|POST                 /api/admin/vehicles
//   GET|PATCH|DELETE         /api/admin/vehicles/:id
//   POST                     /api/admin/vehicles/:id/assignments
//   PATCH|DELETE             /api/admin/vehicles/:id/assignments/:childId
//   POST                     /api/admin/vehicles/:id/insurance
//   PATCH|DELETE             /api/admin/vehicles/:id/insurance/:childId
//   POST                     /api/admin/vehicles/:id/services
//   PATCH|DELETE             /api/admin/vehicles/:id/services/:childId
//   POST                     /api/admin/vehicles/:id/costs
//   PATCH|DELETE             /api/admin/vehicles/:id/costs/:childId
//
// Access. Every route is `requireAuth` + `requireTab("vehicles")`, and
// "vehicles" is listed in SUPER_ADMIN_ONLY_TABS — which `canAccessTab` checks
// FIRST, before the usual admin/manager escalation. So the tab is genuinely
// Daniel-only at the API, not merely hidden in the sidebar. Deliberately NOT
// also wrapped in `requireSuperAdmin`: the documented way to open a locked tab
// up is to remove its slug from that set, and a second hard-coded gate would
// silently make that a lie.
//
// Org scoping. `organizationId` is always taken from the X-Workspace-Slug
// header via `workspaceOrg`, never from the request body. A child row is
// reachable only by (id AND vehicleId AND organizationId), so no amount of
// guessing an id crosses a workspace.
//
// Money is stored in cents, integers only. Dates are ISO calendar strings and
// are never round-tripped through a `Date` — see shared/vehicles.ts.
// ─────────────────────────────────────────────────────────────────────────────
import type { Express, Request, Response } from "express";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "./db";
import { requireAuth, requireTab } from "./auth";
import {
  organizations,
  fleetVehicles,
  fleetAssignments,
  fleetInsurancePolicies,
  fleetServiceRecords,
  fleetCosts,
} from "@shared/schema";
import { nzTodayIso } from "@shared/academy";
import {
  isIsoDate,
  isVehicleType,
  isFuelType,
  isVehicleStatus,
  isOwnershipType,
  isComplianceType,
  isInsuranceCoverType,
  isServiceType,
  isCostCategory,
  isFbtExemption,
  vehicleCompliance,
  type PolicyPeriod,
} from "@shared/vehicles";

// ── Org scoping (mirrors workspaceOrg in routes.ts, which isn't exported) ─────
async function workspaceOrg(req: Request): Promise<{ id: number; slug: string } | null> {
  const slug = String(req.headers["x-workspace-slug"] || "").trim();
  if (!slug) return null;
  const [org] = await db.select().from(organizations).where(eq(organizations.slug, slug));
  return org ? { id: org.id, slug: org.slug } : null;
}

// ── Field parsing. The client is never trusted with an org, a vehicle id, or a
//    value outside the enums declared in shared/vehicles.ts. ─────────────────
class BadRequest extends Error {}
class NotFound extends Error {}

const str = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return s.length ? s : null;
};
const reqStr = (v: unknown, field: string): string => {
  const s = str(v);
  if (!s) throw new BadRequest(`${field} is required`);
  return s;
};
const int = (v: unknown, field: string): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
  if (!Number.isInteger(n)) throw new BadRequest(`${field} must be a whole number`);
  return n;
};
const reqInt = (v: unknown, field: string): number => {
  const n = int(v, field);
  if (n === null) throw new BadRequest(`${field} is required`);
  return n;
};
const num = (v: unknown, field: string): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new BadRequest(`${field} must be a number`);
  return n;
};
const isoDate = (v: unknown, field: string): string | null => {
  const s = str(v);
  if (!s) return null;
  if (!isIsoDate(s)) throw new BadRequest(`${field} must be a date (YYYY-MM-DD)`);
  return s;
};
const reqIsoDate = (v: unknown, field: string): string => {
  const s = isoDate(v, field);
  if (!s) throw new BadRequest(`${field} is required`);
  return s;
};
const bool = (v: unknown): boolean => v === true || v === "true";
function pick<T extends string>(v: unknown, guard: (x: unknown) => x is T, field: string, fallback?: T): T {
  const s = str(v);
  if (!s) {
    if (fallback !== undefined) return fallback;
    throw new BadRequest(`${field} is required`);
  }
  if (!guard(s)) throw new BadRequest(`${field} "${s}" is not one of the allowed values`);
  return s;
}

// ── Postgres constraint violations, rendered as sentences a human can act on ──
function friendlyDbError(err: any): { status: number; message: string } | null {
  if (err?.code === "23505") {
    switch (err.constraint) {
      case "fleet_vehicles_org_plate_live_unq":
        return { status: 409, message: "A vehicle with that plate is already on the fleet." };
      case "fleet_assignments_one_open_unq":
        return { status: 409, message: "That vehicle is already assigned to someone. Mark it returned first." };
      default:
        return { status: 409, message: "That record already exists." };
    }
  }
  if (err?.code === "23514") {
    switch (err.constraint) {
      case "fleet_assignments_returned_after_assigned":
        return { status: 400, message: "A vehicle can't be returned before it was assigned." };
      case "fleet_insurance_expires_after_starts":
        return { status: 400, message: "A policy can't expire before it starts." };
      case "fleet_costs_litres_positive":
        return { status: 400, message: "Litres must be greater than zero." };
      default:
        return { status: 400, message: "That value isn't allowed." };
    }
  }
  return null;
}

/** One error funnel: BadRequest → 400, constraint violations → a sentence,
 *  anything else logged and returned as a 500 without leaking internals. */
function handler(fn: (req: Request, res: Response) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (err: any) {
      if (err instanceof BadRequest) return res.status(400).json({ message: err.message });
      if (err instanceof NotFound) return res.status(404).json({ message: err.message });
      const friendly = friendlyDbError(err);
      if (friendly) return res.status(friendly.status).json({ message: friendly.message });
      console.error("[vehicles]", req.method, req.path, err);
      if (!res.headersSent) res.status(500).json({ message: "Something went wrong." });
    }
  };
}

export function registerVehicleRoutes(app: Express) {
  const tab = requireTab("vehicles");

  /** Resolves the workspace org, or throws the right 4xx. */
  async function orgOf(req: Request): Promise<number> {
    const org = await workspaceOrg(req);
    if (!org) throw new BadRequest("X-Workspace-Slug header required");
    return org.id;
  }

  /** A vehicle is only ever reachable through its own org. */
  async function vehicleOf(req: Request, orgId: number) {
    const id = reqInt(req.params.id, "vehicle id");
    const [v] = await db
      .select()
      .from(fleetVehicles)
      .where(and(eq(fleetVehicles.id, id), eq(fleetVehicles.organizationId, orgId)));
    if (!v) throw new NotFound("Vehicle not found");
    return v;
  }

  /** Keep the vehicle's odometer as fresh as the newest reading anyone logs —
   *  a fuel docket, a service, a returned van. RUC status is worthless against
   *  a stale number, and nobody will remember to update it by hand.
   *
   *  Only ever moves forward: a backdated receipt must not rewind the odometer,
   *  and an odometer that goes backwards is a typo, not a fact. */
  async function bumpOdometer(vehicleId: number, orgId: number, km: number | null, onIso: string | null) {
    if (km === null || km < 0 || !onIso) return;
    const [v] = await db
      .select({ odometerKm: fleetVehicles.odometerKm, odometerAt: fleetVehicles.odometerAt })
      .from(fleetVehicles)
      .where(and(eq(fleetVehicles.id, vehicleId), eq(fleetVehicles.organizationId, orgId)));
    if (!v) return;
    const dateIsNewer = !v.odometerAt || onIso >= v.odometerAt; // ISO strings compare chronologically
    const kmIsForward = v.odometerKm === null || km >= v.odometerKm;
    if (dateIsNewer && kmIsForward) {
      await db
        .update(fleetVehicles)
        .set({ odometerKm: km, odometerAt: onIso, updatedAt: new Date() })
        .where(and(eq(fleetVehicles.id, vehicleId), eq(fleetVehicles.organizationId, orgId)));
    }
  }

  const userId = (req: Request) => req.session.userId ?? null;

  // ── Vehicles ───────────────────────────────────────────────────────────────

  function vehicleFields(body: Record<string, unknown>, mode: "create" | "patch") {
    const req_ = mode === "create";
    const f: Record<string, unknown> = {};
    const set = (k: string, parse: () => unknown) => {
      if (req_ || k in body) f[k] = parse();
    };

    // Plates are stored upper-cased: the unique index is on upper(plate), and
    // somebody will always type "abc123".
    set("plate", () => reqStr(body.plate, "Plate").toUpperCase());
    set("make", () => reqStr(body.make, "Make"));
    set("model", () => reqStr(body.model, "Model"));
    set("variant", () => str(body.variant));
    set("year", () => int(body.year, "Year"));
    set("colour", () => str(body.colour));
    set("vin", () => str(body.vin)?.toUpperCase() ?? null);
    set("engineNumber", () => str(body.engineNumber));
    set("vehicleType", () => pick(body.vehicleType, isVehicleType, "Vehicle type", "car"));
    set("fuelType", () => pick(body.fuelType, isFuelType, "Fuel type", "petrol"));
    set("transmission", () => str(body.transmission));
    set("seats", () => int(body.seats, "Seats"));

    set("odometerKm", () => int(body.odometerKm, "Odometer"));
    set("odometerAt", () => isoDate(body.odometerAt, "Odometer reading date"));

    set("complianceType", () => pick(body.complianceType, isComplianceType, "Compliance type", "wof"));
    set("wofExpiresOn", () => isoDate(body.wofExpiresOn, "WOF expiry"));
    set("cofExpiresOn", () => isoDate(body.cofExpiresOn, "COF expiry"));
    set("regoExpiresOn", () => isoDate(body.regoExpiresOn, "Rego expiry"));

    set("rucRequired", () => bool(body.rucRequired));
    set("rucValidToKm", () => int(body.rucValidToKm, "RUC valid to"));

    set("ownership", () => pick(body.ownership, isOwnershipType, "Ownership", "owned"));
    set("lessor", () => str(body.lessor));
    set("leaseEndsOn", () => isoDate(body.leaseEndsOn, "Lease end"));
    set("leaseMonthlyCents", () => int(body.leaseMonthlyCents, "Lease monthly"));
    set("purchasedOn", () => isoDate(body.purchasedOn, "Purchase date"));
    set("purchasePriceCents", () => int(body.purchasePriceCents, "Purchase price"));
    set("supplier", () => str(body.supplier));
    set("disposedOn", () => isoDate(body.disposedOn, "Disposal date"));
    set("disposalPriceCents", () => int(body.disposalPriceCents, "Disposal price"));

    set("status", () => pick(body.status, isVehicleStatus, "Status", "active"));
    set("nextServiceDueOn", () => isoDate(body.nextServiceDueOn, "Next service due"));
    set("nextServiceDueKm", () => int(body.nextServiceDueKm, "Next service due (km)"));

    set("fbtPrivateUse", () => bool(body.fbtPrivateUse));
    set("fbtExemption", () => pick(body.fbtExemption, isFbtExemption, "FBT exemption", "none"));
    set("fbtNotes", () => str(body.fbtNotes));
    set("notes", () => str(body.notes));

    // Cross-field truth: whichever compliance type is selected must have a date
    // to check. We don't force one on create (you may not know it yet) — the
    // badge will read `unknown` and nag until it's filled in, which is the point.
    return f;
  }

  app.get(
    "/api/admin/vehicles",
    requireAuth,
    tab,
    handler(async (req, res) => {
      const orgId = await orgOf(req);
      const today = nzTodayIso();

      const vehicles = await db
        .select()
        .from(fleetVehicles)
        .where(eq(fleetVehicles.organizationId, orgId))
        .orderBy(asc(fleetVehicles.plate));

      // `today` ships even on the empty response — the client must never fall
      // back to its own clock, which is UTC and reads a day behind in NZ.
      if (!vehicles.length) return res.json({ vehicles: [], summary: emptySummary(), today });

      const ids = vehicles.map((v) => v.id);

      // Two extra queries, not 2N. A club has tens of vehicles, not thousands.
      const policies = await db
        .select()
        .from(fleetInsurancePolicies)
        .where(and(eq(fleetInsurancePolicies.organizationId, orgId), inArray(fleetInsurancePolicies.vehicleId, ids)));

      const openAssignments = await db
        .select()
        .from(fleetAssignments)
        .where(
          and(
            eq(fleetAssignments.organizationId, orgId),
            inArray(fleetAssignments.vehicleId, ids),
            // NULL returned_on = they still have it. `isNull`, never
            // `eq(col, null)` — the latter compiles to `= NULL`, which is never
            // true in SQL, and every vehicle would silently read as unassigned.
            // The partial unique index guarantees at most one open row each.
            isNull(fleetAssignments.returnedOn),
          ),
        );

      const policiesFor = (vid: number): PolicyPeriod[] =>
        policies.filter((p) => p.vehicleId === vid).map((p) => ({ startsOn: p.startsOn!, expiresOn: p.expiresOn! }));

      const rows = vehicles.map((v) => {
        const holder = openAssignments.find((a) => a.vehicleId === v.id) ?? null;
        return {
          ...v,
          compliance: vehicleCompliance(v as any, policiesFor(v.id), today),
          holder: holder
            ? { id: holder.id, name: holder.holderName, since: holder.assignedOn, userId: holder.holderUserId }
            : null,
        };
      });

      res.json({ vehicles: rows, summary: summarise(rows), today });
    }),
  );

  app.post(
    "/api/admin/vehicles",
    requireAuth,
    tab,
    handler(async (req, res) => {
      const orgId = await orgOf(req);
      const fields = vehicleFields(req.body ?? {}, "create");
      const [row] = await db
        .insert(fleetVehicles)
        .values({ ...(fields as any), organizationId: orgId, createdBy: userId(req) })
        .returning();
      res.status(201).json({ vehicle: row });
    }),
  );

  app.get(
    "/api/admin/vehicles/:id",
    requireAuth,
    tab,
    handler(async (req, res) => {
      const orgId = await orgOf(req);
      const vehicle = await vehicleOf(req, orgId);
      const today = nzTodayIso();

      const scope = (t: any) => and(eq(t.vehicleId, vehicle.id), eq(t.organizationId, orgId));
      const [assignments, policies, services, costs] = await Promise.all([
        db.select().from(fleetAssignments).where(scope(fleetAssignments)).orderBy(desc(fleetAssignments.assignedOn)),
        db.select().from(fleetInsurancePolicies).where(scope(fleetInsurancePolicies)).orderBy(desc(fleetInsurancePolicies.expiresOn)),
        db.select().from(fleetServiceRecords).where(scope(fleetServiceRecords)).orderBy(desc(fleetServiceRecords.servicedOn)),
        db.select().from(fleetCosts).where(scope(fleetCosts)).orderBy(desc(fleetCosts.incurredOn)),
      ]);

      const periods: PolicyPeriod[] = policies.map((p) => ({ startsOn: p.startsOn!, expiresOn: p.expiresOn! }));

      res.json({
        vehicle,
        compliance: vehicleCompliance(vehicle as any, periods, today),
        holder: assignments.find((a) => a.returnedOn === null) ?? null,
        assignments,
        policies,
        services,
        costs,
        costSummary: summariseCosts(costs, today),
        today,
      });
    }),
  );

  app.patch(
    "/api/admin/vehicles/:id",
    requireAuth,
    tab,
    handler(async (req, res) => {
      const orgId = await orgOf(req);
      const vehicle = await vehicleOf(req, orgId);
      const fields = vehicleFields(req.body ?? {}, "patch");
      const [row] = await db
        .update(fleetVehicles)
        .set({ ...(fields as any), updatedAt: new Date() })
        .where(and(eq(fleetVehicles.id, vehicle.id), eq(fleetVehicles.organizationId, orgId)))
        .returning();
      res.json({ vehicle: row });
    }),
  );

  /** Retire, don't destroy. A vehicle with any history is archived to
   *  `disposed`, exactly as deleting a squad with members archives it — who was
   *  driving the van in March is a question an insurer or the IRD may ask years
   *  later, and a DELETE is the only way to make it unanswerable. A vehicle
   *  entered by mistake, with no history at all, is genuinely deleted. */
  app.delete(
    "/api/admin/vehicles/:id",
    requireAuth,
    tab,
    handler(async (req, res) => {
      const orgId = await orgOf(req);
      const vehicle = await vehicleOf(req, orgId);
      const scope = (t: any) => and(eq(t.vehicleId, vehicle.id), eq(t.organizationId, orgId));

      const [a, p, s, c] = await Promise.all([
        db.select({ id: fleetAssignments.id }).from(fleetAssignments).where(scope(fleetAssignments)).limit(1),
        db.select({ id: fleetInsurancePolicies.id }).from(fleetInsurancePolicies).where(scope(fleetInsurancePolicies)).limit(1),
        db.select({ id: fleetServiceRecords.id }).from(fleetServiceRecords).where(scope(fleetServiceRecords)).limit(1),
        db.select({ id: fleetCosts.id }).from(fleetCosts).where(scope(fleetCosts)).limit(1),
      ]);
      const hasHistory = a.length || p.length || s.length || c.length;

      if (hasHistory) {
        const [row] = await db
          .update(fleetVehicles)
          .set({ status: "disposed", disposedOn: vehicle.disposedOn ?? nzTodayIso(), updatedAt: new Date() })
          .where(and(eq(fleetVehicles.id, vehicle.id), eq(fleetVehicles.organizationId, orgId)))
          .returning();
        return res.json({ archived: true, vehicle: row, message: "Vehicle had history, so it was archived rather than deleted." });
      }

      await db.delete(fleetVehicles).where(and(eq(fleetVehicles.id, vehicle.id), eq(fleetVehicles.organizationId, orgId)));
      res.json({ archived: false, deleted: true });
    }),
  );

  // ── Child resources ────────────────────────────────────────────────────────
  //
  // Every child is created against a vehicle already proved to belong to the
  // caller's org, and is updated/deleted only by (id AND vehicleId AND orgId).

  type ChildSpec = {
    path: string;
    table: any;
    fields: (body: Record<string, unknown>, mode: "create" | "patch") => Record<string, unknown>;
    /** Runs after a create/patch — used to keep the vehicle's odometer fresh. */
    after?: (row: any, vehicleId: number, orgId: number) => Promise<void>;
  };

  const children: ChildSpec[] = [
    {
      path: "assignments",
      table: fleetAssignments,
      fields: (b, mode) => {
        const req_ = mode === "create";
        const f: Record<string, unknown> = {};
        const set = (k: string, parse: () => unknown) => { if (req_ || k in b) f[k] = parse(); };
        set("holderUserId", () => int(b.holderUserId, "Holder user"));
        set("holderName", () => reqStr(b.holderName, "Who has it"));
        set("holderEmail", () => str(b.holderEmail));
        set("holderPhone", () => str(b.holderPhone));
        set("licenceClass", () => str(b.licenceClass));
        set("licenceExpiresOn", () => isoDate(b.licenceExpiresOn, "Licence expiry"));
        set("assignedOn", () => reqIsoDate(b.assignedOn, "Assigned on"));
        set("returnedOn", () => isoDate(b.returnedOn, "Returned on"));
        set("odometerStartKm", () => int(b.odometerStartKm, "Odometer at handover"));
        set("odometerEndKm", () => int(b.odometerEndKm, "Odometer at return"));
        set("purpose", () => str(b.purpose));
        set("notes", () => str(b.notes));
        return f;
      },
      // Returning a van tells us its odometer on the day it came back.
      after: (row, vid, orgId) => bumpOdometer(vid, orgId, row.odometerEndKm ?? null, row.returnedOn ?? null),
    },
    {
      path: "insurance",
      table: fleetInsurancePolicies,
      fields: (b, mode) => {
        const req_ = mode === "create";
        const f: Record<string, unknown> = {};
        const set = (k: string, parse: () => unknown) => { if (req_ || k in b) f[k] = parse(); };
        set("insurer", () => reqStr(b.insurer, "Insurer"));
        set("policyNumber", () => reqStr(b.policyNumber, "Policy number"));
        set("coverType", () => pick(b.coverType, isInsuranceCoverType, "Cover type", "comprehensive"));
        set("startsOn", () => reqIsoDate(b.startsOn, "Policy start"));
        set("expiresOn", () => reqIsoDate(b.expiresOn, "Policy expiry"));
        set("excessCents", () => int(b.excessCents, "Excess"));
        set("premiumCents", () => int(b.premiumCents, "Premium"));
        set("agreedValueCents", () => int(b.agreedValueCents, "Agreed value"));
        set("contactName", () => str(b.contactName));
        set("contactPhone", () => str(b.contactPhone));
        set("notes", () => str(b.notes));
        return f;
      },
    },
    {
      path: "services",
      table: fleetServiceRecords,
      fields: (b, mode) => {
        const req_ = mode === "create";
        const f: Record<string, unknown> = {};
        const set = (k: string, parse: () => unknown) => { if (req_ || k in b) f[k] = parse(); };
        set("servicedOn", () => reqIsoDate(b.servicedOn, "Service date"));
        set("serviceType", () => pick(b.serviceType, isServiceType, "Service type", "service"));
        set("provider", () => str(b.provider));
        set("odometerKm", () => int(b.odometerKm, "Odometer"));
        set("description", () => str(b.description));
        set("costCents", () => int(b.costCents, "Cost"));
        set("invoiceRef", () => str(b.invoiceRef));
        set("nextServiceDueOn", () => isoDate(b.nextServiceDueOn, "Next service due"));
        set("nextServiceDueKm", () => int(b.nextServiceDueKm, "Next service due (km)"));
        set("notes", () => str(b.notes));
        return f;
      },
      after: async (row, vid, orgId) => {
        await bumpOdometer(vid, orgId, row.odometerKm ?? null, row.servicedOn ?? null);
        // Logging a service is the moment you learn when the next one is due,
        // so it updates the vehicle's own "next due" that the badge reads.
        if (row.nextServiceDueOn || row.nextServiceDueKm) {
          await db
            .update(fleetVehicles)
            .set({
              ...(row.nextServiceDueOn ? { nextServiceDueOn: row.nextServiceDueOn } : {}),
              ...(row.nextServiceDueKm ? { nextServiceDueKm: row.nextServiceDueKm } : {}),
              updatedAt: new Date(),
            })
            .where(and(eq(fleetVehicles.id, vid), eq(fleetVehicles.organizationId, orgId)));
        }
      },
    },
    {
      path: "costs",
      table: fleetCosts,
      fields: (b, mode) => {
        const req_ = mode === "create";
        const f: Record<string, unknown> = {};
        const set = (k: string, parse: () => unknown) => { if (req_ || k in b) f[k] = parse(); };
        set("incurredOn", () => reqIsoDate(b.incurredOn, "Date"));
        set("category", () => pick(b.category, isCostCategory, "Category"));
        set("amountCents", () => reqInt(b.amountCents, "Amount"));
        set("supplier", () => str(b.supplier));
        set("reference", () => str(b.reference));
        set("odometerKm", () => int(b.odometerKm, "Odometer"));
        set("litres", () => num(b.litres, "Litres"));
        set("notes", () => str(b.notes));
        return f;
      },
      // A fuel docket is the most frequent odometer reading the club will ever
      // record. Free freshness for the RUC badge.
      after: (row, vid, orgId) => bumpOdometer(vid, orgId, row.odometerKm ?? null, row.incurredOn ?? null),
    },
  ];

  for (const spec of children) {
    app.post(
      `/api/admin/vehicles/:id/${spec.path}`,
      requireAuth,
      tab,
      handler(async (req, res) => {
        const orgId = await orgOf(req);
        const vehicle = await vehicleOf(req, orgId);
        const fields = spec.fields(req.body ?? {}, "create");
        // `spec.table` is deliberately loose so one loop serves four tables;
        // drizzle's insert() then resolves to a union TS can't destructure.
        const inserted = (await db
          .insert(spec.table)
          .values({ ...(fields as any), vehicleId: vehicle.id, organizationId: orgId, createdBy: userId(req) })
          .returning()) as any[];
        const row = inserted[0];
        await spec.after?.(row, vehicle.id, orgId);
        res.status(201).json({ row });
      }),
    );

    app.patch(
      `/api/admin/vehicles/:id/${spec.path}/:childId`,
      requireAuth,
      tab,
      handler(async (req, res) => {
        const orgId = await orgOf(req);
        const vehicle = await vehicleOf(req, orgId);
        const childId = reqInt(req.params.childId, "id");
        const fields = spec.fields(req.body ?? {}, "patch");
        const [row] = await db
          .update(spec.table)
          .set({ ...(fields as any), updatedAt: new Date() })
          .where(and(eq(spec.table.id, childId), eq(spec.table.vehicleId, vehicle.id), eq(spec.table.organizationId, orgId)))
          .returning();
        if (!row) return res.status(404).json({ message: "Not found" });
        await spec.after?.(row, vehicle.id, orgId);
        res.json({ row });
      }),
    );

    app.delete(
      `/api/admin/vehicles/:id/${spec.path}/:childId`,
      requireAuth,
      tab,
      handler(async (req, res) => {
        const orgId = await orgOf(req);
        const vehicle = await vehicleOf(req, orgId);
        const childId = reqInt(req.params.childId, "id");
        const deleted = await db
          .delete(spec.table)
          .where(and(eq(spec.table.id, childId), eq(spec.table.vehicleId, vehicle.id), eq(spec.table.organizationId, orgId)))
          .returning({ id: spec.table.id });
        if (!deleted.length) return res.status(404).json({ message: "Not found" });
        res.json({ deleted: true });
      }),
    );
  }
}

// ── Rollups ──────────────────────────────────────────────────────────────────

function emptySummary() {
  return { total: 0, active: 0, expired: 0, dueSoon: 0, unknown: 0, unassigned: 0 };
}

function summarise(rows: Array<{ status: string; compliance: { overall: string }; holder: unknown }>) {
  const live = rows.filter((r) => r.status !== "disposed");
  return {
    total: rows.length,
    active: live.length,
    expired: live.filter((r) => r.compliance.overall === "expired").length,
    dueSoon: live.filter((r) => r.compliance.overall === "due_soon").length,
    unknown: live.filter((r) => r.compliance.overall === "unknown").length,
    unassigned: live.filter((r) => !r.holder).length,
  };
}

/** Costs, in cents. `last12m` uses a plain string comparison against the ISO
 *  date twelve months back — no Date arithmetic, so no timezone to get wrong. */
function summariseCosts(costs: Array<{ category: string; amountCents: number; incurredOn: string | null; litres: number | null; odometerKm: number | null }>, todayIso: string) {
  const [y, m, d] = todayIso.split("-").map(Number);
  const cutoff = `${String(y - 1).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

  const byCategory: Record<string, number> = {};
  let total = 0;
  let last12m = 0;
  let fuelLitres = 0;
  let fuelCents = 0;

  for (const c of costs) {
    total += c.amountCents;
    byCategory[c.category] = (byCategory[c.category] ?? 0) + c.amountCents;
    if (c.incurredOn && c.incurredOn >= cutoff) last12m += c.amountCents;
    if (c.category === "fuel" && c.litres) {
      fuelLitres += c.litres;
      fuelCents += c.amountCents;
    }
  }

  // Distance covered by the fuel records we hold, which is the only honest
  // denominator we have. Null rather than a made-up number when we can't tell.
  const odos = costs.filter((c) => c.category === "fuel" && c.odometerKm !== null).map((c) => c.odometerKm as number);
  const kmSpan = odos.length >= 2 ? Math.max(...odos) - Math.min(...odos) : 0;

  return {
    totalCents: total,
    last12mCents: last12m,
    byCategory,
    fuelLitres: fuelLitres || null,
    centsPerLitre: fuelLitres > 0 ? Math.round(fuelCents / fuelLitres) : null,
    litresPer100km: kmSpan > 0 && fuelLitres > 0 ? Math.round((fuelLitres / kmSpan) * 100 * 10) / 10 : null,
  };
}
