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
  organizations, contacts,
  housingHouses, housingRooms, housingTenancies, housingRentCharges,
  housingUtilityAccounts, housingUtilityBills,
} from "@shared/schema";
import {
  isRoomType, isRentFrequency, isUtilityKind, isPaymentMethod,
  parseIso, nzTodayIso, addDaysIso, compareIso,
  tenancyState, rangesOverlap,
  paymentState, daysOverdue, amountOutstandingCents,
  chargePeriods, annualisedRentCents, summariseOccupancy,
  MAX_GENERATED_CHARGES,
  type RentFrequency,
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
      const activeRoomIds = activeTenancies.map(r => r.tenancy.roomId);
      const occupancy = summariseOccupancy(rooms, activeRoomIds);

      // Per-house occupancy, so an empty house is obvious at a glance.
      const roomsByHouse = new Map<number, typeof rooms>();
      for (const r of rooms) {
        if (!roomsByHouse.has(r.houseId)) roomsByHouse.set(r.houseId, []);
        roomsByHouse.get(r.houseId)!.push(r);
      }
      const houseSummaries = houses.map(h => ({
        ...h,
        ...summariseOccupancy(roomsByHouse.get(h.id) ?? [], activeRoomIds),
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

      res.json({
        today,
        occupancy,
        houses: houseSummaries,
        activeTenants: activeTenancies.length,
        annualRentCents,
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

      const active = await activeTenanciesFor(org.id, today);
      const tenantByRoom = new Map(active.map(a => [a.tenancy.roomId, {
        tenancyId: a.tenancy.id,
        contactId: a.contact.id,
        name: `${a.contact.firstName} ${a.contact.lastName}`.trim(),
        email: a.contact.email,
        phone: a.contact.phone,
        rentCents: a.tenancy.rentCents,
        rentFrequency: a.tenancy.rentFrequency,
        startDate: a.tenancy.startDate,
        endDate: a.tenancy.endDate,
      }]));

      const occupiedRoomIds = Array.from(tenantByRoom.keys());
      res.json(houses.map(h => {
        const hRooms = rooms.filter(r => r.houseId === h.id);
        const summary = summariseOccupancy(hRooms, occupiedRoomIds);
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

      const [row] = await db.insert(housingRooms).values({
        houseId, organizationId: org.id, name, roomType,
        defaultRentCents: rent ?? 0, defaultRentFrequency: freq,
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

      const rows = await db.select({
        tenancy: housingTenancies, contact: contacts, room: housingRooms, house: housingHouses,
      }).from(housingTenancies)
        .innerJoin(contacts, eq(contacts.id, housingTenancies.contactId))
        .innerJoin(housingRooms, eq(housingRooms.id, housingTenancies.roomId))
        .innerJoin(housingHouses, eq(housingHouses.id, housingRooms.houseId))
        .where(eq(housingTenancies.organizationId, org.id))
        .orderBy(desc(housingTenancies.startDate));

      const charges = await db.select().from(housingRentCharges).where(eq(housingRentCharges.organizationId, org.id));

      res.json(rows.map(r => {
        const mine = charges.filter(c => c.tenancyId === r.tenancy.id);
        const overdue = mine.filter(c => paymentState(c, today) === "overdue");
        return {
          ...r.tenancy,
          state: tenancyState(r.tenancy.startDate, r.tenancy.endDate, today),
          tenant: {
            id: r.contact.id,
            name: `${r.contact.firstName} ${r.contact.lastName}`.trim(),
            email: r.contact.email, phone: r.contact.phone,
          },
          room: { id: r.room.id, name: r.room.name, roomType: r.room.roomType },
          house: { id: r.house.id, name: r.house.name },
          charges: { total: mine.length, overdue: overdue.length, overdueCents: overdue.reduce((t, c) => t + amountOutstandingCents(c), 0) },
        };
      }));
    } catch (e) { fail(res, e); }
  });

  app.post("/api/admin/housing/tenancies", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const roomId = id(req.body?.roomId);
      const contactId = id(req.body?.contactId);
      if (!roomId || !contactId) return res.status(400).json({ message: "Room and tenant are required" });

      const [room] = await db.select().from(housingRooms)
        .where(and(eq(housingRooms.id, roomId), eq(housingRooms.organizationId, org.id)));
      if (!room) return res.status(404).json({ message: "Room not found" });
      const [contact] = await db.select().from(contacts).where(eq(contacts.id, contactId));
      if (!contact) return res.status(404).json({ message: "Tenant not found" });

      const startDate = isoDate(req.body?.startDate);
      if (!startDate) return res.status(400).json({ message: "Start date must be YYYY-MM-DD" });
      const endDate = isoDate(req.body?.endDate, { allowNull: true });
      if (endDate === undefined) return res.status(400).json({ message: "End date must be YYYY-MM-DD" });
      if (endDate && compareIso(endDate, startDate) < 0) return res.status(400).json({ message: "End date cannot be before the start date" });

      const freq = s(req.body?.rentFrequency, 20) || room.defaultRentFrequency;
      if (!isRentFrequency(freq)) return res.status(400).json({ message: "Unknown rent frequency" });
      const rentCents = cents(req.body?.rentCents ?? room.defaultRentCents);
      if (rentCents === undefined) return res.status(400).json({ message: "Rent must be a whole number of cents" });
      const bondCents = cents(req.body?.bondCents ?? 0);
      if (bondCents === undefined) return res.status(400).json({ message: "Bond must be a whole number of cents" });

      // Friendly pre-check. The DB's EXCLUDE constraint is the real guarantee —
      // this only exists so the coordinator is told WHO is already in the room.
      const existing = await db.select({ t: housingTenancies, c: contacts })
        .from(housingTenancies).innerJoin(contacts, eq(contacts.id, housingTenancies.contactId))
        .where(eq(housingTenancies.roomId, roomId));
      const clash = existing.find(e => rangesOverlap(startDate, endDate ?? null, e.t.startDate, e.t.endDate));
      if (clash) {
        return res.status(409).json({
          message: `${clash.c.firstName} ${clash.c.lastName} already has this room from ${clash.t.startDate}${clash.t.endDate ? ` to ${clash.t.endDate}` : " (ongoing)"}. End that tenancy first.`,
        });
      }

      const [row] = await db.insert(housingTenancies).values({
        roomId, organizationId: org.id, contactId,
        rentCents: rentCents ?? 0, rentFrequency: freq,
        startDate, endDate: endDate ?? null,
        bondCents: bondCents ?? 0,
        notes: sOrNull(req.body?.notes, 2000),
      }).returning();
      res.status(201).json(row);
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
      if (req.body?.notes !== undefined) patch.notes = sOrNull(req.body.notes, 2000);

      const [row] = await db.update(housingTenancies).set(patch)
        .where(and(eq(housingTenancies.id, tenancyId), eq(housingTenancies.organizationId, org.id))).returning();
      res.json(row);
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
}
