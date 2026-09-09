// ─────────────────────────────────────────────────────────────────────────────
// POS — one register for every brand, every programme, every counter.
//
//   GET   /api/admin/pos/bootstrap
//   POST  /api/admin/pos/registers
//   POST  /api/admin/pos/shifts/open                 { registerId, openingFloatCents }
//   POST  /api/admin/pos/shifts/:id/close            { countedCents, notes }
//   GET   /api/admin/pos/shifts/:id/summary
//   GET   /api/admin/pos/catalogue                   ?q=&orgId=&code=
//   GET   /api/admin/pos/sales                       ?shiftId=&status=
//   POST  /api/admin/pos/sales                       { registerId, moneyAccount? }
//   GET   /api/admin/pos/sales/:id
//   PATCH /api/admin/pos/sales/:id                   { discountCents, discountReason, contactId, customer, marketingOptIn, notes }
//   POST  /api/admin/pos/sales/:id/lines             { kind, ... }
//   DELETE /api/admin/pos/sales/:id/lines/:lineId
//   POST  /api/admin/pos/sales/:id/payments          { method, amountCents, reference }   manual tenders
//   POST  /api/admin/pos/sales/:id/payments/card     card via Stripe Terminal (server-driven reader)
//   POST  /api/admin/pos/sales/:id/payments/:pid/confirm
//   POST  /api/admin/pos/sales/:id/payments/:pid/cancel
//   POST  /api/admin/pos/sales/:id/void              { reason }
//   POST  /api/admin/pos/sales/:id/refunds           { amountCents, reason, paymentId? }   requireRefundPermission
//   POST  /api/admin/pos/sales/:id/receipt           { email? }
//   POST  /api/admin/pos/declines                    { registerId, reason, amountCents?, note? }
//   POST  /api/admin/pos/terminal/connection-token   { registerId }   (the app SDK, phase 4)
//   GET   /api/public/pos/receipt/:token             the customer's receipt, by 128-bit token
//
// Access. `requireAuth` + `requireTab("pos")`. NOT super-admin-locked: Olga,
// Travis, Zach and Isaac are the users. Selling is low blast radius; refunds
// keep the explicit per-person `can_issue_refunds` flag with no role bypass.
//
// Scope. Deliberately NOT by workspace header — the whole point is one register
// selling every brand. What a sale may contain is decided by its money account
// (the Stripe/bank bucket), enforced by the database, never by the caller.
//
// Money. Every rule lives in Postgres (migrations/2026-09-09_pos.sql): totals
// derive from lines, paid derives from payments, refunds are capped, lines
// freeze once money lands, a paid sale cannot be deleted. This file decides
// WHAT to write; the database decides whether it is allowed.
// ─────────────────────────────────────────────────────────────────────────────
import type { Express, Request, Response } from "express";
import Stripe from "stripe";
import { and, asc, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "./db";
import { requireAuth, requireTab, requireRefundPermission } from "./auth";
import { storage } from "./storage";
import {
  organizations, users, contacts, programs, programOptions, registrations,
  shopProducts, shopProductColours, shopProductImages, shopVariants,
  clubEvents, clubEventTicketTypes,
  posRegisters, posShifts, posSales, posSaleLines, posPayments, posRefunds, posDeclines, posOrgMoneyAccounts,
} from "@shared/schema";
import {
  POS_TENDERS, POS_MANUAL_TENDERS, POS_DECLINE_REASONS, POS_SELLER, POS_MONEY_ACCOUNTS,
  isPosTender, isPosDeclineReason, isPosMoneyAccount, roundCashToTenCents, receiptTier,
  shiftExpectedCashCents, posTenderLabel,
} from "@shared/pos";
import { stripe as clubStripe } from "./stripe";
import { cugcStripe } from "./cugc-stripe";
import { sendPosReceiptEmail } from "./email";

const RECEIPT_BASE = process.env.POS_RECEIPT_BASE_URL || "https://app.usg.co.nz";

// ── Stripe per money account ─────────────────────────────────────────────────
// The same shape as club-events' stripeFor: a missing key REFUSES to sell rather
// than quietly charging the wrong account.
let trustStripe: Stripe | null = null;
export function stripeForAccount(account: string): { stripe: Stripe; ok: boolean; reason?: string } {
  if (account === "club") return { stripe: clubStripe, ok: !!process.env.STRIPE_SECRET_KEY, reason: "Stripe is not configured." };
  if (account === "cugc") return { stripe: cugcStripe, ok: !!process.env.CUGC_STRIPE_SECRET_KEY, reason: "The Gymnastics Stripe account is not configured." };
  if (account === "trust") {
    const sk = process.env.CLUB_EVENTS_TRUST_STRIPE_SECRET_KEY;
    if (!sk) return { stripe: clubStripe, ok: false, reason: "The Trust's Stripe keys are not configured." };
    if (!trustStripe) trustStripe = new Stripe(sk, { apiVersion: "2025-04-30.basil" as any });
    return { stripe: trustStripe, ok: true };
  }
  return { stripe: clubStripe, ok: false, reason: `Unknown money account "${account}".` };
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const uid = (req: Request) => req.session.userId as number;
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };
const str = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Postgres RAISEd a POS_* rule, or a CHECK fired: answer 409 with the human half. */
function posError(res: Response, e: any): boolean {
  const msg = String(e?.message ?? "");
  const m = msg.match(/^(POS_[A-Z_]+):\s*(.*)$/);
  if (m) { res.status(409).json({ code: m[1], message: m[2] }); return true; }
  const c = msg.match(/violates check constraint "([a-z_]+)"/);
  if (c) {
    const friendly: Record<string, string> = {
      pos_sales_discount_reason: "A discount needs a reason.",
      pos_sales_paid_le_total: "That would pay more than the sale total.",
      pos_sales_refund_le_paid: "That would refund more than was paid.",
      pos_sales_state: "That change is not allowed in the sale's current state.",
      pos_payments_amount_pos: "A payment must be more than nothing.",
      pos_refunds_amount_pos: "A refund must be more than nothing.",
      pos_refunds_reason: "A refund needs a reason.",
      pos_sale_lines_qty_pos: "Quantity must be at least 1.",
      pos_shifts_float_nonneg: "A float cannot be negative.",
    };
    res.status(409).json({ code: c[1], message: friendly[c[1]] ?? `Refused by the database rule ${c[1]}.` });
    return true;
  }
  if (/pos_shifts_one_open_per_register/.test(msg)) { res.status(409).json({ code: "POS_SHIFT_OPEN", message: "That register already has an open shift." }); return true; }
  return false;
}

async function staffName(userId: number | null | undefined): Promise<string | null> {
  if (!userId) return null;
  const [u] = await db.select({ f: users.firstName, l: users.lastName, e: users.email }).from(users).where(eq(users.id, userId));
  if (!u) return null;
  return [u.f, u.l].filter(Boolean).join(" ") || u.e;
}

async function moneyAccountForOrg(orgId: number): Promise<string | null> {
  const [m] = await db.select().from(posOrgMoneyAccounts).where(eq(posOrgMoneyAccounts.organizationId, orgId));
  return m?.account ?? null;
}

async function loadSale(id: number) {
  const [sale] = await db.select().from(posSales).where(eq(posSales.id, id));
  if (!sale) return null;
  const [lines, payments, refunds, [register]] = await Promise.all([
    db.select().from(posSaleLines).where(eq(posSaleLines.saleId, id)).orderBy(asc(posSaleLines.sort), asc(posSaleLines.id)),
    db.select().from(posPayments).where(eq(posPayments.saleId, id)).orderBy(asc(posPayments.id)),
    db.select().from(posRefunds).where(eq(posRefunds.saleId, id)).orderBy(asc(posRefunds.id)),
    db.select().from(posRegisters).where(eq(posRegisters.id, sale.registerId)),
  ]);
  const orgIds = Array.from(new Set(lines.map((l) => l.organizationId)));
  const orgs = orgIds.length ? await db.select({ id: organizations.id, name: organizations.name, slug: organizations.slug }).from(organizations).where(inArray(organizations.id, orgIds)) : [];
  const orgName = (oid: number) => orgs.find((o) => o.id === oid)?.name ?? "";
  return {
    ...sale,
    servedByName: await staffName(sale.servedByUserId),
    register: register ? { id: register.id, name: register.name, hasReader: !!register.stripeReaderId } : null,
    lines: lines.map((l) => ({ ...l, brand: orgName(l.organizationId) })),
    payments: payments.map((p) => ({ ...p, label: posTenderLabel(p.method) })),
    refunds,
    remainingCents: Math.max(0, sale.totalCents - sale.paidCents),
    refundableCents: Math.max(0, sale.paidCents - sale.refundedCents),
    receiptUrl: `${RECEIPT_BASE}/receipt/${sale.token}`,
  };
}
export type LoadedSale = NonNullable<Awaited<ReturnType<typeof loadSale>>>;

async function openSaleOr409(res: Response, id: number) {
  const sale = await loadSale(id);
  if (!sale) { res.status(404).json({ message: "Sale not found." }); return null; }
  if (sale.status !== "open") { res.status(409).json({ code: "POS_SALE_NOT_OPEN", message: `This sale is ${sale.status}.` }); return null; }
  return sale;
}

// ── Fulfilment: what a PAID sale does to the rest of ClubOS, exactly once ────
// Stamped atomically on pos_sales.fulfilled_at, so the register's confirm call
// and the Stripe webhook racing each other do the work once, not twice.
export async function fulfilPaidSale(saleId: number): Promise<boolean> {
  const claimed = await db.execute(sql`UPDATE pos_sales SET fulfilled_at = now() WHERE id = ${saleId} AND status IN ('paid') AND fulfilled_at IS NULL RETURNING id`);
  if (!claimed.rowCount) return false;
  const sale = await loadSale(saleId);
  if (!sale) return false;
  const succeeded = sale.payments.filter((p) => p.status === "succeeded");
  // The tender that settled the sale is what a registration reads as its own
  // payment method; a split cash+EFTPOS sale reads as the larger part.
  const primary = [...succeeded].sort((a, b) => b.amountCents - a.amountCents)[0];
  const method = primary?.method ?? "other";
  const reference = succeeded.map((p) => p.reference).filter(Boolean).join(", ") || null;

  for (const line of sale.lines) {
    try {
      if (line.kind === "variant" && line.variantId) {
        await db.execute(sql`UPDATE shop_variants SET stock = GREATEST(stock - ${line.qty}, 0) WHERE id = ${line.variantId}`);
      } else if (line.kind === "registration" && line.registrationId) {
        // The same columns the office writes today. `WHERE status = 'pending'`
        // means a registration confirmed some other way is left alone.
        const r = await db.execute(sql`
          UPDATE registrations
             SET status = 'confirmed', amount_paid = ${(line.lineCents / 100).toFixed(2)},
                 payment_method = ${method}, payment_reference = ${reference},
                 served_by_user_id = ${sale.servedByUserId}, paid_at = now(), pos_sale_id = ${sale.id}
           WHERE id = ${line.registrationId} AND status = 'pending'
           RETURNING id`);
        if (r.rowCount) await storage.assignOrderNumber(line.registrationId).catch((e) => console.error("[POS] order number", e));
      } else if (line.kind === "event_ticket" && line.clubEventTicketTypeId && !line.clubEventOrderId) {
        const ce = await import("./club-events");
        const [tt] = await db.select().from(clubEventTicketTypes).where(eq(clubEventTicketTypes.id, line.clubEventTicketTypeId));
        const ev = tt ? await ce.eventById(tt.eventId) : undefined;
        const meta = (line.meta ?? {}) as any;
        if (ev) {
          const out = await ce.manualOrder(ev, {
            quantity: line.qty, ticketTypeId: tt!.id, unitPriceCents: line.unitCents,
            buyerName: meta.buyerName || sale.customerName || "Counter sale",
            buyerEmail: meta.buyerEmail || sale.customerEmail || "",
            buyerPhone: meta.buyerPhone || sale.customerPhone || null,
            paymentMethod: method, paymentReference: reference,
            guests: meta.guests, staffNotes: `POS ${sale.saleNumber}`,
          }, sale.servedByUserId);
          if (out.order) await db.update(posSaleLines).set({ clubEventOrderId: out.order.id }).where(eq(posSaleLines.id, line.id));
          else console.error("[POS] event ticket not minted:", out.error);
        }
      }
    } catch (e) {
      console.error(`[POS] fulfil line ${line.id} (${line.kind}) failed:`, e);
    }
  }
  if (sale.customerEmail) {
    try { await sendReceipt(sale.id, sale.customerEmail); } catch (e) { console.error("[POS] receipt email failed:", e); }
  }
  return true;
}

async function sendReceipt(saleId: number, to: string): Promise<boolean> {
  const sale = await loadSale(saleId);
  if (!sale) return false;
  const ok = await sendPosReceiptEmail({ to, sale });
  if (ok) await db.update(posSales).set({ receiptSentAt: new Date() }).where(eq(posSales.id, saleId));
  return ok;
}

/** Stripe told us a card_present PaymentIntent succeeded (confirm call or webhook). Idempotent. */
export async function markPosPaymentSucceededByIntent(pi: { id: string; status: string; metadata?: Record<string, string> | null }): Promise<boolean> {
  if (pi.status !== "succeeded") return false;
  const r = await db.execute(sql`UPDATE pos_payments SET status = 'succeeded', succeeded_at = now() WHERE stripe_payment_intent_id = ${pi.id} AND status = 'pending' RETURNING sale_id`);
  if (!r.rowCount) return false;
  const saleId = Number((r.rows[0] as any).sale_id);
  const [sale] = await db.select({ status: posSales.status }).from(posSales).where(eq(posSales.id, saleId));
  if (sale?.status === "paid") await fulfilPaidSale(saleId);
  return true;
}

async function shiftSummary(shiftId: number) {
  const [shift] = await db.select().from(posShifts).where(eq(posShifts.id, shiftId));
  if (!shift) return null;
  const sales = await db.select().from(posSales).where(eq(posSales.shiftId, shiftId));
  const saleIds = sales.map((s) => s.id);
  const payments = saleIds.length ? await db.select().from(posPayments).where(and(inArray(posPayments.saleId, saleIds), eq(posPayments.status, "succeeded"))) : [];
  const refunds = saleIds.length ? await db.select().from(posRefunds).where(inArray(posRefunds.saleId, saleIds)) : [];
  const paidIds = sales.filter((s) => s.paidAt).map((s) => s.id);
  const lines = paidIds.length ? await db.select().from(posSaleLines).where(inArray(posSaleLines.saleId, paidIds)) : [];
  const orgIds = Array.from(new Set(lines.map((l) => l.organizationId)));
  const orgs = orgIds.length ? await db.select({ id: organizations.id, name: organizations.name }).from(organizations).where(inArray(organizations.id, orgIds)) : [];
  const declines = await db.select().from(posDeclines).where(eq(posDeclines.shiftId, shiftId));

  const byTender: Record<string, { label: string; cents: number; count: number; refundedCents: number }> = {};
  for (const t of POS_TENDERS) byTender[t.value] = { label: t.label, cents: 0, count: 0, refundedCents: 0 };
  for (const p of payments) { const b = byTender[p.method] ?? (byTender[p.method] = { label: p.method, cents: 0, count: 0, refundedCents: 0 }); b.cents += p.amountCents; b.count += 1; }
  for (const r of refunds) { const b = byTender[r.method] ?? (byTender[r.method] = { label: r.method, cents: 0, count: 0, refundedCents: 0 }); b.refundedCents += r.amountCents; }
  const byBrand: Record<string, { name: string; cents: number; lines: number }> = {};
  for (const l of lines) { const k = String(l.organizationId); const b = byBrand[k] ?? (byBrand[k] = { name: orgs.find((o) => o.id === l.organizationId)?.name ?? "", cents: 0, lines: 0 }); b.cents += l.lineCents; b.lines += 1; }

  const cashIn = byTender.cash?.cents ?? 0;
  const cashOut = byTender.cash?.refundedCents ?? 0;
  const expectedCash = shiftExpectedCashCents({ openingFloatCents: shift.openingFloatCents, cashPaymentsCents: cashIn, cashRefundsCents: cashOut });
  const declinesByReason: Record<string, number> = {};
  for (const d of declines) declinesByReason[d.reason] = (declinesByReason[d.reason] ?? 0) + 1;
  return {
    shift: { ...shift, openedByName: await staffName(shift.openedByUserId), closedByName: await staffName(shift.closedByUserId) },
    sales: { total: sales.length, paid: sales.filter((s) => s.paidAt).length, open: sales.filter((s) => s.status === "open").length, void: sales.filter((s) => s.status === "void").length, refunded: sales.filter((s) => s.status === "refunded" || s.status === "partially_refunded").length },
    takenCents: payments.reduce((a, p) => a + p.amountCents, 0),
    refundedCents: refunds.reduce((a, r) => a + r.amountCents, 0),
    gstCents: sales.filter((s) => s.paidAt).reduce((a, s) => a + s.gstCents, 0),
    byTender: Object.entries(byTender).map(([method, v]) => ({ method, ...v })).filter((v) => v.cents || v.refundedCents),
    byBrand: Object.values(byBrand),
    cash: { openingFloatCents: shift.openingFloatCents, inCents: cashIn, outCents: cashOut, expectedCents: expectedCash, countedCents: shift.closingCashCountedCents, varianceCents: shift.closingCashCountedCents == null ? null : shift.closingCashCountedCents - expectedCash },
    declines: { total: declines.length, byReason: declinesByReason },
  };
}

export function registerPosRoutes(app: Express) {
  const gate = [requireAuth, requireTab("pos")] as const;

  // ── Bootstrap ─────────────────────────────────────────────────────────────
  app.get("/api/admin/pos/bootstrap", ...gate, async (req, res) => {
    try {
      const [regs, buckets, orgs, me] = await Promise.all([
        db.select().from(posRegisters).where(eq(posRegisters.active, true)).orderBy(asc(posRegisters.id)),
        db.select().from(posOrgMoneyAccounts),
        db.select({ id: organizations.id, slug: organizations.slug, name: organizations.name }).from(organizations).where(eq(organizations.active, true)).orderBy(asc(organizations.id)),
        storage.getUser(uid(req)),
      ]);
      const open = regs.length ? await db.select().from(posShifts).where(and(inArray(posShifts.registerId, regs.map((r) => r.id)), isNull(posShifts.closedAt))) : [];
      const openShifts = await Promise.all(open.map(async (s) => ({ ...s, openedByName: await staffName(s.openedByUserId) })));
      res.json({
        registers: regs.map((r) => ({ ...r, openShift: openShifts.find((s) => s.registerId === r.id) ?? null, hasReader: !!r.stripeReaderId })),
        brands: orgs.filter((o) => o.slug !== "sandbox").map((o) => ({ ...o, account: buckets.find((b) => b.organizationId === o.id)?.account ?? null })),
        moneyAccounts: POS_MONEY_ACCOUNTS,
        tenders: POS_TENDERS, manualTenders: POS_MANUAL_TENDERS, declineReasons: POS_DECLINE_REASONS, seller: POS_SELLER,
        me: { id: me?.id, name: [me?.firstName, me?.lastName].filter(Boolean).join(" ") || me?.email, canIssueRefunds: me?.canIssueRefunds === true },
      });
    } catch (e: any) { console.error("[POS] bootstrap", e); res.status(500).json({ message: e.message }); }
  });

  app.post("/api/admin/pos/registers", ...gate, async (req, res) => {
    try {
      const name = str(req.body?.name, 80);
      if (name.length < 2) return res.status(400).json({ message: "Give the register a name." });
      const defaultOrgId = num(req.body?.defaultOrgId);
      const [r] = await db.insert(posRegisters).values({
        name, location: str(req.body?.location, 120) || null,
        defaultOrgId: Number.isFinite(defaultOrgId) ? defaultOrgId : null, createdByUserId: uid(req),
      }).returning();
      res.status(201).json(r);
    } catch (e: any) { if (!posError(res, e)) res.status(500).json({ message: e.message }); }
  });

  // ── Shifts ────────────────────────────────────────────────────────────────
  app.post("/api/admin/pos/shifts/open", ...gate, async (req, res) => {
    try {
      const registerId = num(req.body?.registerId);
      const float = num(req.body?.openingFloatCents ?? 0);
      if (!Number.isFinite(registerId)) return res.status(400).json({ message: "Choose a register." });
      if (!Number.isFinite(float) || float < 0) return res.status(400).json({ message: "The float must be zero or more." });
      const [s] = await db.insert(posShifts).values({ registerId, openedByUserId: uid(req), openingFloatCents: Math.round(float) }).returning();
      res.status(201).json({ ...s, openedByName: await staffName(s.openedByUserId) });
    } catch (e: any) { if (!posError(res, e)) res.status(500).json({ message: e.message }); }
  });

  app.post("/api/admin/pos/shifts/:id/close", ...gate, async (req, res) => {
    try {
      const id = num(req.params.id);
      const counted = num(req.body?.countedCents);
      if (!Number.isFinite(counted) || counted < 0) return res.status(400).json({ message: "Enter the cash you counted." });
      // Empty open carts are abandoned, not money: void them so the shift can close.
      await db.execute(sql`UPDATE pos_sales SET status = 'void', voided_at = now(), void_reason = 'Shift closed with the sale still open' WHERE shift_id = ${id} AND status = 'open' AND paid_cents = 0`);
      await db.update(posShifts).set({ closedAt: new Date(), closedByUserId: uid(req), closingCashCountedCents: Math.round(counted), notes: str(req.body?.notes, 1000) || null }).where(and(eq(posShifts.id, id), isNull(posShifts.closedAt)));
      const summary = await shiftSummary(id);
      if (!summary?.shift.closedAt) return res.status(409).json({ code: "POS_SHIFT_NOT_CLOSED", message: "The shift did not close — is it already closed?" });
      res.json(summary);
    } catch (e: any) { if (!posError(res, e)) res.status(500).json({ message: e.message }); }
  });

  app.get("/api/admin/pos/shifts/:id/summary", ...gate, async (req, res) => {
    try {
      const s = await shiftSummary(num(req.params.id));
      if (!s) return res.status(404).json({ message: "Shift not found." });
      res.json(s);
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  // ── Catalogue: every brand's merch, programmes and events on sale ─────────
  app.get("/api/admin/pos/catalogue", ...gate, async (req, res) => {
    try {
      const q = str(req.query.q, 80).toLowerCase();
      const code = str(req.query.code, 80);
      const products = await db.select().from(shopProducts).where(eq(shopProducts.status, "active")).orderBy(asc(shopProducts.organizationId), asc(shopProducts.sortOrder), asc(shopProducts.title));
      const ids = products.map((p) => p.id);
      const [colours, images, variants] = ids.length ? await Promise.all([
        db.select().from(shopProductColours).where(and(inArray(shopProductColours.productId, ids), eq(shopProductColours.active, true))).orderBy(asc(shopProductColours.sortOrder)),
        db.select().from(shopProductImages).where(inArray(shopProductImages.productId, ids)).orderBy(asc(shopProductImages.sortOrder), asc(shopProductImages.id)),
        db.select().from(shopVariants).where(and(inArray(shopVariants.productId, ids), eq(shopVariants.active, true))),
      ]) : [[], [], []];
      const codeHit = code ? variants.find((v) => (v.sku ?? "").toLowerCase() === code.toLowerCase()) : null;
      const list = products
        .filter((p) => !q || p.title.toLowerCase().includes(q) || (p.subtitle ?? "").toLowerCase().includes(q))
        .map((p) => ({
          id: p.id, orgId: p.organizationId, title: p.title, subtitle: p.subtitle, type: p.type, priceCents: p.priceCents,
          image: images.find((im) => im.productId === p.id && im.colourId == null)?.url ?? images.find((im) => im.productId === p.id)?.url ?? null,
          colours: colours.filter((c) => c.productId === p.id).map((c) => ({
            id: c.id, name: c.name, swatchHex: c.swatchHex,
            image: images.find((im) => im.colourId === c.id)?.url ?? null,
            variants: variants.filter((v) => v.colourId === c.id).map((v) => ({ id: v.id, size: v.size, sku: v.sku, stock: v.stock, priceCents: v.priceCents ?? p.priceCents })),
          })),
        }))
        .filter((p) => p.colours.some((c) => c.variants.length > 0));

      const progs = await db.select({ p: programs, o: programOptions }).from(programs)
        .leftJoin(programOptions, and(eq(programOptions.programId, programs.id), eq(programOptions.isActive, true)))
        .where(eq(programs.isActive, true));
      const byProg = new Map<number, any>();
      for (const row of progs) {
        const p = row.p as any;
        const cur = byProg.get(p.id) ?? { id: p.id, orgId: p.organizationId, name: p.name, type: p.type, registrationOpen: !!p.registrationOpen, options: [] as any[] };
        if (row.o && (row.o.fullPriceCents ?? 0) > 0) cur.options.push({ id: row.o.id, name: row.o.name, fullPriceCents: row.o.fullPriceCents });
        byProg.set(p.id, cur);
      }
      const programmes = Array.from(byProg.values())
        .filter((p) => ["academy", "holiday_camp"].includes(p.type))
        .filter((p) => !q || String(p.name).toLowerCase().includes(q));

      const now = new Date();
      const events = await db.select().from(clubEvents).where(gte(clubEvents.startsAt, new Date(now.getTime() - 24 * 3600 * 1000))).orderBy(asc(clubEvents.startsAt));
      const evIds = events.map((e) => e.id);
      const types = evIds.length ? await db.select().from(clubEventTicketTypes).where(and(inArray(clubEventTicketTypes.eventId, evIds), eq(clubEventTicketTypes.isActive, true))).orderBy(asc(clubEventTicketTypes.sort)) : [];
      const eventsOut = events.map((e) => ({
        id: e.id, orgId: e.organizationId, name: e.name, startsAt: e.startsAt, stripeAccount: (e as any).stripeAccount,
        ticketTypes: types.filter((t) => t.eventId === e.id && (!t.salesStart || t.salesStart <= now) && (!t.salesEnd || t.salesEnd >= now)).map((t) => ({ id: t.id, name: t.name, priceCents: t.priceCents })),
      })).filter((e) => e.ticketTypes.length > 0 && (!q || e.name.toLowerCase().includes(q)));

      res.json({ products: list, programmes, events: eventsOut, codeHit: codeHit ? { variantId: codeHit.id, productId: codeHit.productId } : null });
    } catch (e: any) { console.error("[POS] catalogue", e); res.status(500).json({ message: e.message }); }
  });

  // ── Sales ─────────────────────────────────────────────────────────────────
  app.get("/api/admin/pos/sales", ...gate, async (req, res) => {
    try {
      const shiftId = num(req.query.shiftId);
      const status = str(req.query.status, 30);
      const where = [] as any[];
      if (Number.isFinite(shiftId)) where.push(eq(posSales.shiftId, shiftId));
      if (status) where.push(eq(posSales.status, status));
      const rows = await db.select().from(posSales).where(where.length ? and(...where) : undefined).orderBy(desc(posSales.id)).limit(60);
      res.json(rows.map((s) => ({ ...s, remainingCents: Math.max(0, s.totalCents - s.paidCents) })));
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.post("/api/admin/pos/sales", ...gate, async (req, res) => {
    try {
      const registerId = num(req.body?.registerId);
      if (!Number.isFinite(registerId)) return res.status(400).json({ message: "Choose a register." });
      const [shift] = await db.select().from(posShifts).where(and(eq(posShifts.registerId, registerId), isNull(posShifts.closedAt)));
      if (!shift) return res.status(409).json({ code: "POS_NO_SHIFT", message: "Open a shift on this register first." });
      const account = isPosMoneyAccount(req.body?.moneyAccount) ? req.body.moneyAccount : "club";
      const [sale] = await db.insert(posSales).values({ registerId, shiftId: shift.id, moneyAccount: account, servedByUserId: uid(req) }).returning();
      res.status(201).json(await loadSale(sale.id));
    } catch (e: any) { if (!posError(res, e)) res.status(500).json({ message: e.message }); }
  });

  app.get("/api/admin/pos/sales/:id", ...gate, async (req, res) => {
    const sale = await loadSale(num(req.params.id));
    if (!sale) return res.status(404).json({ message: "Sale not found." });
    res.json(sale);
  });

  app.patch("/api/admin/pos/sales/:id", ...gate, async (req, res) => {
    try {
      const sale = await openSaleOr409(res, num(req.params.id)); if (!sale) return;
      const b = req.body ?? {};
      const patch: Partial<typeof posSales.$inferInsert> = {};
      if (b.discountCents !== undefined) {
        const d = num(b.discountCents);
        if (!Number.isFinite(d) || d < 0) return res.status(400).json({ message: "Bad discount." });
        if (d > sale.subtotalCents) return res.status(400).json({ message: "A discount cannot exceed the subtotal." });
        patch.discountCents = Math.round(d);
        patch.discountReason = d > 0 ? (str(b.discountReason, 200) || null) : null;
        if (d > 0 && !patch.discountReason) return res.status(400).json({ message: "Say why the price was reduced — it goes on the sale." });
        patch.roundingCents = 0;
      }
      if (b.contactId !== undefined) {
        if (b.contactId === null) patch.contactId = null;
        else {
          const cid = num(b.contactId);
          const [c] = Number.isFinite(cid) ? await db.select({ id: contacts.id, f: contacts.firstName, l: contacts.lastName, e: contacts.email, p: contacts.phone }).from(contacts).where(eq(contacts.id, cid)) : [];
          if (!c) return res.status(404).json({ message: "That person was not found." });
          patch.contactId = c.id;
          if (!str(b.customer?.name)) patch.customerName = [c.f, c.l].filter(Boolean).join(" ") || null;
          if (!str(b.customer?.email)) patch.customerEmail = c.e || null;
          if (!str(b.customer?.phone)) patch.customerPhone = c.p || null;
        }
      }
      if (b.customer !== undefined) {
        const c = b.customer ?? {};
        if (c.name !== undefined) patch.customerName = str(c.name, 120) || null;
        if (c.email !== undefined) { const e = str(c.email, 200).toLowerCase(); if (e && !e.includes("@")) return res.status(400).json({ message: "That email doesn't look right." }); patch.customerEmail = e || null; }
        if (c.phone !== undefined) patch.customerPhone = str(c.phone, 40) || null;
      }
      // Consent is evidence: stamped only when the box was ticked, cleared when unticked.
      if (b.marketingOptIn !== undefined) patch.marketingOptInAt = b.marketingOptIn === true ? new Date() : null;
      if (b.notes !== undefined) patch.notes = str(b.notes, 1000) || null;
      if (Object.keys(patch).length) await db.update(posSales).set(patch).where(eq(posSales.id, sale.id));
      res.json(await loadSale(sale.id));
    } catch (e: any) { if (!posError(res, e)) res.status(500).json({ message: e.message }); }
  });

  // ── Lines ─────────────────────────────────────────────────────────────────
  app.post("/api/admin/pos/sales/:id/lines", ...gate, async (req, res) => {
    try {
      const sale = await openSaleOr409(res, num(req.params.id)); if (!sale) return;
      const b = req.body ?? {};
      const kind = str(b.kind, 20);
      const qty = Math.max(1, Math.min(100, Math.round(num(b.qty ?? 1)) || 1));
      const nextSort = sale.lines.length;

      if (kind === "variant") {
        const variantId = num(b.variantId);
        const [row] = Number.isFinite(variantId) ? await db.select({ v: shopVariants, p: shopProducts, c: shopProductColours }).from(shopVariants)
          .innerJoin(shopProducts, eq(shopProducts.id, shopVariants.productId))
          .innerJoin(shopProductColours, eq(shopProductColours.id, shopVariants.colourId))
          .where(eq(shopVariants.id, variantId)) : [];
        if (!row || !row.v.active || row.p.status !== "active") return res.status(404).json({ message: "That item is not on sale." });
        const existing = sale.lines.find((l) => l.kind === "variant" && l.variantId === row.v.id);
        const wantQty = (existing?.qty ?? 0) + qty;
        if (row.v.stock < wantQty) return res.status(409).json({ code: "POS_STOCK", message: `Only ${row.v.stock} of that size in stock.` });
        const unit = row.v.priceCents ?? row.p.priceCents;
        if (existing) {
          await db.update(posSaleLines).set({ qty: wantQty, lineCents: unit * wantQty }).where(eq(posSaleLines.id, existing.id));
        } else {
          const img = (await db.select().from(shopProductImages).where(or(eq(shopProductImages.colourId, row.c.id), and(eq(shopProductImages.productId, row.p.id), isNull(shopProductImages.colourId)))).orderBy(asc(shopProductImages.sortOrder)).limit(1))[0];
          await db.insert(posSaleLines).values({
            saleId: sale.id, kind: "variant", organizationId: row.p.organizationId, variantId: row.v.id, productId: row.p.id,
            title: row.p.title, detail: [row.c.name, row.v.size].filter(Boolean).join(" · "), unitCents: unit, qty, lineCents: unit * qty,
            meta: { imageUrl: img?.url ?? null, sku: row.v.sku ?? null }, sort: nextSort,
          });
        }
      } else if (kind === "custom") {
        const orgId = num(b.orgId);
        const unit = Math.round(num(b.unitCents));
        const title = str(b.title, 120);
        if (!Number.isFinite(orgId)) return res.status(400).json({ message: "Which brand is this for?" });
        if (!title) return res.status(400).json({ message: "Describe the item." });
        if (!Number.isFinite(unit) || unit < 0) return res.status(400).json({ message: "Bad price." });
        await db.insert(posSaleLines).values({ saleId: sale.id, kind: "custom", organizationId: orgId, title, detail: str(b.detail, 200) || null, unitCents: unit, qty, lineCents: unit * qty, sort: nextSort });
      } else if (kind === "registration") {
        const registrationId = num(b.registrationId);
        const [row] = Number.isFinite(registrationId) ? await db.select({ r: registrations, p: programs, c: contacts }).from(registrations)
          .innerJoin(programs, eq(programs.id, registrations.programId))
          .innerJoin(contacts, eq(contacts.id, registrations.contactId))
          .where(eq(registrations.id, registrationId)) : [];
        if (!row) return res.status(404).json({ message: "Registration not found." });
        if (row.r.status !== "pending") return res.status(409).json({ code: "POS_REG_STATE", message: `That registration is ${row.r.status}, not awaiting payment.` });
        if (row.r.posSaleId && row.r.posSaleId !== sale.id) return res.status(409).json({ code: "POS_REG_TAKEN", message: "That registration is already in another sale." });
        const total = row.r.totalCents ?? 0;
        if (total <= 0) return res.status(409).json({ message: "That registration has no amount to pay." });
        if (!row.p.organizationId) return res.status(409).json({ message: "That programme has no brand." });
        await db.insert(posSaleLines).values({
          saleId: sale.id, kind: "registration", organizationId: row.p.organizationId, registrationId: row.r.id,
          title: row.p.name, detail: [row.c.firstName, row.c.lastName].filter(Boolean).join(" "), unitCents: total, qty: 1, lineCents: total, sort: nextSort,
        });
        await db.update(registrations).set({ posSaleId: sale.id } as any).where(eq(registrations.id, row.r.id));
      } else if (kind === "event_ticket") {
        const ticketTypeId = num(b.ticketTypeId);
        const [row] = Number.isFinite(ticketTypeId) ? await db.select({ t: clubEventTicketTypes, e: clubEvents }).from(clubEventTicketTypes).innerJoin(clubEvents, eq(clubEvents.id, clubEventTicketTypes.eventId)).where(eq(clubEventTicketTypes.id, ticketTypeId)) : [];
        if (!row || !row.t.isActive) return res.status(404).json({ message: "That ticket is not on sale." });
        const buyerName = str(b.buyerName, 120) || sale.customerName || "";
        const buyerEmail = str(b.buyerEmail, 200).toLowerCase() || sale.customerEmail || "";
        if (buyerName.length < 2 || !buyerEmail.includes("@")) return res.status(400).json({ message: "A ticket needs the buyer's name and email — the ticket is sent there." });
        await db.insert(posSaleLines).values({
          saleId: sale.id, kind: "event_ticket", organizationId: row.e.organizationId, clubEventTicketTypeId: row.t.id,
          title: row.e.name, detail: row.t.name, unitCents: row.t.priceCents, qty, lineCents: row.t.priceCents * qty,
          meta: { buyerName, buyerEmail, buyerPhone: str(b.buyerPhone, 40) || null }, sort: nextSort,
        });
        if (!sale.customerName) await db.update(posSales).set({ customerName: buyerName, customerEmail: sale.customerEmail || buyerEmail }).where(eq(posSales.id, sale.id));
      } else {
        return res.status(400).json({ message: "Unknown line kind." });
      }
      res.status(201).json(await loadSale(sale.id));
    } catch (e: any) { if (!posError(res, e)) { console.error("[POS] add line", e); res.status(500).json({ message: e.message }); } }
  });

  app.patch("/api/admin/pos/sales/:id/lines/:lineId", ...gate, async (req, res) => {
    try {
      const sale = await openSaleOr409(res, num(req.params.id)); if (!sale) return;
      const line = sale.lines.find((l) => l.id === num(req.params.lineId));
      if (!line) return res.status(404).json({ message: "Line not found." });
      const qty = Math.round(num(req.body?.qty));
      if (!Number.isFinite(qty) || qty < 1 || qty > 100) return res.status(400).json({ message: "Quantity must be between 1 and 100." });
      // A registration is one child in one programme — it has no quantity.
      if (line.kind === "registration") return res.status(409).json({ message: "A registration is for one player." });
      if (line.kind === "variant" && line.variantId) {
        const [v] = await db.select().from(shopVariants).where(eq(shopVariants.id, line.variantId));
        if (v && v.stock < qty) return res.status(409).json({ code: "POS_STOCK", message: `Only ${v.stock} of that size in stock.` });
      }
      await db.update(posSaleLines).set({ qty, lineCents: line.unitCents * qty }).where(eq(posSaleLines.id, line.id));
      res.json(await loadSale(sale.id));
    } catch (e: any) { if (!posError(res, e)) res.status(500).json({ message: e.message }); }
  });

  app.delete("/api/admin/pos/sales/:id/lines/:lineId", ...gate, async (req, res) => {
    try {
      const sale = await openSaleOr409(res, num(req.params.id)); if (!sale) return;
      const line = sale.lines.find((l) => l.id === num(req.params.lineId));
      if (!line) return res.status(404).json({ message: "Line not found." });
      await db.delete(posSaleLines).where(eq(posSaleLines.id, line.id));
      // The pending registration stays as checkout scaffolding, just unlinked.
      if (line.registrationId) await db.update(registrations).set({ posSaleId: null } as any).where(eq(registrations.id, line.registrationId));
      res.json(await loadSale(sale.id));
    } catch (e: any) { if (!posError(res, e)) res.status(500).json({ message: e.message }); }
  });

  // ── Manual tenders: cash (rounded), EFTPOS terminal, bank transfer, other ─
  app.post("/api/admin/pos/sales/:id/payments", ...gate, async (req, res) => {
    try {
      const sale = await openSaleOr409(res, num(req.params.id)); if (!sale) return;
      const method = str(req.body?.method, 20);
      if (!isPosTender(method) || method === "card_present") return res.status(400).json({ message: "Choose how they paid: cash, EFTPOS terminal, bank transfer or other." });
      const tendered = Math.round(num(req.body?.amountCents));
      if (!Number.isFinite(tendered) || tendered <= 0) return res.status(400).json({ message: "Enter the amount." });
      if (sale.lines.length === 0) return res.status(409).json({ message: "Nothing in the sale yet." });
      const reference = str(req.body?.reference, 120) || null;
      const tender = POS_TENDERS.find((t) => t.value === method)!;
      if (tender.needsReference && !reference && method !== "other") return res.status(400).json({ message: `Record the ${tender.label} reference (the slip or transfer number).` });

      let remaining = sale.remainingCents;
      let amount = tendered;
      let change = 0;
      if (method === "cash" && tendered >= remaining && sale.roundingCents === 0) {
        // Settling in cash: the remainder rounds to 10c, the rounding is recorded
        // on the sale, and the payment is the rounded remainder. Never round to
        // zero — a 3c remainder is paid as 3c rather than waved away.
        const { roundedCents, roundingCents } = roundCashToTenCents(remaining);
        if (roundingCents !== 0 && roundedCents > 0) {
          await db.update(posSales).set({ roundingCents }).where(eq(posSales.id, sale.id));
          remaining = roundedCents;
        }
        amount = remaining;
        change = tendered - remaining;
      } else if (tendered > remaining) {
        return res.status(409).json({ code: "POS_OVERPAY", message: `${(remaining / 100).toFixed(2)} is owing — record that, not more.` });
      }
      await db.insert(posPayments).values({ saleId: sale.id, method, amountCents: amount, reference, status: "succeeded", succeededAt: new Date(), createdByUserId: uid(req) });
      const after = await loadSale(sale.id);
      if (after?.status === "paid") await fulfilPaidSale(sale.id);
      res.status(201).json({ sale: await loadSale(sale.id), changeCents: change });
    } catch (e: any) { if (!posError(res, e)) { console.error("[POS] payment", e); res.status(500).json({ message: e.message }); } }
  });

  // A sale that costs nothing — a comp, a giveaway at a stand — still has to
  // close, so the stock moves and the giveaway is on the record. There is no
  // payment to take, so this is the only way a $0 sale reaches 'paid'.
  app.post("/api/admin/pos/sales/:id/complete", ...gate, async (req, res) => {
    try {
      const sale = await openSaleOr409(res, num(req.params.id)); if (!sale) return;
      if (sale.lines.length === 0) return res.status(409).json({ message: "Nothing in the sale." });
      if (sale.totalCents !== 0) return res.status(409).json({ message: `${(sale.remainingCents / 100).toFixed(2)} is owing — take the payment.` });
      await db.update(posSales).set({ status: "paid", paidAt: new Date(), notes: [sale.notes, `Nothing to pay${str(req.body?.reason, 200) ? ` — ${str(req.body.reason, 200)}` : ""}`].filter(Boolean).join(" · ") }).where(and(eq(posSales.id, sale.id), eq(posSales.status, "open")));
      await fulfilPaidSale(sale.id);
      res.json(await loadSale(sale.id));
    } catch (e: any) { if (!posError(res, e)) res.status(500).json({ message: e.message }); }
  });

  // ── Card through a Stripe reader (server-driven) ─────────────────────────
  app.post("/api/admin/pos/sales/:id/payments/card", ...gate, async (req, res) => {
    try {
      const sale = await openSaleOr409(res, num(req.params.id)); if (!sale) return;
      if (sale.remainingCents <= 0) return res.status(409).json({ message: "Nothing owing." });
      const pending = sale.payments.find((p) => p.status === "pending");
      if (pending) return res.status(409).json({ code: "POS_CARD_PENDING", message: "A card payment is already in progress — finish or cancel it first.", paymentId: pending.id });
      const { stripe, ok, reason } = stripeForAccount(sale.moneyAccount);
      if (!ok) return res.status(409).json({ code: "POS_NO_STRIPE", message: reason });
      const [register] = await db.select().from(posRegisters).where(eq(posRegisters.id, sale.registerId));
      const useReader = req.body?.viaReader !== false && !!register?.stripeReaderId;
      const pi = await stripe.paymentIntents.create({
        amount: sale.remainingCents, currency: "nzd",
        payment_method_types: ["card_present"], capture_method: "automatic",
        description: `Register ${sale.saleNumber}`,
        ...(sale.customerEmail ? { receipt_email: sale.customerEmail } : {}),
        metadata: { kind: "pos_sale", posSaleId: String(sale.id), saleNumber: sale.saleNumber, registerId: String(sale.registerId) },
      }, { idempotencyKey: `pos_sale_${sale.id}_card_${sale.payments.length}` });
      const [payment] = await db.insert(posPayments).values({ saleId: sale.id, method: "card_present", amountCents: sale.remainingCents, stripePaymentIntentId: pi.id, status: "pending", createdByUserId: uid(req) }).returning();
      let readerAction: any = null;
      if (useReader) {
        try {
          const reader = await stripe.terminal.readers.processPaymentIntent(register!.stripeReaderId!, { payment_intent: pi.id });
          readerAction = reader.action ?? null;
        } catch (e: any) {
          await db.update(posPayments).set({ status: "failed" }).where(eq(posPayments.id, payment.id));
          await stripe.paymentIntents.cancel(pi.id).catch(() => {});
          return res.status(409).json({ code: "POS_READER", message: `The reader did not take the payment: ${e?.message ?? "unknown error"}` });
        }
      }
      res.status(201).json({ paymentId: payment.id, paymentIntentId: pi.id, clientSecret: useReader ? null : pi.client_secret, viaReader: useReader, readerAction });
    } catch (e: any) { if (!posError(res, e)) { console.error("[POS] card", e); res.status(500).json({ message: e.message }); } }
  });

  app.post("/api/admin/pos/sales/:id/payments/:pid/confirm", ...gate, async (req, res) => {
    try {
      const saleId = num(req.params.id);
      const [payment] = await db.select().from(posPayments).where(and(eq(posPayments.id, num(req.params.pid)), eq(posPayments.saleId, saleId)));
      if (!payment || !payment.stripePaymentIntentId) return res.status(404).json({ message: "Payment not found." });
      const [sale] = await db.select().from(posSales).where(eq(posSales.id, saleId));
      const { stripe } = stripeForAccount(sale!.moneyAccount);
      let pi = await stripe.paymentIntents.retrieve(payment.stripePaymentIntentId);
      if (pi.status === "requires_capture") pi = await stripe.paymentIntents.capture(pi.id);
      if (pi.status === "succeeded") {
        // Paid state is read back from Stripe, never trusted from the browser.
        await markPosPaymentSucceededByIntent(pi as any);
      } else if (pi.status === "canceled") {
        await db.update(posPayments).set({ status: "canceled" }).where(and(eq(posPayments.id, payment.id), eq(posPayments.status, "pending")));
      }
      res.json({ stripeStatus: pi.status, sale: await loadSale(saleId) });
    } catch (e: any) { if (!posError(res, e)) { console.error("[POS] confirm", e); res.status(500).json({ message: e.message }); } }
  });

  app.post("/api/admin/pos/sales/:id/payments/:pid/cancel", ...gate, async (req, res) => {
    try {
      const saleId = num(req.params.id);
      const [payment] = await db.select().from(posPayments).where(and(eq(posPayments.id, num(req.params.pid)), eq(posPayments.saleId, saleId)));
      if (!payment) return res.status(404).json({ message: "Payment not found." });
      if (payment.status !== "pending") return res.status(409).json({ message: `That payment is ${payment.status}.` });
      const [sale] = await db.select().from(posSales).where(eq(posSales.id, saleId));
      const { stripe } = stripeForAccount(sale!.moneyAccount);
      const [register] = await db.select().from(posRegisters).where(eq(posRegisters.id, sale!.registerId));
      if (register?.stripeReaderId) await stripe.terminal.readers.cancelAction(register.stripeReaderId).catch(() => {});
      if (payment.stripePaymentIntentId) {
        const pi = await stripe.paymentIntents.retrieve(payment.stripePaymentIntentId);
        if (pi.status === "succeeded") { await markPosPaymentSucceededByIntent(pi as any); return res.status(409).json({ code: "POS_ALREADY_PAID", message: "That card payment already went through.", sale: await loadSale(saleId) }); }
        if (pi.status !== "canceled") await stripe.paymentIntents.cancel(pi.id).catch(() => {});
      }
      await db.update(posPayments).set({ status: "canceled" }).where(and(eq(posPayments.id, payment.id), eq(posPayments.status, "pending")));
      res.json(await loadSale(saleId));
    } catch (e: any) { if (!posError(res, e)) res.status(500).json({ message: e.message }); }
  });

  // ── Void (unpaid only) ────────────────────────────────────────────────────
  app.post("/api/admin/pos/sales/:id/void", ...gate, async (req, res) => {
    try {
      const sale = await openSaleOr409(res, num(req.params.id)); if (!sale) return;
      if (sale.paidCents > 0) return res.status(409).json({ code: "POS_SALE_HAS_MONEY", message: "This sale has taken money — refund it instead of voiding." });
      const reason = str(req.body?.reason, 200) || "Voided at the register";
      for (const l of sale.lines) if (l.registrationId) await db.update(registrations).set({ posSaleId: null } as any).where(eq(registrations.id, l.registrationId));
      await db.update(posSales).set({ status: "void", voidedAt: new Date(), voidReason: reason }).where(eq(posSales.id, sale.id));
      res.json(await loadSale(sale.id));
    } catch (e: any) { if (!posError(res, e)) res.status(500).json({ message: e.message }); }
  });

  // ── Refunds: the explicit flag, no role bypass ────────────────────────────
  app.post("/api/admin/pos/sales/:id/refunds", requireAuth, requireTab("pos"), requireRefundPermission, async (req, res) => {
    try {
      const sale = await loadSale(num(req.params.id));
      if (!sale) return res.status(404).json({ message: "Sale not found." });
      const amount = Math.round(num(req.body?.amountCents));
      const reason = str(req.body?.reason, 300);
      if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ message: "Enter the amount to refund." });
      if (!reason) return res.status(400).json({ message: "Say why — it goes on the sale." });
      if (amount > sale.refundableCents) return res.status(409).json({ code: "POS_OVERREFUND", message: `Only ${(sale.refundableCents / 100).toFixed(2)} can still be refunded.` });
      const paymentId = num(req.body?.paymentId);
      const payment = Number.isFinite(paymentId) ? sale.payments.find((p) => p.id === paymentId && p.status === "succeeded") : sale.payments.find((p) => p.status === "succeeded" && p.method === "card_present") ?? sale.payments.find((p) => p.status === "succeeded");
      if (!payment) return res.status(409).json({ message: "No payment on this sale to refund against." });
      let stripeRefundId: string | null = null;
      if (payment.method === "card_present" && payment.stripePaymentIntentId) {
        const { stripe } = stripeForAccount(sale.moneyAccount);
        const r = await stripe.refunds.create({ payment_intent: payment.stripePaymentIntentId, amount, metadata: { kind: "pos_sale", posSaleId: String(sale.id) } }, { idempotencyKey: `pos_refund_${sale.id}_${payment.id}_${amount}_${sale.refunds.length}` });
        stripeRefundId = r.id;
      }
      // Cash, EFTPOS and bank refunds are RECORDED; the money goes back over the counter.
      await db.insert(posRefunds).values({ saleId: sale.id, paymentId: payment.id, method: payment.method, amountCents: amount, reason, stripeRefundId, issuedByUserId: uid(req) });
      await storage.createAuditLog({ userId: uid(req), action: "refund", entity: "pos_sale", entityId: sale.id, details: `POS ${sale.saleNumber}: refunded ${(amount / 100).toFixed(2)} by ${payment.method} — ${reason}` } as any);
      res.status(201).json(await loadSale(sale.id));
    } catch (e: any) { if (!posError(res, e)) { console.error("[POS] refund", e); res.status(500).json({ message: e.message }); } }
  });

  // ── Receipt ──────────────────────────────────────────────────────────────
  app.post("/api/admin/pos/sales/:id/receipt", ...gate, async (req, res) => {
    try {
      const sale = await loadSale(num(req.params.id));
      if (!sale) return res.status(404).json({ message: "Sale not found." });
      if (!sale.paidAt) return res.status(409).json({ message: "The sale isn't paid yet." });
      const to = str(req.body?.email, 200).toLowerCase() || sale.customerEmail || "";
      if (!to.includes("@")) return res.status(400).json({ message: "Enter an email address for the receipt." });
      if (to !== sale.customerEmail) await db.update(posSales).set({ customerEmail: to }).where(eq(posSales.id, sale.id));
      const ok = await sendReceipt(sale.id, to);
      res.json({ sent: ok, sale: await loadSale(sale.id) });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.get("/api/public/pos/receipt/:token", async (req, res) => {
    try {
      const token = str(req.params.token, 64);
      if (!/^[0-9a-f-]{36}$/i.test(token)) return res.status(404).json({ message: "Not found." });
      const [row] = await db.select({ id: posSales.id }).from(posSales).where(eq(posSales.token, token));
      const sale = row ? await loadSale(row.id) : null;
      if (!sale || !sale.paidAt) return res.status(404).json({ message: "Not found." });
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("X-Robots-Tag", "noindex");
      const tier = receiptTier(sale.totalCents);
      res.json({
        seller: POS_SELLER, saleNumber: sale.saleNumber, paidAt: sale.paidAt, status: sale.status, tier,
        lines: sale.lines.map((l) => ({ title: l.title, detail: l.detail, brand: l.brand, qty: l.qty, unitCents: l.unitCents, lineCents: l.lineCents })),
        subtotalCents: sale.subtotalCents, discountCents: sale.discountCents, roundingCents: sale.roundingCents, totalCents: sale.totalCents, gstCents: sale.gstCents,
        payments: sale.payments.filter((p) => p.status === "succeeded").map((p) => ({ label: p.label, amountCents: p.amountCents, reference: p.method === "card_present" ? null : p.reference })),
        refunds: sale.refunds.map((r) => ({ amountCents: r.amountCents, at: r.createdAt })),
        customerName: tier === "over_1000" ? sale.customerName : null,
        servedBy: sale.servedByName,
      });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  // ── The sale that didn't happen ───────────────────────────────────────────
  app.post("/api/admin/pos/declines", ...gate, async (req, res) => {
    try {
      const registerId = num(req.body?.registerId);
      const reason = str(req.body?.reason, 30);
      if (!Number.isFinite(registerId)) return res.status(400).json({ message: "Choose a register." });
      if (!isPosDeclineReason(reason)) return res.status(400).json({ message: "Choose a reason." });
      const [shift] = await db.select({ id: posShifts.id }).from(posShifts).where(and(eq(posShifts.registerId, registerId), isNull(posShifts.closedAt)));
      const amt = req.body?.amountCents == null || req.body.amountCents === "" ? null : Math.round(num(req.body.amountCents));
      const [d] = await db.insert(posDeclines).values({ registerId, shiftId: shift?.id ?? null, reason, amountCents: amt != null && Number.isFinite(amt) ? amt : null, note: str(req.body?.note, 300) || null, createdByUserId: uid(req) }).returning();
      res.status(201).json(d);
    } catch (e: any) { if (!posError(res, e)) res.status(500).json({ message: e.message }); }
  });

  // ── Terminal connection token for the app SDK (Tap to Pay / WisePad) ─────
  app.post("/api/admin/pos/terminal/connection-token", ...gate, async (req, res) => {
    try {
      const registerId = num(req.body?.registerId);
      const [register] = Number.isFinite(registerId) ? await db.select().from(posRegisters).where(eq(posRegisters.id, registerId)) : [];
      const account = isPosMoneyAccount(req.body?.moneyAccount) ? req.body.moneyAccount : "club";
      const { stripe, ok, reason } = stripeForAccount(account);
      if (!ok) return res.status(409).json({ code: "POS_NO_STRIPE", message: reason });
      const token = await stripe.terminal.connectionTokens.create(register?.stripeLocationId ? { location: register.stripeLocationId } : {});
      res.json({ secret: token.secret });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });
}
