// Apply migrations/2026-08-26_coding_budget.sql, rehearsing it first.
//
//   npx tsx --env-file=.env script/apply-coding-budget.ts            (dry run)
//   npx tsx --env-file=.env script/apply-coding-budget.ts --commit
//
// There is no local Postgres, so a dry run is the only rehearsal available: it
// runs the real DDL and the real verification inside a transaction it then rolls
// back. Additive and idempotent.
//
// The behavioural checks are the point. Three invariants are the reason this is
// a pair of tables rather than a spreadsheet, and each is proven by inserting a
// row that MUST be refused:
//
//   1. A transaction cannot be coded to a control row  (the double-count)
//   2. A transaction cannot be coded to a reserved code (codes 14–20)
//   3. The same external id cannot be imported twice    (the retry)
//
// Plus one that must be ACCEPTED and is easy to get wrong: a budget of NULL,
// which has to stay distinguishable from a budget of zero.
import { readFileSync } from "fs";
import { join } from "path";
import pg from "pg";

const COMMIT = process.argv.includes("--commit");
const ORG_ID = 7; // United Sports Group

async function main() {
  const sql = readFileSync(
    join(process.cwd(), "migrations", "2026-08-26_coding_budget.sql"), "utf8");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  console.log(`\n  coding_accounts + coding_transactions — ${COMMIT ? "COMMIT" : "DRY RUN (rolled back)"}\n`);
  await client.query("BEGIN");
  const problems: string[] = [];

  try {
    await client.query(sql);
    console.log("  migration ran");

    for (const table of ["coding_accounts", "coding_transactions"]) {
      const t = await client.query(
        `select 1 from information_schema.tables where table_name = $1`, [table]);
      if (!t.rowCount) problems.push(`${table} was not created`);
    }

    // Money is an integer number of cents, never a float.
    for (const [table, col] of [
      ["coding_accounts", "budget_excl_cents"],
      ["coding_transactions", "amount_excl_cents"],
      ["coding_transactions", "amount_incl_cents"],
    ]) {
      const r = await client.query(
        `select data_type from information_schema.columns
          where table_name = $1 and column_name = $2`, [table, col]);
      if (r.rows[0]?.data_type !== "integer") {
        problems.push(`${table}.${col} is ${r.rows[0]?.data_type ?? "missing"}, expected integer`);
      }
    }

    // A budget column must have NO default — a default of 0 would erase the
    // difference between "not budgeted" and "budgeted at nil".
    const dflt = await client.query(
      `select column_default, is_nullable from information_schema.columns
        where table_name = 'coding_accounts' and column_name = 'budget_excl_cents'`);
    if (dflt.rows[0]?.column_default != null) {
      problems.push(`budget_excl_cents has a default (${dflt.rows[0].column_default}) — NULL must stay distinct from 0`);
    }
    if (dflt.rows[0]?.is_nullable !== "YES") {
      problems.push("budget_excl_cents is NOT NULL — an unbudgeted line has no figure");
    }

    // ── Fixtures. One postable code, one control row, one reserved code.
    const mk = async (code: string, treatment: string, name: string) => {
      const r = await client.query(
        `insert into coding_accounts
           (organization_id, code, top_code, depth, name, kind, treatment)
         values ($1,$2,$3,$4,$5,'income',$6) returning id, postable`,
        [ORG_ID, code, code.split("-")[0], code.split("-").length, name, treatment]);
      return r.rows[0];
    };
    const entry    = await mk("ZZ-01", "entry",    "probe entry line");
    const control  = await mk("ZZ",    "subtotal", "probe control row");
    const reserved = await mk("ZZ-02", "reserved", "probe reserved code");

    if (entry.postable !== true)    problems.push("an 'entry' account came back not postable");
    if (control.postable !== false) problems.push("a 'subtotal' account came back POSTABLE — the whole guard is off");
    if (reserved.postable !== false) problems.push("a 'reserved' account came back POSTABLE");

    // ── Each of these must be refused. A SAVEPOINT per attempt, because a
    //    failed statement poisons the whole transaction otherwise.
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
    const accepts = async (label: string, statement: string, params: any[]) => {
      await client.query("SAVEPOINT probe");
      try {
        const r = await client.query(statement, params);
        await client.query("RELEASE SAVEPOINT probe");
        console.log(`  ✓ accepted: ${label}`);
        return r;
      } catch (e: any) {
        await client.query("ROLLBACK TO SAVEPOINT probe");
        problems.push(`${label} was REFUSED — ${e.message}`);
        return null;
      }
    };

    const insertTxn =
      `insert into coding_transactions
         (organization_id, coding_account_id, occurred_on, amount_excl_cents, gst_cents, source, external_id)
       values ($1,$2,'2026-08-26',$3,$4,$5,$6)`;

    await refuses("a transaction coded to a CONTROL ROW",
      insertTxn, [ORG_ID, control.id, 10000, 1500, "manual", null]);
    await refuses("a transaction coded to a RESERVED code",
      insertTxn, [ORG_ID, reserved.id, 10000, 1500, "manual", null]);
    await refuses("a duplicate code within one organisation",
      `insert into coding_accounts (organization_id, code, top_code, depth, name, kind, treatment)
       values ($1,'ZZ-01','ZZ',2,'clash','income','entry')`, [ORG_ID]);

    // The retry. First import lands, the identical second one must not.
    const first = await accepts("an imported transaction with an external id",
      insertTxn, [ORG_ID, entry.id, 10000, 1500, "xero", "INV-PROBE-1"]);
    if (first) {
      await refuses("the SAME external id imported a second time",
        insertTxn, [ORG_ID, entry.id, 10000, 1500, "xero", "INV-PROBE-1"]);
      // ...but the same id from a DIFFERENT source is a different fact.
      await accepts("the same id from a different source",
        insertTxn, [ORG_ID, entry.id, 10000, 1500, "clubos", "INV-PROBE-1"]);
    }

    // Two hand-entered lines, identical, same day — two real transactions.
    await accepts("a second identical MANUAL line (no external id)",
      insertTxn, [ORG_ID, entry.id, 10000, 1500, "manual", null]);

    // The derived total must be exactly the sum of its parts.
    const total = await client.query(
      `select amount_excl_cents, gst_cents, amount_incl_cents
         from coding_transactions where coding_account_id = $1 limit 1`, [entry.id]);
    const t = total.rows[0];
    if (t && t.amount_incl_cents !== t.amount_excl_cents + t.gst_cents) {
      problems.push(`amount_incl_cents (${t.amount_incl_cents}) is not excl + gst`);
    } else if (t) {
      console.log(`  ✓ derived: ${t.amount_excl_cents} + ${t.gst_cents} = ${t.amount_incl_cents}`);
    }

    // A parent with children cannot be deleted out from under them.
    await client.query(
      `update coding_accounts set parent_id = $1 where id = $2`, [control.id, entry.id]);
    await refuses("deleting a parent that still has children",
      `delete from coding_accounts where id = $1`, [control.id]);

    // RLS on, both tables.
    const rls = await client.query(
      `select relname, relrowsecurity from pg_class
        where relname in ('coding_accounts','coding_transactions')`);
    for (const r of rls.rows) {
      if (!r.relrowsecurity) problems.push(`${r.relname} has RLS disabled`);
    }
    if (rls.rows.length === 2 && rls.rows.every(r => r.relrowsecurity)) {
      console.log("  ✓ RLS enabled on both tables");
    }

    // Clean the probes up before committing for real.
    await client.query(`delete from coding_transactions where coding_account_id = any($1)`,
      [[entry.id, control.id, reserved.id]]);
    await client.query(`update coding_accounts set parent_id = null where id = $1`, [entry.id]);
    await client.query(`delete from coding_accounts where id = any($1)`,
      [[entry.id, control.id, reserved.id]]);

    if (problems.length) {
      console.log(`\n  ${problems.length} PROBLEM(S):`);
      for (const p of problems) console.log(`    ✗ ${p}`);
      await client.query("ROLLBACK");
      console.log("\n  rolled back — nothing changed.\n");
      process.exit(1);
    }

    if (COMMIT) {
      await client.query("COMMIT");
      console.log("\n  ✓ committed. Now seed it:  npx tsx --env-file=.env script/seed-coding-budget.ts --commit\n");
    } else {
      await client.query("ROLLBACK");
      console.log("\n  ✓ all checks passed — rolled back. Re-run with --commit to apply.\n");
    }
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
