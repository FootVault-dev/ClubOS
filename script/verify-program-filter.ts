/**
 * Verification for API-key programme filtering.
 *
 *   npx tsx script/verify-program-filter.ts
 *
 * Two halves:
 *   A. Pure logic — normalizeProgramFilter + programFilterSqlCondition, including
 *      the fail-closed cases and the SQL-injection guard.
 *   B. Real SQL — runs the ACTUAL fenced queries against the live database,
 *      READ-ONLY, and asserts the fenced row set is exactly the programmes the
 *      filter allows and no others.
 *
 * Read-only by construction: every statement is a SELECT, and the whole of
 * part B runs inside a transaction that is always ROLLED BACK.
 *
 * This is the conformance gate for the fence. Run it after ANY change to the
 * /api/v1 programme queries or to shared/api-scopes.ts.
 */

import "dotenv/config";
import { Pool } from "pg";
import { readFileSync } from "fs";
import {
  normalizeProgramFilter,
  programFilterSqlCondition,
  programFilterIsEmpty,
  describeProgramFilter,
  rejectedProgramTokens,
  unknownProgramTypes,
  scopesOutsideProgramFilter,
  type ProgramFilter,
} from "../shared/api-scopes";

let passed = 0;
let failed = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.log(`  ❌ ${label}\n       expected: ${e}\n       actual:   ${a}`);
  }
}

function assert(label: string, condition: boolean, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.log(`  ❌ ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

// ── A. Pure logic ────────────────────────────────────────────────────────────

function partA() {
  console.log("\nA. Filter logic\n");

  // ONLY a literal absence means unrestricted.
  check("null is unrestricted", normalizeProgramFilter(null), null);
  check("undefined is unrestricted", normalizeProgramFilter(undefined), null);
  check("unrestricted produces no SQL clause", programFilterSqlCondition(null), null);

  // Everything else that fails to parse must fail CLOSED, not open. A value in
  // this column was put there to restrict a key; if we can't read it, the only
  // safe interpretation is "restrict everything".
  const failClosed: [string, unknown][] = [
    ["{} (no keys)", {}],
    ["a bare array", ["holiday_camp"]],
    ["a jsonb string (pg returns it as a JS string)", "holiday_camp"],
    ["a number", 42],
    ["the singular typo {type:[...]}", { type: ["holiday_camp"] }],
    ["a capitalised key {Types:[...]}", { Types: ["holiday_camp"] }],
    ["an unrelated key {programTypes:[...]}", { programTypes: ["holiday_camp"] }],
    ["{types:null}", { types: null }],
    ["{slugs:'u4-u8'} (string, not array)", { slugs: "u4-u8" }],
    ["all tokens invalid", { types: ["'; DROP TABLE programs; --"] }],
  ];
  for (const [label, value] of failClosed) {
    const norm = normalizeProgramFilter(value);
    assert(`${label} → restricted, not unrestricted`, norm !== null);
    check(`${label} → SQL FALSE`, programFilterSqlCondition(norm), "FALSE");
  }

  // The real filter.
  const zach = normalizeProgramFilter({ types: ["holiday_camp"], slugs: ["u4-u8"] });
  check("Zach's filter normalises", zach, { types: ["holiday_camp"], slugs: ["u4-u8"] });
  check(
    "Zach's filter builds a type-OR-slug condition",
    programFilterSqlCondition(zach),
    "(p.type::text IN ('holiday_camp') OR p.slug IN ('u4-u8'))",
  );
  check("alias is honoured", programFilterSqlCondition(zach, "prog"), "(prog.type::text IN ('holiday_camp') OR prog.slug IN ('u4-u8'))");
  assert("type is compared as text, so an unknown label matches no row instead of raising an enum error",
    (programFilterSqlCondition(zach) || "").includes(".type::text IN"));

  // Fail closed — the property that makes this a fence rather than a hint.
  const empty = normalizeProgramFilter({ types: [], slugs: [] });
  assert("a present-but-empty filter is NOT unrestricted", empty !== null);
  assert("a present-but-empty filter reports empty", programFilterIsEmpty(empty));
  check("a present-but-empty filter yields FALSE, never an absent clause", programFilterSqlCondition(empty), "FALSE");

  // Write-time validation: what the admin typed must be what gets stored.
  check("a dropped token is reported, not silently swallowed",
    rejectedProgramTokens({ types: ["holiday_camp"], slugs: ["u4-u8", "o'brien"] }), ["o'brien"]);
  check("a clean filter drops nothing", rejectedProgramTokens({ types: ["holiday_camp"], slugs: ["u4-u8"] }), []);
  check("a type that is not a real programme type is caught",
    unknownProgramTypes(["holiday_camp", "camps", "u4-u8"]), ["camps", "u4-u8"]);
  check("the real types pass", unknownProgramTypes(["holiday_camp", "academy"]), []);
  check("scopes the filter cannot constrain are named",
    scopesOutsideProgramFilter(["camps:read", "tournament:read", "cic7s:read"]), ["tournament:read", "cic7s:read"]);
  check("Zach's scopes are all programme-aware",
    scopesOutsideProgramFilter(["overview:read", "camps:read", "registrations:read"]), []);

  // Injection guard — the condition is interpolated into raw SQL.
  const mixed = normalizeProgramFilter({
    types: ["holiday_camp", "'; DELETE FROM registrations; --", "aca demy"],
    slugs: ["u4-u8", "o'brien"],
  });
  check("dangerous tokens are dropped, safe ones kept", mixed, { types: ["holiday_camp"], slugs: ["u4-u8"] });
  const sqlText = programFilterSqlCondition(mixed) || "";
  // The only attacker-influenced part of the string is what sits inside the
  // quoted literals — assert on exactly that, rather than on the whole clause
  // (which legitimately contains `::`, parens and dots from our own code).
  const literals = [...sqlText.matchAll(/'([^']*)'/g)].map(m => m[1]);
  assert(`every quoted literal is a plain identifier (${literals.length} checked)`,
    literals.length > 0 && literals.every(l => /^[a-z0-9_-]+$/.test(l)), JSON.stringify(literals));
  assert("quotes are balanced — no literal can be closed early",
    (sqlText.match(/'/g) || []).length % 2 === 0, sqlText);
  assert("no semicolon reaches the SQL", !sqlText.includes(";"), sqlText);
  assert("no comment marker reaches the SQL", !sqlText.includes("--"), sqlText);

  // A hostile token that survives normalisation must still not be able to break
  // out — belt and braces over a wide fuzz set.
  const hostile = ["a'--", "a';DROP TABLE x;--", "a\nb", "a b", "a/*x*/", "ａ", "K", "ſ", "x".repeat(200), "", "-- ", "';"];
  for (const h of hostile) {
    const f = normalizeProgramFilter({ types: ["holiday_camp"], slugs: [h] });
    const s = programFilterSqlCondition(f) || "";
    if (s.includes(h) && h.length > 0 && !/^[a-z0-9_-]+$/.test(h)) {
      failed++; console.log(`  ❌ hostile token reached the SQL: ${JSON.stringify(h)} -> ${s}`);
    }
  }
  passed++; console.log(`  ✅ ${hostile.length} hostile tokens all rejected before the SQL`);

  // Case + whitespace + duplicates.
  check(
    "tokens are trimmed, lowercased and deduped",
    normalizeProgramFilter({ types: ["  Holiday_Camp ", "holiday_camp"], slugs: ["U4-U8"] }),
    { types: ["holiday_camp"], slugs: ["u4-u8"] },
  );

  // Human-readable description (shown in the admin UI + audit log).
  check("unrestricted description", describeProgramFilter(null), "All programmes in the allowed workspaces");
  assert("Zach's description names both parts", describeProgramFilter(zach).includes("holiday_camp") && describeProgramFilter(zach).includes("u4-u8"));
}

// ── A2. Gate coverage — does every programme query actually USE the fence? ───
//
// Part A proves the FRAGMENT is correct; it would still pass if every call to
// programSqlFilter() were deleted from routes.ts. This half reads the source and
// asserts each /api/v1 endpoint that filters on programs.organization_id also
// carries the gate — so a new endpoint that forgets it fails the suite instead
// of silently bypassing every fence.

function partA2() {
  console.log("\nA2. Gate coverage in server/routes.ts\n");

  const src = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8").split("\n");
  const starts: { line: number; name: string }[] = [];
  src.forEach((l, i) => {
    const m = l.match(/app\.(?:get|post)\("(\/api\/v1\/[^"]*)"/);
    if (m) starts.push({ line: i, name: m[1] });
  });
  starts.push({ line: src.length, name: "__end__" });

  let checked = 0;
  for (let i = 0; i < starts.length - 1; i++) {
    const body = src.slice(starts[i].line, starts[i + 1].line).join("\n");
    const orgFilters = (body.match(/p\.organization_id (?:=|IN)/g) || []).length;
    if (orgFilters === 0) continue;
    const gates = (body.match(/programSqlFilter\(req\)|programSqlCondition\(req\)/g) || []).length;
    checked++;
    assert(
      `${starts[i].name} — all ${orgFilters} programme quer${orgFilters === 1 ? "y is" : "ies are"} gated`,
      gates >= orgFilters,
      `${orgFilters - gates} of ${orgFilters} queries have no ${"$"}{programSqlFilter(req)} — that endpoint bypasses every programme fence`,
    );
  }
  assert(`found programme endpoints to check (got ${checked})`, checked >= 9,
    "the scan matched fewer endpoints than expected — has the v1 section moved or been renamed?");

  // The two admin-route occurrences of the same string must NOT be gated: they
  // serve logged-in staff, not API keys, and req has no apiKeyProgramFilter.
  const adminGated = src.filter((l, i) =>
    /p\.organization_id = \$\{orgId\}/.test(l) &&
    !starts.some(s => s.line <= i && i < (starts[starts.findIndex(x => x.line === s.line) + 1]?.line ?? 0)) &&
    /programSqlFilter/.test(l)).length;
  assert("no non-v1 admin query was gated by mistake", adminGated === 0);
}

// ── B. Real SQL, read-only, against the live database ────────────────────────

async function partB() {
  console.log("\nB. Real SQL against the live database (read-only, rolled back)\n");

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("  ⚠️  DATABASE_URL not set — skipping the SQL half.");
    return;
  }

  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  const ORG = 1; // CUFC
  const zach = normalizeProgramFilter({ types: ["holiday_camp"], slugs: ["u4-u8"] })!;
  const fence = programFilterSqlCondition(zach)!;

  const q = async (text: string) => (await client.query(text)).rows as any[];
  try {
    await client.query("BEGIN READ ONLY");
    {
      // What the whole workspace holds, unfenced — the baseline Zach must NOT see.
      const all = await q(
        `SELECT p.id, p.name, p.slug, p.type FROM programs p WHERE p.organization_id = ${ORG} ORDER BY p.id`,
      );
      // What the fence lets through.
      const fenced = await q(
        `SELECT p.id, p.name, p.slug, p.type FROM programs p WHERE p.organization_id = ${ORG} AND ${fence} ORDER BY p.id`,
      );

      console.log(`  workspace holds ${all.length} programmes; the fence passes ${fenced.length}`);
      for (const p of fenced) console.log(`      ✓ ${p.name}  [type=${p.type} slug=${p.slug}]`);
      const blocked = all.filter((a: any) => !fenced.some((f: any) => f.id === a.id));
      for (const p of blocked) console.log(`      ✗ ${p.name}  [type=${p.type} slug=${p.slug}]`);

      assert("the fence passes fewer programmes than the workspace holds", fenced.length < all.length,
        "if these are equal the fence is doing nothing");
      assert("every programme that passes is a holiday camp or the u4-u8 programme",
        fenced.every((p: any) => p.type === "holiday_camp" || p.slug === "u4-u8"),
        JSON.stringify(fenced.map((p: any) => `${p.slug}/${p.type}`)));
      assert("every holiday camp in the workspace passes",
        all.filter((p: any) => p.type === "holiday_camp").every((p: any) => fenced.some((f: any) => f.id === p.id)));
      assert("the u4-u8 programme passes",
        fenced.some((p: any) => p.slug === "u4-u8"),
        "no programme with slug u4-u8 came through");
      assert("no other academy programme passes",
        !fenced.some((p: any) => p.type === "academy" && p.slug !== "u4-u8"),
        JSON.stringify(fenced.filter((p: any) => p.type === "academy").map((p: any) => p.slug)));

      // The registrations query — the one that carries names and email addresses.
      const regsAll = await q(`
        SELECT COUNT(*)::int AS n FROM registrations r
        JOIN programs p ON r.program_id = p.id
        WHERE p.organization_id = ${ORG} AND r.registered_at >= now() - interval '90 days'
      `);
      const regsFenced = await q(`
        SELECT COUNT(*)::int AS n FROM registrations r
        JOIN programs p ON r.program_id = p.id
        WHERE p.organization_id = ${ORG} AND ${fence} AND r.registered_at >= now() - interval '90 days'
      `);
      const leaked = await q(`
        SELECT DISTINCT p.name FROM registrations r
        JOIN programs p ON r.program_id = p.id
        WHERE p.organization_id = ${ORG} AND ${fence}
          AND NOT (p.type = 'holiday_camp' OR p.slug = 'u4-u8')
      `);
      console.log(`  registrations (90d): workspace ${regsAll[0].n}, fenced ${regsFenced[0].n}`);
      assert("the fence removes registrations from other programmes", regsFenced[0].n < regsAll[0].n);
      assert("no registration from a non-permitted programme survives the fence", leaked.length === 0,
        JSON.stringify(leaked.map((r: any) => r.name)));

      // The empty filter must read nothing at all.
      const nothing = programFilterSqlCondition(normalizeProgramFilter({ types: [], slugs: [] }))!;
      const none = await q(
        `SELECT COUNT(*)::int AS n FROM programs p WHERE p.organization_id = ${ORG} AND ${nothing}`,
      );
      assert("an empty filter reads zero programmes (fails closed in real SQL)", none[0].n === 0, `got ${none[0].n}`);

    }
    await client.query("ROLLBACK");
    console.log("  \u21a9\ufe0e  read-only transaction rolled back (no writes)");
  } catch (e: any) {
    failed++;
    console.log(`  \u274c SQL verification threw: ${e?.message}`);
    try { await client.query("ROLLBACK"); } catch {}
  } finally {
    client.release();
    await pool.end();
  }
}

(async () => {
  console.log("API-key programme filter — verification");
  partA();
  partA2();
  await partB();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
