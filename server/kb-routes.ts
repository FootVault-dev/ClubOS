// ─────────────────────────────────────────────────────────────────────────────
// Knowledge Base routes — the vault, plus Rambo.
//
// Universal tab (same as Chat, Feedback, Task Tracker), so every endpoint is
// gated by requireAuth only, never requireTab. Visibility inside the tab is per
// ARTICLE: most are open to all staff, and one that carries a `requiredTab` is
// judged by the same decider Rambo's tools use.
// ─────────────────────────────────────────────────────────────────────────────
import type { Express } from "express";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "./db";
import { requireAuth } from "./auth";
import { storage } from "./storage";
import {
  kbAccessLog,
  kbArticleRevisions,
  kbArticles,
  kbChatMessages,
  kbChatSessions,
  users as usersTable,
} from "@shared/schema";
import {
  KB_BRANDS,
  KB_CATEGORY_SUGGESTIONS,
  KB_STATUSES,
  isKbBrand,
  RAMBO_TOOLS,
  ramboToolsFor,
  viewerCanReachTab,
  viewerCanReadArticle,
  type Viewer,
} from "@shared/knowledge-base";
import { askRambo, buildViewer } from "./rambo";

const clean = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;

/** Leadership — matches the Feedback board's notion exactly. */
async function isManagerUser(userId: number): Promise<boolean> {
  const user = await storage.getUser(userId);
  if (!user) return false;
  if (user.role === "super_admin") return true;
  const orgs = await storage.getUserOrganizations(userId);
  return (orgs as any[]).some((o) => o.userRole === "admin" || o.userRole === "manager");
}

/**
 * May this person set (or clear) an article's `requiredTab`?
 *
 * 🔴 The dangerous direction is UN-gating: a team member editing a restricted
 * article and removing its lock would publish it to every staff member. So
 * changing the gate requires being able to reach BOTH the old gate and the new
 * one. You cannot open a door you were never behind.
 */
function mayChangeGate(viewer: Viewer, from: string | null, to: string | null, fromWs?: string | null, toWs?: string | null): boolean {
  if (from === to) return true;
  if (from && !viewerCanReachTab(viewer, from, fromWs ?? undefined).allowed) return false;
  if (to && !viewerCanReachTab(viewer, to, toWs ?? undefined).allowed) return false;
  return true;
}

export function registerKnowledgeBaseRoutes(app: Express) {
  // ── Who am I, what can I see ──────────────────────────────────────────────
  app.get("/api/admin/kb/bootstrap", requireAuth, async (req, res) => {
    try {
      const viewer = await buildViewer(req.session.userId!);
      if (!viewer) return res.status(401).json({ message: "Not signed in" });
      const isManager = await isManagerUser(viewer.userId);
      const allowed = ramboToolsFor(viewer);

      const categories = await db
        .selectDistinct({ category: kbArticles.category })
        .from(kbArticles)
        .where(sql`${kbArticles.category} is not null`);

      res.json({
        viewer: { userId: viewer.userId, name: viewer.name, isManager, isSuperAdmin: viewer.globalRole === "super_admin" },
        brands: KB_BRANDS,
        statuses: KB_STATUSES,
        categorySuggestions: Array.from(
          new Set([...KB_CATEGORY_SUGGESTIONS, ...categories.map((c) => c.category!).filter(Boolean)]),
        ).sort(),
        // Honest about the boundary rather than hiding it: showing people what
        // Rambo can and cannot reach for them is the difference between a
        // system that feels trustworthy and one that feels like it is hiding
        // something. It reveals nothing their own sidebar doesn't.
        rambo: {
          enabled: Boolean(process.env.ANTHROPIC_API_KEY),
          canSee: allowed.map((t) => ({ name: t.name, title: t.title })),
          cannotSee: RAMBO_TOOLS.filter((t) => !allowed.some((a) => a.name === t.name)).map((t) => ({
            name: t.name,
            title: t.title,
            requiredTab: t.requiredTab,
          })),
        },
      });
    } catch (e: any) {
      console.error("[kb] bootstrap failed:", e);
      res.status(500).json({ message: e.message });
    }
  });

  // ── Browse / search articles ──────────────────────────────────────────────
  app.get("/api/admin/kb/articles", requireAuth, async (req, res) => {
    try {
      const viewer = await buildViewer(req.session.userId!);
      if (!viewer) return res.status(401).json({ message: "Not signed in" });

      const brand = typeof req.query.brand === "string" ? req.query.brand : "all";
      const q = clean(req.query.q);
      const category = clean(req.query.category);
      const includeDrafts = req.query.includeDrafts === "1";

      const conds: any[] = [];
      if (!includeDrafts) conds.push(eq(kbArticles.status, "published"));
      else conds.push(sql`${kbArticles.status} <> 'archived'`);
      if (brand && brand !== "all") {
        // An "all brands" article is club-wide knowledge and belongs in every
        // brand's view — filtering it out is how a shared policy goes missing.
        conds.push(or(eq(kbArticles.brand, brand), eq(kbArticles.brand, "all"))!);
      }
      if (category) conds.push(eq(kbArticles.category, category));
      if (q) {
        conds.push(
          or(
            sql`to_tsvector('english', coalesce(${kbArticles.title},'') || ' ' || coalesce(${kbArticles.summary},'') || ' ' || coalesce(${kbArticles.body},'')) @@ plainto_tsquery('english', ${q})`,
            ilike(kbArticles.title, `%${q}%`),
            ilike(kbArticles.body, `%${q}%`),
            sql`lower(${kbArticles.title}) % lower(${q})`,
            sql`${kbArticles.keywords}::text ilike ${"%" + q + "%"}`,
          )!,
        );
      }

      const rows = await db
        .select({
          id: kbArticles.id,
          brand: kbArticles.brand,
          category: kbArticles.category,
          title: kbArticles.title,
          summary: kbArticles.summary,
          status: kbArticles.status,
          keywords: kbArticles.keywords,
          requiredTab: kbArticles.requiredTab,
          requiredWorkspace: kbArticles.requiredWorkspace,
          viewCount: kbArticles.viewCount,
          verifiedAt: kbArticles.verifiedAt,
          updatedAt: kbArticles.updatedAt,
          ownerFirst: usersTable.firstName,
          ownerLast: usersTable.lastName,
        })
        .from(kbArticles)
        .leftJoin(usersTable, eq(kbArticles.ownerUserId, usersTable.id))
        .where(and(...conds))
        .orderBy(desc(kbArticles.updatedAt))
        .limit(200);

      // 🔴 Gate filtering happens here, after the query — a restricted article's
      // TITLE is often the sensitive part, so it must not reach the browser.
      const visible = rows.filter((r) => viewerCanReadArticle(viewer, r));

      res.json({
        articles: visible.map((r) => ({
          ...r,
          ownerName: [r.ownerFirst, r.ownerLast].filter(Boolean).join(" ") || null,
          ownerFirst: undefined,
          ownerLast: undefined,
        })),
      });
    } catch (e: any) {
      console.error("[kb] list failed:", e);
      res.status(500).json({ message: e.message });
    }
  });

  // ── One article ───────────────────────────────────────────────────────────
  app.get("/api/admin/kb/articles/:id", requireAuth, async (req, res) => {
    try {
      const viewer = await buildViewer(req.session.userId!);
      if (!viewer) return res.status(401).json({ message: "Not signed in" });
      const id = parseInt(String(req.params.id), 10);
      if (!Number.isFinite(id)) return res.status(400).json({ message: "Bad id" });

      const [article] = await db.select().from(kbArticles).where(eq(kbArticles.id, id));
      if (!article) return res.status(404).json({ message: "Article not found" });
      // 404, not 403: a restricted article should not confirm its own existence.
      if (!viewerCanReadArticle(viewer, article)) return res.status(404).json({ message: "Article not found" });

      await db
        .update(kbArticles)
        .set({ viewCount: sql`${kbArticles.viewCount} + 1` })
        .where(eq(kbArticles.id, id));

      const revisions = await db
        .select({
          id: kbArticleRevisions.id,
          editNote: kbArticleRevisions.editNote,
          createdAt: kbArticleRevisions.createdAt,
          first: usersTable.firstName,
          last: usersTable.lastName,
        })
        .from(kbArticleRevisions)
        .leftJoin(usersTable, eq(kbArticleRevisions.editedBy, usersTable.id))
        .where(eq(kbArticleRevisions.articleId, id))
        .orderBy(desc(kbArticleRevisions.createdAt))
        .limit(25);

      res.json({
        article,
        revisions: revisions.map((r) => ({
          id: r.id,
          editNote: r.editNote,
          createdAt: r.createdAt,
          editorName: [r.first, r.last].filter(Boolean).join(" ") || "Unknown",
        })),
      });
    } catch (e: any) {
      console.error("[kb] read failed:", e);
      res.status(500).json({ message: e.message });
    }
  });

  // ── Create ────────────────────────────────────────────────────────────────
  // Any staff member. A vault only fills up if the people who hold the
  // knowledge can write it down without asking permission first.
  app.post("/api/admin/kb/articles", requireAuth, async (req, res) => {
    try {
      const viewer = await buildViewer(req.session.userId!);
      if (!viewer) return res.status(401).json({ message: "Not signed in" });

      const title = clean(req.body?.title);
      if (!title) return res.status(400).json({ message: "A title is required" });
      const brand = isKbBrand(req.body?.brand) ? req.body.brand : "all";
      const status = KB_STATUSES.includes(req.body?.status) ? req.body.status : "draft";
      const requiredTab = clean(req.body?.requiredTab) ?? null;
      const requiredWorkspace = clean(req.body?.requiredWorkspace) ?? null;

      if (!mayChangeGate(viewer, null, requiredTab, null, requiredWorkspace)) {
        return res.status(403).json({ message: "You can't restrict an article to an area you don't have access to yourself." });
      }

      const [created] = await db
        .insert(kbArticles)
        .values({
          brand,
          category: clean(req.body?.category) ?? null,
          title: title.slice(0, 300),
          summary: clean(req.body?.summary) ?? null,
          body: typeof req.body?.body === "string" ? req.body.body : "",
          keywords: Array.isArray(req.body?.keywords)
            ? req.body.keywords.filter((k: any) => typeof k === "string" && k.trim()).map((k: string) => k.trim())
            : [],
          status,
          requiredTab,
          requiredWorkspace,
          ownerUserId: viewer.userId,
          createdBy: viewer.userId,
          updatedBy: viewer.userId,
          publishedAt: status === "published" ? new Date() : null,
        })
        .returning();

      res.status(201).json(created);
    } catch (e: any) {
      console.error("[kb] create failed:", e);
      res.status(500).json({ message: e.message });
    }
  });

  // ── Update ────────────────────────────────────────────────────────────────
  app.patch("/api/admin/kb/articles/:id", requireAuth, async (req, res) => {
    try {
      const viewer = await buildViewer(req.session.userId!);
      if (!viewer) return res.status(401).json({ message: "Not signed in" });
      const id = parseInt(String(req.params.id), 10);
      if (!Number.isFinite(id)) return res.status(400).json({ message: "Bad id" });

      const [existing] = await db.select().from(kbArticles).where(eq(kbArticles.id, id));
      if (!existing) return res.status(404).json({ message: "Article not found" });
      if (!viewerCanReadArticle(viewer, existing)) return res.status(404).json({ message: "Article not found" });

      const nextTab = req.body?.requiredTab !== undefined ? clean(req.body.requiredTab) ?? null : existing.requiredTab;
      const nextWs =
        req.body?.requiredWorkspace !== undefined ? clean(req.body.requiredWorkspace) ?? null : existing.requiredWorkspace;
      if (!mayChangeGate(viewer, existing.requiredTab, nextTab, existing.requiredWorkspace, nextWs)) {
        return res.status(403).json({ message: "You can't change the access restriction on this article." });
      }

      // Keep the version that is being replaced, before it is gone.
      await db.insert(kbArticleRevisions).values({
        articleId: id,
        title: existing.title,
        summary: existing.summary,
        body: existing.body,
        editedBy: viewer.userId,
        editNote: clean(req.body?.editNote) ?? null,
      });

      const patch: Record<string, any> = { updatedAt: new Date(), updatedBy: viewer.userId };
      if (req.body.title !== undefined) {
        const t = clean(req.body.title);
        if (!t) return res.status(400).json({ message: "Title can't be blank" });
        patch.title = t.slice(0, 300);
      }
      if (req.body.summary !== undefined) patch.summary = clean(req.body.summary) ?? null;
      if (req.body.body !== undefined) patch.body = typeof req.body.body === "string" ? req.body.body : "";
      if (req.body.category !== undefined) patch.category = clean(req.body.category) ?? null;
      if (req.body.brand !== undefined && isKbBrand(req.body.brand)) patch.brand = req.body.brand;
      if (req.body.keywords !== undefined && Array.isArray(req.body.keywords)) {
        patch.keywords = req.body.keywords.filter((k: any) => typeof k === "string" && k.trim()).map((k: string) => k.trim());
      }
      if (req.body.requiredTab !== undefined) patch.requiredTab = nextTab;
      if (req.body.requiredWorkspace !== undefined) patch.requiredWorkspace = nextWs;
      if (req.body.status !== undefined && KB_STATUSES.includes(req.body.status)) {
        patch.status = req.body.status;
        if (req.body.status === "published" && !existing.publishedAt) patch.publishedAt = new Date();
      }
      // Editing a page is not the same as confirming its facts are still true,
      // so `verified_at` only moves when someone explicitly says so.
      if (req.body.verified === true) {
        patch.verifiedAt = new Date();
        patch.verifiedBy = viewer.userId;
      }

      const [updated] = await db.update(kbArticles).set(patch).where(eq(kbArticles.id, id)).returning();
      res.json(updated);
    } catch (e: any) {
      console.error("[kb] update failed:", e);
      res.status(500).json({ message: e.message });
    }
  });

  // ── Delete — the author or a manager ──────────────────────────────────────
  app.delete("/api/admin/kb/articles/:id", requireAuth, async (req, res) => {
    try {
      const viewer = await buildViewer(req.session.userId!);
      if (!viewer) return res.status(401).json({ message: "Not signed in" });
      const id = parseInt(String(req.params.id), 10);
      if (!Number.isFinite(id)) return res.status(400).json({ message: "Bad id" });

      const [existing] = await db.select().from(kbArticles).where(eq(kbArticles.id, id));
      if (!existing) return res.status(404).json({ message: "Article not found" });
      if (!viewerCanReadArticle(viewer, existing)) return res.status(404).json({ message: "Article not found" });

      const isManager = await isManagerUser(viewer.userId);
      if (!isManager && existing.createdBy !== viewer.userId) {
        return res.status(403).json({ message: "Only the author or a manager can delete an article" });
      }
      await db.delete(kbArticles).where(eq(kbArticles.id, id));
      res.json({ ok: true });
    } catch (e: any) {
      console.error("[kb] delete failed:", e);
      res.status(500).json({ message: e.message });
    }
  });

  // ── Rambo: conversations ──────────────────────────────────────────────────
  app.get("/api/admin/kb/sessions", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const rows = await db
        .select()
        .from(kbChatSessions)
        .where(eq(kbChatSessions.userId, userId))
        .orderBy(desc(kbChatSessions.updatedAt))
        .limit(30);
      res.json({ sessions: rows });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/admin/kb/sessions/:id", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const id = parseInt(String(req.params.id), 10);
      if (!Number.isFinite(id)) return res.status(400).json({ message: "Bad id" });
      const [session] = await db.select().from(kbChatSessions).where(eq(kbChatSessions.id, id));
      // Someone else's conversation with Rambo is theirs, including for a
      // manager. Nothing in it is a club record.
      if (!session || session.userId !== userId) return res.status(404).json({ message: "Not found" });
      const messages = await db
        .select()
        .from(kbChatMessages)
        .where(eq(kbChatMessages.sessionId, id))
        .orderBy(kbChatMessages.createdAt);
      res.json({ session, messages });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.delete("/api/admin/kb/sessions/:id", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const id = parseInt(String(req.params.id), 10);
      if (!Number.isFinite(id)) return res.status(400).json({ message: "Bad id" });
      const [session] = await db.select().from(kbChatSessions).where(eq(kbChatSessions.id, id));
      if (!session || session.userId !== userId) return res.status(404).json({ message: "Not found" });
      await db.delete(kbChatSessions).where(eq(kbChatSessions.id, id));
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // ── Rambo: ask ────────────────────────────────────────────────────────────
  app.post("/api/admin/kb/ask", requireAuth, async (req, res) => {
    try {
      const viewer = await buildViewer(req.session.userId!);
      if (!viewer) return res.status(401).json({ message: "Not signed in" });

      const question = clean(req.body?.question);
      if (!question) return res.status(400).json({ message: "Ask Rambo something" });
      const brand = isKbBrand(req.body?.brand) ? req.body.brand : "all";

      // Continue a conversation, or start one.
      let sessionId: number | null =
        Number.isFinite(Number(req.body?.sessionId)) ? Number(req.body.sessionId) : null;
      if (sessionId != null) {
        const [s] = await db.select().from(kbChatSessions).where(eq(kbChatSessions.id, sessionId));
        if (!s || s.userId !== viewer.userId) sessionId = null;
      }
      if (sessionId == null) {
        const [created] = await db
          .insert(kbChatSessions)
          .values({ userId: viewer.userId, brand, title: question.slice(0, 80) })
          .returning();
        sessionId = created.id;
      }

      const prior = await db
        .select({ role: kbChatMessages.role, content: kbChatMessages.content })
        .from(kbChatMessages)
        .where(eq(kbChatMessages.sessionId, sessionId))
        .orderBy(kbChatMessages.createdAt)
        .limit(20);

      await db.insert(kbChatMessages).values({ sessionId, role: "user", content: question });

      const reply = await askRambo({
        viewer,
        brand,
        history: prior
          .filter((m) => m.content.trim() !== "")
          .map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
        question,
      });

      const [saved] = await db
        .insert(kbChatMessages)
        .values({
          sessionId,
          role: "assistant",
          content: reply.content,
          toolsUsed: reply.toolsUsed,
          sources: reply.sources,
        })
        .returning();

      await db.update(kbChatSessions).set({ updatedAt: new Date() }).where(eq(kbChatSessions.id, sessionId));

      res.json({ sessionId, message: saved });
    } catch (e: any) {
      console.error("[kb] ask failed:", e);
      res.status(500).json({ message: "Rambo couldn't answer that — " + e.message });
    }
  });

  // ── The audit trail. Super admins only: it names who asked for what. ───────
  app.get("/api/admin/kb/access-log", requireAuth, async (req, res) => {
    try {
      const viewer = await buildViewer(req.session.userId!);
      if (!viewer) return res.status(401).json({ message: "Not signed in" });
      if (viewer.globalRole !== "super_admin") return res.status(403).json({ message: "Super admins only" });
      const rows = await db.select().from(kbAccessLog).orderBy(desc(kbAccessLog.createdAt)).limit(200);
      res.json({ entries: rows });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });
}
