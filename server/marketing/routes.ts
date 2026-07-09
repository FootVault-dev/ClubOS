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
import { and, desc, eq, gt, gte, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "../db";
import { requireAuth, requireTab } from "../auth";
import {
  organizations, mktLists, mktListMembers, mktSegments, mktCampaigns, mktProfiles,
  mktConsent, mktSuppressions, mktEvents, mktMetrics, mktEmailMessages, mktEmailEvents, mktEmailLinkClicks, mktConversions,
  mktTemplates, mktFlows, mktFlowVersions, mktFlowEnrollments, mktFlowStepRuns, mktSmsMessages,
} from "@shared/schema";
import { registerMarketingWebhook } from "./webhook";
import { registerMarketingPublicRoutes } from "./public-routes";
import { resolveAudience, computeSegment, evaluateDefinition, type CampaignAudience } from "./segments";
import { suppress, unsuppress, filterSendable } from "./suppression";
import { sendMarketingEmail } from "./resend-client";
import { addMarketingJob } from "./worker";
import { brandKeyForWorkspace, brandShell, publicBaseUrl } from "./brand";
import { signUnsubscribeToken, signPreferenceToken } from "./tokens";
// Phase E — flows engine helpers + the v1 flow template library + SMS preview.
import { enrollFromListAdd, saveDraftGraph, publishFlow, newestVersion } from "./flows";
import { normalizeGraph } from "./flow-graph";
import { FLOW_TEMPLATES, getFlowTemplate } from "./flow-templates";
import { analyzeSms, appendOptOutSuffix, estimateCost } from "./sms";

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
        // Phase E — list-trigger: enrol newly-added members into any live flow keyed on this list.
        await enrollFromListAdd(org.id, id, profileIds).catch(() => {});
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

  // Live count preview — runs the evaluator on an arbitrary definition, then the
  // suppression gate (email marketing) so the builder shows both the raw match
  // count AND what's actually sendable, matching the wizard's audience-estimate shape.
  app.post("/api/admin/marketing/segments/preview-count", ...gate, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "Workspace required" });
      const ids = await evaluateDefinition(req.body?.definition ?? {}, org.id);
      const gated = await filterSendable(ids, { workspaceId: org.id, channel: "email", isMarketing: true });
      res.json({ total: ids.length, sendable: gated.sendable.length });
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
  // List/search — includes a per-channel consent summary + suppressed flag per
  // row, WITHOUT N+1: one query for the page of profiles, one grouped query for
  // consent across those ids, and two grouped queries (email/phone,
  // channel-aware — mirrors the /profiles/:id fix below) for suppressions,
  // merged in JS. Always 4 queries total, never one per row.
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

      if (rows.length === 0) return res.json([]);

      const lc = (s: string | null | undefined) => (s || "").trim().toLowerCase();
      const ids = rows.map((r) => r.id);

      const consentRows = await db.select({
        profileId: mktConsent.profileId, channel: mktConsent.channel, subState: mktConsent.subState,
      }).from(mktConsent).where(inArray(mktConsent.profileId, ids));
      const consentByProfile = new Map<number, Record<string, string>>();
      for (const c of consentRows) {
        const m = consentByProfile.get(c.profileId) ?? {};
        m[c.channel] = c.subState;
        consentByProfile.set(c.profileId, m);
      }

      const emails = Array.from(new Set(rows.map((r) => lc(r.email)).filter(Boolean)));
      const phones = Array.from(new Set(rows.map((r) => r.phoneE164).filter(Boolean) as string[]));
      const notExpired = or(isNull(mktSuppressions.expiresAt), gt(mktSuppressions.expiresAt, new Date()));
      const suppressedEmails = new Set<string>();
      const suppressedPhones = new Set<string>();
      if (emails.length) {
        const sup = await db.select({ email: mktSuppressions.email }).from(mktSuppressions)
          .where(and(eq(mktSuppressions.channel, "email"), inArray(mktSuppressions.email, emails), notExpired));
        for (const s of sup) if (s.email) suppressedEmails.add(lc(s.email));
      }
      if (phones.length) {
        const sup = await db.select({ phoneE164: mktSuppressions.phoneE164 }).from(mktSuppressions)
          .where(and(eq(mktSuppressions.channel, "sms"), inArray(mktSuppressions.phoneE164, phones), notExpired));
        for (const s of sup) if (s.phoneE164) suppressedPhones.add(s.phoneE164);
      }

      res.json(rows.map((r) => {
        const c = consentByProfile.get(r.id) ?? {};
        return {
          ...r,
          consent: {
            email: { subState: c.email ?? null, suppressed: r.email ? suppressedEmails.has(lc(r.email)) : false },
            sms: { subState: c.sms ?? null, suppressed: r.phoneE164 ? suppressedPhones.has(r.phoneE164) : false },
          },
        };
      }));
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
      // Channel-aware: email suppressions match by email, SMS suppressions match
      // by phone_e164 — a hardcoded channel='email'-by-email-only query would
      // silently hide every SMS suppression (the profile's phone never checked).
      const emailSuppressions = profile.email
        ? await db.select().from(mktSuppressions).where(and(eq(mktSuppressions.channel, "email"), sql`lower(${mktSuppressions.email}) = ${(profile.email || "").toLowerCase()}`))
        : [];
      const smsSuppressions = profile.phoneE164
        ? await db.select().from(mktSuppressions).where(and(eq(mktSuppressions.channel, "sms"), eq(mktSuppressions.phoneE164, profile.phoneE164)))
        : [];
      const suppressions = [...emailSuppressions, ...smsSuppressions];
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
      // Delivered (or sent-and-presumed-good, mirroring the per-campaign analytics
      // fallback) among messages SENT in the last 30 days — the windowed twin of
      // deliveredTotal above.
      const [delivered30] = await db.select({ n: sql<number>`count(*)::int` }).from(mktEmailMessages)
        .where(and(eq(mktEmailMessages.workspaceId, org.id), gte(mktEmailMessages.sentAt, since), inArray(mktEmailMessages.status, ["sent", "delivered"])));
      // Human clicks in the last 30 days — read off the raw event stream (occurred_at),
      // not off message.sentAt, so a click on an older send still counts if it
      // happened this window. Scoped to this workspace via the message join.
      const [humanClicks30] = await db.select({ n: sql<number>`count(*)::int` }).from(mktEmailEvents)
        .innerJoin(mktEmailMessages, eq(mktEmailMessages.id, mktEmailEvents.messageId))
        .where(and(
          eq(mktEmailMessages.workspaceId, org.id), eq(mktEmailEvents.eventType, "email.clicked"),
          eq(mktEmailEvents.isMachine, false), gte(mktEmailEvents.occurredAt, since),
        ));
      // Revenue = conversions on this workspace's campaigns (all-time + windowed).
      const [rev] = await db.select({ cents: sql<number>`coalesce(sum(${mktConversions.revenueCents}),0)::int` })
        .from(mktConversions).innerJoin(mktCampaigns, eq(mktCampaigns.id, mktConversions.campaignId))
        .where(eq(mktCampaigns.workspaceId, org.id));
      const [conv30] = await db.select({
        n: sql<number>`count(*)::int`, cents: sql<number>`coalesce(sum(${mktConversions.revenueCents}),0)::int`,
      }).from(mktConversions).innerJoin(mktCampaigns, eq(mktCampaigns.id, mktConversions.campaignId))
        .where(and(eq(mktCampaigns.workspaceId, org.id), gte(mktConversions.convertedAt, since)));
      const [profiles] = await db.select({ n: sql<number>`count(*)::int` }).from(mktProfiles).where(eq(mktProfiles.workspaceId, org.id));

      const topCampaigns = await db.select({
        id: mktCampaigns.id, name: mktCampaigns.name, status: mktCampaigns.status,
        sentAt: mktCampaigns.sentAt, sentCount: mktCampaigns.sentCount, recipientCount: mktCampaigns.recipientCount,
      }).from(mktCampaigns).where(and(eq(mktCampaigns.workspaceId, org.id), eq(mktCampaigns.status, "sent")))
        .orderBy(desc(mktCampaigns.sentAt)).limit(10);

      const deliveredN = Number(delivered?.n ?? 0);
      const revenue = Number(rev?.cents ?? 0) / 100;
      const sends30dN = Number(sends30?.n ?? 0);
      const delivered30dN = Number(delivered30?.n ?? 0);
      const conversions30dCount = Number(conv30?.n ?? 0);
      const conversions30dRevenueCents = Number(conv30?.cents ?? 0);
      const revenue30d = conversions30dRevenueCents / 100;
      res.json({
        profiles: Number(profiles?.n ?? 0),
        sends30d: sends30dN,
        deliveredTotal: deliveredN,
        revenue,
        revenuePerRecipient: deliveredN ? revenue / deliveredN : 0,
        topCampaigns,
        // Windowed (30d) metrics — the honest, recency-weighted view for the
        // dashboard cards (vs the all-time totals above).
        delivered30dPct: sends30dN ? delivered30dN / sends30dN : 0,
        humanClicks30d: Number(humanClicks30?.n ?? 0),
        conversions30d: { count: conversions30dCount, revenueCents: conversions30dRevenueCents },
        rpr30d: delivered30dN ? revenue30d / delivered30dN : 0,
      });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  // Webhook health (Settings) — last-received event + a 24h pulse, so Daniel can
  // tell at a glance whether Resend is actually calling the webhook (vs "nothing
  // sent yet" vs "misconfigured"). Scoped to this workspace via the message join
  // (mkt_email_events itself carries no workspace_id).
  app.get("/api/admin/marketing/webhook-health", ...gate, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "Workspace required" });
      const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

      const [last] = await db.select({ at: sql<string | null>`max(${mktEmailEvents.receivedAt})` })
        .from(mktEmailEvents).innerJoin(mktEmailMessages, eq(mktEmailMessages.id, mktEmailEvents.messageId))
        .where(eq(mktEmailMessages.workspaceId, org.id));

      const [count24h] = await db.select({ n: sql<number>`count(*)::int` })
        .from(mktEmailEvents).innerJoin(mktEmailMessages, eq(mktEmailMessages.id, mktEmailEvents.messageId))
        .where(and(eq(mktEmailMessages.workspaceId, org.id), gte(mktEmailEvents.receivedAt, since24h)));

      const byType = await db.select({ eventType: mktEmailEvents.eventType, n: sql<number>`count(*)::int` })
        .from(mktEmailEvents).innerJoin(mktEmailMessages, eq(mktEmailMessages.id, mktEmailEvents.messageId))
        .where(and(eq(mktEmailMessages.workspaceId, org.id), gte(mktEmailEvents.receivedAt, since24h)))
        .groupBy(mktEmailEvents.eventType);

      res.json({
        lastEventAt: last?.at ?? null,
        events24h: Number(count24h?.n ?? 0),
        byType24h: Object.fromEntries(byType.map((b) => [b.eventType, Number(b.n)])),
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

  // ═════════════════════════════ Flows (Phase E) ═════════════════════════════
  // The automations engine: versioned flow graphs, event/list/date triggers, the
  // abandoned-enrolment derivation, and per-step analytics. Every message step
  // sends through the SAME suppression gate + segment evaluator as campaigns.

  // Per-flow rollup stats (kept O(flows), not O(enrollments)).
  async function flowStats(flowId: number) {
    const [enr] = await db.select({
      total: sql<number>`count(*)::int`,
      active: sql<number>`count(*) filter (where status = 'active')::int`,
      completed: sql<number>`count(*) filter (where status = 'completed')::int`,
      exited: sql<number>`count(*) filter (where status in ('exited','cancelled'))::int`,
    }).from(mktFlowEnrollments).where(eq(mktFlowEnrollments.flowId, flowId));
    const [sent] = await db.select({ n: sql<number>`count(*)::int` })
      .from(mktFlowStepRuns).innerJoin(mktFlowEnrollments, eq(mktFlowEnrollments.id, mktFlowStepRuns.enrollmentId))
      .where(and(eq(mktFlowEnrollments.flowId, flowId), eq(mktFlowStepRuns.status, "sent")));
    const [conv] = await db.select({
      count: sql<number>`count(*)::int`, revenueCents: sql<number>`coalesce(sum(${mktConversions.revenueCents}),0)::int`,
    }).from(mktConversions).innerJoin(mktEmailMessages, eq(mktEmailMessages.id, mktConversions.messageId))
      .where(eq(mktEmailMessages.flowId, flowId));
    return {
      totalEnrollments: Number(enr?.total ?? 0), activeEnrollments: Number(enr?.active ?? 0),
      completed: Number(enr?.completed ?? 0), exited: Number(enr?.exited ?? 0),
      messagesSent: Number(sent?.n ?? 0),
      conversions: Number(conv?.count ?? 0), revenue: Number(conv?.revenueCents ?? 0) / 100,
    };
  }

  function reEntryBool(triggerConfig: any): boolean {
    const p = triggerConfig?.reEntry;
    return p != null && p !== "never";
  }

  // The v1 flow template gallery (static). Registered BEFORE /flows/:id so the
  // literal 'templates' segment isn't captured as an id.
  app.get("/api/admin/marketing/flows/templates", ...gate, async (_req, res) => {
    res.json(FLOW_TEMPLATES.map((t) => ({
      key: t.key, name: t.name, description: t.description, expectedImpact: t.expectedImpact,
      triggerType: t.triggerType, stepCount: t.graph.steps.length,
    })));
  });

  // SMS body preview — segments / chars / encoding / cost (server-side; analyzeSms
  // is a server module, so the editor calls this instead of importing it).
  app.post("/api/admin/marketing/flows/preview-sms", ...gate, async (req, res) => {
    try {
      const raw = String(req.body?.body || "");
      const isMarketing = req.body?.isMarketing !== false;
      const finalBody = isMarketing ? appendOptOutSuffix(raw) : raw;
      const a = analyzeSms(finalBody);
      const centsPerSegment = Number(process.env.SMS_CENTS_PER_SEGMENT || "10");
      res.json({
        encoding: a.encoding, chars: a.chars, segments: a.segments, segmentLength: a.segmentLength,
        offendingChars: a.offendingChars, finalBody,
        costEstimatePerRecipientCents: estimateCost(a.segments, 1, centsPerSegment),
      });
    } catch (e: any) { res.status(400).json({ message: e.message }); }
  });

  app.get("/api/admin/marketing/flows", ...gate, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "Workspace required" });
      const flows = await db.select().from(mktFlows).where(eq(mktFlows.workspaceId, org.id)).orderBy(desc(mktFlows.createdAt));
      const withStats = await Promise.all(flows.map(async (f) => ({ ...f, stats: await flowStats(f.id) })));
      res.json(withStats);
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  // Create — from a template or blank. Always starts as a DRAFT (nothing sends
  // until the user reviews + publishes).
  app.post("/api/admin/marketing/flows", ...gate, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "Workspace required" });
      const b = req.body || {};
      let triggerType: string, triggerConfig: any, entryFilter: any, name: string, graph: any;
      if (b.templateKey) {
        const t = getFlowTemplate(String(b.templateKey));
        if (!t) return res.status(400).json({ message: "Unknown template" });
        triggerType = t.triggerType; triggerConfig = t.triggerConfig; entryFilter = t.entryFilter ?? null;
        name = String(b.name || t.name); graph = t.graph;
      } else {
        triggerType = ["event", "list", "segment", "date_property"].includes(b.triggerType) ? b.triggerType : "event";
        triggerConfig = b.triggerConfig ?? {}; entryFilter = b.entryFilter ?? null;
        name = String(b.name || "Untitled flow"); graph = { steps: [], entry: null };
      }
      const [flow] = await db.insert(mktFlows).values({
        workspaceId: org.id, name, status: "draft", triggerType: triggerType as any,
        triggerConfig, entryFilter, reEntry: reEntryBool(triggerConfig),
      }).returning();
      await saveDraftGraph(flow.id, normalizeGraph(graph));
      const draft = await newestVersion(flow.id);
      res.json({ ...flow, draftGraph: draft?.graph ?? { steps: [] }, stats: await flowStats(flow.id) });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.get("/api/admin/marketing/flows/:id", ...gate, async (req, res) => {
    try {
      const org = await workspaceOrg(req); const id = num(req.params.id);
      if (!org || id == null) return res.status(400).json({ message: "Bad request" });
      const [flow] = await db.select().from(mktFlows).where(and(eq(mktFlows.id, id), eq(mktFlows.workspaceId, org.id))).limit(1);
      if (!flow) return res.status(404).json({ message: "Not found" });
      const draft = await newestVersion(flow.id);
      const live = flow.liveVersionId != null
        ? (await db.select().from(mktFlowVersions).where(eq(mktFlowVersions.id, flow.liveVersionId)).limit(1))[0] ?? null
        : null;
      res.json({
        ...flow,
        draftGraph: draft?.graph ?? { steps: [] },
        draftVersionId: draft?.id ?? null,
        draftDirty: draft ? draft.publishedAt == null : false,
        liveVersion: live ? { id: live.id, versionNo: live.versionNo, publishedAt: live.publishedAt } : null,
        stats: await flowStats(flow.id),
      });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  // Update settings (never the graph — that's the draft endpoint).
  app.patch("/api/admin/marketing/flows/:id", ...gate, async (req, res) => {
    try {
      const org = await workspaceOrg(req); const id = num(req.params.id);
      if (!org || id == null) return res.status(400).json({ message: "Bad request" });
      const b = req.body || {};
      const patch: any = { updatedAt: new Date() };
      if (b.name !== undefined) patch.name = String(b.name);
      if (b.triggerType !== undefined && ["event", "list", "segment", "date_property"].includes(b.triggerType)) patch.triggerType = b.triggerType;
      if (b.triggerConfig !== undefined) { patch.triggerConfig = b.triggerConfig; patch.reEntry = reEntryBool(b.triggerConfig); }
      if (b.entryFilter !== undefined) patch.entryFilter = b.entryFilter;
      if (b.quietHours !== undefined) patch.quietHours = b.quietHours;
      const [row] = await db.update(mktFlows).set(patch).where(and(eq(mktFlows.id, id), eq(mktFlows.workspaceId, org.id))).returning();
      res.json(row ?? null);
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  // Save the draft graph (leaves the live version + running enrollments untouched).
  app.put("/api/admin/marketing/flows/:id/draft", ...gate, async (req, res) => {
    try {
      const org = await workspaceOrg(req); const id = num(req.params.id);
      if (!org || id == null) return res.status(400).json({ message: "Bad request" });
      const [flow] = await db.select({ id: mktFlows.id }).from(mktFlows).where(and(eq(mktFlows.id, id), eq(mktFlows.workspaceId, org.id))).limit(1);
      if (!flow) return res.status(404).json({ message: "Not found" });
      const graph = normalizeGraph(req.body?.graph);
      const versionId = await saveDraftGraph(id, graph);
      res.json({ ok: true, versionId, graph });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  // Publish — new entrants get the new version; running enrollments keep theirs.
  app.post("/api/admin/marketing/flows/:id/publish", ...gate, async (req, res) => {
    try {
      const org = await workspaceOrg(req); const id = num(req.params.id);
      if (!org || id == null) return res.status(400).json({ message: "Bad request" });
      const [flow] = await db.select({ id: mktFlows.id }).from(mktFlows).where(and(eq(mktFlows.id, id), eq(mktFlows.workspaceId, org.id))).limit(1);
      if (!flow) return res.status(404).json({ message: "Not found" });
      const published = await publishFlow(id);
      if (!published) return res.status(400).json({ message: "Nothing to publish — add at least one step first" });
      res.json({ ok: true, ...published });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.post("/api/admin/marketing/flows/:id/pause", ...gate, async (req, res) => {
    try {
      const org = await workspaceOrg(req); const id = num(req.params.id);
      if (!org || id == null) return res.status(400).json({ message: "Bad request" });
      const [row] = await db.update(mktFlows).set({ status: "paused", updatedAt: new Date() })
        .where(and(eq(mktFlows.id, id), eq(mktFlows.workspaceId, org.id))).returning();
      res.json(row ?? null);
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.post("/api/admin/marketing/flows/:id/resume", ...gate, async (req, res) => {
    try {
      const org = await workspaceOrg(req); const id = num(req.params.id);
      if (!org || id == null) return res.status(400).json({ message: "Bad request" });
      const [flow] = await db.select().from(mktFlows).where(and(eq(mktFlows.id, id), eq(mktFlows.workspaceId, org.id))).limit(1);
      if (!flow) return res.status(404).json({ message: "Not found" });
      if (flow.liveVersionId == null) return res.status(400).json({ message: "Publish the flow before setting it live" });
      const [row] = await db.update(mktFlows).set({ status: "live", updatedAt: new Date() }).where(eq(mktFlows.id, id)).returning();
      res.json(row);
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.delete("/api/admin/marketing/flows/:id", ...gate, async (req, res) => {
    try {
      const org = await workspaceOrg(req); const id = num(req.params.id);
      if (!org || id == null) return res.status(400).json({ message: "Bad request" });
      await db.delete(mktFlows).where(and(eq(mktFlows.id, id), eq(mktFlows.workspaceId, org.id)));
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  // Enrollment list for a flow (most-recent first, joined to the profile).
  app.get("/api/admin/marketing/flows/:id/enrollments", ...gate, async (req, res) => {
    try {
      const org = await workspaceOrg(req); const id = num(req.params.id);
      if (!org || id == null) return res.status(400).json({ message: "Bad request" });
      const [flow] = await db.select({ id: mktFlows.id }).from(mktFlows).where(and(eq(mktFlows.id, id), eq(mktFlows.workspaceId, org.id))).limit(1);
      if (!flow) return res.status(404).json({ message: "Not found" });
      const rows = await db.select({
        id: mktFlowEnrollments.id, status: mktFlowEnrollments.status, currentStepId: mktFlowEnrollments.currentStepId,
        enteredAt: mktFlowEnrollments.enteredAt, exitedAt: mktFlowEnrollments.exitedAt, exitReason: mktFlowEnrollments.exitReason,
        email: mktProfiles.email, firstName: mktProfiles.firstName, lastName: mktProfiles.lastName,
      }).from(mktFlowEnrollments).leftJoin(mktProfiles, eq(mktProfiles.id, mktFlowEnrollments.profileId))
        .where(eq(mktFlowEnrollments.flowId, id)).orderBy(desc(mktFlowEnrollments.enteredAt)).limit(200);
      res.json(rows);
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  // Per-step analytics — sent / skipped / failed per step id, from the step-run
  // ledger, plus the flow-level enrollment + conversion rollup.
  app.get("/api/admin/marketing/flows/:id/analytics", ...gate, async (req, res) => {
    try {
      const org = await workspaceOrg(req); const id = num(req.params.id);
      if (!org || id == null) return res.status(400).json({ message: "Bad request" });
      const [flow] = await db.select().from(mktFlows).where(and(eq(mktFlows.id, id), eq(mktFlows.workspaceId, org.id))).limit(1);
      if (!flow) return res.status(404).json({ message: "Not found" });

      const runs = await db.select({
        stepId: mktFlowStepRuns.stepId,
        sent: sql<number>`count(*) filter (where ${mktFlowStepRuns.status} = 'sent')::int`,
        skipped: sql<number>`count(*) filter (where ${mktFlowStepRuns.status} = 'skipped')::int`,
        failed: sql<number>`count(*) filter (where ${mktFlowStepRuns.status} = 'failed')::int`,
      }).from(mktFlowStepRuns).innerJoin(mktFlowEnrollments, eq(mktFlowEnrollments.id, mktFlowStepRuns.enrollmentId))
        .where(eq(mktFlowEnrollments.flowId, id)).groupBy(mktFlowStepRuns.stepId);

      const perStep: Record<string, { sent: number; skipped: number; failed: number }> = {};
      for (const r of runs) perStep[r.stepId] = { sent: Number(r.sent), skipped: Number(r.skipped), failed: Number(r.failed) };

      res.json({ flow: { id: flow.id, name: flow.name, status: flow.status }, perStep, stats: await flowStats(flow.id) });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  // Send a test of one email step to an arbitrary address (no gate — sender's own inbox).
  app.post("/api/admin/marketing/flows/:id/test-email", ...gate, async (req, res) => {
    try {
      const org = await workspaceOrg(req); const id = num(req.params.id);
      if (!org || id == null) return res.status(400).json({ message: "Bad request" });
      const to = String(req.body?.to || "").trim();
      const stepId = String(req.body?.stepId || "");
      if (!to || !stepId) return res.status(400).json({ message: "Recipient + stepId required" });
      const [flow] = await db.select().from(mktFlows).where(and(eq(mktFlows.id, id), eq(mktFlows.workspaceId, org.id))).limit(1);
      if (!flow) return res.status(404).json({ message: "Not found" });
      const draft = await newestVersion(id);
      const graph = normalizeGraph(draft?.graph);
      const step = graph.steps.find((s) => s.id === stepId);
      if (!step || step.type !== "email") return res.status(400).json({ message: "Email step not found" });

      const shell = brandShell(org.id);
      const base = publicBaseUrl();
      const unsubToken = signUnsubscribeToken({ profileId: 0, workspaceId: org.id, scope: "brand" });
      const oneClickUrl = `${base}/api/public/marketing/unsubscribe/oneclick?token=${encodeURIComponent(unsubToken)}`;
      let html = String((step.config as any)?.bodyHtml || "<p>(no content yet)</p>")
        .replace(/\{\{\s*first_name\s*\}\}/gi, "there").replace(/\{\{\s*(last_name|email)\s*\}\}/gi, "");
      if (!html.includes(oneClickUrl)) {
        html += `<div style="margin-top:24px;font-size:12px;color:#8a8a8a;text-align:center;">${shell.name} · <a href="${oneClickUrl}">Unsubscribe</a></div>`;
      }
      const isMkt = (step.config as any)?.isMarketing !== false;
      const result = await sendMarketingEmail({
        orgId: org.id, to, subject: `[TEST] ${(step.config as any)?.subject || flow.name}`, html,
        idempotencyKey: `flowtest-${id}-${stepId}-${Date.now()}`, stream: isMkt ? "marketing" : "transactional",
        listUnsubscribeUrl: oneClickUrl,
      });
      if (!result.ok) return res.status(502).json({ message: result.error || "Send failed" });
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });
}
