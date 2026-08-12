// ─────────────────────────────────────────────────────────────────────────────
// SITE FAQs — the questions on a brand's website and in its live-chat widget.
//
// Public (cookie-less, CORS-allow-listed to the brand sites):
//   GET /api/public/faqs/:brandKey?surface=website|chat
//
// Admin (session + the "faqs" tab, org-scoped):
//   GET    /api/admin/faqs
//   POST   /api/admin/faqs
//   PATCH  /api/admin/faqs/:id
//   DELETE /api/admin/faqs/:id
//   PATCH  /api/admin/faqs/reorder
//
// Both lists used to live in the website's source, so answering a new question
// was a code change. Dima edits them here and the site picks them up within a
// minute.
// ─────────────────────────────────────────────────────────────────────────────
import type { Express, Request, Response } from "express";
import { and, asc, eq } from "drizzle-orm";
import { db } from "./db";
import { requireAuth, requireTab } from "./auth";
import { organizations, siteFaqs } from "@shared/schema";

const s = (v: any, max = 4000): string => String(v ?? "").trim().slice(0, max);

// Which brand a workspace edits. Keeps a workspace from publishing FAQs onto
// another brand's site by passing a brandKey in the body.
const BRAND_FOR_ORG: Record<number, string> = {
  8: "unitedprints",
};

// Same allow-list shape as the chat + quote endpoints.
const FAQ_HOSTS = new Set([
  "unitedprints.co.nz", "www.unitedprints.co.nz",
  "cicyouth.com", "www.cicyouth.com",
  "minifootball.co.nz", "www.minifootball.co.nz",
  "cugc.co.nz", "www.cugc.co.nz",
  "cufc.co.nz", "www.cufc.co.nz",
]);

function faqCors(req: Request, res: Response) {
  const origin = req.headers.origin as string | undefined;
  if (!origin) return;
  try {
    const { hostname, protocol } = new URL(origin);
    const isLocal = hostname === "localhost" || hostname === "127.0.0.1";
    if (protocol !== "https:" && !isLocal) return;
    if (FAQ_HOSTS.has(hostname) || hostname.endsWith(".vercel.app") || isLocal) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Vary", "Origin");
      res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.set("Access-Control-Allow-Headers", "Content-Type");
    }
  } catch { /* malformed origin */ }
}

async function workspaceOrg(req: Request): Promise<{ id: number; slug: string } | null> {
  const slug = String(req.headers["x-workspace-slug"] || "").trim();
  if (!slug) return null;
  const [org] = await db.select().from(organizations).where(eq(organizations.slug, slug));
  return org ? { id: org.id, slug: org.slug } : null;
}

export function registerFaqRoutes(app: Express) {
  // ═══════════════════════════ PUBLIC ═══════════════════════════════════════
  app.options("/api/public/faqs/:brandKey", (req, res) => { faqCors(req, res); res.sendStatus(204); });
  app.get("/api/public/faqs/:brandKey", async (req: Request, res: Response) => {
    faqCors(req, res);
    try {
      const brandKey = s(req.params.brandKey, 40);
      const surface = s(req.query.surface as string, 20);

      const rows = await db.select().from(siteFaqs)
        .where(and(eq(siteFaqs.brandKey, brandKey), eq(siteFaqs.isActive, true)))
        .orderBy(asc(siteFaqs.displayOrder), asc(siteFaqs.id));

      const filtered = surface === "chat" ? rows.filter((r) => r.showInChat)
        : surface === "website" ? rows.filter((r) => r.showOnWebsite)
        : rows;

      res.set("Cache-Control", "public, max-age=60");
      // `q`/`a` because that is the shape both the website's FAQ component and
      // the chat widget already expect — no client change needed beyond the fetch.
      res.json({ faqs: filtered.map((r) => ({ q: r.question, a: r.answer })) });
    } catch (e: any) {
      console.error("[faqs] public list failed:", e);
      res.status(500).json({ message: "Couldn't load FAQs." });
    }
  });

  // ═══════════════════════════ ADMIN ════════════════════════════════════════
  const tab = requireTab("faqs");

  app.get("/api/admin/faqs", requireAuth, tab, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "X-Workspace-Slug header required" });
      const rows = await db.select().from(siteFaqs)
        .where(eq(siteFaqs.organizationId, org.id))
        .orderBy(asc(siteFaqs.displayOrder), asc(siteFaqs.id));
      res.json({
        faqs: rows,
        brandKey: BRAND_FOR_ORG[org.id] ?? null,
        // So the page can tell Dima exactly where these show up.
        siteUrl: org.id === 8 ? "https://unitedprints.co.nz" : null,
      });
    } catch (e: any) {
      console.error("[faqs] admin list failed:", e);
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/admin/faqs", requireAuth, tab, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "X-Workspace-Slug header required" });
      // 🔴 The brand comes from the workspace, never the body — otherwise this
      // workspace could publish an FAQ onto another brand's website.
      const brandKey = BRAND_FOR_ORG[org.id];
      if (!brandKey) return res.status(400).json({ message: "This workspace has no website wired up for FAQs yet." });

      const question = s(req.body?.question, 300);
      const answer = s(req.body?.answer, 4000);
      if (!question) return res.status(400).json({ message: "Add the question." });
      if (!answer) return res.status(400).json({ message: "Add the answer." });

      // New ones go to the bottom.
      const existing = await db.select({ o: siteFaqs.displayOrder }).from(siteFaqs)
        .where(eq(siteFaqs.organizationId, org.id));
      const nextOrder = existing.reduce((m, r) => Math.max(m, r.o), 0) + 10;

      const [row] = await db.insert(siteFaqs).values({
        organizationId: org.id,
        brandKey,
        question,
        answer,
        showOnWebsite: req.body?.showOnWebsite !== false,
        showInChat: req.body?.showInChat !== false,
        isActive: req.body?.isActive !== false,
        displayOrder: Number.isFinite(Number(req.body?.displayOrder)) ? Number(req.body.displayOrder) : nextOrder,
        updatedByUserId: req.session.userId!,
      }).returning();
      res.status(201).json(row);
    } catch (e: any) {
      console.error("[faqs] create failed:", e);
      res.status(400).json({ message: e.message });
    }
  });

  app.patch("/api/admin/faqs/reorder", requireAuth, tab, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "X-Workspace-Slug header required" });
      const ids: number[] = Array.isArray(req.body?.ids) ? req.body.ids.map((n: any) => parseInt(String(n), 10)).filter(Number.isFinite) : [];
      if (!ids.length) return res.status(400).json({ message: "ids required" });

      // Renumber server-side from the given order, and only rows in this org —
      // a stale client list can't reorder somebody else's FAQs.
      await db.transaction(async (tx) => {
        for (let i = 0; i < ids.length; i++) {
          await tx.update(siteFaqs).set({ displayOrder: (i + 1) * 10, updatedAt: new Date() })
            .where(and(eq(siteFaqs.id, ids[i]), eq(siteFaqs.organizationId, org.id)));
        }
      });
      const rows = await db.select().from(siteFaqs).where(eq(siteFaqs.organizationId, org.id))
        .orderBy(asc(siteFaqs.displayOrder), asc(siteFaqs.id));
      res.json({ faqs: rows });
    } catch (e: any) {
      console.error("[faqs] reorder failed:", e);
      res.status(400).json({ message: e.message });
    }
  });

  app.patch("/api/admin/faqs/:id", requireAuth, tab, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      const id = parseInt(String(req.params.id), 10);
      if (!org || !Number.isFinite(id)) return res.status(400).json({ message: "Bad request" });

      const [existing] = await db.select().from(siteFaqs)
        .where(and(eq(siteFaqs.id, id), eq(siteFaqs.organizationId, org.id)));
      if (!existing) return res.status(404).json({ message: "Not found" });

      const patch: Record<string, any> = { updatedAt: new Date(), updatedByUserId: req.session.userId! };
      if (req.body?.question !== undefined) {
        const q = s(req.body.question, 300);
        if (!q) return res.status(400).json({ message: "The question can't be empty." });
        patch.question = q;
      }
      if (req.body?.answer !== undefined) {
        const a = s(req.body.answer, 4000);
        if (!a) return res.status(400).json({ message: "The answer can't be empty." });
        patch.answer = a;
      }
      if (req.body?.showOnWebsite !== undefined) patch.showOnWebsite = !!req.body.showOnWebsite;
      if (req.body?.showInChat !== undefined) patch.showInChat = !!req.body.showInChat;
      if (req.body?.isActive !== undefined) patch.isActive = !!req.body.isActive;
      if (req.body?.displayOrder !== undefined && Number.isFinite(Number(req.body.displayOrder))) {
        patch.displayOrder = Number(req.body.displayOrder);
      }
      // brandKey and organizationId are identity, not settings.
      const [row] = await db.update(siteFaqs).set(patch)
        .where(and(eq(siteFaqs.id, id), eq(siteFaqs.organizationId, org.id))).returning();
      res.json(row);
    } catch (e: any) {
      console.error("[faqs] patch failed:", e);
      res.status(400).json({ message: e.message });
    }
  });

  app.delete("/api/admin/faqs/:id", requireAuth, tab, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      const id = parseInt(String(req.params.id), 10);
      if (!org || !Number.isFinite(id)) return res.status(400).json({ message: "Bad request" });
      const [existing] = await db.select().from(siteFaqs)
        .where(and(eq(siteFaqs.id, id), eq(siteFaqs.organizationId, org.id)));
      if (!existing) return res.status(404).json({ message: "Not found" });
      await db.delete(siteFaqs).where(eq(siteFaqs.id, id));
      res.status(204).end();
    } catch (e: any) {
      console.error("[faqs] delete failed:", e);
      res.status(500).json({ message: e.message });
    }
  });
}
