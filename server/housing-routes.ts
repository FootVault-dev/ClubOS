// ─────────────────────────────────────────────────────────────────────────────
// HOUSING — the residency houses at the United Sports Centre.
//
// Admin only (session + the "housing" tab), org-scoped to the workspace the
// request came from. There is NO public surface: nothing here is ever served to
// a browser that isn't logged into ClubOS. Tenants are people, and their rent
// arrears are not a public fact.
//
//   GET    /api/admin/housing/overview
//   GET    /api/admin/housing/houses            POST /api/admin/housing/houses
//   PATCH  /api/admin/housing/houses/:id        DELETE (archives if it has rooms)
//   POST   /api/admin/housing/rooms
//   PATCH  /api/admin/housing/rooms/:id         DELETE (archives if it has tenancies)
//   GET    /api/admin/housing/tenancies         POST /api/admin/housing/tenancies
//   PATCH  /api/admin/housing/tenancies/:id     DELETE (only when it has no paid charges)
//   POST   /api/admin/housing/tenancies/:id/charges     — generate the rent schedule
//   GET    /api/admin/housing/charges           PATCH /api/admin/housing/charges/:id
//   GET    /api/admin/housing/utilities         POST /api/admin/housing/utilities
//   PATCH  /api/admin/housing/utilities/:id     DELETE
//   GET    /api/admin/housing/bills             POST /api/admin/housing/bills
//   PATCH  /api/admin/housing/bills/:id         DELETE
//   GET    /api/admin/housing/tenant-search?q=  — find or create a contact
//   POST   /api/admin/housing/tenants
//
// Money is integer cents on the wire and in the DB; the client renders dollars.
// Amounts are always recomputed server-side — the browser never says what a
// charge is worth, it only says which room and which tenancy.
// ─────────────────────────────────────────────────────────────────────────────
import type { Express, Request, Response } from "express";
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "./db";
import { requireAuth, requireTab } from "./auth";
import {
  organizations, contacts, users,
  housingHouses, housingRooms, housingTenancies, housingRentCharges,
  housingUtilityAccounts, housingUtilityBills,
  housingPeriods, housingRoster, housingActionItems,
} from "@shared/schema";
import {
  isRoomType, isRentFrequency, isUtilityKind, isPaymentMethod,
  parseIso, nzTodayIso, addDaysIso, compareIso,
  tenancyState, rangesOverlap,
  paymentState, daysOverdue, amountOutstandingCents,
  chargePeriods, annualisedRentCents, summariseOccupancy,
  MAX_GENERATED_CHARGES,
  type RentFrequency,
  // Accommodation (2026-08-18)
  isAgreementType, isOccupantCategory, isConditionStatus, isConditionReport,
  isActionKind, isActionPriority, isActionStatus, isChargeKind, isActionOpen,
  checkOutToLastNight, tenancyMoney, statedVarianceCents, hasMaterialVariance,
  summariseAccommodation, findPersonOverlaps, accommodationStatus,
  type TenancyMoney,
} from "@shared/housing";

// ── Small helpers ────────────────────────────────────────────────────────────
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

/** Accept only a bare `YYYY-MM-DD`. A timestamp here is how dates slip a day.
 *  With `allowNull`, an empty string clears the field — which is what an empty
 *  `<input type="date">` sends for "no end date". */
function isoDate(v: any, { allowNull = false } = {}): string | null | undefined {
  if (v === null || v === undefined || v === "") return allowNull ? null : undefined;
  const raw = s(v, 10);
  return parseIso(raw) ? raw : undefined;
}

/** A payment date is NOT the same kind of field.
 *
 *  🔴 Only a literal `null` un-marks a payment. An empty string is a bug in the
 *  caller — a half-loaded page sending `paidOn: ""` must never be read as "this
 *  charge was never paid" and silently wipe a recorded payment. Returns
 *  `undefined` for anything that is neither a real date nor `null`. */
function paidDate(v: any): string | null | undefined {
  if (v === null) return null;
  if (v === undefined) return undefined;
  const raw = s(v, 10);
  return parseIso(raw) ? raw : undefined;
}

const id = (v: any): number | null => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// ── Org scoping (mirrors workspaceOrg in routes.ts, which isn't exported) ─────
async function workspaceOrg(req: Request): Promise<{ id: number; slug: string } | null> {
  const slug = String(req.headers["x-workspace-slug"] || "").trim();
  if (!slug) return null;
  const [org] = await db.select().from(organizations).where(eq(organizations.slug, slug));
  return org ? { id: org.id, slug: org.slug } : null;
}

/** Every handler starts here. A missing/unknown workspace header is a 400, not
 *  an unscoped query — a housing row must never leak across workspaces. */
async function orgOr400(req: Request, res: Response): Promise<{ id: number } | null> {
  const org = await workspaceOrg(req);
  if (!org) {
    res.status(400).json({ message: "X-Workspace-Slug header required" });
    return null;
  }
  return org;
}

const fail = (res: Response, e: any) => {
  console.error("[housing]", e?.message || e);
  res.status(500).json({ message: e?.message || "Housing request failed" });
};

/** Postgres raises 23P01 when the EXCLUDE constraint stops two tenants sharing
 *  a room. Translate it into something a coordinator can act on. */
function isOverlapViolation(e: any): boolean {
  return e?.code === "23P01" && String(e?.constraint || "").includes("no_overlap");
}

// ── Enriched reads ───────────────────────────────────────────────────────────

/**
 * The ONE place a stored tenancy becomes a set of numbers.
 *
 * Every surface — the overview, the tenancy list, the invoicing matrix, the
 * seed's verification — goes through this, so the figure on screen is the
 * figure the server derived and there is no second opinion about what somebody
 * owes. The source workbook's problem was four opinions.
 */
function enrichTenancy<T extends {
  startDate: string; endDate: string | null; rentCents: number;
  utilitiesCents?: number | null; utilitiesIncluded?: boolean | null;
  holidayWeeks?: string | number | null; rentFrequency?: string | null;
  statedTotalCents?: number | null; roomId?: number | null;
}>(t: T, today: string) {
  // `holiday_weeks` is numeric(5,2), which the pg driver hands back as a STRING.
  // Number("") is 0 but Number(null) is also 0 — both are "no holiday", so the
  // coercion is safe here; anything unparseable falls back to 0 rather than NaN.
  const holidayWeeks = Number(t.holidayWeeks ?? 0);
  const money = tenancyMoney({
    startDate: t.startDate,
    endDate: t.endDate,
    rentCents: t.rentCents,
    utilitiesCents: t.utilitiesCents ?? 0,
    utilitiesIncluded: !!t.utilitiesIncluded,
    holidayWeeks: Number.isFinite(holidayWeeks) ? holidayWeeks : 0,
    rentFrequency: (t.rentFrequency as RentFrequency) ?? "weekly",
  }, today);
  const variance = money ? statedVarianceCents(money.totalCents, t.statedTotalCents) : null;
  return {
    ...t,
    holidayWeeks,
    state: tenancyState(t.startDate, t.endDate, today),
    money,
    variance,
    hasVariance: money ? hasMaterialVariance(money.totalCents, t.statedTotalCents) : false,
    roomConfirmed: t.roomId !== null && t.roomId !== undefined,
  };
}

async function activeTenanciesFor(orgId: number, today: string) {
  const rows = await db
    .select({
      tenancy: housingTenancies,
      contact: contacts,
      room: housingRooms,
    })
    .from(housingTenancies)
    .innerJoin(contacts, eq(contacts.id, housingTenancies.contactId))
    .innerJoin(housingRooms, eq(housingRooms.id, housingTenancies.roomId))
    .where(eq(housingTenancies.organizationId, orgId));

  return rows.filter(r => tenancyState(r.tenancy.startDate, r.tenancy.endDate, today) === "active");
}

export function registerHousingRoutes(app: Express) {
  const tab = requireTab("housing");

  // ── Overview ───────────────────────────────────────────────────────────────
  // Everything the coordinator needs on one screen: who is behind on rent, what
  // bills are late, and how many beds are empty.
  app.get("/api/admin/housing/overview", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const today = nzTodayIso();

      const [houses, rooms, tenancyRows, charges, utilAccounts, bills] = await Promise.all([
        db.select().from(housingHouses).where(and(eq(housingHouses.organizationId, org.id), isNull(housingHouses.archivedAt))).orderBy(asc(housingHouses.name)),
        db.select().from(housingRooms).where(and(eq(housingRooms.organizationId, org.id), isNull(housingRooms.archivedAt))),
        db.select({ tenancy: housingTenancies, contact: contacts })
          .from(housingTenancies)
          .innerJoin(contacts, eq(contacts.id, housingTenancies.contactId))
          .where(eq(housingTenancies.organizationId, org.id)),
        db.select().from(housingRentCharges).where(eq(housingRentCharges.organizationId, org.id)),
        db.select().from(housingUtilityAccounts).where(and(eq(housingUtilityAccounts.organizationId, org.id), isNull(housingUtilityAccounts.archivedAt))),
        db.select().from(housingUtilityBills).where(eq(housingUtilityBills.organizationId, org.id)),
      ]);

      const activeTenancies = tenancyRows.filter(r => tenancyState(r.tenancy.startDate, r.tenancy.endDate, today) === "active");
      // A tenancy whose room is disputed occupies no room we can name, so it
      // cannot count toward occupancy — but its MONEY still counts, which is why
      // it is dropped here and not from the rent figures below.
      const activeRoomIds = activeTenancies
        .map(r => r.tenancy.roomId)
        .filter((v): v is number => typeof v === "number");
      const occupancy = summariseAccommodation(rooms, activeRoomIds);

      // Per-house occupancy, so an empty house is obvious at a glance.
      const roomsByHouse = new Map<number, typeof rooms>();
      for (const r of rooms) {
        if (!roomsByHouse.has(r.houseId)) roomsByHouse.set(r.houseId, []);
        roomsByHouse.get(r.houseId)!.push(r);
      }
      const houseSummaries = houses.map(h => ({
        ...h,
        ...summariseAccommodation(roomsByHouse.get(h.id) ?? [], activeRoomIds),
      }));

      const overdueCharges = charges.filter(c => paymentState(c, today) === "overdue");
      const overdueBills = bills.filter(b => paymentState(b, today) === "overdue");
      const dueSoonCharges = charges.filter(c => paymentState(c, today) === "due_soon");
      const dueSoonBills = bills.filter(b => paymentState(b, today) === "due_soon");

      const sumOutstanding = (rows: { amountCents: number; paidAmountCents: number | null; waived: boolean; dueOn: string; paidOn: string | null }[]) =>
        rows.reduce((t, r) => t + amountOutstandingCents(r), 0);

      // The rent roll: what the occupied rooms are contracted to bring in a year.
      const annualRentCents = activeTenancies.reduce(
        (t, r) => t + annualisedRentCents(r.tenancy.rentCents, (r.tenancy.rentFrequency as RentFrequency)), 0);

      // ── What is not yet trustworthy ──────────────────────────────────────
      // Derived live, never a stored checklist, so an item disappears the moment
      // somebody actually fixes it. Half the source workbook's action list is
      // answerable from the data itself; only the human decisions are stored.
      const enrichedAll = tenancyRows.map(r => enrichTenancy(r.tenancy, today));
      const rosterRows = await db.select({ r: housingRoster, c: contacts })
        .from(housingRoster).innerJoin(contacts, eq(contacts.id, housingRoster.contactId))
        .where(and(eq(housingRoster.organizationId, org.id), isNull(housingRoster.archivedAt)));

      const activeEnriched = enrichedAll.filter(t => t.state === "active");
      const compliance = {
        roomUnconfirmed: enrichedAll.filter(t => !t.roomConfirmed).length,
        agreementUndecided: activeEnriched.filter(t => !t.agreementType || t.agreementType === "undecided").length,
        conditionReportPending: activeEnriched.filter(t => t.conditionReport !== "signed").length,
        keyNotIssued: activeEnriched.filter(t => !t.keyIssued).length,
        legalNameUnverified: rosterRows.filter(x => !x.r.legalNameVerified).length,
        missingEmail: rosterRows.filter(x => !x.c.email).length,
        // Nobody in this residency has a phone number on file, which matters at
        // 2am far more than an email address does.
        missingPhone: rosterRows.filter(x => !x.c.phone).length,
        missingEmergencyContact: rosterRows.filter(x => !x.r.emergencyContactName || !x.r.emergencyContactPhone).length,
        roomsNeverInspected: rooms.filter(r => !r.conditionStatus || r.conditionStatus === "unknown").length,
        personOverlaps: findPersonOverlaps(tenancyRows.map(r => ({
          id: r.tenancy.id, contactId: r.tenancy.contactId, roomId: r.tenancy.roomId,
          startDate: r.tenancy.startDate, endDate: r.tenancy.endDate,
        }))).length,
      };

      const actions = await db.select().from(housingActionItems)
        .where(eq(housingActionItems.organizationId, org.id));
      const openActions = actions.filter(a => isActionOpen(a.status));

      // The recomputed cost of every tenancy against what the club wrote down.
      const varianceRows = enrichedAll.filter(t => t.hasVariance);
      const varianceCents = varianceRows.reduce((t, r) => t + (r.variance ?? 0), 0);

      res.json({
        today,
        occupancy,
        houses: houseSummaries,
        activeTenants: activeTenancies.length,
        annualRentCents,
        compliance,
        actions: {
          open: openActions.length,
          high: openActions.filter(a => a.priority === "high").length,
          conflicts: openActions.filter(a => a.kind === "conflict").length,
        },
        variance: {
          rows: varianceRows.length,
          cents: varianceCents,
          // Positive means the club appears to have under-billed.
          underBilledCents: varianceRows.reduce((t, r) => t + Math.max(0, r.variance ?? 0), 0),
          overBilledCents: varianceRows.reduce((t, r) => t + Math.min(0, r.variance ?? 0), 0),
        },
        // Weekly income actually being invoiced right now, split so that a
        // remuneration room does not read as a hole in the rent roll.
        weekly: {
          rentCents: activeEnriched.reduce((t, r) => t + (r.money?.weeklyRentCents ?? 0), 0),
          utilitiesCents: activeEnriched.reduce((t, r) => t + (r.money?.weeklyUtilitiesCents ?? 0), 0),
          remunerationRooms: activeEnriched.filter(r => r.isRemuneration).length,
        },
        rent: {
          overdueCount: overdueCharges.length,
          overdueCents: sumOutstanding(overdueCharges),
          dueSoonCount: dueSoonCharges.length,
          dueSoonCents: sumOutstanding(dueSoonCharges),
        },
        utilities: {
          accounts: utilAccounts.length,
          overdueCount: overdueBills.length,
          overdueCents: sumOutstanding(overdueBills),
          dueSoonCount: dueSoonBills.length,
          dueSoonCents: sumOutstanding(dueSoonBills),
        },
      });
    } catch (e) { fail(res, e); }
  });

  // ── Houses ─────────────────────────────────────────────────────────────────
  app.get("/api/admin/housing/houses", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const today = nzTodayIso();
      const includeArchived = truthy(req.query.includeArchived);

      const houses = await db.select().from(housingHouses)
        .where(includeArchived
          ? eq(housingHouses.organizationId, org.id)
          : and(eq(housingHouses.organizationId, org.id), isNull(housingHouses.archivedAt)))
        .orderBy(asc(housingHouses.name));

      const rooms = await db.select().from(housingRooms)
        .where(and(eq(housingRooms.organizationId, org.id), isNull(housingRooms.archivedAt)))
        .orderBy(asc(housingRooms.name));

      // innerJoins rooms, so every row here has a room — the filter below is
      // what tells TypeScript that, now that room_id is nullable.
      const active = (await activeTenanciesFor(org.id, today))
        .filter(a => typeof a.tenancy.roomId === "number");
      const tenantByRoom = new Map<number, any>(active.map(a => [a.tenancy.roomId as number, {
        tenancyId: a.tenancy.id,
        contactId: a.contact.id,
        name: `${a.contact.firstName} ${a.contact.lastName}`.trim(),
        email: a.contact.email,
        phone: a.contact.phone,
        rentCents: a.tenancy.rentCents,
        rentFrequency: a.tenancy.rentFrequency,
        utilitiesCents: a.tenancy.utilitiesCents,
        utilitiesIncluded: a.tenancy.utilitiesIncluded,
        isRemuneration: a.tenancy.isRemuneration,
        agreementType: a.tenancy.agreementType,
        startDate: a.tenancy.startDate,
        endDate: a.tenancy.endDate,
      }]));

      const occupiedRoomIds = Array.from(tenantByRoom.keys());
      res.json(houses.map(h => {
        const hRooms = rooms.filter(r => r.houseId === h.id);
        const summary = summariseAccommodation(hRooms, occupiedRoomIds);
        return {
          ...h,
          // Spread the counts BEFORE `rooms`, so the room array is what wins the
          // `rooms` key. The client reads the count as `house.rooms.length`.
          occupied: summary.occupied,
          vacant: summary.vacant,
          occupancyPct: summary.occupancyPct,
          roomCount: summary.rooms,
          rooms: hRooms.map(r => ({ ...r, tenant: tenantByRoom.get(r.id) ?? null })),
        };
      }));
    } catch (e) { fail(res, e); }
  });

  app.post("/api/admin/housing/houses", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const name = s(req.body?.name, 120);
      if (!name) return res.status(400).json({ message: "House name is required" });
      const [row] = await db.insert(housingHouses).values({
        organizationId: org.id,
        name,
        address: sOrNull(req.body?.address),
        notes: sOrNull(req.body?.notes, 2000),
      }).returning();
      res.status(201).json(row);
    } catch (e: any) {
      if (e?.code === "23505") return res.status(409).json({ message: "A house with that name already exists" });
      fail(res, e);
    }
  });

  app.patch("/api/admin/housing/houses/:id", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const houseId = id(req.params.id);
      if (!houseId) return res.status(400).json({ message: "Bad id" });

      const patch: Record<string, any> = { updatedAt: new Date() };
      if (req.body?.name !== undefined) {
        const name = s(req.body.name, 120);
        if (!name) return res.status(400).json({ message: "House name is required" });
        patch.name = name;
      }
      if (req.body?.address !== undefined) patch.address = sOrNull(req.body.address);
      if (req.body?.notes !== undefined) patch.notes = sOrNull(req.body.notes, 2000);
      if (req.body?.archived !== undefined) patch.archivedAt = truthy(req.body.archived) ? new Date() : null;

      const [row] = await db.update(housingHouses).set(patch)
        .where(and(eq(housingHouses.id, houseId), eq(housingHouses.organizationId, org.id)))
        .returning();
      if (!row) return res.status(404).json({ message: "House not found" });
      res.json(row);
    } catch (e: any) {
      if (e?.code === "23505") return res.status(409).json({ message: "A house with that name already exists" });
      fail(res, e);
    }
  });

  // Deleting a house that has ever housed anyone ARCHIVES it. A tenancy is a
  // financial record; it does not disappear because someone tidied the list.
  app.delete("/api/admin/housing/houses/:id", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const houseId = id(req.params.id);
      if (!houseId) return res.status(400).json({ message: "Bad id" });

      const rooms = await db.select({ id: housingRooms.id }).from(housingRooms).where(eq(housingRooms.houseId, houseId));
      const roomIds = rooms.map(r => r.id);
      const tenancyCount = roomIds.length
        ? (await db.select({ id: housingTenancies.id }).from(housingTenancies).where(inArray(housingTenancies.roomId, roomIds))).length
        : 0;

      if (tenancyCount > 0) {
        const [row] = await db.update(housingHouses).set({ archivedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(housingHouses.id, houseId), eq(housingHouses.organizationId, org.id))).returning();
        if (!row) return res.status(404).json({ message: "House not found" });
        return res.json({ archived: true, reason: `${tenancyCount} tenancy record(s) kept` });
      }

      const [row] = await db.delete(housingHouses)
        .where(and(eq(housingHouses.id, houseId), eq(housingHouses.organizationId, org.id))).returning();
      if (!row) return res.status(404).json({ message: "House not found" });
      res.json({ deleted: true });
    } catch (e) { fail(res, e); }
  });

  // ── Rooms ──────────────────────────────────────────────────────────────────
  app.post("/api/admin/housing/rooms", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const houseId = id(req.body?.houseId);
      const name = s(req.body?.name, 120);
      if (!houseId || !name) return res.status(400).json({ message: "House and room name are required" });

      const [house] = await db.select().from(housingHouses)
        .where(and(eq(housingHouses.id, houseId), eq(housingHouses.organizationId, org.id)));
      if (!house) return res.status(404).json({ message: "House not found" });

      const roomType = s(req.body?.roomType, 20) || "single";
      if (!isRoomType(roomType)) return res.status(400).json({ message: "Unknown room type" });
      const freq = s(req.body?.defaultRentFrequency, 20) || "weekly";
      if (!isRentFrequency(freq)) return res.status(400).json({ message: "Unknown rent frequency" });
      const rent = cents(req.body?.defaultRentCents ?? 0);
      if (rent === undefined) return res.status(400).json({ message: "Rent must be a whole number of cents" });

      const util = cents(req.body?.defaultUtilitiesCents ?? 0);
      if (util === undefined) return res.status(400).json({ message: "Utilities must be a whole number of cents" });
      const condition = s(req.body?.conditionStatus, 30);
      if (condition && !isConditionStatus(condition)) return res.status(400).json({ message: "Unknown condition status" });

      const [row] = await db.insert(housingRooms).values({
        houseId, organizationId: org.id, name, roomType,
        defaultRentCents: rent ?? 0, defaultRentFrequency: freq,
        defaultUtilitiesCents: util ?? 0,
        bedConfig: sOrNull(req.body?.bedConfig, 80),
        occupantType: sOrNull(req.body?.occupantType, 80),
        keyCode: sOrNull(req.body?.keyCode, 60),
        conditionStatus: condition || null,
        conditionCheckedOn: isoDate(req.body?.conditionCheckedOn, { allowNull: true }) ?? null,
        propertyLead: sOrNull(req.body?.propertyLead, 120),
        isReserve: truthy(req.body?.isReserve),
        notes: sOrNull(req.body?.notes, 2000),
      }).returning();
      res.status(201).json(row);
    } catch (e: any) {
      if (e?.code === "23505") return res.status(409).json({ message: "That house already has a room with this name" });
      fail(res, e);
    }
  });

  app.patch("/api/admin/housing/rooms/:id", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const roomId = id(req.params.id);
      if (!roomId) return res.status(400).json({ message: "Bad id" });

      const patch: Record<string, any> = { updatedAt: new Date() };
      if (req.body?.name !== undefined) {
        const name = s(req.body.name, 120);
        if (!name) return res.status(400).json({ message: "Room name is required" });
        patch.name = name;
      }
      if (req.body?.roomType !== undefined) {
        if (!isRoomType(req.body.roomType)) return res.status(400).json({ message: "Unknown room type" });
        patch.roomType = req.body.roomType;
      }
      if (req.body?.defaultRentFrequency !== undefined) {
        if (!isRentFrequency(req.body.defaultRentFrequency)) return res.status(400).json({ message: "Unknown rent frequency" });
        patch.defaultRentFrequency = req.body.defaultRentFrequency;
      }
      if (req.body?.defaultRentCents !== undefined) {
        const v = cents(req.body.defaultRentCents);
        if (v === undefined) return res.status(400).json({ message: "Rent must be a whole number of cents" });
        patch.defaultRentCents = v;
      }
      if (req.body?.defaultUtilitiesCents !== undefined) {
        const v = cents(req.body.defaultUtilitiesCents);
        if (v === undefined) return res.status(400).json({ message: "Utilities must be a whole number of cents" });
        patch.defaultUtilitiesCents = v;
      }
      if (req.body?.conditionStatus !== undefined) {
        const v = s(req.body.conditionStatus, 30);
        if (v && !isConditionStatus(v)) return res.status(400).json({ message: "Unknown condition status" });
        patch.conditionStatus = v || null;
        // Recording a condition without recording WHEN leaves a badge that ages
        // into a lie, so an inspection always stamps its own date unless one is
        // given. Same reasoning as the fleet tab's odometer reading.
        if (req.body.conditionCheckedOn === undefined) patch.conditionCheckedOn = nzTodayIso();
      }
      if (req.body?.conditionCheckedOn !== undefined) {
        const v = isoDate(req.body.conditionCheckedOn, { allowNull: true });
        if (v === undefined) return res.status(400).json({ message: "Inspection date must be YYYY-MM-DD" });
        patch.conditionCheckedOn = v;
      }
      if (req.body?.bedConfig !== undefined) patch.bedConfig = sOrNull(req.body.bedConfig, 80);
      if (req.body?.occupantType !== undefined) patch.occupantType = sOrNull(req.body.occupantType, 80);
      if (req.body?.keyCode !== undefined) patch.keyCode = sOrNull(req.body.keyCode, 60);
      if (req.body?.propertyLead !== undefined) patch.propertyLead = sOrNull(req.body.propertyLead, 120);
      if (req.body?.isReserve !== undefined) patch.isReserve = truthy(req.body.isReserve);
      if (req.body?.notes !== undefined) patch.notes = sOrNull(req.body.notes, 2000);
      if (req.body?.archived !== undefined) patch.archivedAt = truthy(req.body.archived) ? new Date() : null;

      const [row] = await db.update(housingRooms).set(patch)
        .where(and(eq(housingRooms.id, roomId), eq(housingRooms.organizationId, org.id))).returning();
      if (!row) return res.status(404).json({ message: "Room not found" });
      res.json(row);
    } catch (e: any) {
      if (e?.code === "23505") return res.status(409).json({ message: "That house already has a room with this name" });
      fail(res, e);
    }
  });

  app.delete("/api/admin/housing/rooms/:id", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const roomId = id(req.params.id);
      if (!roomId) return res.status(400).json({ message: "Bad id" });

      const tenancies = await db.select({ id: housingTenancies.id }).from(housingTenancies)
        .where(eq(housingTenancies.roomId, roomId));

      if (tenancies.length > 0) {
        const [row] = await db.update(housingRooms).set({ archivedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(housingRooms.id, roomId), eq(housingRooms.organizationId, org.id))).returning();
        if (!row) return res.status(404).json({ message: "Room not found" });
        return res.json({ archived: true, reason: `${tenancies.length} tenancy record(s) kept` });
      }
      const [row] = await db.delete(housingRooms)
        .where(and(eq(housingRooms.id, roomId), eq(housingRooms.organizationId, org.id))).returning();
      if (!row) return res.status(404).json({ message: "Room not found" });
      res.json({ deleted: true });
    } catch (e) { fail(res, e); }
  });

  // ── Tenant lookup / creation ───────────────────────────────────────────────
  // A tenant is a `contacts` row. Search first so a residency player who is
  // already in ClubOS (and in a squad) is linked, not duplicated.
  app.get("/api/admin/housing/tenant-search", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const q = s(req.query.q, 80);
      if (q.length < 2) return res.json([]);
      const like = `%${q}%`;
      const rows = await db.select({
        id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName,
        email: contacts.email, phone: contacts.phone, type: contacts.type,
      }).from(contacts)
        .where(or(ilike(contacts.firstName, like), ilike(contacts.lastName, like), ilike(contacts.email, like)))
        .limit(15);
      res.json(rows);
    } catch (e) { fail(res, e); }
  });

  app.post("/api/admin/housing/tenants", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const firstName = s(req.body?.firstName, 80);
      const lastName = s(req.body?.lastName, 80);
      const phone = s(req.body?.phone, 40);
      if (!firstName || !lastName) return res.status(400).json({ message: "First and last name are required" });
      if (!phone) return res.status(400).json({ message: "Phone number is required" }); // standing rule: phone is mandatory

      const email = sOrNull(req.body?.email, 160);
      if (email) {
        const [existing] = await db.select().from(contacts).where(ilike(contacts.email, email)).limit(1);
        if (existing) return res.status(409).json({ message: `${existing.firstName} ${existing.lastName} already exists with that email`, contact: existing });
      }
      const [row] = await db.insert(contacts).values({
        type: "tenant", firstName, lastName, email, phone,
        notes: sOrNull(req.body?.notes, 1000),
      }).returning();
      res.status(201).json(row);
    } catch (e) { fail(res, e); }
  });

  // ── Tenancies ──────────────────────────────────────────────────────────────
  app.get("/api/admin/housing/tenancies", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const today = nzTodayIso();

      // 🔴 LEFT joins on the room. A tenancy whose room is disputed still has a
      // person, dates and money attached to it; an inner join would drop it from
      // the list entirely and the term would quietly lose several thousand
      // dollars of real occupancy.
      const rows = await db.select({
        tenancy: housingTenancies, contact: contacts, room: housingRooms, house: housingHouses,
        period: housingPeriods,
      }).from(housingTenancies)
        .innerJoin(contacts, eq(contacts.id, housingTenancies.contactId))
        .leftJoin(housingRooms, eq(housingRooms.id, housingTenancies.roomId))
        .leftJoin(housingHouses, eq(housingHouses.id, housingRooms.houseId))
        .leftJoin(housingPeriods, eq(housingPeriods.id, housingTenancies.periodId))
        .where(eq(housingTenancies.organizationId, org.id))
        .orderBy(desc(housingTenancies.startDate));

      const [charges, fallbackHouses] = await Promise.all([
        db.select().from(housingRentCharges).where(eq(housingRentCharges.organizationId, org.id)),
        db.select().from(housingHouses).where(eq(housingHouses.organizationId, org.id)),
      ]);
      const houseById = new Map(fallbackHouses.map(h => [h.id, h]));

      // One person in two rooms at once — a warning the database deliberately
      // does not raise, because holding two rooms is something this club has
      // actually done (Deen Hasanovic took both Tiny House rooms).
      const overlapIds = new Set(
        findPersonOverlaps(rows.map(r => ({
          id: r.tenancy.id, contactId: r.tenancy.contactId, roomId: r.tenancy.roomId,
          startDate: r.tenancy.startDate, endDate: r.tenancy.endDate,
        }))).flatMap(o => [o.a.id, o.b.id]));

      const periodFilter = id(req.query.periodId);

      res.json(rows
        .filter(r => !periodFilter || r.tenancy.periodId === periodFilter)
        .map(r => {
          const mine = charges.filter(c => c.tenancyId === r.tenancy.id);
          const overdue = mine.filter(c => paymentState(c, today) === "overdue");
          // When the room is known the house comes from the room; the fallback
          // is consulted ONLY when it is not, so the two can never disagree.
          const house = r.house ?? (r.tenancy.unconfirmedHouseId ? houseById.get(r.tenancy.unconfirmedHouseId) ?? null : null);
          return {
            ...enrichTenancy(r.tenancy, today),
            tenant: {
              id: r.contact.id,
              name: `${r.contact.firstName} ${r.contact.lastName}`.trim(),
              email: r.contact.email, phone: r.contact.phone,
            },
            room: r.room ? { id: r.room.id, name: r.room.name, roomType: r.room.roomType, isReserve: r.room.isReserve } : null,
            house: house ? { id: house.id, name: house.name, inferred: !r.room } : null,
            period: r.period ? { id: r.period.id, name: r.period.name } : null,
            personOverlap: overlapIds.has(r.tenancy.id),
            charges: {
              total: mine.length,
              overdue: overdue.length,
              overdueCents: overdue.reduce((t, c) => t + amountOutstandingCents(c), 0),
              billedCents: mine.reduce((t, c) => t + (c.waived ? 0 : c.amountCents), 0),
              paidCents: mine.reduce((t, c) => t + (c.paidAmountCents ?? 0), 0),
            },
          };
        }));
    } catch (e) { fail(res, e); }
  });

  app.post("/api/admin/housing/tenancies", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      // The room is optional. A tenancy the club can evidence but cannot place
      // in a specific room is still a real tenancy with real money on it.
      const roomId = id(req.body?.roomId);
      const contactId = id(req.body?.contactId);
      if (!contactId) return res.status(400).json({ message: "Tenant is required" });

      let room: typeof housingRooms.$inferSelect | undefined;
      if (roomId) {
        [room] = await db.select().from(housingRooms)
          .where(and(eq(housingRooms.id, roomId), eq(housingRooms.organizationId, org.id)));
        if (!room) return res.status(404).json({ message: "Room not found" });
      }
      const [contact] = await db.select().from(contacts).where(eq(contacts.id, contactId));
      if (!contact) return res.status(404).json({ message: "Tenant not found" });

      const startDate = isoDate(req.body?.startDate);
      if (!startDate) return res.status(400).json({ message: "Start date must be YYYY-MM-DD" });
      const endDate = isoDate(req.body?.endDate, { allowNull: true });
      if (endDate === undefined) return res.status(400).json({ message: "End date must be YYYY-MM-DD" });
      if (endDate && compareIso(endDate, startDate) < 0) return res.status(400).json({ message: "End date cannot be before the start date" });

      const freq = s(req.body?.rentFrequency, 20) || room?.defaultRentFrequency || "weekly";
      if (!isRentFrequency(freq)) return res.status(400).json({ message: "Unknown rent frequency" });
      const rentCents = cents(req.body?.rentCents ?? room?.defaultRentCents ?? 0);
      if (rentCents === undefined) return res.status(400).json({ message: "Rent must be a whole number of cents" });
      const bondCents = cents(req.body?.bondCents ?? 0);
      if (bondCents === undefined) return res.status(400).json({ message: "Bond must be a whole number of cents" });
      const utilitiesCents = cents(req.body?.utilitiesCents ?? room?.defaultUtilitiesCents ?? 0);
      if (utilitiesCents === undefined) return res.status(400).json({ message: "Utilities must be a whole number of cents" });

      const agreementType = s(req.body?.agreementType, 30) || "undecided";
      if (!isAgreementType(agreementType)) return res.status(400).json({ message: "Unknown agreement type" });
      const occupantCategory = s(req.body?.occupantCategory, 30);
      if (occupantCategory && !isOccupantCategory(occupantCategory)) return res.status(400).json({ message: "Unknown occupant category" });
      const conditionReport = s(req.body?.conditionReport, 20);
      if (conditionReport && !isConditionReport(conditionReport)) return res.status(400).json({ message: "Unknown condition report state" });

      const holidayWeeksRaw = req.body?.holidayWeeks ?? 0;
      const holidayWeeks = Number(holidayWeeksRaw);
      if (!Number.isFinite(holidayWeeks) || holidayWeeks < 0 || holidayWeeks > 520) {
        return res.status(400).json({ message: "Holiday weeks must be a number of weeks" });
      }

      const periodId = id(req.body?.periodId);
      if (periodId) {
        const [p] = await db.select().from(housingPeriods)
          .where(and(eq(housingPeriods.id, periodId), eq(housingPeriods.organizationId, org.id)));
        if (!p) return res.status(404).json({ message: "Period not found" });
      }

      // Friendly pre-check. The DB's EXCLUDE constraint is the real guarantee —
      // this only exists so the coordinator is told WHO is already in the room.
      if (roomId) {
        const existing = await db.select({ t: housingTenancies, c: contacts })
          .from(housingTenancies).innerJoin(contacts, eq(contacts.id, housingTenancies.contactId))
          .where(eq(housingTenancies.roomId, roomId));
        const clash = existing.find(e => rangesOverlap(startDate, endDate ?? null, e.t.startDate, e.t.endDate));
        if (clash) {
          return res.status(409).json({
            message: `${clash.c.firstName} ${clash.c.lastName} already has this room from ${clash.t.startDate}${clash.t.endDate ? ` to ${clash.t.endDate}` : " (ongoing)"}. End that tenancy first, or leave the room blank and flag it.`,
          });
        }
      }

      const [row] = await db.insert(housingTenancies).values({
        roomId: roomId ?? null, organizationId: org.id, contactId,
        periodId: periodId ?? null,
        rentCents: rentCents ?? 0, rentFrequency: freq,
        utilitiesCents: utilitiesCents ?? 0,
        utilitiesIncluded: truthy(req.body?.utilitiesIncluded),
        agreementType,
        occupantCategory: occupantCategory || null,
        // 🔴 Not inferred from rentCents === 0. A player whose room is part of
        // their wages and a tenant we simply have no rate for both store zero,
        // and telling them apart is somebody's employment record.
        isRemuneration: truthy(req.body?.isRemuneration),
        holidayWeeks: String(holidayWeeks),
        keyIssued: truthy(req.body?.keyIssued),
        keyReturnedOn: isoDate(req.body?.keyReturnedOn, { allowNull: true }) ?? null,
        conditionReport: conditionReport || null,
        agreementSignedOn: isoDate(req.body?.agreementSignedOn, { allowNull: true }) ?? null,
        unconfirmedHouseId: roomId ? null : (id(req.body?.unconfirmedHouseId) ?? null),
        roomConflictNote: roomId ? null : sOrNull(req.body?.roomConflictNote, 500),
        startDate, endDate: endDate ?? null,
        bondCents: bondCents ?? 0,
        notes: sOrNull(req.body?.notes, 2000),
      }).returning();
      res.status(201).json(enrichTenancy(row, nzTodayIso()));
    } catch (e: any) {
      if (isOverlapViolation(e)) return res.status(409).json({ message: "That room already has a tenant over those dates" });
      fail(res, e);
    }
  });

  app.patch("/api/admin/housing/tenancies/:id", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const tenancyId = id(req.params.id);
      if (!tenancyId) return res.status(400).json({ message: "Bad id" });

      const [current] = await db.select().from(housingTenancies)
        .where(and(eq(housingTenancies.id, tenancyId), eq(housingTenancies.organizationId, org.id)));
      if (!current) return res.status(404).json({ message: "Tenancy not found" });

      const patch: Record<string, any> = { updatedAt: new Date() };
      if (req.body?.startDate !== undefined) {
        const v = isoDate(req.body.startDate);
        if (!v) return res.status(400).json({ message: "Start date must be YYYY-MM-DD" });
        patch.startDate = v;
      }
      if (req.body?.endDate !== undefined) {
        const v = isoDate(req.body.endDate, { allowNull: true });
        if (v === undefined) return res.status(400).json({ message: "End date must be YYYY-MM-DD" });
        patch.endDate = v;
      }
      const nextStart = patch.startDate ?? current.startDate;
      const nextEnd = patch.endDate !== undefined ? patch.endDate : current.endDate;
      if (nextEnd && compareIso(nextEnd, nextStart) < 0) return res.status(400).json({ message: "End date cannot be before the start date" });

      if (req.body?.rentFrequency !== undefined) {
        if (!isRentFrequency(req.body.rentFrequency)) return res.status(400).json({ message: "Unknown rent frequency" });
        patch.rentFrequency = req.body.rentFrequency;
      }
      if (req.body?.rentCents !== undefined) {
        const v = cents(req.body.rentCents);
        if (v === undefined) return res.status(400).json({ message: "Rent must be a whole number of cents" });
        patch.rentCents = v;
      }
      if (req.body?.bondCents !== undefined) {
        const v = cents(req.body.bondCents);
        if (v === undefined) return res.status(400).json({ message: "Bond must be a whole number of cents" });
        patch.bondCents = v;
      }
      if (req.body?.bondReturnedOn !== undefined) {
        const v = isoDate(req.body.bondReturnedOn, { allowNull: true });
        if (v === undefined) return res.status(400).json({ message: "Bond return date must be YYYY-MM-DD" });
        patch.bondReturnedOn = v;
      }
      if (req.body?.utilitiesCents !== undefined) {
        const v = cents(req.body.utilitiesCents);
        if (v === undefined) return res.status(400).json({ message: "Utilities must be a whole number of cents" });
        patch.utilitiesCents = v;
      }
      if (req.body?.utilitiesIncluded !== undefined) patch.utilitiesIncluded = truthy(req.body.utilitiesIncluded);
      if (req.body?.agreementType !== undefined) {
        if (!isAgreementType(req.body.agreementType)) return res.status(400).json({ message: "Unknown agreement type" });
        patch.agreementType = req.body.agreementType;
      }
      if (req.body?.occupantCategory !== undefined) {
        const v = s(req.body.occupantCategory, 30);
        if (v && !isOccupantCategory(v)) return res.status(400).json({ message: "Unknown occupant category" });
        patch.occupantCategory = v || null;
      }
      if (req.body?.isRemuneration !== undefined) patch.isRemuneration = truthy(req.body.isRemuneration);
      if (req.body?.holidayWeeks !== undefined) {
        const v = Number(req.body.holidayWeeks);
        if (!Number.isFinite(v) || v < 0 || v > 520) return res.status(400).json({ message: "Holiday weeks must be a number of weeks" });
        patch.holidayWeeks = String(v);
      }
      if (req.body?.keyIssued !== undefined) patch.keyIssued = truthy(req.body.keyIssued);
      if (req.body?.keyReturnedOn !== undefined) {
        const v = isoDate(req.body.keyReturnedOn, { allowNull: true });
        if (v === undefined) return res.status(400).json({ message: "Key return date must be YYYY-MM-DD" });
        patch.keyReturnedOn = v;
      }
      if (req.body?.conditionReport !== undefined) {
        const v = s(req.body.conditionReport, 20);
        if (v && !isConditionReport(v)) return res.status(400).json({ message: "Unknown condition report state" });
        patch.conditionReport = v || null;
      }
      if (req.body?.agreementSignedOn !== undefined) {
        const v = isoDate(req.body.agreementSignedOn, { allowNull: true });
        if (v === undefined) return res.status(400).json({ message: "Signed date must be YYYY-MM-DD" });
        patch.agreementSignedOn = v;
      }
      if (req.body?.periodId !== undefined) {
        const v = id(req.body.periodId);
        if (v) {
          const [pr] = await db.select().from(housingPeriods)
            .where(and(eq(housingPeriods.id, v), eq(housingPeriods.organizationId, org.id)));
          if (!pr) return res.status(404).json({ message: "Period not found" });
        }
        patch.periodId = v ?? null;
      }
      // 🔴 Assigning a room to a previously-unplaced tenancy is how a conflict
      // gets RESOLVED, so it has to be possible here — and the moment a real
      // room is set, the guessed house and the conflict note stop applying.
      if (req.body?.roomId !== undefined) {
        const v = id(req.body.roomId);
        if (v) {
          const [rm] = await db.select().from(housingRooms)
            .where(and(eq(housingRooms.id, v), eq(housingRooms.organizationId, org.id)));
          if (!rm) return res.status(404).json({ message: "Room not found" });
          const others = await db.select({ t: housingTenancies, c: contacts })
            .from(housingTenancies).innerJoin(contacts, eq(contacts.id, housingTenancies.contactId))
            .where(eq(housingTenancies.roomId, v));
          const clash = others.find(o => o.t.id !== tenancyId && rangesOverlap(nextStart, nextEnd, o.t.startDate, o.t.endDate));
          if (clash) {
            return res.status(409).json({
              message: `${clash.c.firstName} ${clash.c.lastName} already has that room from ${clash.t.startDate}${clash.t.endDate ? ` to ${clash.t.endDate}` : " (ongoing)"}.`,
            });
          }
          patch.unconfirmedHouseId = null;
          patch.roomConflictNote = null;
        }
        patch.roomId = v ?? null;
      }
      if (req.body?.unconfirmedHouseId !== undefined) patch.unconfirmedHouseId = id(req.body.unconfirmedHouseId) ?? null;
      if (req.body?.roomConflictNote !== undefined) patch.roomConflictNote = sOrNull(req.body.roomConflictNote, 500);
      if (req.body?.notes !== undefined) patch.notes = sOrNull(req.body.notes, 2000);

      const [row] = await db.update(housingTenancies).set(patch)
        .where(and(eq(housingTenancies.id, tenancyId), eq(housingTenancies.organizationId, org.id))).returning();
      res.json(enrichTenancy(row, nzTodayIso()));
    } catch (e: any) {
      if (isOverlapViolation(e)) return res.status(409).json({ message: "Those dates overlap another tenancy in the same room" });
      fail(res, e);
    }
  });

  // A tenancy with money attached to it cannot be deleted. End it instead.
  app.delete("/api/admin/housing/tenancies/:id", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const tenancyId = id(req.params.id);
      if (!tenancyId) return res.status(400).json({ message: "Bad id" });

      const paid = await db.select({ id: housingRentCharges.id }).from(housingRentCharges)
        .where(and(eq(housingRentCharges.tenancyId, tenancyId), sql`${housingRentCharges.paidOn} IS NOT NULL`));
      if (paid.length > 0) {
        return res.status(409).json({ message: `This tenancy has ${paid.length} recorded payment(s). Set an end date instead of deleting it.` });
      }
      const [row] = await db.delete(housingTenancies)
        .where(and(eq(housingTenancies.id, tenancyId), eq(housingTenancies.organizationId, org.id))).returning();
      if (!row) return res.status(404).json({ message: "Tenancy not found" });
      res.json({ deleted: true });
    } catch (e) { fail(res, e); }
  });

  // ── Generate the rent schedule ─────────────────────────────────────────────
  // Idempotent: the (tenancy_id, due_on) unique index means re-running only ever
  // inserts the charges that did not exist. A tenant is never double-charged,
  // and an already-paid charge is never rewritten.
  app.post("/api/admin/housing/tenancies/:id/charges", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const tenancyId = id(req.params.id);
      if (!tenancyId) return res.status(400).json({ message: "Bad id" });

      const [t] = await db.select().from(housingTenancies)
        .where(and(eq(housingTenancies.id, tenancyId), eq(housingTenancies.organizationId, org.id)));
      if (!t) return res.status(404).json({ message: "Tenancy not found" });
      if (t.rentCents <= 0) return res.status(400).json({ message: "Set a rent amount on this tenancy before generating charges" });

      const today = nzTodayIso();
      // Default: everything due up to 90 days out. Never generate the whole of a
      // 5-year tenancy — a rent rise would leave stale charges behind it.
      const horizon = isoDate(req.body?.horizon, { allowNull: true }) ?? addDaysIso(today, 90)!;
      if (!horizon) return res.status(400).json({ message: "Horizon must be YYYY-MM-DD" });

      const periods = chargePeriods(t.startDate, t.endDate, t.rentFrequency as RentFrequency, horizon);
      if (periods.length === 0) return res.json({ created: 0, skipped: 0, total: 0 });
      if (periods.length >= MAX_GENERATED_CHARGES) {
        return res.status(400).json({ message: "That horizon would generate too many charges. Choose a nearer date." });
      }

      const inserted = await db.insert(housingRentCharges).values(
        periods.map(p => ({
          tenancyId: t.id,
          organizationId: org.id,
          periodStart: p.periodStart,
          periodEnd: p.periodEnd,
          dueOn: p.dueOn,
          amountCents: t.rentCents,   // server-derived — the browser never names an amount
        }))
      ).onConflictDoNothing().returning({ id: housingRentCharges.id });

      res.json({ created: inserted.length, skipped: periods.length - inserted.length, total: periods.length, horizon });
    } catch (e) { fail(res, e); }
  });

  // ── Rent charges ───────────────────────────────────────────────────────────
  app.get("/api/admin/housing/charges", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const today = nzTodayIso();
      const onlyUnpaid = truthy(req.query.unpaid);

      const rows = await db.select({
        charge: housingRentCharges, tenancy: housingTenancies, contact: contacts,
        room: housingRooms, house: housingHouses,
      }).from(housingRentCharges)
        .innerJoin(housingTenancies, eq(housingTenancies.id, housingRentCharges.tenancyId))
        .innerJoin(contacts, eq(contacts.id, housingTenancies.contactId))
        .innerJoin(housingRooms, eq(housingRooms.id, housingTenancies.roomId))
        .innerJoin(housingHouses, eq(housingHouses.id, housingRooms.houseId))
        .where(eq(housingRentCharges.organizationId, org.id))
        .orderBy(desc(housingRentCharges.dueOn));

      const out = rows.map(r => ({
        ...r.charge,
        state: paymentState(r.charge, today),
        daysOverdue: daysOverdue(r.charge, today),
        outstandingCents: amountOutstandingCents(r.charge),
        tenant: { id: r.contact.id, name: `${r.contact.firstName} ${r.contact.lastName}`.trim(), phone: r.contact.phone, email: r.contact.email },
        room: { id: r.room.id, name: r.room.name },
        house: { id: r.house.id, name: r.house.name },
      })).filter(c => !onlyUnpaid || (c.state === "overdue" || c.state === "due_soon" || c.state === "upcoming"));

      res.json({ today, charges: out });
    } catch (e) { fail(res, e); }
  });

  app.patch("/api/admin/housing/charges/:id", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const chargeId = id(req.params.id);
      if (!chargeId) return res.status(400).json({ message: "Bad id" });

      const [current] = await db.select().from(housingRentCharges)
        .where(and(eq(housingRentCharges.id, chargeId), eq(housingRentCharges.organizationId, org.id)));
      if (!current) return res.status(404).json({ message: "Charge not found" });

      const patch: Record<string, any> = { updatedAt: new Date() };

      if (req.body?.paidOn !== undefined) {
        const v = paidDate(req.body.paidOn);
        if (v === undefined) return res.status(400).json({ message: "Paid date must be YYYY-MM-DD, or null to un-mark" });
        patch.paidOn = v;
        // Marking paid with no explicit amount means paid in full. Un-marking
        // clears the amount too, so a cleared charge can't keep a phantom credit.
        if (v === null) { patch.paidAmountCents = null; patch.method = null; patch.reference = null; }
        else if (req.body.paidAmountCents === undefined) patch.paidAmountCents = current.amountCents;
      }
      if (req.body?.paidAmountCents !== undefined) {
        const v = cents(req.body.paidAmountCents, { allowNull: true });
        if (v === undefined) return res.status(400).json({ message: "Amount must be a whole number of cents" });
        patch.paidAmountCents = v;
      }
      if (req.body?.method !== undefined) {
        const m = s(req.body.method, 30);
        if (m && !isPaymentMethod(m)) return res.status(400).json({ message: "Unknown payment method" });
        patch.method = m || null;
      }
      if (req.body?.reference !== undefined) patch.reference = sOrNull(req.body.reference, 120);
      if (req.body?.waived !== undefined) patch.waived = truthy(req.body.waived);
      if (req.body?.notes !== undefined) patch.notes = sOrNull(req.body.notes, 1000);
      if (req.body?.amountCents !== undefined) {
        const v = cents(req.body.amountCents);
        if (v === undefined) return res.status(400).json({ message: "Amount must be a whole number of cents" });
        patch.amountCents = v;
      }

      const [row] = await db.update(housingRentCharges).set(patch)
        .where(and(eq(housingRentCharges.id, chargeId), eq(housingRentCharges.organizationId, org.id))).returning();
      const today = nzTodayIso();
      res.json({ ...row, state: paymentState(row, today), outstandingCents: amountOutstandingCents(row) });
    } catch (e) { fail(res, e); }
  });

  app.delete("/api/admin/housing/charges/:id", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const chargeId = id(req.params.id);
      if (!chargeId) return res.status(400).json({ message: "Bad id" });
      const [current] = await db.select().from(housingRentCharges)
        .where(and(eq(housingRentCharges.id, chargeId), eq(housingRentCharges.organizationId, org.id)));
      if (!current) return res.status(404).json({ message: "Charge not found" });
      if (current.paidOn) return res.status(409).json({ message: "This charge is marked paid. Un-mark it before deleting." });
      await db.delete(housingRentCharges).where(eq(housingRentCharges.id, chargeId));
      res.json({ deleted: true });
    } catch (e) { fail(res, e); }
  });

  // ── Utility accounts ───────────────────────────────────────────────────────
  app.get("/api/admin/housing/utilities", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const today = nzTodayIso();
      const accounts = await db.select({ account: housingUtilityAccounts, house: housingHouses })
        .from(housingUtilityAccounts)
        .innerJoin(housingHouses, eq(housingHouses.id, housingUtilityAccounts.houseId))
        .where(and(eq(housingUtilityAccounts.organizationId, org.id), isNull(housingUtilityAccounts.archivedAt)))
        .orderBy(asc(housingHouses.name), asc(housingUtilityAccounts.kind));

      const bills = await db.select().from(housingUtilityBills).where(eq(housingUtilityBills.organizationId, org.id));

      res.json(accounts.map(a => {
        const mine = bills.filter(b => b.utilityAccountId === a.account.id);
        const overdue = mine.filter(b => paymentState(b, today) === "overdue");
        const next = mine.filter(b => !b.paidOn && !b.waived).sort((x, y) => compareIso(x.dueOn, y.dueOn))[0] ?? null;
        return {
          ...a.account,
          house: { id: a.house.id, name: a.house.name },
          bills: { total: mine.length, overdue: overdue.length, overdueCents: overdue.reduce((t, b) => t + amountOutstandingCents(b), 0) },
          nextDue: next ? { id: next.id, dueOn: next.dueOn, amountCents: next.amountCents, state: paymentState(next, today) } : null,
        };
      }));
    } catch (e) { fail(res, e); }
  });

  app.post("/api/admin/housing/utilities", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const houseId = id(req.body?.houseId);
      if (!houseId) return res.status(400).json({ message: "House is required" });
      const [house] = await db.select().from(housingHouses)
        .where(and(eq(housingHouses.id, houseId), eq(housingHouses.organizationId, org.id)));
      if (!house) return res.status(404).json({ message: "House not found" });

      const kind = s(req.body?.kind, 20);
      if (!isUtilityKind(kind)) return res.status(400).json({ message: "Unknown utility type" });
      const expected = cents(req.body?.expectedAmountCents ?? 0);
      if (expected === undefined) return res.status(400).json({ message: "Expected amount must be a whole number of cents" });

      const [row] = await db.insert(housingUtilityAccounts).values({
        houseId, organizationId: org.id, kind,
        provider: sOrNull(req.body?.provider, 120),
        accountNumber: sOrNull(req.body?.accountNumber, 80),
        billingFrequency: s(req.body?.billingFrequency, 20) || "monthly",
        expectedAmountCents: expected ?? 0,
        notes: sOrNull(req.body?.notes, 1000),
      }).returning();
      res.status(201).json(row);
    } catch (e) { fail(res, e); }
  });

  app.patch("/api/admin/housing/utilities/:id", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const accId = id(req.params.id);
      if (!accId) return res.status(400).json({ message: "Bad id" });
      const patch: Record<string, any> = { updatedAt: new Date() };
      if (req.body?.kind !== undefined) {
        if (!isUtilityKind(req.body.kind)) return res.status(400).json({ message: "Unknown utility type" });
        patch.kind = req.body.kind;
      }
      if (req.body?.provider !== undefined) patch.provider = sOrNull(req.body.provider, 120);
      if (req.body?.accountNumber !== undefined) patch.accountNumber = sOrNull(req.body.accountNumber, 80);
      if (req.body?.billingFrequency !== undefined) patch.billingFrequency = s(req.body.billingFrequency, 20) || "monthly";
      if (req.body?.expectedAmountCents !== undefined) {
        const v = cents(req.body.expectedAmountCents);
        if (v === undefined) return res.status(400).json({ message: "Expected amount must be a whole number of cents" });
        patch.expectedAmountCents = v;
      }
      if (req.body?.notes !== undefined) patch.notes = sOrNull(req.body.notes, 1000);
      if (req.body?.archived !== undefined) patch.archivedAt = truthy(req.body.archived) ? new Date() : null;

      const [row] = await db.update(housingUtilityAccounts).set(patch)
        .where(and(eq(housingUtilityAccounts.id, accId), eq(housingUtilityAccounts.organizationId, org.id))).returning();
      if (!row) return res.status(404).json({ message: "Utility account not found" });
      res.json(row);
    } catch (e) { fail(res, e); }
  });

  app.delete("/api/admin/housing/utilities/:id", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const accId = id(req.params.id);
      if (!accId) return res.status(400).json({ message: "Bad id" });
      const bills = await db.select({ id: housingUtilityBills.id }).from(housingUtilityBills)
        .where(eq(housingUtilityBills.utilityAccountId, accId));
      if (bills.length > 0) {
        const [row] = await db.update(housingUtilityAccounts).set({ archivedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(housingUtilityAccounts.id, accId), eq(housingUtilityAccounts.organizationId, org.id))).returning();
        if (!row) return res.status(404).json({ message: "Utility account not found" });
        return res.json({ archived: true, reason: `${bills.length} bill(s) kept` });
      }
      const [row] = await db.delete(housingUtilityAccounts)
        .where(and(eq(housingUtilityAccounts.id, accId), eq(housingUtilityAccounts.organizationId, org.id))).returning();
      if (!row) return res.status(404).json({ message: "Utility account not found" });
      res.json({ deleted: true });
    } catch (e) { fail(res, e); }
  });

  // ── Utility bills ──────────────────────────────────────────────────────────
  app.get("/api/admin/housing/bills", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const today = nzTodayIso();
      const rows = await db.select({ bill: housingUtilityBills, account: housingUtilityAccounts, house: housingHouses })
        .from(housingUtilityBills)
        .innerJoin(housingUtilityAccounts, eq(housingUtilityAccounts.id, housingUtilityBills.utilityAccountId))
        .innerJoin(housingHouses, eq(housingHouses.id, housingUtilityAccounts.houseId))
        .where(eq(housingUtilityBills.organizationId, org.id))
        .orderBy(desc(housingUtilityBills.dueOn));

      res.json({
        today,
        bills: rows.map(r => ({
          ...r.bill,
          state: paymentState(r.bill, today),
          daysOverdue: daysOverdue(r.bill, today),
          outstandingCents: amountOutstandingCents(r.bill),
          account: { id: r.account.id, kind: r.account.kind, provider: r.account.provider },
          house: { id: r.house.id, name: r.house.name },
        })),
      });
    } catch (e) { fail(res, e); }
  });

  app.post("/api/admin/housing/bills", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const accountId = id(req.body?.utilityAccountId);
      if (!accountId) return res.status(400).json({ message: "Utility account is required" });
      const [acc] = await db.select().from(housingUtilityAccounts)
        .where(and(eq(housingUtilityAccounts.id, accountId), eq(housingUtilityAccounts.organizationId, org.id)));
      if (!acc) return res.status(404).json({ message: "Utility account not found" });

      const dueOn = isoDate(req.body?.dueOn);
      if (!dueOn) return res.status(400).json({ message: "Due date must be YYYY-MM-DD" });
      const amountCents = cents(req.body?.amountCents);
      if (amountCents === undefined || amountCents === null) return res.status(400).json({ message: "Amount is required" });

      const [row] = await db.insert(housingUtilityBills).values({
        utilityAccountId: accountId, organizationId: org.id,
        periodLabel: sOrNull(req.body?.periodLabel, 60),
        dueOn, amountCents,
        notes: sOrNull(req.body?.notes, 1000),
      }).returning();
      res.status(201).json(row);
    } catch (e) { fail(res, e); }
  });

  app.patch("/api/admin/housing/bills/:id", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const billId = id(req.params.id);
      if (!billId) return res.status(400).json({ message: "Bad id" });
      const [current] = await db.select().from(housingUtilityBills)
        .where(and(eq(housingUtilityBills.id, billId), eq(housingUtilityBills.organizationId, org.id)));
      if (!current) return res.status(404).json({ message: "Bill not found" });

      const patch: Record<string, any> = { updatedAt: new Date() };
      if (req.body?.paidOn !== undefined) {
        const v = paidDate(req.body.paidOn);
        if (v === undefined) return res.status(400).json({ message: "Paid date must be YYYY-MM-DD, or null to un-mark" });
        patch.paidOn = v;
        if (v === null) { patch.paidAmountCents = null; patch.method = null; patch.reference = null; }
        else if (req.body.paidAmountCents === undefined) patch.paidAmountCents = current.amountCents;
      }
      if (req.body?.paidAmountCents !== undefined) {
        const v = cents(req.body.paidAmountCents, { allowNull: true });
        if (v === undefined) return res.status(400).json({ message: "Amount must be a whole number of cents" });
        patch.paidAmountCents = v;
      }
      if (req.body?.amountCents !== undefined) {
        const v = cents(req.body.amountCents);
        if (v === undefined) return res.status(400).json({ message: "Amount must be a whole number of cents" });
        patch.amountCents = v;
      }
      if (req.body?.dueOn !== undefined) {
        const v = isoDate(req.body.dueOn);
        if (!v) return res.status(400).json({ message: "Due date must be YYYY-MM-DD" });
        patch.dueOn = v;
      }
      if (req.body?.periodLabel !== undefined) patch.periodLabel = sOrNull(req.body.periodLabel, 60);
      if (req.body?.method !== undefined) {
        const m = s(req.body.method, 30);
        if (m && !isPaymentMethod(m)) return res.status(400).json({ message: "Unknown payment method" });
        patch.method = m || null;
      }
      if (req.body?.reference !== undefined) patch.reference = sOrNull(req.body.reference, 120);
      if (req.body?.waived !== undefined) patch.waived = truthy(req.body.waived);
      if (req.body?.notes !== undefined) patch.notes = sOrNull(req.body.notes, 1000);

      const [row] = await db.update(housingUtilityBills).set(patch)
        .where(and(eq(housingUtilityBills.id, billId), eq(housingUtilityBills.organizationId, org.id))).returning();
      const today = nzTodayIso();
      res.json({ ...row, state: paymentState(row, today), outstandingCents: amountOutstandingCents(row) });
    } catch (e) { fail(res, e); }
  });

  app.delete("/api/admin/housing/bills/:id", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const billId = id(req.params.id);
      if (!billId) return res.status(400).json({ message: "Bad id" });
      const [row] = await db.delete(housingUtilityBills)
        .where(and(eq(housingUtilityBills.id, billId), eq(housingUtilityBills.organizationId, org.id))).returning();
      if (!row) return res.status(404).json({ message: "Bill not found" });
      res.json({ deleted: true });
    } catch (e) { fail(res, e); }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ACCOMMODATION (2026-08-18)
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Billing periods ────────────────────────────────────────────────────────
  app.get("/api/admin/housing/periods", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const today = nzTodayIso();
      const periods = await db.select().from(housingPeriods)
        .where(eq(housingPeriods.organizationId, org.id))
        .orderBy(desc(housingPeriods.startDate));

      const tenancies = await db.select().from(housingTenancies).where(eq(housingTenancies.organizationId, org.id));
      const charges = await db.select().from(housingRentCharges).where(eq(housingRentCharges.organizationId, org.id));

      res.json(periods.map(p => {
        const mine = tenancies.filter(t => t.periodId === p.id).map(t => enrichTenancy(t, today));
        const myCharges = charges.filter(c => c.periodId === p.id);
        const computedCents = mine.reduce((t, r) => t + (r.money?.totalCents ?? 0), 0);
        const billedCents = myCharges.reduce((t, c) => t + (c.waived ? 0 : c.amountCents), 0);
        const paidCents = myCharges.reduce((t, c) => t + (c.paidAmountCents ?? 0), 0);
        return {
          ...p,
          tenancies: mine.length,
          // The recomputed cost of everything in the term…
          computedCents,
          // …what has actually been raised as a charge…
          billedCents,
          // …and what has come in.
          paidCents,
          outstandingCents: Math.max(0, billedCents - paidCents),
          // …beside whatever the club's own document claimed the term totalled.
          statedVarianceCents: statedVarianceCents(computedCents, p.statedTotalCents),
        };
      }));
    } catch (e) { fail(res, e); }
  });

  app.post("/api/admin/housing/periods", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const name = s(req.body?.name, 80);
      const startDate = isoDate(req.body?.startDate);
      const endDate = isoDate(req.body?.endDate);
      if (!name) return res.status(400).json({ message: "Name is required" });
      if (!startDate || !endDate) return res.status(400).json({ message: "Start and end dates must be YYYY-MM-DD" });
      if (compareIso(endDate, startDate) < 0) return res.status(400).json({ message: "End date cannot be before the start date" });
      const stated = cents(req.body?.statedTotalCents, { allowNull: true });
      if (stated === undefined) return res.status(400).json({ message: "Stated total must be a whole number of cents" });

      const [row] = await db.insert(housingPeriods).values({
        organizationId: org.id, name, startDate, endDate,
        statedTotalCents: stated ?? null,
        statedTotalNote: sOrNull(req.body?.statedTotalNote, 500),
        notes: sOrNull(req.body?.notes, 2000),
      }).returning();
      res.status(201).json(row);
    } catch (e: any) {
      if (e?.code === "23505") return res.status(409).json({ message: "A period with that name already exists" });
      fail(res, e);
    }
  });

  app.patch("/api/admin/housing/periods/:id", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const periodId = id(req.params.id);
      if (!periodId) return res.status(400).json({ message: "Bad id" });
      const [current] = await db.select().from(housingPeriods)
        .where(and(eq(housingPeriods.id, periodId), eq(housingPeriods.organizationId, org.id)));
      if (!current) return res.status(404).json({ message: "Period not found" });

      const patch: Record<string, any> = { updatedAt: new Date() };
      if (req.body?.name !== undefined) {
        const v = s(req.body.name, 80);
        if (!v) return res.status(400).json({ message: "Name is required" });
        patch.name = v;
      }
      for (const key of ["startDate", "endDate"] as const) {
        if (req.body?.[key] !== undefined) {
          const v = isoDate(req.body[key]);
          if (!v) return res.status(400).json({ message: `${key} must be YYYY-MM-DD` });
          patch[key] = v;
        }
      }
      const nextStart = patch.startDate ?? current.startDate;
      const nextEnd = patch.endDate ?? current.endDate;
      if (compareIso(nextEnd, nextStart) < 0) return res.status(400).json({ message: "End date cannot be before the start date" });
      if (req.body?.statedTotalCents !== undefined) {
        const v = cents(req.body.statedTotalCents, { allowNull: true });
        if (v === undefined) return res.status(400).json({ message: "Stated total must be a whole number of cents" });
        patch.statedTotalCents = v;
      }
      if (req.body?.statedTotalNote !== undefined) patch.statedTotalNote = sOrNull(req.body.statedTotalNote, 500);
      if (req.body?.notes !== undefined) patch.notes = sOrNull(req.body.notes, 2000);
      if (req.body?.closed !== undefined) patch.closedAt = truthy(req.body.closed) ? new Date() : null;

      const [row] = await db.update(housingPeriods).set(patch)
        .where(and(eq(housingPeriods.id, periodId), eq(housingPeriods.organizationId, org.id))).returning();
      res.json(row);
    } catch (e: any) {
      if (e?.code === "23505") return res.status(409).json({ message: "A period with that name already exists" });
      fail(res, e);
    }
  });

  // A period with tenancies attached is not deleted — the tenancies would be
  // orphaned out of every subtotal that has ever been reconciled against it.
  app.delete("/api/admin/housing/periods/:id", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const periodId = id(req.params.id);
      if (!periodId) return res.status(400).json({ message: "Bad id" });
      const used = await db.select({ id: housingTenancies.id }).from(housingTenancies)
        .where(eq(housingTenancies.periodId, periodId));
      if (used.length > 0) {
        return res.status(409).json({ message: `${used.length} tenancy record(s) belong to this period. Close it instead of deleting it.` });
      }
      const [row] = await db.delete(housingPeriods)
        .where(and(eq(housingPeriods.id, periodId), eq(housingPeriods.organizationId, org.id))).returning();
      if (!row) return res.status(404).json({ message: "Period not found" });
      res.json({ deleted: true });
    } catch (e) { fail(res, e); }
  });

  // ── The invoicing matrix ───────────────────────────────────────────────────
  // Section 3 of the club's run sheet, rebuilt so that every figure is derived.
  // Each occupant, what their stay costs, what has been charged, what has been
  // paid, what is left — and where that disagrees with the club's own record.
  app.get("/api/admin/housing/invoicing", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const today = nzTodayIso();
      const periodFilter = id(req.query.periodId);

      const rows = await db.select({
        tenancy: housingTenancies, contact: contacts, room: housingRooms,
        house: housingHouses, period: housingPeriods,
      }).from(housingTenancies)
        .innerJoin(contacts, eq(contacts.id, housingTenancies.contactId))
        .leftJoin(housingRooms, eq(housingRooms.id, housingTenancies.roomId))
        .leftJoin(housingHouses, eq(housingHouses.id, housingRooms.houseId))
        .leftJoin(housingPeriods, eq(housingPeriods.id, housingTenancies.periodId))
        .where(eq(housingTenancies.organizationId, org.id))
        .orderBy(asc(housingTenancies.startDate));

      const charges = await db.select().from(housingRentCharges).where(eq(housingRentCharges.organizationId, org.id));

      const lines = rows
        .filter(r => !periodFilter || r.tenancy.periodId === periodFilter)
        .map(r => {
          const e = enrichTenancy(r.tenancy, today);
          const mine = charges.filter(c => c.tenancyId === r.tenancy.id);
          const billedCents = mine.reduce((t, c) => t + (c.waived ? 0 : c.amountCents), 0);
          const paidCents = mine.reduce((t, c) => t + (c.paidAmountCents ?? 0), 0);
          return {
            tenancyId: r.tenancy.id,
            sourceRef: r.tenancy.sourceRef,
            period: r.period ? { id: r.period.id, name: r.period.name } : null,
            tenant: { id: r.contact.id, name: `${r.contact.firstName} ${r.contact.lastName}`.trim(), email: r.contact.email },
            location: r.room ? `${r.house?.name ?? "?"} — ${r.room.name}` : "Room not confirmed",
            roomConfirmed: e.roomConfirmed,
            startDate: r.tenancy.startDate,
            endDate: r.tenancy.endDate,
            agreementType: r.tenancy.agreementType,
            isRemuneration: r.tenancy.isRemuneration,
            weeklyRentCents: e.money?.weeklyRentCents ?? 0,
            weeklyUtilitiesCents: e.money?.weeklyUtilitiesCents ?? 0,
            weeks: e.money?.weeks ?? 0,
            holidayWeeks: e.holidayWeeks,
            computedCents: e.money?.totalCents ?? 0,
            statedTotalCents: r.tenancy.statedTotalCents,
            varianceCents: e.variance,
            hasVariance: e.hasVariance,
            sourcePaymentStatus: r.tenancy.sourceatusPayment,
            billedCents,
            paidCents,
            // 🔴 Outstanding is measured against what has actually been CHARGED,
            // not against the recomputed cost. Nobody owes money on an invoice
            // that was never raised — the gap between the two is a billing
            // question, and it is reported separately as `unbilledCents`.
            outstandingCents: Math.max(0, billedCents - paidCents),
            unbilledCents: Math.max(0, (e.money?.totalCents ?? 0) - billedCents),
            chargeCount: mine.length,
          };
        });

      const sum = (k: "computedCents" | "billedCents" | "paidCents" | "outstandingCents" | "unbilledCents") =>
        lines.reduce((t, l) => t + l[k], 0);

      res.json({
        today,
        lines,
        totals: {
          tenancies: lines.length,
          computedCents: sum("computedCents"),
          statedCents: lines.reduce((t, l) => t + (l.statedTotalCents ?? 0), 0),
          billedCents: sum("billedCents"),
          paidCents: sum("paidCents"),
          outstandingCents: sum("outstandingCents"),
          unbilledCents: sum("unbilledCents"),
          varianceCents: lines.reduce((t, l) => t + (l.varianceCents ?? 0), 0),
          varianceRows: lines.filter(l => l.hasVariance).length,
        },
      });
    } catch (e) { fail(res, e); }
  });

  // ── Raise the invoice for a whole stay ─────────────────────────────────────
  // The weekly generator above suits an open-ended tenancy. This residency
  // invoices a TERM at a time — one figure per occupant per stay — so this
  // raises exactly that, splitting rent from power when the two are billed
  // separately so each line can be chased and settled on its own.
  //
  // Idempotent through the same `(tenancy_id, due_on)` unique index: re-running
  // never double-charges. An already-paid charge is never rewritten.
  app.post("/api/admin/housing/tenancies/:id/term-charge", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const tenancyId = id(req.params.id);
      if (!tenancyId) return res.status(400).json({ message: "Bad id" });

      const [t] = await db.select().from(housingTenancies)
        .where(and(eq(housingTenancies.id, tenancyId), eq(housingTenancies.organizationId, org.id)));
      if (!t) return res.status(404).json({ message: "Tenancy not found" });
      if (!t.endDate) return res.status(400).json({ message: "This tenancy has no end date. Use the weekly rent schedule instead." });

      const today = nzTodayIso();
      const e = enrichTenancy(t, today);
      if (!e.money || e.money.totalCents <= 0) {
        return res.status(400).json({ message: "This stay works out at nothing to pay. Check the rate and the dates." });
      }

      // Rent is payable in advance, so the whole-stay invoice falls due on the
      // day the stay begins — the same rule the weekly schedule uses.
      const dueOn = t.startDate;
      const rows: any[] = [];
      const base = {
        tenancyId: t.id, organizationId: org.id, periodId: t.periodId,
        periodStart: t.startDate, periodEnd: t.endDate,
      };

      if (e.money.utilitiesCents > 0) {
        rows.push({ ...base, kind: "rent", dueOn, amountCents: e.money.rentCents });
        // A second line needs a second due date: the unique index is on
        // (tenancy_id, due_on), so two charges sharing a day would collide and
        // the power line would silently never be created.
        rows.push({ ...base, kind: "utilities", dueOn: addDaysIso(dueOn, 1)!, amountCents: e.money.utilitiesCents });
      } else {
        rows.push({ ...base, kind: t.utilitiesIncluded ? "combined" : "rent", dueOn, amountCents: e.money.totalCents });
      }

      const inserted = await db.insert(housingRentCharges)
        .values(rows.filter(r => r.amountCents > 0))
        .onConflictDoNothing()
        .returning({ id: housingRentCharges.id });

      res.json({ created: inserted.length, skipped: rows.length - inserted.length, totalCents: e.money.totalCents });
    } catch (e) { fail(res, e); }
  });

  // ── The accommodation roster ───────────────────────────────────────────────
  app.get("/api/admin/housing/roster", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const today = nzTodayIso();

      const [rows, tenancies, rooms, houses] = await Promise.all([
        db.select({ r: housingRoster, c: contacts })
          .from(housingRoster).innerJoin(contacts, eq(contacts.id, housingRoster.contactId))
          .where(and(eq(housingRoster.organizationId, org.id), isNull(housingRoster.archivedAt)))
          .orderBy(asc(contacts.lastName), asc(contacts.firstName)),
        db.select().from(housingTenancies).where(eq(housingTenancies.organizationId, org.id)),
        db.select().from(housingRooms).where(eq(housingRooms.organizationId, org.id)),
        db.select().from(housingHouses).where(eq(housingHouses.organizationId, org.id)),
      ]);
      const roomById = new Map(rooms.map(r => [r.id, r]));
      const houseById = new Map(houses.map(h => [h.id, h]));

      res.json(rows.map(({ r, c }) => {
        const mine = tenancies.filter(t => t.contactId === c.id);
        const status = accommodationStatus(mine, today);
        const current = mine.find(t => tenancyState(t.startDate, t.endDate, today) === "active") ?? null;
        const room = current?.roomId ? roomById.get(current.roomId) : undefined;
        return {
          ...r,
          contact: {
            id: c.id, name: `${c.firstName} ${c.lastName}`.trim(),
            email: c.email, phone: c.phone, type: c.type,
          },
          status,
          currentLocation: room ? `${houseById.get(room.houseId)?.name ?? "?"} — ${room.name}` : null,
          tenancies: mine.length,
          // 🔴 The one thing an accommodation manager needs at 2am and the one
          // thing this data set does not have for anybody.
          contactable: !!(c.phone || c.email),
        };
      }));
    } catch (e) { fail(res, e); }
  });

  app.post("/api/admin/housing/roster", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const contactId = id(req.body?.contactId);
      if (!contactId) return res.status(400).json({ message: "A person is required" });
      const [contact] = await db.select().from(contacts).where(eq(contacts.id, contactId));
      if (!contact) return res.status(404).json({ message: "Person not found" });

      const [row] = await db.insert(housingRoster).values({
        organizationId: org.id, contactId,
        roleLabel: sOrNull(req.body?.roleLabel, 80),
        legalName: sOrNull(req.body?.legalName, 160),
        legalNameVerified: truthy(req.body?.legalNameVerified),
        emergencyContactName: sOrNull(req.body?.emergencyContactName, 120),
        emergencyContactPhone: sOrNull(req.body?.emergencyContactPhone, 40),
        notes: sOrNull(req.body?.notes, 2000),
      }).returning();
      res.status(201).json(row);
    } catch (e: any) {
      if (e?.code === "23505") return res.status(409).json({ message: "That person is already on the roster" });
      fail(res, e);
    }
  });

  app.patch("/api/admin/housing/roster/:id", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const rosterId = id(req.params.id);
      if (!rosterId) return res.status(400).json({ message: "Bad id" });

      const patch: Record<string, any> = { updatedAt: new Date() };
      if (req.body?.roleLabel !== undefined) patch.roleLabel = sOrNull(req.body.roleLabel, 80);
      if (req.body?.legalName !== undefined) patch.legalName = sOrNull(req.body.legalName, 160);
      // 🔴 Verifying a legal name is a deliberate act by a person who has seen a
      // document. Editing the spelling does NOT verify it, and must not quietly
      // flip the flag — an unverified name is what blocks a binding agreement.
      if (req.body?.legalNameVerified !== undefined) patch.legalNameVerified = truthy(req.body.legalNameVerified);
      if (req.body?.emergencyContactName !== undefined) patch.emergencyContactName = sOrNull(req.body.emergencyContactName, 120);
      if (req.body?.emergencyContactPhone !== undefined) patch.emergencyContactPhone = sOrNull(req.body.emergencyContactPhone, 40);
      if (req.body?.notes !== undefined) patch.notes = sOrNull(req.body.notes, 2000);
      if (req.body?.archived !== undefined) patch.archivedAt = truthy(req.body.archived) ? new Date() : null;

      const [row] = await db.update(housingRoster).set(patch)
        .where(and(eq(housingRoster.id, rosterId), eq(housingRoster.organizationId, org.id))).returning();
      if (!row) return res.status(404).json({ message: "Roster entry not found" });
      res.json(row);
    } catch (e) { fail(res, e); }
  });

  app.delete("/api/admin/housing/roster/:id", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const rosterId = id(req.params.id);
      if (!rosterId) return res.status(400).json({ message: "Bad id" });
      const [entry] = await db.select().from(housingRoster)
        .where(and(eq(housingRoster.id, rosterId), eq(housingRoster.organizationId, org.id)));
      if (!entry) return res.status(404).json({ message: "Roster entry not found" });

      // Somebody who has lived here is archived, never removed: their tenancy
      // history has to keep a person attached to it.
      const lived = await db.select({ id: housingTenancies.id }).from(housingTenancies)
        .where(and(eq(housingTenancies.contactId, entry.contactId), eq(housingTenancies.organizationId, org.id)));
      if (lived.length > 0) {
        const [row] = await db.update(housingRoster).set({ archivedAt: new Date(), updatedAt: new Date() })
          .where(eq(housingRoster.id, rosterId)).returning();
        return res.json({ archived: true, reason: `${lived.length} tenancy record(s) kept`, row });
      }
      await db.delete(housingRoster).where(eq(housingRoster.id, rosterId));
      res.json({ deleted: true });
    } catch (e) { fail(res, e); }
  });

  // ── Actions and conflicts ──────────────────────────────────────────────────
  app.get("/api/admin/housing/actions", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const rows = await db.select({ a: housingActionItems, u: users })
        .from(housingActionItems)
        .leftJoin(users, eq(users.id, housingActionItems.assignedUserId))
        .where(eq(housingActionItems.organizationId, org.id))
        .orderBy(asc(housingActionItems.ref));

      const today = nzTodayIso();
      const rank: Record<string, number> = { high: 0, medium: 1, low: 2 };
      res.json({
        today,
        items: rows
          .map(({ a, u }) => ({
            ...a,
            open: isActionOpen(a.status),
            // Overdue is derived, like everything else that has a date on it.
            overdue: isActionOpen(a.status) && !!a.targetDate && compareIso(a.targetDate, today) < 0,
            assignedTo: u ? { id: u.id, name: [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email } : null,
          }))
          .sort((x, y) =>
            Number(y.open) - Number(x.open) ||
            (rank[x.priority] ?? 9) - (rank[y.priority] ?? 9) ||
            String(x.ref ?? "").localeCompare(String(y.ref ?? ""))),
      });
    } catch (e) { fail(res, e); }
  });

  app.post("/api/admin/housing/actions", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const title = s(req.body?.title, 200);
      if (!title) return res.status(400).json({ message: "Title is required" });
      const kind = s(req.body?.kind, 20) || "action";
      if (!isActionKind(kind)) return res.status(400).json({ message: "Unknown kind" });
      const priority = s(req.body?.priority, 20) || "medium";
      if (!isActionPriority(priority)) return res.status(400).json({ message: "Unknown priority" });
      const status = s(req.body?.status, 20) || "open";
      if (!isActionStatus(status)) return res.status(400).json({ message: "Unknown status" });
      const targetDate = isoDate(req.body?.targetDate, { allowNull: true });
      if (targetDate === undefined) return res.status(400).json({ message: "Target date must be YYYY-MM-DD" });

      const [row] = await db.insert(housingActionItems).values({
        organizationId: org.id, kind, title, priority, status,
        ref: sOrNull(req.body?.ref, 40),
        category: sOrNull(req.body?.category, 80),
        detail: sOrNull(req.body?.detail, 4000),
        ownerLabel: sOrNull(req.body?.ownerLabel, 120),
        assignedUserId: id(req.body?.assignedUserId) ?? null,
        targetDate: targetDate ?? null,
        resolutionNotes: sOrNull(req.body?.resolutionNotes, 4000),
        related: req.body?.related && typeof req.body.related === "object" ? req.body.related : {},
      }).returning();
      res.status(201).json(row);
    } catch (e: any) {
      if (e?.code === "23505") return res.status(409).json({ message: "An item with that reference already exists" });
      fail(res, e);
    }
  });

  app.patch("/api/admin/housing/actions/:id", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const itemId = id(req.params.id);
      if (!itemId) return res.status(400).json({ message: "Bad id" });

      const patch: Record<string, any> = { updatedAt: new Date() };
      if (req.body?.title !== undefined) {
        const v = s(req.body.title, 200);
        if (!v) return res.status(400).json({ message: "Title is required" });
        patch.title = v;
      }
      if (req.body?.priority !== undefined) {
        if (!isActionPriority(req.body.priority)) return res.status(400).json({ message: "Unknown priority" });
        patch.priority = req.body.priority;
      }
      if (req.body?.status !== undefined) {
        if (!isActionStatus(req.body.status)) return res.status(400).json({ message: "Unknown status" });
        patch.status = req.body.status;
        // Finishing something stamps the day it finished, unless the caller
        // supplies one; re-opening it clears the stamp rather than leaving a
        // completion date on an open item.
        if (!isActionOpen(req.body.status)) {
          if (req.body.completedOn === undefined) patch.completedOn = nzTodayIso();
        } else {
          patch.completedOn = null;
        }
      }
      if (req.body?.completedOn !== undefined) {
        const v = isoDate(req.body.completedOn, { allowNull: true });
        if (v === undefined) return res.status(400).json({ message: "Completed date must be YYYY-MM-DD" });
        patch.completedOn = v;
      }
      if (req.body?.targetDate !== undefined) {
        const v = isoDate(req.body.targetDate, { allowNull: true });
        if (v === undefined) return res.status(400).json({ message: "Target date must be YYYY-MM-DD" });
        patch.targetDate = v;
      }
      if (req.body?.category !== undefined) patch.category = sOrNull(req.body.category, 80);
      if (req.body?.detail !== undefined) patch.detail = sOrNull(req.body.detail, 4000);
      if (req.body?.ownerLabel !== undefined) patch.ownerLabel = sOrNull(req.body.ownerLabel, 120);
      if (req.body?.assignedUserId !== undefined) patch.assignedUserId = id(req.body.assignedUserId) ?? null;
      if (req.body?.resolutionNotes !== undefined) patch.resolutionNotes = sOrNull(req.body.resolutionNotes, 4000);

      const [row] = await db.update(housingActionItems).set(patch)
        .where(and(eq(housingActionItems.id, itemId), eq(housingActionItems.organizationId, org.id))).returning();
      if (!row) return res.status(404).json({ message: "Item not found" });
      res.json(row);
    } catch (e) { fail(res, e); }
  });

  app.delete("/api/admin/housing/actions/:id", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const itemId = id(req.params.id);
      if (!itemId) return res.status(400).json({ message: "Bad id" });
      const [row] = await db.delete(housingActionItems)
        .where(and(eq(housingActionItems.id, itemId), eq(housingActionItems.organizationId, org.id))).returning();
      if (!row) return res.status(404).json({ message: "Item not found" });
      res.json({ deleted: true });
    } catch (e) { fail(res, e); }
  });
}
