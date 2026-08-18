// ─────────────────────────────────────────────────────────────────────────────
// SEED — the vehicle Drive folder into the fleet register.
//
//   npx tsx --env-file=.env script/seed-fleet-drive-context.ts            (dry)
//   npx tsx --env-file=.env script/seed-fleet-drive-context.ts --commit
//
// Source: the "Vehicles" folder in the club's Google Drive
// (drive.google.com/drive/folders/1vl8814mSNB5p7SflSJlooHRmCwugwdyS) — signed
// agreements, per-vehicle condition photos, and the 2024 records that turned
// out to hold the only insurance documents anyone has produced.
//
// ── What the folder actually settled, and what it opened up ─────────────────
//
// The register left insurance blank ("?" in every Insurer cell). It is not
// blank because nobody filled the sheet in. Two policies exist, and NEITHER
// covers today's fleet:
//
//   * AMI M0020801177 — the 2014 Toyota Aqua QLP12, third party only, insured
//     in the name of a PRIVATE INDIVIDUAL, not the club. 8 May 2024 → 8 May
//     2025. Expired 15 months ago.
//   * AA AMV033120667 — comprehensive, insured "Canterbury Sports Limited",
//     direct-debited from Ryan Edwards' personal bank account, covering a 2010
//     Toyota Land Cruiser (FKW617) that is NOT in the 2026 register at all.
//     Same dates. Also expired.
//
// Both are recorded here rather than left as "unknown", because an expired
// policy with a date is a fact staff can act on, and `insuranceStatus()` reads
// it as expired and shows when cover lapsed. "Unknown" would hide that the club
// has looked and found nothing current.
//
// The two 2024 vehicles are added as DISPOSED — not because a disposal is
// documented (it isn't), but because the register states "Fleet Size: 6
// Vehicles" as at 30 July 2026 and neither is among them, so they are provably
// out of the current fleet. `disposed_on` stays NULL: gone, date unknown. A
// disposed vehicle never nags, so this adds history without adding noise.
//
// The contradiction worth a human's attention is in the paperwork itself. The
// Feb 2024 business vehicle agreement says the EMPLOYEE "shall be responsible
// for maintaining comprehensive insurance … in the name of the Employee". The
// later Staff Vehicle Use Policy says "The Club maintains its own insurance for
// Club-owned vehicles". Those cannot both be the club's position, and which one
// is true decides whether six vehicles on the road are covered.
// ─────────────────────────────────────────────────────────────────────────────
import pg from "pg";

const COMMIT = process.argv.includes("--commit");
const ORG_ID = 7;
const CREATED_BY = 1;
const DRIVE = "https://drive.google.com/drive/folders/1vl8814mSNB5p7SflSJlooHRmCwugwdyS";

/** The date the register asserts the fleet is six vehicles. Used to CLOSE the
 *  2024 assignments: we cannot know when each driver handed the vehicle back,
 *  but we know it was no longer in the fleet by then. A ceiling, not a date. */
const REGISTER_DATE = "2026-07-30";

// ── Notes appended to the six vehicles already in the register ───────────────
const MARKER = "── From the vehicle Drive folder ──";

const NOTE_APPEND: Record<string, string> = {
  QLP12:
    "Signed Staff Vehicle Use Policy and Agreement on file (Vehicle Agreement - Ryan.pdf).\n" +
    "Condition photos on file (Drive → Photos and Video → \"Aqua QLP12 - Ryan\").\n" +
    "🔴 The ONLY insurance document found for this car is an AMI certificate in the name of a " +
    "private individual (not the club), THIRD PARTY only, which expired 8 May 2025. Recorded " +
    "against the vehicle below. If this car is being driven on club business today, whether it " +
    "is insured at all is an open question.",
  PRK235:
    "Signed Staff Vehicle Use Policy and Agreement on file (Vehicle Agreement - Paul.pdf).\n" +
    "Condition photos on file (Drive → Photos and Video → \"Mitsubishi Outlander- Paul\").\n" +
    "No insurance document found for this vehicle anywhere in the Drive folder.",
  NCN360:
    "Signed Staff Vehicle Use Policy and Agreement on file (…Agreement NCN 360.pdf).\n" +
    "No insurance document found for this vehicle anywhere in the Drive folder.",
  MML178: "No insurance document found for this vehicle anywhere in the Drive folder.",
  FWC150:
    "No signed agreement found in the Drive folder either — which matches the register's own " +
    "blank Agreement cell for this vehicle.\n" +
    "No insurance document found for this vehicle anywhere in the Drive folder.",
  RPN394: "No insurance document found for this vehicle anywhere in the Drive folder.",
};

// ── Insurance found in the Drive folder ──────────────────────────────────────
type Policy = {
  plate: string;
  insurer: string;
  policyNumber: string;
  coverType: string;
  startsOn: string;
  expiresOn: string;
  excessCents: number | null;
  agreedValueCents: number | null;
  notes: string;
};

const POLICIES: Policy[] = [
  {
    plate: "QLP12",
    insurer: "AMI Insurance",
    policyNumber: "M0020801177",
    coverType: "third_party",
    startsOn: "2024-05-08",
    expiresOn: "2025-05-08",
    excessCents: null,
    agreedValueCents: null,
    notes:
      "From \"Certificate of Insurance.pdf\" (8 May 2024) in the Drive folder's 2024 records.\n" +
      "🔴 The insured is a PRIVATE INDIVIDUAL (Mr Ta Eh Doe), not Christchurch United FC or any " +
      "club entity, and the cover is \"Private Third Party\" — no cover for damage to this car, " +
      "and the policy describes the use as private, not business.\n" +
      "Annual premium $159.18, billed monthly. EXPIRED 8 May 2025; no renewal document exists in " +
      "the folder. Recorded so the gap is visible, not to suggest the car is covered.",
  },
  {
    plate: "FKW617",
    insurer: "AA Insurance",
    policyNumber: "AMV033120667",
    coverType: "comprehensive",
    startsOn: "2024-05-08",
    expiresOn: "2025-05-08",
    excessCents: 50000,
    agreedValueCents: 3000000,
    notes:
      "From \"Motor Policy Schedule AMV033120667.pdf\" (21 May 2024).\n" +
      "Insured: Canterbury Sports Limited — a different entity from Christchurch United Football " +
      "Club Inc. Premium direct-debited fortnightly ($67.74) from R M Edwards' personal bank " +
      "account, authorised by Ryan Edwards.\n" +
      "Agreed value $30,000. Comprehensive excess $500 (plus $550 listed driver under 25, $400 " +
      "inexperienced, $2,500 unlisted driver under 25). Excess-free glass included; rental cover " +
      "declined. Listed drivers: Ryan Edwards (main), Amy Robertson.\n" +
      "🔴 Vehicle use is recorded with the insurer as PRIVATE, and the vehicle address as 24 Bill " +
      "Hammond Drive, Belfast. A club vehicle used for club business on a policy that says " +
      "private is worth checking before a claim, not after. EXPIRED 8 May 2025.",
  },
];

// ── The 2024 vehicles, neither of which is in the current register ───────────
type Archived = {
  plate: string;
  make: string;
  model: string;
  year: number | null;
  vehicleType: string;
  fuelType: string;
  wofExpiresOn: string | null;
  regoExpiresOn: string | null;
  notes: string;
  holderName: string;
  assignedOn: string;
  assignmentNotes: string;
};

const ARCHIVED: Archived[] = [
  {
    plate: "FKW617",
    make: "Toyota",
    model: "Land Cruiser",
    year: 2010,
    vehicleType: "car",
    // The insurer's own description: "200 Vx Wagon 8st 5dr Spts". A 200-series
    // VX is diesel in New Zealand, but nothing in these documents says so and a
    // wrong answer here changes whether it owed RUC. Left at the default.
    fuelType: "petrol",
    wofExpiresOn: "2024-10-04",
    regoExpiresOn: "2025-01-21",
    notes:
      "ARCHIVED — this vehicle is NOT in the 30 July 2026 register, which states a fleet of six. " +
      "Recorded from its February 2024 business vehicle agreement so the history, the driver and " +
      "the insurance policy have somewhere to live.\n" +
      "🔴 Marked disposed because it is provably out of the current fleet. NO disposal is " +
      "documented — `disposed_on` is deliberately blank, and whether it was sold, returned or " +
      "transferred is unknown. Correct the status if it is still around.\n" +
      "Insurer's description: 2010 Toyota Landcruiser 200 Vx Wagon 8st 5dr Spts, agreed value " +
      "$30,000. The AA policy below is the only comprehensive cover found for any club vehicle.",
    holderName: "Ryan Edwards",
    assignedOn: "2024-02-01",
    assignmentNotes:
      "From the February 2024 business vehicle agreement, which commences 1 Feb 2024 and runs " +
      "until terminated. Driver insurance recorded on the agreement as \"AA - Policy number: " +
      "AMV033120667\".\n" +
      "End date NOT documented. Closed on 30 Jul 2026 because the register of that date shows " +
      "the vehicle was no longer in the fleet — a ceiling on when it ended, not the actual day.",
  },
  {
    plate: "LDL505",
    make: "Toyota",
    model: "Camry",
    year: 2008,
    vehicleType: "car",
    fuelType: "petrol",
    wofExpiresOn: "2023-07-17",
    regoExpiresOn: "2023-07-17",
    notes:
      "ARCHIVED — not in the 30 July 2026 register. Recorded from its February 2024 business " +
      "vehicle agreement.\n" +
      "🔴 Marked disposed because it is provably out of the current fleet; no disposal is " +
      "documented and `disposed_on` is blank.\n" +
      "⚠️ The agreement itself lists the WOF and registration as due 17 July 2023 — both already " +
      "expired when the February 2024 agreement was signed. Recorded as written.\n" +
      "The agreement's Driver Insurance field is EMPTY.",
    holderName: "Steven van Dijk",
    assignedOn: "2024-02-01",
    assignmentNotes:
      "From the February 2024 business vehicle agreement (commences 1 Feb 2024). The Driver " +
      "Insurance field on the agreement was left blank.\n" +
      "End date NOT documented. Closed on 30 Jul 2026, the date the register shows the vehicle " +
      "was no longer in the fleet.",
  },
];

/** The policy conflict, recorded once on the workspace's own fleet notes via
 *  every vehicle would be noise — so it goes on the two documents' vehicles and
 *  is reported to a human. Kept here so the script explains itself. */
const POLICY_CONFLICT =
  "⚠️ The paperwork contradicts itself on who insures a club vehicle. The Feb 2024 business " +
  "vehicle agreement makes it the EMPLOYEE's responsibility, in the employee's own name. The " +
  "Staff Vehicle Use Policy says the Club maintains its own insurance for club-owned vehicles. " +
  "Both are on file. Which one is true decides whether six vehicles now on the road are covered.";

async function main() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log(`\n  Vehicle Drive folder → ClubOS fleet (org ${ORG_ID})`);
  console.log(`  ${COMMIT ? "COMMIT — writing to the live database" : "DRY RUN — rolled back"}\n`);

  await client.query("BEGIN");
  try {
    // ── 1. Append the Drive context to the six existing vehicles ─────────────
    for (const [plate, extra] of Object.entries(NOTE_APPEND)) {
      const { rows } = await client.query(
        `select id, notes from fleet_vehicles
          where organization_id = $1 and upper(plate) = upper($2) and status <> 'disposed'`,
        [ORG_ID, plate],
      );
      if (!rows.length) { console.log(`  ! ${plate} not found — skipped`); continue; }
      if ((rows[0].notes ?? "").includes(MARKER)) {
        console.log(`  = ${plate.padEnd(8)} Drive context already recorded`);
        continue;
      }
      const notes = `${rows[0].notes ?? ""}\n\n${MARKER}\n${extra}\nFolder: ${DRIVE}`.trim();
      await client.query(`update fleet_vehicles set notes = $1, updated_at = now() where id = $2`,
        [notes, rows[0].id]);
      console.log(`  + ${plate.padEnd(8)} Drive context appended`);
    }

    // ── 2. The two 2024 vehicles, archived ───────────────────────────────────
    for (const v of ARCHIVED) {
      const existing = await client.query(
        `select id from fleet_vehicles where organization_id = $1 and upper(plate) = upper($2)`,
        [ORG_ID, v.plate],
      );
      let id: number;
      if (existing.rowCount) {
        id = existing.rows[0].id;
        console.log(`  = ${v.plate.padEnd(8)} ${v.make} ${v.model} already present (#${id})`);
      } else {
        const notes = `${v.notes}\n\n${MARKER}\n${POLICY_CONFLICT}\nFolder: ${DRIVE}`;
        const ins = await client.query(
          `insert into fleet_vehicles
             (organization_id, plate, make, model, year, vehicle_type, fuel_type,
              compliance_type, wof_expires_on, rego_expires_on, ruc_required,
              ownership, status, disposed_on, fbt_private_use, fbt_exemption, notes, created_by)
           values ($1,$2,$3,$4,$5,$6,$7,'wof',$8,$9,false,'owned','disposed',NULL,false,'none',$10,$11)
           returning id`,
          [ORG_ID, v.plate, v.make, v.model, v.year, v.vehicleType, v.fuelType,
           v.wofExpiresOn, v.regoExpiresOn, notes, CREATED_BY],
        );
        id = ins.rows[0].id;
        console.log(`  + ${v.plate.padEnd(8)} ${v.make} ${v.model} → #${id} (archived)`);
      }

      const dupe = await client.query(
        `select id from fleet_assignments where vehicle_id = $1 and holder_name = $2 and assigned_on = $3`,
        [id, v.holderName, v.assignedOn],
      );
      if (dupe.rowCount) { console.log(`      = ${v.holderName} — assignment already present`); continue; }
      await client.query(
        `insert into fleet_assignments
           (organization_id, vehicle_id, holder_name, assigned_on, returned_on, notes, created_by)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [ORG_ID, id, v.holderName, v.assignedOn, REGISTER_DATE, v.assignmentNotes, CREATED_BY],
      );
      console.log(`      + ${v.holderName} (2024-02-01 → ${REGISTER_DATE}, closed)`);
    }

    // ── 3. The two policies ──────────────────────────────────────────────────
    for (const p of POLICIES) {
      const veh = await client.query(
        `select id from fleet_vehicles where organization_id = $1 and upper(plate) = upper($2)`,
        [ORG_ID, p.plate],
      );
      if (!veh.rowCount) { console.log(`  ! no vehicle ${p.plate} for policy ${p.policyNumber}`); continue; }
      const dupe = await client.query(
        `select id from fleet_insurance_policies where vehicle_id = $1 and policy_number = $2`,
        [veh.rows[0].id, p.policyNumber],
      );
      if (dupe.rowCount) { console.log(`  = ${p.policyNumber} already recorded`); continue; }
      await client.query(
        `insert into fleet_insurance_policies
           (organization_id, vehicle_id, insurer, policy_number, cover_type, starts_on,
            expires_on, excess_cents, agreed_value_cents, notes, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [ORG_ID, veh.rows[0].id, p.insurer, p.policyNumber, p.coverType, p.startsOn,
         p.expiresOn, p.excessCents, p.agreedValueCents, `${p.notes}\n\n${POLICY_CONFLICT}`, CREATED_BY],
      );
      console.log(`  + policy ${p.policyNumber} (${p.insurer}) → ${p.plate}, expired ${p.expiresOn}`);
    }

    // ── Verify ───────────────────────────────────────────────────────────────
    const c = (await client.query(
      `select
         (select count(*)::int from fleet_vehicles where organization_id=$1 and status <> 'disposed') live,
         (select count(*)::int from fleet_vehicles where organization_id=$1 and status = 'disposed') archived,
         (select count(*)::int from fleet_insurance_policies where organization_id=$1) policies,
         (select count(*)::int from fleet_vehicles where organization_id=$1 and notes like '%'||$2||'%') noted`,
      [ORG_ID, MARKER],
    )).rows[0];

    const problems: string[] = [];
    if (c.live !== 6) problems.push(`expected 6 live vehicles, found ${c.live}`);
    if (c.archived !== 2) problems.push(`expected 2 archived vehicles, found ${c.archived}`);
    if (c.policies !== 2) problems.push(`expected 2 policies, found ${c.policies}`);
    if (c.noted !== 8) problems.push(`expected 8 vehicles carrying Drive context, found ${c.noted}`);

    // No policy may claim to cover today — both expired, and saying otherwise
    // would be the one error that matters here.
    const current = await client.query(
      `select policy_number from fleet_insurance_policies
        where organization_id = $1 and expires_on >= current_date`,
      [ORG_ID],
    );
    for (const r of current.rows) problems.push(`${r.policy_number} reads as current cover — it is not`);

    console.log(`\n  ${c.live} live · ${c.archived} archived · ${c.policies} policies (both expired) · ${c.noted} carry Drive context`);
    if (problems.length) {
      for (const p of problems) console.error(`    ✗ ${p}`);
      throw new Error("verification failed");
    }
    console.log("  ✓ verification passed");

    if (COMMIT) { await client.query("COMMIT"); console.log("\n  Committed.\n"); }
    else { await client.query("ROLLBACK"); console.log("\n  Rolled back (dry run). Re-run with --commit.\n"); }
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(`\n  FAILED: ${e.message}\n`); process.exit(1); });
