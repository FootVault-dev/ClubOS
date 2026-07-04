// Import historical Mini Football purchases from the Shopify export into ClubOS.
//   - People  -> real `contacts` table (type 'guardian', matching the live MFL
//                captain convention), deduped by lower(trim(email)).
//   - Purchases -> `mfl_customer_history` (source-tagged, idempotent per Shopify
//                line item), so the CLV + Loyalty trackers can show each
//                customer's full journey without polluting live `registrations`.
//   - Marketing opt-outs on Shopify are respected: an 'unsubscribed' customer is
//                added to `email_unsubscribes` (org 3) so the mailer suppresses them.
//
// Reads the export produced by scripts/shopify/export_mfl_history.py
// (orders_raw.jsonl). DRY-RUN by default (rolls back); pass --commit to write.
//   npx tsx script/import-mfl-shopify-history.ts --dir /abs/path/to/export [--commit]
//   (defaults to the latest data/mfl-shopify-export/<date> folder)

import "dotenv/config";
import { Pool } from "pg";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join, resolve } from "path";

const ORG_ID = 3;
const CATEGORY: [string, RegExp][] = [
  ["mini_football", /mini football/i],
  ["social_leagues", /social league/i],
  ["summer_7aside", /summer\s*7[\s-]*a[\s-]*side/i],
  ["fill_ins", /fill[- ]?in/i],
];
const EXCLUDE = /\bcic\b|holiday programme|residency|uniform|merchandise/i;
const TEAM_RE = /team\s*name\s*[:=]\s*(.+)/i;

const clean = (s: any) => (s == null ? null : String(s).trim() || null);
const lc = (s: any) => (s == null ? "" : String(s).trim().toLowerCase());
const classifyLine = (title: string): string | null => {
  if (EXCLUDE.test(title)) return null;
  for (const [c, re] of CATEGORY) if (re.test(title)) return c;
  return null;
};

function resolveDir(): string {
  const flagIdx = process.argv.indexOf("--dir");
  if (flagIdx !== -1 && process.argv[flagIdx + 1]) return resolve(process.argv[flagIdx + 1]);
  const pos = process.argv.slice(2).find((a) => !a.startsWith("-"));
  if (pos) return resolve(pos);
  // default: latest date folder under <workspace>/data/mfl-shopify-export
  const base = resolve(__dirname, "..", "..", "..", "data", "mfl-shopify-export");
  const dates = readdirSync(base).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  if (!dates.length) throw new Error(`No export folders under ${base}`);
  return join(base, dates[dates.length - 1]);
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  const commit = process.argv.includes("--commit");
  const dir = resolveDir();
  const rawPath = join(dir, "orders_raw.jsonl");
  if (!existsSync(rawPath)) throw new Error(`Not found: ${rawPath}`);
  console.log(`Reading ${rawPath}`);

  const lines = readFileSync(rawPath, "utf8").split("\n").filter(Boolean);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  let histInserted = 0, histUpdated = 0, contactsInserted = 0, contactsMatched = 0, unsubs = 0, skippedLines = 0;
  const perCat: Record<string, { rows: number; cents: number }> = {};
  const spendByEmail = new Map<string, { name: string; cents: number; rows: number; seasons: Set<string> }>();

  // Dedup caches within this run (so two line items in one order reuse one contact)
  const contactCache = new Map<string, number>();

  async function upsertContact(first: string, last: string, email: string, phone: string | null, address: string | null, optedOut: boolean): Promise<number | null> {
    const key = lc(email) || `noemail:${lc(first)}|${lc(last)}|${lc(phone)}`;
    if (contactCache.has(key)) return contactCache.get(key)!;
    let id: number | null = null;
    if (lc(email)) {
      const found = await client.query(`SELECT id FROM contacts WHERE lower(trim(email)) = $1 ORDER BY id LIMIT 1`, [lc(email)]);
      if (found.rows[0]) {
        id = found.rows[0].id;
        await client.query(
          `UPDATE contacts SET phone = COALESCE(phone, $2),
             first_name = CASE WHEN COALESCE(NULLIF(first_name,''),'') = '' THEN $3 ELSE first_name END,
             last_name  = CASE WHEN COALESCE(NULLIF(last_name,''),'')  = '' THEN $4 ELSE last_name  END
           WHERE id = $1`,
          [id, clean(phone), clean(first) || "", clean(last) || ""]);
        contactsMatched++;
      } else {
        const ins = await client.query(
          `INSERT INTO contacts (type, first_name, last_name, email, phone, address, newsletter_consent, tags, notes)
           VALUES ('guardian',$1,$2,$3,$4,$5,$6,'mfl,shopify-import','Imported from Shopify MFL history') RETURNING id`,
          [clean(first) || "", clean(last) || "", clean(email), clean(phone), clean(address), !optedOut]);
        id = ins.rows[0].id;
        contactsInserted++;
      }
    } else if (clean(first) || clean(last) || clean(phone)) {
      const found = await client.query(
        `SELECT id FROM contacts WHERE email IS NULL AND lower(trim(first_name))=$1 AND lower(trim(last_name))=$2 AND COALESCE(phone,'')=COALESCE($3,'') ORDER BY id LIMIT 1`,
        [lc(first), lc(last), clean(phone)]);
      if (found.rows[0]) { id = found.rows[0].id; contactsMatched++; }
      else {
        const ins = await client.query(
          `INSERT INTO contacts (type, first_name, last_name, phone, newsletter_consent, tags, notes)
           VALUES ('guardian',$1,$2,$3,false,'mfl,shopify-import,no-email','Imported from Shopify MFL history (no email)') RETURNING id`,
          [clean(first) || "", clean(last) || "", clean(phone)]);
        id = ins.rows[0].id; contactsInserted++;
      }
    }
    if (id != null) contactCache.set(key, id);
    return id;
  }

  await client.query("BEGIN");
  try {
    for (const line of lines) {
      const { order } = JSON.parse(line);
      const cust = order.customer || {};
      const addr = cust.default_address || {};
      const emState = (cust.email_marketing_consent && cust.email_marketing_consent.state) || "";
      const optedOut = emState === "unsubscribed";
      const email = cust.email || order.email || "";
      const first = cust.first_name || "";
      const last = cust.last_name || "";
      const phone = cust.phone || order.phone || null;
      const address = [addr.address1, addr.address2, addr.city, addr.zip].filter(Boolean).join(", ") || null;
      const noteTeam = (() => { const m = TEAM_RE.exec(order.note || ""); return m ? m[1].trim().replace(/^['"]|['"]$/g, "") : null; })();

      let orderHasMflLine = false;
      for (const li of order.line_items || []) {
        const title = li.title || "";
        const cat = classifyLine(title);
        if (!cat) { continue; }
        orderHasMflLine = true;
        const contactId = await upsertContact(first, last, email, phone, address, optedOut);
        const qty = parseInt(li.quantity, 10) || 1;
        const cents = Math.round((parseFloat(li.price) || 0) * qty * 100);
        const raw = JSON.stringify({ line_item: li, order: { id: order.id, name: order.name, created_at: order.created_at, financial_status: order.financial_status, note: order.note, total_price: order.total_price } });
        const r = await client.query(
          `INSERT INTO mfl_customer_history
             (organization_id, contact_id, source, external_id, external_ref, external_line_id, category,
              product_title, variant, team_name, purchased_at, amount_cents, currency, quantity, financial_status,
              buyer_first_name, buyer_last_name, buyer_email, buyer_phone, notes, raw_json)
           VALUES ($1,$2,'shopify',$3,$4,$5,$6,$7,$8,$9,$10,$11,'NZD',$12,$13,$14,$15,$16,$17,NULL,$18::jsonb)
           ON CONFLICT (source, external_line_id) WHERE external_line_id IS NOT NULL DO UPDATE SET
             contact_id = EXCLUDED.contact_id, amount_cents = EXCLUDED.amount_cents,
             financial_status = EXCLUDED.financial_status, product_title = EXCLUDED.product_title,
             variant = EXCLUDED.variant, team_name = COALESCE(mfl_customer_history.team_name, EXCLUDED.team_name),
             raw_json = EXCLUDED.raw_json
           RETURNING (xmax = 0) AS inserted`,
          [ORG_ID, contactId, String(order.id), order.name, String(li.id), cat,
           title, clean(li.variant_title), noteTeam, order.created_at, cents, qty, order.financial_status,
           clean(first), clean(last), clean(email), clean(phone), raw]);
        if (r.rows[0].inserted) histInserted++; else histUpdated++;
        perCat[cat] = perCat[cat] || { rows: 0, cents: 0 };
        perCat[cat].rows++; perCat[cat].cents += cents;
        const ek = lc(email) || `#${order.id}`;
        const s = spendByEmail.get(ek) || { name: `${first} ${last}`.trim() || ek, cents: 0, rows: 0, seasons: new Set<string>() };
        s.cents += cents; s.rows++; s.seasons.add(title);
        spendByEmail.set(ek, s);
      }
      if (order.line_items && !orderHasMflLine) skippedLines++;
      if (optedOut && lc(email)) {
        const u = await client.query(
          `INSERT INTO email_unsubscribes (organization_id, email, source) VALUES ($1,$2,'shopify-import')
           ON CONFLICT (organization_id, email) DO NOTHING RETURNING id`, [ORG_ID, lc(email)]);
        if (u.rows[0]) unsubs++;
      }
    }

    if (commit) { await client.query("COMMIT"); } else { await client.query("ROLLBACK"); }
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }

  const totalCents = Object.values(perCat).reduce((a, c) => a + c.cents, 0);
  console.log(`\n${commit ? "🟢 COMMITTED" : "🟡 DRY RUN (rolled back — pass --commit to write)"}`);
  console.log(`\nHistory rows: ${histInserted} inserted, ${histUpdated} updated`);
  console.log(`Contacts: ${contactsInserted} new, ${contactsMatched} matched existing`);
  console.log(`Opt-outs suppressed (email_unsubscribes): ${unsubs}`);
  console.log(`Total historical value: $${(totalCents / 100).toLocaleString("en-NZ", { minimumFractionDigits: 2 })}`);
  console.log(`\nBy category:`);
  for (const [c, v] of Object.entries(perCat)) console.log(`  ${c.padEnd(16)} ${String(v.rows).padStart(4)} rows   $${(v.cents / 100).toLocaleString("en-NZ")}`);
  const top = [...spendByEmail.values()].sort((a, b) => b.cents - a.cents).slice(0, 12);
  console.log(`\nTop 12 by lifetime spend (preview of the CLV leaderboard):`);
  top.forEach((s, i) => console.log(`  ${String(i + 1).padStart(2)}. ${s.name.padEnd(28)} $${(s.cents / 100).toLocaleString("en-NZ").padStart(9)}  · ${s.rows} orders · ${s.seasons.size} seasons`));

  client.release();
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
