// ─────────────────────────────────────────────────────────────────────────────
// PROGRAMME & PAYMENT HISTORY — every term a person signed up for, and every
// dollar actually recorded against them.
//
// Built 2026-08-12 (Daniel): the office could see a family's links but not what
// they had ever bought. Accounts needs the transaction history, the football
// side needs the programme history, and a loyalty scheme needs both.
//
// THE ONE RULE, as with resolveFamily(): both the player page and the parent
// page resolve history through resolvePeopleHistory() here. Four sources record
// what a family bought, and a page that reads one of them is how "No programmes"
// ended up under a child with two terms and a $160 card payment on file:
//
//   fm_registration_history   10,294 rows — 10 years of FM terms, 3,194 people
//   fm_payment_history         9,624 rows — $1.21m, 2017-08-09 → 2026-07-05
//   registrations              ClubOS term enrolments (the person IS contact_id)
//   registration_items         holiday camps (the child is a `children` row)
//
// ── The money rules, which are the whole point ───────────────────────────────
//
// 🔴 A PAYMENT BELONGS TO THE PERSON NAMED ON IT. fm_payment_history.contact_id
//    points at the PLAYER, not the payer: 8,528 payments ($981k) sit against
//    player-type contacts and 666 against guardians, and the row's own
//    first/last name matches that contact on all 9,195 joinable rows. So a
//    child's page shows their own payments, and a parent's total is the sum of
//    their children's — not a re-reading of the same rows from the other side.
//
// 🔴 A MULTI-CHILD BOOKING IS COUNTED ONCE AND NEVER SPLIT. 36 live camp
//    registrations cover 2–3 children under one total_cents, and
//    registration_items.price_cents is NULL on 779 of 834 lines — there is no
//    per-child price to divide by, and an even split would invent one (a child
//    on a half day did not pay what their sibling on a full day paid). Each
//    child's row carries the booking, and the household adds it once.
//
// 🔴 THE ABSENCE OF A PAYMENT IS NOT EVIDENCE OF NON-PAYMENT. Payments and term
//    registrations only agree on term_name 58% of the time (5,969 of 10,294
//    registrations match; 5,612 payments match no registration for that person).
//    So there is deliberately NO paid/unpaid badge. Where a term-name match
//    exists it is shown as supporting evidence; where it doesn't, the page says
//    nothing rather than telling the accounts team a family didn't pay.
//
// 🔴 TOTALS COME FROM REAL PAYMENT ROWS, never from a status. A "confirmed"
//    registration with amount_paid 0.00 is the normal camp shape (367 of 535
//    live registrations), so inferring payment from status would invent revenue.
// ─────────────────────────────────────────────────────────────────────────────
import { sql } from "drizzle-orm";
import { db } from "./db";
import {
  personKey, emptyHistoryTotals,
  type PersonKey, type PersonKind,
  type ProgrammeEntry, type PaymentEntry, type PersonHistory, type HistoryTotals,
} from "@shared/family";

/** A `date`/timestamp column as a bare ISO day — never through UTC. */
function isoDay(v: any): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "string") return v.slice(0, 10);
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, "0");
    const d = String(v.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
}

const num = (v: any): number | null =>
  v === null || v === undefined || v === "" ? null : Number(v);

/** `amount_paid` is numeric dollars; total_cents is cents. Keep them apart. */
function dollarsToCents(v: any): number | null {
  const n = num(v);
  return n === null || Number.isNaN(n) ? null : Math.round(n * 100);
}

function blankHistory(): PersonHistory {
  return { programmes: [], payments: [], totals: emptyHistoryTotals() };
}

function ensure(map: Map<number, PersonHistory>, id: number): PersonHistory {
  let h = map.get(id);
  if (!h) { h = blankHistory(); map.set(id, h); }
  return h;
}

const idList = (ids: number[]) => sql.join(ids.map(i => sql`${i}`), sql`, `);

/**
 * History for a batch of people, keyed by contact id and by camp-child id.
 *
 * Batched on purpose: a parent with six children resolving one query each is
 * how this codebase exhausted its connection pool before (see the note on
 * getRegistrationsForContact in family-routes.ts).
 */
export async function resolvePeopleHistory(
  contactIds: number[],
  childIds: number[],
): Promise<{ byContact: Map<number, PersonHistory>; byChild: Map<number, PersonHistory> }> {
  const byContact = new Map<number, PersonHistory>();
  const byChild = new Map<number, PersonHistory>();
  const cIds = Array.from(new Set(contactIds.filter(Boolean)));
  const kIds = Array.from(new Set(childIds.filter(Boolean)));

  // Term-name → paid cents, per person. Built first so a programme row can show
  // the payments recorded for that same term as supporting evidence.
  const paidByTerm = new Map<string, number>();
  const termKey = (id: number, term: string | null) => `${id}|${(term || "").toLowerCase()}`;

  const [fmRegs, fmPays, liveRegs, campRegs] = await Promise.all([
    cIds.length ? db.execute(sql`
      SELECT h.contact_id, h.id, h.term_name, h.season_year, h.programme_group, h.position,
             t.start_date
      FROM fm_registration_history h
      LEFT JOIN terms t ON t.id = h.term_id
      WHERE h.contact_id IN (${idList(cIds)})`) : { rows: [] as any[] },

    cIds.length ? db.execute(sql`
      SELECT p.contact_id, p.id, p.fee_description, p.term_name, p.season_year,
             p.programme, p.method, p.paid_on, p.amount_cents
      FROM fm_payment_history p
      WHERE p.contact_id IN (${idList(cIds)})
      ORDER BY p.paid_on DESC NULLS LAST`) : { rows: [] as any[] },

    cIds.length ? db.execute(sql`
      SELECT r.contact_id, r.id, r.program_id, r.status::text AS status,
             r.total_cents, r.amount_paid::text AS amount_paid,
             r.refunded_amount_cents, r.registered_at, r.season_year,
             r.payment_method, r.paid_at,
             p.name AS program_name, p.type::text AS program_type,
             (SELECT count(DISTINCT ri.child_id) FROM registration_items ri
               WHERE ri.registration_id = r.id AND ri.child_id IS NOT NULL) AS child_count
      FROM registrations r JOIN programs p ON p.id = r.program_id
      WHERE r.contact_id IN (${idList(cIds)})
      ORDER BY r.registered_at DESC NULLS LAST`) : { rows: [] as any[] },

    kIds.length ? db.execute(sql`
      SELECT DISTINCT ON (ri.child_id, r.id)
             ri.child_id, r.id, r.status::text AS status, r.total_cents,
             r.amount_paid::text AS amount_paid, r.refunded_amount_cents,
             r.registered_at, r.payment_method, r.paid_at,
             p.name AS program_name, p.type::text AS program_type,
             (SELECT count(DISTINCT ri2.child_id) FROM registration_items ri2
               WHERE ri2.registration_id = r.id AND ri2.child_id IS NOT NULL) AS child_count
      FROM registration_items ri
      JOIN registrations r ON r.id = ri.registration_id
      JOIN programs p ON p.id = r.program_id
      WHERE ri.child_id IN (${idList(kIds)})
      ORDER BY ri.child_id, r.id, r.registered_at DESC NULLS LAST`) : { rows: [] as any[] },
  ]);

  // ── Payments first ─────────────────────────────────────────────────────────
  for (const row of fmPays.rows as any[]) {
    const cid = Number(row.contact_id);
    const h = ensure(byContact, cid);
    const cents = Number(row.amount_cents) || 0;
    h.payments.push({
      key: `fmpay-${row.id}`,
      source: "friendly_manager",
      paidOn: isoDay(row.paid_on),
      amountCents: cents,
      method: row.method || null,
      description: row.fee_description || row.programme || null,
      termLabel: row.term_name || null,
    });
    const k = termKey(cid, row.term_name);
    paidByTerm.set(k, (paidByTerm.get(k) || 0) + cents);
  }

  // ── Friendly Manager term registrations ────────────────────────────────────
  for (const row of fmRegs.rows as any[]) {
    const cid = Number(row.contact_id);
    const h = ensure(byContact, cid);
    const matched = paidByTerm.get(termKey(cid, row.term_name));
    h.programmes.push({
      key: `fmreg-${row.id}`,
      source: "friendly_manager",
      programme: row.programme_group || row.term_name || "Programme",
      detail: row.position || null,
      termLabel: row.term_name || null,
      seasonYear: num(row.season_year),
      status: null,
      chargedCents: null,
      refundedCents: 0,
      registeredAt: isoDay(row.start_date),
      sharedBooking: null,
      matchedPaymentCents: matched === undefined ? null : matched,
    });
  }

  // ── ClubOS registrations where the person is the registrant ────────────────
  for (const row of liveRegs.rows as any[]) {
    const cid = Number(row.contact_id);
    const h = ensure(byContact, cid);
    const childCount = Number(row.child_count) || 0;
    const total = num(row.total_cents);
    const paidCents = dollarsToCents(row.amount_paid) || 0;
    const refunded = Number(row.refunded_amount_cents) || 0;

    h.programmes.push({
      key: `reg-${row.id}`,
      source: "clubos",
      programme: row.program_name,
      detail: row.program_type || null,
      termLabel: null,
      seasonYear: num(row.season_year),
      status: row.status,
      chargedCents: total,
      refundedCents: refunded,
      registeredAt: isoDay(row.registered_at),
      sharedBooking: childCount > 1
        ? { registrationId: Number(row.id), childCount, totalCents: total }
        : null,
      matchedPaymentCents: null,
    });

    // A ClubOS registration carries its own money, so it is also a payment —
    // but only where a real amount was recorded. Never infer one from status.
    if (paidCents > 0) {
      h.payments.push({
        key: `regpay-${row.id}`,
        source: "clubos",
        paidOn: isoDay(row.paid_at) || isoDay(row.registered_at),
        amountCents: paidCents,
        method: row.payment_method || null,
        description: row.program_name,
        termLabel: null,
      });
    }
    if (refunded > 0) {
      h.payments.push({
        key: `regref-${row.id}`,
        source: "clubos",
        paidOn: isoDay(row.paid_at) || isoDay(row.registered_at),
        amountCents: -refunded,
        method: "refund",
        description: `Refund — ${row.program_name}`,
        termLabel: null,
      });
    }
  }

  // ── Holiday camps, reached through a per-day line ──────────────────────────
  for (const row of campRegs.rows as any[]) {
    const kid = Number(row.child_id);
    const h = ensure(byChild, kid);
    const childCount = Number(row.child_count) || 0;
    const total = num(row.total_cents);
    const paidCents = dollarsToCents(row.amount_paid) || 0;
    const refunded = Number(row.refunded_amount_cents) || 0;

    h.programmes.push({
      key: `camp-${row.id}-${kid}`,
      source: "camp",
      programme: row.program_name,
      detail: row.program_type || null,
      termLabel: null,
      seasonYear: null,
      status: row.status,
      chargedCents: total,
      refundedCents: refunded,
      registeredAt: isoDay(row.registered_at),
      sharedBooking: childCount > 1
        ? { registrationId: Number(row.id), childCount, totalCents: total }
        : null,
      matchedPaymentCents: null,
    });

    // 🔴 Only a single-child booking contributes money to THIS child. A shared
    // basket has no per-child price, so it is left for the household to count
    // once rather than attributed here and double-counted across siblings.
    if (paidCents > 0 && childCount <= 1) {
      h.payments.push({
        key: `camppay-${row.id}-${kid}`,
        source: "camp",
        paidOn: isoDay(row.paid_at) || isoDay(row.registered_at),
        amountCents: paidCents,
        method: row.payment_method || null,
        description: row.program_name,
        termLabel: null,
      });
    }
  }

  for (const h of Array.from(byContact.values())) finalise(h);
  for (const h of Array.from(byChild.values())) finalise(h);
  return { byContact, byChild };
}

/** Sort each list newest-first and compute the totals a human reads. */
function finalise(h: PersonHistory): void {
  // Undated FM rows sort last rather than pretending to a position in time.
  h.programmes.sort((a, b) => {
    const ay = a.seasonYear ?? -1, by = b.seasonYear ?? -1;
    if (ay !== by) return by - ay;
    return (b.termLabel || b.registeredAt || "").localeCompare(a.termLabel || a.registeredAt || "");
  });
  h.payments.sort((a, b) => (b.paidOn || "").localeCompare(a.paidOn || ""));
  h.totals = totalsFor(h.programmes, h.payments);
}

export function totalsFor(programmes: ProgrammeEntry[], payments: PaymentEntry[]): HistoryTotals {
  const terms = new Set<string>();
  const seasons = new Set<number>();
  for (const p of programmes) {
    if (p.termLabel) terms.add(p.termLabel.toLowerCase());
    if (p.seasonYear) seasons.add(p.seasonYear);
  }
  let paid = 0, refunded = 0;
  const days: string[] = [];
  for (const p of payments) {
    if (p.amountCents < 0) refunded += -p.amountCents;
    paid += p.amountCents; // net: a refund row is already negative
    if (p.paidOn) days.push(p.paidOn);
  }
  for (const p of programmes) if (p.registeredAt) days.push(p.registeredAt);
  days.sort();
  return {
    programmeCount: programmes.length,
    termCount: terms.size,
    seasons: Array.from(seasons).sort((a, b) => b - a),
    paymentCount: payments.length,
    paidCents: paid,
    refundedCents: refunded,
    firstActivity: days[0] || null,
    lastActivity: days[days.length - 1] || null,
  };
}

/**
 * A household roll-up: the parent's own record plus every child's, with each
 * shared booking counted exactly once no matter how many siblings it covered.
 */
export function householdTotals(
  own: PersonHistory | null,
  childHistories: PersonHistory[],
): HistoryTotals & { childCount: number; sharedBookingCount: number } {
  const programmes: ProgrammeEntry[] = [];
  const payments: PaymentEntry[] = [];
  for (const h of [own, ...childHistories]) {
    if (!h) continue;
    programmes.push(...h.programmes);
    payments.push(...h.payments);
  }

  // Each shared basket adds its total once, keyed by registration id.
  const sharedTotals = new Map<number, number>();
  for (const p of programmes) {
    if (p.sharedBooking && p.sharedBooking.totalCents !== null) {
      sharedTotals.set(p.sharedBooking.registrationId, p.sharedBooking.totalCents);
    }
  }

  const base = totalsFor(programmes, payments);
  let sharedSum = 0;
  for (const cents of Array.from(sharedTotals.values())) sharedSum += cents;

  return {
    ...base,
    paidCents: base.paidCents + sharedSum,
    childCount: childHistories.length,
    sharedBookingCount: sharedTotals.size,
  };
}

export function historyKeyFor(kind: PersonKind, id: number): PersonKey {
  return personKey(kind, id);
}
