// Tests for the NZF identity vocabulary + validation.
//   npx tsx script/test-nzf-identity.ts
//
// These guard the decisions that made Sporty refuse a 495-person import on
// 28 July 2026, and the five ways the live API contradicted its own swagger.
// Every case below is a real failure mode observed in our own data or against
// the live UAT API — none are hypothetical.

import {
  NZF_COUNTRIES,
  NZF_ETHNICITY_GROUPS,
  NZ_REGIONS,
  countryByCode,
  countryByName,
  ethnicityGroupById,
  groupTakesNoSelections,
  validateNzfIdentity,
  validateNzfAddress,
  nzfIdentityGap,
  isNzfIdentityComplete,
} from "../shared/nzf-identity";
import { resolveStoredEthnicity, structuredAddressOf, buildRegisterPerson } from "../shared/sporty";

let pass = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: string) {
  if (cond) pass++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}
function eq<T>(name: string, actual: T, expected: T) {
  check(name, Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected),
    `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

const groupId = (name: string) => NZF_ETHNICITY_GROUPS.find((g) => g.name === name)!.id;
const selId = (group: string, sel: string) =>
  NZF_ETHNICITY_GROUPS.find((g) => g.name === group)!.selections.find((s) => s.name === sel)!.id;

// ── The vocabulary itself ───────────────────────────────────────────────────

check("vocabulary has 7 ethnicity groups", NZF_ETHNICITY_GROUPS.length === 7, `got ${NZF_ETHNICITY_GROUPS.length}`);
check("vocabulary has 200+ countries", NZF_COUNTRIES.length >= 200, `got ${NZF_COUNTRIES.length}`);

// 🔴 The whole reason bare "European" was unregisterable: NZF has two European
// groups and no plain one. If this ever collapses back to one, the form is
// asking a question NZF doesn't ask.
check("European is split into two groups, with no bare 'European'",
  !!NZF_ETHNICITY_GROUPS.find((g) => g.name === "NZ European") &&
  !!NZF_ETHNICITY_GROUPS.find((g) => g.name === "Other European") &&
  !NZF_ETHNICITY_GROUPS.some((g) => g.name === "European"));

// 🔴 FIFA/IOC codes, not ISO 3166-1 alpha-3. Sending WSM for Samoa or DEU for
// Germany is rejected.
eq("Samoa is SAM (FIFA), not WSM (ISO)", countryByName("Samoa")?.code, "SAM");
eq("Germany is GER (FIFA), not DEU (ISO)", countryByName("Germany")?.code, "GER");
check("New Zealand resolves", countryByCode("NZL")?.name === "New Zealand");
check("WSM (the ISO code for Samoa) is NOT a valid code", countryByCode("WSM") === null);

// NZ European takes no specific selection at all — asking for one invents a
// question, and sending one sends a value the group has no vocabulary for.
check("NZ European takes no selections", groupTakesNoSelections(groupId("NZ European")));
check("Māori takes optional iwi", ethnicityGroupById(groupId("Māori"))!.minSelections === 0);
check("Māori allows up to 4 iwi", ethnicityGroupById(groupId("Māori"))!.maxSelections === 4);
check("Asian requires at least one selection", ethnicityGroupById(groupId("Asian"))!.minSelections === 1);

// ── Country lookup is exact ─────────────────────────────────────────────────
check("country lookup is case-insensitive on the code", countryByCode("nzl")?.code === "NZL");
check("a near-miss country name returns null, never a best guess", countryByName("New Zealnd") === null);
check("empty country code returns null", countryByCode("") === null);

// ── Identity validation ─────────────────────────────────────────────────────

const validNzEuropean = {
  countryOfBirthCode: "NZL",
  nationalityCode: "NZL",
  ethnicityGroupId: groupId("NZ European"),
  ethnicitySelectionIds: [],
};
{
  const r = validateNzfIdentity(validNzEuropean);
  check("NZ European with no selections is valid", r.ok);
  if (r.ok) {
    eq("resolves the country NAME from the code", r.value.countryOfBirth, "New Zealand");
    eq("sub-ethnicity is null when the group takes none", r.value.subEthnicity, null);
  }
}

// 🔴 Regression: the exact shape that made 448 records unregisterable.
{
  const r = validateNzfIdentity({ countryOfBirthCode: "", nationalityCode: "", ethnicityGroupId: null });
  check("empty identity is rejected", !r.ok);
  if (!r.ok) eq("all three fields are reported", r.errors.length, 3);
}

// 🔴 Regression: "Christchurch" as a country of birth (a real value in our data).
{
  const r = validateNzfIdentity({ ...validNzEuropean, countryOfBirthCode: "Christchurch" });
  check("a city typed as a country is rejected", !r.ok);
}

// A group that requires a selection cannot be sent without one.
{
  const r = validateNzfIdentity({
    countryOfBirthCode: "NZL", nationalityCode: "NZL",
    ethnicityGroupId: groupId("Asian"), ethnicitySelectionIds: [],
  });
  check("Asian without a specific ethnicity is rejected", !r.ok);
  if (!r.ok) check("the error names the group", r.errors[0].includes("Asian"), r.errors[0]);
}
{
  const r = validateNzfIdentity({
    countryOfBirthCode: "NZL", nationalityCode: "NZL",
    ethnicityGroupId: groupId("Asian"), ethnicitySelectionIds: [selId("Asian", "Indian")],
  });
  check("Asian with one specific ethnicity is valid", r.ok);
  if (r.ok) eq("sub-ethnicity carries the chosen name", r.value.subEthnicity, "Indian");
}
// 🔴 The mis-registration this replaces: substring matching turned "Indian"
// into "Anglo Indian" for three real contacts. An id cannot do that.
{
  const indian = selId("Asian", "Indian");
  const anglo = selId("Asian", "Anglo Indian");
  check("Indian and Anglo Indian are distinct ids", indian !== anglo);
  const r = validateNzfIdentity({
    countryOfBirthCode: "NZL", nationalityCode: "NZL",
    ethnicityGroupId: groupId("Asian"), ethnicitySelectionIds: [indian],
  });
  check("choosing Indian yields exactly Indian", r.ok && r.value.subEthnicity === "Indian");
}

// Over the maximum is rejected rather than silently truncated.
{
  const asian = NZF_ETHNICITY_GROUPS.find((g) => g.name === "Asian")!;
  const r = validateNzfIdentity({
    countryOfBirthCode: "NZL", nationalityCode: "NZL",
    ethnicityGroupId: asian.id,
    ethnicitySelectionIds: asian.selections.slice(0, 3).map((s) => s.id),
  });
  check("3 selections where the max is 2 is rejected", !r.ok);
}

// A selection from the WRONG group is rejected — this is how a child would end
// up filed under an ethnicity nobody picked.
{
  const r = validateNzfIdentity({
    countryOfBirthCode: "NZL", nationalityCode: "NZL",
    ethnicityGroupId: groupId("Asian"),
    ethnicitySelectionIds: [selId("Pacific Peoples", "Fijian")],
  });
  check("a selection from another group is rejected", !r.ok);
}

// NZ European must not carry a selection.
{
  const r = validateNzfIdentity({
    ...validNzEuropean,
    ethnicitySelectionIds: [selId("Other European", "British")],
  });
  check("NZ European with a selection is rejected", !r.ok);
}

// Second ethnicity: optional, but valid if given, and never a repeat.
{
  const r = validateNzfIdentity({
    ...validNzEuropean,
    ethnicity2GroupId: groupId("Māori"),
    ethnicity2SelectionIds: [],
  });
  check("second ethnicity Māori with no iwi is valid (min 0)", r.ok);
  if (r.ok) eq("second group name is recorded", r.value.ethnicity2, "Māori");
}
{
  const r = validateNzfIdentity({ ...validNzEuropean, ethnicity2GroupId: groupId("NZ European") });
  check("a second ethnicity identical to the first is rejected", !r.ok);
}
{
  const r = validateNzfIdentity({ ...validNzEuropean, ethnicity2SelectionIds: [1] });
  check("a second specific ethnicity without a group is rejected", !r.ok);
}

// ── Address ─────────────────────────────────────────────────────────────────

const validAddress = {
  street: "12 Example Road", suburb: "Riccarton", city: "Christchurch",
  region: "Canterbury", postcode: "8041", country: "NZL",
};
check("a full NZ address is valid", validateNzfAddress(validAddress).ok);

// 🔴 The live API's own contradiction: Region is documented optional and is in
// fact mandatory. 111 of our 495 had no region.
{
  const r = validateNzfAddress({ ...validAddress, region: "" });
  check("a missing region is rejected", !r.ok);
  if (!r.ok) check("the error names New Zealand Football", r.errors[0].includes("New Zealand Football"), r.errors[0]);
}
for (const part of ["street", "suburb", "city", "postcode"] as const) {
  check(`a missing ${part} is rejected`, !validateNzfAddress({ ...validAddress, [part]: "" }).ok);
}
{
  const r = validateNzfAddress({ ...validAddress, region: "Canterberry" });
  check("a misspelt NZ region is rejected", !r.ok);
}
// An overseas address keeps a free-text region — enumerating the world's
// provinces is not ours to do.
check("an overseas region is free text",
  validateNzfAddress({ ...validAddress, country: "AUS", region: "Queensland" }).ok);
{
  const r = validateNzfAddress(validAddress);
  check("one-line form is built for the legacy column",
    r.ok && r.value.oneLine === "12 Example Road, Riccarton, Christchurch, 8041", r.ok ? r.value.oneLine : "");
}

// ── Stored → payload (the Sporty mapper) ────────────────────────────────────

const ref = {
  countries: NZF_COUNTRIES.map((c) => ({ CountryCode: c.code, CountryName: c.name })),
  genders: ["Male", "Female", "Non-binary"],
  ethnicityGroups: NZF_ETHNICITY_GROUPS.map((g) => ({
    EthnicityGroupId: g.id,
    EthnicityGroupName: g.name,
    MinimumSelectionsRequired: g.minSelections,
    MaximumSelectionsRequired: g.maxSelections,
    EthnicityGroupSelections: g.selections.map((s) => ({
      EthnicityGroupSelectionId: s.id, EthnicityGroupSelectionName: s.name,
    })),
  })),
};

{
  const r = resolveStoredEthnicity(groupId("Asian"), [selId("Asian", "Indian")], ref);
  check("stored ids resolve with no ambiguity", !!r && r.groupName === "Asian" && !r.groupAmbiguity && !r.selectionAmbiguity);
}
check("no stored id falls through to the free-text path", resolveStoredEthnicity(null, [], ref) === null);
// A retired selection must not be quietly dropped — it re-resolves/flags.
check("an unknown selection id falls through rather than being dropped",
  resolveStoredEthnicity(groupId("Asian"), [999999], ref) === null);

{
  const addr = structuredAddressOf({
    addressStreet: "12 Example Road", addressSuburb: "Riccarton", addressCity: "Christchurch",
    addressRegion: "Canterbury", addressPostcode: "8041", addressCountry: "NZL",
  }, ref as any);
  check("structured address is used verbatim", !!addr && addr.confident);
  // 🔴 Address.Country carries the NAME — that is what the accepted UAT
  // registrations sent. Storing the code and shipping it raw would break it.
  eq("country code is resolved to the name for the payload", addr?.address.Country, "New Zealand");
  eq("region survives verbatim", addr?.address.Region, "Canterbury");
}
check("a partial structured address falls through to the parser",
  structuredAddressOf({ addressStreet: "12 Example Road", addressCity: "Christchurch" }, ref as any) === null);

// End-to-end: a structured contact builds a payload with no blockers, where the
// same person as free text would have been blocked on the "European" tie.
{
  const built = buildRegisterPerson({
    player: {
      id: 1, firstName: "Test", lastName: "Child", dateOfBirth: "2015-06-01", gender: "male",
      email: null, phone: null, address: null,
      nationality: null, countryOfBirth: null,
      ethnicity: "European", subEthnicity: null, ethnicity2: null, subEthnicity2: null,
      nationalityCode: "NZL", countryOfBirthCode: "NZL",
      ethnicityGroupId: groupId("NZ European"), ethnicitySelectionIds: [],
      ethnicity2GroupId: null, ethnicity2SelectionIds: null,
      addressStreet: "12 Example Road", addressSuburb: "Riccarton", addressCity: "Christchurch",
      addressRegion: "Canterbury", addressPostcode: "8041", addressCountry: "NZL",
    },
    guardian: { firstName: "Test", lastName: "Parent", email: "p@example.com", phone: "0211234567", address: null },
    ref, todayIso: "2026-07-28",
  });
  const blockers = built.issues.filter((i) => i.severity === "blocker");
  check("a structured minor builds cleanly", built.payload !== null && blockers.length === 0,
    blockers.map((b) => b.code).join(", "));
  eq("payload carries the resolved group name", built.payload?.PrimaryEthnicityGroupName, "NZ European");
  eq("payload carries the FIFA nationality code", built.payload?.NationalityCode, "NZL");
  eq("payload address has the region", built.payload?.Address.Region, "Canterbury");

  // The same person WITHOUT structured fields: bare "European" is ambiguous and
  // must block, not pick a side.
  const legacy = buildRegisterPerson({
    player: {
      id: 2, firstName: "Test", lastName: "Child", dateOfBirth: "2015-06-01", gender: "male",
      email: null, phone: null, address: "12 Example Road, Riccarton, Christchurch 8041",
      nationality: "New Zealand", countryOfBirth: "New Zealand",
      ethnicity: "European", subEthnicity: null, ethnicity2: null, subEthnicity2: null,
    },
    guardian: { firstName: "Test", lastName: "Parent", email: "p@example.com", phone: "0211234567", address: null },
    ref, todayIso: "2026-07-28",
  });
  check("bare 'European' still blocks on the legacy path",
    legacy.payload === null && legacy.issues.some((i) => i.code === "ethnicity_group_ambiguous"));
}

// ── Gap reporting ───────────────────────────────────────────────────────────
{
  // 🔴 A legacy free-text "European" must read as a GAP: it is exactly the value
  // NZF rejects, so counting it as present would report the problem as solved.
  const legacyOnly = { ethnicity: "European", nationality: "New Zealand", countryOfBirth: "New Zealand" } as any;
  const g = nzfIdentityGap(legacyOnly);
  check("free-text-only contact reads as an ethnicity gap", g.ethnicity);
  check("free-text-only contact reads as a nationality gap", g.nationality);
  check("free-text-only contact is not complete", !isNzfIdentityComplete(legacyOnly));

  const done = {
    countryOfBirthCode: "NZL", nationalityCode: "NZL", ethnicityGroupId: 1,
    addressStreet: "a", addressSuburb: "b", addressCity: "c",
    addressRegion: "Canterbury", addressPostcode: "8041", addressCountry: "NZL",
  };
  check("a fully structured contact is complete", isNzfIdentityComplete(done));
  check("missing only the region is still incomplete",
    !isNzfIdentityComplete({ ...done, addressRegion: null }));
}

check("NZ_REGIONS covers all 15 regions plus none invented", NZ_REGIONS.length === 15, `got ${NZ_REGIONS.length}`);

// ── Report ──────────────────────────────────────────────────────────────────
console.log(`\n${failures.length === 0 ? "✅" : "❌"} nzf-identity: ${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`   ✗ ${f}`);
process.exit(failures.length === 0 ? 0 : 1);
