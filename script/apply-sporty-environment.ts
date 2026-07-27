// Apply (or rehearse) migrations/2026-07-27_sporty_environment.sql — namespaces
// Sporty sync state + reference cache by environment (uat | prod).
//
// There is no local Postgres, so the rehearsal runs the whole migration inside a
// transaction against the real DB, verifies every object, then ROLLS BACK.
//
//   npx tsx --env-file=.env script/apply-sporty-environment.ts --dry-run
//   npx tsx --env-file=.env script/apply-sporty-environment.ts
//
// Additive: two new columns, two constraint swaps. No data is destroyed.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const DRY_RUN = process.argv.includes("--dry-run");
const here = dirname(fileURLToPath(import.meta.url));
const sqlText = readFileSync(join(here, "..", "migrations", "2026-07-27_sporty_environment.sql"), "utf8");

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL not set — run with --env-file=.env");
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  let failed = false;
  const fail = (m: string) => {
    console.error(`✗ ${m}`);
    failed = true;
  };
  const ok = (m: string) => console.log(`✓ ${m}`);

  try {
    await client.query("BEGIN");
    await client.query(sqlText);

    // 1. Both tables carry a NOT NULL environment column with NO default.
    for (const table of ["sporty_sync_state", "sporty_reference_cache"]) {
      const { rows } = await client.query(
        `SELECT is_nullable, column_default FROM information_schema.columns
          WHERE table_name = $1 AND column_name = 'environment'`,
        [table],
      );
      if (!rows.length) fail(`${table}.environment missing`);
      else if (rows[0].is_nullable !== "NO") fail(`${table}.environment is nullable`);
      else if (rows[0].column_default !== null) fail(`${table}.environment has a default (${rows[0].column_default}) — it must fail loudly instead of guessing`);
      else ok(`${table}.environment NOT NULL, no default`);
    }

    // 2. The new composite uniques exist; the old single-column ones are gone.
    const constraintExists = async (name: string, table: string) => {
      const { rows } = await client.query(
        "SELECT 1 FROM pg_constraint WHERE conname = $1 AND conrelid = $2::regclass",
        [name, table],
      );
      return rows.length > 0;
    };
    for (const [name, table] of [
      ["sporty_sync_state_contact_env_unique", "sporty_sync_state"],
      ["sporty_reference_cache_kind_env_unique", "sporty_reference_cache"],
    ] as const) {
      (await constraintExists(name, table)) ? ok(`unique ${table}.${name}`) : fail(`unique missing: ${name}`);
    }
    for (const [name, table] of [
      ["sporty_sync_state_contact_unique", "sporty_sync_state"],
      ["sporty_reference_cache_kind_unique", "sporty_reference_cache"],
    ] as const) {
      (await constraintExists(name, table)) ? fail(`old single-column unique still present: ${name}`) : ok(`old unique ${name} removed`);
    }

    // 3. The invariant that matters: the SAME contact can hold BOTH a uat and a
    //    prod row, and a second row in the SAME environment is rejected.
    const { rows: anyContact } = await client.query("SELECT id FROM contacts LIMIT 1");
    const { rows: anyOrg } = await client.query("SELECT id FROM organizations LIMIT 1");
    if (anyContact.length && anyOrg.length) {
      const cid = anyContact[0].id;
      const oid = anyOrg[0].id;
      // The whole probe lives inside a savepoint that is ALWAYS rolled back, so
      // a real (committing) run never leaves synthetic sync rows behind.
      await client.query("SAVEPOINT invariants");
      await client.query(
        `INSERT INTO sporty_sync_state (organization_id, contact_id, environment, sporty_id, status)
         VALUES ($1, $2, 'uat', 999001, 'synced'), ($1, $2, 'prod', 41822, 'synced')`,
        [oid, cid],
      );
      ok("same contact holds a uat row AND a prod row (both environments coexist)");

      let rejected = false;
      await client.query("SAVEPOINT dup");
      try {
        await client.query(
          `INSERT INTO sporty_sync_state (organization_id, contact_id, environment, sporty_id, status)
           VALUES ($1, $2, 'uat', 999002, 'synced')`,
          [oid, cid],
        );
      } catch {
        rejected = true;
      }
      await client.query("ROLLBACK TO SAVEPOINT dup");
      rejected ? ok("a second row for the same (contact, environment) is rejected by Postgres") : fail("duplicate (contact, environment) was ACCEPTED — the unique is not doing its job");

      // And a row that names no environment must be refused outright.
      let refused = false;
      await client.query("SAVEPOINT noenv");
      try {
        await client.query(
          `INSERT INTO sporty_sync_state (organization_id, contact_id, sporty_id, status)
           VALUES ($1, $2, 555, 'synced')`,
          [oid, cid],
        );
      } catch {
        refused = true;
      }
      await client.query("ROLLBACK TO SAVEPOINT noenv");
      refused ? ok("an insert that names no environment is refused (fails loudly, never assumes prod)") : fail("an environment-less insert was ACCEPTED");
      await client.query("ROLLBACK TO SAVEPOINT invariants");
      await client.query("RELEASE SAVEPOINT invariants");
      ok("probe rows rolled back — no synthetic state left behind");
    } else {
      console.log("• skipped live-invariant check (no contacts/organizations rows)");
    }

    if (failed) {
      await client.query("ROLLBACK");
      console.error("\nVerification failed — rolled back, nothing changed.");
      process.exit(1);
    }
    if (DRY_RUN) {
      await client.query("ROLLBACK");
      console.log("\nDRY RUN passed — every object verified inside the transaction, then rolled back. Database unchanged.");
    } else {
      await client.query("COMMIT");
      console.log("\nMigration APPLIED and verified.");
    }
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error("Migration failed:", e);
  process.exit(1);
});
