// T9 — short-link redirect logic tests. Pure, no DB, no network.
// Run: npx tsx script/test-attribution-links.ts  (exits non-zero on failure)
import assert from "node:assert";
import { createHash, randomBytes } from "node:crypto";
import {
  isAllowedDestination,
  hostIsOurs,
  buildRedirectUrl,
  bytesToBase64Url,
  clickIdFromBytes,
  mainSiteForHost,
  ipHashSeed,
  DEFAULT_MAIN_SITE,
} from "../shared/short-links";

let n = 0;
function ok(cond: boolean, msg: string) {
  n++;
  assert.ok(cond, msg);
}
function eq(a: unknown, b: unknown, msg: string) {
  n++;
  assert.strictEqual(a, b, `${msg} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

// ── click-id / key generation (base64url of random bytes) ────────────────────
// Known RFC 4648 vectors ("Man" → "TWFu", "M" → "TQ", "Ma" → "TWE").
eq(bytesToBase64Url([0x4d, 0x61, 0x6e]), "TWFu", "base64url 'Man'");
eq(bytesToBase64Url([0x4d]), "TQ", "base64url 'M' (no padding)");
eq(bytesToBase64Url([0x4d, 0x61]), "TWE", "base64url 'Ma'");
// url-safe alphabet actually uses - and _ (bytes 0xff,0xff,0xfe → '__-' ... verify vs node)
for (const vec of [[0xff, 0xff, 0xfe], [0xfb, 0xff], [0x00, 0x00, 0x00], [0xde, 0xad, 0xbe, 0xef]]) {
  eq(bytesToBase64Url(vec), Buffer.from(vec).toString("base64url"), `base64url matches node for ${vec}`);
}
// 16-byte click id: 22 chars, url-safe charset only, matches the CID cookie regex,
// and equals node's own base64url of the same bytes.
for (let i = 0; i < 200; i++) {
  const b = randomBytes(16);
  const id = clickIdFromBytes(b);
  eq(id.length, 22, "click id is 22 chars");
  ok(/^[A-Za-z0-9_-]{1,64}$/.test(id), `click id url-safe: ${id}`);
  ok(!/[+/=]/.test(id), `click id has no +/=: ${id}`);
  eq(id, b.toString("base64url"), "click id equals node base64url");
}

// ── allow-list / open-redirect guard ─────────────────────────────────────────
for (const good of [
  "https://join.minifootball.co.nz/league",
  "https://minifootball.co.nz",
  "https://order.unitedprints.co.nz/print/order/abc",
  "https://www.cugc.co.nz/free-session",
  "https://cicyouth.com/skills-challenge",
  "https://footballinstitute.co.nz/apply",
  "https://southislandunited.com",
  "https://clubos.fly.dev/admin",
  "https://preview-abc.vercel.app/x",
  "http://localhost:5173/league",
]) {
  ok(isAllowedDestination(good), `allowed: ${good}`);
}
for (const bad of [
  "https://evil.com",
  "https://minifootball.co.nz.evil.com/league", // look-alike suffix attack
  "https://notminifootball.co.nz", // not a subdomain (no dot boundary)
  "https://evil.com/?x=minifootball.co.nz",
  "javascript:alert(1)",
  "data:text/html,x",
  "ftp://minifootball.co.nz",
  "//evil.com", // protocol-relative, no host parsed by URL()
  "not a url",
  "",
  null,
  undefined,
  123 as unknown,
]) {
  ok(!isAllowedDestination(bad as unknown as string), `blocked: ${String(bad)}`);
}
// hostIsOurs boundary checks
ok(hostIsOurs("JOIN.MINIFOOTBALL.CO.NZ"), "hostIsOurs case-insensitive");
ok(hostIsOurs("cugc.co.nz:443"), "hostIsOurs strips port");
ok(!hostIsOurs("minifootball.co.nz.attacker.io"), "hostIsOurs rejects suffix attack");
ok(!hostIsOurs(""), "hostIsOurs empty is false");

// ── redirect URL building (ci + utm, preserving existing params) ─────────────
{
  const url = buildRedirectUrl("https://join.minifootball.co.nz/league", "CID123", {
    channel: "facebook",
    medium: "paid_social",
    campaign: "term3",
    content: "carousel-a",
  });
  const u = new URL(url);
  eq(u.searchParams.get("ci"), "CID123", "ci appended");
  eq(u.searchParams.get("utm_source"), "facebook", "utm_source from channel");
  eq(u.searchParams.get("utm_medium"), "paid_social", "utm_medium");
  eq(u.searchParams.get("utm_campaign"), "term3", "utm_campaign");
  eq(u.searchParams.get("utm_content"), "carousel-a", "utm_content");
  eq(u.hostname, "join.minifootball.co.nz", "host unchanged");
  eq(u.pathname, "/league", "path unchanged");
}
{
  // existing destination params are preserved; existing utm_source is NOT clobbered.
  const url = buildRedirectUrl("https://minifootball.co.nz/l?team=abc&utm_source=poster", "CID9", {
    channel: "facebook",
    medium: "paid_social",
    campaign: "term3",
  });
  const u = new URL(url);
  eq(u.searchParams.get("team"), "abc", "existing non-utm param preserved");
  eq(u.searchParams.get("utm_source"), "poster", "existing utm_source not overwritten");
  eq(u.searchParams.get("utm_medium"), "paid_social", "absent utm_medium still filled");
  eq(u.searchParams.get("ci"), "CID9", "ci added alongside existing params");
}
{
  // ci overwrites a pre-existing ci; null/empty utm fields are skipped.
  const url = buildRedirectUrl("https://cugc.co.nz/enrol?ci=OLD", "NEW", {
    channel: "instagram",
    medium: null,
    campaign: "",
    content: undefined,
  });
  const u = new URL(url);
  eq(u.searchParams.get("ci"), "NEW", "ci overwritten with fresh value");
  eq(u.searchParams.get("utm_source"), "instagram", "utm_source set");
  eq(u.searchParams.has("utm_medium"), false, "null utm_medium skipped");
  eq(u.searchParams.has("utm_campaign"), false, "empty utm_campaign skipped");
  eq(u.searchParams.has("utm_content"), false, "undefined utm_content skipped");
}
{
  // no utm supplied → just ci
  const url = buildRedirectUrl("https://cicyouth.com/x", "ONLYCI");
  eq(new URL(url).searchParams.get("ci"), "ONLYCI", "ci-only build");
}

// ── unknown-key fallback (org main site, never open redirect) ────────────────
eq(mainSiteForHost("join.minifootball.co.nz"), "https://minifootball.co.nz", "join. stripped → root");
eq(mainSiteForHost("order.unitedprints.co.nz"), "https://unitedprints.co.nz", "order. stripped → root");
eq(mainSiteForHost("www.cugc.co.nz"), "https://cugc.co.nz", "www. stripped → root");
eq(mainSiteForHost("cicyouth.com"), "https://cicyouth.com", "apex host kept");
eq(mainSiteForHost("clubos.fly.dev"), "https://clubos.fly.dev", "app host kept");
eq(mainSiteForHost("join.minifootball.co.nz:443"), "https://minifootball.co.nz", "port stripped in fallback");
eq(mainSiteForHost("something.vercel.app"), DEFAULT_MAIN_SITE, "preview host → default");
eq(mainSiteForHost("localhost:5173"), DEFAULT_MAIN_SITE, "dev host → default");
eq(mainSiteForHost("evil.com"), DEFAULT_MAIN_SITE, "foreign host → default");
eq(mainSiteForHost(""), DEFAULT_MAIN_SITE, "empty host → default");
eq(mainSiteForHost(undefined), DEFAULT_MAIN_SITE, "missing host → default");

// ── dedupe hash seed (SHA256(ip+ua)) ─────────────────────────────────────────
const sha = (ip: string, ua: string) => createHash("sha256").update(ipHashSeed(ip, ua)).digest("hex");
eq(ipHashSeed("1.2.3.4", "UA/1"), "1.2.3.4||UA/1", "seed format");
eq(sha("1.2.3.4", "UA/1"), sha("1.2.3.4", "UA/1"), "same (ip,ua) → same hash (dedupe hits)");
ok(sha("1.2.3.4", "UA/1") !== sha("1.2.3.5", "UA/1"), "different ip → different hash");
ok(sha("1.2.3.4", "UA/1") !== sha("1.2.3.4", "UA/2"), "different ua → different hash");
// separator prevents ip/ua boundary collisions
ok(ipHashSeed("ab", "c") !== ipHashSeed("a", "bc"), "boundary is unambiguous");
eq(sha("", "").length, 64, "sha256 hex is 64 chars");
ok(!sha("1.2.3.4", "UA/1").includes("1.2.3.4"), "digest never contains the raw ip");

console.log(`\n✅ test-attribution-links: ${n} assertions passed`);
