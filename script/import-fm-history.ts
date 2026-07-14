// Import 10 years of Friendly Manager data into ClubOS (CUFC, org 1).
// Sources: data/friendly-manager-export/<date>/ (people, members combined, transactions CSVs)
// Mapping doc: DanielMeynOS/plans/2026-07-14-fm-clubos-import-mapping.md
//
// DRY RUN by default (transaction rolled back). Pass --commit to persist.
// Idempotent: contacts upsert on friendly_manager_id; history rows ON CONFLICT DO NOTHING
// on their natural keys; relationships + unsubscribes check-before-insert.
//
// Usage:
//   npx tsx script/import-fm-history.ts --dir /abs/path/to/2026-07-14 [--commit]
import "dotenv/config";
import pg from "pg";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const ORG_ID = 1; // Christchurch United

// ---------- tiny CSV parser (handles quotes, embedded commas/newlines, BOM) ----------
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
const lc = (s: string) => (s || "").trim().toLowerCase();
const nz = (s: string) => { const t = (s || "").trim(); return t === "" ? null : t; };
const dobOk = (s: string) => s && s !== "0000-00-00" ? s : null;
const sha1 = (s: string) => crypto.createHash("sha1").update(s).digest("hex");

function parseNzDate(d: string): string | null {
  // FM CSVs: DD/MM/YYYY or YYYY-MM-DD
  const m1 = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(d);
  if (m1) return `${m1[3]}-${m1[2]}-${m1[1]}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  return null;
}
function seasonYearFromTerm(name: string): number | null {
  const m = /\b(20\d\d)\b/.exec(name);
  return m ? parseInt(m[1], 10) : null;
}
function normalizeMethod(raw: string): string {
  const r = raw.trim();
  if (/^Allocation/i.test(r)) return "credit_allocation";
  const map: Record<string, string> = {
    "Credit Card": "card", "Bank Transfer": "bank_transfer", "Eftpos": "eftpos",
    "Cash": "cash", "Other": "other", "Overpayment": "overpayment",
    "Prepayment": "prepayment", "Credit Deduction": "credit_deduction",
  };
  return map[r] || "other";
}
function splitNamePhone(s: string): { name: string | null; phone: string | null } {
  const t = (s || "").trim();
  if (!t) return { name: null, phone: null };
  const i = t.lastIndexOf(":");
  if (i === -1) return { name: t, phone: null };
  const name = t.slice(0, i).trim();
  const phone = t.slice(i + 1).trim();
  return { name: name || null, phone: /\d/.test(phone) ? phone : null };
}
function amountToCents(s: string): number | null {
  const t = (s || "").replace(/[$,\s]/g, "");
  if (!t || isNaN(Number(t))) return null;
  return Math.round(Number(t) * 100);
}

async function main() {
  const args = process.argv.slice(2);
  const commit = args.includes("--commit");
  const dirIdx = args.indexOf("--dir");
  const dir = dirIdx >= 0 ? args[dirIdx + 1] : path.resolve(__dirname, "../../../data/friendly-manager-export/2026-07-14");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");

  const people = csvObjects(path.join(dir, "people/people-all-8716.csv"));
  const members = csvObjects(path.join(dir, "members/members-all-terms-combined.csv"));
  const txns = csvObjects(path.join(dir, "fees/transactions-all.csv"));
  const termMap = new Map<string, string>(); // termId -> name
  for (const line of fs.readFileSync(path.join(dir, "terms.tsv"), "utf8").split("\n")) {
    const [id, name] = line.split("\t");
    if (id && name) termMap.set(id.trim(), name.trim());
  }
  console.log(`Loaded: ${people.length} people, ${members.length} member rows, ${txns.length} transactions, ${termMap.size} terms`);

  // ---------- pre-compute classification ----------
  const memberPersonIds = new Set(members.map((m) => m["Id"]));
  const primaryContactOf = new Map<string, string>(); // personId -> "Name: phone" raw
  const isReferencedAsPC = new Set<string>(); // names (lc "first last") referenced as someone's primary contact
  for (const p of people) {
    const pc = p["Primary Contact"];
    if (pc) {
      primaryContactOf.set(p["Id"], pc);
      isReferencedAsPC.add(lc(splitNamePhone(pc).name || ""));
    }
  }
  const nameIndex = new Map<string, string[]>(); // lc "first last" -> [personIds]
  for (const p of people) {
    const k = lc(`${p["First Name"]} ${p["Last Name"]}`);
    if (!nameIndex.has(k)) nameIndex.set(k, []);
    nameIndex.get(k)!.push(p["Id"]);
  }
  const peopleById = new Map(people.map((p) => [p["Id"], p]));

  function contactType(p: Record<string, string>): "player" | "guardian" | "staff" {
    const role = p["Role"] || "";
    if (role === "Club Admin" || role === "Manager") return "staff";
    if (memberPersonIds.has(p["Id"])) {
      if (role === "Standard User" && isReferencedAsPC.has(lc(`${p["First Name"]} ${p["Last Name"]}`))) return "guardian";
      return "player";
    }
    if (role === "No Login") return "player";
    return "guardian";
  }

  function buildNotes(p: Record<string, string>): string {
    const parts = ["Imported from Friendly Manager 2026-07-14"];
    const jd = dobOk(p["Join Date"]);
    if (jd) parts.push(`FM join ${jd}`);
    if (nz(p["Comet ID"])) parts.push(`COMET ${p["Comet ID"]}`);
    if (nz(p["Occupation"])) parts.push(`Occupation: ${p["Occupation"]}`);
    if (nz(p["Volunteer"])) parts.push(`Volunteer: ${p["Volunteer"]}`);
    if (nz(p["Club Name"]) && p["Club Name"] !== p["Team Name"]) parts.push(`Club: ${p["Club Name"]}`);
    if (nz(p["Notes"])) parts.push(`FM notes: ${p["Notes"]}`);
    if (nz(p["Tags"]) && p["Tags"] !== "[]") parts.push(`FM tags: ${p["Tags"]}`);
    return parts.join(" · ");
  }

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const stats = {
    contactsInserted: 0, contactsAdopted: 0, contactsUpdatedByFmId: 0,
    archivedContactsCreated: 0, relationshipsInserted: 0, relationshipsSkippedAmbiguous: 0,
    relationshipsExisting: 0, regsInserted: 0, regsConflict: 0, regsNoContact: 0,
    paysInserted: 0, paysConflict: 0, paysLinked: 0, paysAmbiguous: 0, paysNoMatch: 0,
    unsubsInserted: 0, amountCentsTotal: 0,
  };

  try {
    await client.query("BEGIN");

    // ---------- 1. contacts ----------
    const fmToContactId = new Map<string, number>();
    for (const p of people) {
      const fmId = p["Id"];
      const email = nz(lc(p["Email"]));
      const first = p["First Name"].trim(), last = p["Last Name"].trim();
      const type = contactType(p);
      const em = splitNamePhone(p["Emergency Contact"]);
      const gender = p["Gender"] === "Male" ? "male" : p["Gender"] === "Female" ? "female" : null;

      // 1a: already imported? (idempotent re-run)
      const existingByFm = await client.query(`SELECT id FROM contacts WHERE friendly_manager_id = $1 LIMIT 1`, [fmId]);
      if (existingByFm.rows.length) {
        fmToContactId.set(fmId, existingByFm.rows[0].id);
        stats.contactsUpdatedByFmId++;
        continue;
      }
      // 1b: adopt an existing prod contact (same email + name)
      let adoptedId: number | null = null;
      if (email) {
        const r = await client.query(
          `SELECT id FROM contacts WHERE friendly_manager_id IS NULL AND lower(trim(email)) = $1
             AND lower(first_name) = $2 AND lower(last_name) = $3 ORDER BY id LIMIT 1`,
          [email, lc(first), lc(last)]
        );
        if (r.rows.length) adoptedId = r.rows[0].id;
      }
      if (adoptedId) {
        await client.query(
          `UPDATE contacts SET
             friendly_manager_id = $1,
             phone = COALESCE(NULLIF(phone,''), $2),
             alternate_phone = COALESCE(NULLIF(alternate_phone,''), $3),
             gender = COALESCE(gender, $4::gender_type),
             date_of_birth = COALESCE(date_of_birth, $5::date),
             address = COALESCE(NULLIF(address,''), $6),
             medical_notes = COALESCE(NULLIF(medical_notes,''), $7),
             emergency_contact = COALESCE(NULLIF(emergency_contact,''), $8),
             emergency_phone = COALESCE(NULLIF(emergency_phone,''), $9),
             school = COALESCE(NULLIF(school,''), $10),
             school_year = COALESCE(NULLIF(school_year,''), $11),
             team_name = COALESCE(NULLIF(team_name,''), $12),
             previous_club = COALESCE(NULLIF(previous_club,''), $13),
             nationality = COALESCE(NULLIF(nationality,''), $14),
             country_of_birth = COALESCE(NULLIF(country_of_birth,''), $15),
             ethnicity = COALESCE(NULLIF(ethnicity,''), $16),
             sub_ethnicity = COALESCE(NULLIF(sub_ethnicity,''), $17),
             ethnicity2 = COALESCE(NULLIF(ethnicity2,''), $18),
             sub_ethnicity2 = COALESCE(NULLIF(sub_ethnicity2,''), $19),
             tags = CASE WHEN COALESCE(tags,'') = '' THEN 'fm-import' ELSE tags || ',fm-import' END,
             notes = CASE WHEN COALESCE(notes,'') = '' THEN $20 ELSE notes || E'\n' || $20 END
           WHERE id = $21`,
          [fmId, nz(p["Phone"]), nz(p["Alternate Phone"]), gender, dobOk(p["Date Of Birth"]),
           nz(p["Address"]), nz(p["Medical"]), em.name, em.phone, nz(p["School"]),
           nz(p["School Year"]), nz(p["Team Name"]), nz(p["Previous Club"]), nz(p["Nationality"]),
           nz(p["Country of Birth"]), nz(p["Ethnicity"]), nz(p["Specific Ethnicity"]),
           nz(p["Additional Ethnicity"]), nz(p["Specific Additional Ethnicity"]),
           buildNotes(p), adoptedId]
        );
        fmToContactId.set(fmId, adoptedId);
        stats.contactsAdopted++;
        continue;
      }
      // 1c: insert new
      const ins = await client.query(
        `INSERT INTO contacts (type, first_name, last_name, email, phone, alternate_phone, gender,
           date_of_birth, address, nationality, school, school_year, medical_notes,
           emergency_contact, emergency_phone, photo_consent, newsletter_consent,
           previous_club, team_name, tags, notes, country_of_birth, ethnicity, sub_ethnicity,
           ethnicity2, sub_ethnicity2, friendly_manager_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
         RETURNING id`,
        [type, first, last, email, nz(p["Phone"]), nz(p["Alternate Phone"]), gender,
         dobOk(p["Date Of Birth"]), nz(p["Address"]), nz(p["Nationality"]), nz(p["School"]),
         nz(p["School Year"]), nz(p["Medical"]), em.name, em.phone,
         p["Allow Photos"] === "Yes", p["Subscribed"] === "Yes",
         nz(p["Previous Club"]), nz(p["Team Name"]),
         email ? "fm-import" : "fm-import,no-email", buildNotes(p),
         nz(p["Country of Birth"]), nz(p["Ethnicity"]), nz(p["Specific Ethnicity"]),
         nz(p["Additional Ethnicity"]), nz(p["Specific Additional Ethnicity"]), fmId]
      );
      fmToContactId.set(fmId, ins.rows[0].id);
      stats.contactsInserted++;
    }

    // 1d: the ~5 archived people present only in member rows
    const seenArchived = new Set<string>();
    for (const m of members) {
      const fmId = m["Id"];
      if (peopleById.has(fmId) || fmToContactId.has(fmId) || seenArchived.has(fmId)) continue;
      seenArchived.add(fmId);
      const exists = await client.query(`SELECT id FROM contacts WHERE friendly_manager_id = $1 LIMIT 1`, [fmId]);
      if (exists.rows.length) { fmToContactId.set(fmId, exists.rows[0].id); continue; }
      const em = splitNamePhone(m["Emergency Contact"] || "");
      const ins = await client.query(
        `INSERT INTO contacts (type, first_name, last_name, email, phone, gender, date_of_birth,
           address, medical_notes, emergency_contact, emergency_phone, tags, notes, friendly_manager_id)
         VALUES ('player',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'fm-import,archived-person',
                 'Imported from Friendly Manager 2026-07-14 (archived person, from member rows)',$11)
         RETURNING id`,
        [m["First Name"], m["Last Name"], nz(lc(m["Email"] || "")), nz(m["Phone"] || ""),
         m["Gender"] === "Male" ? "male" : m["Gender"] === "Female" ? "female" : null,
         parseNzDate(m["Date Of Birth"] || "") , nz(m["Address"] || ""), nz(m["Medical"] || ""),
         em.name, em.phone, fmId]
      );
      fmToContactId.set(fmId, ins.rows[0].id);
      stats.archivedContactsCreated++;
    }

    // ---------- 2. relationships ----------
    for (const p of people) {
      const pcRaw = primaryContactOf.get(p["Id"]);
      if (!pcRaw) continue;
      const { name } = splitNamePhone(pcRaw);
      if (!name) continue;
      const candidates = nameIndex.get(lc(name)) || [];
      let guardianFmId: string | null = null;
      if (candidates.length === 1) guardianFmId = candidates[0];
      else if (candidates.length > 1) {
        // disambiguate by shared family email
        const myEmail = lc(p["Email"]);
        const share = candidates.filter((cid) => cid !== p["Id"] && lc(peopleById.get(cid)!["Email"]) === myEmail && myEmail);
        if (share.length === 1) guardianFmId = share[0];
        else { stats.relationshipsSkippedAmbiguous++; continue; }
      } else { stats.relationshipsSkippedAmbiguous++; continue; }
      if (!guardianFmId || guardianFmId === p["Id"]) continue;
      const gId = fmToContactId.get(guardianFmId), cId = fmToContactId.get(p["Id"]);
      if (!gId || !cId || gId === cId) continue;
      const exists = await client.query(
        `SELECT id FROM contact_relationships WHERE guardian_id = $1 AND player_id = $2 LIMIT 1`, [gId, cId]);
      if (exists.rows.length) { stats.relationshipsExisting++; continue; }
      await client.query(
        `INSERT INTO contact_relationships (guardian_id, player_id, relationship, is_primary_contact)
         VALUES ($1,$2,'parent',true)`, [gId, cId]);
      stats.relationshipsInserted++;
    }

    // ---------- 3. fm_registration_history ----------
    for (const m of members) {
      const termId = parseInt(m["termId"], 10);
      const termName = termMap.get(m["termId"]) || `term-${m["termId"]}`;
      const cId = fmToContactId.get(m["Id"]) ?? null;
      if (!cId) stats.regsNoContact++;
      const r = await client.query(
        `INSERT INTO fm_registration_history
           (organization_id, contact_id, fm_person_id, term_id, term_name, season_year,
            programme_group, position, source, raw_json)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'friendly_manager',$9)
         ON CONFLICT (fm_person_id, term_id, programme_group) DO NOTHING
         RETURNING id`,
        [ORG_ID, cId, m["Id"], termId, termName, seasonYearFromTerm(termName),
         m["Programme"] || "(unspecified)", nz(m["Position"] || ""), JSON.stringify(m)]
      );
      if (r.rows.length) stats.regsInserted++; else stats.regsConflict++;
    }

    // ---------- 4. fm_payment_history ----------
    const occurrence = new Map<string, number>();
    for (const t of txns) {
      const cents = amountToCents(t["Amount"]);
      const paidOn = parseNzDate(t["Date"]);
      if (cents === null || !paidOn) { console.warn("SKIP unparseable tx:", JSON.stringify(t).slice(0, 120)); continue; }
      const baseKey = [t["Fee #"], paidOn, cents, t["Method"], t["Note/Reference"]].join("|");
      const occ = (occurrence.get(baseKey) || 0) + 1;
      occurrence.set(baseKey, occ);
      const externalKey = sha1(`${baseKey}|${occ}`);

      const k = lc(`${t["First Name"]} ${t["Last Name"]}`);
      const cand = nameIndex.get(k) || [];
      let cId: number | null = null;
      if (cand.length === 1) { cId = fmToContactId.get(cand[0]) ?? null; if (cId) stats.paysLinked++; }
      else if (cand.length > 1) stats.paysAmbiguous++;
      else stats.paysNoMatch++;

      // fee text: "Term 3 2026 - Technification: Technification: U11 - U12 Mondays"
      const feeText = (t["Fee"] || "").trim();
      const termM = /^(.*?20\d\d|[^-]*?)\s*-\s*(.*)$/.exec(feeText);
      const termName = termM && /20\d\d|Term|Academy|Camp|Winter|Senior|Programme/i.test(termM[1]) ? termM[1].trim() : null;
      const programme = termM ? termM[2].trim() : null;

      const r = await client.query(
        `INSERT INTO fm_payment_history
           (organization_id, contact_id, first_name, last_name, fee_number, fee_description,
            term_name, season_year, programme, method, method_raw, paid_on, amount_cents,
            note_reference, source, external_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'friendly_manager',$15)
         ON CONFLICT (external_key) DO NOTHING
         RETURNING id`,
        [ORG_ID, cId, t["First Name"], t["Last Name"], nz(t["Fee #"]), nz(feeText),
         termName, termName ? seasonYearFromTerm(termName) : null, programme,
         normalizeMethod(t["Method"]), t["Method"], paidOn, cents, nz(t["Note/Reference"]), externalKey]
      );
      if (r.rows.length) { stats.paysInserted++; stats.amountCentsTotal += cents; }
      else stats.paysConflict++;
    }

    // ---------- 5. unsubscribes (only emails where EVERY sharer is No) ----------
    const byEmail = new Map<string, string[]>();
    for (const p of people) {
      const e = lc(p["Email"]);
      if (!e) continue;
      if (!byEmail.has(e)) byEmail.set(e, []);
      byEmail.get(e)!.push(p["Subscribed"]);
    }
    for (const [email, subs] of byEmail) {
      if (!subs.every((s) => s === "No")) continue;
      const r = await client.query(
        `INSERT INTO email_unsubscribes (organization_id, email, source)
         VALUES ($1,$2,'fm-import') ON CONFLICT (organization_id, email) DO NOTHING RETURNING id`,
        [ORG_ID, email]
      );
      if (r.rows.length) stats.unsubsInserted++;
    }

    // ---------- report ----------
    const expectTotal = 111726939; // $1,117,269.39 from the manifest
    console.log("\n================ IMPORT REPORT ================");
    console.log(JSON.stringify(stats, null, 2));
    console.log(`payments $ total inserted: $${(stats.amountCentsTotal / 100).toLocaleString("en-NZ", { minimumFractionDigits: 2 })}`);
    console.log(`manifest expects:          $${(expectTotal / 100).toLocaleString("en-NZ", { minimumFractionDigits: 2 })}`);
    console.log(`reconciles: ${stats.amountCentsTotal === expectTotal ? "YES ✓" : "NO — INVESTIGATE"}`);

    // sample families for eyeballing
    const fam = await client.query(`
      SELECT g.first_name || ' ' || g.last_name AS guardian, g.email,
             c.first_name || ' ' || c.last_name AS child, c.date_of_birth,
             (SELECT count(*) FROM fm_registration_history h WHERE h.contact_id = c.id) AS reg_terms,
             (SELECT count(*) FROM fm_payment_history ph WHERE ph.contact_id = c.id) AS payments
      FROM contact_relationships r
      JOIN contacts g ON g.id = r.guardian_id
      JOIN contacts c ON c.id = r.player_id
      WHERE g.tags LIKE '%fm-import%'
      ORDER BY random() LIMIT 10`);
    console.log("\nSample families (guardian -> child, terms, payments):");
    for (const f of fam.rows) console.log(` ${f.guardian} <${f.email}> -> ${f.child} (dob ${f.date_of_birth}) regs:${f.reg_terms} pays:${f.payments}`);

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
