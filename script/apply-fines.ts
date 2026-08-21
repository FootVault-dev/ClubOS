// Apply migrations/2026-08-21_fines.sql, rehearsing it first.
//
//   npx tsx --env-file=.env script/apply-fines.ts             (dry run)
//   npx tsx --env-file=.env script/apply-fines.ts --commit
//
// There is no local Postgres, so a dry run is the only rehearsal available: it
// runs the real DDL and the real verification inside a transaction it then
// rolls back. Additive and idempotent.
//
// The behavioural checks matter more than the structural ones here. Three
// invariants are the reason this table is worth having rather than a
// spreadsheet, so each is proven by inserting a row that must be refused:
// the same notice number cannot be logged twice, a fine cannot be both paid
// and waived, and an amount cannot be negative.
import { readFileSync } from "fs";
import { join } from "path";
import pg from "pg";

const COMMIT = process.argv.includes("--commit");
const ORG_ID = 7; // United Sports Group

async function main() {
  const sql = readFileSync(join(process.cwd(), "migrations", "2026-08-21_fines.sql"), "utf8");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  console.log(`\n  fines + fine_attachments — ${COMMIT ? "COMMIT" : "DRY RUN (rolled back)"}\n`);
  await client.query("BEGIN");
  const problems: string[] = [];
  try {
    await client.query(sql);
    console.log("  migration ran");

    for (const table of ["fines", "fine_attachments"]) {
      const t = await client.query(
        `select 1 from information_schema.tables where table_name = $1`, [table]);
      if (!t.rowCount) problems.push(`${table} was not created`);
    }

    // Money must be an integer number of cents, never a float.
    const amount = await client.query(
      `select data_type from information_schema.columns
        where table_name = 'fines' and column_name = 'amount_cents'`);
    if (amount.rows[0]?.data_type !== "integer") {
      problems.push(`amount_cents is ${amount.rows[0]?.data_type}, expected integer`);
    }

    // ── Behavioural checks. Each deliberately violates an invariant and must
    //    be refused. A SAVEPOINT per attempt, because a failed statement
    //    poisons the whole transaction otherwise — that exact trap produced a
    //    baffling "relation does not exist" in the staff-voice rehearsal.
    const refuses = async (label: string, statement: string, params: any[]) => {
      await client.query("SAVEPOINT probe");
      try {
        await client.query(statement, params);
        problems.push(`${label} was ACCEPTED — it must be refused`);
        await client.query("ROLLBACK TO SAVEPOINT probe");
      } catch {
        await client.query("ROLLBACK TO SAVEPOINT probe");
        console.log(`  ✓ refused: ${label}`);
      }
    };

    const insert = `insert into fines (organization_id, direction, category, counterparty, amount_cents, reference, paid_on, waived_on)
                    values ($1,$2,$3,$4,$5,$6,$7,$8)`;

    // Seed one real row to collide with, then prove each refusal.
    await client.query(insert, [ORG_ID, "club_owes", "parking", "Probe Council", 1000, "PROBE-REF-1", null, null]);

    await refuses("the same notice number twice",
      insert, [ORG_ID, "club_owes", "parking", "Probe Council", 2000, "probe-ref-1", null, null]);
    await refuses("a fine that is both paid and waived",
      insert, [ORG_ID, "club_owes", "parking", "Probe", 1000, "PROBE-REF-2", "2026-08-01", "2026-08-02"]);
    await refuses("a negative amount",
      insert, [ORG_ID, "club_owes", "parking", "Probe", -100, "PROBE-REF-3", null, null]);

    // And prove the things that MUST be allowed still are: two fines with no
    // reference at all (the partial index must not treat NULLs as equal), and
    // a fine paid after its due date, which is paid — not overdue.
    await client.query(insert, [ORG_ID, "club_owes", "parking", "No ref A", 1000, null, null, null]);
    await client.query(insert, [ORG_ID, "owed_to_club", "disciplinary", "No ref B", 1000, null, null, null]);
    console.log("  ✓ allowed: two fines with no reference number");

    const paidLate = await client.query(
      `insert into fines (organization_id, direction, category, counterparty, amount_cents, due_on, paid_on)
       values ($1,'club_owes','parking','Paid late',1000,'2026-01-01','2026-03-01') returning id`, [ORG_ID]);
    if (!paidLate.rowCount) problems.push("a fine paid after its due date was refused");
    else console.log("  ✓ allowed: a fine paid after its due date");

    // Everything above was a probe. Nothing may survive, even on --commit.
    await client.query(`delete from fines where organization_id = $1 and counterparty like 'Probe%' or counterparty in ('No ref A','No ref B','Paid late')`, [ORG_ID]);
    const left = await client.query(`select count(*)::int n from fines`);
    if (left.rows[0].n !== 0) problems.push(`${left.rows[0].n} probe rows survived — the table must be left empty`);
    console.log(`  ${left.rows[0].n} rows in fines (probes cleaned up)`);

    if (problems.length) {
      for (const p of problems) console.error(`    ✗ ${p}`);
      throw new Error("verification failed");
    }
    console.log("  ✓ verification passed");

    if (COMMIT) {
      await client.query("COMMIT");
      console.log("\n  Committed.\n");
    } else {
      await client.query("ROLLBACK");
      console.log("\n  Rolled back (dry run). Re-run with --commit.\n");
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
