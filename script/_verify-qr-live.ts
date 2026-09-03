/**
 * _verify-qr-live.ts — the QR Code Generator, against production.
 *
 * Asserts the things that would silently break it:
 *  - every link that existed before the rebuild is still listed
 *  - the universal endpoints are gated (401 to a stranger, never 200)
 *  - a business's programmes produce a destination that actually resolves
 *  - the destination allow-list still refuses anything off our domains
 *
 * The URL shapes matter more than they look: a QR code goes on a printed
 * poster, so a wrong path is discovered by a parent standing in a car park.
 *
 *   npx tsx --env-file=.env script/_verify-qr-live.ts
 */
import pg from "pg";
import { suggestedDestination, programmeUrl } from "../shared/qr-targets.js";
import { isAllowedDestination } from "../shared/short-links.js";

const BASE = "https://app.usg.co.nz";
let failed = 0;
const ok = (m: string) => console.log(`  ok   ${m}`);
const bad = (m: string) => { failed++; console.log(`  FAIL ${m}`); };

const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();

// ── 1. Nothing was lost ────────────────────────────────────────────────────
const { rows: links } = await c.query(
  `select id, key, destination, clicks, program_id, organization_id from short_links order by id`);
const clicks = links.reduce((n, l) => n + (l.clicks || 0), 0);
links.length >= 7 ? ok(`${links.length} tracked links still present (${clicks} clicks)`)
                  : bad(`only ${links.length} links — links were LOST`);
for (const key of ["field-hire", "tech", "FpDkP6e"]) {
  links.some((l) => l.key === key) ? ok(`/l/${key} survived the rebuild`) : bad(`/l/${key} is GONE`);
}
const { rows: [cl] } = await c.query(`select count(*)::int n from link_clicks`);
cl.n >= 1640 ? ok(`${cl.n} click rows intact`) : bad(`click history shrank to ${cl.n}`);

// ── 2. The column is additive ──────────────────────────────────────────────
const { rows: [col] } = await c.query(
  `select is_nullable, column_default from information_schema.columns
   where table_name='short_links' and column_name='program_id'`);
col?.is_nullable === "YES" && col.column_default == null
  ? ok("program_id is nullable with no default — old links assert nothing")
  : bad("program_id must be nullable with no default");

// ── 3. The endpoints are gated ─────────────────────────────────────────────
for (const path of ["/api/admin/qr/options", "/api/admin/qr/links"]) {
  const r = await fetch(BASE + path, { redirect: "manual" });
  r.status === 401 ? ok(`${path} → 401 to a stranger`)
                   : bad(`${path} → ${r.status}, expected 401 (is it deployed? is it OPEN?)`);
}

// ── 4. Derived destinations actually resolve ───────────────────────────────
const { rows: progs } = await c.query(
  `select p.id, p.slug, p.name, p.type, p.organization_id o
   from programs p where p.is_active and p.organization_id in (1,2,3) order by p.organization_id, p.id`);
const seen = new Set<string>();
for (const p of progs) {
  const url = programmeUrl(p.o, { slug: p.slug, type: p.type });
  if (!url) { bad(`no URL derived for ${p.name}`); continue; }
  if (!isAllowedDestination(url)) { bad(`${url} fails the allow-list`); continue; }
  if (seen.has(url)) continue;
  seen.add(url);
  const r = await fetch(url, { redirect: "follow" }).catch(() => null);
  const code = r?.status ?? 0;
  code >= 200 && code < 400
    ? ok(`${p.name} → ${url} (${code})`)
    : bad(`${p.name} → ${url} answered ${code} — a poster would send people to a dead page`);
}

// ── 5. The allow-list still refuses the world ──────────────────────────────
for (const evil of ["https://evil.example.com/", "http://cufc.co.nz.evil.com/", "javascript:alert(1)"]) {
  isAllowedDestination(evil) ? bad(`allow-list ACCEPTED ${evil}`) : ok(`allow-list refuses ${evil}`);
}
suggestedDestination(7, null) === null
  ? ok("United Sports Group has no funnel host and is offered none")
  : bad("USG should not produce a destination");

await c.end();
console.log(failed === 0 ? `\n✓ QR Code Generator verified on production.\n` : `\n✗ ${failed} check(s) failed.\n`);
process.exit(failed === 0 ? 0 : 1);
