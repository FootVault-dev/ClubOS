// Apply the staff-videos (in-house Loom) migration. ADDITIVE ONLY.
//
//   Rehearse:  npx tsx --env-file=.env script/apply-staff-videos.ts --dry-run
//   Apply:     npx tsx --env-file=.env script/apply-staff-videos.ts
//
// `--dry-run` runs the whole migration and every verification inside a
// transaction it then ROLLS BACK. Postgres DDL is transactional, so this proves
// the SQL parses and the organizations/users foreign keys resolve — while
// changing nothing. Run BEFORE fly deploy; never `db:push` against prod.
import { Pool } from "pg";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const DRY_RUN = process.argv.includes("--dry-run");

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, "..", "migrations", "2026-07-20_staff_videos.sql"), "utf8");

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
try {
  console.log(DRY_RUN ? "\nDRY RUN — everything below is rolled back.\n" : "\nAPPLYING to the database.\n");
  await pool.query("BEGIN");
  await pool.query(sql);

  let missing = 0;
  for (const t of ["staff_videos", "staff_video_events", "staff_video_comments"]) {
    const r = await pool.query("SELECT to_regclass($1) AS t", [t]);
    const ok = r.rows[0].t !== null;
    if (!ok) missing++;
    console.log(`${ok ? "  ok " : " MISS"}  table ${t}`);
  }
  for (const idx of [
    "staff_videos_token_key",
    "staff_videos_org_idx",
    "staff_videos_owner_idx",
    "staff_video_events_video_idx",
    "staff_video_events_viewer_idx",
    "staff_video_comments_video_idx",
  ]) {
    const r = await pool.query("SELECT 1 FROM pg_indexes WHERE indexname = $1", [idx]);
    const ok = r.rows.length > 0;
    if (!ok) missing++;
    console.log(`${ok ? "  ok " : " MISS"}  index ${idx}`);
  }

  // The token unique index is the load-bearing one — the share URL /v/{token}
  // must never resolve to two videos. Prove it's UNIQUE, not plain.
  const tok = await pool.query(
    `SELECT indexdef FROM pg_indexes WHERE indexname = 'staff_videos_token_key'`,
  );
  const tokOk = tok.rows.length > 0 && /UNIQUE/i.test(tok.rows[0].indexdef);
  if (!tokOk) missing++;
  console.log(`${tokOk ? "  ok " : " MISS"}  staff_videos_token_key is UNIQUE`);

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
    console.log("\nAll staff-video objects present. Safe to deploy.\n");
  }
} catch (e) {
  await pool.query("ROLLBACK").catch(() => {});
  throw e;
} finally {
  await pool.end();
}
