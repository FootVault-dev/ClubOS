// Does search actually find real club content by words INSIDE a file?
import pg from "pg";
const p = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const sample = await p.query(`
  SELECT name, left(extracted_text, 300) AS head FROM drive_nodes
  WHERE extract_status='done' AND length(extracted_text) > 800 ORDER BY random() LIMIT 1`);
if (!sample.rows.length) { console.log("nothing indexed yet"); await p.end(); process.exit(0); }
const doc = sample.rows[0];
// Pick a distinctive multi-word phrase from inside the document.
const words = String(doc.head).replace(/\s+/g, " ").split(" ").filter(w => w.length > 4).slice(6, 10);
const phrase = words.join(" ");
console.log(`\n  file   : ${doc.name}`);
console.log(`  phrase : "${phrase}"  (taken from INSIDE the file, not its name)\n`);
const t0 = Date.now();
const r = await p.query(`
  SELECT name, ts_rank(
      setweight(to_tsvector('english', coalesce(name,'')), 'A') ||
      setweight(to_tsvector('english', coalesce(extracted_text,'')), 'C'),
      plainto_tsquery('english', $1)) AS rank
  FROM drive_nodes
  WHERE trashed_at IS NULL AND (
    setweight(to_tsvector('english', coalesce(name,'')), 'A') ||
    setweight(to_tsvector('english', coalesce(extracted_text,'')), 'C')
  ) @@ plainto_tsquery('english', $1)
  ORDER BY rank DESC LIMIT 5`, [phrase]);
console.log(`  ${r.rows.length} hit(s) in ${Date.now() - t0}ms:`);
for (const x of r.rows) console.log(`    ${String(x.name).slice(0, 62)}`);
const found = r.rows.some((x: any) => x.name === doc.name);
console.log(`\n  ${found ? "✓ the source file came back" : "✗ the source file did NOT come back"}\n`);
const tot = await p.query(`SELECT count(*)::int n, count(*) FILTER (WHERE extract_status='done')::int d FROM drive_nodes WHERE kind='file'`);
console.log(`  ${tot.rows[0].d} of ${tot.rows[0].n} files searchable so far\n`);
await p.end();
