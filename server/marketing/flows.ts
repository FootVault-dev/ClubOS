/**
 * Marketing Suite — the FLOWS RUNTIME (Phase E). The highest-leverage part of the
 * suite: flows out-earn campaigns ~18–30× on revenue-per-recipient (synthesis §4).
 *
 * A flow is an immutable, versioned graph of steps; a person's progress is a
 * mutable enrollment row pinned to the version it entered on (Klaviyo's safe
 * live-edit semantics for free — running enrollments never see a graph edit,
 * only new entrants get the new version). Delayed steps run on graphile-worker
 * (the durable Postgres job runner from Phase B), one advance job per enrollment
 * keyed `flow:{flowId}:{profileId}` so there's never more than one pending step.
 *
 * Every message step passes through the SAME suppression gate as campaigns
 * (filterSendable) and the SAME boolean-tree evaluator as segments
 * (evaluateDefinition) — one engine, no divergence.
 *
 * The pure graph-walk / delay / quiet-hours / merge-tag logic lives in
 * ./flow-graph.ts (DB-free, unit-tested by script/test-flows-graph.ts). This file
 * is the side-effectful orchestration: enrol, advance, send, exit, and the
 * nightly sweep that derives the abandoned-enrolment signal from pending rows.
 *
 * Spec: plan Phase E · 03-flows-automation-roi.md §A/B/C · synthesis §5/§6 + (c).
 */

import type { JobHelpers } from "graphile-worker";
import { and, desc, eq, gte, isNotNull, lte, sql } from "drizzle-orm";
import { db } from "../db";
import {
  mktFlows, mktFlowVersions, mktFlowEnrollments, mktFlowStepRuns,
  mktProfiles, mktConsent, mktEmailMessages, mktSmsMessages,
  registrations, contacts, programs, cugcRegistrations,
} from "@shared/schema";
import {
  normalizeGraph, getStep, entryStepId, isMessageStep, resolveNext, delayToMs,
  scheduleForStep, renderMergeTags, ensureFooter, reEntryPolicy,
  type FlowGraph, type FlowStep, type MergeCtx,
} from "./flow-graph";
import { evaluateDefinition } from "./segments";
import { filterSendable } from "./suppression";
import { sendMarketingEmail } from "./resend-client";
import { getSmsProvider, appendOptOutSuffix, analyzeSms } from "./sms";
import { brandKeyForWorkspace, brandShell, publicBaseUrl } from "./brand";
import { signUnsubscribeToken, signPreferenceToken } from "./tokens";
import { addMarketingJob } from "./worker";
import { trackEvent } from "./events";

type MktFlow = typeof mktFlows.$inferSelect;

const lc = (s: string | null | undefined) => (s || "").trim().toLowerCase();

// ── Flow-level config accessors ──────────────────────────────────────────────
function triggerMetric(flow: MktFlow): string | null {
  const c = (flow.triggerConfig as any) || {};
  return c.metricName ?? c.metric ?? null;
}
function exitMetric(flow: MktFlow): string | null {
  const e = (flow.triggerConfig as any)?.exitOn;
  if (!e) return null;
  return typeof e === "string" ? e : (e.metricName ?? e.metric ?? null);
}
function flowKind(flow: MktFlow): string | null {
  return (flow.triggerConfig as any)?.kind ?? null;
}
function hasConditions(filter: any): boolean {
  if (!filter || typeof filter !== "object") return false;
  return (Array.isArray(filter.all) && filter.all.length > 0) || (Array.isArray(filter.any) && filter.any.length > 0);
}
function propertyFiltersMatch(filters: any, props: Record<string, any> | undefined): boolean {
  if (!filters || typeof filters !== "object") return true;
  const entries = Object.entries(filters);
  if (entries.length === 0) return true;
  const p = props || {};
  return entries.every(([k, v]) => String(p[k] ?? "") === String(v ?? ""));
}

// ── Version loading ──────────────────────────────────────────────────────────
async function loadLiveVersion(flow: MktFlow): Promise<{ versionId: number; graph: FlowGraph } | null> {
  if (flow.liveVersionId == null) return null;
  const [v] = await db.select().from(mktFlowVersions).where(eq(mktFlowVersions.id, flow.liveVersionId)).limit(1);
  if (!v) return null;
  return { versionId: v.id, graph: normalizeGraph(v.graph) };
}

// ── Enrollment ───────────────────────────────────────────────────────────────
/** Low-level enrol with a preloaded version (used by batch triggers). Returns the
 *  enrollment id or null if the person was skipped (re-entry / entry-filter). */
async function doEnroll(
  flow: MktFlow, versionId: number, graph: FlowGraph, profileId: number, triggerEvent?: Record<string, unknown> | null,
): Promise<number | null> {
  const policy = reEntryPolicy(flow);
  const existing = await db.select({ id: mktFlowEnrollments.id, status: mktFlowEnrollments.status })
    .from(mktFlowEnrollments)
    .where(and(eq(mktFlowEnrollments.flowId, flow.id), eq(mktFlowEnrollments.profileId, profileId)));

  // Hard rule: one ACTIVE enrollment per (flow, profile).
  if (existing.some((e) => e.status === "active")) return null;
  // 'never' = one enrollment ever; 'after_exit'/'always' allow re-entry once no active exists.
  if (policy === "never" && existing.length > 0) return null;

  if (hasConditions(flow.entryFilter)) {
    const ids = await evaluateDefinition(flow.entryFilter as any, flow.workspaceId);
    if (!ids.includes(profileId)) return null;
  }

  const entry = entryStepId(graph);
  if (!entry) return null;

  const jobKey = `flow:${flow.id}:${profileId}`;
  const [enr] = await db.insert(mktFlowEnrollments).values({
    flowId: flow.id, flowVersionId: versionId, profileId, status: "active",
    currentStepId: entry, triggerEvent: triggerEvent ?? null, nextRunJobKey: jobKey,
  }).returning({ id: mktFlowEnrollments.id });

  await addMarketingJob("flow:step", { enrollmentId: enr.id, stepId: entry },
    { jobKey, jobKeyMode: "replace", runAt: new Date() });
  return enr.id;
}

/** Public single enrol — loads the flow's live version, then delegates. */
export async function enrollProfile(flow: MktFlow, profileId: number, triggerEvent?: Record<string, unknown> | null): Promise<number | null> {
  if (flow.status !== "live") return null;
  const v = await loadLiveVersion(flow);
  if (!v) return null;
  return doEnroll(flow, v.versionId, v.graph, profileId, triggerEvent);
}

// ── Event trigger hook (called from events.ts trackEvent) ─────────────────────
/**
 * The one hook trackEvent fires after every event: it (1) EXITS any active
 * enrollment whose flow names this metric as its exit/conversion event, then
 * (2) ENROLS the profile into any live event-triggered flow keyed on this metric
 * (property filters honoured). Idempotent — the enrollment guard means a repeated
 * event (e.g. the 15-min sweep re-emitting a still-pending 'Started Registration')
 * never double-enrols, and a later-created flow still picks up the person.
 */
export async function enrollFromEvent(
  workspaceId: number, profileId: number, metricName: string, triggerEvent?: Record<string, unknown> | null,
): Promise<void> {
  const flows = await db.select().from(mktFlows)
    .where(and(eq(mktFlows.workspaceId, workspaceId), eq(mktFlows.status, "live")));
  if (flows.length === 0) return;

  // (1) Exit conversions first — a conversion should stop a recovery flow before
  //     any enrol logic runs.
  for (const flow of flows) {
    if (exitMetric(flow) === metricName) {
      await exitActiveEnrollments(flow.id, profileId, "converted").catch(() => {});
    }
  }

  // (2) Enrol into event-triggered flows on this metric.
  for (const flow of flows) {
    if (flow.triggerType !== "event") continue;
    if (triggerMetric(flow) !== metricName) continue;
    const pf = (flow.triggerConfig as any)?.propertyFilters;
    if (!propertyFiltersMatch(pf, (triggerEvent as any)?.properties)) continue;
    await enrollProfile(flow, profileId, triggerEvent).catch(() => {});
  }
}

/** List-trigger hook — called from routes.ts after list members are added. */
export async function enrollFromListAdd(workspaceId: number, listId: number, profileIds: number[]): Promise<void> {
  if (!profileIds.length) return;
  const flows = await db.select().from(mktFlows)
    .where(and(eq(mktFlows.workspaceId, workspaceId), eq(mktFlows.status, "live"), eq(mktFlows.triggerType, "list")));
  for (const flow of flows) {
    if (Number((flow.triggerConfig as any)?.listId) !== listId) continue;
    const v = await loadLiveVersion(flow);
    if (!v) continue;
    for (const pid of profileIds) await doEnroll(flow, v.versionId, v.graph, pid, { trigger: "list", listId }).catch(() => {});
  }
}

async function exitActiveEnrollments(flowId: number, profileId: number, reason: string): Promise<number> {
  const rows = await db.update(mktFlowEnrollments)
    .set({ status: "exited", exitedAt: new Date(), exitReason: reason })
    .where(and(eq(mktFlowEnrollments.flowId, flowId), eq(mktFlowEnrollments.profileId, profileId), eq(mktFlowEnrollments.status, "active")))
    .returning({ id: mktFlowEnrollments.id });
  return rows.length;
}

/**
 * Cancellation hook — e.g. a payment completes → the abandoned-enrolment flow
 * exits with reason 'converted'. `flowKind` matches trigger_config.kind
 * ('abandoned_enrolment', 'welcome', …) or '*' for every flow. Looks the profile
 * up by email within the workspace and exits its active enrollments.
 */
export async function cancelFlowEnrollment(
  flowKind: string, workspaceId: number, profileEmail: string, reason: string = "converted",
): Promise<number> {
  const email = lc(profileEmail);
  if (!email) return 0;
  const [p] = await db.select({ id: mktProfiles.id }).from(mktProfiles)
    .where(and(eq(mktProfiles.workspaceId, workspaceId), sql`lower(${mktProfiles.email}) = ${email}`)).limit(1);
  if (!p) return 0;

  const active = await db.select({ enrId: mktFlowEnrollments.id, kind: mktFlows.triggerConfig })
    .from(mktFlowEnrollments)
    .innerJoin(mktFlows, eq(mktFlows.id, mktFlowEnrollments.flowId))
    .where(and(eq(mktFlowEnrollments.profileId, p.id), eq(mktFlowEnrollments.status, "active"), eq(mktFlows.workspaceId, workspaceId)));

  let cancelled = 0;
  for (const row of active) {
    const k = (row.kind as any)?.kind ?? null;
    if (flowKind !== "*" && k !== flowKind) continue;
    await db.update(mktFlowEnrollments)
      .set({ status: "exited", exitedAt: new Date(), exitReason: reason })
      .where(eq(mktFlowEnrollments.id, row.enrId));
    cancelled++;
  }
  return cancelled;
}

// ── Step execution ───────────────────────────────────────────────────────────
async function closeEnrollment(enrollmentId: number, reason: string): Promise<void> {
  const status = reason === "completed" ? "completed" : "exited";
  await db.update(mktFlowEnrollments)
    .set({ status, exitedAt: new Date(), exitReason: reason })
    .where(eq(mktFlowEnrollments.id, enrollmentId));
}

async function hasExitEventSince(flow: MktFlow, profileId: number, since: Date): Promise<boolean> {
  const metric = exitMetric(flow);
  if (!metric) return false;
  const res = await db.execute(sql`
    SELECT 1 FROM mkt_events e
    JOIN mkt_metrics m ON m.id = e.metric_id
    WHERE e.profile_id = ${profileId} AND m.workspace_id = ${flow.workspaceId}
      AND m.name = ${metric} AND e.occurred_at > ${since.toISOString()}::timestamptz
    LIMIT 1`);
  return (res.rows?.length ?? 0) > 0;
}

async function evalConditionForProfile(workspaceId: number, definition: any, profileId: number): Promise<boolean> {
  if (!hasConditions(definition)) return true; // no condition = pass
  const ids = await evaluateDefinition(definition, workspaceId);
  return ids.includes(profileId);
}

async function applyUpdateProperty(profileId: number, config: any): Promise<void> {
  const key = String(config?.path || "").replace(/^props\./, "").replace(/[^A-Za-z0-9_]/g, "");
  if (!key) return;
  const valueJson = JSON.stringify(config?.value ?? null);
  await db.execute(sql`
    UPDATE mkt_profiles
    SET props = coalesce(props, '{}'::jsonb) || jsonb_build_object(${key}::text, ${valueJson}::jsonb),
        updated_at = now()
    WHERE id = ${profileId}`);
}

interface MergeCtxExt extends MergeCtx { oneClickUrl: string }
function mergeCtxFor(profile: { id: number; email: string | null; firstName: string | null; lastName: string | null }, workspaceId: number): MergeCtxExt {
  const base = publicBaseUrl();
  const unsubToken = signUnsubscribeToken({ profileId: profile.id, workspaceId, scope: "brand" });
  const prefsToken = signPreferenceToken({ profileId: profile.id, workspaceId });
  return {
    first_name: profile.firstName || "", last_name: profile.lastName || "", email: profile.email || "",
    unsubscribe_url: `${base}/api/public/marketing/unsubscribe?token=${encodeURIComponent(unsubToken)}`,
    preferences_url: `${base}/api/public/marketing/preferences?token=${encodeURIComponent(prefsToken)}`,
    oneClickUrl: `${base}/api/public/marketing/unsubscribe/oneclick?token=${encodeURIComponent(unsubToken)}`,
  };
}

async function sendEmailStep(enr: typeof mktFlowEnrollments.$inferSelect, flow: MktFlow, step: FlowStep): Promise<void> {
  const idemKey = `${enr.id}:${step.id}`;
  const [run] = await db.insert(mktFlowStepRuns).values({
    enrollmentId: enr.id, stepId: step.id, status: "pending", channel: "email",
    idempotencyKey: idemKey, scheduledFor: new Date(),
  }).onConflictDoNothing().returning({ id: mktFlowStepRuns.id });
  if (!run) return; // this step already ran for this enrollment — at-most-once

  const isMkt = (step.config as any)?.isMarketing !== false;
  const gated = await filterSendable([enr.profileId], { workspaceId: flow.workspaceId, channel: "email", isMarketing: isMkt });
  const profile = gated.sendable[0];
  if (!profile || !profile.email) {
    await db.update(mktFlowStepRuns).set({ status: "skipped", executedAt: new Date() }).where(eq(mktFlowStepRuns.id, run.id));
    return; // skip-not-exit (suppressed / no consent / no identifier)
  }

  const ctx = mergeCtxFor(profile, flow.workspaceId);
  const shell = brandShell(flow.workspaceId);
  const html = ensureFooter(renderMergeTags((step.config as any)?.bodyHtml, ctx), ctx, shell.name);
  const subject = renderMergeTags((step.config as any)?.subject || "", ctx);
  const brandKey = brandKeyForWorkspace(flow.workspaceId);

  const [msg] = await db.insert(mktEmailMessages).values({
    brandKey, workspaceId: flow.workspaceId, campaignId: null, flowId: flow.id, profileId: enr.profileId,
    stream: isMkt ? "marketing" : "transactional", toEmail: profile.email, subject, status: "queued",
  }).returning({ id: mktEmailMessages.id });

  const result = await sendMarketingEmail({
    orgId: flow.workspaceId, to: profile.email, subject, html, idempotencyKey: msg.id,
    stream: isMkt ? "marketing" : "transactional",
    listUnsubscribeUrl: ctx.oneClickUrl,
    listUnsubscribeMailto: `unsubscribe@${(shell.linkHost || "cufc.co.nz").replace(/^join\./, "")}`,
    tags: [{ name: "flow_id", value: String(flow.id) }],
  });

  if (result.ok) {
    await db.update(mktEmailMessages).set({ status: "sent", sentAt: new Date(), resendEmailId: result.id }).where(eq(mktEmailMessages.id, msg.id));
    await db.update(mktFlowStepRuns).set({ status: "sent", messageId: Number(msg.id), executedAt: new Date() }).where(eq(mktFlowStepRuns.id, run.id));
  } else {
    await db.update(mktEmailMessages).set({ status: "failed" }).where(eq(mktEmailMessages.id, msg.id));
    await db.update(mktFlowStepRuns).set({ status: "failed", messageId: Number(msg.id), executedAt: new Date() }).where(eq(mktFlowStepRuns.id, run.id));
  }
}

async function sendSmsStep(enr: typeof mktFlowEnrollments.$inferSelect, flow: MktFlow, step: FlowStep): Promise<void> {
  const idemKey = `${enr.id}:${step.id}`;
  const [run] = await db.insert(mktFlowStepRuns).values({
    enrollmentId: enr.id, stepId: step.id, status: "pending", channel: "sms",
    idempotencyKey: idemKey, scheduledFor: new Date(),
  }).onConflictDoNothing().returning({ id: mktFlowStepRuns.id });
  if (!run) return;

  const isMkt = (step.config as any)?.isMarketing !== false;
  const gated = await filterSendable([enr.profileId], { workspaceId: flow.workspaceId, channel: "sms", isMarketing: isMkt });
  const profile = gated.sendable[0];
  if (!profile || !profile.phoneE164) {
    await db.update(mktFlowStepRuns).set({ status: "skipped", executedAt: new Date() }).where(eq(mktFlowStepRuns.id, run.id));
    return;
  }

  const ctx = mergeCtxFor(profile, flow.workspaceId);
  const raw = renderMergeTags((step.config as any)?.body || "", ctx);
  const body = isMkt ? appendOptOutSuffix(raw) : raw;
  const analysis = analyzeSms(body);
  const provider = getSmsProvider();

  const [msg] = await db.insert(mktSmsMessages).values({
    profileId: enr.profileId, phoneE164: profile.phoneE164, campaignId: null, body,
    encoding: analysis.encoding, segments: analysis.segments, provider: provider.name,
    isMarketing: isMkt, status: "queued",
  }).returning({ id: mktSmsMessages.id });

  try {
    const result = await provider.send({ to: profile.phoneE164, body, clientRef: idemKey });
    await db.update(mktSmsMessages).set({
      status: "sent", sentAt: new Date(), providerMessageId: result.providerMessageId,
      segments: result.segments, costCents: result.costCentsEstimate ?? null,
    }).where(eq(mktSmsMessages.id, msg.id));
    await db.update(mktFlowStepRuns).set({ status: "sent", messageId: Number(msg.id), executedAt: new Date() }).where(eq(mktFlowStepRuns.id, run.id));
  } catch {
    await db.update(mktSmsMessages).set({ status: "failed" }).where(eq(mktSmsMessages.id, msg.id));
    await db.update(mktFlowStepRuns).set({ status: "failed", messageId: Number(msg.id), executedAt: new Date() }).where(eq(mktFlowStepRuns.id, run.id));
  }
}

/**
 * graphile-worker task `flow:step` — advance ONE enrollment: process steps until
 * it hits a delay (schedule the future step + return) or an exit/end. Message
 * steps run through the suppression gate and honour quiet hours (D7). Every side
 * effect is keyed by idempotency, so an at-least-once retry never double-sends.
 */
export async function runFlowStep(payload: any, helpers?: JobHelpers): Promise<void> {
  const enrollmentId = Number(payload?.enrollmentId);
  const startStepId: string | undefined = payload?.stepId;
  if (!Number.isFinite(enrollmentId)) return;

  const [enr] = await db.select().from(mktFlowEnrollments).where(eq(mktFlowEnrollments.id, enrollmentId)).limit(1);
  if (!enr || enr.status !== "active") return; // cancelled/converted/completed → no-op

  const [flow] = await db.select().from(mktFlows).where(eq(mktFlows.id, enr.flowId)).limit(1);
  if (!flow) return;

  // Flow-level lifecycle: park a paused flow's steps; exit an archived flow.
  if (flow.status === "archived") { await closeEnrollment(enr.id, "archived"); return; }
  if (flow.status !== "live") {
    // paused / draft — hold and retry in 30 min (resumes when set live).
    await addMarketingJob("flow:step", { enrollmentId: enr.id, stepId: enr.currentStepId },
      { jobKey: `flow:${flow.id}:${enr.profileId}`, jobKeyMode: "replace", runAt: new Date(Date.now() + 30 * 60_000) });
    return;
  }

  const [ver] = await db.select().from(mktFlowVersions).where(eq(mktFlowVersions.id, enr.flowVersionId)).limit(1);
  if (!ver) { await closeEnrollment(enr.id, "error"); return; }
  const graph = normalizeGraph(ver.graph);
  const profileId = enr.profileId;
  const jobKey = `flow:${flow.id}:${profileId}`;

  // Exit condition — a conversion event since entry stops the flow before any step.
  if (await hasExitEventSince(flow, profileId, enr.enteredAt)) { await closeEnrollment(enr.id, "converted"); return; }

  let currentId: string | null = startStepId ?? enr.currentStepId ?? entryStepId(graph);
  let guard = 0;
  while (currentId && guard++ < 200) {
    const step = getStep(graph, currentId);
    if (!step) { await closeEnrollment(enr.id, "completed"); return; }

    if (step.type === "exit") { await closeEnrollment(enr.id, String((step.config as any)?.reason || "exit")); return; }

    if (step.type === "delay") {
      const nextId = step.next;
      if (!nextId) { await closeEnrollment(enr.id, "completed"); return; }
      const nextStep = getStep(graph, nextId);
      const runAt = scheduleForStep(new Date(Date.now() + delayToMs(step.config as any)), isMessageStep(nextStep));
      await db.update(mktFlowEnrollments).set({ currentStepId: nextId }).where(eq(mktFlowEnrollments.id, enr.id));
      await addMarketingJob("flow:step", { enrollmentId: enr.id, stepId: nextId }, { jobKey, jobKeyMode: "replace", runAt });
      return;
    }

    if (step.type === "condition") {
      const pass = await evalConditionForProfile(flow.workspaceId, (step.config as any)?.definition, profileId);
      const nextId = resolveNext(step, pass);
      if (!nextId) { await closeEnrollment(enr.id, "completed"); return; }
      await db.update(mktFlowEnrollments).set({ currentStepId: nextId }).where(eq(mktFlowEnrollments.id, enr.id));
      currentId = nextId; continue;
    }

    if (step.type === "update_property") {
      await applyUpdateProperty(profileId, step.config);
      const nextId = step.next;
      if (!nextId) { await closeEnrollment(enr.id, "completed"); return; }
      await db.update(mktFlowEnrollments).set({ currentStepId: nextId }).where(eq(mktFlowEnrollments.id, enr.id));
      currentId = nextId; continue;
    }

    // message step (email | sms) — quiet hours defer, then send.
    const now = new Date();
    const deferred = scheduleForStep(now, true);
    if (deferred.getTime() !== now.getTime()) {
      await db.update(mktFlowEnrollments).set({ currentStepId: currentId }).where(eq(mktFlowEnrollments.id, enr.id));
      await addMarketingJob("flow:step", { enrollmentId: enr.id, stepId: currentId }, { jobKey, jobKeyMode: "replace", runAt: deferred });
      return;
    }
    try {
      if (step.type === "email") await sendEmailStep(enr, flow, step);
      else await sendSmsStep(enr, flow, step);
    } catch (e: any) {
      helpers?.logger?.error?.(`flow ${flow.id} enr ${enr.id} step ${step.id} send error: ${e?.message}`);
    }
    const nextId = step.next;
    if (!nextId) { await closeEnrollment(enr.id, "completed"); return; }
    await db.update(mktFlowEnrollments).set({ currentStepId: nextId }).where(eq(mktFlowEnrollments.id, enr.id));
    currentId = nextId; continue;
  }
  await closeEnrollment(enr.id, "completed");
}

// ── Versioning (draft / publish) ─────────────────────────────────────────────
/** Newest version row for a flow (the working draft — published or not). */
export async function newestVersion(flowId: number): Promise<typeof mktFlowVersions.$inferSelect | null> {
  const [v] = await db.select().from(mktFlowVersions).where(eq(mktFlowVersions.flowId, flowId)).orderBy(desc(mktFlowVersions.versionNo)).limit(1);
  return v ?? null;
}

/**
 * Save a draft graph WITHOUT touching the live version: update the newest
 * unpublished version in place, or fork a new unpublished version above the live
 * one. Running enrollments (pinned to the published version) are untouched.
 */
export async function saveDraftGraph(flowId: number, graph: FlowGraph): Promise<number> {
  const newest = await newestVersion(flowId);
  if (newest && newest.publishedAt == null) {
    await db.update(mktFlowVersions).set({ graph: graph as any }).where(eq(mktFlowVersions.id, newest.id));
    return newest.id;
  }
  const nextNo = (newest?.versionNo ?? 0) + 1;
  const [v] = await db.insert(mktFlowVersions).values({ flowId, versionNo: nextNo, graph: graph as any, publishedAt: null }).returning({ id: mktFlowVersions.id });
  return v.id;
}

/**
 * Publish = make the newest version immutable + live. New entrants get it;
 * running enrollments keep their pinned (older) version. Returns the live version.
 */
export async function publishFlow(flowId: number): Promise<{ versionId: number; versionNo: number } | null> {
  const newest = await newestVersion(flowId);
  if (!newest) return null;
  if (newest.publishedAt == null) {
    await db.update(mktFlowVersions).set({ publishedAt: new Date() }).where(eq(mktFlowVersions.id, newest.id));
  }
  await db.update(mktFlows).set({ liveVersionId: newest.id, status: "live", updatedAt: new Date() }).where(eq(mktFlows.id, flowId));
  return { versionId: newest.id, versionNo: newest.versionNo };
}

// ── The sweep (graphile-worker cron: every 15 min) ────────────────────────────
const REG_NOTICE = "You provided this contact detail when you began a registration with the club; we may contact you about completing that registration.";

/** Seed an inferred, operational consent row so a derived abandoner can be
 *  contacted about their in-progress registration (never fabricates marketing
 *  consent — that stays express-only). No-op if any consent row already exists. */
async function ensureInferredConsent(profileId: number, channel: "email" | "sms", notice: string): Promise<void> {
  const [existing] = await db.select({ id: mktConsent.id }).from(mktConsent)
    .where(and(eq(mktConsent.profileId, profileId), eq(mktConsent.channel, channel))).limit(1);
  if (existing) return;
  await db.insert(mktConsent).values({
    profileId, channel, subState: "never", legalBasis: "inferred", canReceive: false,
    source: "clubos:registration:started", consentShownText: notice, consentAt: new Date(),
  }).onConflictDoNothing();
}

function splitName(full: string | null | undefined): { firstName: string | null; lastName: string | null } {
  const parts = String(full || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: null, lastName: null };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") || null };
}

async function contactForRegistration(guardianId: number | null, contactId: number): Promise<{ email: string | null; phone: string | null; firstName: string | null; lastName: string | null } | null> {
  const primaryId = guardianId ?? contactId;
  const [c] = await db.select({ email: contacts.email, phone: contacts.phone, firstName: contacts.firstName, lastName: contacts.lastName })
    .from(contacts).where(eq(contacts.id, primaryId)).limit(1);
  if (c?.email) return c;
  if (guardianId != null && contactId !== guardianId) {
    const [p] = await db.select({ email: contacts.email, phone: contacts.phone, firstName: contacts.firstName, lastName: contacts.lastName })
      .from(contacts).where(eq(contacts.id, contactId)).limit(1);
    if (p?.email) return p;
  }
  return c ?? null;
}

/** Abandoned-enrolment derivation: pending registration rows (1h–72h old) →
 *  'Started Registration' events (deduped forever by unique_id) that enrol the
 *  guardian/contact into any live flow triggered on that metric. Confirmed rows →
 *  'Completed Registration' + explicit cancel of the recovery flow. */
async function sweepAbandonedEnrolment(now: Date): Promise<void> {
  const to = new Date(now.getTime() - 1 * 3600_000);    // must be at least 1h old
  const from = new Date(now.getTime() - 72 * 3600_000); // but not older than 72h

  // ── registrations (academy / league / tournament / camps) ──
  const regPending = await db.select({
    id: registrations.id, contactId: registrations.contactId, guardianId: registrations.guardianId,
    orgId: programs.organizationId, programId: registrations.programId,
  }).from(registrations).innerJoin(programs, eq(programs.id, registrations.programId))
    .where(and(eq(registrations.status, "pending"), gte(registrations.registeredAt, from), lte(registrations.registeredAt, to)));

  for (const r of regPending) {
    if (r.orgId == null) continue;
    const c = await contactForRegistration(r.guardianId, r.contactId);
    if (!c?.email) continue;
    try {
      const res = await trackEvent({
        workspaceId: r.orgId,
        profile: { email: c.email, phone: c.phone, firstName: c.firstName, lastName: c.lastName },
        metric: "Started Registration", uniqueId: `reg:${r.id}`,
        properties: { registrationId: r.id, programId: r.programId, source: "registrations" },
      });
      if (res.profileId != null) await ensureInferredConsent(res.profileId, "email", REG_NOTICE);
    } catch { /* keep sweeping */ }
  }

  // confirmed registrations (last 72h by creation) → Completed Registration + cancel recovery
  const regConfirmed = await db.select({
    id: registrations.id, contactId: registrations.contactId, guardianId: registrations.guardianId,
    orgId: programs.organizationId, programId: registrations.programId,
  }).from(registrations).innerJoin(programs, eq(programs.id, registrations.programId))
    .where(and(eq(registrations.status, "confirmed"), gte(registrations.registeredAt, from)));

  for (const r of regConfirmed) {
    if (r.orgId == null) continue;
    const c = await contactForRegistration(r.guardianId, r.contactId);
    if (!c?.email) continue;
    try {
      await trackEvent({
        workspaceId: r.orgId,
        profile: { email: c.email, phone: c.phone, firstName: c.firstName, lastName: c.lastName },
        metric: "Completed Registration", uniqueId: `reg-done:${r.id}`,
        properties: { registrationId: r.id, programId: r.programId, source: "registrations" },
      });
      await cancelFlowEnrollment("abandoned_enrolment", r.orgId, c.email, "converted");
    } catch { /* keep sweeping */ }
  }

  // ── CUGC registrations (own table; pending_payment → paid) ──
  const cugcPending = await db.select().from(cugcRegistrations)
    .where(and(eq(cugcRegistrations.status, "pending_payment"), gte(cugcRegistrations.createdAt, from), lte(cugcRegistrations.createdAt, to)));
  for (const r of cugcPending) {
    if (!r.email) continue;
    const nm = splitName(r.parentName);
    try {
      const res = await trackEvent({
        workspaceId: r.organizationId,
        profile: { email: r.email, phone: r.phone, firstName: nm.firstName, lastName: nm.lastName },
        metric: "Started Registration", uniqueId: `cugcreg:${r.id}`,
        properties: { cugcRegistrationId: r.id, programSlug: r.programSlug, source: "cugc_registrations" },
      });
      if (res.profileId != null) await ensureInferredConsent(res.profileId, "email", REG_NOTICE);
    } catch { /* keep sweeping */ }
  }

  const cugcPaid = await db.select().from(cugcRegistrations)
    .where(and(eq(cugcRegistrations.status, "paid"), isNotNull(cugcRegistrations.paidAt), gte(cugcRegistrations.paidAt, from)));
  for (const r of cugcPaid) {
    if (!r.email) continue;
    const nm = splitName(r.parentName);
    try {
      await trackEvent({
        workspaceId: r.organizationId,
        profile: { email: r.email, phone: r.phone, firstName: nm.firstName, lastName: nm.lastName },
        metric: "Completed Registration", uniqueId: `cugcreg-done:${r.id}`,
        properties: { cugcRegistrationId: r.id, programSlug: r.programSlug, source: "cugc_registrations" },
      });
      await cancelFlowEnrollment("abandoned_enrolment", r.organizationId, r.email, "converted");
    } catch { /* keep sweeping */ }
  }
}

// ── Date-property flows (term reminders etc.) ────────────────────────────────
function parseTime(t: string | undefined): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || "09:00"));
  if (!m) return [9, 0];
  return [Math.min(23, Number(m[1])), Math.min(59, Number(m[2]))];
}

/** NZ wall-clock → UTC instant (DST-safe fixed-point; same technique as the SMS lib). */
function nzWallToUtc(y: number, mo: number, d: number, hh: number, mm: number): Date {
  const tz = "Pacific/Auckland";
  let guessMs = Date.UTC(y, mo - 1, d, hh, mm, 0);
  const wantMs = guessMs;
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(guessMs));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
    const asUtcMs = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    const diff = wantMs - asUtcMs;
    if (diff === 0) break;
    guessMs += diff;
  }
  return new Date(guessMs);
}

/** Target instant = (baseISODate + offsetDays) at `time` NZ. */
function computeDateTarget(baseISO: string, offsetDays: number, time: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(baseISO || ""));
  if (!m) return null;
  const base = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  base.setUTCDate(base.getUTCDate() + (Number(offsetDays) || 0));
  const [hh, mm] = parseTime(time);
  return nzWallToUtc(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), hh, mm);
}

// Due if the target has just passed (catch-up window 24h; the re-entry='never'
// guard means a flow enrols each profile at most once across all sweeps).
function isDue(target: Date | null, now: Date): boolean {
  if (!target) return false;
  const t = target.getTime();
  return t <= now.getTime() && t > now.getTime() - 24 * 3600_000;
}

async function allProfileIds(workspaceId: number): Promise<number[]> {
  const rows = await db.select({ id: mktProfiles.id }).from(mktProfiles).where(eq(mktProfiles.workspaceId, workspaceId));
  return rows.map((r) => r.id);
}

async function sweepDatePropertyFlows(now: Date): Promise<void> {
  const flows = await db.select().from(mktFlows)
    .where(and(eq(mktFlows.status, "live"), eq(mktFlows.triggerType, "date_property")));

  for (const flow of flows) {
    const v = await loadLiveVersion(flow);
    if (!v) continue;
    const cfg = (flow.triggerConfig as any) || {};
    const source = cfg.source || "term_start";

    if (source === "term_start") {
      const target = computeDateTarget(cfg.date, cfg.offsetDays, cfg.time);
      if (!isDue(target, now)) continue;
      const ids = hasConditions(flow.entryFilter)
        ? await evaluateDefinition(flow.entryFilter as any, flow.workspaceId)
        : await allProfileIds(flow.workspaceId);
      for (const pid of ids) await doEnroll(flow, v.versionId, v.graph, pid, { trigger: "date_property", target: target?.toISOString() }).catch(() => {});
    } else if (source === "profile_prop") {
      const path = String(cfg.propertyPath || "").replace(/[^A-Za-z0-9_]/g, "");
      if (!path) continue;
      // Per-profile date in props[path]; compute each target, enrol the due ones.
      const rows = await db.execute(sql`
        SELECT id, (props ->> ${path}) AS val FROM mkt_profiles
        WHERE workspace_id = ${flow.workspaceId} AND props ? ${path}`);
      for (const row of rows.rows as { id: number; val: string }[]) {
        const target = computeDateTarget(row.val, cfg.offsetDays, cfg.time);
        if (!isDue(target, now)) continue;
        await doEnroll(flow, v.versionId, v.graph, Number(row.id), { trigger: "date_property", target: target?.toISOString() }).catch(() => {});
      }
    }
  }
}

/** The `flow:sweep` cron body — date-property enrolment + abandoned-enrolment derivation. */
export async function flowSweep(): Promise<void> {
  const now = new Date();
  await sweepDatePropertyFlows(now).catch((e) => console.error("[Marketing] date sweep error:", e?.message));
  await sweepAbandonedEnrolment(now).catch((e) => console.error("[Marketing] abandoned sweep error:", e?.message));
}
