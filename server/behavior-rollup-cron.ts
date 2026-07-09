// Total Tracking Platform, Phase 1 (Behavioral Depth) — nightly rollup +
// partition maintenance + prune cron (T7). Reads the raw `behavior_events`
// table ONLY; the ClubOS "Behavior" tab and any agent read the `*_daily`
// rollup tables this cron writes, never the raw table (AGENTS.md North star).
//
// Three jobs, each independently guarded (one failing never blocks the
// others, and the whole pass never throws) — same posture as
// server/attribution-maintenance-cron.ts:
//
//  1. runBehaviorRollups()          — recompute "yesterday" (NZ local date)
//     across the 5 shared/behavior-rollups.ts builders via the raw pg.Pool
//     (drizzle-orm 0.39's sql.raw() takes no params arg — see T4 Lessons
//     learned). 4 of the 5 are idempotent full-overwrite upserts; the 5th
//     (hour_of_day_profile) is a deliberate rolling INCREMENT that must NOT
//     be re-run for the same day twice. A watermark in the existing generic
//     `settings` key/value table (behavior_rollup_last_day) guards ALL 5
//     against a same-day re-run (e.g. a redeploy firing the +15min boot
//     timer again before the next scheduled 24h tick) — simpler than
//     special-casing just the increment one, and harmless for the other 4
//     since skipping them on a genuine re-run just means "nothing to redo".
//
//  2. ensureNextBehaviorPartition()  — CREATE TABLE IF NOT EXISTS next
//     month's `behavior_events_YYYY_MM` partition. No pg_partman; running
//     this daily means the platform is never more than a few weeks from
//     running out of a partition to write into, per the migration's header
//     warning. Table/date literals are inlined (not parameterised — DDL
//     identifiers can't be bound params) but are guarded by a strict regex
//     before interpolation; both are pure JS Date computations, never
//     user input.
//
//  3. pruneOldBehaviorPartitions()   — DROP the whole monthly partition once
//     it's older than the 13-month retention window (AGENTS.md §5 — "the
//     ONE allowed drop, whole old partition only"). Discovers partitions via
//     pg_inherits (not a hardcoded list) but only ever acts on a relname
//     that matches `behavior_events_YYYY_MM` exactly, so it can never touch
//     the parent table or an unrelated relation.
//
// Registered in server/index.ts after the attribution-maintenance cron.

import { pool, db } from "./db";
import { settings } from "@shared/schema";
import { eq } from "drizzle-orm";
import { ROLLUP_BUILDERS } from "@shared/behavior-rollups";

// ── Tunables ─────────────────────────────────────────────────────────────────
const PARTITION_RETENTION_MONTHS = 13;
const WATERMARK_KEY = "behavior_rollup_last_day";
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const PARTITION_NAME_RE = /^behavior_events_(\d{4})_(\d{2})$/;

// ── 1. Nightly rollup recompute ──────────────────────────────────────────────

/** "Yesterday" as a YYYY-MM-DD string in NZ local time (matches the
 *  hour_of_day_profile builder's own `AT TIME ZONE 'Pacific/Auckland'`
 *  bucketing, so the day boundary used to select rows lines up with the
 *  day boundary used to bucket them). */
async function getYesterdayNZ(): Promise<string> {
  const res: any = await pool.query(
    `SELECT to_char((now() AT TIME ZONE 'Pacific/Auckland' - interval '1 day')::date, 'YYYY-MM-DD') AS day`,
  );
  return String(res.rows[0].day);
}

async function getWatermark(): Promise<string | null> {
  const [row] = await db.select().from(settings).where(eq(settings.key, WATERMARK_KEY));
  return row?.value ?? null;
}

async function setWatermark(day: string): Promise<void> {
  await db
    .insert(settings)
    .values({ key: WATERMARK_KEY, value: day })
    .onConflictDoUpdate({ target: settings.key, set: { value: day, updatedAt: new Date() } });
}

/** Recompute yesterday's 5 rollups. Skips entirely (logged, not an error) if
 *  that day was already rolled up — see file header. Never throws; each
 *  builder's failure is caught independently so one bad rollup doesn't
 *  block the others or the watermark write for the ones that succeeded. */
export async function runBehaviorRollups(): Promise<void> {
  try {
    const day = await getYesterdayNZ();
    if (!DAY_RE.test(day)) {
      console.error("[BehaviorRollup] unexpected day value from DB:", day);
      return;
    }
    const already = await getWatermark();
    if (already === day) {
      console.log(`[BehaviorRollup] ${day} already rolled up, skipping re-run`);
      return;
    }
    let failed = 0;
    for (const { name, build } of ROLLUP_BUILDERS) {
      try {
        const { text, params } = build(day);
        await pool.query(text, params);
      } catch (e: any) {
        failed++;
        console.error(`[BehaviorRollup] "${name}" rollup failed for ${day}:`, e?.message || e);
      }
    }
    await setWatermark(day);
    console.log(`[BehaviorRollup] recomputed rollups for ${day}${failed ? ` (${failed} builder(s) failed — see above)` : ""}`);
  } catch (e: any) {
    console.error("[BehaviorRollup] rollup pass failed:", e?.message || e);
  }
}

// ── 2. Partition maintenance ─────────────────────────────────────────────────

function monthStartUTC(base: Date, monthOffset: number): string {
  const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + monthOffset, 1));
  return d.toISOString().slice(0, 10);
}

/** Ensure next month's `behavior_events` partition exists. Idempotent
 *  (CREATE TABLE IF NOT EXISTS). Never throws. */
export async function ensureNextBehaviorPartition(): Promise<void> {
  try {
    const now = new Date();
    const from = monthStartUTC(now, 1);
    const to = monthStartUTC(now, 2);
    if (!DAY_RE.test(from) || !DAY_RE.test(to)) return; // defensive — should be unreachable
    const [y, m] = from.split("-");
    const name = `behavior_events_${y}_${m}`;
    if (!PARTITION_NAME_RE.test(name)) return; // defensive — should be unreachable
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${name} PARTITION OF behavior_events FOR VALUES FROM ('${from}') TO ('${to}')`,
    );
  } catch (e: any) {
    console.error("[BehaviorRollup] partition maintenance failed:", e?.message || e);
  }
}

// ── 3. Prune partitions older than the retention window ─────────────────────

/** Drop whole monthly `behavior_events_YYYY_MM` partitions once every row in
 *  them is older than PARTITION_RETENTION_MONTHS. Discovers partitions via
 *  pg_inherits so it's correct even if the initial migration's 3-partition
 *  seed was later extended by hand; only ever acts on a relname that matches
 *  the exact monthly-partition pattern (guards against ever touching the
 *  parent table itself or an unrelated relation). Never throws. */
export async function pruneOldBehaviorPartitions(): Promise<string[]> {
  const dropped: string[] = [];
  try {
    const res: any = await pool.query(`
      SELECT c.relname AS name
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class p ON p.oid = i.inhparent
      WHERE p.relname = 'behavior_events'
    `);
    const now = new Date();
    const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - PARTITION_RETENTION_MONTHS, 1));
    for (const row of (res?.rows || []) as Array<{ name: string }>) {
      const m = PARTITION_NAME_RE.exec(row.name);
      if (!m) continue; // guard: only ever touch exactly-matching monthly partitions
      const partitionMonthStart = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
      if (partitionMonthStart < cutoff) {
        await pool.query(`DROP TABLE IF EXISTS ${row.name}`);
        dropped.push(row.name);
      }
    }
    if (dropped.length) {
      console.log(
        `[BehaviorRollup] dropped ${dropped.length} partition(s) older than ${PARTITION_RETENTION_MONTHS} months: ${dropped.join(", ")}`,
      );
    }
  } catch (e: any) {
    console.error("[BehaviorRollup] partition prune failed:", e?.message || e);
  }
  return dropped;
}

// ── Orchestration ────────────────────────────────────────────────────────────

/** One full maintenance pass. Never throws. */
export async function runBehaviorMaintenance(): Promise<void> {
  await runBehaviorRollups();
  await ensureNextBehaviorPartition();
  await pruneOldBehaviorPartitions();
}

let started = false;

/** Start the nightly behavioral-rollup cron (idempotent). */
export function startBehaviorRollupCron(): void {
  if (started) return;
  started = true;
  const intervalMs =
    parseInt(process.env.BEHAVIOR_ROLLUP_CRON_INTERVAL_MS || "") || 24 * 60 * 60 * 1000;
  // 15 min after boot — staggered 5 min after the attribution-maintenance
  // cron's own 10-min boot timer so the two nightly passes don't land on the
  // DB in the same tick.
  setTimeout(() => { runBehaviorMaintenance(); }, 15 * 60 * 1000);
  setInterval(() => { runBehaviorMaintenance(); }, intervalMs);
  console.log(
    `[BehaviorRollup] Nightly behavioral rollups scheduled (every ${Math.round(intervalMs / 3600000)}h)`,
  );
}
