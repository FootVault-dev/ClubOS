import pg from "pg";
const p = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const r = await p.query(`SELECT left(extract_error,70) AS err, count(*)::int n FROM drive_nodes WHERE extract_status='failed' GROUP BY 1 ORDER BY 2 DESC LIMIT 8`);
console.log("\nfailures by reason:"); for (const x of r.rows) console.log(`  ${String(x.n).padStart(3)}  ${x.err}`);
const u = await p.query(`SELECT CASE
    WHEN lower(name) ~ '\\.(jpg|jpeg|png|gif|heic|webp|svg|tif|tiff)$' THEN 'image'
    WHEN lower(name) ~ '\\.(mp4|mov|avi|mkv|m4v|wmv)$' THEN 'video'
    WHEN lower(name) ~ '\\.pdf$' THEN 'pdf — scan, needs OCR'
    WHEN lower(name) ~ '\\.(doc|ppt|pages|key|numbers)$' THEN 'legacy Office / Apple'
    ELSE 'other' END AS why, count(*)::int n
  FROM drive_nodes WHERE extract_status='unsupported' GROUP BY 1 ORDER BY 2 DESC`);
console.log("\nstill not searchable:"); for (const x of u.rows) console.log(`  ${String(x.n).padStart(5)}  ${x.why}`);
await p.end();
