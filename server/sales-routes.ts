// ─────────────────────────────────────────────────────────────────────────────
// SALES — United Print prospect database + pipeline. Prints workspace,
// super-admin only while Daniel shapes it (see SUPER_ADMIN_ONLY_TABS).
//
//   GET|POST         /api/admin/sales/prospects
//   GET|PATCH|DELETE /api/admin/sales/prospects/:id
//   POST             /api/admin/sales/prospects/:id/activities
//   PATCH|DELETE     /api/admin/sales/prospects/:id/activities/:childId
//
// Org scoping. `organizationId` always comes from the X-Workspace-Slug header
// via `workspaceOrg`, never from the request body — same as vehicles/housing.
//
// Pipeline rules:
//   - A stage change always leaves an activity row behind. Who was contacted
//     when is the sales history Daniel is training himself on.
//   - Moving to won/paid promotes the prospect into print_contacts (the CRM
//     tab) exactly once — a customer should exist where orders live.
//   - "Follow-up due" is DERIVED from next_follow_up_on vs today, never stored.
//   - Money in integer cents; dates as ISO strings, never through `new Date()`.
// ─────────────────────────────────────────────────────────────────────────────
import type { Express, Request, Response } from "express";
import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "./db";
import { requireAuth, requireTab } from "./auth";
import { organizations, printContacts, salesActivities, salesProspects } from "@shared/schema";
import { nzTodayIso } from "@shared/academy";
import {
  OPEN_PIPELINE_STAGES,
  isIsoDate,
  isSalesActivityType,
  isSalesOutcome,
  isSalesRegion,
  isSalesStage,
  isSalesTier,
  stageLabel,
  type SalesStage,
} from "@shared/sales";

// ── Org scoping (mirrors workspaceOrg in routes.ts, which isn't exported) ─────
async function workspaceOrg(req: Request): Promise<{ id: number; slug: string } | null> {
  const slug = String(req.headers["x-workspace-slug"] || "").trim();
  if (!slug) return null;
  const [org] = await db.select().from(organizations).where(eq(organizations.slug, slug));
  return org ? { id: org.id, slug: org.slug } : null;
}

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
const isoDate = (v: unknown, field: string): string | null => {
  const s = str(v);
  if (!s) return null;
  if (!isIsoDate(s)) throw new BadRequest(`${field} must be a date (YYYY-MM-DD)`);
  return s;
};
function pick<T extends string>(v: unknown, guard: (x: unknown) => x is T, field: string, fallback?: T): T {
  const s = str(v);
  if (!s) {
    if (fallback !== undefined) return fallback;
    throw new BadRequest(`${field} is required`);
  }
  if (!guard(s)) throw new BadRequest(`${field} "${s}" is not one of the allowed values`);
  return s;
}
/** services_match: an array of short strings, or nothing. Never trusted deep. */
const strArray = (v: unknown): string[] | null => {
  if (!Array.isArray(v)) return null;
  const out = v.filter((x) => typeof x === "string" && x.trim()).map((x) => (x as string).trim().slice(0, 40));
  return out.length ? out.slice(0, 12) : null;
};

function friendlyDbError(err: any): { status: number; message: string } | null {
  if (err?.code === "23505") {
    switch (err.constraint) {
      case "sales_prospects_org_website_unq":
        return { status: 409, message: "A prospect with that website is already in the database." };
      default:
        return { status: 409, message: "That record already exists." };
    }
  }
  if (err?.code === "23514") {
    return { status: 400, message: "That value isn't allowed." };
  }
  return null;
}

function handler(fn: (req: Request, res: Response) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (err: any) {
      if (err instanceof BadRequest) return res.status(400).json({ message: err.message });
      if (err instanceof NotFound) return res.status(404).json({ message: err.message });
      const friendly = friendlyDbError(err);
      if (friendly) return res.status(friendly.status).json({ message: friendly.message });
      console.error("[sales]", req.method, req.path, err);
      if (!res.headersSent) res.status(500).json({ message: "Something went wrong." });
    }
  };
}

export function registerSalesRoutes(app: Express) {
  const tab = requireTab("sales");

  async function orgOf(req: Request): Promise<number> {
    const org = await workspaceOrg(req);
    if (!org) throw new BadRequest("X-Workspace-Slug header required");
    return org.id;
  }

  async function prospectOf(req: Request, orgId: number) {
    const id = reqInt(req.params.id, "prospect id");
    const [p] = await db
      .select()
      .from(salesProspects)
      .where(and(eq(salesProspects.id, id), eq(salesProspects.organizationId, orgId)));
    if (!p) throw new NotFound("Prospect not found");
    return p;
  }

  const userId = (req: Request) => req.session.userId ?? null;

  /** Winning a deal creates the customer where orders live — print_contacts,
   *  the CRM tab — exactly once per prospect. */
  async function promoteToContact(prospect: typeof salesProspects.$inferSelect, orgId: number): Promise<number | null> {
    if (prospect.promotedContactId) return prospect.promotedContactId;
    const full = (prospect.contactName ?? "").trim();
    const firstName = full ? full.split(/\s+/)[0] : prospect.name;
    const lastName = full ? full.split(/\s+/).slice(1).join(" ") : "";
    const [contact] = await db
      .insert(printContacts)
      .values({
        organizationId: orgId,
        firstName,
        lastName,
        email: prospect.email,
        phone: prospect.phone,
        company: prospect.name,
        type: "customer",
        notes: `Promoted from the Sales pipeline (prospect #${prospect.id}).`,
      })
      .returning();
    await db
      .update(salesProspects)
      .set({ promotedContactId: contact.id, updatedAt: new Date() })
      .where(and(eq(salesProspects.id, prospect.id), eq(salesProspects.organizationId, orgId)));
    return contact.id;
  }

  /** One place performs every stage move, so the activity trail can't be
   *  skipped and the won→CRM promotion can't be forgotten. */
  async function moveStage(
    prospect: typeof salesProspects.$inferSelect,
    orgId: number,
    to: SalesStage,
    by: number | null,
    viaNote?: string | null,
  ) {
    if (prospect.stage === to) return prospect;
    const [row] = await db
      .update(salesProspects)
      .set({ stage: to, stageChangedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(salesProspects.id, prospect.id), eq(salesProspects.organizationId, orgId)))
      .returning();
    await db.insert(salesActivities).values({
      organizationId: orgId,
      prospectId: prospect.id,
      type: "stage_change",
      note: [`${stageLabel(prospect.stage)} → ${stageLabel(to)}`, viaNote].filter(Boolean).join(" · "),
      createdBy: by,
    });
    if (to === "won" || to === "paid") await promoteToContact(row, orgId);
    return row;
  }

  function prospectFields(body: Record<string, unknown>, mode: "create" | "patch") {
    const req_ = mode === "create";
    const f: Record<string, unknown> = {};
    const set = (k: string, parse: () => unknown) => {
      if (req_ || k in body) f[k] = parse();
    };

    set("name", () => reqStr(body.name, "Name"));
    set("website", () => str(body.website));
    set("city", () => str(body.city));
    set("region", () => (str(body.region) ? pick(body.region, isSalesRegion, "Region") : null));
    set("category", () => str(body.category));
    set("subcategory", () => str(body.subcategory));
    set("whyFit", () => str(body.whyFit));
    set("servicesMatch", () => strArray(body.servicesMatch));
    set("contactName", () => str(body.contactName));
    set("contactRole", () => str(body.contactRole));
    set("email", () => str(body.email));
    set("phone", () => str(body.phone));
    set("evidenceUrl", () => str(body.evidenceUrl));
    set("fitScore", () => int(body.fitScore, "Fit score"));
    set("volumeScore", () => int(body.volumeScore, "Volume score"));
    set("tier", () => (str(body.tier) ? pick(body.tier, isSalesTier, "Tier") : null));
    set("nextFollowUpOn", () => isoDate(body.nextFollowUpOn, "Follow-up date"));
    set("declinedReason", () => str(body.declinedReason));
    set("dealValueCents", () => int(body.dealValueCents, "Deal value"));
    set("notes", () => str(body.notes));
    // stage deliberately NOT here — it only moves through moveStage(), so the
    // activity trail and the won→CRM promotion can never be bypassed.
    return f;
  }

  // ── Prospects ──────────────────────────────────────────────────────────────

  app.get(
    "/api/admin/sales/prospects",
    requireAuth,
    tab,
    handler(async (req, res) => {
      const orgId = await orgOf(req);
      const today = nzTodayIso();

      const prospects = await db
        .select()
        .from(salesProspects)
        .where(eq(salesProspects.organizationId, orgId))
        .orderBy(desc(salesProspects.totalScore), asc(salesProspects.name));

      // `today` ships even on the empty response — the client must never fall
      // back to its own clock, which is UTC and reads a day behind in NZ.
      res.json({ prospects, summary: summarise(prospects, today), today });
    }),
  );

  app.post(
    "/api/admin/sales/prospects",
    requireAuth,
    tab,
    handler(async (req, res) => {
      const orgId = await orgOf(req);
      const fields = prospectFields(req.body ?? {}, "create");
      const [row] = await db
        .insert(salesProspects)
        .values({ ...(fields as any), organizationId: orgId, source: "manual", createdBy: userId(req) })
        .returning();
      res.status(201).json({ prospect: row });
    }),
  );

  app.get(
    "/api/admin/sales/prospects/:id",
    requireAuth,
    tab,
    handler(async (req, res) => {
      const orgId = await orgOf(req);
      const prospect = await prospectOf(req, orgId);
      const activities = await db
        .select()
        .from(salesActivities)
        .where(and(eq(salesActivities.prospectId, prospect.id), eq(salesActivities.organizationId, orgId)))
        .orderBy(desc(salesActivities.occurredAt));
      res.json({ prospect, activities, today: nzTodayIso() });
    }),
  );

  app.patch(
    "/api/admin/sales/prospects/:id",
    requireAuth,
    tab,
    handler(async (req, res) => {
      const orgId = await orgOf(req);
      let prospect = await prospectOf(req, orgId);
      const body = req.body ?? {};

      const fields = prospectFields(body, "patch");
      if (Object.keys(fields).length) {
        const [row] = await db
          .update(salesProspects)
          .set({ ...(fields as any), updatedAt: new Date() })
          .where(and(eq(salesProspects.id, prospect.id), eq(salesProspects.organizationId, orgId)))
          .returning();
        prospect = row;
      }

      if ("stage" in body) {
        const to = pick(body.stage, isSalesStage, "Stage");
        prospect = await moveStage(prospect, orgId, to, userId(req));
      }

      res.json({ prospect });
    }),
  );

  /** A prospect with logged history is sales knowledge — decline it, don't
   *  delete it. Only a bare row (a data-entry mistake) is genuinely deleted. */
  app.delete(
    "/api/admin/sales/prospects/:id",
    requireAuth,
    tab,
    handler(async (req, res) => {
      const orgId = await orgOf(req);
      const prospect = await prospectOf(req, orgId);
      const [activity] = await db
        .select({ id: salesActivities.id })
        .from(salesActivities)
        .where(and(eq(salesActivities.prospectId, prospect.id), eq(salesActivities.organizationId, orgId)))
        .limit(1);
      if (activity) {
        return res.status(400).json({
          message: "This prospect has call history — decline it instead of deleting, so the record of who said what survives.",
        });
      }
      await db
        .delete(salesProspects)
        .where(and(eq(salesProspects.id, prospect.id), eq(salesProspects.organizationId, orgId)));
      res.json({ deleted: true });
    }),
  );

  // ── Activities (calls, emails, meetings, notes) ────────────────────────────

  app.post(
    "/api/admin/sales/prospects/:id/activities",
    requireAuth,
    tab,
    handler(async (req, res) => {
      const orgId = await orgOf(req);
      const prospect = await prospectOf(req, orgId);
      const b = req.body ?? {};

      const type = pick(b.type, isSalesActivityType, "Activity type", "call");
      if (type === "stage_change") throw new BadRequest("Stage changes are logged automatically — move the stage instead.");
      const outcome = str(b.outcome) ? pick(b.outcome, isSalesOutcome, "Outcome") : null;
      const note = str(b.note);
      const followUp = isoDate(b.nextFollowUpOn, "Follow-up date");

      const [activity] = await db
        .insert(salesActivities)
        .values({
          organizationId: orgId,
          prospectId: prospect.id,
          type,
          outcome,
          note,
          createdBy: userId(req),
        })
        .returning();

      // A quick-log can carry its consequences in the same request: the next
      // follow-up date, and an obvious stage move (booked a call, got a no).
      const patch: Record<string, unknown> = {};
      if ("nextFollowUpOn" in b) patch.nextFollowUpOn = followUp;
      if (Object.keys(patch).length) {
        await db
          .update(salesProspects)
          .set({ ...(patch as any), updatedAt: new Date() })
          .where(and(eq(salesProspects.id, prospect.id), eq(salesProspects.organizationId, orgId)));
      }

      let updated = null;
      if (str(b.moveStage)) {
        const to = pick(b.moveStage, isSalesStage, "Stage");
        updated = await moveStage(prospect, orgId, to, userId(req), `via ${type} outcome ${outcome ?? "—"}`);
      }

      res.status(201).json({ activity, prospect: updated ?? undefined });
    }),
  );

  app.patch(
    "/api/admin/sales/prospects/:id/activities/:childId",
    requireAuth,
    tab,
    handler(async (req, res) => {
      const orgId = await orgOf(req);
      const prospect = await prospectOf(req, orgId);
      const childId = reqInt(req.params.childId, "id");
      const b = req.body ?? {};
      const patch: Record<string, unknown> = {};
      if ("note" in b) patch.note = str(b.note);
      if ("outcome" in b) patch.outcome = str(b.outcome) ? pick(b.outcome, isSalesOutcome, "Outcome") : null;
      if (!Object.keys(patch).length) throw new BadRequest("Nothing to update");
      const [row] = await db
        .update(salesActivities)
        .set(patch as any)
        .where(
          and(
            eq(salesActivities.id, childId),
            eq(salesActivities.prospectId, prospect.id),
            eq(salesActivities.organizationId, orgId),
          ),
        )
        .returning();
      if (!row) return res.status(404).json({ message: "Not found" });
      res.json({ row });
    }),
  );

  app.delete(
    "/api/admin/sales/prospects/:id/activities/:childId",
    requireAuth,
    tab,
    handler(async (req, res) => {
      const orgId = await orgOf(req);
      const prospect = await prospectOf(req, orgId);
      const childId = reqInt(req.params.childId, "id");
      const deleted = await db
        .delete(salesActivities)
        .where(
          and(
            eq(salesActivities.id, childId),
            eq(salesActivities.prospectId, prospect.id),
            eq(salesActivities.organizationId, orgId),
          ),
        )
        .returning({ id: salesActivities.id });
      if (!deleted.length) return res.status(404).json({ message: "Not found" });
      res.json({ deleted: true });
    }),
  );
}

// ── Rollups ──────────────────────────────────────────────────────────────────

function summarise(
  rows: Array<{
    stage: string;
    tier: string | null;
    nextFollowUpOn: string | null;
    dealValueCents: number | null;
  }>,
  todayIso: string,
) {
  const byStage: Record<string, number> = {};
  const byTier: Record<string, number> = {};
  let followUpsDue = 0;
  let pipelineValueCents = 0;
  let wonValueCents = 0;
  let paidValueCents = 0;

  for (const r of rows) {
    byStage[r.stage] = (byStage[r.stage] ?? 0) + 1;
    if (r.tier) byTier[r.tier] = (byTier[r.tier] ?? 0) + 1;
    // ISO strings compare chronologically — derived, never stored.
    if (r.nextFollowUpOn && r.nextFollowUpOn <= todayIso && r.stage !== "declined" && r.stage !== "paid") followUpsDue++;
    if (r.dealValueCents) {
      if ((OPEN_PIPELINE_STAGES as readonly string[]).includes(r.stage)) pipelineValueCents += r.dealValueCents;
      if (r.stage === "won") wonValueCents += r.dealValueCents;
      if (r.stage === "paid") paidValueCents += r.dealValueCents;
    }
  }

  return { total: rows.length, byStage, byTier, followUpsDue, pipelineValueCents, wonValueCents, paidValueCents };
}
