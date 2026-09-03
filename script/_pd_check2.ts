import pg from 'pg';
async function main() {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const q = async (l: string, s: string) => {
    try { console.log('\n### ' + l); console.table((await c.query(s)).rows); }
    catch (e: any) { console.log(l, 'ERR', e.message); }
  };
  await q('columns on sponsorship_deals',
    `select column_name from information_schema.columns where table_name='sponsorship_deals' order by ordinal_position`);
  await q('completeness of the 64 migrated deals', `
    select count(*)::int as deals,
      count(primary_contact_name)::int as has_name,
      count(nullif(primary_contact_email,''))::int as has_email,
      count(nullif(primary_contact_phone,''))::int as has_phone,
      count(*) filter (where deal_value_cents > 0)::int as has_value,
      count(expected_close_date)::int as has_close_date
    from sponsorship_deals where notes like '%[from-pipedrive]%'`);
  await q('deals created SINCE the migration (4 May)',
    `select id, title, stage, organization_id, created_at::date
     from sponsorship_deals where created_at::date > date '2026-05-04' order by created_at`);
  await q('any deal EDITED since the migration?', `
    select count(*)::int as edited_since_may
    from sponsorship_deals where updated_at::date > date '2026-05-05'`);
  await q('related activity tables present', `
    select table_name from information_schema.tables
    where table_name like 'sponsor%' or table_name like '%deliverable%' order by 1`);
  await c.end();
}
main().catch(e => { console.error('FATAL', e.message); process.exit(1); });
