import { REAL_STATUS_SQL, contactHiddenSql, childHiddenSql } from "./registration-visibility";
// ─────────────────────────────────────────────────────────────────────────────
// FAMILIES — parents and children, visible from both sides.
//
// Built 2026-08-02 after Olga (CUFC office) reported she could not find a child
// who had paid online, only their parent, and that a parent's page showed
// neither the child nor their programme. The links were never missing: there
// are 4,466 rows in contact_relationships and every registration carries a
// guardian_id. Nothing surfaced them.
//
//   GET    /api/admin/people?q=&filter=       — one search over BOTH people tables
//   GET    /api/admin/people/:key             — a person + their whole family
//   POST   /api/admin/people/:key/guardians   — link a guardian to a child
//   DELETE /api/admin/people/:key/guardians/:guardianKey
//
// THE ONE RULE: every screen resolves a family through resolveFamily() here.
// Three mechanisms record a family, and a page that reads only one of them is
// how this bug happened in the first place:
//   contact_relationships   academy/term children + everything imported from
//                           Friendly Manager (the explicit, editable edge)
//   registrations.guardian_id → registrations.contact_id
//                           the academy shape, implied by a payment
//   children.parent_id      holiday camps, where the child is a `children` row
//
// Camp children are NOT migrated into `contacts`; attendance, registration_items
// and child_medical all hang off children.id. The two shapes are unified at
// READ time and keyed by a namespaced person key instead (see shared/family.ts).
//
// Access: requireAuth + the "contacts" tab — the same audience that can already
// see the Contacts page in the sidebar. `contacts` is an org-less shared pool
// holding children's medical notes and dates of birth, so this deliberately
// does not widen who can read it.
// ─────────────────────────────────────────────────────────────────────────────
import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "./db";
import { requireAuth, requireTab } from "./auth";
import { nzTodayIso } from "@shared/housing";
import {
  personKey, parsePersonKey, mergeChildRecords, relationshipLabel,
  type PersonKey, type PersonKind, type LinkSource,
  type FamilyChild, type FamilyGuardian, type RegistrationSummary,
  type PersonHistory, type HistoryTotals, emptyHistoryTotals,
} from "@shared/family";
import { resolvePeopleHistory, householdRollup, totalsFor } from "./person-history";

const s = (v: any, max = 300): string => String(v ?? "").trim().slice(0, max);

/**
 * A `date` column as a bare ISO day, whatever the driver hands back.
 *
 * drizzle currently returns date columns as strings, but the raw pg driver
 * parses them into a Date at LOCAL midnight — and `String(thatDate).slice(0,10)`
 * yields "Thu Dec 13" while `.toISOString()` yields the day BEFORE, because NZ
 * midnight is the previous day in UTC. Either would corrupt a child's date of
 * birth, which sets their age grade and decides whether two records are the
 * same child. Read the calendar parts; never round-trip through UTC.
 */
function isoDate(v: any): string | null {
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

// ── Registrations, batched ───────────────────────────────────────────────────
// Never per-person in a loop: a family page that issued one query per child
// exhausted the connection pool once already (see getRegistrationsForContact).

function emptyMap(): Map<number, RegistrationSummary[]> { return new Map(); }

function pushReg(map: Map<number, RegistrationSummary[]>, id: number, r: RegistrationSummary) {
  const arr = map.get(id);
  if (arr) arr.push(r); else map.set(id, [r]);
}

/** Registrations where the person IS the registrant (the academy shape). */
async function regsByContactId(ids: number[]): Promise<Map<number, RegistrationSummary[]>> {
  if (ids.length === 0) return emptyMap();
  const rows = await db.execute(sql`
    SELECT r.contact_id, r.id, r.program_id, r.status::text AS status,
           r.amount_paid::text AS amount_paid, r.total_cents, r.registered_at,
           p.name AS program_name, p.type::text AS program_type
    FROM registrations r
    JOIN programs p ON p.id = r.program_id
    WHERE r.contact_id IN (${sql.join(ids.map(i => sql`${i}`), sql`, `)})
      AND r.status IN ${REAL_STATUS_SQL}
    ORDER BY r.registered_at DESC NULLS LAST`);
  const map = emptyMap();
  for (const row of rows.rows as any[]) {
    pushReg(map, Number(row.contact_id), {
      id: Number(row.id), programId: Number(row.program_id),
      programName: row.program_name, programType: row.program_type,
      status: row.status, amountPaid: row.amount_paid,
      totalCents: row.total_cents === null || row.total_cents === undefined ? null : Number(row.total_cents),
      registeredAt: row.registered_at ? new Date(row.registered_at).toISOString() : null,
    });
  }
  return map;
}

/** Registrations reached through a per-day camp line item (the camp shape). */
async function regsByChildId(ids: number[]): Promise<Map<number, RegistrationSummary[]>> {
  if (ids.length === 0) return emptyMap();
  const rows = await db.execute(sql`
    SELECT DISTINCT ON (ri.child_id, r.id)
           ri.child_id, r.id, r.program_id, r.status::text AS status,
           r.amount_paid::text AS amount_paid, r.total_cents, r.registered_at,
           p.name AS program_name, p.type::text AS program_type
    FROM registration_items ri
    JOIN registrations r ON r.id = ri.registration_id
    JOIN programs p ON p.id = r.program_id
    WHERE ri.child_id IN (${sql.join(ids.map(i => sql`${i}`), sql`, `)})
      AND r.status IN ${REAL_STATUS_SQL}
    ORDER BY ri.child_id, r.id, r.registered_at DESC NULLS LAST`);
  const map = emptyMap();
  for (const row of rows.rows as any[]) {
    pushReg(map, Number(row.child_id), {
      id: Number(row.id), programId: Number(row.program_id),
      programName: row.program_name, programType: row.program_type,
      status: row.status, amountPaid: row.amount_paid,
      totalCents: row.total_cents === null || row.total_cents === undefined ? null : Number(row.total_cents),
      registeredAt: row.registered_at ? new Date(row.registered_at).toISOString() : null,
    });
  }
  return map;
}

// ── The resolver ─────────────────────────────────────────────────────────────

type PersonRow = {
  key: PersonKey; kind: PersonKind; id: number;
  firstName: string; lastName: string; type: string | null;
  email: string | null; phone: string | null; alternatePhone?: string | null;
  dateOfBirth: string | null; gender?: string | null;
  address?: string | null; school?: string | null; schoolYear?: string | null;
  allergies?: string | null; medicalNotes?: string | null; epiPen?: boolean;
  emergencyContact?: string | null; emergencyPhone?: string | null;
  friendlyManagerId?: string | null;
};

function contactRowToPerson(row: any): PersonRow {
  return {
    key: personKey("contact", Number(row.id)), kind: "contact", id: Number(row.id),
    firstName: row.first_name, lastName: row.last_name, type: row.type,
    email: row.email, phone: row.phone, alternatePhone: row.alternate_phone,
    dateOfBirth: isoDate(row.date_of_birth),
    gender: row.gender, address: row.address, school: row.school, schoolYear: row.school_year,
    allergies: row.allergies, medicalNotes: row.medical_notes,
    emergencyContact: row.emergency_contact, emergencyPhone: row.emergency_phone,
    friendlyManagerId: row.friendly_manager_id,
  };
}

function childRowToPerson(row: any): PersonRow {
  return {
    key: personKey("child", Number(row.id)), kind: "child", id: Number(row.id),
    firstName: row.first_name, lastName: row.last_name, type: "player",
    email: null, phone: null,
    dateOfBirth: isoDate(row.date_of_birth),
    gender: row.gender,
    allergies: row.allergies, medicalNotes: row.notes, epiPen: row.epi_pen === true,
  };
}

async function loadPerson(kind: PersonKind, id: number): Promise<PersonRow | null> {
  if (kind === "contact") {
    const r = await db.execute(sql`SELECT * FROM contacts WHERE id = ${id} LIMIT 1`);
    const row = (r.rows as any[])[0];
    return row ? contactRowToPerson(row) : null;
  }
  const r = await db.execute(sql`
    SELECT c.*, m.allergies, m.epi_pen, m.notes
    FROM children c LEFT JOIN child_medical m ON m.child_id = c.id
    WHERE c.id = ${id} LIMIT 1`);
  const row = (r.rows as any[])[0];
  return row ? childRowToPerson(row) : null;
}

/** Merge a link into a list, keeping every source that produced it. */
function upsertLink<T extends { key: PersonKey; sources: LinkSource[]; relationship: string | null }>(
  list: T[], candidate: T,
): void {
  const found = list.find(x => x.key === candidate.key);
  if (!found) { list.push(candidate); return; }
  for (const src of candidate.sources) if (!found.sources.includes(src)) found.sources.push(src);
  if (!found.relationship && candidate.relationship) found.relationship = candidate.relationship;
}

export type Family = {
  person: PersonRow & { age: number | null };
  guardians: FamilyGuardian[];
  children: FamilyChild[];
  registrations: RegistrationSummary[];
  /** Everything this person signed up for and paid — see server/person-history.ts. */
  history: PersonHistory;
  /**
   * Present on a parent: their own record plus every child's, every row labelled
   * with whose it is and each shared booking listed once. Null on a player, who
   * is not a household.
   */
  household: (PersonHistory & { childCount: number; sharedBookingCount: number }) | null;
  today: string;
};

/**
 * A person and their whole family, from all three link mechanisms.
 *
 * Guardianship is keyed on the DIRECTION of the edge (guardian_id → player_id),
 * never on contacts.type. 168 edges in prod point player→player and 10 point
 * guardian→guardian — Friendly Manager import artifacts where the adult landed
 * with the wrong type. Reading the type instead of the edge would drop those
 * families on the floor.
 */
export async function resolveFamily(kind: PersonKind, id: number): Promise<Family | null> {
  const person = await loadPerson(kind, id);
  if (!person) return null;
  const today = nzTodayIso();

  const guardians: FamilyGuardian[] = [];
  const children: FamilyChild[] = [];

  if (kind === "child") {
    // Camp shape: exactly one parent, structural, not editable here.
    const pr = await db.execute(sql`
      SELECT c.* FROM children ch JOIN contacts c ON c.id = ch.parent_id WHERE ch.id = ${id} LIMIT 1`);
    const prow = (pr.rows as any[])[0];
    if (prow) {
      upsertLink(guardians, {
        key: personKey("contact", Number(prow.id)), kind: "contact", id: Number(prow.id),
        firstName: prow.first_name, lastName: prow.last_name,
        email: prow.email, phone: prow.phone,
        relationship: "Parent", sources: ["camp_parent"],
      });
    }
    const [regMap, hist] = await Promise.all([
      regsByChildId([id]),
      resolvePeopleHistory([], [id]),
    ]);
    return {
      person: { ...person, age: null },
      guardians, children,
      registrations: regMap.get(id) || [],
      history: hist.byChild.get(id) || blankPersonHistory(),
      household: null,
      today,
    };
  }

  // ── contact shape ──────────────────────────────────────────────────────────
  // Guardians OF this person: explicit edges, then edges implied by a payment.
  const gRows = await db.execute(sql`
    SELECT c.*, cr.relationship, 'relationship'::text AS src
    FROM contact_relationships cr JOIN contacts c ON c.id = cr.guardian_id
    WHERE cr.player_id = ${id}
    UNION
    SELECT c.*, NULL AS relationship, 'registration'::text AS src
    FROM registrations r JOIN contacts c ON c.id = r.guardian_id
    WHERE r.contact_id = ${id} AND r.guardian_id IS NOT NULL AND r.guardian_id <> ${id}
      AND r.status IN ${REAL_STATUS_SQL}`);
  for (const row of gRows.rows as any[]) {
    upsertLink(guardians, {
      key: personKey("contact", Number(row.id)), kind: "contact", id: Number(row.id),
      firstName: row.first_name, lastName: row.last_name,
      email: row.email, phone: row.phone,
      relationship: row.relationship ? relationshipLabel(row.relationship) : null,
      sources: [row.src as LinkSource],
    });
  }

  // Children OF this person: explicit edges, payment-implied edges, camp rows.
  const cRows = await db.execute(sql`
    SELECT c.*, cr.relationship, 'relationship'::text AS src
    FROM contact_relationships cr JOIN contacts c ON c.id = cr.player_id
    WHERE cr.guardian_id = ${id}
    UNION
    SELECT c.*, NULL AS relationship, 'registration'::text AS src
    FROM registrations r JOIN contacts c ON c.id = r.contact_id
    WHERE r.guardian_id = ${id} AND r.contact_id <> ${id}
      AND r.status IN ${REAL_STATUS_SQL}`);
  const childContactIds: number[] = [];
  for (const row of cRows.rows as any[]) {
    const cid = Number(row.id);
    childContactIds.push(cid);
    upsertLink(children as any, {
      key: personKey("contact", cid), kind: "contact", id: cid,
      firstName: row.first_name, lastName: row.last_name,
      dateOfBirth: isoDate(row.date_of_birth),
      allergies: row.allergies, medicalNotes: row.medical_notes,
      relationship: row.relationship ? relationshipLabel(row.relationship) : null,
      sources: [row.src as LinkSource], registrations: [],
    } as any);
  }

  const kidRows = await db.execute(sql`
    SELECT ch.*, m.allergies, m.epi_pen, m.notes
    FROM children ch LEFT JOIN child_medical m ON m.child_id = ch.id
    WHERE ch.parent_id = ${id}`);
  const campChildIds: number[] = [];
  for (const row of kidRows.rows as any[]) {
    const cid = Number(row.id);
    campChildIds.push(cid);
    upsertLink(children as any, {
      key: personKey("child", cid), kind: "child", id: cid,
      firstName: row.first_name, lastName: row.last_name,
      dateOfBirth: isoDate(row.date_of_birth),
      allergies: row.allergies, medicalNotes: row.notes, epiPen: row.epi_pen === true,
      relationship: "Parent", sources: ["camp_parent"], registrations: [],
    } as any);
  }

  // One batched pass for every child's programmes, plus this person's own.
  const [byContact, byChild] = await Promise.all([
    regsByContactId(Array.from(new Set([...childContactIds, id]))),
    regsByChildId(campChildIds),
  ]);
  for (const c of children) {
    c.registrations = (c.kind === "contact" ? byContact.get(c.id) : byChild.get(c.id)) || [];
  }

  // One card per actual child, programmes pooled across their records.
  const mergedChildren = mergeChildRecords(children);
  mergedChildren.sort((a, b) => (a.dateOfBirth || "9999").localeCompare(b.dateOfBirth || "9999"));

  // History for this person and every child, in ONE batched pass — a parent of
  // six resolving a query each is what exhausted the pool before.
  const hist = await resolvePeopleHistory([...childContactIds, id], campChildIds);
  const ownHistory = hist.byContact.get(id) || blankPersonHistory();

  // A merged child card pools history across every record it stands for, the
  // same way its registrations are pooled — otherwise a child who did a camp as
  // a `children` row and the academy as a `contacts` row shows only half.
  for (const c of mergedChildren) {
    const parts: PersonHistory[] = [];
    for (const rec of c.records || [{ kind: c.kind, id: c.id } as any]) {
      const h = rec.kind === "contact" ? hist.byContact.get(rec.id) : hist.byChild.get(rec.id);
      if (h) parts.push(h);
    }
    c.history = mergeHistories(parts);
  }

  return {
    person: { ...person, age: null },
    guardians, children: mergedChildren,
    registrations: byContact.get(id) || [],
    history: ownHistory,
    household: householdRollup(
      { history: ownHistory, name: `${person.firstName} ${person.lastName}`.trim(), key: person.key },
      mergedChildren
        .filter(c => c.history)
        .map(c => ({
          history: c.history as PersonHistory,
          name: `${c.firstName} ${c.lastName}`.trim(),
          key: c.key,
        })),
    ),
    today,
  };
}

function blankPersonHistory(): PersonHistory {
  return { programmes: [], payments: [], totals: emptyHistoryTotals() };
}

/** Pool several records' history into one, de-duplicated by entry key. */
function mergeHistories(parts: PersonHistory[]): PersonHistory {
  if (parts.length === 1) return parts[0];
  const programmes = new Map<string, any>();
  const payments = new Map<string, any>();
  for (const p of parts) {
    for (const x of p.programmes) programmes.set(x.key, x);
    for (const x of p.payments) payments.set(x.key, x);
  }
  const prog = Array.from(programmes.values());
  const pay = Array.from(payments.values());
  return { programmes: prog, payments: pay, totals: totalsFor(prog, pay) };
}

// ── Search across BOTH people tables ─────────────────────────────────────────
// Server-side on purpose. The old page fetched every contact and filtered in the
// browser; adding the 6,506 academy children to that payload would have shipped
// ~10,900 people — including their medical notes — on every page load.
// pg_trgm GIN indexes already exist on contacts and children first/last name.

type SearchFilter = "all" | "players" | "parents" | "families";

export async function searchPeople(q: string, filter: SearchFilter, limit: number, offset: number) {
  const like = `%${q}%`;
  const hasQ = q.length > 0;

  // Trigram score, mirroring the global-search threshold (0.2, looser than
  // pg_trgm's 0.3 default so a single-letter typo still matches).
  const contactWhere = hasQ
    ? sql`AND ((c.first_name ILIKE ${like} OR c.last_name ILIKE ${like}
               OR (c.first_name || ' ' || c.last_name) ILIKE ${like}
               OR c.email ILIKE ${like} OR c.phone ILIKE ${like})
          OR GREATEST(similarity(lower(c.first_name), lower(${q})),
                      similarity(lower(c.last_name), lower(${q})),
                      similarity(lower(c.first_name || ' ' || c.last_name), lower(${q}))) >= 0.2)`
    : sql``;
  const childWhere = hasQ
    ? sql`AND ((ch.first_name ILIKE ${like} OR ch.last_name ILIKE ${like}
               OR (ch.first_name || ' ' || ch.last_name) ILIKE ${like})
          OR GREATEST(similarity(lower(ch.first_name), lower(${q})),
                      similarity(lower(ch.last_name), lower(${q}))) >= 0.2)`
    : sql``;

  const typeWhere =
    filter === "players" ? sql`AND c.type = 'player'`
    : filter === "parents" || filter === "families" ? sql`AND c.type <> 'player'`
    : sql``;

  // Camp children are people too — they belong in a player search and are
  // excluded from a parent search.
  const includeCampChildren = filter === "all" || filter === "players";

  const contactSel = sql`
    SELECT 'contact'::text AS kind, c.id, c.first_name, c.last_name, c.type::text AS type,
           c.email, c.phone, c.date_of_birth,
           ${hasQ ? sql`GREATEST(similarity(lower(c.first_name), lower(${q})),
                                 similarity(lower(c.last_name), lower(${q})),
                                 similarity(lower(c.first_name || ' ' || c.last_name), lower(${q})))`
                  : sql`0`} AS score
    FROM contacts c
    WHERE c.type <> 'staff' AND NOT ${contactHiddenSql("c")} ${typeWhere} ${contactWhere}`;

  const childSel = sql`
    SELECT 'child'::text AS kind, ch.id, ch.first_name, ch.last_name, 'player'::text AS type,
           NULL::text AS email, NULL::text AS phone, ch.date_of_birth,
           ${hasQ ? sql`GREATEST(similarity(lower(ch.first_name), lower(${q})),
                                 similarity(lower(ch.last_name), lower(${q})))`
                  : sql`0`} AS score
    FROM children ch
    WHERE NOT ${childHiddenSql("ch")} ${childWhere}`;

  const union = includeCampChildren ? sql`${contactSel} UNION ALL ${childSel}` : contactSel;

  // Nameless records sort LAST. 18 contacts carry no name at all (17 Friendly
  // Manager imports and one shared club mailbox), and a plain `last_name ASC`
  // put every one of them at the top of the browse view — the first thing
  // anyone opening Contacts would see was a screen of blank rows.
  const rows = await db.execute(sql`
    WITH found AS (${union})
    SELECT * FROM found
    ORDER BY score DESC,
             (NULLIF(trim(coalesce(first_name,'') || coalesce(last_name,'')), '') IS NULL),
             last_name ASC, first_name ASC
    LIMIT ${limit} OFFSET ${offset}`);

  const countRes = await db.execute(sql`WITH found AS (${union}) SELECT count(*)::int AS n FROM found`);
  const total = Number((countRes.rows as any[])[0]?.n || 0);

  return { rows: rows.rows as any[], total };
}

/**
 * The family one line of context for a page of search results.
 *
 * This is the Jackrabbit pattern the research called out: a hit on a child's
 * name should show WHOSE child they are right there, without a second click.
 * Batched over the visible page only — never the whole table.
 */
async function familySummaries(rows: any[]): Promise<Map<string, { parents: string[]; children: string[] }>> {
  const out = new Map<string, { parents: string[]; children: string[] }>();
  const contactIds = rows.filter(r => r.kind === "contact").map(r => Number(r.id));
  const childIds = rows.filter(r => r.kind === "child").map(r => Number(r.id));

  if (contactIds.length) {
    const ids = sql.join(contactIds.map(i => sql`${i}`), sql`, `);
    // Parents of each contact (explicit edge OR implied by a registration).
    const parents = await db.execute(sql`
      SELECT x.player_id AS person_id, g.first_name, g.last_name FROM (
        SELECT cr.player_id, cr.guardian_id FROM contact_relationships cr WHERE cr.player_id IN (${ids})
        UNION
        SELECT r.contact_id, r.guardian_id FROM registrations r
        WHERE r.contact_id IN (${ids}) AND r.guardian_id IS NOT NULL AND r.guardian_id <> r.contact_id
          AND r.status IN ${REAL_STATUS_SQL}
      ) x JOIN contacts g ON g.id = x.guardian_id`);
    for (const row of parents.rows as any[]) {
      const k = personKey("contact", Number(row.person_id));
      const e = out.get(k) || { parents: [], children: [] };
      const nm = `${row.first_name} ${row.last_name}`.trim();
      if (!e.parents.includes(nm)) e.parents.push(nm);
      out.set(k, e);
    }
    // Children of each contact, from all three sources.
    const kids = await db.execute(sql`
      SELECT x.guardian_id AS person_id, x.first_name, x.last_name FROM (
        SELECT cr.guardian_id, c.first_name, c.last_name
          FROM contact_relationships cr JOIN contacts c ON c.id = cr.player_id
          WHERE cr.guardian_id IN (${ids})
        UNION
        SELECT r.guardian_id, c.first_name, c.last_name
          FROM registrations r JOIN contacts c ON c.id = r.contact_id
          WHERE r.guardian_id IN (${ids}) AND r.contact_id <> r.guardian_id
          AND r.status IN ${REAL_STATUS_SQL}
        UNION
        SELECT ch.parent_id, ch.first_name, ch.last_name
          FROM children ch WHERE ch.parent_id IN (${ids})
      ) x`);
    for (const row of kids.rows as any[]) {
      const k = personKey("contact", Number(row.person_id));
      const e = out.get(k) || { parents: [], children: [] };
      const nm = `${row.first_name} ${row.last_name}`.trim();
      if (!e.children.includes(nm)) e.children.push(nm);
      out.set(k, e);
    }
  }

  if (childIds.length) {
    const ids = sql.join(childIds.map(i => sql`${i}`), sql`, `);
    const parents = await db.execute(sql`
      SELECT ch.id AS person_id, c.first_name, c.last_name
      FROM children ch JOIN contacts c ON c.id = ch.parent_id WHERE ch.id IN (${ids})`);
    for (const row of parents.rows as any[]) {
      const k = personKey("child", Number(row.person_id));
      const e = out.get(k) || { parents: [], children: [] };
      e.parents.push(`${row.first_name} ${row.last_name}`.trim());
      out.set(k, e);
    }
  }
  return out;
}

// ── Routes ───────────────────────────────────────────────────────────────────

export function registerFamilyRoutes(app: Express) {
  const gate = [requireAuth, requireTab("contacts")] as const;

  app.get("/api/admin/people", ...gate, async (req: Request, res: Response) => {
    try {
      const q = s(req.query.q, 100);
      const filterRaw = s(req.query.filter, 20) as SearchFilter;
      const filter: SearchFilter =
        ["all", "players", "parents", "families"].includes(filterRaw) ? filterRaw : "all";
      const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "50")) || 50, 1), 100);
      const offset = Math.max(parseInt(String(req.query.offset ?? "0")) || 0, 0);

      const { rows, total } = await searchPeople(q, filter, limit, offset);
      const fam = await familySummaries(rows);

      let people = rows.map(r => {
        const key = personKey(r.kind as PersonKind, Number(r.id));
        const f = fam.get(key) || { parents: [], children: [] };
        return {
          key, kind: r.kind, id: Number(r.id),
          firstName: r.first_name, lastName: r.last_name,
          personType: r.type === "player" ? "player" : "parent",
          email: r.email, phone: r.phone,
          dateOfBirth: isoDate(r.date_of_birth),
          parents: f.parents, children: f.children,
        };
      });

      // "Families" = a guardian with more than one child — the sibling view the
      // office actually asks for on the phone (iClassPro ships the same report).
      // Applied after the family summary because the count comes from it.
      if (filter === "families") people = people.filter(p => p.children.length > 1);

      res.json({ people, total: filter === "families" ? people.length : total, today: nzTodayIso() });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/admin/people/:key", ...gate, async (req: Request, res: Response) => {
    try {
      const parsed = parsePersonKey(String(req.params.key));
      if (!parsed) return res.status(400).json({ message: "Invalid person key" });
      const family = await resolveFamily(parsed.kind, parsed.id);
      if (!family) return res.status(404).json({ message: "Person not found" });
      res.json(family);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // Link a guardian to a child. Both must be `contacts` rows: contact_relationships
  // has a foreign key into contacts, and a camp child's parent is already fixed by
  // children.parent_id. Idempotent — the unique index makes a double-tap a no-op.
  // ── Correct someone's details ────────────────────────────────────────────
  // Daniel, 2026-09-04: Travis found "Noothan Matthew" filed with the wrong
  // email, and there was no way to fix it — every correction came back to
  // Daniel or was pushed onto the parent. Staff take these over the phone; they
  // have to be able to write them down.
  //
  // 🔴 Deliberately NARROW: name, email, phone and the child's school. NOT date
  // of birth (it sets the NZF age grade and a typo silently regrades a child),
  // not medical or identity fields, and nothing that moves money. Widening this
  // is a decision, not an oversight.
  //
  // 🔴 An email is how a family is matched to what is already on file, so
  // changing one re-points a person's whole history. It is validated, lowercased
  // and refused if another record of the same kind already holds it — a
  // duplicate email is how two people become one by accident.
  app.patch("/api/admin/people/:key", ...gate, async (req: Request, res: Response) => {
    try {
      const parsed = parsePersonKey(String(req.params.key));
      if (!parsed) return res.status(400).json({ message: "Unknown person" });
      const body = req.body ?? {};

      const clean = (v: unknown, max = 120) => {
        if (v === undefined) return undefined;
        const t = String(v ?? "").trim();
        return t.slice(0, max);
      };
      const firstName = clean(body.firstName, 80);
      const lastName = clean(body.lastName, 80);
      const emailRaw = clean(body.email, 200);
      const phone = clean(body.phone, 40);
      const school = clean(body.school, 120);

      if (firstName !== undefined && !firstName) {
        return res.status(400).json({ message: "A first name can't be blank." });
      }
      let email: string | null | undefined = undefined;
      if (emailRaw !== undefined) {
        if (emailRaw === "") email = null;                 // clearing is allowed
        else {
          const e = emailRaw.toLowerCase();
          if (!/^[^\s@]+@[^\s@,;]+\.[a-z]{2,}$/i.test(e)) {
            return res.status(400).json({ message: "That doesn't look like an email address." });
          }
          email = e;
        }
      }

      if (parsed.kind === "contact") {
        if (email) {
          const clash = await db.execute(sql`
            SELECT id FROM contacts WHERE lower(email) = ${email} AND id <> ${parsed.id} LIMIT 1`);
          if (clash.rows.length) {
            return res.status(409).json({
              message: "Another contact already uses that email. Fix the duplicate first, or use a different address.",
            });
          }
        }
        const sets: string[] = [];
        const vals: any[] = [];
        if (firstName !== undefined) { sets.push("first_name"); vals.push(firstName); }
        if (lastName !== undefined)  { sets.push("last_name");  vals.push(lastName); }
        if (email !== undefined)     { sets.push("email");      vals.push(email); }
        if (phone !== undefined)     { sets.push("phone");      vals.push(phone || null); }
        if (!sets.length) return res.status(400).json({ message: "Nothing to change." });
        const assignments = sql.join(sets.map((col, i) => sql`${sql.raw(col)} = ${vals[i]}`), sql`, `);
        await db.execute(sql`UPDATE contacts SET ${assignments} WHERE id = ${parsed.id}`);
      } else {
        const sets: string[] = [];
        const vals: any[] = [];
        if (firstName !== undefined) { sets.push("first_name"); vals.push(firstName); }
        if (lastName !== undefined)  { sets.push("last_name");  vals.push(lastName); }
        if (school !== undefined)    { sets.push("school");     vals.push(school || null); }
        if (!sets.length) return res.status(400).json({ message: "Nothing to change." });
        const assignments = sql.join(sets.map((col, i) => sql`${sql.raw(col)} = ${vals[i]}`), sql`, `);
        await db.execute(sql`UPDATE children SET ${assignments} WHERE id = ${parsed.id}`);
      }

      // Who changed it. A contact's email is load-bearing — it is how their
      // registrations and payments are matched — so the change is auditable.
      console.log(`[People] user ${(req as any).session?.userId} edited ${req.params.key}: ${Object.keys(body).join(", ")}`);
      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.post("/api/admin/people/:key/guardians", ...gate, async (req: Request, res: Response) => {
    try {
      const child = parsePersonKey(String(req.params.key));
      const guardian = parsePersonKey(req.body?.guardianKey);
      if (!child || !guardian) return res.status(400).json({ message: "Invalid person key" });
      if (child.kind !== "contact" || guardian.kind !== "contact") {
        return res.status(400).json({
          message: "A camp child's parent comes from the booking and can't be changed here.",
        });
      }
      if (child.id === guardian.id) {
        return res.status(400).json({ message: "A person can't be their own guardian." });
      }
      const relationship = s(req.body?.relationship, 60) || "Parent";

      const exists = await db.execute(sql`
        SELECT 1 FROM contacts WHERE id IN (${child.id}, ${guardian.id})`);
      if ((exists.rows as any[]).length < 2) return res.status(404).json({ message: "Person not found" });

      await db.execute(sql`
        INSERT INTO contact_relationships (guardian_id, player_id, relationship, is_primary_contact)
        VALUES (${guardian.id}, ${child.id}, ${relationship}, true)
        ON CONFLICT (guardian_id, player_id) DO UPDATE SET relationship = EXCLUDED.relationship`);

      const family = await resolveFamily(child.kind, child.id);
      res.json(family);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // Remove an explicit link. A link implied by a registration is NOT removable —
  // it is a record of who paid, and deleting the edge would not change that.
  app.delete("/api/admin/people/:key/guardians/:guardianKey", ...gate, async (req: Request, res: Response) => {
    try {
      const child = parsePersonKey(String(req.params.key));
      const guardian = parsePersonKey(String(req.params.guardianKey));
      if (!child || !guardian) return res.status(400).json({ message: "Invalid person key" });
      if (child.kind !== "contact" || guardian.kind !== "contact") {
        return res.status(400).json({ message: "This link comes from a booking and can't be removed here." });
      }

      await db.execute(sql`
        DELETE FROM contact_relationships
        WHERE guardian_id = ${guardian.id} AND player_id = ${child.id}`);

      // If a registration still implies the link it will reappear — say so
      // rather than letting the row seem to come back on its own.
      const implied = await db.execute(sql`
        SELECT 1 FROM registrations
        WHERE contact_id = ${child.id} AND guardian_id = ${guardian.id} LIMIT 1`);
      const family = await resolveFamily(child.kind, child.id);
      res.json({
        ...family,
        note: (implied.rows as any[]).length
          ? "Unlinked, but this parent still shows because they paid for a registration."
          : null,
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });
}
