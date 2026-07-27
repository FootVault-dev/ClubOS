/**
 * Marketing Suite — SMS CAMPAIGN pure helpers (Phase F final piece).
 *
 * DB-free / Express-free, mirroring the flow-graph.ts split from flows.ts: the
 * SMS campaign send path (worker.ts) and the wizard's cost-preview/test-send
 * endpoints (routes.ts) both need the exact SAME body-transform + cost math —
 * it lives here once, and is unit-tested with no DB by script/test-sms-campaign.ts.
 *
 * ── Storage decision (documented once here; referenced from routes.ts/worker.ts) ──
 * The brief was explicit: add nothing to shared/schema.ts for SMS campaigns.
 * mkt_campaigns has no SMS-specific columns, so for channel='sms' campaigns:
 *   - the SMS body TEMPLATE lives in mkt_campaigns.body_html — reused as a
 *     generic "content" field (it's already nullable free text; for SMS it
 *     holds plain text, never HTML — the column name is a historical email
 *     artifact, not a constraint).
 *   - the allowUnicode override lives in mkt_campaigns.audience.smsOptions.allowUnicode.
 *     `audience` is already a free-form `jsonb` (`Record<string, unknown>`,
 *     read by segments.ts's resolveAudience() via ONLY `.include`/`.exclude` —
 *     see server/marketing/segments.ts's resolveAudience, which ignores any
 *     other key). A sibling `smsOptions` key is the least-hacky home for one
 *     small per-campaign SMS flag with zero schema/migration risk.
 * getCampaignAllowUnicode/withCampaignAllowUnicode are the two ends of that
 * contract — read it, and merge a new value into an existing audience object
 * without disturbing include/exclude.
 */
import { appendOptOutSuffix, analyzeSms, sanitizeToGsm7, estimateCost, isQuietHours, nextSendableTime, type SmsAnalysis } from "./sms";
import { renderMergeTags, type MergeCtx } from "./flow-graph";

export interface CampaignAudienceWithSmsOptions {
  include?: unknown[];
  exclude?: unknown[];
  smsOptions?: { allowUnicode?: boolean };
}

/** Read the allowUnicode override off a campaign's `audience` jsonb (default false = sanitize to GSM-7). */
export function getCampaignAllowUnicode(audience: unknown): boolean {
  const a = (audience && typeof audience === "object" ? audience : {}) as CampaignAudienceWithSmsOptions;
  return a.smsOptions?.allowUnicode === true;
}

/** Merge an allowUnicode flag into an existing audience jsonb — leaves include/exclude untouched. */
export function withCampaignAllowUnicode(audience: unknown, allowUnicode: boolean): Record<string, unknown> {
  const a = (audience && typeof audience === "object" ? audience : {}) as CampaignAudienceWithSmsOptions;
  return { ...a, smsOptions: { ...(a.smsOptions || {}), allowUnicode } };
}

/**
 * Cents-per-segment for cost math. Reads `SMS_COST_CENTS_PER_SEGMENT` — the
 * name every provider adapter (dryrun/tnz/websms) actually reads (see
 * sms/README.md's env table) — falling back to the OLDER `SMS_CENTS_PER_SEGMENT`
 * name the Phase E flows preview-sms route uses (server/marketing/routes.ts's
 * `/flows/preview-sms`), so a env var set under either name still works; new
 * code (this file) always prefers the provider-matching name so the campaign
 * wizard's estimate can never silently disagree with what a real send bills.
 */
export function campaignSmsCentsPerSegment(): number {
  const raw = process.env.SMS_COST_CENTS_PER_SEGMENT ?? process.env.SMS_CENTS_PER_SEGMENT;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 10;
}

export interface ComposedSmsBody {
  finalBody: string;
  analysis: SmsAnalysis;
  /** Unique characters sanitizeToGsm7 stripped entirely (empty when allowUnicode=true, or nothing needed stripping). */
  sanitizedRemoved: string[];
}

/**
 * The ONE place a campaign SMS body is turned into what actually gets sent:
 * merge-tag render → sanitize to GSM-7 (unless allowUnicode) → opt-out suffix
 * (unless transactional, isMarketing=false) → analyze for encoding/segments/cost.
 * Same suffix-then-analyze order as flows.ts's sendSmsStep; campaigns
 * additionally sanitize to GSM-7 by default — the wizard's whole "avoid the
 * UCS-2 cost trap" pitch (see sms/encoding.ts's file header) — which the flows
 * engine does not currently do.
 */
export function composeCampaignSmsBody(
  rawTemplate: string,
  ctx: MergeCtx,
  opts: { isMarketing: boolean; allowUnicode: boolean },
): ComposedSmsBody {
  const rendered = renderMergeTags(rawTemplate, ctx);
  let body = rendered;
  let sanitizedRemoved: string[] = [];
  if (!opts.allowUnicode) {
    const s = sanitizeToGsm7(rendered);
    body = s.sanitized;
    sanitizedRemoved = s.removed;
  }
  const finalBody = opts.isMarketing ? appendOptOutSuffix(body) : body;
  return { finalBody, analysis: analyzeSms(finalBody), sanitizedRemoved };
}

/** segments-per-message x total sendable recipients x the configured per-segment rate. */
export function estimateCampaignSmsCostCents(segmentsPerMessage: number, totalMessages: number): number {
  return estimateCost(segmentsPerMessage, totalMessages, campaignSmsCentsPerSegment());
}

/**
 * Whole-campaign quiet-hours decision (D7): if `now` lands in the NZ
 * 20:00–08:00 window, the send should be rescheduled to the next sendable
 * instant rather than let a batch start mid-window. Pure wrapper over the SMS
 * lib's DST-safe Intl math (sms/index.ts) — kept here so worker.ts's decision
 * of WHAT to do (reschedule vs proceed) is unit-testable without a DB.
 */
export function quietHoursDecision(now: Date): { reschedule: boolean; runAt: Date } {
  if (!isQuietHours(now)) return { reschedule: false, runAt: now };
  return { reschedule: true, runAt: nextSendableTime(now) };
}
