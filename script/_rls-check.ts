import pg from "pg";
async function main() {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const r = await c.query(
    `select relname from pg_class cl
       join pg_namespace n on n.oid = cl.relnamespace
      where n.nspname='public' and cl.relkind='r' and cl.relrowsecurity = false
      order by relname`);
  const t = await c.query(
    `select count(*)::int n from pg_class cl join pg_namespace nn on nn.oid=cl.relnamespace
      where nn.nspname='public' and cl.relkind='r'`);
  console.log(r.rowCount === 0
    ? `  RLS: every one of ${t.rows[0].n} public tables has RLS enabled`
    : `  RLS: ${r.rowCount} of ${t.rows[0].n} table(s) WITHOUT RLS:\n` +
      r.rows.map((x: any) => "    · " + x.relname).join("\n"));
  await c.end();
  process.exit(r.rowCount === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
