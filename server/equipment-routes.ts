// ─────────────────────────────────────────────────────────────────────────────
// EQUIPMENT REGISTER — one responsible person per team, their gear, and the
// termly declaration of it. USG workspace, locked tab.
//
// STAFF (requireAuth + requireTab("equipment")):
//   GET|POST                 /api/admin/equipment/holders
//   GET|PATCH|DELETE         /api/admin/equipment/holders/:id
//   POST                     /api/admin/equipment/holders/:id/rotate-link
//   POST                     /api/admin/equipment/holders/:id/items
//   PATCH|DELETE             /api/admin/equipment/holders/:id/items/:itemId
//   GET|POST                 /api/admin/equipment/rounds
//   GET|PATCH                /api/admin/equipment/rounds/:id
//   POST                     /api/admin/equipment/rounds/:id/remind
//   GET                      /api/admin/equipment/overview
//
// HOLDER (Bearer "eqh:" token — NEVER a staff session):
//   GET                      /api/public/equipment/me
//   POST                     /api/public/equipment/me/items
//   PATCH|DELETE             /api/public/equipment/me/items/:id
//   POST                     /api/public/equipment/me/audit
//
// ── Why the holder is not a ClubOS login ─────────────────────────────────────
// The meeting was explicit that the responsible person maintains their own
// list — "it shouldn't be Travis inputting information". The obvious way to do
// that is to give each coordinator a ClubOS account, and it is the wrong way:
// `canAccessTab` grants EVERY tab in a workspace to an admin/manager
// membership, and `users.role` defaults to "coach" — which is also what a
// member of the public gets by signing up to a fan app. Coach onboarding into
// ClubOS is a known-blocked piece of work for exactly that reason. Handing
// twenty-five part-time coaches accounts so they can count footballs would be
// the largest access-control change the club has ever made, made sideways.
//
// So a holder gets a signed link instead, in the shape the MFL and CIC referee
// portals already use: an HMAC token that carries a HOLDER id, sets no session
// cookie, and is re-checked against the live row on every single request. The
// "eqh:" prefix is a domain separator — the referee parsers require "lref:" /
// "ref:" and reject this, and this parser rejects theirs, so no credential can
// ever be mistaken for another.
//
// ── What is derived, and what that buys ──────────────────────────────────────
// Audit status, lateness and variance are computed in shared/equipment.ts from
// rows that either exist or do not. There is no status column to fall out of
// step with a due date somebody edited, and no "outstanding" flag left set on a
// coach who submitted three weeks ago.
//
// 🔴 A count of `null` means NOT COUNTED and is never coerced to 0. Every read
// path below preserves that, because the alternative is telling Ryan a coach
// lost twenty-two footballs when what actually happened is they got half way
// down a form on their phone.
// ─────────────────────────────────────────────────────────────────────────────
import type { Express, Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { and, asc, desc, eq, inArray, sql as dsql } from "drizzle-orm";
import { db } from "./db";
import { requireAuth, requireTab } from "./auth";
import {
  organizations,
  contacts,
  users,
  equipmentHolders,
  equipmentItems,
  equipmentAuditRounds,
  equipmentAuditReturns,
  equipmentAuditCounts,
  equipmentAuditReminders,
} from "@shared/schema";
import { nzTodayIso } from "@shared/academy";
import { fromForOrg } from "@shared/org-domains";
import { sendEmail } from "./email";
import {
  isEquipmentCategory,
  isEquipmentCondition,
  isEquipmentSource,
  isHolderStatus,
  isRoundStatus,
  isIsoDate,
  auditStatus,
  submittedLate,
  variance,
  categoryTotals,
  roundProgress,
  EQUIPMENT_CATEGORY_LABELS,
} from "@shared/equipment";

const APP_URL = (process.env.APP_URL || "https://app.usg.co.nz").replace(/\/+$/, "");

// ── Org scoping ──────────────────────────────────────────────────────────────
// Always from the X-Workspace-Slug header, never the request body. A client
// cannot choose which workspace it is writing into.
async function workspaceOrg(req: Request): Promise<{ id: number; slug: string } | null> {
  const slug = String(req.headers["x-workspace-slug"] || "").trim();
  if (!slug) return null;
  const [org] = await db.select().from(organizations).where(eq(organizations.slug, slug));
  return org ? { id: org.id, slug: org.slug } : null;
}

class BadRequest extends Error {}
class NotFound extends Error {}
class Conflict extends Error {}

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
const nonNegInt = (v: unknown, field: string): number | null => {
  const n = int(v, field);
  if (n !== null && n < 0) throw new BadRequest(`${field} cannot be negative`);
  return n;
};
const isoOrNull = (v: unknown, field: string): string | null => {
  const s = str(v);
  if (!s) return null;
  if (!isIsoDate(s)) throw new BadRequest(`${field} must be a date (YYYY-MM-DD)`);
  return s;
};
// Deliberately permissive. This is not a signup form — a staff member is typing
// a colleague's address, and the only cost of a typo is a bounced reminder.
const email = (v: unknown, field: string): string => {
  const s = reqStr(v, field).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new BadRequest(`${field} must be an email address`);
  return s;
};

function fail(res: Response, err: unknown) {
  if (err instanceof BadRequest) return res.status(400).json({ message: err.message });
  if (err instanceof NotFound) return res.status(404).json({ message: err.message });
  if (err instanceof Conflict) return res.status(409).json({ message: err.message });
  console.error("[equipment]", err);
  return res.status(500).json({ message: "Something went wrong" });
}

// ── Holder token ─────────────────────────────────────────────────────────────
// `eqh:<holderId>.<linkVersion>.<expiry>.<hmac>`.
//
// The link version rides INSIDE the signed payload, so bumping the column
// invalidates every link ever issued to that one holder without touching
// anybody else's and without rotating a shared secret.
//
// 180 days covers two terms; each termly reminder carries a fresh link, so in
// practice nobody meets the expiry. It is short enough that a link left in an
// old inbox stops working within a season.
const HOLDER_TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const holderSecret = () => process.env.SESSION_SECRET || "cufc-dev-secret";

export function makeHolderToken(holderId: number, linkVersion: number) {
  const expiresAt = Date.now() + HOLDER_TOKEN_TTL_MS;
  const payload = `eqh:${holderId}.${linkVersion}.${expiresAt}`;
  const sig = crypto.createHmac("sha256", holderSecret()).update(payload).digest("hex");
  return { token: `${payload}.${sig}`, expiresAt };
}

export function holderLink(holderId: number, linkVersion: number) {
  return `${APP_URL}/equipment/${encodeURIComponent(makeHolderToken(holderId, linkVersion).token)}`;
}

function parseHolderToken(token: string): { holderId: number; linkVersion: number } | null {
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [idPart, verStr, expStr, sig] = parts;
  if (!idPart.startsWith("eqh:")) return null;
  const expected = crypto
    .createHmac("sha256", holderSecret())
    .update(`${idPart}.${verStr}.${expStr}`)
    .digest("hex");
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const holderId = parseInt(idPart.slice(4), 10);
  const linkVersion = parseInt(verStr, 10);
  const exp = parseInt(expStr, 10);
  if (!holderId || !linkVersion || !exp || Date.now() > exp) return null;
  return { holderId, linkVersion };
}

interface HolderRequest extends Request {
  holder?: typeof equipmentHolders.$inferSelect;
}

// The holder row is re-read and re-checked on EVERY request. Retiring somebody
// or rotating their link takes effect on their next tap, not when a token
// happens to expire.
async function requireHolderToken(req: HolderRequest, res: Response, next: NextFunction) {
  try {
    const header = String(req.headers.authorization || "");
    const raw = header.startsWith("Bearer ") ? header.slice(7) : "";
    const parsed = raw ? parseHolderToken(raw) : null;
    if (!parsed) return res.status(401).json({ message: "This link has expired. Ask the club for a new one." });
    const [holder] = await db
      .select()
      .from(equipmentHolders)
      .where(eq(equipmentHolders.id, parsed.holderId));
    if (!holder) return res.status(401).json({ message: "This link is no longer valid." });
    if (holder.status !== "active") {
      return res.status(403).json({ message: "You are no longer listed as responsible for this team's equipment." });
    }
    if (holder.linkVersion !== parsed.linkVersion) {
      return res.status(401).json({ message: "This link has been replaced. Ask the club for the current one." });
    }
    req.holder = holder;
    next();
  } catch (err) {
    console.error("[equipment] holder token", err);
    res.status(500).json({ message: "Something went wrong" });
  }
}

// ── Shared reads ─────────────────────────────────────────────────────────────

/** The round staff are currently chasing, if any. Newest open round wins. */
async function openRoundFor(orgId: number) {
  const [round] = await db
    .select()
    .from(equipmentAuditRounds)
    .where(and(eq(equipmentAuditRounds.organizationId, orgId), eq(equipmentAuditRounds.status, "open")))
    .orderBy(desc(equipmentAuditRounds.year), desc(equipmentAuditRounds.termNumber))
    .limit(1);
  return round ?? null;
}

const isoDay = (v: unknown): string | null => {
  if (!v) return null;
  if (typeof v === "string") return v.slice(0, 10);
  // A `date` column comes back from pg as a Date at NZ-midnight-in-UTC. Take the
  // calendar parts in UTC — never toISOString() on a local Date, which is how a
  // due date renders a day early for eleven hours out of every twenty-four.
  if (v instanceof Date) {
    const y = v.getUTCFullYear();
    const m = String(v.getUTCMonth() + 1).padStart(2, "0");
    const d = String(v.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return null;
};

const isoTs = (v: unknown): string | null => {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  return typeof v === "string" ? v : null;
};

function shapeRound(r: typeof equipmentAuditRounds.$inferSelect | null) {
  if (!r) return null;
  return {
    id: r.id,
    year: r.year,
    termNumber: r.termNumber,
    label: r.label,
    opensOn: isoDay(r.opensOn),
    dueOn: isoDay(r.dueOn),
    status: r.status,
    notes: r.notes,
  };
}

function shapeItem(i: typeof equipmentItems.$inferSelect) {
  return {
    id: i.id,
    holderId: i.holderId,
    category: i.category,
    categoryLabel: EQUIPMENT_CATEGORY_LABELS[i.category as keyof typeof EQUIPMENT_CATEGORY_LABELS] ?? "Other",
    name: i.name,
    quantity: i.quantity,
    condition: i.condition,
    storageLocation: i.storageLocation,
    source: i.source,
    acquiredOn: isoDay(i.acquiredOn),
    addedVia: i.addedVia,
    notes: i.notes,
  };
}

export function registerEquipmentRoutes(app: Express) {
  // ═══════════════════════════════════════════════════════════════════════════
  // STAFF
  // ═══════════════════════════════════════════════════════════════════════════
  const staff = [requireAuth, requireTab("equipment")] as const;

  // ── Overview ──────────────────────────────────────────────────────────────
  app.get("/api/admin/equipment/overview", ...staff, async (req: Request, res: Response) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "X-Workspace-Slug header required" });
      const today = nzTodayIso();

      const holders = await db
        .select()
        .from(equipmentHolders)
        .where(eq(equipmentHolders.organizationId, org.id))
        .orderBy(asc(equipmentHolders.teamName));
      const active = holders.filter(h => h.status === "active");

      const items = await db
        .select()
        .from(equipmentItems)
        .where(eq(equipmentItems.organizationId, org.id));

      const round = await openRoundFor(org.id);
      let progress = null as ReturnType<typeof roundProgress> | null;
      let outstanding: Array<{ holderId: number; teamName: string; personName: string; email: string; status: string }> = [];

      if (round) {
        const returns = await db
          .select()
          .from(equipmentAuditReturns)
          .where(eq(equipmentAuditReturns.roundId, round.id));
        const byHolder = new Map(returns.map(r => [r.holderId, r]));
        const dueOn = isoDay(round.dueOn);
        // Only ACTIVE holders are chased. A retired coordinator is not
        // outstanding — they are not responsible any more.
        progress = roundProgress(
          active.map(h => ({ submittedAt: isoTs(byHolder.get(h.id)?.submittedAt ?? null) })),
          dueOn,
          today,
        );
        outstanding = active
          .map(h => ({
            holder: h,
            status: auditStatus({
              submittedAt: isoTs(byHolder.get(h.id)?.submittedAt ?? null),
              dueOn,
              todayIso: today,
            }),
          }))
          .filter(x => x.status !== "submitted")
          .map(x => ({
            holderId: x.holder.id,
            teamName: x.holder.teamName,
            personName: x.holder.personName,
            email: x.holder.email,
            status: x.status,
          }));
      }

      const itemsByHolder = new Map<number, number>();
      const qtyByHolder = new Map<number, number>();
      for (const i of items) {
        itemsByHolder.set(i.holderId, (itemsByHolder.get(i.holderId) ?? 0) + 1);
        qtyByHolder.set(i.holderId, (qtyByHolder.get(i.holderId) ?? 0) + i.quantity);
      }

      res.json({
        today,
        totals: {
          holders: active.length,
          retired: holders.length - active.length,
          lines: items.length,
          quantity: items.reduce((s, i) => s + i.quantity, 0),
          // The number the meeting actually asked for: what we hold, by kind,
          // so a reorder or a grant application starts from a figure.
          byCategory: categoryTotals(items),
        },
        openRound: shapeRound(round),
        progress,
        outstanding,
        holders: holders.map(h => ({
          id: h.id,
          teamName: h.teamName,
          programme: h.programme,
          personName: h.personName,
          email: h.email,
          phone: h.phone,
          storageLocation: h.storageLocation,
          status: h.status,
          contactId: h.contactId,
          lines: itemsByHolder.get(h.id) ?? 0,
          quantity: qtyByHolder.get(h.id) ?? 0,
        })),
      });
    } catch (err) {
      fail(res, err);
    }
  });

  // ── Holders ───────────────────────────────────────────────────────────────
  app.post("/api/admin/equipment/holders", ...staff, async (req: Request, res: Response) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "X-Workspace-Slug header required" });

      const teamName = reqStr(req.body?.teamName, "Team");
      const personName = reqStr(req.body?.personName, "Person responsible");
      const addr = email(req.body?.email, "Email");
      const contactId = int(req.body?.contactId, "contactId");

      // A linked contact must exist. We never mint one from this form — that is
      // how the contacts table grew 175 duplicate-people groups.
      if (contactId !== null) {
        const [c] = await db.select().from(contacts).where(eq(contacts.id, contactId));
        if (!c) throw new BadRequest("That contact no longer exists");
      }

      const [row] = await db
        .insert(equipmentHolders)
        .values({
          organizationId: org.id,
          teamName,
          programme: str(req.body?.programme),
          contactId,
          personName,
          email: addr,
          phone: str(req.body?.phone),
          storageLocation: str(req.body?.storageLocation),
          notes: str(req.body?.notes),
          createdBy: req.session.userId ?? null,
        })
        .returning();

      res.status(201).json({ holder: row, link: holderLink(row.id, row.linkVersion) });
    } catch (err: any) {
      // The partial unique index is the authority on this, not a pre-check —
      // two staff adding a coordinator at the same moment would both pass a
      // check-then-act read.
      if (err?.code === "23505") {
        return res
          .status(409)
          .json({ message: "That team already has someone responsible. Retire them first, or edit the existing one." });
      }
      fail(res, err);
    }
  });

  app.get("/api/admin/equipment/holders/:id", ...staff, async (req: Request, res: Response) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "X-Workspace-Slug header required" });
      const id = int(req.params.id, "id");
      const [holder] = await db
        .select()
        .from(equipmentHolders)
        .where(and(eq(equipmentHolders.id, Number(id)), eq(equipmentHolders.organizationId, org.id)));
      if (!holder) throw new NotFound("Not found");

      const items = await db
        .select()
        .from(equipmentItems)
        .where(eq(equipmentItems.holderId, holder.id))
        .orderBy(asc(equipmentItems.category), asc(equipmentItems.name));

      const returns = await db
        .select({
          r: equipmentAuditReturns,
          round: equipmentAuditRounds,
        })
        .from(equipmentAuditReturns)
        .innerJoin(equipmentAuditRounds, eq(equipmentAuditRounds.id, equipmentAuditReturns.roundId))
        .where(eq(equipmentAuditReturns.holderId, holder.id))
        .orderBy(desc(equipmentAuditRounds.year), desc(equipmentAuditRounds.termNumber));

      res.json({
        today: nzTodayIso(),
        holder: {
          ...holder,
          createdAt: isoTs(holder.createdAt),
          updatedAt: isoTs(holder.updatedAt),
        },
        link: holder.status === "active" ? holderLink(holder.id, holder.linkVersion) : null,
        items: items.map(shapeItem),
        totals: { lines: items.length, quantity: items.reduce((s, i) => s + i.quantity, 0), byCategory: categoryTotals(items) },
        history: returns.map(({ r, round }) => ({
          roundId: round.id,
          label: round.label,
          dueOn: isoDay(round.dueOn),
          submittedAt: isoTs(r.submittedAt),
          late: submittedLate(isoTs(r.submittedAt), isoDay(round.dueOn)),
          notes: r.notes,
        })),
      });
    } catch (err) {
      fail(res, err);
    }
  });

  app.patch("/api/admin/equipment/holders/:id", ...staff, async (req: Request, res: Response) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "X-Workspace-Slug header required" });
      const id = Number(int(req.params.id, "id"));
      const [existing] = await db
        .select()
        .from(equipmentHolders)
        .where(and(eq(equipmentHolders.id, id), eq(equipmentHolders.organizationId, org.id)));
      if (!existing) throw new NotFound("Not found");

      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if ("teamName" in req.body) patch.teamName = reqStr(req.body.teamName, "Team");
      if ("programme" in req.body) patch.programme = str(req.body.programme);
      if ("personName" in req.body) patch.personName = reqStr(req.body.personName, "Person responsible");
      if ("email" in req.body) patch.email = email(req.body.email, "Email");
      if ("phone" in req.body) patch.phone = str(req.body.phone);
      if ("storageLocation" in req.body) patch.storageLocation = str(req.body.storageLocation);
      if ("notes" in req.body) patch.notes = str(req.body.notes);
      if ("contactId" in req.body) {
        const cid = int(req.body.contactId, "contactId");
        if (cid !== null) {
          const [c] = await db.select().from(contacts).where(eq(contacts.id, cid));
          if (!c) throw new BadRequest("That contact no longer exists");
        }
        patch.contactId = cid;
      }
      if ("status" in req.body) {
        const s = reqStr(req.body.status, "Status");
        if (!isHolderStatus(s)) throw new BadRequest("Unknown status");
        patch.status = s;
      }

      const [row] = await db
        .update(equipmentHolders)
        .set(patch)
        .where(and(eq(equipmentHolders.id, id), eq(equipmentHolders.organizationId, org.id)))
        .returning();
      res.json({ holder: row, link: row.status === "active" ? holderLink(row.id, row.linkVersion) : null });
    } catch (err: any) {
      if (err?.code === "23505") {
        return res.status(409).json({ message: "That team already has someone responsible." });
      }
      fail(res, err);
    }
  });

  // Deleting is allowed ONLY while a holder has no audit history. Once they
  // have declared a count, that declaration is a record and the holder is
  // retired instead — which the RESTRICT on returns→holders enforces anyway;
  // this just turns a database error into an explanation.
  app.delete("/api/admin/equipment/holders/:id", ...staff, async (req: Request, res: Response) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "X-Workspace-Slug header required" });
      const id = Number(int(req.params.id, "id"));
      const [existing] = await db
        .select()
        .from(equipmentHolders)
        .where(and(eq(equipmentHolders.id, id), eq(equipmentHolders.organizationId, org.id)));
      if (!existing) throw new NotFound("Not found");

      const [{ n }] = await db
        .select({ n: dsql<number>`count(*)::int` })
        .from(equipmentAuditReturns)
        .where(eq(equipmentAuditReturns.holderId, id));
      if (n > 0) {
        throw new Conflict(
          "This person has submitted an equipment audit, so their record is kept. Set them to retired instead.",
        );
      }

      await db.delete(equipmentHolders).where(and(eq(equipmentHolders.id, id), eq(equipmentHolders.organizationId, org.id)));
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/admin/equipment/holders/:id/rotate-link", ...staff, async (req: Request, res: Response) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "X-Workspace-Slug header required" });
      const id = Number(int(req.params.id, "id"));
      const [row] = await db
        .update(equipmentHolders)
        .set({ linkVersion: dsql`${equipmentHolders.linkVersion} + 1`, updatedAt: new Date() })
        .where(and(eq(equipmentHolders.id, id), eq(equipmentHolders.organizationId, org.id)))
        .returning();
      if (!row) throw new NotFound("Not found");
      res.json({ link: holderLink(row.id, row.linkVersion) });
    } catch (err) {
      fail(res, err);
    }
  });

  // ── Items (staff acting on a holder's behalf) ──────────────────────────────
  function itemPatchFrom(body: any, forInsert: boolean): Record<string, unknown> {
    const patch: Record<string, unknown> = {};
    if (forInsert || "name" in body) patch.name = reqStr(body?.name, "Item");
    if (forInsert || "category" in body) {
      const c = str(body?.category) ?? "other";
      if (!isEquipmentCategory(c)) throw new BadRequest("Unknown category");
      patch.category = c;
    }
    if (forInsert || "quantity" in body) {
      const q = nonNegInt(body?.quantity, "Quantity");
      patch.quantity = q ?? 0;
    }
    if ("condition" in body) {
      const c = str(body?.condition);
      if (c !== null && !isEquipmentCondition(c)) throw new BadRequest("Unknown condition");
      patch.condition = c;
    }
    if ("source" in body) {
      const s = str(body?.source) ?? "unknown";
      if (!isEquipmentSource(s)) throw new BadRequest("Unknown source");
      patch.source = s;
    }
    if ("storageLocation" in body) patch.storageLocation = str(body?.storageLocation);
    if ("acquiredOn" in body) patch.acquiredOn = isoOrNull(body?.acquiredOn, "Acquired on");
    if ("notes" in body) patch.notes = str(body?.notes);
    return patch;
  }

  async function holderOr404(orgId: number, holderId: number) {
    const [h] = await db
      .select()
      .from(equipmentHolders)
      .where(and(eq(equipmentHolders.id, holderId), eq(equipmentHolders.organizationId, orgId)));
    if (!h) throw new NotFound("Not found");
    return h;
  }

  app.post("/api/admin/equipment/holders/:id/items", ...staff, async (req: Request, res: Response) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "X-Workspace-Slug header required" });
      const holder = await holderOr404(org.id, Number(int(req.params.id, "id")));
      const [row] = await db
        .insert(equipmentItems)
        .values({
          ...(itemPatchFrom(req.body, true) as any),
          organizationId: org.id,
          holderId: holder.id,
          addedVia: "staff",
          createdBy: req.session.userId ?? null,
        })
        .returning();
      res.status(201).json({ item: shapeItem(row) });
    } catch (err) {
      fail(res, err);
    }
  });

  app.patch("/api/admin/equipment/holders/:id/items/:itemId", ...staff, async (req: Request, res: Response) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "X-Workspace-Slug header required" });
      const holder = await holderOr404(org.id, Number(int(req.params.id, "id")));
      // Reachable only by (item AND holder AND org) — guessing an id never
      // crosses a team, let alone a workspace.
      const [row] = await db
        .update(equipmentItems)
        .set({ ...(itemPatchFrom(req.body, false) as any), updatedAt: new Date() })
        .where(
          and(
            eq(equipmentItems.id, Number(int(req.params.itemId, "itemId"))),
            eq(equipmentItems.holderId, holder.id),
            eq(equipmentItems.organizationId, org.id),
          ),
        )
        .returning();
      if (!row) throw new NotFound("Not found");
      res.json({ item: shapeItem(row) });
    } catch (err) {
      fail(res, err);
    }
  });

  app.delete("/api/admin/equipment/holders/:id/items/:itemId", ...staff, async (req: Request, res: Response) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "X-Workspace-Slug header required" });
      const holder = await holderOr404(org.id, Number(int(req.params.id, "id")));
      const [row] = await db
        .delete(equipmentItems)
        .where(
          and(
            eq(equipmentItems.id, Number(int(req.params.itemId, "itemId"))),
            eq(equipmentItems.holderId, holder.id),
            eq(equipmentItems.organizationId, org.id),
          ),
        )
        .returning();
      if (!row) throw new NotFound("Not found");
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // ── Rounds ────────────────────────────────────────────────────────────────
  app.get("/api/admin/equipment/rounds", ...staff, async (req: Request, res: Response) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "X-Workspace-Slug header required" });
      const today = nzTodayIso();
      const rounds = await db
        .select()
        .from(equipmentAuditRounds)
        .where(eq(equipmentAuditRounds.organizationId, org.id))
        .orderBy(desc(equipmentAuditRounds.year), desc(equipmentAuditRounds.termNumber));

      const active = await db
        .select()
        .from(equipmentHolders)
        .where(and(eq(equipmentHolders.organizationId, org.id), eq(equipmentHolders.status, "active")));

      const ids = rounds.map(r => r.id);
      const returns = ids.length
        ? await db.select().from(equipmentAuditReturns).where(inArray(equipmentAuditReturns.roundId, ids))
        : [];

      res.json({
        today,
        rounds: rounds.map(r => {
          const mine = returns.filter(x => x.roundId === r.id);
          const byHolder = new Map(mine.map(x => [x.holderId, x]));
          return {
            ...shapeRound(r),
            progress: roundProgress(
              active.map(h => ({ submittedAt: isoTs(byHolder.get(h.id)?.submittedAt ?? null) })),
              isoDay(r.dueOn),
              today,
            ),
          };
        }),
      });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/admin/equipment/rounds", ...staff, async (req: Request, res: Response) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "X-Workspace-Slug header required" });
      const year = int(req.body?.year, "Year");
      const termNumber = int(req.body?.termNumber, "Term");
      if (year === null || termNumber === null) throw new BadRequest("Year and term are required");
      if (termNumber < 1 || termNumber > 4) throw new BadRequest("Term must be 1–4");
      const opensOn = isoOrNull(req.body?.opensOn, "Opens on");
      const dueOn = isoOrNull(req.body?.dueOn, "Due on");
      if (opensOn && dueOn && dueOn < opensOn) throw new BadRequest("The due date cannot be before the opening date");

      const [row] = await db
        .insert(equipmentAuditRounds)
        .values({
          organizationId: org.id,
          year,
          termNumber,
          label: str(req.body?.label) ?? `Term ${termNumber} ${year}`,
          opensOn,
          dueOn,
          notes: str(req.body?.notes),
          createdBy: req.session.userId ?? null,
        })
        .returning();
      res.status(201).json({ round: shapeRound(row) });
    } catch (err: any) {
      if (err?.code === "23505") {
        return res.status(409).json({ message: "There is already an audit for that term." });
      }
      fail(res, err);
    }
  });

  app.patch("/api/admin/equipment/rounds/:id", ...staff, async (req: Request, res: Response) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "X-Workspace-Slug header required" });
      const id = Number(int(req.params.id, "id"));
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if ("label" in req.body) patch.label = reqStr(req.body.label, "Label");
      if ("opensOn" in req.body) patch.opensOn = isoOrNull(req.body.opensOn, "Opens on");
      if ("dueOn" in req.body) patch.dueOn = isoOrNull(req.body.dueOn, "Due on");
      if ("notes" in req.body) patch.notes = str(req.body.notes);
      if ("status" in req.body) {
        const s = reqStr(req.body.status, "Status");
        if (!isRoundStatus(s)) throw new BadRequest("Unknown status");
        patch.status = s;
      }
      const [row] = await db
        .update(equipmentAuditRounds)
        .set(patch)
        .where(and(eq(equipmentAuditRounds.id, id), eq(equipmentAuditRounds.organizationId, org.id)))
        .returning();
      if (!row) throw new NotFound("Not found");
      res.json({ round: shapeRound(row) });
    } catch (err) {
      fail(res, err);
    }
  });

  // The board for one round: every active holder, where they stand, and — for
  // those who submitted — what moved.
  app.get("/api/admin/equipment/rounds/:id", ...staff, async (req: Request, res: Response) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "X-Workspace-Slug header required" });
      const id = Number(int(req.params.id, "id"));
      const today = nzTodayIso();

      const [round] = await db
        .select()
        .from(equipmentAuditRounds)
        .where(and(eq(equipmentAuditRounds.id, id), eq(equipmentAuditRounds.organizationId, org.id)));
      if (!round) throw new NotFound("Not found");
      const dueOn = isoDay(round.dueOn);

      const active = await db
        .select()
        .from(equipmentHolders)
        .where(and(eq(equipmentHolders.organizationId, org.id), eq(equipmentHolders.status, "active")))
        .orderBy(asc(equipmentHolders.teamName));

      const returns = await db
        .select()
        .from(equipmentAuditReturns)
        .where(eq(equipmentAuditReturns.roundId, round.id));
      const byHolder = new Map(returns.map(r => [r.holderId, r]));

      const counts = returns.length
        ? await db
            .select()
            .from(equipmentAuditCounts)
            .where(inArray(equipmentAuditCounts.returnId, returns.map(r => r.id)))
        : [];

      const reminders = await db
        .select()
        .from(equipmentAuditReminders)
        .where(eq(equipmentAuditReminders.roundId, round.id))
        .orderBy(desc(equipmentAuditReminders.sentAt));
      const lastReminder = new Map<number, string | null>();
      for (const r of reminders) if (!lastReminder.has(r.holderId)) lastReminder.set(r.holderId, isoTs(r.sentAt));

      const rows = active.map(h => {
        const ret = byHolder.get(h.id) ?? null;
        const mine = ret ? counts.filter(c => c.returnId === ret.id) : [];
        const lines = mine.map(c => {
          const v = variance({ expected: c.quantityBefore, counted: c.countedQuantity });
          return {
            id: c.id,
            itemName: c.itemName,
            category: c.category,
            expected: c.quantityBefore,
            counted: c.countedQuantity,
            condition: c.condition,
            notes: c.notes,
            variance: v.kind,
            delta: v.delta,
          };
        });
        return {
          holderId: h.id,
          teamName: h.teamName,
          programme: h.programme,
          personName: h.personName,
          email: h.email,
          phone: h.phone,
          status: auditStatus({ submittedAt: isoTs(ret?.submittedAt ?? null), dueOn, todayIso: today }),
          submittedAt: isoTs(ret?.submittedAt ?? null),
          late: submittedLate(isoTs(ret?.submittedAt ?? null), dueOn),
          notes: ret?.notes ?? null,
          lastRemindedAt: lastReminder.get(h.id) ?? null,
          lines,
          // A count that was never taken contributes to neither total — it is
          // not a shortfall, it is a blank.
          shortLines: lines.filter(l => l.variance === "short").length,
          notCounted: lines.filter(l => l.variance === "not_counted").length,
        };
      });

      res.json({
        today,
        round: shapeRound(round),
        progress: roundProgress(
          active.map(h => ({ submittedAt: isoTs(byHolder.get(h.id)?.submittedAt ?? null) })),
          dueOn,
          today,
        ),
        rows,
      });
    } catch (err) {
      fail(res, err);
    }
  });

  // ── Reminders — the whiteboard's "follow up + notify system" ───────────────
  // Staff-triggered, not a cron. Nothing here runs on a schedule: a button that
  // says who it is about to email is honest, and a nightly job that quietly
  // mails twenty-five coaches is the kind of thing that gets discovered by a
  // coach, not by us. `holderIds` chases named people; omitting it chases
  // everyone who has not submitted.
  app.post("/api/admin/equipment/rounds/:id/remind", ...staff, async (req: Request, res: Response) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "X-Workspace-Slug header required" });
      const id = Number(int(req.params.id, "id"));
      const today = nzTodayIso();

      const [round] = await db
        .select()
        .from(equipmentAuditRounds)
        .where(and(eq(equipmentAuditRounds.id, id), eq(equipmentAuditRounds.organizationId, org.id)));
      if (!round) throw new NotFound("Not found");
      if (round.status !== "open") throw new BadRequest("That audit is closed. Re-open it before sending reminders.");
      const dueOn = isoDay(round.dueOn);

      const active = await db
        .select()
        .from(equipmentHolders)
        .where(and(eq(equipmentHolders.organizationId, org.id), eq(equipmentHolders.status, "active")));

      const returns = await db
        .select()
        .from(equipmentAuditReturns)
        .where(eq(equipmentAuditReturns.roundId, round.id));
      const submitted = new Set(returns.filter(r => r.submittedAt).map(r => r.holderId));

      const wanted: number[] | null = Array.isArray(req.body?.holderIds)
        ? req.body.holderIds.map((v: unknown) => Number(int(v, "holderIds"))).filter((n: number) => Number.isInteger(n))
        : null;

      // Never chase somebody who has already submitted, even if a stale page
      // asked us to. The page they were looking at may be minutes old.
      const targets = active.filter(h => !submitted.has(h.id) && (wanted === null || wanted.includes(h.id)));

      const from = fromForOrg(org.id, "United Sports Group");
      const dueLine = dueOn ? ` It's due by <strong>${dueOn}</strong>.` : "";
      let sent = 0;
      let failed = 0;

      for (const h of targets) {
        const link = holderLink(h.id, h.linkVersion);
        const html = `
          <p>Hi ${h.personName.split(" ")[0]},</p>
          <p>It's time for the <strong>${round.label}</strong> equipment check for
             <strong>${h.teamName}</strong>.${dueLine}</p>
          <p>Open your team's equipment list, count what you actually have, and press submit.
             If you've picked up new gear since last term, add it on the same page.</p>
          <p><a href="${link}"
                style="display:inline-block;background:#111;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none">
                Open your equipment list</a></p>
          <p style="color:#666;font-size:13px">This link is just for you — please don't forward it.</p>
          <p>Thanks,<br>United Sports Group</p>`;

        let ok = false;
        let error: string | null = null;
        try {
          ok = await sendEmail({
            to: h.email,
            from,
            subject: `${round.label} — equipment check for ${h.teamName}`,
            html,
          });
          if (!ok) error = "Email provider did not accept the message";
        } catch (e: any) {
          ok = false;
          error = String(e?.message ?? e).slice(0, 300);
        }

        // Logged either way. A reminder that silently failed is worse than none,
        // because the board would read as "chased" and nobody would chase again.
        await db.insert(equipmentAuditReminders).values({
          organizationId: org.id,
          roundId: round.id,
          holderId: h.id,
          sentToEmail: h.email,
          sentByUserId: req.session.userId ?? null,
          delivered: ok,
          error,
        });
        ok ? sent++ : failed++;
      }

      res.json({ sent, failed, skipped: active.length - targets.length, today });
    } catch (err) {
      fail(res, err);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // HOLDER — signed link, no session, no ClubOS account.
  // ═══════════════════════════════════════════════════════════════════════════

  app.get("/api/public/equipment/me", requireHolderToken, async (req: HolderRequest, res: Response) => {
    try {
      const holder = req.holder!;
      const today = nzTodayIso();
      const items = await db
        .select()
        .from(equipmentItems)
        .where(eq(equipmentItems.holderId, holder.id))
        .orderBy(asc(equipmentItems.category), asc(equipmentItems.name));

      const round = await openRoundFor(holder.organizationId);
      let audit = null as any;
      if (round) {
        const [ret] = await db
          .select()
          .from(equipmentAuditReturns)
          .where(
            and(eq(equipmentAuditReturns.roundId, round.id), eq(equipmentAuditReturns.holderId, holder.id)),
          );
        const counts = ret
          ? await db.select().from(equipmentAuditCounts).where(eq(equipmentAuditCounts.returnId, ret.id))
          : [];
        audit = {
          round: shapeRound(round),
          status: auditStatus({ submittedAt: isoTs(ret?.submittedAt ?? null), dueOn: isoDay(round.dueOn), todayIso: today }),
          submittedAt: isoTs(ret?.submittedAt ?? null),
          notes: ret?.notes ?? null,
          // Keyed by item so the form can pre-fill a previous submission
          // without ever inventing a number for a line nobody counted.
          counts: counts
            .filter(c => c.itemId !== null)
            .map(c => ({ itemId: c.itemId, counted: c.countedQuantity, condition: c.condition, notes: c.notes })),
        };
      }

      res.json({
        today,
        holder: {
          id: holder.id,
          teamName: holder.teamName,
          programme: holder.programme,
          personName: holder.personName,
          email: holder.email,
          storageLocation: holder.storageLocation,
        },
        items: items.map(shapeItem),
        totals: { lines: items.length, quantity: items.reduce((s, i) => s + i.quantity, 0) },
        audit,
      });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/public/equipment/me/items", requireHolderToken, async (req: HolderRequest, res: Response) => {
    try {
      const holder = req.holder!;
      const name = reqStr(req.body?.name, "Item");
      const category = str(req.body?.category) ?? "other";
      if (!isEquipmentCategory(category)) throw new BadRequest("Unknown category");
      const quantity = nonNegInt(req.body?.quantity, "Quantity") ?? 0;
      const condition = str(req.body?.condition);
      if (condition !== null && !isEquipmentCondition(condition)) throw new BadRequest("Unknown condition");
      const source = str(req.body?.source) ?? "unknown";
      if (!isEquipmentSource(source)) throw new BadRequest("Unknown source");

      const [row] = await db
        .insert(equipmentItems)
        .values({
          organizationId: holder.organizationId,
          holderId: holder.id,
          name,
          category,
          quantity,
          condition,
          source,
          storageLocation: str(req.body?.storageLocation),
          notes: str(req.body?.notes),
          addedVia: "holder",
        })
        .returning();
      res.status(201).json({ item: shapeItem(row) });
    } catch (err) {
      fail(res, err);
    }
  });

  app.patch("/api/public/equipment/me/items/:id", requireHolderToken, async (req: HolderRequest, res: Response) => {
    try {
      const holder = req.holder!;
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if ("name" in req.body) patch.name = reqStr(req.body.name, "Item");
      if ("quantity" in req.body) patch.quantity = nonNegInt(req.body.quantity, "Quantity") ?? 0;
      if ("category" in req.body) {
        const c = str(req.body.category) ?? "other";
        if (!isEquipmentCategory(c)) throw new BadRequest("Unknown category");
        patch.category = c;
      }
      if ("condition" in req.body) {
        const c = str(req.body.condition);
        if (c !== null && !isEquipmentCondition(c)) throw new BadRequest("Unknown condition");
        patch.condition = c;
      }
      if ("storageLocation" in req.body) patch.storageLocation = str(req.body.storageLocation);
      if ("notes" in req.body) patch.notes = str(req.body.notes);

      // Scoped to THIS holder — a token can only ever touch its own team's list.
      const [row] = await db
        .update(equipmentItems)
        .set(patch)
        .where(and(eq(equipmentItems.id, Number(int(req.params.id, "id"))), eq(equipmentItems.holderId, holder.id)))
        .returning();
      if (!row) throw new NotFound("Not found");
      res.json({ item: shapeItem(row) });
    } catch (err) {
      fail(res, err);
    }
  });

  app.delete("/api/public/equipment/me/items/:id", requireHolderToken, async (req: HolderRequest, res: Response) => {
    try {
      const holder = req.holder!;
      const [row] = await db
        .delete(equipmentItems)
        .where(and(eq(equipmentItems.id, Number(int(req.params.id, "id"))), eq(equipmentItems.holderId, holder.id)))
        .returning();
      if (!row) throw new NotFound("Not found");
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  /**
   * Submit the termly count.
   *
   * Body: { counts: [{ itemId, counted?: number|null, condition?, notes? }], notes? }
   *
   * 🔴 `counted` omitted or null is NOT COUNTED. It is stored as null, it does
   * not update the register, and it shows on the staff board as a blank rather
   * than a loss.
   *
   * 🔴 `quantityBefore` is frozen the FIRST time a line is counted in this
   * round, and is never rewritten by a later correction. Otherwise submitting,
   * then fixing a typo, would silently erase the variance the audit exists to
   * surface.
   *
   * The whole thing is one transaction: a half-applied audit — counts recorded
   * but quantities not moved, or the reverse — would be worse than no audit,
   * because it would look complete.
   */
  app.post("/api/public/equipment/me/audit", requireHolderToken, async (req: HolderRequest, res: Response) => {
    try {
      const holder = req.holder!;
      const round = await openRoundFor(holder.organizationId);
      if (!round) throw new BadRequest("There's no equipment check open at the moment.");

      const raw = Array.isArray(req.body?.counts) ? req.body.counts : [];
      const parsed = raw.map((c: any) => ({
        itemId: Number(int(c?.itemId, "itemId")),
        counted: c?.counted === null || c?.counted === undefined || c?.counted === "" ? null : nonNegInt(c.counted, "Count"),
        condition: (() => {
          const v = str(c?.condition);
          if (v !== null && !isEquipmentCondition(v)) throw new BadRequest("Unknown condition");
          return v;
        })(),
        notes: str(c?.notes),
      }));

      const result = await db.transaction(async tx => {
        const items = await tx.select().from(equipmentItems).where(eq(equipmentItems.holderId, holder.id));
        const byId = new Map(items.map(i => [i.id, i]));

        const [ret] = await tx
          .insert(equipmentAuditReturns)
          .values({
            organizationId: holder.organizationId,
            roundId: round.id,
            holderId: holder.id,
            submittedAt: new Date(),
            submittedByName: holder.personName,
            notes: str(req.body?.notes),
          })
          .onConflictDoUpdate({
            target: [equipmentAuditReturns.roundId, equipmentAuditReturns.holderId],
            set: { submittedAt: new Date(), notes: str(req.body?.notes), updatedAt: new Date() },
          })
          .returning();

        const existing = await tx
          .select()
          .from(equipmentAuditCounts)
          .where(eq(equipmentAuditCounts.returnId, ret.id));
        const existingByItem = new Map(existing.filter(c => c.itemId !== null).map(c => [c.itemId!, c]));

        let counted = 0;
        for (const line of parsed) {
          const item = byId.get(line.itemId);
          if (!item) continue; // A line for somebody else's item is ignored, not an error.
          const prior = existingByItem.get(item.id);
          // Frozen on first count; a re-submission keeps the original figure.
          const quantityBefore = prior?.quantityBefore ?? item.quantity;

          if (prior) {
            await tx
              .update(equipmentAuditCounts)
              .set({
                countedQuantity: line.counted,
                condition: line.condition,
                notes: line.notes,
                itemName: item.name,
                category: item.category,
                updatedAt: new Date(),
              })
              .where(eq(equipmentAuditCounts.id, prior.id));
          } else {
            await tx.insert(equipmentAuditCounts).values({
              organizationId: holder.organizationId,
              returnId: ret.id,
              itemId: item.id,
              itemName: item.name,
              category: item.category,
              quantityBefore,
              countedQuantity: line.counted,
              condition: line.condition,
              notes: line.notes,
            });
          }

          // The audit IS the new truth of what they hold — but only for lines
          // they actually counted.
          if (line.counted !== null) {
            counted++;
            await tx
              .update(equipmentItems)
              .set({
                quantity: line.counted,
                condition: line.condition ?? item.condition,
                updatedAt: new Date(),
              })
              .where(eq(equipmentItems.id, item.id));
          }
        }
        return { returnId: ret.id, counted, lines: parsed.length };
      });

      res.json({ ok: true, ...result });
    } catch (err) {
      fail(res, err);
    }
  });
}
