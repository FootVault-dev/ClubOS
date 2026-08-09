/**
 * Screenshots the live CUGC Mailer at phone / laptop / desktop sizes.
 *
 * The page is behind a login, so this mints a throwaway user who belongs ONLY
 * to the Gymnastics workspace (so the app lands there with no switching),
 * exchanges it for a session cookie, hands that to scripts/ui_preflight.mjs,
 * and deletes the user afterwards.
 *
 *   npx tsx --env-file=.env script/_preflight-cugc-mailer.ts
 */
import pg from "pg";
import bcrypt from "bcryptjs";
import { execFileSync } from "child_process";
import { join } from "path";

const BASE = process.env.VERIFY_BASE || "https://app.usg.co.nz";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  let userId: number | null = null;
  try {
    const email = `_cugcpreflight_${Date.now()}@usg.co.nz`;
    const password = `T${Math.random().toString(36).slice(2)}!aA9`;
    const { rows } = await pool.query(
      `INSERT INTO users (email, first_name, last_name, password, role, active)
       VALUES ($1,'Preflight','Test',$2,'team_member',true) RETURNING id`,
      [email, await bcrypt.hash(password, 10)],
    );
    userId = rows[0].id;
    // Gymnastics only, and as an admin so the sidebar renders the full tab list
    // exactly as Natalia will see it.
    await pool.query(
      `INSERT INTO user_organizations (user_id, organization_id, role) VALUES ($1, 6, 'admin')`,
      [userId],
    );

    const login = await fetch(`${BASE}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!login.ok) throw new Error(`login failed: HTTP ${login.status}`);
    const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
    if (!cookie) throw new Error("no session cookie");
    console.log("logged in as the throwaway Gymnastics admin\n");

    const root = join(process.cwd(), "..", "..");
    execFileSync(
      "node",
      [join(root, "scripts", "ui_preflight.mjs"), `${BASE}/admin/cugc-mailer`, "cugc-mailer"],
      { stdio: "inherit", env: { ...process.env, UI_PREFLIGHT_COOKIE: cookie } },
    );
  } finally {
    if (userId) {
      await pool.query(`DELETE FROM user_organizations WHERE user_id = $1`, [userId]).catch(() => {});
      await pool.query(`DELETE FROM users WHERE id = $1`, [userId]).catch(() => {});
      console.log("\nthrowaway user removed");
    }
    await pool.end();
  }
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
