import { Pool } from "pg";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, "..", "migrations", "2026-08-16_drive_search_vector.sql"), "utf8");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const db = await pool.connect();
try {
  console.log("\napplying drive search vector…");
  await db.query(sql);
  const c = await db.query(`SELECT count(*)::int n, count(search_vec)::int v FROM drive_nodes`);
  console.log(`  rows ${c.rows[0].n} · with a search vector ${c.rows[0].v}`);
  const i = await db.query(`SELECT indexname FROM pg_indexes WHERE tablename='drive_nodes' AND indexname LIKE '%search_vec%' OR indexname LIKE '%trgm%'`);
  console.log(`  indexes: ${i.rows.map((x:any)=>x.indexname).join(", ")}`);
} finally { db.release(); await pool.end(); }
