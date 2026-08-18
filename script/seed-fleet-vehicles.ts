// ─────────────────────────────────────────────────────────────────────────────
// SEED — the CUFC vehicle register into the USG Vehicles tab.
//
//   npx tsx --env-file=.env script/seed-fleet-vehicles.ts            (dry run)
//   npx tsx --env-file=.env script/seed-fleet-vehicles.ts --commit   (writes)
//
// Source: CUFC_Vehicle_Database.xlsx, sheet "Vehicle Register New", exported to
// PDF 18 Aug 2026. The sheet states "Last Updated: 30 July 2026 | Fleet Size: 6
// Vehicles". The workbook's other two sheets — Trip Log and Maintenance — are
// blank templates with headers and no rows, so there is nothing to import from
// them. Their absence is a fact worth keeping: this is a register, not a log.
//
// Idempotent on (organization_id, upper(plate)) for vehicles, on
// (vehicle_id, holder_name, assigned_on) for assignments, and on
// (vehicle_id, serviced_on) for services. Re-running never duplicates and never
// overwrites a human's later edit — an existing row is left exactly as it is.
//
// ── What this seed refuses to invent ────────────────────────────────────────
//
//  * NO INSURANCE ROWS. The register's Insurer and Policy # columns hold "?"
//    for four vehicles and are blank for two. `fleet_insurance_policies`
//    requires an insurer, a policy number and both dates — none of which exist.
//    So the tab will read insurance as `unknown` on all six, which is the
//    truth: nobody has recorded the club's motor cover. Inventing a placeholder
//    policy would turn "we don't know" into a green badge.
//
//  * NO ASSIGNMENT START DATES THAT WERE NEVER RECORDED. Five of the seven
//    driver rows show usage as "? - current": the end is open, the start is
//    unknown. `assigned_on` is NOT NULL, so each is dated 2026-07-30 — the
//    register's own last-updated date. That is a FLOOR, not a handover: on 30
//    July the register asserted these people held these vehicles, so we know
//    they held them on or before that day. Every such row says so in its notes.
//
//  * NO FUEL TYPE WHERE THE MODEL DOESN'T SETTLE IT. Aqua and Prius are
//    hybrid-only worldwide, and the Hiace's own engine number (2TR) is the 2.7
//    petrol — those three are facts about the model, not guesses. The Hilux and
//    the Outlander are left at the schema default and flagged in their notes,
//    because guessing wrong on either changes whether the vehicle owes RUC.
//
//  * NO FBT RULING. The Prius is garaged at the driver's home address, which in
//    New Zealand is the availability test. Recorded in `fbt_notes`, left for
//    Victor. The flag itself stays false — the tab records a position, it does
//    not adjudicate one.
// ─────────────────────────────────────────────────────────────────────────────
import pg from "pg";

const COMMIT = process.argv.includes("--commit");

/** United Sports Group. The Vehicles tab lives in this workspace. */
const ORG_ID = 7;
/** Daniel Meyn — whose import this is. */
const CREATED_BY = 1;

/** The register's own "Last Updated" date. Used as the floor for anything the
 *  sheet asserts as true "now" but never dated: current drivers, and the two
 *  odometer readings that carry no reading date of their own. */
const REGISTER_DATE = "2026-07-30";

type Assignment = {
  holderName: string;
  licenceExpiresOn: string | null;
  assignedOn: string;
  returnedOn: string | null;
  odometerStartKm: number | null;
  odometerEndKm: number | null;
  notes: string;
};

type Service = {
  servicedOn: string;
  odometerKm: number | null;
  description: string | null;
  nextServiceDueOn: string | null;
};

type Vehicle = {
  plate: string;
  make: string;
  model: string;
  variant: string | null;
  year: number | null;
  colour: string | null;
  vin: string | null;
  engineNumber: string | null;
  vehicleType: string;
  fuelType: string;
  rucRequired: boolean;
  odometerKm: number | null;
  odometerAt: string | null;
  wofExpiresOn: string | null;
  regoExpiresOn: string | null;
  nextServiceDueOn: string | null;
  fbtNotes: string | null;
  notes: string;
  assignments: Assignment[];
  services: Service[];
};

/** Boilerplate for a driver whose start date the register never captured. */
const UNDATED_START =
  "Start date not recorded in the register (shown as '?'). Dated from the register's " +
  "last-updated date, 30 Jul 2026 — the day we know they held it, not the day they got it.";

const VEHICLES: Vehicle[] = [
  {
    plate: "QLP12",
    make: "Toyota",
    model: "Aqua",
    variant: null,
    year: 2014,
    colour: "White",
    vin: "7AT0H65YX22295359",
    engineNumber: "1NZ-7011293",
    vehicleType: "car",
    fuelType: "hybrid", // The Aqua is sold only as a hybrid — a fact about the model.
    rucRequired: false, // Petrol-hybrid: pays through fuel excise, buys no RUC licence.
    odometerKm: 124402,
    odometerAt: REGISTER_DATE,
    wofExpiresOn: "2027-07-31",
    regoExpiresOn: "2027-01-25",
    nextServiceDueOn: null,
    fbtNotes: null,
    notes:
      "White hatchback. Chassis NHP10-2295359.\n" +
      "Odometer 124,402 km is the driver's start reading — the register recorded no separate " +
      "current reading and gave no reading date, so it is dated 30 Jul 2026 (the register's own " +
      "last-updated date).\n" +
      "No service history recorded in the register.",
    assignments: [
      {
        holderName: "Ryan Edwards",
        licenceExpiresOn: "2027-06-08",
        assignedOn: REGISTER_DATE,
        returnedOn: null,
        odometerStartKm: 124402,
        odometerEndKm: null,
        notes: `Licence #DF403974. Vehicle Use Agreement signed. ${UNDATED_START}`,
      },
    ],
    services: [],
  },

  {
    plate: "PRK235",
    make: "Mitsubishi",
    model: "Outlander",
    variant: null,
    year: 2014,
    colour: "Grey",
    vin: "7AT0CJ3MX22014096",
    engineNumber: "4B11 MY2022",
    vehicleType: "car",
    fuelType: "petrol", // Schema default — see the flag in notes.
    rucRequired: false,
    odometerKm: null,
    odometerAt: null,
    wofExpiresOn: "2027-08-01",
    regoExpiresOn: "2027-06-01",
    nextServiceDueOn: "2027-02-01",
    fbtNotes: null,
    notes:
      "Grey station wagon. Chassis GG2W-0014096.\n" +
      "⚠ Fuel type not recorded in the register. The 4B11 engine appears in BOTH the petrol " +
      "Outlander and the plug-in hybrid. Left as petrol. If it is a PHEV it owes RUC, and the " +
      "RUC badge on this page is wrong until someone confirms which it is.\n" +
      "No odometer reading recorded anywhere in the register.",
    assignments: [
      {
        holderName: "Paul Holocher",
        licenceExpiresOn: null,
        assignedOn: REGISTER_DATE,
        returnedOn: null,
        odometerStartKm: null,
        odometerEndKm: null,
        notes: `Licence #ED525442 — expiry date not recorded. Vehicle Use Agreement signed. ${UNDATED_START}`,
      },
    ],
    services: [
      {
        servicedOn: "2026-07-31",
        odometerKm: null,
        description: "Recorded in the register as the last service. No provider, cost or odometer captured.",
        nextServiceDueOn: "2027-02-01",
      },
    ],
  },

  {
    plate: "MML178",
    make: "Toyota",
    model: "Hiace",
    variant: "Club Van",
    year: 2016,
    colour: "Silver",
    vin: "7AT0H60FX19016270",
    engineNumber: "2TR 9070299",
    vehicleType: "minibus",
    // 2TR-FE is the 2.7-litre petrol — the engine number in the register settles this.
    fuelType: "petrol",
    rucRequired: false,
    odometerKm: 125808,
    odometerAt: REGISTER_DATE,
    // The register records a WOF, not a COF. A club van moving its own team is
    // generally not a passenger service vehicle; that call is the club's, and
    // the register has already made it.
    wofExpiresOn: "2026-06-27",
    regoExpiresOn: "2027-05-03",
    nextServiceDueOn: null,
    fbtNotes: null,
    notes:
      "Silver minibus. Chassis TRH224-0016270.\n" +
      "🔴 WOF EXPIRED 27 Jun 2026. The register's own legend says a WOF must be current before " +
      "any vehicle use, and the van changed drivers on 30 Jul 2026 — a month after it lapsed.\n" +
      "Odometer 125,808 km is well evidenced: it is both the reading the previous driver handed " +
      "over on and the reading the new driver took it on.\n" +
      "No service history recorded in the register.",
    assignments: [
      {
        holderName: "Samuel Mahlamaki",
        licenceExpiresOn: null,
        assignedOn: "2026-07-29",
        returnedOn: "2026-07-29",
        odometerStartKm: null,
        odometerEndKm: 125808,
        notes:
          "Held the van until 29 Jul 2026, when it passed to Travis Graham at 125,808 km. " +
          "Start date not recorded in the register ('?'), so this assignment is dated from his " +
          "last day rather than inventing a start — the length of this row means nothing. " +
          "No licence number recorded. Vehicle Use Agreement signed.",
      },
      {
        holderName: "Travis Graham",
        licenceExpiresOn: "2027-01-11",
        assignedOn: "2026-07-30",
        returnedOn: null,
        odometerStartKm: 125808,
        odometerEndKm: null,
        notes:
          "Licence #20340010WM12 — not an NZ-format licence number. If this is an overseas " +
          "licence, New Zealand's 12-month entitlement applies and it is worth checking against " +
          "the club's motor policy. Vehicle Use Agreement signed. Took the van on 30 Jul 2026 " +
          "at 125,808 km (a real handover date, unlike the rest of this fleet).",
      },
    ],
    services: [],
  },

  {
    plate: "FWC150",
    make: "Toyota",
    model: "Hilux",
    variant: null,
    year: null,
    colour: null,
    vin: null,
    engineNumber: null,
    vehicleType: "ute",
    fuelType: "petrol", // Schema default — see the flag in notes.
    rucRequired: false,
    odometerKm: 240000,
    odometerAt: REGISTER_DATE,
    wofExpiresOn: "2027-08-21",
    regoExpiresOn: "2026-08-22",
    // Deliberately NULL. The register says 27/06/26, which is BEFORE the 1 Jul
    // 2026 service it supposedly follows — a stale figure. Writing it would
    // paint a red "service overdue" badge on a vehicle that was serviced last
    // month, and a badge that cries wolf gets ignored. The raw value is kept in
    // the notes and in the service record below.
    nextServiceDueOn: null,
    fbtNotes: null,
    notes:
      "⚠ Fuel type not recorded in the register. A Hilux is commonly diesel — and a diesel owes " +
      "RUC, which nothing in the register mentions. Left as petrol, so the RUC badge currently " +
      "reads 'not required'. Confirm the fuel type before trusting it.\n" +
      "⚠ The register's next-service date (27/06/26) falls BEFORE the 1 Jul 2026 service it " +
      "follows, so it is a stale figure. Left blank here rather than shown as overdue — set the " +
      "real next-service date.\n" +
      "🔴 No signed Vehicle Use Agreement on file for the driver. This is the only vehicle in " +
      "the register without one, and the register's own legend requires it of every driver.\n" +
      "Odometer 240,000 km carries no reading date in the register and is suspiciously round; " +
      "dated 30 Jul 2026 from the register's last-updated date.\n" +
      "No year, VIN, engine or chassis number recorded.",
    assignments: [
      {
        holderName: "Dimitri Kochnev",
        licenceExpiresOn: "2031-06-26",
        assignedOn: REGISTER_DATE,
        returnedOn: null,
        odometerStartKm: null,
        odometerEndKm: null,
        notes:
          "Licence #9924206171 — not an NZ-format licence number; if it is an overseas licence, " +
          "the 12-month entitlement applies. 🔴 NO signed Vehicle Use Agreement on file. " +
          `${UNDATED_START}`,
      },
    ],
    services: [
      {
        servicedOn: "2026-07-01",
        odometerKm: null,
        description:
          "Recorded in the register as the last service. The register's next-service date " +
          "(27/06/26) predates this service and has not been carried onto the vehicle.",
        nextServiceDueOn: null,
      },
    ],
  },

  {
    plate: "NCN360",
    make: "Toyota",
    model: "Aqua",
    variant: null,
    year: null,
    colour: null,
    vin: null,
    engineNumber: null,
    vehicleType: "car",
    fuelType: "hybrid",
    rucRequired: false,
    odometerKm: null,
    odometerAt: null,
    wofExpiresOn: "2026-12-27",
    regoExpiresOn: "2026-07-15",
    nextServiceDueOn: "2026-12-24",
    fbtNotes: null,
    notes:
      "🔴 Rego EXPIRED 15 Jul 2026.\n" +
      "No odometer reading, year, VIN, engine or chassis number recorded in the register.",
    assignments: [
      {
        holderName: "Adria Casals",
        licenceExpiresOn: "2027-08-31",
        assignedOn: REGISTER_DATE,
        returnedOn: null,
        odometerStartKm: null,
        odometerEndKm: null,
        notes: `Licence #DU715282. Vehicle Use Agreement signed. ${UNDATED_START}`,
      },
    ],
    services: [
      {
        servicedOn: "2025-12-24",
        odometerKm: null,
        description: "Recorded in the register as the last service. No provider, cost or odometer captured.",
        nextServiceDueOn: "2026-12-24",
      },
    ],
  },

  {
    plate: "RPN394",
    make: "Toyota",
    model: "Prius",
    variant: null,
    year: null,
    colour: null,
    vin: null,
    engineNumber: null,
    vehicleType: "car",
    fuelType: "hybrid",
    rucRequired: false,
    // The one genuinely dated reading in the whole register.
    odometerKm: 133250,
    odometerAt: "2026-01-29",
    wofExpiresOn: "2026-11-30",
    regoExpiresOn: "2026-07-11",
    nextServiceDueOn: null,
    fbtNotes:
      "The register records this as a staff vehicle garaged at the driver's home address " +
      "(78 Nottingham Ave, Halswell). In New Zealand it is AVAILABILITY for private use, not " +
      "actual private use, that attracts FBT. Position recorded here, not adjudicated — Victor " +
      "to confirm the club's FBT treatment and whether any work-related-vehicle exemption is " +
      "being claimed.",
    notes:
      "🔴 Rego EXPIRED 11 Jul 2026.\n" +
      "Staff vehicle (Albert Riera Vidal). Parked at 78 Nottingham Ave, Halswell.\n" +
      "At the 29 Jan 2026 inspection: very small windshield chips noted; no first aid kit and no " +
      "fire extinguisher on board. Both still outstanding as far as the register shows.\n" +
      "Odometer 133,250 km read 29 Jan 2026 — the only reading in the register with a real date " +
      "against it, and now over six months old.",
    assignments: [
      {
        holderName: "Albert Riera Vidal",
        licenceExpiresOn: "2035-10-23",
        assignedOn: REGISTER_DATE,
        returnedOn: null,
        odometerStartKm: null,
        odometerEndKm: null,
        notes: `Licence #DR719352. Vehicle Use Agreement signed. ${UNDATED_START}`,
      },
    ],
    services: [
      {
        servicedOn: "2026-01-29",
        odometerKm: 133250,
        description:
          "Recorded in the register as the last service; the notes describe it as an inspection. " +
          "Findings: very small windshield chips; no first aid kit or fire extinguisher on board.",
        nextServiceDueOn: null,
      },
    ],
  },
];

async function main() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  console.log(`\n  CUFC vehicle register → ClubOS Vehicles (United Sports Group, org ${ORG_ID})`);
  console.log(`  ${COMMIT ? "COMMIT — writing to the live database" : "DRY RUN — rolled back at the end"}\n`);

  await client.query("BEGIN");
  try {
    const org = await client.query(`select name from organizations where id = $1`, [ORG_ID]);
    if (!org.rowCount) throw new Error(`Organization ${ORG_ID} does not exist`);
    console.log(`  Workspace: ${org.rows[0].name}\n`);

    let created = 0;
    let skipped = 0;
    let assignmentsCreated = 0;
    let servicesCreated = 0;

    for (const v of VEHICLES) {
      const existing = await client.query(
        `select id from fleet_vehicles
          where organization_id = $1 and upper(plate) = upper($2) and status <> 'disposed'`,
        [ORG_ID, v.plate],
      );

      let vehicleId: number;
      if (existing.rowCount) {
        vehicleId = existing.rows[0].id;
        skipped++;
        console.log(`  = ${v.plate.padEnd(8)} ${v.make} ${v.model} — already present (#${vehicleId}), left untouched`);
      } else {
        const ins = await client.query(
          `insert into fleet_vehicles
             (organization_id, plate, make, model, variant, year, colour, vin, engine_number,
              vehicle_type, fuel_type, odometer_km, odometer_at, compliance_type,
              wof_expires_on, rego_expires_on, ruc_required, ownership, status,
              next_service_due_on, fbt_private_use, fbt_exemption, fbt_notes, notes, created_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'wof',$14,$15,$16,'owned','active',
                   $17,false,'none',$18,$19,$20)
           returning id`,
          [
            ORG_ID, v.plate, v.make, v.model, v.variant, v.year, v.colour, v.vin, v.engineNumber,
            v.vehicleType, v.fuelType, v.odometerKm, v.odometerAt,
            v.wofExpiresOn, v.regoExpiresOn, v.rucRequired,
            v.nextServiceDueOn, v.fbtNotes, v.notes, CREATED_BY,
          ],
        );
        vehicleId = ins.rows[0].id;
        created++;
        console.log(`  + ${v.plate.padEnd(8)} ${v.make} ${v.model}${v.variant ? ` ${v.variant}` : ""} → #${vehicleId}`);
      }

      for (const a of v.assignments) {
        const dupe = await client.query(
          `select id from fleet_assignments
            where vehicle_id = $1 and holder_name = $2 and assigned_on = $3`,
          [vehicleId, a.holderName, a.assignedOn],
        );
        if (dupe.rowCount) {
          console.log(`      = ${a.holderName} — assignment already present`);
          continue;
        }
        await client.query(
          `insert into fleet_assignments
             (organization_id, vehicle_id, holder_name, licence_expires_on, assigned_on,
              returned_on, odometer_start_km, odometer_end_km, notes, created_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            ORG_ID, vehicleId, a.holderName, a.licenceExpiresOn, a.assignedOn,
            a.returnedOn, a.odometerStartKm, a.odometerEndKm, a.notes, CREATED_BY,
          ],
        );
        assignmentsCreated++;
        console.log(`      + ${a.holderName}${a.returnedOn ? ` (returned ${a.returnedOn})` : " (current)"}`);
      }

      for (const s of v.services) {
        const dupe = await client.query(
          `select id from fleet_service_records where vehicle_id = $1 and serviced_on = $2`,
          [vehicleId, s.servicedOn],
        );
        if (dupe.rowCount) {
          console.log(`      = service ${s.servicedOn} — already present`);
          continue;
        }
        await client.query(
          `insert into fleet_service_records
             (organization_id, vehicle_id, serviced_on, service_type, odometer_km,
              description, next_service_due_on, created_by)
           values ($1,$2,$3,'service',$4,$5,$6,$7)`,
          [ORG_ID, vehicleId, s.servicedOn, s.odometerKm, s.description, s.nextServiceDueOn, CREATED_BY],
        );
        servicesCreated++;
        console.log(`      + service ${s.servicedOn}`);
      }
    }

    // ── Verify inside the transaction, before anything is made permanent ─────
    const counts = await client.query(
      `select
         (select count(*)::int from fleet_vehicles  where organization_id = $1 and status <> 'disposed') as vehicles,
         (select count(*)::int from fleet_assignments where organization_id = $1) as assignments,
         (select count(*)::int from fleet_assignments where organization_id = $1 and returned_on is null) as open_assignments,
         (select count(*)::int from fleet_service_records where organization_id = $1) as services,
         (select count(*)::int from fleet_insurance_policies where organization_id = $1) as policies`,
      [ORG_ID],
    );
    const c = counts.rows[0];

    const problems: string[] = [];
    if (c.vehicles !== 6) problems.push(`expected 6 live vehicles, found ${c.vehicles}`);
    if (c.assignments !== 7) problems.push(`expected 7 assignments, found ${c.assignments}`);
    if (c.open_assignments !== 6) problems.push(`expected 6 current drivers, found ${c.open_assignments}`);
    if (c.services !== 4) problems.push(`expected 4 service records, found ${c.services}`);
    if (c.policies !== 0) problems.push(`expected 0 insurance policies, found ${c.policies}`);

    // Every vehicle must have exactly one person holding it right now.
    const unheld = await client.query(
      `select v.plate from fleet_vehicles v
        where v.organization_id = $1 and v.status <> 'disposed'
          and not exists (select 1 from fleet_assignments a
                           where a.vehicle_id = v.id and a.returned_on is null)`,
      [ORG_ID],
    );
    for (const r of unheld.rows) problems.push(`${r.plate} has no current driver`);

    console.log(
      `\n  ${c.vehicles} vehicles · ${c.assignments} assignments (${c.open_assignments} current) · ` +
        `${c.services} services · ${c.policies} insurance policies`,
    );

    if (problems.length) {
      console.error("\n  VERIFICATION FAILED:");
      for (const p of problems) console.error(`    ✗ ${p}`);
      throw new Error("verification failed — rolling back");
    }
    console.log("  ✓ verification passed");

    if (COMMIT) {
      await client.query("COMMIT");
      console.log(`\n  Committed. ${created} vehicles created, ${skipped} already present, ` +
        `${assignmentsCreated} assignments, ${servicesCreated} services.\n`);
    } else {
      await client.query("ROLLBACK");
      console.log("\n  Rolled back (dry run). Re-run with --commit to write.\n");
    }
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(`\n  FAILED: ${e.message}\n`);
  process.exit(1);
});
