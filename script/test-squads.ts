// Pure-logic tests for shared/squads.ts.  Run: npx tsx script/test-squads.ts
import assert from "node:assert/strict";
import {
  SQUAD_ROLES, STAFF_ROLES, isSquadRole,
  POSITIONS, isPosition,
  SQUAD_BANDS, isSquadBand, bandForAgeGrade, squadSortKey,
  checkSquadEligibility, validateSquad, validateSquadMember, summariseRoster,
} from "../shared/squads";

let passed = 0;
function ok(name: string, fn: () => void) {
  try { fn(); passed++; }
  catch (e: any) { console.error(`FAIL: ${name}\n  ${e.message}`); process.exitCode = 1; }
}

// ── Roles ───────────────────────────────────────────────────────────────────
ok("seven roles", () => assert.equal(SQUAD_ROLES.length, 7));
ok("player is a role", () => assert.equal(isSquadRole("player"), true));
ok("staff excludes player", () => assert.equal(STAFF_ROLES.includes("player" as any), false));
ok("staff is six roles", () => assert.equal(STAFF_ROLES.length, 6));
ok("junk role rejected", () => assert.equal(isSquadRole("captain"), false));
ok("non-string role rejected", () => assert.equal(isSquadRole(1), false));

// ── Positions / bands ───────────────────────────────────────────────────────
ok("four positions", () => assert.equal(POSITIONS.length, 4));
ok("GK is a position", () => assert.equal(isPosition("GK"), true));
ok("striker is not", () => assert.equal(isPosition("ST"), false));
ok("three bands", () => assert.equal(SQUAD_BANDS.length, 3));
ok("band junk rejected", () => assert.equal(isSquadBand("reserves"), false));

ok("U9 → youth", () => assert.equal(bandForAgeGrade(9), "youth"));
ok("U12 → youth", () => assert.equal(bandForAgeGrade(12), "youth"));
ok("U13 → academy", () => assert.equal(bandForAgeGrade(13), "academy"));
ok("U17 → academy", () => assert.equal(bandForAgeGrade(17), "academy"));
ok("U20 → senior", () => assert.equal(bandForAgeGrade(20), "senior"));
ok("no grade → senior", () => assert.equal(bandForAgeGrade(null), "senior"));
ok("undefined grade → senior", () => assert.equal(bandForAgeGrade(undefined), "senior"));

// ── Sorting: First Team at the top, U9s at the foot ─────────────────────────
ok("senior sorts above youth", () => {
  assert.ok(squadSortKey({ ageGrade: null }) < squadSortKey({ ageGrade: 17 }));
});
ok("older youth sorts above younger", () => {
  assert.ok(squadSortKey({ ageGrade: 17 }) < squadSortKey({ ageGrade: 9 }));
});
ok("a real club ordering comes out right", () => {
  const squads = [
    { name: "U9", ageGrade: 9 }, { name: "First Team", ageGrade: null },
    { name: "U14", ageGrade: 14 }, { name: "NXT (U20)", ageGrade: 20 },
    { name: "U13", ageGrade: 13 },
  ];
  const order = [...squads].sort((a, b) => squadSortKey(a) - squadSortKey(b)).map((s) => s.name);
  assert.deepEqual(order, ["First Team", "NXT (U20)", "U14", "U13", "U9"]);
});
ok("an explicit displayOrder wins", () => assert.equal(squadSortKey({ ageGrade: 9, displayOrder: 3 }), 3));

// ── Eligibility — NZF grade = seasonYear − birthYear ────────────────────────
ok("born 2012 fits the U14s in 2026", () => {
  const r = checkSquadEligibility("2012-05-01", 2026, 14);
  assert.equal(r.eligible, true);
  assert.equal(r.grade, 14);
});
ok("a U13 may play UP into the U14s", () => {
  const r = checkSquadEligibility("2013-05-01", 2026, 14);
  assert.equal(r.eligible, true);
  assert.match(r.reason, /playing up/i);
});
ok("a U15 may NOT play DOWN into the U14s", () => {
  const r = checkSquadEligibility("2011-05-01", 2026, 14);
  assert.equal(r.eligible, false);
  assert.match(r.reason, /over age/i);
});
ok("senior squad has no age limit", () => {
  const r = checkSquadEligibility("1995-01-01", 2026, null);
  assert.equal(r.eligible, true);
  assert.match(r.reason, /no age limit/i);
});
ok("missing dob does not block, but says so", () => {
  const r = checkSquadEligibility("", 2026, 14);
  assert.equal(r.eligible, true);
  assert.match(r.reason, /no date of birth/i);
});
ok("1 January birthday is graded correctly (the toISOString trap)", () => {
  assert.equal(checkSquadEligibility("2012-01-01", 2026, 14).grade, 14);
});

// ── validateSquad ───────────────────────────────────────────────────────────
ok("a valid squad passes", () => assert.deepEqual(validateSquad({ name: "U14 Boys", seasonYear: 2026, ageGrade: 14, band: "academy" }), []));
ok("a senior squad may have no grade", () => assert.deepEqual(validateSquad({ name: "First Team", seasonYear: 2026, ageGrade: null }), []));
ok("name required", () => assert.match(validateSquad({ seasonYear: 2026 }).join(" "), /name/i));
ok("season required", () => assert.match(validateSquad({ name: "U14" }).join(" "), /season/i));
ok("silly season rejected", () => assert.match(validateSquad({ name: "U14", seasonYear: 1900 }).join(" "), /season/i));
ok("U3 rejected", () => assert.match(validateSquad({ name: "x", seasonYear: 2026, ageGrade: 3 }).join(" "), /age grade/i));
ok("U24 rejected", () => assert.match(validateSquad({ name: "x", seasonYear: 2026, ageGrade: 24 }).join(" "), /age grade/i));
ok("bad band rejected", () => assert.match(validateSquad({ name: "x", seasonYear: 2026, band: "reserves" }).join(" "), /band/i));

// ── validateSquadMember ─────────────────────────────────────────────────────
ok("a valid player passes", () => assert.deepEqual(validateSquadMember({ contactId: 5, role: "player", squadNumber: 7, position: "MF" }), []));
ok("a coach with no number passes", () => assert.deepEqual(validateSquadMember({ contactId: 5, role: "head_coach" }), []));
ok("contact required", () => assert.match(validateSquadMember({ role: "player" }).join(" "), /person/i));
ok("role required", () => assert.match(validateSquadMember({ contactId: 1 }).join(" "), /role/i));
ok("squad number 0 rejected", () => assert.match(validateSquadMember({ contactId: 1, role: "player", squadNumber: 0 }).join(" "), /1 and 99/));
ok("squad number 100 rejected", () => assert.match(validateSquadMember({ contactId: 1, role: "player", squadNumber: 100 }).join(" "), /1 and 99/));
ok("a coach cannot hold a squad number", () => {
  assert.match(validateSquadMember({ contactId: 1, role: "manager", squadNumber: 9 }).join(" "), /only players/i);
});
ok("a coach cannot hold a position", () => {
  assert.match(validateSquadMember({ contactId: 1, role: "physio", position: "GK" }).join(" "), /only players/i);
});
ok("bad position rejected", () => assert.match(validateSquadMember({ contactId: 1, role: "player", position: "ST" }).join(" "), /position/i));
ok("hostile payload does not throw", () => {
  assert.ok(validateSquadMember({ contactId: {}, role: [], squadNumber: "x", position: 3 } as any).length > 0);
});

// ── summariseRoster ─────────────────────────────────────────────────────────
ok("counts players and staff, ignoring departures", () => {
  const s = summariseRoster([
    { role: "player" }, { role: "player" }, { role: "head_coach" },
    { role: "player", leftAt: "2026-08-01" },
  ]);
  assert.deepEqual(s, { players: 2, staff: 1, total: 3, departed: 1 });
});
ok("an empty squad summarises to zeroes", () => {
  assert.deepEqual(summariseRoster([]), { players: 0, staff: 0, total: 0, departed: 0 });
});

console.log(`\n✅ squads: ${passed} assertions passed`);
if (process.exitCode) console.error("❌ some assertions failed");
