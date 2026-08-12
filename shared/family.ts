// Families: who a child's parents are, and which children belong to a parent.
//
// ClubOS holds people in TWO tables, and that is not going to change:
//   contacts  — academy/term players (type='player'), guardians, staff…
//   children  — holiday-camp children, reached through registration_items,
//               and the anchor for attendance + child_medical.
// Their id sequences overlap (children 1–365, contacts 4–37,343), so a bare
// integer does not identify a person. Every route, link and search result
// therefore carries a namespaced key — `contact-123` / `child-45`. Passing a
// raw id between the two shapes is how /api/admin/contacts/player/:id came to
// 404 on every academy child, and how it could have opened the WRONG child.
export type PersonKind = "contact" | "child";

export type PersonKey = string;

export function personKey(kind: PersonKind, id: number): PersonKey {
  return `${kind}-${id}`;
}

export function parsePersonKey(key: string | undefined | null): { kind: PersonKind; id: number } | null {
  if (!key) return null;
  const m = /^(contact|child)-(\d+)$/.exec(key.trim());
  if (!m) return null;
  const id = parseInt(m[2], 10);
  if (!Number.isFinite(id) || id <= 0) return null;
  return { kind: m[1] as PersonKind, id };
}

// Where a family link came from. Kept on every edge because the three sources
// are not equally authoritative and only one of them is editable:
//   relationship — an explicit row in contact_relationships. Staff can remove it.
//   registration — implied by registrations.guardian_id. It is a payment record;
//                  unlinking it here would be a lie, so the UI says so instead.
//   camp_parent  — children.parent_id, the camp shape. Structural, not editable.
export type LinkSource = "relationship" | "registration" | "camp_parent";

export const LINK_SOURCE_LABEL: Record<LinkSource, string> = {
  relationship: "Linked",
  registration: "From registration",
  camp_parent: "Camp booking",
};

// Free text in the database today (4,378 'parent', plus Mother/Father/Dad/Mum/
// 'Mother/Father'). We offer a controlled list and still render whatever is
// stored — rewriting a family's own words to fit a dropdown is not our call.
// NZ Football's Sporty takes only Guardian 1, Guardian 2 and Next of Kin, so
// the vocabulary is kept compatible with what we will eventually push there.
export const RELATIONSHIP_OPTIONS = [
  "Parent",
  "Mother",
  "Father",
  "Guardian",
  "Grandparent",
  "Caregiver",
  "Next of Kin",
  "Other",
] as const;

export function relationshipLabel(raw: string | null | undefined): string {
  const v = (raw || "").trim();
  if (!v) return "Parent";
  // 'parent' → 'Parent'. Anything the club typed itself is shown verbatim.
  return v.charAt(0).toUpperCase() + v.slice(1);
}

// Duplicate identity: same name, same date of birth. Matches the existing
// partial index contacts_player_identity_idx (lower(first), lower(last), dob),
// so detection uses an index rather than a sequential scan.
//
// A child with NO date of birth never groups with anyone — two children called
// "Jack Smith" with no DOB recorded are not evidence of a duplicate, and
// collapsing them would hide a real person.
export function duplicateKeyOf(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
  dob: string | null | undefined,
): string | null {
  const f = (firstName || "").trim().toLowerCase();
  const l = (lastName || "").trim().toLowerCase();
  const d = (dob || "").trim().slice(0, 10);
  if (!f || !l || !d) return null;
  return `${f}|${l}|${d}`;
}

export type RegistrationSummary = {
  id: number;
  programId: number;
  programName: string;
  programType: string | null;
  status: string;
  amountPaid: string | null;
  // The registration's value in cents. `amount_paid` is left at 0 by the camp
  // checkout — 367 of 535 live registrations — so rendering that field alone
  // shows $0.00 next to a CONFIRMED holiday camp. total_cents is the field
  // that is consistently populated, and the two agree wherever both are set.
  totalCents: number | null;
  registeredAt: string | null;
};

export type ChildRecord = {
  key: PersonKey;
  kind: PersonKind;
  id: number;
  registrationCount: number;
};

// ── Programme & payment history ──────────────────────────────────────────────
// Built 2026-08-12 so the office, the accounts team and any future loyalty
// scheme can see everything a person has ever signed up for and everything
// they have actually paid — across Friendly Manager (10 years) and ClubOS.

export type HistorySource = "friendly_manager" | "clubos" | "camp";

/** One thing a person signed up for: an FM term, a ClubOS term, a camp. */
export type ProgrammeEntry = {
  key: string;
  source: HistorySource;
  programme: string;
  /** FM's long fee wording, or a ClubOS option label. Null when there isn't one. */
  detail: string | null;
  termLabel: string | null;
  seasonYear: number | null;
  /** ClubOS registration status. Null for FM rows, which record no status. */
  status: string | null;
  /** What was charged. Null when the source never recorded an amount. */
  chargedCents: number | null;
  refundedCents: number;
  registeredAt: string | null;
  /**
   * Set when this row is one child on a booking that covered several children.
   * 🔴 The basket is NEVER split across them: registration_items.price_cents is
   * null on 779 of 834 lines, so there is no per-child price to split by, and a
   * child on a half day did not pay the same as a sibling on a full day. The
   * amount belongs to the booking, and the household counts it once.
   */
  sharedBooking: { registrationId: number; childCount: number; totalCents: number | null } | null;
  /**
   * Payments whose term matches this row's term, for this same person. Shown as
   * supporting evidence ONLY. 🔴 Their absence is NOT evidence of non-payment —
   * only 5,969 of 10,294 FM term registrations have a term-name match and 5,612
   * payments match no registration at all, so an "unpaid" badge built on this
   * would libel more than half the families who did pay.
   */
  matchedPaymentCents: number | null;
};

/** One payment actually recorded. Negative amounts are refunds. */
export type PaymentEntry = {
  key: string;
  source: HistorySource;
  paidOn: string | null;
  amountCents: number;
  method: string | null;
  description: string | null;
  termLabel: string | null;
};

export type HistoryTotals = {
  programmeCount: number;
  /** Distinct terms enrolled — the number a loyalty tier would key on. */
  termCount: number;
  seasons: number[];
  paymentCount: number;
  /** Sum of real payment rows, net of refunds. Never inferred from a status. */
  paidCents: number;
  refundedCents: number;
  firstActivity: string | null;
  lastActivity: string | null;
};

export type PersonHistory = {
  programmes: ProgrammeEntry[];
  payments: PaymentEntry[];
  totals: HistoryTotals;
};

/** A parent's roll-up: their own record plus every child, counted once each. */
export type HouseholdTotals = HistoryTotals & {
  childCount: number;
  /** Bookings that covered more than one child, counted once in paidCents. */
  sharedBookingCount: number;
};

export function emptyHistoryTotals(): HistoryTotals {
  return {
    programmeCount: 0, termCount: 0, seasons: [], paymentCount: 0,
    paidCents: 0, refundedCents: 0, firstActivity: null, lastActivity: null,
  };
}

export type FamilyChild = {
  key: PersonKey;          // the record to open when the card is tapped
  kind: PersonKind;
  id: number;
  firstName: string;
  lastName: string;
  dateOfBirth: string | null;
  allergies?: string | null;
  medicalNotes?: string | null;
  epiPen?: boolean;
  sources: LinkSource[];
  relationship: string | null;
  // Every programme this child is on, pooled across all of their records.
  registrations: RegistrationSummary[];
  // The underlying rows this card stands for. Length > 1 means the same child
  // is stored more than once.
  records: ChildRecord[];
  // True when those records span BOTH people tables — a child who did a holiday
  // camp (a `children` row) and also enrolled in the academy (a `contacts` row).
  // That is normal and expected, NOT a data-entry mistake, and is worded
  // differently in the UI from a genuine duplicate.
  crossShape?: boolean;
  // Everything this child ever signed up for and paid, pooled across their
  // records the same way `registrations` is.
  history?: PersonHistory;
};

export type FamilyGuardian = {
  key: PersonKey;
  kind: PersonKind;
  id: number;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  relationship: string | null;
  sources: LinkSource[];
};

function isLiveRegistration(r: RegistrationSummary): boolean {
  return r.status === "confirmed" || r.status === "completed" || r.status === "paid";
}

// Which of several records for one child the card should open. Prefer the
// `contacts` row — it is the modern shape and the only one carrying medical
// notes, school and the NZF identity fields — then the most live registrations,
// then the lowest id. Deliberately deterministic: two staff looking at the same
// family must land on the same record.
function pickPrimary(group: FamilyChild[]): FamilyChild {
  return [...group].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "contact" ? -1 : 1;
    const aLive = a.registrations.filter(isLiveRegistration).length;
    const bLive = b.registrations.filter(isLiveRegistration).length;
    if (aLive !== bLive) return bLive - aLive;
    if (a.registrations.length !== b.registrations.length) return b.registrations.length - a.registrations.length;
    return a.id - b.id;
  })[0];
}

/**
 * Collapse the records that describe the SAME child into one card, pooling
 * their programmes.
 *
 * The earlier version of this picked a survivor and marked the rest
 * "duplicates", which buried real information: a child stored once as a camp
 * `children` row and once as an academy `contacts` row had one of those records
 * — and every programme on it — folded out of sight. In one live family that
 * hid Joel Roberts' CURRENT term enrolment behind last holidays' camp booking.
 *
 * Nothing is merged in the database and no record is dropped: each card lists
 * the rows it stands for, and all of their registrations, so the family reads
 * as the people it actually contains. Merging people for real is destructive
 * and stays a deliberate, human decision.
 */
export function mergeChildRecords(children: FamilyChild[]): FamilyChild[] {
  const groups = new Map<string, FamilyChild[]>();
  const ungrouped: FamilyChild[] = [];

  for (const c of children) {
    const k = duplicateKeyOf(c.firstName, c.lastName, c.dateOfBirth);
    // No date of birth → never grouped. Two children called "Jack Smith" with
    // no DOB are not evidence of a duplicate, and collapsing them would erase
    // a real person.
    if (!k) { ungrouped.push(c); continue; }
    const arr = groups.get(k);
    if (arr) arr.push(c); else groups.set(k, [c]);
  }

  const merged: FamilyChild[] = [];
  for (const group of Array.from(groups.values())) {
    const primary = pickPrimary(group);
    const seenReg = new Set<number>();
    const registrations: RegistrationSummary[] = [];
    for (const rec of group) {
      for (const r of rec.registrations) {
        if (seenReg.has(r.id)) continue;
        seenReg.add(r.id);
        registrations.push(r);
      }
    }
    registrations.sort((a, b) => (b.registeredAt || "").localeCompare(a.registeredAt || ""));

    const sources = Array.from(new Set(group.flatMap(g => g.sources)));
    merged.push({
      ...primary,
      registrations,
      sources,
      records: group.map(g => ({
        key: g.key, kind: g.kind, id: g.id, registrationCount: g.registrations.length,
      })).sort((a, b) => a.key.localeCompare(b.key)),
      crossShape: new Set(group.map(g => g.kind)).size > 1,
      // Keep the richest medical detail available across the records — an
      // allergy recorded on one row must not vanish because the card opens
      // the other.
      allergies: group.map(g => g.allergies).find(Boolean) ?? null,
      medicalNotes: group.map(g => g.medicalNotes).find(Boolean) ?? null,
      epiPen: group.some(g => g.epiPen === true),
    });
  }

  for (const c of ungrouped) {
    merged.push({ ...c, records: [{ key: c.key, kind: c.kind, id: c.id, registrationCount: c.registrations.length }] });
  }
  return merged;
}

// Age in whole years, computed on calendar parts. Never via Date arithmetic —
// `new Date(dob)` reads a day earlier in NZ and ages a child by a year across
// the UTC boundary, which is exactly how a 9th birthday becomes an 8th.
export function ageFromDob(dob: string | null | undefined, todayIso: string): number | null {
  if (!dob) return null;
  const [by, bm, bd] = dob.slice(0, 10).split("-").map(Number);
  const [ty, tm, td] = todayIso.slice(0, 10).split("-").map(Number);
  if (!by || !bm || !bd || !ty || !tm || !td) return null;
  let age = ty - by;
  if (tm < bm || (tm === bm && td < bd)) age--;
  return age >= 0 && age < 130 ? age : null;
}
