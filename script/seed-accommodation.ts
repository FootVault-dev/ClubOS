// Import the CUFC residency run sheet into the Accommodation tab.
//
//   Rehearse:  npx tsx --env-file=.env script/seed-accommodation.ts --dry-run
//   Apply:     npx tsx --env-file=.env script/seed-accommodation.ts --commit
//
// Dry run is the DEFAULT. Everything runs in one transaction that is rolled back
// unless --commit is passed, and the verification at the end runs inside that
// transaction, so a rehearsal proves the real numbers before anything is kept.
//
// ── What this script will not do ─────────────────────────────────────────────
//
//  * It does not hold a single figure of its own. Every name, date, rate and
//    total comes from outputs/accommodation/2026-08-18-residency-import/
//    source-data.json, which is a verbatim extraction of the five PDFs. If a
//    number is wrong, it is wrong in the club's workbook and the variance report
//    at the end says so.
//
//  * It does not resolve a contradiction. Where the club's documents disagree —
//    four rooms recorded as holding two people at once, four different totals
//    for one term — the conflict is imported AS a conflict and left for a human.
//
//  * It does not invent a person. Someone already in ClubOS is linked, never
//    duplicated, and every link is printed so it can be challenged.
//
//  * It does not invent a payment date. The Jan–May charges are marked paid
//    because the source says "Paid in Full", dated to the end of the stay, and
//    every one of them carries a reference saying the date was derived.
//
// Idempotent: re-running updates the same rows, keyed on the workbook's own
// reference (JM-01, MS-09…). It never creates a second copy of anything.
import { Pool, types as pgTypes } from "pg";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import {
  checkOutToLastNight, tenancyMoney, statedVarianceCents, hasMaterialVariance,
} from "../shared/housing";

const COMMIT = process.argv.includes("--commit");
const ORG_SLUG = "united-sports-group";

// 🔴 Hand back DATE columns as the plain 'YYYY-MM-DD' string Postgres stored.
// By default node-postgres builds a JS Date at LOCAL midnight, and
// `.toISOString()` on that is 12 hours earlier in UTC — so a tenancy starting
// 15 December reads back as the 14th. It is the same one-day slip that printed
// "18 July" on an invoice due the 17th. Nothing in this script should ever hold
// a calendar date as a Date object.
pgTypes.setTypeParser(pgTypes.builtins.DATE, (v) => v);

const here = dirname(fileURLToPath(import.meta.url));
const SRC = JSON.parse(readFileSync(
  join(here, "..", "..", "..", "outputs", "accommodation", "2026-08-18-residency-import", "source-data.json"), "utf8"));

const dollars = (n: number | null | undefined) => (n === null || n === undefined ? null : Math.round(n * 100));
const money = (c: number) => `$${(c / 100).toFixed(2)}`;

// Map the source's free text onto the vocabularies in shared/housing.ts.
const AGREEMENT: Record<string, string> = {
  "Licence to Occupy": "licence_to_occupy",
  "Boarding Agreement": "boarding_agreement",
  "Short-Term Rental": "short_term_rental",
  "Club Remuneration": "club_remuneration",
};
const CATEGORY: Record<string, string> = {
  "Senior Squad Player": "senior_squad",
  "Academy Player": "academy",
  "International Player": "international",
};
const CONDITION: Record<string, string> = {
  "Inspected - Good": "inspected_good",
  "Clean & Ready": "clean_ready",
  "Ready for Use": "ready_for_use",
  "Pending Check-out": "pending_checkout",
};
const REPORT: Record<string, string> = { Signed: "signed", Pending: "pending", Returned: "returned" };
const ACTION_PRIORITY: Record<string, string> = { high: "high", medium: "medium", low: "low" };
const CONFLICT_PRIORITY: Record<string, string> = { high: "high", medium: "medium", low: "low" };

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const c = await pool.connect();

const linked: string[] = [];
const created: string[] = [];
const warnings: string[] = [];

try {
  console.log(COMMIT ? "\nCOMMITTING to the database.\n" : "\nDRY RUN — rolled back at the end. Pass --commit to keep it.\n");
  await c.query("BEGIN");

  const { rows: [org] } = await c.query(`SELECT id, name FROM organizations WHERE slug = $1`, [ORG_SLUG]);
  if (!org) throw new Error(`No organization with slug ${ORG_SLUG}`);
  console.log(`Workspace: ${org.name} (org ${org.id})\n`);

  // ── Periods ────────────────────────────────────────────────────────────────
  const periodId = new Map<string, number>();
  for (const p of SRC.periods) {
    const { rows: [row] } = await c.query(
      `INSERT INTO housing_periods (organization_id, name, start_date, end_date, stated_total_cents, stated_total_note, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (organization_id, lower(name)) DO UPDATE SET
         start_date = EXCLUDED.start_date, end_date = EXCLUDED.end_date,
         stated_total_cents = EXCLUDED.stated_total_cents,
         stated_total_note = EXCLUDED.stated_total_note,
         notes = EXCLUDED.notes, updated_at = now()
       RETURNING id`,
      [org.id, p.name, p.startDate, p.endDate, dollars(p.statedTotalDollars),
       `${p.statedTotalSource}. The other sheet states ${money(dollars(p.altStatedTotalDollars)!)} (${p.altStatedTotalSource}).`,
       p.notes]);
    periodId.set(p.key, row.id);
  }
  console.log(`Periods:  ${periodId.size}`);

  // ── Houses and rooms ───────────────────────────────────────────────────────
  const houseId = new Map<string, number>();
  for (const h of SRC.houses) {
    const { rows: [row] } = await c.query(
      `INSERT INTO housing_houses (organization_id, name, address, notes)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (organization_id, lower(name)) DO UPDATE SET
         address = EXCLUDED.address, notes = EXCLUDED.notes, updated_at = now()
       RETURNING id`,
      [org.id, h.name, h.address, h.notes ?? null]);
    houseId.set(h.key, row.id);
  }

  const roomId = new Map<string, number>();   // "main/Room 1" -> id
  for (const r of SRC.rooms) {
    const hid = houseId.get(r.house)!;
    const { rows: [row] } = await c.query(
      `INSERT INTO housing_rooms (
         house_id, organization_id, name, room_type,
         default_rent_cents, default_rent_frequency, default_utilities_cents,
         bed_config, occupant_type, key_code, condition_status, property_lead,
         is_reserve, source_status)
       VALUES ($1,$2,$3,'single',$4,'weekly',$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (house_id, lower(name)) DO UPDATE SET
         default_rent_cents = EXCLUDED.default_rent_cents,
         default_utilities_cents = EXCLUDED.default_utilities_cents,
         bed_config = EXCLUDED.bed_config, occupant_type = EXCLUDED.occupant_type,
         key_code = EXCLUDED.key_code, condition_status = EXCLUDED.condition_status,
         property_lead = EXCLUDED.property_lead, is_reserve = EXCLUDED.is_reserve,
         source_status = EXCLUDED.source_status, updated_at = now()
       RETURNING id`,
      [hid, org.id, r.name,
       dollars(r.baseWeeklyRentDollars), dollars(r.utilitiesWeeklyDollars),
       r.bedConfig, r.targetOccupantType, r.keyCode,
       CONDITION[r.conditionStatus] ?? "unknown", r.propertyLead,
       r.reserve, r.sourceStatus]);
    roomId.set(`${r.house}/${r.name}`, row.id);
  }
  console.log(`Houses:   ${houseId.size}`);
  console.log(`Rooms:    ${roomId.size}  (${SRC.rooms.filter((r: any) => r.reserve).length} reserve / not lettable)\n`);

  // ── People ─────────────────────────────────────────────────────────────────
  // 🔴 Email first. Only if there is no email match do we look at the name, and
  // an exact full-name hit inside one club's own contacts is treated as the same
  // person — because the alternative, a second Johnson Cleland, is the failure
  // this database has already been bitten by. Every such link is printed.
  const contactId = new Map<string, number>();
  for (const p of SRC.people) {
    const { rows: byEmail } = await c.query(
      `SELECT id, first_name, last_name, email FROM contacts WHERE lower(email) = lower($1) LIMIT 1`, [p.email]);
    if (byEmail[0]) {
      contactId.set(p.key, byEmail[0].id);
      linked.push(`  ${p.firstName} ${p.lastName} → contact ${byEmail[0].id} (matched on email)`);
      continue;
    }
    const { rows: byName } = await c.query(
      `SELECT id, first_name, last_name, email FROM contacts
       WHERE lower(first_name) = lower($1) AND lower(last_name) = lower($2)
       ORDER BY id LIMIT 2`, [p.firstName, p.lastName]);
    if (byName.length === 1) {
      contactId.set(p.key, byName[0].id);
      linked.push(`  ${p.firstName} ${p.lastName} → contact ${byName[0].id} (matched on NAME; ClubOS holds ${byName[0].email ?? "no email"}, the run sheet gives ${p.email})`);
      warnings.push(`${p.firstName} ${p.lastName} was linked by name, not email. ClubOS has ${byName[0].email ?? "no email"} on that record; the run sheet gives ${p.email}. Confirm they are the same person and which address should receive rent notices.`);
      continue;
    }
    if (byName.length > 1) {
      warnings.push(`${p.firstName} ${p.lastName} matches ${byName.length}+ existing contacts by name and none by email — a NEW contact was created rather than guessing which one. Merge by hand if it is a duplicate.`);
    }
    // 🔴 No phone. The source documents contain no phone number for anybody, and
    // making one up to satisfy the usual rule would be worse than the gap. It is
    // counted as a compliance gap on the tab instead.
    const { rows: [row] } = await c.query(
      `INSERT INTO contacts (type, first_name, last_name, email, notes)
       VALUES ('player',$1,$2,$3,$4) RETURNING id`,
      [p.firstName, p.lastName, p.email,
       `Residency occupant. Imported from the CUFC accommodation run sheet, 2026-08-18. Role: ${p.role}. No phone number appears in the source.`]);
    contactId.set(p.key, row.id);
    created.push(`  ${p.firstName} ${p.lastName} (${p.email})`);
  }

  // ── Roster ─────────────────────────────────────────────────────────────────
  for (const p of SRC.people) {
    await c.query(
      `INSERT INTO housing_roster (organization_id, contact_id, role_label, legal_name, legal_name_verified, notes)
       VALUES ($1,$2,$3,NULL,$4,$5)
       ON CONFLICT (organization_id, contact_id) DO UPDATE SET
         role_label = EXCLUDED.role_label, notes = EXCLUDED.notes, updated_at = now()`,
      [org.id, contactId.get(p.key), p.role,
       // Default false for everyone: the run sheet flags two people as needing a
       // legal-name check, but it never says the other 24 were ever verified
       // either. "Not verified" is the honest state for a name nobody has
       // checked against a document.
       false,
       p.note ?? null]);
  }
  console.log(`People:   ${contactId.size}  (${created.length} created, ${linked.length} linked to existing contacts)`);
  console.log(`Roster:   ${SRC.people.length}  (${SRC.people.filter((p: any) => p.nonResident).length} off-site squad players)\n`);

  // ── Tenancies ──────────────────────────────────────────────────────────────
  // 🔴 Insertion order decides who keeps a contested room. Undisputed tenancies
  // go in first; a disputed one then hits the exclusion constraint and falls back
  // to no room at all, rather than being placed somewhere nobody put it.
  const ordered = [...SRC.tenancies].sort((a, b) => Number(!!a.roomDisputed) - Number(!!b.roomDisputed));
  const tenancyIdByRef = new Map<string, number>();
  let droppedRooms = 0;

  async function insertTenancy(t: any, ref: string, roomKey: string | null, rentDollars: number, note: string | null) {
    const lastNight = checkOutToLastNight(t.checkOut)!;
    const rid = roomKey ? roomId.get(roomKey)! : null;
    const args = (room: number | null, conflictNote: string | null) => ([
      room, org.id, contactId.get(t.person), periodId.get(t.period) ?? null,
      dollars(rentDollars), t.utilitiesIncluded ? 0 : dollars(t.utilitiesWeeklyDollars ?? 0),
      !!t.utilitiesIncluded, AGREEMENT[t.agreementType] ?? "undecided",
      CATEGORY[SRC.people.find((p: any) => p.key === t.person)?.role] ?? "other",
      !!t.remuneration, String(t.holidayWeeks ?? 0),
      t.keyIssued ?? false, t.keyReturned ? lastNight : null,
      REPORT[t.conditionReport] ?? "none",
      dollars(t.statedTotalDollars), t.paymentStatus ?? null, ref,
      room ? null : houseId.get(t.house) ?? null,
      conflictNote,
      t.checkIn, lastNight, note,
    ]);
    const sql = `
      INSERT INTO housing_tenancies (
        room_id, organization_id, contact_id, period_id,
        rent_cents, utilities_cents, utilities_included, agreement_type,
        occupant_category, is_remuneration, holiday_weeks,
        key_issued, key_returned_on, condition_report,
        stated_total_cents, source_payment_status, source_ref,
        unconfirmed_house_id, room_conflict_note,
        start_date, end_date, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
      ON CONFLICT (organization_id, source_ref) WHERE source_ref IS NOT NULL DO UPDATE SET
        room_id = EXCLUDED.room_id, period_id = EXCLUDED.period_id,
        rent_cents = EXCLUDED.rent_cents, utilities_cents = EXCLUDED.utilities_cents,
        utilities_included = EXCLUDED.utilities_included,
        agreement_type = EXCLUDED.agreement_type, occupant_category = EXCLUDED.occupant_category,
        is_remuneration = EXCLUDED.is_remuneration, holiday_weeks = EXCLUDED.holiday_weeks,
        key_issued = EXCLUDED.key_issued, condition_report = EXCLUDED.condition_report,
        stated_total_cents = EXCLUDED.stated_total_cents,
        source_payment_status = EXCLUDED.source_payment_status,
        unconfirmed_house_id = EXCLUDED.unconfirmed_house_id,
        room_conflict_note = EXCLUDED.room_conflict_note,
        start_date = EXCLUDED.start_date, end_date = EXCLUDED.end_date,
        notes = EXCLUDED.notes, updated_at = now()
      RETURNING id`;

    await c.query("SAVEPOINT t");
    try {
      const { rows: [row] } = await c.query(sql, args(rid, null));
      await c.query("RELEASE SAVEPOINT t");
      return row.id as number;
    } catch (e: any) {
      if (e.code !== "23P01") throw e;
      // The room is already taken over these dates. Keep the tenancy, drop the
      // room, and say why — the money and the person are not in doubt.
      await c.query("ROLLBACK TO SAVEPOINT t");
      const { rows: [clash] } = await c.query(
        `SELECT ct.first_name, ct.last_name, t.start_date, t.end_date
           FROM housing_tenancies t JOIN contacts ct ON ct.id = t.contact_id
          WHERE t.room_id = $1 AND daterange(t.start_date, t.end_date, '[]') && daterange($2::date, $3::date, '[]')
          LIMIT 1`, [rid, t.checkIn, lastNight]);
      const who = clash ? `${clash.first_name} ${clash.last_name} (${clash.start_date} to ${clash.end_date})` : "another tenancy";
      const conflictNote = `The source places this stay in ${SRC.houses.find((h: any) => h.key === t.house)?.name} ${t.room}, but ${who} is recorded in that room over the same dates. Room left unconfirmed rather than guessed.`;
      const { rows: [row] } = await c.query(sql, args(null, conflictNote));
      droppedRooms++;
      warnings.push(`${ref}: ${conflictNote}`);
      await c.query("RELEASE SAVEPOINT t").catch(() => {});
      return row.id as number;
    }
  }

  for (const t of ordered) {
    const id = await insertTenancy(t, t.ref, `${t.house}/${t.room}`, t.weeklyRentDollars ?? 0, t.notes ?? null);
    tenancyIdByRef.set(t.ref, id);

    // A stay that took two rooms at one combined rate. The whole rate sits on
    // the first room so the money is counted once; the second is recorded at
    // zero so it still reads as occupied and cross-references the first.
    if (t.alsoRoom) {
      const secondRef = `${t.ref}b`;
      const id2 = await insertTenancy(
        { ...t, room: t.alsoRoom, statedTotalDollars: null, alsoRoom: undefined },
        secondRef, `${t.house}/${t.alsoRoom}`, 0,
        `Second room of a combined let. The full ${money(dollars(t.weeklyRentDollars)!)}/wk is recorded on ${t.room} under ${t.ref}; this row exists so the room reads as occupied without counting the rent twice.`);
      tenancyIdByRef.set(secondRef, id2);
    }
  }
  console.log(`Tenancies: ${tenancyIdByRef.size}  (${droppedRooms} imported with the room left unconfirmed)\n`);

  // ── Charges ────────────────────────────────────────────────────────────────
  // One invoice per stay, split into rent and power when the two are billed
  // apart. Amounts are DERIVED, never taken from the workbook's total.
  let chargeCount = 0, paidCount = 0, paidCents = 0;
  for (const t of SRC.tenancies) {
    const tid = tenancyIdByRef.get(t.ref)!;
    const lastNight = checkOutToLastNight(t.checkOut)!;
    const m = tenancyMoney({
      startDate: t.checkIn, endDate: lastNight,
      rentCents: dollars(t.weeklyRentDollars ?? 0)!,
      utilitiesCents: dollars(t.utilitiesWeeklyDollars ?? 0) ?? 0,
      utilitiesIncluded: !!t.utilitiesIncluded,
      holidayWeeks: t.holidayWeeks ?? 0,
    })!;
    if (m.totalCents <= 0) continue;

    // The source says "Paid in Full" but never says WHEN. Dating a payment to
    // the end of the stay is a derivation, so it is labelled as one on the row
    // itself — a payment date nobody can trace is how a reconciliation goes bad.
    const settled = /paid in full/i.test(t.paymentStatus ?? "");
    const lines = m.utilitiesCents > 0
      ? [{ kind: "rent", due: t.checkIn, amt: m.rentCents },
         { kind: "utilities", due: (() => { const d = new Date(Date.UTC(...t.checkIn.split("-").map((x: string, i: number) => i === 1 ? +x - 1 : +x) as [number, number, number])); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })(), amt: m.utilitiesCents }]
      : [{ kind: t.utilitiesIncluded ? "combined" : "rent", due: t.checkIn, amt: m.totalCents }];

    for (const l of lines) {
      if (l.amt <= 0) continue;
      await c.query(
        `INSERT INTO housing_rent_charges (
           tenancy_id, organization_id, period_id, kind, period_start, period_end,
           due_on, amount_cents, paid_on, paid_amount_cents, reference, notes, source_ref)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (tenancy_id, due_on) DO UPDATE SET
           amount_cents = EXCLUDED.amount_cents, kind = EXCLUDED.kind,
           period_id = EXCLUDED.period_id, notes = EXCLUDED.notes, updated_at = now()`,
        [tid, org.id, periodId.get(t.period) ?? null, l.kind, t.checkIn, lastNight,
         l.due, l.amt,
         settled ? lastNight : null,
         settled ? l.amt : null,
         settled ? "Imported — source states Paid in Full" : null,
         settled
           ? `Amount derived from ${money(dollars(t.weeklyRentDollars ?? 0)!)}/wk over the recorded dates. The source records this as paid in full but gives no payment date; the end of the stay is used as a stand-in and is not an observed date.`
           : `Amount derived from the recorded rate and dates. Source status: ${t.paymentStatus}.`,
         `${t.ref}-${l.kind}`]);
      chargeCount++;
      if (settled) { paidCount++; paidCents += l.amt; }
    }
  }
  console.log(`Charges:  ${chargeCount}  (${paidCount} marked paid, ${money(paidCents)})\n`);

  // ── Actions and conflicts ──────────────────────────────────────────────────
  for (const a of SRC.actions) {
    await c.query(
      `INSERT INTO housing_action_items (
         organization_id, kind, ref, priority, category, title, detail,
         owner_label, status, target_date, resolution_notes, completed_on)
       VALUES ($1,'action',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (organization_id, ref) WHERE ref IS NOT NULL DO UPDATE SET
         priority = EXCLUDED.priority, category = EXCLUDED.category,
         title = EXCLUDED.title, detail = EXCLUDED.detail,
         owner_label = EXCLUDED.owner_label, target_date = EXCLUDED.target_date,
         resolution_notes = EXCLUDED.resolution_notes, updated_at = now()`,
      [org.id, a.ref, ACTION_PRIORITY[a.priority] ?? "medium", a.category, a.title, a.detail,
       a.owner, a.status, a.targetDate, a.resolution,
       a.status === "completed" ? a.targetDate : null]);
  }
  for (const f of SRC.conflicts) {
    await c.query(
      `INSERT INTO housing_action_items (
         organization_id, kind, ref, priority, category, title, detail, status, resolution_notes, related)
       VALUES ($1,'conflict',$2,$3,'Data conflict',$4,$5,'open',$6,$7)
       ON CONFLICT (organization_id, ref) WHERE ref IS NOT NULL DO UPDATE SET
         priority = EXCLUDED.priority, title = EXCLUDED.title, detail = EXCLUDED.detail,
         resolution_notes = EXCLUDED.resolution_notes, related = EXCLUDED.related, updated_at = now()`,
      [org.id, f.ref, CONFLICT_PRIORITY[f.severity] ?? "medium", f.title, f.detail,
       f.resolution, JSON.stringify({ affects: f.affects })]);
  }
  console.log(`Actions:  ${SRC.actions.length} compliance items + ${SRC.conflicts.length} recorded data conflicts\n`);

  // ═══════════════════════════════════════════════════════════════════════════
  // VERIFY — inside the transaction, so a dry run proves the real numbers.
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("─".repeat(78));
  let failures = 0;
  const check = (pass: boolean, label: string) => { if (!pass) failures++; console.log(`${pass ? "  ok " : " FAIL"}  ${label}`); };

  const one = async (sql: string, args: any[] = []) => (await c.query(sql, args)).rows[0];

  const counts = await one(`
    SELECT
      (SELECT count(*) FROM housing_houses  WHERE organization_id=$1) houses,
      (SELECT count(*) FROM housing_rooms   WHERE organization_id=$1) rooms,
      (SELECT count(*) FROM housing_rooms   WHERE organization_id=$1 AND is_reserve) reserve,
      (SELECT count(*) FROM housing_tenancies WHERE organization_id=$1) tenancies,
      (SELECT count(*) FROM housing_tenancies WHERE organization_id=$1 AND room_id IS NULL) noroom,
      (SELECT count(*) FROM housing_roster  WHERE organization_id=$1) roster,
      (SELECT count(*) FROM housing_rent_charges WHERE organization_id=$1) charges,
      (SELECT count(*) FROM housing_action_items WHERE organization_id=$1) actions`, [org.id]);

  check(+counts.houses === SRC.houses.length, `${counts.houses} houses`);
  check(+counts.rooms === SRC.rooms.length, `${counts.rooms} rooms (${counts.reserve} reserve)`);
  check(+counts.roster === SRC.people.length, `${counts.roster} people on the roster`);
  check(+counts.tenancies === SRC.tenancies.length + 1, `${counts.tenancies} tenancies (24 from the run sheet + 1 for Deen Hasanovic's second Tiny House room)`);
  check(+counts.noroom === 4, `${counts.noroom} tenancies imported with the room unconfirmed — expected exactly the 4 double-booked rooms`);
  check(+counts.actions === SRC.actions.length + SRC.conflicts.length, `${counts.actions} action items`);

  // 🔴 The point of the whole exercise: does what we stored still price the way
  // the club's own workbook prices it, except where we said it does not?
  const { rows: stored } = await c.query(
    `SELECT source_ref, start_date, end_date, rent_cents, utilities_cents,
            utilities_included, holiday_weeks, stated_total_cents
       FROM housing_tenancies WHERE organization_id = $1 AND source_ref IS NOT NULL`, [org.id]);

  let matched = 0; const variances: string[] = [];
  for (const row of stored) {
    if (row.stated_total_cents === null) continue;
    // Plain strings, thanks to the DATE type parser at the top of this file.
    const m = tenancyMoney({
      startDate: row.start_date, endDate: row.end_date,
      rentCents: row.rent_cents, utilitiesCents: row.utilities_cents,
      utilitiesIncluded: row.utilities_included, holidayWeeks: Number(row.holiday_weeks),
    })!;
    if (hasMaterialVariance(m.totalCents, row.stated_total_cents)) {
      variances.push(`      ${row.source_ref}: we compute ${money(m.totalCents)}, the club recorded ${money(row.stated_total_cents)}  (${statedVarianceCents(m.totalCents, row.stated_total_cents)! > 0 ? "+" : ""}${money(statedVarianceCents(m.totalCents, row.stated_total_cents)!)})`);
    } else matched++;
  }
  check(matched === 20, `${matched} tenancies price exactly as the club recorded them`);
  check(variances.length === 2, `${variances.length} price differently — and both are known findings`);
  if (variances.length) console.log(variances.join("\n"));

  const totals = await one(
    `SELECT p.name,
            sum(rc.amount_cents) FILTER (WHERE NOT rc.waived) billed,
            sum(coalesce(rc.paid_amount_cents,0)) paid
       FROM housing_rent_charges rc JOIN housing_periods p ON p.id = rc.period_id
      WHERE rc.organization_id = $1 AND p.name LIKE 'May%'
      GROUP BY p.name`, [org.id]);
  check(+totals.billed === 766857, `May–Sep billed ${money(+totals.billed)} — matches the run sheet's $7,668.57 exactly`);
  check(+totals.paid === 0, `May–Sep paid ${money(+totals.paid)} — nothing settled yet, as the run sheet says`);

  const janMay = await one(
    `SELECT sum(rc.amount_cents) FILTER (WHERE NOT rc.waived) billed
       FROM housing_rent_charges rc JOIN housing_periods p ON p.id = rc.period_id
      WHERE rc.organization_id = $1 AND p.name LIKE 'Jan%'`, [org.id]);
  console.log(`\n  Jan–May recomputed from the rates and dates: ${money(+janMay.billed)}`);
  console.log(`    the run sheet's subtotal                  : $36,850.00`);
  console.log(`    the invoicing sheet's own TOTAL cell      : $37,500.00`);
  console.log(`    adding up its own thirteen row totals     : $36,550.00`);

  console.log("─".repeat(78));
  if (created.length) console.log(`\nCreated ${created.length} new contacts:\n${created.join("\n")}`);
  if (linked.length) console.log(`\nLinked to existing ClubOS contacts:\n${linked.join("\n")}`);
  if (warnings.length) console.log(`\n⚠ ${warnings.length} things a human needs to look at:\n` + warnings.map(w => `  • ${w}`).join("\n"));

  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} CHECK(S) FAILED.`}`);

  if (!COMMIT || failures > 0) {
    await c.query("ROLLBACK");
    console.log(failures > 0 && COMMIT
      ? "\nRolled back — NOT committed, because a check failed.\n"
      : "\nRolled back — nothing kept. Re-run with --commit to apply.\n");
    process.exit(failures > 0 ? 1 : 0);
  }
  await c.query("COMMIT");
  console.log("\nCommitted.\n");
} catch (e: any) {
  await c.query("ROLLBACK").catch(() => {});
  console.error("\nFailed, rolled back:", e?.message || e);
  console.error(e?.stack);
  process.exit(1);
} finally {
  c.release();
  await pool.end();
}
