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
import {
  normalizeProgramFilter,
  programFilterSqlCondition,
  programFilterIsEmpty,
  describeProgramFilter,
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

  // Absence means unrestricted — every key that exists today.
  check("null is unrestricted", normalizeProgramFilter(null), null);
  check("undefined is unrestricted", normalizeProgramFilter(undefined), null);
  check("a bare object with neither key is unrestricted", normalizeProgramFilter({}), null);
  check("a non-object is unrestricted, not guessed at", normalizeProgramFilter("holiday_camp"), null);
  check("an array is unrestricted, not guessed at", normalizeProgramFilter(["holiday_camp"]), null);
  check("unrestricted produces no SQL clause", programFilterSqlCondition(null), null);

  // The real filter.
  const zach = normalizeProgramFilter({ types: ["holiday_camp"], slugs: ["u4-u8"] });
  check("Zach's filter normalises", zach, { types: ["holiday_camp"], slugs: ["u4-u8"] });
  check(
    "Zach's filter builds a type-OR-slug condition",
    programFilterSqlCondition(zach),
    "(p.type IN ('holiday_camp') OR p.slug IN ('u4-u8'))",
  );
  check("alias is honoured", programFilterSqlCondition(zach, "prog"), "(prog.type IN ('holiday_camp') OR prog.slug IN ('u4-u8'))");

  // Fail closed — the property that makes this a fence rather than a hint.
  const empty = normalizeProgramFilter({ types: [], slugs: [] });
  assert("a present-but-empty filter is NOT unrestricted", empty !== null);
  assert("a present-but-empty filter reports empty", programFilterIsEmpty(empty));
  check("a present-but-empty filter yields FALSE, never an absent clause", programFilterSqlCondition(empty), "FALSE");

  const allJunk = normalizeProgramFilter({ types: ["'; DROP TABLE programs; --"], slugs: ["../../etc"] });
  check("every token invalid → tokens dropped", allJunk, { types: [], slugs: [] });
  check("every token invalid → FALSE, never widened to all programmes", programFilterSqlCondition(allJunk), "FALSE");

  // Injection guard — the condition is interpolated into raw SQL.
  const mixed = normalizeProgramFilter({
    types: ["holiday_camp", "'; DELETE FROM registrations; --", "aca demy"],
    slugs: ["u4-u8", "o'brien"],
  });
  check("dangerous tokens are dropped, safe ones kept", mixed, { types: ["holiday_camp"], slugs: ["u4-u8"] });
  const sqlText = programFilterSqlCondition(mixed) || "";
  assert("no quote can escape the literal", !/[^a-z0-9_\-'(), .]/i.test(sqlText.replace(/p\.(type|slug) IN/g, "").replace(/ OR /g, "")), sqlText);
  assert("no semicolon reaches the SQL", !sqlText.includes(";"), sqlText);
  assert("no comment marker reaches the SQL", !sqlText.includes("--"), sqlText);

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
  await partB();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
