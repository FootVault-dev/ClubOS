// Seed the tracked short link for the cufc.co.nz "Field Hire" menu item.
// Dry-run:  npx tsx --env-file=.env script/seed-field-hire-link.ts
// Apply:    npx tsx --env-file=.env script/seed-field-hire-link.ts --apply
//
// app.usg.co.nz/l/field-hire  → logs the click (AttributionOS Links tab, org 4)
//   → 302 to book.unitedsportscentre.com/?source=field-hire-mainmenu (+ utm_*)
//   → the booking page stamps attribution_source on the booking (revenue).
// Idempotent (ON CONFLICT key) — never clobbers the click counter or created_at.
import { Pool } from "pg";

const apply = process.argv.includes("--apply");
const DEST = "https://book.unitedsportscentre.com/?source=field-hire-mainmenu";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
try {
  const org = await pool.query("SELECT id FROM organizations WHERE slug = 'united-sports-centre'");
  if (!org.rows.length) throw new Error("org 'united-sports-centre' not found");
  const orgId = org.rows[0].id;

  await pool.query("BEGIN");
  const r = await pool.query(
    `INSERT INTO short_links
       (organization_id, key, destination, channel, medium, campaign, content, brand, note, active)
     VALUES ($1, 'field-hire', $2, 'referral', 'nav', 'field-hire', 'main-menu', 'cufc',
             'cufc.co.nz "Field Hire" main-menu item -> USC booking site', true)
     ON CONFLICT (key) DO UPDATE SET
       organization_id = EXCLUDED.organization_id,
       destination = EXCLUDED.destination,
       channel = EXCLUDED.channel, medium = EXCLUDED.medium,
       campaign = EXCLUDED.campaign, content = EXCLUDED.content,
       brand = EXCLUDED.brand, note = EXCLUDED.note, active = true
     RETURNING id, key, destination, organization_id, channel, campaign, content`,
    [orgId, DEST],
  );
  console.log("LINK:", JSON.stringify(r.rows[0]));
  if (apply) { await pool.query("COMMIT"); console.log("COMMITTED — /l/field-hire is live."); }
  else { await pool.query("ROLLBACK"); console.log("DRY-RUN (rolled back). Re-run with --apply."); }
} catch (e) {
  await pool.query("ROLLBACK").catch(() => {});
  throw e;
} finally {
  await pool.end();
}
