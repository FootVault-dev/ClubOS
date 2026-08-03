// ─────────────────────────────────────────────────────────────────────────────
// TASK TRACKER — the organisation-wide project & task system.
//
// Access is UNIVERSAL by design: the tab shows in every workspace's System
// section, so these endpoints are gated by requireAuth only — never requireTab
// and never by workspace. Same pattern as Chat and Feedback.
//
// What a manager may do that a staff member may not:
//   • shape STRUCTURE — projects, areas, status columns
//   • edit or delete anyone's task
// Everyone else can create tasks freely and edit tasks they own, help on, or
// created. Manager-only task creation was explicitly ruled out: it recreates
// the "everything goes through one person" dynamic we are moving off WhatsApp.
//
// Query discipline: every list endpoint issues a FIXED number of queries
// regardless of row count. Never one query per row — `/api/admin/registrations`
// was reproducibly 500ing with EMAXCONNSESSION for exactly that reason, and
// prod runs two machines against a 15-connection pooler.
// ─────────────────────────────────────────────────────────────────────────────
import type { Express } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "./db";
import { requireAuth } from "./auth";
import { storage } from "./storage";
import {
  ttAreas,
  ttProjectStatuses,
  ttTaskStatuses,
  ttProjects,
  ttTasks,
  ttTaskAssignees,
  ttChecklistItems,
  ttComments,
  users as usersTable,
} from "@shared/schema";
import {
  nzToday,
  cleanText,
  cleanDate,
  cleanKeyList,
  isPriority,
  isProjectKind,
  isStatusKind,
  canEditTask,
  canDeleteTask,
  TT_BRAND_KEYS,
  brandKeyForOrgSlug,
  type ActorContext,
} from "@shared/task-tracker";

// ── Actor ────────────────────────────────────────────────────────────────────

/**
 * Manager = super_admin globally, or admin/manager in any workspace. Same
 * "leadership" notion the Feedback board and global search already use, so
 * Travis needs no new role to run this.
 */
async function isManagerUser(userId: number): Promise<boolean> {
  const user = await storage.getUser(userId);
  if (!user) return false;
  if (user.role === "super_admin") return true;
  const orgs = await storage.getUserOrganizations(userId);
  return (orgs as any[]).some((o) => o.userRole === "admin" || o.userRole === "manager");
}

async function actorFor(req: any): Promise<ActorContext> {
  const userId = req.session.userId as number;
  return { userId, isManager: await isManagerUser(userId) };
}

// ── Shared shapes ────────────────────────────────────────────────────────────

const personName = (first?: string | null, last?: string | null) =>
  `${first ?? ""} ${last ?? ""}`.trim() || null;

/**
 * Load every task matching a filter, plus its assignees and checklist counts,
 * in exactly THREE queries — one for the tasks, one for all their assignees,
 * one for all their checklist items. Never scales with row count.
 */
async function loadTasks(where: any) {
  const rows = await db
    .select({
      id: ttTasks.id,
      projectId: ttTasks.projectId,
      statusId: ttTasks.statusId,
      statusLabel: ttTaskStatuses.label,
      statusKind: ttTaskStatuses.kind,
      statusColor: ttTaskStatuses.color,
      title: ttTasks.title,
      description: ttTasks.description,
      priority: ttTasks.priority,
      ownerId: ttTasks.ownerId,
      ownerFirst: usersTable.firstName,
      ownerLast: usersTable.lastName,
      startDate: ttTasks.startDate,
      dueDate: ttTasks.dueDate,
      tags: ttTasks.tags,
      sortOrder: ttTasks.sortOrder,
      completedAt: ttTasks.completedAt,
      statusChangedAt: ttTasks.statusChangedAt,
      createdBy: ttTasks.createdBy,
      createdAt: ttTasks.createdAt,
      updatedAt: ttTasks.updatedAt,
    })
    .from(ttTasks)
    .innerJoin(ttTaskStatuses, eq(ttTasks.statusId, ttTaskStatuses.id))
    .leftJoin(usersTable, eq(ttTasks.ownerId, usersTable.id))
    .where(where);

  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  const assignees = await db
    .select({
      taskId: ttTaskAssignees.taskId,
      userId: ttTaskAssignees.userId,
      firstName: usersTable.firstName,
      lastName: usersTable.lastName,
    })
    .from(ttTaskAssignees)
    .innerJoin(usersTable, eq(ttTaskAssignees.userId, usersTable.id))
    .where(inArray(ttTaskAssignees.taskId, ids));

  const checklist = await db
    .select({
      taskId: ttChecklistItems.taskId,
      total: sql<number>`count(*)::int`,
      done: sql<number>`count(*) filter (where ${ttChecklistItems.done})::int`,
    })
    .from(ttChecklistItems)
    .where(inArray(ttChecklistItems.taskId, ids))
    .groupBy(ttChecklistItems.taskId);

  const byTask = new Map<number, Array<{ id: number; name: string | null }>>();
  for (const a of assignees) {
    const list = byTask.get(a.taskId) ?? [];
    list.push({ id: a.userId, name: personName(a.firstName, a.lastName) });
    byTask.set(a.taskId, list);
  }
  const checkByTask = new Map(checklist.map((c) => [c.taskId, c]));

  return rows.map((r) => {
    const c = checkByTask.get(r.id);
    return {
      ...r,
      ownerName: personName(r.ownerFirst, r.ownerLast),
      assignees: byTask.get(r.id) ?? [],
      checklistDone: c?.done ?? 0,
      checklistTotal: c?.total ?? 0,
    };
  });
}

// ── Registration ─────────────────────────────────────────────────────────────

export function registerTaskTrackerRoutes(app: Express) {
  const BASE = "/api/admin/task-tracker";

  // ── Bootstrap — everything the UI needs to render before any filtering ─────
  app.get(`${BASE}/bootstrap`, requireAuth, async (req, res) => {
    try {
      const actor = await actorFor(req);
      // The workspace the user is standing in, so the tab can open pre-filtered
      // to that brand. Purely a default — the data is never workspace-scoped.
      const orgSlug = (req.headers["x-workspace-slug"] as string) || null;

      const [areas, projectStatuses, taskStatuses, allUsers] = await Promise.all([
        db.select().from(ttAreas).where(eq(ttAreas.archived, false)).orderBy(ttAreas.sortOrder),
        db.select().from(ttProjectStatuses).orderBy(ttProjectStatuses.sortOrder),
        db.select().from(ttTaskStatuses).orderBy(ttTaskStatuses.sortOrder),
        storage.getAllUsers(),
      ]);

      const staff = (allUsers as any[])
        .filter((u) => u.active)
        .map((u) => ({ id: u.id, name: personName(u.firstName, u.lastName) }))
        .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "", "en-NZ"));

      res.json({
        today: nzToday(),
        me: { id: actor.userId, isManager: actor.isManager },
        defaultBrand: brandKeyForOrgSlug(orgSlug),
        areas,
        projectStatuses,
        taskStatuses,
        brands: TT_BRAND_KEYS,
        staff,
      });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // ── Projects ──────────────────────────────────────────────────────────────
  // Returns every live project with its owner and a DERIVED task rollup — the
  // "29/29" line. Two queries total: projects, then one grouped count over all
  // their tasks.
  app.get(`${BASE}/projects`, requireAuth, async (req, res) => {
    try {
      const includeArchived = req.query.archived === "1";
      const rows = await db
        .select({
          id: ttProjects.id,
          name: ttProjects.name,
          emoji: ttProjects.emoji,
          description: ttProjects.description,
          kind: ttProjects.kind,
          statusId: ttProjects.statusId,
          statusLabel: ttProjectStatuses.label,
          statusKind: ttProjectStatuses.kind,
          statusColor: ttProjectStatuses.color,
          ownerId: ttProjects.ownerId,
          ownerFirst: usersTable.firstName,
          ownerLast: usersTable.lastName,
          areas: ttProjects.areas,
          brands: ttProjects.brands,
          startDate: ttProjects.startDate,
          targetDate: ttProjects.targetDate,
          targetNote: ttProjects.targetNote,
          sortOrder: ttProjects.sortOrder,
          archived: ttProjects.archived,
          createdAt: ttProjects.createdAt,
          updatedAt: ttProjects.updatedAt,
        })
        .from(ttProjects)
        .innerJoin(ttProjectStatuses, eq(ttProjects.statusId, ttProjectStatuses.id))
        .leftJoin(usersTable, eq(ttProjects.ownerId, usersTable.id))
        .where(includeArchived ? sql`true` : eq(ttProjects.archived, false))
        .orderBy(ttProjects.sortOrder, ttProjects.id);

      // Task rollup per project, computed not stored.
      const counts = await db
        .select({
          projectId: ttTasks.projectId,
          total: sql<number>`count(*)::int`,
          done: sql<number>`count(*) filter (where ${ttTaskStatuses.kind} = 'done')::int`,
          overdue: sql<number>`count(*) filter (where ${ttTaskStatuses.kind} <> 'done' and ${ttTasks.dueDate} < ${nzToday()})::int`,
        })
        .from(ttTasks)
        .innerJoin(ttTaskStatuses, eq(ttTasks.statusId, ttTaskStatuses.id))
        .where(eq(ttTasks.archived, false))
        .groupBy(ttTasks.projectId);

      const byProject = new Map(counts.map((c) => [c.projectId, c]));

      res.json({
        today: nzToday(),
        projects: rows.map((r) => {
          const c = byProject.get(r.id);
          return {
            ...r,
            ownerName: personName(r.ownerFirst, r.ownerLast),
            taskTotal: c?.total ?? 0,
            taskDone: c?.done ?? 0,
            taskOverdue: c?.overdue ?? 0,
          };
        }),
      });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.post(`${BASE}/projects`, requireAuth, async (req, res) => {
    try {
      const actor = await actorFor(req);
      if (!actor.isManager) return res.status(403).json({ message: "Only managers can create projects" });

      const name = cleanText(req.body?.name);
      if (!name) return res.status(400).json({ message: "A name is required" });

      const kind = isProjectKind(req.body?.kind) ? req.body.kind : "project";
      const statusId = Number(req.body?.statusId);
      if (!Number.isInteger(statusId)) return res.status(400).json({ message: "A status is required" });

      const [created] = await db
        .insert(ttProjects)
        .values({
          name,
          emoji: cleanText(req.body?.emoji),
          description: cleanText(req.body?.description),
          kind,
          statusId,
          ownerId: Number.isInteger(Number(req.body?.ownerId)) ? Number(req.body.ownerId) : null,
          areas: cleanKeyList(req.body?.areas),
          brands: cleanKeyList(req.body?.brands, TT_BRAND_KEYS),
          startDate: cleanDate(req.body?.startDate),
          targetDate: cleanDate(req.body?.targetDate),
          targetNote: cleanText(req.body?.targetNote),
          createdBy: actor.userId,
        })
        .returning();

      res.status(201).json(created);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.patch(`${BASE}/projects/:id`, requireAuth, async (req, res) => {
    try {
      const actor = await actorFor(req);
      if (!actor.isManager) return res.status(403).json({ message: "Only managers can edit projects" });

      const id = Number(req.params.id);
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      const b = req.body ?? {};

      if ("name" in b) {
        const name = cleanText(b.name);
        if (!name) return res.status(400).json({ message: "A name is required" });
        patch.name = name;
      }
      if ("emoji" in b) patch.emoji = cleanText(b.emoji);
      if ("description" in b) patch.description = cleanText(b.description);
      if ("kind" in b && isProjectKind(b.kind)) patch.kind = b.kind;
      if ("statusId" in b && Number.isInteger(Number(b.statusId))) patch.statusId = Number(b.statusId);
      if ("ownerId" in b) patch.ownerId = Number.isInteger(Number(b.ownerId)) ? Number(b.ownerId) : null;
      if ("areas" in b) patch.areas = cleanKeyList(b.areas);
      if ("brands" in b) patch.brands = cleanKeyList(b.brands, TT_BRAND_KEYS);
      if ("startDate" in b) patch.startDate = cleanDate(b.startDate);
      if ("targetDate" in b) patch.targetDate = cleanDate(b.targetDate);
      if ("targetNote" in b) patch.targetNote = cleanText(b.targetNote);
      if ("archived" in b) patch.archived = !!b.archived;
      if ("sortOrder" in b && Number.isInteger(Number(b.sortOrder))) patch.sortOrder = Number(b.sortOrder);

      const [updated] = await db.update(ttProjects).set(patch).where(eq(ttProjects.id, id)).returning();
      if (!updated) return res.status(404).json({ message: "Project not found" });
      res.json(updated);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  /**
   * Delete a project — but ARCHIVE it instead if it still holds tasks.
   * Planning history is a record: the fact that we ran a campaign and what it
   * involved outlives our interest in the campaign. (The FK is SET NULL, so
   * even a forced delete would orphan rather than destroy tasks — this is the
   * intentional layer above that.)
   */
  app.delete(`${BASE}/projects/:id`, requireAuth, async (req, res) => {
    try {
      const actor = await actorFor(req);
      if (!actor.isManager) return res.status(403).json({ message: "Only managers can delete projects" });

      const id = Number(req.params.id);
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(ttTasks)
        .where(eq(ttTasks.projectId, id));

      if (count > 0) {
        const [archived] = await db
          .update(ttProjects)
          .set({ archived: true, updatedAt: new Date() })
          .where(eq(ttProjects.id, id))
          .returning();
        if (!archived) return res.status(404).json({ message: "Project not found" });
        return res.json({ archived: true, taskCount: count });
      }

      await db.delete(ttProjects).where(eq(ttProjects.id, id));
      res.json({ deleted: true });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // ── Tasks ─────────────────────────────────────────────────────────────────
  app.get(`${BASE}/tasks`, requireAuth, async (req, res) => {
    try {
      const includeArchived = req.query.archived === "1";
      const tasks = await loadTasks(includeArchived ? sql`true` : eq(ttTasks.archived, false));
      res.json({ today: nzToday(), tasks });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.post(`${BASE}/tasks`, requireAuth, async (req, res) => {
    try {
      const actor = await actorFor(req);
      const title = cleanText(req.body?.title);
      if (!title) return res.status(400).json({ message: "A title is required" });

      const statusId = Number(req.body?.statusId);
      if (!Number.isInteger(statusId)) return res.status(400).json({ message: "A status is required" });

      const projectId = Number.isInteger(Number(req.body?.projectId)) ? Number(req.body.projectId) : null;
      const priority = isPriority(req.body?.priority) ? req.body.priority : "medium";

      const [created] = await db
        .insert(ttTasks)
        .values({
          projectId,
          statusId,
          title,
          description: cleanText(req.body?.description),
          priority,
          ownerId: Number.isInteger(Number(req.body?.ownerId)) ? Number(req.body.ownerId) : null,
          startDate: cleanDate(req.body?.startDate),
          dueDate: cleanDate(req.body?.dueDate),
          tags: cleanKeyList(req.body?.tags),
          createdBy: actor.userId,
        })
        .returning();

      await syncAssignees(created.id, req.body?.assigneeIds);
      const [full] = await loadTasks(eq(ttTasks.id, created.id));
      res.status(201).json(full);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.patch(`${BASE}/tasks/:id`, requireAuth, async (req, res) => {
    try {
      const actor = await actorFor(req);
      const id = Number(req.params.id);

      const [existing] = await loadTasks(eq(ttTasks.id, id));
      if (!existing) return res.status(404).json({ message: "Task not found" });

      if (!canEditTask(actor, {
        ownerId: existing.ownerId,
        createdBy: existing.createdBy,
        assigneeIds: existing.assignees.map((a) => a.id),
      })) {
        return res.status(403).json({ message: "You can only change tasks you own, help with, or created" });
      }

      const b = req.body ?? {};
      const patch: Record<string, unknown> = { updatedAt: new Date() };

      if ("title" in b) {
        const title = cleanText(b.title);
        if (!title) return res.status(400).json({ message: "A title is required" });
        patch.title = title;
      }
      if ("description" in b) patch.description = cleanText(b.description);
      if ("priority" in b && isPriority(b.priority)) patch.priority = b.priority;
      if ("ownerId" in b) patch.ownerId = Number.isInteger(Number(b.ownerId)) ? Number(b.ownerId) : null;
      if ("projectId" in b) patch.projectId = Number.isInteger(Number(b.projectId)) ? Number(b.projectId) : null;
      if ("startDate" in b) patch.startDate = cleanDate(b.startDate);
      if ("dueDate" in b) patch.dueDate = cleanDate(b.dueDate);
      if ("tags" in b) patch.tags = cleanKeyList(b.tags);
      if ("archived" in b) patch.archived = !!b.archived;
      if ("sortOrder" in b && Number.isInteger(Number(b.sortOrder))) patch.sortOrder = Number(b.sortOrder);

      // Status transitions are stamped server-side. The client never sends
      // completedAt — a browser clock is not a source of truth, and letting it
      // write completion times makes "done last week" unauditable.
      if ("statusId" in b && Number.isInteger(Number(b.statusId)) && Number(b.statusId) !== existing.statusId) {
        const newStatusId = Number(b.statusId);
        const [status] = await db
          .select({ kind: ttTaskStatuses.kind })
          .from(ttTaskStatuses)
          .where(eq(ttTaskStatuses.id, newStatusId));
        if (!status) return res.status(400).json({ message: "Unknown status" });

        patch.statusId = newStatusId;
        patch.statusChangedAt = new Date();

        const wasDone = existing.statusKind === "done";
        const nowDone = status.kind === "done";
        // Entering done stamps the time; leaving clears it. Re-entering a task
        // that already carries a stamp never rewrites it — the first completion
        // is the one that happened.
        if (nowDone && !wasDone && !existing.completedAt) patch.completedAt = new Date();
        if (!nowDone && wasDone) patch.completedAt = null;
      }

      await db.update(ttTasks).set(patch).where(eq(ttTasks.id, id));
      if ("assigneeIds" in b) await syncAssignees(id, b.assigneeIds);

      const [full] = await loadTasks(eq(ttTasks.id, id));
      res.json(full);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.delete(`${BASE}/tasks/:id`, requireAuth, async (req, res) => {
    try {
      const actor = await actorFor(req);
      const id = Number(req.params.id);
      const [existing] = await db
        .select({ createdBy: ttTasks.createdBy })
        .from(ttTasks)
        .where(eq(ttTasks.id, id));
      if (!existing) return res.status(404).json({ message: "Task not found" });

      if (!canDeleteTask(actor, { createdBy: existing.createdBy })) {
        return res.status(403).json({ message: "You can only delete tasks you created" });
      }
      await db.delete(ttTasks).where(eq(ttTasks.id, id));
      res.json({ deleted: true });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // ── The accountability rollup — Travis's view ─────────────────────────────
  //
  // Per-person: open / overdue / due this week / stale / completed in the last
  // 7 days. Deliberately built on task COUNTS, not hours: non-technical staff
  // will not maintain time estimates, and a capacity model nobody feeds is
  // worse than no capacity model at all.
  //
  // Deliberately NOT here: a manually-set RAG traffic light. A status colour
  // somebody types is an opinion, and rollups of opinions launder bad news into
  // comfortable amber. Everything below is computed from dates and status kind.
  app.get(`${BASE}/team`, requireAuth, async (_req, res) => {
    try {
      const today = nzToday();
      const rows = await db
        .select({
          userId: ttTasks.ownerId,
          firstName: usersTable.firstName,
          lastName: usersTable.lastName,
          statusKind: ttTaskStatuses.kind,
          dueDate: ttTasks.dueDate,
          statusChangedAt: ttTasks.statusChangedAt,
          completedAt: ttTasks.completedAt,
        })
        .from(ttTasks)
        .innerJoin(ttTaskStatuses, eq(ttTasks.statusId, ttTaskStatuses.id))
        .leftJoin(usersTable, eq(ttTasks.ownerId, usersTable.id))
        .where(eq(ttTasks.archived, false));

      res.json({ today, rows });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // ── Comments ──────────────────────────────────────────────────────────────
  app.get(`${BASE}/tasks/:id/comments`, requireAuth, async (req, res) => {
    try {
      const rows = await db
        .select()
        .from(ttComments)
        .where(eq(ttComments.taskId, Number(req.params.id)))
        .orderBy(desc(ttComments.createdAt));
      res.json(rows);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.post(`${BASE}/tasks/:id/comments`, requireAuth, async (req, res) => {
    try {
      const actor = await actorFor(req);
      const body = cleanText(req.body?.body);
      if (!body) return res.status(400).json({ message: "Write something first" });
      const user = await storage.getUser(actor.userId);
      const [created] = await db
        .insert(ttComments)
        .values({
          taskId: Number(req.params.id),
          authorId: actor.userId,
          authorName: personName(user?.firstName, user?.lastName),
          body,
        })
        .returning();
      res.status(201).json(created);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // ── Checklist ─────────────────────────────────────────────────────────────
  app.get(`${BASE}/tasks/:id/checklist`, requireAuth, async (req, res) => {
    try {
      const rows = await db
        .select()
        .from(ttChecklistItems)
        .where(eq(ttChecklistItems.taskId, Number(req.params.id)))
        .orderBy(ttChecklistItems.sortOrder, ttChecklistItems.id);
      res.json(rows);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.post(`${BASE}/tasks/:id/checklist`, requireAuth, async (req, res) => {
    try {
      const title = cleanText(req.body?.title);
      if (!title) return res.status(400).json({ message: "A title is required" });
      const [created] = await db
        .insert(ttChecklistItems)
        .values({ taskId: Number(req.params.id), title, sortOrder: Number(req.body?.sortOrder) || 0 })
        .returning();
      res.status(201).json(created);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.patch(`${BASE}/checklist/:itemId`, requireAuth, async (req, res) => {
    try {
      const patch: Record<string, unknown> = {};
      if ("done" in (req.body ?? {})) patch.done = !!req.body.done;
      if ("title" in (req.body ?? {})) {
        const title = cleanText(req.body.title);
        if (title) patch.title = title;
      }
      const [updated] = await db
        .update(ttChecklistItems)
        .set(patch)
        .where(eq(ttChecklistItems.id, Number(req.params.itemId)))
        .returning();
      if (!updated) return res.status(404).json({ message: "Item not found" });
      res.json(updated);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.delete(`${BASE}/checklist/:itemId`, requireAuth, async (req, res) => {
    try {
      await db.delete(ttChecklistItems).where(eq(ttChecklistItems.id, Number(req.params.itemId)));
      res.json({ deleted: true });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // ── Areas (structure — managers only) ─────────────────────────────────────
  app.post(`${BASE}/areas`, requireAuth, async (req, res) => {
    try {
      const actor = await actorFor(req);
      if (!actor.isManager) return res.status(403).json({ message: "Only managers can add areas" });
      const label = cleanText(req.body?.label);
      if (!label) return res.status(400).json({ message: "A label is required" });
      const key = (cleanText(req.body?.key) ?? label).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const [created] = await db
        .insert(ttAreas)
        .values({ key, label, color: cleanText(req.body?.color) ?? "#6366f1", sortOrder: Number(req.body?.sortOrder) || 0 })
        .returning();
      res.status(201).json(created);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Replace a task's helper list. Two statements, never one-per-person.
 * The owner is a column on the task and is NOT duplicated here — "who is
 * accountable" and "who else is on it" are different questions.
 */
async function syncAssignees(taskId: number, raw: unknown): Promise<void> {
  if (!Array.isArray(raw)) return;
  const ids = Array.from(
    new Set(raw.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0)),
  );
  await db.delete(ttTaskAssignees).where(eq(ttTaskAssignees.taskId, taskId));
  if (ids.length === 0) return;
  await db.insert(ttTaskAssignees).values(ids.map((userId) => ({ taskId, userId })));
}
