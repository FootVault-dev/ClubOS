import pg from 'pg';
async function main() {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const q = async (label: string, s: string) => {
    try { console.log(label, JSON.stringify((await c.query(s)).rows)); }
    catch (e: any) { console.log(label, 'ERR', e.message); }
  };
  await q('total_deals     ', `select count(*)::int from sponsorship_deals`);
  await q('from_pipedrive  ', `select count(*)::int from sponsorship_deals where notes like '%[from-pipedrive]%'`);
  await q('by_org          ', `select organization_id, count(*)::int from sponsorship_deals group by 1 order by 2 desc`);
  await q('pipedrive_range ', `select min(created_at)::date as first, max(created_at)::date as last from sponsorship_deals where notes like '%[from-pipedrive]%'`);
  await q('stages          ', `select stage, count(*)::int from sponsorship_deals where notes like '%[from-pipedrive]%' group by 1 order by 2 desc`);
  await c.end();
}
main().catch(e => { console.error('FATAL', e.message); process.exit(1); });
