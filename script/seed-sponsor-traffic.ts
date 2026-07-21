// Seed the 50 real sponsor placements (CUFC + SIU) into Sponsor Traffic so the
// tab opens populated with tracked links from day one. Source of truth for
// these values: outputs/sponsor-traffic/sponsors.json in DanielMeynOS (recon
// of apps/cufc-website/src/site.ts PARTNER_LOGOS + apps/siu-website partners.json,
// generated 2026-07-12). Embedded verbatim below so this script has no runtime
// dependency on that path.
//
// Idempotent — upserts on short_code. On conflict, updates name/website_url/
// tier/logo_url only; NEVER touches open_count, last_opened_at or site_status
// (real traffic + health-check state must survive a re-seed).
//
// Dry-run unless --commit (runs inside a transaction, rolled back unless
// --commit is passed).
//
// Usage: npx tsx --env-file=.env script/seed-sponsor-traffic.ts [--commit]

import "dotenv/config";
import { Pool } from "pg";

type SeedRow = { brand: string; name: string; code: string; tier: string; url: string };

const SEED: SeedRow[] = [
  // ── CUFC (christchurchunited.co.nz) ──────────────────────────────────────
  { brand: "cufc", name: "Fusion5", code: "cufc-fusion5", tier: "partner", url: "https://www.fusion5.co.nz" },
  { brand: "cufc", name: "Go Media", code: "cufc-gomedia", tier: "partner", url: "https://www.gomedia.co.nz" },
  { brand: "cufc", name: "SMC Design Studio", code: "cufc-smc", tier: "partner", url: "https://smcdesign.co.nz" },
  { brand: "cufc", name: "CUPRA", code: "cufc-cupra", tier: "partner", url: "https://cuprachristchurch.co.nz" },
  { brand: "cufc", name: "Heartland Bank", code: "cufc-heartland", tier: "partner", url: "https://www.heartland.co.nz" },
  { brand: "cufc", name: "Duncan Cotterill", code: "cufc-duncancotterill", tier: "partner", url: "https://duncancotterill.com" },
  { brand: "cufc", name: "United Prints", code: "cufc-unitedprints", tier: "partner", url: "https://unitedprints.co.nz" },
  { brand: "cufc", name: "Victoria Foods", code: "cufc-victoriafoods", tier: "partner", url: "https://victoriafoods.co.nz" },
  { brand: "cufc", name: "The Lone Star", code: "cufc-lonestar", tier: "partner", url: "https://www.lonestar.co.nz" },
  { brand: "cufc", name: "The Drifter", code: "cufc-drifter", tier: "partner", url: "https://thedrifter.com/christchurch" },
  { brand: "cufc", name: "The Yard Gym", code: "cufc-yardgym", tier: "partner", url: "https://theyardgym.com/locations/christchurch-south" },
  { brand: "cufc", name: "Revamp Digital", code: "cufc-revamp", tier: "partner", url: "https://www.revampdigital.co.nz" },
  { brand: "cufc", name: "SignBiz", code: "cufc-signbiz", tier: "partner", url: "https://www.signbiz.co.nz" },
  { brand: "cufc", name: "United Steel", code: "cufc-unitedsteel", tier: "partner", url: "https://www.unitedsteel.co.nz" },
  { brand: "cufc", name: "Milano Tiling", code: "cufc-milano", tier: "partner", url: "https://www.milanotiling.co.nz" },
  { brand: "cufc", name: "LT McGuinness", code: "cufc-ltmcguinness", tier: "partner", url: "https://ltmcguinness.co.nz" },
  // CUFC site currently has NO url for Formosa (renders non-link) — using their
  // Facebook page. Confirm a real site with Daniel.
  { brand: "cufc", name: "Formosa Foods", code: "cufc-formosa", tier: "partner", url: "https://www.facebook.com/Formosafoods/" },
  { brand: "cufc", name: "Core Hygiene", code: "cufc-corehygiene", tier: "partner", url: "https://www.corehygiene.co.nz" },
  { brand: "cufc", name: "Shade Plus", code: "cufc-shadeplus", tier: "partner", url: "https://shadeplus.co.nz" },
  { brand: "cufc", name: "Alphouse", code: "cufc-alphouse", tier: "partner", url: "https://alphouse.nz" },
  { brand: "cufc", name: "Beck & Associates", code: "cufc-beck", tier: "partner", url: "https://beckandassociates.co.nz" },
  { brand: "cufc", name: "Jacksons Retreat", code: "cufc-jacksonsretreat", tier: "partner", url: "https://www.jacksonsretreat.co.nz" },
  { brand: "cufc", name: "Moana Skies", code: "cufc-moanaskies", tier: "partner", url: "https://www.moanaskies.co.nz" },
  { brand: "cufc", name: "New Balance x Belgravia Apparel", code: "cufc-belgravia", tier: "partner", url: "https://belgraviaapparelshop.co.nz" },
  { brand: "cufc", name: "Your Local Home Services", code: "cufc-yourlocal", tier: "partner", url: "https://yourlocal.nz" },

  // ── SIU (southislandunited.com) ──────────────────────────────────────────
  { brand: "siu", name: "New Balance x Belgravia Apparel", code: "siu-belgravia", tier: "Major partner", url: "https://belgraviaapparel.com/" },
  { brand: "siu", name: "Go Media", code: "siu-gomedia", tier: "Major partner", url: "https://www.gomedia.co.nz/" },
  { brand: "siu", name: "United Prints", code: "siu-unitedprints", tier: "Principal partner", url: "https://unitedprints.co.nz/" },
  { brand: "siu", name: "SMC Design", code: "siu-smc", tier: "Principal partner", url: "https://smcdesign.co.nz/" },
  { brand: "siu", name: "Victoria Foods", code: "siu-victoriafoods", tier: "Principal partner", url: "https://victoriafoods.co.nz/" },
  { brand: "siu", name: "Signbiz", code: "siu-signbiz", tier: "Principal partner", url: "https://www.signbiz.co.nz/" },
  { brand: "siu", name: "United Steel", code: "siu-unitedsteel", tier: "Principal partner", url: "https://www.unitedsteel.co.nz/" },
  { brand: "siu", name: "Cupra", code: "siu-cupra", tier: "Principal partner", url: "https://cuprachristchurch.co.nz/" },
  { brand: "siu", name: "Core Hygiene", code: "siu-corehygiene", tier: "Principal partner", url: "https://www.corehygiene.co.nz/" },
  { brand: "siu", name: "Revamp Digital", code: "siu-revamp", tier: "Principal partner", url: "https://www.revampdigital.co.nz/" },
  { brand: "siu", name: "Moana Skies", code: "siu-moanaskies", tier: "Premium partner", url: "https://www.moanaskies.co.nz/" },
  { brand: "siu", name: "Heartland", code: "siu-heartland", tier: "Premium partner", url: "https://www.heartland.nz/" },
  { brand: "siu", name: "Your Local Home Services", code: "siu-yourlocal", tier: "Premium partner", url: "https://yourlocal.nz/" },
  { brand: "siu", name: "Formosa Foods", code: "siu-formosa", tier: "Premium partner", url: "https://www.facebook.com/Formosafoods/" },
  { brand: "siu", name: "Milano Tiling", code: "siu-milano", tier: "Premium partner", url: "https://www.milanotiling.co.nz/" },
  { brand: "siu", name: "Beck & Associates", code: "siu-beck", tier: "Premium partner", url: "https://www.beckandassociates.co.nz/" },
  { brand: "siu", name: "Jackson's Retreat", code: "siu-jacksonsretreat", tier: "Premium partner", url: "https://www.jacksonsretreat.co.nz/" },
  { brand: "siu", name: "AlpHouse", code: "siu-alphouse", tier: "Premium partner", url: "https://alphouse.nz/" },
  { brand: "siu", name: "Shade Plus", code: "siu-shadeplus", tier: "Premium partner", url: "https://shadeplus.co.nz/" },
  { brand: "siu", name: "Duncan Cotterill", code: "siu-duncancotterill", tier: "Premium partner", url: "https://duncancotterill.com/" },
  { brand: "siu", name: "Fusion 5", code: "siu-fusion5", tier: "Premium partner", url: "https://www.fusion5.com/" },
  { brand: "siu", name: "The Lone Star", code: "siu-lonestar", tier: "Premium partner", url: "https://www.lonestar.co.nz/" },
  { brand: "siu", name: "LT McGuinness", code: "siu-ltmcguinness", tier: "Premium partner", url: "https://ltmcguinness.co.nz/" },
  { brand: "siu", name: "The Yard Gym", code: "siu-yardgym", tier: "Premium partner", url: "https://theyardgym.com/locations/christchurch-south" },
  { brand: "siu", name: "The Drifter", code: "siu-drifter", tier: "Premium partner", url: "https://thedrifter.com/christchurch/" },

  // ── CIC (cicyouth.com — Christchurch International Cup, July youth tournament) ──
  // Sponsor set = the CIC 2026 perimeter-board logos. Codes match the tracked
  // links wired on cicyouth.com's Sponsor Wall + the client impression/view beacon.
  { brand: "cic", name: "Commodore Airport Hotel", code: "cic-commodore", tier: "partner", url: "https://www.commodorehotel.co.nz" },
  { brand: "cic", name: "The Drifter", code: "cic-drifter", tier: "partner", url: "https://thedrifter.com/christchurch" },
  { brand: "cic", name: "Go Media", code: "cic-gomedia", tier: "partner", url: "https://www.gomedia.co.nz" },
  { brand: "cic", name: "The Lone Star", code: "cic-lonestar", tier: "partner", url: "https://www.lonestar.co.nz" },
  { brand: "cic", name: "New Balance", code: "cic-newbalance", tier: "partner", url: "https://www.newbalance.co.nz" },
  { brand: "cic", name: "SMC Design", code: "cic-smc", tier: "partner", url: "https://smcdesign.co.nz" },
  { brand: "cic", name: "United Prints", code: "cic-unitedprints", tier: "partner", url: "https://unitedprints.co.nz" },
  { brand: "cic", name: "United Steel", code: "cic-unitedsteel", tier: "partner", url: "https://www.unitedsteel.co.nz" },
  { brand: "cic", name: "Victoria Foods", code: "cic-victoriafoods", tier: "partner", url: "https://victoriafoods.co.nz" },
  { brand: "cic", name: "Heartland", code: "cic-heartland", tier: "partner", url: "https://www.heartland.nz" },
  { brand: "cic", name: "Perennial", code: "cic-perennial", tier: "partner", url: "https://www.perennial.co.nz" },
  // Gaming/community grant funders — seeded (impression-tracked + health-checkable)
  // but the click-through link stays OFF on the site until Daniel signs off.
  { brand: "cic", name: "NZCT", code: "cic-nzct", tier: "grant funder", url: "https://www.nzct.org.nz" },
  { brand: "cic", name: "The Lion Foundation", code: "cic-lionfoundation", tier: "grant funder", url: "https://lionfoundation.nz" },
  { brand: "cic", name: "Kiwi Gaming", code: "cic-kiwigaming", tier: "grant funder", url: "https://www.kiwigaming.org.nz" },
];

async function main() {
  const commit = process.argv.includes("--commit");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  await pool.query("BEGIN");
  try {
    const org = await pool.query("SELECT id FROM organizations WHERE slug='united-sports-group' LIMIT 1");
    if (!org.rowCount) throw new Error("united-sports-group org not found");
    const orgId = org.rows[0].id;

    let inserted = 0, updated = 0;
    for (const s of SEED) {
      const r = await pool.query(
        `INSERT INTO sponsors (organization_id, name, brand, website_url, short_code, tier, logo_url)
         VALUES ($1,$2,$3,$4,$5,$6,NULL)
         ON CONFLICT (short_code) DO UPDATE SET
           name = EXCLUDED.name,
           website_url = EXCLUDED.website_url,
           tier = EXCLUDED.tier,
           logo_url = EXCLUDED.logo_url,
           updated_at = now()
         RETURNING (xmax = 0) AS inserted`,
        [orgId, s.name, s.brand, s.url, s.code, s.tier]
      );
      if (r.rows[0].inserted) inserted++; else updated++;
    }

    const total = await pool.query("SELECT count(*)::int AS n FROM sponsors WHERE organization_id=$1", [orgId]);
    console.log(`Sponsor Traffic seed: inserted=${inserted}, updated=${updated}, total_in_org=${total.rows[0].n}`);

    if (commit) {
      await pool.query("COMMIT");
      console.log("🟢 COMMITTED");
    } else {
      await pool.query("ROLLBACK");
      console.log("🟡 DRY RUN — nothing written. Re-run with --commit to apply.");
    }
  } catch (e) {
    await pool.query("ROLLBACK");
    throw e;
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error("❌", e); process.exit(1); });
