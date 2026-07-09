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
import { renderTrackerScript } from "../shared/tracker-script";
import { serializeSetCookie, VID_COOKIE, VID_MAX_AGE_SECONDS } from "../server/attribution-cookies";

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

// ── summary ──────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("\nFailures:");
  for (const f of fails) console.log("  ✗ " + f);
  process.exit(1);
}
console.log("✓ all T12 tracker assertions pass");
