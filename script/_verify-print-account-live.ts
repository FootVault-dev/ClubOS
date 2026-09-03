// Live verification of United Prints customer accounts, against PRODUCTION and
// the real database.
//
//   npx tsx --env-file=.env script/_verify-print-account-live.ts
//
// 🔴 It signs in like a person: it POSTs a real email and password to the real
// /signup and /login endpoints, gets a real session cookie, and reads real
// orders back. Nothing about the password path is simulated — the scrypt hash
// it asserts on is the one production wrote.
//
// The ONE simulated step is the RESET code, because a script cannot open an
// inbox: it writes a known code hash into print_customer_codes and redeems it
// through the real /reset endpoint. Every other step — rate limits, hashing,
// timing-safe compare, session issuance, revocation — is the production path.
//
// It creates a throwaway account (`_verify-…@unitedprints.invalid`, a
// guaranteed-undeliverable TLD) and deletes it in a finally.
import crypto from "crypto";
import pg from "pg";

const BASE = process.env.VERIFY_BASE ?? "https://app.usg.co.nz";
const API = `${BASE}/api/public/unitedprints/account`;

let checks = 0;
const problems: string[] = [];
const ok = (l: string) => { checks++; console.log(`  ✓ ${l}`); };
const bad = (l: string) => { checks++; problems.push(l); console.log(`  ✗ ${l}`); };
const is = (cond: boolean, l: string) => (cond ? ok(l) : bad(l));

/** curl, not fetch. node's outbound fetch has been intermittently dead on this
 *  Mac, and a verifier that silently reaches nothing is worse than none. */
async function http(
  method: string,
  url: string,
  opts: { body?: any; cookie?: string } = {},
): Promise<{ status: number; json: any; setCookie: string | null; text: string }> {
  const { execFile } = await import("child_process");
  const args = ["-s", "-i", "-X", method, "--max-time", "25", url];
  if (opts.body !== undefined) {
    args.push("-H", "Content-Type: application/json", "-d", JSON.stringify(opts.body));
  }
  if (opts.cookie) args.push("-H", `Cookie: ${opts.cookie}`);
  const raw = await new Promise<string>((res, rej) =>
    execFile("curl", args, { maxBuffer: 20 * 1024 * 1024 }, (e, out) => (e ? rej(e) : res(out))),
  );
  const split = raw.indexOf("\r\n\r\n");
  const head = raw.slice(0, split);
  const text = raw.slice(split + 4);
  const status = Number(head.match(/HTTP\/[\d.]+ (\d+)/)?.[1] ?? 0);
  const setCookie = head.match(/set-cookie:\s*([^\r\n]+)/i)?.[1] ?? null;
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status, json, setCookie, text };
}

async function main() {
  const email = `_verify-${Date.now()}@unitedprints.invalid`;
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();

  console.log(`\nUnited Prints customer accounts — live checks against ${BASE}\n`);
  let customerId: number | null = null;

  try {
    // ── 1. The endpoints exist at all ───────────────────────────────────────
    const anon = await http("GET", `${API}/me`);
    is(anon.status === 401, "an unauthenticated /me is 401, not 200-with-an-empty-account");

    // ── 2. Sign up with a password ──────────────────────────────────────────
    const password = "correct-horse-battery-staple-9";

    const weak = await http("POST", `${API}/signup`, { body: { email, password: "short", name: "Verify Bot" } });
    is(weak.status === 400, "a password under 12 characters is refused");
    is(/12 characters/i.test(weak.json?.message ?? ""), "…and says why, in words a person can act on");

    const badEmail = await http("POST", `${API}/signup`, { body: { email: "not-an-email", password } });
    is(badEmail.status === 400, "a malformed address is refused");

    const signup = await http("POST", `${API}/signup`, { body: { email, password, name: "Verify Bot", company: "Verify Ltd" } });
    is(signup.status === 200, "signing up with a real password works");
    const cookie = signup.setCookie?.split(";")[0] ?? "";
    is(cookie.startsWith("__Host-up_account="), "the session cookie is __Host- prefixed (origin-locked)");
    is(/HttpOnly/i.test(signup.setCookie ?? ""), "…httpOnly, so no script can read it");
    is(/Secure/i.test(signup.setCookie ?? ""), "…Secure");
    is(/SameSite=Lax/i.test(signup.setCookie ?? ""), "…SameSite=Lax");

    const row = await db.query(
      `SELECT id, tier, discount_pct, password_hash, password_set_at FROM print_customers WHERE lower(email)=$1`, [email]);
    customerId = row.rows[0]?.id ?? null;
    is(!!customerId, "the account exists");
    is(
      row.rows[0]?.tier === "standard" && Number(row.rows[0]?.discount_pct) === 0,
      "🔴 a brand-new account is standard/0% — signing up does NOT grant a discount",
    );
    is(
      /^s1\$[0-9a-f]{32}\$[0-9a-f]{128}$/.test(String(row.rows[0]?.password_hash ?? "")),
      "🔴 the password is stored as a scrypt hash in the house s1$salt$hex format",
    );
    is(
      !String(row.rows[0]?.password_hash ?? "").includes(password),
      "🔴 …and the plaintext password appears nowhere in the row",
    );

    const dupe = await http("POST", `${API}/signup`, { body: { email, password, name: "Someone Else" } });
    is(dupe.status === 409, "signing up twice with the same email is refused");

    // ── 3. Sign in ──────────────────────────────────────────────────────────
    const wrongPw = await http("POST", `${API}/login`, { body: { email, password: "the-wrong-password-entirely" } });
    is(wrongPw.status === 401, "a wrong password is refused");

    const noSuch = await http("POST", `${API}/login`, { body: { email: `_ghost-${Date.now()}@unitedprints.invalid`, password } });
    is(noSuch.status === 401, "an unknown address is refused");
    is(
      wrongPw.json?.message === noSuch.json?.message,
      "🔴 …with the IDENTICAL message, so the form cannot be asked who has an account",
    );

    const login = await http("POST", `${API}/login`, { body: { email, password } });
    is(login.status === 200, "the right password signs in");
    is(login.json?.me?.email === email, "…and returns this customer");

    // ── 4. The session works, and shows the truth ───────────────────────────
    const me = await http("GET", `${API}/me`, { cookie });
    is(me.status === 200, "/me works with the session");
    is(me.json?.me?.email === email, "…and returns this customer, not somebody else");
    is(me.json?.me?.discountPct === 0, "…reporting 0% until a human sets otherwise");
    is(Array.isArray(me.json?.me?.orders), "…with an orders array (empty is a real answer)");

    // ── 5. A customer cannot promote themselves ─────────────────────────────
    await http("PATCH", `${API}/profile`, { cookie, body: { name: "Verify Bot", discountPct: 90, tier: "trade" } });
    const after = await db.query(`SELECT name, tier, discount_pct FROM print_customers WHERE id=$1`, [customerId]);
    is(after.rows[0]?.name === "Verify Bot", "a customer can edit their own name");
    is(
      Number(after.rows[0]?.discount_pct) === 0 && after.rows[0]?.tier === "standard",
      "🔴 …but a discountPct in the request body is IGNORED — no self-service trade rate",
    );

    // ── 6. Pricing actually changes, in the engine ──────────────────────────
    const mats = await http("GET", `${BASE}/api/public/unitedprints/quote-materials`);
    const material = (mats.json?.materials ?? [])[0];
    if (!material) {
      bad("no quotable material on prod to price against");
    } else {
      const item = { materialSlug: material.slug, widthMm: 2000, heightMm: 1000, quantity: 3 };
      const list = await http("POST", `${BASE}/api/public/unitedprints/quote-price`, { body: { items: [item] } });
      is(list.status === 200 && list.json?.totalCents > 0, `list price for ${material.slug} is a real number`);
      is(list.json?.accountPricing === null, "an anonymous visitor gets no account pricing");

      const asMember = await http("POST", `${BASE}/api/public/unitedprints/quote-price`, { cookie, body: { items: [item] } });
      is(
        asMember.json?.totalCents === list.json?.totalCents,
        "a signed-in customer on 0% pays exactly the list price (no accidental discount)",
      );

      // Now give them a real rate, the way Dima would, and re-price.
      const staff = await db.query(`SELECT id FROM users ORDER BY id LIMIT 1`);
      await db.query(
        `UPDATE print_customers SET tier='trade', discount_pct=20, approved_by_user_id=$2, approved_at=now() WHERE id=$1`,
        [customerId, staff.rows[0].id],
      );
      const traded = await http("POST", `${BASE}/api/public/unitedprints/quote-price`, { cookie, body: { items: [item] } });
      is(traded.json?.accountPricing?.applied === true, "with a trade rate set, the response says it is applied");
      is(
        traded.json?.totalCents < list.json?.totalCents,
        `…and the price actually drops (${list.json?.totalCents} → ${traded.json?.totalCents} cents)`,
      );
      is(
        (traded.json?.lines?.[0]?.breakdown ?? []).some((b: any) => /Account pricing/i.test(b.label)),
        "…and the breakdown names the discount rather than silently shrinking the total",
      );

      // The floor holds. The smallest job the material ALLOWS sits at the shop
      // minimum for everyone.
      //
      // 🔴 The size must come from the material's own declared minimum, not a
      // number picked to look small. 100×100mm is below PVC Banner's 500mm
      // floor, so the line does not price at all (ok:false, subtotal 0) — and
      // the first version of this check compared 0 >= 5890 and reported a
      // pricing bug that did not exist.
      const tiny = {
        materialSlug: material.slug,
        widthMm: material.sizeMinWMm ?? 500,
        heightMm: material.sizeMinHMm ?? 500,
        quantity: 1,
      };
      const tinyList = await http("POST", `${BASE}/api/public/unitedprints/quote-price`, { body: { items: [tiny] } });
      const tinyTrade = await http("POST", `${BASE}/api/public/unitedprints/quote-price`, { cookie, body: { items: [tiny] } });
      is(tinyList.json?.lines?.[0]?.ok === true, "the smallest allowed job prices (so the next check means something)");
      is(
        tinyTrade.json?.subtotalCents >= material.minChargeCents,
        `🔴 a trade discount never takes a job below the shop minimum (${tinyTrade.json?.subtotalCents} >= ${material.minChargeCents})`,
      );
      is(
        tinyTrade.json?.totalCents === tinyList.json?.totalCents,
        "…so on a job already at the minimum, trade and list are the same number",
      );
    }

    // ── 6b. Forgot password ─────────────────────────────────────────────────
    const forgotUnknown = await http("POST", `${API}/forgot`, { body: { email: `_ghost2-${Date.now()}@unitedprints.invalid` } });
    const forgotKnown = await http("POST", `${API}/forgot`, { body: { email } });
    is(forgotUnknown.status === 200 && forgotKnown.status === 200, "forgot-password answers 200 either way");
    is(
      JSON.stringify(forgotUnknown.json) === JSON.stringify(forgotKnown.json),
      "🔴 …IDENTICALLY, so it cannot be asked whether a business has an account",
    );
    is(!JSON.stringify(forgotKnown.json ?? {}).match(/\d{6}/), "…and never returns the code itself");

    // Redeem a reset code (planted, since we cannot open the inbox).
    const rcode = "515151";
    const rhash = crypto.createHash("sha256").update(`${rcode}:${email}`).digest("hex");
    await db.query(
      `INSERT INTO print_customer_codes (email, code_hash, expires_at, purpose) VALUES ($1,$2, now() + interval '10 minutes','reset')`,
      [email, rhash],
    );
    const shortNew = await http("POST", `${API}/reset`, { body: { email, code: rcode, password: "tiny" } });
    is(shortNew.status === 400, "a reset to a too-short password is refused");

    const newPassword = "a-different-long-passphrase-2";
    const reset = await http("POST", `${API}/reset`, { body: { email, code: rcode, password: newPassword } });
    is(reset.status === 200, "the reset code sets a new password and signs in");

    const oldPw = await http("POST", `${API}/login`, { body: { email, password } });
    is(oldPw.status === 401, "…the OLD password stops working");
    const newPw = await http("POST", `${API}/login`, { body: { email, password: newPassword } });
    is(newPw.status === 200, "…and the new one works");

    const stale = await http("GET", `${API}/me`, { cookie });
    is(stale.status === 401, "🔴 …and every session opened before the reset is revoked by it");

    // Continue with a fresh session for the remaining checks.
    const freshCookie = newPw.setCookie?.split(";")[0] ?? "";

    // ── 7. Revocation bites immediately ─────────────────────────────────────
    await db.query(`UPDATE print_customers SET disabled_at = now() WHERE id = $1`, [customerId]);
    const disabled = await http("GET", `${API}/me`, { cookie: freshCookie });
    is(disabled.status === 401, "🔴 disabling the account locks an ALREADY-OPEN session out on its next request");
    await db.query(`UPDATE print_customers SET disabled_at = NULL WHERE id = $1`, [customerId]);

    const out = await http("POST", `${API}/logout`, { cookie: freshCookie });
    is(out.status === 200, "logout answers 200");
    const revoked = await db.query(
      `SELECT COUNT(*) n FROM print_customer_sessions WHERE customer_id=$1 AND revoked_at IS NOT NULL`,
      [customerId],
    );
    is(Number(revoked.rows[0].n) > 0, "…and revokes the session row, not just the browser's cookie");

    // ── 8. The audit trail exists ───────────────────────────────────────────
    const events = await db.query(`SELECT DISTINCT event FROM print_customer_auth_events WHERE lower(email)=$1`, [email]);
    const kinds = events.rows.map((r) => r.event);
    is(kinds.includes("signin_ok"), "a successful sign-in is audited");
    is(kinds.includes("signin_failed"), "a failed attempt is audited too");

    // ── 9. The other brand's portal was not hijacked ────────────────────────
    const cufc = await http("GET", "https://join.cufc.co.nz/account");
    is(
      cufc.status === 301 || cufc.status === 302,
      "join.cufc.co.nz/account still redirects parents to the club portal",
    );

    // ── 10. The hosts serve ─────────────────────────────────────────────────
    for (const host of ["join.unitedprints.co.nz", "shop.unitedprints.co.nz"]) {
      const r = await http("GET", `https://${host}/account`);
      is(r.status === 200, `${host}/account serves the portal (200)`);
      is(!/cufc\.co\.nz\/account/.test(r.text), `…and does not bounce to the football club`);
    }
  } finally {
    if (customerId) {
      await db.query(`DELETE FROM print_customer_sessions WHERE customer_id=$1`, [customerId]);
      await db.query(`DELETE FROM print_customer_auth_events WHERE customer_id=$1`, [customerId]);
      await db.query(`DELETE FROM print_customers WHERE id=$1`, [customerId]);
    }
    await db.query(`DELETE FROM print_customer_codes WHERE email LIKE '\\_verify-%' OR email LIKE '\\_nobody-%'`);
    await db.query(`DELETE FROM print_customer_auth_events WHERE email LIKE '\\_verify-%' OR email LIKE '\\_nobody-%'`);
    await db.end();
  }

  console.log(`\n${checks} checks, ${problems.length} problem(s).`);
  for (const p of problems) console.log(`  ✗ ${p}`);
  if (problems.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
