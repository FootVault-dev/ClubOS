/**
 * Marketing Suite — admin API (all gated requireTab("marketing") + workspace-scoped).
 *
 * `registerMarketingRoutes(app)` is the ONE integration point wired from
 * server/routes.ts: it mounts the (public, ungated) Resend webhook + unsub /
 * preference pages AND the (auth-gated) admin CRUD/analytics API below.
 *
 * Workspace scoping mirrors the rest of ClubOS: the client sends X-Workspace-Slug,
 * which we resolve to an organisation id and use to scope every query. Everything
 * that sends passes through resolveAudience → filterSendable (the suppression gate).
 */

import type { Express, Request, Response } from "express";
import { and, desc, eq, gte, ilike, inArray, or, sql } from "drizzle-orm";
import { db } from "../db";
import { requireAuth, requireTab } from "../auth";
import {
  organizations, mktLists, mktListMembers, mktSegments, mktCampaigns, mktProfiles,
  mktConsent, mktSuppressions, mktEvents, mktMetrics, mktEmailMessages, mktEmailLinkClicks, mktConversions,
  mktTemplates,
} from "@shared/schema";
import { registerMarketingWebhook } from "./webhook";
import { registerMarketingPublicRoutes } from "./public-routes";
import { resolveAudience, previewCount, computeSegment, type CampaignAudience } from "./segments";
import { suppress, unsuppress } from "./suppression";
import { sendMarketingEmail } from "./resend-client";
import { addMarketingJob } from "./worker";
import { brandKeyForWorkspace, brandShell, publicBaseUrl } from "./brand";
import { signUnsubscribeToken, signPreferenceToken } from "./tokens";

// Resolve X-Workspace-Slug → org id (mirrors registerRoutes' workspaceOrg helper).
async function workspaceOrg(req: Request): Promise<{ id: number; slug: string } | null> {
  const slug = String(req.headers["x-workspace-slug"] || "").trim();
  if (!slug) return null;
  const [org] = await db.select({ id: organizations.id, slug: organizations.slug }).from(organizations).where(eq(organizations.slug, slug)).limit(1);
  return org ?? null;
}

const gate = [requireAuth, requireTab("marketing")] as const;
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

export function registerMarketingRoutes(app: Express): void {
  // Public (ungated) — the Resend webhook + unsubscribe/preference pages.
  registerMarketingWebhook(app);
  registerMarketingPublicRoutes(app);

  // ════════════════════════════ LISTS ════════════════════════════
  app.get("/api/admin/marketing/lists", ...gate, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "Workspace required" });
      const lists = await db.select().from(mktLists).where(eq(mktLists.workspaceId, org.id)).orderBy(desc(mktLists.createdAt));
      const withCounts = await Promise.all(lists.map(async (l) => {
        const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(mktListMembers).where(eq(mktListMembers.listId, l.id));
        return { ...l, memberCount: Number(n) };
      }));
      res.json(withCounts);
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.post("/api/admin/marketing/lists", ...gate, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "Workspace required" });
      const [row] = await db.insert(mktLists).values({
        workspaceId: org.id, name: String(req.body?.name || "Untitled list"), description: req.body?.description ?? null,
      }).returning();
      res.json(row);
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.patch("/api/admin/marketing/lists/:id", ...gate, async (req, res) => {
    try {
      const org = await workspaceOrg(req); const id = num(req.params.id);
      if (!org || id == null) return res.status(400).json({ message: "Bad request" });
      const [row] = await db.update(mktLists).set({
        name: req.body?.name ?? undefined, description: req.body?.description ?? undefined, updatedAt: new Date(),
      }).where(and(eq(mktLists.id, id), eq(mktLists.workspaceId, org.id))).returning();
      res.json(row ?? null);
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.delete("/api/admin/marketing/lists/:id", ...gate, async (req, res) => {
    try {
      const org = await workspaceOrg(req); const id = num(req.params.id);
      if (!org || id == null) return res.status(400).json({ message: "Bad request" });
      await db.delete(mktLists).where(and(eq(mktLists.id, id), eq(mktLists.workspaceId, org.id)));
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.post("/api/admin/marketing/lists/:id/members", ...gate, async (req, res) => {
    try {
      const org = await workspaceOrg(req); const id = num(req.params.id);
      if (!org || id == null) return res.status(400).json({ message: "Bad request" });
      const profileIds: number[] = Array.isArray(req.body?.profileIds) ? req.body.profileIds.map(Number).filter(Number.isFinite) : [];
      if (profileIds.length) {
        await db.insert(mktListMembers).values(profileIds.map((profileId) => ({ listId: id, profileId, source: "admin" }))).onConflictDoNothing();
      }
      res.json({ ok: true, added: profileIds.length });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.delete("/api/admin/marketing/lists/:id/members", ...gate, async (req, res) => {
    try {
      const org = await workspaceOrg(req); const id = num(req.params.id);
      if (!org || id == null) return res.status(400).json({ message: "Bad request" });
      const profileIds: number[] = Array.isArray(req.body?.profileIds) ? req.body.profileIds.map(Number).filter(Number.isFinite) : [];
      if (profileIds.length) await db.delete(mktListMembers).where(and(eq(mktListMembers.listId, id), inArray(mktListMembers.profileId, profileIds)));
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  // ════════════════════════════ SEGMENTS ════════════════════════════
  app.get("/api/admin/marketing/segments", ...gate, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "Workspace required" });
      res.json(await db.select().from(mktSegments).where(eq(mktSegments.workspaceId, org.id)).orderBy(desc(mktSegments.createdAt)));
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.post("/api/admin/marketing/segments", ...gate, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "Workspace required" });
      const [row] = await db.insert(mktSegments).values({
        workspaceId: org.id, name: String(req.body?.name || "Untitled segment"), definition: req.body?.definition ?? {},
      }).returning();
      const stats = await computeSegment(row.id, org.id).catch(() => ({ count: 0, materialised: false }));
      res.json({ ...row, memberCount: stats.count });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.patch("/api/admin/marketing/segments/:id", ...gate, async (req, res) => {
    try {
      const org = await workspaceOrg(req); const id = num(req.params.id);
      if (!org || id == null) return res.status(400).json({ message: "Bad request" });
      const [row] = await db.update(mktSegments).set({
        name: req.body?.name ?? undefined, definition: req.body?.definition ?? undefined, updatedAt: new Date(),
      }).where(and(eq(mktSegments.id, id), eq(mktSegments.workspaceId, org.id))).returning();
      if (row) await computeSegment(row.id, org.id).catch(() => {});
      res.json(row ?? null);
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.delete("/api/admin/marketing/segments/:id", ...gate, async (req, res) => {
    try {
      const org = await workspaceOrg(req); const id = num(req.params.id);
      if (!org || id == null) return res.status(400).json({ message: "Bad request" });
      await db.delete(mktSegments).where(and(eq(mktSegments.id, id), eq(mktSegments.workspaceId, org.id)));
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  // Live count preview — runs the evaluator on an arbitrary definition.
  app.post("/api/admin/marketing/segments/preview-count", ...gate, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "Workspace required" });
      res.json({ count: await previewCount(req.body?.definition ?? {}, org.id) });
    } catch (e: any) { res.status(400).json({ message: e.message }); }
  });

  app.post("/api/admin/marketing/segments/:id/recompute", ...gate, async (req, res) => {
    try {
      const org = await workspaceOrg(req); const id = num(req.params.id);
      if (!org || id == null) return res.status(400).json({ message: "Bad request" });
      res.json(await computeSegment(id, org.id));
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  // ════════════════════════════ CAMPAIGNS ════════════════════════════
  app.get("/api/admin/marketing/campaigns", ...gate, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "Workspace required" });
      res.json(await db.select().from(mktCampaigns).where(eq(mktCampaigns.workspaceId, org.id)).orderBy(desc(mktCampaigns.createdAt)));
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.get("/api/admin/marketing/campaigns/:id", ...gate, async (req, res) => {
    try {
      const org = await workspaceOrg(req); const id = num(req.params.id);
      if (!org || id == null) return res.status(400).json({ message: "Bad request" });
      const [row] = await db.select().from(mktCampaigns).where(and(eq(mktCampaigns.id, id), eq(mktCampaigns.workspaceId, org.id))).limit(1);
      res.json(row ?? null);
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.post("/api/admin/marketing/campaigns", ...gate, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "Workspace required" });
      const b = req.body || {};
      const [row] = await db.insert(mktCampaigns).values({
        workspaceId: org.id, name: String(b.name || "Untitled campaign"), channel: b.channel || "email",
        subject: b.subject ?? null, preheader: b.preheader ?? null, fromName: b.fromName ?? null,
        replyTo: b.replyTo ?? null, templateId: b.templateId ?? null, bodyHtml: b.bodyHtml ?? null,
        audience: b.audience ?? {}, isMarketing: b.isMarketing ?? true, utm: b.utm ?? null,
        createdBy: req.session.userId ?? null,
      }).returning();
      res.json(row);
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.patch("/api/admin/marketing/campaigns/:id", ...gate, async (req, res) => {
    try {
      const org = await workspaceOrg(req); const id = num(req.params.id);
      if (!org || id == null) return res.status(400).json({ message: "Bad request" });
      const [existing] = await db.select().from(mktCampaigns).where(and(eq(mktCampaigns.id, id), eq(mktCampaigns.workspaceId, org.id))).limit(1);
      if (!existing) return res.status(404).json({ message: "Not found" });
      if (["sending", "sent"].includes(existing.status)) return res.status(409).json({ message: "Campaign already sent/sending" });
      const b = req.body || {};
      const [row] = await db.update(mktCampaigns).set({
        name: b.name ?? undefined, subject: b.subject ?? undefined, preheader: b.preheader ?? undefined,
        fromName: b.fromName ?? undefined, replyTo: b.replyTo ?? undefined, templateId: b.templateId ?? undefined,
        bodyHtml: b.bodyHtml ?? undefined, audience: b.audience ?? undefined, isMarketing: b.isMarketing ?? undefined,
        utm: b.utm ?? undefined, updatedAt: new Date(),
      }).where(eq(mktCampaigns.id, id)).returning();
      res.json(row);
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.delete("/api/admin/marketing/campaigns/:id", ...gate, async (req, res) => {
    try {
      const org = await workspaceOrg(req); const id = num(req.params.id);
      if (!org || id == null) return res.status(400).json({ message: "Bad request" });
      await db.delete(mktCampaigns).where(and(eq(mktCampaigns.id, id), eq(mktCampaigns.workspaceId, org.id)));
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  // Audience estimate → {total, suppressed, sendable} (dry-run through the gate).
  app.post("/api/admin/marketing/campaigns/:id/audience-estimate", ...gate, async (req, res) => {
    try {
      const org = await workspaceOrg(req); const id = num(req.params.id);
      if (!org || id == null) return res.status(400).json({ message: "Bad request" });
      const [c] = await db.select().from(mktCampaigns).where(and(eq(mktCampaigns.id, id), eq(mktCampaigns.workspaceId, org.id))).limit(1);
      if (!c) return res.status(404).json({ message: "Not found" });
      const r = await resolveAudience((c.audience as CampaignAudience) || {}, org.id, { channel: "email", isMarketing: c.isMarketing });
      res.json({ total: r.total, sendable: r.profileIds.length, suppressed: r.gate?.excluded ?? 0, breakdown: r.gate });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  // Send a test email to an arbitrary address (no gate — it's the sender's own inbox).
  app.post("/api/admin/marketing/campaigns/:id/test-email", ...gate, async (req, res) => {
    try {
      const org = await workspaceOrg(req); const id = num(req.params.id);
      if (!org || id == null) return res.status(400).json({ message: "Bad request" });
      const to = String(req.body?.to || "").trim();
      if (!to) return res.status(400).json({ message: "Recipient required" });
      const [c] = await db.select().from(mktCampaigns).where(and(eq(mktCampaigns.id, id), eq(mktCampaigns.workspaceId, org.id))).limit(1);
      if (!c) return res.status(404).json({ message: "Not found" });

      const shell = brandShell(org.id);
      const base = publicBaseUrl();
      const unsubToken = signUnsubscribeToken({ profileId: 0, workspaceId: org.id, scope: "brand" });
      const prefsToken = signPreferenceToken({ profileId: 0, workspaceId: org.id });
      const oneClickUrl = `${base}/api/public/marketing/unsubscribe/oneclick?token=${encodeURIComponent(unsubToken)}`;
      const prefsUrl = `${base}/api/public/marketing/preferences?token=${encodeURIComponent(prefsToken)}`;
      let html = (c.bodyHtml || "<p>(no content yet)</p>").replace(/\{\{\s*first_name\s*\}\}/gi, "there").replace(/\{\{\s*(last_name|email)\s*\}\}/gi, "");
      if (!html.includes(oneClickUrl)) {
        html += `<div style="margin-top:24px;font-size:12px;color:#8a8a8a;text-align:center;">${shell.name} · <a href="${oneClickUrl}">Unsubscribe</a> · <a href="${prefsUrl}">Preferences</a></div>`;
      }
      const result = await sendMarketingEmail({
        orgId: org.id, to, subject: `[TEST] ${c.subject || c.name}`, html,
        fromName: c.fromName || undefined, replyTo: c.replyTo || undefined,
        idempotencyKey: `test-${id}-${Date.now()}`, stream: c.isMarketing ? "marketing" : "transactional",
        listUnsubscribeUrl: oneClickUrl,
      });
      res.json({ ok: result.ok, id: result.id, error: result.error, skipped: result.skipped });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.post("/api/admin/marketing/campaigns/:id/schedule", ...gate, async (req, res) => {
    try {
      const org = await workspaceOrg(req); const id = num(req.params.id);
      if (!org || id == null) return res.status(400).json({ message: "Bad request" });
      const scheduledAt = req.body?.scheduledAt ? new Date(req.body.scheduledAt) : null;
      if (!scheduledAt || isNaN(scheduledAt.getTime())) return res.status(400).json({ message: "Valid scheduledAt required" });
      const [c] = await db.select().from(mktCampaigns).where(and(eq(mktCampaigns.id, id), eq(mktCampaigns.workspaceId, org.id))).limit(1);
      if (!c) return res.status(404).json({ message: "Not found" });
      if (["sending", "sent"].includes(c.status)) return res.status(409).json({ message: "Already sent/sending" });
      await db.update(mktCampaigns).set({ status: "scheduled", scheduledAt, updatedAt: new Date() }).where(eq(mktCampaigns.id, id));
      await addMarketingJob("campaign:send", { campaignId: id }, { runAt: scheduledAt, jobKey: `campaign-send:${id}`, jobKeyMode: "replace" });
      res.json({ ok: true, scheduledAt });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.post("/api/admin/marketing/campaigns/:id/send-now", ...gate, async (req, res) => {
    try {
      const org = await workspaceOrg(req); const id = num(req.params.id);
      if (!org || id == null) return res.status(400).json({ message: "Bad request" });
      const [c] = await db.select().from(mktCampaigns).where(and(eq(mktCampaigns.id, id), eq(mktCampaigns.workspaceId, org.id))).limit(1);
      if (!c) return res.status(404).json({ message: "Not found" });
      if (["sending", "sent"].includes(c.status)) return res.status(409).json({ message: "Already sent/sending" });
      await db.update(mktCampaigns).set({ status: "sending", updatedAt: new Date() }).where(eq(mktCampaigns.id, id));
      await addMarketingJob("campaign:send", { campaignId: id }, { jobKey: `campaign-send:${id}`, jobKeyMode: "replace" });
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.post("/api/admin/marketing/campaigns/:id/cancel", ...gate, async (req, res) => {
    try {
      const org = await workspaceOrg(req); const id = num(req.params.id);
      if (!org || id == null) return res.status(400).json({ message: "Bad request" });
      const [c] = await db.select().from(mktCampaigns).where(and(eq(mktCampaigns.id, id), eq(mktCampaigns.workspaceId, org.id))).limit(1);
      if (!c) return res.status(404).json({ message: "Not found" });
      if (c.status === "sent") return res.status(409).json({ message: "Already sent" });
      // Flip status → the scheduled orchestrator job bails when it fires.
      await db.update(mktCampaigns).set({ status: "cancelled", updatedAt: new Date() }).where(eq(mktCampaigns.id, id));
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  // Campaign analytics — funnel + human/machine split + link map + conversions.
  app.get("/api/admin/marketing/campaigns/:id/analytics", ...gate, async (req, res) => {
    try {
      const org = await workspaceOrg(req); const id = num(req.params.id);
      if (!org || id == null) return res.status(400).json({ message: "Bad request" });
      const [c] = await db.select().from(mktCampaigns).where(and(eq(mktCampaigns.id, id), eq(mktCampaigns.workspaceId, org.id))).limit(1);
      if (!c) return res.status(404).json({ message: "Not found" });

      const agg = await db.select({
        total: sql<number>`count(*)::int`,
        queued: sql<number>`count(*) filter (where status = 'queued')::int`,
        sent: sql<number>`count(*) filter (where status in ('sent','delivered'))::int`,
        delivered: sql<number>`count(*) filter (where status = 'delivered')::int`,
        bounced: sql<number>`count(*) filter (where status = 'bounced')::int`,
        complained: sql<number>`count(*) filter (where status = 'complained')::int`,
        failed: sql<number>`count(*) filter (where status = 'failed')::int`,
        uniqueOpens: sql<number>`count(*) filter (where first_opened_at is not null)::int`,
        uniqueClicks: sql<number>`count(*) filter (where first_clicked_at is not null)::int`,
        openCount: sql<number>`coalesce(sum(open_count),0)::int`,
        humanOpenCount: sql<number>`coalesce(sum(human_open_count),0)::int`,
        clickCount: sql<number>`coalesce(sum(click_count),0)::int`,
        humanClickCount: sql<number>`coalesce(sum(human_click_count),0)::int`,
      }).from(mktEmailMessages).where(eq(mktEmailMessages.campaignId, id));
      const m = agg[0];

      const links = await db.select({
        linkUrl: mktEmailLinkClicks.linkUrl,
        clicks: sql<number>`count(*)::int`,
        humanClicks: sql<number>`count(*) filter (where is_bot = false)::int`,
      }).from(mktEmailLinkClicks).where(eq(mktEmailLinkClicks.campaignId, id)).groupBy(mktEmailLinkClicks.linkUrl).orderBy(desc(sql`count(*)`)).limit(50);

      const [conv] = await db.select({
        conversions: sql<number>`count(*)::int`,
        revenueCents: sql<number>`coalesce(sum(revenue_cents),0)::int`,
      }).from(mktConversions).where(eq(mktConversions.campaignId, id));

      // Unsubs attributable to this send (brand-scoped, since it was sent).
      const brandKey = brandKeyForWorkspace(org.id);
      const [unsub] = await db.select({ n: sql<number>`count(*)::int` }).from(mktSuppressions).where(and(
        eq(mktSuppressions.channel, "email"),
        c.sentAt ? gte(mktSuppressions.createdAt, c.sentAt) : sql`true`,
        brandKey ? or(eq(mktSuppressions.brandKey, brandKey), eq(mktSuppressions.scope, "global")) : sql`true`,
        inArray(mktSuppressions.reason, ["unsub_oneclick", "unsub_prefs"]),
      ));

      const delivered = Number(m.delivered) || Number(m.sent) || 0;
      res.json({
        campaign: { id: c.id, name: c.name, subject: c.subject, status: c.status, sentAt: c.sentAt, recipientCount: c.recipientCount },
        funnel: {
          total: Number(m.total), queued: Number(m.queued), sent: Number(m.sent), delivered: Number(m.delivered),
          bounced: Number(m.bounced), complained: Number(m.complained), failed: Number(m.failed), unsubscribed: Number(unsub?.n ?? 0),
        },
        engagement: {
          uniqueOpens: Number(m.uniqueOpens), uniqueClicks: Number(m.uniqueClicks),
          openCount: Number(m.openCount), humanOpenCount: Number(m.humanOpenCount),
          machineOpenCount: Number(m.openCount) - Number(m.humanOpenCount),
          clickCount: Number(m.clickCount), humanClickCount: Number(m.humanClickCount),
          botClickCount: Number(m.clickCount) - Number(m.humanClickCount),
        },
        // Honest KPIs (opens demoted, MPP-labelled; RPR/human-click headline).
        kpis: {
          humanClickRate: delivered ? Number(m.humanClickCount) / delivered : 0,
          conversionRate: delivered ? Number(conv?.conversions ?? 0) / delivered : 0,
          revenuePerRecipient: delivered ? (Number(conv?.revenueCents ?? 0) / 100) / delivered : 0,
          openRateMppInflated: delivered ? Number(m.uniqueOpens) / delivered : 0,
        },
        links,
        conversions: { count: Number(conv?.conversions ?? 0), revenue: (Number(conv?.revenueCents ?? 0) / 100) },
      });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  // ════════════════════════════ PROFILES ════════════════════════════
  app.get("/api/admin/marketing/profiles", ...gate, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "Workspace required" });
      const q = String(req.query.q || "").trim();
      const where = q
        ? and(eq(mktProfiles.workspaceId, org.id), or(ilike(mktProfiles.email, `%${q}%`), ilike(mktProfiles.firstName, `%${q}%`), ilike(mktProfiles.lastName, `%${q}%`)))
        : eq(mktProfiles.workspaceId, org.id);
      const rows = await db.select({
        id: mktProfiles.id, email: mktProfiles.email, phoneE164: mktProfiles.phoneE164,
        firstName: mktProfiles.firstName, lastName: mktProfiles.lastName, lastEventAt: mktProfiles.lastEventAt,
      }).from(mktProfiles).where(where).orderBy(desc(mktProfiles.createdAt)).limit(100);
      res.json(rows);
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.get("/api/admin/marketing/profiles/:id", ...gate, async (req, res) => {
    try {
      const org = await workspaceOrg(req); const id = num(req.params.id);
      if (!org || id == null) return res.status(400).json({ message: "Bad request" });
      const [profile] = await db.select().from(mktProfiles).where(and(eq(mktProfiles.id, id), eq(mktProfiles.workspaceId, org.id))).limit(1);
      if (!profile) return res.status(404).json({ message: "Not found" });
      const consent = await db.select().from(mktConsent).where(eq(mktConsent.profileId, id));
      const events = await db.select({
        id: mktEvents.id, metric: mktMetrics.name, properties: mktEvents.properties,
        value: mktEvents.value, occurredAt: mktEvents.occurredAt,
      }).from(mktEvents).innerJoin(mktMetrics, eq(mktMetrics.id, mktEvents.metricId))
        .where(eq(mktEvents.profileId, id)).orderBy(desc(mktEvents.occurredAt)).limit(50);
      const suppressions = profile.email
        ? await db.select().from(mktSuppressions).where(and(eq(mktSuppressions.channel, "email"), sql`lower(${mktSuppressions.email}) = ${(profile.email || "").toLowerCase()}`))
        : [];
      res.json({ profile, consent, events, suppressions });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.post("/api/admin/marketing/profiles/:id/suppress", ...gate, async (req, res) => {
    try {
      const org = await workspaceOrg(req); const id = num(req.params.id);
      if (!org || id == null) return res.status(400).json({ message: "Bad request" });
      const [profile] = await db.select().from(mktProfiles).where(and(eq(mktProfiles.id, id), eq(mktProfiles.workspaceId, org.id))).limit(1);
      if (!profile) return res.status(404).json({ message: "Not found" });
      const channel = req.body?.channel === "sms" ? "sms" : "email";
      const scope = req.body?.scope === "global" ? "global" : "brand";
      await suppress({
        email: profile.email, phoneE164: profile.phoneE164, channel, scope,
        brandKey: scope === "brand" ? brandKeyForWorkspace(org.id) : null,
        reason: "manual", source: "admin", workspaceId: org.id,
      });
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.post("/api/admin/marketing/profiles/:id/unsuppress", ...gate, async (req, res) => {
    try {
      const org = await workspaceOrg(req); const id = num(req.params.id);
      if (!org || id == null) return res.status(400).json({ message: "Bad request" });
      const [profile] = await db.select().from(mktProfiles).where(and(eq(mktProfiles.id, id), eq(mktProfiles.workspaceId, org.id))).limit(1);
      if (!profile) return res.status(404).json({ message: "Not found" });
      const channel = req.body?.channel === "sms" ? "sms" : "email";
      await unsuppress({ email: profile.email, phoneE164: profile.phoneE164, channel, workspaceId: org.id });
      // Re-enable consent so the profile can receive again.
      const [existing] = await db.select({ id: mktConsent.id }).from(mktConsent).where(and(eq(mktConsent.profileId, id), eq(mktConsent.channel, channel))).limit(1);
      if (existing) await db.update(mktConsent).set({ subState: "subscribed", legalBasis: "express", canReceive: true, updatedAt: new Date() }).where(eq(mktConsent.id, existing.id));
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  // ════════════════════════════ DASHBOARD ════════════════════════════
  app.get("/api/admin/marketing/dashboard", ...gate, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "Workspace required" });
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

      const [delivered] = await db.select({ n: sql<number>`count(*)::int` }).from(mktEmailMessages)
        .where(and(eq(mktEmailMessages.workspaceId, org.id), inArray(mktEmailMessages.status, ["sent", "delivered"])));
      const [sends30] = await db.select({ n: sql<number>`count(*)::int` }).from(mktEmailMessages)
        .where(and(eq(mktEmailMessages.workspaceId, org.id), gte(mktEmailMessages.sentAt, since)));
      // Revenue = conversions on this workspace's campaigns.
      const [rev] = await db.select({ cents: sql<number>`coalesce(sum(${mktConversions.revenueCents}),0)::int` })
        .from(mktConversions).innerJoin(mktCampaigns, eq(mktCampaigns.id, mktConversions.campaignId))
        .where(eq(mktCampaigns.workspaceId, org.id));
      const [profiles] = await db.select({ n: sql<number>`count(*)::int` }).from(mktProfiles).where(eq(mktProfiles.workspaceId, org.id));

      const topCampaigns = await db.select({
        id: mktCampaigns.id, name: mktCampaigns.name, status: mktCampaigns.status,
        sentAt: mktCampaigns.sentAt, sentCount: mktCampaigns.sentCount, recipientCount: mktCampaigns.recipientCount,
      }).from(mktCampaigns).where(and(eq(mktCampaigns.workspaceId, org.id), eq(mktCampaigns.status, "sent")))
        .orderBy(desc(mktCampaigns.sentAt)).limit(10);

      const deliveredN = Number(delivered?.n ?? 0);
      const revenue = Number(rev?.cents ?? 0) / 100;
      res.json({
        profiles: Number(profiles?.n ?? 0),
        sends30d: Number(sends30?.n ?? 0),
        deliveredTotal: deliveredN,
        revenue,
        revenuePerRecipient: deliveredN ? revenue / deliveredN : 0,
        topCampaigns,
      });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  // ═══════════════════════════ Templates (Phase D) ═══════════════════════════
  //
  // Reusable email designs + per-brand synced header/footer blocks, all in the
  // existing mkt_templates table (no schema change). Conventions:
  //   • block_tree holds the full builder result { doc, html, text } — the Tiptap
  //     doc is the source of truth, html is the render snapshot (never authored raw).
  //   • kind = 'template' (a saved design) | 'synced_block' (a workspace-wide
  //     reusable block, edited once, injected everywhere).
  //   • Synced blocks use RESERVED names per workspace: "__synced_header__" and
  //     "__synced_footer__" — that name convention IS the registry (no new column).
  // All routes are ...gate (requireAuth + requireTab("marketing")) and scoped to
  // the X-Workspace-Slug workspace, mirroring the Phase B patterns above.

  const SYNCED_NAME: Record<string, string> = {
    header: "__synced_header__",
    footer: "__synced_footer__",
  };

  // List templates (optionally filter by ?kind= and ?channel=).
  app.get("/api/admin/marketing/templates", ...gate, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "Workspace required" });
      const kind = typeof req.query.kind === "string" ? req.query.kind : null;
      const channel = typeof req.query.channel === "string" ? req.query.channel : null;
      const rows = await db.select().from(mktTemplates).where(and(
        eq(mktTemplates.workspaceId, org.id),
        kind ? eq(mktTemplates.kind, kind) : sql`true`,
        channel ? eq(mktTemplates.channel, channel) : sql`true`,
      )).orderBy(desc(mktTemplates.updatedAt));
      res.json(rows);
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  // Create a template.
  app.post("/api/admin/marketing/templates", ...gate, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "Workspace required" });
      const name = String(req.body?.name || "").trim();
      if (!name) return res.status(400).json({ message: "Name required" });
      const [row] = await db.insert(mktTemplates).values({
        workspaceId: org.id,
        name,
        channel: req.body?.channel === "sms" ? "sms" : "email",
        kind: req.body?.kind === "synced_block" ? "synced_block" : "template",
        subject: req.body?.subject ?? null,
        blockTree: req.body?.blockTree ?? null,
        createdBy: (req.session as any)?.userId ?? null,
      }).returning();
      res.json(row);
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  // Update a template (name / subject / blockTree).
  app.patch("/api/admin/marketing/templates/:id", ...gate, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "Workspace required" });
      const id = num(req.params.id);
      if (id == null) return res.status(400).json({ message: "Bad id" });
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (typeof req.body?.name === "string") patch.name = req.body.name.trim();
      if ("subject" in (req.body ?? {})) patch.subject = req.body.subject ?? null;
      if ("blockTree" in (req.body ?? {})) patch.blockTree = req.body.blockTree ?? null;
      const [row] = await db.update(mktTemplates).set(patch)
        .where(and(eq(mktTemplates.id, id), eq(mktTemplates.workspaceId, org.id))).returning();
      if (!row) return res.status(404).json({ message: "Not found" });
      res.json(row);
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  // Delete a template.
  app.delete("/api/admin/marketing/templates/:id", ...gate, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "Workspace required" });
      const id = num(req.params.id);
      if (id == null) return res.status(400).json({ message: "Bad id" });
      await db.delete(mktTemplates).where(and(eq(mktTemplates.id, id), eq(mktTemplates.workspaceId, org.id)));
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  // Get this workspace's synced header + footer blocks (by reserved name).
  app.get("/api/admin/marketing/synced-blocks", ...gate, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "Workspace required" });
      const rows = await db.select().from(mktTemplates).where(and(
        eq(mktTemplates.workspaceId, org.id),
        eq(mktTemplates.kind, "synced_block"),
        inArray(mktTemplates.name, [SYNCED_NAME.header, SYNCED_NAME.footer]),
      ));
      res.json({
        header: rows.find((r) => r.name === SYNCED_NAME.header) ?? null,
        footer: rows.find((r) => r.name === SYNCED_NAME.footer) ?? null,
      });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  // Upsert the synced header or footer (slot = header|footer) for this workspace.
  app.put("/api/admin/marketing/synced-blocks/:slot", ...gate, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "Workspace required" });
      const name = SYNCED_NAME[String(req.params.slot)];
      if (!name) return res.status(400).json({ message: "slot must be header or footer" });
      const [existing] = await db.select({ id: mktTemplates.id }).from(mktTemplates).where(and(
        eq(mktTemplates.workspaceId, org.id), eq(mktTemplates.name, name), eq(mktTemplates.kind, "synced_block"),
      )).limit(1);
      let row;
      if (existing) {
        [row] = await db.update(mktTemplates).set({
          blockTree: req.body?.blockTree ?? null, subject: req.body?.subject ?? null, updatedAt: new Date(),
        }).where(eq(mktTemplates.id, existing.id)).returning();
      } else {
        [row] = await db.insert(mktTemplates).values({
          workspaceId: org.id, name, kind: "synced_block", channel: "email",
          subject: req.body?.subject ?? null, blockTree: req.body?.blockTree ?? null,
          createdBy: (req.session as any)?.userId ?? null,
        }).returning();
      }
      res.json(row);
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });
}
