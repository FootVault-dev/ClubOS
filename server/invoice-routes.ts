// ─────────────────────────────────────────────────────────────────────────────
// USG Invoices — tracked, payable invoices owned by the United Sports Group
// workspace (organization_id 7), super-admin only.
//
// The public payable page lives in a SEPARATE Vercel app (apps/invoices,
// usg-invoices.vercel.app/i/:token) and calls the /api/public/invoices/:token*
// routes below. ClubOS is the system of record; that page is only the face
// of one — see the migration header (migrations/2026-07-10_usg_invoices.sql)
// and shared/invoice-types.ts for the full wire-contract rationale.
//
// Admin (session + the "invoices" tab, which is super-admin only per
// shared/tabs.ts SUPER_ADMIN_ONLY_TABS — invoices carry bank details):
//   GET    /api/admin/invoices
//   GET    /api/admin/invoices/:id
//   POST   /api/admin/invoices
//   PATCH  /api/admin/invoices/:id
//   POST   /api/admin/invoices/:id/send
//   POST   /api/admin/invoices/:id/reminder
//   POST   /api/admin/invoices/:id/mark-paid
//   POST   /api/admin/invoices/:id/void
//
// Public (no auth, CORS-allow-listed to usg-invoices.vercel.app):
//   GET    /api/public/invoices/:token
//   POST   /api/public/invoices/:token/opened
//   POST   /api/public/invoices/:token/pay-intent
//
// Also exports markInvoicePaidByPaymentIntent, called from the main Stripe
// webhook in server/routes.ts on payment_intent.succeeded when
// metadata.kind === "invoice" — mirroring the existing kind === "membership"
// branch. NEVER set metadata.printOrderId on an invoice PaymentIntent — that
// is the sole trigger for pushPaidOrderToXero() and must never fire here.
// ─────────────────────────────────────────────────────────────────────────────
import crypto from "crypto";
import type { Express, Request, Response } from "express";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import { db } from "./db";
import { requireAuth, requireTab } from "./auth";
import { clientIp } from "./api-security";
import { sendEmail } from "./email";
import { fromForOrg } from "@shared/org-domains";
import { nzTodayIso } from "@shared/academy";
import { stripe } from "./stripe";
import { organizations, usgInvoices, usgInvoiceEvents, type UsgInvoice } from "@shared/schema";
import {
  cardBreakdown,
  exclusiveOfInclusive,
  gstContentOfInclusive,
  gstOnExclusive,
  formatNZD,
} from "@shared/invoice-money";
import {
  SUPPLIER_BY_BRAND,
  DEFAULT_SURCHARGE_NOTE,
  INVOICE_STATUSES,
  INVOICE_BRANDS,
  GST_TREATMENTS,
  isInvoiceBrand,
  isInvoiceStatus,
  isGstTreatment,
  deriveInvoiceStatus,
  invoiceUrl,
  type PublicInvoice,
  type InvoiceLine,
  type InvoiceSpendRow,
  type InvoiceSpendSummary,
  type InvoiceBrand,
  type GstTreatment,
} from "@shared/invoice-types";

// invoiceUrl() is brand-aware and lives in shared/invoice-types.ts — an SIU
// invoice links to pay.southislandunited.com, a CUFC one falls back until its
// domain is attached.

// ── CORS (mirrors setMflCors / setCic7sCors in server/routes.ts) ────────────
// The real brand domains, plus this app's own preview deploys. The old
// /\.vercel\.app$/ catch-all let ANY Vercel-hosted site call these endpoints;
// narrowed to our project's own preview URLs. (CORS is not the security boundary
// here — the unguessable token is — but there is no reason to be loose.)
const INVOICE_SITE_ORIGINS = [
  "https://invoice.southislandunited.com", // canonical
  "https://pay.southislandunited.com",     // legacy alias, 307s to the above
  "https://usg-invoices.vercel.app",
];
const INVOICE_PREVIEW_ORIGIN = /^https:\/\/usg-invoices-[a-z0-9-]+\.vercel\.app$/;

function setInvoiceCors(req: Request, res: Response) {
  const origin = (req.headers.origin as string) || "";
  if (INVOICE_SITE_ORIGINS.includes(origin) || INVOICE_PREVIEW_ORIGIN.test(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
  }
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
}

// ── Small sanitisers — never trust the client for anything money-shaped ─────
const str = (v: unknown, max = 500): string => String(v ?? "").trim().slice(0, max);
const strOrNull = (v: unknown, max = 500): string | null => str(v, max) || null;

function sanitizeStringArray(v: unknown, max = 30, maxLen = 300): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => str(x, maxLen)).filter(Boolean).slice(0, max);
}

function sanitizeLines(v: unknown): InvoiceLine[] {
  if (!Array.isArray(v)) return [];
  const out: InvoiceLine[] = [];
  for (const raw of v.slice(0, 100)) {
    const description = str((raw as any)?.description, 300);
    const amountCents = Math.round(Number((raw as any)?.amountCents));
    if (!description || !Number.isFinite(amountCents)) continue;
    const detail = str((raw as any)?.detail, 500);
    out.push({ description, amountCents, ...(detail ? { detail } : {}) });
  }
  return out;
}

function sanitizeSpendSummary(v: unknown): InvoiceSpendSummary | null {
  if (!v || typeof v !== "object") return null;
  const label = str((v as any).label, 200);
  const totalLabel = str((v as any).totalLabel, 200);
  const rowsRaw = (v as any).rows;
  if (!label || !totalLabel || !Array.isArray(rowsRaw)) return null;
  const rows: InvoiceSpendRow[] = [];
  for (const r of rowsRaw.slice(0, 50)) {
    const rl = str((r as any)?.label, 200);
    const amt = Math.round(Number((r as any)?.amountCents));
    if (!rl || !Number.isFinite(amt)) continue;
    rows.push({ label: rl, amountCents: amt });
  }
  if (rows.length === 0) return null;
  return { label, totalLabel, rows };
}

/** Server-computed from lines + gstTreatment. NEVER trust totals from the client. */
function computeTotals(lines: InvoiceLine[], gstTreatment: GstTreatment) {
  const lineTotal = lines.reduce((sum, l) => sum + (Number.isFinite(l.amountCents) ? l.amountCents : 0), 0);
  if (gstTreatment === "exclusive") {
    const subtotalCents = lineTotal;
    const gstCents = gstOnExclusive(subtotalCents);
    return { subtotalCents, gstCents, totalCents: subtotalCents + gstCents };
  }
  // inclusive (default)
  const subtotalCents = exclusiveOfInclusive(lineTotal);
  const gstCents = gstContentOfInclusive(lineTotal);
  return { subtotalCents, gstCents, totalCents: lineTotal };
}

function genInvoiceToken(): string {
  // >=20 chars, unguessable — an invoice carries bank details.
  return crypto.randomBytes(16).toString("hex"); // 32 hex chars
}

// ── Wire shape for GET /api/public/invoices/:token ──────────────────────────
// Hand-shaped, never `res.json(row)` — id, organizationId and
// stripePaymentIntentId must never leave the admin surface.
function buildPublicInvoice(inv: UsgInvoice): PublicInvoice {
  const brand: InvoiceBrand = isInvoiceBrand(inv.brand) ? inv.brand : "siu";
  const status = isInvoiceStatus(inv.status) ? inv.status : "draft";
  const gstTreatment: GstTreatment = isGstTreatment(inv.gstTreatment) ? inv.gstTreatment : "inclusive";
  const notes = Array.isArray(inv.notes) ? (inv.notes as string[]) : [];
  return {
    token: inv.token,
    number: inv.number,
    status,
    isDraft: inv.isDraft,
    draftReasons: Array.isArray(inv.draftReasons) ? (inv.draftReasons as string[]) : [],
    brand,
    issuedOn: inv.issuedOn,
    dueOn: inv.dueOn,
    termsLabel: inv.termsLabel ?? "",
    supplier: SUPPLIER_BY_BRAND[brand],
    recipient: {
      legalName: inv.recipientName,
      addressLines: Array.isArray(inv.recipientAddress) ? (inv.recipientAddress as string[]) : [],
    },
    recipientContactEmail: inv.recipientEmail ?? undefined,
    title: inv.title,
    intro: inv.intro ?? undefined,
    spendSummary: (inv.spendSummary as InvoiceSpendSummary | null) ?? undefined,
    lines: Array.isArray(inv.lines) ? (inv.lines as InvoiceLine[]) : [],
    gstTreatment,
    bank: {
      accountName: inv.bankAccountName ?? "",
      accountNumber: inv.bankAccountNumber ?? "",
      reference: inv.bankReference ?? "",
      particulars: inv.bankParticulars ?? undefined,
      code: inv.bankCode ?? undefined,
    },
    cardEnabled: inv.cardEnabled,
    surchargeNote: DEFAULT_SURCHARGE_NOTE,
    notes: notes.length ? notes : undefined,
  };
}

// ── Email (a single simple template, reused for send + reminder) ───────────
function invoiceEmailHtml(params: { heading: string; body: string; number: string; amountLabel: string; url: string }): string {
  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#0b0b09;padding:36px 16px;">
    <div style="max-width:560px;margin:0 auto;">
      <div style="text-align:center;padding:4px 0 22px;">
        <p style="color:#c59949;margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">Invoice ${params.number}</p>
        <h1 style="color:#ffffff;margin:0;font-size:22px;font-weight:800;letter-spacing:-0.2px;">${params.heading}</h1>
      </div>
      <div style="background:#141410;border:1px solid #2c2c26;border-radius:18px;padding:24px;">
        <p style="color:#d8d5c9;font-size:14px;line-height:1.6;margin:0 0 18px;">${params.body}</p>
        <p style="color:#f4f1ea;font-size:28px;font-weight:700;margin:0 0 18px;">${params.amountLabel}</p>
        <a href="${params.url}" style="display:inline-block;background:#c59949;color:#0b0b09;font-weight:700;font-size:14px;padding:12px 22px;border-radius:10px;text-decoration:none;">View &amp; pay invoice</a>
      </div>
      <p style="text-align:center;color:#5a5a52;font-size:11px;line-height:1.7;margin:20px 0 0;">United Sports Group</p>
    </div>
  </div>`;
}

// ── Org scoping (mirrors workspaceOrg in routes.ts, which isn't exported) ───
async function workspaceOrg(req: Request): Promise<{ id: number; slug: string } | null> {
  const slug = String(req.headers["x-workspace-slug"] || "").trim();
  if (!slug) return null;
  const [org] = await db.select().from(organizations).where(eq(organizations.slug, slug));
  return org ? { id: org.id, slug: org.slug } : null;
}

type EventSummary = { openCount: number; firstOpenedAt: Date | null; lastOpenedAt: Date | null; reminderCount: number };

function summarizeEvents(events: { invoiceId: number; kind: string; isStaff: boolean; at: Date }[]): Map<number, EventSummary> {
  const byInvoice = new Map<number, EventSummary>();
  for (const e of events) {
    const cur = byInvoice.get(e.invoiceId) ?? { openCount: 0, firstOpenedAt: null, lastOpenedAt: null, reminderCount: 0 };
    if (e.kind === "opened" && !e.isStaff) {
      cur.openCount += 1;
      if (!cur.firstOpenedAt || e.at < cur.firstOpenedAt) cur.firstOpenedAt = e.at;
      if (!cur.lastOpenedAt || e.at > cur.lastOpenedAt) cur.lastOpenedAt = e.at;
    }
    if (e.kind === "reminder_sent") cur.reminderCount += 1;
    byInvoice.set(e.invoiceId, cur);
  }
  return byInvoice;
}

export function registerInvoiceRoutes(app: Express) {
  const tab = requireTab("invoices");

  // ═══════════════════════════ ADMIN ═══════════════════════════════════════

  app.get("/api/admin/invoices", requireAuth, tab, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "X-Workspace-Slug header required" });

      const invoices = await db.select().from(usgInvoices)
        .where(eq(usgInvoices.organizationId, org.id))
        .orderBy(desc(usgInvoices.createdAt));

      const ids = invoices.map((i) => i.id);
      const events = ids.length
        ? await db.select({
            invoiceId: usgInvoiceEvents.invoiceId,
            kind: usgInvoiceEvents.kind,
            isStaff: usgInvoiceEvents.isStaff,
            at: usgInvoiceEvents.at,
          }).from(usgInvoiceEvents).where(inArray(usgInvoiceEvents.invoiceId, ids))
        : [];
      const summaries = summarizeEvents(events);
      const today = nzTodayIso();

      res.json({
        invoices: invoices.map((inv) => {
          const summary = summaries.get(inv.id) ?? { openCount: 0, firstOpenedAt: null, lastOpenedAt: null, reminderCount: 0 };
          return {
            ...inv,
            derivedStatus: deriveInvoiceStatus(isInvoiceStatus(inv.status) ? inv.status : "draft", inv.dueOn, today),
            openCount: summary.openCount,
            firstOpenedAt: summary.firstOpenedAt,
            lastOpenedAt: summary.lastOpenedAt,
            reminderCount: summary.reminderCount,
          };
        }),
      });
    } catch (e: any) {
      console.error("[invoices] admin list failed:", e);
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/admin/invoices/:id", requireAuth, tab, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "X-Workspace-Slug header required" });
      const id = parseInt(String(req.params.id), 10);
      if (!Number.isFinite(id)) return res.status(400).json({ message: "Bad id" });

      const [inv] = await db.select().from(usgInvoices)
        .where(and(eq(usgInvoices.id, id), eq(usgInvoices.organizationId, org.id)));
      if (!inv) return res.status(404).json({ message: "Invoice not found" });

      const timeline = await db.select().from(usgInvoiceEvents)
        .where(eq(usgInvoiceEvents.invoiceId, id))
        .orderBy(asc(usgInvoiceEvents.at));

      res.json({
        invoice: { ...inv, derivedStatus: deriveInvoiceStatus(isInvoiceStatus(inv.status) ? inv.status : "draft", inv.dueOn, nzTodayIso()) },
        timeline,
      });
    } catch (e: any) {
      console.error("[invoices] admin detail failed:", e);
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/admin/invoices", requireAuth, tab, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "X-Workspace-Slug header required" });

      const number = str(req.body?.number, 60);
      const recipientName = str(req.body?.recipientName, 200);
      const title = str(req.body?.title, 200);
      const issuedOn = str(req.body?.issuedOn, 10);
      const dueOn = str(req.body?.dueOn, 10);
      if (!number) return res.status(400).json({ message: "An invoice number is required" });
      if (!recipientName) return res.status(400).json({ message: "A recipient name is required" });
      if (!title) return res.status(400).json({ message: "A title is required" });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(issuedOn) || !/^\d{4}-\d{2}-\d{2}$/.test(dueOn)) {
        return res.status(400).json({ message: "issuedOn and dueOn must be YYYY-MM-DD" });
      }

      const brand: InvoiceBrand = isInvoiceBrand(req.body?.brand) ? req.body.brand : "siu";
      const gstTreatment: GstTreatment = isGstTreatment(req.body?.gstTreatment) ? req.body.gstTreatment : "inclusive";
      const lines = sanitizeLines(req.body?.lines);
      const totals = computeTotals(lines, gstTreatment);
      const status = isInvoiceStatus(req.body?.status) ? req.body.status : "draft";

      const [created] = await db.insert(usgInvoices).values({
        organizationId: org.id,
        token: genInvoiceToken(),
        number,
        status,
        brand,
        recipientName,
        recipientEmail: strOrNull(req.body?.recipientEmail, 200),
        recipientAddress: sanitizeStringArray(req.body?.recipientAddress, 10, 200),
        title,
        intro: strOrNull(req.body?.intro, 2000),
        spendSummary: sanitizeSpendSummary(req.body?.spendSummary),
        lines,
        notes: sanitizeStringArray(req.body?.notes, 20, 500),
        gstTreatment,
        subtotalCents: totals.subtotalCents,
        gstCents: totals.gstCents,
        totalCents: totals.totalCents,
        issuedOn,
        dueOn,
        termsLabel: strOrNull(req.body?.termsLabel, 300),
        cardEnabled: !!req.body?.cardEnabled,
        isDraft: req.body?.isDraft !== undefined ? !!req.body.isDraft : true,
        draftReasons: sanitizeStringArray(req.body?.draftReasons, 20, 500),
        bankAccountName: strOrNull(req.body?.bankAccountName, 200),
        bankAccountNumber: strOrNull(req.body?.bankAccountNumber, 60),
        bankReference: strOrNull(req.body?.bankReference, 60),
        bankParticulars: strOrNull(req.body?.bankParticulars, 60),
        bankCode: strOrNull(req.body?.bankCode, 60),
      }).returning();

      await db.insert(usgInvoiceEvents).values({ invoiceId: created.id, kind: "created", isStaff: true });
      res.status(201).json(created);
    } catch (e: any) {
      if (String(e?.code) === "23505") return res.status(409).json({ message: "An invoice with that number already exists." });
      console.error("[invoices] create failed:", e);
      res.status(500).json({ message: e.message });
    }
  });

  app.patch("/api/admin/invoices/:id", requireAuth, tab, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "X-Workspace-Slug header required" });
      const id = parseInt(String(req.params.id), 10);
      if (!Number.isFinite(id)) return res.status(400).json({ message: "Bad id" });

      const [existing] = await db.select().from(usgInvoices)
        .where(and(eq(usgInvoices.id, id), eq(usgInvoices.organizationId, org.id)));
      if (!existing) return res.status(404).json({ message: "Invoice not found" });

      const b = req.body ?? {};
      const patch: Record<string, any> = { updatedAt: new Date() };

      if (b.number !== undefined) { const v = str(b.number, 60); if (!v) return res.status(400).json({ message: "number can't be blank" }); patch.number = v; }
      if (b.recipientName !== undefined) { const v = str(b.recipientName, 200); if (!v) return res.status(400).json({ message: "recipientName can't be blank" }); patch.recipientName = v; }
      if (b.recipientEmail !== undefined) patch.recipientEmail = strOrNull(b.recipientEmail, 200);
      if (b.recipientAddress !== undefined) patch.recipientAddress = sanitizeStringArray(b.recipientAddress, 10, 200);
      if (b.title !== undefined) { const v = str(b.title, 200); if (!v) return res.status(400).json({ message: "title can't be blank" }); patch.title = v; }
      if (b.intro !== undefined) patch.intro = strOrNull(b.intro, 2000);
      if (b.spendSummary !== undefined) patch.spendSummary = sanitizeSpendSummary(b.spendSummary);
      if (b.notes !== undefined) patch.notes = sanitizeStringArray(b.notes, 20, 500);
      if (b.issuedOn !== undefined) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(str(b.issuedOn, 10))) return res.status(400).json({ message: "issuedOn must be YYYY-MM-DD" });
        patch.issuedOn = str(b.issuedOn, 10);
      }
      if (b.dueOn !== undefined) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(str(b.dueOn, 10))) return res.status(400).json({ message: "dueOn must be YYYY-MM-DD" });
        patch.dueOn = str(b.dueOn, 10);
      }
      if (b.termsLabel !== undefined) patch.termsLabel = strOrNull(b.termsLabel, 300);
      if (b.cardEnabled !== undefined) patch.cardEnabled = !!b.cardEnabled;
      if (b.isDraft !== undefined) patch.isDraft = !!b.isDraft;
      if (b.draftReasons !== undefined) patch.draftReasons = sanitizeStringArray(b.draftReasons, 20, 500);
      if (b.bankAccountName !== undefined) patch.bankAccountName = strOrNull(b.bankAccountName, 200);
      if (b.bankAccountNumber !== undefined) patch.bankAccountNumber = strOrNull(b.bankAccountNumber, 60);
      if (b.bankReference !== undefined) patch.bankReference = strOrNull(b.bankReference, 60);
      if (b.bankParticulars !== undefined) patch.bankParticulars = strOrNull(b.bankParticulars, 60);
      if (b.bankCode !== undefined) patch.bankCode = strOrNull(b.bankCode, 60);
      if (b.brand !== undefined) { if (!isInvoiceBrand(b.brand)) return res.status(400).json({ message: `brand must be one of ${INVOICE_BRANDS.join(", ")}` }); patch.brand = b.brand; }

      // Manual status corrections — 'paid' must go through mark-paid (or the
      // Stripe webhook) so paidAt/paidMethod/paidAmountCents stay consistent.
      if (b.status !== undefined) {
        if (!isInvoiceStatus(b.status)) return res.status(400).json({ message: `status must be one of ${INVOICE_STATUSES.join(", ")}` });
        if (b.status === "paid") return res.status(400).json({ message: "Use mark-paid to record a payment." });
        patch.status = b.status;
      }

      // Recompute totals server-side whenever lines or gstTreatment change —
      // NEVER trust totals from the client.
      let nextGstTreatment: GstTreatment = isGstTreatment(existing.gstTreatment) ? existing.gstTreatment : "inclusive";
      if (b.gstTreatment !== undefined) {
        if (!isGstTreatment(b.gstTreatment)) return res.status(400).json({ message: `gstTreatment must be one of ${GST_TREATMENTS.join(", ")}` });
        nextGstTreatment = b.gstTreatment;
        patch.gstTreatment = nextGstTreatment;
      }
      let nextLines: InvoiceLine[] = Array.isArray(existing.lines) ? (existing.lines as InvoiceLine[]) : [];
      if (b.lines !== undefined) {
        nextLines = sanitizeLines(b.lines);
        patch.lines = nextLines;
      }
      if (b.lines !== undefined || b.gstTreatment !== undefined) {
        const totals = computeTotals(nextLines, nextGstTreatment);
        patch.subtotalCents = totals.subtotalCents;
        patch.gstCents = totals.gstCents;
        patch.totalCents = totals.totalCents;
      }

      const [updated] = await db.update(usgInvoices).set(patch)
        .where(and(eq(usgInvoices.id, id), eq(usgInvoices.organizationId, org.id)))
        .returning();
      res.json(updated);
    } catch (e: any) {
      if (String(e?.code) === "23505") return res.status(409).json({ message: "An invoice with that number already exists." });
      console.error("[invoices] update failed:", e);
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/admin/invoices/:id/send", requireAuth, tab, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "X-Workspace-Slug header required" });
      const id = parseInt(String(req.params.id), 10);
      if (!Number.isFinite(id)) return res.status(400).json({ message: "Bad id" });

      const [inv] = await db.select().from(usgInvoices)
        .where(and(eq(usgInvoices.id, id), eq(usgInvoices.organizationId, org.id)));
      if (!inv) return res.status(404).json({ message: "Invoice not found" });
      if (inv.status === "void") return res.status(400).json({ message: "This invoice has been voided." });
      if (!inv.recipientEmail) return res.status(400).json({ message: "Add a recipient email before sending." });

      await db.update(usgInvoices).set({ status: "sent", updatedAt: new Date() })
        .where(eq(usgInvoices.id, id));
      await db.insert(usgInvoiceEvents).values({ invoiceId: id, kind: "sent", isStaff: true });

      try {
        await sendEmail({
          to: inv.recipientEmail,
          from: fromForOrg(org.id, "United Sports Group"),
          subject: `Invoice ${inv.number} from United Sports Group`,
          html: invoiceEmailHtml({
            heading: "You've received an invoice",
            body: `${inv.title} — please find the details below. You can view, download and pay it online.`,
            number: inv.number,
            amountLabel: formatNZD(inv.totalCents),
            url: invoiceUrl(isInvoiceBrand(inv.brand) ? inv.brand : "siu", inv.token),
          }),
        });
      } catch (e) {
        console.error("[invoices] send email failed:", e);
      }

      res.json({ ok: true });
    } catch (e: any) {
      console.error("[invoices] send failed:", e);
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/admin/invoices/:id/reminder", requireAuth, tab, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "X-Workspace-Slug header required" });
      const id = parseInt(String(req.params.id), 10);
      if (!Number.isFinite(id)) return res.status(400).json({ message: "Bad id" });

      const [inv] = await db.select().from(usgInvoices)
        .where(and(eq(usgInvoices.id, id), eq(usgInvoices.organizationId, org.id)));
      if (!inv) return res.status(404).json({ message: "Invoice not found" });
      if (inv.status === "paid" || inv.status === "void") {
        return res.status(400).json({ message: `Can't send a reminder — this invoice is ${inv.status}.` });
      }
      if (!inv.recipientEmail) return res.status(400).json({ message: "Add a recipient email before sending a reminder." });

      await db.insert(usgInvoiceEvents).values({ invoiceId: id, kind: "reminder_sent", isStaff: true });

      try {
        await sendEmail({
          to: inv.recipientEmail,
          from: fromForOrg(org.id, "United Sports Group"),
          subject: `Reminder — invoice ${inv.number} is due`,
          html: invoiceEmailHtml({
            heading: "Friendly reminder",
            body: `${inv.title} is still outstanding. You can view, download and pay it online.`,
            number: inv.number,
            amountLabel: formatNZD(inv.totalCents),
            url: invoiceUrl(isInvoiceBrand(inv.brand) ? inv.brand : "siu", inv.token),
          }),
        });
      } catch (e) {
        console.error("[invoices] reminder email failed:", e);
      }

      res.json({ ok: true });
    } catch (e: any) {
      console.error("[invoices] reminder failed:", e);
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/admin/invoices/:id/mark-paid", requireAuth, tab, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "X-Workspace-Slug header required" });
      const id = parseInt(String(req.params.id), 10);
      if (!Number.isFinite(id)) return res.status(400).json({ message: "Bad id" });

      const method = req.body?.method === "card" ? "card" : "bank";
      const amountCents = Math.round(Number(req.body?.amountCents));
      if (!Number.isFinite(amountCents) || amountCents <= 0) {
        return res.status(400).json({ message: "A positive amountCents is required" });
      }

      // Atomic idempotency guard — mirrors storage.confirmRegistrationOnce.
      // Only the caller that flips status wins; a second click (or a race
      // with the Stripe webhook) is a no-op, never a duplicate 'paid' event.
      const [row] = await db.update(usgInvoices)
        .set({ status: "paid", paidAt: new Date(), paidMethod: method, paidAmountCents: amountCents, updatedAt: new Date() })
        .where(and(eq(usgInvoices.id, id), eq(usgInvoices.organizationId, org.id), ne(usgInvoices.status, "paid")))
        .returning({ id: usgInvoices.id });
      if (!row) return res.status(409).json({ message: "This invoice is already marked paid." });

      await db.insert(usgInvoiceEvents).values({
        invoiceId: id, kind: "paid", isStaff: true, meta: { method, amountCents },
      });

      const [updated] = await db.select().from(usgInvoices).where(eq(usgInvoices.id, id));
      res.json(updated);
    } catch (e: any) {
      console.error("[invoices] mark-paid failed:", e);
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/admin/invoices/:id/void", requireAuth, tab, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "X-Workspace-Slug header required" });
      const id = parseInt(String(req.params.id), 10);
      if (!Number.isFinite(id)) return res.status(400).json({ message: "Bad id" });

      const [inv] = await db.select().from(usgInvoices)
        .where(and(eq(usgInvoices.id, id), eq(usgInvoices.organizationId, org.id)));
      if (!inv) return res.status(404).json({ message: "Invoice not found" });
      if (inv.status === "paid") return res.status(400).json({ message: "Can't void a paid invoice." });

      await db.update(usgInvoices).set({ status: "void", updatedAt: new Date() }).where(eq(usgInvoices.id, id));
      await db.insert(usgInvoiceEvents).values({ invoiceId: id, kind: "voided", isStaff: true });

      const [updated] = await db.select().from(usgInvoices).where(eq(usgInvoices.id, id));
      res.json(updated);
    } catch (e: any) {
      console.error("[invoices] void failed:", e);
      res.status(500).json({ message: e.message });
    }
  });

  // ═══════════════════════════ PUBLIC ═══════════════════════════════════════

  app.options("/api/public/invoices/:token", (req, res) => { setInvoiceCors(req, res); res.sendStatus(204); });
  app.get("/api/public/invoices/:token", async (req, res) => {
    setInvoiceCors(req, res);
    try {
      const token = str(req.params.token, 80);
      if (!token) return res.status(404).json({ message: "Not found" });
      const [inv] = await db.select().from(usgInvoices).where(eq(usgInvoices.token, token));
      if (!inv) return res.status(404).json({ message: "Not found" });
      res.json(buildPublicInvoice(inv));
    } catch (e: any) {
      console.error("[invoices] public get failed:", e);
      res.status(500).json({ message: "Something went wrong." });
    }
  });

  app.options("/api/public/invoices/:token/opened", (req, res) => { setInvoiceCors(req, res); res.sendStatus(204); });
  app.post("/api/public/invoices/:token/opened", async (req, res) => {
    setInvoiceCors(req, res);
    try {
      const token = str(req.params.token, 80);
      const [inv] = token ? await db.select({ id: usgInvoices.id }).from(usgInvoices).where(eq(usgInvoices.token, token)) : [];
      if (!inv) return res.json({ ok: true }); // never let tracking error out in front of the payer

      const ip = clientIp(req);
      const salt = process.env.SESSION_SECRET || "cufc-dev-secret";
      const ipHash = crypto.createHash("sha256").update(`${ip}|${salt}`).digest("hex");
      // Best-effort: a genuine ClubOS session cookie only travels cross-origin
      // if the caller sends credentials, which this public page does not by
      // default — this is forward-compatible, not load-bearing.
      const isStaff = !!(req as any).session?.userId;

      await db.insert(usgInvoiceEvents).values({
        invoiceId: inv.id,
        kind: "opened",
        ipHash,
        userAgent: str(req.headers["user-agent"], 400) || null,
        referrer: str(req.body?.referrer ?? req.headers["referer"], 400) || null,
        isStaff,
      });
      res.json({ ok: true });
    } catch (e: any) {
      console.error("[invoices] opened tracking failed:", e);
      res.json({ ok: true }); // tracking must never break the invoice
    }
  });

  app.options("/api/public/invoices/:token/pay-intent", (req, res) => { setInvoiceCors(req, res); res.sendStatus(204); });
  app.post("/api/public/invoices/:token/pay-intent", async (req, res) => {
    setInvoiceCors(req, res);
    try {
      const token = str(req.params.token, 80);
      const [inv] = token ? await db.select().from(usgInvoices).where(eq(usgInvoices.token, token)) : [];
      if (!inv) return res.status(404).json({ message: "Invoice not found" });
      if (!inv.cardEnabled || inv.status !== "sent") {
        return res.status(400).json({ message: "Card payments aren't switched on for this invoice yet." });
      }

      const breakdown = cardBreakdown(inv.totalCents, "domestic");
      const paymentIntent = await stripe.paymentIntents.create(
        {
          amount: breakdown.totalCents,
          currency: "nzd",
          automatic_payment_methods: { enabled: true },
          receipt_email: inv.recipientEmail || undefined,
          description: `Invoice ${inv.number} — ${inv.title}`,
          // NEVER set printOrderId here — that metadata key is the sole trigger
          // for pushPaidOrderToXero() and must never fire from an invoice.
          metadata: { invoiceToken: inv.token, kind: "invoice" },
        },
        {
          // A reload or double-click must not mint a second PaymentIntent for the
          // same invoice. Keyed on token + amount so that if the invoice is edited
          // and re-sent, a genuinely new intent is created rather than the stale one
          // being replayed at the old price. Same discipline as server/stripe.ts.
          idempotencyKey: `invoice-${inv.token}-${breakdown.totalCents}`,
        },
      );

      res.json({ clientSecret: paymentIntent.client_secret, amountCents: breakdown.totalCents });
    } catch (e: any) {
      console.error("[invoices] pay-intent failed:", e);
      res.status(500).json({ message: "Couldn't start the card payment." });
    }
  });
}

/**
 * Called from the main Stripe webhook (server/routes.ts, payment_intent.succeeded)
 * when metadata.kind === "invoice" — mirrors the existing kind === "membership"
 * branch. Idempotent: the atomic guard means a webhook retry (or a race with a
 * manual mark-paid) is a safe no-op, never a duplicate 'paid' event.
 */
export async function markInvoicePaidByPaymentIntent(paymentIntent: {
  id: string;
  metadata?: Record<string, string>;
  amount_received?: number;
  amount?: number;
}): Promise<void> {
  const token = paymentIntent.metadata?.invoiceToken;
  if (!token) return;
  try {
    const [inv] = await db.select({ id: usgInvoices.id }).from(usgInvoices).where(eq(usgInvoices.token, token));
    if (!inv) {
      console.error("[invoices] webhook: no invoice for token", token);
      return;
    }
    const amountCents =
      typeof paymentIntent.amount_received === "number" ? paymentIntent.amount_received
      : typeof paymentIntent.amount === "number" ? paymentIntent.amount
      : null;

    // apps/invoices (api/pay-intent.ts) grosses the card charge up by a surcharge
    // equal to Stripe's own fee, so amountCents here is the SURCHARGED total, not
    // the invoice total — e.g. an $890.82 invoice is charged $915.38. paidAmountCents
    // still records that surcharged figure verbatim (it is the truth of what the
    // card was charged), but it must never be read as an overpayment: the club
    // still banks exactly the invoice total, and Stripe keeps the surcharge. The
    // 'paid' event meta below carries invoiceTotalCents + surchargeCents (read off
    // the PaymentIntent's own metadata, set at creation time) so the admin UI can
    // show that split rather than imply the club received $24.56 more than owed.
    const parseMetaCents = (v: string | undefined): number | null => {
      if (!v) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const invoiceTotalCents = parseMetaCents(paymentIntent.metadata?.invoiceTotalCents);
    const surchargeCents = parseMetaCents(paymentIntent.metadata?.surchargeCents);

    const [row] = await db.update(usgInvoices)
      .set({
        status: "paid",
        paidAt: new Date(),
        paidMethod: "card",
        stripePaymentIntentId: paymentIntent.id,
        updatedAt: new Date(),
        ...(amountCents != null ? { paidAmountCents: amountCents } : {}),
      })
      .where(and(eq(usgInvoices.id, inv.id), ne(usgInvoices.status, "paid")))
      .returning({ id: usgInvoices.id });
    if (!row) return; // already paid — webhook retry, idempotent no-op

    await db.insert(usgInvoiceEvents).values({
      invoiceId: inv.id,
      kind: "paid",
      isStaff: false,
      meta: {
        method: "card",
        paymentIntentId: paymentIntent.id,
        amountCents,
        invoiceTotalCents,
        surchargeCents,
      },
    });
  } catch (e) {
    console.error("[invoices] markInvoicePaidByPaymentIntent failed:", e);
  }
}
