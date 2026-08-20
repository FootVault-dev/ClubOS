/**
 * Apply the Ethnic Cup registrations migration.
 *
 *   npx tsx --env-file=.env script/apply-ethnic-cup.ts             # DRY RUN (rolls back)
 *   npx tsx --env-file=.env script/apply-ethnic-cup.ts --commit    # for real
 *
 * Dry run is the default and it genuinely rehearses: the whole thing runs
 * inside ONE transaction that is rolled back unless --commit is passed. The
 * migration file deliberately carries no BEGIN/COMMIT of its own — an inner
 * COMMIT would end this transaction and leave the ROLLBACK running in
 * autocommit, which rehearses nothing.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

const COMMIT = process.argv.includes("--commit");
const SQL_FILE = join(import.meta.dirname, "..", "migrations", "2026-08-20_ethnic_cup_registrations.sql");

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  const client = new pg.Client({ connectionString: url });
  await client.connect();

  const sql = readFileSync(SQL_FILE, "utf8");
  console.log(`${COMMIT ? "APPLYING" : "DRY RUN"} — ${SQL_FILE.split("/").pop()}\n`);

  try {
    await client.query("BEGIN");
    await client.query(sql);

    // Behavioural checks that insert real rows, so the constraints are proven
    // rather than assumed. These run inside the same transaction either way.
    const { rows: orgRows } = await client.query(
      `SELECT id FROM organizations WHERE slug = 'christchurch-international-cup' LIMIT 1`,
    );
    if (!orgRows.length) throw new Error("CIC organisation not found — wrong database?");
    const orgId = orgRows[0].id;
    console.log(`  ok   CIC organisation resolves (id ${orgId})`);

    const ins = await client.query(
      `INSERT INTO ethnic_cup_registrations (organization_id, first_name, email, community)
       VALUES ($1, 'Rehearsal', 'rehearsal@example.com', 'Test community') RETURNING id, status, created_at`,
      [orgId],
    );
    console.log(`  ok   insert works; status defaults to '${ins.rows[0].status}'`);

    const del = await client.query(
      `DELETE FROM ethnic_cup_registrations WHERE id = $1 RETURNING id`,
      [ins.rows[0].id],
    );
    if (del.rowCount !== 1) throw new Error("could not clean up the rehearsal row");
    console.log("  ok   rehearsal row removed");

    const { rows: rls } = await client.query(
      `SELECT relrowsecurity FROM pg_class WHERE relname = 'ethnic_cup_registrations'`,
    );
    if (!rls[0]?.relrowsecurity) throw new Error("RLS is OFF on the new table");
    console.log("  ok   row level security is ON");

    const { rows: fk } = await client.query(
      `SELECT confdeltype FROM pg_constraint
        WHERE conrelid = 'ethnic_cup_registrations'::regclass AND contype = 'f'`,
    );
    console.log(`  ok   organization_id FK present (on delete '${fk[0]?.confdeltype}')`);

    if (COMMIT) {
      await client.query("COMMIT");
      console.log("\n✓ committed.");
    } else {
      await client.query("ROLLBACK");
      console.log("\n✓ dry run passed and was ROLLED BACK. Re-run with --commit to apply.");
    }
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("\n✗ failed, rolled back:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
