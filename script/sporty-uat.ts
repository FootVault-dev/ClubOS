// UAT harness for the Sporty / NZ Football NRS integration.
//
// NZF (Rodrigo Stephanou) issued UAT credentials on 2026-07-27 and asked us to
// "send some registrations through covering as many different scenarios as
// possible (Nationality, Country of Birth, Age…)". This drives that.
//
//   npx tsx --env-file=.env script/sporty-uat.ts connect     # auth + reachability
//   npx tsx --env-file=.env script/sporty-uat.ts reference   # pull + cache their real vocab
//   npx tsx --env-file=.env script/sporty-uat.ts scenarios --dry-run
//   npx tsx --env-file=.env script/sporty-uat.ts scenarios   # push the matrix
//   npx tsx --env-file=.env script/sporty-uat.ts verify      # read back what we sent
//
// SAFETY: refuses to run against production. These are synthetic people built
// in memory — the scenario matrix never touches the ClubOS contacts table, so
// no real child's identity data is sent to a test environment, and no UAT
// SportyId is written against a real contact row.

import {
  buildRegisterPerson,
  classifySportyError,
  sportyEnvironmentFor,
  isSportyProduction,
  type SportyBuildPlayer,
  type SportyBuildGuardian,
  type SportyReferenceData,
} from "../shared/sporty";
import { SportyClient, readSportyConfig } from "../server/sporty-client";

const CMD = process.argv[2] || "connect";
const DRY_RUN = process.argv.includes("--dry-run");
/** AIOS repo root/outputs — this script runs from a clubos worktree, so walk up
 *  to the workspace rather than guessing a relative depth. */
const OUT_DIR = `${process.env.HOME}/Desktop/AIOS/DanielMeynOS/outputs/sporty-uat/`;

function die(msg: string): never {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

function config() {
  const cfg = readSportyConfig();
  if (!cfg) die("SPORTY_API_KEY / SPORTY_API_USERNAME / SPORTY_API_PASSWORD are not set. Run with --env-file=.env");
  if (isSportyProduction(cfg.baseUrl)) {
    die(
      `SPORTY_BASE_URL points at PRODUCTION (${cfg.baseUrl}).\n` +
        `  This harness pushes synthetic test people and must never run against the real\n` +
        `  National Registration System. Point it at https://uat.sporty.co.nz.`,
    );
  }
  return cfg;
}

// ── The scenario matrix ─────────────────────────────────────────────────────
// Deliberately synthetic. Names are obviously test data so NZF can spot and
// purge them; every other field exercises a real branch of the mapper.

const TODAY = "2026-07-27";

interface Scenario {
  key: string;
  what: string;
  player: Omit<SportyBuildPlayer, "id">;
  guardian?: SportyBuildGuardian | null;
  /** Set when we EXPECT preflight to refuse — proves the guardrails, not the happy path. */
  expectBlocked?: string;
}

const GUARDIAN: SportyBuildGuardian = {
  firstName: "Tessa",
  lastName: "Testerton",
  email: "uat.guardian@cufc.co.nz",
  phone: "0211234567",
  address: "12 Test Street, Riccarton, Christchurch, 8041",
};

const SCENARIOS: Scenario[] = [
  {
    key: "adult-nz-european",
    what: "Adult · NZ national, born NZ · European · male",
    player: {
      firstName: "Uattest", lastName: "Alpha",
      dateOfBirth: "1998-04-12", gender: "male",
      email: "uat.alpha@cufc.co.nz", phone: "0211000001",
      address: "12 Test Street, Riccarton, Christchurch, 8041",
      nationality: "New Zealand", countryOfBirth: "New Zealand",
      ethnicity: "European", subEthnicity: "New Zealand European",
      ethnicity2: null, subEthnicity2: null,
    },
  },
  {
    key: "minor-u13-maori",
    what: "Minor (U13) · NZ/NZ · Māori with iwi · guardian required",
    player: {
      firstName: "Uattest", lastName: "Bravo",
      dateOfBirth: "2014-09-02", gender: "male",
      email: null, phone: null, address: null, // must inherit from guardian
      nationality: "New Zealand", countryOfBirth: "New Zealand",
      ethnicity: "Māori", subEthnicity: "Ngāi Tahu",
      ethnicity2: null, subEthnicity2: null,
    },
    guardian: GUARDIAN,
  },
  {
    key: "minor-u8-female-dual-ethnicity",
    what: "Minor (U8) · female · dual ethnicity (European + Pacific Peoples)",
    player: {
      firstName: "Uattest", lastName: "Charlie",
      dateOfBirth: "2019-01-15", gender: "female",
      email: null, phone: null, address: null,
      nationality: "New Zealand", countryOfBirth: "Samoa",
      ethnicity: "European", subEthnicity: "New Zealand European",
      ethnicity2: "Pacific Peoples", subEthnicity2: "Samoan",
    },
    guardian: GUARDIAN,
  },
  {
    key: "minor-born-overseas",
    what: "Minor · born overseas (Brazil), Brazilian national · MELAA-adjacent",
    player: {
      firstName: "Uattest", lastName: "Delta",
      dateOfBirth: "2011-06-30", gender: "male",
      email: null, phone: null, address: null,
      nationality: "Brazil", countryOfBirth: "Brazil",
      ethnicity: "Other Ethnicity", subEthnicity: null,
      ethnicity2: null, subEthnicity2: null,
    },
    guardian: GUARDIAN,
  },
  {
    key: "adult-dual-nationality-mismatch",
    what: "Adult · nationality ≠ country of birth (GBR national born ZAF) · Asian",
    player: {
      firstName: "Uattest", lastName: "Echo",
      dateOfBirth: "1991-11-05", gender: "female",
      email: "uat.echo@cufc.co.nz", phone: "0211000005",
      address: "9 Sample Road, Addington, Christchurch, 8024",
      nationality: "England", countryOfBirth: "South Africa",
      ethnicity: "Asian", subEthnicity: "Indian",
      ethnicity2: null, subEthnicity2: null,
    },
  },
  {
    key: "minor-melaa",
    what: "Minor · MELAA (their minimum-selection rule) · born Iran",
    player: {
      firstName: "Uattest", lastName: "Foxtrot",
      dateOfBirth: "2010-02-20", gender: "male",
      email: null, phone: null, address: null,
      nationality: "Iran", countryOfBirth: "Iran",
      ethnicity: "Middle Eastern / Latin American / African", subEthnicity: "Iranian",
      ethnicity2: null, subEthnicity2: null,
    },
    guardian: GUARDIAN,
  },
  {
    key: "edge-17th-birthday-today",
    what: "Edge · turns 18 TOMORROW (still a minor today) · guardian required",
    player: {
      firstName: "Uattest", lastName: "Golf",
      dateOfBirth: "2008-07-28", gender: "female",
      email: null, phone: null, address: null,
      nationality: "New Zealand", countryOfBirth: "New Zealand",
      ethnicity: "European", subEthnicity: "British",
      ethnicity2: null, subEthnicity2: null,
    },
    guardian: GUARDIAN,
  },
  {
    key: "edge-18th-birthday-today",
    what: "Edge · turns 18 TODAY (adult; no guardian needed)",
    player: {
      firstName: "Uattest", lastName: "Hotel",
      dateOfBirth: "2008-07-27", gender: "male",
      email: "uat.hotel@cufc.co.nz", phone: "0211000008",
      address: "3 Boundary Lane, Hornby, Christchurch, 8042",
      nationality: "New Zealand", countryOfBirth: "New Zealand",
      ethnicity: "European", subEthnicity: "New Zealand European",
      ethnicity2: null, subEthnicity2: null,
    },
  },
  {
    key: "adult-pacific-tonga",
    what: "Adult · Tongan national born Tonga · Pacific Peoples",
    player: {
      firstName: "Uattest", lastName: "India",
      dateOfBirth: "1996-03-08", gender: "male",
      email: "uat.india@cufc.co.nz", phone: "0211000009",
      address: "45 Example Ave, Papanui, Christchurch, 8052",
      nationality: "Tonga", countryOfBirth: "Tonga",
      ethnicity: "Pacific Peoples", subEthnicity: "Tongan",
      ethnicity2: null, subEthnicity2: null,
    },
  },
  {
    key: "blocked-incomplete-address",
    what: "GUARDRAIL · a bare street line is refused (Sporty needs all six parts; 24 real registrants)",
    expectBlocked: "address_incomplete",
    player: {
      firstName: "Uattest", lastName: "Juliet",
      dateOfBirth: "2013-12-01", gender: "female",
      email: null, phone: null, address: null,
      nationality: "New Zealand", countryOfBirth: "Fiji",
      ethnicity: "Pacific Peoples", subEthnicity: "Fijian",
      ethnicity2: null, subEthnicity2: null,
    },
    guardian: { ...GUARDIAN, address: "Rural Delivery 4 Oxford" },
  },
  {
    key: "asian-indian-exact-match",
    what: "Regression · sub-ethnicity 'Indian' must NOT become 'Anglo Indian' (3 real contacts)",
    player: {
      firstName: "Uattest", lastName: "November",
      dateOfBirth: "2012-04-18", gender: "male",
      email: null, phone: null, address: null,
      nationality: "India", countryOfBirth: "India",
      ethnicity: "Asian", subEthnicity: "Indian",
      ethnicity2: null, subEthnicity2: null,
    },
    guardian: GUARDIAN,
  },
  {
    key: "other-ethnicity-maps-to-other",
    what: "Regression · 'Other Ethnicity' resolves to their 'Other' group (4 real contacts)",
    player: {
      firstName: "Uattest", lastName: "Oscar",
      dateOfBirth: "2009-10-10", gender: "female",
      email: null, phone: null, address: null,
      nationality: "New Zealand", countryOfBirth: "Ethiopia",
      ethnicity: "Other Ethnicity", subEthnicity: null,
      ethnicity2: null, subEthnicity2: null,
    },
    guardian: GUARDIAN,
  },
  // ── Guardrail scenarios: these SHOULD be refused before any network call ──
  {
    key: "blocked-bare-european",
    what: "GUARDRAIL · bare 'European' is ambiguous in their list (74 real contacts)",
    expectBlocked: "ethnicity_group_ambiguous",
    player: {
      firstName: "Uattest", lastName: "Papa",
      dateOfBirth: "2011-03-03", gender: "male",
      email: null, phone: null, address: null,
      nationality: "New Zealand", countryOfBirth: "New Zealand",
      ethnicity: "European", subEthnicity: null,
      ethnicity2: null, subEthnicity2: null,
    },
    guardian: GUARDIAN,
  },
  {
    key: "blocked-gender-other",
    what: "GUARDRAIL · gender 'other' is never auto-mapped to Non-binary",
    expectBlocked: "gender_unmapped",
    player: {
      firstName: "Uattest", lastName: "Kilo",
      dateOfBirth: "2012-05-05", gender: "other",
      email: null, phone: null, address: null,
      nationality: "New Zealand", countryOfBirth: "New Zealand",
      ethnicity: "European", subEthnicity: "New Zealand European",
      ethnicity2: null, subEthnicity2: null,
    },
    guardian: GUARDIAN,
  },
  {
    key: "blocked-minor-no-guardian",
    what: "GUARDRAIL · minor with no guardian on record is skipped, not guessed",
    expectBlocked: "missing_guardian_name",
    player: {
      firstName: "Uattest", lastName: "Lima",
      dateOfBirth: "2015-08-08", gender: "male",
      email: "uat.lima@cufc.co.nz", phone: "0211000012",
      address: "1 Nowhere St, Riccarton, Christchurch, 8011",
      nationality: "New Zealand", countryOfBirth: "New Zealand",
      ethnicity: "European", subEthnicity: "New Zealand European",
      ethnicity2: null, subEthnicity2: null,
    },
    guardian: null,
  },
  {
    key: "blocked-unknown-country",
    what: "GUARDRAIL · an unmappable country of birth is refused, never defaulted to NZL",
    expectBlocked: "country_of_birth_unresolved",
    player: {
      firstName: "Uattest", lastName: "Mike",
      dateOfBirth: "2000-01-01", gender: "male",
      email: "uat.mike@cufc.co.nz", phone: "0211000013",
      address: "2 Unknown Way, Riccarton, Christchurch, 8011",
      nationality: "New Zealand", countryOfBirth: "Wakanda",
      ethnicity: "European", subEthnicity: "New Zealand European",
      ethnicity2: null, subEthnicity2: null,
    },
  },
];

// ── Commands ────────────────────────────────────────────────────────────────

async function cmdConnect() {
  const cfg = config();
  console.log(`base URL    : ${cfg.baseUrl}`);
  console.log(`environment : ${sportyEnvironmentFor(cfg.baseUrl)}`);
  console.log(`api key     : ${cfg.apiKey.slice(0, 8)}…`);
  console.log(`username    : ${cfg.username}\n`);

  const client = new SportyClient(cfg);
  const started = Date.now();
  const result = await client.testConnection();
  console.log(`testConnection → ${JSON.stringify(result)}  (${Date.now() - started}ms)`);
  if (!(result as any).ok) die("Connection failed — see the message above.");
  console.log("\n✓ Authenticated against Sporty UAT.");
}

async function fetchReference(client: SportyClient): Promise<SportyReferenceData> {
  const [countries, genders, ethnicityGroups] = [
    await client.getCountries(),
    await client.getGenders(),
    await client.getEthnicityGroups(),
  ];
  return { countries, genders, ethnicityGroups };
}

async function cmdReference() {
  const cfg = config();
  const client = new SportyClient(cfg);
  const ref = await fetchReference(client);

  console.log(`countries        : ${ref.countries!.length}`);
  console.log(`genders          : ${JSON.stringify(ref.genders)}`);
  console.log(`ethnicity groups : ${ref.ethnicityGroups!.length}\n`);
  for (const g of ref.ethnicityGroups!) {
    console.log(
      `  · ${g.EthnicityGroupName} (id ${g.EthnicityGroupId}) — min ${g.MinimumSelectionsRequired}, max ${g.MaximumSelectionsRequired}, ${g.EthnicityGroupSelections?.length ?? 0} selections`,
    );
  }
  // Sanity-check the assumptions our mapper was written against.
  console.log("\nMapper assumption checks:");
  const nzl = ref.countries!.find((c) => c.CountryCode === "NZL");
  console.log(`  NZL present            : ${nzl ? `yes (${nzl.CountryName})` : "NO — mapper assumes alpha-3"}`);
  for (const g of ["Male", "Female", "Non-binary"]) {
    console.log(`  gender "${g}"${" ".repeat(12 - g.length)}: ${ref.genders!.includes(g) ? "yes" : "NO"}`);
  }
  const melaa = ref.ethnicityGroups!.find((g) => /melaa|middle eastern/i.test(g.EthnicityGroupName));
  console.log(`  MELAA group            : ${melaa ? `"${melaa.EthnicityGroupName}" (min ${melaa.MinimumSelectionsRequired})` : "NOT FOUND"}`);

  // Persist into the environment-scoped cache so the engine and UI use the real vocab.
  const { refreshReferenceData } = await import("../server/sporty-engine");
  const counts = await refreshReferenceData(client);
  console.log(`\n✓ Cached to sporty_reference_cache (environment '${sportyEnvironmentFor(cfg.baseUrl)}'):`, counts);
}

async function cmdScenarios() {
  const cfg = config();
  const client = new SportyClient(cfg);
  const ref = await fetchReference(client);

  console.log(`\nScenario matrix — ${SCENARIOS.length} cases against ${cfg.baseUrl}`);
  console.log(DRY_RUN ? "DRY RUN — building payloads only, nothing is sent.\n" : "LIVE — payloads will be sent to UAT.\n");

  const results: any[] = [];
  for (const [i, s] of SCENARIOS.entries()) {
    const built = buildRegisterPerson({
      player: { id: 900000 + i, ...s.player },
      guardian: s.guardian ?? null,
      ref,
      todayIso: TODAY,
    });
    const blockers = built.issues.filter((x) => x.severity === "blocker");
    const warnings = built.issues.filter((x) => x.severity === "warning");

    console.log(`${i + 1}. ${s.key}`);
    console.log(`   ${s.what}`);
    if (built.isMinor !== null) console.log(`   minor: ${built.isMinor}`);

    if (s.expectBlocked) {
      const hit = blockers.some((b) => b.code === s.expectBlocked);
      console.log(`   expected refusal "${s.expectBlocked}": ${hit ? "✓ refused before sending" : "✗ NOT REFUSED"}`);
      if (blockers.length) console.log(`   → ${blockers.map((b) => b.message).join(" ")}`);
      results.push({ key: s.key, kind: "guardrail", passed: hit, blockers: blockers.map((b) => b.code) });
      console.log("");
      continue;
    }

    if (blockers.length) {
      console.log(`   ✗ unexpectedly blocked: ${blockers.map((b) => `${b.code} (${b.message})`).join(" | ")}`);
      results.push({ key: s.key, kind: "push", outcome: "preflight_blocked", blockers: blockers.map((b) => b.code) });
      console.log("");
      continue;
    }
    if (warnings.length) console.log(`   warnings: ${warnings.map((w) => w.code).join(", ")}`);
    console.log(`   payload: ${JSON.stringify({ ...built.payload, Address: undefined })}`);
    console.log(`   address: ${JSON.stringify(built.payload!.Address)}`);

    if (DRY_RUN) {
      results.push({ key: s.key, kind: "push", outcome: "dry_run", payload: built.payload });
      console.log("");
      continue;
    }

    try {
      const res = await client.registerPerson(built.payload!);
      if (res.ok) {
        console.log(`   → 200 SportyId ${res.data.SportyId}${res.data.PersonFifaId ? ` · FIFA ${res.data.PersonFifaId}` : ""}`);
        results.push({ key: s.key, kind: "push", outcome: "synced", sportyId: res.data.SportyId, fifaId: res.data.PersonFifaId ?? null, payload: built.payload });
      } else {
        const kind = classifySportyError(res.message);
        console.log(`   → ${res.status} ${kind}: ${res.message}${res.sportyId ? ` (SportyId ${res.sportyId})` : ""}`);
        results.push({ key: s.key, kind: "push", outcome: kind, httpStatus: res.status, message: res.message, sportyId: res.sportyId ?? null, payload: built.payload });
      }
    } catch (e: any) {
      console.log(`   → TRANSPORT FAILURE: ${e?.message || e}`);
      results.push({ key: s.key, kind: "push", outcome: "transport_error", message: e?.message || String(e) });
    }
    console.log("");
  }

  // Summary
  const guardrails = results.filter((r) => r.kind === "guardrail");
  const pushes = results.filter((r) => r.kind === "push");
  console.log("─".repeat(70));
  console.log(`Guardrails : ${guardrails.filter((g) => g.passed).length}/${guardrails.length} refused as designed`);
  const byOutcome = pushes.reduce((acc: Record<string, number>, r) => ((acc[r.outcome] = (acc[r.outcome] || 0) + 1), acc), {});
  console.log(`Pushes     : ${JSON.stringify(byOutcome)}`);
  console.log("─".repeat(70));

  const outPath = OUT_DIR;
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(outPath, { recursive: true });
  const file = `${outPath}${DRY_RUN ? "dry-run" : "results"}-${TODAY}.json`;
  writeFileSync(file, JSON.stringify({ ranAt: new Date().toISOString(), baseUrl: cfg.baseUrl, results }, null, 2));
  console.log(`\nSaved: ${file}`);
}

async function cmdVerify() {
  const cfg = config();
  const client = new SportyClient(cfg);
  const { readFileSync } = await import("node:fs");
  const outPath = OUT_DIR;
  const prior = JSON.parse(readFileSync(`${outPath}results-${TODAY}.json`, "utf8"));
  // Anything Sporty has given us an id for — whether it came back 200 or as an
  // "already registered" / "overseas clearance" error. That IS the doctrine.
  const synced = prior.results.filter((r: any) => r.sportyId && r.payload);
  console.log(`Re-sending ${synced.length} payloads WITH their stored SportyId to prove UPDATE semantics (same id, no duplicate)…\n`);

  let ok = 0;
  for (const r of synced) {
    const payload = { ...r.payload, SportyId: r.sportyId };
    try {
      const res = await client.registerPerson(payload);
      if (res.ok) {
        const same = res.data.SportyId === r.sportyId;
        console.log(`${same ? "✓" : "✗"} ${r.key}: returned SportyId ${res.data.SportyId} (sent ${r.sportyId})`);
        if (same) ok++;
      } else {
        console.log(`• ${r.key}: ${res.status} ${res.message}`);
      }
    } catch (e: any) {
      console.log(`✗ ${r.key}: transport failure ${e?.message || e}`);
    }
  }
  console.log(`\n${ok}/${synced.length} updated in place with no new registration created.`);
}

// ── The real production path, end to end, against real UAT ──────────────────
// Everything above exercises the mapper + client. This exercises the ENGINE:
// candidate discovery from the database → preflight → push → environment-scoped
// sync state → audit log. It seeds its own synthetic contacts and deletes them
// afterwards, so no real child's identity data goes to a test environment.

async function cmdEngine() {
  const cfg = config();
  const { db } = await import("../server/db");
  const { eq, and, inArray } = await import("drizzle-orm");
  const schema = await import("@shared/schema");
  const engine = await import("../server/sporty-engine");

  const ORG = 1; // CUFC
  const created = { contacts: [] as number[], programs: [] as number[] };
  let pass = 0,
    fail = 0;
  const check = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
      pass++;
      console.log(`✓ ${name}`);
    } catch (e: any) {
      fail++;
      console.error(`✗ ${name}\n    ${e?.message || e}`);
    }
  };

  try {
    const [guardian] = await db
      .insert(schema.contacts)
      .values({
        type: "guardian",
        firstName: "SportyUAT",
        lastName: "Guardian",
        email: "sporty-uat-guardian@example.com",
        phone: "0210000001",
        address: "1 UAT Way, Riccarton, Christchurch 8041",
      } as any)
      .returning();
    const [player] = await db
      .insert(schema.contacts)
      .values({
        type: "player",
        firstName: "SportyUAT",
        lastName: "EnginePlayer",
        dateOfBirth: "2014-05-05",
        gender: "male",
        nationality: "New Zealand",
        countryOfBirth: "New Zealand",
        ethnicity: "European",
        subEthnicity: "New Zealand European",
      } as any)
      .returning();
    created.contacts.push(guardian.id, player.id);
    await db
      .insert(schema.contactRelationships)
      .values({ guardianId: guardian.id, playerId: player.id, relationship: "parent", isPrimaryContact: true } as any);

    const [program] = await db
      .insert(schema.programs)
      .values({
        organizationId: ORG,
        name: "SPORTY UAT TEST PROGRAMME (delete me)",
        type: "academy",
        seasonYear: 2026,
        isActive: false,
        registrationOpen: false,
      } as any)
      .returning();
    created.programs.push(program.id);
    await db
      .insert(schema.registrations)
      .values({ programId: program.id, contactId: player.id, guardianId: guardian.id, status: "confirmed" } as any);

    console.log(`\nEngine path against ${cfg.baseUrl} (synthetic contact ${player.id}, deleted afterwards)\n`);

    await check("candidate discovery finds the player and preflight passes", async () => {
      const built = await engine.buildCandidates(ORG, { contactIds: [player.id] });
      if (built.length !== 1) throw new Error(`expected 1 candidate, got ${built.length}`);
      const b = built[0];
      if (b.displayStatus !== "ready") throw new Error(`status ${b.displayStatus}: ${JSON.stringify(b.build.issues)}`);
      if (!b.build.payload?.Address?.Region) throw new Error("region was not derived onto the payload");
      if (b.build.payload!.Email !== "sporty-uat-guardian@example.com") throw new Error("guardian email fallback did not apply");
    });

    let sportyId: number | null = null;
    await check("push reaches real UAT and stores an id under the 'uat' namespace", async () => {
      const run = await engine.pushCandidates(ORG, [player.id]);
      const r = run.results[0];
      if (!r || !["synced", "blocked"].includes(r.outcome)) throw new Error(JSON.stringify(run));
      const rows = await db
        .select()
        .from(schema.sportySyncState)
        .where(eq(schema.sportySyncState.contactId, player.id));
      if (rows.length !== 1) throw new Error(`expected exactly 1 state row, got ${rows.length}`);
      const state = rows[0];
      if (state.environment !== "uat") throw new Error(`state.environment = ${state.environment}, expected uat`);
      if (!state.sportyId) throw new Error("no SportyId stored");
      sportyId = state.sportyId;
      console.log(`    → outcome ${r.outcome}, SportyId ${state.sportyId}, environment '${state.environment}'`);
    });

    await check("NO production-namespace row was created for this contact", async () => {
      const prod = await db
        .select()
        .from(schema.sportySyncState)
        .where(and(eq(schema.sportySyncState.contactId, player.id), eq(schema.sportySyncState.environment, "prod")));
      if (prod.length) throw new Error("a 'prod' state row exists — UAT leaked into the production namespace");
    });

    await check("audit log records the call against the UAT base URL", async () => {
      const logs = await engine.sportyLogFor(ORG, player.id);
      if (!logs.length) throw new Error("no audit rows");
      if (!/uat/i.test(logs[0].baseUrl)) throw new Error(`audit baseUrl = ${logs[0].baseUrl}`);
    });

    await check("unchanged data is not re-sent", async () => {
      const run = await engine.pushCandidates(ORG, [player.id]);
      if (run.results[0].outcome !== "skipped_unchanged") throw new Error(`expected skipped_unchanged, got ${run.results[0].outcome}`);
    });

    await check("changed data re-pushes and keeps the SAME SportyId (update, not duplicate)", async () => {
      await db.update(schema.contacts).set({ phone: "0219999999" } as any).where(eq(schema.contacts.id, player.id));
      const run = await engine.pushCandidates(ORG, [player.id]);
      if (!["synced", "blocked"].includes(run.results[0].outcome)) throw new Error(JSON.stringify(run));
      const [state] = await db
        .select()
        .from(schema.sportySyncState)
        .where(eq(schema.sportySyncState.contactId, player.id));
      if (state.sportyId !== sportyId) throw new Error(`SportyId changed ${sportyId} → ${state.sportyId} — that is a duplicate registration`);
    });

    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) process.exitCode = 1;
  } finally {
    // Delete sync/audit rows first: contact_id is ON DELETE RESTRICT by design.
    if (created.contacts.length) {
      await db.delete(schema.sportyPushLog).where(inArray(schema.sportyPushLog.contactId, created.contacts));
      await db.delete(schema.sportySyncState).where(inArray(schema.sportySyncState.contactId, created.contacts));
      await db.delete(schema.registrations).where(inArray(schema.registrations.contactId, created.contacts));
      await db.delete(schema.contactRelationships).where(inArray(schema.contactRelationships.playerId, created.contacts));
    }
    if (created.programs.length) await db.delete(schema.programs).where(inArray(schema.programs.id, created.programs));
    if (created.contacts.length) await db.delete(schema.contacts).where(inArray(schema.contacts.id, created.contacts));
    console.log("cleanup complete — synthetic rows removed");
  }
}

/** Read-only: how many real CUFC registrants would pass preflight today, and
 *  what exactly is stopping the rest. No network calls, nothing written. */
async function cmdReadiness() {
  const engine = await import("../server/sporty-engine");
  const ORG = 1;
  // Without NZF's real vocabulary the mapper runs its provisional path, stops
  // detecting ambiguous ethnicity groups, and reports far more players "ready"
  // than truly are (it once read 49/118 against a true 8/118). Refuse rather
  // than print a comfortable lie.
  const { ref, fetchedAt } = await engine.loadReferenceData();
  if (!fetchedAt || !ref.ethnicityGroups?.length || !ref.countries?.length) {
    die("Reference data isn't loaded for this environment — run `sporty-uat.ts reference` first.\n  Readiness computed without it is optimistic and wrong.");
  }
  const built = await engine.buildCandidates(ORG, { scope: "academy" });

  const byStatus: Record<string, number> = {};
  const byBlocker: Record<string, number> = {};
  for (const b of built) {
    byStatus[b.displayStatus] = (byStatus[b.displayStatus] ?? 0) + 1;
    for (const i of b.build.issues.filter((x) => x.severity === "blocker")) {
      byBlocker[i.code] = (byBlocker[i.code] ?? 0) + 1;
    }
  }
  console.log(`CUFC confirmed academy registrants: ${built.length}\n`);
  console.log("Preflight status:");
  for (const [k, v] of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);
  console.log("\nWhat is blocking the rest (a player can have several):");
  for (const [k, v] of Object.entries(byBlocker).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);

  const ready = built.filter((b) => b.displayStatus === "ready");
  console.log(`\n→ ${ready.length} of ${built.length} would push cleanly right now.`);
  process.exit(0);
}

const COMMANDS: Record<string, () => Promise<void>> = {
  connect: cmdConnect,
  reference: cmdReference,
  scenarios: cmdScenarios,
  verify: cmdVerify,
  engine: cmdEngine,
  readiness: cmdReadiness,
};

const run = COMMANDS[CMD];
if (!run) die(`Unknown command "${CMD}". Try: ${Object.keys(COMMANDS).join(" | ")}`);
run().catch((e) => {
  console.error("\nFailed:", e?.stack || e?.message || e);
  process.exit(1);
});
