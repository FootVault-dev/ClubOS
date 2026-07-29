// D29 verification — exercises the quick-item write path against the LIVE
// warehouse inside a transaction that is always ROLLED BACK.
//
// The point is that "the route returns 401" only proves the code shipped. This
// proves the thing it actually does works on the real database: that the three
// inserts succeed together, that the unique indexes behave the way the route
// assumes, and that a barcode already in use is genuinely rejected by the data
// rather than only by an `if` in the handler.
//
//   npx tsx --env-file=.env script/verify-quick-item-live.ts
//
// Writes nothing. Every assertion runs inside ROLLBACK.

import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

let passed = 0;
const fails: string[] = [];
function ok(name: string, cond: boolean, extra = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}${extra ? ` — ${extra}` : ""}`); }
  else { fails.push(name); console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ""}`); }
}

async function main() {
  const c = await pool.connect();
  try {
    // Baseline, outside the transaction.
    const before = await c.query(`
      SELECT (SELECT count(*) FROM wh_items)           AS items,
             (SELECT count(*) FROM wh_barcode_aliases) AS aliases,
             (SELECT count(*) FROM wh_item_fields)     AS fields,
             (SELECT count(*) FROM wh_movements)       AS movements,
             (SELECT count(*) FROM wh_locations WHERE active) AS locations
    `);
    const b = before.rows[0];
    console.log(`\nLive warehouse: ${b.items} items · ${b.aliases} barcode aliases · ${b.fields} field values · ${b.movements} movements · ${b.locations} locations\n`);

    console.log("Locations Dima can count into:");
    const locs = await c.query(`SELECT code, name, kind FROM wh_locations WHERE active AND kind <> 'virtual' ORDER BY code`);
    for (const l of locs.rows) console.log(`  · ${l.name ?? "(no name)"}  [${l.code}]  ${l.kind}`);
    console.log();

    await c.query("BEGIN");

    const SKU = `ZZTEST-D29-${Date.now().toString().slice(-6)}`;
    const CODE = `TESTEAN${Date.now().toString().slice(-9)}`;

    // 1. The three inserts the route performs, in one transaction.
    const item = await c.query(
      `INSERT INTO wh_items (sku, name, kind, tracking_mode, brand_owner, category, unit, notes)
       VALUES ($1,$2,'merch','stock','club','uniform','ea',$3) RETURNING id, sku, name, category, tracking_mode`,
      [SKU, "KELME Football Shorts Adults Navy L", "Box 3 had 2 faded prints"],
    );
    const itemId = item.rows[0].id;
    ok("item inserts with the quick-item shape", !!itemId, `${item.rows[0].sku} · ${item.rows[0].category} · ${item.rows[0].tracking_mode}`);

    await c.query(`INSERT INTO wh_barcode_aliases (code, item_id, pack_qty, note) VALUES ($1,$2,'1','Linked during a stock take')`, [CODE, itemId]);
    ok("barcode alias links to the new item", true, CODE);

    await c.query(
      `INSERT INTO wh_item_fields (item_id, field_key, value_text) VALUES
        ($1,'vendor','KELME'),($1,'vendor_model','K123-45'),($1,'colour','Navy'),($1,'size_asian','L'),($1,'size_eu','XL')`,
      [itemId],
    );
    const fields = await c.query(
      `SELECT field_key, value_text FROM wh_item_fields WHERE item_id = $1 ORDER BY field_key`, [itemId]);
    ok("all five apparel attributes stored", fields.rows.length === 5,
      fields.rows.map((r) => `${r.field_key}=${r.value_text}`).join(" "));

    // 2. The scan path the counting screen depends on: this EAN now resolves.
    const resolved = await c.query(
      `SELECT i.id, i.sku, i.name, a.pack_qty FROM wh_barcode_aliases a
       JOIN wh_items i ON i.id = a.item_id WHERE a.code = $1`, [CODE]);
    ok("🔴 the scanned barcode now resolves to the item", resolved.rows.length === 1 && resolved.rows[0].id === itemId,
      `${resolved.rows[0]?.sku} pack=${resolved.rows[0]?.pack_qty}`);

    // 3. The guard that matters most: the same code cannot point at two items.
    const other = await c.query(
      `INSERT INTO wh_items (sku, name, kind, tracking_mode, brand_owner, unit)
       VALUES ($1,'Decoy','merch','stock','club','ea') RETURNING id`, [`${SKU}-B`]);
    let clashRejected = false;
    try {
      await c.query("SAVEPOINT s1");
      await c.query(`INSERT INTO wh_barcode_aliases (code, item_id, pack_qty) VALUES ($1,$2,'1')`, [CODE, other.rows[0].id]);
      await c.query("ROLLBACK TO SAVEPOINT s1");
    } catch {
      clashRejected = true;
      await c.query("ROLLBACK TO SAVEPOINT s1");
    }
    ok("🔴 a barcode cannot be registered to a second item (DB-enforced)", clashRejected,
      clashRejected ? "unique index rejected it" : "NO DB CONSTRAINT — the handler check is the only guard");

    // 4. Duplicate SKU is refused, which is why the route suffixes instead.
    let skuRejected = false;
    try {
      await c.query("SAVEPOINT s2");
      await c.query(`INSERT INTO wh_items (sku, name, kind, tracking_mode, brand_owner, unit) VALUES ($1,'Dup','merch','stock','club','ea')`, [SKU]);
      await c.query("ROLLBACK TO SAVEPOINT s2");
    } catch {
      skuRejected = true;
      await c.query("ROLLBACK TO SAVEPOINT s2");
    }
    ok("duplicate SKU refused by the database", skuRejected);

    // 5. One field value per key per item — a re-save updates, never doubles.
    let dupFieldRejected = false;
    try {
      await c.query("SAVEPOINT s3");
      await c.query(`INSERT INTO wh_item_fields (item_id, field_key, value_text) VALUES ($1,'colour','Red')`, [itemId]);
      await c.query("ROLLBACK TO SAVEPOINT s3");
    } catch {
      dupFieldRejected = true;
      await c.query("ROLLBACK TO SAVEPOINT s3");
    }
    ok("one value per attribute per item", dupFieldRejected);

    // 6. A stock take of this item would post a real ledger delta.
    const loc = locs.rows[0];
    if (loc) {
      const locId = (await c.query(`SELECT id FROM wh_locations WHERE code = $1`, [loc.code])).rows[0].id;
      const onHand = (await c.query(`SELECT on_hand FROM wh_stock WHERE item_id = $1 AND location_id = $2`, [itemId, locId])).rows[0];
      ok("a freshly registered item starts at zero on hand", !onHand || Number(onHand.on_hand) === 0,
        `counting 10 at ${loc.name ?? loc.code} would write delta +10`);
    }

    await c.query("ROLLBACK");

    // Nothing survived.
    const after = await pool.query(`
      SELECT (SELECT count(*) FROM wh_items)           AS items,
             (SELECT count(*) FROM wh_barcode_aliases) AS aliases,
             (SELECT count(*) FROM wh_item_fields)     AS fields
    `);
    const a = after.rows[0];
    ok("🔴 rolled back — the live warehouse is untouched",
      a.items === b.items && a.aliases === b.aliases && a.fields === b.fields,
      `${a.items} items · ${a.aliases} aliases · ${a.fields} fields`);
  } finally {
    c.release();
    await pool.end();
  }

  console.log(`\n${fails.length ? "❌" : "✅"} ${passed} passed, ${fails.length} failed`);
  if (fails.length) { console.error(fails.join("\n")); process.exitCode = 1; }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
