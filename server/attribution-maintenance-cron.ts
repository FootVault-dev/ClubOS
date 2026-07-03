// AttributionOS (T21) — nightly data-quality guards for the attribution spine.
//
// Three jobs, each independent and defensive (one failing never blocks the
// others, and the whole pass never throws — same posture as the other crons):
//
//  1. prunePageViews()  — delete raw page_view/scroll rows older than 13 months
//     that carry NO attribution value (not touch-bearing, not stitched to a
//     person). Keeps session_start, alias, touch-bearing and conversion-linked
//     rows forever. Batched so the delete never takes a long table lock.
//
//  2. backfillBotFlags() — bot detection runs per-event at ingest (T6) off the
//     request UA + the client webdriver hint, but a bot's later click/scroll
//     events can slip through with is_bot=false. Backstop: if ANY of a visitor's
//     recent events is flagged a bot, flag them all.
//
//  3. repairShortLinkCounters() — the short_links cached counters (clicks/leads/
//     sales/sale_amount_cents) drift (a counter bump can fail; leads/sales are
//     only ever materialised here). Recompute them from the actuals in
//     link_clicks + the 8 conversion tables and repair any that disagree.
//
// Pattern mirrors server/api-security.ts (nightly prune) / server/ad-spend-cron.ts
// (guarded start, first run shortly after boot, then daily). All DB glue — no
// pure logic worth a unit test; the gate is `npm run build`.

import { db } from "./db";
import { shortLinks } from "@shared/schema";
import { eq, sql } from "drizzle-orm";

// ── Tunables ─────────────────────────────────────────────────────────────────
const PAGE_VIEW_RETENTION_MONTHS = 13;      // keep at least a full year + a month
const PRUNE_BATCH = 5000;                   // rows per delete pass (avoid long locks)
const PRUNE_MAX_BATCHES = 400;              // backstop: ≤2M rows/run
const BOT_BACKFILL_WINDOW_DAYS = 35;        // only re-scan recent rows (cheap, indexable)

// The 8 conversion/lead tables (T3), each with a click_id column. Static list —
// used only to build a fixed UNION, so plain identifiers are safe (no user input).
// `is_lead` + `rev` (cents) match server/attribution-reports.ts revenue truth:
// confirmed registrations / paid cugc / paid print are SALES (carry revenue);
// everything else — and unpaid print enquiries — are LEADS.
const CONVERSION_UNION = sql`
  SELECT click_id, false AS is_lead, COALESCE(total_cents, 0) AS rev
    FROM registrations WHERE status = 'confirmed' AND click_id IS NOT NULL
  UNION ALL
  SELECT click_id, false, COALESCE(price_cents, 0)
    FROM cugc_registrations WHERE status = 'paid' AND click_id IS NOT NULL
  UNION ALL
  SELECT click_id, (COALESCE(paid_cents, 0) = 0), COALESCE(paid_cents, 0)
    FROM print_orders WHERE click_id IS NOT NULL
  UNION ALL
  SELECT click_id, true, 0 FROM cugc_free_sessions WHERE click_id IS NOT NULL
  UNION ALL
  SELECT click_id, true, 0 FROM league_waitlist WHERE click_id IS NOT NULL
  UNION ALL
  SELECT click_id, true, 0 FROM cic7s_registrations WHERE click_id IS NOT NULL
  UNION ALL
  SELECT click_id, true, 0 FROM football_institute_applications WHERE click_id IS NOT NULL
  UNION ALL
  SELECT click_id, true, 0 FROM booking_requests WHERE click_id IS NOT NULL
`;

// ── 1. Prune stale, value-less page_view / scroll rows ───────────────────────
/** Delete old raw page_view/scroll events with no attribution value. Batched.
 *  Returns the number of rows deleted. Never throws. */
export async function prunePageViews(): Promise<number> {
  let deleted = 0;
  try {
    for (let batch = 0; batch < PRUNE_MAX_BATCHES; batch++) {
      const res: any = await db.execute(sql`
        DELETE FROM analytics_events
        WHERE id IN (
          SELECT id FROM analytics_events
          WHERE event_type IN ('page_view', 'scroll')
            AND timestamp < now() - make_interval(months => ${PAGE_VIEW_RETENTION_MONTHS})
            AND person_id IS NULL      -- not conversion-linked
            AND channel   IS NULL      -- not touch-bearing…
            AND click_id  IS NULL
            AND fbclid    IS NULL
            AND gclid     IS NULL
          LIMIT ${PRUNE_BATCH}
        )
      `);
      const n = res?.rowCount ?? 0;
      deleted += n;
      if (n < PRUNE_BATCH) break; // last (partial) batch drained the eligible rows
    }
    if (deleted) console.log(`[AttrMaintenance] pruned ${deleted} stale page_view/scroll row(s)`);
  } catch (e: any) {
    console.error("[AttrMaintenance] prune failed:", e?.message || e);
  }
  return deleted;
}

// ── 2. Bot-flag backstop ─────────────────────────────────────────────────────
/** Propagate a confirmed bot flag across all of a visitor's recent events.
 *  Returns rows newly flagged. Never throws. */
export async function backfillBotFlags(): Promise<number> {
  try {
    const res: any = await db.execute(sql`
      UPDATE analytics_events
      SET is_bot = true
      WHERE is_bot = false
        AND timestamp > now() - make_interval(days => ${BOT_BACKFILL_WINDOW_DAYS})
        AND visitor_id IN (
          SELECT DISTINCT visitor_id FROM analytics_events
          WHERE is_bot = true
            AND timestamp > now() - make_interval(days => ${BOT_BACKFILL_WINDOW_DAYS})
        )
    `);
    const n = res?.rowCount ?? 0;
    if (n) console.log(`[AttrMaintenance] bot backstop flagged ${n} row(s)`);
    return n;
  } catch (e: any) {
    console.error("[AttrMaintenance] bot backstop failed:", e?.message || e);
    return 0;
  }
}

// ── 3. Short-link counter reconciliation ─────────────────────────────────────
/** Recompute short_links cached counters from actuals and repair any that drift.
 *  Returns the number of links updated. Never throws. */
export async function repairShortLinkCounters(): Promise<number> {
  try {
    // Actual non-bot clicks per link.
    const clickRes: any = await db.execute(sql`
      SELECT link_id, count(*)::int AS clicks
      FROM link_clicks
      WHERE is_bot = false
      GROUP BY link_id
    `);
    const clicksByLink = new Map<number, number>();
    for (const r of (clickRes?.rows || []) as Array<{ link_id: number; clicks: number }>) {
      clicksByLink.set(Number(r.link_id), Number(r.clicks) || 0);
    }

    // Actual leads / sales / sale revenue per link, matched by the non-bot click
    // ids the link minted (click_id is unique → one click id maps to one link).
    const convRes: any = await db.execute(sql`
      WITH cl AS (
        SELECT link_id, click_id FROM link_clicks
        WHERE is_bot = false AND click_id IS NOT NULL
      ),
      conv AS (${CONVERSION_UNION})
      SELECT cl.link_id,
             count(*) FILTER (WHERE NOT conv.is_lead)::int          AS sales,
             count(*) FILTER (WHERE conv.is_lead)::int              AS leads,
             COALESCE(sum(conv.rev) FILTER (WHERE NOT conv.is_lead), 0)::bigint AS sale_amount_cents
      FROM conv JOIN cl ON cl.click_id = conv.click_id
      GROUP BY cl.link_id
    `);
    const convByLink = new Map<number, { sales: number; leads: number; saleAmountCents: number }>();
    for (const r of (convRes?.rows || []) as Array<{
      link_id: number; sales: number; leads: number; sale_amount_cents: number | string;
    }>) {
      convByLink.set(Number(r.link_id), {
        sales: Number(r.sales) || 0,
        leads: Number(r.leads) || 0,
        saleAmountCents: Number(r.sale_amount_cents) || 0,
      });
    }

    // Compare against the cached counters and repair drift only.
    const links = await db
      .select({
        id: shortLinks.id,
        clicks: shortLinks.clicks,
        leads: shortLinks.leads,
        sales: shortLinks.sales,
        saleAmountCents: shortLinks.saleAmountCents,
      })
      .from(shortLinks);

    let repaired = 0;
    for (const link of links) {
      const clicks = clicksByLink.get(link.id) ?? 0;
      const conv = convByLink.get(link.id) ?? { sales: 0, leads: 0, saleAmountCents: 0 };
      if (
        link.clicks === clicks &&
        link.leads === conv.leads &&
        link.sales === conv.sales &&
        link.saleAmountCents === conv.saleAmountCents
      ) {
        continue; // already accurate
      }
      await db
        .update(shortLinks)
        .set({
          clicks,
          leads: conv.leads,
          sales: conv.sales,
          saleAmountCents: conv.saleAmountCents,
        })
        .where(eq(shortLinks.id, link.id));
      repaired++;
    }
    if (repaired) console.log(`[AttrMaintenance] repaired counters on ${repaired} short link(s)`);
    return repaired;
  } catch (e: any) {
    console.error("[AttrMaintenance] short-link counter repair failed:", e?.message || e);
    return 0;
  }
}

// ── Orchestration ────────────────────────────────────────────────────────────
/** One full maintenance pass. Never throws. */
export async function runAttributionMaintenance(): Promise<void> {
  await prunePageViews();
  await backfillBotFlags();
  await repairShortLinkCounters();
}

let started = false;

/** Start the nightly attribution-maintenance cron (idempotent). */
export function startAttributionMaintenanceCron(): void {
  if (started) return;
  started = true;
  const intervalMs =
    parseInt(process.env.ATTR_MAINTENANCE_CRON_INTERVAL_MS || "") || 24 * 60 * 60 * 1000;
  setTimeout(() => { runAttributionMaintenance(); }, 10 * 60 * 1000); // 10 min after boot
  setInterval(() => { runAttributionMaintenance(); }, intervalMs);
  console.log(
    `[AttrMaintenance] Data-quality guards scheduled (every ${Math.round(intervalMs / 3600000)}h)`,
  );
}
