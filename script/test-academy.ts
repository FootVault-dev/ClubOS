// Pure-logic tests for shared/academy.ts.
// Run: npx tsx script/test-academy.ts   (exits non-zero on failure)
//
// No DB, no network. Follows script/test-league-pricing.ts.
import assert from "node:assert/strict";
import {
  POLICY_VERSION,
  TERMS_PER_YEAR,
  FULL_YEAR_DISCOUNT_BPS,
  NZF_ETHNICITIES,
  isNzfEthnicity,
  birthYearOf,
  ageGradeFor,
  checkEligibility,
  fullYearAvailable,
  quoteAcademy,
  validateAcademyRegistration,
  type AcademyRegistrationInput,
} from "../shared/academy";

let passed = 0;
function ok(name: string, fn: () => void) {
  try {
    fn();
    passed++;
  } catch (e: any) {
    console.error(`FAIL: ${name}\n  ${e.message}`);
    process.exitCode = 1;
  }
}

// ── birthYearOf ─────────────────────────────────────────────────────────────
ok("birthYearOf parses ISO", () => assert.equal(birthYearOf("2017-03-04"), 2017));
ok("birthYearOf trims", () => assert.equal(birthYearOf("  2017-03-04 "), 2017));
ok("birthYearOf rejects junk", () => assert.equal(birthYearOf("not-a-date"), null));
ok("birthYearOf rejects empty", () => assert.equal(birthYearOf(""), null));
ok("birthYearOf rejects null", () => assert.equal(birthYearOf(null), null));
ok("birthYearOf rejects slashes", () => assert.equal(birthYearOf("04/03/2017"), null));
ok("birthYearOf rejects bad month", () => assert.equal(birthYearOf("2017-13-01"), null));
ok("birthYearOf rejects bad day", () => assert.equal(birthYearOf("2017-01-32"), null));

// The timezone trap: `new Date("2017-01-01").getFullYear()` is 2016 in NZ
// (UTC midnight is the previous afternoon locally). We must never do that.
ok("birthYearOf is timezone-proof on 1 Jan", () => {
  assert.equal(birthYearOf("2017-01-01"), 2017);
});
ok("birthYearOf is timezone-proof on 31 Dec", () => {
  assert.equal(birthYearOf("2017-12-31"), 2017);
});

// ── ageGradeFor — NZF classifies by year of birth ───────────────────────────
// NZF: "For the 2026 Season: 2017 is U9 Grade."
ok("born 2017 is U9 in 2026", () => assert.equal(ageGradeFor("2017-06-15", 2026), 9));
ok("born 2017 on 1 Jan is still U9", () => assert.equal(ageGradeFor("2017-01-01", 2026), 9));
ok("born 2017 on 31 Dec is still U9", () => assert.equal(ageGradeFor("2017-12-31", 2026), 9));
ok("born 2022 is U4 in 2026", () => assert.equal(ageGradeFor("2022-08-01", 2026), 4));
ok("born 2013 is U13 in 2026", () => assert.equal(ageGradeFor("2013-02-02", 2026), 13));
ok("grade advances with the season", () => assert.equal(ageGradeFor("2017-06-15", 2027), 10));
ok("bad dob → null grade", () => assert.equal(ageGradeFor("nope", 2026), null));
ok("future birth year → negative rejected", () => assert.equal(ageGradeFor("2030-01-01", 2026), null));

// ── checkEligibility ────────────────────────────────────────────────────────
ok("U9 fits Pre-Academy U9–U12", () => {
  const r = checkEligibility("2017-06-15", 2026, 9, 12);
  assert.equal(r.eligible, true);
  assert.equal(r.grade, 9);
});
ok("U8 does not fit Pre-Academy U9–U12", () => {
  const r = checkEligibility("2018-06-15", 2026, 9, 12);
  assert.equal(r.eligible, false);
  assert.match(r.reason, /U9/);
});
ok("U13 does not fit Pre-Academy U9–U12", () => {
  const r = checkEligibility("2013-06-15", 2026, 9, 12);
  assert.equal(r.eligible, false);
});
ok("boundary low is inclusive", () => assert.equal(checkEligibility("2017-01-01", 2026, 9, 12).eligible, true));
ok("boundary high is inclusive", () => assert.equal(checkEligibility("2014-01-01", 2026, 9, 12).eligible, true));
ok("U4 fits FUNiño U4–U8", () => assert.equal(checkEligibility("2022-01-01", 2026, 4, 8).eligible, true));
ok("unbounded max accepts an older player", () => {
  assert.equal(checkEligibility("2006-01-01", 2026, 13, null).eligible, true);
});
ok("missing dob is not eligible", () => {
  const r = checkEligibility("", 2026, 4, 8);
  assert.equal(r.eligible, false);
  assert.match(r.reason, /date of birth/i);
});

// ── Ethnicity vocabulary ────────────────────────────────────────────────────
ok("six Stats NZ level-1 groups", () => assert.equal(NZF_ETHNICITIES.length, 6));
ok("Māori is recognised (macron)", () => assert.equal(isNzfEthnicity("Māori"), true));
ok("Maori without macron is NOT silently accepted", () => assert.equal(isNzfEthnicity("Maori"), false));
ok("junk ethnicity rejected", () => assert.equal(isNzfEthnicity("Klingon"), false));
ok("non-string rejected", () => assert.equal(isNzfEthnicity(42), false));

// ── fullYearAvailable — the policy exclusion ───────────────────────────────
ok("core programmes may pay for the year", () => assert.equal(fullYearAvailable("core"), true));
ok("additional programmes may NOT", () => assert.equal(fullYearAvailable("additional"), false));

// ── quoteAcademy — money ────────────────────────────────────────────────────
ok("single term at full price", () => {
  const q = quoteAcademy({ termPriceCents: 40_000, plan: "term", section: "core" });
  assert.equal(q.subtotalCents, 40_000);
  assert.equal(q.discountCents, 0);
  assert.equal(q.totalCents, 40_000);
  assert.equal(q.termsCovered, 1);
});

ok("single term, pro-rated mid-term join", () => {
  const q = quoteAcademy({
    termPriceCents: 40_000,
    proratedTermPriceCents: 24_000,
    plan: "term",
    section: "core",
  });
  assert.equal(q.subtotalCents, 40_000);
  assert.equal(q.discountCents, 16_000);
  assert.equal(q.totalCents, 24_000);
  assert.match(q.reason, /pro-rated/i);
});

ok("full year = 4 terms less 5%", () => {
  const q = quoteAcademy({ termPriceCents: 40_000, plan: "year", section: "core" });
  assert.equal(q.subtotalCents, 160_000);
  assert.equal(q.discountCents, 8_000);       // 5% of $1,600.00 = $80.00
  assert.equal(q.totalCents, 152_000);
  assert.equal(q.termsCovered, TERMS_PER_YEAR);
});

ok("discount is exactly FULL_YEAR_DISCOUNT_BPS", () => {
  assert.equal(FULL_YEAR_DISCOUNT_BPS, 500);
  const q = quoteAcademy({ termPriceCents: 100_000, plan: "year", section: "core" });
  assert.equal(q.discountCents, 20_000);      // 5% of $4,000.00
});

// The invariant that keeps Stripe and Xero agreeing.
ok("subtotal − discount === total, always (fuzz)", () => {
  for (let cents = 1; cents <= 250_000; cents += 137) {
    for (const plan of ["term", "year"] as const) {
      const q = quoteAcademy({ termPriceCents: cents, plan, section: "core" });
      assert.equal(q.subtotalCents - q.discountCents, q.totalCents, `broke at ${cents} / ${plan}`);
      assert.ok(Number.isInteger(q.totalCents), `non-integer cents at ${cents}`);
      assert.ok(q.totalCents > 0, `non-positive total at ${cents}`);
    }
  }
});

ok("odd cents round the discount, never the total", () => {
  // 4 × 33_333 = 133_332; 5% = 6_666.6 → rounds to 6_667. Total must be 126_665.
  const q = quoteAcademy({ termPriceCents: 33_333, plan: "year", section: "core" });
  assert.equal(q.subtotalCents, 133_332);
  assert.equal(q.discountCents, 6_667);
  assert.equal(q.totalCents, 126_665);
  assert.equal(q.subtotalCents - q.discountCents, q.totalCents);
});

ok("full-year on an additional programme throws", () => {
  assert.throws(
    () => quoteAcademy({ termPriceCents: 15_000, plan: "year", section: "additional" }),
    /only available for core/i,
  );
});

ok("additional programme by term is fine", () => {
  const q = quoteAcademy({ termPriceCents: 15_000, plan: "term", section: "additional" });
  assert.equal(q.totalCents, 15_000);
});

ok("zero price refuses to quote", () => {
  assert.throws(() => quoteAcademy({ termPriceCents: 0, plan: "term", section: "core" }), /positive/i);
});
ok("negative price refuses to quote", () => {
  assert.throws(() => quoteAcademy({ termPriceCents: -100, plan: "term", section: "core" }), /positive/i);
});
ok("non-integer price refuses to quote", () => {
  assert.throws(() => quoteAcademy({ termPriceCents: 40_000.5, plan: "term", section: "core" }), /integer/i);
});

// ── validateAcademyRegistration ─────────────────────────────────────────────
function validInput(): AcademyRegistrationInput {
  return {
    programSlug: "funino-u4-u8",
    paymentPlan: "term",
    child: {
      firstName: "Aria",
      lastName: "Meyn",
      dateOfBirth: "2019-04-01",
      gender: "female",
      school: "Ilam School",
      countryOfBirth: "New Zealand",
      nationality: "New Zealand",
      ethnicity: "European",
      subEthnicity: "New Zealand European",
    },
    guardian: {
      firstName: "Daniel",
      lastName: "Meyn",
      email: "daniel@cufc.co.nz",
      phone: "021 446 212",
      relationship: "Father",
    },
    emergency: { name: "Slava Meyn", phone: "0211234567" },
    consents: { policy: true, medical: true, photo: false, newsletter: true },
  };
}

ok("a complete registration validates", () => {
  assert.deepEqual(validateAcademyRegistration(validInput()), []);
});

ok("photo consent is genuinely optional", () => {
  const i = validInput();
  i.consents!.photo = false;
  assert.deepEqual(validateAcademyRegistration(i), []);
});

ok("phone is mandatory", () => {
  const i = validInput();
  i.guardian!.phone = "";
  assert.match(validateAcademyRegistration(i).join(" "), /phone/i);
});

ok("a too-short phone is rejected", () => {
  const i = validInput();
  i.guardian!.phone = "1234";
  assert.match(validateAcademyRegistration(i).join(" "), /phone/i);
});

ok("+64 phone accepted", () => {
  const i = validInput();
  i.guardian!.phone = "+64 21 446 212";
  assert.deepEqual(validateAcademyRegistration(i), []);
});

ok("bad email rejected", () => {
  const i = validInput();
  i.guardian!.email = "daniel@";
  assert.match(validateAcademyRegistration(i).join(" "), /email/i);
});

// The whole point of the migration — these must never pass empty.
ok("country of birth is required (NZF audit)", () => {
  const i = validInput();
  i.child!.countryOfBirth = "";
  assert.match(validateAcademyRegistration(i).join(" "), /country of birth/i);
});
ok("ethnicity is required (NZF audit)", () => {
  const i = validInput();
  i.child!.ethnicity = "";
  assert.match(validateAcademyRegistration(i).join(" "), /ethnic group/i);
});
ok("nationality is required (NZF audit)", () => {
  const i = validInput();
  i.child!.nationality = "";
  assert.match(validateAcademyRegistration(i).join(" "), /nationality/i);
});
ok("an invalid ethnicity is rejected, not coerced", () => {
  const i = validInput();
  i.child!.ethnicity = "Pakeha";
  assert.match(validateAcademyRegistration(i).join(" "), /ethnic group/i);
});
ok("optional second ethnicity may be blank", () => {
  const i = validInput();
  i.child!.ethnicity2 = "";
  assert.deepEqual(validateAcademyRegistration(i), []);
});
ok("but an invalid second ethnicity is rejected", () => {
  const i = validInput();
  i.child!.ethnicity2 = "Klingon";
  assert.match(validateAcademyRegistration(i).join(" "), /additional ethnic group/i);
});

ok("policy consent is mandatory", () => {
  const i = validInput();
  i.consents!.policy = false;
  assert.match(validateAcademyRegistration(i).join(" "), /Membership & Payment Policy/i);
});
ok("policy consent must be exactly true, not truthy", () => {
  const i = validInput();
  (i.consents as any).policy = "yes";
  assert.match(validateAcademyRegistration(i).join(" "), /Membership & Payment Policy/i);
});
ok("medical consent is mandatory", () => {
  const i = validInput();
  i.consents!.medical = false;
  assert.match(validateAcademyRegistration(i).join(" "), /medical/i);
});
ok("emergency contact is mandatory", () => {
  const i = validInput();
  i.emergency!.name = "";
  assert.match(validateAcademyRegistration(i).join(" "), /emergency contact name/i);
});
ok("relationship is mandatory", () => {
  const i = validInput();
  i.guardian!.relationship = "";
  assert.match(validateAcademyRegistration(i).join(" "), /relationship/i);
});
ok("bad dob is caught", () => {
  const i = validInput();
  i.child!.dateOfBirth = "01/04/2019";
  assert.match(validateAcademyRegistration(i).join(" "), /date of birth/i);
});
ok("bad payment plan is caught", () => {
  const i = validInput();
  i.paymentPlan = "weekly";
  assert.match(validateAcademyRegistration(i).join(" "), /term or for the full year/i);
});
ok("an empty payload produces many errors, and does not throw", () => {
  const errs = validateAcademyRegistration({});
  assert.ok(errs.length >= 10, `expected many errors, got ${errs.length}`);
});
ok("hostile payload of wrong types does not throw", () => {
  const errs = validateAcademyRegistration({
    programSlug: 42,
    paymentPlan: [],
    child: { firstName: {}, dateOfBirth: 12345, ethnicity: null },
    guardian: { email: [], phone: {} },
    consents: { policy: 1, medical: "true" },
  } as any);
  assert.ok(errs.length > 0);
});

ok("POLICY_VERSION is pinned", () => assert.equal(POLICY_VERSION, "2026-01-01"));

console.log(`\n✅ academy: ${passed} assertions passed`);
if (process.exitCode) console.error("❌ some assertions failed");
