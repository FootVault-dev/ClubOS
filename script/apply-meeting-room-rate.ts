/**
 * Publish the United Sports Centre meeting room on book.unitedsportscentre.com
 * at $25.00 per hour.
 *
 * WHY $25. Daniel, ClubOS DM to Travis, 18 Aug 2026, answering "what is the cost
 * for hiring out the meeting room?": "We currently don't have one but we need to
 * establish one, I would say $25/hour is fair and it's in line with the market
 * rate in Christchurch for example if you were to book at the library."
 * Confirmed as the rate on 21 Aug. It is a NEW rate being established, not a
 * published one being applied — the row currently holds $0.00.
 *
 * WHAT CHANGES, and why each one:
 *   · price_per_hour_cents  0 → 2500. With NO rows in facility_pricing_rules for
 *     this facility, calcItemPriceCents() falls through to the facility's own
 *     price_per_hour_cents, so a flat $25/hr applies at every hour of every day.
 *     That is exactly "$25/h" and needs no rules, no peak/off-peak split.
 *   · public_visible        false → true. This is the actual publishing step.
 *   · type                  "field" → "meeting_room". The booking page maps type
 *     to a label ("field" renders as "Field"), so leaving it would advertise the
 *     meeting room as a Field the moment it went public. `meeting_room` is
 *     already in the client's FacilityType union — nothing new is invented.
 *   · description           it currently reads "Internal meeting room — not
 *     publicly bookable", which becomes a false statement on a public page.
 *
 * 🔴 half_full is already false and there are no half/quarter prices, so no
 * part-of-a-pitch controls can appear. Left untouched deliberately.
 *
 * Rates on this venue are GST-INCLUSIVE — the booking page prints "Includes 15%
 * GST" against its cart total — so $25.00 is what the hirer pays per hour.
 *
 * Dry run by default. Pass --commit to write.
 */
import pg from "pg";

const COMMIT = process.argv.includes("--commit");
const FACILITY_ID = 5; // Meeting Room, organization_id 4 (United Sports Centre)

const NEW = {
  pricePerHourCents: 2500,
  publicVisible: true,
  type: "meeting_room",
  description: "Meeting room with screen. Hired by the hour.",
};

async function main() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  // The transaction is controlled HERE, not inside the SQL — a statement that
  // carries its own COMMIT would end the transaction and leave the rollback
  // running in autocommit, which is the hole 14 migrations in this repo still have.
  await client.query("BEGIN");
  try {
    const before = await client.query(
      `SELECT id, organization_id, name, type, description, public_visible,
              price_per_hour_cents, half_full, display_order
         FROM facilities WHERE id = $1`,
      [FACILITY_ID],
    );
    if (before.rowCount !== 1) throw new Error(`facility ${FACILITY_ID} not found`);
    const b = before.rows[0];
    if (b.organization_id !== 4) {
      throw new Error(`facility ${FACILITY_ID} is org ${b.organization_id}, expected 4 (USC)`);
    }
    console.log("BEFORE:", JSON.stringify(b, null, 2));

    const after = await client.query(
      `UPDATE facilities
          SET price_per_hour_cents = $2,
              public_visible       = $3,
              type                 = $4,
              description          = $5
        WHERE id = $1
      RETURNING id, name, type, description, public_visible, price_per_hour_cents`,
      [FACILITY_ID, NEW.pricePerHourCents, NEW.publicVisible, NEW.type, NEW.description],
    );
    console.log("AFTER :", JSON.stringify(after.rows[0], null, 2));

    // Assert the thing we actually care about rather than trusting the UPDATE.
    const a = after.rows[0];
    const checks: [string, boolean][] = [
      ["price is $25.00/hr", a.price_per_hour_cents === 2500],
      ["publicly visible", a.public_visible === true],
      ["typed as meeting_room", a.type === "meeting_room"],
      ["description no longer says 'not publicly bookable'", !/not publicly bookable/i.test(a.description ?? "")],
    ];
    // No pricing rules must exist, or they would override the flat rate.
    const rules = await client.query(
      `SELECT count(*)::int AS n FROM facility_pricing_rules WHERE facility_id = $1`,
      [FACILITY_ID],
    );
    checks.push(["no pricing rules override the flat rate", rules.rows[0].n === 0]);

    let ok = true;
    for (const [label, pass] of checks) {
      console.log(`${pass ? "  ok " : "  FAIL"} ${label}`);
      if (!pass) ok = false;
    }
    if (!ok) throw new Error("verification failed");

    if (COMMIT) {
      await client.query("COMMIT");
      console.log("\nCOMMITTED — the meeting room is live at $25.00/hr.");
    } else {
      await client.query("ROLLBACK");
      console.log("\nDRY RUN — rolled back. Re-run with --commit to apply.");
    }
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
