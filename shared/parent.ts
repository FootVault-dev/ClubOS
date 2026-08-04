// ─────────────────────────────────────────────────────────────────────────────
// PARENT ACCOUNTS — shared shapes for the family-facing dashboard.
//
// Client-safe: no DB, no crypto, no server imports. The server owns every
// decision in here; these are the shapes it returns and the rules both sides
// agree on.
// ─────────────────────────────────────────────────────────────────────────────

/** How long a signed-in parent stays signed in. Families check in about once a
 *  term; 30 days spans a term's registration window without asking twice. */
export const PARENT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** The login code's life. Long enough to find the email on a phone, short
 *  enough that a code left visible on a shared screen goes stale. */
export const PARENT_CODE_TTL_MS = 15 * 60 * 1000;

/** Wrong guesses before a code is dead and a new one must be requested. */
export const PARENT_CODE_MAX_ATTEMPTS = 5;

/** Codes per address per hour, and per origin IP per hour. */
export const PARENT_CODE_MAX_PER_EMAIL_HOUR = 5;
export const PARENT_CODE_MAX_PER_IP_HOUR = 20;

/** The session cookie. Read from the raw header — ClubOS has no cookie-parser,
 *  so `req.cookies` is silently undefined and reading it fails open. */
export const PARENT_COOKIE = "cufc_parent";

// ── What the dashboard renders ───────────────────────────────────────────────

/**
 * What we can HONESTLY say about one registration's money.
 *
 * 🔴 There is deliberately no "you owe $X" state, and no account-level balance.
 * Probed against prod 2026-08-04:
 *     confirmed          414 registrations — only 169 have any amount_paid
 *     pending            116 registrations — 0 have any amount_paid
 *     partially_refunded   4 — 0 have any amount_paid
 * `amount_paid` is simply not maintained: the camp checkout never set it, and
 * office walk-ups did not set it until v372. So `total_cents − amount_paid`
 * would have told ~245 families who have ALREADY PAID that they owed money,
 * and 116 people who abandoned a checkout that they owed us $23,649.
 *
 * A wrong balance on a parent's own screen is worse than no balance. Until the
 * payments ledger is trustworthy, this reports what each registration IS and
 * what the fee WAS, and claims a shortfall only where a real part-payment is
 * actually recorded.
 */
export type ParentFeeState =
  | "paid"        // confirmed, and a payment covering the fee is recorded
  | "part_paid"   // confirmed, a payment is recorded, and it is short — real
  | "recorded"    // confirmed, but no payment recorded: say nothing about money
  | "incomplete"  // pending — an abandoned checkout, not a debt
  | "cancelled"   // cancelled / refunded / partially refunded
  | "free";       // no fee

/** One programme a child is on, with the money as the club sees it. */
export type ParentRegistration = {
  id: number;
  programId: number;
  programName: string;
  programType: string | null;
  status: string;              // pending | confirmed | cancelled …
  registeredAt: string | null; // ISO day
  totalCents: number;
  paidCents: number;
  owingCents: number;
  feeState: ParentFeeState;
  paymentMode: string | null;  // upfront | weekly
};

/** A child as their parent sees them. `key` is the namespaced person key from
 *  shared/family.ts — two people tables with overlapping ids. */
export type ParentChild = {
  key: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string | null;
  age: number | null;
  /** NZF age grade = seasonYear − birthYear. Never Date arithmetic. */
  ageGrade: number | null;
  registrations: ParentRegistration[];
  owingCents: number;
  /** Details the parent can see and correct. */
  details: ParentChildDetails;
  /** True when the club's record is missing something NZ Football requires.
   *  Surfaced as a gentle prompt, never a block. */
  needsIdentity: boolean;
};

export type ParentChildDetails = {
  medicalNotes: string | null;
  allergies: string | null;
  emergencyContact: string | null;
  emergencyPhone: string | null;
  school: string | null;
  photoConsent: boolean;
  medicalConsent: boolean;
  countryOfBirth: string | null;
  nationality: string | null;
  ethnicity: string | null;
  subEthnicity: string | null;
};

export type ParentProfile = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  alternatePhone: string | null;
  address: string | null;
};

export type ParentMe = {
  profile: ParentProfile;
  children: ParentChild[];
  owingCents: number;
  today: string;
  /** Every guardian contact row this login speaks for. Diagnostic only — a
   *  parent never sees it, but it explains a family that looks merged. */
  guardianIds: number[];
};

// ── Rules both sides apply ───────────────────────────────────────────────────

const CLOSED = new Set(["cancelled", "refunded", "partially_refunded"]);

export function feeStateFor(totalCents: number, paidCents: number, status: string): ParentFeeState {
  if (CLOSED.has(status)) return "cancelled";
  if (status === "pending") return "incomplete";
  if (!totalCents) return "free";
  if (paidCents >= totalCents) return "paid";
  // A recorded part-payment is a real fact. Zero is an ABSENCE of a record,
  // which is not the same thing and must never be reported as a shortfall.
  if (paidCents > 0) return "part_paid";
  return "recorded";
}

/**
 * The shortfall we are willing to state out loud: only where a genuine
 * part-payment is on file. Everything else returns 0, so no screen can add up
 * an "outstanding balance" out of missing data.
 */
export function owingFor(totalCents: number, paidCents: number, status: string): number {
  if (feeStateFor(totalCents, paidCents, status) !== "part_paid") return 0;
  return Math.max(0, (totalCents || 0) - (paidCents || 0));
}

/** Plain-English label for a fee state. One wording, both surfaces. */
export function feeLabelFor(state: ParentFeeState, totalCents: number, owingCents: number,
                            money: (c: number) => string): string {
  switch (state) {
    case "paid":       return "Paid";
    case "part_paid":  return `${money(owingCents)} still to pay`;
    case "recorded":   return money(totalCents);
    case "incomplete": return "Not completed";
    case "cancelled":  return "Cancelled";
    case "free":       return "No fee";
  }
}

/** NZ Football classifies by year of birth: a child born 2017 is U9 in 2026.
 *  Calendar parts only — `new Date("2017-01-01")` reads 2016 in NZ. */
export function ageGradeFor(dob: string | null | undefined, todayIso: string): number | null {
  if (!dob || dob.length < 4) return null;
  const birthYear = parseInt(dob.slice(0, 4), 10);
  const seasonYear = parseInt(todayIso.slice(0, 4), 10);
  if (!birthYear || !seasonYear) return null;
  const grade = seasonYear - birthYear;
  return grade > 0 && grade < 100 ? grade : null;
}

export function centsToDollars(cents: number): string {
  return (cents / 100).toLocaleString("en-NZ", { style: "currency", currency: "NZD" });
}

/** Normalise an address the same way on both sides, so a parent who types
 *  " Dad@Example.COM " reaches the same account every time. */
export function normalizeParentEmail(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export function looksLikeEmail(raw: unknown): boolean {
  const e = normalizeParentEmail(raw);
  return e.length <= 254 && EMAIL_RE.test(e);
}
