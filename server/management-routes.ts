// ─────────────────────────────────────────────────────────────────────────────
// MANAGEMENT — the planning workspace behind the "Management" tab (first home:
// United Prints). Projects → per-project workflow statuses → tasks, with
// checklists, finish-to-start dependencies (the Gantt arrows) and comments.
// Sibling of maintenance-routes.ts (same house style): admin only (session +
// the "management" tab), org-scoped via X-Workspace-Slug. No public surface.
//
//   GET    /api/admin/management/projects            POST /api/admin/management/projects
//   PATCH  /api/admin/management/projects/:id        DELETE (archives if it has tasks)
//   POST   /api/admin/management/projects/:id/statuses
//   PATCH  /api/admin/management/statuses/:id        DELETE ?moveTo= (refuses to strand tasks)
//   GET    /api/admin/management/tasks               POST /api/admin/management/tasks
//   PATCH  /api/admin/management/tasks/:id           DELETE /api/admin/management/tasks/:id
//   POST   /api/admin/management/tasks/:id/position  — board/table drag (status + index)
//   POST   /api/admin/management/tasks/:id/deps      DELETE /api/admin/management/deps/:id
//   POST   /api/admin/management/tasks/:id/checklist PATCH/DELETE .../checklist/:id
//   GET    /api/admin/management/tasks/:id/comments  POST — comment; DELETE .../comments/:id
//   GET    /api/admin/management/team                — workspace users for assignee pickers
//
// Doctrine: dates are bare YYYY-MM-DD strings, never round-tripped through a
// Date; every list response carries `today` (NZ) so the client never invents
// one; overdue is DERIVED client-side from that `today`; completed_at is
// stamped/cleared HERE on done-kind transitions, never trusted from the
// client; dependency cycles are refused before insert.
// ─────────────────────────────────────────────────────────────────────────────
import type { Express, Request, Response } from "express";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "./db";
import { requireAuth, requireTab } from "./auth";
import { storage } from "./storage";
import {
  organizations,
  planProjects, planStatuses, planTasks, planTaskDeps, planChecklistItems, planComments,
  planCollaborators,
} from "@shared/schema";
import {
  isProjectStatus, isStatusKind, isTaskPriority,
  isIsoDate, nzTodayIso, wouldCreateCycle,
  DEFAULT_STATUSES, PROJECT_COLORS,
  effectiveRole, roleAtLeast, isCollabRole, isProjectDefaultRole, type CollabRole,
} from "@shared/management";

// ── Small helpers (mirrors server/maintenance-routes.ts) ─────────────────────
const s = (v: any, max = 500): string => String(v ?? "").trim().slice(0, max);
const sOrNull = (v: any, max = 500): string | null => { const t = s(v, max); return t ? t : null; };
const truthy = (v: any) => v === true || v === "true" || v === "1";

const id = (v: any): number | null => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** id | null (explicit clear) | undefined (invalid). */
function idOrNull(v: any): number | null | undefined {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Accept only a bare `YYYY-MM-DD`; empty/omitted clears with allowNull. */
function isoDate(v: any, { allowNull = false } = {}): string | null | undefined {
  if (v === null || v === undefined || v === "") return allowNull ? null : undefined;
  const raw = s(v, 10);
  return isIsoDate(raw) ? raw : undefined;
}

/** progress: 0–100 whole number, or null to clear. */
function progressVal(v: any): number | null | undefined {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 100) return undefined;
  return n;
}

/** tags: array of trimmed non-empty strings, capped. */
function tagsVal(v: any): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const raw of v.slice(0, 20)) {
    const t = s(raw, 40);
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** A hex-ish colour token — permissive but bounded. */
function colorVal(v: any): string | undefined {
  const t = s(v, 20);
  return /^#[0-9a-fA-F]{3,8}$/.test(t) ? t : undefined;
}

class BadRequestErr extends Error {}
class NotFoundErr extends Error {}

// ── Org scoping (mirrors maintenance-routes.ts) ──────────────────────────────
async function workspaceOrg(req: Request): Promise<{ id: number; slug: string } | null> {
  const slug = String(req.headers["x-workspace-slug"] || "").trim();
  if (!slug) return null;
  const [org] = await db.select().from(organizations).where(eq(organizations.slug, slug));
  return org ? { id: org.id, slug: org.slug } : null;
}

async function orgOr400(req: Request, res: Response): Promise<{ id: number } | null> {
  const org = await workspaceOrg(req);
  if (!org) {
    res.status(400).json({ message: "X-Workspace-Slug header required" });
    return null;
  }
  return org;
}

const fail = (res: Response, e: any) => {
  console.error("[management]", e?.message || e);
  res.status(500).json({ message: e?.message || "Management request failed" });
};

async function sessionUser(req: Request): Promise<{ id: number; name: string | null } | null> {
  const userId = req.session.userId;
  if (!userId) return null;
  const user = await storage.getUser(userId).catch(() => null);
  if (!user) return null;
  const name = `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim();
  return { id: user.id, name: name || user.email || null };
}

/** start ≤ due whenever both are set — the Gantt bar guard. */
function datesOrdered(start: string | null, due: string | null): boolean {
  return !start || !due || start <= due;
}

// ── Per-project access (viewer < commenter < editor < admin) ─────────────────
// The tab grant gets someone through the door; WHAT they can touch in each
// project is decided here, by shared/management.ts effectiveRole — the same
// function the client uses to disable its buttons. Server-side is the gate;
// the client is just being polite.

async function sessionAccess(req: Request): Promise<{ userId: number; isSuper: boolean }> {
  const userId = req.session.userId!;
  const user = await storage.getUser(userId).catch(() => null);
  return { userId, isSuper: user?.role === "super_admin" };
}

/** Effective role per project for the whole org — one query each way. */
async function accessMap(req: Request, orgId: number): Promise<Map<number, CollabRole | "none">> {
  const { userId, isSuper } = await sessionAccess(req);
  const [projects, rows] = await Promise.all([
    db.select({ id: planProjects.id, createdBy: planProjects.createdBy, defaultRole: planProjects.defaultRole })
      .from(planProjects).where(eq(planProjects.organizationId, orgId)),
    db.select().from(planCollaborators)
      .where(and(eq(planCollaborators.organizationId, orgId), eq(planCollaborators.userId, userId))),
  ]);
  const mine = new Map(rows.map((r) => [r.projectId, r.role]));
  const map = new Map<number, CollabRole | "none">();
  for (const p of projects) {
    map.set(p.id, effectiveRole({
      isSuperAdmin: isSuper, userId,
      project: { createdBy: p.createdBy, defaultRole: p.defaultRole },
      collabRole: mine.get(p.id) ?? null,
    }));
  }
  return map;
}

/** Effective role on ONE project (mutation gates). "none" for missing projects
 *  too — a 403 must not reveal whether a hidden project exists. */
async function roleFor(req: Request, orgId: number, projectId: number): Promise<CollabRole | "none"> {
  const { userId, isSuper } = await sessionAccess(req);
  const [project] = await db.select().from(planProjects)
    .where(and(eq(planProjects.id, projectId), eq(planProjects.organizationId, orgId)));
  if (!project) return "none";
  const [row] = await db.select().from(planCollaborators)
    .where(and(eq(planCollaborators.projectId, projectId), eq(planCollaborators.userId, userId)));
  return effectiveRole({
    isSuperAdmin: isSuper, userId,
    project: { createdBy: project.createdBy, defaultRole: project.defaultRole },
    collabRole: row?.role ?? null,
  });
}

const forbid = (res: Response, need: string) =>
  res.status(403).json({ message: `You need ${need} access on this project` });

export function registerManagementRoutes(app: Express) {
  const tab = requireTab("management");

  // ── Projects (each returned with its status columns) ───────────────────────
  app.get("/api/admin/management/projects", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const includeArchived = truthy(req.query.includeArchived);

      const [allProjects, roles] = await Promise.all([
        db.select().from(planProjects)
          .where(includeArchived
            ? eq(planProjects.organizationId, org.id)
            : and(eq(planProjects.organizationId, org.id), sql`${planProjects.status} <> 'archived'`))
          .orderBy(asc(planProjects.sortOrder), asc(planProjects.id)),
        accessMap(req, org.id),
      ]);
      // A project you have no role on simply doesn't exist for you.
      const projects = allProjects.filter((p) => roles.get(p.id) !== "none");

      const [statuses, collaborators] = projects.length
        ? await Promise.all([
            db.select().from(planStatuses)
              .where(inArray(planStatuses.projectId, projects.map((p) => p.id)))
              .orderBy(asc(planStatuses.sortOrder), asc(planStatuses.id)),
            db.select().from(planCollaborators)
              .where(inArray(planCollaborators.projectId, projects.map((p) => p.id)))
              .orderBy(asc(planCollaborators.id)),
          ])
        : [[], []];

      res.json({
        today: nzTodayIso(),
        projects: projects.map((p) => ({
          ...p,
          statuses: statuses.filter((st) => st.projectId === p.id),
          collaborators: collaborators.filter((c) => c.projectId === p.id),
          myRole: roles.get(p.id) ?? "none",
        })),
      });
    } catch (e) { fail(res, e); }
  });

  // Creating a project seeds the default To do / In progress / Done columns in
  // the same transaction — a board with no columns can't hold a task.
  app.post("/api/admin/management/projects", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const name = s(req.body?.name, 160);
      if (!name) return res.status(400).json({ message: "Project name is required" });

      const startDate = isoDate(req.body?.startDate, { allowNull: true });
      if (startDate === undefined) return res.status(400).json({ message: "Start date must be YYYY-MM-DD" });
      const targetDate = isoDate(req.body?.targetDate, { allowNull: true });
      if (targetDate === undefined) return res.status(400).json({ message: "Target date must be YYYY-MM-DD" });
      if (!datesOrdered(startDate ?? null, targetDate ?? null)) {
        return res.status(400).json({ message: "Start date must be on or before the target date" });
      }

      const user = await sessionUser(req);

      const result = await db.transaction(async (tx) => {
        // Round-robin colour from the wheel unless the caller picked one.
        const existing = await tx.select({ id: planProjects.id }).from(planProjects)
          .where(eq(planProjects.organizationId, org.id));
        const color = colorVal(req.body?.color) ?? PROJECT_COLORS[existing.length % PROJECT_COLORS.length];

        const [project] = await tx.insert(planProjects).values({
          organizationId: org.id, name,
          description: sOrNull(req.body?.description, 4000),
          color,
          startDate: startDate ?? null,
          targetDate: targetDate ?? null,
          sortOrder: existing.length,
          createdBy: user?.id ?? null,
        }).returning();

        const statuses = await tx.insert(planStatuses).values(
          DEFAULT_STATUSES.map((d, i) => ({
            organizationId: org.id, projectId: project.id,
            label: d.label, color: d.color, kind: d.kind, sortOrder: i,
          })),
        ).returning();

        // The creator is always an explicit admin — belt to effectiveRole's
        // creator-braces, and it makes them visible in the people list.
        const collaborators = user
          ? await tx.insert(planCollaborators).values({
              organizationId: org.id, projectId: project.id,
              userId: user.id, role: "admin", addedBy: user.id,
            }).returning()
          : [];

        return { ...project, statuses, collaborators, myRole: "admin" as const };
      });

      res.status(201).json(result);
    } catch (e) { fail(res, e); }
  });

  app.patch("/api/admin/management/projects/:id", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const projectId = id(req.params.id);
      if (!projectId) return res.status(400).json({ message: "Bad id" });

      const [current] = await db.select().from(planProjects)
        .where(and(eq(planProjects.id, projectId), eq(planProjects.organizationId, org.id)));
      if (!current) return res.status(404).json({ message: "Project not found" });
      if (!roleAtLeast(await roleFor(req, org.id, projectId), "admin")) return forbid(res, "admin");

      const patch: Record<string, any> = { updatedAt: new Date() };
      if (req.body?.defaultRole !== undefined) {
        if (!isProjectDefaultRole(req.body.defaultRole)) return res.status(400).json({ message: "Unknown default role" });
        patch.defaultRole = req.body.defaultRole;
      }
      if (req.body?.name !== undefined) {
        const name = s(req.body.name, 160);
        if (!name) return res.status(400).json({ message: "Project name is required" });
        patch.name = name;
      }
      if (req.body?.description !== undefined) patch.description = sOrNull(req.body.description, 4000);
      if (req.body?.color !== undefined) {
        const c = colorVal(req.body.color);
        if (!c) return res.status(400).json({ message: "Colour must be a hex value like #6366f1" });
        patch.color = c;
      }
      if (req.body?.status !== undefined) {
        if (!isProjectStatus(req.body.status)) return res.status(400).json({ message: "Unknown project status" });
        patch.status = req.body.status;
      }
      if (req.body?.startDate !== undefined) {
        const v = isoDate(req.body.startDate, { allowNull: true });
        if (v === undefined) return res.status(400).json({ message: "Start date must be YYYY-MM-DD" });
        patch.startDate = v;
      }
      if (req.body?.targetDate !== undefined) {
        const v = isoDate(req.body.targetDate, { allowNull: true });
        if (v === undefined) return res.status(400).json({ message: "Target date must be YYYY-MM-DD" });
        patch.targetDate = v;
      }
      const nextStart = patch.startDate !== undefined ? patch.startDate : current.startDate;
      const nextTarget = patch.targetDate !== undefined ? patch.targetDate : current.targetDate;
      if (!datesOrdered(nextStart, nextTarget)) {
        return res.status(400).json({ message: "Start date must be on or before the target date" });
      }
      if (req.body?.sortOrder !== undefined) {
        const n = Number(req.body.sortOrder);
        if (!Number.isInteger(n) || n < 0) return res.status(400).json({ message: "Bad sort order" });
        patch.sortOrder = n;
      }

      const [row] = await db.update(planProjects).set(patch)
        .where(and(eq(planProjects.id, projectId), eq(planProjects.organizationId, org.id))).returning();
      res.json(row);
    } catch (e) { fail(res, e); }
  });

  // Deleting a project that has tasks ARCHIVES it instead — planning history
  // (what we said we'd do, and whether we did it) is a record, not clutter.
  app.delete("/api/admin/management/projects/:id", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const projectId = id(req.params.id);
      if (!projectId) return res.status(400).json({ message: "Bad id" });
      if (!roleAtLeast(await roleFor(req, org.id, projectId), "admin")) return forbid(res, "admin");

      const tasks = await db.select({ id: planTasks.id }).from(planTasks)
        .where(eq(planTasks.projectId, projectId));

      if (tasks.length > 0) {
        const [row] = await db.update(planProjects).set({ status: "archived", updatedAt: new Date() })
          .where(and(eq(planProjects.id, projectId), eq(planProjects.organizationId, org.id))).returning();
        if (!row) return res.status(404).json({ message: "Project not found" });
        return res.json({ archived: true, reason: `${tasks.length} task(s) kept` });
      }

      const [row] = await db.delete(planProjects)
        .where(and(eq(planProjects.id, projectId), eq(planProjects.organizationId, org.id))).returning();
      if (!row) return res.status(404).json({ message: "Project not found" });
      res.json({ deleted: true });
    } catch (e) { fail(res, e); }
  });

  // ── Status columns ──────────────────────────────────────────────────────────
  app.post("/api/admin/management/projects/:id/statuses", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const projectId = id(req.params.id);
      if (!projectId) return res.status(400).json({ message: "Bad id" });

      const [project] = await db.select().from(planProjects)
        .where(and(eq(planProjects.id, projectId), eq(planProjects.organizationId, org.id)));
      if (!project) return res.status(404).json({ message: "Project not found" });
      if (!roleAtLeast(await roleFor(req, org.id, projectId), "admin")) return forbid(res, "admin");

      const label = s(req.body?.label, 60);
      if (!label) return res.status(400).json({ message: "Column name is required" });
      const kind = s(req.body?.kind, 10) || "todo";
      if (!isStatusKind(kind)) return res.status(400).json({ message: "Unknown column kind" });

      const existing = await db.select({ sortOrder: planStatuses.sortOrder }).from(planStatuses)
        .where(eq(planStatuses.projectId, projectId))
        .orderBy(desc(planStatuses.sortOrder)).limit(1);

      const [row] = await db.insert(planStatuses).values({
        organizationId: org.id, projectId, label,
        color: colorVal(req.body?.color) ?? "#64748b",
        kind, sortOrder: (existing[0]?.sortOrder ?? -1) + 1,
      }).returning();
      res.status(201).json(row);
    } catch (e) { fail(res, e); }
  });

  app.patch("/api/admin/management/statuses/:id", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const statusId = id(req.params.id);
      if (!statusId) return res.status(400).json({ message: "Bad id" });

      const [existing] = await db.select().from(planStatuses)
        .where(and(eq(planStatuses.id, statusId), eq(planStatuses.organizationId, org.id)));
      if (!existing) return res.status(404).json({ message: "Column not found" });
      if (!roleAtLeast(await roleFor(req, org.id, existing.projectId), "admin")) return forbid(res, "admin");

      const patch: Record<string, any> = {};
      if (req.body?.label !== undefined) {
        const label = s(req.body.label, 60);
        if (!label) return res.status(400).json({ message: "Column name is required" });
        patch.label = label;
      }
      if (req.body?.color !== undefined) {
        const c = colorVal(req.body.color);
        if (!c) return res.status(400).json({ message: "Colour must be a hex value" });
        patch.color = c;
      }
      if (req.body?.kind !== undefined) {
        if (!isStatusKind(req.body.kind)) return res.status(400).json({ message: "Unknown column kind" });
        patch.kind = req.body.kind;
      }
      if (req.body?.sortOrder !== undefined) {
        const n = Number(req.body.sortOrder);
        if (!Number.isInteger(n) || n < 0) return res.status(400).json({ message: "Bad sort order" });
        patch.sortOrder = n;
      }
      if (!Object.keys(patch).length) return res.status(400).json({ message: "Nothing to update" });

      const [row] = await db.update(planStatuses).set(patch)
        .where(and(eq(planStatuses.id, statusId), eq(planStatuses.organizationId, org.id))).returning();
      if (!row) return res.status(404).json({ message: "Column not found" });
      res.json(row);
    } catch (e) { fail(res, e); }
  });

  // Deleting a column never strands tasks: with tasks present the request
  // must name a same-project ?moveTo= column; a project's last column can
  // never be deleted.
  app.delete("/api/admin/management/statuses/:id", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const statusId = id(req.params.id);
      if (!statusId) return res.status(400).json({ message: "Bad id" });

      const [status] = await db.select().from(planStatuses)
        .where(and(eq(planStatuses.id, statusId), eq(planStatuses.organizationId, org.id)));
      if (!status) return res.status(404).json({ message: "Column not found" });
      if (!roleAtLeast(await roleFor(req, org.id, status.projectId), "admin")) return forbid(res, "admin");

      const siblings = await db.select({ id: planStatuses.id }).from(planStatuses)
        .where(eq(planStatuses.projectId, status.projectId));
      if (siblings.length <= 1) return res.status(400).json({ message: "A project needs at least one column" });

      const moveTo = id(req.query.moveTo);

      await db.transaction(async (tx) => {
        const tasks = await tx.select({ id: planTasks.id }).from(planTasks)
          .where(eq(planTasks.statusId, statusId));

        if (tasks.length > 0) {
          if (!moveTo) throw new BadRequestErr("Pick a column to move this column's tasks to first");
          if (moveTo === statusId || !siblings.some((sb) => sb.id === moveTo)) {
            throw new BadRequestErr("Tasks can only move to another column in the same project");
          }
          await tx.update(planTasks).set({ statusId: moveTo, updatedAt: new Date() })
            .where(eq(planTasks.statusId, statusId));
        }

        await tx.delete(planStatuses).where(eq(planStatuses.id, statusId));
      });

      res.json({ deleted: true });
    } catch (e: any) {
      if (e instanceof BadRequestErr) return res.status(400).json({ message: e.message });
      fail(res, e);
    }
  });

  // ── Tasks ───────────────────────────────────────────────────────────────────
  // One payload carries every non-archived task in the workspace with its
  // checklist and inbound dependency edges — the views (board/table/calendar/
  // Gantt/My-Work) are all lenses over this one dataset.
  app.get("/api/admin/management/tasks", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const includeArchived = truthy(req.query.includeArchived);

      const [allOrgTasks, roles] = await Promise.all([
        db.select().from(planTasks)
          .where(includeArchived
            ? eq(planTasks.organizationId, org.id)
            : and(eq(planTasks.organizationId, org.id), eq(planTasks.archived, false)))
          .orderBy(asc(planTasks.sortOrder), asc(planTasks.id)),
        accessMap(req, org.id),
      ]);
      // Only tasks in projects the user can at least SEE.
      const tasks = allOrgTasks.filter((t) => roles.get(t.projectId) !== "none");

      const ids = tasks.map((t) => t.id);
      const [checklist, deps, commentCounts] = ids.length
        ? await Promise.all([
            db.select().from(planChecklistItems)
              .where(inArray(planChecklistItems.taskId, ids))
              .orderBy(asc(planChecklistItems.sortOrder), asc(planChecklistItems.id)),
            db.select().from(planTaskDeps)
              .where(eq(planTaskDeps.organizationId, org.id)),
            db.select({ taskId: planComments.taskId, n: sql<number>`count(*)::int` })
              .from(planComments)
              .where(inArray(planComments.taskId, ids))
              .groupBy(planComments.taskId),
          ])
        : [[], [], []];

      const countByTask = new Map(commentCounts.map((c) => [c.taskId, c.n]));
      const visible = new Set(ids);
      res.json({
        today: nzTodayIso(),
        tasks: tasks.map((t) => ({
          ...t,
          checklist: checklist.filter((c) => c.taskId === t.id),
          commentCount: countByTask.get(t.id) ?? 0,
        })),
        // An edge into a hidden project must not leak that project's tasks.
        deps: deps.filter((d) => visible.has(d.predecessorId) && visible.has(d.successorId)),
      });
    } catch (e) { fail(res, e); }
  });

  app.post("/api/admin/management/tasks", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const projectId = id(req.body?.projectId);
      if (!projectId) return res.status(400).json({ message: "projectId is required" });
      const title = s(req.body?.title, 300);
      if (!title) return res.status(400).json({ message: "Task title is required" });

      const [project] = await db.select().from(planProjects)
        .where(and(eq(planProjects.id, projectId), eq(planProjects.organizationId, org.id)));
      if (!project) return res.status(404).json({ message: "Project not found" });
      if (!roleAtLeast(await roleFor(req, org.id, projectId), "editor")) return forbid(res, "editor");

      const statuses = await db.select().from(planStatuses)
        .where(eq(planStatuses.projectId, projectId))
        .orderBy(asc(planStatuses.sortOrder), asc(planStatuses.id));
      if (!statuses.length) return res.status(400).json({ message: "Project has no columns" });

      let status = statuses[0];
      if (req.body?.statusId !== undefined) {
        const want = id(req.body.statusId);
        const found = statuses.find((st) => st.id === want);
        if (!found) return res.status(400).json({ message: "Column doesn't belong to this project" });
        status = found;
      }

      const priority = s(req.body?.priority, 10) || "medium";
      if (!isTaskPriority(priority)) return res.status(400).json({ message: "Unknown priority" });
      const startDate = isoDate(req.body?.startDate, { allowNull: true });
      if (startDate === undefined) return res.status(400).json({ message: "Start date must be YYYY-MM-DD" });
      const dueDate = isoDate(req.body?.dueDate, { allowNull: true });
      if (dueDate === undefined) return res.status(400).json({ message: "Due date must be YYYY-MM-DD" });
      if (!datesOrdered(startDate ?? null, dueDate ?? null)) {
        return res.status(400).json({ message: "Start date must be on or before the due date" });
      }
      const assigneeId = idOrNull(req.body?.assigneeId);
      if (assigneeId === undefined) return res.status(400).json({ message: "Bad assignee" });
      const progress = progressVal(req.body?.progress);
      if (progress === undefined) return res.status(400).json({ message: "Progress must be 0–100" });
      const tags = req.body?.tags !== undefined ? tagsVal(req.body.tags) : [];
      if (tags === undefined) return res.status(400).json({ message: "Tags must be a list of short labels" });

      const user = await sessionUser(req);

      // New tasks land at the bottom of their column.
      const last = await db.select({ sortOrder: planTasks.sortOrder }).from(planTasks)
        .where(eq(planTasks.statusId, status.id))
        .orderBy(desc(planTasks.sortOrder)).limit(1);

      const [row] = await db.insert(planTasks).values({
        organizationId: org.id, projectId, statusId: status.id, title,
        description: sOrNull(req.body?.description, 8000),
        priority, assigneeId: assigneeId ?? null,
        startDate: startDate ?? null, dueDate: dueDate ?? null,
        milestone: truthy(req.body?.milestone),
        progress, tags,
        sortOrder: (last[0]?.sortOrder ?? -1) + 1,
        completedAt: status.kind === "done" ? new Date() : null,
        createdBy: user?.id ?? null,
      }).returning();

      res.status(201).json({ ...row, checklist: [], commentCount: 0 });
    } catch (e) { fail(res, e); }
  });

  app.patch("/api/admin/management/tasks/:id", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const taskId = id(req.params.id);
      if (!taskId) return res.status(400).json({ message: "Bad id" });

      const [current] = await db.select().from(planTasks)
        .where(and(eq(planTasks.id, taskId), eq(planTasks.organizationId, org.id)));
      if (!current) return res.status(404).json({ message: "Task not found" });
      if (!roleAtLeast(await roleFor(req, org.id, current.projectId), "editor")) return forbid(res, "editor");

      const [currentStatus] = await db.select().from(planStatuses)
        .where(eq(planStatuses.id, current.statusId));

      const patch: Record<string, any> = { updatedAt: new Date() };

      // Moving project: the task needs a column in the target project — the
      // caller may name one, otherwise it lands in the target's first column.
      let targetProjectId = current.projectId;
      if (req.body?.projectId !== undefined) {
        const pid = id(req.body.projectId);
        if (!pid) return res.status(400).json({ message: "Bad project" });
        const [project] = await db.select().from(planProjects)
          .where(and(eq(planProjects.id, pid), eq(planProjects.organizationId, org.id)));
        if (!project) return res.status(404).json({ message: "Project not found" });
        if (!roleAtLeast(await roleFor(req, org.id, pid), "editor")) return forbid(res, "editor");
        targetProjectId = pid;
        patch.projectId = pid;
      }

      let nextStatus = currentStatus;
      const statusIdGiven = req.body?.statusId !== undefined;
      if (statusIdGiven || targetProjectId !== current.projectId) {
        const statuses = await db.select().from(planStatuses)
          .where(eq(planStatuses.projectId, targetProjectId))
          .orderBy(asc(planStatuses.sortOrder), asc(planStatuses.id));
        if (!statuses.length) return res.status(400).json({ message: "Project has no columns" });

        if (statusIdGiven) {
          const want = id(req.body.statusId);
          const found = statuses.find((st) => st.id === want);
          if (!found) return res.status(400).json({ message: "Column doesn't belong to this project" });
          nextStatus = found;
        } else {
          nextStatus = statuses[0];
        }
        patch.statusId = nextStatus.id;
      }

      // completed_at follows the done-kind transition, stamped here and only
      // here. Re-entering done never rewrites an existing stamp.
      if (nextStatus && currentStatus && nextStatus.kind !== currentStatus.kind) {
        if (nextStatus.kind === "done") patch.completedAt = current.completedAt ?? new Date();
        else patch.completedAt = null;
      } else if (nextStatus && !currentStatus && nextStatus.kind === "done") {
        patch.completedAt = current.completedAt ?? new Date();
      }

      if (req.body?.title !== undefined) {
        const title = s(req.body.title, 300);
        if (!title) return res.status(400).json({ message: "Task title is required" });
        patch.title = title;
      }
      if (req.body?.description !== undefined) patch.description = sOrNull(req.body.description, 8000);
      if (req.body?.priority !== undefined) {
        if (!isTaskPriority(req.body.priority)) return res.status(400).json({ message: "Unknown priority" });
        patch.priority = req.body.priority;
      }
      if (req.body?.assigneeId !== undefined) {
        const v = idOrNull(req.body.assigneeId);
        if (v === undefined) return res.status(400).json({ message: "Bad assignee" });
        patch.assigneeId = v;
      }
      if (req.body?.startDate !== undefined) {
        const v = isoDate(req.body.startDate, { allowNull: true });
        if (v === undefined) return res.status(400).json({ message: "Start date must be YYYY-MM-DD" });
        patch.startDate = v;
      }
      if (req.body?.dueDate !== undefined) {
        const v = isoDate(req.body.dueDate, { allowNull: true });
        if (v === undefined) return res.status(400).json({ message: "Due date must be YYYY-MM-DD" });
        patch.dueDate = v;
      }
      const nextStart = patch.startDate !== undefined ? patch.startDate : current.startDate;
      const nextDue = patch.dueDate !== undefined ? patch.dueDate : current.dueDate;
      if (!datesOrdered(nextStart, nextDue)) {
        return res.status(400).json({ message: "Start date must be on or before the due date" });
      }
      if (req.body?.milestone !== undefined) patch.milestone = truthy(req.body.milestone);
      if (req.body?.progress !== undefined) {
        const v = progressVal(req.body.progress);
        if (v === undefined) return res.status(400).json({ message: "Progress must be 0–100" });
        patch.progress = v;
      }
      if (req.body?.tags !== undefined) {
        const v = tagsVal(req.body.tags);
        if (v === undefined) return res.status(400).json({ message: "Tags must be a list of short labels" });
        patch.tags = v;
      }
      if (req.body?.archived !== undefined) patch.archived = truthy(req.body.archived);

      const [row] = await db.update(planTasks).set(patch)
        .where(and(eq(planTasks.id, taskId), eq(planTasks.organizationId, org.id))).returning();
      res.json(row);
    } catch (e) { fail(res, e); }
  });

  app.delete("/api/admin/management/tasks/:id", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const taskId = id(req.params.id);
      if (!taskId) return res.status(400).json({ message: "Bad id" });

      const [existing] = await db.select().from(planTasks)
        .where(and(eq(planTasks.id, taskId), eq(planTasks.organizationId, org.id)));
      if (!existing) return res.status(404).json({ message: "Task not found" });
      if (!roleAtLeast(await roleFor(req, org.id, existing.projectId), "editor")) return forbid(res, "editor");

      const [row] = await db.delete(planTasks)
        .where(and(eq(planTasks.id, taskId), eq(planTasks.organizationId, org.id))).returning();
      if (!row) return res.status(404).json({ message: "Task not found" });
      res.json({ deleted: true });
    } catch (e) { fail(res, e); }
  });

  // Board/table drag: place a task at `index` within `statusId`. The whole
  // column is resequenced 0..n in one transaction — columns are small, and a
  // full rewrite is race-safe where midpoint arithmetic eventually isn't.
  app.post("/api/admin/management/tasks/:id/position", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const taskId = id(req.params.id);
      if (!taskId) return res.status(400).json({ message: "Bad id" });
      const statusId = id(req.body?.statusId);
      if (!statusId) return res.status(400).json({ message: "statusId is required" });
      const index = Number(req.body?.index);
      if (!Number.isInteger(index) || index < 0) return res.status(400).json({ message: "Bad index" });

      const [target] = await db.select({ projectId: planTasks.projectId }).from(planTasks)
        .where(and(eq(planTasks.id, taskId), eq(planTasks.organizationId, org.id)));
      if (!target) return res.status(404).json({ message: "Task not found" });
      if (!roleAtLeast(await roleFor(req, org.id, target.projectId), "editor")) return forbid(res, "editor");

      const result = await db.transaction(async (tx) => {
        const [task] = await tx.select().from(planTasks)
          .where(and(eq(planTasks.id, taskId), eq(planTasks.organizationId, org.id)));
        if (!task) throw new NotFoundErr("Task not found");

        const [status] = await tx.select().from(planStatuses)
          .where(and(eq(planStatuses.id, statusId), eq(planStatuses.organizationId, org.id)));
        if (!status) throw new NotFoundErr("Column not found");
        if (status.projectId !== task.projectId) {
          throw new BadRequestErr("Tasks can only move between columns of the same project");
        }

        const column = await tx.select().from(planTasks)
          .where(and(eq(planTasks.statusId, statusId), eq(planTasks.archived, false)))
          .orderBy(asc(planTasks.sortOrder), asc(planTasks.id));

        const without = column.filter((t) => t.id !== taskId);
        const at = Math.min(index, without.length);
        const ordered = [...without.slice(0, at), task, ...without.slice(at)];

        for (let i = 0; i < ordered.length; i++) {
          const extra: Record<string, any> = { sortOrder: i };
          if (ordered[i].id === taskId) {
            extra.statusId = statusId;
            extra.updatedAt = new Date();
            const [currentStatus] = await tx.select().from(planStatuses)
              .where(eq(planStatuses.id, task.statusId));
            if (currentStatus && status.kind !== currentStatus.kind) {
              extra.completedAt = status.kind === "done" ? (task.completedAt ?? new Date()) : null;
            }
          }
          await tx.update(planTasks).set(extra).where(eq(planTasks.id, ordered[i].id));
        }

        const [row] = await tx.select().from(planTasks).where(eq(planTasks.id, taskId));
        return row;
      });

      res.json(result);
    } catch (e: any) {
      if (e instanceof NotFoundErr) return res.status(404).json({ message: e.message });
      if (e instanceof BadRequestErr) return res.status(400).json({ message: e.message });
      fail(res, e);
    }
  });

  // ── Dependencies ────────────────────────────────────────────────────────────
  app.post("/api/admin/management/tasks/:id/deps", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const successorId = id(req.params.id);
      const predecessorId = id(req.body?.predecessorId);
      if (!successorId || !predecessorId) return res.status(400).json({ message: "Bad task id" });
      if (successorId === predecessorId) return res.status(400).json({ message: "A task can't depend on itself" });

      const pair = await db.select().from(planTasks)
        .where(and(inArray(planTasks.id, [successorId, predecessorId]), eq(planTasks.organizationId, org.id)));
      if (pair.length !== 2) return res.status(404).json({ message: "Task not found" });
      const succ = pair.find((t) => t.id === successorId)!;
      if (!roleAtLeast(await roleFor(req, org.id, succ.projectId), "editor")) return forbid(res, "editor");

      // Cycle check over the workspace's whole edge set — refused before
      // insert, because a Gantt with a cycle in it can't be drawn honestly.
      const edges = await db.select().from(planTaskDeps).where(eq(planTaskDeps.organizationId, org.id));
      if (wouldCreateCycle(edges, predecessorId, successorId)) {
        return res.status(400).json({ message: "That would create a circular dependency" });
      }

      const [row] = await db.insert(planTaskDeps)
        .values({ organizationId: org.id, predecessorId, successorId })
        .onConflictDoNothing()
        .returning();
      if (!row) return res.status(409).json({ message: "That dependency already exists" });
      res.status(201).json(row);
    } catch (e) { fail(res, e); }
  });

  app.delete("/api/admin/management/deps/:id", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const depId = id(req.params.id);
      if (!depId) return res.status(400).json({ message: "Bad id" });

      const [edge] = await db.select().from(planTaskDeps)
        .where(and(eq(planTaskDeps.id, depId), eq(planTaskDeps.organizationId, org.id)));
      if (!edge) return res.status(404).json({ message: "Dependency not found" });
      const [succTask] = await db.select({ projectId: planTasks.projectId }).from(planTasks)
        .where(eq(planTasks.id, edge.successorId));
      if (succTask && !roleAtLeast(await roleFor(req, org.id, succTask.projectId), "editor")) return forbid(res, "editor");

      const [row] = await db.delete(planTaskDeps)
        .where(and(eq(planTaskDeps.id, depId), eq(planTaskDeps.organizationId, org.id))).returning();
      if (!row) return res.status(404).json({ message: "Dependency not found" });
      res.json({ deleted: true });
    } catch (e) { fail(res, e); }
  });

  // ── Checklist ───────────────────────────────────────────────────────────────
  app.post("/api/admin/management/tasks/:id/checklist", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const taskId = id(req.params.id);
      if (!taskId) return res.status(400).json({ message: "Bad id" });
      const title = s(req.body?.title, 300);
      if (!title) return res.status(400).json({ message: "Checklist item text is required" });

      const [task] = await db.select({ id: planTasks.id, projectId: planTasks.projectId }).from(planTasks)
        .where(and(eq(planTasks.id, taskId), eq(planTasks.organizationId, org.id)));
      if (!task) return res.status(404).json({ message: "Task not found" });
      if (!roleAtLeast(await roleFor(req, org.id, task.projectId), "editor")) return forbid(res, "editor");

      const assigneeId = idOrNull(req.body?.assigneeId);
      if (assigneeId === undefined) return res.status(400).json({ message: "Bad assignee" });

      const last = await db.select({ sortOrder: planChecklistItems.sortOrder }).from(planChecklistItems)
        .where(eq(planChecklistItems.taskId, taskId))
        .orderBy(desc(planChecklistItems.sortOrder)).limit(1);

      const [row] = await db.insert(planChecklistItems).values({
        organizationId: org.id, taskId, title,
        assigneeId: assigneeId ?? null,
        sortOrder: (last[0]?.sortOrder ?? -1) + 1,
      }).returning();
      res.status(201).json(row);
    } catch (e) { fail(res, e); }
  });

  app.patch("/api/admin/management/checklist/:id", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const itemId = id(req.params.id);
      if (!itemId) return res.status(400).json({ message: "Bad id" });

      const [item] = await db.select().from(planChecklistItems)
        .where(and(eq(planChecklistItems.id, itemId), eq(planChecklistItems.organizationId, org.id)));
      if (!item) return res.status(404).json({ message: "Checklist item not found" });
      const [itemTask] = await db.select({ projectId: planTasks.projectId }).from(planTasks)
        .where(eq(planTasks.id, item.taskId));
      if (itemTask && !roleAtLeast(await roleFor(req, org.id, itemTask.projectId), "editor")) return forbid(res, "editor");

      const patch: Record<string, any> = {};
      if (req.body?.title !== undefined) {
        const title = s(req.body.title, 300);
        if (!title) return res.status(400).json({ message: "Checklist item text is required" });
        patch.title = title;
      }
      if (req.body?.done !== undefined) patch.done = truthy(req.body.done);
      if (req.body?.assigneeId !== undefined) {
        const v = idOrNull(req.body.assigneeId);
        if (v === undefined) return res.status(400).json({ message: "Bad assignee" });
        patch.assigneeId = v;
      }
      if (req.body?.sortOrder !== undefined) {
        const n = Number(req.body.sortOrder);
        if (!Number.isInteger(n) || n < 0) return res.status(400).json({ message: "Bad sort order" });
        patch.sortOrder = n;
      }
      if (!Object.keys(patch).length) return res.status(400).json({ message: "Nothing to update" });

      const [row] = await db.update(planChecklistItems).set(patch)
        .where(and(eq(planChecklistItems.id, itemId), eq(planChecklistItems.organizationId, org.id))).returning();
      if (!row) return res.status(404).json({ message: "Checklist item not found" });
      res.json(row);
    } catch (e) { fail(res, e); }
  });

  app.delete("/api/admin/management/checklist/:id", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const itemId = id(req.params.id);
      if (!itemId) return res.status(400).json({ message: "Bad id" });

      const [item] = await db.select().from(planChecklistItems)
        .where(and(eq(planChecklistItems.id, itemId), eq(planChecklistItems.organizationId, org.id)));
      if (!item) return res.status(404).json({ message: "Checklist item not found" });
      const [itemTask] = await db.select({ projectId: planTasks.projectId }).from(planTasks)
        .where(eq(planTasks.id, item.taskId));
      if (itemTask && !roleAtLeast(await roleFor(req, org.id, itemTask.projectId), "editor")) return forbid(res, "editor");

      const [row] = await db.delete(planChecklistItems)
        .where(and(eq(planChecklistItems.id, itemId), eq(planChecklistItems.organizationId, org.id))).returning();
      if (!row) return res.status(404).json({ message: "Checklist item not found" });
      res.json({ deleted: true });
    } catch (e) { fail(res, e); }
  });

  // ── Comments ────────────────────────────────────────────────────────────────
  app.get("/api/admin/management/tasks/:id/comments", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const taskId = id(req.params.id);
      if (!taskId) return res.status(400).json({ message: "Bad id" });

      const [task] = await db.select({ id: planTasks.id, projectId: planTasks.projectId }).from(planTasks)
        .where(and(eq(planTasks.id, taskId), eq(planTasks.organizationId, org.id)));
      if (!task) return res.status(404).json({ message: "Task not found" });
      if (!roleAtLeast(await roleFor(req, org.id, task.projectId), "viewer")) return forbid(res, "viewer");

      const rows = await db.select().from(planComments)
        .where(eq(planComments.taskId, taskId))
        .orderBy(asc(planComments.createdAt), asc(planComments.id));
      res.json({ today: nzTodayIso(), comments: rows });
    } catch (e) { fail(res, e); }
  });

  app.post("/api/admin/management/tasks/:id/comments", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const taskId = id(req.params.id);
      if (!taskId) return res.status(400).json({ message: "Bad id" });
      const body = s(req.body?.body, 8000);
      if (!body) return res.status(400).json({ message: "Comment text is required" });

      const [task] = await db.select({ id: planTasks.id, projectId: planTasks.projectId }).from(planTasks)
        .where(and(eq(planTasks.id, taskId), eq(planTasks.organizationId, org.id)));
      if (!task) return res.status(404).json({ message: "Task not found" });
      if (!roleAtLeast(await roleFor(req, org.id, task.projectId), "commenter")) return forbid(res, "commenter");

      const user = await sessionUser(req);
      const [row] = await db.insert(planComments).values({
        organizationId: org.id, taskId, body,
        authorId: user?.id ?? null, authorName: user?.name ?? null,
      }).returning();
      res.status(201).json(row);
    } catch (e) { fail(res, e); }
  });

  app.delete("/api/admin/management/comments/:id", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const commentId = id(req.params.id);
      if (!commentId) return res.status(400).json({ message: "Bad id" });

      // Your own comment is yours to delete; anyone else's takes project admin.
      const [existing] = await db.select().from(planComments)
        .where(and(eq(planComments.id, commentId), eq(planComments.organizationId, org.id)));
      if (!existing) return res.status(404).json({ message: "Comment not found" });
      if (existing.authorId !== req.session.userId) {
        const [cTask] = await db.select({ projectId: planTasks.projectId }).from(planTasks)
          .where(eq(planTasks.id, existing.taskId));
        if (cTask && !roleAtLeast(await roleFor(req, org.id, cTask.projectId), "admin")) return forbid(res, "admin");
      }

      const [row] = await db.delete(planComments)
        .where(and(eq(planComments.id, commentId), eq(planComments.organizationId, org.id))).returning();
      if (!row) return res.status(404).json({ message: "Comment not found" });
      res.json({ deleted: true });
    } catch (e) { fail(res, e); }
  });

  // ── Collaborators (per-project people + roles; admin-gated) ────────────────
  app.post("/api/admin/management/projects/:id/collaborators", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const projectId = id(req.params.id);
      if (!projectId) return res.status(400).json({ message: "Bad id" });
      if (!roleAtLeast(await roleFor(req, org.id, projectId), "admin")) return forbid(res, "admin");

      const userId = id(req.body?.userId);
      if (!userId) return res.status(400).json({ message: "Pick a person" });
      const role = s(req.body?.role, 12) || "editor";
      if (!isCollabRole(role)) return res.status(400).json({ message: "Unknown role" });

      // Only people who are actually members of this workspace can be added —
      // a collaborator row must never grant someone their first door in.
      const member = await db.execute(sql`
        SELECT 1 FROM user_organizations WHERE user_id = ${userId} AND organization_id = ${org.id} LIMIT 1`);
      if (!member.rows.length) return res.status(400).json({ message: "That person isn't in this workspace — add them in Team first" });

      const { userId: me } = await sessionAccess(req);
      const [row] = await db.insert(planCollaborators)
        .values({ organizationId: org.id, projectId, userId, role, addedBy: me })
        .onConflictDoUpdate({
          target: [planCollaborators.projectId, planCollaborators.userId],
          set: { role },
        })
        .returning();
      res.status(201).json(row);
    } catch (e) { fail(res, e); }
  });

  app.patch("/api/admin/management/collaborators/:id", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const collabId = id(req.params.id);
      if (!collabId) return res.status(400).json({ message: "Bad id" });

      const [existing] = await db.select().from(planCollaborators)
        .where(and(eq(planCollaborators.id, collabId), eq(planCollaborators.organizationId, org.id)));
      if (!existing) return res.status(404).json({ message: "Collaborator not found" });
      if (!roleAtLeast(await roleFor(req, org.id, existing.projectId), "admin")) return forbid(res, "admin");

      if (!isCollabRole(req.body?.role)) return res.status(400).json({ message: "Unknown role" });
      const [row] = await db.update(planCollaborators).set({ role: req.body.role })
        .where(eq(planCollaborators.id, collabId)).returning();
      res.json(row);
    } catch (e) { fail(res, e); }
  });

  app.delete("/api/admin/management/collaborators/:id", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const collabId = id(req.params.id);
      if (!collabId) return res.status(400).json({ message: "Bad id" });

      const [existing] = await db.select().from(planCollaborators)
        .where(and(eq(planCollaborators.id, collabId), eq(planCollaborators.organizationId, org.id)));
      if (!existing) return res.status(404).json({ message: "Collaborator not found" });
      if (!roleAtLeast(await roleFor(req, org.id, existing.projectId), "admin")) return forbid(res, "admin");

      // Lockout is impossible by construction (super_admin and the project
      // creator are always effective admins), so removals are unrestricted.
      await db.delete(planCollaborators).where(eq(planCollaborators.id, collabId));
      res.json({ deleted: true });
    } catch (e) { fail(res, e); }
  });

  // ── Team (assignee pickers) ────────────────────────────────────────────────
  app.get("/api/admin/management/team", requireAuth, tab, async (req, res) => {
    try {
      const org = await orgOr400(req, res); if (!org) return;
      const rows = await db.execute(sql`
        SELECT u.id, u.first_name, u.last_name, u.email
        FROM users u
        JOIN user_organizations uo ON uo.user_id = u.id
        WHERE uo.organization_id = ${org.id} AND u.active = true
        ORDER BY u.first_name, u.last_name`);
      res.json(rows.rows);
    } catch (e) { fail(res, e); }
  });
}
