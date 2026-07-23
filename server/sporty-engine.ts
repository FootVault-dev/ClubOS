// Sporty / NZF NRS push engine — candidate discovery, preflight preview, and
// the sequential live push. The rules that matter:
//
//  · WHO gets pushed: distinct player contacts holding a CONFIRMED registration
//    in a football programme (academy by default) of the workspace org. Pending
//    (unpaid) registrations are never pushed — a person is not registered with
//    the national body until the club considers them registered.
//  · SportyId doctrine: any response carrying a SportyId — success OR error —
//    writes it to sporty_sync_state before anything else happens. A stored
//    SportyId is ALWAYS sent on later pushes; "Player already registered" with
//    an id triggers one immediate retry as an update.
//  · Unchanged data is never re-sent (payload hash), pushes run sequentially
//    (their rate limit is 2/s and the client paces itself), and every call —
//    success or failure — lands one append-only sporty_push_log row.
//  · Nothing here invents data: preflight blockers make the engine SKIP a
//    player and tell staff exactly which field to fix.

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "./db";
import {
  contactRelationships,
  contacts,
  sportyPushLog,
  sportyReferenceCache,
  sportySyncState,
  type SportySyncState,
} from "@shared/schema";
import { nzTodayIso } from "@shared/academy";
import {
  buildRegisterPerson,
  classifySportyError,
  blockReasonFor,
  sportyPayloadHash,
  type SportyBuildGuardian,
  type SportyBuildPlayer,
  type SportyBuildResult,
  type SportyReferenceData,
  type SportyEthnicityGroup,
  type SportyCountry,
} from "@shared/sporty";
import { SportyClient, SportyTransportError, readSportyConfig } from "./sporty-client";

// Football programme types that exist in the NRS. holiday_camp/event stay out.
const SCOPE_TYPES: Record<string, string[]> = {
  academy: ["academy"],
  all: ["academy", "trials", "open_training", "league_team"],
};

export type SportyScope = keyof typeof SCOPE_TYPES;

export interface SportyCandidate {
  contactId: number;
  firstName: string | null;
  lastName: string | null;
  dateOfBirth: string | null;
  gender: string | null;
  programs: string[];
  seasonYears: number[];
  lastRegisteredAt: string | null;
  registrationGuardianId: number | null;
  state: SportySyncState | null;
}

function scopeTypes(scope: string | undefined): string[] {
  return SCOPE_TYPES[scope || "academy"] ?? SCOPE_TYPES.academy;
}

// ── Reference data ──────────────────────────────────────────────────────────

export async function loadReferenceData(): Promise<{ ref: SportyReferenceData; fetchedAt: Date | null }> {
  const rows = await db.select().from(sportyReferenceCache);
  const ref: SportyReferenceData = {};
  let fetchedAt: Date | null = null;
  for (const row of rows) {
    if (row.kind === "countries") ref.countries = row.payload as SportyCountry[];
    if (row.kind === "genders") ref.genders = row.payload as string[];
    if (row.kind === "ethnicity_groups") ref.ethnicityGroups = row.payload as SportyEthnicityGroup[];
    if (!fetchedAt || row.fetchedAt > fetchedAt) fetchedAt = row.fetchedAt;
  }
  return { ref, fetchedAt };
}

export async function refreshReferenceData(client: SportyClient): Promise<{ countries: number; genders: number; ethnicityGroups: number }> {
  const [countries, genders, ethnicityGroups] = [
    await client.getCountries(),
    await client.getGenders(),
    await client.getEthnicityGroups(),
  ];
  const upsert = async (kind: string, payload: unknown) => {
    await db
      .insert(sportyReferenceCache)
      .values({ kind, payload: payload as any, fetchedAt: new Date() })
      .onConflictDoUpdate({
        target: sportyReferenceCache.kind,
        set: { payload: payload as any, fetchedAt: new Date() },
      });
  };
  await upsert("countries", countries);
  await upsert("genders", genders);
  await upsert("ethnicity_groups", ethnicityGroups);
  return { countries: countries.length, genders: genders.length, ethnicityGroups: ethnicityGroups.length };
}

// ── Candidate discovery ─────────────────────────────────────────────────────

export async function listCandidates(
  orgId: number,
  opts: { scope?: string; search?: string } = {},
): Promise<SportyCandidate[]> {
  const types = scopeTypes(opts.scope);
  const search = (opts.search || "").trim();

  // One row per player contact across all their confirmed football
  // registrations; the guardian of the LATEST registration wins.
  const result = await db.execute(sql`
    SELECT
      c.id AS contact_id,
      c.first_name, c.last_name,
      c.date_of_birth::text AS date_of_birth, -- ::text: node-postgres parses bare DATE to a JS Date
      c.gender,
      array_agg(DISTINCT p.name) AS programs,
      array_agg(DISTINCT p.season_year) FILTER (WHERE p.season_year IS NOT NULL) AS season_years,
      max(r.registered_at) AS last_registered_at,
      (array_agg(r.guardian_id ORDER BY r.registered_at DESC))[1] AS registration_guardian_id
    FROM registrations r
    JOIN programs p ON p.id = r.program_id
    JOIN contacts c ON c.id = r.contact_id
    WHERE p.organization_id = ${orgId}
      AND r.status = 'confirmed'
      AND p.type IN ${sql.raw(`(${types.map((t) => `'${t}'`).join(",")})`)}
      ${search ? sql`AND (c.first_name || ' ' || c.last_name) ILIKE ${"%" + search + "%"}` : sql``}
    GROUP BY c.id
    ORDER BY c.last_name, c.first_name
  `);

  const rows = result.rows as any[];
  if (!rows.length) return [];

  const ids = rows.map((r) => Number(r.contact_id));
  const states = await db.select().from(sportySyncState).where(inArray(sportySyncState.contactId, ids));
  const stateByContact = new Map(states.map((s) => [s.contactId, s]));

  return rows.map((r) => ({
    contactId: Number(r.contact_id),
    firstName: r.first_name ?? null,
    lastName: r.last_name ?? null,
    dateOfBirth: typeof r.date_of_birth === "string" ? r.date_of_birth.slice(0, 10) : null,
    gender: r.gender ?? null,
    programs: (r.programs ?? []).filter(Boolean),
    seasonYears: (r.season_years ?? []).map(Number),
    lastRegisteredAt: r.last_registered_at ? new Date(r.last_registered_at).toISOString() : null,
    registrationGuardianId: r.registration_guardian_id != null ? Number(r.registration_guardian_id) : null,
    state: stateByContact.get(Number(r.contact_id)) ?? null,
  }));
}

// ── Build (payload + preflight) ─────────────────────────────────────────────

export interface BuiltCandidate {
  candidate: SportyCandidate;
  build: SportyBuildResult;
  payloadHash: string | null;
  /** What the row shows in the UI: stored status, or derived readiness. */
  displayStatus: string;
}

function toBuildPlayer(c: typeof contacts.$inferSelect): SportyBuildPlayer {
  return {
    id: c.id,
    firstName: c.firstName,
    lastName: c.lastName,
    dateOfBirth: c.dateOfBirth ? String(c.dateOfBirth).slice(0, 10) : null,
    gender: c.gender,
    email: c.email,
    phone: c.phone,
    address: c.address,
    nationality: c.nationality,
    countryOfBirth: c.countryOfBirth,
    ethnicity: c.ethnicity,
    subEthnicity: c.subEthnicity,
    ethnicity2: c.ethnicity2,
    subEthnicity2: c.subEthnicity2,
  };
}

function toBuildGuardian(c: typeof contacts.$inferSelect | undefined): SportyBuildGuardian | null {
  if (!c) return null;
  return { firstName: c.firstName, lastName: c.lastName, email: c.email, phone: c.phone, address: c.address };
}

export async function buildCandidates(
  orgId: number,
  opts: { scope?: string; contactIds?: number[]; search?: string } = {},
): Promise<BuiltCandidate[]> {
  let candidates = await listCandidates(orgId, { scope: opts.scope, search: opts.search });
  if (opts.contactIds?.length) {
    const wanted = new Set(opts.contactIds);
    candidates = candidates.filter((c) => wanted.has(c.contactId));
  }
  if (!candidates.length) return [];

  const { ref } = await loadReferenceData();
  const today = nzTodayIso();

  const playerIds = candidates.map((c) => c.contactId);
  const playerRows = await db.select().from(contacts).where(inArray(contacts.id, playerIds));
  const playerById = new Map(playerRows.map((p) => [p.id, p]));

  // Guardian: the latest registration's guardian_id, else the primary
  // contact_relationships guardian, else any relationship guardian.
  const rels = await db
    .select()
    .from(contactRelationships)
    .where(inArray(contactRelationships.playerId, playerIds));
  const relGuardianByPlayer = new Map<number, number>();
  for (const rel of rels) {
    const existing = relGuardianByPlayer.get(rel.playerId);
    if (existing === undefined || rel.isPrimaryContact) relGuardianByPlayer.set(rel.playerId, rel.guardianId);
  }

  const guardianIds = new Set<number>();
  for (const c of candidates) {
    const gid = c.registrationGuardianId ?? relGuardianByPlayer.get(c.contactId);
    if (gid) guardianIds.add(gid);
  }
  const guardianRows = guardianIds.size
    ? await db.select().from(contacts).where(inArray(contacts.id, Array.from(guardianIds)))
    : [];
  const guardianById = new Map(guardianRows.map((g) => [g.id, g]));

  return candidates.map((candidate) => {
    const player = playerById.get(candidate.contactId);
    const guardianId = candidate.registrationGuardianId ?? relGuardianByPlayer.get(candidate.contactId);
    const guardian = guardianId ? guardianById.get(guardianId) : undefined;

    const build = player
      ? buildRegisterPerson({
          player: toBuildPlayer(player),
          guardian: toBuildGuardian(guardian),
          sportyId: candidate.state?.sportyId ?? null,
          ref,
          todayIso: today,
        })
      : ({ payload: null, issues: [{ severity: "blocker", code: "contact_missing", message: "Contact row not found." }], isMinor: null } as SportyBuildResult);

    const payloadHash = build.payload ? sportyPayloadHash(build.payload) : null;
    const stored = candidate.state?.status;
    let displayStatus: string;
    if (stored === "excluded") displayStatus = "excluded";
    else if (build.issues.some((i) => i.severity === "blocker")) displayStatus = "needs_data";
    else if (stored === "synced" && payloadHash && candidate.state?.lastPayloadHash === payloadHash) displayStatus = "synced";
    else if (stored === "synced") displayStatus = "changed"; // synced before, data has moved since
    else displayStatus = stored ?? "ready";
    return { candidate, build, payloadHash, displayStatus };
  });
}

// ── Live push ───────────────────────────────────────────────────────────────

export interface PushResultRow {
  contactId: number;
  name: string;
  outcome: string; // 'synced' | 'blocked' | 'error' | 'skipped_needs_data' | 'skipped_unchanged' | 'skipped_excluded'
  message?: string;
  sportyId?: number | null;
}

export interface PushRunResult {
  results: PushResultRow[];
  aborted?: string; // human reason when the run stopped early (auth / rate limit)
}

async function upsertState(
  orgId: number,
  contactId: number,
  patch: Partial<typeof sportySyncState.$inferInsert>,
): Promise<void> {
  await db
    .insert(sportySyncState)
    .values({ organizationId: orgId, contactId, ...patch, updatedAt: new Date() } as any)
    .onConflictDoUpdate({
      target: sportySyncState.contactId,
      set: { ...patch, updatedAt: new Date() } as any,
    });
}

async function appendLog(
  orgId: number,
  contactId: number,
  baseUrl: string,
  outcome: string,
  httpStatus: number | null,
  sportyId: number | null,
  message: string | null,
  requestPayload: unknown,
  responseBody: unknown,
): Promise<void> {
  await db.insert(sportyPushLog).values({
    organizationId: orgId,
    contactId,
    endpoint: "RegisterPerson",
    baseUrl,
    outcome,
    httpStatus,
    sportyId,
    message,
    requestPayload: requestPayload as any,
    responseBody: responseBody as any,
  });
}

export async function pushCandidates(
  orgId: number,
  contactIds: number[],
  opts: { scope?: string; force?: boolean } = {},
): Promise<PushRunResult> {
  const config = readSportyConfig();
  if (!config) {
    throw new Error("Sporty API credentials are not installed (SPORTY_API_KEY / SPORTY_API_USERNAME / SPORTY_API_PASSWORD). UAT keys come from NZ Football once we confirm development is complete.");
  }
  const client = new SportyClient(config);

  // Reference data is required for a live push — mapping against guesses is
  // how bad data reaches a national register. Fetch it if missing or stale.
  const { ref, fetchedAt } = await loadReferenceData();
  const staleMs = 7 * 24 * 60 * 60 * 1000;
  if (!ref.ethnicityGroups?.length || !ref.countries?.length || !fetchedAt || Date.now() - fetchedAt.getTime() > staleMs) {
    await refreshReferenceData(client);
  }

  const built = await buildCandidates(orgId, { scope: opts.scope, contactIds });
  const results: PushResultRow[] = [];

  for (const item of built) {
    const { candidate, build, payloadHash } = item;
    const name = `${candidate.firstName ?? ""} ${candidate.lastName ?? ""}`.trim() || `contact ${candidate.contactId}`;
    const state = candidate.state;

    if (state?.status === "excluded") {
      results.push({ contactId: candidate.contactId, name, outcome: "skipped_excluded" });
      continue;
    }
    if (!build.payload || !payloadHash) {
      results.push({
        contactId: candidate.contactId,
        name,
        outcome: "skipped_needs_data",
        message: build.issues.filter((i) => i.severity === "blocker").map((i) => i.message).join(" "),
      });
      continue;
    }
    if (!opts.force && state?.status === "synced" && state.lastPayloadHash === payloadHash && state.sportyId) {
      results.push({ contactId: candidate.contactId, name, outcome: "skipped_unchanged", sportyId: state.sportyId });
      continue;
    }

    // A stored SportyId is ALWAYS sent (build already set it from state).
    let payload = build.payload;
    try {
      let res = await client.registerPerson(payload);

      // "Player already registered" with an id: save it, retry ONCE as update.
      if (!res.ok && res.sportyId && classifySportyError(res.message) === "already_registered") {
        await upsertState(orgId, candidate.contactId, { sportyId: res.sportyId });
        await appendLog(orgId, candidate.contactId, client.baseUrl, "already_registered", res.status, res.sportyId, res.message, payload, res.body);
        payload = { ...payload, SportyId: res.sportyId };
        res = await client.registerPerson(payload);
      }

      if (res.ok) {
        const sportyId = res.data.SportyId ?? payload.SportyId ?? null;
        await upsertState(orgId, candidate.contactId, {
          sportyId: typeof sportyId === "number" ? sportyId : null,
          personFifaId: res.data.PersonFifaId ?? state?.personFifaId ?? null,
          status: "synced",
          blockReason: null,
          lastError: null,
          lastPayloadHash: payloadHash,
          lastPushedAt: new Date(),
          attempts: (state?.attempts ?? 0) + 1,
        });
        await appendLog(orgId, candidate.contactId, client.baseUrl, "synced", 200, typeof sportyId === "number" ? sportyId : null, null, payload, res.data);
        results.push({ contactId: candidate.contactId, name, outcome: "synced", sportyId: typeof sportyId === "number" ? sportyId : null });
        continue;
      }

      const kind = classifySportyError(res.message);
      const block = blockReasonFor(kind);
      // The doctrine: an id on ANY response is saved before anything else.
      const learnedSportyId = res.sportyId ?? state?.sportyId ?? null;
      if (block) {
        await upsertState(orgId, candidate.contactId, {
          sportyId: learnedSportyId,
          status: "blocked",
          blockReason: block,
          lastError: res.message,
          attempts: (state?.attempts ?? 0) + 1,
        });
        await appendLog(orgId, candidate.contactId, client.baseUrl, "blocked", res.status, res.sportyId, res.message, payload, res.body);
        results.push({ contactId: candidate.contactId, name, outcome: "blocked", message: res.message, sportyId: learnedSportyId });
      } else {
        await upsertState(orgId, candidate.contactId, {
          sportyId: learnedSportyId,
          status: "error",
          lastError: res.message,
          attempts: (state?.attempts ?? 0) + 1,
        });
        await appendLog(orgId, candidate.contactId, client.baseUrl, "error", res.status, res.sportyId, res.message, payload, res.body);
        results.push({ contactId: candidate.contactId, name, outcome: "error", message: res.message });
      }
    } catch (e: any) {
      if (e instanceof SportyTransportError && (e.status === 401 || e.status === 429)) {
        // Config or rate problems affect every remaining call — stop the run.
        await appendLog(orgId, candidate.contactId, client.baseUrl, "error", e.status, null, e.message, payload, null);
        results.push({ contactId: candidate.contactId, name, outcome: "error", message: e.message });
        return { results, aborted: e.message };
      }
      await upsertState(orgId, candidate.contactId, {
        status: "error",
        lastError: e?.message || String(e),
        attempts: (state?.attempts ?? 0) + 1,
      });
      await appendLog(orgId, candidate.contactId, client.baseUrl, "error", e instanceof SportyTransportError ? e.status : null, null, e?.message || String(e), payload, null);
      results.push({ contactId: candidate.contactId, name, outcome: "error", message: e?.message || String(e) });
    }
  }

  return { results };
}

// ── Overview + log + exclude ────────────────────────────────────────────────

export async function sportyOverview(orgId: number, scope?: string) {
  const built = await buildCandidates(orgId, { scope });
  const counts: Record<string, number> = { total: built.length, ready: 0, needs_data: 0, synced: 0, changed: 0, blocked: 0, error: 0, excluded: 0, pending: 0 };
  for (const b of built) counts[b.displayStatus] = (counts[b.displayStatus] ?? 0) + 1;

  const { ref, fetchedAt } = await loadReferenceData();
  const [lastPush] = await db
    .select()
    .from(sportyPushLog)
    .where(eq(sportyPushLog.organizationId, orgId))
    .orderBy(desc(sportyPushLog.createdAt))
    .limit(1);

  return {
    counts,
    config: {
      installed: readSportyConfig() !== null,
      baseUrl: readSportyConfig()?.baseUrl ?? null,
      autosync: process.env.SPORTY_AUTOSYNC === "1",
    },
    reference: {
      fetchedAt: fetchedAt?.toISOString() ?? null,
      countries: ref.countries?.length ?? 0,
      genders: ref.genders ?? [],
      ethnicityGroups: (ref.ethnicityGroups ?? []).map((g) => g.EthnicityGroupName),
    },
    lastPushAt: lastPush?.createdAt?.toISOString() ?? null,
  };
}

export async function sportyLogFor(orgId: number, contactId?: number, limit = 100) {
  const conditions = [eq(sportyPushLog.organizationId, orgId)];
  if (contactId) conditions.push(eq(sportyPushLog.contactId, contactId));
  return db
    .select()
    .from(sportyPushLog)
    .where(and(...conditions))
    .orderBy(desc(sportyPushLog.createdAt))
    .limit(Math.min(limit, 500));
}

export async function setExcluded(orgId: number, contactId: number, excluded: boolean, reason?: string) {
  if (excluded) {
    await upsertState(orgId, contactId, { status: "excluded", excludedReason: reason || "Excluded by staff" });
  } else {
    // Back to the derived world: pending until the next push decides otherwise.
    await upsertState(orgId, contactId, { status: "pending", excludedReason: null });
  }
}
