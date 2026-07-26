/**
 * Marketing Suite — Klaviyo → ClubOS importer (migration, Phase A companion).
 *
 * Reads the read-only JSONL export produced by
 * scripts/klaviyo_migration/export_klaviyo.py (outside this repo, in the
 * outer AIOS workspace — see WORKSPACE_ROOT below) and loads it into the
 * canonical mkt_profiles / mkt_consent / mkt_suppressions / mkt_lists /
 * mkt_list_members tables, using the SAME semantics as the existing ClubOS
 * ingest (server/marketing/ingest.ts): idempotent upsert keyed on
 * (workspace_id, lower(email)), rank-based never-downgrade consent, the
 * shared-phone guard, and per-row transient-network retry. This file
 * deliberately MIRRORS ingest.ts's logic rather than importing its private
 * (non-exported) helpers, so the two stay readable side by side.
 *
 * Klaviyo consent IS real recorded opt-in (unlike most of ClubOS's other
 * audience tables, which only ever get `never`/`inferred` by default) — so
 * SUBSCRIBED maps straight to `subscribed`/`express` for both channels.
 *
 *   npx tsx --env-file=.env script/import-klaviyo.ts --account cufc --dry-run
 *   npx tsx --env-file=.env script/import-klaviyo.ts --account siu  --dry-run
 *   npx tsx --env-file=.env script/import-klaviyo.ts --account cufc
 *   npx tsx --env-file=.env script/import-klaviyo.ts --account siu
 *
 * Always dry-run first — see scripts/klaviyo_migration/README.md §Import.
 */

import { and, eq, sql } from "drizzle-orm";
import { existsSync, mkdirSync, writeFileSync, createReadStream } from "fs";
import { createInterface } from "readline";
import { join } from "path";
import { fileURLToPath } from "url";
import { db } from "../server/db";
import { mktProfiles, mktConsent, mktSuppressions, mktLists, mktListMembers } from "@shared/schema";
import { normalizeNzPhone } from "../server/marketing/ingest";
import { BRAND_KEY_BY_ORG } from "../server/marketing/brand";

// ─── Paths ───────────────────────────────────────────────────────────────────
// This worktree (apps/clubos/.worktrees/marketing) is a git worktree several
// levels below the outer AIOS workspace where the Klaviyo export lands
// (outputs/klaviyo-migration/{account}/raw/ — written by
// scripts/klaviyo_migration/export_klaviyo.py, a SEPARATE repo from ClubOS).
// Hardcoded absolute path per the build instructions — safer than relative
// traversal off a worktree path that can move.
const WORKSPACE_ROOT = "/Users/danielmeyn/Desktop/AIOS/DanielMeynOS";
const EXPORT_ROOT = join(WORKSPACE_ROOT, "outputs", "klaviyo-migration");

// ─── Account → home workspace mapping ─────────────────────────────────────────
// Real org ids from shared/org-domains.ts WORKSPACE_DOMAINS:
//   1 christchurch-united (cufc) · 2 south-island-united (siu) · 3 mini-football-leagues (mfl)
//   4 united-sports-centre (usc) · 5 christchurch-international-cup (cic)
//   6 united-gymnastics (cugc) · 7 united-sports-group (usg) · 8 united-prints (prints)
type Account = "cufc" | "siu";
const ORG_CUFC = 1;
const ORG_SIU = 2;
const ORG_CIC = 5;
const ORG_USG = 7;
const ACCOUNT_HOME_ORG: Record<Account, number> = { cufc: ORG_CUFC, siu: ORG_SIU };

/**
 * Per-list overrides by name PREFIX (case-insensitive), applied regardless of
 * which Klaviyo account the list lives in — the SIU account accumulated some
 * lists that are really CUFC-academy or CIC audiences dumped there before
 * per-brand Klaviyo accounts existed.
 *
 * Mapping decisions (documented per the build brief):
 *   - 'CUFC' / 'Academy' prefix → org 1 (Christchurch United). The academy is
 *     a CUFC brand even when its Klaviyo list sits in the SIU account.
 *   - 'CIC' prefix → org 5 (Christchurch International Cup) — CIC has its own
 *     ClubOS workspace; a list literally named "CIC ..." is that tournament's
 *     audience, not SIU's or CUFC's.
 *   - 'Business Hub' prefix → org 7 (United Sports Group). The build brief
 *     grouped 'CIC'/'Business Hub' under one bucket ("the CIC/group org"),
 *     but the ClubOS Business Hub (sponsor/partner directory + QR — see
 *     memory project_business_hub.md) is an explicit CROSS-BRAND "group"
 *     feature, and org 7 is literally named united-sports-group / referred to
 *     elsewhere in this codebase as the "group workspace" (see CLAUDE.md's
 *     Proposal Tracker section). Routing "Business Hub" lists to CIC (org 5)
 *     instead of USG (org 7) would put a cross-club sponsor list inside one
 *     tournament's workspace, which reads wrong. This is the one judgment
 *     call in this file — a one-line edit to `overrideOrgForListName` below
 *     flips it back to ORG_CIC if Daniel intended the literal CIC workspace.
 *   - Anything else → the account's home org (logged as unmapped/default,
 *     not an error — most lists are exactly that).
 */
function overrideOrgForListName(name: string): number | null {
  const n = name.trim();
  if (/^cufc/i.test(n) || /^academy/i.test(n)) return ORG_CUFC;
  if (/^business hub/i.test(n)) return ORG_USG;
  if (/^cic/i.test(n)) return ORG_CIC;
  return null;
}

// ─── Consent / suppression vocab (mirrors server/marketing/ingest.ts) ────────
type Channel = "email" | "sms";
type SubState = "subscribed" | "unsubscribed" | "never";
type LegalBasis = "express" | "inferred" | "deemed" | "none" | "opted_out";
const SUB_RANK: Record<SubState, number> = { never: 1, subscribed: 2, unsubscribed: 3 };

// Klaviyo's documented suppression reason enum (export_klaviyo.py SUPPRESSION_REASONS)
// → ClubOS's mkt_suppression_reason enum (shared/schema.ts mktSuppressionReasonEnum).
type MktSuppressionReason = "manual" | "hard_bounce" | "complaint" | "unsub_prefs";
const SUPPRESSION_REASON_MAP: Record<string, MktSuppressionReason> = {
  USER_SUPPRESSED: "manual",
  HARD_BOUNCE: "hard_bounce",
  SPAM_COMPLAINT: "complaint",
  UNSUBSCRIBE: "unsub_prefs",
};
function mapSuppressionReason(raw: string | null | undefined): MktSuppressionReason {
  if (!raw) return "manual";
  return SUPPRESSION_REASON_MAP[raw.toUpperCase()] ?? "manual";
}
// A hard bounce or spam complaint is a strong deliverability signal — suppress
// it everywhere (global), on top of the brand-scope row. A manual suppression
// or preference-centre unsub is brand-specific only.
function isGlobalSuppressionReason(reason: MktSuppressionReason): boolean {
  return reason === "hard_bounce" || reason === "complaint";
}

/** Klaviyo consent → ClubOS's two-axis model. Klaviyo consent IS a real opt-in
 * event, so SUBSCRIBED maps to express (unlike ClubOS's other audience tables,
 * which default to inferred/never). */
function mapConsent(consent: string | null | undefined): { subState: SubState; legalBasis: LegalBasis } {
  if (consent === "SUBSCRIBED") return { subState: "subscribed", legalBasis: "express" };
  if (consent === "UNSUBSCRIBED") return { subState: "unsubscribed", legalBasis: "opted_out" };
  return { subState: "never", legalBasis: "inferred" }; // NEVER_SUBSCRIBED / missing / unknown
}

// ─── Email normalisation (mirrors ingest.ts's private normalizeEmail — not
// exported there, so copied verbatim rather than reached into). ─────────────
function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const e = raw.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return null;
  return e;
}

// ─── Transient-network retry (identical pattern to ingest.ts) ────────────────
function isTransientDbError(e: unknown): boolean {
  const msg = e instanceof Error ? `${(e as NodeJS.ErrnoException).code ?? ""} ${e.message}` : String(e);
  return /ETIMEDOUT|ECONNRESET|EPIPE|Connection terminated|timeout expired|ENOTFOUND|EAI_AGAIN/i.test(msg);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (isTransientDbError(e) && attempt < 5) {
        attempt++;
        const backoffMs = 1000 * 2 ** attempt;
        console.warn(`  [${label}] transient DB error (attempt ${attempt}/5), retrying in ${backoffMs / 1000}s…`);
        await sleep(backoffMs);
        continue;
      }
      throw e;
    }
  }
}

// ─── JSONL streaming ───────────────────────────────────────────────────────
async function* readJsonl<T = any>(path: string): AsyncGenerator<T> {
  if (!existsSync(path)) return;
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    try {
      yield JSON.parse(t) as T;
    } catch {
      // defensive — skip a malformed line rather than aborting the whole import
    }
  }
}
async function readJsonlArray<T = any>(path: string): Promise<T[]> {
  const out: T[] = [];
  for await (const row of readJsonl<T>(path)) out.push(row as T);
  return out;
}

// ─── Klaviyo export shapes (permissive — only the fields we read) ────────────
interface KlaviyoListJson { id: string; attributes?: { name?: string } }
interface KlaviyoListMemberJson { id: string; email?: string | null }
interface KlaviyoSuppressionEntry { reason?: string; timestamp?: string }
interface KlaviyoMarketingSub {
  consent?: string;
  consent_timestamp?: string;
  method_detail?: string;
  double_optin?: boolean;
  suppression?: KlaviyoSuppressionEntry[];
}
interface KlaviyoProfileJson {
  id: string;
  attributes?: {
    email?: string | null;
    phone_number?: string | null;
    first_name?: string | null;
    last_name?: string | null;
    properties?: Record<string, unknown>;
    subscriptions?: {
      email?: { marketing?: KlaviyoMarketingSub };
      sms?: { marketing?: KlaviyoMarketingSub };
    };
  };
  /** Only present on suppressed_profiles.jsonl rows — which reason-filtered pass found this row. */
  _suppression_reason_queried?: string;
}
interface KlaviyoTemplateJson { id: string; attributes?: { name?: string } }

// ─── Result accumulator ───────────────────────────────────────────────────
interface ImportResult {
  account: Account;
  dryRun: boolean;
  homeOrgId: number;
  orgsUsed: Set<number>;
  lists: { id: string; name: string; targetOrgId: number; overridden: boolean; klaviyoMembers: number }[];
  klaviyo: {
    profilesTotal: number;
    skippedNoEmail: number;
    subscribedEmail: number;
    unsubscribedEmail: number;
    subscribedSms: number;
    suppressedByReason: Record<string, number>;
    suppressedUniqueProfiles: number;
  };
  clubos: {
    profileRowsCreated: number;
    profileRowsUpdated: number;
    profileRowsWritten: number; // may exceed klaviyo profile count — multi-org membership is correct duplication, not a bug
    profilesRepresented: number; // distinct Klaviyo ids that got >=1 ClubOS row
  };
  consent: { emailRows: number; smsRows: number };
  suppressions: { created: number; consentDowngraded: number; byReason: Record<string, number> };
  listMembers: { linked: number; notFound: number };
  skipped: { segments: number; flowsCount: number; campaignsEmail: number; campaignsSms: number; templateNames: string[] };
}

function emptyResult(account: Account, dryRun: boolean): ImportResult {
  return {
    account, dryRun, homeOrgId: ACCOUNT_HOME_ORG[account], orgsUsed: new Set([ACCOUNT_HOME_ORG[account]]),
    lists: [],
    klaviyo: {
      profilesTotal: 0, skippedNoEmail: 0, subscribedEmail: 0, unsubscribedEmail: 0, subscribedSms: 0,
      suppressedByReason: {}, suppressedUniqueProfiles: 0,
    },
    clubos: { profileRowsCreated: 0, profileRowsUpdated: 0, profileRowsWritten: 0, profilesRepresented: 0 },
    consent: { emailRows: 0, smsRows: 0 },
    suppressions: { created: 0, consentDowngraded: 0, byReason: {} },
    listMembers: { linked: 0, notFound: 0 },
    skipped: { segments: 0, flowsCount: 0, campaignsEmail: 0, campaignsSms: 0, templateNames: [] },
  };
}

// ─── Consent seeding (mirrors ingest.ts's seedConsent — same rank rule) ──────
async function seedConsent(
  profileId: number, channel: Channel, subState: SubState, legalBasis: LegalBasis,
  source: string, consentAt: Date | null, methodDetail?: string | null, doubleOptin?: boolean,
): Promise<"inserted" | "updated" | "skipped"> {
  return withRetry(`consent:${profileId}:${channel}`, async () => {
    const [existing] = await db
      .select({ id: mktConsent.id, subState: mktConsent.subState })
      .from(mktConsent)
      .where(and(eq(mktConsent.profileId, profileId), eq(mktConsent.channel, channel)))
      .limit(1);

    if (!existing) {
      await db.insert(mktConsent).values({
        profileId, channel, subState, legalBasis,
        canReceive: subState === "subscribed", source, consentAt: consentAt ?? new Date(),
        methodDetail: methodDetail ?? null, doubleOptin: !!doubleOptin,
      });
      return "inserted";
    }
    // Never downgrade (subscribed/express not overwritten by never/inferred);
    // an unsubscribe/opt-out (rank 3) ALWAYS wins — identical rule to ingest.ts.
    if (SUB_RANK[subState] > SUB_RANK[existing.subState as SubState]) {
      await db.update(mktConsent).set({
        subState, legalBasis, canReceive: subState === "subscribed", source, updatedAt: new Date(),
      }).where(eq(mktConsent.id, existing.id));
      return "updated";
    }
    return "skipped";
  });
}

// ─── Profile upsert (mirrors ingest.ts's processCandidate, per-org) ──────────
interface ProfileCandidate {
  email: string; // normalized, lowercased
  phoneRaw: string | null;
  firstName: string | null;
  lastName: string | null;
  klaviyoId: string;
  account: Account;
  klaviyoProps: Record<string, unknown>;
}

function mergeProfileProps(
  existing: Record<string, unknown> | null,
  cand: ProfileCandidate,
  phoneRaw: string | null,
  hasE164: boolean,
): Record<string, unknown> {
  const p: Record<string, unknown> = { ...(existing || {}) };
  const sources = new Set<string>(Array.isArray(p.sources) ? (p.sources as string[]) : []);
  sources.add(`klaviyo:${cand.account}`);
  p.sources = Array.from(sources);
  if (!hasE164 && phoneRaw && !p.phone_raw) p.phone_raw = phoneRaw;

  // Keep klaviyo profile id per-account (a person can legitimately exist in
  // BOTH the cufc and siu Klaviyo accounts — e.g. shared family email across
  // brands); a flat props.klaviyo_id string would let the second account's
  // import silently clobber the first's id. Object keyed by account instead.
  const existingIds = p.klaviyo_id && typeof p.klaviyo_id === "object" ? { ...(p.klaviyo_id as Record<string, string>) } : {};
  existingIds[cand.account] = cand.klaviyoId;
  p.klaviyo_id = existingIds;

  if (cand.klaviyoProps && Object.keys(cand.klaviyoProps).length) {
    const existingKlaviyoProps = p.klaviyo_props && typeof p.klaviyo_props === "object" ? { ...(p.klaviyo_props as Record<string, unknown>) } : {};
    p.klaviyo_props = { ...existingKlaviyoProps, [cand.account]: cand.klaviyoProps };
  }
  return p;
}

async function upsertProfile(orgId: number, cand: ProfileCandidate, dryRun: boolean): Promise<{ id: number | null; created: boolean }> {
  return withRetry(`profile:${orgId}:${cand.email}`, async () => {
    const { e164, raw: phoneRaw } = normalizeNzPhone(cand.phoneRaw);

    const [existing] = await db
      .select({ id: mktProfiles.id, firstName: mktProfiles.firstName, lastName: mktProfiles.lastName, phoneE164: mktProfiles.phoneE164, props: mktProfiles.props })
      .from(mktProfiles)
      .where(and(eq(mktProfiles.workspaceId, orgId), sql`lower(${mktProfiles.email}) = ${cand.email}`))
      .limit(1);

    // Dry run: read-only existence check for an accurate created/updated
    // projection (identical limitation to ingest.ts — a not-yet-created
    // profile has no id, so consent/suppression can't be simulated here).
    if (dryRun) return { id: existing?.id ?? null, created: !existing };

    // Shared-phone guard — identical to ingest.ts: (workspace_id, phone_e164)
    // is unique (one profile owns a number for SMS); a later profile carries
    // the number in props.shared_phone instead of failing the insert.
    let phoneForRow = e164;
    if (phoneForRow) {
      const [phoneOwner] = await db
        .select({ id: mktProfiles.id })
        .from(mktProfiles)
        .where(and(eq(mktProfiles.workspaceId, orgId), eq(mktProfiles.phoneE164, phoneForRow)))
        .limit(1);
      if (phoneOwner && (!existing || phoneOwner.id !== existing.id)) phoneForRow = null;
    }

    if (existing) {
      const props = mergeProfileProps(existing.props as Record<string, unknown> | null, cand, phoneRaw, !!(existing.phoneE164 ?? phoneForRow));
      if (e164 && !phoneForRow && !existing.phoneE164 && !props.shared_phone) props.shared_phone = e164;
      await db.update(mktProfiles).set({
        firstName: existing.firstName ?? cand.firstName, // never overwrite a non-null with null
        lastName: existing.lastName ?? cand.lastName,
        phoneE164: existing.phoneE164 ?? phoneForRow,
        props,
        updatedAt: new Date(),
      }).where(eq(mktProfiles.id, existing.id));
      return { id: existing.id, created: false };
    }

    const props = mergeProfileProps(null, cand, phoneRaw, !!phoneForRow);
    if (e164 && !phoneForRow) props.shared_phone = e164;
    const [row] = await db.insert(mktProfiles).values({
      workspaceId: orgId, email: cand.email, phoneE164: phoneForRow,
      firstName: cand.firstName, lastName: cand.lastName, props,
    }).returning({ id: mktProfiles.id });
    return { id: row.id, created: true };
  });
}

// ─── Suppression (mirrors ingest.ts's importSuppressions) ────────────────────
async function recordSuppression(
  orgId: number, account: Account, email: string, reasonRaw: string | null | undefined,
  dryRun: boolean, result: ImportResult,
): Promise<void> {
  const reason = mapSuppressionReason(reasonRaw);
  if (dryRun) return; // Klaviyo-side counts already carry the "would-be" projection

  const brandKey = BRAND_KEY_BY_ORG[orgId] ?? String(orgId);
  await withRetry(`suppression:${orgId}:${email}`, async () => {
    const inserted = await db.insert(mktSuppressions).values({
      email, channel: "email", scope: "brand", brandKey, reason,
      source: `klaviyo:${account}:${reason}`,
    }).onConflictDoNothing().returning({ id: mktSuppressions.id });
    if (inserted.length) {
      result.suppressions.created++;
      result.suppressions.byReason[reason] = (result.suppressions.byReason[reason] ?? 0) + 1;
    }

    if (isGlobalSuppressionReason(reason)) {
      const insertedGlobal = await db.insert(mktSuppressions).values({
        email, channel: "email", scope: "global", brandKey: null, reason,
        source: `klaviyo:${account}:${reason}`,
      }).onConflictDoNothing().returning({ id: mktSuppressions.id });
      if (insertedGlobal.length) result.suppressions.created++;
    }

    // Downgrade this org's profile row to unsubscribed/opted_out — always wins
    // (rank rule), exactly like ingest.ts's importSuppressions.
    const [profile] = await db
      .select({ id: mktProfiles.id })
      .from(mktProfiles)
      .where(and(eq(mktProfiles.workspaceId, orgId), sql`lower(${mktProfiles.email}) = ${email}`))
      .limit(1);
    if (profile) {
      const verdict = await seedConsent(profile.id, "email", "unsubscribed", "opted_out", `klaviyo:${account}:${reason}`, null);
      if (verdict !== "skipped") result.suppressions.consentDowngraded++;
    }
  });
}

// ─── Lists / list membership ──────────────────────────────────────────────
interface ListInfo { id: string; name: string; targetOrgId: number; overridden: boolean }

async function loadLists(rawDir: string, homeOrgId: number): Promise<ListInfo[]> {
  const rows = await readJsonlArray<KlaviyoListJson>(join(rawDir, "lists.jsonl"));
  return rows.map((r) => {
    const name = (r.attributes?.name || `Unnamed list ${r.id}`).trim();
    const override = overrideOrgForListName(name);
    return { id: r.id, name, targetOrgId: override ?? homeOrgId, overridden: override != null };
  });
}

async function loadListMembership(rawDir: string, lists: ListInfo[]): Promise<{
  profileOrgSets: Map<string, Set<number>>;
  listMembersRaw: Map<string, { klaviyoId: string; email: string | null }[]>;
}> {
  const profileOrgSets = new Map<string, Set<number>>();
  const listMembersRaw = new Map<string, { klaviyoId: string; email: string | null }[]>();
  for (const list of lists) {
    const path = join(rawDir, "list_members", `${list.id}.jsonl`);
    const members: { klaviyoId: string; email: string | null }[] = [];
    for await (const m of readJsonl<KlaviyoListMemberJson>(path)) {
      members.push({ klaviyoId: m.id, email: m.email ?? null });
      const set = profileOrgSets.get(m.id) ?? new Set<number>();
      set.add(list.targetOrgId);
      profileOrgSets.set(m.id, set);
    }
    listMembersRaw.set(list.id, members);
  }
  return { profileOrgSets, listMembersRaw };
}

/** Idempotent: find-or-create a `Klaviyo: {name}` list in the target workspace. */
async function findOrCreateList(workspaceId: number, name: string): Promise<number> {
  const fullName = `Klaviyo: ${name}`;
  return withRetry(`list:${workspaceId}:${fullName}`, async () => {
    const [existing] = await db
      .select({ id: mktLists.id })
      .from(mktLists)
      .where(and(eq(mktLists.workspaceId, workspaceId), eq(mktLists.name, fullName)))
      .limit(1);
    if (existing) return existing.id;
    const [row] = await db.insert(mktLists).values({ workspaceId, name: fullName }).returning({ id: mktLists.id });
    return row.id;
  });
}

// ─── ClubOS post-import verification queries (real run only) ─────────────────
async function clubosPostImportStats(account: Account, orgIds: number[]): Promise<{
  distinctProfilesRepresented: number;
  subscribedEmail: number;
  unsubscribedEmail: number;
  subscribedSms: number;
  suppressedByReason: Record<string, number>;
  suppressedUniqueEmails: number;
}> {
  const sourcesJson = JSON.stringify({ sources: [`klaviyo:${account}`] });

  const distinctRow: any = await db.execute(sql`
    SELECT count(DISTINCT props->'klaviyo_id'->>${account})::int AS n
    FROM mkt_profiles
    WHERE workspace_id = ANY(${orgIds}) AND props @> ${sourcesJson}::jsonb
  `);
  const distinctProfilesRepresented = distinctRow.rows?.[0]?.n ?? 0;

  const consentRow: any = await db.execute(sql`
    SELECT c.channel, c.sub_state, count(DISTINCT p.props->'klaviyo_id'->>${account})::int AS n
    FROM mkt_consent c
    JOIN mkt_profiles p ON p.id = c.profile_id
    WHERE p.workspace_id = ANY(${orgIds}) AND p.props @> ${sourcesJson}::jsonb
    GROUP BY c.channel, c.sub_state
  `);
  let subscribedEmail = 0, unsubscribedEmail = 0, subscribedSms = 0;
  for (const r of consentRow.rows ?? []) {
    if (r.channel === "email" && r.sub_state === "subscribed") subscribedEmail = r.n;
    if (r.channel === "email" && r.sub_state === "unsubscribed") unsubscribedEmail = r.n;
    if (r.channel === "sms" && r.sub_state === "subscribed") subscribedSms = r.n;
  }

  // Suppressions: distinct email per reason (dedupes the per-org brand rows a
  // multi-workspace profile produces — one Klaviyo profile, one count).
  const suppRows = await db
    .select({ reason: mktSuppressions.reason, email: mktSuppressions.email })
    .from(mktSuppressions)
    .where(sql`${mktSuppressions.source} LIKE ${`klaviyo:${account}:%`}`);
  const suppressedByReason: Record<string, number> = {};
  const byReasonEmails: Record<string, Set<string>> = {};
  const allEmails = new Set<string>();
  for (const s of suppRows) {
    if (!s.email) continue;
    allEmails.add(s.email);
    const set = byReasonEmails[s.reason] ?? new Set<string>();
    set.add(s.email);
    byReasonEmails[s.reason] = set;
  }
  for (const [reason, set] of Object.entries(byReasonEmails)) suppressedByReason[reason] = set.size;

  return { distinctProfilesRepresented, subscribedEmail, unsubscribedEmail, subscribedSms, suppressedByReason, suppressedUniqueEmails: allEmails.size };
}

async function clubosListMemberCount(listId: number): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(mktListMembers).where(eq(mktListMembers.listId, listId));
  return row?.n ?? 0;
}

// ─── Orchestrator ──────────────────────────────────────────────────────────
export async function runImport(account: Account, dryRun: boolean): Promise<ImportResult> {
  const rawDir = join(EXPORT_ROOT, account, "raw");
  if (!existsSync(rawDir)) {
    console.error(`\n❌ No Klaviyo export found for '${account}' at:\n   ${rawDir}`);
    console.error(`   Run the export first:\n   python3 scripts/klaviyo_migration/export_klaviyo.py --account ${account}\n`);
    process.exit(1);
  }

  const result = emptyResult(account, dryRun);
  const homeOrgId = result.homeOrgId;

  // ── 1. Lists + membership (built FIRST so profile→org sets exist before
  // profiles.jsonl streams through) ──
  console.log(`-> Loading lists + list membership for '${account}'...`);
  const lists = await loadLists(rawDir, homeOrgId);
  const { profileOrgSets, listMembersRaw } = await loadListMembership(rawDir, lists);
  for (const list of lists) {
    const memberCount = listMembersRaw.get(list.id)?.length ?? 0;
    result.lists.push({ ...list, klaviyoMembers: memberCount });
    result.orgsUsed.add(list.targetOrgId);
    if (list.overridden) {
      console.log(`   list "${list.name}" (${memberCount} members) → org ${list.targetOrgId} (name-pattern override)`);
    } else {
      console.warn(`   ⚠️  list "${list.name}" (${memberCount} members) unmapped → defaulting to home org ${homeOrgId}`);
    }
  }

  // ── 2 + 3. Profiles + consent + per-profile suppression entries ──
  console.log(`-> Importing profiles...`);
  const seenKlaviyoIds = new Set<string>();
  const profileIdByOrgEmail = new Map<string, number>(); // `${orgId}:${email}` -> clubos profile id

  for await (const row of readJsonl<KlaviyoProfileJson>(join(rawDir, "profiles.jsonl"))) {
    result.klaviyo.profilesTotal++;
    const attrs = row.attributes || {};
    const email = normalizeEmail(attrs.email);
    if (!email) { result.klaviyo.skippedNoEmail++; continue; }

    // Array.from up front — plain arrays iterate fine under this repo's tsc
    // target without --downlevelIteration; iterating a Set directly does not.
    const orgSet = Array.from(profileOrgSets.get(row.id) ?? new Set<number>([homeOrgId]));
    for (const o of orgSet) result.orgsUsed.add(o);

    const emailSub = attrs.subscriptions?.email?.marketing;
    const smsSub = attrs.subscriptions?.sms?.marketing;
    const emailMapped = mapConsent(emailSub?.consent);
    const smsMapped = mapConsent(smsSub?.consent);
    const emailConsentAt = emailSub?.consent_timestamp ? new Date(emailSub.consent_timestamp) : null;
    const smsConsentAt = smsSub?.consent_timestamp ? new Date(smsSub.consent_timestamp) : null;

    if (!seenKlaviyoIds.has(row.id)) {
      seenKlaviyoIds.add(row.id);
      if (emailMapped.subState === "subscribed") result.klaviyo.subscribedEmail++;
      if (emailMapped.subState === "unsubscribed") result.klaviyo.unsubscribedEmail++;
      if (smsMapped.subState === "subscribed") result.klaviyo.subscribedSms++;
    }

    let representedInClubos = false;
    for (const orgId of orgSet) {
      const cand: ProfileCandidate = {
        email, phoneRaw: attrs.phone_number ?? null, firstName: attrs.first_name ?? null, lastName: attrs.last_name ?? null,
        klaviyoId: row.id, account, klaviyoProps: attrs.properties ?? {},
      };
      const { id, created } = await upsertProfile(orgId, cand, dryRun);
      result.clubos.profileRowsWritten++;
      if (created) result.clubos.profileRowsCreated++; else result.clubos.profileRowsUpdated++;
      representedInClubos = true;

      if (dryRun || id == null) continue; // no id yet — consent/suppression can't be simulated (matches ingest.ts's own dry-run limitation)

      profileIdByOrgEmail.set(`${orgId}:${email}`, id);

      const emailVerdict = await seedConsent(
        id, "email", emailMapped.subState, emailMapped.legalBasis,
        `klaviyo:${account}:${emailMapped.subState}`, emailConsentAt, emailSub?.method_detail, emailSub?.double_optin,
      );
      if (emailVerdict !== "skipped") result.consent.emailRows++;

      if (attrs.phone_number) {
        const smsVerdict = await seedConsent(
          id, "sms", smsMapped.subState, smsMapped.legalBasis,
          `klaviyo:${account}:${smsMapped.subState}`, smsConsentAt, smsSub?.method_detail, smsSub?.double_optin,
        );
        if (smsVerdict !== "skipped") result.consent.smsRows++;
      }

      const suppressionEntries = emailSub?.suppression ?? [];
      for (const s of suppressionEntries) {
        await recordSuppression(orgId, account, email, s.reason, dryRun, result);
      }
    }
    if (representedInClubos) result.clubos.profilesRepresented++;
  }

  // ── 4. suppressed_profiles.jsonl — one row per (profile, reason-pass) ──
  console.log(`-> Importing suppressed_profiles.jsonl...`);
  const suppressedSeenPerReason = new Set<string>(); // `${klaviyoId}:${reason}` — file already dedupes per-reason-pass, this is defensive
  const suppressedUniqueKlaviyoIds = new Set<string>();
  for await (const row of readJsonl<KlaviyoProfileJson>(join(rawDir, "suppressed_profiles.jsonl"))) {
    const attrs = row.attributes || {};
    const email = normalizeEmail(attrs.email);
    const reasonRaw = row._suppression_reason_queried ?? null;
    const reason = mapSuppressionReason(reasonRaw);
    if (!email) continue;

    suppressedUniqueKlaviyoIds.add(row.id);
    const dedupeKey = `${row.id}:${reason}`;
    if (!suppressedSeenPerReason.has(dedupeKey)) {
      suppressedSeenPerReason.add(dedupeKey);
      result.klaviyo.suppressedByReason[reason] = (result.klaviyo.suppressedByReason[reason] ?? 0) + 1;
    }
    if (dryRun) continue;

    const orgSet = Array.from(profileOrgSets.get(row.id) ?? new Set<number>([homeOrgId]));
    for (const orgId of orgSet) {
      result.orgsUsed.add(orgId);
      // Ensure the profile row exists (suppressed_profiles.jsonl should be a
      // subset of profiles.jsonl, but defensively upsert a minimal row if not).
      if (!profileIdByOrgEmail.has(`${orgId}:${email}`)) {
        const cand: ProfileCandidate = {
          email, phoneRaw: attrs.phone_number ?? null, firstName: attrs.first_name ?? null, lastName: attrs.last_name ?? null,
          klaviyoId: row.id, account, klaviyoProps: attrs.properties ?? {},
        };
        const { id } = await upsertProfile(orgId, cand, false);
        if (id != null) profileIdByOrgEmail.set(`${orgId}:${email}`, id);
      }
      await recordSuppression(orgId, account, email, reasonRaw, dryRun, result);
    }
  }
  result.klaviyo.suppressedUniqueProfiles = suppressedUniqueKlaviyoIds.size;

  // ── 5. Lists → mkt_lists + mkt_list_members (now that profiles exist) ──
  console.log(`-> Creating lists + list membership...`);
  for (const list of lists) {
    const members = listMembersRaw.get(list.id) ?? [];
    if (dryRun) {
      // Would-be projection: every member whose email resolves to a profile we
      // saw in profiles.jsonl for this list's target org.
      for (const m of members) {
        const email = normalizeEmail(m.email);
        if (email) result.listMembers.linked++; else result.listMembers.notFound++;
      }
      continue;
    }
    const listId = await findOrCreateList(list.targetOrgId, list.name);
    for (const m of members) {
      const email = normalizeEmail(m.email);
      const profileId = email ? profileIdByOrgEmail.get(`${list.targetOrgId}:${email}`) : undefined;
      if (!profileId) { result.listMembers.notFound++; continue; }
      await withRetry(`list_member:${listId}:${profileId}`, async () => {
        await db.insert(mktListMembers).values({
          listId, profileId, source: `klaviyo:${account}:list`,
        }).onConflictDoNothing();
      });
      result.listMembers.linked++;
    }
  }

  // ── 6. Skip: segments (0) / flows (0) / campaigns history / templates ──
  result.skipped.segments = (await readJsonlArray(join(rawDir, "segments.jsonl"))).length;
  result.skipped.flowsCount = (await readJsonlArray(join(rawDir, "flows.jsonl"))).length;
  result.skipped.campaignsEmail = (await readJsonlArray(join(rawDir, "campaigns_email.jsonl"))).length;
  result.skipped.campaignsSms = (await readJsonlArray(join(rawDir, "campaigns_sms.jsonl"))).length;
  const templates = await readJsonlArray<KlaviyoTemplateJson>(join(rawDir, "templates.jsonl"));
  result.skipped.templateNames = templates.map((t) => t.attributes?.name || t.id);

  return result;
}

// ─── Report ────────────────────────────────────────────────────────────────
function parityLine(label: string, klaviyo: number, clubos: number): string {
  const verdict = klaviyo === clubos ? "OK" : "MISMATCH";
  return `| ${label} | ${klaviyo} | ${clubos} | **${verdict}** |`;
}

async function buildAndWriteReport(result: ImportResult): Promise<string> {
  const { account, dryRun } = result;
  const lines: string[] = [];
  lines.push(`# Klaviyo → ClubOS Import Report — ${account} (${dryRun ? "DRY RUN — projection, not DB-verified" : "LIVE"})`);
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("This report is what the \"safe to cancel Klaviyo\" decision reads. Every");
  lines.push("PARITY row should read OK before that call is made.");
  lines.push("");

  lines.push("## Parity summary");
  lines.push("");
  lines.push("| Metric | Klaviyo (export) | ClubOS (import) | Parity |");
  lines.push("|---|---|---|---|");

  let clubosSubscribedEmail = result.klaviyo.subscribedEmail;
  let clubosUnsubscribedEmail = result.klaviyo.unsubscribedEmail;
  let clubosSubscribedSms = result.klaviyo.subscribedSms;
  let clubosSuppressedByReason: Record<string, number> = { ...result.klaviyo.suppressedByReason };
  let clubosSuppressedUnique = result.klaviyo.suppressedUniqueProfiles;
  let clubosProfilesRepresented = result.clubos.profilesRepresented;

  if (!dryRun) {
    const stats = await clubosPostImportStats(account, Array.from(result.orgsUsed));
    clubosProfilesRepresented = stats.distinctProfilesRepresented;
    clubosSubscribedEmail = stats.subscribedEmail;
    clubosUnsubscribedEmail = stats.unsubscribedEmail;
    clubosSubscribedSms = stats.subscribedSms;
    clubosSuppressedByReason = stats.suppressedByReason;
    clubosSuppressedUnique = stats.suppressedUniqueEmails;
  }

  const klaviyoProfilesWithEmail = result.klaviyo.profilesTotal - result.klaviyo.skippedNoEmail;
  lines.push(parityLine("Profiles with an email address", klaviyoProfilesWithEmail, clubosProfilesRepresented));
  lines.push(parityLine("Subscribed — email marketing", result.klaviyo.subscribedEmail, clubosSubscribedEmail));
  lines.push(parityLine("Unsubscribed — email marketing", result.klaviyo.unsubscribedEmail, clubosUnsubscribedEmail));
  lines.push(parityLine("Subscribed — SMS marketing (bonus, not required)", result.klaviyo.subscribedSms, clubosSubscribedSms));

  for (const reason of ["manual", "hard_bounce", "complaint", "unsub_prefs"]) {
    const kl = result.klaviyo.suppressedByReason[reason] ?? 0;
    const cl = clubosSuppressedByReason[reason] ?? 0;
    if (kl || cl) lines.push(parityLine(`Suppressed — ${reason}`, kl, cl));
  }
  lines.push(parityLine("Suppressed — unique profiles", result.klaviyo.suppressedUniqueProfiles, clubosSuppressedUnique));
  lines.push("");
  lines.push(`_Informational (not a parity check — expected to differ by design): ClubOS profile rows written across all mapped workspaces = **${result.clubos.profileRowsWritten}** (${result.clubos.profileRowsCreated} created, ${result.clubos.profileRowsUpdated} updated). A profile that's a member of lists mapped to 2 different orgs correctly gets 2 rows — see the per-workspace model in server/marketing/README.md._`);
  lines.push("");

  lines.push("## Lists");
  lines.push("");
  lines.push("| Klaviyo list | → workspace org | Klaviyo members | ClubOS members | Parity |");
  lines.push("|---|---|---|---|---|");
  for (const list of result.lists) {
    let clubosCount = list.klaviyoMembers; // dry-run projection default
    if (!dryRun) {
      const listId = await findOrCreateList(list.targetOrgId, list.name); // idempotent lookup, no-op if already created this run
      clubosCount = await clubosListMemberCount(listId);
    }
    const verdict = list.klaviyoMembers === clubosCount ? "OK" : "MISMATCH";
    lines.push(`| ${list.name}${list.overridden ? " *(override)*" : ""} | ${list.targetOrgId} | ${list.klaviyoMembers} | ${clubosCount} | **${verdict}** |`);
  }
  if (result.listMembers.notFound > 0) {
    lines.push("");
    lines.push(`⚠️ ${result.listMembers.notFound} list membership row(s) could not be matched to an imported profile (missing/unparseable email in list_members) — not fatal, just unlinked.`);
  }
  lines.push("");

  lines.push("## Skipped (not migrated — reasons)");
  lines.push("");
  lines.push(`- **Segments**: ${result.skipped.segments} found on disk (segments.jsonl) — 0 expected on both accounts; dynamic segments get rebuilt as native \`mkt_segments\` once the send engine's segment builder ships.`);
  lines.push(`- **Flows**: ${result.skipped.flowsCount} found on disk (flows.jsonl) — 0 expected; automation is rebuilt natively as \`mkt_flows\` (Phase C), not migrated.`);
  lines.push(`- **Campaign history**: ${result.skipped.campaignsEmail} email + ${result.skipped.campaignsSms} SMS campaigns archived on disk (raw/campaigns_email.jsonl, raw/campaigns_sms.jsonl) — historical sends aren't actionable in ClubOS's model, kept as a read-only archive only.`);
  if (result.skipped.templateNames.length) {
    lines.push(`- **Templates**: ${result.skipped.templateNames.length} found on disk (raw/templates.jsonl), recreated BY HAND in the new campaign builder (not auto-imported — Klaviyo's block format doesn't map to ours):`);
    for (const name of result.skipped.templateNames) lines.push(`  - ${name}`);
  } else {
    lines.push("- **Templates**: none found on disk (raw/templates.jsonl missing or empty).");
  }
  lines.push("");

  const reportDir = join(EXPORT_ROOT, account);
  mkdirSync(reportDir, { recursive: true });
  const reportPath = join(reportDir, "IMPORT-REPORT.md");
  writeFileSync(reportPath, lines.join("\n") + "\n", "utf8");
  return reportPath;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  (async () => {
    const args = process.argv.slice(2);
    const accountFlagIdx = args.indexOf("--account");
    const accountArg = accountFlagIdx !== -1 ? args[accountFlagIdx + 1] : undefined;
    const dryRun = args.includes("--dry-run");

    if (accountArg !== "cufc" && accountArg !== "siu") {
      console.error("Usage: npx tsx --env-file=.env script/import-klaviyo.ts --account cufc|siu [--dry-run]");
      process.exit(1);
    }
    const account: Account = accountArg;

    const result = await runImport(account, dryRun);

    console.log(`\n${dryRun ? "DRY RUN — " : ""}Klaviyo import complete for '${account}'.`);
    console.log("Klaviyo (export):", result.klaviyo);
    console.log("ClubOS (this run):", result.clubos);
    console.log("Consent seeded:", result.consent);
    console.log("Suppressions:", result.suppressions);
    console.log("List members:", result.listMembers);
    console.log("Skipped:", { ...result.skipped, templateNames: `${result.skipped.templateNames.length} names — see report` });

    const reportPath = await buildAndWriteReport(result);
    console.log(`\n📄 Full parity report written to: ${reportPath}`);
    process.exit(0);
  })().catch((e) => {
    console.error("❌ Klaviyo import failed", e);
    process.exit(1);
  });
}
