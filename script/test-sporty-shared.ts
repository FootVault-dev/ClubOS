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
  nzRegionForCity,
  missingAddressParts,
  sportyGenderFor,
  sportyPayloadHash,
  sportyEnvironmentFor,
  isSportyProduction,
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

// A faithful EXCERPT of Sporty's REAL UAT vocabulary (pulled 2026-07-27), not
// our assumptions: FIFA-style country codes, European split in two, and the
// selection names that collide under substring matching.
const REF: SportyReferenceData = {
  countries: [
    { CountryCode: "NZL", CountryName: "New Zealand" },
    { CountryCode: "AUS", CountryName: "Australia" },
    { CountryCode: "GBR", CountryName: "United Kingdom" },
    { CountryCode: "ENG", CountryName: "England" },
    { CountryCode: "SCO", CountryName: "Scotland" },
    { CountryCode: "SAM", CountryName: "Samoa" },
    { CountryCode: "TGA", CountryName: "Tonga" },
    { CountryCode: "RSA", CountryName: "South Africa" },
    { CountryCode: "NED", CountryName: "Netherlands" },
    { CountryCode: "GER", CountryName: "Germany" },
    { CountryCode: "KOR", CountryName: "Korea Republic" },
    { CountryCode: "USA", CountryName: "USA" },
    { CountryCode: "FIJ", CountryName: "Fiji" },
    { CountryCode: "IRN", CountryName: "Iran" },
    { CountryCode: "BRA", CountryName: "Brazil" },
  ],
  genders: ["Male","Female","Non-binary"],
  ethnicityGroups: [
    {
      EthnicityGroupId: 1,
      EthnicityGroupName: "NZ European",
      MinimumSelectionsRequired: 0,
      MaximumSelectionsRequired: 0,
      EthnicityGroupSelections: [
      ],
    },
    {
      EthnicityGroupId: 7,
      EthnicityGroupName: "Other European",
      MinimumSelectionsRequired: 1,
      MaximumSelectionsRequired: 2,
      EthnicityGroupSelections: [
        { EthnicityGroupSelectionId: 210, EthnicityGroupSelectionName: "British" },
        { EthnicityGroupSelectionId: 235, EthnicityGroupSelectionName: "French" },
        { EthnicityGroupSelectionId: 272, EthnicityGroupSelectionName: "Russian" },
        { EthnicityGroupSelectionId: 206, EthnicityGroupSelectionName: "Belorussian" },
        { EthnicityGroupSelectionId: 195, EthnicityGroupSelectionName: "Afrikaner" },
      ],
    },
    {
      EthnicityGroupId: 2,
      EthnicityGroupName: "Māori",
      MinimumSelectionsRequired: 0,
      MaximumSelectionsRequired: 4,
      EthnicityGroupSelections: [
        { EthnicityGroupSelectionId: 8, EthnicityGroupSelectionName: "Ngāi Tahu / Kāi Tahu" },
        { EthnicityGroupSelectionId: 28, EthnicityGroupSelectionName: "Ngāti Kahu" },
        { EthnicityGroupSelectionId: 16, EthnicityGroupSelectionName: "Ngāpuhi ki Whaingaroa-Ngāti Kahu ki Whaingaroa" },
        { EthnicityGroupSelectionId: 52, EthnicityGroupSelectionName: "Ngāti Porou" },
      ],
    },
    {
      EthnicityGroupId: 3,
      EthnicityGroupName: "Pacific Peoples",
      MinimumSelectionsRequired: 1,
      MaximumSelectionsRequired: 2,
      EthnicityGroupSelections: [
        { EthnicityGroupSelectionId: 145, EthnicityGroupSelectionName: "Samoan" },
        { EthnicityGroupSelectionId: 149, EthnicityGroupSelectionName: "Tongan" },
        { EthnicityGroupSelectionId: 135, EthnicityGroupSelectionName: "Fijian" },
      ],
    },
    {
      EthnicityGroupId: 4,
      EthnicityGroupName: "Asian",
      MinimumSelectionsRequired: 1,
      MaximumSelectionsRequired: 2,
      EthnicityGroupSelections: [
        { EthnicityGroupSelectionId: 165, EthnicityGroupSelectionName: "Indian" },
        { EthnicityGroupSelectionId: 153, EthnicityGroupSelectionName: "Anglo Indian" },
        { EthnicityGroupSelectionId: 162, EthnicityGroupSelectionName: "Fijian Indian" },
        { EthnicityGroupSelectionId: 166, EthnicityGroupSelectionName: "Indian Tamil" },
        { EthnicityGroupSelectionId: 160, EthnicityGroupSelectionName: "Chinese" },
        { EthnicityGroupSelectionId: 159, EthnicityGroupSelectionName: "Cambodian Chinese" },
        { EthnicityGroupSelectionId: 170, EthnicityGroupSelectionName: "Korean" },
      ],
    },
    {
      EthnicityGroupId: 6,
      EthnicityGroupName: "MELAA",
      MinimumSelectionsRequired: 1,
      MaximumSelectionsRequired: 2,
      EthnicityGroupSelections: [
        { EthnicityGroupSelectionId: 243, EthnicityGroupSelectionName: "Iranian/Persian" },
        { EthnicityGroupSelectionId: 286, EthnicityGroupSelectionName: "Syrian" },
        { EthnicityGroupSelectionId: 202, EthnicityGroupSelectionName: "Assyrian" },
      ],
    },
    {
      EthnicityGroupId: 5,
      EthnicityGroupName: "Other",
      MinimumSelectionsRequired: 1,
      MaximumSelectionsRequired: 2,
      EthnicityGroupSelections: [
        { EthnicityGroupSelectionId: 296, EthnicityGroupSelectionName: "New Zealander" },
        { EthnicityGroupSelectionId: 294, EthnicityGroupSelectionName: "Other Ethnicity" },
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
  assert.equal(resolveCountryCode("Narnia", REF), null);
  assert.equal(resolveCountryCode(""), null);
  assert.equal(resolveCountryCode("XYZ", REF), null); // unknown code rejected against ref
  assert.deepEqual(resolveCountryCode("Sāmoa", REF), { code: "SAM", provisional: false }); // diacritics
});

test("their codes are FIFA/IOC-style, not ISO — we read codes off THEIR list", () => {
  // Verified live 2026-07-27. Hard-coding the ISO code would send a country
  // their system does not have.
  assert.deepEqual(resolveCountryCode("Samoa", REF), { code: "SAM", provisional: false }); // ISO would be WSM
  assert.deepEqual(resolveCountryCode("Tonga", REF), { code: "TGA", provisional: false }); // ISO TON
  assert.deepEqual(resolveCountryCode("Fiji", REF), { code: "FIJ", provisional: false }); // ISO FJI
  assert.deepEqual(resolveCountryCode("South Africa", REF), { code: "RSA", provisional: false }); // ISO ZAF
  assert.deepEqual(resolveCountryCode("Germany", REF), { code: "GER", provisional: false }); // ISO DEU
  assert.deepEqual(resolveCountryCode("Netherlands", REF), { code: "NED", provisional: false }); // ISO NLD
  // The home nations are distinct from GBR in their list.
  assert.deepEqual(resolveCountryCode("England", REF), { code: "ENG", provisional: false });
  assert.deepEqual(resolveCountryCode("Scotland", REF), { code: "SCO", provisional: false });
  assert.deepEqual(resolveCountryCode("United Kingdom", REF), { code: "GBR", provisional: false });
  // Aliases resolve through their NAME, so they survive the ISO/FIFA difference.
  assert.deepEqual(resolveCountryCode("Holland", REF), { code: "NED", provisional: false });
  assert.deepEqual(resolveCountryCode("UK", REF), { code: "GBR", provisional: false });
  assert.deepEqual(resolveCountryCode("South Korea", REF), { code: "KOR", provisional: false });
  // An ISO code that is not one of theirs must not be passed through blindly.
  assert.equal(resolveCountryCode("WSM", REF), null);
  assert.equal(resolveCountryCode("ZAF", REF), null);
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
  assert.deepEqual(maori!.selectionIds, [8]); // "Ngāi Tahu / Kāi Tahu"

  const melaaNoSub = resolveEthnicity("Middle Eastern / Latin American / African", null, REF);
  assert.ok(melaaNoSub);
  assert.equal(melaaNoSub!.groupName, "MELAA");
  assert.ok(melaaNoSub!.selectionShortfall, "MELAA with no selection must report the shortfall");
  assert.equal(melaaNoSub!.selectionShortfall!.required, 1);

  const melaaWithSub = resolveEthnicity("Middle Eastern / Latin American / African", "Iranian", REF);
  assert.deepEqual(melaaWithSub!.selectionIds, [243]); // "Iranian/Persian"
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
  // "European" + "New Zealand European" settles to their NZ European group,
  // which takes NO selections (min 0, max 0).
  assert.equal(r.payload!.PrimaryEthnicityGroupName, "NZ European");
  assert.equal(r.payload!.PrimaryEthnicityGroupSelectionIds, undefined);
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

// ── Sub-ethnicity collisions (regressions found against live UAT, 2026-07-27) ─
// Substring-first matching silently registered real CUFC contacts under the
// wrong ethnicity. Exact match must always win.

test("exact sub-ethnicity beats a longer substring match", () => {
  // 3 real contacts say "Indian" — substring-first picked "Anglo Indian".
  assert.deepEqual(resolveEthnicity("Asian", "Indian", REF)!.selectionIds, [165]);
  // 2 real contacts say "Chinese" — substring-first picked "Cambodian Chinese".
  assert.deepEqual(resolveEthnicity("Asian", "Chinese", REF)!.selectionIds, [160]);
  // "Syrian" is a substring of "Assyrian".
  assert.deepEqual(resolveEthnicity("Middle Eastern / Latin American / African", "Syrian", REF)!.selectionIds, [286]);
  // "Russian" is a substring of "Belorussian".
  assert.deepEqual(resolveEthnicity("European", "Russian", REF)!.selectionIds, [272]);
  // A real contact says "Ngati Kahu" (no macrons); it is also inside a much
  // longer iwi name.
  assert.deepEqual(resolveEthnicity("Māori", "Ngati Kahu", REF)!.selectionIds, [28]);
});

test("a sub-ethnicity matching several options is refused, not guessed", () => {
  // "Ngāti" is inside several iwi names — no single answer, so no answer.
  const many = resolveEthnicity("Māori", "Ngāti", REF);
  assert.ok(many!.selectionAmbiguity, "several iwi contain 'Ngāti' — must report ambiguity");
  assert.ok(many!.selectionAmbiguity!.candidates.length > 1);
  assert.deepEqual(many!.selectionIds, [], "nothing is sent when we cannot tell");

  // And it reaches the operator as a blocker naming the options, not a silent pick.
  const built = buildRegisterPerson({
    player: { ...ADULT, ethnicity: "Māori", subEthnicity: "Ngāti" },
    guardian: null,
    ref: REF,
    todayIso: "2026-07-27",
  });
  assert.equal(built.payload, null);
  assert.ok(built.issues.some((i) => i.code === "ethnicity_selection_ambiguous" && i.severity === "blocker"));

  // A partial like "Indian Tam" sits between "Indian" and "Indian Tamil" — also refused.
  assert.ok(resolveEthnicity("Asian", "Indian Tam", REF)!.selectionAmbiguity);
  // But a loose match with exactly ONE candidate still resolves: precision, not
  // paranoia (covered above by "Ngai Tahu" → "Ngāi Tahu / Kāi Tahu" and
  // "Iranian" → "Iranian/Persian").
});

// ── The European split (their vocabulary has no "European" group) ────────────

test("bare 'European' is refused — their list has NZ European AND Other European", () => {
  const r = resolveEthnicity("European", null, REF);
  assert.ok(r);
  assert.ok(r!.groupAmbiguity, "must report the group ambiguity rather than pick one");
  assert.deepEqual(r!.groupAmbiguity!.candidates.sort(), ["NZ European", "Other European"]);

  const built = buildRegisterPerson({
    player: { ...ADULT, subEthnicity: null },
    guardian: null,
    ref: REF,
    todayIso: "2026-07-27",
  });
  assert.equal(built.payload, null, "an ambiguous ethnicity must block the push");
  assert.ok(built.issues.some((i) => i.code === "ethnicity_group_ambiguous" && i.severity === "blocker"));
});

test("the sub-ethnicity settles the European split", () => {
  // Names the group outright.
  assert.equal(resolveEthnicity("European", "New Zealand European", REF)!.groupName, "NZ European");
  assert.equal(resolveEthnicity("European", "Pākehā", REF)!.groupName, "NZ European");
  // Matches a selection that exists in only one of the two groups.
  const british = resolveEthnicity("European", "British", REF);
  assert.equal(british!.groupName, "Other European");
  assert.deepEqual(british!.selectionIds, [210]);
  const french = resolveEthnicity("European", "French", REF); // a real contact's value
  assert.equal(french!.groupName, "Other European");
  assert.deepEqual(french!.selectionIds, [235]);
});

test("'Other Ethnicity' maps to their 'Other' group and satisfies its min-1 rule", () => {
  // Their group is called "Other"; its selection 294 is literally "Other
  // Ethnicity", so the translation is faithful, not invented.
  const r = resolveEthnicity("Other Ethnicity", null, REF);
  assert.ok(r, "must resolve — 4 real contacts carry this value");
  assert.equal(r!.groupName, "Other");
  assert.deepEqual(r!.selectionIds, [294]);
  assert.equal(r!.selectionShortfall, undefined);
});

// ── Address (rules proved against live UAT, 2026-07-27) ─────────────────────

test("a leading 4-digit street number is never read as a postcode", () => {
  // Real CUFC address that broke this: became postcode 1272 on "Courtenay Road".
  const a = parseNzAddress("1272 Courtenay Road")!.address;
  assert.equal(a.AlphaPostCode, undefined);
  assert.equal(a.StreetAddress, "1272 Courtenay Road");
  // A trailing postcode is still found, and the street number left alone.
  const b = parseNzAddress("1272 Courtenay Road, Kirwee, Christchurch 7473")!.address;
  assert.equal(b.AlphaPostCode, "7473");
  assert.equal(b.StreetAddress, "1272 Courtenay Road");
});

test("region is derived from the city, and unknown cities yield none", () => {
  assert.equal(nzRegionForCity("Christchurch"), "Canterbury");
  assert.equal(nzRegionForCity("Rolleston"), "Canterbury");
  assert.equal(nzRegionForCity("christchurch cbd"), "Canterbury"); // city inside free text
  assert.equal(nzRegionForCity("Dunedin"), "Otago");
  assert.equal(nzRegionForCity("Whangārei"), "Northland"); // macrons normalised
  assert.equal(nzRegionForCity("Springfield, Ohio"), null);
  assert.equal(nzRegionForCity(""), null);
  assert.equal(parseNzAddress("1 Test St, Riccarton, Christchurch 8041")!.address.Region, "Canterbury");
});

test("all six address parts are required, and the missing ones are named", () => {
  assert.deepEqual(missingAddressParts({ StreetAddress: "1 A St", Suburb: "S", City: "Christchurch", Region: "Canterbury", AlphaPostCode: "8041", Country: "New Zealand" }), []);
  assert.deepEqual(missingAddressParts({ StreetAddress: "1 A St", Country: "New Zealand" }), ["suburb", "city or town", "region", "postcode"]);
  assert.deepEqual(missingAddressParts(null).length, 6);

  // A bare street line is a blocker naming exactly what is absent — not a
  // cryptic "Address is required." from NZF after the fact.
  const r = buildRegisterPerson({
    player: { ...ADULT, address: "23C Juniper Place" }, // a real CUFC address
    guardian: null,
    ref: REF,
    todayIso: "2026-07-27",
  });
  assert.equal(r.payload, null);
  const issue = r.issues.find((i) => i.code === "address_incomplete");
  assert.ok(issue && issue.severity === "blocker");
  assert.ok(issue!.message.includes("suburb"));
  assert.ok(issue!.message.includes("postcode"));
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

// ── Environment namespacing ─────────────────────────────────────────────────
// A SportyId only means something in the environment that issued it, and the
// doctrine sends stored ids on every later push — so mislabelling UAT as
// production would send a test id to the real national register.

test("production is an explicit allowlist; UAT and anything unknown are not", () => {
  assert.equal(sportyEnvironmentFor("https://www.sporty.co.nz"), "prod");
  assert.equal(sportyEnvironmentFor("https://sporty.co.nz"), "prod");
  assert.equal(sportyEnvironmentFor("https://uat.sporty.co.nz"), "uat");
  assert.equal(sportyEnvironmentFor("https://UAT.Sporty.co.nz/"), "uat");
  assert.equal(isSportyProduction("https://www.sporty.co.nz"), true);
  assert.equal(isSportyProduction("https://uat.sporty.co.nz"), false);
});

test("an unrecognised host gets its own namespace — never 'prod' by accident", () => {
  // A mock, a staging host, a typo: all must be quarantined from prod ids.
  assert.equal(sportyEnvironmentFor("http://localhost:4599"), "localhost-4599");
  assert.equal(sportyEnvironmentFor("https://staging.sporty.co.nz"), "staging-sporty-co-nz");
  assert.equal(sportyEnvironmentFor("https://sporty.co.nz.evil.example"), "sporty-co-nz-evil-example");
  assert.equal(sportyEnvironmentFor(""), "unknown");
  assert.equal(sportyEnvironmentFor(null), "unknown");
  for (const v of ["http://localhost:4599", "https://staging.sporty.co.nz", "", null]) {
    assert.equal(isSportyProduction(v), false);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
