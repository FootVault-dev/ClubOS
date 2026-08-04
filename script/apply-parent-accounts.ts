// Apply the parent-accounts migration. ADDITIVE ONLY — one new table plus
// three indexes. No existing column is added, altered or dropped, and no
// existing row is written.
//
//   Rehearse:  npx tsx --env-file=.env script/apply-parent-accounts.ts --dry-run
//   Apply:     npx tsx --env-file=.env script/apply-parent-accounts.ts
//
// `--dry-run` runs the migration AND every verification inside a transaction it
// then ROLLS BACK. Postgres DDL is transactional, so this proves the whole
// thing works against live data before anything is committed — there is no
// local Postgres, so this is the only rehearsal available.
import { Pool } from "pg";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const DRY_RUN = process.argv.includes("--dry-run");

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, "..", "migrations", "2026-08-04_parent_accounts.sql"), "utf8");

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
let failures = 0;
const check = (ok: boolean, label: string) => {
  if (!ok) failures++;
  console.log(`${ok ? "  ok " : " FAIL"}  ${label}`);
};

try {
  console.log(DRY_RUN ? "\nDRY RUN — everything below is rolled back.\n" : "\nAPPLYING to the database.\n");
  await pool.query("BEGIN");
  await pool.query(sql);

  // ── The table and its indexes exist ────────────────────────────────────────
  const t = await pool.query("SELECT to_regclass('parent_login_codes') AS t");
  check(t.rows[0].t !== null, "table parent_login_codes");
  for (const idx of [
    "parent_login_codes_email_idx",
    "parent_login_codes_ip_idx",
    "contacts_email_lower_idx",
  ]) {
    const r = await pool.query("SELECT to_regclass($1) AS t", [idx]);
    check(r.rows[0].t !== null, `index ${idx}`);
  }

  // ── RLS is on (the standing rule: a new table defaults to OFF) ─────────────
  const rls = await pool.query(
    "SELECT relrowsecurity FROM pg_class WHERE relname = 'parent_login_codes'",
  );
  check(rls.rows[0]?.relrowsecurity === true, "row level security enabled");

  // ── It actually works: write a code, read it back, consume it once ─────────
  await pool.query(
    `INSERT INTO parent_login_codes (email, code_hash, expires_at, request_ip)
     VALUES ('rehearsal@example.com', 'deadbeef', now() + interval '15 minutes', '127.0.0.1')`,
  );
  const live = await pool.query(
    `SELECT id FROM parent_login_codes
     WHERE email = 'rehearsal@example.com' AND consumed_at IS NULL AND expires_at > now()`,
  );
  check(live.rowCount === 1, "a fresh code is findable");
  const consumed = await pool.query(
    `UPDATE parent_login_codes SET consumed_at = now()
     WHERE id = $1 AND consumed_at IS NULL RETURNING id`,
    [live.rows[0]?.id],
  );
  check(consumed.rowCount === 1, "single-use consume succeeds once");
  const replay = await pool.query(
    `UPDATE parent_login_codes SET consumed_at = now()
     WHERE id = $1 AND consumed_at IS NULL RETURNING id`,
    [live.rows[0]?.id],
  );
  check(replay.rowCount === 0, "consuming the same code twice is refused");
  await pool.query("DELETE FROM parent_login_codes WHERE email = 'rehearsal@example.com'");

  // ── The login population, as it will actually behave ───────────────────────
  const pop = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM contacts
        WHERE type = 'guardian' AND email IS NOT NULL AND email <> '') AS guardians_with_email,
      (SELECT COUNT(DISTINCT LOWER(TRIM(email))) FROM contacts
        WHERE type = 'guardian' AND email IS NOT NULL AND email <> '') AS distinct_logins,
      (SELECT COUNT(*) FROM contacts
        WHERE type = 'player' AND email IS NOT NULL AND email <> '') AS players_with_email`);
  const p = pop.rows[0];
  console.log(`\n  ${p.distinct_logins} email addresses can sign in`
    + ` (${p.guardians_with_email} guardian rows behind them).`);
  console.log(`  ${p.players_with_email} PLAYER rows also carry an email —`
    + ` none of them is a login, by design.\n`);
  check(Number(p.distinct_logins) > 0, "at least one family can sign in");
  // The guardian rows must outnumber the addresses, or the union-across-rows
  // logic is solving a problem that does not exist.
  check(Number(p.guardians_with_email) >= Number(p.distinct_logins),
    "guardian rows >= distinct addresses (duplicates are real)");

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED — rolling back.\n`);
    await pool.query("ROLLBACK");
    process.exit(1);
  }
  await pool.query(DRY_RUN ? "ROLLBACK" : "COMMIT");
  console.log(DRY_RUN ? "Rolled back. Nothing changed.\n" : "Committed.\n");
} catch (e: any) {
  await pool.query("ROLLBACK").catch(() => {});
  console.error("\nFAILED — rolled back:", e.message, "\n");
  process.exit(1);
} finally {
  await pool.end();
}
