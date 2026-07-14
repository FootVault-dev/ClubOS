// Import CUFC Shopify order history (holiday programmes, residency camps,
// open trainings, one CIC tournament entry — and gymnastics behind a flag)
// into ClubOS's existing fm_registration_history / fm_payment_history tables.
// NO NEW TABLES — same two destination tables the Friendly Manager import uses
// (they already carry a `source` column for exactly this reason).
//
// Source: data/cufc-shopify-export/<date>/*.csv, produced by
//         scripts/shopify/export_cufc_history.py (local-only, reads the
//         on-disk Shopify order cache, never calls the Shopify API).
// Bucket classification + per-bucket order/line/gross totals were verified to
// reconcile exactly against outputs/shopify-cufc-audit/2026-07-14/report.md
// before that export was written — this script also re-checks the totals it
// reads against the export's own reconciliation.json before importing.
//
// Clones the structure of import-fm-history.ts exactly:
//   - single transaction, DRY RUN by default (ROLLBACK), --commit to persist
//   - batched 500-row INSERTs (not one round-trip per row)
//   - adopt-existing-contact-before-insert, COALESCE-fill only empty fields
//   - ON CONFLICT DO NOTHING idempotency on natural keys
//   - verification report printed at the end
//
// Usage:
//   npx tsx script/import-shopify-history.ts --dir /abs/path/to/2026-07-15 [--commit] [--include-gymnastics]
//
// INVARIANT (re-run idempotency): every contact this script inserts is found
// again on the next run by the SAME matching rule it was inserted under
// (email+first+last, or — when there is no email — first+last+phone). Every
// registration/payment row's natural key (fm_person_id / external_key) is
// deterministic from (line_id [+ child_row_index for multi-child holiday
// lines]) — never randomly generated — so re-running with --commit twice is
// a no-op the second time (ON CONFLICT DO NOTHING on both tables, and the
// contact/child/relationship lookups all re-resolve to the rows the first
// run created).
//
// KNOWN LIMITATIONS (deliberate, see the task's read-first + judgement calls):
//   - Refund state is not carried through — every line imports as clean paid
//     history regardless of Shopify `financial_status` (10 of 689 holiday
//     orders are partially_refunded/refunded/partially_paid; this was out of
//     the export's specified columns, flagged for Daniel/Victor).
//   - ~62 holiday lines with quantity > 1 whose properties don't cleanly
//     decompose into N named children (empty properties, or a crammed
//     comma-joined name that doesn't split N ways) import as ONE buyer-level
//     row per line (child_unknown=1, contact = the buyer), not N synthetic
//     unnamed children — see export_cufc_history.py's own docstring.
//   - No-email buyers (40 of 874 target-bucket orders) are matched/deduped by
//     (first, last, phone) rather than email; if two different truly
//     no-email buyers ever share identical first+last+phone (including all
//     blank) they would be merged into one contact. Rare in practice, worth
//     a human skim of the "no-email" contacts after --commit.
import "dotenv/config";
import pg from "pg";
import fs from "fs";
import path from "path";

const BATCH = 500;

// Bucket -> destination ClubOS org.
//   holiday-programmes / residency-camps / open-trainings -> org 1 (CUFC)
//   cic-tournament -> org 5 (Christchurch International Cup)
//   gymnastics -> org 6 (United Gymnastics) — DESTINATION NOT CONFIRMED BY
//   DANIEL. The audit report only *proposed* org 6; it was never signed off.
//   Off by default — pass --include-gymnastics to import it.
const BUCKET_ORG: Record<string, number> = {
  "holiday-programmes": 1,
  "residency-camps": 1,
  "open-trainings": 1,
  "cic-tournament": 5,
  "gymnastics": 6,
};

// Per the task spec verbatim: registrations (fm_registration_history) are
// written for these three buckets only. cic-tournament (a one-off adult
// tournament team entry, not a term enrolment) and gymnastics (a free-trial
// lead, not a programme term) get a PAYMENT row only, never a registration.
const REGISTRATION_BUCKETS = new Set(["holiday-programmes", "residency-camps", "open-trainings"]);

// All five buckets get a payment row (fm_payment_history) — including the
// $0 open-trainings/gymnastics lines, which are enrolment history even
// though no money changed hands.
const BUCKET_FILES: Record<string, string> = {
  "holiday-programmes": "holiday-registrations.csv",
  "open-trainings": "open-trainings.csv",
  "gymnastics": "gymnastics.csv",
  "cic-tournament": "cic.csv",
  "residency-camps": "residency-camps.csv",
};

// ---------- tiny CSV parser (cloned verbatim from import-fm-history.ts) ----------
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", inQ = false;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (ch !== "\r") field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0].trim() !== ""));
}
function csvObjects(file: string): Record<string, string>[] {
  const rows = parseCsv(fs.readFileSync(file, "utf8"));
  const hdr = rows[0].map((h) => h.replace(/^﻿/, "").trim());
  return rows.slice(1).map((r) => Object.fromEntries(hdr.map((h, i) => [h, (r[i] ?? "").trim()])));
}

// ---------- helpers ----------
const lc = (s: string | undefined | null) => (s || "").trim().toLowerCase();
const nz = (s: string | undefined | null) => { const t = (s || "").trim(); return t === "" ? null : t; };
const isHolidayOrCampTitle = (title: string) => /holiday|camp/i.test(title);

function chunks<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
function valuesSql(rowCount: number, colCount: number): string {
  const rows: string[] = [];
  for (let r = 0; r < rowCount; r++) {
    const cols: string[] = [];
    for (let c = 0; c < colCount; c++) cols.push(`$${r * colCount + c + 1}`);
    rows.push(`(${cols.join(",")})`);
  }
  return rows.join(",");
}

// ---------- normalized row shape (one per CSV data row, across all buckets) ----------
interface Row {
  bucket: string;
  orgId: number;
  orderId: string;
  orderName: string;
  lineId: string;
  childRowIndex: number;
  isMultiRowLine: boolean; // >1 CSV row shares this (orderId,lineId) — holiday multi-child lines only
  buyerFirst: string;
  buyerLast: string;
  buyerEmail: string;
  buyerPhone: string;
  programmeTitle: string;
  variantTitle: string;
  paidOn: string;
  lineGrossCents: number;
  currency: string;
  quantity: number;
  childUnknown: boolean;
  childFirst: string;
  childLast: string;
  childDob: string;
  raw: Record<string, string>;
}

function loadBucketCsv(dir: string, bucket: string): Row[] {
  const file = path.join(dir, BUCKET_FILES[bucket]);
  if (!fs.existsSync(file)) throw new Error(`Missing export file for bucket ${bucket}: ${file}`);
  const objs = csvObjects(file);
  const isHoliday = bucket === "holiday-programmes";
  const rows: Row[] = objs.map((o) => ({
    bucket,
    orgId: BUCKET_ORG[bucket],
    orderId: o["order_id"],
    orderName: o["order_name"] || "",
    lineId: o["line_id"],
    childRowIndex: isHoliday ? parseInt(o["child_row_index"] || "0", 10) : 0,
    isMultiRowLine: false, // filled in below
    buyerFirst: o["buyer_first"] || "",
    buyerLast: o["buyer_last"] || "",
    buyerEmail: lc(o["buyer_email"]),
    buyerPhone: o["buyer_phone"] || "",
    programmeTitle: o["programme_title"] || "",
    variantTitle: o["variant_title"] || "",
    paidOn: o["paid_on"],
    lineGrossCents: parseInt(o["line_gross_cents"] || "0", 10),
    currency: o["currency"] || "NZD",
    quantity: parseInt(o["quantity"] || "1", 10),
    childUnknown: isHoliday ? o["child_unknown"] === "1" : true,
    childFirst: isHoliday ? (o["child_first"] || "") : "",
    childLast: isHoliday ? (o["child_last"] || "") : "",
    childDob: isHoliday ? (o["child_dob"] || "") : "",
    raw: o,
  }));
  if (isHoliday) {
    const counts = new Map<string, number>();
    for (const r of rows) {
      const k = `${r.orderId}|${r.lineId}`;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    for (const r of rows) r.isMultiRowLine = (counts.get(`${r.orderId}|${r.lineId}`) || 1) > 1;
  }
  return rows;
}

function buyerKeyOf(r: Row): string {
  return r.buyerEmail
    ? `email:${r.buyerEmail}|${lc(r.buyerFirst)}|${lc(r.buyerLast)}`
    : `noemail:${lc(r.buyerFirst)}|${lc(r.buyerLast)}|${lc(r.buyerPhone)}`;
}
// Natural key shared by fm_registration_history.fm_person_id and
// fm_payment_history.external_key — MUST be suffixed with child_row_index
// whenever more than one output row shares a line_id (holiday multi-child
// lines), or the payment table's UNIQUE(external_key) index would reject
// rows 2..N for that line.
function lineNaturalKey(r: Row): string {
  return r.isMultiRowLine ? `shopify:${r.lineId}:${r.childRowIndex}` : `shopify:${r.lineId}`;
}

async function main() {
  const args = process.argv.slice(2);
  const commit = args.includes("--commit");
  const includeGymnastics = args.includes("--include-gymnastics");
  const dirIdx = args.indexOf("--dir");
  const dir = dirIdx >= 0 ? args[dirIdx + 1] : path.resolve(__dirname, "../../../data/cufc-shopify-export/2026-07-15");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");

  const reconPath = path.join(dir, "reconciliation.json");
  const reconciliation: Record<string, { orders: number; lines: number; gross_cents: number }> =
    fs.existsSync(reconPath) ? JSON.parse(fs.readFileSync(reconPath, "utf8")) : {};

  const buckets = Object.keys(BUCKET_ORG).filter((b) => b !== "gymnastics" || includeGymnastics);
  if (!includeGymnastics) {
    console.log("Skipping gymnastics bucket (destination org 6 unconfirmed by Daniel) — pass --include-gymnastics to import it.");
  }

  const allRows: Row[] = [];
  for (const bucket of buckets) allRows.push(...loadBucketCsv(dir, bucket));
  console.log(`Loaded ${allRows.length} rows across buckets: ${buckets.join(", ")}`);

  // Re-verify what we loaded against the export's own reconciliation.json
  // (independent double-check — confirms this script read the same CSVs the
  // export believed it wrote). Computed at LINE granularity (distinct
  // order_id+line_id), since holiday multi-child lines repeat the same
  // lineGrossCents on every child row of that line.
  console.log("\nRe-checking loaded CSVs against reconciliation.json:");
  let anyMismatch = false;
  for (const bucket of buckets) {
    if (!reconciliation[bucket]) continue;
    const rowsForBucket = allRows.filter((r) => r.bucket === bucket);
    const orders = new Set(rowsForBucket.map((r) => r.orderId));
    const lineGross = new Map<string, number>(); // "orderId|lineId" -> gross
    for (const r of rowsForBucket) lineGross.set(`${r.orderId}|${r.lineId}`, r.lineGrossCents);
    const grossCents = [...lineGross.values()].reduce((a, c) => a + c, 0);
    const exp = reconciliation[bucket];
    const ok = orders.size === exp.orders && lineGross.size === exp.lines && grossCents === exp.gross_cents;
    console.log(
      `  ${bucket.padEnd(20)} orders ${orders.size}/${exp.orders}  lines ${lineGross.size}/${exp.lines}  ` +
      `gross $${(grossCents / 100).toFixed(2)}/$${(exp.gross_cents / 100).toFixed(2)}  [${ok ? "MATCH" : "MISMATCH"}]`
    );
    if (!ok) anyMismatch = true;
  }
  // Staff test orders (Daniel testing checkout with child "Test 1" on his own
  // footvault email) are real Shopify lines — they reconcile above — but must
  // not become history rows or a "Test 1" child contact. Excluded HERE, after
  // the reconciliation gate, and logged so the report is honest about it.
  const testRows = allRows.filter(
    (r) => r.buyerEmail === "daniel@footvault.com" && /^test\b/i.test(`${r.childFirst}`.trim())
  );
  if (testRows.length) {
    const testCents = testRows.reduce((a, r) => a + r.lineGrossCents, 0);
    console.log(`\nExcluding ${testRows.length} staff TEST rows (buyer daniel@footvault.com, child "Test …") — $${(testCents / 100).toFixed(2)} not imported.`);
    const testSet = new Set(testRows);
    for (let i = allRows.length - 1; i >= 0; i--) if (testSet.has(allRows[i])) allRows.splice(i, 1);
  }

  if (anyMismatch) {
    throw new Error("Reconciliation mismatch between loaded CSVs and reconciliation.json — STOPPING (never import unverified numbers).");
  }

  // ---------- unique buyers across all loaded rows (first occurrence wins) ----------
  const buyerByKey = new Map<string, Row>();
  for (const r of allRows) {
    const k = buyerKeyOf(r);
    if (!buyerByKey.has(k)) buyerByKey.set(k, r);
  }

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const stats = {
    buyersAdopted: 0, buyersInserted: 0,
    childrenMatched: 0, childrenInserted: 0, relationshipsInserted: 0, relationshipsExisting: 0,
    regsInserted: 0, regsConflict: 0,
    paysInserted: 0, paysConflict: 0, paysAmountCentsTotal: 0,
    byBucket: {} as Record<string, {
      rows: number; regsInserted: number; paysInserted: number;
      paysInsertedCents: number; paysExpectedCents: number;
    }>,
  };
  for (const b of buckets) {
    stats.byBucket[b] = {
      rows: allRows.filter((r) => r.bucket === b).length,
      regsInserted: 0, paysInserted: 0, paysInsertedCents: 0, paysExpectedCents: 0,
    };
  }

  try {
    await client.query("BEGIN");

    // ============ 1. buyer contacts (adopt-before-insert, COALESCE-fill) ============
    const emailIndex = new Map<string, number>(); // "email|first|last" -> id
    const noEmailIndex = new Map<string, number>(); // "first|last|phone" -> id
    {
      const byEmail = await client.query(
        `SELECT id, lower(trim(email)) AS e, lower(first_name) AS f, lower(last_name) AS l
         FROM contacts WHERE email IS NOT NULL AND trim(email) <> '' ORDER BY id`);
      for (const r of byEmail.rows) {
        const k = `${r.e}|${r.f}|${r.l}`;
        if (!emailIndex.has(k)) emailIndex.set(k, r.id);
      }
      const noEmail = await client.query(
        `SELECT id, lower(first_name) AS f, lower(last_name) AS l, COALESCE(phone,'') AS p
         FROM contacts WHERE email IS NULL OR trim(email) = '' ORDER BY id`);
      for (const r of noEmail.rows) {
        const k = `${r.f}|${r.l}|${r.p}`;
        if (!noEmailIndex.has(k)) noEmailIndex.set(k, r.id);
      }
    }

    const buyerKeyToContactId = new Map<string, number>();
    const buyersToInsert: Row[] = [];
    for (const [key, row] of buyerByKey) {
      let existing: number | undefined;
      if (row.buyerEmail) {
        existing = emailIndex.get(`${row.buyerEmail}|${lc(row.buyerFirst)}|${lc(row.buyerLast)}`);
      } else {
        existing = noEmailIndex.get(`${lc(row.buyerFirst)}|${lc(row.buyerLast)}|${lc(row.buyerPhone)}`);
      }
      if (existing) {
        await client.query(
          `UPDATE contacts SET
             phone = COALESCE(NULLIF(phone,''), $2),
             tags = CASE WHEN COALESCE(tags,'') = '' THEN 'shopify-import'
                         WHEN tags LIKE '%shopify-import%' THEN tags
                         ELSE tags || ',shopify-import' END
           WHERE id = $1`,
          [existing, nz(row.buyerPhone)]
        );
        buyerKeyToContactId.set(key, existing);
        stats.buyersAdopted++;
      } else {
        buyersToInsert.push(row);
      }
    }

    const BUYER_COLS = 7; // type, first_name, last_name, email, phone, tags, notes
    for (const batch of chunks(buyersToInsert, BATCH)) {
      const params: any[] = [];
      for (const row of batch) {
        params.push(
          "guardian",
          row.buyerFirst || "",
          row.buyerLast || "",
          nz(row.buyerEmail),
          nz(row.buyerPhone),
          row.buyerEmail ? "shopify-import" : "shopify-import,no-email",
          "Imported from CUFC Shopify store history (2026-07-15)"
        );
      }
      // RETURNING the columns the key was built from (not relying on VALUES/
      // RETURNING positional order — mirrors import-fm-history.ts's own
      // caution on its largest batch, which RETURNS friendly_manager_id
      // rather than trusting row position).
      const res = await client.query(
        `INSERT INTO contacts (type, first_name, last_name, email, phone, tags, notes)
         VALUES ${valuesSql(batch.length, BUYER_COLS)}
         RETURNING id, lower(trim(COALESCE(email,''))) AS e, lower(first_name) AS f, lower(last_name) AS l, COALESCE(phone,'') AS p`,
        params
      );
      for (const r of res.rows) {
        const key = r.e ? `email:${r.e}|${r.f}|${r.l}` : `noemail:${r.f}|${r.l}|${lc(r.p)}`;
        buyerKeyToContactId.set(key, r.id);
      }
      stats.buyersInserted += res.rows.length;
    }

    // ============ 2. children — holiday rows with a known child only ============
    const guardianChildren = new Map<string, Array<{ id: number; f: string; l: string; dob: string }>>();
    const existingRelPairs = new Set<string>();
    {
      const rel = await client.query(
        `SELECT r.guardian_id AS gid, c.id AS cid, lower(c.first_name) AS f, lower(c.last_name) AS l,
                COALESCE(c.date_of_birth::text, '') AS dob
         FROM contact_relationships r JOIN contacts c ON c.id = r.player_id`);
      for (const r of rel.rows) {
        const arr = guardianChildren.get(String(r.gid)) || [];
        arr.push({ id: r.cid, f: r.f, l: r.l, dob: r.dob });
        guardianChildren.set(String(r.gid), arr);
        existingRelPairs.add(`${r.gid}|${r.cid}`);
      }
    }

    const holidayKnownChildRows = allRows.filter((r) => r.bucket === "holiday-programmes" && !r.childUnknown);
    const childKeyToContactId = new Map<string, number>(); // "orderId|lineId|childRowIndex" -> contact id
    const childrenToInsert: Array<{ row: Row; guardianId: number }> = [];

    for (const row of holidayKnownChildRows) {
      const guardianId = buyerKeyToContactId.get(buyerKeyOf(row));
      if (!guardianId) continue; // should never happen — every buyer was resolved above
      const wantF = lc(row.childFirst), wantL = lc(row.childLast), wantD = row.childDob;
      const candidates = (guardianChildren.get(String(guardianId)) || []).filter((c) => {
        if (c.f !== wantF) return false;
        if (wantL && c.l !== wantL) return false;
        if (wantD && c.dob && c.dob !== wantD) return false;
        return true;
      });
      if (candidates.length) {
        childKeyToContactId.set(`${row.orderId}|${row.lineId}|${row.childRowIndex}`, candidates[0].id);
        stats.childrenMatched++;
      } else {
        childrenToInsert.push({ row, guardianId });
      }
    }

    const CHILD_COLS = 6; // type, first_name, last_name, date_of_birth, tags, notes
    const childInsertKeys: string[] = [];
    const childInsertGuardians: number[] = [];
    for (const batch of chunks(childrenToInsert, BATCH)) {
      const params: any[] = [];
      for (const { row } of batch) {
        params.push(
          "player",
          row.childFirst,
          row.childLast || "",
          row.childDob || null,
          "shopify-import",
          "Imported from CUFC Shopify store history (2026-07-15, holiday programme)"
        );
      }
      const res = await client.query(
        `INSERT INTO contacts (type, first_name, last_name, date_of_birth, tags, notes)
         VALUES ${valuesSql(batch.length, CHILD_COLS)}
         RETURNING id`,
        params
      );
      for (let i = 0; i < res.rows.length; i++) {
        const { row, guardianId } = batch[i];
        childKeyToContactId.set(`${row.orderId}|${row.lineId}|${row.childRowIndex}`, res.rows[i].id);
        childInsertKeys.push(`${row.orderId}|${row.lineId}|${row.childRowIndex}`);
        childInsertGuardians.push(guardianId);
      }
      stats.childrenInserted += res.rows.length;
    }

    // relationships for newly-inserted children (existing children already have one)
    const relRows: Array<[number, number]> = [];
    for (let i = 0; i < childInsertKeys.length; i++) {
      const guardianId = childInsertGuardians[i];
      const childId = childKeyToContactId.get(childInsertKeys[i])!;
      const pairKey = `${guardianId}|${childId}`;
      if (existingRelPairs.has(pairKey)) { stats.relationshipsExisting++; continue; }
      existingRelPairs.add(pairKey);
      relRows.push([guardianId, childId]);
    }
    for (const batch of chunks(relRows, BATCH)) {
      const params: any[] = [];
      for (const [g, c] of batch) params.push(g, c, "parent", true);
      await client.query(
        `INSERT INTO contact_relationships (guardian_id, player_id, relationship, is_primary_contact)
         VALUES ${valuesSql(batch.length, 4)}`,
        params
      );
      stats.relationshipsInserted += batch.length;
    }

    // resolves the contact_id to use for any row (child if known+resolved, else the buyer)
    function contactIdFor(row: Row): number | null {
      if (row.bucket === "holiday-programmes" && !row.childUnknown) {
        const cid = childKeyToContactId.get(`${row.orderId}|${row.lineId}|${row.childRowIndex}`);
        if (cid) return cid;
      }
      return buyerKeyToContactId.get(buyerKeyOf(row)) ?? null;
    }

    // ============ 3. registrations (fm_registration_history) ============
    // Chunked PER BUCKET (not across the whole mixed row list) so the
    // per-bucket stats below are exact counts, never a proportional guess.
    const REG_COLS = 10;
    for (const bucket of buckets) {
      if (!REGISTRATION_BUCKETS.has(bucket)) continue;
      const bucketRows = allRows.filter((r) => r.bucket === bucket);
      for (const batch of chunks(bucketRows, BATCH)) {
        const params: any[] = [];
        for (const row of batch) {
          const seasonYear = parseInt(row.paidOn.slice(0, 4), 10);
          const termId = 9000 + (seasonYear - 2000);
          // term_name drives the History tab's category CASE: its FIRST branch
          // buckets term_name ~* '(camp|winter|holiday)' as 'holiday', so ONLY
          // the holiday bucket may carry that prefix. Open-trainings must keep
          // the raw title ("Free Week of Open Training") so the CASE falls
          // through to programme_group ~* 'open training' → 'open-training'.
          const termName =
            bucket === "holiday-programmes" && !isHolidayOrCampTitle(row.programmeTitle)
              ? `Holiday Programme — ${row.programmeTitle}`
              : row.programmeTitle;
          const programmeGroup = row.variantTitle || row.programmeTitle;
          params.push(
            row.orgId, contactIdFor(row), lineNaturalKey(row), termId, termName, seasonYear,
            programmeGroup, null, "shopify", JSON.stringify(row.raw)
          );
        }
        const res = await client.query(
          `INSERT INTO fm_registration_history
             (organization_id, contact_id, fm_person_id, term_id, term_name, season_year,
              programme_group, position, source, raw_json)
           VALUES ${valuesSql(batch.length, REG_COLS)}
           ON CONFLICT (fm_person_id, term_id, programme_group) DO NOTHING
           RETURNING id`,
          params
        );
        stats.regsInserted += res.rows.length;
        stats.regsConflict += batch.length - res.rows.length;
        stats.byBucket[bucket].regsInserted += res.rows.length;
      }
    }

    // ============ 4. payments (fm_payment_history) — ONE row per ORDER LINE ============
    // A multi-child line expands to N registration rows, but the money exists
    // once: inserting the full line value on each child row would overstate a
    // family's lifetime value by (N-1)×line — the dry-run reconciliation
    // caught exactly that ($420). Payments therefore dedupe to childRowIndex 0
    // (attached to that child's contact; the household rollup already unions
    // the family), and the reconciliation must now match to the cent.
    const PAY_COLS = 16;
    for (const bucket of buckets) {
      const bucketRows = allRows
        .filter((r) => r.bucket === bucket)
        .filter((r) => !r.isMultiRowLine || r.childRowIndex === 0);
      stats.byBucket[bucket].paysExpectedCents = bucketRows.reduce((sum, r) => sum + r.lineGrossCents, 0);
      for (const batch of chunks(bucketRows, BATCH)) {
        const params: any[] = [];
        for (const row of batch) {
          const seasonYear = parseInt(row.paidOn.slice(0, 4), 10);
          const cid = contactIdFor(row);
          const isChild = row.bucket === "holiday-programmes" && !row.childUnknown &&
            childKeyToContactId.has(`${row.orderId}|${row.lineId}|${row.childRowIndex}`);
          const firstName = isChild ? row.childFirst : row.buyerFirst;
          const lastName = isChild ? row.childLast : row.buyerLast;
          const feeNumber = `SHOP-${(row.orderName || "").replace(/^#/, "") || row.orderId}`;
          const feeDescription = row.variantTitle
            ? `${row.programmeTitle} — ${row.variantTitle}`
            : row.programmeTitle;
          params.push(
            row.orgId, cid, firstName, lastName, feeNumber, feeDescription,
            row.programmeTitle, seasonYear, row.programmeTitle,
            "card", "Shopify", row.paidOn, row.lineGrossCents, null,
            "shopify", lineNaturalKey(row)
          );
        }
        const res = await client.query(
          `INSERT INTO fm_payment_history
             (organization_id, contact_id, first_name, last_name, fee_number, fee_description,
              term_name, season_year, programme, method, method_raw, paid_on, amount_cents,
              note_reference, source, external_key)
           VALUES ${valuesSql(batch.length, PAY_COLS)}
           ON CONFLICT (external_key) DO NOTHING
           RETURNING amount_cents`,
          params
        );
        stats.paysInserted += res.rows.length;
        stats.paysConflict += batch.length - res.rows.length;
        stats.byBucket[bucket].paysInserted += res.rows.length;
        for (const r of res.rows) {
          stats.paysAmountCentsTotal += r.amount_cents;
          stats.byBucket[bucket].paysInsertedCents += r.amount_cents;
        }
      }
    }

    // ============ report ============
    console.log("\n================ IMPORT REPORT ================");
    console.log(JSON.stringify(stats, null, 2));
    console.log(`\nPayments inserted total: $${(stats.paysAmountCentsTotal / 100).toLocaleString("en-NZ", { minimumFractionDigits: 2 })}`);
    const expectedTotalCents = buckets.reduce((a, b) => a + (reconciliation[b]?.gross_cents || 0), 0);
    console.log(`Expected (sum of reconciliation.json for imported buckets): $${(expectedTotalCents / 100).toLocaleString("en-NZ", { minimumFractionDigits: 2 })}`);
    console.log(
      `Note: on a clean first run these should match exactly EXCEPT that holiday multi-child lines ` +
      `contribute their full line total on each of N rows (see lineNaturalKey), so paysAmountCentsTotal ` +
      `can legitimately exceed the reconciliation total by (N-1) x line value for those ~2 lines.`
    );

    const sample = await client.query(`
      SELECT g.first_name || ' ' || g.last_name AS guardian, g.email,
             c.first_name || ' ' || c.last_name AS child, c.date_of_birth::text AS dob,
             (SELECT count(*) FROM fm_registration_history h WHERE h.contact_id = c.id AND h.source = 'shopify') AS reg_rows,
             (SELECT count(*) FROM fm_payment_history ph WHERE ph.contact_id = c.id AND ph.source = 'shopify') AS pay_rows
      FROM contact_relationships r
      JOIN contacts g ON g.id = r.guardian_id
      JOIN contacts c ON c.id = r.player_id
      WHERE g.tags LIKE '%shopify-import%'
      ORDER BY random() LIMIT 10`);
    console.log("\nSample families (guardian -> child, shopify reg rows, shopify pay rows):");
    for (const f of sample.rows) {
      console.log(` ${f.guardian} <${f.email}> -> ${f.child} (dob ${f.dob}) regs:${f.reg_rows} pays:${f.pay_rows}`);
    }

    if (commit) {
      await client.query("COMMIT");
      console.log("\nCOMMITTED.");
    } else {
      await client.query("ROLLBACK");
      console.log("\nDRY RUN — rolled back. Re-run with --commit to persist.");
    }
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
