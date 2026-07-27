/**
 * Marketing Suite — the Resend webhook pipeline (POST /api/webhooks/resend).
 *
 * Resend = transport + a raw event stream; ClubOS = the honest analytics
 * warehouse. This endpoint:
 *   - verifies the Svix HMAC signature over the RAW body (spoof-proof); rejects
 *     if RESEND_WEBHOOK_SECRET is missing in production, logs-and-accepts in dev;
 *   - is idempotent on svix-id (ON CONFLICT DO NOTHING) — Svix is at-least-once;
 *   - maps resend_email_id → mkt_email_messages and advances a FORWARD-ONLY
 *     status machine (order is NOT guaranteed) + first_opened/clicked + counts;
 *   - tags machine opens (Apple MPP / fast pre-fetch) and bot clicks (scanner
 *     UA / <3s-after-delivery / honeypot) so only humans are ever headlined;
 *   - auto-suppresses (global) + opts consent out on complaint / hard bounce /
 *     email.suppressed — what keeps us under the 0.1% complaint line;
 *   - returns 200 FAST, all heavy work inside try/catch so our own bugs never
 *     trigger a Svix retry storm.
 *
 * Spec: 05-analytics-deliverability.md §B + Findings 2, 5, 7, 8.
 */

import type { Express, Request, Response } from "express";
import { Webhook } from "svix";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { mktEmailEvents, mktEmailMessages, mktEmailLinkClicks } from "@shared/schema";
import { suppress } from "./suppression";

const WEBHOOK_SECRET = process.env.RESEND_WEBHOOK_SECRET || "";
const HONEYPOT_MARKER = "mkt-hp"; // a hidden honeypot link carrying this marker ⇒ any click on it is a bot

// Security scanners that follow links before delivery (their clicks are bots).
const SCANNER_UA = /(microsoft|safelinks|outlook|proofpoint|mimecast|barracuda|forcepoint|symantec|messagelabs|cisco|ironport|google\s?security|curl|wget|python-requests|go-http-client|axios|node-fetch|headless|bot|crawler|scanner)/i;
// Apple Mail Privacy Protection proxy / generic pre-fetch machine opens.
const APPLE_MACHINE_UA = /(applemail|mail\/|macintosh.*mail|iphone.*mail|gcimageproxy|googleimageproxy|apple-)/i;

// Forward-only status rank — a late `sent` must never overwrite `delivered`.
const STATUS_RANK: Record<string, number> = { queued: 0, scheduled: 1, sent: 2, delivered: 3 };

function pick<T = any>(obj: any, ...paths: string[]): T | undefined {
  for (const p of paths) {
    const v = p.split(".").reduce((o: any, k) => (o == null ? undefined : o[k]), obj);
    if (v != null) return v as T;
  }
  return undefined;
}

function toDate(v: unknown): Date {
  if (!v) return new Date();
  const d = new Date(v as any);
  return isNaN(d.getTime()) ? new Date() : d;
}

export function registerMarketingWebhook(app: Express): void {
  app.post("/api/webhooks/resend", async (req: Request, res: Response) => {
    // 1. Verify. The raw body is preserved globally by express.json's `verify`.
    const raw = req.rawBody instanceof Buffer ? req.rawBody.toString("utf8") : JSON.stringify(req.body ?? {});
    const svixId = String(req.headers["svix-id"] || "");
    const svixTimestamp = String(req.headers["svix-timestamp"] || "");
    const svixSignature = String(req.headers["svix-signature"] || "");

    let payload: any;
    if (WEBHOOK_SECRET) {
      try {
        const wh = new Webhook(WEBHOOK_SECRET);
        payload = wh.verify(raw, {
          "svix-id": svixId, "svix-timestamp": svixTimestamp, "svix-signature": svixSignature,
        });
      } catch (err: any) {
        console.warn("[Marketing webhook] signature verification failed:", err?.message);
        return res.status(400).json({ message: "invalid signature" });
      }
    } else {
      if (process.env.NODE_ENV === "production") {
        console.error("[Marketing webhook] RESEND_WEBHOOK_SECRET missing in production — rejecting");
        return res.status(500).json({ message: "webhook secret not configured" });
      }
      console.warn("[Marketing webhook] no RESEND_WEBHOOK_SECRET — accepting UNVERIFIED (dev only)");
      try { payload = req.rawBody instanceof Buffer ? JSON.parse(raw) : req.body; } catch { payload = req.body; }
    }

    // Everything below is best-effort — always 200 so Svix never retries on our bugs.
    try {
      const eventType = String(payload?.type || "");
      const data = payload?.data || {};
      const resendEmailId: string | null = pick<string>(data, "email_id", "id") ?? null;
      const occurredAt = toDate(payload?.created_at || data?.created_at);

      // Locate our message row (may be null for e.g. transactional mail not tracked here).
      let message: { id: number; status: string; deliveredAt: Date | null; profileId: number | null; campaignId: number | null; toEmail: string | null; workspaceId: number | null; brandKey: string | null } | undefined;
      if (resendEmailId) {
        const [m] = await db.select({
          id: mktEmailMessages.id, status: mktEmailMessages.status, deliveredAt: mktEmailMessages.deliveredAt,
          profileId: mktEmailMessages.profileId, campaignId: mktEmailMessages.campaignId,
          toEmail: mktEmailMessages.toEmail, workspaceId: mktEmailMessages.workspaceId, brandKey: mktEmailMessages.brandKey,
        }).from(mktEmailMessages).where(eq(mktEmailMessages.resendEmailId, resendEmailId)).limit(1);
        message = m;
      }

      // Enrichment (open/click detail).
      const linkUrl = pick<string>(data, "click.link", "link", "click.url") ?? null;
      const ipAddress = pick<string>(data, "click.ipAddress", "open.ipAddress", "ip_address", "click.ip", "open.ip") ?? null;
      const userAgent = pick<string>(data, "click.userAgent", "open.userAgent", "user_agent", "click.user_agent", "open.user_agent") ?? null;

      // Honesty tagging.
      const deliveredAt = message?.deliveredAt ?? null;
      const secsSinceDelivery = deliveredAt ? (occurredAt.getTime() - deliveredAt.getTime()) / 1000 : null;
      let isMachine = false;
      let machineReason: string | null = null;
      if (eventType === "email.opened") {
        if (userAgent && APPLE_MACHINE_UA.test(userAgent)) { isMachine = true; machineReason = "apple_mpp"; }
        else if (secsSinceDelivery != null && secsSinceDelivery >= 0 && secsSinceDelivery < 2) { isMachine = true; machineReason = "fast_prefetch"; }
      } else if (eventType === "email.clicked") {
        if (linkUrl && linkUrl.includes(HONEYPOT_MARKER)) { isMachine = true; machineReason = "honeypot"; }
        else if (userAgent && SCANNER_UA.test(userAgent)) { isMachine = true; machineReason = "scanner_ua"; }
        else if (secsSinceDelivery != null && secsSinceDelivery >= 0 && secsSinceDelivery < 3) { isMachine = true; machineReason = "fast_click"; }
      }

      // 2. Idempotent raw-event insert (dedupe on svix-id).
      const inserted = await db.insert(mktEmailEvents).values({
        svixId: svixId || null,
        eventType,
        resendEmailId,
        messageId: message?.id ?? null,
        occurredAt,
        linkUrl,
        ipAddress,
        userAgent,
        isMachine,
        machineReason,
        rawPayload: payload,
      }).onConflictDoNothing().returning({ id: mktEmailEvents.id });

      if (inserted.length === 0) {
        // Duplicate delivery — side effects already applied.
        return res.status(200).json({ ok: true, deduped: true });
      }

      // 3. Apply side effects to the message + suppression.
      if (message) {
        await applyToMessage(message, eventType, occurredAt, isMachine, { linkUrl, campaignId: message.campaignId, profileId: message.profileId });
      }

      // 4. Complaint / hard bounce / suppressed → auto-suppress (global) + opt out.
      const suppressEmail = message?.toEmail || pick<string[]>(data, "to")?.[0] || pick<string>(data, "to") || null;
      if (eventType === "email.complained" && suppressEmail) {
        await suppress({ email: suppressEmail, channel: "email", scope: "global", reason: "complaint", source: "resend_webhook" });
      } else if (eventType === "email.bounced" && suppressEmail) {
        const bounceType = pick<string>(data, "bounce.type", "bounce.subType", "bounceType") || "";
        const isHard = !bounceType || /hard|permanent|block|suppress/i.test(bounceType);
        if (isHard) await suppress({ email: suppressEmail, channel: "email", scope: "global", reason: "hard_bounce", source: "resend_webhook" });
      } else if (eventType === "email.suppressed" && suppressEmail) {
        await suppress({ email: suppressEmail, channel: "email", scope: "global", reason: "invalid", source: "resend_webhook" });
      }

      return res.status(200).json({ ok: true });
    } catch (err: any) {
      // Never surface a 500 that would provoke a Svix retry storm on our own bug.
      console.error("[Marketing webhook] processing error (accepted anyway):", err?.message);
      return res.status(200).json({ ok: true, error: "processed_with_errors" });
    }
  });
}

async function applyToMessage(
  message: { id: number; status: string; deliveredAt: Date | null },
  eventType: string,
  occurredAt: Date,
  isMachine: boolean,
  extra: { linkUrl: string | null; campaignId: number | null; profileId: number | null },
): Promise<void> {
  const set: Record<string, unknown> = {};
  const advance = (target: string) => {
    if ((STATUS_RANK[target] ?? -1) > (STATUS_RANK[message.status] ?? -1)) set.status = target;
  };

  switch (eventType) {
    case "email.sent":
      advance("sent"); if (!("sentAt" in set)) set.sentAt = occurredAt; break;
    case "email.delivered":
      advance("delivered"); set.deliveredAt = occurredAt; break;
    case "email.bounced":
      set.status = "bounced"; set.bouncedAt = occurredAt; break;
    case "email.complained":
      set.status = "complained"; set.complainedAt = occurredAt; break;
    case "email.failed":
      // Only mark failed if not already delivered/opened.
      if ((STATUS_RANK[message.status] ?? -1) < STATUS_RANK.delivered) set.status = "failed";
      break;
    case "email.opened":
      set.openCount = sql`${mktEmailMessages.openCount} + 1`;
      if (!isMachine) set.humanOpenCount = sql`${mktEmailMessages.humanOpenCount} + 1`;
      set.firstOpenedAt = sql`COALESCE(${mktEmailMessages.firstOpenedAt}, ${occurredAt.toISOString()})`;
      break;
    case "email.clicked":
      set.clickCount = sql`${mktEmailMessages.clickCount} + 1`;
      if (!isMachine) set.humanClickCount = sql`${mktEmailMessages.humanClickCount} + 1`;
      set.firstClickedAt = sql`COALESCE(${mktEmailMessages.firstClickedAt}, ${occurredAt.toISOString()})`;
      break;
    default:
      break;
  }

  if (Object.keys(set).length) {
    await db.update(mktEmailMessages).set(set as any).where(eq(mktEmailMessages.id, message.id));
  }

  if (eventType === "email.clicked") {
    await db.insert(mktEmailLinkClicks).values({
      messageId: message.id,
      campaignId: extra.campaignId ?? null,
      profileId: extra.profileId ?? null,
      linkUrl: extra.linkUrl ?? null,
      isBot: isMachine,
      clickedAt: occurredAt,
    });
  }
}
