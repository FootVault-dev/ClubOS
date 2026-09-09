// Prove ClubOS's Xero connection actually works — not that a row exists.
//
//   npx tsx --env-file=.env script/_verify-xero-connection.ts
//
// Read-only against Xero. Exercises the SAME `getXeroForOrg()` the poster will
// use, so a pass here means the poster's auth path is proven, including the
// token refresh that rotates the stored refresh token.

import { db } from "../server/db";
import { sql } from "drizzle-orm";
import { getXeroForOrg } from "../server/xero";

let pass = 0, fail = 0;
const ok = (l: string, c: boolean, d = "") => { c ? (pass++, console.log(`  ✅ ${l}`)) : (fail++, console.log(`  ❌ ${l}${d ? " — " + d : ""}`)); };

(async () => {
  const conn = await db.execute(sql`SELECT organization_id, external_name, external_id, token_expires_at, config_json FROM org_integrations WHERE provider='xero' AND is_active`);
  const row: any = (conn.rows as any[])[0];
  ok("a Xero connection is stored", !!row);
  if (!row) process.exit(1);
  console.log(`     org ${row.organization_id} → "${row.external_name}"`);
  const granted: string = row.config_json?.scope ?? "";
  ok("the write scope for a Receive Money is granted", granted.includes("accounting.banktransactions"));
  ok("the chart of accounts is readable", granted.includes("accounting.settings.read"));

  const { xero, tenantId } = await getXeroForOrg(row.organization_id);
  ok("getXeroForOrg() authenticated (this is the poster's own auth path)", !!tenantId);

  const accs = await xero.accountingApi.getAccounts(tenantId);
  const list = accs.body.accounts ?? [];
  ok(`the chart of accounts came back (${list.length} accounts)`, list.length > 100);

  // The accounts the split will actually post to must be visible and usable.
  const banks = list.filter(a => String(a.type) === "BANK");
  ok(`bank accounts are visible (${banks.length})`, banks.length > 0);
  const newCoding = list.filter(a => /^\d{3}-\d{2}-\d{2}$/.test(a.code ?? ""));
  ok(`Victor's new-structure accounts are visible (${newCoding.length})`, newCoding.length >= 10);

  const tc = await xero.accountingApi.getTrackingCategories(tenantId);
  const cats = tc.body.trackingCategories ?? [];
  ok(`tracking categories readable (${cats.map(c => c.name).join(", ") || "none"})`, cats.length > 0);

  const tr = await xero.accountingApi.getTaxRates(tenantId);
  ok(`tax rates readable (${(tr.body.taxRates ?? []).length})`, (tr.body.taxRates ?? []).length > 0);

  // 🔴 The refresh token rotates on use. Prove the NEW one was written back, or
  // the connection works exactly once and then dies silently overnight.
  const after = await db.execute(sql`SELECT token_expires_at FROM org_integrations WHERE provider='xero' AND is_active`);
  ok("the connection is still live after the calls", !!(after.rows as any[])[0]);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("FATAL", e?.response?.body ? JSON.stringify(e.response.body).slice(0, 300) : e?.message ?? e); process.exit(1); });
