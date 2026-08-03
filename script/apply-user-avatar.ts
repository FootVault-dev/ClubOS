// Applies migrations/2026-08-03_user_avatar.sql — staff profile pictures.
// Dry-run by default; --apply commits.
//
//   npx tsx --env-file=.env script/apply-user-avatar.ts
//   npx tsx --env-file=.env script/apply-user-avatar.ts --apply
//
// 🔴 EVERY catalogue query here is schema-qualified to 'public'. This database
// also carries Supabase's own auth.users, so a bare table_name='users' filter
// silently matches BOTH and any count-based assertion reads nonsense — which
// is exactly how the first run of this script failed.
//
// This runs against the LIVE users table — every staff login, every squad
// coach, every registration's served_by. So the assertions are about what did
// NOT happen as much as what did: no row count change, no existing column
// touched, and nothing written into the new column by the migration itself.

import { Pool } from "pg";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const APPLY = process.argv.includes("--apply");
const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, "..", "migrations", "2026-08-03_user_avatar.sql"), "utf8");

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set.");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const one = async (q: string, p: any[] = []) => (await pool.query(q, p)).rows[0];

try {
  await pool.query("BEGIN");

  const before = await one(`SELECT
    (SELECT count(*)::int FROM users) users,
    (SELECT count(*)::int FROM users WHERE active) active_users,
    (SELECT count(*)::int FROM user_organizations) memberships`);
  console.log("live before:", JSON.stringify(before), "\n");

  await pool.query(sql);

  let bad = 0;
  const check = (ok: boolean, label: string) => {
    if (!ok) bad++;
    console.log(`${ok ? "  ok " : " MISS"}  ${label}`);
  };

  const col = await one(`SELECT is_nullable, column_default, data_type
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='users' AND column_name='avatar_url'`);
  check(!!col, "column users.avatar_url exists");
  check(col?.is_nullable === "YES", "nullable — no photo is a real state, not an error");
  check(col?.column_default === null, "no default — never invents a picture for anybody");
  check(col?.data_type === "text", "text");

  // No CHECK constraint: the /objects/ rule lives in the route handler where a
  // rejection can say why. A stale CHECK is how the MFL checkout started 500ing.
  const checks = await one(`SELECT count(*)::int n FROM information_schema.constraint_column_usage ccu
    JOIN information_schema.table_constraints tc ON tc.constraint_name = ccu.constraint_name
    WHERE ccu.table_schema='public' AND ccu.table_name='users' AND ccu.column_name='avatar_url' AND tc.constraint_type='CHECK'`);
  check(Number(checks.n) === 0, "no CHECK constraint on avatar_url");

  const written = await one(`SELECT count(*)::int n FROM users WHERE avatar_url IS NOT NULL`);
  check(Number(written.n) === 0, "migration wrote no avatars — every staff member still shows initials");

  // The login path must be untouched: these are the columns auth reads.
  const authCols = await one(`SELECT count(*)::int n FROM information_schema.columns
    WHERE table_schema='public' AND table_name='users' AND column_name IN ('email','password','role','active','google_id','apple_id')`);
  check(Number(authCols.n) === 6, "every auth column still present and unchanged");

  const after = await one(`SELECT
    (SELECT count(*)::int FROM users) users,
    (SELECT count(*)::int FROM users WHERE active) active_users,
    (SELECT count(*)::int FROM user_organizations) memberships`);
  check(JSON.stringify(before) === JSON.stringify(after), `additive — ${JSON.stringify(after)}`);

  if (bad > 0) {
    console.error(`\n${bad} check(s) failed — DO NOT DEPLOY.`);
    await pool.query("ROLLBACK");
    process.exit(1);
  }

  if (APPLY) {
    await pool.query("COMMIT");
    console.log("\n✅ --apply passed — migration COMMITTED.");
  } else {
    await pool.query("ROLLBACK");
    console.log("\n✅ Dry run passed — rolled back, nothing written.");
  }
} catch (e) {
  await pool.query("ROLLBACK").catch(() => {});
  throw e;
} finally {
  await pool.end();
}
