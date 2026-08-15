// ─────────────────────────────────────────────────────────────────────────────
// Import the club's Google Drive into Club Drive.
//
//   Survey:  npx tsx --env-file=.env script/import-google-drive.ts --folder <id> --dry-run
//   Import:  npx tsx --env-file=.env script/import-google-drive.ts --folder <id> --max-mb 50
//
// 🔴 IDEMPOTENT. Every node records (source='google_drive', source_id=<file id>)
// behind a unique index, so re-running adopts what is already here instead of
// duplicating it. That matters more than usual: this will be run repeatedly as
// the token expires, folders are added, and the media tail is decided on.
//
// 🔴 DOCUMENTS FIRST, MEDIA LAST. The club Drive holds ~2.86 TB, and almost all
// of that is raw video and photography — cold files nobody opens in a browser
// and which belong on cheap bulk storage, not in the searchable document store.
// `--max-mb` (default 50) is the line. Skipped files are REPORTED, never
// silently dropped, so the tail is a decision rather than an accident.
//
// 🔴 A Google Doc has no bytes. It is exported twice: once to Office format so
// the file is real and downloadable, and once to text/plain so its CONTENTS are
// searchable — which is the entire point of moving it.
// ─────────────────────────────────────────────────────────────────────────────
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { Pool } from "pg";
import { GOOGLE_EXPORT, GOOGLE_FOLDER_MIME, googleIsUnexportable } from "../shared/drive";
import { driveStorage } from "../server/drive-storage";
import { extractText } from "../server/drive-extract";

const args = process.argv.slice(2);
const flag = (n: string, d?: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d;
};
const DRY_RUN = args.includes("--dry-run");
const ROOT_FOLDER = flag("folder");
const MAX_BYTES = Number(flag("max-mb", "50")) * 1024 * 1024;
const LIMIT = Number(flag("limit", "0"));
const INTO = flag("into");   // optional existing drive_nodes folder id to nest under

if (!ROOT_FOLDER) {
  console.error("Need --folder <google drive folder id>");
  process.exit(1);
}

// ── Google auth ──────────────────────────────────────────────────────────────
const here = dirname(fileURLToPath(import.meta.url));
// Walk UP to find the workspace token rather than counting `..` — this script
// runs from the main checkout AND from a deploy worktree, which sit at
// different depths, and a hardcoded depth silently resolves to nothing.
function findToken(): string {
  let dir = here;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "scripts", "intel", "workspace_token.json");
    if (existsSync(candidate)) return candidate;
    dir = join(dir, "..");
  }
  throw new Error("Could not find scripts/intel/workspace_token.json above " + here);
}
const TOKEN_PATH = findToken();

async function accessToken(): Promise<string> {
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(TOKEN_PATH, "utf8"));
  } catch {
    throw new Error(`No Google token at ${TOKEN_PATH}. Run: python3 scripts/google_workspace_auth.py`);
  }
  const body = new URLSearchParams({
    client_id: raw.client_id,
    client_secret: raw.client_secret,
    refresh_token: raw.refresh_token,
    grant_type: "refresh_token",
  });
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const j: any = await r.json();
  if (!r.ok) {
    // The known failure: the cufc-aios consent screen is in Testing mode, so
    // Google expires refresh tokens after 7 days. Re-authorising buys another
    // week; domain-wide delegation is the permanent fix.
    throw new Error(
      `Google refused the refresh token (${j.error ?? r.status}). ` +
      `Re-run: python3 scripts/google_workspace_auth.py — or move cufc-aios to domain-wide delegation.`,
    );
  }
  return j.access_token as string;
}

let TOKEN = "";
async function gapi(path: string, params: Record<string, string> = {}): Promise<any> {
  const url = new URL(`https://www.googleapis.com/drive/v3/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("supportsAllDrives", "true");
  const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!r.ok) throw new Error(`Drive API ${path} → ${r.status} ${await r.text()}`);
  return r.json();
}

async function download(fileId: string, exportMime?: string): Promise<Buffer> {
  const url = exportMime
    ? `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(exportMime)}`
    : `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!r.ok) throw new Error(`download ${fileId} → ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// ── DB ───────────────────────────────────────────────────────────────────────
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function existing(sourceId: string): Promise<number | null> {
  const r = await pool.query(`SELECT id FROM drive_nodes WHERE source='google_drive' AND source_id=$1`, [sourceId]);
  return r.rows[0]?.id ?? null;
}

/**
 * 🔴 Google Drive allows two files — or two folders — with the SAME NAME in the
 * same parent, because it identifies them by id. Club Drive does not: sibling
 * names are unique among live nodes, which is what makes a path meaningful and
 * stops a move silently shadowing something. The club's own Drive really does
 * carry duplicates (two "Youth and Academy — Paul…" folders at the top level).
 *
 * Neither is wrong, so neither file is dropped: the second one is stored as
 * "name (2)". Losing a file to make an import finish is the one outcome worth
 * avoiding here.
 */
async function insertNode(v: Record<string, any>): Promise<number> {
  const keys = Object.keys(v);
  const sql = `INSERT INTO drive_nodes (${keys.join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")})
     ON CONFLICT (source, source_id) WHERE source_id IS NOT NULL DO UPDATE SET name = EXCLUDED.name
     RETURNING id`;
  const baseName: string = v.name;
  for (let attempt = 1; attempt <= 25; attempt++) {
    try {
      const r = await pool.query(sql, keys.map((k) => v[k]));
      return r.rows[0].id;
    } catch (e: any) {
      if (!String(e?.message ?? "").includes("drive_nodes_sibling_name") &&
          !String(e?.message ?? "").includes("drive_nodes_root_name")) throw e;
      // Insert the suffix BEFORE the extension so "report.pdf" becomes
      // "report (2).pdf" and still opens in the right application.
      const dot = baseName.lastIndexOf(".");
      const stem = dot > 0 ? baseName.slice(0, dot) : baseName;
      const ext = dot > 0 ? baseName.slice(dot) : "";
      v.name = `${stem} (${attempt + 1})${ext}`;
      stats.renamed++;
    }
  }
  throw new Error(`could not find a free name for "${baseName}"`);
}

// ── Walk ─────────────────────────────────────────────────────────────────────
interface Stats {
  folders: number; files: number; skippedBig: number; skippedType: number;
  failed: number; bytes: number; alreadyHere: number; textIndexed: number; renamed: number;
}
const stats: Stats = { folders: 0, files: 0, skippedBig: 0, skippedType: 0, failed: 0, bytes: 0, alreadyHere: 0, textIndexed: 0, renamed: 0 };
const skippedBigList: { name: string; mb: number; path: string }[] = [];
const failedList: { name: string; why: string }[] = [];

async function listChildren(folderId: string): Promise<any[]> {
  const out: any[] = [];
  let pageToken: string | undefined;
  do {
    const page = await gapi("files", {
      q: `'${folderId}' in parents and trashed = false`,
      fields: "nextPageToken, files(id,name,mimeType,size,modifiedTime,webViewLink)",
      pageSize: "1000",
      includeItemsFromAllDrives: "true",
      ...(pageToken ? { pageToken } : {}),
    });
    out.push(...(page.files ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

// Files are network-bound end to end — download from Google, upload to storage,
// then parse. Done one at a time the whole import takes the better part of a
// day; a small pool cuts it to a couple of hours. Folders stay STRICTLY
// sequential because a child row needs its parent's id to exist first.
const FILE_CONCURRENCY = Number(flag("concurrency", "6"));

async function pool_map<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}

async function walk(googleFolderId: string, parentNodeId: number | null, path: string, depth = 0): Promise<void> {
  if (LIMIT && stats.files >= LIMIT) return;
  const children = await listChildren(googleFolderId);
  const fileChildren = children.filter((c: any) => c.mimeType !== GOOGLE_FOLDER_MIME);
  await pool_map(fileChildren, FILE_CONCURRENCY, (f: any) => handleFile(f, parentNodeId, `${path}/${f.name}`, depth));

  for (const f of children) {
    if (LIMIT && stats.files >= LIMIT) return;
    const isFolder = f.mimeType === GOOGLE_FOLDER_MIME;
    const childPath = `${path}/${f.name}`;
    if (!isFolder) continue;   // already handled by the pool above

    if (isFolder) {
      stats.folders++;
      let nodeId: number | null = null;
      if (!DRY_RUN) {
        nodeId = await existing(f.id);
        // 🔴 ADOPT a folder somebody already made by hand. Sibling names are
        // unique among live nodes, so creating a second "Sponsorship" here
        // would simply fail — and the useful behaviour is to merge into the
        // one that exists rather than to stop. Adopting stamps the Google id
        // on it, so the next run recognises it immediately.
        if (nodeId === null) {
          const claim = await pool.query(
            `UPDATE drive_nodes SET source='google_drive', source_id=$1, source_url=$2
             WHERE kind='folder' AND trashed_at IS NULL AND source_id IS NULL
               AND lower(name)=lower($3)
               AND parent_id IS NOT DISTINCT FROM $4
             RETURNING id`,
            [f.id, f.webViewLink ?? null, f.name, parentNodeId],
          );
          nodeId = claim.rows[0]?.id ?? null;
          if (nodeId !== null) console.log(`${"  ".repeat(depth)}   ↳ adopted the existing "${f.name}" folder`);
        }
        if (nodeId === null) {
          nodeId = await insertNode({
            parent_id: parentNodeId, kind: "folder", name: f.name,
            source: "google_drive", source_id: f.id, source_url: f.webViewLink ?? null,
          });
        }
      }
      console.log(`${"  ".repeat(depth)}📁 ${f.name}`);
      try {
        await walk(f.id, nodeId, childPath, depth + 1);
      } catch (e: any) {
        // One unreadable subtree must not abandon the other 800 folders.
        stats.failed++;
        failedList.push({ name: childPath, why: String(e?.message ?? e).slice(0, 160) });
        console.log(`${"  ".repeat(depth)}✗  ${f.name} — ${e.message}`);
      }
      continue;
    }

  }
}

async function handleFile(f: any, parentNodeId: number | null, childPath: string, depth: number): Promise<void> {
  {
    if (LIMIT && stats.files >= LIMIT) return;
    // ── A file ──────────────────────────────────────────────────────────────
    if (!DRY_RUN && (await existing(f.id))) { stats.alreadyHere++; return; }

    if (googleIsUnexportable(f.mimeType)) {
      // Forms, Sites, Jamboards. Recorded as a LINK rather than an empty file —
      // a 0-byte "Registration Form.gform" would be a lie on the shelf.
      stats.skippedType++;
      if (!DRY_RUN) {
        await insertNode({
          parent_id: parentNodeId, kind: "file", name: f.name,
          mime_type: f.mimeType, source: "google_drive", source_id: f.id,
          source_url: f.webViewLink ?? null, storage_backend: "google",
          extract_status: "unsupported",
          description: "Lives in Google — this type has no downloadable file.",
        });
      }
      return;
    }

    const exp = GOOGLE_EXPORT[f.mimeType];
    const size = Number(f.size ?? 0);
    if (!exp && size > MAX_BYTES) {
      stats.skippedBig++;
      skippedBigList.push({ name: f.name, mb: Math.round(size / 1024 / 1024), path: childPath });
      return;
    }

    if (DRY_RUN) {
      stats.files++;
      stats.bytes += size;
      console.log(`${"  ".repeat(depth)}📄 ${f.name}${size ? ` (${Math.round(size / 1024)} KB)` : ""}`);
      return;
    }

    try {
      const buf = await download(f.id, exp?.mime);
      const name = exp && !f.name.endsWith(`.${exp.ext}`) ? `${f.name}.${exp.ext}` : f.name;
      const contentType = exp?.mime ?? f.mimeType;
      const put = await driveStorage().put(buf, contentType, name);

      // A Google-native doc gives its text far more reliably as a plain-text
      // export than by parsing the Office file we just made.
      let text: string | null = null;
      let status = "unsupported";
      if (exp && f.mimeType !== "application/vnd.google-apps.drawing") {
        try {
          const plain = await download(f.id, "text/plain");
          text = plain.toString("utf8").replace(/ /g, "").trim().slice(0, 400_000);
          status = "done";
        } catch { /* fall through to the parser below */ }
      }
      if (text === null) {
        const ex = await extractText(buf, contentType, name);
        text = ex.text;
        status = ex.status;
      }
      if (status === "done") stats.textIndexed++;

      await insertNode({
        parent_id: parentNodeId, kind: "file", name,
        storage_key: put.storageKey, storage_backend: put.backend,
        mime_type: contentType, size_bytes: put.sizeBytes, checksum: put.checksum,
        extracted_text: text, extract_status: status,
        source: "google_drive", source_id: f.id, source_url: f.webViewLink ?? null,
        source_modified_at: f.modifiedTime ? new Date(f.modifiedTime) : null,
      });

      stats.files++;
      stats.bytes += put.sizeBytes;
      console.log(`${"  ".repeat(depth)}📄 ${name} → ${Math.round(put.sizeBytes / 1024)} KB${status === "done" ? " ✓ indexed" : ""}`);
    } catch (e: any) {
      stats.failed++;
      failedList.push({ name: childPath, why: String(e.message ?? e).slice(0, 160) });
      console.log(`${"  ".repeat(depth)}✗  ${f.name} — ${e.message}`);
    }
  }
}

// ── Run ──────────────────────────────────────────────────────────────────────
try {
  TOKEN = await accessToken();
  const root = await gapi(`files/${ROOT_FOLDER}`, { fields: "id,name,mimeType" });
  console.log(`\n${DRY_RUN ? "SURVEY" : "IMPORT"}: "${root.name}"  (files over ${Math.round(MAX_BYTES / 1024 / 1024)} MB are skipped)\n`);

  let parent: number | null = INTO ? Number(INTO) : null;
  if (!DRY_RUN && !INTO) {
    parent = await existing(ROOT_FOLDER);
    if (parent === null) {
      parent = await insertNode({
        parent_id: null, kind: "folder", name: root.name,
        source: "google_drive", source_id: root.id,
      });
    }
  }

  await walk(ROOT_FOLDER, parent, root.name);

  console.log(`\n${"─".repeat(60)}`);
  console.log(`  folders                ${stats.folders}`);
  console.log(`  files ${DRY_RUN ? "found  " : "imported"}         ${stats.files}`);
  console.log(`  contents searchable    ${stats.textIndexed}`);
  console.log(`  already here           ${stats.alreadyHere}`);
  console.log(`  skipped — too big      ${stats.skippedBig}`);
  console.log(`  skipped — Google-only  ${stats.skippedType}`);
  console.log(`  renamed (dup name)     ${stats.renamed}`);
  console.log(`  failed                 ${stats.failed}`);
  console.log(`  total size             ${(stats.bytes / 1024 / 1024).toFixed(1)} MB`);

  if (skippedBigList.length) {
    console.log(`\n  Skipped for size (decide on these deliberately):`);
    for (const s of skippedBigList.slice(0, 25)) console.log(`    ${s.mb} MB  ${s.path}`);
    if (skippedBigList.length > 25) console.log(`    …and ${skippedBigList.length - 25} more`);
  }
  if (failedList.length) {
    console.log(`\n  Failed:`);
    for (const f of failedList.slice(0, 25)) console.log(`    ${f.name} — ${f.why}`);
  }
  console.log("");
} catch (e: any) {
  console.error(`\n${e.message}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
