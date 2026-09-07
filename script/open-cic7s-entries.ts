// Open (or close) CIC Summer 7's team entries and payment — BOTH grades at once.
//
//   npx tsx --env-file=.env script/open-cic7s-entries.ts             (show state)
//   npx tsx --env-file=.env script/open-cic7s-entries.ts --open      (entries + payment ON)
//   npx tsx --env-file=.env script/open-cic7s-entries.ts --close     (both OFF)
//
// Sibling of open-ethnic-cup-entries.ts. The 7's is two Team Pay competitions
// (Open $700, Social $500 — Isaac's graphic, 2026-09-03) that must move together:
// a grade that is open while its sibling is shut is a form that works for half
// the teams. fillins_open is deliberately not touched (--fillins to opt in).
import pg from "pg";

const SLUGS = ["cic-summer-7s-2027-open", "cic-summer-7s-2027-social"];
const OPEN = process.argv.includes("--open");
const CLOSE = process.argv.includes("--close");
const FILLINS = process.argv.includes("--fillins");

async function main() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const show = (r: any, label: string) =>
    console.log(`  ${label.padEnd(30)} entries ${r.entries_open ? "OPEN " : "shut "}· payments ${r.payments_enabled ? "ON  " : "OFF "}· fill-ins ${r.fillins_open ? "OPEN" : "shut"}`);

  const rows = (await client.query(
    `select slug, name, fee_cents, default_squad_size, entries_open, payments_enabled, fillins_open
       from teampay_competitions where slug = any($1) order by slug`, [SLUGS])).rows;
  if (rows.length !== SLUGS.length) {
    console.error(`\n  Expected ${SLUGS.length} competitions, found ${rows.length}. Run seed-teampay-cic7s.ts first.\n`);
    process.exit(1);
  }
  console.log("");
  for (const r of rows) { console.log(`  ${r.name} — $${(r.fee_cents / 100).toFixed(2)} per team, squad of ${r.default_squad_size}`); show(r, "  now:"); }
  if (!OPEN && !CLOSE) { console.log(`\n  Nothing changed. Pass --open or --close.\n`); await client.end(); return; }

  let good = true;
  for (const r of rows) {
    const entries = OPEN, payments = OPEN, fillins = FILLINS ? OPEN : r.fillins_open;
    const [after] = (await client.query(
      `update teampay_competitions set entries_open = $2, payments_enabled = $3, fillins_open = $4, updated_at = now()
        where slug = $1 returning entries_open, payments_enabled, fillins_open`,
      [r.slug, entries, payments, fillins])).rows;
    show(after, `  after (${r.slug.split("-").pop()}):`);
    const check = (await client.query(`select entries_open, payments_enabled from teampay_competitions where slug = $1`, [r.slug])).rows[0];
    good = good && check.entries_open === entries && check.payments_enabled === payments;
  }
  console.log(good ? `\n  ✓ confirmed by read-back\n` : `\n  ✗ read-back disagrees — check by hand\n`);
  await client.end();
  process.exit(good ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
