import pg from "pg";
const p = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const r = await p.query(`
  SELECT CASE
    WHEN lower(name) ~ '\\.(jpg|jpeg|png|gif|heic|webp|svg|tif|tiff)$' THEN 'image'
    WHEN lower(name) ~ '\\.(mp4|mov|avi|mkv|m4v|wmv)$'                THEN 'video'
    WHEN lower(name) ~ '\\.(mp3|wav|m4a|aac)$'                        THEN 'audio'
    WHEN lower(name) ~ '\\.(zip|rar|7z|gz)$'                          THEN 'archive'
    WHEN lower(name) ~ '\\.(docx|doc|pptx|ppt|pages|key|numbers)$'    THEN 'office (no zip reader)'
    WHEN lower(name) ~ '\\.pdf$'                                      THEN 'pdf — scan, needs OCR'
    ELSE 'other' END AS why,
    count(*)::int n
  FROM drive_nodes WHERE extract_status='unsupported' GROUP BY 1 ORDER BY 2 DESC`);
console.log("\nwhy 2,538 files have no searchable text:\n");
for (const x of r.rows) console.log(`  ${String(x.why).padEnd(26)} ${String(x.n).padStart(5)}`);
await p.end();
