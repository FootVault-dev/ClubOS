// Sync new leads from a new-leads workflow output into prospects.jsonl + the live
// sponsorship_prospects table (org 7). Dedupes by domain/company; only NET-NEW rows
// are appended + inserted (ON CONFLICT DO NOTHING). Tags each with its category.
//
// Usage: npx tsx --env-file=.env script/sync-new-prospects.ts <wave-output.json>

import { Pool } from "pg";
import { readFileSync, writeFileSync } from "fs";

const OUT = process.argv[2];
if (!OUT) throw new Error("usage: sync-new-prospects.ts <wave-output.json>");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
const ORG = 7;
const JSONL = "/Users/danielmeyn/Desktop/AIOS/DanielMeynOS/outputs/sponsorship-leads/prospects.jsonl";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const BRAND_MAP: any = { CUFC: "cufc", SIU: "siu", MFL: "mfl", CIC: "cic", CUGC: "gymnastics", ACAD: "academy", USC: "usc", PRINT: "print" };
const domain = (u: string) => (!u ? "" : u.replace(/^https?:\/\/(www\.)?/i, "").split("/")[0].toLowerCase());
const slug = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

(async () => {
  let raw: any = JSON.parse(readFileSync(OUT, "utf-8"));
  raw = raw.result ?? raw;
  const segs: any[] = raw.segments || [];
  const lines = readFileSync(JSONL, "utf-8").split("\n").filter((l) => l.trim());
  const leads = lines.map((l) => JSON.parse(l));
  const seen = new Set(leads.map((L: any) => domain(L.website) || slug(L.company)));

  const newRecs: any[] = [];
  for (const seg of segs) {
    for (const L of (seg.data && seg.data.leads) || []) {
      const key = domain(L.website) || slug(L.company);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      L.category = seg.category;
      L._segment = seg.id;
      L.brands_fit = (L.brands_fit || []).map((b: string) => BRAND_MAP[String(b).toUpperCase()] || String(b).toLowerCase());
      newRecs.push(L);
    }
  }

  writeFileSync(JSONL, leads.concat(newRecs).map((L) => JSON.stringify(L)).join("\n") + "\n");

  let inserted = 0;
  for (const L of newRecs) {
    const dms = L.decision_makers || []; const dm0 = dms[0] || {}; const bc = L.best_contact || {}; const soc = L.socials || {};
    const detail = JSON.stringify({ decision_makers: dms, socials: soc, size_signal: L.size_signal || null });
    const r = await pool.query(
      `INSERT INTO sponsorship_prospects
        (organization_id,company,website,sector,location,brand_tags,segment,category,tier,fit_score,spend_capacity_score,reachability_score,capacity_estimate,already_backs_sport,sport_evidence,why_fit,brief,contact_name,contact_email,email_confidence,contact_phone,decision_maker_name,decision_maker_role,decision_maker_linkedin,linkedin_url,sources,grade_rationale,detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
       ON CONFLICT (organization_id,lower(company)) DO NOTHING RETURNING id`,
      [ORG, L.company, L.website || null, L.sector || null, L.location || null, L.brands_fit || [], L._segment || null, L.category || null,
       L.tier || null, L.fit_score ?? null, L.spend_capacity_score ?? null, L.reachability_score ?? null, L.sponsorship_capacity_nzd_estimate || null,
       typeof L.already_backs_sport === "boolean" ? L.already_backs_sport : null, L.sport_evidence || null, L.why_fit || null, L.brief || null,
       bc.name || dm0.name || null, bc.email || null, bc.email_confidence || null, bc.phone || null,
       dm0.name || null, dm0.role || null, dm0.linkedin || null, soc.linkedin || null, L.sources || [], L.grade_rationale || null, detail]
    );
    if (r.rows[0]) inserted++;
  }
  console.log(`New leads: ${newRecs.length} net-new appended to jsonl; ${inserted} inserted into prod (org ${ORG}).`);
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
