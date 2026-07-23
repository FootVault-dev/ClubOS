// End-to-end test of the Sporty push: the REAL SportyClient and REAL engine
// against the mock Sporty server (script/mock-sporty.ts, faithful to their
// swagger). Two parts:
//
//   Part 1 — client vs mock, no database: auth, token expiry re-auth, 429
//            backoff, every documented RegisterPerson scenario.
//   Part 2 — engine vs mock + the real DB (needs DATABASE_URL + the
//            2026-07-21_sporty_sync.sql tables): candidate discovery, preview,
//            push, SportyId capture on "already registered" + auto-retry,
//            unchanged-skip, changed-data re-push, audit log. Creates clearly
//            named test rows in org 1 and deletes ALL of them in finally —
//            including the mock reference data it writes to the cache.
//
//   npx tsx --env-file=.env script/test-sporty-e2e.ts
//   (без DATABASE_URL: part 1 runs, part 2 reports SKIPPED)

import assert from "node:assert";

process.env.MOCK_TOKEN_TTL_S = "3"; // mock tokens die fast → exercises 401 re-auth
const PORT = 4590 + Math.floor(Math.random() * 300);

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (e: any) {
    failed++;
    process.exitCode = 1;
    console.error(`✗ ${name}\n  ${e?.stack || e?.message || e}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { mockSportyApp, setMockTokenTtl, MOCK_API_KEY, MOCK_USERNAME, MOCK_PASSWORD } = await import("./mock-sporty");
  const server = mockSportyApp.listen(PORT);
  console.log(`[e2e] mock sporty on :${PORT}`);

  process.env.SPORTY_BASE_URL = `http://localhost:${PORT}`;
  process.env.SPORTY_API_KEY = MOCK_API_KEY;
  process.env.SPORTY_API_USERNAME = MOCK_USERNAME;
  process.env.SPORTY_API_PASSWORD = MOCK_PASSWORD;

  const { SportyClient, readSportyConfig } = await import("../server/sporty-client");
  const { buildRegisterPerson, classifySportyError } = await import("../shared/sporty");

  // ── Part 1: client vs mock ────────────────────────────────────────────────
  const cfg = readSportyConfig()!;
  assert.ok(cfg, "config should read from env");
  // minIntervalMs 0 so the client CAN trip the mock's 2/s limit → backoff path.
  const client = new SportyClient(cfg, { minIntervalMs: 0 });

  await test("auth + reference data round-trip", async () => {
    const genders = await client.getGenders();
    assert.deepEqual(genders, ["Male", "Female", "Non-binary"]);
    const countries = await client.getCountries();
    assert.ok(countries.some((c) => c.CountryCode === "NZL"));
    const groups = await client.getEthnicityGroups();
    assert.ok(groups.some((g) => g.EthnicityGroupName === "MELAA" && g.MinimumSelectionsRequired === 1));
  });

  await test("expired token triggers silent re-auth (401 path)", async () => {
    await sleep(3200); // mock token TTL is 3s; client still believes its cache
    const genders = await client.getGenders();
    assert.deepEqual(genders, ["Male", "Female", "Non-binary"]);
  });

  await test("burst requests survive the 2/s rate limit via backoff (429 path)", async () => {
    const results = await Promise.all([client.getGenders(), client.getGenders(), client.getGenders(), client.getGenders()]);
    for (const r of results) assert.deepEqual(r, ["Male", "Female", "Non-binary"]);
  });

  // Auth stress is done — from here the mock issues realistic 24h tokens (a 3s
  // TTL + rate-limit backoffs sustains a 401↔429 cycle that cannot occur in
  // production, where tokens live 24h).
  setMockTokenTtl(86399);
  await sleep(3200); // let the last short-lived token die, then re-auth long

  const ref = {
    countries: await client.getCountries(),
    genders: await client.getGenders(),
    ethnicityGroups: await client.getEthnicityGroups(),
  };
  const basePlayer = {
    id: 999001,
    firstName: "Aroha",
    lastName: "TestPlayer",
    dateOfBirth: "1996-02-14",
    gender: "female",
    email: "aroha@example.com",
    phone: "0211234567",
    address: "8 Test Lane, Riccarton, Christchurch 8041",
    nationality: "New Zealand",
    countryOfBirth: "New Zealand",
    ethnicity: "Māori",
    subEthnicity: "Ngāi Tahu",
    ethnicity2: null,
    subEthnicity2: null,
  };

  await test("valid registration → 200 with SportyId + FIFA id", async () => {
    const { payload } = buildRegisterPerson({ player: basePlayer, guardian: null, ref, todayIso: "2026-07-21" });
    assert.ok(payload);
    const res = await client.registerPerson(payload!);
    assert.ok(res.ok, JSON.stringify(res));
    if (res.ok) {
      assert.ok(res.data.SportyId > 0);
      assert.ok(String(res.data.PersonFifaId).startsWith("FIFA-"));
    }
  });

  await test("re-registering the same person → 'already registered' + id, retry-with-id succeeds", async () => {
    const { payload } = buildRegisterPerson({ player: basePlayer, guardian: null, ref, todayIso: "2026-07-21" });
    const dup = await client.registerPerson(payload!);
    assert.ok(!dup.ok);
    if (!dup.ok) {
      assert.equal(classifySportyError(dup.message), "already_registered");
      assert.ok(dup.sportyId && dup.sportyId > 0, "duplicate must carry the SportyId");
      const retry = await client.registerPerson({ ...payload!, SportyId: dup.sportyId });
      assert.ok(retry.ok, "retry with the returned SportyId must succeed as an update");
    }
  });

  await test("overseas clearance / termination / red flag classify + carry ids per the docs", async () => {
    for (const [first, kind, expectId] of [
      ["OVERSEAS", "overseas_clearance", 90002],
      ["TERMINATION", "termination_required", 90003],
      ["REDFLAG", "red_flag", null],
    ] as const) {
      const { payload } = buildRegisterPerson({
        player: { ...basePlayer, id: basePlayer.id + 1, firstName: first },
        guardian: null,
        ref,
        todayIso: "2026-07-21",
      });
      const res = await client.registerPerson(payload!);
      assert.ok(!res.ok);
      if (!res.ok) {
        assert.equal(classifySportyError(res.message), kind, `${first} → ${kind}`);
        assert.equal(res.sportyId, expectId, `${first} SportyId`);
      }
    }
  });

  await test("transient 500 is retried once and succeeds", async () => {
    const { payload } = buildRegisterPerson({
      player: { ...basePlayer, id: 999077, firstName: "SERVERBOOM" },
      guardian: null,
      ref,
      todayIso: "2026-07-21",
    });
    const res = await client.registerPerson(payload!);
    assert.ok(res.ok, JSON.stringify(res));
  });

  await test("mock enforces the documented field validation (bad gender rejected)", async () => {
    const { payload } = buildRegisterPerson({ player: { ...basePlayer, id: 999078, firstName: "Valid" }, guardian: null, ref, todayIso: "2026-07-21" });
    const res = await client.registerPerson({ ...payload!, Gender: "male" as any }); // wrong case on purpose
    assert.ok(!res.ok);
    if (!res.ok) assert.equal(res.message, "Invalid Gender");
  });

  // ── Part 2: engine vs mock + real DB ──────────────────────────────────────
  if (!process.env.DATABASE_URL) {
    console.log("\n[e2e] Part 2 SKIPPED — DATABASE_URL not set (run with --env-file=.env)");
  } else {
    const { db } = await import("../server/db");
    const { sql } = await import("drizzle-orm");
    const reg = await db.execute(sql`SELECT to_regclass('sporty_sync_state') AS r`);
    if (!(reg.rows as any[])[0]?.r) {
      console.log("\n[e2e] Part 2 SKIPPED — sporty tables not applied yet (run script/apply-sporty-sync.ts first)");
    } else {
      await part2(PORT);
    }
  }

  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
}

async function part2(port: number) {
  console.log("\n[e2e] Part 2 — engine against real DB (org 1 test rows, cleaned in finally)");
  const { db } = await import("../server/db");
  const { eq, inArray } = await import("drizzle-orm");
  const schema = await import("../shared/schema");
  const engine = await import("../server/sporty-engine");
  const { SportyClient, readSportyConfig } = await import("../server/sporty-client");

  const ORG = 1; // CUFC
  const created = { contacts: [] as number[], programs: [] as number[], registrations: [] as number[] };

  try {
    // Guardian + two players (one normal, one that trips the duplicate path).
    const [guardian] = await db
      .insert(schema.contacts)
      .values({
        type: "guardian",
        firstName: "SportyE2E",
        lastName: "Guardian",
        email: "sporty-e2e-guardian@example.com",
        phone: "0210000001",
        address: "1 E2E Way, Riccarton, Christchurch 8041",
      } as any)
      .returning();
    const [player1] = await db
      .insert(schema.contacts)
      .values({
        type: "player",
        firstName: "SportyE2E",
        lastName: "PlayerOne",
        dateOfBirth: "2014-05-05",
        gender: "male",
        nationality: "New Zealand",
        countryOfBirth: "New Zealand",
        ethnicity: "European",
        subEthnicity: "New Zealand European",
      } as any)
      .returning();
    const [player2] = await db
      .insert(schema.contacts)
      .values({
        type: "player",
        firstName: "DUPLICATE", // mock: first bare push → "Player already registered" + 90001
        lastName: "PlayerTwo",
        dateOfBirth: "2013-09-09",
        gender: "female",
        nationality: "NZ",
        countryOfBirth: "New Zealand",
        ethnicity: "Pacific Peoples",
        subEthnicity: "Samoan",
      } as any)
      .returning();
    created.contacts.push(guardian.id, player1.id, player2.id);

    await db.insert(schema.contactRelationships).values({ guardianId: guardian.id, playerId: player1.id, relationship: "parent", isPrimaryContact: true } as any);
    await db.insert(schema.contactRelationships).values({ guardianId: guardian.id, playerId: player2.id, relationship: "parent", isPrimaryContact: true } as any);

    const [program] = await db
      .insert(schema.programs)
      .values({
        organizationId: ORG,
        name: "SPORTY E2E TEST PROGRAMME (delete me)",
        type: "academy",
        seasonYear: 2026,
        isActive: false,
        registrationOpen: false,
      } as any)
      .returning();
    created.programs.push(program.id);

    for (const p of [player1, player2]) {
      const [r] = await db
        .insert(schema.registrations)
        .values({ programId: program.id, contactId: p.id, guardianId: guardian.id, status: "confirmed" } as any)
        .returning();
      created.registrations.push(r.id);
    }

    await test("engine: reference refresh populates the cache from the API", async () => {
      const counts = await engine.refreshReferenceData(new SportyClient(readSportyConfig()!));
      assert.ok(counts.countries >= 10 && counts.ethnicityGroups === 6 && counts.genders === 3);
    });

    await test("engine: candidate discovery finds both players, preflight-ready", async () => {
      const built = await engine.buildCandidates(ORG, { contactIds: [player1.id, player2.id] });
      assert.equal(built.length, 2);
      for (const b of built) {
        assert.equal(b.displayStatus, "ready", `${b.candidate.firstName}: ${JSON.stringify(b.build.issues)}`);
        assert.ok(b.build.payload);
        assert.equal(b.build.isMinor, true);
        assert.equal(b.build.payload!.ParentGuardian1FirstName, "SportyE2E");
        assert.equal(b.build.payload!.Email, "sporty-e2e-guardian@example.com"); // guardian fallback
      }
    });

    await test("engine: push → synced, SportyId + FIFA id stored, audit row written", async () => {
      const run = await engine.pushCandidates(ORG, [player1.id]);
      assert.equal(run.results.length, 1);
      assert.equal(run.results[0].outcome, "synced", JSON.stringify(run));
      const [state] = await db.select().from(schema.sportySyncState).where(eq(schema.sportySyncState.contactId, player1.id));
      assert.ok(state?.sportyId && state.sportyId > 0);
      assert.equal(state.status, "synced");
      assert.ok(state.personFifaId?.startsWith("FIFA-"));
      assert.ok(state.lastPayloadHash?.startsWith("fnv1a:"));
      const logs = await engine.sportyLogFor(ORG, player1.id);
      assert.ok(logs.length >= 1 && logs[0].outcome === "synced");
    });

    await test("engine: unchanged data → skipped, nothing re-sent", async () => {
      const run = await engine.pushCandidates(ORG, [player1.id]);
      assert.equal(run.results[0].outcome, "skipped_unchanged");
    });

    await test("engine: 'already registered' → id saved + auto-retry lands as update", async () => {
      const run = await engine.pushCandidates(ORG, [player2.id]);
      assert.equal(run.results[0].outcome, "synced", JSON.stringify(run));
      assert.equal(run.results[0].sportyId, 90001);
      const [state] = await db.select().from(schema.sportySyncState).where(eq(schema.sportySyncState.contactId, player2.id));
      assert.equal(state.sportyId, 90001);
      const logs = await engine.sportyLogFor(ORG, player2.id);
      assert.ok(logs.some((l) => l.outcome === "already_registered"), "the duplicate hit must be audited");
      assert.ok(logs.some((l) => l.outcome === "synced"));
    });

    await test("engine: changed contact data → 'changed' → re-push updates in place", async () => {
      await db.update(schema.contacts).set({ phone: "0219999999" } as any).where(eq(schema.contacts.id, guardian.id));
      const built = await engine.buildCandidates(ORG, { contactIds: [player1.id] });
      assert.equal(built[0].displayStatus, "changed");
      const run = await engine.pushCandidates(ORG, [player1.id]);
      assert.equal(run.results[0].outcome, "synced");
      const [state] = await db.select().from(schema.sportySyncState).where(eq(schema.sportySyncState.contactId, player1.id));
      assert.equal(state.status, "synced");
    });

    await test("engine: exclude/include round-trip", async () => {
      await engine.setExcluded(ORG, player1.id, true, "e2e test exclusion");
      let built = await engine.buildCandidates(ORG, { contactIds: [player1.id] });
      assert.equal(built[0].displayStatus, "excluded");
      const run = await engine.pushCandidates(ORG, [player1.id]);
      assert.equal(run.results[0].outcome, "skipped_excluded");
      await engine.setExcluded(ORG, player1.id, false);
      built = await engine.buildCandidates(ORG, { contactIds: [player1.id] });
      assert.notEqual(built[0].displayStatus, "excluded");
    });

    await test("engine: overview counts + config surface", async () => {
      const o = await engine.sportyOverview(ORG);
      assert.ok(o.counts.total >= 2);
      assert.equal(o.config.installed, true);
      assert.equal(o.reference.ethnicityGroups.length, 6);
    });
  } finally {
    // Order matters: sync state is RESTRICT on contacts.
    const ids = created.contacts;
    if (ids.length) {
      await db.delete(schema.sportyPushLog).where(inArray(schema.sportyPushLog.contactId, ids));
      await db.delete(schema.sportySyncState).where(inArray(schema.sportySyncState.contactId, ids));
      if (created.registrations.length) await db.delete(schema.registrations).where(inArray(schema.registrations.id, created.registrations));
      await db.delete(schema.contactRelationships).where(inArray(schema.contactRelationships.playerId, ids));
      await db.delete(schema.contacts).where(inArray(schema.contacts.id, ids));
    }
    if (created.programs.length) await db.delete(schema.programs).where(inArray(schema.programs.id, created.programs));
    // Never leave MOCK reference data in the real cache.
    await db.delete(schema.sportyReferenceCache);
    console.log("[e2e] cleanup complete — test rows and mock reference data removed");
  }
}

main().then(() => process.exit(process.exitCode || 0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
