// Proof that editing an API key's grant IN PLACE is enforced by the DEPLOYED
// app — that the fence genuinely moves, the key string genuinely doesn't, and
// that every way of widening access by accident is refused.
//
//   npx tsx --env-file=.env script/_verify-api-key-edit-live.ts
//
// It stands up a throwaway super admin (the edit endpoint requires that role,
// so unlike the hiring scope test there is no way to prove this without one),
// mints a throwaway API key through the real endpoint, drives it, and deletes
// both in a finally whatever happens. Nothing touches Daniel's, Isaac's or
// Zach's keys.
//
// The important assertions are the REFUSALS. An edit form that quietly stores a
// grant which means something other than what was typed is worse than no edit
// form, because the whole point of it is that Daniel can trust what he sees.
import { Pool } from "pg";
import bcrypt from "bcryptjs";

// Point at a locally-run server first (VERIFY_BASE=http://localhost:5000) so a
// bug in the endpoint never reaches prod, then re-run against app.usg.co.nz to
// prove the DEPLOYED build behaves the same.
const BASE = process.env.VERIFY_BASE || "https://app.usg.co.nz";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

let failures = 0;
const created: { users: number[]; keys: number[] } = { users: [], keys: [] };

const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "  ok " : " FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};
const sameSet = (a: any[], b: any[]) =>
  Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
  [...a].map(String).sort().join("|") === [...b].map(String).sort().join("|");

async function superAdminActor() {
  const email = `_apikeytest_${Date.now()}@usg.co.nz`;
  const password = `T${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}!aA9`;
  const { rows } = await pool.query(
    `INSERT INTO users (email, first_name, last_name, password, role, active)
     VALUES ($1,'ApiKey','Test',$2,'super_admin',true) RETURNING id`,
    [email, await bcrypt.hash(password, 10)],
  );
  const id = rows[0].id;
  created.users.push(id);
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!login.ok) throw new Error(`login failed: HTTP ${login.status}`);
  const cookie = (login.headers.getSetCookie?.() ?? []).map(c => c.split(";")[0]).join("; ");
  if (!cookie) throw new Error("no session cookie");
  const send = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { cookie, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* some routes answer empty */ }
    return { status: res.status, json };
  };
  return { id, email, send };
}

/** Call a v1 endpoint with the raw key, as the holder's AIOS would. */
async function asKey(rawKey: string, path: string) {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${rawKey}` } });
  let json: any = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, json };
}
const listOf = (j: any, k: string) => (Array.isArray(j) ? j : j?.[k] ?? j?.data ?? []);

try {
  // ── facts from the database the assertions are measured against ──────────
  const { rows: progs } = await pool.query(
    `SELECT organization_id, slug, type::text AS type FROM programs WHERE organization_id IN (1,3) ORDER BY organization_id, slug`,
  );
  const org1 = progs.filter(p => p.organization_id === 1);
  const org1Slugs = org1.map(p => p.slug);
  const org3Slugs = progs.filter(p => p.organization_id === 3).map(p => p.slug);
  // A slug that exists in CUFC but NOT in MFL — the case that must refuse when
  // workspaces are narrowed out from under an existing fence.
  const cufcOnlySlug = org1Slugs.find(s => !org3Slugs.includes(s));
  const campTypeCount = org1.filter(p => p.type === "holiday_camp").length;
  console.log(`\n  (prod today: CUFC has ${org1.length} programmes, ${campTypeCount} of type holiday_camp)`);
  if (!cufcOnlySlug) throw new Error("no CUFC-only programme slug found — cannot test the narrowing case");

  const admin = await superAdminActor();
  console.log(`  (throwaway super admin ${admin.email} created + logged in)`);

  // ══ 1. mint a throwaway key through the real create endpoint ═════════════
  console.log("\n── create a throwaway key (CUFC, camps+registrations, fenced to holiday_camp) ──");
  const mint = await admin.send("POST", "/api/admin/api-keys", {
    name: "_TEST_ edit-verify (delete me)",
    organizationId: 1,
    allowedOrgIds: [1],
    scopes: ["camps:read", "registrations:read"],
    programFilter: { types: ["holiday_camp"], slugs: [] },
  });
  check("key created", mint.status === 200 && !!mint.json?.key, `HTTP ${mint.status}`);
  if (!mint.json?.key) throw new Error("no key returned — cannot continue");
  const keyId: number = mint.json.id;
  const rawKey: string = mint.json.key;
  created.keys.push(keyId);

  const campsBefore = listOf((await asKey(rawKey, "/api/v1/camps")).json, "camps");
  check("fenced key reads only holiday_camp programmes", campsBefore.length === campTypeCount,
    `${campsBefore.length} visible, ${campTypeCount} of that type exist`);

  // ══ 2. the refusals — every way to widen access by accident ══════════════
  console.log("\n── refusals ──");
  {
    const r = await admin.send("PATCH", `/api/admin/api-keys/${keyId}`, { scopes: [] });
    check("empty scopes refused (that is what revoke is for)", r.status === 400, `HTTP ${r.status}`);
  }
  {
    const r = await admin.send("PATCH", `/api/admin/api-keys/${keyId}`, { scopes: ["camps:read", "everything:read"] });
    check("unknown scope refused", r.status === 400, r.json?.message);
  }
  {
    const r = await admin.send("PATCH", `/api/admin/api-keys/${keyId}`, { allowedOrgIds: [] });
    check("empty workspaces refused", r.status === 400, `HTTP ${r.status}`);
  }
  {
    const r = await admin.send("PATCH", `/api/admin/api-keys/${keyId}`, { allowedOrgIds: [1, 99999] });
    check("non-existent workspace refused", r.status === 400, r.json?.message);
  }
  {
    // The swapped-boxes trap: a type typed into slugs is well-formed and would
    // silently grant the whole category.
    const r = await admin.send("PATCH", `/api/admin/api-keys/${keyId}`, {
      programFilter: { types: [], slugs: ["holiday_camp"] },
    });
    check("a TYPE typed into the slugs box is refused (would widen)", r.status === 400, r.json?.message?.slice(0, 60));
  }
  {
    const r = await admin.send("PATCH", `/api/admin/api-keys/${keyId}`, {
      programFilter: { types: [], slugs: ["definitely-not-a-real-programme"] },
    });
    check("unknown slug refused", r.status === 400, r.json?.message?.slice(0, 50));
  }
  {
    // A fence is a no-op on scopes whose data never touches `programs` — so the
    // combination must be refused rather than appear to fence something.
    const r = await admin.send("PATCH", `/api/admin/api-keys/${keyId}`, {
      scopes: ["camps:read", "tournament:read"],
    });
    check("adding tournament:read to a FENCED key is refused", r.status === 400, r.json?.message?.slice(0, 60));
  }
  {
    // Narrowing workspaces out from under a fence that names a CUFC-only slug.
    const setSlug = await admin.send("PATCH", `/api/admin/api-keys/${keyId}`, {
      programFilter: { types: [], slugs: [cufcOnlySlug] },
    });
    check(`fence narrowed to slug "${cufcOnlySlug}"`, setSlug.status === 200, `HTTP ${setSlug.status}`);
    const r = await admin.send("PATCH", `/api/admin/api-keys/${keyId}`, { allowedOrgIds: [3] });
    check("moving workspaces out from under an existing fence is refused", r.status === 400,
      r.json?.message?.slice(0, 70));
  }
  {
    const r = await admin.send("PATCH", `/api/admin/api-keys/${keyId}`, {});
    check("an empty edit is refused, not silently accepted", r.status === 400, `HTTP ${r.status}`);
  }
  {
    const r = await admin.send("PATCH", `/api/admin/api-keys/${keyId}`, { name: "   " });
    check("blank name refused", r.status === 400, `HTTP ${r.status}`);
  }

  // ══ 3. the grant still says what it said before all those refusals ═══════
  const { rows: afterRefusals } = await pool.query(
    `SELECT scopes, allowed_org_ids, program_filter FROM api_keys WHERE id = $1`, [keyId]);
  check("refused edits changed nothing in the database",
    sameSet(afterRefusals[0].scopes, ["camps:read", "registrations:read"]) &&
    sameSet(afterRefusals[0].allowed_org_ids, [1]),
    JSON.stringify(afterRefusals[0].scopes));

  // ══ 4. a legitimate edit — and the enforcement actually moves ════════════
  console.log("\n── a real edit ──");
  {
    const r = await admin.send("PATCH", `/api/admin/api-keys/${keyId}`, {
      scopes: ["camps:read", "registrations:read", "overview:read"],
      programFilter: { types: ["holiday_camp"], slugs: [] },
      name: "_TEST_ edit-verify renamed (delete me)",
    });
    check("scopes widened + renamed in one edit", r.status === 200 && r.json?.changed === true, `HTTP ${r.status}`);
    check("response reports what changed", Array.isArray(r.json?.changes) && r.json.changes.length >= 2,
      JSON.stringify(r.json?.changes));

    // overview:read was NOT granted a moment ago; it must work now, on the SAME key.
    const ov = await asKey(rawKey, "/api/v1/overview?days=30");
    check("the SAME key string now reaches the newly-granted scope", ov.status === 200, `HTTP ${ov.status}`);
    const camps = listOf((await asKey(rawKey, "/api/v1/camps")).json, "camps");
    check("fence still holds after the edit", camps.length === campTypeCount,
      `${camps.length} visible, ${campTypeCount} expected`);
  }
  {
    // Removing a scope must take effect just as fast as adding one.
    const r = await admin.send("PATCH", `/api/admin/api-keys/${keyId}`, {
      scopes: ["camps:read", "registrations:read"],
    });
    check("scope removed", r.status === 200, `HTTP ${r.status}`);
    const ov = await asKey(rawKey, "/api/v1/overview?days=30");
    check("the removed scope is refused on the very next request", ov.status === 403, `HTTP ${ov.status}`);
  }
  {
    // Lifting the fence entirely — the one thing the old program-filter-only
    // route could do, still reachable from the edit form by clearing both boxes.
    const r = await admin.send("PATCH", `/api/admin/api-keys/${keyId}`, { programFilter: null });
    check("fence lifted with an explicit null", r.status === 200 && r.json?.programFilter === null, `HTTP ${r.status}`);
    const camps = listOf((await asKey(rawKey, "/api/v1/camps")).json, "camps");
    check("unfenced key now sees every CUFC programme", camps.length === org1.length,
      `${camps.length} visible, ${org1.length} exist`);
  }
  {
    const r = await admin.send("PATCH", `/api/admin/api-keys/${keyId}`, {
      scopes: ["camps:read", "registrations:read"],
    });
    check("a no-op edit reports changed:false rather than writing", r.status === 200 && r.json?.changed === false,
      JSON.stringify(r.json?.changed));
  }

  // ══ 5. the key string never changed through any of it ════════════════════
  const { rows: prefixRows } = await pool.query(`SELECT key_prefix FROM api_keys WHERE id = $1`, [keyId]);
  check("key prefix unchanged by every edit", prefixRows[0].key_prefix === mint.json.keyPrefix,
    `${prefixRows[0].key_prefix} vs ${mint.json.keyPrefix}`);
  check("the original raw key still authenticates", (await asKey(rawKey, "/api/v1/camps")).status === 200);

  // ══ 6. revoke — immediate, and a revoked key cannot be edited back ═══════
  console.log("\n── revoke ──");
  {
    const r = await admin.send("DELETE", `/api/admin/api-keys/${keyId}`);
    check("revoke returns ok", r.status === 200, `HTTP ${r.status}`);
    const after = await asKey(rawKey, "/api/v1/camps");
    check("the key stops working on the very next request", after.status === 401, `HTTP ${after.status}`);
    const { rows } = await pool.query(`SELECT active FROM api_keys WHERE id = $1`, [keyId]);
    check("row survives revocation (audit history intact)", rows.length === 1 && rows[0].active === false);
    const edit = await admin.send("PATCH", `/api/admin/api-keys/${keyId}`, { scopes: ["camps:read"] });
    check("a revoked key cannot be edited back to life", edit.status === 400, edit.json?.message?.slice(0, 60));
  }

  // ══ 7. the whole thing is super-admin only ═══════════════════════════════
  console.log("\n── still super-admin only ──");
  {
    const anon = await fetch(`${BASE}/api/admin/api-keys/${keyId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scopes: ["camps:read"] }),
    });
    check("PATCH without a session is refused", anon.status === 401 || anon.status === 403, `HTTP ${anon.status}`);
  }
  {
    // A plain admin — the role nine staff actually hold — must not reach it.
    const email = `_apikeytest_admin_${Date.now()}@usg.co.nz`;
    const password = `T${Math.random().toString(36).slice(2)}!aA9`;
    const { rows } = await pool.query(
      `INSERT INTO users (email, first_name, last_name, password, role, active)
       VALUES ($1,'ApiKey','TestAdmin',$2,'admin',true) RETURNING id`,
      [email, await bcrypt.hash(password, 10)],
    );
    created.users.push(rows[0].id);
    const login = await fetch(`${BASE}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    check("throwaway admin logged in", login.status === 200, `HTTP ${login.status}`);
    const cookie = (login.headers.getSetCookie?.() ?? []).map(c => c.split(";")[0]).join("; ");

    // Prove the session is genuinely established AND genuinely not a super
    // admin first — otherwise a refusal below could be a false pass caused by
    // no session at all rather than by the role rule.
    const me = await fetch(`${BASE}/api/auth/me`, { headers: { cookie } });
    const meJson: any = me.status === 200 ? await me.json() : null;
    check("session established and role is 'admin', not super_admin",
      me.status === 200 && meJson?.role === "admin", `HTTP ${me.status} role=${meJson?.role}`);

    const asAdmin = await fetch(`${BASE}/api/admin/api-keys/${keyId}`, {
      method: "PATCH", headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ scopes: ["camps:read"] }),
    });
    check("a workspace ADMIN is refused the edit", asAdmin.status === 403 || asAdmin.status === 401,
      `HTTP ${asAdmin.status}`);
    const listAsAdmin = await fetch(`${BASE}/api/admin/api-keys`, { headers: { cookie } });
    check("a workspace ADMIN cannot even list keys", listAsAdmin.status === 403 || listAsAdmin.status === 401,
      `HTTP ${listAsAdmin.status}`);
  }
} catch (e: any) {
  failures++;
  console.log(`\n FAIL  threw: ${e.message}`);
} finally {
  console.log("\n── cleanup ──");
  for (const id of created.keys) {
    await pool.query("DELETE FROM api_key_request_logs WHERE api_key_id = $1", [id]);
    await pool.query("DELETE FROM api_keys WHERE id = $1", [id]);
  }
  for (const id of created.users) {
    await pool.query("DELETE FROM audit_logs WHERE user_id = $1", [id]).catch(() => {});
    await pool.query("DELETE FROM user_organizations WHERE user_id = $1", [id]).catch(() => {});
    await pool.query("UPDATE api_keys SET created_by_id = NULL WHERE created_by_id = $1", [id]).catch(() => {});
    await pool.query("DELETE FROM users WHERE id = $1", [id]);
  }
  const { rows: leftUsers } = await pool.query(
    "SELECT count(*)::int AS n FROM users WHERE email LIKE '\\_apikeytest\\_%'");
  const { rows: leftKeys } = await pool.query(
    "SELECT count(*)::int AS n FROM api_keys WHERE name LIKE '\\_TEST\\_%'");
  console.log(`  throwaway users left: ${leftUsers[0].n} (must be 0)`);
  console.log(`  throwaway keys left:  ${leftKeys[0].n} (must be 0)`);
  if (leftUsers[0].n !== 0 || leftKeys[0].n !== 0) failures++;
  const { rows: real } = await pool.query("SELECT id, name, active FROM api_keys ORDER BY id");
  console.log(`  real keys untouched:  ${real.map(r => `#${r.id} ${r.active ? "active" : "revoked"}`).join(", ")}`);
  await pool.end();
  console.log(failures ? `\n${failures} FAILURE(S)\n` : "\nAll checks passed.\n");
  process.exit(failures ? 1 : 0);
}
