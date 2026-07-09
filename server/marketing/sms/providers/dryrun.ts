// Marketing Suite — SMS dry-run provider (Phase F part 1).
//
// The default adapter (see index.ts's getSmsProvider()) — never touches a real
// carrier. Logs every "send" to the console, computes real segments/cost via
// encoding.ts (so cost-preview UI can be exercised end-to-end before a real
// provider account exists), and hands back a fake-but-realistic providerMessageId.
//
// Also exposes test-only helpers (simulateDeliveryReceiptRequest / simulateInboundRequest)
// that build a ProviderRequest this same class's parseDeliveryReceipt/parseInbound can
// consume, so script/test-sms-lib.ts can exercise a full send -> DLR -> inbound round trip
// with no network and no DB.

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

/** Discriminated shape used for the fake webhook bodies this provider round-trips. */
type DryRunWebhookBody =
  | { kind: "dlr"; providerMessageId: string; status: SmsDeliveryStatus; at: string }
  | { kind: "inbound"; from: string; body: string; providerMessageId?: string; at: string };

function readCentsPerSegment(): number {
  const raw = process.env.SMS_COST_CENTS_PER_SEGMENT;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
}

export class DryRunSmsProvider implements SmsProvider {
  readonly name = "dryrun";

  /** Every send this instance has accepted, for test assertions / debugging. */
  readonly sent: Array<SmsSendInput & SmsSendResult> = [];

  async send(msg: SmsSendInput): Promise<SmsSendResult> {
    const analysis = analyzeSms(msg.body);
    const centsPerSegment = readCentsPerSegment();
    const result: SmsSendResult = {
      providerMessageId: `dryrun_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
      segments: analysis.segments,
      costCentsEstimate: estimateCost(analysis.segments, 1, centsPerSegment),
    };

    console.log(
      `[sms/dryrun] SEND to=${msg.to} clientRef=${msg.clientRef} senderId=${msg.senderId ?? "(default)"} ` +
        `encoding=${analysis.encoding} segments=${result.segments} costCentsEstimate=${result.costCentsEstimate} ` +
        `providerMessageId=${result.providerMessageId}\n  body="${msg.body}"`,
    );

    this.sent.push({ ...msg, ...result });
    return result;
  }

  parseDeliveryReceipt(req: ProviderRequest): SmsDeliveryReceipt | null {
    const body = req.body as DryRunWebhookBody | undefined;
    if (!body || body.kind !== "dlr") return null;
    return {
      providerMessageId: body.providerMessageId,
      status: body.status,
      at: new Date(body.at),
    };
  }

  parseInbound(req: ProviderRequest): SmsInboundMessage | null {
    const body = req.body as DryRunWebhookBody | undefined;
    if (!body || body.kind !== "inbound") return null;
    return {
      from: body.from,
      body: body.body,
      providerMessageId: body.providerMessageId,
      at: new Date(body.at),
    };
  }

  /** Dry-run has no real webhook signing — nothing to verify, always true. */
  verifyWebhook(_req: ProviderRequest): boolean {
    return true;
  }

  // -------------------------------------------------------------------------
  // Test-only helpers — build a fake ProviderRequest this provider's own
  // parseDeliveryReceipt/parseInbound can consume, so callers (and
  // script/test-sms-lib.ts) can exercise the full round trip with no network.
  // -------------------------------------------------------------------------

  /** Builds a fake DLR webhook request for `providerMessageId` (default status: delivered). */
  simulateDeliveryReceiptRequest(providerMessageId: string, status: SmsDeliveryStatus = "delivered"): ProviderRequest {
    const body: DryRunWebhookBody = { kind: "dlr", providerMessageId, status, at: new Date().toISOString() };
    return { headers: {}, body };
  }

  /** Builds a fake inbound-SMS webhook request (a reply, incl. STOP/HELP keywords). */
  simulateInboundRequest(from: string, text: string, providerMessageId?: string): ProviderRequest {
    const body: DryRunWebhookBody = { kind: "inbound", from, body: text, providerMessageId, at: new Date().toISOString() };
    return { headers: {}, body };
  }
}
