/**
 * Marketing Suite — inbound SMS + delivery-receipt webhooks (Phase F final piece).
 *
 * POST /api/webhooks/sms/inbound — a reply from a recipient (STOP/HELP/anything
 *   else). A STOP-family keyword (EXACT match on the trimmed body — see
 *   sms/index.ts's matchStopKeyword doc comment for why substring matching would
 *   be wrong) suppresses the phone number GLOBALLY across every brand/workspace
 *   (channel='sms') — mirroring the RFC 8058 one-click unsubscribe on the email
 *   side: instant, no confirmation gate (suppress() with scope='global' also
 *   downgrades every matching profile's SMS consent to opted_out — see
 *   suppression.ts). Every inbound message is recorded to mkt_sms_inbound
 *   regardless of keyword match, HELP included (matchedKeyword is null for an
 *   ordinary reply — reaching a human inbox for those is a later phase).
 *
 * POST /api/webhooks/sms/dlr — a delivery-receipt callback (delivered/failed/
 *   expired). Joins back to mkt_sms_messages by provider_message_id (set at
 *   send time by the campaign worker / flows engine) and advances its status.
 *
 * Both routes ask the CONFIGURED provider (getSmsProvider() — whichever
 * adapter SMS_PROVIDER selects) to parse the request, defensively trying the
 * OTHER parse method on that same provider instance before giving up: at
 * least one provider (WebSMS) delivers both delivery receipts AND inbound
 * replies to a single `dlrurl` callback (see sms/README.md), so a provider
 * mis-pointed at only one of these two URLs must not silently drop the other
 * kind of event. verifyWebhook() is called on every request but — per every
 * adapter's documented gap (sms/README.md "Webhook signature verification —
 * an honest gap") — always returns true today; the call exists so a future
 * signed provider fails closed for free, without a code change here.
 *
 * Always 200s (heavy work inside try/catch) — same "never trigger a retry
 * storm over our own bug" contract as the Resend webhook (webhook.ts).
 */
import type { Express, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { mktSmsMessages, mktSmsInbound } from "@shared/schema";
import {
  getSmsProvider, matchStopKeyword, matchHelpKeyword,
  type ProviderRequest, type SmsDeliveryReceipt, type SmsInboundMessage, type SmsDeliveryStatus,
} from "./sms";
import { suppress } from "./suppression";

function toProviderRequest(req: Request): ProviderRequest {
  return {
    headers: req.headers as Record<string, string | string[] | undefined>,
    body: req.body,
    query: req.query as Record<string, string | undefined>,
    rawBody: req.rawBody instanceof Buffer ? req.rawBody.toString("utf8") : undefined,
  };
}

const DLR_STATUS_MAP: Record<SmsDeliveryStatus, "delivered" | "failed" | "undelivered"> = {
  delivered: "delivered",
  failed: "failed",
  expired: "undelivered",
};

async function applyDeliveryReceipt(receipt: SmsDeliveryReceipt): Promise<void> {
  const status = DLR_STATUS_MAP[receipt.status] ?? "failed";
  const set: Record<string, unknown> = { status };
  if (status === "delivered") set.deliveredAt = receipt.at;
  await db.update(mktSmsMessages).set(set as any).where(eq(mktSmsMessages.providerMessageId, receipt.providerMessageId));
}

async function applyInbound(msg: SmsInboundMessage): Promise<void> {
  const stop = matchStopKeyword(msg.body);
  const help = !stop ? matchHelpKeyword(msg.body) : null;

  await db.insert(mktSmsInbound).values({
    phoneE164: msg.from,
    body: msg.body,
    matchedKeyword: stop ?? help ?? null,
    providerMessageId: msg.providerMessageId ?? null,
    receivedAt: msg.at,
  });

  if (stop) {
    // scope='global': a STOP applies to every brand/workspace this phone number
    // is a profile in, not just whichever campaign prompted the reply — the
    // recipient has no way to know (or care) which brand's short code they're
    // replying to. suppress() also downgrades matching profiles' SMS consent.
    await suppress({ phoneE164: msg.from, channel: "sms", scope: "global", reason: "unsub_oneclick", source: "sms_webhook_stop" });
  }
}

export function registerSmsWebhookRoutes(app: Express): void {
  app.post("/api/webhooks/sms/dlr", async (req: Request, res: Response) => {
    try {
      const provider = getSmsProvider();
      const preq = toProviderRequest(req);
      if (!provider.verifyWebhook(preq)) return res.status(400).json({ message: "invalid signature" });

      const receipt = provider.parseDeliveryReceipt(preq);
      if (receipt) { await applyDeliveryReceipt(receipt); return res.status(200).json({ ok: true }); }

      // Defensive fallback — see file header (WebSMS shares one callback URL).
      const inbound = provider.parseInbound(preq);
      if (inbound) { await applyInbound(inbound); return res.status(200).json({ ok: true }); }

      return res.status(200).json({ ok: true, ignored: true });
    } catch (err: any) {
      console.error("[Marketing] sms dlr webhook error (accepted anyway):", err?.message);
      return res.status(200).json({ ok: true, error: "processed_with_errors" });
    }
  });

  app.post("/api/webhooks/sms/inbound", async (req: Request, res: Response) => {
    try {
      const provider = getSmsProvider();
      const preq = toProviderRequest(req);
      if (!provider.verifyWebhook(preq)) return res.status(400).json({ message: "invalid signature" });

      const inbound = provider.parseInbound(preq);
      if (inbound) { await applyInbound(inbound); return res.status(200).json({ ok: true }); }

      // Defensive fallback — see file header (WebSMS shares one callback URL).
      const receipt = provider.parseDeliveryReceipt(preq);
      if (receipt) { await applyDeliveryReceipt(receipt); return res.status(200).json({ ok: true }); }

      return res.status(200).json({ ok: true, ignored: true });
    } catch (err: any) {
      console.error("[Marketing] sms inbound webhook error (accepted anyway):", err?.message);
      return res.status(200).json({ ok: true, error: "processed_with_errors" });
    }
  });
}
