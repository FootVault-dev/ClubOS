/**
 * Marketing Suite — durable send engine on graphile-worker (D4).
 *
 * A Postgres-backed job runner (no Redis, no Temporal) that SURVIVES a deploy or
 * crash mid-send — the gap the old in-process runBroadcastQueue couldn't close.
 * graphile-worker creates and migrates its OWN `graphile_worker` schema on start
 * (additive; not in our migration files).
 *
 * Tasks:
 *   campaign:send        — orchestrator: resolve the audience through the
 *                          suppression gate, snapshot one mkt_email_messages row
 *                          per sendable recipient (idempotent via the
 *                          (campaign_id, profile_id) unique index), then fan out
 *                          campaign:send_batch jobs of 50. For channel='sms'
 *                          campaigns, an NZ quiet-hours gate (D7) reschedules the
 *                          WHOLE send to the next sendable instant instead of
 *                          starting, then delegates to campaign:send_sms_batch.
 *   campaign:send_batch  — sequential send of ≤50 EMAILS via the shared Resend
 *                          client, personalisation merge tags, per-message
 *                          try/catch → sent/failed + resend_email_id. Triggers
 *                          finalize when the campaign's queued backlog hits 0.
 *   campaign:send_sms_batch — sequential send of ≤50 SMS via the configured
 *                          SmsProvider (server/marketing/sms/): merge-tag render
 *                          → sanitize to GSM-7 (unless the campaign's allowUnicode
 *                          override) → opt-out suffix → mkt_sms_messages row +
 *                          send. Re-checks quiet hours per batch (a big send can
 *                          cross the 20:00 NZ boundary mid-flight). Triggers
 *                          finalize once every recipient has a resolved status.
 *   campaign:finalize    — roll counts up to mkt_campaigns.status='sent', from
 *                          mkt_email_messages or mkt_sms_messages per channel.
 *
 * Scheduled sends: the route enqueues campaign:send with `runAt = scheduled_at`;
 * cancel just flips the campaign status, and the orchestrator bails on a
 * non-sending status when the job fires.
 *
 * Spec: synthesis §6 (Postgres job runner) + build directives (a)/(b) + Phase F
 * SMS campaigns (server/marketing/campaign-sms.ts holds the pure body/cost math).
 */

import { run, makeWorkerUtils, type Runner, type WorkerUtils, type JobHelpers, type TaskList } from "graphile-worker";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "../db";
import { mktCampaigns, mktEmailMessages, mktProfiles, mktSmsMessages } from "@shared/schema";
import { resolveAudience } from "./segments";
import { sendMarketingEmail } from "./resend-client";
import { getSmsProvider, estimateCost } from "./sms";
import { composeCampaignSmsBody, getCampaignAllowUnicode, campaignSmsCentsPerSegment, quietHoursDecision } from "./campaign-sms";
// Aliased — this file already has its own (email-shaped, camelCase) local
// MergeCtx interface below; flow-graph's is the snake_case {{tag}} shape
// composeCampaignSmsBody expects. Same name, two different shapes — alias to
// avoid the collision rather than rename either (each is right for its file).
import type { MergeCtx as SmsMergeCtx } from "./flow-graph";
import { brandKeyForWorkspace, brandShell, publicBaseUrl } from "./brand";
import { signUnsubscribeToken, signPreferenceToken } from "./tokens";
// Phase E — the flows runtime + nightly sweep. Imported lazily-at-call inside the
// task wrappers below (worker ⇄ flows is a benign function-scoped import cycle).
import { runFlowStep, flowSweep } from "./flows";

const BATCH_SIZE = 50;
const CONNECTION = process.env.DATABASE_URL;

let runner: Runner | null = null;
let workerUtils: WorkerUtils | null = null;
let utilsPromise: Promise<WorkerUtils> | null = null;

// ── Enqueue helper (usable from routes, independent of the runner) ───────────
async function getUtils(): Promise<WorkerUtils> {
  if (workerUtils) return workerUtils;
  if (!utilsPromise) {
    utilsPromise = makeWorkerUtils({ connectionString: CONNECTION }).then((u) => { workerUtils = u; return u; });
  }
  return utilsPromise;
}

export async function addMarketingJob(
  identifier: string,
  payload?: unknown,
  spec?: { runAt?: Date; jobKey?: string; jobKeyMode?: "replace" | "preserve_run_at"; maxAttempts?: number },
): Promise<void> {
  const utils = await getUtils();
  await utils.addJob(identifier, payload as any, spec);
}

// ── Personalisation ──────────────────────────────────────────────────────────
interface MergeCtx { firstName: string; lastName: string; email: string; unsubscribeUrl: string; preferencesUrl: string }

function renderMergeTags(input: string | null | undefined, ctx: MergeCtx): string {
  if (!input) return "";
  const map: Record<string, string> = {
    first_name: ctx.firstName, last_name: ctx.lastName, email: ctx.email,
    unsubscribe_url: ctx.unsubscribeUrl, preferences_url: ctx.preferencesUrl,
  };
  return input.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_m, key: string) => {
    const v = map[String(key).toLowerCase()];
    return v == null ? "" : v;
  });
}

/** Guarantee a visible unsubscribe + preferences footer (bulk-sender requirement). */
function ensureFooter(html: string, ctx: MergeCtx, brandName: string): string {
  if (html.includes(ctx.unsubscribeUrl)) return html;
  const footer = `
  <div style="margin-top:32px;padding-top:16px;border-top:1px solid #e5e5e5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:#8a8a8a;text-align:center;">
    <p style="margin:0 0 6px;">${brandName} · Christchurch, New Zealand</p>
    <p style="margin:0;">
      <a href="${ctx.unsubscribeUrl}" style="color:#8a8a8a;text-decoration:underline;">Unsubscribe</a>
      &nbsp;·&nbsp;
      <a href="${ctx.preferencesUrl}" style="color:#8a8a8a;text-decoration:underline;">Email preferences</a>
    </p>
  </div>`;
  return `${html}${footer}`;
}

// ── Task: campaign:send (orchestrator) ───────────────────────────────────────
async function taskCampaignSend(payload: unknown, helpers: JobHelpers): Promise<void> {
  const { campaignId } = (payload || {}) as { campaignId?: number };
  if (!campaignId) return;

  const [campaign] = await db.select().from(mktCampaigns).where(eq(mktCampaigns.id, campaignId)).limit(1);
  if (!campaign) { helpers.logger.error(`campaign ${campaignId} not found`); return; }
  // Cancel/completed guard — a cancelled scheduled send simply no-ops here.
  if (!["scheduled", "sending", "queued", "draft"].includes(campaign.status)) {
    helpers.logger.info(`campaign ${campaignId} status=${campaign.status} — skipping send`);
    return;
  }

  if (campaign.channel === "sms") {
    // Whole-campaign NZ quiet-hours gate (D7): reschedule the ENTIRE send
    // rather than start mid-window. Checked BEFORE flipping to "sending" so a
    // requeued send still reads as in-flight (the send-now route already set
    // "sending"; a scheduled send stays "scheduled" until this fires for real).
    const qh = quietHoursDecision(new Date());
    if (qh.reschedule) {
      helpers.logger.info(`campaign ${campaignId} sms send lands in NZ quiet hours — rescheduling to ${qh.runAt.toISOString()}`);
      await helpers.addJob("campaign:send", { campaignId }, { runAt: qh.runAt, jobKey: `campaign-send:${campaignId}`, jobKeyMode: "replace" });
      return;
    }
    await db.update(mktCampaigns).set({ status: "sending", updatedAt: new Date() }).where(eq(mktCampaigns.id, campaignId));
    await taskCampaignSendSms(campaign, helpers);
    return;
  }

  await db.update(mktCampaigns).set({ status: "sending", updatedAt: new Date() }).where(eq(mktCampaigns.id, campaignId));

  const workspaceId = campaign.workspaceId;
  const brandKey = brandKeyForWorkspace(workspaceId);

  // Resolve the audience THROUGH the suppression gate — this is the only place
  // recipients are chosen, and nothing bypasses filterSendable.
  const resolved = await resolveAudience(
    (campaign.audience as any) || {},
    workspaceId,
    { channel: "email", isMarketing: campaign.isMarketing },
  );
  const sendable = resolved.gate?.sendable ?? [];

  // Snapshot one message row per sendable recipient (idempotent).
  for (let i = 0; i < sendable.length; i += 500) {
    const chunk = sendable.slice(i, i + 500);
    await db.insert(mktEmailMessages).values(chunk.map((p) => ({
      brandKey, workspaceId, campaignId, profileId: p.id,
      stream: (campaign.isMarketing ? "marketing" : "transactional") as "marketing" | "transactional",
      toEmail: p.email, subject: campaign.subject, status: "queued" as const,
    }))).onConflictDoNothing();
  }

  await db.update(mktCampaigns)
    .set({ recipientCount: sendable.length, updatedAt: new Date() })
    .where(eq(mktCampaigns.id, campaignId));

  // Fetch the still-queued message ids (handles resume after a crash).
  const queued = await db.select({ id: mktEmailMessages.id })
    .from(mktEmailMessages)
    .where(and(eq(mktEmailMessages.campaignId, campaignId), eq(mktEmailMessages.status, "queued")));

  if (queued.length === 0) {
    await helpers.addJob("campaign:finalize", { campaignId }, { jobKey: `finalize:${campaignId}` });
    return;
  }

  for (let i = 0; i < queued.length; i += BATCH_SIZE) {
    const messageIds = queued.slice(i, i + BATCH_SIZE).map((m) => Number(m.id));
    await helpers.addJob("campaign:send_batch", { campaignId, messageIds });
  }
  helpers.logger.info(`campaign ${campaignId}: queued ${queued.length} messages in ${Math.ceil(queued.length / BATCH_SIZE)} batches`);
}

// ── Task: campaign:send_batch ────────────────────────────────────────────────
async function taskCampaignSendBatch(payload: unknown, helpers: JobHelpers): Promise<void> {
  const { campaignId, messageIds } = (payload || {}) as { campaignId?: number; messageIds?: number[] };
  if (!campaignId || !Array.isArray(messageIds) || messageIds.length === 0) return;

  const [campaign] = await db.select().from(mktCampaigns).where(eq(mktCampaigns.id, campaignId)).limit(1);
  if (!campaign) return;
  if (campaign.status === "cancelled" || campaign.status === "paused") {
    helpers.logger.info(`campaign ${campaignId} ${campaign.status} — batch aborted`);
    return;
  }

  const messages = await db.select({
    id: mktEmailMessages.id, profileId: mktEmailMessages.profileId,
    toEmail: mktEmailMessages.toEmail, status: mktEmailMessages.status,
  }).from(mktEmailMessages).where(inArray(mktEmailMessages.id, messageIds));

  const profileIds = messages.map((m) => m.profileId).filter((n): n is number => n != null);
  const profiles = profileIds.length
    ? await db.select({ id: mktProfiles.id, firstName: mktProfiles.firstName, lastName: mktProfiles.lastName, email: mktProfiles.email })
        .from(mktProfiles).where(inArray(mktProfiles.id, profileIds))
    : [];
  const profileById = new Map(profiles.map((p) => [p.id, p]));

  const shell = brandShell(campaign.workspaceId);
  const base = publicBaseUrl();
  const html = campaign.bodyHtml || "";
  const stream = campaign.isMarketing ? "marketing" : "transactional";

  for (const msg of messages) {
    if (msg.status !== "queued") continue;
    try {
      const profile = msg.profileId != null ? profileById.get(msg.profileId) : undefined;
      const to = msg.toEmail || profile?.email || "";
      if (!to) { await markFailed(msg.id); continue; }

      const unsubToken = signUnsubscribeToken({ profileId: msg.profileId ?? 0, workspaceId: campaign.workspaceId, scope: "brand" });
      const prefsToken = signPreferenceToken({ profileId: msg.profileId ?? 0, workspaceId: campaign.workspaceId });
      const ctx: MergeCtx = {
        firstName: profile?.firstName || "",
        lastName: profile?.lastName || "",
        email: to,
        unsubscribeUrl: `${base}/api/public/marketing/unsubscribe?token=${encodeURIComponent(unsubToken)}`,
        preferencesUrl: `${base}/api/public/marketing/preferences?token=${encodeURIComponent(prefsToken)}`,
      };
      const oneClickUrl = `${base}/api/public/marketing/unsubscribe/oneclick?token=${encodeURIComponent(unsubToken)}`;

      const renderedHtml = ensureFooter(renderMergeTags(html, ctx), ctx, shell.name);
      const renderedSubject = renderMergeTags(campaign.subject || "", ctx);

      const result = await sendMarketingEmail({
        orgId: campaign.workspaceId,
        to,
        subject: renderedSubject,
        html: renderedHtml,
        fromName: campaign.fromName || undefined,
        replyTo: campaign.replyTo || undefined,
        idempotencyKey: msg.id,
        stream: stream as "marketing" | "transactional",
        listUnsubscribeUrl: oneClickUrl,
        listUnsubscribeMailto: `unsubscribe@${(shell.linkHost || "cufc.co.nz").replace(/^join\./, "")}`,
        tags: [{ name: "campaign_id", value: String(campaignId) }],
      });

      if (result.ok) {
        await db.update(mktEmailMessages)
          .set({ status: "sent", sentAt: new Date(), resendEmailId: result.id })
          .where(eq(mktEmailMessages.id, msg.id));
      } else {
        helpers.logger.error(`campaign ${campaignId} msg ${msg.id} send failed: ${result.error}`);
        await markFailed(msg.id);
      }
    } catch (err: any) {
      helpers.logger.error(`campaign ${campaignId} msg ${msg.id} threw: ${err?.message}`);
      await markFailed(msg.id).catch(() => {});
    }
  }

  // When the campaign's queued backlog is empty, finalize (deduped by job_key).
  const [{ remaining }] = await db.select({ remaining: sql<number>`count(*)::int` })
    .from(mktEmailMessages)
    .where(and(eq(mktEmailMessages.campaignId, campaignId), eq(mktEmailMessages.status, "queued")));
  if (Number(remaining) === 0) {
    await helpers.addJob("campaign:finalize", { campaignId }, { jobKey: `finalize:${campaignId}` });
  }
}

async function markFailed(messageId: number): Promise<void> {
  await db.update(mktEmailMessages).set({ status: "failed" }).where(eq(mktEmailMessages.id, messageId));
}

// ── Task: campaign:send (SMS orchestrator) ───────────────────────────────────
// Called from taskCampaignSend once the whole-campaign quiet-hours gate has
// passed and status='sending' is set. Mirrors the email orchestrator's shape
// (resolve → snapshot → fan out batches) but adapted for mkt_sms_messages,
// which — unlike mkt_email_messages' campaignProfileUnq — has NO
// (campaign_id, profile_id) unique index (the brief added no schema for this
// build), so idempotency on a resumed/requeued send is app-level: skip any
// profile that already has a row for this campaign, checked here AND again
// per-row in taskCampaignSendSmsBatch (belt and braces against two batch jobs
// racing on the same profile).
async function taskCampaignSendSms(campaign: typeof mktCampaigns.$inferSelect, helpers: JobHelpers): Promise<void> {
  const resolved = await resolveAudience(
    (campaign.audience as any) || {},
    campaign.workspaceId,
    { channel: "sms", isMarketing: campaign.isMarketing },
  );
  const sendable = resolved.gate?.sendable ?? [];

  await db.update(mktCampaigns)
    .set({ recipientCount: sendable.length, updatedAt: new Date() })
    .where(eq(mktCampaigns.id, campaign.id));

  if (sendable.length === 0) {
    await helpers.addJob("campaign:finalize", { campaignId: campaign.id }, { jobKey: `finalize:${campaign.id}` });
    return;
  }

  const already = await db.select({ profileId: mktSmsMessages.profileId }).from(mktSmsMessages)
    .where(eq(mktSmsMessages.campaignId, campaign.id));
  const alreadySet = new Set(already.map((a) => a.profileId).filter((n): n is number => n != null));
  const pending = sendable.filter((p) => !alreadySet.has(p.id));

  if (pending.length === 0) {
    await helpers.addJob("campaign:finalize", { campaignId: campaign.id }, { jobKey: `finalize:${campaign.id}` });
    return;
  }

  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const profileIds = pending.slice(i, i + BATCH_SIZE).map((p) => p.id);
    await helpers.addJob("campaign:send_sms_batch", { campaignId: campaign.id, profileIds });
  }
  helpers.logger.info(`campaign ${campaign.id}: queued ${pending.length} SMS in ${Math.ceil(pending.length / BATCH_SIZE)} batches`);
}

// ── Task: campaign:send_sms_batch ────────────────────────────────────────────
async function taskCampaignSendSmsBatch(payload: unknown, helpers: JobHelpers): Promise<void> {
  const { campaignId, profileIds } = (payload || {}) as { campaignId?: number; profileIds?: number[] };
  if (!campaignId || !Array.isArray(profileIds) || profileIds.length === 0) return;

  const [campaign] = await db.select().from(mktCampaigns).where(eq(mktCampaigns.id, campaignId)).limit(1);
  if (!campaign) return;
  if (campaign.status === "cancelled" || campaign.status === "paused") {
    helpers.logger.info(`campaign ${campaignId} ${campaign.status} — sms batch aborted`);
    return;
  }

  // Re-check quiet hours per batch — a large multi-batch send can cross the
  // 20:00 NZ boundary mid-flight; reschedule just THIS batch, not the whole send.
  const qh = quietHoursDecision(new Date());
  if (qh.reschedule) {
    await helpers.addJob("campaign:send_sms_batch", { campaignId, profileIds }, { runAt: qh.runAt });
    return;
  }

  const profiles = await db.select({
    id: mktProfiles.id, phoneE164: mktProfiles.phoneE164,
    firstName: mktProfiles.firstName, lastName: mktProfiles.lastName, email: mktProfiles.email,
  }).from(mktProfiles).where(inArray(mktProfiles.id, profileIds));
  const profileById = new Map(profiles.map((p) => [p.id, p]));

  const isMkt = campaign.isMarketing;
  const allowUnicode = getCampaignAllowUnicode(campaign.audience);
  const rawTemplate = campaign.bodyHtml || ""; // SMS body lives in body_html (see campaign-sms.ts header)
  const provider = getSmsProvider();
  const centsPerSegment = campaignSmsCentsPerSegment();

  for (const pid of profileIds) {
    const profile = profileById.get(pid);
    if (!profile || !profile.phoneE164) continue; // the gate already filtered these out; defensive only

    // Row-level idempotency re-check (belt and braces vs the orchestrator's
    // check — protects against two batch jobs racing on the same profile).
    const existing = await db.select({ id: mktSmsMessages.id }).from(mktSmsMessages)
      .where(and(eq(mktSmsMessages.campaignId, campaignId), eq(mktSmsMessages.profileId, pid))).limit(1);
    if (existing.length) continue;

    const ctx: SmsMergeCtx = {
      first_name: profile.firstName || "", last_name: profile.lastName || "", email: profile.email || "",
      unsubscribe_url: "", preferences_url: "", // unused in SMS — STOP handles opt-out, not a link
    };
    const { finalBody, analysis } = composeCampaignSmsBody(rawTemplate, ctx, { isMarketing: isMkt, allowUnicode });

    const [msg] = await db.insert(mktSmsMessages).values({
      profileId: pid, phoneE164: profile.phoneE164, campaignId, body: finalBody,
      encoding: analysis.encoding, segments: analysis.segments, provider: provider.name,
      isMarketing: isMkt, status: "queued",
    }).returning({ id: mktSmsMessages.id });

    try {
      const result = await provider.send({ to: profile.phoneE164, body: finalBody, clientRef: `${campaignId}:${pid}` });
      await db.update(mktSmsMessages).set({
        status: "sent", sentAt: new Date(), providerMessageId: result.providerMessageId,
        segments: result.segments, costCents: result.costCentsEstimate ?? estimateCost(analysis.segments, 1, centsPerSegment),
      }).where(eq(mktSmsMessages.id, msg.id));
    } catch (err: any) {
      helpers.logger.error(`campaign ${campaignId} sms msg ${msg.id} send failed: ${err?.message}`);
      await db.update(mktSmsMessages).set({ status: "failed" }).where(eq(mktSmsMessages.id, msg.id));
    }
  }

  // Once every sendable recipient has a resolved status, finalize (deduped by job_key).
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(mktSmsMessages)
    .where(and(eq(mktSmsMessages.campaignId, campaignId), inArray(mktSmsMessages.status, ["sent", "delivered", "failed", "undelivered"])));
  if (Number(n) >= campaign.recipientCount) {
    await helpers.addJob("campaign:finalize", { campaignId }, { jobKey: `finalize:${campaignId}` });
  }
}

// ── Task: campaign:finalize ──────────────────────────────────────────────────
async function taskCampaignFinalize(payload: unknown, helpers: JobHelpers): Promise<void> {
  const { campaignId } = (payload || {}) as { campaignId?: number };
  if (!campaignId) return;

  const [campaignRow] = await db.select({ channel: mktCampaigns.channel }).from(mktCampaigns).where(eq(mktCampaigns.id, campaignId)).limit(1);
  const isSms = campaignRow?.channel === "sms";

  let sentCount = 0;
  let failedCount = 0;
  if (isSms) {
    const [sentRow] = await db.select({ n: sql<number>`count(*)::int` })
      .from(mktSmsMessages)
      .where(and(eq(mktSmsMessages.campaignId, campaignId), inArray(mktSmsMessages.status, ["sent", "delivered"])));
    const [failedRow] = await db.select({ n: sql<number>`count(*)::int` })
      .from(mktSmsMessages)
      .where(and(eq(mktSmsMessages.campaignId, campaignId), inArray(mktSmsMessages.status, ["failed", "undelivered"])));
    sentCount = Number(sentRow?.n ?? 0);
    failedCount = Number(failedRow?.n ?? 0);
  } else {
    const [sentRow] = await db.select({ n: sql<number>`count(*)::int` })
      .from(mktEmailMessages)
      .where(and(eq(mktEmailMessages.campaignId, campaignId), inArray(mktEmailMessages.status, ["sent", "delivered"])));
    const [failedRow] = await db.select({ n: sql<number>`count(*)::int` })
      .from(mktEmailMessages)
      .where(and(eq(mktEmailMessages.campaignId, campaignId), eq(mktEmailMessages.status, "failed")));
    sentCount = Number(sentRow?.n ?? 0);
    failedCount = Number(failedRow?.n ?? 0);
  }

  await db.update(mktCampaigns).set({
    status: "sent", sentAt: new Date(),
    sentCount, failedCount,
    updatedAt: new Date(),
  }).where(and(eq(mktCampaigns.id, campaignId), ne(mktCampaigns.status, "cancelled")));
  helpers.logger.info(`campaign ${campaignId} finalized (${isSms ? "sms" : "email"}): sent=${sentCount} failed=${failedCount}`);
}

// ── Bootstrap ────────────────────────────────────────────────────────────────
const taskList: TaskList = {
  "campaign:send": taskCampaignSend,
  "campaign:send_batch": taskCampaignSendBatch,
  "campaign:send_sms_batch": taskCampaignSendSmsBatch,
  "campaign:finalize": taskCampaignFinalize,
  // Phase E — flows engine. `flow:step` advances one enrollment; `flow:sweep` is
  // the every-15-min cron that enrols date-property flows + derives the
  // abandoned-enrolment signal from pending registration rows.
  "flow:step": (payload, helpers) => runFlowStep(payload, helpers),
  "flow:sweep": () => flowSweep(),
};

// graphile-worker crontab (runner option): fire flow:sweep every 15 minutes.
// `?fill=1h` backfills a missed run after downtime; the enrol guards make it safe.
const MARKETING_CRONTAB = "*/15 * * * * flow:sweep ?fill=1h";

/**
 * Start the marketing worker. Called once from server/index.ts. Resilient: a
 * failure here (or a missing DATABASE_URL) never crashes server boot — the
 * suite's admin UI still loads; only sends won't fire until the worker is up.
 */
export async function startMarketingWorker(): Promise<void> {
  if (process.env.MARKETING_WORKER_DISABLED === "1") {
    console.log("[Marketing] worker disabled via MARKETING_WORKER_DISABLED=1");
    return;
  }
  if (!CONNECTION) {
    console.warn("[Marketing] DATABASE_URL not set — marketing worker not started");
    return;
  }
  try {
    runner = await run({
      connectionString: CONNECTION,
      concurrency: Number(process.env.MARKETING_WORKER_CONCURRENCY || "3"),
      pollInterval: 2000,
      noHandleSignals: true, // the server owns process signals
      taskList,
      crontab: MARKETING_CRONTAB,
    });
    console.log("[Marketing] durable send worker started (graphile-worker)");
    runner.promise.catch((e) => console.error("[Marketing] worker stopped:", e));
  } catch (err) {
    console.error("[Marketing] failed to start worker (sends will not fire):", err);
  }
}

export async function stopMarketingWorker(): Promise<void> {
  try { await runner?.stop(); } catch { /* ignore */ }
  runner = null;
}
