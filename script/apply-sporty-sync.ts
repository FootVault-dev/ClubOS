// Apply (or rehearse) migrations/2026-07-21_sporty_sync.sql — the Sporty/NZF
// NRS sync tables. There is no local Postgres, so the rehearsal runs the whole
// migration inside a transaction against the real DB, verifies every object
// exists, then ROLLS BACK. Run with --dry-run first, always.
//
//   npx tsx --env-file=.env script/apply-sporty-sync.ts --dry-run
//   npx tsx --env-file=.env script/apply-sporty-sync.ts
//
// Additive-only: three new tables, no changes to existing objects.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const DRY_RUN = process.argv.includes("--dry-run");
const here = dirname(fileURLToPath(import.meta.url));
const sqlText = readFileSync(join(here, "..", "migrations", "2026-07-21_sporty_sync.sql"), "utf8");

const EXPECT_TABLES = ["sporty_sync_state", "sporty_push_log", "sporty_reference_cache"];
const EXPECT_INDEXES = [
  "sporty_sync_state_org_status_idx",
  "sporty_push_log_contact_idx",
  "sporty_push_log_org_idx",
];
const EXPECT_CONSTRAINTS = [
  ["sporty_sync_state", "sporty_sync_state_contact_unique"],
  ["sporty_reference_cache", "sporty_reference_cache_kind_unique"],
];

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL not set — run with --env-file=.env");
    process.exit(1);
  }
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sqlText);

    let failed = false;
    for (const table of EXPECT_TABLES) {
      const { rows } = await client.query("SELECT to_regclass($1) AS reg", [table]);
      if (!rows[0]?.reg) {
        console.error(`✗ table missing after migration: ${table}`);
        failed = true;
      } else {
        console.log(`✓ table ${table}`);
      }
    }
    for (const index of EXPECT_INDEXES) {
      const { rows } = await client.query("SELECT 1 FROM pg_indexes WHERE indexname = $1", [index]);
      if (!rows.length) {
        console.error(`✗ index missing after migration: ${index}`);
        failed = true;
      } else {
        console.log(`✓ index ${index}`);
      }
    }
    for (const [table, constraint] of EXPECT_CONSTRAINTS) {
      const { rows } = await client.query(
        "SELECT 1 FROM pg_constraint WHERE conname = $1 AND conrelid = $2::regclass",
        [constraint, table],
      );
      if (!rows.length) {
        console.error(`✗ unique constraint missing: ${table}.${constraint}`);
        failed = true;
      } else {
        console.log(`✓ unique ${table}.${constraint}`);
      }
    }
    // The doctrine columns that must exist for the engine to run at all.
    const { rows: cols } = await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'sporty_sync_state'`,
    );
    for (const needed of ["sporty_id", "status", "block_reason", "last_payload_hash", "excluded_reason"]) {
      if (!cols.some((c: any) => c.column_name === needed)) {
        console.error(`✗ sporty_sync_state.${needed} missing`);
        failed = true;
      }
    }

    if (failed) {
      await client.query("ROLLBACK");
      console.error("Verification failed — rolled back, nothing changed.");
      process.exit(1);
    }
    if (DRY_RUN) {
      await client.query("ROLLBACK");
      console.log("DRY RUN passed — all objects verified inside the transaction, then rolled back. Database unchanged.");
    } else {
      await client.query("COMMIT");
      console.log("Migration APPLIED and verified.");
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
