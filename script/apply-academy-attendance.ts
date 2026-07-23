// Apply the academy-attendance migration. ADDITIVE ONLY.
//
//   Rehearse:  npx tsx --env-file=.env script/apply-academy-attendance.ts --dry-run
//   Apply:     npx tsx --env-file=.env script/apply-academy-attendance.ts
//
// `--dry-run` runs the migration AND every verification inside a transaction it
// then ROLLS BACK — proving the SQL parses and the invariants hold without
// changing anything. (Prod has schema drift — never `db:push --force`.)
import { Pool } from "pg";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const DRY_RUN = process.argv.includes("--dry-run");

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, "..", "migrations", "2026-07-23_academy_attendance.sql"), "utf8");

// A migration must run on ONE connection — `pool.query` checks out an
// arbitrary client per call, so BEGIN and its SAVEPOINTs can land on different
// connections and the rollback silently applies to nothing.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const db = await pool.connect();

const col = async (name: string) => {
  const r = await db.query(
    "SELECT is_nullable FROM information_schema.columns WHERE table_name='attendance' AND column_name=$1",
    [name],
  );
  return r.rows[0] ?? null;
};

try {
  console.log(DRY_RUN ? "\nDRY RUN — everything below is rolled back.\n" : "\nAPPLYING to the database.\n");

  const before = await db.query("SELECT count(*)::int AS n FROM attendance");
  console.log(`  existing attendance rows: ${before.rows[0].n}\n`);

  await db.query("BEGIN");
  await db.query(sql);

  let missing = 0;
  const check = (ok: boolean, label: string) => {
    if (!ok) missing++;
    console.log(`${ok ? "  ok " : " MISS"}  ${label}`);
  };

  for (const c of ["contact_id", "status", "marked_at", "marked_by_user_id"]) {
    check((await col(c)) !== null, `column attendance.${c}`);
  }
  check((await col("child_id"))?.is_nullable === "YES", "attendance.child_id is nullable");

  {
    const r = await db.query("SELECT 1 FROM pg_indexes WHERE indexname=$1", ["attendance_camp_date_contact_uniq"]);
    check(r.rows.length > 0, "index attendance_camp_date_contact_uniq");
  }
  {
    const r = await db.query(
      "SELECT 1 FROM pg_constraint WHERE conrelid='attendance'::regclass AND conname=$1",
      ["attendance_one_person_ck"],
    );
    check(r.rows.length > 0, "constraint attendance_one_person_ck");
  }

  // The existing 786 camp rows must all still satisfy the new invariant —
  // if any row had no child_id the CHECK would already have refused to attach.
  {
    const r = await db.query(
      "SELECT count(*)::int AS n FROM attendance WHERE (child_id IS NOT NULL) = (contact_id IS NOT NULL)",
    );
    check(r.rows[0].n === 0, `every existing row points at exactly one person (${r.rows[0].n} bad)`);
  }

  // Prove the invariant actually bites, then undo the probe.
  {
    let refused = false;
    await db.query("SAVEPOINT probe");
    try {
      await db.query("INSERT INTO attendance (camp_id, camp_date_id) VALUES (NULL, NULL)");
    } catch { refused = true; }
    await db.query("ROLLBACK TO SAVEPOINT probe");
    check(refused, "a roll line with no person is refused");
  }

  const after = await db.query("SELECT count(*)::int AS n FROM attendance");
  check(after.rows[0].n === before.rows[0].n, `no attendance rows added or lost (${after.rows[0].n})`);

  if (missing) {
    await db.query("ROLLBACK");
    console.error(`\n${missing} check(s) failed — DO NOT DEPLOY.`);
    process.exit(1);
  }

  if (DRY_RUN) {
    await db.query("ROLLBACK");
    console.log("\n✓ Migration is valid. Rolled back — the database is unchanged.");
    console.log("  Re-run without --dry-run to apply it for real.\n");
  } else {
    await db.query("COMMIT");
    console.log("\nattendance now carries the academy shape. Safe to deploy.\n");
  }
} catch (e) {
  await db.query("ROLLBACK").catch(() => {});
  throw e;
} finally {
  db.release();
  await pool.end();
}
