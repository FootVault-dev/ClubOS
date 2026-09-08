// FUNiño U4–U8 — move the Term 3 2026 registrations Olga entered in Friendly
// Manager into ClubOS, with every player + parent detail FM holds.
//
// Source: outputs/fm-migration/2026-09-08-funino/fm-dump.json — the 60 people
// in FM group 372 ("Programme: Unlimited Play", code "U4-8 Players"), captured
// 2026-09-08 by clicking through every profile + Fees tab in a real browser.
//
// What it found, and what this script therefore does:
//   • FM holds NO Term 4 2026 fee for anyone. The group's "current term" is
//     Term 3 2026 and every fee is Term 3 or older. So these are Term 3
//     registrations, imported AS Term 3 (registered_at / paid_at = the FM
//     payment date, notes name the term and the FM fee ref). Nobody is written
//     as a Term 4 registrant — a Term 3 payer is not a Term 4 registrant.
//   • 24 players carry a PAID "Term 3 2026 - U4-8 Players: Unlimited Play"
//     fee ($160, 17 by card on FM's own gateway, 7 by EFTPOS at the office).
//     Those 24 become `confirmed` registrations on programme 4, option 7.
//   • 36 do not (23 no fees at all, 12 older terms only, 1 unpaid Term 3
//     Technification). If you ain't paid you ain't registered: no registration
//     is written for them, and no new contact is minted for them either.
//
// Doctrine (same as every import here): dry-run by default, ONE transaction
// (rolled back on dry-run so constraints and RETURNING still fire),
// idempotent on a natural key (registrations.legacy_source +
// legacy_external_id = the FM fee ref, protected by a partial unique index),
// people keyed on contacts.friendly_manager_id, fields filled with COALESCE
// so nothing a family already told ClubOS is overwritten, and a hard
// reconciliation (24 rows · $3,840.00 · 17 card / 7 eftpos) that throws — and
// so rolls back — if the numbers drift. No email is sent: this is direct SQL.
//
// Dry run:  npx tsx --env-file=.env script/migrate-fm-funino-2026.ts [--programme technification] [--xero]
// Apply:    npx tsx --env-file=.env script/migrate-fm-funino-2026.ts [--programme technification] [--xero] --commit

import "dotenv/config";
import fs from "fs";
import path from "path";
import pg from "pg";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { ONLINE_PAYMENT_METHOD } from "../shared/payments";
import { NZF_ETHNICITY_GROUPS } from "../shared/nzf-vocabulary";
import { countryByName, validateNzfIdentity } from "../shared/nzf-identity";

const COMMIT = process.argv.includes("--commit");
// --programme funino|technification (default funino). Same doctrine, second
// programme (2026-09-08, later the same night): Technification U9–U10 and
// U11–U12 Mondays, $150 a term, two FM groups, two ClubOS options.
const PROGRAMME = (() => { const i = process.argv.indexOf("--programme"); return i > 0 ? process.argv[i + 1] : "funino"; })();
interface ProgrammeConfig {
  dir: string; programId: number; label: string; feePrefix: string; priceCents: number;
  xeroRef: RegExp; aliases: Record<string, string>; exclude: Record<string, string>;
  /** Xero payers with NO FM profile to import but an EXISTING ClubOS contact: invoice → contact id. */
  direct?: Record<string, { contactId: number; why: string }>;
  /** Which ClubOS option a person buys — decided from the FM fee name, else the FM group they sit in, else birth year. */
  optionFor: (p: { fields: Record<string, string>; _group?: string }, feeName?: string) => number;
}
const PROGRAMMES: Record<string, ProgrammeConfig> = {
  funino: {
    dir: "2026-09-08-funino", programId: 4, label: "U4-8 Unlimited Play",
    feePrefix: "Term 3 2026 - U4-8 Players: Unlimited Play", priceCents: 16000,
    xeroRef: /^FS 2026 - Term 3/,
    // Xero spells her "Rae" like her brother Mathias; FM has "Isla Reign Law" (43351).
    aliases: { "isla rae law": "43351" },
    // Evan Hao (INV-17241, $160 "FS" + a $245 overpayment) is a U9 (born 2017-11-15) whose
    // $405 Pre-Academy payment on cufc.co.nz (ClubOS #467) Olga filed against the wrong
    // programme. Registered by mistake at 21:50 and reversed at 22:05.
    exclude: { "INV-17241": "Pre-Academy U9 payment misfiled as FS" },
    optionFor: () => 7,
  },
  technification: {
    dir: "2026-09-08-technification", programId: 5, label: "Technification (Mondays)",
    feePrefix: "Term 3 2026 - Technification", priceCents: 15000,
    xeroRef: /Technification.*T3|Term 3.*Technification/i,
    aliases: {}, exclude: {},
    direct: {
      // Xero "(G) Quintin Gilmore" — FM knows him as "Quinn Gilmore" (same family phone); ClubOS
      // already holds him as Quintin (36640, b. 2017-06-05) from a website booking. Registering
      // against that record avoids minting a "Quinn" duplicate.
      "INV-17409": { contactId: 36640, why: "ClubOS contact 36640 Quintin Gilmore (FM 'Quinn Gilmore'), b. 2017-06-05" },
      // Xero "(G) Amir Hussaini" — ClubOS 30170 (FM 40368, b. 2017-11-27), not in an FM Technification group.
      "INV-17133": { contactId: 30170, why: "ClubOS contact 30170 Amir Hussaini (FM 40368), b. 2017-11-27" },
    },
    optionFor: (p, feeName) => {
      const band = /U11\s*-\s*U12/i.test(feeName ?? "") ? 14 : /U9\s*-\s*U10/i.test(feeName ?? "") ? 13
        : /U11/i.test(p._group ?? "") ? 14 : /U9/i.test(p._group ?? "") ? 13 : null;
      if (band) return band;
      const y = Number((p.fields["person[dateOfBirth]"] ?? "").slice(0, 4));
      if (!y) throw new Error("Technification: cannot pick U9–U10 vs U11–U12 — no fee band, no group, no birth year");
      return 2026 - y <= 10 ? 13 : 14; // NZF grade = seasonYear − birthYear
    },
  },
};
const CFG = PROGRAMMES[PROGRAMME];
if (!CFG) throw new Error(`Unknown --programme ${PROGRAMME}`);
// --xero: the SECOND pass (2026-09-08, same evening). Olga tracks office payments
// in Xero, not FM — FM held fees for 24 of the 60, Xero held paid "FS 2026 -
// Term 3" invoices for 31 more of them. The people still come from the FM dump
// (full profiles + parents); only the payment evidence comes from Xero.
const XERO = process.argv.includes("--xero");

const DUMP = path.resolve(__dirname, `../../../outputs/fm-migration/${CFG.dir}/fm-dump.json`);
const REPORT_DIR = path.dirname(DUMP);
const RECONCILE = path.join(REPORT_DIR, "xero/reconcile.json");
const XERO_ALIASES = CFG.aliases;
const XERO_EXCLUDE = CFG.exclude;

const PROGRAM_ID = CFG.programId;
const TERM_LABEL = "Term 3 2026 (20 Jul – 25 Sep)";
const FEE_PREFIX = CFG.feePrefix;
const PRICE_CENTS = CFG.priceCents;
const SEASON_YEAR = 2026;
const LEGACY_SOURCE = XERO ? "xero" : "friendly_manager";
const RUN_STAMP = "2026-09-08";

// Values a parent types to mean "nothing" in a free-text box. Stored as a
// medical note they would render "No" on a coach's roll.
const NONE_MARKERS = new Set(["", "-", "no", "na", "n/a", "none", "nil", "nothing"]);

type Fields = Record<string, string>;
interface FmPayment { date: string; method: string; ref: string; amount: string }
interface FmFee {
  ref: string; name: string; date: string; due: string;
  amount: string; paid: string; outstanding: string; payments: FmPayment[];
}
interface FmPerson {
  id: string; capturedAt: string; hasFeesTab: boolean; feesStatus: string;
  totalPaid: string; outstanding: string; fields: Fields; fees: FmFee[];
  /** FM group name the person was captured from (Technification has two). */
  _group?: string;
}

// ── helpers ──────────────────────────────────────────────────────────────────

const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const nz = (v: unknown) => (s(v) ? s(v) : null);
const noneish = (v: unknown) => NONE_MARKERS.has(s(v).toLowerCase());
const textOrNull = (v: unknown) => (noneish(v) ? null : s(v));
const lc = (v: unknown) => s(v).toLowerCase();

/** dd/mm/yyyy (FM) → yyyy-mm-dd. Throws on anything else: a date is a fact. */
function isoFromDmy(dmy: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s(dmy));
  if (!m) throw new Error(`Unparseable FM date "${dmy}"`);
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/** Midday NZ on the payment date, as UTC — renders as that calendar day in
 *  both zones, so no reader ever sees the day before. */
function midDayNzUtc(isoDate: string): string {
  return `${isoDate}T00:00:00.000Z`;
}

function capFirst(v: string): string {
  return v ? v[0].toUpperCase() + v.slice(1) : v;
}

function paidTerm3Fee(p: FmPerson): FmFee | null {
  const f = p.fees.find((x) => x.name.startsWith(FEE_PREFIX));
  if (!f) return null;
  const paid = Number(f.paid), outstanding = Number(f.outstanding);
  if (!(paid > 0) || outstanding !== 0) return null;
  return f;
}

interface Payment {
  ref: string; paid: number; dateIso: string; dateLabel: string;
  office: boolean; paymentMethod: string; note: string;
}

function fmPayment(p: FmPerson): Payment {
  const fee = paidTerm3Fee(p)!;
  const pay = fee.payments[0];
  // The Technification capture could not open FM's payment sub-rows (they load
  // on a toggle the automation could not reach), so a paid fee with no payment
  // row is recorded as tender 'other' on the fee's own date — never a guessed
  // EFTPOS or card. Xero is the payment record either way.
  if (!pay) {
    return {
      ref: fee.ref, paid: Number(fee.paid), dateIso: isoFromDmy(fee.date), dateLabel: fee.date,
      office: true, paymentMethod: "other",
      note: `migrated from Friendly Manager fee ${fee.ref} ($${fee.paid} paid; FM fee dated ${fee.date}, tender not captured)`,
    };
  }
  if (Number(pay.amount) !== Number(fee.paid)) {
    throw new Error(`FM ${p.id}: payment rows do not add up to the fee's paid amount`);
  }
  const office = pay.method === "Eftpos";
  const paymentMethod = office ? "eftpos" : pay.method === "Credit Card" ? ONLINE_PAYMENT_METHOD : null;
  if (!paymentMethod) throw new Error(`FM ${p.id}: unknown FM payment method "${pay.method}"`);
  return {
    ref: fee.ref, paid: Number(fee.paid), dateIso: isoFromDmy(pay.date), dateLabel: pay.date,
    office, paymentMethod,
    note: `migrated from Friendly Manager fee ${fee.ref} ($${fee.paid} paid ${pay.date} by ${pay.method}${office ? " at the office" : " on FM's online gateway"})`,
  };
}

interface XeroRow { num: string; ref: string; to: string; date: string; paid: number; due: number; status: string }
const MONTHS: Record<string, string> = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
function isoFromXero(d: string): string {
  const m = /^(\d{1,2}) ([A-Z][a-z]{2}) (\d{4})$/.exec(s(d));
  if (!m || !MONTHS[m[2]]) throw new Error(`Unparseable Xero date "${d}"`);
  return `${m[3]}-${MONTHS[m[2]]}-${m[1].padStart(2, "0")}`;
}
/** Xero says the invoice is paid and how much; it does not say the tender, so the
 *  method is recorded as 'other' with the invoice number as the reference —
 *  never a guessed EFTPOS/cash. Olga raises these at the office. */
function xeroPayment(r: XeroRow): Payment {
  return {
    ref: r.num, paid: r.paid, dateIso: isoFromXero(r.date), dateLabel: r.date,
    office: true, paymentMethod: "other",
    note: `migrated from Xero invoice ${r.num} ("${r.ref}", $${r.paid.toFixed(2)} paid, invoice dated ${r.date}; Friendly Manager holds no fee for this term)`,
  };
}

const xeroNorm = (v: string) => v.replace(/^\((FS|G|A[^)]*)\)\s*/, "").replace(/[’']/g, "'").trim().toLowerCase();

function classify(p: FmPerson): string {
  const t4 = p.fees.filter((f) => f.name.startsWith("Term 4 2026") && f.name.includes(FEE_PREFIX.replace("Term 3 2026 - ", "")));
  if (t4.length) return "TERM4_FEE_PRESENT";
  const t3 = p.fees.find((f) => f.name.startsWith(FEE_PREFIX));
  if (t3) return Number(t3.outstanding) === 0 && Number(t3.paid) > 0 ? "T3_PAID" : "T3_UNPAID";
  if (p.feesStatus === "NO_FEES_TAB") return "NO_FEES";
  if (!p.fees.length) return `FEES_TAB_EMPTY (outstanding $${p.outstanding || "?"})`;
  const terms = [...new Set(p.fees.map((f) => f.name.split(" - ")[0]))].sort();
  return `OLDER_ONLY (${terms.join(", ")})`;
}

interface Guardian {
  fmId: string; firstName: string; lastName: string; relationship: string | null;
  primary: boolean; email: string | null; phone: string | null; altPhone: string | null;
}

function guardiansOf(f: Fields): Guardian[] {
  const ids = [...new Set(
    Object.keys(f).map((k) => /^contacts\[(\d+)\]/.exec(k)?.[1]).filter(Boolean) as string[],
  )];
  const out = ids.map((id) => ({
    fmId: id,
    firstName: s(f[`contacts[${id}][firstName]`]),
    lastName: s(f[`contacts[${id}][lastName]`]),
    relationship: nz(f[`contacts[${id}][relationship]`]),
    primary: s(f[`contacts[${id}][type]`]) === "Primary Contact",
    email: nz(lc(f[`contacts[${id}][email]`])),
    phone: nz(f[`contacts[${id}][phone]`]),
    altPhone: nz(f[`contacts[${id}][alternatePhone]`]),
  }));
  // Primary first, so the registration's guardian_id is the person FM emails.
  out.sort((a, b) => Number(b.primary) - Number(a.primary));
  return out;
}

/** Only an EXACT match against NZ Football's own vocabulary is written to the
 *  structured columns. FM is NZF-connected and offers the same list, so an
 *  exact match is the family's answer, not our guess; a near-miss stays free
 *  text and counts as a gap, which is the truth. */
function structuredIdentity(f: Fields) {
  const cob = countryByName(f["customFields[countryOfBirth]"]);
  const nat = countryByName(f["customFields[nationality]"]);
  const groupByName = (name: string) =>
    NZF_ETHNICITY_GROUPS.find((g) => g.name.trim().toLowerCase() === lc(name)) ?? null;
  const g1 = groupByName(f["customFields[ethnicity]"] ?? "");
  const sel1 = s(f["customFields[subEthnicity][]"]);
  let g2 = groupByName(f["customFields[ethnicity2]"] ?? "");
  const sel2 = s(f["customFields[subEthnicity2][]"]);
  // A second ethnicity identical to the first carries no information and the
  // validator rightly refuses it; dropping the repeat is normalisation.
  if (g2 && g1 && g2.id === g1.id && lc(sel2) === lc(sel1)) g2 = null;
  const selIds = (g: typeof g1, name: string) => {
    if (!g) return [];
    if (!name) return [];
    const m = g.selections.find((x) => x.name.trim().toLowerCase() === lc(name));
    return m ? [m.id] : [-1]; // -1 = no exact match → validation fails → free text only
  };
  if (!cob || !nat || !g1) return null;
  const r = validateNzfIdentity({
    countryOfBirthCode: cob.code,
    nationalityCode: nat.code,
    ethnicityGroupId: g1.id,
    ethnicitySelectionIds: selIds(g1, sel1),
    ethnicity2GroupId: g2?.id ?? null,
    ethnicity2SelectionIds: g2 ? selIds(g2, sel2) : [],
  });
  return r.ok ? r.value : null;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const dump: Record<string, FmPerson> = JSON.parse(fs.readFileSync(DUMP, "utf8"));
  // Xero mode may bring in a person who paid in Xero but is no longer in FM
  // group 372 (Evan Hao). Their FM profile is captured the same way into
  // xero/extra-fm-people.json, keyed by FM id, and merged here.
  const EXTRA = path.join(REPORT_DIR, "xero/extra-fm-people.json");
  if (XERO && fs.existsSync(EXTRA)) {
    const extra: Record<string, FmPerson> = JSON.parse(fs.readFileSync(EXTRA, "utf8"));
    for (const [id, p] of Object.entries(extra)) if (!dump[id]) dump[id] = p;
  }
  const people = Object.values(dump).sort((a, b) => Number(a.id) - Number(b.id));
  console.log(`${PROGRAMME}: ${people.length} people in the FM dump (${DUMP})`);

  const classes = new Map<string, FmPerson[]>();
  for (const p of people) {
    const k = classify(p);
    classes.set(k, [...(classes.get(k) ?? []), p]);
  }
  if (classes.has("TERM4_FEE_PRESENT")) {
    throw new Error("A Term 4 2026 fee appeared in the dump — this script only knows Term 3. Stop and look.");
  }
  // FM mode: the paid FM fee holders. Xero mode: FM-group people with a PAID
  // "FS 2026 - Term 3" invoice in Xero and no FM fee (the FM-fee holders are
  // already in, and a second registration would double-count them).
  const xeroById = new Map<string, XeroRow>();
  if (XERO) {
    const rec = JSON.parse(fs.readFileSync(RECONCILE, "utf8"));
    const byName = new Map<string, FmPerson>();
    for (const p of people) byName.set(xeroNorm(`${s(p.fields["person[firstName]"])} ${s(p.fields["person[lastName]"])}`), p);
    for (const row of rec.t3paid as XeroRow[]) {
      if (XERO_EXCLUDE[row.num]) continue;
      const key = xeroNorm(row.to);
      const p = XERO_ALIASES[key] ? dump[XERO_ALIASES[key]] : byName.get(key);
      if (!p) continue; // not in the FM group — reported separately, needs a human
      if (paidTerm3Fee(p)) continue; // FM already proves this one; migrated in pass 1
      if (xeroById.has(p.id)) throw new Error(`Two paid Xero Term 3 invoices for FM ${p.id} (${row.to}) — resolve by hand`);
      xeroById.set(p.id, row);
    }
  }
  const toMigrate = XERO ? people.filter((p) => xeroById.has(p.id)) : (classes.get("T3_PAID") ?? []);
  const paymentFor = (p: FmPerson): Payment => XERO ? xeroPayment(xeroById.get(p.id)!) : fmPayment(p);
  console.log(`\nClassification:`);
  for (const [k, v] of [...classes.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${String(v.length).padStart(3)}  ${k}`);
  }
  console.log(`\nMigrating ${toMigrate.length} paid Term 3 registrations from ${XERO ? "XERO" : "FM fees"}. ${COMMIT ? "COMMIT" : "DRY RUN (rolled back)"}\n`);

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const q = async (sql: string, params: any[] = []) => (await client.query(sql, params)).rows;

  const stats = {
    playersAdoptedByFm: 0, playersAdoptedByIdentity: 0, playersCreated: 0, playersUpdated: 0,
    guardiansAdoptedByFm: 0, guardiansAdoptedByEmail: 0, guardiansCreated: 0, guardiansRetyped: 0,
    relationshipsInserted: 0, relationshipsExisting: 0,
    identityStructured: 0, identityFreeTextOnly: 0,
    regsInserted: 0, regsAlreadyThere: 0, pendingSuperseded: 0,
    warnings: [] as string[],
  };
  const mapping: any[] = [];

  try {
    await client.query("BEGIN");

    const prog = (await q(`SELECT id, name, type, organization_id FROM programs WHERE id=$1`, [PROGRAM_ID]))[0];
    if (!prog || prog.type !== "academy") throw new Error(`Programme ${PROGRAM_ID} is not the academy programme expected`);
    const options = new Map<number, { id: number; name: string; full_price_cents: number }>();
    for (const o of await q(`SELECT id, name, full_price_cents FROM program_options WHERE program_id=$1 AND is_active`, [PROGRAM_ID])) options.set(o.id, o);
    for (const o of options.values()) if (o.full_price_cents !== PRICE_CENTS) throw new Error(`Option ${o.id} ${o.name} is $${o.full_price_cents / 100}, expected $${PRICE_CENTS / 100}`);

    for (const p of toMigrate) {
      const f = p.fields;
      const pay = paymentFor(p);
      const paidIso = pay.dateIso;
      const optionId = CFG.optionFor(p, XERO ? undefined : paidTerm3Fee(p)?.name);
      const opt = options.get(optionId);
      if (!opt) throw new Error(`FM ${p.id}: option ${optionId} is not an active option of programme ${PROGRAM_ID}`);
      const firstName = s(f["person[firstName]"]), lastName = s(f["person[lastName]"]);
      const dob = nz(f["person[dateOfBirth]"]);
      const gender = f["person[gender]"] === "Male" ? "male" : f["person[gender]"] === "Female" ? "female" : null;
      const street = nz(f["person[street]"]), suburb = nz(f["person[suburb]"]);
      const city = nz(f["person[city]"]), postcode = nz(f["person[postCode]"]);
      const oneLine = [street, suburb, city, postcode].filter(Boolean).join(", ") || null;
      const school = textOrNull(f["customFields[school]"]);
      const schoolYear = textOrNull(f["customFields[schoolYear]"]);
      const medical = textOrNull(f["person[medical]"]);
      const previousClub = textOrNull(f["customFields[previousClub]"]);
      const photoConsent = f["person[allowPhotos]"] === "checked";
      const identity = structuredIdentity(f);
      const guardians = guardiansOf(f);
      if (!guardians.length || !guardians[0].primary) {
        throw new Error(`FM ${p.id} ${firstName} ${lastName}: no Primary Contact in FM — cannot register a child with no guardian`);
      }

      // ── guardians ──────────────────────────────────────────────────────────
      const guardianIds: Array<{ g: Guardian; id: number }> = [];
      for (const g of guardians) {
        let row = (await q(`SELECT id, type, date_of_birth FROM contacts WHERE friendly_manager_id=$1`, [g.fmId]))[0];
        if (row) stats.guardiansAdoptedByFm++;
        if (!row && g.email) {
          // Same rule as the office counter: a guardian is matched on email —
          // but only when the first name agrees, so one shared mailbox can
          // never quietly merge two different adults.
          const cands = await q(
            `SELECT id, type, date_of_birth, first_name FROM contacts
              WHERE friendly_manager_id IS NULL AND type='guardian'
                AND email IS NOT NULL AND lower(trim(email))=$1`, [g.email]);
          const same = cands.filter((c) => lc(c.first_name) === lc(g.firstName));
          if (same.length === 1) {
            row = same[0];
            await q(`UPDATE contacts SET friendly_manager_id=$1 WHERE id=$2`, [g.fmId, row.id]);
            stats.guardiansAdoptedByEmail++;
          } else if (cands.length) {
            stats.warnings.push(`FM ${p.id}: guardian ${g.firstName} ${g.lastName} <${g.email}> matches ${cands.length} ClubOS guardian(s) by email but not by first name — created a new row instead of merging`);
          }
        }
        if (row) {
          // The FM history import typed FM "Standard Contact" adults as
          // players (they were people rows with no role). A parent with no
          // date of birth, no registration and no roster spot is a guardian.
          if (row.type === "player" && !row.date_of_birth) {
            const inUse = (await q(
              `SELECT (SELECT count(*) FROM registrations WHERE contact_id=$1)
                    + (SELECT count(*) FROM contact_relationships WHERE player_id=$1)
                    + (SELECT count(*) FROM club_squad_members WHERE contact_id=$1) AS n`, [row.id]))[0].n;
            if (Number(inUse) === 0) {
              await q(`UPDATE contacts SET type='guardian' WHERE id=$1`, [row.id]);
              stats.guardiansRetyped++;
            }
          }
          await q(
            `UPDATE contacts SET
               email = COALESCE(NULLIF(email,''), $2),
               phone = COALESCE(NULLIF(phone,''), $3),
               alternate_phone = COALESCE(NULLIF(alternate_phone,''), $4),
               address = COALESCE(NULLIF(address,''), $5),
               address_street = COALESCE(address_street, $6),
               address_suburb = COALESCE(address_suburb, $7),
               address_city = COALESCE(address_city, $8),
               address_postcode = COALESCE(address_postcode, $9)
             WHERE id=$1`,
            [row.id, g.email, g.phone, g.altPhone, oneLine, street, suburb, city, postcode]);
        } else {
          // The household address is the child's address — the same choice the
          // FM history import made for every guardian it created.
          row = (await q(
            `INSERT INTO contacts (type, first_name, last_name, email, phone, alternate_phone,
               address, address_street, address_suburb, address_city, address_postcode, friendly_manager_id)
             VALUES ('guardian', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id, type`,
            [g.firstName, g.lastName, g.email, g.phone, g.altPhone, oneLine, street, suburb, city, postcode, g.fmId]))[0];
          stats.guardiansCreated++;
        }
        guardianIds.push({ g, id: row.id });
      }
      const primaryGuardianId = guardianIds[0].id;

      // ── player ─────────────────────────────────────────────────────────────
      let player = (await q(`SELECT id FROM contacts WHERE friendly_manager_id=$1`, [p.id]))[0];
      if (player) stats.playersAdoptedByFm++;
      if (!player && dob) {
        // A child who was typed into ClubOS (an online checkout, an office
        // entry) before FM knew them: same name, same birthday, same family.
        const cands = await q(
          `SELECT c.id FROM contacts c
            WHERE c.friendly_manager_id IS NULL AND c.type='player'
              AND lower(c.first_name)=$1 AND lower(c.last_name)=$2 AND c.date_of_birth=$3::date
              AND EXISTS (SELECT 1 FROM contact_relationships r WHERE r.player_id=c.id AND r.guardian_id = ANY($4))`,
          [lc(firstName), lc(lastName), dob, guardianIds.map((x) => x.id)]);
        if (cands.length === 1) {
          player = cands[0];
          await q(`UPDATE contacts SET friendly_manager_id=$1 WHERE id=$2`, [p.id, player.id]);
          stats.playersAdoptedByIdentity++;
        } else if (cands.length > 1) {
          throw new Error(`FM ${p.id} ${firstName} ${lastName}: ${cands.length} ClubOS players share name, DOB and family — resolve by hand`);
        }
      }
      const playerCols = {
        gender, dob, address: oneLine, street, suburb, city, postcode,
        school, schoolYear, medical, previousClub,
        nationality: nz(f["customFields[nationality]"]),
        countryOfBirth: nz(f["customFields[countryOfBirth]"]),
        ethnicity: nz(f["customFields[ethnicity]"]),
        subEthnicity: nz(f["customFields[subEthnicity][]"]),
        ethnicity2: nz(f["customFields[ethnicity2]"]),
        subEthnicity2: nz(f["customFields[subEthnicity2][]"]),
        email: nz(lc(f["person[email]"])),
        phone: nz(f["person[phone]"]),
      };
      if (player) {
        await q(
          `UPDATE contacts SET
             gender = COALESCE(gender, $2::gender_type),
             date_of_birth = COALESCE(date_of_birth, $3::date),
             address = COALESCE(NULLIF(address,''), $4),
             address_street = COALESCE(address_street, $5),
             address_suburb = COALESCE(address_suburb, $6),
             address_city = COALESCE(address_city, $7),
             address_postcode = COALESCE(address_postcode, $8),
             school = COALESCE(NULLIF(school,''), $9),
             school_year = COALESCE(NULLIF(school_year,''), $10),
             medical_notes = COALESCE(NULLIF(medical_notes,''), $11),
             previous_club = COALESCE(NULLIF(previous_club,''), $12),
             nationality = COALESCE(NULLIF(nationality,''), $13),
             country_of_birth = COALESCE(NULLIF(country_of_birth,''), $14),
             ethnicity = COALESCE(NULLIF(ethnicity,''), $15),
             sub_ethnicity = COALESCE(NULLIF(sub_ethnicity,''), $16),
             ethnicity2 = COALESCE(NULLIF(ethnicity2,''), $17),
             sub_ethnicity2 = COALESCE(NULLIF(sub_ethnicity2,''), $18),
             email = COALESCE(NULLIF(email,''), $19),
             phone = COALESCE(NULLIF(phone,''), $20),
             photo_consent = photo_consent OR $21
           WHERE id=$1`,
          [player.id, playerCols.gender, playerCols.dob, playerCols.address, playerCols.street, playerCols.suburb,
           playerCols.city, playerCols.postcode, playerCols.school, playerCols.schoolYear, playerCols.medical,
           playerCols.previousClub, playerCols.nationality, playerCols.countryOfBirth, playerCols.ethnicity,
           playerCols.subEthnicity, playerCols.ethnicity2, playerCols.subEthnicity2, playerCols.email,
           playerCols.phone, photoConsent]);
        stats.playersUpdated++;
      } else {
        player = (await q(
          `INSERT INTO contacts (type, first_name, last_name, gender, date_of_birth, address,
             address_street, address_suburb, address_city, address_postcode, school, school_year,
             medical_notes, previous_club, nationality, country_of_birth, ethnicity, sub_ethnicity,
             ethnicity2, sub_ethnicity2, email, phone, photo_consent, friendly_manager_id)
           VALUES ('player', $1, $2, $3::gender_type, $4::date, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                   $14, $15, $16, $17, $18, $19, $20, $21, $22, $23) RETURNING id`,
          [firstName, lastName, playerCols.gender, playerCols.dob, playerCols.address, playerCols.street,
           playerCols.suburb, playerCols.city, playerCols.postcode, playerCols.school, playerCols.schoolYear,
           playerCols.medical, playerCols.previousClub, playerCols.nationality, playerCols.countryOfBirth,
           playerCols.ethnicity, playerCols.subEthnicity, playerCols.ethnicity2, playerCols.subEthnicity2,
           playerCols.email, playerCols.phone, photoConsent, p.id]))[0];
        stats.playersCreated++;
      }

      // Structured NZF identity — only where nobody has answered yet in ClubOS,
      // and only from an exact vocabulary match.
      if (identity) {
        const r = await client.query(
          `UPDATE contacts SET
             country_of_birth=$2, country_of_birth_code=$3, nationality=$4, nationality_code=$5,
             ethnicity=$6, ethnicity_group_id=$7, ethnicity_selection_ids=$8, sub_ethnicity=$9,
             ethnicity2=$10, ethnicity2_group_id=$11, ethnicity2_selection_ids=$12, sub_ethnicity2=$13,
             identity_captured_at=now(), identity_captured_source='import'
           WHERE id=$1 AND ethnicity_group_id IS NULL AND nationality_code IS NULL AND country_of_birth_code IS NULL`,
          [player.id, identity.countryOfBirth, identity.countryOfBirthCode, identity.nationality, identity.nationalityCode,
           identity.ethnicity, identity.ethnicityGroupId, identity.ethnicitySelectionIds, identity.subEthnicity,
           identity.ethnicity2, identity.ethnicity2GroupId, identity.ethnicity2SelectionIds, identity.subEthnicity2]);
        if (r.rowCount) stats.identityStructured++;
      } else {
        stats.identityFreeTextOnly++;
      }

      // ── family links ───────────────────────────────────────────────────────
      for (const { g, id: gid } of guardianIds) {
        const exists = await q(`SELECT id FROM contact_relationships WHERE guardian_id=$1 AND player_id=$2`, [gid, player.id]);
        if (exists.length) { stats.relationshipsExisting++; continue; }
        await q(
          `INSERT INTO contact_relationships (guardian_id, player_id, relationship, is_primary_contact)
           VALUES ($1, $2, $3, $4)`,
          [gid, player.id, g.relationship ? capFirst(g.relationship) : "parent", g.primary]);
        stats.relationshipsInserted++;
      }

      // ── the registration ───────────────────────────────────────────────────
      const already = await q(
        `SELECT id, order_number FROM registrations WHERE legacy_source=$1 AND legacy_external_id=$2`,
        [LEGACY_SOURCE, pay.ref]);
      let regId: number, orderNumber: number;
      if (already.length) {
        stats.regsAlreadyThere++;
        regId = already[0].id; orderNumber = already[0].order_number;
      } else {
        // A family who ALSO paid Term 3 in ClubOS would be charged twice on
        // paper. None exist today; the guard is here for a re-run.
        const dup = await q(
          `SELECT id FROM registrations WHERE contact_id=$1 AND program_id=$2
             AND status IN ('confirmed','partially_refunded','refunded')
             AND registered_at >= '2026-06-01' AND registered_at < '2026-10-01'`, [player.id, PROGRAM_ID]);
        if (dup.length) {
          throw new Error(`FM ${p.id} ${firstName} ${lastName}: already holds a paid Term 3 registration in ClubOS (#${dup[0].id}) — a second one would double-count $160`);
        }
        const isOffice = pay.office;
        const paymentMethod = pay.paymentMethod;
        // The agreed price is what was paid: a half term is $80, eight weeks
        // $92.80. Same shape as an office entry — list price, discount, total.
        const paidCents = Math.round(pay.paid * 100);
        if (paidCents <= 0 || paidCents > PRICE_CENTS) throw new Error(`FM ${p.id}: paid $${pay.paid} is outside 0–$160`);
        const priceNote = paidCents < PRICE_CENTS ? ` · Price adjusted from ${(PRICE_CENTS / 100).toFixed(2)} to ${pay.paid.toFixed(2)}` : "";
        const notes = `${TERM_LABEL} · ${CFG.label} · ${opt.name} · ${pay.note}${priceNote} on ${RUN_STAMP}`;
        const ins = (await q(
          `INSERT INTO registrations (
             program_id, program_option_id, contact_id, guardian_id, status,
             payment_mode, academy_payment_plan, season_year,
             subtotal_cents, discount_cents, total_cents, currency, amount_paid,
             registration_location, source, notes,
             payment_method, payment_reference, served_by_user_id, paid_at, registered_at,
             legacy_source, legacy_external_id, order_number)
           VALUES ($1, $2, $3, $4, 'confirmed',
                   'upfront', 'term', $5,
                   $6::int, $6::int - $17::int, $17::int, 'NZD', $7,
                   $8, $9, $10,
                   $11, $12, NULL, $13::timestamptz, $14::timestamp,
                   $15, $16, (SELECT COALESCE(MAX(order_number), 0) + 1 FROM registrations))
           RETURNING id, order_number`,
          [PROGRAM_ID, optionId, player.id, primaryGuardianId, SEASON_YEAR,
           PRICE_CENTS, pay.paid.toFixed(2),
           isOffice ? "cufc_office" : "online", LEGACY_SOURCE, notes,
           paymentMethod, pay.ref, midDayNzUtc(paidIso), midDayNzUtc(paidIso),
           LEGACY_SOURCE, pay.ref, paidCents]))[0];
        regId = ins.id; orderNumber = ins.order_number;
        stats.regsInserted++;

        // An abandoned ClubOS checkout for the same child + programme is now
        // answered by this payment. Left `pending` it would keep the family on
        // the abandoned-enrolment nag list for a fee they paid at the counter.
        const pend = await q(
          `SELECT id FROM registrations WHERE contact_id=$1 AND program_id=$2 AND status='pending'
             AND COALESCE(amount_paid,0)=0 AND id<>$3`, [player.id, PROGRAM_ID, regId]);
        for (const row of pend) {
          await q(
            `UPDATE registrations SET status='cancelled',
               notes = COALESCE(NULLIF(notes,'') || ' · ', '') || $2
             WHERE id=$1`,
            [row.id, `Unpaid checkout superseded by registration #${regId} (${pay.ref}, $${pay.paid.toFixed(2)} paid, ${pay.dateLabel}) — closed by the ${XERO ? "Xero" : "FM"} migration on ${RUN_STAMP}`]);
          stats.pendingSuperseded++;
        }

        await q(
          `INSERT INTO audit_logs (user_id, action, entity, entity_id, details)
           VALUES (NULL, 'import', 'registration', $1, $2)`,
          [regId, `${XERO ? "Xero" : "FM"} migration (script/migrate-fm-funino-2026.ts${XERO ? " --xero" : ""}): ${firstName} ${lastName} → ${prog.name} (${opt.name}), ${pay.paid.toFixed(2)} NZD, ${TERM_LABEL}, ${pay.note}; FM person ${p.id}`]);
      }

      mapping.push({
        fmId: p.id, player: `${firstName} ${lastName}`, dob, contactId: player.id, optionId, option: opt.name,
        guardians: guardianIds.map((x) => ({ fmId: x.g.fmId, name: `${x.g.firstName} ${x.g.lastName}`, contactId: x.id, primary: x.g.primary })),
        feeRef: pay.ref, paid: pay.paid.toFixed(2), paidOn: paidIso, method: pay.paymentMethod,
        registrationId: regId, orderNumber, identityStructured: !!identity,
      });
      console.log(`  ✓ FM ${p.id} ${firstName} ${lastName} → contact ${player.id}, reg #${regId} (order ${orderNumber}), ${pay.ref} $${pay.paid.toFixed(2)} ${pay.paymentMethod} ${pay.dateLabel}${identity ? "" : "  [identity: free text only]"}`);
    }

    // ── Xero payers registered straight against an existing ClubOS contact ──
    const directPays: Payment[] = [];
    if (XERO && CFG.direct) {
      const rec = JSON.parse(fs.readFileSync(RECONCILE, "utf8"));
      for (const [inv, d] of Object.entries(CFG.direct)) {
        const row = (rec.t3paid as XeroRow[]).find((r) => r.num === inv);
        if (!row) throw new Error(`direct: ${inv} is not a paid Xero row in the reconcile file`);
        const contact = (await q(`SELECT id, first_name, last_name, date_of_birth::text dob FROM contacts WHERE id=$1 AND type='player'`, [d.contactId]))[0];
        if (!contact) throw new Error(`direct: contact ${d.contactId} not found`);
        const pay = xeroPayment(row);
        directPays.push(pay);
        const already = await q(`SELECT id, order_number FROM registrations WHERE legacy_source=$1 AND legacy_external_id=$2`, [LEGACY_SOURCE, pay.ref]);
        if (already.length) { stats.regsAlreadyThere++; continue; }
        const dup = await q(`SELECT id FROM registrations WHERE contact_id=$1 AND program_id=$2 AND status IN ('confirmed','partially_refunded','refunded') AND registered_at >= '2026-06-01' AND registered_at < '2026-10-01'`, [contact.id, PROGRAM_ID]);
        if (dup.length) throw new Error(`direct: ${contact.first_name} ${contact.last_name} already holds a paid Term 3 registration (#${dup[0].id})`);
        const guardian = (await q(`SELECT guardian_id FROM contact_relationships WHERE player_id=$1 ORDER BY is_primary_contact DESC, id LIMIT 1`, [contact.id]))[0];
        if (!guardian) throw new Error(`direct: contact ${contact.id} has no guardian link — cannot register a child with no parent`);
        const optionId = CFG.optionFor({ fields: { "person[dateOfBirth]": contact.dob ?? "" } });
        const opt = options.get(optionId);
        if (!opt) throw new Error(`direct: option ${optionId} not active on programme ${PROGRAM_ID}`);
        const paidCents = Math.round(pay.paid * 100);
        if (paidCents <= 0 || paidCents > PRICE_CENTS) throw new Error(`direct: ${inv} paid $${pay.paid} outside 0–$${PRICE_CENTS / 100}`);
        const priceNote = paidCents < PRICE_CENTS ? ` · Price adjusted from ${(PRICE_CENTS / 100).toFixed(2)} to ${pay.paid.toFixed(2)}` : "";
        const notes = `${TERM_LABEL} · ${CFG.label} · ${opt.name} · ${pay.note} · ${d.why}${priceNote} on ${RUN_STAMP}`;
        const ins = (await q(
          `INSERT INTO registrations (
             program_id, program_option_id, contact_id, guardian_id, status,
             payment_mode, academy_payment_plan, season_year,
             subtotal_cents, discount_cents, total_cents, currency, amount_paid,
             registration_location, source, notes,
             payment_method, payment_reference, served_by_user_id, paid_at, registered_at,
             legacy_source, legacy_external_id, order_number)
           VALUES ($1, $2, $3, $4, 'confirmed', 'upfront', 'term', $5,
                   $6::int, $6::int - $12::int, $12::int, 'NZD', $7,
                   'cufc_office', $8, $9, 'other', $10, NULL, $11::timestamptz, $11::timestamp,
                   $8, $10, (SELECT COALESCE(MAX(order_number), 0) + 1 FROM registrations))
           RETURNING id, order_number`,
          [PROGRAM_ID, optionId, contact.id, guardian.guardian_id, SEASON_YEAR, PRICE_CENTS, pay.paid.toFixed(2),
           LEGACY_SOURCE, notes, pay.ref, midDayNzUtc(pay.dateIso), paidCents]))[0];
        stats.regsInserted++;
        await q(`INSERT INTO audit_logs (user_id, action, entity, entity_id, details) VALUES (NULL, 'import', 'registration', $1, $2)`,
          [ins.id, `Xero migration (script/migrate-fm-funino-2026.ts --programme ${PROGRAMME} --xero, direct): ${contact.first_name} ${contact.last_name} → ${prog.name} (${opt.name}), ${pay.paid.toFixed(2)} NZD, ${TERM_LABEL}, ${pay.note}; ${d.why}`]);
        mapping.push({ fmId: null, player: `${contact.first_name} ${contact.last_name}`, dob: contact.dob, contactId: contact.id, optionId, option: opt.name, guardians: [{ contactId: guardian.guardian_id }], feeRef: pay.ref, paid: pay.paid.toFixed(2), paidOn: pay.dateIso, method: "other", registrationId: ins.id, orderNumber: ins.order_number, direct: d.why });
        console.log(`  ✓ direct ${contact.first_name} ${contact.last_name} (contact ${contact.id}) → reg #${ins.id} (order ${ins.order_number}), ${pay.ref} $${pay.paid.toFixed(2)} ${pay.dateLabel}`);
      }
    }

    // ── reconcile against FM ────────────────────────────────────────────────
    const rec = (await q(
      `SELECT count(*)::int n, sum(total_cents)::int cents, sum(amount_paid)::numeric paid,
              count(*) FILTER (WHERE payment_method='eftpos')::int eftpos,
              count(*) FILTER (WHERE payment_method=$2)::int card,
              count(*) FILTER (WHERE payment_method='other')::int other,
              count(*) FILTER (WHERE total_cents <> round(amount_paid*100))::int total_mismatch,
              count(*) FILTER (WHERE status<>'confirmed')::int not_confirmed,
              count(*) FILTER (WHERE order_number IS NULL)::int no_order
         FROM registrations WHERE legacy_source=$1 AND program_id=$3`,
      [LEGACY_SOURCE, ONLINE_PAYMENT_METHOD, PROGRAM_ID]))[0];
    const pays = [...toMigrate.map(paymentFor), ...directPays];
    const srcSum = pays.reduce((a, x) => a + x.paid, 0);
    const srcCount = (m: string) => pays.filter((x) => x.paymentMethod === m).length;
    console.log(`
Reconciliation — ClubOS: ${rec.n} regs · $${(rec.cents / 100).toFixed(2)} · paid $${Number(rec.paid).toFixed(2)} · ${rec.eftpos} eftpos / ${rec.card} card / ${rec.other} other`);
    console.log(`               — ${XERO ? "Xero:  " : "FM:    "} ${pays.length} paid · $${srcSum.toFixed(2)} · ${srcCount("eftpos")} eftpos / ${srcCount(ONLINE_PAYMENT_METHOD)} card / ${srcCount("other")} other`);
    const bad: string[] = [];
    if (rec.n !== pays.length) bad.push("count");
    if ((rec.cents / 100).toFixed(2) !== srcSum.toFixed(2)) bad.push("total_cents");
    if (Number(rec.paid).toFixed(2) !== srcSum.toFixed(2)) bad.push("amount_paid");
    if (rec.total_mismatch) bad.push("total≠paid");
    if (rec.eftpos !== srcCount("eftpos") || rec.card !== srcCount(ONLINE_PAYMENT_METHOD) || rec.other !== srcCount("other")) bad.push("tender split");
    if (rec.not_confirmed) bad.push("status");
    if (rec.no_order) bad.push("order_number");
    if (bad.length) throw new Error(`RECONCILIATION FAILED on: ${bad.join(", ")} — rolling back`);

    const dupOrders = await q(`SELECT order_number FROM registrations WHERE order_number IS NOT NULL GROUP BY 1 HAVING count(*)>1`);
    if (dupOrders.length) throw new Error(`Duplicate order numbers after import: ${dupOrders.map((r) => r.order_number).join(", ")}`);

    console.log(`\nStats: ${JSON.stringify(stats, null, 0)}`);

    const report = {
      run: RUN_STAMP, programme: PROGRAMME, source: XERO ? "xero" : "friendly_manager", mode: COMMIT ? "commit" : "dry-run", program: PROGRAM_ID, term: TERM_LABEL,
      migrated: mapping,
      notMigrated: people.filter((p) => classify(p) !== "T3_PAID" && !xeroById.has(p.id)).map((p) => ({
        fmId: p.id, name: `${s(p.fields["person[firstName]"])} ${s(p.fields["person[lastName]"])}`,
        why: classify(p),
        fees: p.fees.map((f) => `${f.ref} ${f.name.split(" - ")[0]} paid $${f.paid} outstanding $${f.outstanding}`),
      })),
      stats,
    };
    fs.writeFileSync(path.join(REPORT_DIR, `report-${XERO ? "xero-" : ""}${COMMIT ? "commit" : "dry-run"}.json`), JSON.stringify(report, null, 2));

    if (COMMIT) {
      await client.query("COMMIT");
      console.log("\nCOMMITTED.");
    } else {
      await client.query("ROLLBACK");
      console.log("\nDRY RUN — rolled back. Re-run with --commit to apply.");
    }
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error("\n✗", e.message ?? e); process.exit(1); });
