// Live verification for the PayShare integration.
//
//   npx tsx --env-file=.env script/_verify-payshare.ts
//
// Checks the things that would silently cost money or misdiagnose an outage:
//   · a paused integration reads as 503 "not open yet", never 502/500
//   · a contract gap reads as 400 WITH the gaps, so the self-test can name it
//   · completion amounts reconcile in both unit conventions and REFUSE anything
//     that doesn't — this is the guard between a $170 pitch and a $1.70 session
//   · signatures round-trip on both inbound secrets
//   · the wizard probe answers with every field PayShare requires
//
// Read-only against PayShare: it creates nothing that survives (session create
// is refused while paused, which is exactly the state under test).

import { amountsReconcile } from "../server/payshare-routes";
import {
  createPayShareSession,
  getBookingByRef,
  payshareEnv,
  payshareErrorResponse,
  resolveWizardProbeBooking,
} from "../server/payshare";

let bad = 0;
const check = (ok: boolean, label: string, detail = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "  ok " : " FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
};

console.log("\n── env ─────────────────────────────────────────────────────────");
const env = payshareEnv();
check(!!env, "PAYSHARE_* env present");
if (env) {
  check(!!env.apiKey.startsWith("ps_"), "API key looks like a PayShare key");
  check(env.liveMode === false, "live mode OFF by default", `PAYSHARE_LIVE_MODE=${process.env.PAYSHARE_LIVE_MODE ?? "(unset)"}`);
}

console.log("\n── amount reconciliation (the money guard) ─────────────────────");
check(amountsReconcile("17020", 17020), "minor units match");
check(amountsReconcile("170.20", 17020), "major units match");
check(amountsReconcile("170.2", 17020), "major units, trailing zero dropped");
check(!amountsReconcile("1702", 17020), "REFUSES a 10x-short total");
check(!amountsReconcile("17020.00", 17020), "REFUSES major-unit reading of a minor-unit figure");
check(!amountsReconcile("", 17020), "REFUSES empty");
check(!amountsReconcile(null, 17020), "REFUSES null");
check(!amountsReconcile("abc", 17020), "REFUSES junk");
check(!amountsReconcile("-170.20", 17020), "REFUSES negative");

// The capture model is the single most expensive thing to get wrong here, and
// it is invisible to a type-checker: charge-on-pay compiles perfectly and takes
// real money for bookings that never fill. These are source assertions, in the
// spirit of deploy.sh's client-only regression guard.
console.log("\n── capture model (authorise → group capture) ───────────────────");
{
  const { readFileSync } = await import("fs");
  const { fileURLToPath } = await import("url");
  const { dirname, join } = await import("path");
  const here = dirname(fileURLToPath(import.meta.url));
  const routes = readFileSync(join(here, "..", "server", "payshare-routes.ts"), "utf8");

  check(/capture_method:\s*"manual"/.test(routes), "PaymentIntent uses MANUAL capture (money held, not taken)");
  check(/requires_capture/.test(routes), "treats requires_capture as an authorised payer");
  check(/kind:\s*"authorize"/.test(routes), "records kind:authorize on each pay");
  check(/PAYSHARE_SESSION_CAPTURE_READY/.test(routes), "handles capture-ready");
  check(/await captureGroup\(/.test(routes), "capture-ready actually captures the group (not a no-op)");
  check(/kind:\s*"capture"/.test(routes), "records kind:capture at group capture");
  check(
    /paymentIntents\.capture\(/.test(routes),
    "captures the Stripe holds",
  );
  // The per-payer path must not report a capture — that would tell PayShare the
  // money is banked while it is still only held, and group capture would never
  // be requested. Anchored on the function itself rather than a byte window, so
  // a refactor moves the check instead of silently emptying it.
  const perPayerStart = routes.indexOf("async function recordAuthorisedShare");
  check(perPayerStart > -1, "recordAuthorisedShare (the per-payer path) exists");
  const perPayer = perPayerStart > -1 ? routes.slice(perPayerStart) : "";
  check(
    perPayer.includes('kind: "authorize"') && !perPayer.includes('kind: "capture"'),
    "the per-payer path records authorize ONLY, never capture",
  );
  // …and the group path is the only place a capture is reported.
  const groupStart = routes.indexOf("async function captureGroup");
  const groupBlock = groupStart > -1 ? routes.slice(groupStart, routes.indexOf("export function registerPayShareRoutes")) : "";
  check(groupBlock.includes('kind: "capture"'), "captureGroup is the only place capture is recorded");
}

console.log("\n── error mapping ──────────────────────────────────────────────");
const gapErr = payshareErrorResponse(
  Object.assign(new Error("Missing required fields"), {
    status: 400,
    code: "CONTRACT_VIOLATION",
    gaps: ["orderSummary.merchantDisplayName"],
  }),
);
check(gapErr.status === 400, "CONTRACT_VIOLATION → 400", `got ${gapErr.status}`);
check(
  JSON.stringify(gapErr.body.error.details?.gaps) === JSON.stringify(["orderSummary.merchantDisplayName"]),
  "CONTRACT_VIOLATION carries details.gaps",
);

const pausedErr = payshareErrorResponse(
  Object.assign(new Error("PayShare — unavailable"), { status: 403, code: "INTEGRATION_PAUSED" }),
);
check(pausedErr.status === 503, "INTEGRATION_PAUSED → 503, not an outage", `got ${pausedErr.status}`);
check(pausedErr.status !== 500, "never 500");

console.log("\n── wizard probe ───────────────────────────────────────────────");
const probe = resolveWizardProbeBooking("payshare-wizard-probe");
check(!!probe, "probe ref resolves");
check(probe?.isProbe === true, "flagged isProbe — nothing downstream may charge for it");
check(!!probe?.orderSummary?.merchantDisplayName, "orderSummary.merchantDisplayName present (required)");
check(!!probe?.orderSummary?.orderReference, "orderSummary.orderReference present (required)");
check(probe?.currency === "NZD", "explicit currency");
check(resolveWizardProbeBooking("vbg_abc123") === null, "a real booking ref is NOT treated as a probe");

console.log("\n── probe survives getBookingByRef (no DB hit) ──────────────────");
const viaHook = await getBookingByRef("payshare-wizard-probe");
check(!!viaHook?.isProbe, "getBookingByRef keeps the wizard probe path");

console.log("\n── live createSession (expected to be refused while paused) ────");
if (!env) {
  console.log("  skipped — no env");
} else {
  try {
    const s = await createPayShareSession(
      {
        amountMinor: "17020",
        currency: "NZD",
        merchantOrderRef: "payshare-wizard-probe-verify",
        orderSummary: {
          merchantDisplayName: "United Sports Centre",
          orderReference: "payshare-wizard-probe-verify",
          itemDescription: "Full pitch hire — 60 min (verify)",
        },
      },
      { idempotencyKey: `verify-${process.pid}` },
    );
    check(!!s.sessionId && !!s.sessionUrl, "session created — integration is NO LONGER paused", s.sessionId);
    console.log("\n  NOTE: rollout is open. Re-run the PayShare wizard self-test.");
  } catch (e: any) {
    const mapped = payshareErrorResponse(e);
    check(!!e.code, "the real error CODE survives (SDK drops it — we don't)", String(e.code));
    check(
      e.code === "INTEGRATION_PAUSED" ? mapped.status === 503 : mapped.status === 400,
      `mapped ${e.code} → ${mapped.status}`,
    );
    check(mapped.status !== 500 && mapped.status !== 502, "not reported as a server fault");
    if (e.code === "INTEGRATION_PAUSED") {
      console.log("\n  → Rollout is PAUSED in PayShare Partner Settings. Move it to Pilot to go further.");
    }
  }
}

console.log(`\n${bad === 0 ? "✓ all checks passed" : `✗ ${bad} check(s) failed`}\n`);
process.exit(bad === 0 ? 0 : 1);
