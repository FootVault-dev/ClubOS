/**
 * Marketing Suite — THE one shared Resend client for the suite.
 *
 * Supersedes the raw `fetch` in server/email.ts FOR MARKETING SENDS. Every
 * marketing/flow email goes through `sendMarketingEmail`, which guarantees:
 *   - the from-address is ALWAYS derived from a verified workspace domain via
 *     shared/org-domains.ts `fromForOrg` (never hardcoded);
 *   - an `Idempotency-Key` header (caller supplies mkt_email_messages.id) so a
 *     retried send can never double-mail a parent;
 *   - a real text/plain part (derived from the HTML if not supplied) — HTML-only
 *     mail is a spam signal;
 *   - for marketing-stream messages, the RFC 8058 one-click headers
 *     (`List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click`),
 *     which Resend does NOT add on the plain Emails API (only on Broadcasts);
 *   - a client-side token bucket (~2/s default, configurable) plus runtime 429
 *     back-off honouring `retry-after` / `ratelimit-reset`.
 *
 * Spec: outputs/deep-research/2026-07-09-clubos-marketing-suite/05-analytics-deliverability.md
 * (Findings 2, 3, 10, 11) + synthesis §(a)/(d).
 */

import { fromForOrg } from "@shared/org-domains";

const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const RESEND_ENDPOINT = "https://api.resend.com/emails";

// Token-bucket rate limit. Resend's dedicated limit is ~10 req/s/team; we default
// to a conservative ~2/s (the proven runBroadcastQueue spacing) and still honour
// the live `retry-after`/`ratelimit-reset` headers on a 429.
const SEND_RATE_PER_SEC = Math.max(0.2, Number(process.env.MARKETING_SEND_RATE_PER_SEC || "2"));
const MIN_SPACING_MS = Math.ceil(1000 / SEND_RATE_PER_SEC);
const MAX_429_RETRIES = 4;

let lastSendAt = 0;
let chain: Promise<unknown> = Promise.resolve();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/** Serialise all sends through one chain, spaced ≥ MIN_SPACING_MS apart. */
async function throttle(): Promise<void> {
  const mine = chain.then(async () => {
    const wait = lastSendAt + MIN_SPACING_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastSendAt = Date.now();
  });
  // Keep the chain alive even if a prior link rejected.
  chain = mine.catch(() => {});
  await mine;
}

/** Strip HTML to a plain-text approximation (mirrors server/email.ts htmlToText). */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<\/(p|div|h[1-6]|li|tr|br)>/gi, "\n")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface SendMarketingEmailParams {
  /** Workspace/org id — drives the verified from-domain via fromForOrg. */
  orgId: number | null | undefined;
  to: string;
  subject: string;
  html: string;
  text?: string;
  /** Overrides only the display NAME; the domain always comes from fromForOrg. */
  fromName?: string;
  replyTo?: string;
  /** Caller supplies mkt_email_messages.id — becomes the Idempotency-Key. */
  idempotencyKey: string | number;
  /** marketing (default) attaches the RFC 8058 one-click headers; transactional doesn't. */
  stream?: "marketing" | "transactional";
  /** The https one-click unsubscribe URL (required for a marketing send to be compliant). */
  listUnsubscribeUrl?: string;
  /** Optional mailto: fallback for List-Unsubscribe. */
  listUnsubscribeMailto?: string;
  /** Extra custom headers (merged last). */
  headers?: Record<string, string>;
  /** ISO 8601 / natural-language schedule (Resend `scheduled_at`); single-send only. */
  scheduledAt?: string;
  /** Optional Resend tags. */
  tags?: { name: string; value: string }[];
}

export interface SendMarketingEmailResult {
  ok: boolean;
  id: string | null;
  status: number;
  error?: string;
  skipped?: boolean;
}

/**
 * Send one marketing email through Resend with idempotency, plaintext, RFC 8058
 * headers and rate-limit back-off. Never throws — returns a result object.
 */
export async function sendMarketingEmail(params: SendMarketingEmailParams): Promise<SendMarketingEmailResult> {
  if (!RESEND_API_KEY) {
    console.warn("[Marketing] RESEND_API_KEY not configured — skipping send to", params.to);
    return { ok: false, id: null, status: 0, skipped: true, error: "RESEND_API_KEY not configured" };
  }

  const from = fromForOrg(params.orgId ?? null, params.fromName);
  const stream = params.stream ?? "marketing";

  const headers: Record<string, string> = { ...(params.headers || {}) };
  if (stream === "marketing" && params.listUnsubscribeUrl) {
    const parts = [`<${params.listUnsubscribeUrl}>`];
    if (params.listUnsubscribeMailto) parts.push(`<mailto:${params.listUnsubscribeMailto}?subject=unsubscribe>`);
    headers["List-Unsubscribe"] = parts.join(", ");
    // The value is EXACTLY this per the RFC 8058 ABNF.
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }

  const body: Record<string, unknown> = {
    from,
    to: [params.to],
    reply_to: params.replyTo || undefined,
    subject: params.subject,
    html: params.html,
    text: params.text ?? htmlToText(params.html),
    headers: Object.keys(headers).length ? headers : undefined,
    scheduled_at: params.scheduledAt || undefined,
    tags: params.tags,
  };

  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
    await throttle();
    try {
      const res = await fetch(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${RESEND_API_KEY}`,
          "Idempotency-Key": String(params.idempotencyKey).slice(0, 256),
        },
        body: JSON.stringify(body),
      });

      if (res.status === 429 && attempt < MAX_429_RETRIES) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const reset = Number(res.headers.get("ratelimit-reset"));
        const waitSec = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter
          : Number.isFinite(reset) && reset > 0 ? reset : Math.min(8, 2 ** attempt);
        console.warn(`[Marketing] 429 from Resend — backing off ${waitSec}s (attempt ${attempt + 1})`);
        await sleep(waitSec * 1000);
        continue;
      }

      let json: any = null;
      try { json = await res.json(); } catch { /* empty body */ }
      if (res.ok) {
        return { ok: true, id: (json && json.id) || null, status: res.status };
      }
      const error = json?.message || json?.error?.message || `Resend ${res.status}`;
      return { ok: false, id: null, status: res.status, error };
    } catch (err: any) {
      if (attempt < MAX_429_RETRIES) {
        await sleep(Math.min(8, 2 ** attempt) * 1000);
        continue;
      }
      return { ok: false, id: null, status: 0, error: err?.message || "network error" };
    }
  }
  return { ok: false, id: null, status: 429, error: "rate limited" };
}
