import pg from "pg";
const p = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const q = "academy report";
// EXACTLY the expression the GIN index was built on — anything else can't use it.
const sql = `
  SELECT id FROM drive_nodes
  WHERE trashed_at IS NULL AND (
    setweight(to_tsvector('english', coalesce(name,'')), 'A') ||
    setweight(to_tsvector('english', coalesce(description,'')), 'B') ||
    setweight(to_tsvector('english', coalesce(extracted_text,'')), 'C')
  ) @@ plainto_tsquery('english', $1) LIMIT 60`;
const plan = await p.query(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, [q]);
const txt = plan.rows.map((r: any) => r["QUERY PLAN"]).join("\n");
console.log("\n" + txt.split("\n").filter((l: string) => /Scan|Time|Filter/.test(l)).slice(0, 6).join("\n"));
console.log(`\n  uses the GIN index: ${/Bitmap Index Scan on drive_nodes_fts_idx/.test(txt) ? "YES" : "NO — sequential scan"}\n`);
await p.end();
