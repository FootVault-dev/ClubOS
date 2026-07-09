/**
 * Marketing Suite — public (NO auth) unsubscribe + preference-centre routes.
 *
 *   GET  /api/public/marketing/unsubscribe            branded confirm page (the
 *                                                     visible link; a scanner
 *                                                     prefetch can't opt someone
 *                                                     out — a human must confirm)
 *   POST /api/public/marketing/unsubscribe            confirm from that page
 *   POST /api/public/marketing/unsubscribe/oneclick   RFC 8058 target — instant
 *                                                     brand-scope suppression +
 *                                                     consent opt-out, 200 empty,
 *                                                     NO confirmation gate
 *   GET  /api/public/marketing/preferences            preference centre
 *   POST /api/public/marketing/preferences            apply preference changes
 *
 * All identify the recipient by an opaque, HMAC-signed token (server/marketing/
 * tokens.ts) — no email/id in the URL, so nobody can opt out anyone else.
 *
 * Spec: 05-analytics-deliverability.md Findings 11 & 12; synthesis build directive (a).
 */

import type { Express, Request, Response } from "express";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { mktProfiles, mktConsent, mktSuppressions } from "@shared/schema";
import { verifyUnsubscribeToken, verifyPreferenceToken, signPreferenceToken } from "./tokens";
import { suppress } from "./suppression";
import { brandShell, brandKeyForWorkspace, publicBaseUrl, type BrandShell } from "./brand";

const CATEGORIES = ["news", "offers", "events"] as const;
type Category = typeof CATEGORIES[number];
const CATEGORY_LABEL: Record<Category, string> = { news: "News & updates", offers: "Offers & promotions", events: "Events & fixtures" };

function esc(s: string | null | undefined): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

function page(shell: BrandShell, title: string, inner: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(shell.name)}</title></head>
  <body style="margin:0;background:${shell.bg};color:${shell.fg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:520px;margin:0 auto;padding:56px 24px;">
      ${shell.logoUrl ? `<div style="text-align:center;margin:0 0 20px;"><img src="${shell.logoUrl}" alt="${esc(shell.name)}" width="64" height="64" style="border:0;"/></div>` : ""}
      <p style="text-align:center;color:${shell.accent};margin:0 0 14px;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">${esc(shell.name)}</p>
      <h1 style="text-align:center;font-size:22px;font-weight:700;margin:0 0 18px;color:${shell.fg};">${esc(title)}</h1>
      ${inner}
    </div>
  </body></html>`;
}

const btn = (accent: string) => `display:inline-block;background:${accent};color:#0b0b0b;font-weight:700;font-size:15px;padding:12px 22px;border-radius:10px;border:0;cursor:pointer;text-decoration:none;`;
const linkStyle = (accent: string) => `color:${accent};text-decoration:underline;`;

async function loadProfile(profileId: number, workspaceId: number) {
  const [p] = await db.select({ id: mktProfiles.id, email: mktProfiles.email, phoneE164: mktProfiles.phoneE164 })
    .from(mktProfiles).where(and(eq(mktProfiles.id, profileId), eq(mktProfiles.workspaceId, workspaceId))).limit(1);
  return p;
}

/** Set a profile's email consent back to subscribed/express (voluntary re-opt-in). */
async function resubscribeConsent(profileId: number): Promise<void> {
  const [existing] = await db.select({ id: mktConsent.id }).from(mktConsent)
    .where(and(eq(mktConsent.profileId, profileId), eq(mktConsent.channel, "email"))).limit(1);
  if (existing) {
    await db.update(mktConsent).set({ subState: "subscribed", legalBasis: "express", canReceive: true, updatedAt: new Date() })
      .where(eq(mktConsent.id, existing.id));
  } else {
    await db.insert(mktConsent).values({
      profileId, channel: "email", subState: "subscribed", legalBasis: "express",
      canReceive: true, source: "clubos:marketing:preference_center", consentAt: new Date(),
    }).onConflictDoNothing();
  }
}

/** Remove a specific-scope suppression for this email (used by category/brand re-opt). */
async function removeSuppression(email: string, scope: "brand" | "category", brandKey: string | null, category: string | null): Promise<void> {
  const conds = [eq(mktSuppressions.channel, "email"), eq(mktSuppressions.scope, scope), sql`lower(${mktSuppressions.email}) = ${email.toLowerCase()}`];
  if (brandKey) conds.push(eq(mktSuppressions.brandKey, brandKey));
  if (category) conds.push(eq(mktSuppressions.category, category));
  await db.delete(mktSuppressions).where(and(...conds));
}

async function currentSuppressions(email: string, brandKey: string | null) {
  const rows = await db.select({ scope: mktSuppressions.scope, category: mktSuppressions.category, expiresAt: mktSuppressions.expiresAt })
    .from(mktSuppressions)
    .where(and(eq(mktSuppressions.channel, "email"), sql`lower(${mktSuppressions.email}) = ${email.toLowerCase()}`));
  const isGlobal = rows.some((r) => r.scope === "global");
  const isBrand = rows.some((r) => r.scope === "brand");
  const suppressedCats = new Set(rows.filter((r) => r.scope === "category" && r.category).map((r) => r.category as string));
  return { isGlobal, isBrand, suppressedCats, rows };
}

export function registerMarketingPublicRoutes(app: Express): void {
  const base = publicBaseUrl();

  // ── Confirm page (visible unsubscribe link) ────────────────────────────────
  app.get("/api/public/marketing/unsubscribe", async (req: Request, res: Response) => {
    const token = String(req.query.token || "");
    const payload = verifyUnsubscribeToken(token);
    if (!payload) return res.status(400).send(page(brandShell(null), "Link expired", `<p style="text-align:center;line-height:1.6;">This unsubscribe link is invalid or has expired. Reply to any email and we'll remove you.</p>`));
    const shell = brandShell(payload.workspaceId);
    const prefsToken = signPreferenceToken({ profileId: payload.profileId, workspaceId: payload.workspaceId });
    const inner = `
      <p style="text-align:center;line-height:1.7;font-size:15px;">Unsubscribe from <strong>${esc(shell.name)}</strong> marketing emails? You'll still get essential emails about anything you've registered for.</p>
      <form method="POST" action="${base}/api/public/marketing/unsubscribe?token=${encodeURIComponent(token)}" style="text-align:center;margin:26px 0 18px;">
        <button type="submit" style="${btn(shell.accent)}">Unsubscribe me</button>
      </form>
      <p style="text-align:center;font-size:14px;">Prefer to choose what you get? <a href="${base}/api/public/marketing/preferences?token=${encodeURIComponent(prefsToken)}" style="${linkStyle(shell.accent)}">Manage your preferences</a></p>`;
    res.send(page(shell, "Unsubscribe", inner));
  });

  // ── Confirm POST (from the page's button) ──────────────────────────────────
  app.post("/api/public/marketing/unsubscribe", async (req: Request, res: Response) => {
    const token = String(req.query.token || req.body?.token || "");
    const payload = verifyUnsubscribeToken(token);
    if (!payload) return res.status(400).send(page(brandShell(null), "Link expired", `<p style="text-align:center;">This link is invalid or has expired.</p>`));
    const shell = brandShell(payload.workspaceId);
    try {
      const profile = await loadProfile(payload.profileId, payload.workspaceId);
      const email = profile?.email || null;
      const scope = payload.scope === "global" ? "global" : "brand";
      await suppress({
        email, channel: "email", scope,
        brandKey: scope === "brand" ? brandKeyForWorkspace(payload.workspaceId) : null,
        reason: "unsub_prefs", source: "preference_center", workspaceId: payload.workspaceId,
      });
      res.send(page(shell, "You're unsubscribed", `<p style="text-align:center;line-height:1.7;">Done — you won't receive any more ${esc(shell.name)} marketing emails. You'll still get essential emails about anything you've registered for.</p>`));
    } catch {
      res.status(500).send(page(shell, "Something went wrong", `<p style="text-align:center;">Reply to any email and we'll remove you manually.</p>`));
    }
  });

  // ── RFC 8058 one-click target (mailbox provider POSTs here) ─────────────────
  app.post("/api/public/marketing/unsubscribe/oneclick", async (req: Request, res: Response) => {
    const token = String(req.query.token || req.body?.token || "");
    const payload = verifyUnsubscribeToken(token);
    if (!payload) return res.status(400).end();
    try {
      const profile = await loadProfile(payload.profileId, payload.workspaceId);
      const scope = payload.scope === "global" ? "global" : "brand";
      await suppress({
        email: profile?.email || null, channel: "email", scope,
        brandKey: scope === "brand" ? brandKeyForWorkspace(payload.workspaceId) : null,
        reason: "unsub_oneclick", source: "list-unsubscribe-post", workspaceId: payload.workspaceId,
      });
    } catch (err: any) {
      console.error("[Marketing] one-click unsub error:", err?.message);
    }
    // RFC 8058: return 200 with no confirmation gate.
    res.status(200).end();
  });

  // ── Preference centre (GET) ────────────────────────────────────────────────
  app.get("/api/public/marketing/preferences", async (req: Request, res: Response) => {
    const token = String(req.query.token || "");
    const payload = verifyPreferenceToken(token);
    if (!payload) return res.status(400).send(page(brandShell(null), "Link expired", `<p style="text-align:center;">This link is invalid or has expired.</p>`));
    const shell = brandShell(payload.workspaceId);
    const profile = await loadProfile(payload.profileId, payload.workspaceId);
    if (!profile?.email) return res.status(404).send(page(shell, "Not found", `<p style="text-align:center;">We couldn't find your subscription.</p>`));

    const brandKey = brandKeyForWorkspace(payload.workspaceId);
    const state = await currentSuppressions(profile.email, brandKey);
    const subscribed = !state.isGlobal && !state.isBrand;

    const catRows = CATEGORIES.map((c) => {
      const checked = subscribed && !state.suppressedCats.has(c) ? "checked" : "";
      return `<label style="display:flex;align-items:center;gap:10px;padding:10px 0;font-size:15px;"><input type="checkbox" name="cat_${c}" ${checked} style="width:18px;height:18px;accent-color:${shell.accent};"/> ${esc(CATEGORY_LABEL[c])}</label>`;
    }).join("");

    const inner = `
      <p style="text-align:center;font-size:14px;color:${shell.fg};opacity:.8;margin:0 0 24px;">${esc(profile.email)}</p>
      <form method="POST" action="${base}/api/public/marketing/preferences?token=${encodeURIComponent(token)}">
        <input type="hidden" name="action" value="save"/>
        <label style="display:flex;align-items:center;gap:10px;padding:12px 0;font-size:16px;font-weight:700;border-bottom:1px solid rgba(255,255,255,.12);"><input type="checkbox" name="subscribed" ${subscribed ? "checked" : ""} style="width:18px;height:18px;accent-color:${shell.accent};"/> Subscribed to ${esc(shell.name)}</label>
        <div style="padding:12px 0 4px;font-size:12px;letter-spacing:1px;text-transform:uppercase;opacity:.7;">What you'd like to receive</div>
        ${catRows}
        <div style="text-align:center;margin:24px 0 8px;"><button type="submit" style="${btn(shell.accent)}">Save preferences</button></div>
      </form>
      <div style="display:flex;gap:12px;justify-content:center;margin-top:18px;flex-wrap:wrap;">
        <form method="POST" action="${base}/api/public/marketing/preferences?token=${encodeURIComponent(token)}"><input type="hidden" name="action" value="pause30"/><button type="submit" style="background:transparent;border:1px solid ${shell.accent};color:${shell.accent};padding:9px 16px;border-radius:9px;font-size:13px;cursor:pointer;">Pause for 30 days</button></form>
        <form method="POST" action="${base}/api/public/marketing/preferences?token=${encodeURIComponent(token)}"><input type="hidden" name="action" value="unsuball"/><button type="submit" style="background:transparent;border:1px solid rgba(255,255,255,.25);color:${shell.fg};padding:9px 16px;border-radius:9px;font-size:13px;cursor:pointer;">Unsubscribe from everything</button></form>
      </div>`;
    res.send(page(shell, "Email preferences", inner));
  });

  // ── Preference centre (POST) ───────────────────────────────────────────────
  app.post("/api/public/marketing/preferences", async (req: Request, res: Response) => {
    const token = String(req.query.token || req.body?.token || "");
    const payload = verifyPreferenceToken(token);
    if (!payload) return res.status(400).send(page(brandShell(null), "Link expired", `<p style="text-align:center;">This link is invalid or has expired.</p>`));
    const shell = brandShell(payload.workspaceId);
    const brandKey = brandKeyForWorkspace(payload.workspaceId);
    try {
      const profile = await loadProfile(payload.profileId, payload.workspaceId);
      const email = profile?.email;
      if (!email) return res.status(404).send(page(shell, "Not found", `<p style="text-align:center;">We couldn't find your subscription.</p>`));
      const action = String(req.body?.action || "save");

      if (action === "unsuball") {
        await suppress({ email, channel: "email", scope: "global", reason: "unsub_prefs", source: "preference_center", workspaceId: payload.workspaceId });
        return res.send(page(shell, "Unsubscribed from everything", `<p style="text-align:center;line-height:1.7;">Done — you're off all ${esc(shell.name)} marketing.</p>`));
      }

      if (action === "pause30") {
        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        await suppress({ email, channel: "email", scope: "brand", brandKey, reason: "manual", source: "pause_30d", expiresAt, downgradeConsent: false, workspaceId: payload.workspaceId });
        return res.send(page(shell, "Paused for 30 days", `<p style="text-align:center;line-height:1.7;">We'll take a break — you won't hear from ${esc(shell.name)} for 30 days, then you'll resume automatically.</p>`));
      }

      // action === "save": reconcile the brand + category toggles.
      const wantSubscribed = req.body?.subscribed === "on" || req.body?.subscribed === "true" || req.body?.subscribed === true;
      if (wantSubscribed) {
        await removeSuppression(email, "brand", brandKey, null);
        // Also lift any global suppression the user is now overriding voluntarily.
        await db.delete(mktSuppressions).where(and(eq(mktSuppressions.channel, "email"), eq(mktSuppressions.scope, "global"), sql`lower(${mktSuppressions.email}) = ${email.toLowerCase()}`));
        await resubscribeConsent(payload.profileId);
        for (const c of CATEGORIES) {
          const on = req.body?.[`cat_${c}`] === "on" || req.body?.[`cat_${c}`] === "true";
          if (on) await removeSuppression(email, "category", brandKey, c);
          else await suppress({ email, channel: "email", scope: "category", brandKey, category: c, reason: "unsub_prefs", source: "preference_center", downgradeConsent: false, workspaceId: payload.workspaceId });
        }
      } else {
        await suppress({ email, channel: "email", scope: "brand", brandKey, reason: "unsub_prefs", source: "preference_center", workspaceId: payload.workspaceId });
      }
      res.send(page(shell, "Preferences saved", `<p style="text-align:center;line-height:1.7;">Your ${esc(shell.name)} email preferences have been updated.</p>`));
    } catch (err: any) {
      console.error("[Marketing] preferences error:", err?.message);
      res.status(500).send(page(shell, "Something went wrong", `<p style="text-align:center;">Please try again, or reply to any email.</p>`));
    }
  });
}
