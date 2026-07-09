// Academy registration — pure logic. No DB, no Stripe, no network.
//
// Everything here is derived from a written source, never invented:
//   • Age grades      — NZ Football classifies by YEAR OF BIRTH. A child born in
//                       2017 is U9 for the 2026 season. So grade = season − birthYear.
//                       (Corroborated by the club's own Membership & Payment Policy
//                       2026 §5, which frames age "as at 1 January of the season".)
//   • Ethnicity       — Stats NZ level-1 classification, the standard NZF uses.
//                       Friendly Manager collects exactly this shape today
//                       (custom[ethnicity] + custom[subEthnicity] for iwi, plus a
//                       second optional pair). Free text at the DB layer because
//                       Sporty's accepted vocabulary is not yet confirmed.
//   • 5% discount     — Membership & Payment Policy 2026: "5% discount on training
//                       fees only when the full amount for all four terms ... is
//                       paid in one single payment at the start of the season."
//                       It explicitly does NOT apply to Technification, Goalkeeper,
//                       holiday programmes or camps → i.e. only `academy_section`
//                       = 'core'. Getting this wrong under-charges families.
//
// Tested by script/test-academy.ts (npx tsx script/test-academy.ts).

// ── Policy constants ────────────────────────────────────────────────────────

/** The published policy these registrations are accepted against. Stored on the
 *  registration row so a tick-box is evidence, not a rumour. Bump when the Board
 *  reissues the policy. Effective date from PaymentPolicy.tsx. */
export const POLICY_VERSION = "2026-01-01";

/** NZ school year: four terms. The policy's full-year price is all four. */
export const TERMS_PER_YEAR = 4;

/** 5%, in basis points, to keep the arithmetic in integers. */
export const FULL_YEAR_DISCOUNT_BPS = 500;

/** `programs.academy_section`. 'core' = the training pathway (FUNiño,
 *  Pre-Academy, Academy). 'additional' = paid add-ons (Technification,
 *  Goalkeeper, Morning Programme). Matches the existing seed.ts classifier. */
export type AcademySection = "core" | "additional";
export const ACADEMY_SECTIONS: AcademySection[] = ["core", "additional"];

export type AcademyPaymentPlan = "term" | "year";
export const ACADEMY_PAYMENT_PLANS: AcademyPaymentPlan[] = ["term", "year"];

// ── NZ Football / Mainland Football required identity vocabulary ────────────

/** Stats NZ level-1 ethnic groups — the categories NZF's registration forms use.
 *  `subEthnicity` carries the specific group (and iwi, for Māori) as free text. */
export const NZF_ETHNICITIES = [
  "European",
  "Māori",
  "Pacific Peoples",
  "Asian",
  "Middle Eastern / Latin American / African",
  "Other Ethnicity",
] as const;
export type NzfEthnicity = (typeof NZF_ETHNICITIES)[number];

export function isNzfEthnicity(v: unknown): v is NzfEthnicity {
  return typeof v === "string" && (NZF_ETHNICITIES as readonly string[]).includes(v);
}

export const GENDERS = ["male", "female", "other"] as const;
export type Gender = (typeof GENDERS)[number];

// ── Age grades ──────────────────────────────────────────────────────────────

/** Year of birth from an ISO `YYYY-MM-DD`. Returns null on anything malformed —
 *  never throws, never guesses. Deliberately does NOT construct a Date: parsing
 *  "2017-01-01" as a Date and reading getFullYear() is timezone-dependent and
 *  silently returns 2016 in NZ. Substring the string instead. */
export function birthYearOf(dobIso: string | null | undefined): number | null {
  if (typeof dobIso !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dobIso.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < 1900 || year > 2200) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  return year;
}

/** NZF age grade for a season. Born 2017, season 2026 → 9 (i.e. "U9").
 *  Null when the DOB is unusable. */
export function ageGradeFor(dobIso: string | null | undefined, seasonYear: number): number | null {
  const by = birthYearOf(dobIso);
  if (by === null) return null;
  const grade = seasonYear - by;
  if (grade < 0 || grade > 100) return null;
  return grade;
}

export interface EligibilityResult {
  eligible: boolean;
  grade: number | null;
  reason: string;
}

/** Is this child in the programme's age band for the season?
 *  `ageMin`/`ageMax` are the programme's grade bounds (inclusive), e.g. 4..8.
 *  A null bound means "unbounded on that side". */
export function checkEligibility(
  dobIso: string | null | undefined,
  seasonYear: number,
  ageMin: number | null | undefined,
  ageMax: number | null | undefined,
): EligibilityResult {
  const grade = ageGradeFor(dobIso, seasonYear);
  if (grade === null) {
    return { eligible: false, grade: null, reason: "A valid date of birth is required." };
  }
  if (typeof ageMin === "number" && grade < ageMin) {
    return {
      eligible: false,
      grade,
      reason: `This programme is for U${ageMin}${typeof ageMax === "number" ? `–U${ageMax}` : "+"}. Your child is U${grade} in ${seasonYear}.`,
    };
  }
  if (typeof ageMax === "number" && grade > ageMax) {
    return {
      eligible: false,
      grade,
      reason: `This programme is for ${typeof ageMin === "number" ? `U${ageMin}–` : "up to "}U${ageMax}. Your child is U${grade} in ${seasonYear}.`,
    };
  }
  return { eligible: true, grade, reason: `U${grade} in ${seasonYear}` };
}

// ── Fees ────────────────────────────────────────────────────────────────────

export interface AcademyQuoteInput {
  /** One term's fee, in cents. Server-sourced from program_options.full_price_cents. */
  termPriceCents: number;
  plan: AcademyPaymentPlan;
  section: AcademySection;
  /** Pre-computed pro-rata for a mid-term join (from program-pricing.quoteProgram).
   *  Only ever applied to the 'term' plan. Omit for full price. */
  proratedTermPriceCents?: number;
}

export interface AcademyQuote {
  plan: AcademyPaymentPlan;
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  termsCovered: number;
  reason: string;
}

/** The full-year 5% is a discount on TRAINING fees. Technification, Goalkeeper
 *  and the Morning Programme ('additional') are excluded by the policy, so they
 *  can only ever be bought a term at a time. */
export function fullYearAvailable(section: AcademySection): boolean {
  return section === "core";
}

/** Money math. Integer cents throughout; the only rounding is the discount, and
 *  it rounds the DISCOUNT (not the total) so subtotal − discount === total
 *  exactly, always. A half-cent drift here becomes a Stripe/Xero mismatch. */
export function quoteAcademy(input: AcademyQuoteInput): AcademyQuote {
  const { termPriceCents, plan, section } = input;

  if (!Number.isInteger(termPriceCents) || termPriceCents <= 0) {
    throw new Error("termPriceCents must be a positive integer number of cents");
  }

  if (plan === "year") {
    if (!fullYearAvailable(section)) {
      throw new Error(
        "Full-year payment is only available for core academy programmes " +
          "(the policy's 5% discount excludes Technification, Goalkeeper and holiday programmes).",
      );
    }
    const subtotalCents = termPriceCents * TERMS_PER_YEAR;
    const discountCents = Math.round((subtotalCents * FULL_YEAR_DISCOUNT_BPS) / 10_000);
    return {
      plan,
      subtotalCents,
      discountCents,
      totalCents: subtotalCents - discountCents,
      termsCovered: TERMS_PER_YEAR,
      reason: `All ${TERMS_PER_YEAR} terms paid up front — ${FULL_YEAR_DISCOUNT_BPS / 100}% off training fees`,
    };
  }

  // Single term. A mid-term join may have been pro-rated upstream.
  const payable = input.proratedTermPriceCents ?? termPriceCents;
  if (!Number.isInteger(payable) || payable <= 0) {
    throw new Error("proratedTermPriceCents must be a positive integer number of cents");
  }
  const discountCents = Math.max(0, termPriceCents - payable);
  return {
    plan,
    subtotalCents: termPriceCents,
    discountCents,
    totalCents: payable,
    termsCovered: 1,
    reason: discountCents > 0 ? "Pro-rated — you've joined part-way through the term" : "One term",
  };
}

// ── Validation ──────────────────────────────────────────────────────────────

export interface AcademyRegistrationInput {
  programSlug?: unknown;
  paymentPlan?: unknown;
  child?: {
    firstName?: unknown;
    lastName?: unknown;
    dateOfBirth?: unknown;
    gender?: unknown;
    school?: unknown;
    // NZF audit fields
    countryOfBirth?: unknown;
    nationality?: unknown;
    ethnicity?: unknown;
    subEthnicity?: unknown;
    ethnicity2?: unknown;
    subEthnicity2?: unknown;
    medicalNotes?: unknown;
    allergies?: unknown;
  };
  guardian?: {
    firstName?: unknown;
    lastName?: unknown;
    email?: unknown;
    phone?: unknown;
    alternatePhone?: unknown;
    relationship?: unknown;
    address?: unknown;
  };
  emergency?: { name?: unknown; phone?: unknown };
  consents?: {
    policy?: unknown;   // Membership & Payment Policy 2026 + NZF registration terms
    medical?: unknown;  // permission to seek medical treatment
    photo?: unknown;    // optional — absence is a valid answer, not an error
    newsletter?: unknown;
  };
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const isEmail = (v: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
/** NZ numbers, tolerant of spaces/dashes/+64. Requires at least 8 digits. */
const isPhone = (v: string): boolean => (v.replace(/[^\d]/g, "").length >= 8);

/**
 * Returns a list of human-readable errors — empty means valid.
 *
 * Required-field policy:
 *   • phone is MANDATORY (standing rule across every form we build)
 *   • the NZF audit fields (country of birth, ethnicity) are MANDATORY — they are
 *     the whole reason this migration exists; letting them through empty would
 *     silently recreate the gap we are closing
 *   • photo consent is genuinely optional (declining is a valid answer)
 */
export function validateAcademyRegistration(input: AcademyRegistrationInput): string[] {
  const errors: string[] = [];
  const child = input.child ?? {};
  const guardian = input.guardian ?? {};
  const emergency = input.emergency ?? {};
  const consents = input.consents ?? {};

  if (!str(input.programSlug)) errors.push("Programme is required.");

  const plan = str(input.paymentPlan);
  if (!(ACADEMY_PAYMENT_PLANS as string[]).includes(plan)) {
    errors.push("Choose whether you're paying by term or for the full year.");
  }

  // Child
  if (!str(child.firstName)) errors.push("Player's first name is required.");
  if (!str(child.lastName)) errors.push("Player's last name is required.");
  if (birthYearOf(str(child.dateOfBirth)) === null) {
    errors.push("Player's date of birth is required (YYYY-MM-DD).");
  }
  if (!(GENDERS as readonly string[]).includes(str(child.gender))) {
    errors.push("Player's gender is required.");
  }

  // NZ Football audit fields
  if (!str(child.countryOfBirth)) errors.push("Player's country of birth is required by New Zealand Football.");
  if (!str(child.nationality)) errors.push("Player's nationality is required by New Zealand Football.");
  if (!isNzfEthnicity(str(child.ethnicity))) {
    errors.push("Player's ethnic group is required by New Zealand Football.");
  }
  // A second ethnicity is optional, but if one is given it must be valid.
  const e2 = str(child.ethnicity2);
  if (e2 && !isNzfEthnicity(e2)) errors.push("Additional ethnic group is not a recognised option.");

  // Guardian
  if (!str(guardian.firstName)) errors.push("Parent/guardian first name is required.");
  if (!str(guardian.lastName)) errors.push("Parent/guardian last name is required.");
  if (!isEmail(str(guardian.email))) errors.push("A valid parent/guardian email is required.");
  if (!isPhone(str(guardian.phone))) errors.push("A valid parent/guardian phone number is required.");
  if (!str(guardian.relationship)) errors.push("Your relationship to the player is required.");

  // Emergency contact — the FM form leans on the guardian for this; we ask
  // explicitly because a guardian standing on the sideline is not reachable.
  if (!str(emergency.name)) errors.push("An emergency contact name is required.");
  if (!isPhone(str(emergency.phone))) errors.push("A valid emergency contact phone number is required.");

  // Consents
  if (consents.policy !== true) {
    errors.push("You must accept the Membership & Payment Policy and NZ Football's registration terms.");
  }
  if (consents.medical !== true) {
    errors.push("You must consent to emergency medical treatment.");
  }

  return errors;
}
