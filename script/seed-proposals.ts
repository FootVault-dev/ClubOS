// Seed Daniel's real, currently-active proposals into the Proposal Tracker so
// the tab opens populated (each with a tracked link). Idempotent — skips a row
// if a proposal of the same title already exists for the USG org.
// Values are conservative starters Daniel edits in the UI; money left null so
// nothing is invented.
//
// Usage: npx tsx --env-file=.env script/seed-proposals.ts

import { Pool } from "pg";
import crypto from "crypto";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ALPHABET = "23456789abcdefghijkmnpqrstuvwxyz";
const code = (n = 7) => Array.from(crypto.randomBytes(n)).map(b => ALPHABET[b % ALPHABET.length]).join("");

const SEED = [
  { title: "La Liga × SIU partnership", company: "LALIGA", proposal_type: "partnership", category: "La Liga",
    brand_tags: ["siu"], status: "in_discussion", owner: "Daniel",
    link_url: "https://partner.southislandunited.com/la-liga", source_tag: "laliga-proposal" },
  { title: "Fitness Canterbury — first-team gym partnership", company: "Fitness Canterbury", proposal_type: "partnership", category: "Gyms & Fitness",
    brand_tags: ["cufc"], status: "sent", owner: "Daniel",
    link_url: "https://usg-partners.vercel.app/fitness-canterbury", source_tag: "fitness-canterbury-proposal" },
  { title: "Cassels & Sons — beer partnership", company: "Cassels & Sons Brewing", proposal_type: "sponsorship", category: "Breweries / Beer",
    brand_tags: ["cufc", "siu"], status: "in_discussion", owner: "Daniel",
    link_url: "https://usg-partners.vercel.app/cassels", source_tag: "cassels-proposal" },
  { title: "Football Starts at Home × ANZ", company: "ANZ", proposal_type: "partnership", category: "General",
    brand_tags: ["siu"], status: "sent", owner: "Daniel",
    link_url: "https://usg-partners.vercel.app/football-starts-at-home/anz", source_tag: "fsah-anz-proposal" },
];

(async () => {
  const org = await pool.query("SELECT id FROM organizations WHERE slug='united-sports-group' LIMIT 1");
  if (!org.rowCount) throw new Error("united-sports-group org not found");
  const orgId = org.rows[0].id;

  let inserted = 0, skipped = 0;
  for (const p of SEED) {
    const exists = await pool.query("SELECT 1 FROM proposals WHERE organization_id=$1 AND title=$2", [orgId, p.title]);
    if (exists.rowCount) { skipped++; continue; }
    await pool.query(
      `INSERT INTO proposals (organization_id, title, company, proposal_type, category, brand_tags, status, owner, link_url, short_code, source_tag, sent_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, CASE WHEN $7='draft' THEN NULL ELSE now() END)`,
      [orgId, p.title, p.company, p.proposal_type, p.category, p.brand_tags, p.status, p.owner, p.link_url, code(), p.source_tag]
    );
    inserted++;
  }
  const total = await pool.query("SELECT count(*)::int AS n FROM proposals WHERE organization_id=$1", [orgId]);
  console.log(`✅ Seeded proposals. inserted=${inserted}, skipped(existing)=${skipped}, total_in_org=${total.rows[0].n}`);
  await pool.end();
})().catch(e => { console.error("❌", e); process.exit(1); });
