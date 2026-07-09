/**
 * Marketing Suite — THE send gate. EVERY send path (campaign, flow, test) MUST
 * pass its recipient ids through `filterSendable` before a single email/SMS is
 * dispatched. No list, segment or manual override can bypass it.
 *
 * A recipient is sendable only if ALL hold for the requested channel:
 *   1. it has the identifier the channel needs (email / phone_e164);
 *   2. CONSENT —
 *        marketing    ⇒ sub_state = 'subscribed' AND legal_basis = 'express'
 *        operational  ⇒ legal_basis IN ('express','inferred') AND not unsubscribed
 *      (a missing consent row = no recorded basis = NOT sendable — NZ UEMA s9(3)
 *       burden of proof);
 *   3. SUPPRESSION — the address is NOT in mkt_suppressions at any of the 4 scopes
 *      that apply (global, brand for this workspace's brand_key, category, list),
 *      ignoring suppressions whose expires_at has passed ("pause 30 days").
 *
 * `suppress()` is the write side, used by the webhook (bounce/complaint) and the
 * public unsub/preference handlers — it inserts the suppression row and (by
 * default) downgrades the matching profiles' consent to opted_out.
 *
 * Spec: synthesis §(a) mkt_consent/mkt_suppressions + §(d) gate 1.
 */

import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "../db";
import { mktProfiles, mktConsent, mktSuppressions } from "@shared/schema";
import { BRAND_KEY_BY_ORG, brandKeyForWorkspace } from "./brand";

export type MktChannel = "email" | "sms";
export type SuppressScope = "global" | "brand" | "category" | "list";
export type SuppressReason = "unsub_oneclick" | "unsub_prefs" | "complaint" | "hard_bounce" | "manual" | "invalid";

export interface SendableProfile {
  id: number;
  email: string | null;
  phoneE164: string | null;
  firstName: string | null;
  lastName: string | null;
  props: Record<string, unknown>;
}

export interface FilterSendableResult {
  sendable: SendableProfile[];
  total: number;
  excluded: number;
  excludedByConsent: number;
  excludedBySuppression: number;
  excludedNoIdentifier: number;
}

export interface FilterSendableOpts {
  workspaceId: number;
  channel: MktChannel;
  isMarketing: boolean;
  category?: string | null;
  listId?: number | null;
}

const lc = (s: string | null | undefined) => (s || "").trim().toLowerCase();

/** reverse of BRAND_KEY_BY_ORG — the org id that owns a brand_key (for brand-scope consent downgrade). */
function orgIdForBrandKey(brandKey: string | null | undefined): number | null {
  if (!brandKey) return null;
  const found = Object.entries(BRAND_KEY_BY_ORG).find(([, k]) => k === brandKey);
  if (found) return Number(found[0]);
  const asNum = Number(brandKey);
  return Number.isFinite(asNum) ? asNum : null;
}

export async function filterSendable(
  profileIds: number[],
  opts: FilterSendableOpts,
): Promise<FilterSendableResult> {
  const empty: FilterSendableResult = {
    sendable: [], total: 0, excluded: 0, excludedByConsent: 0, excludedBySuppression: 0, excludedNoIdentifier: 0,
  };
  const ids = Array.from(new Set(profileIds)).filter((n) => Number.isFinite(n));
  if (ids.length === 0) return empty;

  // 1. Load profiles — scoped to the workspace (a cross-workspace id can't leak in).
  const profiles = await db
    .select({
      id: mktProfiles.id, email: mktProfiles.email, phoneE164: mktProfiles.phoneE164,
      firstName: mktProfiles.firstName, lastName: mktProfiles.lastName, props: mktProfiles.props,
    })
    .from(mktProfiles)
    .where(and(eq(mktProfiles.workspaceId, opts.workspaceId), inArray(mktProfiles.id, ids)));

  if (profiles.length === 0) return { ...empty, total: 0 };

  // 2. Consent for these profiles + channel.
  const consentRows = await db
    .select({ profileId: mktConsent.profileId, subState: mktConsent.subState, legalBasis: mktConsent.legalBasis })
    .from(mktConsent)
    .where(and(inArray(mktConsent.profileId, profiles.map((p) => p.id)), eq(mktConsent.channel, opts.channel)));
  const consentByProfile = new Map(consentRows.map((c) => [c.profileId, c]));

  // 3. Suppressions — build the set of suppressed emails/phones across the 4 scopes.
  const brandKey = brandKeyForWorkspace(opts.workspaceId);
  const emails = Array.from(new Set(profiles.map((p) => lc(p.email)).filter(Boolean)));
  const phones = Array.from(new Set(profiles.map((p) => p.phoneE164).filter(Boolean) as string[]));

  const suppressedEmails = new Set<string>();
  const suppressedPhones = new Set<string>();

  if (emails.length || phones.length) {
    const scopeClauses = [eq(mktSuppressions.scope, "global")] as any[];
    if (brandKey) scopeClauses.push(and(eq(mktSuppressions.scope, "brand"), eq(mktSuppressions.brandKey, brandKey)));
    if (opts.category) scopeClauses.push(and(eq(mktSuppressions.scope, "category"), eq(mktSuppressions.category, opts.category)));
    if (opts.listId != null) scopeClauses.push(and(eq(mktSuppressions.scope, "list"), eq(mktSuppressions.listId, opts.listId)));

    // Suppression + profile emails are stored already-lowercased by the ingest,
    // so a direct inArray on the column matches without a lower() expression.
    const identifierClause = or(
      emails.length ? inArray(mktSuppressions.email, emails) : sql`false`,
      phones.length ? inArray(mktSuppressions.phoneE164, phones) : sql`false`,
    );

    const rows = await db
      .select({ email: mktSuppressions.email, phoneE164: mktSuppressions.phoneE164 })
      .from(mktSuppressions)
      .where(and(
        eq(mktSuppressions.channel, opts.channel),
        or(...scopeClauses),
        identifierClause,
        or(isNull(mktSuppressions.expiresAt), gt(mktSuppressions.expiresAt, new Date())),
      ));
    for (const r of rows) {
      if (r.email) suppressedEmails.add(lc(r.email));
      if (r.phoneE164) suppressedPhones.add(r.phoneE164);
    }
  }

  // 4. Verdict per profile.
  const result: FilterSendableResult = { ...empty, total: profiles.length, sendable: [] };
  for (const p of profiles) {
    const identifier = opts.channel === "email" ? lc(p.email) : (p.phoneE164 || "");
    if (!identifier) { result.excludedNoIdentifier++; continue; }

    const c = consentByProfile.get(p.id);
    let consentOk = false;
    if (c) {
      if (opts.isMarketing) {
        consentOk = c.subState === "subscribed" && c.legalBasis === "express";
      } else {
        consentOk = (c.legalBasis === "express" || c.legalBasis === "inferred") && c.subState !== "unsubscribed";
      }
    }
    if (!consentOk) { result.excludedByConsent++; continue; }

    const suppressed = opts.channel === "email"
      ? suppressedEmails.has(identifier)
      : suppressedPhones.has(identifier);
    if (suppressed) { result.excludedBySuppression++; continue; }

    result.sendable.push({
      id: p.id, email: p.email, phoneE164: p.phoneE164,
      firstName: p.firstName, lastName: p.lastName,
      props: (p.props as Record<string, unknown>) || {},
    });
  }
  result.excluded = result.total - result.sendable.length;
  return result;
}

// ── Write side ───────────────────────────────────────────────────────────────
export interface SuppressOpts {
  email?: string | null;
  phoneE164?: string | null;
  channel: MktChannel;
  scope: SuppressScope;
  brandKey?: string | null;
  category?: string | null;
  listId?: number | null;
  reason: SuppressReason;
  source?: string;
  expiresAt?: Date | null;
  /** Also set matching profiles' consent to opted_out (default true for global/brand). */
  downgradeConsent?: boolean;
  /** Restrict the consent downgrade to this workspace (brand scope). */
  workspaceId?: number | null;
}

/**
 * Insert a suppression row (idempotent) and, by default, downgrade the matching
 * profiles' consent to unsubscribed/opted_out. The one write used by the webhook
 * (bounce/complaint) and the public unsub/preference handlers.
 */
export async function suppress(opts: SuppressOpts): Promise<void> {
  const email = opts.email ? lc(opts.email) : null;
  const phone = opts.phoneE164 || null;
  if (!email && !phone) return;

  await db.insert(mktSuppressions).values({
    email, phoneE164: phone, channel: opts.channel, scope: opts.scope,
    brandKey: opts.brandKey ?? null, category: opts.category ?? null, listId: opts.listId ?? null,
    reason: opts.reason, source: opts.source ?? null, expiresAt: opts.expiresAt ?? null,
  }).onConflictDoNothing();

  const downgrade = opts.downgradeConsent ?? (opts.scope === "global" || opts.scope === "brand");
  if (!downgrade) return;

  // Which profiles to downgrade: any matching the address, narrowed to the brand's
  // workspace for a brand-scope suppression (a CUFC unsub must not touch SIU).
  const conds: any[] = [];
  if (email && phone) conds.push(or(sql`lower(${mktProfiles.email}) = ${email}`, eq(mktProfiles.phoneE164, phone)));
  else if (email) conds.push(sql`lower(${mktProfiles.email}) = ${email}`);
  else if (phone) conds.push(eq(mktProfiles.phoneE164, phone));

  const wsId = opts.workspaceId ?? (opts.scope === "brand" ? orgIdForBrandKey(opts.brandKey) : null);
  if (opts.scope === "brand" && wsId != null) conds.push(eq(mktProfiles.workspaceId, wsId));

  const targets = await db.select({ id: mktProfiles.id }).from(mktProfiles).where(and(...conds));
  for (const t of targets) {
    await optOutConsent(t.id, opts.channel);
  }
}

/** Set a profile's consent for a channel to unsubscribed/opted_out (upsert). Always wins. */
export async function optOutConsent(profileId: number, channel: MktChannel): Promise<void> {
  const [existing] = await db
    .select({ id: mktConsent.id })
    .from(mktConsent)
    .where(and(eq(mktConsent.profileId, profileId), eq(mktConsent.channel, channel)))
    .limit(1);
  if (existing) {
    await db.update(mktConsent).set({
      subState: "unsubscribed", legalBasis: "opted_out", canReceive: false, updatedAt: new Date(),
    }).where(eq(mktConsent.id, existing.id));
  } else {
    await db.insert(mktConsent).values({
      profileId, channel, subState: "unsubscribed", legalBasis: "opted_out",
      canReceive: false, source: "clubos:marketing:opt_out", consentAt: new Date(),
    }).onConflictDoNothing();
  }
}

/** Remove a suppression (admin un-suppress) and re-enable consent to subscribed/express. */
export async function unsuppress(opts: {
  email?: string | null; phoneE164?: string | null; channel: MktChannel; workspaceId?: number | null;
}): Promise<void> {
  const email = opts.email ? lc(opts.email) : null;
  const phone = opts.phoneE164 || null;
  if (!email && !phone) return;
  const idClause = or(
    email ? sql`lower(${mktSuppressions.email}) = ${email}` : sql`false`,
    phone ? eq(mktSuppressions.phoneE164, phone) : sql`false`,
  );
  await db.delete(mktSuppressions).where(and(eq(mktSuppressions.channel, opts.channel), idClause));
}
