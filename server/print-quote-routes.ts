// ─────────────────────────────────────────────────────────────────────────────
// PRINT QUOTES — indicative quotes from the unitedprints.co.nz "Instant Quote"
// page, awaiting the Print manager's Approve/Reject before they enter the
// existing Orders/production pipeline.
//
// Public (cookie-less, CORS-allow-listed to the United Prints site):
//   GET  /api/public/unitedprints/quote-materials  — the products on the form
//   POST /api/public/unitedprints/quote-price      — price a configuration
//   POST /api/public/unitedprints/quote-request
//
// Those first two are what make the website's Instant Quote read its prices
// from the Materials tab instead of a hardcoded table in its own source. The
// price is computed HERE, by the same quotePrintItem() engine the admin order
// screen uses — the browser never holds a rate card, so Dima changing a price
// in ClubOS changes the public quote on the next keystroke, with no deploy.
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
import { currentPrintCustomer } from "./print-account-routes";
import { accountDiscountPct } from "@shared/print-account";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "./db";
import { requireAuth, requireTab } from "./auth";
import {
  organizations,
  printQuotes,
  printQuoteItems,
  printMaterials,
  printOrders,
  printOrderItems,
  printOrderEvents,
  type PrintMaterial,
} from "@shared/schema";
import { quotePrintItem, quoteOrderTotals } from "./print-pricing";
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

// ── Rate limit ───────────────────────────────────────────────────────────────
// The pricing endpoint is public and hits the database, and the quote form
// calls it as the customer types. Coarse per-IP ceiling, generous enough that
// a real person filling in four items never notices.
//
// In-memory, so on prod's two Fly machines the effective ceiling is 2× this.
// That is fine for what it defends against (a scripted hammer, not a precise
// quota) and is the deliberate trade — per staff-chat, in-process state must
// never be load-bearing across machines.
const priceHits = new Map<string, { count: number; resetAt: number }>();
const PRICE_WINDOW_MS = 60_000;
const PRICE_MAX_PER_WINDOW = 120;

function priceRateLimited(req: Request): boolean {
  const ip = String(req.headers["x-forwarded-for"] || req.ip || "unknown").split(",")[0].trim();
  const now = Date.now();
  const hit = priceHits.get(ip);
  if (!hit || now > hit.resetAt) {
    priceHits.set(ip, { count: 1, resetAt: now + PRICE_WINDOW_MS });
    if (priceHits.size > 5000) {
      priceHits.forEach((v, k) => { if (now > v.resetAt) priceHits.delete(k); });
    }
    return false;
  }
  hit.count += 1;
  return hit.count > PRICE_MAX_PER_WINDOW;
}

// ── The public view of a material ────────────────────────────────────────────
// 🔴 Fields are listed explicitly and never spread from the row. The catalog
// carries substrate_cost_per_m2_cents and markup_multiplier — the club's cost
// price and its margin on every product. Those must never reach a browser;
// baseRateCents is the RETAIL rate and is already on the website by design.
function publicMaterialView(m: PrintMaterial) {
  const stockSizes = Array.isArray(m.sizeTiersJson) ? (m.sizeTiersJson as any[]) : [];
  return {
    slug: m.slug,
    name: m.name,
    description: m.description,
    category: m.category,
    pricingMethod: m.pricingMethod,
    baseRateCents: m.baseRateCents,
    minChargeCents: m.minChargeCents,
    sizeMinWMm: m.sizeMinWMm,
    sizeMaxWMm: m.sizeMaxWMm,
    sizeMinHMm: m.sizeMinHMm,
    sizeMaxHMm: m.sizeMaxHMm,
    // The printer's roll width, so the form can say "one side up to 1.6m"
    // before the customer types. The server still enforces it — this is a
    // courtesy, never the gate.
    maxRollWidthMm: m.maxRollWidthMm,
    turnaroundDays: m.turnaroundDays,
    humanQuoteRequired: m.humanQuoteRequired,
    stockSizes: stockSizes.map((t) => ({
      id: String(t?.id ?? ""),
      label: String(t?.label ?? ""),
      widthMm: Number(t?.w) || null,
      heightMm: Number(t?.h) || null,
      priceCents: Number(t?.priceCents) || 0,
    })).filter((t) => t.id && t.label),
  };
}

// The products the website's Instant Quote may offer: active AND explicitly
// flipped on for the website. Order is Dima's displayOrder.
async function websiteQuoteMaterials(orgId: number): Promise<PrintMaterial[]> {
  return db.select().from(printMaterials)
    .where(and(
      eq(printMaterials.organizationId, orgId),
      eq(printMaterials.isActive, true),
      eq(printMaterials.quoteOnWebsite, true),
    ))
    .orderBy(asc(printMaterials.displayOrder), asc(printMaterials.id));
}

// ── Pricing a submitted configuration ───────────────────────────────────────
// One place, used by BOTH the live-price endpoint and the quote submission, so
// the number a customer watched on screen is the number that lands in ClubOS.
interface PricedLine {
  index: number;
  ok: boolean;
  materialSlug: string;
  materialName: string;
  designName: string | null;
  designFileName: string | null;
  widthMm: number | null;
  heightMm: number | null;
  quantity: number;
  areaM2: number | null;
  sizeLabel: string | null;
  lineExGstCents: number;
  breakdown: { label: string; cents: number }[];
  message: string | null;
  turnaroundDays: number | null;
}

const num = (v: any): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * If a typed size IS one of the shop's stock sizes, quote the stock price.
 *
 * 🔴 Without this the website quotes the per-m² fallback on tiered products,
 * and for corflute the two disagree badly: a 1200 × 1800 sign is $115 on the
 * shop's own price list and $183.60 per m² — a 60% overcharge on the most
 * common large real-estate size, which would simply lose the job. Someone
 * ringing up gets $115, so the form has to as well.
 *
 * Orientation-insensitive (a 900 × 600 sign is the same sheet as 600 × 900)
 * with a 5mm tolerance, because a customer typing a nominal size shouldn't
 * miss the price list by a rounding error.
 */
const STOCK_SIZE_TOLERANCE_MM = 5;

function matchStockTier(material: PrintMaterial, widthMm: number | null, heightMm: number | null): string | undefined {
  if (!widthMm || !heightMm) return undefined;
  const tiers = Array.isArray(material.sizeTiersJson) ? (material.sizeTiersJson as any[]) : [];
  const want = [Math.min(widthMm, heightMm), Math.max(widthMm, heightMm)];
  for (const t of tiers) {
    const tw = Number(t?.w), th = Number(t?.h);
    if (!Number.isFinite(tw) || !Number.isFinite(th)) continue;
    const have = [Math.min(tw, th), Math.max(tw, th)];
    if (Math.abs(have[0] - want[0]) <= STOCK_SIZE_TOLERANCE_MM && Math.abs(have[1] - want[1]) <= STOCK_SIZE_TOLERANCE_MM) {
      return String(t.id);
    }
  }
  return undefined;
}

/**
 * Prices each requested line against the live catalog.
 *
 * 🔴 A line whose material is not on the website, or which the engine declines
 * to price, comes back ok:false with the engine's own message and a ZERO
 * amount — never a guessed one. An unpriceable item must reach Dima as "needs
 * a human quote", because a made-up number here becomes a real print_orders
 * row the moment he presses Approve.
 */
async function priceQuoteLines(
  orgId: number,
  rawItems: any[],
  /**
   * The signed-in customer's account discount, resolved SERVER-SIDE from their
   * session row. Never from the request body — see ItemConfig.accountDiscountPct.
   * An anonymous visitor is 0, which is also the default for every account
   * until Dima sets a real number.
   */
  accountDiscountPct = 0,
): Promise<{ lines: PricedLine[]; subtotalCents: number; gstCents: number; totalCents: number; needsHumanQuote: boolean }> {
  const available = await websiteQuoteMaterials(orgId);
  const bySlug = new Map(available.map((m) => [m.slug, m]));

  const lines: PricedLine[] = rawItems.slice(0, 50).map((it: any, index: number) => {
    const materialSlug = s(it?.materialSlug, 120);
    const widthMm = num(it?.widthMm);
    const heightMm = num(it?.heightMm);
    const qtyRaw = Number(it?.quantity);
    const quantity = Number.isFinite(qtyRaw) && qtyRaw > 0 ? Math.min(Math.round(qtyRaw), 10_000) : 1;
    const designName = s(it?.design, 200) || null;
    const designFileName = s(it?.design_file, 300) || null;

    const material = bySlug.get(materialSlug);
    const base = {
      index, materialSlug, designName, designFileName, widthMm, heightMm, quantity,
      breakdown: [] as { label: string; cents: number }[],
      turnaroundDays: null as number | null,
    };

    if (!material) {
      return {
        ...base, ok: false,
        materialName: materialSlug || "Unknown product",
        areaM2: null, sizeLabel: null, lineExGstCents: 0,
        message: "That product isn't available to quote online right now — send it through and we'll price it by hand.",
      };
    }

    const sizeLabel = widthMm && heightMm ? `${widthMm} × ${heightMm} mm` : null;
    const areaM2 = widthMm && heightMm ? (widthMm * heightMm) / 1_000_000 : null;

    const tierId = matchStockTier(material, widthMm, heightMm);
    const outcome = quotePrintItem(material, {
      widthMm: widthMm ?? undefined,
      heightMm: heightMm ?? undefined,
      quantity,
      sides: 1,
      accountDiscountPct,
      ...(tierId ? { extra: { tierId } } : {}),
    });

    if (!outcome.ok) {
      return {
        ...base, ok: false, materialName: material.name, areaM2, sizeLabel,
        lineExGstCents: 0, message: outcome.message,
      };
    }

    return {
      ...base, ok: true, materialName: material.name, areaM2, sizeLabel,
      lineExGstCents: outcome.subtotalCents,
      breakdown: outcome.breakdown,
      message: null,
      turnaroundDays: outcome.turnaroundDays,
    };
  });

  // Totals cover only the lines that actually priced — GST on a $0 placeholder
  // would understate nothing, but summing a declined line as 0 alongside a
  // real one is exactly right: the customer sees a total for what we can
  // price, and a plain note on what we cannot.
  const totals = quoteOrderTotals(lines.filter((l) => l.ok).map((l) => l.lineExGstCents));
  return { lines, ...totals, needsHumanQuote: lines.some((l) => !l.ok) };
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

  // The products the Instant Quote form offers, straight from the Materials
  // tab. Dima adds a product or flips "show on website" and it appears here —
  // the website holds no list of its own.
  app.options("/api/public/unitedprints/quote-materials", (req, res) => { quoteCors(req, res); res.sendStatus(204); });
  app.get("/api/public/unitedprints/quote-materials", async (req: Request, res: Response) => {
    quoteCors(req, res);
    try {
      const materials = await websiteQuoteMaterials(UNITED_PRINTS_ORG_ID);
      // A short cache: Dima's edit should show up quickly, but the form asks
      // for this on every page load.
      res.set("Cache-Control", "public, max-age=60");
      res.json({
        materials: materials.map(publicMaterialView),
        gstRate: 0.15,
        currency: "NZD",
      });
    } catch (e: any) {
      console.error("[print-quotes] public materials failed:", e);
      res.status(500).json({ message: "Couldn't load products." });
    }
  });

  // Live pricing as the customer types. The engine runs here, never in the
  // browser — so there is no rate card to go stale and nothing to tamper with.
  app.options("/api/public/unitedprints/quote-price", (req, res) => { quoteCors(req, res); res.sendStatus(204); });
  app.post("/api/public/unitedprints/quote-price", async (req: Request, res: Response) => {
    quoteCors(req, res);
    try {
      if (priceRateLimited(req)) {
        return res.status(429).json({ message: "Too many price checks — give it a moment." });
      }
      const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
      if (!rawItems.length) return res.status(400).json({ message: "At least one item is required." });

      // 🔴 The discount comes from the SESSION, never the body.
      //
      // A note on where this does and does not take effect, because it is
      // load-bearing rather than an oversight: the cookie is `__Host-` scoped
      // to join.unitedprints.co.nz, so a call from the marketing site (a
      // different origin, sent without credentials by design) resolves to no
      // customer and prices at list. The SAME endpoint, called from the signed-in
      // portal on the same origin, carries the cookie and prices at their rate.
      //
      // That is deliberate. Making the marketing site's quote account-aware
      // would mean credentialed CORS on an allowlist that currently reflects any
      // *.vercel.app origin — which would let any Vercel page price, and act, as
      // a signed-in customer. The portal is where a customer sees their price.
      const customer = await currentPrintCustomer(req);
      const priced = await priceQuoteLines(
        UNITED_PRINTS_ORG_ID,
        rawItems,
        accountDiscountPct(customer),
      );
      res.json({
        accountPricing: customer
          ? { applied: accountDiscountPct(customer) > 0, discountPct: accountDiscountPct(customer), tier: customer.tier }
          : null,
        lines: priced.lines.map((l) => ({
          index: l.index,
          ok: l.ok,
          materialName: l.materialName,
          sizeLabel: l.sizeLabel,
          areaM2: l.areaM2,
          quantity: l.quantity,
          lineExGstCents: l.lineExGstCents,
          breakdown: l.breakdown,
          message: l.message,
          turnaroundDays: l.turnaroundDays,
        })),
        subtotalCents: priced.subtotalCents,
        gstCents: priced.gstCents,
        totalCents: priced.totalCents,
        needsHumanQuote: priced.needsHumanQuote,
      });
    } catch (e: any) {
      console.error("[print-quotes] public price failed:", e);
      res.status(500).json({ message: "Couldn't price that just now." });
    }
  });

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

      // 🔴 Re-price on the server whenever the site tells us WHICH product it
      // picked. The browser's arithmetic is a display convenience; approving a
      // quote mints a real print_orders row at this amount, so the figure that
      // gets stored has to be one we computed from the live catalog. A stale
      // tab left open across a price change — or a hand-made POST — must not
      // be able to book a $1 banner.
      //
      // Items without a materialSlug are the OLD website payload (a label and
      // a number it worked out itself). That path is kept so ClubOS can deploy
      // before the site does without 400-ing every live submission in the gap
      // — the lesson from shipping the CUGC date-of-birth gate first.
      const usesCatalog = rawItems.some((it: any) => s(it?.materialSlug, 120));

      let subtotalCents: number;
      let gstCents: number;
      let totalCents: number;
      let itemRows: Array<Omit<typeof printQuoteItems.$inferInsert, "quoteId">>;
      let unpriceable: string[] = [];

      if (usesCatalog) {
        const priced = await priceQuoteLines(UNITED_PRINTS_ORG_ID, rawItems);
        subtotalCents = priced.subtotalCents;
        gstCents = priced.gstCents;
        totalCents = priced.totalCents;
        unpriceable = priced.lines.filter((l) => !l.ok).map((l) => `${l.materialName}: ${l.message}`);
        itemRows = priced.lines.map((l) => ({
          designName: l.designName,
          material: l.materialName,
          sizeLabel: l.sizeLabel,
          areaM2: l.areaM2 != null ? String(l.areaM2.toFixed(4)) : null,
          quantity: l.quantity,
          lineExGstCents: l.lineExGstCents,
          designFileName: l.designFileName,
        }));
      } else {
        subtotalCents = toCents(body.subtotalExGst);
        gstCents = toCents(body.gst);
        totalCents = toCents(body.totalIncGst);
        itemRows = rawItems.slice(0, 50).map((it: any) => ({
          designName: s(it.design, 200) || null,
          material: s(it.material, 120) || null,
          sizeLabel: s(it.size, 120) || null,
          areaM2: Number.isFinite(Number(it.areaM2)) ? String(it.areaM2) : null,
          quantity: Number.isFinite(Number(it.quantity)) && Number(it.quantity) > 0 ? Math.round(Number(it.quantity)) : 1,
          lineExGstCents: toCents(it.lineExGst),
          designFileName: s(it.design_file, 300) || null,
        }));
      }

      // Anything the engine declined is spelled out in the note, so Dima sees
      // "needs a hand-quote" rather than a suspiciously round total.
      const customerNote = s(body.note, 2000);
      const note = [customerNote, unpriceable.length ? `⚠ Needs a manual price — ${unpriceable.join(" · ")}` : ""]
        .filter(Boolean).join("\n\n") || null;

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
        note,
      }).returning();

      const items = itemRows.map((row) => ({ ...row, quoteId: quote.id }));
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

      // Echo the SERVER's totals back. If a stale tab submitted an old price,
      // the confirmation the customer reads is the real one, not the one their
      // screen happened to be showing.
      res.json({
        ok: true,
        id: quote.id,
        subtotalCents,
        gstCents,
        totalCents,
        needsHumanQuote: unpriceable.length > 0,
      });
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
