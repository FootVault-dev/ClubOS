// Standalone proof of the AttributionOS identity decision logic (T7). No DB / network.
//   npx tsx script/test-attribution-identity.ts
//
// Covers the pinned merge rules from AGENTS.md:
//   - email/phone normalisation (canonical lowercase email, digits+`+` phone)
//   - illegal ids + unreplaced macros are never usable identities
//   - decideVisitorBind matrix: anonymous→bind, same→noop, different→blocked_auto_merge
//
// NOTE: imports ONLY from shared/ (pure) — importing server/identity.ts would pull in
// ./db which throws without DATABASE_URL (Hard Rule 1). The DB layer is verified by build.

import {
  normalizeEmail,
  normalizePhone,
  normalizeIdentityValue,
  decideVisitorBind,
  isUsableIdentity,
} from "../shared/identity";

let pass = 0;
let fail = 0;
const fails: string[] = [];
function check(cond: boolean, msg: string) {
  if (cond) pass++;
  else {
    fail++;
    if (fails.length < 40) fails.push(msg);
  }
}
function eq(actual: unknown, expected: unknown, msg: string) {
  check(actual === expected, `${msg} — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

// ── normalizeEmail ──────────────────────────────────────────────────────────
eq(normalizeEmail("Daniel@Example.COM"), "daniel@example.com", "email lowercased");
eq(normalizeEmail("  parent@club.co.nz  "), "parent@club.co.nz", "email trimmed");
eq(normalizeEmail("a.b+tag@sub.domain.com"), "a.b+tag@sub.domain.com", "email plus/sub kept");
eq(normalizeEmail("notanemail"), null, "no @ → null");
eq(normalizeEmail("missing@domain"), null, "no dot in domain → null");
eq(normalizeEmail("two@@at.com"), null, "double @ → null");
eq(normalizeEmail("has space@x.com"), null, "space → null");
eq(normalizeEmail(""), null, "empty → null");
eq(normalizeEmail("   "), null, "whitespace → null");
eq(normalizeEmail(null), null, "null → null");
eq(normalizeEmail(undefined), null, "undefined → null");
eq(normalizeEmail("undefined"), null, "illegal id 'undefined' → null");
eq(normalizeEmail("null"), null, "illegal id 'null' → null");
eq(normalizeEmail("[object Object]"), null, "illegal id '[object Object]' → null");
eq(normalizeEmail("{{email}}"), null, "unreplaced macro → null");
eq(normalizeEmail(12345), null, "non-string → null");

// ── normalizePhone ──────────────────────────────────────────────────────────
eq(normalizePhone("+64 21 555 1234"), "+64215551234", "phone strips spaces, keeps +");
eq(normalizePhone("(021) 555-1234"), "0215551234", "phone strips brackets/dashes");
eq(normalizePhone("021 555 1234"), "0215551234", "phone strips spaces");
eq(normalizePhone("123"), null, "too short → null");
eq(normalizePhone(""), null, "empty phone → null");
eq(normalizePhone(null), null, "null phone → null");
eq(normalizePhone("undefined"), null, "illegal id phone → null");
eq(normalizePhone("{{phone}}"), null, "macro phone → null");

// ── normalizeIdentityValue (per kind) ───────────────────────────────────────
eq(normalizeIdentityValue("email", "Foo@Bar.com"), "foo@bar.com", "kind=email normalises");
eq(normalizeIdentityValue("phone", "+64 21 555 1234"), "+64215551234", "kind=phone normalises");
eq(normalizeIdentityValue("visitor", "  abc-123_DEF  "), "abc-123_DEF", "kind=visitor trims, keeps case");
eq(normalizeIdentityValue("visitor", "anonymous"), null, "kind=visitor illegal id → null");
eq(normalizeIdentityValue("visitor", "{{id}}"), null, "kind=visitor macro → null");
// @ts-expect-error — guarding an unexpected kind
eq(normalizeIdentityValue("bogus", "x"), null, "unknown kind → null");

// ── decideVisitorBind matrix ────────────────────────────────────────────────
const anon = decideVisitorBind({ existingPersonId: null, targetPersonId: 42 });
eq(anon.action, "bind", "anonymous visitor → bind");
eq(anon.audit, false, "anon bind writes no audit row");
eq(anon.reason, "anon_to_identified", "anon bind reason");

const same = decideVisitorBind({ existingPersonId: 42, targetPersonId: 42 });
eq(same.action, "noop", "same person → noop");
eq(same.audit, false, "noop writes no audit row");

const diff = decideVisitorBind({ existingPersonId: 7, targetPersonId: 99 });
eq(diff.action, "blocked_auto_merge", "two identified persons → blocked_auto_merge");
eq(diff.audit, true, "blocked merge writes an audit row");
eq(diff.reason, "blocked_auto_merge", "blocked merge reason");

const badTargetZero = decideVisitorBind({ existingPersonId: null, targetPersonId: 0 });
eq(badTargetZero.action, "invalid", "target id 0 → invalid");
const badTargetNeg = decideVisitorBind({ existingPersonId: null, targetPersonId: -3 });
eq(badTargetNeg.action, "invalid", "negative target id → invalid");
const badTargetFloat = decideVisitorBind({ existingPersonId: null, targetPersonId: 1.5 });
eq(badTargetFloat.action, "invalid", "non-integer target id → invalid");
// invalid target is checked BEFORE the existing binding, so it never mislabels a collision
const badTargetWithExisting = decideVisitorBind({ existingPersonId: 7, targetPersonId: 0 });
eq(badTargetWithExisting.action, "invalid", "invalid target wins over collision path");

// ── isUsableIdentity ────────────────────────────────────────────────────────
eq(isUsableIdentity("real-visitor-id-123"), true, "normal id usable");
eq(isUsableIdentity("guest"), false, "illegal id 'guest' not usable");
eq(isUsableIdentity(""), false, "empty not usable");
eq(isUsableIdentity("{{x}}"), false, "macro not usable");

// ── report ──────────────────────────────────────────────────────────────────
console.log(`\nattribution-identity: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("\nFailures:");
  for (const f of fails) console.error("  ✗ " + f);
  process.exit(1);
}
console.log("✓ all identity decision assertions passed");
