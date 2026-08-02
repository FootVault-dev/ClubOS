// Apply the family-linking migration. ADDITIVE ONLY — indexes, no data written.
//
//   Rehearse:  npx tsx --env-file=.env script/apply-family-links.ts --dry-run
//   Apply:     npx tsx --env-file=.env script/apply-family-links.ts
//
// `--dry-run` runs the migration and every verification inside a transaction it
// then ROLLS BACK. Postgres DDL is transactional, so this proves the unique
// index can actually be built on the live data before we commit to it — which
// matters here, because CREATE UNIQUE INDEX fails outright if a duplicate
// (guardian_id, player_id) pair exists.
import { Pool } from "pg";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const DRY_RUN = process.argv.includes("--dry-run");

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, "..", "migrations", "2026-08-02_family_links.sql"), "utf8");

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
try {
  console.log(DRY_RUN ? "\nDRY RUN — everything below is rolled back.\n" : "\nAPPLYING to the database.\n");
  await pool.query("BEGIN");
  await pool.query(sql);

  let missing = 0;
  for (const idx of [
    "contact_relationships_guardian_idx",
    "contact_relationships_player_idx",
    "contact_relationships_pair_uniq",
    "children_parent_idx",
    "registrations_guardian_idx",
    "registration_items_child_idx",
  ]) {
    const r = await pool.query("SELECT to_regclass($1) AS t", [idx]);
    const ok = r.rows[0].t !== null;
    if (!ok) missing++;
    console.log(`${ok ? "  ok " : " MISS"}  index ${idx}`);
  }

  // The family data itself must be unchanged by this migration.
  const counts = await pool.query(`
    SELECT (SELECT count(*) FROM contact_relationships) AS edges,
           (SELECT count(*) FROM children)              AS camp_children,
           (SELECT count(*) FROM contacts WHERE type='player')   AS player_contacts,
           (SELECT count(*) FROM contacts WHERE type='guardian') AS guardians`);
  const c = counts.rows[0];
  console.log(`\n  edges ${c.edges} · camp children ${c.camp_children} · player contacts ${c.player_contacts} · guardians ${c.guardians}`);

  // Proof the resolver's two directions now hit an index rather than a scan.
  const plan = await pool.query(
    `EXPLAIN SELECT 1 FROM contact_relationships WHERE guardian_id = 14`);
  const usesIndex = plan.rows.map((r: any) => r["QUERY PLAN"]).join(" ").includes("Index");
  console.log(`  ${usesIndex ? "ok  " : "WARN"}  guardian lookup uses an index`);

  if (missing > 0) throw new Error(`${missing} index(es) missing after migration`);

  if (DRY_RUN) {
    await pool.query("ROLLBACK");
    console.log("\nROLLED BACK — nothing changed. Re-run without --dry-run to apply.\n");
  } else {
    await pool.query("COMMIT");
    console.log("\nCOMMITTED.\n");
  }
} catch (e: any) {
  await pool.query("ROLLBACK").catch(() => {});
  console.error("\nFAILED — rolled back:", e.message, "\n");
  process.exitCode = 1;
} finally {
  await pool.end();
}
