// Academy registration — pure logic. No DB, no Stripe, no network.
//
// Everything here is derived from a written source, never invented:
//   • Age grades      — NZ Football classifies by YEAR OF BIRTH. A child born in
//                       2017 is U9 for the 2026 season. So grade = season − birthYear.
//                       (Corroborated by the club's own Membership & Payment Policy
//                       2026 §5, which frames age "as at 1 January of the season".)
//   • Ethnicity       — NZ Football's OWN seven groups, pulled from their
//                       reference endpoints (shared/nzf-vocabulary.ts) and
//                       validated in shared/nzf-identity.ts. Was Stats NZ level-1
//                       free text until 28 July 2026; that shape is unregisterable,
//                       because NZF splits NZ European from Other European and
//                       rejects a bare "European". Sporty refused a 495-person
//                       import on exactly this. Never guess which side someone
//                       belongs on — the family answers, we record.
//   • 5% discount     — Membership & Payment Policy 2026: "5% discount on training
//                       fees only when the full amount for all four terms ... is
//                       paid in one single payment at the start of the season."
//                       It explicitly does NOT apply to Technification, Goalkeeper,
//                       holiday programmes or camps → i.e. only `academy_section`
//                       = 'core'. Getting this wrong under-charges families.
//
// Tested by script/test-academy.ts (npx tsx script/test-academy.ts).

import { validateNzfAddress, validateNzfIdentity } from "./nzf-identity";

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

// ── Pro-rata: join late, pay for what's left ────────────────────────────────

/** Today's date in New Zealand, as `YYYY-MM-DD`.
 *
 *  NEVER use `new Date().toISOString().slice(0,10)` for an NZ date. NZ is UTC+12
 *  (+13 in daylight time), so from midday local onwards the UTC date is still
 *  YESTERDAY. A pro-rata computed from it hands the parent an extra session's
 *  discount for half of every day, and misgrades children born on 1 January.
 *  `en-CA` formats as YYYY-MM-DD. */
export function nzTodayIso(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Pacific/Auckland",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** Whole days from `a` to `b`, both `YYYY-MM-DD`. Anchored at UTC midnight so
 *  the arithmetic is timezone-free — these are calendar dates, not instants. */
export function daysBetween(aIso: string, bIso: string): number | null {
  const p = (s: string) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s).trim());
    return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  };
  const a = p(aIso);
  const b = p(bIso);
  if (a === null || b === null) return null;
  return Math.round((b - a) / 86_400_000);
}

export interface TermProgress {
  /** Sessions the parent is actually buying. */
  sessionsRemaining: number;
  totalSessions: number;
  /** 0 = term hasn't started, so nothing has been missed. */
  weeksElapsed: number;
  status: "before" | "running" | "ended";
}

/**
 * How much of a term is left, in sessions.
 *
 * Daniel's rule, verbatim: "If they join 5 weeks into the term and it's a
 * 10-week term, then they only pay for the 5 weeks."
 *
 * So a child joining on the first day of week 6 has 5 weeks elapsed and 5
 * sessions remaining. Before the term starts, nothing is missed → full price.
 * After it ends, nothing is left → the term can't be sold.
 *
 * The old `quoteProgram()` counted weeks *to the end date* and added one, which
 * returns 6 in that example — the parent pays for a session that has already
 * happened.
 */
export function termProgress(
  todayIso: string,
  termStartIso: string,
  termEndIso: string,
  totalSessions: number,
): TermProgress | null {
  if (!Number.isInteger(totalSessions) || totalSessions <= 0) return null;
  const sinceStart = daysBetween(termStartIso, todayIso);
  const untilEnd = daysBetween(todayIso, termEndIso);
  if (sinceStart === null || untilEnd === null) return null;

  if (sinceStart < 0) {
    return { sessionsRemaining: totalSessions, totalSessions, weeksElapsed: 0, status: "before" };
  }
  if (untilEnd < 0) {
    return { sessionsRemaining: 0, totalSessions, weeksElapsed: totalSessions, status: "ended" };
  }
  const weeksElapsed = Math.min(totalSessions, Math.floor(sinceStart / 7));
  return {
    sessionsRemaining: Math.max(0, totalSessions - weeksElapsed),
    totalSessions,
    weeksElapsed,
    status: "running",
  };
}

/** Pro-rated price for a part-term join. Rounds the price the parent PAYS, and
 *  `quoteAcademy` derives the discount from it, so the two always reconcile. */
export function prorateTermPriceCents(
  termPriceCents: number,
  sessionsRemaining: number,
  totalSessions: number,
): number {
  if (!Number.isInteger(termPriceCents) || termPriceCents <= 0) {
    throw new Error("termPriceCents must be a positive integer number of cents");
  }
  if (sessionsRemaining >= totalSessions) return termPriceCents;
  if (sessionsRemaining <= 0) return 0;
  return Math.round((termPriceCents * sessionsRemaining) / totalSessions);
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

/**
 * Can this programme be bought for the whole year?
 *
 * Two gates, both straight from the Membership & Payment Policy 2026:
 *
 *  1. The 5% is a discount on TRAINING fees. Technification, Goalkeeper and the
 *     Morning Programme ('additional') are excluded, so they sell by the term only.
 *  2. "...the full amount for all four terms ... is paid in one single payment at
 *     the START OF THE SEASON." A parent joining in Term 3 who bought "the full
 *     year" would be paying for two terms that have already finished. So the
 *     full-year plan is only offered while the bound term is Term 1.
 *
 *  Pass `termNumber = null` (no term bound) to keep the year plan available — an
 *  unbound programme has no season to be late for.
 */
export function fullYearAvailable(section: AcademySection, termNumber?: number | null): boolean {
  if (section !== "core") return false;
  if (termNumber === null || termNumber === undefined) return true;
  return termNumber === 1;
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

// ── Promo codes ─────────────────────────────────────────────────────────────

/** Stripe will not take a card charge below NZD $0.50. A code that drives the
 *  total under that has to be refused, not silently rounded up — and we have no
 *  free-registration path for the academy yet. */
export const STRIPE_MIN_CHARGE_CENTS = 50;

export type PromoValueType = "percentage" | "fixed_amount" | "fixed";

/**
 * Cents to take off, given the amount the parent would otherwise pay.
 *
 * Applied AFTER pro-rata, on what's actually owed — a "20% off" code on a
 * half-term join discounts the half-term price, not the full-term list price.
 * Clamped to [0, base] so a code can never make a total negative, and never
 * credits the parent money.
 */
export function promoDiscountCents(baseCents: number, valueType: string, value: number | string): number {
  if (!Number.isInteger(baseCents) || baseCents <= 0) return 0;
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return 0;
  const raw = valueType === "percentage" ? Math.round((baseCents * v) / 100) : Math.round(v * 100);
  return Math.min(baseCents, Math.max(0, raw));
}

export interface PromoOutcome {
  ok: boolean;
  promoCents: number;
  totalCents: number;
  reason?: string;
}

/** Does this code leave a chargeable amount? Pure — the caller has already
 *  loaded and authorised the discount row. */
export function applyPromo(payableCents: number, valueType: string, value: number | string): PromoOutcome {
  const promoCents = promoDiscountCents(payableCents, valueType, value);
  const totalCents = payableCents - promoCents;
  if (totalCents <= 0) {
    return { ok: false, promoCents, totalCents, reason: "That code covers the full fee — we can't take a $0 payment here yet." };
  }
  if (totalCents < STRIPE_MIN_CHARGE_CENTS) {
    return { ok: false, promoCents, totalCents, reason: `The smallest card payment we can take is $${(STRIPE_MIN_CHARGE_CENTS / 100).toFixed(2)}.` };
  }
  return { ok: true, promoCents, totalCents };
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
    // NZF audit fields — structured. Codes and ids come straight off NZ
    // Football's published vocabulary (shared/nzf-vocabulary.ts), so the answer
    // is valid at the moment it is given. The old free-text twins below are
    // still accepted from legacy callers, but they no longer satisfy the check.
    countryOfBirthCode?: unknown;
    nationalityCode?: unknown;
    ethnicityGroupId?: unknown;
    ethnicitySelectionIds?: unknown;
    ethnicity2GroupId?: unknown;
    ethnicity2SelectionIds?: unknown;
    // Legacy free-text (kept so an older client doesn't 500; ignored for
    // validation because these are precisely the values NZF rejects).
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
    /** Legacy one-line address. Superseded by `addressParts`. */
    address?: unknown;
    /** Six-part address — all parts required, because Sporty rejects the whole
     *  address if any one is missing (Region included). */
    addressParts?: {
      street?: unknown;
      suburb?: unknown;
      city?: unknown;
      region?: unknown;
      postcode?: unknown;
      country?: unknown;
    };
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

  // NZ Football audit fields — validated against NZF's own vocabulary rather
  // than accepted as free text. This is the fix for the 28 July 2026 import
  // refusal: free text produced values NZF cannot register ("Christchurch" as a
  // country of birth, bare "European" as an ethnic group), and the failure only
  // surfaced months later at their validation gate.
  const identity = validateNzfIdentity({
    countryOfBirthCode: child.countryOfBirthCode,
    nationalityCode: child.nationalityCode,
    ethnicityGroupId: child.ethnicityGroupId,
    ethnicitySelectionIds: child.ethnicitySelectionIds,
    ethnicity2GroupId: child.ethnicity2GroupId,
    ethnicity2SelectionIds: child.ethnicity2SelectionIds,
  });
  if (!identity.ok) errors.push(...identity.errors);

  // Address — six parts, all required. Sporty returns the same "Address is
  // required." whichever part is absent, so there is no partial credit.
  const address = validateNzfAddress(guardian.addressParts ?? {});
  if (!address.ok) errors.push(...address.errors);

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
