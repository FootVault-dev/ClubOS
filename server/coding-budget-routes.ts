// ─────────────────────────────────────────────────────────────────────────────
// CODING BUDGET — the club's chart of accounts and the transactions mapped to it.
//
//   GET    /api/admin/coding-budget                  the tree + totals + findings
//   GET    /api/admin/coding-budget/accounts/:id     one code, with its transactions
//   PATCH  /api/admin/coding-budget/accounts/:id     Victor's Xero mapping + GST call
//   GET    /api/admin/coding-budget/transactions     the register (filterable)
//   POST   /api/admin/coding-budget/transactions     map a transaction to a code
//   PATCH  /api/admin/coding-budget/transactions/:id
//   DELETE /api/admin/coding-budget/transactions/:id
//
// Access. `requireAuth` + `requireTab("coding-budget")`, and the slug is in
// SUPER_ADMIN_ONLY_TABS — checked BEFORE the usual admin/manager escalation, so
// the tab is locked at the API rather than merely hidden in the sidebar. This
// is not caution for its own sake: code 21 names eleven individual staff against
// their salaries, the Chief Executive at $150,000 and the Business Development
// Manager at $72,000 among them. Deleting the slug from that set would hand
// every United Sports Group admin the club's payroll. Victor gets in by name
// through `user_organizations.unlocked_tabs` once he has a login —
// script/grant-unlocked-tab.ts, no deploy.
//
// Org scoping. `organizationId` comes from the X-Workspace-Slug header, never
// from the body, and every child row is reachable only by (id AND
// organizationId) — so guessing an id cannot cross a workspace.
//
// Money is integer cents. `amount_incl_cents` is GENERATED in Postgres and is
// never written here.
// ─────────────────────────────────────────────────────────────────────────────
import type { Express, Request, Response } from "express";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "./db";
import { requireAuth, requireTab } from "./auth";
import { organizations, codingAccounts, codingTransactions, users } from "@shared/schema";
import {
  budgetFor, dollars, nzTodayIso, whyNotPostable, isPostable,
  CODING_STATUSES, GST_TREATMENTS, type GstTreatment,
} from "@shared/coding-budget";

const ORG_HEADER = "X-Workspace-Slug header required";

class BadRequest extends Error {}

const str = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return s.length ? s : null;
};
const isIsoDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Cents from a body value. Rejects floats — money is never a fraction of a cent. */
const cents = (v: unknown, field: string): number => {
  if (v === null || v === undefined || v === "") throw new BadRequest(`${field} is required`);
  const n = Number(v);
  if (!Number.isInteger(n)) throw new BadRequest(`${field} must be a whole number of cents`);
  return n;
};

async function workspaceOrg(req: Request): Promise<{ id: number; slug: string } | null> {
  const slug = String(req.headers["x-workspace-slug"] || "").trim();
  if (!slug) return null;
  const [org] = await db.select().from(organizations).where(eq(organizations.slug, slug));
  return org ? { id: org.id, slug: org.slug } : null;
}

/** Every code in the workspace, shaped for the client. */
async function loadAccounts(orgId: number) {
  const rows = await db.select().from(codingAccounts)
    .where(eq(codingAccounts.organizationId, orgId))
    .orderBy(asc(codingAccounts.code));
  return rows.map(r => ({
    id: r.id,
    code: r.code,
    parentCode: r.code.includes("-") ? r.code.slice(0, r.code.lastIndexOf("-")) : null,
    topCode: r.topCode,
    depth: r.depth,
    name: r.name,
    kind: r.kind,
    treatment: r.treatment,
    postable: r.postable,
    budgetExclCents: r.budgetExclCents,
    budgetInclCents: r.budgetInclCents,
    xeroAccount: r.xeroAccount,
    xeroTracking: r.xeroTracking,
    xeroAccountCode: r.xeroAccountCode,
    gstTreatment: r.gstTreatment,
    note: r.note,
    active: r.active,
  }));
}

/**
 * Actuals per code, rolled up through the tree.
 *
 * 🔴 Derived on read, never stored. A stored actual is a number that goes stale
 * the moment a transaction is edited, and the workbook this replaces is the
 * cautionary tale: it stores its totals and states four different figures for
 * the same term.
 */
async function loadActuals(orgId: number) {
  const rows = await db
    .select({
      code: codingAccounts.code,
      excl: sql<string>`coalesce(sum(${codingTransactions.amountExclCents}), 0)`,
      incl: sql<string>`coalesce(sum(${codingTransactions.amountInclCents}), 0)`,
      n: sql<string>`count(${codingTransactions.id})`,
    })
    .from(codingTransactions)
    .innerJoin(codingAccounts, eq(codingAccounts.id, codingTransactions.codingAccountId))
    .where(eq(codingTransactions.organizationId, orgId))
    .groupBy(codingAccounts.code);

  // Roll each code's own total up to every ancestor.
  const excl = new Map<string, number>();
  const incl = new Map<string, number>();
  const count = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string, n: number) => m.set(k, (m.get(k) ?? 0) + n);
  for (const r of rows) {
    const parts = r.code.split("-");
    for (let i = parts.length; i > 0; i--) {
      const key = parts.slice(0, i).join("-");
      bump(excl, key, Number(r.excl));
      bump(incl, key, Number(r.incl));
      bump(count, key, Number(r.n));
    }
  }
  return { excl, incl, count };
}

export function registerCodingBudgetRoutes(app: Express) {
  const gate = [requireAuth, requireTab("coding-budget")] as const;

  const handle = (fn: (req: Request, res: Response) => Promise<void>) =>
    async (req: Request, res: Response) => {
      try {
        await fn(req, res);
      } catch (e: any) {
        if (e instanceof BadRequest) { res.status(400).json({ message: e.message }); return; }
        console.error("[coding-budget]", e);
        res.status(500).json({ message: e?.message ?? "Something went wrong" });
      }
    };

  // ── The whole tree ─────────────────────────────────────────────────────────
  app.get("/api/admin/coding-budget", ...gate, handle(async (req, res) => {
    const org = await workspaceOrg(req);
    if (!org) { res.status(400).json({ message: ORG_HEADER }); return; }

    const accounts = await loadAccounts(org.id);
    const actuals = await loadActuals(org.id);
    const live = accounts.filter(a => a.active);

    // Budget per stream: each top-level code states its own figure, so the
    // club's budget is the sum of the thirty. Deeper figures are detail WITHIN
    // a stream, never an addition to it — see budgetFor().
    const tops = live.filter(a => a.depth === 1);
    const sumTop = (kind: string, col: "budgetExclCents" | "budgetInclCents") =>
      tops.filter(a => a.kind === kind)
          .reduce((n, a) => n + (a[col] ?? 0), 0);

    const budget = {
      incomeExcl: sumTop("income", "budgetExclCents"),
      incomeIncl: sumTop("income", "budgetInclCents"),
      expenseExcl: sumTop("expense", "budgetExclCents"),
      expenseIncl: sumTop("expense", "budgetInclCents"),
    };

    res.json({
      accounts,
      actuals: {
        excl: Object.fromEntries(actuals.excl),
        incl: Object.fromEntries(actuals.incl),
        count: Object.fromEntries(actuals.count),
      },
      budget,
      // 🔴 The surplus is stated EXCLUSIVE of GST only. Netting GST-inclusive
      // income against GST-inclusive expenses treats the GST the club collects
      // on behalf of Inland Revenue as if it were the club's money — which is
      // how the source workbook turns a $23,616 deficit into a $46,596
      // "surplus". The client shows both and says which one is real.
      netExcl: budget.incomeExcl - budget.expenseExcl,
      netIncl: budget.incomeIncl - budget.expenseIncl,
      today: nzTodayIso(),
      mappedToXero: live.filter(a => a.xeroAccountCode).length,
      gstDecided: live.filter(a => a.gstTreatment).length,
      postableCount: live.filter(a => a.postable).length,
    });
  }));

  // ── One code, with the transactions coded to it ────────────────────────────
  app.get("/api/admin/coding-budget/accounts/:id", ...gate, handle(async (req, res) => {
    const org = await workspaceOrg(req);
    if (!org) { res.status(400).json({ message: ORG_HEADER }); return; }
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) { res.status(400).json({ message: "Bad id" }); return; }

    const [row] = await db.select().from(codingAccounts)
      .where(and(eq(codingAccounts.id, id), eq(codingAccounts.organizationId, org.id)));
    if (!row) { res.status(404).json({ message: "Not found" }); return; }

    // Everything coded to this line OR anything beneath it.
    const txns = await db
      .select({
        t: codingTransactions,
        code: codingAccounts.code,
        codeName: codingAccounts.name,
      })
      .from(codingTransactions)
      .innerJoin(codingAccounts, eq(codingAccounts.id, codingTransactions.codingAccountId))
      .where(and(
        eq(codingTransactions.organizationId, org.id),
        sql`${codingAccounts.code} = ${row.code} or ${codingAccounts.code} like ${row.code + "-%"}`,
      ))
      .orderBy(desc(codingTransactions.occurredOn), desc(codingTransactions.id))
      .limit(500);

    res.json({
      account: row,
      transactions: txns.map(r => ({ ...r.t, code: r.code, codeName: r.codeName })),
      today: nzTodayIso(),
    });
  }));

  // ── Victor's mapping. Deliberately the ONLY fields a human may edit here:
  //    the codes, names and budgets come from the workbook and are replaced
  //    wholesale by the seed, so editing them in the app would be undone on the
  //    next import without warning.
  app.patch("/api/admin/coding-budget/accounts/:id", ...gate, handle(async (req, res) => {
    const org = await workspaceOrg(req);
    if (!org) { res.status(400).json({ message: ORG_HEADER }); return; }
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) { res.status(400).json({ message: "Bad id" }); return; }

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if ("xeroAccountCode" in req.body) patch.xeroAccountCode = str(req.body.xeroAccountCode);
    if ("gstTreatment" in req.body) {
      const g = str(req.body.gstTreatment);
      // null is a legitimate value here — it means "not decided yet", and a
      // human must be able to put a line back to undecided.
      if (g !== null && !GST_TREATMENTS.includes(g as GstTreatment)) {
        throw new BadRequest(`${g} is not a GST treatment`);
      }
      patch.gstTreatment = g;
    }
    if ("note" in req.body) patch.note = str(req.body.note);

    const [updated] = await db.update(codingAccounts).set(patch)
      .where(and(eq(codingAccounts.id, id), eq(codingAccounts.organizationId, org.id)))
      .returning();
    if (!updated) { res.status(404).json({ message: "Not found" }); return; }
    res.json({ account: updated });
  }));

  // ── The transaction register ───────────────────────────────────────────────
  app.get("/api/admin/coding-budget/transactions", ...gate, handle(async (req, res) => {
    const org = await workspaceOrg(req);
    if (!org) { res.status(400).json({ message: ORG_HEADER }); return; }

    const where = [eq(codingTransactions.organizationId, org.id)];
    const status = str(req.query.status);
    if (status) where.push(eq(codingTransactions.status, status));
    const top = str(req.query.topCode);
    if (top) where.push(eq(codingAccounts.topCode, top));

    const rows = await db
      .select({
        t: codingTransactions,
        code: codingAccounts.code,
        codeName: codingAccounts.name,
        kind: codingAccounts.kind,
        // `users` has no `name` column — first and last are separate.
        createdByFirst: users.firstName,
        createdByLast: users.lastName,
      })
      .from(codingTransactions)
      .innerJoin(codingAccounts, eq(codingAccounts.id, codingTransactions.codingAccountId))
      .leftJoin(users, eq(users.id, codingTransactions.createdBy))
      .where(and(...where))
      .orderBy(desc(codingTransactions.occurredOn), desc(codingTransactions.id))
      .limit(1000);

    res.json({
      transactions: rows.map(r => ({
        ...r.t, code: r.code, codeName: r.codeName, kind: r.kind,
        // Null reads as "we don't know who entered this", never as nobody.
        createdByName:
          [r.createdByFirst, r.createdByLast].filter(Boolean).join(" ") || null,
      })),
      today: nzTodayIso(),
    });
  }));

  // ── Map a transaction to a code ────────────────────────────────────────────
  app.post("/api/admin/coding-budget/transactions", ...gate, handle(async (req, res) => {
    const org = await workspaceOrg(req);
    if (!org) { res.status(400).json({ message: ORG_HEADER }); return; }

    const accountId = Number(req.body.codingAccountId);
    if (!Number.isInteger(accountId)) throw new BadRequest("Pick a code to map this to");

    const [account] = await db.select().from(codingAccounts)
      .where(and(eq(codingAccounts.id, accountId), eq(codingAccounts.organizationId, org.id)));

    // 🔴 Checked here for the MESSAGE, enforced by the composite foreign key in
    // Postgres. The check is not the guard — a race that slipped past this
    // would still be refused by the database — it just turns a constraint
    // violation into a sentence explaining the double-count.
    const why = whyNotPostable(account ? {
      code: account.code, name: account.name,
      treatment: account.treatment as any, active: account.active,
    } : undefined);
    if (why) throw new BadRequest(why);

    const occurredOn = str(req.body.occurredOn);
    if (!occurredOn || !isIsoDate(occurredOn)) throw new BadRequest("A date (YYYY-MM-DD) is required");

    const status = str(req.body.status) ?? "draft";
    if (!CODING_STATUSES.includes(status as any)) throw new BadRequest(`${status} is not a status`);

    const [row] = await db.insert(codingTransactions).values({
      organizationId: org.id,
      codingAccountId: accountId,
      occurredOn,
      xeroContact: str(req.body.xeroContact),
      party: str(req.body.party),
      reference: str(req.body.reference),
      description: str(req.body.description),
      amountExclCents: cents(req.body.amountExclCents, "Amount"),
      gstCents: req.body.gstCents == null ? 0 : cents(req.body.gstCents, "GST"),
      status,
      source: str(req.body.source) ?? "manual",
      externalId: str(req.body.externalId),
      notes: str(req.body.notes),
      createdBy: (req as any).user?.id ?? null,
    } as any).returning();

    res.status(201).json({ transaction: row });
  }));

  app.patch("/api/admin/coding-budget/transactions/:id", ...gate, handle(async (req, res) => {
    const org = await workspaceOrg(req);
    if (!org) { res.status(400).json({ message: ORG_HEADER }); return; }
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) { res.status(400).json({ message: "Bad id" }); return; }

    const patch: Record<string, unknown> = { updatedAt: new Date() };

    // Re-coding is the whole point of the tab, so the target is re-validated.
    if ("codingAccountId" in req.body) {
      const accountId = Number(req.body.codingAccountId);
      if (!Number.isInteger(accountId)) throw new BadRequest("Pick a code");
      const [account] = await db.select().from(codingAccounts)
        .where(and(eq(codingAccounts.id, accountId), eq(codingAccounts.organizationId, org.id)));
      const why = whyNotPostable(account ? {
        code: account.code, name: account.name,
        treatment: account.treatment as any, active: account.active,
      } : undefined);
      if (why) throw new BadRequest(why);
      patch.codingAccountId = accountId;
    }
    if ("occurredOn" in req.body) {
      const d = str(req.body.occurredOn);
      if (!d || !isIsoDate(d)) throw new BadRequest("A date (YYYY-MM-DD) is required");
      patch.occurredOn = d;
    }
    for (const f of ["xeroContact", "party", "reference", "description", "notes"]) {
      if (f in req.body) patch[f] = str(req.body[f]);
    }
    if ("amountExclCents" in req.body) patch.amountExclCents = cents(req.body.amountExclCents, "Amount");
    if ("gstCents" in req.body) patch.gstCents = cents(req.body.gstCents, "GST");
    if ("status" in req.body) {
      const s = str(req.body.status) ?? "draft";
      if (!CODING_STATUSES.includes(s as any)) throw new BadRequest(`${s} is not a status`);
      patch.status = s;
    }

    const [updated] = await db.update(codingTransactions).set(patch)
      .where(and(eq(codingTransactions.id, id), eq(codingTransactions.organizationId, org.id)))
      .returning();
    if (!updated) { res.status(404).json({ message: "Not found" }); return; }
    res.json({ transaction: updated });
  }));

  app.delete("/api/admin/coding-budget/transactions/:id", ...gate, handle(async (req, res) => {
    const org = await workspaceOrg(req);
    if (!org) { res.status(400).json({ message: ORG_HEADER }); return; }
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) { res.status(400).json({ message: "Bad id" }); return; }
    const [gone] = await db.delete(codingTransactions)
      .where(and(eq(codingTransactions.id, id), eq(codingTransactions.organizationId, org.id)))
      .returning();
    if (!gone) { res.status(404).json({ message: "Not found" }); return; }
    res.json({ ok: true });
  }));
}
