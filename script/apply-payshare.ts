// Applies migrations/2026-07-31_payshare.sql — the PayShare group-checkout
// tables plus the venue kill switch. Dry-run by default; --apply commits.
//
//   npx tsx --env-file=.env script/apply-payshare.ts
//   npx tsx --env-file=.env script/apply-payshare.ts --apply
//
// The assertions that matter:
//   · payshare_enabled is NULLABLE and defaults FALSE — applying this must not
//     switch PayShare on for any venue, including the live USC site.
//   · split_enabled is untouched and Player Pay's row counts are unchanged —
//     the two split options run side by side, and this migration must not so
//     much as brush the one currently taking real money.
//   · the three unique indexes exist. They are the actual guards: without them
//     a replayed create-payment hook mints a second payment intent and a
//     replayed completion webhook confirms the same booking twice (prod runs
//     two Fly machines, so in-memory dedupe is not dedupe).
//   · no CHECK constraints on the enum-ish columns — a stale CHECK is how the
//     MFL checkout once 500'd.

import { Pool } from "pg";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const APPLY = process.argv.includes("--apply");
const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, "..", "migrations", "2026-07-31_payshare.sql"), "utf8");

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set.");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const one = async (q: string, p: any[] = []) => (await pool.query(q, p)).rows[0];

let bad = 0;
const check = (ok: boolean, label: string) => { if (!ok) bad++; console.log(`${ok ? "  ok " : " MISS"}  ${label}`); };

try {
  await pool.query("BEGIN");

  const before = await one(`SELECT
    (SELECT count(*)::int FROM split_sessions)   AS split_sessions,
    (SELECT count(*)::int FROM split_members)    AS split_members,
    (SELECT count(*)::int FROM facility_bookings) AS bookings,
    (SELECT count(*)::int FROM venue_settings WHERE split_enabled) AS venues_with_player_pay`);
  console.log("live before:", JSON.stringify(before), "\n");

  // The migration itself carries BEGIN/COMMIT; strip them so this script's
  // outer transaction stays in control and a dry run can actually roll back.
  await pool.query(sql.replace(/^\s*BEGIN;\s*$/mi, "").replace(/^\s*COMMIT;\s*$/mi, ""));

  // ── the venue flag ────────────────────────────────────────────────────────
  const flag = await one(`SELECT is_nullable, column_default, data_type
    FROM information_schema.columns
    WHERE table_name='venue_settings' AND column_name='payshare_enabled'`);
  check(!!flag, "venue_settings.payshare_enabled exists");
  check(flag?.data_type === "boolean", "boolean");
  check(/false/i.test(flag?.column_default ?? ""), "defaults FALSE — nobody is switched on by the migration");
  check(flag?.is_nullable === "YES", "nullable — matches split_enabled, no backfill");

  const onNow = await one(`SELECT count(*)::int n FROM venue_settings WHERE payshare_enabled IS TRUE`);
  check(onNow.n === 0, "zero venues have PayShare on after applying");

  // ── tables ────────────────────────────────────────────────────────────────
  for (const t of ["payshare_sessions", "payshare_participants", "payshare_events"]) {
    const r = await one(`SELECT to_regclass($1) AS t`, [t]);
    check(!!r?.t, `table ${t} exists`);
  }

  // ── the indexes that carry the real invariants ────────────────────────────
  const idx = await pool.query(`SELECT indexname FROM pg_indexes WHERE indexname LIKE 'payshare%'`);
  const names = idx.rows.map((r: any) => r.indexname);
  check(names.includes("payshare_sessions_session_id_unique"), "unique(session_id) — one hook cannot fund two bookings");
  check(names.includes("payshare_participants_session_participant_unique"), "unique(session, participant) — a retried hook cannot mint a second intent");
  check(names.includes("payshare_participants_pay_token_unique"), "unique(pay_token) — pay links are not guessable");
  check(names.includes("payshare_events_event_id_kind_unique"), "unique(event_id, kind) — cross-machine webhook dedupe");

  // ── currency is never defaulted ───────────────────────────────────────────
  const cur = await one(`SELECT is_nullable, column_default FROM information_schema.columns
    WHERE table_name='payshare_sessions' AND column_name='currency'`);
  check(cur?.is_nullable === "NO", "payshare_sessions.currency NOT NULL");
  check(cur?.column_default === null, "no currency default — PayShare requires it explicitly per session");

  // ── no stale CHECKs on the enum-ish columns ───────────────────────────────
  const checks = await one(`SELECT count(*)::int n FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE c.contype='c' AND t.relname LIKE 'payshare%'`);
  check(checks.n === 0, "no CHECK constraints on payshare tables");

  // ── Player Pay untouched ──────────────────────────────────────────────────
  const after = await one(`SELECT
    (SELECT count(*)::int FROM split_sessions)   AS split_sessions,
    (SELECT count(*)::int FROM split_members)    AS split_members,
    (SELECT count(*)::int FROM facility_bookings) AS bookings,
    (SELECT count(*)::int FROM venue_settings WHERE split_enabled) AS venues_with_player_pay`);
  check(JSON.stringify(before) === JSON.stringify(after), "Player Pay + bookings untouched");
  console.log("live after: ", JSON.stringify(after));

  console.log("");
  if (bad > 0) {
    await pool.query("ROLLBACK");
    console.log(`✗ ${bad} assertion(s) failed — rolled back, nothing changed.`);
    process.exit(1);
  }
  if (APPLY) {
    await pool.query("COMMIT");
    console.log("✓ applied and committed.");
  } else {
    await pool.query("ROLLBACK");
    console.log("✓ dry run passed — rolled back. Re-run with --apply to commit.");
  }
} catch (e) {
  await pool.query("ROLLBACK").catch(() => {});
  console.error("✗ failed, rolled back:", e);
  process.exit(1);
} finally {
  await pool.end();
}
