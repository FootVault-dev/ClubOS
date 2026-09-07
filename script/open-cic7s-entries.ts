// Open (or close) CIC Summer 7's team entries and payment.
//
//   npx tsx --env-file=.env script/open-cic7s-entries.ts             (show state)
//   npx tsx --env-file=.env script/open-cic7s-entries.ts --open      (entries + payment ON)
//   npx tsx --env-file=.env script/open-cic7s-entries.ts --close     (both OFF)
//
// Sibling of open-ethnic-cup-entries.ts. The same switches are in ClubOS at
// CIC workspace → 7's → Team Entries; this exists so turning it OFF in a hurry
// is one command. fillins_open is deliberately not touched (--fillins to opt in).
import pg from "pg";

const SLUG = "cic-summer-7s-2027";
const OPEN = process.argv.includes("--open");
const CLOSE = process.argv.includes("--close");
const FILLINS = process.argv.includes("--fillins");

async function main() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const before = await client.query(
    `select id, name, fee_cents, default_squad_size, entries_open, payments_enabled, fillins_open
       from teampay_competitions where slug = $1`, [SLUG]);
  if (!before.rowCount) { console.error(`\n  No competition with slug '${SLUG}'. Run seed-teampay-cic7s.ts first.\n`); process.exit(1); }
  const c = before.rows[0];
  const show = (r: any, label: string) =>
    console.log(`  ${label.padEnd(7)} entries ${r.entries_open ? "OPEN " : "shut "}· payments ${r.payments_enabled ? "ON  " : "OFF "}· fill-ins ${r.fillins_open ? "OPEN" : "shut"}`);
  console.log(`\n  ${c.name} — $${(c.fee_cents / 100).toFixed(2)} per team, squad of ${c.default_squad_size}\n`);
  show(c, "now:");
  if (!OPEN && !CLOSE) { console.log(`\n  Nothing changed. Pass --open or --close.\n`); await client.end(); return; }

  const entries = OPEN, payments = OPEN, fillins = FILLINS ? OPEN : c.fillins_open;
  const [after] = (await client.query(
    `update teampay_competitions set entries_open = $2, payments_enabled = $3, fillins_open = $4, updated_at = now()
      where slug = $1 returning entries_open, payments_enabled, fillins_open`,
    [SLUG, entries, payments, fillins])).rows;
  show(after, "after:");
  const check = await client.query(`select entries_open, payments_enabled from teampay_competitions where slug = $1`, [SLUG]);
  const good = check.rows[0].entries_open === entries && check.rows[0].payments_enabled === payments;
  console.log(good ? `\n  ✓ confirmed by read-back\n` : `\n  ✗ read-back disagrees — check by hand\n`);
  await client.end();
  process.exit(good ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
