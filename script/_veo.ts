import pg from 'pg';
async function main(){
  const c=new pg.Client({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
  await c.connect();
  const r=await c.query(`select name, mime_type, size_bytes, created_at::date
                         from drive_nodes where name ilike '%veo%' order by created_at desc limit 15`);
  console.table(r.rows);
  await c.end();
}
main().catch(e=>console.log('ERR',e.message));
