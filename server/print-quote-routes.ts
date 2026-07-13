// ─────────────────────────────────────────────────────────────────────────────
// PRINT QUOTES — indicative quotes from the unitedprints.co.nz "Instant Quote"
// page, awaiting the Print manager's Approve/Reject before they enter the
// existing Orders/production pipeline.
//
// Public (cookie-less, CORS-allow-listed to the United Prints site):
//   POST /api/public/unitedprints/quote-request
//
// Admin (session + the "quotes" tab, org-scoped to the United Prints workspace):
//   GET   /api/admin/print-quotes
//   GET   /api/admin/print-quotes/:id
//   PATCH /api/admin/print-quotes/:id     — { action: "approve" } | { action: "reject", reason? }
//
// A quote is deliberately NOT a print_orders row from the moment it lands — the
// customer's self-served total is indicative only. Approve materialises it into
// print_orders (+ items + a 'created' event), reusing the SAME orderNumber +
// magicLinkToken scheme as the existing public order-creation route
// (POST /api/print/orders in routes.ts), so numbering can never collide.
// Reject just closes the quote out.
// ─────────────────────────────────────────────────────────────────────────────
import crypto from "crypto";
import type { Express, Request, Response } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "./db";
import { requireAuth, requireTab } from "./auth";
import {
  organizations,
  printQuotes,
  printQuoteItems,
  printOrders,
  printOrderItems,
  printOrderEvents,
} from "@shared/schema";
import { emailQuoteReceivedCustomer, emailQuoteRequestDima } from "./print-email";

// United Prints is org 8 — same default used by the existing public print
// materials/order routes in routes.ts.
const UNITED_PRINTS_ORG_ID = 8;

const s = (v: any, max = 500): string => String(v ?? "").trim().slice(0, max);
const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const toCents = (v: any): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};

// ── CORS ─────────────────────────────────────────────────────────────────────
// Reflects an allow-listed origin. This endpoint is session-less and sends no
// credentials, so reflection is safe. Mirrors hiringCors/hiringAllowOrigin.
const QUOTE_HOSTS = new Set([
  "unitedprints.co.nz", "www.unitedprints.co.nz",
  "united-print-website.vercel.app",
]);

function quoteAllowOrigin(origin: string | undefined): string | null {
  if (!origin) return null;
  try {
    const { hostname, protocol } = new URL(origin);
    const isLocal = hostname === "localhost" || hostname === "127.0.0.1";
    if (protocol !== "https:" && !isLocal) return null;
    if (QUOTE_HOSTS.has(hostname) || hostname.endsWith(".vercel.app") || isLocal) return origin;
  } catch {
    /* malformed origin */
  }
  return null;
}

function quoteCors(req: Request, res: Response) {
  const allowed = quoteAllowOrigin(req.headers.origin as string | undefined);
  if (allowed) {
    res.set("Access-Control-Allow-Origin", allowed);
    res.set("Vary", "Origin");
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");
  }
}

// ── Org scoping (mirrors workspaceOrg in hiring-routes.ts) ─────────────────
async function workspaceOrg(req: Request): Promise<{ id: number; slug: string } | null> {
  const slug = String(req.headers["x-workspace-slug"] || "").trim();
  if (!slug) return null;
  const [org] = await db.select().from(organizations).where(eq(organizations.slug, slug));
  return org ? { id: org.id, slug: org.slug } : null;
}

export function registerPrintQuoteRoutes(app: Express) {
  // ═══════════════════════════ PUBLIC ═══════════════════════════════════════

  app.options("/api/public/unitedprints/quote-request", (req, res) => { quoteCors(req, res); res.sendStatus(204); });
  app.post("/api/public/unitedprints/quote-request", async (req: Request, res: Response) => {
    quoteCors(req, res);
    try {
      const body = req.body || {};
      const name = s(body.name, 160);
      const email = s(body.email, 160).toLowerCase();
      const phone = s(body.phone, 40);
      const rawItems = Array.isArray(body.items) ? body.items : [];

      const errors: string[] = [];
      if (!name) errors.push("Your name is required.");
      if (!isEmail(email)) errors.push("A valid email address is required.");
      if (!rawItems.length) errors.push("At least one item is required.");
      if (errors.length) return res.status(400).json({ message: errors[0], errors });

      const subtotalCents = toCents(body.subtotalExGst);
      const gstCents = toCents(body.gst);
      const totalCents = toCents(body.totalIncGst);

      const [quote] = await db.insert(printQuotes).values({
        organizationId: UNITED_PRINTS_ORG_ID,
        token: crypto.randomBytes(24).toString("hex"),
        status: "new",
        customerName: name,
        customerEmail: email,
        customerPhone: phone || null,
        source: s(body.source, 200) || null,
        sourceUrl: s(body.sourceUrl, 500) || null,
        subtotalCents,
        gstCents,
        totalCents,
        indicative: true,
        note: s(body.note, 2000) || null,
      }).returning();

      const items = rawItems.slice(0, 50).map((it: any) => ({
        quoteId: quote.id,
        designName: s(it.design, 200) || null,
        material: s(it.material, 120) || null,
        sizeLabel: s(it.size, 120) || null,
        areaM2: Number.isFinite(Number(it.areaM2)) ? String(it.areaM2) : null,
        quantity: Number.isFinite(Number(it.quantity)) && Number(it.quantity) > 0 ? Math.round(Number(it.quantity)) : 1,
        lineExGstCents: toCents(it.lineExGst),
        designFileName: s(it.design_file, 300) || null,
      }));
      const insertedItems = items.length ? await db.insert(printQuoteItems).values(items).returning() : [];

      // Email is best-effort. A Resend outage must never lose the quote.
      try {
        await emailQuoteReceivedCustomer(quote, insertedItems);
      } catch (mailErr) {
        console.error("[print-quotes] customer email failed:", mailErr);
      }
      try {
        await emailQuoteRequestDima(quote, insertedItems);
      } catch (mailErr) {
        console.error("[print-quotes] dima email failed:", mailErr);
      }

      res.json({ ok: true, id: quote.id });
    } catch (e: any) {
      console.error("[print-quotes] quote request failed:", e);
      res.status(500).json({ message: "Something went wrong sending your quote request." });
    }
  });

  // ═══════════════════════════ ADMIN ════════════════════════════════════════
  const tab = requireTab("quotes");

  app.get("/api/admin/print-quotes", requireAuth, tab, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "X-Workspace-Slug header required" });

      const statusFilter = typeof req.query.status === "string" ? req.query.status : undefined;
      const where = statusFilter
        ? and(eq(printQuotes.organizationId, org.id), eq(printQuotes.status, statusFilter))
        : eq(printQuotes.organizationId, org.id);

      const quotes = await db.select().from(printQuotes).where(where).orderBy(desc(printQuotes.createdAt));

      const ids = quotes.map((q) => q.id);
      const items = ids.length
        ? await db.select().from(printQuoteItems).where(inArray(printQuoteItems.quoteId, ids))
        : [];

      res.json({
        quotes: quotes.map((q) => ({
          ...q,
          items: items.filter((it) => it.quoteId === q.id),
        })),
      });
    } catch (e: any) {
      console.error("[print-quotes] admin list failed:", e);
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/admin/print-quotes/:id", requireAuth, tab, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      const id = parseInt(String(req.params.id), 10);
      if (!org || !Number.isFinite(id)) return res.status(400).json({ message: "Bad request" });

      const [quote] = await db.select().from(printQuotes)
        .where(and(eq(printQuotes.id, id), eq(printQuotes.organizationId, org.id)));
      if (!quote) return res.status(404).json({ message: "Quote not found" });

      const items = await db.select().from(printQuoteItems).where(eq(printQuoteItems.quoteId, id));
      res.json({ ...quote, items });
    } catch (e: any) {
      console.error("[print-quotes] admin get failed:", e);
      res.status(500).json({ message: e.message });
    }
  });

  app.patch("/api/admin/print-quotes/:id", requireAuth, tab, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      const id = parseInt(String(req.params.id), 10);
      if (!org || !Number.isFinite(id)) return res.status(400).json({ message: "Bad request" });

      const [quote] = await db.select().from(printQuotes)
        .where(and(eq(printQuotes.id, id), eq(printQuotes.organizationId, org.id)));
      if (!quote) return res.status(404).json({ message: "Quote not found" });
      if (quote.status !== "new") {
        return res.status(409).json({ message: `This quote has already been ${quote.status}.` });
      }

      const action = req.body?.action;
      const userId = req.session.userId!;

      if (action === "reject") {
        const [updated] = await db.update(printQuotes).set({
          status: "rejected",
          rejectedReason: s(req.body?.reason, 500) || null,
          decidedAt: new Date(),
          reviewedBy: userId,
          updatedAt: new Date(),
        }).where(and(eq(printQuotes.id, id), eq(printQuotes.organizationId, org.id))).returning();
        return res.json(updated);
      }

      if (action === "approve") {
        const items = await db.select().from(printQuoteItems).where(eq(printQuoteItems.quoteId, id));

        // Reuse the SAME orderNumber + magicLinkToken scheme as the existing
        // public order-creation route (POST /api/print/orders in routes.ts) —
        // do not invent a scheme that could collide.
        const allOrders = await db.select({ id: printOrders.id }).from(printOrders)
          .where(eq(printOrders.organizationId, org.id));
        const year = new Date().getFullYear();
        const orderNumber = `UP-${year}-${String(allOrders.length + 1).padStart(4, "0")}`;
        const magicLinkToken = crypto.randomBytes(24).toString("hex");

        const title = items[0]?.designName || `Website quote — ${quote.customerName || "customer"}`;

        try {
          const result = await db.transaction(async (tx) => {
            const [order] = await tx.insert(printOrders).values({
              organizationId: org.id,
              orderNumber,
              customerName: quote.customerName || "Website quote",
              customerEmail: quote.customerEmail,
              customerPhone: quote.customerPhone,
              title,
              description: null,
              status: "confirmed",
              amount: String((quote.totalCents / 100).toFixed(2)),
              subtotalCents: quote.subtotalCents,
              gstCents: quote.gstCents,
              totalCents: quote.totalCents,
              paidCents: 0,
              deliveryMethod: "pickup",
              magicLinkToken,
              customerNotes: quote.note,
              notes: `Approved from website quote #${quote.id}`,
              createdBy: userId,
            } as any).returning();

            if (items.length) {
              await tx.insert(printOrderItems).values(items.map((it) => ({
                orderId: order.id,
                materialId: null,
                materialName: it.material || it.designName || "Website quote item",
                description: it.designName,
                widthMm: null,
                heightMm: null,
                quantity: it.quantity,
                sides: 1,
                configJson: { sizeLabel: it.sizeLabel, areaM2: it.areaM2, designFileName: it.designFileName },
                unitPriceCents: it.quantity > 0 ? Math.round(it.lineExGstCents / it.quantity) : it.lineExGstCents,
                qtyDiscountCents: 0,
                addonsTotalCents: 0,
                subtotalCents: it.lineExGstCents,
                estimatedCostCents: 0,
                breakdownJson: [],
              } as any)));
            }

            await tx.insert(printOrderEvents).values({
              orderId: order.id,
              eventType: "created",
              notes: `Created from approved website quote #${quote.id}`,
              metadataJson: { quoteId: quote.id, source: quote.source, sourceUrl: quote.sourceUrl },
              createdBy: userId,
            } as any);

            const [updatedQuote] = await tx.update(printQuotes).set({
              status: "approved",
              promotedOrderId: order.id,
              decidedAt: new Date(),
              reviewedBy: userId,
              updatedAt: new Date(),
            }).where(eq(printQuotes.id, id)).returning();

            return { order, updatedQuote };
          });

          return res.json({ ...result.updatedQuote, orderId: result.order.id, orderNumber: result.order.orderNumber });
        } catch (txErr: any) {
          console.error("[print-quotes] approve materialisation failed:", txErr);
          return res.status(500).json({ message: "Couldn't move this quote to an order. Nothing was changed." });
        }
      }

      return res.status(400).json({ message: 'action must be "approve" or "reject"' });
    } catch (e: any) {
      console.error("[print-quotes] admin patch failed:", e);
      res.status(500).json({ message: e.message });
    }
  });
}
