// Marketing Suite — WebSMS (NZ) provider adapter (Phase F part 1).
//
// WebSMS (websms.co.nz) — the other NZ-native aggregator recommended in
// outputs/deep-research/2026-07-09-clubos-marketing-suite/04-sms-marketing-nz.md
// (~10c NZD/segment, free shared zero-rated short code). No WebSMS account is
// open yet — see ../README.md "Provider setup" for what Daniel needs to do
// before SMS_PROVIDER=websms can be used.
//
// Sourced from WebSMS's own docs (fetched 2026-07-09):
//   https://websms.co.nz/web2sms.php        (legacy send.php GET API — implemented below)
//   https://websms.co.nz/api/openapi/       (newer "Connexus" JSON/bearer-token API)
// WebSMS's site explicitly recommends the Connexus API for NEW integrations, but
// its exact request/response field names could only be extracted via an
// AI-summarized OpenAPI read (lower confidence than the legacy API, which has
// concrete worked examples in the docs). This adapter targets the legacy
// send.php API for that reason — it's the best-corroborated shape. See the
// TODO(verify-live) notes below for the Connexus migration path once a real
// account exists and the OpenAPI spec can be checked directly.

import type {
  ProviderRequest,
  SmsDeliveryReceipt,
  SmsDeliveryStatus,
  SmsInboundMessage,
  SmsProvider,
  SmsSendInput,
  SmsSendResult,
} from "../types";
import { analyzeSms, estimateCost } from "../encoding";

const DEFAULT_BASE_URL = "https://websms.co.nz/api";

function readCentsPerSegment(): number {
  const raw = process.env.SMS_COST_CENTS_PER_SEGMENT;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
}

/** WebSMS examples use dialling format without a leading '+' (e.g. "64271234567") — strip it. */
function toNzDiallingFormat(e164: string): string {
  return e164.startsWith("+") ? e164.slice(1) : e164;
}

/**
 * Documented DLR status codes (websms.co.nz/web2sms.php):
 *   1=Delivered  2=Failed  4=Buffered  8=Queued  16=Rejected
 * Buffered/Queued are in-flight, not terminal — map to null so the caller waits
 * for a later terminal callback rather than recording a fake status.
 */
function mapWebSmsDlrCode(code: number): SmsDeliveryStatus | null {
  switch (code) {
    case 1:
      return "delivered";
    case 2:
      return "failed";
    case 16:
      return "failed"; // rejected
    default:
      return null; // 4=buffered, 8=queued
  }
}

/** Reads params from either a parsed query object or a query-decoded body — GET callbacks land in one or the other depending on how the wiring layer shapes ProviderRequest. */
function readParams(req: ProviderRequest): Record<string, any> | null {
  if (req.query) return req.query;
  if (typeof req.body === "object" && req.body !== null) return req.body as Record<string, any>;
  return null;
}

export class WebSmsProvider implements SmsProvider {
  readonly name = "websms";
  private warnedNoSignature = false;

  private get username(): string {
    const u = process.env.WEBSMS_USERNAME;
    if (!u) throw new Error("[sms/websms] WEBSMS_USERNAME is not set — cannot send via WebSMS (see sms/README.md).");
    return u;
  }

  private get password(): string {
    const p = process.env.WEBSMS_PASSWORD;
    if (!p) throw new Error("[sms/websms] WEBSMS_PASSWORD is not set — cannot send via WebSMS (see sms/README.md).");
    return p;
  }

  private get baseUrl(): string {
    return process.env.WEBSMS_API_BASE_URL || DEFAULT_BASE_URL;
  }

  /**
   * Registered per-send via the `dlrurl` query param (the only callback-registration
   * mechanism the legacy API documents — there's no separate "register webhook" call like
   * Connexus has). Per the docs, BOTH delivery receipts (?id=&dlr=) and inbound replies
   * (?id=+<id>&reply=) land on this same URL, so one env var covers both.
   */
  private get callbackUrl(): string | undefined {
    return process.env.WEBSMS_CALLBACK_URL;
  }

  async send(msg: SmsSendInput): Promise<SmsSendResult> {
    const analysis = analyzeSms(msg.body);
    const centsPerSegment = readCentsPerSegment();

    // NOTE on sender ID: as with TNZ, NZ marketing SMS runs on a shared, zero-rated short
    // code — the legacy send.php API documents no per-message sender-ID override field, so
    // `msg.senderId` / SMS_SENDER_ID is NOT wired into this request. There is nothing
    // confirmed to put it in on the legacy API (Connexus's `from` field is the migration
    // path if/when a dedicated code is provisioned — see the file header).
    void msg.senderId;

    const params = new URLSearchParams({
      username: this.username,
      password: this.password,
      premium: "1", // request a delivery report — without this there's nothing to join a DLR webhook against
      cellnum: toNzDiallingFormat(msg.to),
      message: msg.body,
    });
    if (this.callbackUrl) params.set("dlrurl", this.callbackUrl);
    // TODO(verify-live): the legacy API has no documented client-reference field, so
    // msg.clientRef can't be passed through to WebSMS itself — it's only usable locally
    // (e.g. to correlate the returned providerMessageId back to the caller's own record)
    // until/unless this migrates to Connexus, which documents a `messageId` field for this.
    void msg.clientRef;

    const url = `${this.baseUrl}/send.php?${params.toString()}`;
    const res = await fetch(url, { method: "GET" });
    const text = (await res.text()).trim();

    // Documented response format: "OK:Queued:109720" success / "NOK:<reason>:<message>" error.
    const parts = text.split(":");
    const status = parts[0];
    if (status !== "OK" || !res.ok) {
      throw new Error(`[sms/websms] send failed: ${text || `HTTP ${res.status}`}`);
    }
    const providerMessageId = parts[parts.length - 1]?.trim();
    if (!providerMessageId) {
      throw new Error(`[sms/websms] send returned OK but no message id could be parsed from response: "${text}"`);
    }

    return {
      providerMessageId,
      segments: analysis.segments,
      costCentsEstimate: estimateCost(analysis.segments, 1, centsPerSegment),
    };
  }

  parseDeliveryReceipt(req: ProviderRequest): SmsDeliveryReceipt | null {
    const q = readParams(req);
    if (!q) return null;
    // Inbound replies also land on this same callback URL (see parseInbound) — a `+`-prefixed
    // id or a `reply` param means it's NOT a delivery receipt, so bail out and let
    // parseInbound handle it instead.
    if (q.reply !== undefined || String(q.id ?? "").startsWith("+")) return null;

    const id = q.id;
    const dlrRaw = q.dlr;
    if (id === undefined || dlrRaw === undefined) return null;

    const code = Number(dlrRaw);
    const status = mapWebSmsDlrCode(code);
    if (!status) return null;

    return {
      providerMessageId: String(id),
      status,
      at: new Date(),
    };
  }

  parseInbound(req: ProviderRequest): SmsInboundMessage | null {
    const q = readParams(req);
    if (!q) return null;

    const idRaw = q.id;
    const reply = q.reply;
    if (idRaw === undefined || reply === undefined) return null;
    if (!String(idRaw).startsWith("+")) return null; // '+' prefix marks an inbound reply per the docs

    // TODO(verify-live): the docs' worked example for inbound replies
    // ("id=+109720&reply=Reply Text") doesn't show the replying phone number's field name at
    // all — only the original outbound message id + reply text. Trying the common aliases
    // below; confirm the real field name against a live inbound test before relying on this
    // (STOP/HELP matching in index.ts needs a real `from` to record consent state against).
    const from = q.from ?? q.cellnum ?? q.msisdn ?? q.mobile ?? q.sender;
    if (!from) return null;

    return {
      from: String(from),
      body: String(reply),
      providerMessageId: String(idRaw).slice(1),
      at: new Date(),
    };
  }

  verifyWebhook(_req: ProviderRequest): boolean {
    // TODO(verify-live): the legacy dlrurl callback has no documented signature/HMAC scheme.
    // Per types.ts's SmsProvider contract, log once (loudly) and let it through rather than
    // block delivery/inbound processing. A poor-man's mitigation: bake an unguessable path
    // segment/token into WEBSMS_CALLBACK_URL itself so the URL doubles as a shared secret.
    if (!this.warnedNoSignature) {
      this.warnedNoSignature = true;
      console.warn(
        "[sms/websms] verifyWebhook: no documented signature scheme found for WebSMS's dlrurl " +
          "callback — accepting all requests UNVERIFIED. Consider an unguessable token in " +
          "WEBSMS_CALLBACK_URL as a lightweight mitigation.",
      );
    }
    return true;
  }
}
