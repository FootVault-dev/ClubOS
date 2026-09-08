/**
 * Club Events — HTTP.
 *
 * Public routes: the event page (by slug), starting a purchase, confirming it,
 * and the buyer's order page (by 128-bit token). No login anywhere.
 * Admin routes: gated by requireTab("club-events") in the workspace the
 * request is standing in; refunds additionally by requireRefundPermission.
 */
import type { Express, Request, Response } from "express";
import { eq, and } from "drizzle-orm";
import { db } from "./db";
import { organizations, clubEvents, clubEventTicketTypes, clubEventOrders, clubEventGuests } from "@shared/schema";
import { requireAuth, requireTab, requireRefundPermission } from "./auth";
import { isClubEventStatus, isStripeAccountKey } from "@shared/club-events";
import * as ce from "./club-events";

const TAB = "club-events";

// Brand sites that may call the public endpoints from the browser.
const SITE_ORIGINS = [
  "https://cufc.co.nz", "https://www.cufc.co.nz",
  "https://southislandunited.com", "https://www.southislandunited.com",
];
function setCors(req: Request, res: Response) {
  const origin = String(req.headers.origin || "");
  if (SITE_ORIGINS.includes(origin) || /\.vercel\.app$/.test(origin)) res.header("Access-Control-Allow-Origin", origin);
  res.header("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
}
function notFound(res: Response) { return res.status(404).json({ message: "We couldn't find that." }); }
function clientIp(req: Request): string {
  const fwd = String(req.headers["x-forwarded-for"] || "");
  return (fwd.split(",")[0] || req.ip || "unknown").trim();
}

// 🔴 Deliberately NO per-IP rate limit on the purchase endpoints: a club office
// or a family on one connection buying a table is one IP (see Team Pay's note).
// Capacity + Stripe's own controls are the guard.

async function orgIdForRequest(req: Request): Promise<number | undefined> {
  const slug = String(req.headers["x-workspace-slug"] || "").trim();
  if (!slug) return undefined;
  const [o] = await db.select().from(organizations).where(eq(organizations.slug, slug));
  return o?.id;
}
/** Event scoped to the caller's workspace — an id from another workspace is a 404. */
async function ownedEvent(req: Request, res: Response) {
  const orgId = await orgIdForRequest(req);
  if (!orgId) { res.status(400).json({ message: "No workspace" }); return null; }
  const id = Number(req.params.id);
  const e = Number.isInteger(id) ? await ce.eventById(id) : undefined;
  if (!e || e.organizationId !== orgId) { notFound(res); return null; }
  return e;
}

export function registerClubEventRoutes(app: Express) {
  app.use("/api/public/club-events", (req, res, next) => {
    setCors(req, res);
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  // ── public ─────────────────────────────────────────────────────────────────
  // Order page by token — declared before /:slug so "order" is never read as a slug.
  app.get("/api/public/club-events/order/:token", async (req, res) => {
    const data = await ce.orderByToken(String(req.params.token));
    if (!data) return notFound(res);
    res.json(data);
  });
  app.patch("/api/public/club-events/order/:token", async (req, res) => {
    const r = await ce.updateOrderGuests(String(req.params.token), req.body ?? {});
    if (r.error === "not_found") return notFound(res);
    if (r.error) return res.status(400).json({ message: r.error });
    res.json({ ok: true });
  });
  app.post("/api/public/club-events/order/:token/resend", async (req, res) => {
    const [o] = await db.select({ id: clubEventOrders.id }).from(clubEventOrders).where(eq(clubEventOrders.token, String(req.params.token)));
    if (!o) return notFound(res);
    res.json({ ok: await ce.resendTicket(o.id) });
  });

  app.get("/api/public/club-events/:slug", async (req, res) => {
    const e = await ce.eventBySlug(String(req.params.slug));
    if (!e || e.status === "draft") return notFound(res);
    res.json(await ce.publicEvent(e));
  });

  app.post("/api/public/club-events/:slug/intent", async (req, res) => {
    try {
      const r = await ce.beginOrder(String(req.params.slug), req.body ?? {}, { userAgent: String(req.headers["user-agent"] || ""), ip: clientIp(req) });
      if ("error" in r) {
        if (r.error === "not_found") return notFound(res);
        if (r.error === "already_paid") return res.status(409).json({ message: "That booking is already paid.", alreadyPaid: true });
        return res.status(400).json({ message: r.error });
      }
      res.json(r);
    } catch (err: any) {
      console.error("[club-events] intent failed:", err);
      res.status(500).json({ message: "We couldn't start that payment. Please try again." });
    }
  });

  app.post("/api/public/club-events/order/:token/confirm", async (req, res) => {
    try {
      const r = await ce.confirmOrder(String(req.params.token));
      if (r.error === "not_found") return notFound(res);
      if (r.error) return res.status(400).json({ message: r.error });
      res.json(r);
    } catch (err: any) {
      console.error("[club-events] confirm failed:", err);
      res.status(500).json({ message: "We couldn't confirm that payment yet." });
    }
  });

  // ── admin ──────────────────────────────────────────────────────────────────
  const tab = requireTab(TAB);

  app.get("/api/admin/club-events", requireAuth, tab, async (req: any, res) => {
    const orgId = await orgIdForRequest(req);
    if (!orgId) return res.status(400).json({ message: "No workspace" });
    res.json({ events: await ce.adminEvents(orgId) });
  });

  app.post("/api/admin/club-events", requireAuth, tab, async (req: any, res) => {
    const orgId = await orgIdForRequest(req);
    if (!orgId) return res.status(400).json({ message: "No workspace" });
    const input = ce.cleanEventInput(req.body ?? {});
    if (!input.name || !input.slug || !input.startsAt || isNaN(input.startsAt.getTime())) return res.status(400).json({ message: "Name, slug and a start date/time are required." });
    if (input.status && !isClubEventStatus(input.status)) return res.status(400).json({ message: "Bad status." });
    if (input.stripeAccount && !isStripeAccountKey(input.stripeAccount)) return res.status(400).json({ message: "Bad Stripe account." });
    try {
      const [e] = await db.insert(clubEvents).values({ ...(input as any), organizationId: orgId, shortCode: input.shortCode || "EV" }).returning();
      await ce.logEvent({ eventId: e.id, kind: "event_created", actor: "staff", actorUserId: req.session.userId });
      res.status(201).json(e);
    } catch (err: any) {
      if (/club_events_slug_unique/.test(String(err?.message))) return res.status(409).json({ message: "That slug is already used by another event." });
      throw err;
    }
  });

  app.get("/api/admin/club-events/:id", requireAuth, tab, async (req: any, res) => {
    const e = await ownedEvent(req, res); if (!e) return;
    res.json({
      event: e, ticketTypes: await ce.typesOf(e.id), stats: await ce.eventStats(e),
      orders: await ce.adminOrders(e.id), guests: await ce.adminGuests(e.id),
      publicUrl: ce.eventUrl(e.slug), stripeReady: ce.stripeFor(e.stripeAccount).ok,
    });
  });

  app.patch("/api/admin/club-events/:id", requireAuth, tab, async (req: any, res) => {
    const e = await ownedEvent(req, res); if (!e) return;
    const input = ce.cleanEventInput(req.body ?? {});
    if (input.status && !isClubEventStatus(input.status)) return res.status(400).json({ message: "Bad status." });
    if (input.stripeAccount && !isStripeAccountKey(input.stripeAccount)) return res.status(400).json({ message: "Bad Stripe account." });
    if (input.startsAt && isNaN(input.startsAt.getTime())) return res.status(400).json({ message: "Bad start date." });
    try {
      const [u] = await db.update(clubEvents).set({ ...(input as any), updatedAt: new Date() }).where(eq(clubEvents.id, e.id)).returning();
      await ce.logEvent({ eventId: e.id, kind: "event_updated", actor: "staff", actorUserId: req.session.userId, detail: Object.keys(input) });
      res.json(u);
    } catch (err: any) {
      if (/club_events_slug_unique/.test(String(err?.message))) return res.status(409).json({ message: "That slug is already used by another event." });
      if (/check_violation|violates check/.test(String(err?.message))) return res.status(400).json({ message: "Those values aren't allowed (capacity must be positive; end after start)." });
      throw err;
    }
  });

  // ticket types
  app.post("/api/admin/club-events/:id/ticket-types", requireAuth, tab, async (req: any, res) => {
    const e = await ownedEvent(req, res); if (!e) return;
    const input = ce.cleanTicketTypeInput(req.body ?? {});
    if (!input.name || input.priceCents == null) return res.status(400).json({ message: "Name and price are required." });
    try {
      const [t] = await db.insert(clubEventTicketTypes).values({ ...(input as any), eventId: e.id }).returning();
      res.status(201).json(t);
    } catch (err: any) {
      if (/check_violation|violates check/.test(String(err?.message))) return res.status(400).json({ message: "Sales start must be before sales end." });
      throw err;
    }
  });
  app.patch("/api/admin/club-events/:id/ticket-types/:typeId", requireAuth, tab, async (req: any, res) => {
    const e = await ownedEvent(req, res); if (!e) return;
    const input = ce.cleanTicketTypeInput(req.body ?? {});
    try {
      const [t] = await db.update(clubEventTicketTypes).set({ ...(input as any), updatedAt: new Date() })
        .where(and(eq(clubEventTicketTypes.id, Number(req.params.typeId)), eq(clubEventTicketTypes.eventId, e.id))).returning();
      if (!t) return notFound(res);
      res.json(t);
    } catch (err: any) {
      if (/check_violation|violates check/.test(String(err?.message))) return res.status(400).json({ message: "Sales start must be before sales end." });
      throw err;
    }
  });
  app.delete("/api/admin/club-events/:id/ticket-types/:typeId", requireAuth, tab, async (req: any, res) => {
    const e = await ownedEvent(req, res); if (!e) return;
    try {
      const r = await db.delete(clubEventTicketTypes).where(and(eq(clubEventTicketTypes.id, Number(req.params.typeId)), eq(clubEventTicketTypes.eventId, e.id))).returning({ id: clubEventTicketTypes.id });
      if (!r.length) return notFound(res);
      res.json({ ok: true });
    } catch (err: any) {
      if (/foreign key|violates/.test(String(err?.message))) return res.status(409).json({ message: "Tickets have been sold on this type — deactivate it instead of deleting." });
      throw err;
    }
  });

  // office / EFTPOS sale
  app.post("/api/admin/club-events/:id/orders", requireAuth, tab, async (req: any, res) => {
    const e = await ownedEvent(req, res); if (!e) return;
    const r = await ce.manualOrder(e, req.body ?? {}, req.session.userId);
    if (r.error) return res.status(400).json({ message: r.error });
    res.status(201).json(r.order);
  });

  app.post("/api/admin/club-events/:id/orders/:orderId/resend", requireAuth, tab, async (req: any, res) => {
    const e = await ownedEvent(req, res); if (!e) return;
    const [o] = await db.select({ id: clubEventOrders.id }).from(clubEventOrders).where(and(eq(clubEventOrders.id, Number(req.params.orderId)), eq(clubEventOrders.eventId, e.id)));
    if (!o) return notFound(res);
    res.json({ ok: await ce.resendTicket(o.id) });
  });

  app.post("/api/admin/club-events/:id/orders/:orderId/cancel", requireAuth, tab, async (req: any, res) => {
    const e = await ownedEvent(req, res); if (!e) return;
    const [o] = await db.select({ id: clubEventOrders.id, status: clubEventOrders.status }).from(clubEventOrders).where(and(eq(clubEventOrders.id, Number(req.params.orderId)), eq(clubEventOrders.eventId, e.id)));
    if (!o) return notFound(res);
    if (o.status !== "pending") return res.status(400).json({ message: "Only a pending order can be cancelled — refund a paid one." });
    res.json({ ok: await ce.cancelPending(o.id, req.session.userId) });
  });

  app.patch("/api/admin/club-events/:id/orders/:orderId", requireAuth, tab, async (req: any, res) => {
    const e = await ownedEvent(req, res); if (!e) return;
    const staffNotes = String(req.body?.staffNotes ?? "").trim().slice(0, 2000) || null;
    const tableName = req.body?.tableName === undefined ? undefined : (String(req.body.tableName).trim().slice(0, 80) || null);
    const [u] = await db.update(clubEventOrders).set({ staffNotes, ...(tableName !== undefined ? { tableName } : {}), updatedAt: new Date() })
      .where(and(eq(clubEventOrders.id, Number(req.params.orderId)), eq(clubEventOrders.eventId, e.id))).returning({ id: clubEventOrders.id });
    if (!u) return notFound(res);
    res.json({ ok: true });
  });

  // 🔴 Refunds move money: the per-person flag, no role bypass — same gate as registrations.
  app.post("/api/admin/club-events/:id/orders/:orderId/refund", requireAuth, tab, requireRefundPermission, async (req: any, res) => {
    const e = await ownedEvent(req, res); if (!e) return;
    const [o] = await db.select({ id: clubEventOrders.id }).from(clubEventOrders).where(and(eq(clubEventOrders.id, Number(req.params.orderId)), eq(clubEventOrders.eventId, e.id)));
    if (!o) return notFound(res);
    try {
      const amount = req.body?.amountCents == null || req.body.amountCents === "" ? null : Number(req.body.amountCents);
      const r = await ce.refundOrder(o.id, amount, String(req.body?.reason ?? "").trim().slice(0, 300) || null, req.session.userId);
      if (r.error) return res.status(400).json({ message: r.error });
      res.json(r);
    } catch (err: any) {
      console.error("[club-events] refund failed:", err);
      res.status(500).json({ message: err?.message || "Refund failed." });
    }
  });

  // guest edits + the door
  app.patch("/api/admin/club-events/:id/guests/:guestId", requireAuth, tab, async (req: any, res) => {
    const e = await ownedEvent(req, res); if (!e) return;
    const [g] = await db.select({ id: clubEventGuests.id, eventId: clubEventOrders.eventId }).from(clubEventGuests)
      .innerJoin(clubEventOrders, eq(clubEventOrders.id, clubEventGuests.orderId))
      .where(eq(clubEventGuests.id, Number(req.params.guestId)));
    if (!g || g.eventId !== e.id) return notFound(res);
    const set: any = { updatedAt: new Date() };
    if (req.body?.fullName !== undefined) set.fullName = String(req.body.fullName).trim().slice(0, 120) || null;
    if (req.body?.dietary !== undefined) set.dietary = String(req.body.dietary).trim().slice(0, 300) || null;
    await db.update(clubEventGuests).set(set).where(eq(clubEventGuests.id, g.id));
    if (req.body?.checkedIn !== undefined) await ce.setCheckedIn(g.id, !!req.body.checkedIn, req.session.userId);
    res.json({ ok: true });
  });

  app.post("/api/admin/club-events/:id/reconcile", requireAuth, tab, async (req: any, res) => {
    const e = await ownedEvent(req, res); if (!e) return;
    res.json(await ce.reconcile(e.id));
  });

  app.get("/api/admin/club-events/:id/guests.csv", requireAuth, tab, async (req: any, res) => {
    const e = await ownedEvent(req, res); if (!e) return;
    const csv = ce.guestsCsv(await ce.adminGuests(e.id));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${e.slug}-guests.csv"`);
    res.send(csv);
  });
}
