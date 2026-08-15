import pg from "pg";
const p = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const r = await p.query(`SELECT count(*) FILTER (WHERE kind='folder')::int f, count(*) FILTER (WHERE kind='file')::int fi,
  count(*) FILTER (WHERE extract_status='done')::int idx, pg_size_pretty(sum(size_bytes)) AS bytes FROM drive_nodes`);
console.log(r.rows[0]); await p.end();
