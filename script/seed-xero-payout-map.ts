// Seed the Stripe payout → Xero mapping skeleton and the external-source rules.
//
//   npx tsx --env-file=.env script/seed-xero-payout-map.ts            # dry run
//   npx tsx --env-file=.env script/seed-xero-payout-map.ts --commit
//
// 🔴 Seeds every category with NO account code. The codes are Victor's to give
// and a plausible guess is worse than a blank: a wrong account still balances,
// so it would never be noticed. `confirmed_by` stays NULL until a human says so,
// and the poster refuses to post a category nobody has confirmed.

import { db } from "../server/db";
import { sql } from "drizzle-orm";
import { XERO_CATEGORIES } from "@shared/xero-payout";

const COMMIT = process.argv.includes("--commit");

// Charges billed to the club's Stripe account by apps that keep their orders in
// their OWN database, so no ClubOS table can ever answer for them. Verified
// against 40 live payouts: these are the only two sources that came back
// unresolved, 16 of 18 charges being the photo marketplace.
const RULES: { value: string; category: string; label: string }[] = [
  { value: "CIC Content Marketplace", category: "shop", label: "CIC photo sales (separate app, usg-meet DB)" },
];

(async () => {
  const orgRow = await db.execute(sql`SELECT id, name FROM organizations WHERE slug = 'christchurch-united' OR name ILIKE '%Christchurch United%' ORDER BY id LIMIT 1`);
  const org = (orgRow.rows as any[])[0];
  if (!org) throw new Error("could not find the CUFC organisation");
  console.log(`organisation: ${org.id} — ${org.name}\n`);

  await db.execute(sql`BEGIN`);
  try {
    for (const c of XERO_CATEGORIES) {
      await db.execute(sql`
        INSERT INTO xero_account_map (organization_id, category, note)
        VALUES (${org.id}, ${c.key}, ${c.note ?? null})
        ON CONFLICT (organization_id, category) DO NOTHING`);
      console.log(`  category  ${c.key.padEnd(20)} ${c.label}`);
    }
    for (const r of RULES) {
      await db.execute(sql`
        INSERT INTO xero_payout_rules (organization_id, match_value, category, label, created_by)
        VALUES (${org.id}, ${r.value}, ${r.category}, ${r.label}, 'seed')
        ON CONFLICT DO NOTHING`);
      console.log(`  rule      "${r.value}" → ${r.category}`);
    }
    const n = await db.execute(sql`SELECT count(*)::int c FROM xero_account_map WHERE organization_id = ${org.id}`);
    const m = await db.execute(sql`SELECT count(*)::int c FROM xero_payout_rules WHERE organization_id = ${org.id} AND active`);
    console.log(`\n${(n.rows as any[])[0].c} categories, ${(m.rows as any[])[0].c} rules`);
    console.log("account codes left blank on purpose — Victor's to give");

    if (COMMIT) { await db.execute(sql`COMMIT`); console.log("\n🟢 COMMITTED"); }
    else { await db.execute(sql`ROLLBACK`); console.log("\n↩️  rolled back (dry run). Re-run with --commit."); }
  } catch (e: any) {
    await db.execute(sql`ROLLBACK`); console.error("FATAL", e?.message ?? e); process.exit(1);
  }
  process.exit(0);
})();
