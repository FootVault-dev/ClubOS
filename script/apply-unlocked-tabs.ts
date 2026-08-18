// Apply migrations/2026-08-18_unlocked_tabs.sql, rehearsing it first.
//
//   npx tsx --env-file=.env script/apply-unlocked-tabs.ts             (dry run)
//   npx tsx --env-file=.env script/apply-unlocked-tabs.ts --commit
//
// There is no local Postgres, so a dry run is the only rehearsal available: it
// runs the real DDL and the real verification inside a transaction it then
// rolls back. Additive and idempotent — the column is added IF NOT EXISTS and
// nothing existing is read, rewritten or defaulted.
import { readFileSync } from "fs";
import { join } from "path";
import pg from "pg";

const COMMIT = process.argv.includes("--commit");

async function main() {
  const sql = readFileSync(join(process.cwd(), "migrations", "2026-08-18_unlocked_tabs.sql"), "utf8");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  console.log(`\n  unlocked_tabs — ${COMMIT ? "COMMIT" : "DRY RUN (rolled back)"}\n`);
  await client.query("BEGIN");
  try {
    // Before: how many memberships exist, so we can prove none were altered.
    const before = await client.query(`select count(*)::int n from user_organizations`);

    await client.query(sql);
    console.log("  migration ran");

    const col = await client.query(
      `select data_type, is_nullable, column_default
         from information_schema.columns
        where table_name = 'user_organizations' and column_name = 'unlocked_tabs'`,
    );
    const problems: string[] = [];
    if (!col.rowCount) problems.push("column was not created");
    else {
      if (col.rows[0].data_type !== "jsonb") problems.push(`expected jsonb, got ${col.rows[0].data_type}`);
      if (col.rows[0].is_nullable !== "YES") problems.push("column must be nullable");
      // A default here would assert a permission nobody granted.
      if (col.rows[0].column_default !== null) problems.push(`unexpected default ${col.rows[0].column_default}`);
    }

    const after = await client.query(
      `select count(*)::int n, count(unlocked_tabs)::int granted from user_organizations`,
    );
    if (after.rows[0].n !== before.rows[0].n) problems.push("membership count changed");
    // Nobody should hold a grant merely from running the migration.
    if (after.rows[0].granted !== 0) problems.push(`${after.rows[0].granted} memberships already carry a grant`);

    console.log(`  ${after.rows[0].n} memberships, ${after.rows[0].granted} carrying a locked-tab grant`);

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
