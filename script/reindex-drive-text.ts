// Re-extract text for files whose indexing failed.
//
//   Try 5:   npx tsx --env-file=.env script/reindex-drive-text.ts --limit 5
//   All:     npx tsx --env-file=.env script/reindex-drive-text.ts
//   Retry unsupported too: … --include-unsupported
//
// Needed because the first import ran without pdf.js's `standardFontDataUrl`,
// so every PDF using a standard font threw — and threw with an EMPTY message,
// which stored a blank error and looked like nothing had gone wrong. This
// re-reads the bytes we already hold and fills the search index in.
//
// Safe to re-run: it only ever moves a file from failed → done/unsupported, and
// touches nothing else about the row.
import { Pool } from "pg";
import { driveStorage } from "../server/drive-storage";
import { extractText } from "../server/drive-extract";

const args = process.argv.slice(2);
const flag = (n: string, d?: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d;
};
const LIMIT = Number(flag("limit", "0"));
const INCLUDE_UNSUPPORTED = args.includes("--include-unsupported");
const CONCURRENCY = Number(flag("concurrency", "6"));

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const statuses = INCLUDE_UNSUPPORTED ? ["failed", "unsupported"] : ["failed"];
const { rows } = await pool.query(
  `SELECT id, name, mime_type, storage_key FROM drive_nodes
   WHERE kind='file' AND storage_key IS NOT NULL AND extract_status = ANY($1)
   ORDER BY id ${LIMIT ? "LIMIT " + LIMIT : ""}`,
  [statuses],
);

console.log(`\n${rows.length} file(s) to re-index\n`);

let done = 0, stillNo = 0, failed = 0;
let i = 0;
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, rows.length) }, async () => {
    while (i < rows.length) {
      const r = rows[i++];
      try {
        const buf = await driveStorage().get(r.storage_key);
        const ex = await extractText(buf, r.mime_type, r.name);
        await pool.query(
          `UPDATE drive_nodes SET extracted_text=$1, extract_status=$2, extract_error=$3 WHERE id=$4`,
          [ex.text, ex.status, ex.error ?? null, r.id],
        );
        if (ex.status === "done") {
          done++;
          console.log(`  ✓ ${String(r.name).slice(0, 60)} — ${(ex.text ?? "").length} chars`);
        } else {
          stillNo++;
          console.log(`  · ${String(r.name).slice(0, 60)} — ${ex.status}: ${ex.error ?? ""}`);
        }
      } catch (e: any) {
        failed++;
        console.log(`  ✗ ${String(r.name).slice(0, 60)} — ${e.message}`);
      }
    }
  }),
);

console.log(`\n  indexed ${done} · still not readable ${stillNo} · errored ${failed}\n`);
await pool.end();
