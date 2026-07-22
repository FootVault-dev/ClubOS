// Apply the Sales (United Print prospect pipeline) migration. ADDITIVE ONLY.
//
//   Rehearse:  npx tsx --env-file=.env script/apply-print-sales.ts --dry-run
//   Apply:     npx tsx --env-file=.env script/apply-print-sales.ts
//
// `--dry-run` runs the whole migration and every verification inside a
// transaction it then ROLLS BACK — proving the SQL parses, the organizations /
// users / print_contacts foreign keys resolve, and the partial unique index
// builds, while changing nothing. There is no local Postgres to rehearse
// against. (Prod has schema drift — never `db:push --force`. Run BEFORE deploy.)
import { Pool } from "pg";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const DRY_RUN = process.argv.includes("--dry-run");

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, "..", "migrations", "2026-07-11_print_sales.sql"), "utf8");

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
try {
  console.log(DRY_RUN ? "\nDRY RUN — everything below is rolled back.\n" : "\nAPPLYING to the database.\n");
  await pool.query("BEGIN");
  await pool.query(sql);

  let missing = 0;
  for (const t of ["sales_prospects", "sales_activities"]) {
    const r = await pool.query("SELECT to_regclass($1) AS t", [t]);
    const ok = r.rows[0].t !== null;
    if (!ok) missing++;
    console.log(`${ok ? "  ok " : " MISS"}  table ${t}`);
  }
  for (const idx of [
    "sales_prospects_org_website_unq",
    "sales_prospects_org_stage_idx",
    "sales_prospects_org_tier_idx",
    "sales_prospects_org_followup_idx",
    "sales_activities_prospect_idx",
  ]) {
    const r = await pool.query("SELECT 1 FROM pg_indexes WHERE indexname = $1", [idx]);
    const ok = r.rows.length > 0;
    if (!ok) missing++;
    console.log(`${ok ? "  ok " : " MISS"}  index ${idx}`);
  }

  // The dedupe index is the load-bearing one. Prove it is actually partial —
  // a plain unique on lower(website) would reject the second no-site prospect.
  const partials = await pool.query(
    `SELECT indexname, indexdef FROM pg_indexes WHERE indexname = 'sales_prospects_org_website_unq'`,
  );
  for (const row of partials.rows) {
    const ok = / WHERE /i.test(row.indexdef);
    if (!ok) missing++;
    console.log(`${ok ? "  ok " : " MISS"}  ${row.indexname} is partial`);
  }

  if (missing) {
    await pool.query("ROLLBACK");
    console.error(`\n${missing} object(s) missing — DO NOT DEPLOY.`);
    process.exit(1);
  }

  if (DRY_RUN) {
    await pool.query("ROLLBACK");
    console.log("\n✓ Migration is valid. Rolled back — the database is unchanged.");
    console.log("  Re-run without --dry-run to apply it for real.\n");
  } else {
    await pool.query("COMMIT");
    console.log("\nAll sales objects present. Safe to deploy.\n");
  }
} catch (e) {
  await pool.query("ROLLBACK").catch(() => {});
  throw e;
} finally {
  await pool.end();
}
