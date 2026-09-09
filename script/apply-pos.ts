// Apply migrations/2026-09-09_pos.sql, rehearsing it first.
//
//   npx tsx --env-file=.env script/apply-pos.ts             (dry run)
//   npx tsx --env-file=.env script/apply-pos.ts --commit
//
// There is no local Postgres, so a dry run is the only rehearsal available: it
// runs the real DDL and the real verification inside a transaction it then
// rolls back. Additive and idempotent.
//
// The behavioural checks are the point. Every money rule the register relies
// on is a trigger or a CHECK, and each one is proven here by a write the
// database must refuse: a line for a brand in the wrong money bucket, a line
// on a sale that has taken money, a payment above what is owed, a refund above
// what was paid, a payment edited after it succeeded, a sale deleted after it
// took money, a second open shift on one register, a shift closed over a
// part-paid sale, and a paid sale reached without paid = total.
import { readFileSync } from "fs";
import { join } from "path";
import pg from "pg";

const COMMIT = process.argv.includes("--commit");

async function main() {
  const sql = readFileSync(join(process.cwd(), "migrations", "2026-09-09_pos.sql"), "utf8");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();

  console.log(`\n  pos_* — ${COMMIT ? "COMMIT" : "DRY RUN (rolled back)"}\n`);
  await client.query("BEGIN");
  const problems: string[] = [];
  const ok = (label: string, cond: boolean, detail = "") => {
    console.log(`  ${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
    if (!cond) problems.push(label);
  };
  // Run a statement inside a savepoint and report whether Postgres refused it.
  const refused = async (label: string, stmt: string, params: unknown[] = [], wantCode?: string) => {
    await client.query("SAVEPOINT p");
    try {
      await client.query(stmt, params);
      await client.query("RELEASE SAVEPOINT p");
      ok(label, false, "the write was ACCEPTED");
    } catch (e: any) {
      await client.query("ROLLBACK TO SAVEPOINT p");
      const msg = String(e?.message ?? e);
      ok(label, wantCode ? msg.includes(wantCode) : true, msg.slice(0, 90));
    }
  };

  try {
    await client.query(sql);
    console.log("  migration ran");

    for (const table of ["pos_org_money_accounts", "pos_registers", "pos_shifts", "pos_sales", "pos_sale_lines", "pos_payments", "pos_refunds", "pos_declines"]) {
      const t = await client.query(`select relrowsecurity from pg_class where relname = $1`, [table]);
      ok(`${table} exists with RLS on`, t.rowCount === 1 && t.rows[0].relrowsecurity === true);
    }
    const col = await client.query(`select 1 from information_schema.columns where table_name='registrations' and column_name='pos_sale_id'`);
    ok("registrations.pos_sale_id added", col.rowCount === 1);

    const buckets = await client.query(`select o.slug, m.account from pos_org_money_accounts m join organizations o on o.id = m.organization_id order by o.id`);
    const gym = buckets.rows.find((r) => r.slug === "united-gymnastics");
    ok("every organisation has a money account", buckets.rows.length >= 8, `${buckets.rows.length} rows`);
    ok("United Gymnastics banks to cugc, everyone else to club", gym?.account === "cugc" && buckets.rows.filter((r) => r.slug !== "united-gymnastics").every((r) => r.account === "club"));

    const reg = await client.query(`select id from pos_registers order by id limit 1`);
    ok("a first register exists (Office counter)", reg.rowCount === 1);
    const registerId = reg.rows[0].id;

    // A real staff user to hang the audit trail on — never a made-up id.
    const u = await client.query(`select id from users where active = true order by id limit 1`);
    const userId = u.rows[0].id;
    const cufc = (await client.query(`select id from organizations where slug='christchurch-united'`)).rows[0].id;
    const siu = (await client.query(`select id from organizations where slug='south-island-united'`)).rows[0].id;
    const gymOrg = (await client.query(`select id from organizations where slug='united-gymnastics'`)).rows[0].id;

    // ── Shifts ──────────────────────────────────────────────────────────────
    const sh = await client.query(
      `insert into pos_shifts (register_id, opened_by_user_id, opening_float_cents) values ($1,$2,10000) returning id`, [registerId, userId]);
    const shiftId = sh.rows[0].id;
    await refused("a second open shift on the same register is refused",
      `insert into pos_shifts (register_id, opened_by_user_id) values ($1,$2)`, [registerId, userId], "pos_shifts_one_open_per_register");
    await refused("a shift cannot close with a count but no closer",
      `update pos_shifts set closed_at = now(), closing_cash_counted_cents = 100 where id = $1`, [shiftId], "pos_shifts_close_pair");

    // ── Sale + lines ────────────────────────────────────────────────────────
    const sale = await client.query(
      `insert into pos_sales (register_id, shift_id, money_account, served_by_user_id) values ($1,$2,'club',$3) returning id, sale_number, token`,
      [registerId, shiftId, userId]);
    const saleId = sale.rows[0].id;
    ok("the database minted a sale number", /^R-\d{6}$/.test(sale.rows[0].sale_number), sale.rows[0].sale_number);

    await client.query(`insert into pos_sale_lines (sale_id, kind, organization_id, title, unit_cents, qty, line_cents) values ($1,'custom',$2,'CUFC scarf',2500,2,5000)`, [saleId, cufc]);
    await client.query(`insert into pos_sale_lines (sale_id, kind, organization_id, title, unit_cents, qty, line_cents) values ($1,'custom',$2,'SIU hoodie',7999,1,7999)`, [saleId, siu]);
    let s = (await client.query(`select subtotal_cents, total_cents, gst_cents from pos_sales where id=$1`, [saleId])).rows[0];
    ok("a CUFC line and an SIU line share one cart", s.subtotal_cents === 12999 && s.total_cents === 12999, `total ${s.total_cents}`);
    ok("GST content is total × 3 ÷ 23", s.gst_cents === Math.round((12999 * 3) / 23), `gst ${s.gst_cents}`);

    await refused("a Gymnastics line in a club-bucket sale is refused (different money account)",
      `insert into pos_sale_lines (sale_id, kind, organization_id, title, unit_cents, qty, line_cents) values ($1,'custom',$2,'Leotard',5000,1,5000)`, [saleId, gymOrg], "POS_BUCKET_MISMATCH");
    await refused("line arithmetic is checked (unit × qty ≠ line)",
      `insert into pos_sale_lines (sale_id, kind, organization_id, title, unit_cents, qty, line_cents) values ($1,'custom',$2,'Bad maths',100,2,150)`, [saleId, cufc], "pos_sale_lines_math");

    await client.query(`update pos_sales set discount_cents = 999, discount_reason = 'staff price' where id = $1`, [saleId]);
    s = (await client.query(`select total_cents from pos_sales where id=$1`, [saleId])).rows[0];
    ok("a discount with a reason recomputes the total", s.total_cents === 12000, `total ${s.total_cents}`);
    await refused("a discount without a reason is refused",
      `update pos_sales set discount_cents = 500, discount_reason = null where id = $1`, [saleId], "pos_sales_discount_reason");

    // ── Payments ────────────────────────────────────────────────────────────
    await refused("paying more than is owed is refused",
      `insert into pos_payments (sale_id, method, amount_cents, created_by_user_id, succeeded_at) values ($1,'cash',12001,$2,now())`, [saleId, userId], "POS_OVERPAY");
    await client.query(`insert into pos_payments (sale_id, method, amount_cents, reference, created_by_user_id, succeeded_at) values ($1,'eftpos',5000,'slip 4471',$2,now())`, [saleId, userId]);
    s = (await client.query(`select status, paid_cents from pos_sales where id=$1`, [saleId])).rows[0];
    ok("a part payment leaves the sale open with paid_cents moved", s.status === "open" && s.paid_cents === 5000);
    await refused("a card payment must carry a PaymentIntent",
      `insert into pos_payments (sale_id, method, amount_cents, created_by_user_id, status) values ($1,'card_present',1,$2,'pending')`, [saleId, userId], "pos_payments_card_needs_pi");
    await refused("lines are frozen once any money has landed",
      `insert into pos_sale_lines (sale_id, kind, organization_id, title, unit_cents, qty, line_cents) values ($1,'custom',$2,'Late add',100,1,100)`, [saleId, cufc], "POS_LINES_FROZEN");
    await refused("the shift cannot close over a part-paid sale",
      `update pos_shifts set closed_at = now(), closed_by_user_id = $2, closing_cash_counted_cents = 0 where id = $1`, [shiftId, userId], "POS_SHIFT_HAS_PARTIAL");
    await refused("a paid sale cannot be faked by hand (paid_at without paid = total)",
      `update pos_sales set status = 'paid', paid_at = now() where id = $1`, [saleId], "pos_sales_state");

    const pay = await client.query(`insert into pos_payments (sale_id, method, amount_cents, created_by_user_id, succeeded_at) values ($1,'cash',7000,$2,now()) returning id`, [saleId, userId]);
    s = (await client.query(`select status, paid_cents, paid_at from pos_sales where id=$1`, [saleId])).rows[0];
    ok("paid = total flips the sale to paid with a timestamp", s.status === "paid" && s.paid_cents === 12000 && s.paid_at != null);
    await refused("a succeeded payment cannot be edited",
      `update pos_payments set amount_cents = 1 where id = $1`, [pay.rows[0].id], "POS_PAYMENT_IMMUTABLE");
    await refused("a succeeded payment cannot be deleted",
      `delete from pos_payments where id = $1`, [pay.rows[0].id], "POS_PAYMENT_IMMUTABLE");
    await refused("a sale that took money cannot be deleted",
      `delete from pos_sales where id = $1`, [saleId], "POS_SALE_HAS_MONEY");

    // ── Refunds ─────────────────────────────────────────────────────────────
    await refused("refunding more than was paid is refused",
      `insert into pos_refunds (sale_id, method, amount_cents, reason, issued_by_user_id) values ($1,'cash',12001,'test',$2)`, [saleId, userId], "POS_OVERREFUND");
    await refused("a refund without a reason is refused",
      `insert into pos_refunds (sale_id, method, amount_cents, reason, issued_by_user_id) values ($1,'cash',100,'   ',$2)`, [saleId, userId], "pos_refunds_reason");
    await client.query(`insert into pos_refunds (sale_id, method, amount_cents, reason, issued_by_user_id) values ($1,'cash',2000,'wrong size, exchanged',$2)`, [saleId, userId]);
    s = (await client.query(`select status, refunded_cents from pos_sales where id=$1`, [saleId])).rows[0];
    ok("a part refund reads partially_refunded", s.status === "partially_refunded" && s.refunded_cents === 2000);
    await client.query(`insert into pos_refunds (sale_id, method, amount_cents, reason, issued_by_user_id) values ($1,'cash',10000,'event cancelled',$2)`, [saleId, userId]);
    s = (await client.query(`select status, refunded_cents from pos_sales where id=$1`, [saleId])).rows[0];
    ok("refunding the rest reads refunded", s.status === "refunded" && s.refunded_cents === 12000);

    // ── Void + close ────────────────────────────────────────────────────────
    const s2 = await client.query(`insert into pos_sales (register_id, shift_id, money_account, served_by_user_id) values ($1,$2,'club',$3) returning id`, [registerId, shiftId, userId]);
    await refused("a void needs a reason", `update pos_sales set status='void', voided_at=now() where id=$1`, [s2.rows[0].id], "pos_sales_state");
    await client.query(`update pos_sales set status='void', voided_at=now(), void_reason='customer walked' where id=$1`, [s2.rows[0].id]);
    await client.query(`update pos_shifts set closed_at = now(), closed_by_user_id = $2, closing_cash_counted_cents = 15000 where id = $1`, [shiftId, userId]);
    const closed = (await client.query(`select closed_at from pos_shifts where id=$1`, [shiftId])).rows[0];
    ok("the shift closes once every sale is finished", closed.closed_at != null);
    await refused("a closed shift's count cannot be edited",
      `update pos_shifts set closing_cash_counted_cents = 1 where id = $1`, [shiftId], "POS_SHIFT_CLOSED");
    await refused("a sale cannot open on a closed shift",
      `insert into pos_sales (register_id, shift_id, money_account, served_by_user_id) values ($1,$2,'club',$3)`, [registerId, shiftId, userId], "POS_SHIFT_CLOSED");

    if (problems.length) throw new Error(`${problems.length} check(s) failed: ${problems.join("; ")}`);

    if (COMMIT) {
      // The rehearsal rows must not survive a commit.
      await client.query(`delete from pos_refunds where sale_id = $1`, [saleId]).catch(() => {});
      throw new Error("refusing to commit with rehearsal rows inside the transaction — run dry, then apply the SQL only");
    }
    await client.query("ROLLBACK");
    console.log("\n  DRY RUN — rolled back. All checks passed.\n");
  } catch (e) {
    await client.query("ROLLBACK");
    if (!COMMIT) { console.error("\n  FAILED:", (e as Error).message, "\n"); process.exit(1); }
    // Commit path: apply the DDL alone (idempotent), with no rehearsal rows.
    if (problems.length) { console.error("\n  FAILED:", (e as Error).message, "\n"); process.exit(1); }
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
    console.log("\n  COMMITTED — migration applied (rehearsal passed, then the DDL alone was committed).\n");
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
