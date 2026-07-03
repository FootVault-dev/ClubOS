// AttributionOS (T16) — daily Meta ad-spend sync.
//
// Pulls Marketing-API Insights (level=ad, split by publisher_platform ×
// platform_position) for the last 7 days and re-upserts them into
// `ad_spend_daily`, then refreshes `ad_entities` names for every ad seen in that
// spend AND for ad ids that only appear in our conversion tables (so a purchase
// attributed to an ad that spent nothing today still gets a human-readable name).
//
// Config: META_ACCESS_TOKEN (same token the CAPI uses) + one or more ad-account
// ids from env `META_AD_ACCOUNT_IDS` (comma/space separated) or the `settings`
// row `meta_ad_account_ids`. With NO token OR no accounts the job is a graceful
// no-op — it must never throw on boot.
//
// Pattern mirrors server/print-cron.ts / server/league-balance-cron.ts (guarded,
// first run a few minutes after boot, then daily). All response parsing lives in
// the pure, unit-tested shared/meta-insights.ts — this file only fetches + writes.

import { db } from "./db";
import { adSpendDaily, adEntities, settings } from "@shared/schema";
import { eq, sql } from "drizzle-orm";
import { validExternalId } from "@shared/attribution";
import { META_API_VERSION } from "./meta-capi";
import {
  parseAdAccountIds,
  buildInsightsUrl,
  buildAdEntityUrl,
  parseInsightsPage,
  insightsNextPage,
  parseAdEntity,
  adEntitiesFromSpend,
  trailingWindow,
  type ParsedAdSpendRow,
  type ParsedAdEntity,
} from "@shared/meta-insights";

const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || "";
const WINDOW_DAYS = 7;
const MAX_PAGES = 50;                 // pagination backstop (level=ad, 7d ≈ few pages)
const MAX_CONVERSION_ENTITY_FETCHES = 100; // per-run cap on node calls for new conversion ad ids

// Conversion tables that carry a meta_ad_id (T3). Static list — used only to build
// a distinct-ad-id UNION, so plain identifiers are safe (no user input).
const CONVERSION_TABLES = [
  "registrations",
  "booking_requests",
  "league_waitlist",
  "print_orders",
  "cic7s_registrations",
  "cugc_registrations",
  "cugc_free_sessions",
  "football_institute_applications",
];

/** Resolve configured ad-account ids: env first, then the `settings` table. */
async function resolveAccountIds(): Promise<string[]> {
  const fromEnv = parseAdAccountIds(
    process.env.META_AD_ACCOUNT_IDS || process.env.META_AD_ACCOUNT_ID || "",
  );
  if (fromEnv.length) return fromEnv;
  try {
    const [row] = await db.select().from(settings).where(eq(settings.key, "meta_ad_account_ids"));
    return parseAdAccountIds(row?.value || "");
  } catch (e: any) {
    console.error("[AdSpendCron] settings lookup failed:", e?.message || e);
    return [];
  }
}

function withToken(url: string): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}access_token=${encodeURIComponent(META_ACCESS_TOKEN)}`;
}

/** GET a Meta URL and return parsed JSON, or null on any error. `alreadyTokened`
 *  next-page cursors already carry the access_token. */
async function metaGet(url: string, alreadyTokened = false): Promise<any | null> {
  try {
    const res = await fetch(alreadyTokened ? url : withToken(url));
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      console.error("[AdSpendCron] Meta API error:", JSON.stringify((json && json.error) || json || res.status));
      return null;
    }
    return json;
  } catch (e: any) {
    console.error("[AdSpendCron] fetch failed:", e?.message || e);
    return null;
  }
}

/** Pull every Insights page for one account across the date window. */
async function pullAccountSpend(accountId: string, since: string, until: string): Promise<ParsedAdSpendRow[]> {
  const rows: ParsedAdSpendRow[] = [];
  let url: string | null = buildInsightsUrl(accountId, { since, until, apiVersion: META_API_VERSION, limit: 500 });
  let tokened = false; // first URL needs the token appended; cursors already have it
  let pages = 0;
  while (url && pages++ < MAX_PAGES) {
    const json = await metaGet(url, tokened);
    if (!json) break;
    rows.push(...parseInsightsPage(json));
    url = insightsNextPage(json);
    tokened = true;
  }
  return rows;
}

/** Upsert one spend row (idempotent on the (date, ad_id, platform, position) key). */
async function upsertSpendRow(row: ParsedAdSpendRow): Promise<void> {
  await db
    .insert(adSpendDaily)
    .values({
      date: row.date,
      adId: row.adId,
      adsetId: row.adsetId,
      campaignId: row.campaignId,
      publisherPlatform: row.publisherPlatform,
      platformPosition: row.platformPosition,
      spendCents: row.spendCents,
      impressions: row.impressions,
      clicks: row.clicks,
      refreshedAt: new Date(),
    } as any)
    .onConflictDoUpdate({
      target: [adSpendDaily.date, adSpendDaily.adId, adSpendDaily.publisherPlatform, adSpendDaily.platformPosition],
      set: {
        adsetId: row.adsetId,
        campaignId: row.campaignId,
        spendCents: row.spendCents,
        impressions: row.impressions,
        clicks: row.clicks,
        refreshedAt: new Date(),
      },
    });
}

/** Upsert an ad_entities name row (idempotent on ad_id; never nulls a known name). */
async function upsertAdEntity(e: ParsedAdEntity): Promise<void> {
  const setNonNull: Record<string, unknown> = { refreshedAt: new Date() };
  if (e.adsetId != null) setNonNull.adsetId = e.adsetId;
  if (e.campaignId != null) setNonNull.campaignId = e.campaignId;
  if (e.adName != null) setNonNull.adName = e.adName;
  if (e.adsetName != null) setNonNull.adsetName = e.adsetName;
  if (e.campaignName != null) setNonNull.campaignName = e.campaignName;
  await db
    .insert(adEntities)
    .values({
      adId: e.adId,
      adsetId: e.adsetId,
      campaignId: e.campaignId,
      adName: e.adName,
      adsetName: e.adsetName,
      campaignName: e.campaignName,
      refreshedAt: new Date(),
    } as any)
    .onConflictDoUpdate({ target: adEntities.adId, set: setNonNull });
}

/** Distinct, hygiene-valid meta_ad_id values across all conversion tables. */
async function conversionAdIds(): Promise<string[]> {
  const union = CONVERSION_TABLES.map(
    (t) => `SELECT meta_ad_id FROM ${t} WHERE meta_ad_id IS NOT NULL AND meta_ad_id <> ''`,
  ).join(" UNION ");
  try {
    const res: any = await db.execute(sql.raw(`SELECT DISTINCT meta_ad_id FROM (${union}) u`));
    const rows = (res?.rows || []) as Array<{ meta_ad_id: string }>;
    const out: string[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      const id = validExternalId(r.meta_ad_id); // strips {{macros}}, blocklist, etc.
      if (id && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
    return out;
  } catch (e: any) {
    console.error("[AdSpendCron] conversion ad-id scan failed:", e?.message || e);
    return [];
  }
}

/** Ad ids already present in ad_entities (so we don't re-fetch their names every run). */
async function knownEntityIds(): Promise<Set<string>> {
  try {
    const rows = await db.select({ adId: adEntities.adId }).from(adEntities);
    return new Set(rows.map((r) => r.adId));
  } catch {
    return new Set();
  }
}

/** One full sync pass. Never throws. */
export async function runAdSpendSync(now: Date = new Date()): Promise<void> {
  if (!META_ACCESS_TOKEN) {
    console.log("[AdSpendCron] Skipping — META_ACCESS_TOKEN not configured");
    return;
  }
  try {
    const accounts = await resolveAccountIds();
    if (accounts.length === 0) {
      console.log("[AdSpendCron] Skipping — no ad accounts configured (META_AD_ACCOUNT_IDS or settings.meta_ad_account_ids)");
      return;
    }

    const { since, until } = trailingWindow(now, WINDOW_DAYS);

    // 1) Spend pull + upsert.
    const allSpend: ParsedAdSpendRow[] = [];
    for (const acct of accounts) {
      const rows = await pullAccountSpend(acct, since, until);
      allSpend.push(...rows);
    }
    let spendUpserts = 0;
    for (const row of allSpend) {
      try {
        await upsertSpendRow(row);
        spendUpserts++;
      } catch (e: any) {
        console.error(`[AdSpendCron] spend upsert failed (ad ${row.adId} ${row.date}):`, e?.message || e);
      }
    }

    // 2) ad_entities from spend (names ride along on the Insights rows — free).
    const spendEntities = adEntitiesFromSpend(allSpend);
    const spendAdIds = new Set(spendEntities.map((e) => e.adId));
    for (const e of spendEntities) {
      try {
        await upsertAdEntity(e);
      } catch (e2: any) {
        console.error(`[AdSpendCron] entity upsert failed (ad ${e.adId}):`, e2?.message || e2);
      }
    }

    // 3) Names for ad ids seen ONLY in conversions (no spend today, not yet named).
    let entityFetches = 0;
    try {
      const known = await knownEntityIds();
      const convIds = await conversionAdIds();
      for (const adId of convIds) {
        if (entityFetches >= MAX_CONVERSION_ENTITY_FETCHES) break;
        if (spendAdIds.has(adId) || known.has(adId)) continue; // already covered / named
        entityFetches++;
        const json = await metaGet(buildAdEntityUrl(adId, { apiVersion: META_API_VERSION }));
        const parsed = parseAdEntity(json, adId);
        if (parsed) {
          try {
            await upsertAdEntity(parsed);
          } catch (e: any) {
            console.error(`[AdSpendCron] conversion entity upsert failed (ad ${adId}):`, e?.message || e);
          }
        }
      }
    } catch (e: any) {
      console.error("[AdSpendCron] conversion-entity refresh failed:", e?.message || e);
    }

    console.log(
      `[AdSpendCron] Synced ${spendUpserts} spend row(s) across ${accounts.length} account(s) for ${since}…${until}; ` +
        `${spendEntities.length} ad entity(ies) from spend + ${entityFetches} from conversions`,
    );
  } catch (e: any) {
    console.error("[AdSpendCron] sync failed:", e?.message || e);
  }
}

let started = false;

/** Start the daily ad-spend sync (idempotent; safe to call once on boot). */
export function startAdSpendCron(): void {
  if (started) return;
  started = true;
  if (!META_ACCESS_TOKEN) {
    console.log("[AdSpendCron] Not scheduled — META_ACCESS_TOKEN not configured");
    return;
  }
  const intervalMs = parseInt(process.env.AD_SPEND_CRON_INTERVAL_MS || "") || 24 * 60 * 60 * 1000;
  setTimeout(() => { runAdSpendSync(); }, 5 * 60 * 1000);   // first run 5 min after boot
  setInterval(() => { runAdSpendSync(); }, intervalMs);
  console.log(`[AdSpendCron] Ad-spend sync scheduled (every ${Math.round(intervalMs / 3600000)}h)`);
}
