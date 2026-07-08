/**
 * Marketing Suite — the event pipeline (the append-only keystone stream).
 *
 * `trackEvent` is the single ingress for behavioural events (Registered, Started
 * Registration, Purchased, Renewed, Attended, Watched …): it find-or-creates the
 * metric + profile (light upsert) and appends a deduped row to mkt_events.
 *
 * `attributeConversion` runs the honest, click-triggered, last-touch model on any
 * value-bearing event: it looks back a 3-day window for the most recent
 * NON-bot click by that profile and materialises an mkt_conversions row (keeping
 * the raw click so a different window/model can be recomputed). Opens NEVER
 * trigger attribution (MPP trap) — only real human clicks.
 *
 * Spec: synthesis §(a) mkt_events/mkt_conversions + tension C4/M10 (3-day,
 * last-touch, click-triggered, recomputable).
 */

import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "../db";
import { mktProfiles, mktMetrics, mktEvents, mktEmailLinkClicks, mktConversions } from "@shared/schema";

const lc = (s: string | null | undefined) => (s || "").trim().toLowerCase();

export interface TrackEventInput {
  workspaceId: number;
  profile: { id?: number; email?: string | null; phone?: string | null; firstName?: string | null; lastName?: string | null };
  metric: string;
  properties?: Record<string, unknown>;
  value?: number | string | null;
  currency?: string | null;
  uniqueId?: string | null;
  occurredAt?: Date;
}

export interface TrackEventResult {
  profileId: number | null;
  metricId: number;
  eventId: number | null;
  deduped: boolean;
  conversionId: number | null;
}

/** Find-or-create a metric for a workspace (idempotent under concurrency). */
export async function findOrCreateMetric(workspaceId: number, name: string): Promise<number> {
  const clean = name.trim();
  await db.insert(mktMetrics).values({ workspaceId, name: clean }).onConflictDoNothing();
  const [row] = await db.select({ id: mktMetrics.id }).from(mktMetrics)
    .where(and(eq(mktMetrics.workspaceId, workspaceId), eq(mktMetrics.name, clean))).limit(1);
  return row.id;
}

/** Light find-or-create of a profile by id → email → phone within a workspace. */
export async function findOrCreateProfile(
  workspaceId: number,
  who: { id?: number; email?: string | null; phone?: string | null; firstName?: string | null; lastName?: string | null },
): Promise<number | null> {
  if (who.id != null) {
    const [p] = await db.select({ id: mktProfiles.id }).from(mktProfiles)
      .where(and(eq(mktProfiles.id, who.id), eq(mktProfiles.workspaceId, workspaceId))).limit(1);
    if (p) return p.id;
  }
  const email = lc(who.email);
  const phone = (who.phone || "").trim() || null;

  if (email) {
    const [p] = await db.select({ id: mktProfiles.id }).from(mktProfiles)
      .where(and(eq(mktProfiles.workspaceId, workspaceId), sql`lower(${mktProfiles.email}) = ${email}`)).limit(1);
    if (p) return p.id;
  }
  if (phone) {
    const [p] = await db.select({ id: mktProfiles.id }).from(mktProfiles)
      .where(and(eq(mktProfiles.workspaceId, workspaceId), eq(mktProfiles.phoneE164, phone))).limit(1);
    if (p) return p.id;
  }
  if (!email && !phone) return null;

  const [created] = await db.insert(mktProfiles).values({
    workspaceId, email: email || null, phoneE164: phone,
    firstName: who.firstName ?? null, lastName: who.lastName ?? null,
  }).onConflictDoNothing().returning({ id: mktProfiles.id });
  if (created) return created.id;

  // Lost a race — re-read.
  if (email) {
    const [p] = await db.select({ id: mktProfiles.id }).from(mktProfiles)
      .where(and(eq(mktProfiles.workspaceId, workspaceId), sql`lower(${mktProfiles.email}) = ${email}`)).limit(1);
    if (p) return p.id;
  }
  if (phone) {
    const [p] = await db.select({ id: mktProfiles.id }).from(mktProfiles)
      .where(and(eq(mktProfiles.workspaceId, workspaceId), eq(mktProfiles.phoneE164, phone))).limit(1);
    if (p) return p.id;
  }
  return null;
}

export async function trackEvent(input: TrackEventInput): Promise<TrackEventResult> {
  const occurredAt = input.occurredAt ?? new Date();
  const metricId = await findOrCreateMetric(input.workspaceId, input.metric);
  const profileId = await findOrCreateProfile(input.workspaceId, { ...input.profile });

  if (profileId == null) {
    return { profileId: null, metricId, eventId: null, deduped: false, conversionId: null };
  }

  const valueNum = input.value == null || input.value === "" ? null : Number(input.value);
  const inserted = await db.insert(mktEvents).values({
    workspaceId: input.workspaceId,
    profileId,
    metricId,
    properties: input.properties ?? {},
    value: valueNum != null && Number.isFinite(valueNum) ? String(valueNum) : null,
    valueCurrency: input.currency ?? (valueNum != null ? "NZD" : null),
    uniqueId: input.uniqueId ?? null,
    occurredAt,
  }).onConflictDoNothing().returning({ id: mktEvents.id });

  const eventId = inserted[0]?.id ?? null;
  const deduped = eventId == null;

  // Advance last_event_at (best-effort).
  await db.update(mktProfiles).set({ lastEventAt: occurredAt }).where(eq(mktProfiles.id, profileId)).catch(() => {});

  // Value-bearing, newly-inserted events run last-touch click attribution.
  let conversionId: number | null = null;
  if (!deduped && valueNum != null && Number.isFinite(valueNum) && valueNum > 0) {
    conversionId = await attributeConversion({
      profileId,
      value: valueNum,
      currency: input.currency ?? "NZD",
      conversionType: input.metric,
      occurredAt,
    });
  }

  return { profileId, metricId, eventId, deduped, conversionId };
}

export interface AttributeConversionInput {
  profileId: number;
  value: number;
  currency?: string;
  conversionType?: string;
  occurredAt: Date;
  windowDays?: number;
}

/**
 * Last-touch, click-triggered attribution: find the most recent non-bot click by
 * this profile within the window and materialise an mkt_conversions row. Returns
 * the conversion id, or null if no click was found in the window (unattributed).
 */
export async function attributeConversion(input: AttributeConversionInput): Promise<number | null> {
  const windowDays = input.windowDays ?? 3;
  const windowStart = new Date(input.occurredAt.getTime() - windowDays * 24 * 60 * 60 * 1000);

  const [click] = await db.select({
    messageId: mktEmailLinkClicks.messageId,
    campaignId: mktEmailLinkClicks.campaignId,
    clickedAt: mktEmailLinkClicks.clickedAt,
  }).from(mktEmailLinkClicks)
    .where(and(
      eq(mktEmailLinkClicks.profileId, input.profileId),
      eq(mktEmailLinkClicks.isBot, false),
      gte(mktEmailLinkClicks.clickedAt, windowStart),
      lte(mktEmailLinkClicks.clickedAt, input.occurredAt),
    ))
    .orderBy(desc(mktEmailLinkClicks.clickedAt))
    .limit(1);

  if (!click) return null;

  const [row] = await db.insert(mktConversions).values({
    profileId: input.profileId,
    messageId: click.messageId ?? null,
    campaignId: click.campaignId ?? null,
    conversionType: input.conversionType ?? null,
    revenueCents: Math.round(input.value * 100),
    currency: input.currency ?? "NZD",
    attributedClickAt: click.clickedAt,
    convertedAt: input.occurredAt,
    windowDays,
    model: "last_touch_click",
  }).returning({ id: mktConversions.id });

  return row?.id ?? null;
}
