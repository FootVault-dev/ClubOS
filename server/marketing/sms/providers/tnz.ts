// Marketing Suite — TNZ Group SMS provider adapter (Phase F part 1).
//
// TNZ Group (tnz.co.nz) — one of the two NZ-native aggregators recommended in
// outputs/deep-research/2026-07-09-clubos-marketing-suite/04-sms-marketing-nz.md
// (~10c NZD/segment, free shared zero-rated short code, no 5-6wk Twilio-style
// provisioning wait). No TNZ account is open yet — see ../README.md "Provider
// setup" for what Daniel needs to do before SMS_PROVIDER=tnz can be used.
//
// Sourced from TNZ's own docs (fetched 2026-07-09):
//   https://www.tnz.co.nz/Docs/RESTAPI/?version=1.01
//   https://www.tnz.co.nz/help/tnz-api-structure
//   https://www.tnz.co.nz/Docs/HTTPSAPI/
// TNZ documents THREE overlapping SMS APIs (simple HTTPS GET/POST, JSON REST,
// and a "Flexi" API) and — across the pages above — gives genuinely
// inconsistent detail for the JSON REST API's exact host, request nesting, and
// response envelope. This adapter targets the JSON REST send API (the one the
// research doc's "REST (JSON/XML)" recommendation refers to) using the
// best-corroborated shape, with every unconfirmed spot flagged
// `TODO(verify-live)` — grep this file for that tag before flipping
// SMS_PROVIDER=tnz in anything but a sandbox/Mode=Test send.

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

// TODO(verify-live): TNZ's own docs disagree on the JSON REST API host — one page's
// HTTPS/simple-API doc shows `api.tnz.co.nz`, the REST v1.01 doc shows `api.tnz.net.nz`.
// Confirm the correct host (and whether /api/json/send is still current for the account
// TNZ provisions) against the API key's welcome email / dashboard before first live send.
const DEFAULT_BASE_URL = "https://api.tnz.net.nz/api/json";

function readCentsPerSegment(): number {
  const raw = process.env.SMS_COST_CENTS_PER_SEGMENT;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
}

/** TNZ examples use dialling format without a leading '+' (e.g. "6421000001") — strip it. */
function toTnzDiallingFormat(e164: string): string {
  return e164.startsWith("+") ? e164.slice(1) : e164;
}

function mapTnzStatus(raw: string): SmsDeliveryStatus | null {
  const s = raw.toLowerCase();
  if (s.includes("deliver")) return "delivered";
  if (s.includes("expir")) return "expired";
  if (s.includes("fail") || s.includes("reject") || s.includes("undeliver") || s.includes("error")) return "failed";
  return null;
}

export class TnzSmsProvider implements SmsProvider {
  readonly name = "tnz";
  private warnedNoSignature = false;

  private get apiKey(): string {
    const key = process.env.TNZ_API_KEY;
    if (!key) throw new Error("[sms/tnz] TNZ_API_KEY is not set — cannot send via TNZ (see sms/README.md).");
    return key;
  }

  /**
   * TNZ's JSON body calls this field "Sender", but per their docs it's the
   * TNZ ACCOUNT email/login used for authentication — not the SMS sender ID
   * the recipient sees. Named distinctly here so it isn't confused with
   * SMS_SENDER_ID (see the note on that below).
   */
  private get accountEmail(): string {
    const email = process.env.TNZ_ACCOUNT_EMAIL;
    if (!email) {
      throw new Error(
        "[sms/tnz] TNZ_ACCOUNT_EMAIL is not set — TNZ's API authenticates with the account's " +
          "login email in the request body (their 'Sender' field), not a header (see sms/README.md).",
      );
    }
    return email;
  }

  private get baseUrl(): string {
    return process.env.TNZ_API_BASE_URL || DEFAULT_BASE_URL;
  }

  async send(msg: SmsSendInput): Promise<SmsSendResult> {
    const analysis = analyzeSms(msg.body);
    const centsPerSegment = readCentsPerSegment();

    // TODO(verify-live): exact endpoint path. Docs show `POST {base}/send` for the JSON
    // REST API; the separate simple-HTTPS API instead uses `{host}/api/v2.04/HttpApi/SMS`
    // with Sender/Token/Number/Message fields (no MessageData nesting). If a live test
    // against DEFAULT_BASE_URL 404s, try that simpler shape instead.
    const url = `${this.baseUrl}/send`;

    // NOTE on sender ID: NZ marketing SMS runs on a shared, zero-rated short code (see the
    // research doc's Finding — alphanumeric sender IDs are one-way / can't reply). TNZ's
    // documented request shape has no per-message "Originator"/"From" field distinct from
    // the account's provisioned short code, so `msg.senderId` / SMS_SENDER_ID is NOT wired
    // into this payload — there is nothing confirmed to put it in. Revisit if/when TNZ
    // confirms a dedicated/branded code product that supports overriding it.
    void msg.senderId;

    const payload = {
      Sender: this.accountEmail,
      APIKey: this.apiKey,
      MessageType: "sms",
      APIVersion: "1.01",
      MessageData: {
        Message: msg.body,
        // TODO(verify-live): "Destinations" shape is ambiguous across TNZ's own docs — one
        // page shows a flat string array (["6421000001"]), a later page shows an array of
        // {Recipient} objects. Using the object form (the more recently fetched doc) —
        // confirm with a live Mode=Test send before relying on this.
        Destinations: [{ Recipient: toTnzDiallingFormat(msg.to) }],
        MessageID: msg.clientRef,
      },
    };

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
    });

    const text = await res.text();
    let parsed: Record<string, any> | null = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // TODO(verify-live): some TNZ docs describe a plain-text response
      // ("200 OK, Job %JOBNUMBER%") instead of JSON for this endpoint — if a live send
      // returns non-JSON, parse that shape here instead of falling through to the error below.
    }

    if (!res.ok || parsed?.Result === "Failed") {
      const reason = parsed?.ErrorMessage || text || `HTTP ${res.status}`;
      throw new Error(`[sms/tnz] send failed: ${reason}`);
    }

    // TODO(verify-live): response envelope unconfirmed — docs show both a flat
    // { Result, MessageID } shape and a nested { Result, Data: { MessageID, JobNum, Status } }
    // shape for what looks like the same send call. Defensively check both; falls back to the
    // clientRef (still usable as a join key since it was echoed as MessageData.MessageID above)
    // if neither is present.
    const providerMessageId =
      parsed?.MessageID ?? parsed?.Data?.MessageID ?? parsed?.Data?.JobNum ?? parsed?.JobNum ?? msg.clientRef;

    return {
      providerMessageId: String(providerMessageId),
      segments: analysis.segments,
      costCentsEstimate: estimateCost(analysis.segments, 1, centsPerSegment),
    };
  }

  parseDeliveryReceipt(req: ProviderRequest): SmsDeliveryReceipt | null {
    const body = (typeof req.body === "object" && req.body ? req.body : null) as Record<string, any> | null;
    if (!body) return null;

    // TODO(verify-live): TNZ's webhook payload shape for delivery receipts (their "SMS
    // Status" webhook) was not present in anything fetchable from their docs site — this is
    // a best guess based on TNZ's own status-polling response shape ({MessageID/JobNum,
    // Status}). Confirm against a real webhook payload once TNZ_API_KEY is live and a
    // webhook callback URL is registered on the account.
    const messageId = body.MessageID ?? body.Data?.MessageID ?? body.JobNum ?? body.Data?.JobNum;
    const rawStatus = String(body.Status ?? body.Data?.Status ?? "");
    if (!messageId || !rawStatus) return null;

    const status = mapTnzStatus(rawStatus);
    if (!status) return null;

    return {
      providerMessageId: String(messageId),
      status,
      at: body.Timestamp ? new Date(body.Timestamp) : new Date(),
    };
  }

  parseInbound(req: ProviderRequest): SmsInboundMessage | null {
    const body = (typeof req.body === "object" && req.body ? req.body : null) as Record<string, any> | null;
    if (!body) return null;

    // TODO(verify-live): same gap as parseDeliveryReceipt — TNZ's "SMS Received" webhook
    // field names weren't in anything fetchable from their docs. Best guess mirrors their
    // outbound field naming (From/Sender for the replying number, Message for the body).
    const from = body.From ?? body.Sender ?? body.Number;
    const text = body.Message ?? body.Text;
    if (from === undefined || text === undefined) return null;

    return {
      from: String(from),
      body: String(text),
      providerMessageId: body.MessageID !== undefined ? String(body.MessageID) : undefined,
      at: body.Timestamp ? new Date(body.Timestamp) : new Date(),
    };
  }

  verifyWebhook(_req: ProviderRequest): boolean {
    // TODO(verify-live): TNZ references a "Configuring API Webhooks" guide but no
    // signature/HMAC verification scheme was found in anything fetchable from their docs
    // site. Per types.ts's SmsProvider contract, log once (loudly) and let it through rather
    // than block delivery/inbound processing.
    if (!this.warnedNoSignature) {
      this.warnedNoSignature = true;
      console.warn(
        "[sms/tnz] verifyWebhook: no documented signature scheme found for TNZ webhooks — " +
          "accepting all requests UNVERIFIED. Re-check TNZ's webhook docs / ask their support " +
          "for a signing scheme before relying on this for anything security-sensitive.",
      );
    }
    return true;
  }
}
