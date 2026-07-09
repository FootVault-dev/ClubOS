# Migrations to apply to Supabase prod — BEFORE the Fly deploy

Phase 1 (Behavioral Depth) adds two **additive, idempotent** migration files. Apply them to
the ClubOS prod DB **before** deploying the code (the new code reads/writes these tables).
Both are `CREATE TABLE/INDEX IF NOT EXISTS` only — safe to re-run, no data loss. Never `db:push`.

Apply **in this order**:

1. `migrations/2026-07-10_behavior_events.sql`
   — the raw `behavior_events` table, monthly RANGE-partitioned on `ts`, + the current & next 2
   monthly partitions + 4 parent indexes. Written to ONLY by `POST /api/public/analytics/behavior`.

2. `migrations/2026-07-10_behavior_rollups.sql`
   — the 5 rollup tables the dashboards read: `page_stats_daily`, `section_stats_daily`,
   `click_stats_daily`, `journey_edges_daily`, `hour_of_day_profile` (each with its idempotent
   upsert unique index).

## How to apply (the repo's `pg` + DATABASE_URL pattern)

From `apps/clubos`, run each file in a transaction (rolls back on any error):

```bash
for f in migrations/2026-07-10_behavior_events.sql migrations/2026-07-10_behavior_rollups.sql; do
  MIG="$f" node -e '
    const fs=require("fs"),pg=require("pg");
    const env=Object.fromEntries(fs.readFileSync(".env","utf8").split("\n").filter(l=>l.includes("=")&&!l.trimStart().startsWith("#")).map(l=>{const i=l.indexOf("=");return[l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^["\x27]|["\x27]$/g,"")]}));
    const sql=fs.readFileSync(process.env.MIG,"utf8");
    const p=new pg.Pool({connectionString:env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
    (async()=>{const c=await p.connect();try{await c.query("BEGIN");await c.query(sql);await c.query("COMMIT");console.log("OK",process.env.MIG);}catch(e){await c.query("ROLLBACK");console.error("FAIL",e.message);process.exit(1);}finally{c.release();await p.end();}})();
  ' || break
done
```

## After deploy
- The nightly `server/behavior-rollup-cron.ts` (registered in `server/index.ts`) computes the rollups,
  creates next month's partition, and drops partitions older than 13 months. It is guarded + never throws.
- Dashboards (the ClubOS **Behavior** tab) read ONLY the `*_daily` rollup tables, so they stay empty
  until the first nightly rollup runs (or you trigger it) even once `behavior_events` has raw data.
- **Ongoing ops:** if the rollup cron is ever paused for >1 month, manually add the next
  `CREATE TABLE ... PARTITION OF behavior_events ...` before writes to that month begin, or inserts
  fail with "no partition found for row" (see the header of the events migration).
