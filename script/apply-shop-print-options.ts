/**
 * Printing-as-a-priced-add-on — apply the migration and PROVE its rules.
 *
 *   npx tsx --env-file=.env script/apply-shop-print-options.ts            # dry run, rolled back
 *   npx tsx --env-file=.env script/apply-shop-print-options.ts --commit   # for real
 *
 * Runs migrations/2026-09-09_shop_print_options.sql inside ONE transaction,
 * then asserts every invariant by trying to break it (mustReject) and every
 * legitimate write by doing it (mustAccept), against throwaway fixtures
 * discarded before COMMIT — same rehearsal pattern as apply-club-events.ts.
 * There is no local Postgres, so this transaction IS the rehearsal.
 *
 * The migration file carries no inner BEGIN/COMMIT/ROLLBACK (asserted below,
 * not just trusted) — a migration that commits its own transaction would end
 * this one early and let the ROLLBACK below run in autocommit, silently
 * keeping fixture data. See CLAUDE.md "A migration carrying its own
 * BEGIN/COMMIT defeats a --dry-run wrapper".
 *
 * Proven here:
 *   1. shop_products.print_options and shop_order_items.print_cents exist,
 *      with the right types, and every existing MFL/CIC/CUFC product and
 *      order item is untouched (print_options NULL, print_cents 0 default).
 *   2. print_cents cannot go negative (the CHECK constraint).
 *   3. the migration is idempotent (re-runs cleanly).
 *   4. no fixture data survives the rehearsal.
 */
import { readFileSync } from "fs";
import { join } from "path";
import pg from "pg";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");

const COMMIT = process.argv.includes("--commit");
const MIGRATION = "2026-09-09_shop_print_options.sql";

type Client = pg.Client;
const problems: string[] = [];
let checks = 0;
function ok(label: string) { checks++; console.log(`  ✓ ${label}`); }
function bad(label: string) { checks++; problems.push(label); console.log(`  ✗ ${label}`); }

async function mustReject(c: Client, label: string, sql: string, params: any[] = []) {
  await c.query("SAVEPOINT s");
  try {
    await c.query(sql, params);
    await c.query("ROLLBACK TO SAVEPOINT s");
    bad(`${label} — was ACCEPTED, the database is not enforcing this`);
  } catch {
    await c.query("ROLLBACK TO SAVEPOINT s");
    ok(label);
  }
}
async function mustAccept(c: Client, label: string, sql: string, params: any[] = []) {
  await c.query("SAVEPOINT s");
  let r: any;
  try { r = await c.query(sql, params); }
  catch (e: any) { await c.query("ROLLBACK TO SAVEPOINT s"); bad(`${label} — was REFUSED: ${e.message}`); return null; }
  await c.query("RELEASE SAVEPOINT s");
  ok(label);
  return Array.isArray(r) ? undefined : r?.rows?.[0];
}

async function main() {
  const migrationPath = join(process.cwd(), "migrations", MIGRATION);
  const sql = readFileSync(migrationPath, "utf8");

  // The wrapper trap: a migration carrying its own BEGIN/COMMIT ends OUR
  // transaction early and the ROLLBACK below then runs in autocommit,
  // silently keeping whatever it wrote. Refuse to even try.
  if (/^\s*(BEGIN|COMMIT|ROLLBACK)\b/im.test(sql)) {
    throw new Error(
      `${MIGRATION} contains its own BEGIN/COMMIT/ROLLBACK — this would defeat the --dry-run wrapper. Remove it from the migration file.`,
    );
  }

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log(`\n  Shop print options — ${COMMIT ? "COMMIT" : "DRY RUN (rolled back)"}\n`);
  await client.query("BEGIN");
  try {
    // Baseline BEFORE the migration, so "untouched" is proven, not assumed.
    const before = await client.query(
      `select count(*)::int n from shop_products where organization_id in (1,3,5)`,
    );
    const productCountBefore = before.rows[0].n as number;

    await client.query(sql);
    console.log("  migration ran\n");

    // ── Columns exist, right shapes ─────────────────────────────────────
    {
      const r = await client.query(
        `select data_type, udt_name from information_schema.columns where table_name = 'shop_products' and column_name = 'print_options'`,
      );
      r.rows[0]?.data_type === "jsonb" ? ok("shop_products.print_options is jsonb") : bad(`shop_products.print_options is ${r.rows[0]?.data_type}`);
    }
    {
      const r = await client.query(
        `select data_type, is_nullable, column_default from information_schema.columns where table_name = 'shop_order_items' and column_name = 'print_cents'`,
      );
      r.rows[0]?.data_type === "integer" ? ok("shop_order_items.print_cents is integer") : bad(`shop_order_items.print_cents is ${r.rows[0]?.data_type}`);
      r.rows[0]?.column_default?.includes("0") ? ok("shop_order_items.print_cents defaults to 0") : bad(`shop_order_items.print_cents default is ${r.rows[0]?.column_default}`);
    }
    {
      const r = await client.query(
        `select conname from pg_constraint where conname = 'shop_order_items_print_cents_nonneg'`,
      );
      r.rowCount ? ok("shop_order_items_print_cents_nonneg constraint exists") : bad("the non-negative CHECK constraint is missing");
    }

    // ── Existing MFL/CIC/CUFC products/orders untouched ─────────────────
    const after = await client.query(
      `select count(*)::int n from shop_products where organization_id in (1,3,5)`,
    );
    after.rows[0].n === productCountBefore
      ? ok(`row count for MFL/CIC/CUFC products unchanged (${productCountBefore})`)
      : bad(`row count changed: ${productCountBefore} → ${after.rows[0].n}`);

    const nullCheck = await client.query(
      `select count(*)::int n from shop_products where organization_id in (1,3,5) and print_options is not null`,
    );
    nullCheck.rows[0].n === 0
      ? ok("every existing MFL/CIC/CUFC product carries print_options = NULL")
      : bad(`${nullCheck.rows[0].n} existing product(s) unexpectedly carry a print_options value`);

    const itemsCheck = await client.query(
      `select count(*)::int n from shop_order_items where print_cents <> 0`,
    );
    itemsCheck.rows[0].n === 0
      ? ok("every existing order item carries print_cents = 0")
      : bad(`${itemsCheck.rows[0].n} existing order item(s) unexpectedly carry a non-zero print_cents`);

    // ── Fixtures (discarded) ─────────────────────────────────────────────
    await client.query("SAVEPOINT fixtures");
    const org = (await client.query(`select id from organizations where slug = 'south-island-united'`)).rows[0];
    if (!org) throw new Error("no south-island-united org — cannot build fixtures");

    const printOptions = {
      key: "printing",
      label: "Printing",
      defaultChoice: "none",
      choices: [
        { key: "none", label: "No printing", priceDollars: 0, needsName: false, needsNumber: false },
        { key: "player", label: "Squad player", priceDollars: 19.99, needsName: true, needsNumber: true, fromSquad: true },
        { key: "custom", label: "Your own name & number", priceDollars: 19.99, needsName: true, needsNumber: true },
      ],
    };

    const prod = await mustAccept(client, "a product can carry print_options jsonb",
      `insert into shop_products (organization_id, slug, title, price_cents, status, print_options)
       values ($1, '__fixture_print_options__', 'Fixture Jersey', 13000, 'draft', $2::jsonb) returning id`,
      [org.id, JSON.stringify(printOptions)]);

    const colour = await mustAccept(client, "a colour for the fixture product",
      `insert into shop_product_colours (product_id, name, sort_order) values ($1, 'Default', 0) returning id`, [prod.id]);
    const variant = await mustAccept(client, "a variant for the fixture product",
      `insert into shop_variants (product_id, colour_id, size, stock) values ($1, $2, 'M', 10) returning id`, [prod.id, colour.id]);

    const order = await mustAccept(client, "a fixture order to hang order items off",
      `insert into shop_orders (organization_id, first_name, last_name, email, phone, subtotal_cents, total_cents)
       values ($1, 'Fixture', 'Buyer', 'fixture@example.com', '0210000000', 14999, 14999) returning id`, [org.id]);

    await mustAccept(client, "an order item can snapshot a positive print_cents",
      `insert into shop_order_items (order_id, product_id, variant_id, title, unit_cents, qty, line_cents, print_cents)
       values ($1, $2, $3, 'Fixture Jersey', 13000, 1, 14999, 1999)`, [order.id, prod.id, variant.id]);
    await mustAccept(client, "an order item with print_cents = 0 (no printing chosen)",
      `insert into shop_order_items (order_id, product_id, variant_id, title, unit_cents, qty, line_cents)
       values ($1, $2, $3, 'Fixture Jersey', 13000, 1, 13000)`, [order.id, prod.id, variant.id]);
    await mustReject(client, "a negative print_cents is refused",
      `insert into shop_order_items (order_id, product_id, variant_id, title, unit_cents, qty, line_cents, print_cents)
       values ($1, $2, $3, 'Fixture Jersey', 13000, 1, 12000, -1)`, [order.id, prod.id, variant.id]);
    await mustReject(client, "updating an existing item's print_cents negative is refused",
      `update shop_order_items set print_cents = -100 where order_id = $1`, [order.id]);

    // A product with print_options = NULL (every existing product) is
    // completely unaffected — inserting one still works exactly as before.
    await mustAccept(client, "a product with NO print_options still inserts fine (regression)",
      `insert into shop_products (organization_id, slug, title, price_cents, status)
       values ($1, '__fixture_no_print_options__', 'Fixture Plain Product', 2500, 'draft') returning id`, [org.id]);

    await mustAccept(client, "the whole migration re-runs cleanly (idempotent)", sql);

    await client.query("ROLLBACK TO SAVEPOINT fixtures");
    const left = (await client.query(
      `select
         (select count(*) from shop_products where slug like '__fixture%')::int p,
         (select count(*) from shop_orders where email = 'fixture@example.com')::int o
      `)).rows[0];
    left.p === 0 && left.o === 0 ? ok("no fixture data survives the rehearsal") : bad(`fixtures leaked: ${JSON.stringify(left)}`);
  } catch (e: any) {
    problems.push(`fatal: ${e.message}`);
    console.error(`\n  ✗ fatal: ${e.message}`);
  }

  const clean = problems.length === 0;
  if (COMMIT && clean) {
    await client.query("COMMIT");
    console.log(`\n  ${checks} checks passed — COMMITTED\n`);
  } else {
    await client.query("ROLLBACK");
    console.log(`\n  ${checks} checks, ${problems.length} problems — ROLLED BACK${!COMMIT && clean ? " (dry run; add --commit)" : ""}\n`);
    if (!clean) { problems.forEach((p) => console.log(`   - ${p}`)); process.exitCode = 1; }
  }
  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
