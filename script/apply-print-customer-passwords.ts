// Apply migrations/2026-09-03_print_customer_passwords.sql, rehearsing it first.
//
//   npx tsx --env-file=.env script/apply-print-customer-passwords.ts            (dry run)
//   npx tsx --env-file=.env script/apply-print-customer-passwords.ts --commit
//
// ADDITIVE — three nullable columns on print_customers plus a purpose on the
// code table. Nothing is dropped.
//
// MUST BE REFUSED:
//   1. a password hash that is not the house s1$salt$hex format (a plaintext
//      password written into the column by hand)
//   2. a hash with no password_set_at, and a set_at with no hash
// MUST BE ACCEPTED:
//   A. a real scrypt hash with its date
//   B. an account with NO password at all (the legacy passwordless rows)
//   C. re-running the migration
import { readFileSync } from "fs";
import { join } from "path";
import crypto from "crypto";
import pg from "pg";

const COMMIT = process.argv.includes("--commit");
const MIGRATION = "2026-09-03_print_customer_passwords.sql";
const problems: string[] = [];
let checks = 0;
const ok = (l: string) => { checks++; console.log(`  ✓ ${l}`); };
const bad = (l: string) => { checks++; problems.push(l); console.log(`  ✗ ${l}`); };

async function mustReject(c: pg.Client, label: string, sql: string, params: any[] = []) {
  await c.query("SAVEPOINT s");
  try { await c.query(sql, params); await c.query("ROLLBACK TO SAVEPOINT s"); bad(`${label} — was ACCEPTED`); }
  catch { await c.query("ROLLBACK TO SAVEPOINT s"); ok(`${label} — refused`); }
}
async function mustAccept(c: pg.Client, label: string, sql: string, params: any[] = []) {
  await c.query("SAVEPOINT s");
  try { await c.query(sql, params); await c.query("RELEASE SAVEPOINT s"); ok(label); }
  catch (e: any) { await c.query("ROLLBACK TO SAVEPOINT s"); bad(`${label} — was REFUSED: ${e.message}`); }
}

async function main() {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL!, ssl: { rejectUnauthorized: false } });
  await c.connect();
  console.log(`\n${COMMIT ? "APPLYING" : "REHEARSING (will roll back)"} ${MIGRATION}\n`);
  await c.query("BEGIN");
  try {
    const text = readFileSync(join(process.cwd(), "migrations", MIGRATION), "utf8");
    await c.query(text); ok("migration ran");
    await mustAccept(c, "C. re-running the migration is a no-op", text);

    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.scryptSync("a-real-passphrase-here", salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex");
    const real = `s1$${salt}$${hash}`;

    await mustAccept(c, "A. a real scrypt hash with its date",
      `INSERT INTO print_customers (email, password_hash, password_set_at) VALUES ('_pw-a@example.test', $1, now())`, [real]);
    await mustAccept(c, "B. an account with no password at all (a legacy row)",
      `INSERT INTO print_customers (email) VALUES ('_pw-b@example.test')`);
    await mustReject(c, "1. a plaintext password written into the hash column",
      `INSERT INTO print_customers (email, password_hash, password_set_at) VALUES ('_pw-c@example.test', 'hunter2', now())`);
    await mustReject(c, "1b. a hash in the wrong scheme",
      `INSERT INTO print_customers (email, password_hash, password_set_at) VALUES ('_pw-d@example.test', $1, now())`,
      [`bcrypt$${salt}$${hash}`]);
    await mustReject(c, "2. a hash with no password_set_at",
      `INSERT INTO print_customers (email, password_hash) VALUES ('_pw-e@example.test', $1)`, [real]);
    await mustReject(c, "2b. a password_set_at with no hash",
      `INSERT INTO print_customers (email, password_set_at) VALUES ('_pw-f@example.test', now())`);

    const cols = await c.query(`SELECT column_name FROM information_schema.columns
      WHERE table_name='print_customers' AND column_name IN ('password_hash','password_set_at','email_verified_at')`);
    cols.rowCount === 3 ? ok("all three columns exist") : bad(`expected 3 new columns, found ${cols.rowCount}`);

    const purpose = await c.query(`SELECT column_default FROM information_schema.columns
      WHERE table_name='print_customer_codes' AND column_name='purpose'`);
    String(purpose.rows[0]?.column_default ?? "").includes("login")
      ? ok("existing codes default to purpose 'login' (nothing reinterpreted)")
      : bad("purpose default is not 'login'");

    console.log(`\n${checks} checks, ${problems.length} problem(s).`);
    for (const p of problems) console.log(`  ✗ ${p}`);
    if (problems.length) { await c.query("ROLLBACK"); console.log("\nROLLED BACK.\n"); process.exitCode = 1; }
    else if (COMMIT) { await c.query("COMMIT"); console.log("\nCOMMITTED.\n"); }
    else { await c.query("ROLLBACK"); console.log("\nRolled back (dry run). Re-run with --commit.\n"); }
  } catch (e: any) {
    await c.query("ROLLBACK").catch(() => {});
    console.error("\nFAILED:", e.message, "\n"); process.exitCode = 1;
  } finally { await c.end(); }
}
main();
