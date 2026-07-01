// Seed the sponsorship_prospects table from the overnight scrape
// (outputs/sponsorship-leads/prospects.jsonl). Idempotent: ON CONFLICT
// (organization_id, lower(company)) DO NOTHING — safe to re-run.
// Run AFTER apply-sponsorship-prospects-schema.ts.
//
// Usage:
//   ORG_SLUG=<group-slug> npx tsx --env-file=.env script/seed-sponsorship-prospects.ts
//   ORG_ID=123           npx tsx --env-file=.env script/seed-sponsorship-prospects.ts
// If neither resolves, it prints the available orgs so you can pick the right one.

import { Pool } from "pg";
import { readFileSync } from "fs";
import path from "path";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const DATA_FILE = path.resolve(process.cwd(), process.env.PROSPECTS_FILE || "../../outputs/sponsorship-leads/prospects.jsonl");

// research brand codes -> client BRAND slugs
const BRAND_MAP: Record<string, string> = {
  CUFC: "cufc", SIU: "siu", MFL: "mfl", CIC: "cic", CUGC: "gymnastics", ACAD: "academy", USC: "usc", PRINT: "print",
};

async function resolveOrgId(): Promise<number> {
  if (process.env.ORG_ID) return parseInt(process.env.ORG_ID);
  const slug = process.env.ORG_SLUG;
  if (slug) {
    const r = await pool.query("SELECT id FROM organizations WHERE slug = $1", [slug]);
    if (r.rows[0]) return r.rows[0].id;
  }
  // best-effort: the group org that holds the sponsorship pipeline
  const guess = await pool.query(
    "SELECT id, slug, name FROM organizations WHERE name ILIKE '%united sports%' OR slug ILIKE '%united-sports%' OR slug ILIKE '%group%' ORDER BY id LIMIT 1"
  );
  if (guess.rows[0]) { console.log(`→ Using org #${guess.rows[0].id} (${guess.rows[0].slug} — ${guess.rows[0].name})`); return guess.rows[0].id; }
  const all = await pool.query("SELECT id, slug, name FROM organizations ORDER BY id");
  console.error("Could not resolve org. Set ORG_ID or ORG_SLUG. Available orgs:");
  for (const o of all.rows) console.error(`  ${o.id}  ${o.slug}  ${o.name}`);
  process.exit(1);
}

(async () => {
  const orgId = await resolveOrgId();
  const lines = readFileSync(DATA_FILE, "utf-8").split("\n").filter((l) => l.trim());
  console.log(`Loaded ${lines.length} prospects from ${DATA_FILE} for org #${orgId}`);

  let inserted = 0, skipped = 0;
  for (const line of lines) {
    const L = JSON.parse(line);
    const dms = L.decision_makers || [];
    const dm0 = dms[0] || {};
    const bc = L.best_contact || {};
    const socials = L.socials || {};
    const brandTags = (L.brands_fit || []).map((b: string) => BRAND_MAP[String(b).toUpperCase()] || String(b).toLowerCase());
    const detail = JSON.stringify({ decision_makers: dms, socials, size_signal: L.size_signal || null });

    const r = await pool.query(
      `INSERT INTO sponsorship_prospects
        (organization_id, company, website, sector, location, brand_tags, segment, tier,
         fit_score, spend_capacity_score, reachability_score, capacity_estimate, already_backs_sport,
         sport_evidence, why_fit, brief, contact_name, contact_email, email_confidence, contact_phone,
         decision_maker_name, decision_maker_role, decision_maker_linkedin, linkedin_url, sources,
         grade_rationale, detail, category)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
       ON CONFLICT (organization_id, lower(company)) DO NOTHING
       RETURNING id`,
      [
        orgId, L.company, L.website || null, L.sector || null, L.location || null, brandTags,
        L._segment || null, L.tier || null, L.fit_score ?? null, L.spend_capacity_score ?? null,
        L.reachability_score ?? null, L.sponsorship_capacity_nzd_estimate || null,
        typeof L.already_backs_sport === "boolean" ? L.already_backs_sport : null,
        L.sport_evidence || null, L.why_fit || null, L.brief || null,
        bc.name || dm0.name || null, bc.email || null, bc.email_confidence || null, bc.phone || null,
        dm0.name || null, dm0.role || null, dm0.linkedin || null, socials.linkedin || null,
        L.sources || [], L.grade_rationale || null, detail, L.category || null,
      ]
    );
    if (r.rows[0]) inserted++; else skipped++;
  }
  console.log(`✅ Done. Inserted ${inserted}, skipped ${skipped} (already present).`);
  await pool.end();
})().catch((e) => { console.error("❌", e); process.exit(1); });
