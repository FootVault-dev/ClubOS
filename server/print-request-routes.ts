// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL PRINT REQUESTS — club staff ask the print shop for something; Dima
// approves it into a real job, or declines it with a reason.
//
//   GET    /api/admin/print-requests          — the queue (tab-gated, org-scoped)
//   POST   /api/admin/print-requests          — submit one (anyone with the tab)
//   PATCH  /api/admin/print-requests/:id      — edit your own while it's `new`
//   PATCH  /api/admin/print-requests/:id/decide — approve | decline (DECIDERS ONLY)
//   DELETE /api/admin/print-requests/:id      — withdraw your own while it's `new`
//
// 🔴 The permission split is the whole point, and it rests on one fact about
// ClubOS: canAccessTab() grants EVERY tab to a member whose workspace role is
// admin or manager. So the tab whitelist cannot separate "can submit" from "can
// approve" — a submitter has to be a `team_member` with tabs ["requests"], and
// deciding has to be checked separately, server-side, on the workspace role.
// That is `canDecide()` below, and it is the only place that decision is made.
// ─────────────────────────────────────────────────────────────────────────────
import crypto from "crypto";
import type { Express, Request, Response } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "./db";
import { storage } from "./storage";
import { requireAuth, requireTab } from "./auth";
import {
  organizations,
  users,
  printRequests,
  printOrders,
  printOrderEvents,
} from "@shared/schema";
import { sendEmail } from "./email";

const UNITED_PRINTS_ORG_ID = 8;
const NOTIFY_EMAIL = "orders@unitedprints.co.nz";
const FROM = "United Prints <orders@unitedprints.co.nz>";

const s = (v: any, max = 2000): string => String(v ?? "").trim().slice(0, max);
const int = (v: any): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};

// The vocabularies the UI offers. Validated here so a typo can't create a
// request nobody can filter for, but kept as plain arrays — not DB enums.
const REQUEST_TYPES = ["banner", "corflute", "signage", "garment", "sticker_decal", "poster", "other"] as const;
const URGENCIES = ["standard", "urgent"] as const;
const BRANDS = ["CUFC", "SIU", "MFL", "CIC", "CUGC", "USC", "USG", "United Prints", "Other"] as const;

async function workspaceOrg(req: Request): Promise<{ id: number; slug: string } | null> {
  const slug = String(req.headers["x-workspace-slug"] || "").trim();
  if (!slug) return null;
  const [org] = await db.select().from(organizations).where(eq(organizations.slug, slug));
  return org ? { id: org.id, slug: org.slug } : null;
}

/**
 * May this person approve or decline?
 *
 * Super admin, or admin/manager of THIS workspace. A `team_member` — which is
 * what Travis and every other requester is — can submit and read, never decide.
 *
 * 🔴 Read from the database on every request, not from the session, so removing
 * someone's approval rights bites on their next click rather than their next
 * login. Same reasoning as the refund gate.
 */
async function canDecide(userId: number, orgId: number): Promise<boolean> {
  const user = await storage.getUser(userId);
  if (!user) return false;
  if (user.role === "super_admin") return true;
  const orgs = await storage.getUserOrganizations(userId);
  const membership = (orgs as any[]).find((o) => o.id === orgId);
  return !!membership && (membership.userRole === "admin" || membership.userRole === "manager");
}

function displayName(u?: { firstName?: string | null; lastName?: string | null; email?: string | null }): string {
  if (!u) return "Unknown";
  const n = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
  return n || u.email || "Unknown";
}

/** Garment lines, rebuilt field by field — the request body is never stored raw. */
function cleanGarmentLines(raw: any): { size: string; qty: number; name: string; number: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 60).map((g: any) => ({
    size: s(g?.size, 20),
    qty: int(g?.qty) ?? 1,
    name: s(g?.name, 60),
    number: s(g?.number, 10),
  })).filter((g) => g.size || g.name || g.number);
}

export function registerPrintRequestRoutes(app: Express) {
  const tab = requireTab("requests");

  // ── The queue ──────────────────────────────────────────────────────────────
  // Everyone with the tab sees the workspace's requests, not just their own:
  // it's a shared team queue, it stops two people asking for the same banner,
  // and there is nothing sensitive in it beyond staff names.
  app.get("/api/admin/print-requests", requireAuth, tab, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "X-Workspace-Slug header required" });

      const statusFilter = typeof req.query.status === "string" && req.query.status !== "all"
        ? req.query.status : undefined;
      const where = statusFilter
        ? and(eq(printRequests.organizationId, org.id), eq(printRequests.status, statusFilter))
        : eq(printRequests.organizationId, org.id);

      const rows = await db.select().from(printRequests).where(where).orderBy(desc(printRequests.createdAt));

      // Resolve names in one query, not one per row.
      const ids = Array.from(new Set(rows.flatMap((r) => [r.requesterUserId, r.decidedByUserId].filter(Boolean) as number[])));
      const people = ids.length ? await db.select().from(users).where(inArray(users.id, ids)) : [];
      const byId = new Map(people.map((p) => [p.id, p]));

      const me = req.session.userId!;
      res.json({
        requests: rows.map((r) => ({
          ...r,
          requesterName: displayName(byId.get(r.requesterUserId) as any),
          decidedByName: r.decidedByUserId ? displayName(byId.get(r.decidedByUserId) as any) : null,
          isMine: r.requesterUserId === me,
        })),
        // The client uses this to decide whether to draw Approve/Decline at
        // all. It is a courtesy for the UI — the server enforces it regardless.
        canDecide: await canDecide(me, org.id),
        vocab: { types: REQUEST_TYPES, urgencies: URGENCIES, brands: BRANDS },
      });
    } catch (e: any) {
      console.error("[print-requests] list failed:", e);
      res.status(500).json({ message: e.message });
    }
  });

  // ── Submit ─────────────────────────────────────────────────────────────────
  app.post("/api/admin/print-requests", requireAuth, tab, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "X-Workspace-Slug header required" });

      const b = req.body || {};
      const title = s(b.title, 200);
      const requestType = REQUEST_TYPES.includes(b.requestType) ? b.requestType : "other";
      if (!title) return res.status(400).json({ message: "Give the request a short title." });

      const garment = cleanGarmentLines(b.garmentDetails);
      // A garment request with named shirts already carries its own count; a
      // quantity typed on top of it would contradict the list.
      const quantity = garment.length
        ? garment.reduce((a, g) => a + g.qty, 0)
        : (int(b.quantity) ?? 1);

      const [row] = await db.insert(printRequests).values({
        organizationId: org.id,
        // 🔴 From the session, never the body. Nobody files a request as
        // somebody else.
        requesterUserId: req.session.userId!,
        status: "new",
        requestType,
        title,
        forBrand: BRANDS.includes(b.forBrand) ? b.forBrand : (s(b.forBrand, 40) || null),
        quantity,
        widthMm: int(b.widthMm),
        heightMm: int(b.heightMm),
        sizeNote: s(b.sizeNote, 200) || null,
        garmentDetailsJson: garment,
        printLocation: s(b.printLocation, 60) || null,
        details: s(b.details, 4000) || null,
        artworkUrl: s(b.artworkUrl, 600) || null,
        artworkNote: s(b.artworkNote, 500) || null,
        neededBy: s(b.neededBy, 10) || null,
        urgency: URGENCIES.includes(b.urgency) ? b.urgency : "standard",
      }).returning();

      // Best-effort: a queue nobody is told about is a queue nobody works.
      // Never let an email outage fail the request.
      try {
        const me = await storage.getUser(req.session.userId!);
        await sendEmail({
          to: NOTIFY_EMAIL,
          from: FROM,
          subject: `${row.urgency === "urgent" ? "URGENT — " : ""}Print request: ${row.title}`,
          html: `<p><strong>${displayName(me as any)}</strong> has submitted a print request.</p>
            <p><strong>${row.title}</strong><br/>
            Type: ${row.requestType}${row.forBrand ? ` · For: ${row.forBrand}` : ""}<br/>
            Quantity: ${row.quantity}${row.widthMm && row.heightMm ? ` · ${row.widthMm} × ${row.heightMm} mm` : ""}
            ${row.neededBy ? `<br/>Needed by: ${row.neededBy}` : ""}</p>
            ${row.details ? `<p>${String(row.details).replace(/</g, "&lt;")}</p>` : ""}
            <p><a href="https://app.usg.co.nz/admin/print-requests">Open it in ClubOS →</a></p>`,
        });
      } catch (e) {
        console.error("[print-requests] notify email failed:", e);
      }

      res.status(201).json(row);
    } catch (e: any) {
      console.error("[print-requests] create failed:", e);
      res.status(400).json({ message: e.message });
    }
  });

  // ── Edit / withdraw your own, while it's still unanswered ──────────────────
  app.patch("/api/admin/print-requests/:id", requireAuth, tab, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      const id = parseInt(String(req.params.id), 10);
      if (!org || !Number.isFinite(id)) return res.status(400).json({ message: "Bad request" });

      const [row] = await db.select().from(printRequests)
        .where(and(eq(printRequests.id, id), eq(printRequests.organizationId, org.id)));
      if (!row) return res.status(404).json({ message: "Not found" });

      const me = req.session.userId!;
      const decider = await canDecide(me, org.id);
      // A decider can tidy any request; a requester only their own, and only
      // before it has been answered — editing an approved job is what the Jobs
      // board is for.
      if (row.requesterUserId !== me && !decider) return res.status(404).json({ message: "Not found" });
      if (row.status !== "new" && !decider) {
        return res.status(409).json({ message: `This request has already been ${row.status}.` });
      }

      const b = req.body || {};
      const garment = b.garmentDetails !== undefined ? cleanGarmentLines(b.garmentDetails) : undefined;
      const patch: Record<string, any> = { updatedAt: new Date() };
      if (b.title !== undefined) patch.title = s(b.title, 200) || row.title;
      if (b.requestType !== undefined && REQUEST_TYPES.includes(b.requestType)) patch.requestType = b.requestType;
      if (b.forBrand !== undefined) patch.forBrand = s(b.forBrand, 40) || null;
      if (b.widthMm !== undefined) patch.widthMm = int(b.widthMm);
      if (b.heightMm !== undefined) patch.heightMm = int(b.heightMm);
      if (b.sizeNote !== undefined) patch.sizeNote = s(b.sizeNote, 200) || null;
      if (b.printLocation !== undefined) patch.printLocation = s(b.printLocation, 60) || null;
      if (b.details !== undefined) patch.details = s(b.details, 4000) || null;
      if (b.artworkUrl !== undefined) patch.artworkUrl = s(b.artworkUrl, 600) || null;
      if (b.artworkNote !== undefined) patch.artworkNote = s(b.artworkNote, 500) || null;
      if (b.neededBy !== undefined) patch.neededBy = s(b.neededBy, 10) || null;
      if (b.urgency !== undefined && URGENCIES.includes(b.urgency)) patch.urgency = b.urgency;
      if (garment !== undefined) {
        patch.garmentDetailsJson = garment;
        if (garment.length) patch.quantity = garment.reduce((a, g) => a + g.qty, 0);
      } else if (b.quantity !== undefined) {
        patch.quantity = int(b.quantity) ?? row.quantity;
      }
      // 🔴 status is not patchable here. Deciding has its own endpoint and its
      // own permission — otherwise a requester could approve their own job.
      const [updated] = await db.update(printRequests).set(patch)
        .where(and(eq(printRequests.id, id), eq(printRequests.organizationId, org.id))).returning();
      res.json(updated);
    } catch (e: any) {
      console.error("[print-requests] patch failed:", e);
      res.status(400).json({ message: e.message });
    }
  });

  app.delete("/api/admin/print-requests/:id", requireAuth, tab, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      const id = parseInt(String(req.params.id), 10);
      if (!org || !Number.isFinite(id)) return res.status(400).json({ message: "Bad request" });

      const [row] = await db.select().from(printRequests)
        .where(and(eq(printRequests.id, id), eq(printRequests.organizationId, org.id)));
      if (!row) return res.status(404).json({ message: "Not found" });

      const me = req.session.userId!;
      const decider = await canDecide(me, org.id);
      if (row.requesterUserId !== me && !decider) return res.status(404).json({ message: "Not found" });
      if (row.status === "approved") {
        return res.status(409).json({ message: "This one's already a job — cancel it on the Jobs board instead." });
      }
      await db.delete(printRequests).where(eq(printRequests.id, id));
      res.status(204).end();
    } catch (e: any) {
      console.error("[print-requests] delete failed:", e);
      res.status(500).json({ message: e.message });
    }
  });

  // ── Approve / decline ──────────────────────────────────────────────────────
  app.patch("/api/admin/print-requests/:id/decide", requireAuth, tab, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      const id = parseInt(String(req.params.id), 10);
      if (!org || !Number.isFinite(id)) return res.status(400).json({ message: "Bad request" });

      const me = req.session.userId!;
      if (!(await canDecide(me, org.id))) {
        return res.status(403).json({ message: "Only the print shop can approve or decline requests." });
      }

      const [row] = await db.select().from(printRequests)
        .where(and(eq(printRequests.id, id), eq(printRequests.organizationId, org.id)));
      if (!row) return res.status(404).json({ message: "Not found" });
      if (row.status !== "new") {
        return res.status(409).json({ message: `This request has already been ${row.status}.` });
      }

      const action = req.body?.action;

      if (action === "decline") {
        const [updated] = await db.update(printRequests).set({
          status: "declined",
          declineReason: s(req.body?.reason, 500) || null,
          decidedByUserId: me,
          decidedAt: new Date(),
          updatedAt: new Date(),
        }).where(eq(printRequests.id, id)).returning();

        try {
          const requester = await storage.getUser(row.requesterUserId);
          if (requester?.email) {
            await sendEmail({
              to: requester.email, from: FROM,
              subject: `Print request declined: ${row.title}`,
              html: `<p>Your print request <strong>${row.title}</strong> wasn't approved.</p>
                ${updated.declineReason ? `<p><strong>Reason:</strong> ${String(updated.declineReason).replace(/</g, "&lt;")}</p>` : ""}
                <p>Have a word with the print shop if you think it should go ahead.</p>`,
            });
          }
        } catch (e) { console.error("[print-requests] decline email failed:", e); }

        return res.json(updated);
      }

      if (action === "approve") {
        // Same order-number scheme as everywhere else — never invent one that
        // could collide.
        const existing = await db.select({ id: printOrders.id }).from(printOrders)
          .where(eq(printOrders.organizationId, org.id));
        const orderNumber = `UP-${new Date().getFullYear()}-${String(existing.length + 1).padStart(4, "0")}`;
        const magicLinkToken = crypto.randomBytes(24).toString("hex");
        const requester = await storage.getUser(row.requesterUserId);

        const sizeLine = row.widthMm && row.heightMm ? `${row.widthMm} × ${row.heightMm} mm` : (row.sizeNote || "");
        const garment = Array.isArray(row.garmentDetailsJson) ? (row.garmentDetailsJson as any[]) : [];
        const description = [
          row.details || "",
          sizeLine ? `Size: ${sizeLine}` : "",
          row.printLocation ? `Print location: ${row.printLocation}` : "",
          garment.length ? `Garments: ${garment.map((g) => `${g.size || "?"} ×${g.qty}${g.name ? ` ${g.name}` : ""}${g.number ? ` #${g.number}` : ""}`).join(", ")}` : "",
          row.artworkUrl ? `Artwork: ${row.artworkUrl}` : "",
        ].filter(Boolean).join("\n");

        const result = await db.transaction(async (tx) => {
          const [order] = await tx.insert(printOrders).values({
            organizationId: org.id,
            orderNumber,
            // An internal request is the club ordering from itself — the
            // "customer" is the brand it's for, and the requester is who to
            // chase. 🔴 amount stays 0: what an internal job costs is Dima's
            // call, and a made-up number would flow into the Jobs board totals.
            customerName: row.forBrand || "Internal request",
            customerEmail: requester?.email || null,
            customerPhone: null,
            title: row.title,
            description: description || null,
            // 🔴 "in_design", not "design". print_orders.status IS a real
            // pgEnum (unlike print_requests.status, which is text on purpose),
            // so an invalid value 500s the whole approve. The Jobs board's
            // Design column maps to in_design.
            status: "in_design",   // approved internal work starts at pre-press
            amount: "0.00",
            subtotalCents: 0, gstCents: 0, totalCents: 0, paidCents: 0,
            deliveryMethod: "pickup",
            magicLinkToken,
            dueDate: row.neededBy || null,
            notes: `Approved from internal print request #${row.id} (${displayName(requester as any)})`,
            createdBy: me,
          } as any).returning();

          await tx.insert(printOrderEvents).values({
            orderId: order.id,
            eventType: "created",
            notes: `Created from internal print request #${row.id}`,
            metadataJson: { printRequestId: row.id, requesterUserId: row.requesterUserId, requestType: row.requestType, urgency: row.urgency },
            createdBy: me,
          } as any);

          const [updated] = await tx.update(printRequests).set({
            status: "approved",
            printOrderId: order.id,
            decidedByUserId: me,
            decidedAt: new Date(),
            updatedAt: new Date(),
          }).where(eq(printRequests.id, id)).returning();

          return { order, updated };
        });

        try {
          if (requester?.email) {
            await sendEmail({
              to: requester.email, from: FROM,
              subject: `Print request approved: ${row.title}`,
              html: `<p>Your print request <strong>${row.title}</strong> has been approved and is now job <strong>${result.order.orderNumber}</strong>.</p>
                ${row.neededBy ? `<p>Needed by ${row.neededBy}.</p>` : ""}
                <p>The print shop will be in touch if they need anything else from you.</p>`,
            });
          }
        } catch (e) { console.error("[print-requests] approve email failed:", e); }

        return res.json({ ...result.updated, orderId: result.order.id, orderNumber: result.order.orderNumber });
      }

      return res.status(400).json({ message: 'action must be "approve" or "decline"' });
    } catch (e: any) {
      console.error("[print-requests] decide failed:", e);
      res.status(500).json({ message: "Couldn't record that decision. Nothing was changed." });
    }
  });
}
