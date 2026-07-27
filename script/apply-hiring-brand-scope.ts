// Apply the Hiring brand-scope migration. ADDITIVE ONLY.
//
//   Rehearse:  npx tsx --env-file=.env script/apply-hiring-brand-scope.ts --dry-run
//   Apply:     npx tsx --env-file=.env script/apply-hiring-brand-scope.ts
//
// `--dry-run` runs the migration and every verification inside a transaction it
// then ROLLS BACK — proving the SQL parses and the column lands without touching
// anything. (Prod has schema drift — never `db:push --force`.)
//
// The verification that matters is the last one: every existing membership must
// still read NULL afterwards. NULL means "all brands", so a backfill or a
// DEFAULT here would silently narrow live access for the whole club.
import { Pool } from "pg";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const DRY_RUN = process.argv.includes("--dry-run");

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, "..", "migrations", "2026-07-27_hiring_brand_scope.sql"), "utf8");

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
try {
  console.log(DRY_RUN ? "\nDRY RUN — everything below is rolled back.\n" : "\nAPPLYING to the database.\n");

  const before = await pool.query("SELECT count(*)::int AS n FROM user_organizations");

  await pool.query("BEGIN");
  await pool.query(sql);

  let missing = 0;
  {
    const r = await pool.query(
      `SELECT data_type FROM information_schema.columns
        WHERE table_name = 'user_organizations' AND column_name = 'hiring_brands'`,
    );
    const ok = r.rows[0]?.data_type === "jsonb";
    if (!ok) missing++;
    console.log(`${ok ? "  ok " : " MISS"}  user_organizations.hiring_brands is jsonb`);
  }
  {
    // Nobody's access may narrow. Every pre-existing row must still be NULL.
    const r = await pool.query("SELECT count(*)::int AS n FROM user_organizations WHERE hiring_brands IS NULL");
    const ok = r.rows[0].n === before.rows[0].n;
    if (!ok) missing++;
    console.log(`${ok ? "  ok " : " MISS"}  all ${before.rows[0].n} existing memberships still NULL (= all brands)`);
  }
  {
    const r = await pool.query(
      `SELECT column_default FROM information_schema.columns
        WHERE table_name = 'user_organizations' AND column_name = 'hiring_brands'`,
    );
    const ok = r.rows[0]?.column_default === null;
    if (!ok) missing++;
    console.log(`${ok ? "  ok " : " MISS"}  no column default (a default would scope people implicitly)`);
  }

  if (missing) {
    await pool.query("ROLLBACK");
    console.error(`\n${missing} check(s) failed — DO NOT DEPLOY.`);
    process.exit(1);
  }

  if (DRY_RUN) {
    await pool.query("ROLLBACK");
    console.log("\n✓ Migration is valid. Rolled back — the database is unchanged.");
    console.log("  Re-run without --dry-run to apply it for real.\n");
  } else {
    await pool.query("COMMIT");
    console.log("\n✓ hiring_brands present, nobody narrowed. Safe to deploy.\n");
  }
} catch (e) {
  await pool.query("ROLLBACK").catch(() => {});
  console.error("\nFAILED — rolled back:\n", e);
  process.exit(1);
} finally {
  await pool.end();
}
