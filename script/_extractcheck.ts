import pg from "pg";
const p = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const r = await p.query(`
  SELECT extract_status, count(*)::int AS n FROM drive_nodes WHERE kind='file' GROUP BY 1 ORDER BY 2 DESC`);
console.log("\nextract_status:"); for (const x of r.rows) console.log(`  ${String(x.extract_status ?? "(null)").padEnd(14)} ${x.n}`);
const e = await p.query(`
  SELECT name, extract_status, left(coalesce(extract_error,''),90) AS err FROM drive_nodes
  WHERE kind='file' AND extract_status IN ('failed','unsupported') AND lower(name) LIKE '%.pdf' LIMIT 8`);
console.log("\nsample PDFs not indexed:"); for (const x of e.rows) console.log(`  [${x.extract_status}] ${String(x.name).slice(0,50)} — ${x.err}`);
const ok = await p.query(`SELECT count(*)::int AS n FROM drive_nodes WHERE extract_status='done' AND length(extracted_text)>50`);
console.log(`\n  files with real searchable text: ${ok.rows[0].n}\n`);
await p.end();
