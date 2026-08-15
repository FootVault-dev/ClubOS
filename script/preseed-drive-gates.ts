// Pre-create the sensitive top-level folders WITH a gate, before the Google
// import runs.
//
//   List:  npx tsx --env-file=.env script/preseed-drive-gates.ts --list
//   Apply: npx tsx --env-file=.env script/preseed-drive-gates.ts
//
// 🔴 WHY THIS EXISTS. The importer creates folders open to every staff member,
// which is right for "Uniforms" and catastrophic for "Staff & Coach Agreements".
// The club Drive's top level includes employment contracts, salary and budget
// papers, tenant records, invoicing and named personal folders for the
// President, the GM and the Academy admin. Importing those ungated would publish
// every staff contract in the organisation to every ClubOS login — including
// part-time coaches, because `canAccessTab` grants an admin every tab.
//
// So the sensitive folders are created FIRST, carrying `required_tab = 'budget'`
// — a SUPER_ADMIN_ONLY tab, i.e. Daniel alone — and the importer's folder
// ADOPTION then merges the Google folder into the gated row rather than making a
// second one. Because gates accumulate downward, every file and subfolder
// underneath inherits the lock automatically.
//
// 🔴 Deliberately START CLOSED. Opening a folder later is a click; un-publishing
// a contract that every staff member has already read is not possible.
import { Pool } from "pg";
import { readFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const LIST_ONLY = process.argv.includes("--list");
const ROOT = "1gyBPKvDHuovPd11U3fssM-YTHJgKz9Pm";

// Matched case-insensitively against the START of the Google folder name, so
// truncated/renamed variants ("Club President - Slava Meyn") still match.
const SENSITIVE = [
  "Club Budgets",
  "Staff & Coach Agreements",
  "Staff Leave",
  "Staff Reports",
  "Invoicing",
  "Club President",
  "GM - Ryan Edwards",
  "Admin - Avi",
  "Residency",
  "Accommodation Rentals",
  "Commercial",
  "Club Partnerships",
  "Sponsorship",
  // A named staff member's own working folder — same class as the President's
  // and the GM's.
  "Academy Managment - Jude",
  // 🔴 Not obvious from its name: the survey found "First Team Payments 2023/
  // <player name>/" nested several levels inside this one. Player payments are
  // exactly what must not be browsable by every coach.
  "Marketing and Social Media",
];

const here = dirname(fileURLToPath(import.meta.url));
function findToken(): string {
  let dir = here;
  for (let i = 0; i < 8; i++) {
    const c = join(dir, "scripts", "intel", "workspace_token.json");
    if (existsSync(c)) return c;
    dir = join(dir, "..");
  }
  throw new Error("workspace_token.json not found");
}

const raw = JSON.parse(readFileSync(findToken(), "utf8"));
const tokRes = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id: raw.client_id, client_secret: raw.client_secret,
    refresh_token: raw.refresh_token, grant_type: "refresh_token",
  }),
});
const tok: any = await tokRes.json();
if (!tokRes.ok) throw new Error(`token refresh failed: ${tok.error}`);

const u = new URL("https://www.googleapis.com/drive/v3/files");
u.searchParams.set("q", `'${ROOT}' in parents and trashed = false and mimeType='application/vnd.google-apps.folder'`);
u.searchParams.set("fields", "files(id,name)");
u.searchParams.set("pageSize", "200");
u.searchParams.set("supportsAllDrives", "true");
u.searchParams.set("includeItemsFromAllDrives", "true");
const listed: any = await (await fetch(u, { headers: { Authorization: `Bearer ${tok.access_token}` } })).json();
const folders: { id: string; name: string }[] = listed.files ?? [];

const isSensitive = (n: string) => SENSITIVE.some((s) => n.toLowerCase().startsWith(s.toLowerCase()));

console.log(`\nTop level of the club Drive — ${folders.length} folders\n`);
for (const f of folders.sort((a, b) => a.name.localeCompare(b.name))) {
  console.log(`  ${isSensitive(f.name) ? "🔒 LOCKED " : "   open   "} ${f.name}`);
}
const locked = folders.filter((f) => isSensitive(f.name));
console.log(`\n  ${locked.length} locked to Daniel · ${folders.length - locked.length} open to all staff\n`);

if (LIST_ONLY) process.exit(0);

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// The import nests everything under one root folder named after the Drive.
const rootName = "Christchurch United FC 2026";
let rootId: number;
const existingRoot = await pool.query(
  `SELECT id FROM drive_nodes WHERE parent_id IS NULL AND lower(name)=lower($1) AND trashed_at IS NULL`,
  [rootName],
);
if (existingRoot.rows.length) {
  rootId = existingRoot.rows[0].id;
} else {
  const r = await pool.query(
    `INSERT INTO drive_nodes (parent_id, kind, name) VALUES (NULL,'folder',$1) RETURNING id`, [rootName],
  );
  rootId = r.rows[0].id;
}
console.log(`  root folder id ${rootId}`);

let made = 0, already = 0;
for (const f of locked) {
  const found = await pool.query(
    `SELECT id, required_tab FROM drive_nodes WHERE parent_id=$1 AND lower(name)=lower($2) AND trashed_at IS NULL`,
    [rootId, f.name],
  );
  if (found.rows.length) {
    await pool.query(`UPDATE drive_nodes SET required_tab='budget' WHERE id=$1`, [found.rows[0].id]);
    already++;
  } else {
    await pool.query(
      `INSERT INTO drive_nodes (parent_id, kind, name, required_tab) VALUES ($1,'folder',$2,'budget')`,
      [rootId, f.name],
    );
    made++;
  }
}
console.log(`\n  ${made} gated folders created, ${already} already existed and were re-gated\n`);
await pool.end();
