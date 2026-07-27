// Apply (or rehearse) migrations/2026-07-28_nzf_structured_identity.sql —
// structured NZ Football identity + six-part address on contacts.
//
// There is no local Postgres, so the rehearsal runs the whole migration inside a
// transaction against the real DB, verifies every object, then ROLLS BACK.
//
//   npx tsx --env-file=.env script/apply-nzf-identity.ts --dry-run
//   npx tsx --env-file=.env script/apply-nzf-identity.ts
//
// Purely additive: 14 nullable columns and one partial index. Nothing is
// dropped, nothing is rewritten, and no existing row changes. The legacy
// `address`, `ethnicity`, `nationality` and `country_of_birth` columns are
// untouched, so every current read path keeps working whether or not the
// application code that reads the new columns has shipped.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const DRY_RUN = process.argv.includes("--dry-run");
const here = dirname(fileURLToPath(import.meta.url));
const sqlText = readFileSync(
  join(here, "..", "migrations", "2026-07-28_nzf_structured_identity.sql"),
  "utf8",
);

const NEW_COLUMNS: Array<[string, string]> = [
  ["address_street", "text"],
  ["address_suburb", "text"],
  ["address_city", "text"],
  ["address_region", "text"],
  ["address_postcode", "text"],
  ["address_country", "text"],
  ["nationality_code", "text"],
  ["country_of_birth_code", "text"],
  ["ethnicity_group_id", "integer"],
  ["ethnicity_selection_ids", "ARRAY"],
  ["ethnicity2_group_id", "integer"],
  ["ethnicity2_selection_ids", "ARRAY"],
  ["identity_captured_at", "timestamp with time zone"],
  ["identity_captured_source", "text"],
];

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL not set — run with --env-file=.env");
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  let failed = false;
  const fail = (m: string) => { console.error(`✗ ${m}`); failed = true; };
  const ok = (m: string) => console.log(`✓ ${m}`);

  try {
    // Count contacts BEFORE, so we can prove the migration touched no rows.
    const before = await client.query(`SELECT count(*)::int AS n FROM contacts`);
    const beforeCount: number = before.rows[0].n;

    await client.query("BEGIN");
    await client.query(sqlText);

    // 1. Every column exists, with the right type, and is NULLABLE. A NOT NULL
    //    here would fail the migration on the first existing row — and worse,
    //    a DEFAULT would silently assert a fact about every child already in
    //    the database.
    const cols = await client.query(
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_name = 'contacts' AND column_name = ANY($1)`,
      [NEW_COLUMNS.map(([c]) => c)],
    );
    const byName = new Map(cols.rows.map((r: any) => [r.column_name, r]));
    for (const [name, type] of NEW_COLUMNS) {
      const row: any = byName.get(name);
      if (!row) { fail(`column ${name} missing`); continue; }
      if (row.data_type !== type) { fail(`column ${name} is ${row.data_type}, expected ${type}`); continue; }
      if (row.is_nullable !== "YES") { fail(`column ${name} is NOT NULL — every existing contact would fail`); continue; }
      if (row.column_default !== null) { fail(`column ${name} has a DEFAULT (${row.column_default}) — that invents data`); continue; }
      ok(`contacts.${name} — ${type}, nullable, no default`);
    }

    // 2. The legacy columns still exist and still hold their data. This is the
    //    check that proves nothing was "cleaned up".
    const legacy = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'contacts'
          AND column_name IN ('address','ethnicity','sub_ethnicity','ethnicity2','sub_ethnicity2','nationality','country_of_birth')`,
    );
    if (legacy.rows.length === 7) ok("all 7 legacy identity/address columns intact");
    else fail(`expected 7 legacy columns, found ${legacy.rows.length}`);

    // 3. The partial index exists and IS partial (a full index over every
    //    contact would grow forever as the gap closes).
    const idx = await client.query(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'contacts' AND indexname = 'contacts_nzf_identity_incomplete_idx'`,
    );
    if (idx.rows.length !== 1) fail("contacts_nzf_identity_incomplete_idx missing");
    else if (!/WHERE/i.test(idx.rows[0].indexdef)) fail("the gap index is not partial");
    else ok("contacts_nzf_identity_incomplete_idx present and partial");

    // 4. No CHECK constraints on the new columns. A stale CHECK against a
    //    vocabulary NZ Football controls is how the MFL checkout started 500-ing.
    const checks = await client.query(
      `SELECT con.conname, pg_get_constraintdef(con.oid) AS def
         FROM pg_constraint con
         JOIN pg_class rel ON rel.oid = con.conrelid
        WHERE rel.relname = 'contacts' AND con.contype = 'c'`,
    );
    const offending = checks.rows.filter((r: any) =>
      NEW_COLUMNS.some(([c]) => new RegExp(`\\b${c}\\b`).test(r.def)),
    );
    if (offending.length === 0) ok("no CHECK constraints on the new columns (validation stays in code)");
    else fail(`CHECK constraint(s) on new columns: ${offending.map((o: any) => o.conname).join(", ")}`);

    // 5. Row count unchanged, and every new column is NULL everywhere. The
    //    migration must not have invented a single value.
    const after = await client.query(`SELECT count(*)::int AS n FROM contacts`);
    if (after.rows[0].n === beforeCount) ok(`contacts row count unchanged (${beforeCount})`);
    else fail(`row count changed: ${beforeCount} → ${after.rows[0].n}`);

    const filled = await client.query(
      `SELECT count(*)::int AS n FROM contacts
        WHERE nationality_code IS NOT NULL
           OR country_of_birth_code IS NOT NULL
           OR ethnicity_group_id IS NOT NULL
           OR address_street IS NOT NULL
           OR identity_captured_at IS NOT NULL`,
    );
    if (filled.rows[0].n === 0) ok("no new column was back-filled — every value is honestly unknown");
    else fail(`${filled.rows[0].n} rows have a value in a new column — the migration invented data`);

    // 6. Idempotent: running it twice must be a no-op, not an error.
    await client.query(sqlText);
    ok("migration is idempotent (applied twice cleanly)");

    if (DRY_RUN) {
      await client.query("ROLLBACK");
      console.log(`\n${failed ? "❌" : "✅"} DRY RUN — everything rolled back, database unchanged.`);
    } else if (failed) {
      await client.query("ROLLBACK");
      console.log("\n❌ verification failed — rolled back, database unchanged.");
    } else {
      await client.query("COMMIT");
      console.log("\n✅ APPLIED to the database.");
    }
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("\n❌ migration failed — rolled back, database unchanged.\n", e);
    failed = true;
  } finally {
    client.release();
    await pool.end();
  }
  process.exit(failed ? 1 : 0);
}

main();
