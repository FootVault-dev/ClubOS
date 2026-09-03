// Apply migrations/2026-09-03_print_customer_accounts.sql, rehearsing it first.
//
//   npx tsx --env-file=.env script/apply-print-customer-accounts.ts            (dry run)
//   npx tsx --env-file=.env script/apply-print-customer-accounts.ts --commit
//
// There is no local Postgres, so a dry run is the only rehearsal available: it
// runs the real DDL and the real checks inside a transaction it then rolls back.
// Additive and idempotent — no existing table is touched.
//
// 🔴 The behavioural checks are the point, and most of them are an insert that
// MUST be refused. A constraint nobody has seen reject anything is a comment.
//
// MUST BE REFUSED:
//   1. two accounts for the same email                    (one human, one account)
//   2. the same email in different case                   (Dima@x vs dima@x)
//   3. a discount with no approver                        (money off with nobody's name on it)
//   4. a discount with an approver but no approval date
//   5. a negative discount                                (a surcharge by accident)
//   6. a discount over 100%                               (paying them to take it away)
//   7. two sessions sharing one token hash
//   8. deleting the staff member who approved a discount  (ON DELETE RESTRICT)
//   9. a login code marked consumed before it was created
//
// MUST BE ACCEPTED, each easy to break by accident:
//   A. an account with only an email                      (sign-up knows nothing else yet)
//   B. a 0% discount with no approver                     (every new account)
//   C. a real discount WITH an approver and a date
//   D. two different emails
//   E. re-running the whole migration                     (idempotency)
import { readFileSync } from "fs";
import { join } from "path";
import pg from "pg";

const COMMIT = process.argv.includes("--commit");
const MIGRATION = "2026-09-03_print_customer_accounts.sql";

type Client = pg.Client;
const problems: string[] = [];
let checks = 0;

function ok(label: string) {
  checks++;
  console.log(`  ✓ ${label}`);
}
function bad(label: string) {
  checks++;
  problems.push(label);
  console.log(`  ✗ ${label}`);
}

/** Assert a statement is REFUSED by the database. */
async function mustReject(c: Client, label: string, sql: string, params: any[] = []) {
  await c.query("SAVEPOINT s");
  try {
    await c.query(sql, params);
    await c.query("ROLLBACK TO SAVEPOINT s");
    bad(`${label} — was ACCEPTED, the database is not enforcing this`);
  } catch {
    await c.query("ROLLBACK TO SAVEPOINT s");
    ok(`${label} — refused`);
  }
}

/** Assert a statement is ACCEPTED. */
async function mustAccept(c: Client, label: string, sql: string, params: any[] = []) {
  await c.query("SAVEPOINT s");
  try {
    await c.query(sql, params);
    await c.query("RELEASE SAVEPOINT s");
    ok(label);
  } catch (e: any) {
    await c.query("ROLLBACK TO SAVEPOINT s");
    bad(`${label} — was REFUSED: ${e.message}`);
  }
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set — run with --env-file=.env");

  const sqlText = readFileSync(join(process.cwd(), "migrations", MIGRATION), "utf8");
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();

  console.log(`\n${COMMIT ? "APPLYING" : "REHEARSING (will roll back)"} ${MIGRATION}\n`);
  await c.query("BEGIN");

  try {
    await c.query(sqlText);
    ok("migration ran");

    // Idempotency — the whole file again, in the same transaction.
    await mustAccept(c, "re-running the migration is a no-op", sqlText);

    // A staff user to approve things with. Any real one; we only read the id.
    const staff = await c.query(`SELECT id FROM users ORDER BY id LIMIT 1`);
    const staffId = staff.rows[0]?.id;
    if (!staffId) throw new Error("no users row to use as an approver");

    // ── Accepted ────────────────────────────────────────────────────────────
    await mustAccept(
      c,
      "A. an account with nothing but an email",
      `INSERT INTO print_customers (email) VALUES ('rehearsal-a@example.test')`,
    );
    await mustAccept(
      c,
      "B. a 0% discount with no approver (every new account)",
      `INSERT INTO print_customers (email, discount_pct) VALUES ('rehearsal-b@example.test', 0)`,
    );
    await mustAccept(
      c,
      "C. a real discount WITH an approver and a date",
      `INSERT INTO print_customers (email, tier, discount_pct, approved_by_user_id, approved_at)
       VALUES ('rehearsal-c@example.test', 'trade', 15, $1, now())`,
      [staffId],
    );
    await mustAccept(
      c,
      "D. a second, different email",
      `INSERT INTO print_customers (email) VALUES ('rehearsal-d@example.test')`,
    );

    // ── Refused ─────────────────────────────────────────────────────────────
    await mustReject(
      c,
      "1. the same email twice",
      `INSERT INTO print_customers (email) VALUES ('rehearsal-a@example.test')`,
    );
    await mustReject(
      c,
      "2. the same email in a different case",
      `INSERT INTO print_customers (email) VALUES ('Rehearsal-A@Example.test')`,
    );
    await mustReject(
      c,
      "3. a discount with NO approver — money off with nobody's name on it",
      `INSERT INTO print_customers (email, discount_pct) VALUES ('rehearsal-e@example.test', 20)`,
    );
    await mustReject(
      c,
      "4. a discount with an approver but no approval date",
      `INSERT INTO print_customers (email, discount_pct, approved_by_user_id)
       VALUES ('rehearsal-f@example.test', 20, $1)`,
      [staffId],
    );
    await mustReject(
      c,
      "5. a negative discount (a surcharge by accident)",
      `INSERT INTO print_customers (email, discount_pct, approved_by_user_id, approved_at)
       VALUES ('rehearsal-g@example.test', -5, $1, now())`,
      [staffId],
    );
    await mustReject(
      c,
      "6. a discount over 100%",
      `INSERT INTO print_customers (email, discount_pct, approved_by_user_id, approved_at)
       VALUES ('rehearsal-h@example.test', 120, $1, now())`,
      [staffId],
    );

    // Sessions
    const cust = await c.query(
      `SELECT id FROM print_customers WHERE email = 'rehearsal-a@example.test'`,
    );
    const custId = cust.rows[0].id;
    await mustAccept(
      c,
      "a session for that customer",
      `INSERT INTO print_customer_sessions (customer_id, token_hash, expires_at)
       VALUES ($1, 'rehearsal-hash-1', now() + interval '30 days')`,
      [custId],
    );
    await mustReject(
      c,
      "7. two sessions sharing one token hash",
      `INSERT INTO print_customer_sessions (customer_id, token_hash, expires_at)
       VALUES ($1, 'rehearsal-hash-1', now() + interval '30 days')`,
      [custId],
    );

    // ON DELETE RESTRICT on the approver
    await mustReject(
      c,
      "8. deleting the staff member who approved a discount",
      `DELETE FROM users WHERE id = $1`,
      [staffId],
    );

    // Codes
    await mustReject(
      c,
      "9. a login code consumed before it was created",
      `INSERT INTO print_customer_codes (email, code_hash, expires_at, created_at, consumed_at)
       VALUES ('rehearsal-a@example.test', 'x', now() + interval '10 min', now(), now() - interval '1 hour')`,
    );

    // ── RLS is actually on ──────────────────────────────────────────────────
    const rls = await c.query(`
      SELECT relname, relrowsecurity FROM pg_class
      WHERE relname IN ('print_customers','print_customer_codes',
                        'print_customer_sessions','print_customer_auth_events')`);
    for (const r of rls.rows) {
      if (r.relrowsecurity) ok(`RLS enabled on ${r.relname}`);
      else bad(`RLS is OFF on ${r.relname} — a leaked anon key would read it`);
    }
    if (rls.rows.length !== 4) bad(`expected 4 tables, found ${rls.rows.length}`);

    // ── The default that matters commercially ───────────────────────────────
    const dflt = await c.query(
      `SELECT discount_pct, tier FROM print_customers WHERE email = 'rehearsal-a@example.test'`,
    );
    if (Number(dflt.rows[0].discount_pct) === 0 && dflt.rows[0].tier === "standard") {
      ok("a brand-new account defaults to standard tier at 0% — nobody gets a discount by signing up");
    } else {
      bad(`a new account defaulted to ${dflt.rows[0].tier}/${dflt.rows[0].discount_pct}% — it must be standard/0`);
    }

    console.log(`\n${checks} checks, ${problems.length} problem(s).`);
    for (const p of problems) console.log(`  ✗ ${p}`);

    if (problems.length > 0) {
      await c.query("ROLLBACK");
      console.log("\nROLLED BACK — fix the problems above before committing.\n");
      process.exitCode = 1;
    } else if (COMMIT) {
      await c.query("COMMIT");
      console.log("\nCOMMITTED.\n");
    } else {
      await c.query("ROLLBACK");
      console.log("\nRolled back (dry run). Re-run with --commit to apply.\n");
    }
  } catch (e: any) {
    await c.query("ROLLBACK").catch(() => {});
    console.error("\nFAILED:", e.message, "\n");
    process.exitCode = 1;
  } finally {
    await c.end();
  }
}

main();
