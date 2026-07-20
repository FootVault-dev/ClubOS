// Unit tests for shared/sporty.ts — the mapper, validators, error taxonomy and
// hashing that decide what reaches NZ Football's national register.
//   npx tsx script/test-sporty-shared.ts

import assert from "node:assert";
import {
  buildRegisterPerson,
  classifySportyError,
  blockReasonFor,
  dobIsoDateOnly,
  isMinorOn,
  normalizeName,
  parseNzAddress,
  resolveCountryCode,
  resolveEthnicity,
  sportyGenderFor,
  sportyPayloadHash,
  type SportyBuildPlayer,
  type SportyReferenceData,
} from "../shared/sporty";

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (e: any) {
    failed++;
    process.exitCode = 1;
    console.error(`✗ ${name}\n  ${e?.message || e}`);
  }
}

const REF: SportyReferenceData = {
  countries: [
    { CountryCode: "NZL", CountryName: "New Zealand" },
    { CountryCode: "AUS", CountryName: "Australia" },
    { CountryCode: "GBR", CountryName: "United Kingdom" },
    { CountryCode: "WSM", CountryName: "Samoa" },
  ],
  genders: ["Male", "Female", "Non-binary"],
  ethnicityGroups: [
    {
      EthnicityGroupId: 1,
      EthnicityGroupName: "European",
      MinimumSelectionsRequired: 0,
      MaximumSelectionsRequired: 3,
      EthnicityGroupSelections: [
        { EthnicityGroupSelectionId: 101, EthnicityGroupSelectionName: "New Zealand European" },
        { EthnicityGroupSelectionId: 102, EthnicityGroupSelectionName: "British" },
      ],
    },
    {
      EthnicityGroupId: 2,
      EthnicityGroupName: "Māori",
      MinimumSelectionsRequired: 0,
      MaximumSelectionsRequired: 3,
      EthnicityGroupSelections: [{ EthnicityGroupSelectionId: 201, EthnicityGroupSelectionName: "Ngāi Tahu" }],
    },
    {
      EthnicityGroupId: 5,
      EthnicityGroupName: "MELAA",
      MinimumSelectionsRequired: 1,
      MaximumSelectionsRequired: 2,
      EthnicityGroupSelections: [
        { EthnicityGroupSelectionId: 501, EthnicityGroupSelectionName: "Middle Eastern" },
        { EthnicityGroupSelectionId: 502, EthnicityGroupSelectionName: "Latin American" },
        { EthnicityGroupSelectionId: 503, EthnicityGroupSelectionName: "African" },
      ],
    },
  ],
};

// ── Error taxonomy ──────────────────────────────────────────────────────────

test("classifies every documented error message", () => {
  assert.equal(classifySportyError("Player already registered"), "already_registered");
  assert.equal(classifySportyError("Overseas clearance is required"), "overseas_clearance");
  assert.equal(classifySportyError("Termination required from Cashmere Technical"), "termination_required");
  assert.equal(classifySportyError("Player is red flagged, Unpaid fees for Mainland Football"), "red_flag");
  assert.equal(classifySportyError("Invalid SportyId"), "invalid_sporty_id");
  assert.equal(classifySportyError("First Name is required"), "validation");
  assert.equal(classifySportyError("At least 1 selection(s) required for MELAA"), "validation");
  assert.equal(classifySportyError(null), "validation");
});

test("block reasons only for the created-but-inactive states", () => {
  assert.equal(blockReasonFor("overseas_clearance"), "overseas_clearance");
  assert.equal(blockReasonFor("termination_required"), "termination_required");
  assert.equal(blockReasonFor("red_flag"), "red_flag");
  assert.equal(blockReasonFor("already_registered"), null);
  assert.equal(blockReasonFor("validation"), null);
});

// ── Gender ──────────────────────────────────────────────────────────────────

test("gender maps male/female and refuses to guess 'other'", () => {
  assert.equal(sportyGenderFor("male"), "Male");
  assert.equal(sportyGenderFor("female", REF), "Female");
  assert.equal(sportyGenderFor("other"), null);
  assert.equal(sportyGenderFor(null), null);
  assert.equal(sportyGenderFor("male", { genders: ["Female"] }), null); // not in ref → refuse
});

// ── Countries ───────────────────────────────────────────────────────────────

test("country resolution: names, codes, aliases, provisional flags", () => {
  assert.deepEqual(resolveCountryCode("New Zealand", REF), { code: "NZL", provisional: false });
  assert.deepEqual(resolveCountryCode("NZL", REF), { code: "NZL", provisional: false });
  assert.deepEqual(resolveCountryCode("nz"), { code: "NZL", provisional: true }); // alias, no ref
  assert.deepEqual(resolveCountryCode("England", REF), { code: "GBR", provisional: false }); // alias confirmed by ref
  assert.equal(resolveCountryCode("Narnia", REF), null);
  assert.equal(resolveCountryCode(""), null);
  assert.equal(resolveCountryCode("XYZ", REF), null); // unknown alpha-3 rejected against ref
  assert.deepEqual(resolveCountryCode("Sāmoa", REF), { code: "WSM", provisional: false }); // diacritics
});

// ── Ethnicity ───────────────────────────────────────────────────────────────

test("ethnicity: provisional fallback without reference data", () => {
  const r = resolveEthnicity("Middle Eastern / Latin American / African", null);
  assert.ok(r);
  assert.equal(r!.groupName, "MELAA");
  assert.equal(r!.provisional, true);
});

test("ethnicity: matches Sporty groups incl. diacritics + MELAA min-selection shortfall", () => {
  const maori = resolveEthnicity("Māori", "Ngai Tahu", REF); // sub without macron still matches
  assert.ok(maori && !maori.provisional);
  assert.deepEqual(maori!.selectionIds, [201]);

  const melaaNoSub = resolveEthnicity("Middle Eastern / Latin American / African", null, REF);
  assert.ok(melaaNoSub);
  assert.equal(melaaNoSub!.groupName, "MELAA");
  assert.ok(melaaNoSub!.selectionShortfall, "MELAA with no selection must report the shortfall");
  assert.equal(melaaNoSub!.selectionShortfall!.required, 1);

  const melaaWithSub = resolveEthnicity("Middle Eastern / Latin American / African", "Latin American", REF);
  assert.deepEqual(melaaWithSub!.selectionIds, [502]);
  assert.equal(melaaWithSub!.selectionShortfall, undefined);

  assert.equal(resolveEthnicity("Klingon", null, REF), null);
  assert.equal(resolveEthnicity(null, null, REF), null);
});

// ── Address ─────────────────────────────────────────────────────────────────

test("address: street/suburb/city/postcode split", () => {
  const r = parseNzAddress("12 Aynsley Terrace, Hillsborough, Christchurch 8022");
  assert.ok(r && r.confident);
  assert.equal(r!.address.StreetAddress, "12 Aynsley Terrace");
  assert.equal(r!.address.Suburb, "Hillsborough");
  assert.equal(r!.address.City, "Christchurch");
  assert.equal(r!.address.AlphaPostCode, "8022");
  assert.equal(r!.address.Country, "New Zealand");
});

test("address: last 4-digit token wins as postcode (street numbers don't)", () => {
  const r = parseNzAddress("1234 Main Road, Redwood, Christchurch, 8051");
  assert.equal(r!.address.AlphaPostCode, "8051");
  assert.equal(r!.address.StreetAddress, "1234 Main Road");
});

test("address: trailing country stripped; single-line stays unconfident", () => {
  const withCountry = parseNzAddress("5 High Street, Rangiora, New Zealand");
  assert.equal(withCountry!.address.City, "Rangiora");
  const single = parseNzAddress("14b Kahu Road Christchurch");
  assert.ok(single && !single.confident);
  assert.equal(single!.address.StreetAddress, "14b Kahu Road Christchurch");
  assert.equal(parseNzAddress("   "), null);
});

// ── Dates / minors ──────────────────────────────────────────────────────────

test("minor determination is calendar-exact", () => {
  assert.equal(isMinorOn("2008-07-21", "2026-07-21"), false); // 18th birthday today
  assert.equal(isMinorOn("2008-07-22", "2026-07-21"), true); // 18 tomorrow
  assert.equal(isMinorOn("2017-01-01", "2026-07-21"), true);
  assert.equal(isMinorOn("1990-01-01", "2026-07-21"), false);
  assert.equal(isMinorOn("garbage", "2026-07-21"), null);
});

test("DOB is sent date-only, never a timestamp", () => {
  assert.equal(dobIsoDateOnly("2010-03-25"), "2010-03-25");
  assert.equal(dobIsoDateOnly("2010-03-25T00:00:00.000Z"), "2010-03-25");
  assert.equal(dobIsoDateOnly("25/03/2010"), null);
  assert.equal(dobIsoDateOnly(null), null);
});

test("normalizeName strips macrons and punctuation", () => {
  assert.equal(normalizeName("Māori"), "maori");
  assert.equal(normalizeName("Middle Eastern / Latin American / African"), "middleeasternlatinamericanafrican");
});

// ── buildRegisterPerson ─────────────────────────────────────────────────────

const ADULT: SportyBuildPlayer = {
  id: 42,
  firstName: "Jane",
  lastName: "Smith",
  dateOfBirth: "1995-04-10",
  gender: "female",
  email: "jane@example.com",
  phone: "0210001111",
  address: "1 Test Street, Riccarton, Christchurch 8041",
  nationality: "New Zealand",
  countryOfBirth: "New Zealand",
  ethnicity: "European",
  subEthnicity: "New Zealand European",
  ethnicity2: null,
  subEthnicity2: null,
};

const GUARDIAN = {
  firstName: "Sam",
  lastName: "Jones",
  email: "sam@example.com",
  phone: "0219998888",
  address: "9 Guardian Way, Papanui, Christchurch 8053",
};

test("adult with complete data builds a full payload, no blockers", () => {
  const r = buildRegisterPerson({ player: ADULT, guardian: null, ref: REF, todayIso: "2026-07-21" });
  assert.ok(r.payload, JSON.stringify(r.issues));
  assert.equal(r.issues.filter((i) => i.severity === "blocker").length, 0);
  assert.equal(r.payload!.ExternalSystemId, "clubos:42");
  assert.equal(r.payload!.Gender, "Female");
  assert.equal(r.payload!.NationalityCode, "NZL");
  assert.equal(r.payload!.DateOfBirth, "1995-04-10");
  assert.deepEqual(r.payload!.PrimaryEthnicityGroupSelectionIds, [101]);
  assert.equal(r.payload!.Address.City, "Christchurch");
  assert.equal(r.payload!.SportyId, undefined); // no id known yet → CREATE
  assert.equal(r.isMinor, false);
  assert.equal(r.payload!.ParentGuardian1FirstName, undefined);
});

test("minor: guardian contact details fall back in, guardian fields required", () => {
  const child: SportyBuildPlayer = { ...ADULT, id: 43, dateOfBirth: "2015-06-01", email: null, phone: null, address: null };
  const r = buildRegisterPerson({ player: child, guardian: GUARDIAN, ref: REF, todayIso: "2026-07-21" });
  assert.ok(r.payload, JSON.stringify(r.issues));
  assert.equal(r.isMinor, true);
  assert.equal(r.payload!.Email, "sam@example.com");
  assert.equal(r.payload!.MobilePhone, "0219998888");
  assert.equal(r.payload!.Address.Suburb, "Papanui");
  assert.equal(r.payload!.ParentGuardian1FirstName, "Sam");
  assert.equal(r.payload!.ParentGuardian1Phone, "0219998888");
});

test("minor without a guardian is blocked, never guessed", () => {
  const child: SportyBuildPlayer = { ...ADULT, id: 44, dateOfBirth: "2015-06-01", email: null, phone: null };
  const r = buildRegisterPerson({ player: child, guardian: null, ref: REF, todayIso: "2026-07-21" });
  assert.equal(r.payload, null);
  const codes = r.issues.map((i) => i.code);
  assert.ok(codes.includes("missing_guardian_name"));
  assert.ok(codes.includes("missing_email"));
});

test("gender 'other' and unmappable countries are blockers with named fields", () => {
  const p: SportyBuildPlayer = { ...ADULT, id: 45, gender: "other", nationality: "Narnia", countryOfBirth: null };
  const r = buildRegisterPerson({ player: p, guardian: null, ref: REF, todayIso: "2026-07-21" });
  assert.equal(r.payload, null);
  const codes = r.issues.map((i) => i.code);
  assert.ok(codes.includes("gender_unmapped"));
  assert.ok(codes.includes("nationality_unresolved"));
  assert.ok(codes.includes("country_of_birth_unresolved"));
});

test("MELAA without a specific selection is a blocker (their min rule)", () => {
  const p: SportyBuildPlayer = { ...ADULT, id: 46, ethnicity: "Middle Eastern / Latin American / African", subEthnicity: null };
  const r = buildRegisterPerson({ player: p, guardian: null, ref: REF, todayIso: "2026-07-21" });
  assert.equal(r.payload, null);
  assert.ok(r.issues.some((i) => i.code === "ethnicity_selection_required"));
});

test("unresolvable second ethnicity is omitted with a warning, not fatal", () => {
  const p: SportyBuildPlayer = { ...ADULT, id: 47, ethnicity2: "Klingon", subEthnicity2: null };
  const r = buildRegisterPerson({ player: p, guardian: null, ref: REF, todayIso: "2026-07-21" });
  assert.ok(r.payload);
  assert.equal(r.payload!.SecondaryEthnicityGroupName, undefined);
  assert.ok(r.issues.some((i) => i.code === "ethnicity2_unresolved" && i.severity === "warning"));
});

test("a known SportyId rides the payload (update semantics)", () => {
  const r = buildRegisterPerson({ player: ADULT, guardian: null, sportyId: 90210, ref: REF, todayIso: "2026-07-21" });
  assert.equal(r.payload!.SportyId, 90210);
});

test("provisional mappings warn when reference data is absent", () => {
  const r = buildRegisterPerson({ player: ADULT, guardian: null, todayIso: "2026-07-21" });
  assert.ok(r.payload);
  const codes = r.issues.map((i) => i.code);
  assert.ok(codes.includes("nationality_provisional"));
  assert.ok(codes.includes("ethnicity_provisional"));
});

// ── Hashing ─────────────────────────────────────────────────────────────────

test("payload hash: stable across key order, blind to SportyId, sensitive to data", () => {
  const a = buildRegisterPerson({ player: ADULT, guardian: null, ref: REF, todayIso: "2026-07-21" }).payload!;
  const b = { ...a, SportyId: 12345 };
  assert.equal(sportyPayloadHash(a), sportyPayloadHash(b));
  const c = { ...a, MobilePhone: "0210002222" };
  assert.notEqual(sportyPayloadHash(a), sportyPayloadHash(c));
  const reordered = Object.fromEntries(Object.entries(a).reverse()) as typeof a;
  assert.equal(sportyPayloadHash(a), sportyPayloadHash(reordered));
});

console.log(`\n${passed} passed, ${failed} failed`);
