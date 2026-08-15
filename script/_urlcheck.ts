import pg from "pg";
const p = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const c = await p.query(`SELECT count(*)::int n, count(source_url)::int u FROM drive_nodes WHERE source='google_drive'`);
console.log(`\n  imported from Google: ${c.rows[0].n} · with a live link: ${c.rows[0].u}`);
const s = await p.query(`SELECT name, source_url FROM drive_nodes WHERE source_url IS NOT NULL AND kind='file' LIMIT 4`);
for (const r of s.rows) console.log(`   ${String(r.name).slice(0,44).padEnd(46)} ${r.source_url}`);
const k = await p.query(`SELECT count(*)::int n FROM drive_nodes WHERE storage_backend='google'`);
console.log(`\n  Google-only (Forms/Sites, link-only already): ${k.rows[0].n}\n`);
await p.end();
