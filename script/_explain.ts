import pg from "pg";
const p = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const q = "monthly staff report";
const sql = `
  SELECT id, name,
    ts_rank(search_vec, plainto_tsquery('english',$1)) AS rank,
    similarity(lower(name), lower($1)) AS name_sim
  FROM drive_nodes
  WHERE trashed_at IS NULL AND (
    search_vec @@ plainto_tsquery('english',$1)
    OR lower(name) LIKE $2 OR lower(name) % lower($1))
  ORDER BY name_sim DESC, rank DESC, updated_at DESC LIMIT 60`;
const r = await p.query(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, [q, "%" + q.toLowerCase() + "%"]);
console.log(r.rows.map((x: any) => x["QUERY PLAN"]).join("\n").split("\n").slice(0, 14).join("\n"));
await p.end();
