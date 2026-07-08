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
 *                          campaign:send_batch jobs of 50.
 *   campaign:send_batch  — sequential send of ≤50 messages via the shared Resend
 *                          client, personalisation merge tags, per-message
 *                          try/catch → sent/failed + resend_email_id. Triggers
 *                          finalize when the campaign's queued backlog hits 0.
 *   campaign:finalize    — roll counts up to mkt_campaigns.status='sent'.
 *
 * Scheduled sends: the route enqueues campaign:send with `runAt = scheduled_at`;
 * cancel just flips the campaign status, and the orchestrator bails on a
 * non-sending status when the job fires.
 *
 * Spec: synthesis §6 (Postgres job runner) + build directives (a)/(b).
 */

import { run, makeWorkerUtils, type Runner, type WorkerUtils, type JobHelpers, type TaskList } from "graphile-worker";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "../db";
import { mktCampaigns, mktEmailMessages, mktProfiles } from "@shared/schema";
import { resolveAudience } from "./segments";
import { sendMarketingEmail } from "./resend-client";
import { brandKeyForWorkspace, brandShell, publicBaseUrl } from "./brand";
import { signUnsubscribeToken, signPreferenceToken } from "./tokens";

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
  if (campaign.channel !== "email") {
    helpers.logger.info(`campaign ${campaignId} channel=${campaign.channel} — email engine only (SMS is Phase F)`);
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

// ── Task: campaign:finalize ──────────────────────────────────────────────────
async function taskCampaignFinalize(payload: unknown, helpers: JobHelpers): Promise<void> {
  const { campaignId } = (payload || {}) as { campaignId?: number };
  if (!campaignId) return;

  const [sentRow] = await db.select({ n: sql<number>`count(*)::int` })
    .from(mktEmailMessages)
    .where(and(eq(mktEmailMessages.campaignId, campaignId), inArray(mktEmailMessages.status, ["sent", "delivered"])));
  const [failedRow] = await db.select({ n: sql<number>`count(*)::int` })
    .from(mktEmailMessages)
    .where(and(eq(mktEmailMessages.campaignId, campaignId), eq(mktEmailMessages.status, "failed")));

  await db.update(mktCampaigns).set({
    status: "sent", sentAt: new Date(),
    sentCount: Number(sentRow?.n ?? 0), failedCount: Number(failedRow?.n ?? 0),
    updatedAt: new Date(),
  }).where(and(eq(mktCampaigns.id, campaignId), ne(mktCampaigns.status, "cancelled")));
  helpers.logger.info(`campaign ${campaignId} finalized: sent=${sentRow?.n} failed=${failedRow?.n}`);
}

// ── Bootstrap ────────────────────────────────────────────────────────────────
const taskList: TaskList = {
  "campaign:send": taskCampaignSend,
  "campaign:send_batch": taskCampaignSendBatch,
  "campaign:finalize": taskCampaignFinalize,
};

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
