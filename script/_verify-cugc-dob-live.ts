/**
 * Live verification that BOTH CUGC sign-up flows now require a date of birth —
 * and, just as importantly, that the paid checkout still works.
 *
 * A hard server-side gate was added to a live payment flow. Proving the
 * rejections fire is only half the job; if the happy path broke, enrolments
 * stop. So this drives a real enrolment through to a real Stripe PaymentIntent
 * (created, never confirmed — it costs nothing and expires), then deletes
 * everything it made.
 *
 *   npx tsx --env-file=.env script/_verify-cugc-dob-live.ts
 */
import pg from "pg";

const BASE = process.env.VERIFY_BASE || "https://app.usg.co.nz";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
};

const post = (path: string, body: unknown) =>
  fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://cugc.co.nz" },
    body: JSON.stringify(body),
  });

const TAG = `ZZDOBTEST${Date.now()}`;

// A bookable upcoming session date — the endpoint refuses anything in the past
// or more than 120 days out.
const soonIso = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Pacific/Auckland", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date(Date.now() + 7 * 86400000));

async function main() {
  const madeFreeSessions: number[] = [];
  const madeRegistrations: number[] = [];
  try {
    const freeBase = {
      programSlug: "gymplay",
      sessionLabel: "Wednesday 4:00–4:45pm",
      sessionDate: soonIso,
      childName: `${TAG} Child`,
      parentName: `${TAG} Parent`,
      email: `${TAG.toLowerCase()}@example.com`,
      phone: "0210000000",
    };

    console.log("\nFree trial — date of birth is required");
    for (const [label, dob] of [
      ["missing", ""],
      ["not a date", "sometime in 2019"],
      ["in the future", "2099-01-01"],
      ["an impossible year", "1900-01-01"],
    ] as const) {
      const res = await post("/api/public/cugc/free-session", { ...freeBase, childDob: dob });
      const body = await res.json().catch(() => ({}));
      ok(`a DOB ${label} is refused`, res.status === 400, `HTTP ${res.status} "${body.message ?? ""}"`);
    }

    console.log("\nFree trial — a real booking, with the age derived");
    // Born exactly 5 years and 1 day ago in NZ: age must read 5, and would read
    // 4 if anyone computed it with Date arithmetic across the UTC boundary.
    const todayNz = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Pacific/Auckland", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());
    const [ty, tm, td] = todayNz.split("-").map(Number);
    const dob = `${ty - 5}-${String(tm).padStart(2, "0")}-${String(td).padStart(2, "0")}`;

    const good = await post("/api/public/cugc/free-session", { ...freeBase, childDob: dob });
    const goodBody = await good.json().catch(() => ({}));
    ok("a valid date of birth is accepted", good.status === 200 && goodBody.ok, `HTTP ${good.status}`);
    if (goodBody.id) madeFreeSessions.push(goodBody.id);

    const { rows: fsRows } = await pool.query(
      `SELECT child_dob, child_age FROM cugc_free_sessions WHERE child_name = $1`, [freeBase.childName],
    );
    ok("the date of birth was stored", fsRows[0]?.child_dob === dob, `${fsRows[0]?.child_dob}`);
    ok("the age was derived from it", fsRows[0]?.child_age === 5, `${fsRows[0]?.child_age} (expected 5)`);

    // A birthday one day from now must still read as the younger age.
    const dayBefore = new Date(Date.UTC(ty - 5, tm - 1, td + 1));
    const notYetDob = `${dayBefore.getUTCFullYear()}-${String(dayBefore.getUTCMonth() + 1).padStart(2, "0")}-${String(dayBefore.getUTCDate()).padStart(2, "0")}`;
    const nb = await post("/api/public/cugc/free-session", {
      ...freeBase, childName: `${TAG} Child2`, email: `${TAG.toLowerCase()}b@example.com`, childDob: notYetDob,
    });
    const nbBody = await nb.json().catch(() => ({}));
    if (nbBody.id) madeFreeSessions.push(nbBody.id);
    const { rows: nbRows } = await pool.query(
      `SELECT child_age FROM cugc_free_sessions WHERE child_name = $1`, [`${TAG} Child2`],
    );
    ok("a birthday that hasn't happened yet still reads the younger age", nbRows[0]?.child_age === 4, `${nbRows[0]?.child_age} (expected 4)`);

    console.log("\nPaid enrolment — date of birth is required");
    const enrolBase = {
      programSlug: "gymplay",
      optionIndex: 0,
      gymnastName: `${TAG} Enrol`,
      parentName: `${TAG} Parent`,
      email: `${TAG.toLowerCase()}@example.com`,
      phone: "0210000000",
    };
    for (const [label, d] of [["missing", ""], ["in the future", "2099-01-01"]] as const) {
      const res = await post("/api/public/cugc/enrol", { ...enrolBase, gymnastDob: d });
      const body = await res.json().catch(() => ({}));
      ok(`a DOB ${label} is refused`, res.status === 400, `HTTP ${res.status} "${body.message ?? ""}"`);
    }
    const { rows: leaked } = await pool.query(
      `SELECT count(*)::int n FROM cugc_registrations WHERE gymnast_name = $1`, [enrolBase.gymnastName],
    );
    ok("a refused enrolment writes NO registration row", leaked[0].n === 0, `${leaked[0].n} rows`);

    console.log("\nPaid enrolment — the checkout still works");
    const paid = await post("/api/public/cugc/enrol", { ...enrolBase, gymnastDob: dob });
    const paidBody = await paid.json().catch(() => ({}));
    ok("a valid enrolment is accepted", paid.status === 200, `HTTP ${paid.status} "${paidBody.message ?? ""}"`);
    ok("Stripe returned a client secret (checkout can mount)", typeof paidBody.clientSecret === "string" && paidBody.clientSecret.length > 10);
    const { rows: regRows } = await pool.query(
      `SELECT id, gymnast_dob, status FROM cugc_registrations WHERE gymnast_name = $1`, [enrolBase.gymnastName],
    );
    if (regRows[0]) madeRegistrations.push(regRows[0].id);
    ok("the registration was created with its DOB", regRows[0]?.gymnast_dob === dob, `${regRows[0]?.gymnast_dob}`);
    ok("and is pending payment, not paid", regRows[0]?.status === "pending_payment", regRows[0]?.status);
  } finally {
    for (const id of madeFreeSessions) {
      await pool.query(`DELETE FROM cugc_free_sessions WHERE id = $1`, [id]).catch(() => {});
    }
    await pool.query(`DELETE FROM cugc_free_sessions WHERE child_name LIKE $1`, [`${TAG}%`]).catch(() => {});
    for (const id of madeRegistrations) {
      await pool.query(`DELETE FROM cugc_registrations WHERE id = $1`, [id]).catch(() => {});
    }
    await pool.query(`DELETE FROM cugc_registrations WHERE gymnast_name LIKE $1`, [`${TAG}%`]).catch(() => {});
    const { rows } = await pool.query(
      `SELECT (SELECT count(*)::int FROM cugc_free_sessions WHERE child_name LIKE $1) fs,
              (SELECT count(*)::int FROM cugc_registrations WHERE gymnast_name LIKE $1) reg`, [`${TAG}%`],
    );
    console.log(`\ncleanup — ${rows[0].fs} test bookings, ${rows[0].reg} test registrations left behind`);
    console.log(`${pass} passed, ${fail} failed`);
    await pool.end();
    process.exit(fail === 0 ? 0 : 1);
  }
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
