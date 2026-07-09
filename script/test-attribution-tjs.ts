// Standalone proof of the AttributionOS cross-site tracker `/t.js` (T12). No DB / network.
//   npx tsx script/test-attribution-tjs.ts
//
// Covers the pure logic behind the tracker route:
//   - rootDomainForHost: brand root for a funnel subdomain; null for app/preview/dev
//   - isOurOrigin: CORS allow-list reflection (roots, subdomains, *.vercel.app, dev)
//   - serializeSetCookie: Domain attribute scopes the cookie; backward-compatible
//   - renderTrackerScript: <6KB, ES5-safe (no arrow/const/let/backtick), parses as
//     valid JS, injects the collector base + brand-root list, wires hello + batch

import { rootDomainForHost, isOurOrigin, CLUB_ROOT_DOMAINS } from "../shared/short-links";
import { renderTrackerScript, renderBehaviorScript } from "../shared/tracker-script";
import { serializeSetCookie, VID_COOKIE, VID_MAX_AGE_SECONDS } from "../server/attribution-cookies";
import { BEHAVIOR_EVENT_TYPES } from "../shared/behavior";

let pass = 0;
let fail = 0;
const fails: string[] = [];
function check(cond: boolean, msg: string) {
  if (cond) pass++;
  else {
    fail++;
    if (fails.length < 40) fails.push(msg);
  }
}
function eq(actual: unknown, expected: unknown, msg: string) {
  check(actual === expected, `${msg} — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

// ── rootDomainForHost ────────────────────────────────────────────────────────
eq(rootDomainForHost("join.minifootball.co.nz"), "minifootball.co.nz", "root: funnel subdomain → brand root");
eq(rootDomainForHost("minifootball.co.nz"), "minifootball.co.nz", "root: bare brand root maps to itself");
eq(rootDomainForHost("www.cugc.co.nz"), "cugc.co.nz", "root: www subdomain");
eq(rootDomainForHost("order.unitedprints.co.nz"), "unitedprints.co.nz", "root: order subdomain");
eq(rootDomainForHost("JOIN.MiniFootball.CO.NZ"), "minifootball.co.nz", "root: case-insensitive");
eq(rootDomainForHost("join.minifootball.co.nz:443"), "minifootball.co.nz", "root: strips port");
eq(rootDomainForHost("clubos.fly.dev"), null, "root: app host → null (host-only cookie)");
eq(rootDomainForHost("mfl-website.vercel.app"), null, "root: preview host → null");
eq(rootDomainForHost("localhost"), null, "root: dev host → null");
eq(rootDomainForHost("evil.com"), null, "root: foreign host → null");
eq(rootDomainForHost("minifootball.co.nz.evil.com"), null, "root: look-alike suffix → null");
eq(rootDomainForHost(""), null, "root: empty → null");
eq(rootDomainForHost(undefined), null, "root: undefined → null");

// ── isOurOrigin (CORS reflection guard) ──────────────────────────────────────
check(isOurOrigin("https://minifootball.co.nz"), "origin: brand root allowed");
check(isOurOrigin("https://www.minifootball.co.nz"), "origin: www subdomain allowed");
check(isOurOrigin("https://join.minifootball.co.nz"), "origin: funnel subdomain allowed");
check(isOurOrigin("https://cicyouth.com"), "origin: another brand root allowed");
check(isOurOrigin("https://mfl-website-alpha.vercel.app"), "origin: vercel preview allowed");
check(isOurOrigin("http://localhost:5173"), "origin: local dev allowed");
check(!isOurOrigin("https://evil.com"), "origin: foreign rejected");
check(!isOurOrigin("https://minifootball.co.nz.evil.com"), "origin: look-alike rejected");
check(!isOurOrigin("javascript:alert(1)"), "origin: non-http scheme rejected");
check(!isOurOrigin("null"), "origin: literal 'null' rejected");
check(!isOurOrigin(""), "origin: empty rejected");
check(!isOurOrigin(undefined), "origin: undefined rejected");

// ── serializeSetCookie with Domain (brand-root scoping) ──────────────────────
{
  const scoped = serializeSetCookie(
    { name: VID_COOKIE, value: "v1", maxAgeSeconds: VID_MAX_AGE_SECONDS },
    { secure: true, domain: "minifootball.co.nz" },
  );
  check(scoped.includes("Domain=minifootball.co.nz"), "cookie: Domain present when scoped");
  check(scoped.includes("SameSite=Lax"), "cookie: SameSite=Lax still present with Domain");
  check(scoped.includes("Secure"), "cookie: Secure present");
  check(!scoped.includes("HttpOnly"), "cookie: never HttpOnly (JS reads it)");

  // Backward-compatible: no domain → no Domain attribute (T4 host-only path).
  const hostOnly = serializeSetCookie({ name: VID_COOKIE, value: "v1", maxAgeSeconds: 10 }, { secure: true });
  check(!hostOnly.includes("Domain="), "cookie: no Domain attribute when unscoped");
  // null domain (app/preview/dev host) also omits Domain.
  const nullDomain = serializeSetCookie({ name: VID_COOKIE, value: "v1", maxAgeSeconds: 10 }, { secure: true, domain: null });
  check(!nullDomain.includes("Domain="), "cookie: null domain omits Domain attribute");
}

// ── renderTrackerScript ──────────────────────────────────────────────────────
const js = renderTrackerScript({ collectorBase: "https://join.minifootball.co.nz/", domains: CLUB_ROOT_DOMAINS });

check(typeof js === "string" && js.length > 0, "tracker: renders a non-empty string");
check(Buffer.byteLength(js, "utf8") < 6 * 1024, `tracker: under 6KB (got ${Buffer.byteLength(js, "utf8")} bytes)`);

// ES5-safety: the served string must not use arrow fns, const/let, or template literals.
check(!js.includes("=>"), "tracker: no arrow functions");
check(!/\bconst\b/.test(js), "tracker: no const");
check(!/\blet\b/.test(js), "tracker: no let");
check(!js.includes("`"), "tracker: no template literals");

// Injected config: base has its trailing slash stripped; brand roots are embedded.
check(js.includes("https://join.minifootball.co.nz"), "tracker: injects collector base");
check(!js.includes("join.minifootball.co.nz/'"), "tracker: trailing slash stripped from base");
check(js.includes("minifootball.co.nz"), "tracker: embeds a brand root for decoration");
check(js.includes("/api/public/analytics/hello"), "tracker: wires the hello boot endpoint");
check(js.includes("/api/public/analytics/batch"), "tracker: wires the collector batch endpoint");
check(js.includes("usg_vid") && js.includes("usg_cid"), "tracker: reads the first-party cookies");
check(js.includes("withCredentials"), "tracker: sends credentials so first-party cookie sticks");
check(/vi[=']/.test(js) && js.includes("searchParams"), "tracker: decorates outbound links with vi/ci");

// The emitted body must parse as valid JS (syntax check, not executed).
let parses = true;
try {
  // eslint-disable-next-line no-new-func
  new Function(js);
} catch {
  parses = false;
}
check(parses, "tracker: emitted body is syntactically valid JS");

// Empty base still renders (defensive) and stays ES5-safe.
{
  const bare = renderTrackerScript({ collectorBase: "", domains: [] });
  check(typeof bare === "string" && bare.length > 0, "tracker: empty opts still render");
  check(!bare.includes("=>") && !bare.includes("`"), "tracker: empty opts stay ES5-safe");
}

// Boot script now lazy-loads the T6 behavioral collector once a visitor id exists.
check(js.includes("/t2.js"), "tracker: boot lazy-loads the behavioral script");
check(js.includes("__usgB"), "tracker: boot hands off {base,vid,sid} via window.__usgB");

// ── renderBehaviorScript (T6 — the lazy-loaded v2 behavioral collector) ─────
const beh = renderBehaviorScript({ collectorBase: "https://join.minifootball.co.nz/" });

check(typeof beh === "string" && beh.length > 0, "behavior: renders a non-empty string");
// Lazy-loaded (not part of the boot payload), so no hard 6KB cap — but it should
// stay a lean, single-purpose script, not balloon unboundedly.
check(Buffer.byteLength(beh, "utf8") < 20 * 1024, `behavior: under 20KB (got ${Buffer.byteLength(beh, "utf8")} bytes)`);

// ES5-safety: same constraint as the boot script — served verbatim, never transpiled.
check(!beh.includes("=>"), "behavior: no arrow functions");
check(!/\bconst\b/.test(beh), "behavior: no const");
check(!/\blet\b/.test(beh), "behavior: no let");
check(!beh.includes("`"), "behavior: no template literals");

// Emitted body must parse as valid JS (syntax check, not executed).
{
  let behParses = true;
  try {
    // eslint-disable-next-line no-new-func
    new Function(beh);
  } catch {
    behParses = false;
  }
  check(behParses, "behavior: emitted body is syntactically valid JS");
}

// Reads the boot-injected handoff, never re-derives cookies/session itself.
check(beh.includes("__usgB"), "behavior: reads window.__usgB from the boot script");

// Wires the NEW behavioral collector endpoint — never the attribution /batch path (rule 4).
check(beh.includes("/api/public/analytics/behavior"), "behavior: posts to the v2 behavioral collector");
check(!beh.includes("/api/public/analytics/batch"), "behavior: never posts to the attribution touch endpoint");
check(!beh.includes("/api/public/analytics/hello"), "behavior: never re-calls the attribution hello endpoint");

// Full v2 taxonomy (AGENTS.md §1) is present, sourced from the same whitelist shared/behavior.ts enforces.
for (const t of BEHAVIOR_EVENT_TYPES) {
  check(beh.includes(`'${t}'`), `behavior: emits event type '${t}'`);
}

// Element-anchored click: CSS-path + normalized offset (D18), not raw pixel x/y.
check(beh.includes("cssPath"), "behavior: click carries a CSS-path anchor");
check(beh.includes("offsetX") && beh.includes("offsetY"), "behavior: click carries normalized 0..1 offsets");
check(beh.includes("nth-of-type"), "behavior: CSS-path builder uses nth-of-type for un-id'd ancestors");

// Rage-click: ≥3 clicks same element <1s.
check(beh.includes("rage_click"), "behavior: detects rage clicks");

// Scroll: max depth bucketed into 10% bands.
check(beh.includes("scrollBand"), "behavior: buckets scroll depth into bands");

// Section timing: IntersectionObserver-driven visible-ms per data-track-section.
check(beh.includes("IntersectionObserver"), "behavior: uses IntersectionObserver for section timing");
check(beh.includes("data-track-section"), "behavior: reads the [data-track-section] attribute");

// Web Vitals via PerformanceObserver (LCP/CLS/INP), all feature-detected + try/caught.
check(beh.includes("PerformanceObserver"), "behavior: observes Web Vitals");
check(beh.includes("largest-contentful-paint") && beh.includes("layout-shift"), "behavior: observes LCP + CLS entry types");

// SPA route changes: history.pushState/replaceState + popstate hooked.
check(beh.includes("pushState") && beh.includes("replaceState") && beh.includes("popstate"), "behavior: hooks SPA navigation");

// Forms: start/abandon tracked by id only, no field values ever read. (The CLS
// vitals observer legitimately reads PerformanceEntry.value, so we assert the
// narrower, true guarantee: form tracking only ever reads .id/.name, never .value.)
check(beh.includes("form_start") && beh.includes("form_abandon"), "behavior: tracks form start/abandon");
check(!/formIdOf[\s\S]{0,200}?\.value\b/.test(beh), "behavior: form-id lookup never reads a field's .value");

// Batched + beacon-on-unload delivery (>=1 requests via sendBeacon, periodic XHR flush).
check(beh.includes("sendBeacon"), "behavior: flushes via sendBeacon on unload/hidden");
check(beh.includes("visibilitychange") && beh.includes("pagehide"), "behavior: flushes on visibilitychange + pagehide");
check(beh.includes("setInterval"), "behavior: periodic batched flush (not one request per event)");

// Fail-silent (rule 5): every risky browser API call is guarded so the tracker never throws.
check((beh.match(/catch\(e\)/g) || []).length >= 10, "behavior: broad try/catch coverage around browser APIs");

// Regex metacharacters must survive template-literal cooking (doubled backslash in
// the TS source) — a single backslash would silently degrade to a bare letter.
check(beh.includes("\\s+"), "behavior: whitespace-collapse regex keeps its backslash through template cooking");

// Empty base still renders defensively and stays ES5-safe; no visitor id → no-ops harmlessly at runtime.
{
  const bareBeh = renderBehaviorScript({ collectorBase: "" });
  check(typeof bareBeh === "string" && bareBeh.length > 0, "behavior: empty opts still render");
  check(!bareBeh.includes("=>") && !bareBeh.includes("`"), "behavior: empty opts stay ES5-safe");
}

// ── summary ──────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("\nFailures:");
  for (const f of fails) console.log("  ✗ " + f);
  process.exit(1);
}
console.log("✓ all T12 tracker assertions pass");
