// Apply the roll-guests migration. ADDITIVE ONLY.
//
//   Rehearse:  npx tsx --env-file=.env script/apply-roll-guests.ts --dry-run
//   Apply:     npx tsx --env-file=.env script/apply-roll-guests.ts
import { Pool } from "pg";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const DRY_RUN = process.argv.includes("--dry-run");
const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, "..", "migrations", "2026-07-23_roll_guests.sql"), "utf8");

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const db = await pool.connect();

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

  {
    const r = await db.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name='attendance' AND column_name='guest_kind'");
    check(r.rows.length > 0, "column attendance.guest_kind");
  }
  {
    const r = await db.query("SELECT 1 FROM pg_indexes WHERE indexname='attendance_guest_kind_idx'");
    check(r.rows.length > 0, "index attendance_guest_kind_idx");
  }
  {
    const r = await db.query("SELECT count(*)::int AS n FROM attendance WHERE guest_kind IS NOT NULL");
    check(r.rows[0].n === 0, "every existing roll line reads as a registration (guest_kind NULL)");
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
    console.log("\n✓ Migration is valid. Rolled back — the database is unchanged.\n");
  } else {
    await db.query("COMMIT");
    console.log("\nThe roll can now carry walk-ups. Safe to deploy.\n");
  }
} catch (e) {
  await db.query("ROLLBACK").catch(() => {});
  throw e;
} finally {
  db.release();
  await pool.end();
}
