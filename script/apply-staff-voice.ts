// Apply the Staff Voice migration. ADDITIVE ONLY.
//
//   Rehearse:  npx tsx --env-file=.env script/apply-staff-voice.ts --dry-run
//   Apply:     npx tsx --env-file=.env script/apply-staff-voice.ts
//
// `--dry-run` runs the whole migration and every verification inside a
// transaction it then ROLLS BACK. Postgres DDL is transactional, so this proves
// the SQL parses, the foreign keys to `users`, `staff_channels` and
// `device_push_tokens` resolve against the real schema, and the partial indexes
// build — while changing nothing. There is no local Postgres to rehearse
// against, and a typo found during the real run is a typo found with the
// deploy already half-done. Same pattern as apply-fleet-vehicles.ts.
//
// 🔴 After applying for real: node ../../scripts/security/rls_guard.mjs
import { Pool } from "pg";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const DRY_RUN = process.argv.includes("--dry-run");

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, "..", "migrations", "2026-08-17_staff_voice.sql"), "utf8");

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// 🔴 ONE dedicated connection, not pool.query() per statement.
//
// This script deliberately provokes a unique-violation to prove the invariant
// actually bites. With a pool, the erroring statement can cause that client to
// be released and the NEXT statement to run on a different connection — which
// is not inside our transaction and cannot see the tables we just created. The
// symptom is a baffling `relation "staff_calls" does not exist` several checks
// after the real event. apply-fleet-vehicles.ts gets away with pool.query()
// only because it never triggers an error on purpose.
const db = await pool.connect();
const query = (text: string, params?: unknown[]) => db.query(text, params as any[]);

try {
  console.log(DRY_RUN ? "\nDRY RUN — everything below is rolled back.\n" : "\nAPPLYING to the database.\n");
  await query("BEGIN");
  await query(sql);

  let missing = 0;

  for (const t of ["staff_calls", "staff_call_participants", "staff_call_events"]) {
    const r = await query("SELECT to_regclass($1) AS t", [t]);
    const ok = r.rows[0].t !== null;
    if (!ok) missing++;
    console.log(`${ok ? "  ok " : " MISS"}  table ${t}`);
  }

  // The two new columns on existing tables — the ones a re-run must not
  // duplicate and a fresh run must not skip.
  for (const [table, column] of [
    ["staff_channels", "voice_enabled"],
    ["device_push_tokens", "voip_token"],
  ]) {
    const r = await query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
      [table, column],
    );
    const ok = r.rows.length > 0;
    if (!ok) missing++;
    console.log(`${ok ? "  ok " : " MISS"}  column ${table}.${column}`);
  }

  for (const idx of [
    "staff_calls_one_live_per_channel",
    "staff_calls_client_id_unq",
    "staff_call_participants_unq",
    "staff_call_participants_live_idx",
    "staff_call_events_call_idx",
    "device_push_tokens_voip_unq",
  ]) {
    const r = await query("SELECT 1 FROM pg_indexes WHERE indexname = $1", [idx]);
    const ok = r.rows.length > 0;
    if (!ok) missing++;
    console.log(`${ok ? "  ok " : " MISS"}  index ${idx}`);
  }

  // 🔴 The load-bearing one. staff_calls_one_live_per_channel MUST be partial.
  // A plain unique index on channel_id would allow a channel exactly ONE call
  // ever — the second call anyone ever placed in that room would fail, and it
  // would look like a bug in the app rather than in this migration.
  const partials = await query(
    `SELECT indexname, indexdef FROM pg_indexes
      WHERE indexname IN ('staff_calls_one_live_per_channel',
                          'staff_calls_client_id_unq',
                          'device_push_tokens_voip_unq')`,
  );
  for (const row of partials.rows) {
    const ok = / WHERE /i.test(row.indexdef);
    if (!ok) missing++;
    console.log(`${ok ? "  ok " : " MISS"}  ${row.indexname} is partial`);
  }

  // RLS on every new table — new tables default to OFF and the anon key is
  // public by design.
  const rls = await query(
    `SELECT relname, relrowsecurity FROM pg_class
      WHERE relname IN ('staff_calls','staff_call_participants','staff_call_events')`,
  );
  for (const row of rls.rows) {
    if (!row.relrowsecurity) missing++;
    console.log(`${row.relrowsecurity ? "  ok " : " MISS"}  RLS enabled on ${row.relname}`);
  }

  // Prove the invariant actually bites, rather than trusting that it exists.
  // Two live calls in one channel must be impossible.
  const [chan] = (await query(`SELECT id FROM staff_channels ORDER BY id LIMIT 1`)).rows;
  const [user] = (await query(`SELECT id FROM users ORDER BY id LIMIT 1`)).rows;
  if (chan && user) {
    await query(
      `INSERT INTO staff_calls (mode, channel_id, room_name, started_by)
       VALUES ('direct', $1, 'verify-room-a', $2)`,
      [chan.id, user.id],
    );
    // 🔴 SAVEPOINT, because this insert is MEANT to fail. In Postgres a failed
    // statement aborts the whole transaction and every later statement errors
    // with "current transaction is aborted" — so without this, proving the
    // invariant works would destroy the run that was proving it.
    let blocked = false;
    await query("SAVEPOINT probe");
    try {
      await query(
        `INSERT INTO staff_calls (mode, channel_id, room_name, started_by)
         VALUES ('direct', $1, 'verify-room-b', $2)`,
        [chan.id, user.id],
      );
      await query("RELEASE SAVEPOINT probe");
    } catch (e: any) {
      blocked = String(e?.code) === "23505";
      await query("ROLLBACK TO SAVEPOINT probe");
    }
    if (!blocked) missing++;
    console.log(`${blocked ? "  ok " : " MISS"}  a second live call in one channel is refused`);

    // …and that ENDING the first one frees the channel, or every channel would
    // be permanently unable to place a second call for the rest of time.
    await query(`UPDATE staff_calls SET ended_at = now() WHERE room_name = 'verify-room-a'`);
    let freed = true;
    try {
      await query(
        `INSERT INTO staff_calls (mode, channel_id, room_name, started_by)
         VALUES ('direct', $1, 'verify-room-c', $2)`,
        [chan.id, user.id],
      );
    } catch {
      freed = false;
    }
    if (!freed) missing++;
    console.log(`${freed ? "  ok " : " MISS"}  ending a call frees the channel for the next one`);
  } else {
    console.log("  --   skipped the live invariant check (no staff_channels/users rows)");
  }

  if (missing) {
    await query("ROLLBACK");
    console.error(`\n${missing} check(s) failed — DO NOT DEPLOY.`);
    process.exit(1);
  }

  if (DRY_RUN) {
    await query("ROLLBACK");
    console.log("\n✓ Migration is valid. Rolled back — the database is unchanged.");
    console.log("  Re-run without --dry-run to apply it for real.\n");
  } else {
    // 🔴 The verification rows above were inserted in THIS transaction. On a
    // real apply they must not survive it.
    await query(`DELETE FROM staff_calls WHERE room_name LIKE 'verify-room-%'`);
    await query("COMMIT");
    console.log("\nAll Staff Voice objects present. Now run: node ../../scripts/security/rls_guard.mjs\n");
  }
} catch (e) {
  await query("ROLLBACK").catch(() => {});
  throw e;
} finally {
  db.release();
  await pool.end();
}
