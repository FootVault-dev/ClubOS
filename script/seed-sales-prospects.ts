// Seed the United Print Sales prospect database from the research-fleet output.
//
//   Rehearse:  npx tsx --env-file=.env script/seed-sales-prospects.ts --file <master.json>
//   Apply:     npx tsx --env-file=.env script/seed-sales-prospects.ts --file <master.json> --apply
//
// Grounding is enforced HERE too, not just in the fleet prompts: a row without
// an evidence_url never enters the database (same refusal as the market-research
// seed). Idempotent: matches existing rows by (org, lower(website)) — falling
// back to lower(name) for no-site prospects — and on a match updates ONLY the
// research fields (scores, tier, rank, why-fit, link status, missing contact
// details). It NEVER touches stage, notes, follow-ups or deal values — those
// are Daniel's working edits, and a re-run of the seed must not clobber them.
import { Pool } from "pg";
import { readFileSync } from "fs";

const APPLY = process.argv.includes("--apply");
const fileArg = process.argv.indexOf("--file");
if (fileArg === -1 || !process.argv[fileArg + 1]) {
  console.error("Usage: seed-sales-prospects.ts --file <prospects-master.json> [--apply]");
  process.exit(1);
}
const FILE = process.argv[fileArg + 1];
const ORG_SLUG = "united-prints";

type Row = {
  name: string;
  website: string | null;
  city: string | null;
  region: string | null;
  category: string | null;
  subcategory: string | null;
  why_fit: string | null;
  services_match: string[];
  contact_name: string | null;
  contact_role: string | null;
  email: string | null;
  phone: string | null;
  evidence_url: string | null;
  fetched_at: string | null;
  link_status: string | null;
  fit_score: number;
  volume_score: number;
  access_score: number;
  locality_score: number;
  total_score: number;
  tier: string;
  rank: number;
  notes: string | null;
};

const rows: Row[] = JSON.parse(readFileSync(FILE, "utf8"));
const grounded = rows.filter((r) => r.name && r.evidence_url);
const refused = rows.length - grounded.length;

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
try {
  const org = await pool.query("SELECT id, slug FROM organizations WHERE slug = $1", [ORG_SLUG]);
  if (!org.rows.length) throw new Error(`Organization '${ORG_SLUG}' not found`);
  const orgId: number = org.rows[0].id;
  console.log(`\nOrg: ${ORG_SLUG} (id ${orgId}) · file: ${FILE}`);
  console.log(`Rows: ${rows.length} · grounded: ${grounded.length} · REFUSED (no evidence_url): ${refused}`);
  console.log(APPLY ? "APPLYING.\n" : "DRY RUN — no writes. Re-run with --apply.\n");

  const existing = await pool.query(
    "SELECT id, lower(coalesce(website, '')) AS site, lower(name) AS lname FROM sales_prospects WHERE organization_id = $1",
    [orgId],
  );
  const bySite = new Map<string, number>();
  const byName = new Map<string, number>();
  for (const e of existing.rows) {
    if (e.site) bySite.set(e.site, e.id);
    byName.set(e.lname, e.id);
  }

  let inserted = 0;
  let updated = 0;

  await pool.query("BEGIN");
  for (const r of grounded) {
    const siteKey = (r.website ?? "").toLowerCase();
    const match = (siteKey && bySite.get(siteKey)) || byName.get(r.name.toLowerCase()) || null;

    if (match) {
      updated++;
      if (APPLY) {
        // Research fields only. Contact details fill gaps, never overwrite —
        // a phone number Daniel corrected by hand beats a re-scraped one.
        await pool.query(
          `UPDATE sales_prospects SET
             city = COALESCE(city, $2), region = COALESCE(region, $3),
             category = COALESCE(category, $4), subcategory = COALESCE(subcategory, $5),
             why_fit = COALESCE($6, why_fit), services_match = COALESCE($7::jsonb, services_match),
             contact_name = COALESCE(contact_name, $8), contact_role = COALESCE(contact_role, $9),
             email = COALESCE(email, $10), phone = COALESCE(phone, $11),
             evidence_url = COALESCE($12, evidence_url), fetched_at = COALESCE($13::date, fetched_at),
             link_status = $14,
             fit_score = $15, volume_score = $16, access_score = $17, locality_score = $18,
             total_score = $19, tier = $20, rank = $21,
             updated_at = now()
           WHERE id = $1`,
          [
            match, r.city, r.region, r.category, r.subcategory, r.why_fit,
            r.services_match?.length ? JSON.stringify(r.services_match) : null,
            r.contact_name, r.contact_role, r.email, r.phone,
            r.evidence_url, r.fetched_at, r.link_status,
            r.fit_score, r.volume_score, r.access_score, r.locality_score,
            r.total_score, r.tier, r.rank,
          ],
        );
      }
      continue;
    }

    inserted++;
    if (APPLY) {
      const res = await pool.query(
        `INSERT INTO sales_prospects (
           organization_id, name, website, city, region, category, subcategory,
           why_fit, services_match, contact_name, contact_role, email, phone,
           evidence_url, fetched_at, link_status,
           fit_score, volume_score, access_score, locality_score, total_score, tier, rank,
           source, stage, notes
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15::date,$16,$17,$18,$19,$20,$21,$22,$23,'research-fleet','new',$24)
         ON CONFLICT DO NOTHING RETURNING id`,
        [
          orgId, r.name, r.website, r.city, r.region, r.category, r.subcategory,
          r.why_fit, r.services_match?.length ? JSON.stringify(r.services_match) : null,
          r.contact_name, r.contact_role, r.email, r.phone,
          r.evidence_url, r.fetched_at, r.link_status,
          r.fit_score, r.volume_score, r.access_score, r.locality_score, r.total_score, r.tier, r.rank,
          r.notes,
        ],
      );
      if (res.rows.length && r.website) bySite.set(siteKey, res.rows[0].id);
      if (res.rows.length) byName.set(r.name.toLowerCase(), res.rows[0].id);
      if (!res.rows.length) inserted--; // conflict-skipped duplicate inside the same file
    }
  }
  await pool.query(APPLY ? "COMMIT" : "ROLLBACK");

  console.log(`inserted: ${inserted} · updated: ${updated} · refused: ${refused}`);
  if (APPLY) {
    const count = await pool.query("SELECT count(*)::int AS n, count(*) FILTER (WHERE tier='A')::int AS a FROM sales_prospects WHERE organization_id = $1", [orgId]);
    console.log(`sales_prospects now holds ${count.rows[0].n} rows for ${ORG_SLUG} (Tier A: ${count.rows[0].a}).\n`);
  }
} catch (e) {
  await pool.query("ROLLBACK").catch(() => {});
  throw e;
} finally {
  await pool.end();
}
