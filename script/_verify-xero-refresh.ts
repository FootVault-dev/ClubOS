// Prove the token refresh actually works — the thing that had never once run.
//   npx tsx --env-file=.env script/_verify-xero-refresh.ts
import { db } from "../server/db"; import { orgIntegrations } from "@shared/schema"; import { eq, and, sql } from "drizzle-orm";
import { getXeroForOrg } from "../server/xero";
(async () => {
  const read = async () => (await db.select().from(orgIntegrations).where(and(eq(orgIntegrations.provider,"xero"), eq(orgIntegrations.isActive,true))))[0];
  const before = await read();
  // Mark it dead so the clock check must fire.
  await db.execute(sql`UPDATE org_integrations SET token_expires_at = now() - interval '1 hour' WHERE provider='xero'`);
  const { xero, tenantId } = await getXeroForOrg(1);
  const org = await xero.accountingApi.getOrganisations(tenantId);
  const after = await read();
  const ok = [
    ["reached Xero after a forced refresh", !!org.body.organisations?.[0]?.name],
    ["the access token changed", before.accessToken !== after.accessToken],
    ["the refresh token ROTATED and was stored", before.refreshToken !== after.refreshToken],
    ["the new expiry is in the future", (after.tokenExpiresAt as any).getTime() > Date.now()],
    ["and within the next hour (not a timezone artefact)", (after.tokenExpiresAt as any).getTime() - Date.now() < 3600e3],
  ] as [string, boolean][];
  let fail = 0;
  for (const [l, c] of ok) { console.log(`  ${c ? "✅" : "❌"} ${l}`); if (!c) fail++; }
  console.log(`\n  org: ${org.body.organisations?.[0]?.name}`);
  console.log(`  expiry now: ${(after.tokenExpiresAt as any).toISOString()} (in ${Math.round(((after.tokenExpiresAt as any).getTime()-Date.now())/60000)} min)`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("FAILED", e?.message); process.exit(1); });
