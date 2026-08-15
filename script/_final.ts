import pg from "pg";
const p = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const t = await p.query(`SELECT count(*) FILTER (WHERE kind='folder')::int f, count(*) FILTER (WHERE kind='file')::int fi,
  count(*) FILTER (WHERE extract_status='done')::int idx, pg_size_pretty(sum(size_bytes)) b FROM drive_nodes WHERE trashed_at IS NULL`);
const g = await p.query(`SELECT count(*) FILTER (WHERE gates <> '{}')::int locked, count(*)::int total FROM drive_node_gates`);
const l = await p.query(`SELECT count(*)::int n FROM drive_nodes WHERE source_url LIKE '%docs.google.com/%'`);
console.log(`\n  folders            ${t.rows[0].f}`);
console.log(`  files              ${t.rows[0].fi}   (${t.rows[0].b})`);
console.log(`  searchable inside  ${t.rows[0].idx}`);
console.log(`  live Google docs   ${l.rows[0].n}`);
console.log(`  locked to Daniel   ${g.rows[0].locked} of ${g.rows[0].total} nodes\n`);
await p.end();
