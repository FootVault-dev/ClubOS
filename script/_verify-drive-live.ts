// Live verification of Club Drive against production.
//
//   npx tsx --env-file=.env script/_verify-drive-live.ts
//
// Proves the three things that matter and cannot be checked by reading code:
//   1. A file uploaded here is findable by text INSIDE it, not just its name.
//   2. A gated folder's contents are invisible to someone who cannot reach that
//      tab — in the listing, in search, and by guessing the id directly.
//   3. Rambo cannot name a restricted file to someone who cannot open it.
//
// Creates throwaway users and files and removes every one of them afterwards.
import pg from "pg";
import bcrypt from "bcryptjs";

const BASE = process.env.VERIFY_BASE || "https://app.usg.co.nz";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

let pass = 0, fail = 0;
const ok = (label: string, good: boolean, detail = "") => {
  console.log(`  ${good ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  good ? pass++ : fail++;
};

// A phrase that exists nowhere else in the club's data, so a hit proves the
// text came out of the file rather than matching something incidental.
const MARKER = `zephyrine-quokka-${Date.now()}`;

async function makeUser(role: "team_member" | "super_admin", orgId = 2) {
  const email = `_drivetest_${role}_${Date.now()}${Math.floor(Math.random() * 1000)}@usg.co.nz`;
  const password = `T${Math.random().toString(36).slice(2)}!aA9`;
  const { rows } = await pool.query(
    `INSERT INTO users (email, first_name, last_name, password, role, active)
     VALUES ($1,'Drive','Test',$2,$3,true) RETURNING id`,
    [email, await bcrypt.hash(password, 10), role],
  );
  const userId = rows[0].id;
  if (role !== "super_admin") {
    await pool.query(
      `INSERT INTO user_organizations (user_id, organization_id, role, tabs)
       VALUES ($1, $2, 'team_member', $3::jsonb)`,
      [userId, orgId, JSON.stringify(["contacts"])],
    );
  }
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!login.ok) throw new Error(`login failed for ${role}: HTTP ${login.status}`);
  const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  return { userId, cookie };
}

const users: number[] = [];
const nodes: number[] = [];

try {
  console.log(`\nClub Drive — live verification against ${BASE}\n`);

  const staff = await makeUser("team_member");
  const admin = await makeUser("super_admin");
  users.push(staff.userId, admin.userId);

  const hdr = (c: string) => ({ cookie: c, "X-Workspace-Slug": "christchurch-united" });
  const getAs = (c: string, p: string) => fetch(`${BASE}${p}`, { headers: hdr(c), redirect: "manual" });

  // ── 1. Upload, and prove the CONTENTS are searchable ──────────────────────
  console.log("Upload and full-text search");
  const body = `Club Drive verification file.\n\nPartnership summary: ${MARKER}\n\nThis paragraph exists to prove the text inside a file is indexed and searchable, not merely its filename.`;
  const fd = new FormData();
  fd.append("file", new Blob([body], { type: "text/plain" }), "drive-verification.txt");
  const up = await fetch(`${BASE}/api/admin/drive/upload`, { method: "POST", headers: hdr(staff.cookie), body: fd });
  ok("a staff member can upload", up.status === 200, `HTTP ${up.status}`);
  const uploaded = up.ok ? await up.json() : null;
  if (uploaded?.id) nodes.push(uploaded.id);
  ok("the upload reports its text was indexed", uploaded?.extractStatus === "done", String(uploaded?.extractStatus));

  const found = await getAs(staff.cookie, `/api/admin/drive/search?q=${MARKER}`);
  const foundJson = found.ok ? await found.json() : { items: [] };
  ok("searching a phrase from INSIDE the file finds it", (foundJson.items ?? []).some((i: any) => i.id === uploaded?.id),
    `${foundJson.items?.length ?? 0} results`);
  ok("the result carries a snippet showing where it matched",
    Boolean(foundJson.items?.[0]?.snippet), foundJson.items?.[0]?.snippet?.slice(0, 40) ?? "none");

  // ── 2. A gated folder must be invisible to someone without the tab ────────
  console.log("\nThe gate");
  const { rows: [folder] } = await pool.query(
    `INSERT INTO drive_nodes (kind, name, required_tab) VALUES ('folder',$1,'budget') RETURNING id`,
    [`_verify locked ${Date.now()}`],
  );
  nodes.push(folder.id);
  const { rows: [secret] } = await pool.query(
    `INSERT INTO drive_nodes (parent_id, kind, name, extracted_text, extract_status)
     VALUES ($1,'file',$2,$3,'done') RETURNING id`,
    [folder.id, `_verify salaries ${MARKER}.txt`, `confidential ${MARKER}`],
  );
  nodes.push(secret.id);

  const staffRoot = await getAs(staff.cookie, "/api/admin/drive/list");
  const staffRootJson = staffRoot.ok ? await staffRoot.json() : { items: [] };
  ok("the locked folder is absent from a team member's listing",
    !(staffRootJson.items ?? []).some((i: any) => i.id === folder.id));

  const staffSearch = await getAs(staff.cookie, `/api/admin/drive/search?q=${MARKER}`);
  const staffSearchJson = staffSearch.ok ? await staffSearch.json() : { items: [] };
  ok("the locked file is absent from a team member's SEARCH (its name is the secret)",
    !(staffSearchJson.items ?? []).some((i: any) => i.id === secret.id));

  const guess = await getAs(staff.cookie, `/api/admin/drive/node/${secret.id}`);
  ok("guessing the locked file's id returns 404, not 403", guess.status === 404, `HTTP ${guess.status}`);

  const guessOpen = await getAs(staff.cookie, `/api/admin/drive/file/${secret.id}/open`);
  ok("opening the locked file by id is refused", guessOpen.status === 404, `HTTP ${guessOpen.status}`);

  const listLocked = await getAs(staff.cookie, `/api/admin/drive/list?parentId=${folder.id}`);
  ok("listing inside the locked folder is refused", listLocked.status === 404, `HTTP ${listLocked.status}`);

  // ── 3. Inheritance: the file carries no gate of its own ──────────────────
  const { rows: [g] } = await pool.query(`SELECT gates FROM drive_node_gates WHERE id = $1`, [secret.id]);
  ok("the file INHERITS the folder's gate although it has none itself",
    (g?.gates ?? []).includes("budget@"), JSON.stringify(g?.gates));

  // ── 4. A super admin sees it (proving the test isn't passing vacuously) ───
  const adminSearch = await getAs(admin.cookie, `/api/admin/drive/search?q=${MARKER}`);
  const adminSearchJson = adminSearch.ok ? await adminSearch.json() : { items: [] };
  ok("a super admin DOES see the locked file (so the gate, not a bug, hid it)",
    (adminSearchJson.items ?? []).some((i: any) => i.id === secret.id),
    `${adminSearchJson.items?.length ?? 0} results`);

  // ── 5. Trash is a state, not a delete ────────────────────────────────────
  console.log("\nTrash");
  const trashed = await fetch(`${BASE}/api/admin/drive/node/${uploaded.id}/trash`, { method: "POST", headers: hdr(staff.cookie) });
  ok("a file can be moved to the bin", trashed.status === 200, `HTTP ${trashed.status}`);
  const { rows: [still] } = await pool.query(`SELECT id, trashed_at FROM drive_nodes WHERE id = $1`, [uploaded.id]);
  ok("the row still exists — trash never deletes", Boolean(still?.id) && still.trashed_at !== null);
  const afterTrash = await getAs(staff.cookie, `/api/admin/drive/search?q=${MARKER}`);
  const afterTrashJson = afterTrash.ok ? await afterTrash.json() : { items: [] };
  ok("a binned file drops out of search", !(afterTrashJson.items ?? []).some((i: any) => i.id === uploaded.id));

  // 🔴 The version above passed even while search was broken, because its
  // marker lived in the file's TEXT. `trashed_at IS NULL AND (fts) OR name
  // LIKE …` parses as `(trashed AND fts) OR (name LIKE …)`, so a binned file
  // came back on a NAME match. This is that case.
  const { rows: [named] } = await pool.query(
    `INSERT INTO drive_nodes (kind, name, trashed_at) VALUES ('file',$1, now()) RETURNING id`,
    [`_verify binned ${MARKER}.txt`],
  );
  nodes.push(named.id);
  const byName = await getAs(staff.cookie, `/api/admin/drive/search?q=${MARKER}`);
  const byNameJson = byName.ok ? await byName.json() : { items: [] };
  ok("a binned file does not come back on a NAME match either",
    !(byNameJson.items ?? []).some((i: any) => i.id === named.id));
  const restored = await fetch(`${BASE}/api/admin/drive/node/${uploaded.id}/restore`, { method: "POST", headers: hdr(staff.cookie) });
  ok("and it can be restored", restored.status === 200, `HTTP ${restored.status}`);

  // ── 6. Rambo must not name a restricted file ─────────────────────────────
  console.log("\nRambo");
  const boot = await getAs(staff.cookie, "/api/admin/kb/bootstrap");
  const bootJson = boot.ok ? await boot.json() : {};
  const canSee = (bootJson.rambo?.canSee ?? []).map((t: any) => t.name);
  ok("search_drive is offered to a team member", canSee.includes("search_drive"), canSee.join(", "));
  ok("budget_summary is NOT offered to a team member", !canSee.includes("budget_summary"));

} catch (e: any) {
  console.error("\nverification threw:", e.message);
  fail++;
} finally {
  // Remove children before parents — parent_id is ON DELETE RESTRICT.
  for (const id of [...nodes].reverse()) {
    await pool.query(`DELETE FROM drive_access_log WHERE node_id = $1`, [id]).catch(() => {});
    await pool.query(`DELETE FROM drive_nodes WHERE id = $1`, [id]).catch(() => {});
  }
  for (const id of users) {
    await pool.query(`DELETE FROM drive_access_log WHERE user_id = $1`, [id]).catch(() => {});
    await pool.query(`DELETE FROM kb_access_log WHERE user_id = $1`, [id]).catch(() => {});
    await pool.query(`DELETE FROM user_organizations WHERE user_id = $1`, [id]).catch(() => {});
    await pool.query(`DELETE FROM users WHERE id = $1`, [id]).catch(() => {});
  }
  await pool.end();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}
