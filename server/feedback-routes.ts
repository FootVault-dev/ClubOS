// ─────────────────────────────────────────────────────────────────────────────
// Feature Requests / Bug Reports — the staff feedback board.
//
// A single, shared, club-wide backlog. ANY logged-in staff member (requireAuth)
// can submit a bug / feature / improvement and can read the whole list (so they
// can see it's already reported and what state it's in). Triage — changing a
// request's status / priority / notes, or deleting someone else's — is limited
// to managers (super_admin globally, or admin/manager in any workspace), the
// same "leadership" notion used elsewhere in routes.ts.
//
// Access is universal by design (every workspace shows the Feedback tab), so
// these endpoints are gated by requireAuth only — never requireTab.
// ─────────────────────────────────────────────────────────────────────────────
import type { Express } from "express";
import { eq, desc } from "drizzle-orm";
import { db } from "./db";
import { requireAuth } from "./auth";
import { storage } from "./storage";
import { featureRequests, users as usersTable } from "@shared/schema";

const TYPES = ["bug", "feature", "improvement"];
const STATUSES = ["new", "planned", "in_progress", "done", "declined"];
const PRIORITIES = ["low", "normal", "high", "urgent"];
const RESOLVED = new Set(["done", "declined"]);

// Manager = super_admin globally, OR admin/manager in any workspace they belong
// to. Mirrors the isLeadership check used by the global search in routes.ts.
async function isManagerUser(userId: number): Promise<boolean> {
  const user = await storage.getUser(userId);
  if (!user) return false;
  if (user.role === "super_admin") return true;
  const orgs = await storage.getUserOrganizations(userId);
  return (orgs as any[]).some((o) => o.userRole === "admin" || o.userRole === "manager");
}

const clean = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;

export function registerFeedbackRoutes(app: Express) {
  // ── List every request, newest first, with the submitter's name ────────────
  app.get("/api/admin/feedback", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const isManager = await isManagerUser(userId);
      const rows = await db
        .select({
          id: featureRequests.id,
          type: featureRequests.type,
          title: featureRequests.title,
          description: featureRequests.description,
          area: featureRequests.area,
          pageUrl: featureRequests.pageUrl,
          status: featureRequests.status,
          priority: featureRequests.priority,
          adminNotes: featureRequests.adminNotes,
          createdBy: featureRequests.createdBy,
          resolvedAt: featureRequests.resolvedAt,
          createdAt: featureRequests.createdAt,
          updatedAt: featureRequests.updatedAt,
          submitterFirst: usersTable.firstName,
          submitterLast: usersTable.lastName,
        })
        .from(featureRequests)
        .leftJoin(usersTable, eq(featureRequests.createdBy, usersTable.id))
        .orderBy(desc(featureRequests.createdAt));

      res.json({
        viewer: { userId, isManager },
        requests: rows.map((r) => ({
          ...r,
          submitterName:
            [r.submitterFirst, r.submitterLast].filter(Boolean).join(" ") || "Unknown",
          submitterFirst: undefined,
          submitterLast: undefined,
        })),
      });
    } catch (e: any) {
      console.error("[feedback] list failed:", e);
      res.status(500).json({ message: e.message });
    }
  });

  // ── Submit a new request (any logged-in staff member) ──────────────────────
  app.post("/api/admin/feedback", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const title = clean(req.body?.title);
      if (!title) return res.status(400).json({ message: "A short title is required" });
      const type = TYPES.includes(req.body?.type) ? req.body.type : "bug";
      const priority = PRIORITIES.includes(req.body?.priority) ? req.body.priority : "normal";

      const [created] = await db
        .insert(featureRequests)
        .values({
          type,
          title: title.slice(0, 200),
          description: clean(req.body?.description),
          area: clean(req.body?.area),
          pageUrl: clean(req.body?.pageUrl),
          priority,
          status: "new",
          createdBy: userId,
        })
        .returning();
      res.status(201).json(created);
    } catch (e: any) {
      console.error("[feedback] create failed:", e);
      res.status(500).json({ message: e.message });
    }
  });

  // ── Update a request. Managers can change anything; a submitter can edit the
  //    details of their OWN request while it's still 'new'. ────────────────────
  app.patch("/api/admin/feedback/:id", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ message: "Bad id" });

      const [existing] = await db
        .select()
        .from(featureRequests)
        .where(eq(featureRequests.id, id));
      if (!existing) return res.status(404).json({ message: "Request not found" });

      const isManager = await isManagerUser(userId);
      const isOwner = existing.createdBy === userId;
      if (!isManager && !(isOwner && existing.status === "new")) {
        return res.status(403).json({ message: "You can only edit your own new requests" });
      }

      const patch: Record<string, any> = { updatedAt: new Date() };

      // Fields anyone (owner or manager) may edit.
      if (req.body.type !== undefined && TYPES.includes(req.body.type)) patch.type = req.body.type;
      if (req.body.title !== undefined) {
        const t = clean(req.body.title);
        if (!t) return res.status(400).json({ message: "Title can't be blank" });
        patch.title = t.slice(0, 200);
      }
      if (req.body.description !== undefined) patch.description = clean(req.body.description) ?? null;
      if (req.body.area !== undefined) patch.area = clean(req.body.area) ?? null;
      if (req.body.pageUrl !== undefined) patch.pageUrl = clean(req.body.pageUrl) ?? null;

      // Triage fields — managers only.
      if (isManager) {
        if (req.body.priority !== undefined && PRIORITIES.includes(req.body.priority))
          patch.priority = req.body.priority;
        if (req.body.adminNotes !== undefined) patch.adminNotes = clean(req.body.adminNotes) ?? null;
        if (req.body.status !== undefined && STATUSES.includes(req.body.status)) {
          patch.status = req.body.status;
          if (RESOLVED.has(req.body.status)) {
            patch.resolvedBy = userId;
            patch.resolvedAt = new Date();
          } else {
            patch.resolvedBy = null;
            patch.resolvedAt = null;
          }
        }
      }

      const [updated] = await db
        .update(featureRequests)
        .set(patch)
        .where(eq(featureRequests.id, id))
        .returning();
      res.json(updated);
    } catch (e: any) {
      console.error("[feedback] update failed:", e);
      res.status(500).json({ message: e.message });
    }
  });

  // ── Delete. Managers can delete any; a submitter can delete their own. ──────
  app.delete("/api/admin/feedback/:id", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ message: "Bad id" });

      const [existing] = await db
        .select()
        .from(featureRequests)
        .where(eq(featureRequests.id, id));
      if (!existing) return res.status(404).json({ message: "Request not found" });

      const isManager = await isManagerUser(userId);
      if (!isManager && existing.createdBy !== userId) {
        return res.status(403).json({ message: "You can only delete your own requests" });
      }
      await db.delete(featureRequests).where(eq(featureRequests.id, id));
      res.json({ ok: true });
    } catch (e: any) {
      console.error("[feedback] delete failed:", e);
      res.status(500).json({ message: e.message });
    }
  });
}
