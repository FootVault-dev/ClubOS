// Pull the LIVE Xero chart of accounts + tracking categories through the ClubOS
// connection and save a dated snapshot. Read-only against Xero; the only write is
// the rotated refresh token, which getXeroForOrg() persists.
//   npx tsx --env-file=.env script/_xero-chart-snapshot.ts [orgId]
import fs from "node:fs";
import path from "node:path";
import { db } from "../server/db";
import { orgIntegrations, codingAccounts } from "@shared/schema";
import { eq, sql } from "drizzle-orm";
import { getXeroForOrg } from "../server/xero";

(async () => {
  const rows = await db.select({
    id: orgIntegrations.id, org: orgIntegrations.organizationId, active: orgIntegrations.isActive,
    tenant: orgIntegrations.externalId, exp: orgIntegrations.tokenExpiresAt, upd: orgIntegrations.updatedAt,
  }).from(orgIntegrations).where(eq(orgIntegrations.provider, "xero"));
  console.log("xero connections:", JSON.stringify(rows));

  const stats = await db.execute(sql`select count(*)::int total, count(xero_account_code)::int with_code,
    count(xero_account)::int with_name, count(xero_tracking)::int with_tracking,
    count(*) filter (where postable)::int postable, count(gst_treatment)::int with_gst from coding_accounts`);
  console.log("coding_accounts:", JSON.stringify(stats.rows[0]));

  const orgId = Number(process.argv[2] ?? rows.find(r => r.active)?.org);
  if (!orgId) { console.log("no active Xero connection"); process.exit(1); }
  const { xero, tenantId } = await getXeroForOrg(orgId);

  const out: any = { pulledAt: new Date().toISOString(), orgId, tenantId };
  try {
    const org = await xero.accountingApi.getOrganisations(tenantId);
    out.organisation = org.body.organisations?.[0];
    console.log("organisation:", out.organisation?.name, "| base currency", out.organisation?.baseCurrency, "| FY end", out.organisation?.financialYearEndDay, "/", out.organisation?.financialYearEndMonth);
  } catch (e: any) { console.log("organisation FAILED:", e?.response?.statusCode ?? e?.message); }
  try {
    const acc = await xero.accountingApi.getAccounts(tenantId);
    out.accounts = acc.body.accounts ?? [];
    console.log("accounts:", out.accounts.length);
  } catch (e: any) { console.log("accounts FAILED:", e?.response?.statusCode ?? e?.message, JSON.stringify(e?.response?.body ?? "").slice(0, 300)); }
  try {
    const tc = await xero.accountingApi.getTrackingCategories(tenantId, undefined, undefined, true);
    out.tracking = tc.body.trackingCategories ?? [];
    console.log("tracking categories:", out.tracking.length);
  } catch (e: any) { console.log("tracking FAILED:", e?.response?.statusCode ?? e?.message); }
  try {
    const tr = await xero.accountingApi.getTaxRates(tenantId);
    out.taxRates = tr.body.taxRates ?? [];
    console.log("tax rates:", out.taxRates.length);
  } catch (e: any) { console.log("tax rates FAILED:", e?.response?.statusCode ?? e?.message); }

  if (out.accounts) {
    const dir = path.resolve(__dirname, "../../../outputs/coding-budget/2026-09-09-xero-chart");
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, "xero-chart-snapshot.json");
    fs.writeFileSync(f, JSON.stringify(out, null, 1));
    console.log("saved", f);
  }
  process.exit(0);
})().catch(e => { console.error("FATAL", e?.message ?? e); process.exit(1); });
