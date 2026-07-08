/**
 * Marketing Suite — profile ingest ETL + consent seeding (Phase A).
 *
 * Builds the "one canonical audience" the four legacy mailers never had:
 * idempotently upserts every existing audience table into `mkt_profiles`
 * (deduped on (workspace_id, lower(email))), seeds conservative `mkt_consent`
 * (two axes per channel), and imports the legacy `email_unsubscribes` list into
 * `mkt_suppressions` — downgrading those profiles' email consent to opted-out.
 *
 * Idempotent + additive: safe to run repeatedly. Always DRY-RUN first
 * (see server/marketing/README.md). Reads DATABASE_URL via the shared `db`.
 *
 *   npx tsx --env-file=.env server/marketing/ingest.ts --dry-run
 *   npx tsx --env-file=.env server/marketing/ingest.ts            # writes
 *   npx tsx --env-file=.env server/marketing/ingest.ts --workspace 5
 */

import { and, eq, sql } from "drizzle-orm";
import { fileURLToPath } from "url";
import { db } from "../db";
import {
  mktProfiles, mktConsent, mktSuppressions,
  contacts, predictorEntrants, cicInterestRegistrations, cic7sRegistrations,
  cugcRegistrations, members, appUsers, leagueTeams, splitMembers, splitSessions,
  clubs, tournamentTeams, tournaments, tournamentStaff, volunteers, cicVendors,
  sponsorshipProspects, printContacts, emailUnsubscribes,
} from "@shared/schema";

// ─── Workspace / brand mapping ───────────────────────────────────────────────
// A profile's workspace = the source row's organizationId, EXCEPT `contacts`,
// which has no org column — it is effectively the CUFC CRM, so its guardians +
// adults belong to the Christchurch United / camps workspace (org 1). Confirmed
// against shared/org-domains.ts WORKSPACE_DOMAINS (christchurch-united → orgId 1).
const CONTACTS_WORKSPACE_ID = 1;
const PRINTS_WORKSPACE_ID = 8; // print_contacts.organizationId is nullable → default to united-prints (org 8)

// brand_key per org id — the scope key for brand-level suppressions
// (shared/org-domains.ts order). Sponsors live on their own row's organizationId.
const BRAND_KEY_BY_ORG: Record<number, string> = {
  1: "cufc", 2: "siu", 3: "mfl", 4: "usc", 5: "cic", 6: "cugc", 7: "usg", 8: "prints",
};

// ─── Types ───────────────────────────────────────────────────────────────────
type Channel = "email" | "sms";
type SubState = "subscribed" | "unsubscribed" | "never";
type LegalBasis = "express" | "inferred" | "deemed" | "none" | "opted_out";

const SUB_RANK: Record<SubState, number> = { never: 1, subscribed: 2, unsubscribed: 3 };

export interface SourceCounts { scanned: number; created: number; updated: number; skippedNoEmail: number }
export interface IngestResult {
  dryRun: boolean;
  workspaceFilter: number | null;
  sources: Record<string, SourceCounts>;
  profilesTotal: SourceCounts;
  consentSeeded: { emailRows: number; smsRows: number };
  suppressions: { scanned: number; created: number; consentDowngraded: number };
}

interface Candidate {
  workspaceId: number;
  email: string | null;
  phoneRaw: string | null;
  firstName: string | null;
  lastName: string | null;
  source: string;
  /** email consent override; undefined ⇒ conservative never/inferred */
  emailConsent?: "express" | "opted_out";
  consentSource?: string;
}

// ─── Normalisation helpers ───────────────────────────────────────────────────
function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const e = raw.trim().toLowerCase();
  // deliberately conservative — one @, a dot in the domain, no whitespace.
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return null;
  return e;
}

/** NZ-aware E.164 normaliser. Non-parseable ⇒ e164 null (raw kept for props). */
export function normalizeNzPhone(raw: string | null | undefined): { e164: string | null; raw: string | null } {
  if (!raw) return { e164: null, raw: null };
  const original = raw.trim();
  if (!original) return { e164: null, raw: null };
  let s = original.replace(/[\s\-().]/g, "");
  if (s.startsWith("00")) s = "+" + s.slice(2); // 00 international prefix → +
  if (s.startsWith("+")) {
    const digits = s.slice(1).replace(/\D/g, "");
    return digits.length >= 8 && digits.length <= 15
      ? { e164: "+" + digits, raw: original }
      : { e164: null, raw: original };
  }
  const digits = s.replace(/\D/g, "");
  if (digits.startsWith("64")) {
    const rest = digits.slice(2);
    return rest.length >= 6 && rest.length <= 13 ? { e164: "+64" + rest, raw: original } : { e164: null, raw: original };
  }
  if (digits.startsWith("0")) {
    // NZ national format: 021… → +6421…, 03… → +643…
    const rest = digits.slice(1);
    return rest.length >= 7 && rest.length <= 12 ? { e164: "+64" + rest, raw: original } : { e164: null, raw: original };
  }
  // A bare number with no country code / leading zero — can't safely assume NZ.
  return { e164: null, raw: original };
}

function splitName(full: string | null | undefined): { firstName: string | null; lastName: string | null } {
  if (!full) return { firstName: null, lastName: null };
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: null, lastName: null };
  if (parts.length === 1) return { firstName: parts[0], lastName: null };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

/** Split a contactEmail field that can hold "a@x / b@y, c@z" into individual addresses. */
function splitEmails(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw.split(/[/,;]+/).map((s) => s.trim()).filter(Boolean);
}

function emptyCounts(): SourceCounts { return { scanned: 0, created: 0, updated: 0, skippedNoEmail: 0 }; }

// ─── Core upsert + consent ───────────────────────────────────────────────────
async function seedConsent(
  profileId: number,
  channel: Channel,
  subState: SubState,
  legalBasis: LegalBasis,
  source: string,
  dryRun: boolean,
): Promise<"inserted" | "updated" | "skipped"> {
  const [existing] = await db
    .select({ id: mktConsent.id, subState: mktConsent.subState })
    .from(mktConsent)
    .where(and(eq(mktConsent.profileId, profileId), eq(mktConsent.channel, channel)))
    .limit(1);

  if (!existing) {
    if (!dryRun) {
      await db.insert(mktConsent).values({
        profileId, channel, subState, legalBasis,
        canReceive: subState === "subscribed", source, consentAt: new Date(),
      });
    }
    return "inserted";
  }
  // Never downgrade (subscribed/express not overwritten by never/inferred);
  // an unsubscribe/opt-out (rank 3) ALWAYS wins.
  if (SUB_RANK[subState] > SUB_RANK[existing.subState as SubState]) {
    if (!dryRun) {
      await db.update(mktConsent).set({
        subState, legalBasis, canReceive: subState === "subscribed", source, updatedAt: new Date(),
      }).where(eq(mktConsent.id, existing.id));
    }
    return "updated";
  }
  return "skipped";
}

async function processCandidate(
  cand: Candidate,
  counts: SourceCounts,
  result: IngestResult,
  opts: { dryRun: boolean; workspaceId: number | null },
  seen: Set<string>,
): Promise<void> {
  if (opts.workspaceId != null && cand.workspaceId !== opts.workspaceId) return;

  counts.scanned++;
  const email = normalizeEmail(cand.email);
  if (!email) {
    counts.skippedNoEmail++;
    result.profilesTotal.skippedNoEmail++;
    return;
  }

  const { e164, raw: phoneRaw } = normalizeNzPhone(cand.phoneRaw);
  const key = `${cand.workspaceId}:${email}`;

  const [existing] = await db
    .select({ id: mktProfiles.id, firstName: mktProfiles.firstName, lastName: mktProfiles.lastName, phoneE164: mktProfiles.phoneE164, props: mktProfiles.props })
    .from(mktProfiles)
    .where(and(eq(mktProfiles.workspaceId, cand.workspaceId), sql`lower(${mktProfiles.email}) = ${email}`))
    .limit(1);

  // Dry run: report profile-level counts only (new profiles have no id yet, so
  // consent/suppression writes can't be simulated with real ids — see README).
  if (opts.dryRun) {
    if (existing || seen.has(key)) { counts.updated++; result.profilesTotal.updated++; }
    else { counts.created++; result.profilesTotal.created++; }
    seen.add(key);
    return;
  }

  let profileId: number;
  if (existing) {
    const props = mergeProps(existing.props as Record<string, unknown> | null, cand.source, phoneRaw, !!e164);
    await db.update(mktProfiles).set({
      firstName: existing.firstName ?? cand.firstName,   // never overwrite a non-null with null
      lastName: existing.lastName ?? cand.lastName,
      phoneE164: existing.phoneE164 ?? e164,
      props,
      updatedAt: new Date(),
    }).where(eq(mktProfiles.id, existing.id));
    profileId = existing.id;
    counts.updated++; result.profilesTotal.updated++;
  } else {
    const props = mergeProps(null, cand.source, phoneRaw, !!e164);
    const [row] = await db.insert(mktProfiles).values({
      workspaceId: cand.workspaceId, email, phoneE164: e164,
      firstName: cand.firstName, lastName: cand.lastName, props,
    }).returning({ id: mktProfiles.id });
    profileId = row.id;
    counts.created++; result.profilesTotal.created++;
  }
  seen.add(key);

  // ── Email consent seeding ──
  let subState: SubState = "never";
  let legalBasis: LegalBasis = "inferred";
  let src = cand.consentSource ?? `clubos:ingest:${cand.source}`;
  if (cand.emailConsent === "express") { subState = "subscribed"; legalBasis = "express"; }
  else if (cand.emailConsent === "opted_out") { subState = "unsubscribed"; legalBasis = "opted_out"; }
  const emailVerdict = await seedConsent(profileId, "email", subState, legalBasis, src, false);
  if (emailVerdict !== "skipped") result.consentSeeded.emailRows++;

  // ── SMS consent seeding: never/inferred for every phone (NO express SMS exists) ──
  if (e164) {
    const smsVerdict = await seedConsent(profileId, "sms", "never", "inferred", `clubos:ingest:${cand.source}`, false);
    if (smsVerdict !== "skipped") result.consentSeeded.smsRows++;
  }
}

function mergeProps(
  existing: Record<string, unknown> | null,
  source: string,
  phoneRaw: string | null,
  hasE164: boolean,
): Record<string, unknown> {
  const p: Record<string, unknown> = { ...(existing || {}) };
  const sources = new Set<string>(Array.isArray(p.sources) ? (p.sources as string[]) : []);
  sources.add(source);
  p.sources = Array.from(sources);
  if (!hasE164 && phoneRaw && !p.phone_raw) p.phone_raw = phoneRaw;
  return p;
}

async function runSource(
  name: string,
  candidates: Candidate[],
  result: IngestResult,
  opts: { dryRun: boolean; workspaceId: number | null },
  seen: Set<string>,
): Promise<void> {
  const counts = emptyCounts();
  for (const c of candidates) await processCandidate(c, counts, result, opts, seen);
  result.sources[name] = counts;
}

// ─── Source extractors (verified column names against shared/schema.ts) ───────
async function candidatesContacts(): Promise<Candidate[]> {
  const rows = await db.select({
    email: contacts.email, phone: contacts.phone, firstName: contacts.firstName,
    lastName: contacts.lastName, newsletterConsent: contacts.newsletterConsent,
  }).from(contacts);
  return rows.map((r) => ({
    workspaceId: CONTACTS_WORKSPACE_ID, email: r.email, phoneRaw: r.phone,
    firstName: r.firstName, lastName: r.lastName, source: "contacts",
    emailConsent: r.newsletterConsent === true ? "express" : undefined,
    consentSource: r.newsletterConsent === true ? "clubos:contacts.newsletterConsent" : undefined,
  }));
}

async function candidatesPredictor(): Promise<Candidate[]> {
  const rows = await db.select({
    email: predictorEntrants.email, phone: predictorEntrants.phone,
    fullName: predictorEntrants.fullName, organizationId: predictorEntrants.organizationId,
    marketingConsent: predictorEntrants.marketingConsent,
  }).from(predictorEntrants);
  return rows.map((r) => {
    const { firstName, lastName } = splitName(r.fullName);
    return {
      workspaceId: r.organizationId ?? 1, email: r.email, phoneRaw: r.phone, firstName, lastName,
      source: "predictor_entrants",
      emailConsent: r.marketingConsent === true ? "express" : undefined,
      consentSource: r.marketingConsent === true ? "clubos:predictor_entrants.marketingConsent" : undefined,
    };
  });
}

async function candidatesCicInterest(): Promise<Candidate[]> {
  const rows = await db.select({
    email: cicInterestRegistrations.email, phone: cicInterestRegistrations.phone,
    firstName: cicInterestRegistrations.firstName, lastName: cicInterestRegistrations.lastName,
    organizationId: cicInterestRegistrations.organizationId,
  }).from(cicInterestRegistrations);
  return rows.map((r) => ({
    workspaceId: r.organizationId, email: r.email, phoneRaw: r.phone,
    firstName: r.firstName, lastName: r.lastName, source: "cic_interest_registrations",
  }));
}

async function candidatesCic7s(): Promise<Candidate[]> {
  const rows = await db.select({
    email: cic7sRegistrations.email, phone: cic7sRegistrations.phone,
    firstName: cic7sRegistrations.firstName, lastName: cic7sRegistrations.lastName,
    organizationId: cic7sRegistrations.organizationId,
  }).from(cic7sRegistrations);
  return rows.map((r) => ({
    workspaceId: r.organizationId, email: r.email, phoneRaw: r.phone,
    firstName: r.firstName, lastName: r.lastName, source: "cic7s_registrations",
  }));
}

async function candidatesCugc(): Promise<Candidate[]> {
  const rows = await db.select({
    email: cugcRegistrations.email, phone: cugcRegistrations.phone,
    parentName: cugcRegistrations.parentName, organizationId: cugcRegistrations.organizationId,
  }).from(cugcRegistrations);
  return rows.map((r) => {
    const { firstName, lastName } = splitName(r.parentName);
    return { workspaceId: r.organizationId, email: r.email, phoneRaw: r.phone, firstName, lastName, source: "cugc_registrations" };
  });
}

async function candidatesMembers(): Promise<Candidate[]> {
  const rows = await db.select({
    email: members.email, phone: members.phone, name: members.name, organizationId: members.organizationId,
  }).from(members);
  return rows.map((r) => {
    const { firstName, lastName } = splitName(r.name);
    return { workspaceId: r.organizationId, email: r.email, phoneRaw: r.phone, firstName, lastName, source: "members" };
  });
}

async function candidatesAppUsers(): Promise<Candidate[]> {
  const rows = await db.select({
    email: appUsers.email, name: appUsers.name, organizationId: appUsers.organizationId,
    unsubscribed: appUsers.unsubscribed,
  }).from(appUsers);
  return rows.map((r) => {
    const { firstName, lastName } = splitName(r.name);
    return {
      workspaceId: r.organizationId, email: r.email, phoneRaw: null, firstName, lastName, source: "app_users",
      // Signed up to the app's marketing list ⇒ express; explicit unsubscribe ⇒ opted-out.
      emailConsent: r.unsubscribed === true ? "opted_out" : "express",
      consentSource: "clubos:app_users.unsubscribed",
    };
  });
}

async function candidatesLeagueTeams(): Promise<Candidate[]> {
  const rows = await db.select({
    contactEmail: leagueTeams.contactEmail, contactPhone: leagueTeams.contactPhone,
    contactName: leagueTeams.contactName, organizationId: leagueTeams.organizationId,
  }).from(leagueTeams);
  return rows.map((r) => {
    const { firstName, lastName } = splitName(r.contactName);
    return { workspaceId: r.organizationId, email: r.contactEmail, phoneRaw: r.contactPhone, firstName, lastName, source: "league_teams" };
  });
}

async function candidatesSplitMembers(): Promise<Candidate[]> {
  const rows = await db.select({
    email: splitMembers.email, phone: splitMembers.phone, name: splitMembers.name,
    organizationId: splitSessions.organizationId,
  }).from(splitMembers).innerJoin(splitSessions, eq(splitMembers.splitSessionId, splitSessions.id));
  return rows.map((r) => {
    const { firstName, lastName } = splitName(r.name);
    return { workspaceId: r.organizationId, email: r.email, phoneRaw: r.phone, firstName, lastName, source: "split_members" };
  });
}

async function candidatesClubs(): Promise<Candidate[]> {
  const rows = await db.select({
    contactEmail: clubs.contactEmail, contactPhone: clubs.contactPhone,
    contactName: clubs.contactName, organizationId: clubs.organizationId,
  }).from(clubs);
  return rows.map((r) => {
    const { firstName, lastName } = splitName(r.contactName);
    return { workspaceId: r.organizationId, email: r.contactEmail, phoneRaw: r.contactPhone, firstName, lastName, source: "clubs" };
  });
}

async function candidatesTournamentTeams(): Promise<Candidate[]> {
  const rows = await db.select({
    contactEmail: tournamentTeams.contactEmail, contactPhone: tournamentTeams.contactPhone,
    contactName: tournamentTeams.contactName, organizationId: tournaments.organizationId,
  }).from(tournamentTeams).innerJoin(tournaments, eq(tournamentTeams.tournamentId, tournaments.id));
  const out: Candidate[] = [];
  for (const r of rows) {
    const emails = splitEmails(r.contactEmail);
    const { firstName, lastName } = splitName(r.contactName);
    emails.forEach((email, i) => out.push({
      workspaceId: r.organizationId, email,
      phoneRaw: i === 0 ? r.contactPhone : null, // phone only to the first split address
      firstName, lastName, source: "tournament_teams",
    }));
  }
  return out;
}

async function candidatesTournamentStaff(): Promise<Candidate[]> {
  const rows = await db.select({
    email: tournamentStaff.email, phone: tournamentStaff.phone,
    firstName: tournamentStaff.firstName, lastName: tournamentStaff.lastName,
    organizationId: tournaments.organizationId,
  }).from(tournamentStaff)
    .innerJoin(tournamentTeams, eq(tournamentStaff.teamId, tournamentTeams.id))
    .innerJoin(tournaments, eq(tournamentTeams.tournamentId, tournaments.id));
  return rows.map((r) => ({
    workspaceId: r.organizationId, email: r.email, phoneRaw: r.phone,
    firstName: r.firstName, lastName: r.lastName, source: "tournament_staff",
  }));
}

async function candidatesVolunteers(): Promise<Candidate[]> {
  const rows = await db.select({
    email: volunteers.email, phone: volunteers.phone, firstName: volunteers.firstName,
    lastName: volunteers.lastName, organizationId: volunteers.organizationId,
  }).from(volunteers);
  return rows.map((r) => ({
    workspaceId: r.organizationId, email: r.email, phoneRaw: r.phone,
    firstName: r.firstName, lastName: r.lastName, source: "volunteers",
  }));
}

async function candidatesCicVendors(): Promise<Candidate[]> {
  const rows = await db.select({
    contactEmail: cicVendors.contactEmail, contactPhone: cicVendors.contactPhone,
    contactName: cicVendors.contactName, organizationId: cicVendors.organizationId,
  }).from(cicVendors);
  return rows.map((r) => {
    const { firstName, lastName } = splitName(r.contactName);
    return { workspaceId: r.organizationId, email: r.contactEmail, phoneRaw: r.contactPhone, firstName, lastName, source: "cic_vendors" };
  });
}

async function candidatesSponsorshipProspects(): Promise<Candidate[]> {
  const rows = await db.select({
    contactEmail: sponsorshipProspects.contactEmail, contactPhone: sponsorshipProspects.contactPhone,
    contactName: sponsorshipProspects.contactName, organizationId: sponsorshipProspects.organizationId,
  }).from(sponsorshipProspects);
  return rows.map((r) => {
    const { firstName, lastName } = splitName(r.contactName);
    // Sponsors sit on their own row's organizationId (typically the USG/group workspace).
    return { workspaceId: r.organizationId, email: r.contactEmail, phoneRaw: r.contactPhone, firstName, lastName, source: "sponsorship_prospects" };
  });
}

async function candidatesPrintContacts(): Promise<Candidate[]> {
  const rows = await db.select({
    email: printContacts.email, phone: printContacts.phone, firstName: printContacts.firstName,
    lastName: printContacts.lastName, organizationId: printContacts.organizationId,
  }).from(printContacts);
  return rows.map((r) => ({
    workspaceId: r.organizationId ?? PRINTS_WORKSPACE_ID, email: r.email, phoneRaw: r.phone,
    firstName: r.firstName, lastName: r.lastName, source: "print_contacts",
  }));
}

// ─── Suppression import (email_unsubscribes → mkt_suppressions + downgrade) ───
async function importSuppressions(
  result: IngestResult,
  opts: { dryRun: boolean; workspaceId: number | null },
): Promise<void> {
  const rows = await db.select({
    email: emailUnsubscribes.email, organizationId: emailUnsubscribes.organizationId,
    source: emailUnsubscribes.source,
  }).from(emailUnsubscribes);

  for (const u of rows) {
    const orgId = u.organizationId; // null = global unsubscribe
    // Workspace filter: a brand unsubscribe for a different org is out of scope;
    // a global unsubscribe still applies to the filtered workspace's profiles.
    if (opts.workspaceId != null && orgId != null && orgId !== opts.workspaceId) continue;

    const email = normalizeEmail(u.email);
    if (!email) continue;
    result.suppressions.scanned++;
    if (opts.dryRun) continue; // suppression writes/downgrades are simulated only in the real run

    const scope: "global" | "brand" = orgId == null ? "global" : "brand";
    const brandKey = orgId == null ? null : (BRAND_KEY_BY_ORG[orgId] ?? String(orgId));

    const inserted = await db.insert(mktSuppressions).values({
      email, channel: "email", scope, brandKey, reason: "unsub_prefs",
      source: u.source ? `clubos:email_unsubscribes:${u.source}` : "clubos:email_unsubscribes",
    }).onConflictDoNothing().returning({ id: mktSuppressions.id });
    if (inserted.length) result.suppressions.created++;

    // Downgrade the matching profile(s)' email consent to opted-out (always wins).
    const conds = [sql`lower(${mktProfiles.email}) = ${email}`];
    if (scope === "brand") conds.push(eq(mktProfiles.workspaceId, orgId as number));
    if (opts.workspaceId != null) conds.push(eq(mktProfiles.workspaceId, opts.workspaceId));
    const targets = await db.select({ id: mktProfiles.id }).from(mktProfiles).where(and(...conds));

    for (const t of targets) {
      const verdict = await seedConsent(t.id, "email", "unsubscribed", "opted_out", "clubos:email_unsubscribes", false);
      if (verdict !== "skipped") result.suppressions.consentDowngraded++;
    }
  }
}

// ─── Orchestrator ────────────────────────────────────────────────────────────
export async function runMarketingIngest(opts: { dryRun?: boolean; workspaceId?: number } = {}): Promise<IngestResult> {
  const dryRun = !!opts.dryRun;
  const workspaceId = opts.workspaceId ?? null;
  const result: IngestResult = {
    dryRun, workspaceFilter: workspaceId,
    sources: {}, profilesTotal: emptyCounts(),
    consentSeeded: { emailRows: 0, smsRows: 0 },
    suppressions: { scanned: 0, created: 0, consentDowngraded: 0 },
  };
  const seen = new Set<string>();
  const o = { dryRun, workspaceId };

  // Order note: unsubscribe/opt-out sources (app_users) and the suppression import
  // are rank-3, so they win regardless of ingest order — but suppressions run last
  // by design, once every profile exists.
  await runSource("contacts", await candidatesContacts(), result, o, seen);
  await runSource("predictor_entrants", await candidatesPredictor(), result, o, seen);
  await runSource("cic_interest_registrations", await candidatesCicInterest(), result, o, seen);
  await runSource("cic7s_registrations", await candidatesCic7s(), result, o, seen);
  await runSource("cugc_registrations", await candidatesCugc(), result, o, seen);
  await runSource("members", await candidatesMembers(), result, o, seen);
  await runSource("app_users", await candidatesAppUsers(), result, o, seen);
  await runSource("league_teams", await candidatesLeagueTeams(), result, o, seen);
  await runSource("split_members", await candidatesSplitMembers(), result, o, seen);
  await runSource("clubs", await candidatesClubs(), result, o, seen);
  await runSource("tournament_teams", await candidatesTournamentTeams(), result, o, seen);
  await runSource("tournament_staff", await candidatesTournamentStaff(), result, o, seen);
  await runSource("volunteers", await candidatesVolunteers(), result, o, seen);
  await runSource("cic_vendors", await candidatesCicVendors(), result, o, seen);
  await runSource("sponsorship_prospects", await candidatesSponsorshipProspects(), result, o, seen);
  await runSource("print_contacts", await candidatesPrintContacts(), result, o, seen);

  await importSuppressions(result, o);
  return result;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  const dryRun = process.argv.includes("--dry-run");
  const wsFlag = process.argv.indexOf("--workspace");
  const workspaceId = wsFlag !== -1 && process.argv[wsFlag + 1] ? Number(process.argv[wsFlag + 1]) : undefined;
  runMarketingIngest({ dryRun, workspaceId })
    .then((r) => {
      console.log(`\n${dryRun ? "DRY RUN — " : ""}Marketing ingest complete${workspaceId ? ` (workspace ${workspaceId})` : ""}.`);
      console.table(r.sources);
      console.log("Profiles total:", r.profilesTotal);
      console.log("Consent seeded:", r.consentSeeded);
      console.log("Suppressions:", r.suppressions);
      process.exit(0);
    })
    .catch((e) => { console.error("❌ ingest failed", e); process.exit(1); });
}
