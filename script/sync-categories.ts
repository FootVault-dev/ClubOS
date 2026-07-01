// Sync re-tagged categories from prospects.jsonl into the live sponsorship_prospects table (org 7).
// Usage: npx tsx --env-file=.env script/sync-categories.ts
import { Pool } from "pg";
import { readFileSync } from "fs";
const JSONL = "/Users/danielmeyn/Desktop/AIOS/DanielMeynOS/outputs/sponsorship-leads/prospects.jsonl";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const leads = readFileSync(JSONL, "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  let n = 0;
  for (const L of leads) {
    if (!L.category) continue;
    const r = await pool.query("UPDATE sponsorship_prospects SET category=$1 WHERE organization_id=7 AND lower(company)=lower($2)", [L.category, L.company]);
    n += r.rowCount || 0;
  }
  const tot = await pool.query("SELECT count(*) FROM sponsorship_prospects WHERE organization_id=7");
  const enr = await pool.query("SELECT count(*) FROM sponsorship_prospects WHERE organization_id=7 AND detail LIKE '%enriched%'");
  const byc = await pool.query("SELECT category, count(*) FROM sponsorship_prospects WHERE organization_id=7 GROUP BY category ORDER BY 2 DESC");
  console.log(`categories synced: ${n}`);
  console.log(`total: ${tot.rows[0].count}  enriched: ${enr.rows[0].count}`);
  console.log("by category: " + byc.rows.map((r: any) => `${r.category}:${r.count}`).join("  "));
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
