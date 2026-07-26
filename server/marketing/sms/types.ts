// Marketing Suite — SMS provider contract (Phase F part 1).
//
// Stripe-adapter pattern: one interface, N swappable providers (TnzSmsProvider,
// WebSmsProvider, DryRunSmsProvider, and later TwilioProvider/MessageMediaProvider —
// see the deep-research BUILD SPEC, outputs/deep-research/2026-07-09-clubos-marketing-suite/04-sms-marketing-nz.md
// §"Provider-abstraction interface"). Nothing in this file talks to a vendor SDK
// directly — that's the providers/*.ts adapters' job.
//
// These types map onto `mkt_sms_messages` / `mkt_sms_inbound` in shared/schema.ts:
//   SmsSendResult.providerMessageId -> mkt_sms_messages.provider_message_id
//   SmsSendResult.segments          -> mkt_sms_messages.segments
//   SmsSendResult.costCentsEstimate -> mkt_sms_messages.cost_cents
//   SmsDeliveryReceipt              -> updates mkt_sms_messages.status/delivered_at (join on provider_message_id)
//   SmsInboundMessage               -> inserts into mkt_sms_inbound (phone_e164/body/provider_message_id)
// The actual DB writes are wired by routes.ts/webhook.ts (a parallel agent's job,
// not this file's) — this file only defines the shapes.

/** GSM-7 vs UCS-2 — see encoding.ts for the segment-length/cost consequences. */
export type SmsEncoding = "gsm7" | "ucs2";

/** Input to SmsProvider.send() — one outbound SMS. */
export interface SmsSendInput {
  /** E.164 recipient number, e.g. "+64211234567". */
  to: string;
  /** Final, already-sanitised message body (opt-out suffix already appended if marketing). */
  body: string;
  /** Alphanumeric/short-code sender override; providers fall back to their configured default. */
  senderId?: string;
  /**
   * Caller-supplied idempotency/correlation key (e.g. `${campaignId}:${profileId}` or a ulid).
   * Providers that support a client-reference field should pass it through so retries don't
   * double-send and so inbound/DLR webhooks can be joined back without relying solely on the
   * provider's own message id.
   */
  clientRef: string;
}

/** Result of a successful (accepted-for-delivery) send. */
export interface SmsSendResult {
  /** The provider's own message/job id — the join key for delivery receipts. */
  providerMessageId: string;
  /** Segment count actually billed (should match encoding.ts's analyzeSms() unless the provider disagrees). */
  segments: number;
  /** Cost estimate in NZD cents (segments × recipients × rate) — null if the provider gives no way to estimate. */
  costCentsEstimate: number | null;
}

export type SmsDeliveryStatus = "delivered" | "failed" | "expired";

/** Parsed delivery-receipt (DLR) webhook — null if the payload isn't a DLR this provider recognises. */
export interface SmsDeliveryReceipt {
  providerMessageId: string;
  status: SmsDeliveryStatus;
  at: Date;
}

/** Parsed inbound SMS (a reply, incl. STOP/HELP) — null if the payload isn't an inbound message. */
export interface SmsInboundMessage {
  /** E.164 sender number. */
  from: string;
  body: string;
  /** The provider's id for this inbound message, when it supplies one. */
  providerMessageId?: string;
  at: Date;
}

/**
 * A framework-agnostic view of an incoming HTTP request, so provider adapters
 * don't need to import Express types. The wiring layer (webhook routes, owned
 * by a parallel agent) is responsible for shaping a real `Request` into this.
 */
export interface ProviderRequest {
  headers: Record<string, string | string[] | undefined>;
  /** Parsed body — JSON object for JSON webhooks, or a query-string-decoded object for GET-callback providers. */
  body: unknown;
  /** Query-string params, when the provider delivers callbacks as GET requests. */
  query?: Record<string, string | undefined>;
  /** Raw request body text, needed by providers that HMAC-sign the raw bytes. */
  rawBody?: string;
}

/**
 * The provider contract. Every adapter (TNZ, WebSMS, dry-run, and future
 * Twilio/MessageMedia/Modica adapters) implements this and nothing else in the
 * codebase calls a vendor SDK/API directly.
 */
export interface SmsProvider {
  /** Stable machine name — matches the SMS_PROVIDER env value that selects this adapter. */
  readonly name: string;

  /** Send one SMS. Throws on a hard failure (network error, provider rejects the request). */
  send(msg: SmsSendInput): Promise<SmsSendResult>;

  /**
   * Parse a delivery-receipt webhook payload. Returns null if this request isn't
   * a DLR this provider recognises (so the caller can try parseInbound instead).
   */
  parseDeliveryReceipt(req: ProviderRequest): SmsDeliveryReceipt | null;

  /**
   * Parse an inbound-SMS webhook payload (a reply, incl. STOP/HELP keywords —
   * matching against STOP_KEYWORDS/HELP_KEYWORDS is the caller's job, see index.ts).
   * Returns null if this request isn't an inbound message this provider recognises.
   */
  parseInbound(req: ProviderRequest): SmsInboundMessage | null;

  /**
   * Verify a webhook is genuinely from the provider (HMAC/signature check where the
   * provider supports one). Providers with no signing scheme documented MUST still
   * return true (so sends aren't blocked) but MUST log a loud warning the first time,
   * so this is visible in ops rather than silently trusted forever.
   */
  verifyWebhook(req: ProviderRequest): boolean;
}
