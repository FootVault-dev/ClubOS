// Pure-logic tests for shared/academy.ts.
// Run: npx tsx script/test-academy.ts   (exits non-zero on failure)
//
// No DB, no network. Follows script/test-league-pricing.ts.
import assert from "node:assert/strict";
import { NZF_ETHNICITY_GROUPS } from "../shared/nzf-vocabulary";

const NZ_EUROPEAN_ID = NZF_ETHNICITY_GROUPS.find((g) => g.name === "NZ European")!.id;
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
  nzTodayIso,
  daysBetween,
  termProgress,
  prorateTermPriceCents,
  promoDiscountCents,
  applyPromo,
  STRIPE_MIN_CHARGE_CENTS,
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

// ── fullYearAvailable — the policy exclusions ──────────────────────────────
ok("core, unbound term → year plan offered", () => assert.equal(fullYearAvailable("core"), true));
ok("core, Term 1 → year plan offered", () => assert.equal(fullYearAvailable("core", 1), true));
ok("core, Term 3 → year plan REFUSED (season already half gone)", () => {
  assert.equal(fullYearAvailable("core", 3), false);
});
ok("additional programmes may NEVER pay for the year", () => {
  assert.equal(fullYearAvailable("additional"), false);
  assert.equal(fullYearAvailable("additional", 1), false);
});

// ── nzTodayIso — the timezone trap ─────────────────────────────────────────
ok("nzTodayIso returns YYYY-MM-DD", () => assert.match(nzTodayIso(), /^\d{4}-\d{2}-\d{2}$/));
ok("12:30 UTC on 8 Jul is already 9 Jul in NZ — the whole point", () => {
  // NZST is UTC+12, so anything from 12:00 UTC onward is tomorrow in NZ.
  // toISOString() still says the 8th. That gap is the bug.
  const d = new Date("2026-07-08T12:30:00Z");
  assert.equal(nzTodayIso(d), "2026-07-09");
  assert.equal(d.toISOString().slice(0, 10), "2026-07-08"); // what we must never use
});
ok("11:00 UTC on 8 Jul is still the 8th in NZ (23:00 local)", () => {
  assert.equal(nzTodayIso(new Date("2026-07-08T11:00:00Z")), "2026-07-08");
});
ok("00:30 UTC is already the same NZ day", () => {
  assert.equal(nzTodayIso(new Date("2026-07-09T00:30:00Z")), "2026-07-09");
});
ok("mid-winter (NZST, UTC+12) boundary", () => {
  assert.equal(nzTodayIso(new Date("2026-07-08T12:00:00Z")), "2026-07-09");
});
ok("mid-summer (NZDT, UTC+13) boundary", () => {
  assert.equal(nzTodayIso(new Date("2026-01-08T11:00:00Z")), "2026-01-09");
});

// ── daysBetween ────────────────────────────────────────────────────────────
ok("daysBetween counts calendar days", () => assert.equal(daysBetween("2026-07-20", "2026-07-27"), 7));
ok("daysBetween is signed", () => assert.equal(daysBetween("2026-07-27", "2026-07-20"), -7));
ok("daysBetween same day = 0", () => assert.equal(daysBetween("2026-07-20", "2026-07-20"), 0));
ok("daysBetween crosses a DST change without drift", () => {
  // NZ leaves daylight time 5 Apr 2026. UTC-anchored arithmetic must not care.
  assert.equal(daysBetween("2026-04-01", "2026-04-10"), 9);
});
ok("daysBetween rejects junk", () => assert.equal(daysBetween("nope", "2026-07-20"), null));

// ── termProgress — Daniel's rule, verbatim ─────────────────────────────────
// "If they join 5 weeks into the term and it's a 10-week term, then they only
//  pay for the 5 weeks."
const T_START = "2026-07-20";  // Term 3 2026
const T_END = "2026-09-25";

ok("join exactly 5 weeks in → 5 of 10 sessions remain", () => {
  const p = termProgress("2026-08-24", T_START, T_END, 10)!;  // start + 35 days
  assert.equal(p.weeksElapsed, 5);
  assert.equal(p.sessionsRemaining, 5);
  assert.equal(p.status, "running");
});
ok("day one of the term → all 10 sessions", () => {
  const p = termProgress(T_START, T_START, T_END, 10)!;
  assert.equal(p.sessionsRemaining, 10);
  assert.equal(p.weeksElapsed, 0);
});
ok("before the term starts → full price, nothing missed", () => {
  const p = termProgress("2026-07-01", T_START, T_END, 10)!;
  assert.equal(p.status, "before");
  assert.equal(p.sessionsRemaining, 10);
});
ok("six days in is still week 1 → 10 sessions", () => {
  assert.equal(termProgress("2026-07-26", T_START, T_END, 10)!.sessionsRemaining, 10);
});
ok("seven days in is week 2 → 9 sessions", () => {
  assert.equal(termProgress("2026-07-27", T_START, T_END, 10)!.sessionsRemaining, 9);
});
ok("after the term ends → 0 sessions, status ended", () => {
  const p = termProgress("2026-09-26", T_START, T_END, 10)!;
  assert.equal(p.status, "ended");
  assert.equal(p.sessionsRemaining, 0);
});
ok("last day of term is still sellable (1 session)", () => {
  const p = termProgress(T_END, T_START, T_END, 10)!;
  assert.equal(p.status, "running");
  assert.ok(p.sessionsRemaining >= 1, `got ${p.sessionsRemaining}`);
});
ok("sessions never exceed the total, however late", () => {
  for (let d = 0; d <= 80; d++) {
    const day = new Date(Date.UTC(2026, 6, 20 + d)).toISOString().slice(0, 10);
    const p = termProgress(day, T_START, T_END, 10);
    if (!p) continue;
    assert.ok(p.sessionsRemaining >= 0 && p.sessionsRemaining <= 10, `${day} → ${p.sessionsRemaining}`);
  }
});
ok("termProgress rejects a zero session count", () => assert.equal(termProgress(T_START, T_START, T_END, 0), null));

// ── prorateTermPriceCents ──────────────────────────────────────────────────
ok("5 of 10 sessions halves a $160 term", () => {
  assert.equal(prorateTermPriceCents(16_000, 5, 10), 8_000);
});
ok("full term is never discounted", () => assert.equal(prorateTermPriceCents(16_000, 10, 10), 16_000));
ok("more remaining than total is capped at full", () => assert.equal(prorateTermPriceCents(16_000, 12, 10), 16_000));
ok("no sessions left = nothing to sell", () => assert.equal(prorateTermPriceCents(16_000, 0, 10), 0));
ok("technification: 3 of 10 sessions of $150", () => {
  assert.equal(prorateTermPriceCents(15_000, 3, 10), 4_500);
});
ok("pro-rata rounds to whole cents", () => {
  const p = prorateTermPriceCents(40_500, 7, 10);   // $405 × 0.7
  assert.equal(p, 28_350);
  assert.ok(Number.isInteger(p));
});
ok("odd ratios stay integral", () => {
  for (let s = 1; s <= 10; s++) {
    const p = prorateTermPriceCents(80_500, s, 10);  // Academy U13–U15 $805
    assert.ok(Number.isInteger(p) && p > 0 && p <= 80_500, `s=${s} → ${p}`);
  }
});

// ── quoteAcademy + pro-rata together (the real path) ───────────────────────
ok("FUNiño joining 5 weeks into a 10-week term pays $80.00", () => {
  const p = termProgress("2026-08-24", T_START, T_END, 10)!;
  const prorated = prorateTermPriceCents(16_000, p.sessionsRemaining, p.totalSessions);
  const q = quoteAcademy({ termPriceCents: 16_000, plan: "term", section: "core", proratedTermPriceCents: prorated });
  assert.equal(q.totalCents, 8_000);
  assert.equal(q.subtotalCents, 16_000);
  assert.equal(q.discountCents, 8_000);
  assert.equal(q.subtotalCents - q.discountCents, q.totalCents);
});
ok("Technification joining 5 weeks in pays $75.00", () => {
  const p = termProgress("2026-08-24", T_START, T_END, 10)!;
  const prorated = prorateTermPriceCents(15_000, p.sessionsRemaining, p.totalSessions);
  const q = quoteAcademy({ termPriceCents: 15_000, plan: "term", section: "additional", proratedTermPriceCents: prorated });
  assert.equal(q.totalCents, 7_500);
});
ok("joining before the term starts pays full price", () => {
  const p = termProgress("2026-07-01", T_START, T_END, 10)!;
  const prorated = prorateTermPriceCents(16_000, p.sessionsRemaining, p.totalSessions);
  const q = quoteAcademy({ termPriceCents: 16_000, plan: "term", section: "core", proratedTermPriceCents: prorated });
  assert.equal(q.totalCents, 16_000);
  assert.equal(q.discountCents, 0);
});
ok("the invariant holds across every join week", () => {
  for (let week = 0; week < 10; week++) {
    const day = new Date(Date.UTC(2026, 6, 20 + week * 7)).toISOString().slice(0, 10);
    const p = termProgress(day, T_START, T_END, 10)!;
    const prorated = prorateTermPriceCents(80_500, p.sessionsRemaining, p.totalSessions);
    const q = quoteAcademy({ termPriceCents: 80_500, plan: "term", section: "core", proratedTermPriceCents: prorated });
    assert.equal(q.subtotalCents - q.discountCents, q.totalCents, `week ${week}`);
    assert.equal(p.sessionsRemaining, 10 - week, `week ${week} sessions`);
  }
});

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
      // Structured NZF identity — codes and ids off NZ Football's own list.
      // Was free text ("New Zealand" / "European") until 28 July 2026; that
      // shape is unregisterable, which is why the contract changed.
      countryOfBirthCode: "NZL",
      nationalityCode: "NZL",
      ethnicityGroupId: NZ_EUROPEAN_ID,
      ethnicitySelectionIds: [],
    },
    guardian: {
      firstName: "Daniel",
      lastName: "Meyn",
      email: "daniel@cufc.co.nz",
      phone: "021 446 212",
      relationship: "Father",
      addressParts: {
        street: "12 Example Road",
        suburb: "Riccarton",
        city: "Christchurch",
        region: "Canterbury",
        postcode: "8041",
        country: "NZL",
      },
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
  i.child!.countryOfBirthCode = "";
  assert.match(validateAcademyRegistration(i).join(" "), /country of birth/i);
});
ok("ethnicity is required (NZF audit)", () => {
  const i = validInput();
  i.child!.ethnicityGroupId = null;
  assert.match(validateAcademyRegistration(i).join(" "), /ethnic group/i);
});
ok("nationality is required (NZF audit)", () => {
  const i = validInput();
  i.child!.nationalityCode = "";
  assert.match(validateAcademyRegistration(i).join(" "), /nationality/i);
});
// 🔴 The regression that cost us the 30 July snapshot: free text let a city
// through as a country of birth and a group NZF does not have through as an
// ethnicity. Neither can happen now.
ok("a city typed as a country of birth is rejected", () => {
  const i = validInput();
  i.child!.countryOfBirthCode = "Christchurch";
  assert.match(validateAcademyRegistration(i).join(" "), /country of birth/i);
});
ok("an ethnic group NZF does not have is rejected, not coerced", () => {
  const i = validInput();
  i.child!.ethnicityGroupId = 9999;
  assert.match(validateAcademyRegistration(i).join(" "), /ethnic group/i);
});
ok("optional second ethnicity may be absent", () => {
  const i = validInput();
  i.child!.ethnicity2GroupId = undefined;
  assert.deepEqual(validateAcademyRegistration(i), []);
});
ok("but an invalid second ethnicity is rejected", () => {
  const i = validInput();
  i.child!.ethnicity2GroupId = 9999;
  assert.match(validateAcademyRegistration(i).join(" "), /ethnic group/i);
});
// 🔴 Sporty rejects the whole address if any one part is missing, and Region is
// mandatory despite its swagger saying otherwise.
ok("a missing address region is rejected", () => {
  const i = validInput();
  i.guardian!.addressParts!.region = "";
  assert.match(validateAcademyRegistration(i).join(" "), /region/i);
});
ok("a missing address entirely is rejected", () => {
  const i = validInput();
  delete i.guardian!.addressParts;
  assert.match(validateAcademyRegistration(i).join(" "), /street address/i);
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

// ── Promo codes ─────────────────────────────────────────────────────────────
ok("percentage off the payable amount", () => assert.equal(promoDiscountCents(15_000, "percentage", 20), 3_000));
ok("fixed_amount is dollars → cents", () => assert.equal(promoDiscountCents(15_000, "fixed_amount", 149), 14_900));
ok("'fixed' is treated the same as fixed_amount", () => assert.equal(promoDiscountCents(15_000, "fixed", 149), 14_900));
ok("a discount can never exceed the base", () => assert.equal(promoDiscountCents(1_000, "fixed_amount", 500), 1_000));
ok("a discount can never be negative", () => assert.equal(promoDiscountCents(1_000, "percentage", -50), 0));
ok("a zero-value code takes nothing off", () => assert.equal(promoDiscountCents(1_000, "percentage", 0), 0));
ok("junk value takes nothing off", () => assert.equal(promoDiscountCents(1_000, "percentage", "abc"), 0));
ok("promo applies to the PRO-RATED price, not the list price", () => {
  // Half a $150 term = $75; 20% off that is $15, not $30.
  const p = termProgress("2026-08-24", T_START, T_END, 10)!;
  const payable = prorateTermPriceCents(15_000, p.sessionsRemaining, p.totalSessions);
  assert.equal(payable, 7_500);
  assert.equal(promoDiscountCents(payable, "percentage", 20), 1_500);
});

ok("the $1 Technification test: $150 less $149 = $1.00", () => {
  const r = applyPromo(15_000, "fixed_amount", 149);
  assert.equal(r.ok, true);
  assert.equal(r.promoCents, 14_900);
  assert.equal(r.totalCents, 100);
});
ok("a 100% code is refused — no free-registration path exists", () => {
  const r = applyPromo(15_000, "percentage", 100);
  assert.equal(r.ok, false);
  assert.match(r.reason!, /\$0 payment/);
});
ok("a total under Stripe's 50c floor is refused", () => {
  const r = applyPromo(15_000, "fixed_amount", 149.7);   // → 30c
  assert.equal(r.ok, false);
  assert.match(r.reason!, /smallest card payment/i);
});
ok("exactly 50c is allowed", () => {
  const r = applyPromo(15_000, "fixed_amount", 149.5);
  assert.equal(r.ok, true);
  assert.equal(r.totalCents, 50);
});
ok("STRIPE_MIN_CHARGE_CENTS is 50", () => assert.equal(STRIPE_MIN_CHARGE_CENTS, 50));
ok("promo never makes the total negative, fuzzed", () => {
  for (let base = 100; base <= 100_000; base += 977) {
    for (const [vt, v] of [["percentage", 130], ["fixed_amount", 9999]] as const) {
      const d = promoDiscountCents(base, vt, v);
      assert.ok(d <= base && d >= 0, `${base}/${vt}/${v} → ${d}`);
    }
  }
});

console.log(`\n✅ academy (with promos): ${passed} assertions passed`);
