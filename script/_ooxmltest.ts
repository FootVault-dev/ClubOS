import pg from "pg";
import { driveStorage } from "../server/drive-storage";
import { extractText } from "../server/drive-extract";
const p = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
for (const ext of ["docx", "pptx"]) {
  const r = await p.query(`SELECT name, mime_type, storage_key FROM drive_nodes
    WHERE extract_status='unsupported' AND lower(name) LIKE $1 AND storage_key IS NOT NULL LIMIT 2`, ["%." + ext]);
  for (const f of r.rows) {
    const buf = await driveStorage().get(f.storage_key);
    const ex = await extractText(buf, f.mime_type, f.name);
    const preview = (ex.text ?? "").replace(/\s+/g, " ").slice(0, 90);
    console.log(`  [${ex.status}] ${String(f.name).slice(0, 42).padEnd(44)} ${(ex.text ?? "").length} chars  ${preview}`);
  }
}
await p.end();
