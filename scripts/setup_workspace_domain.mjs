#!/usr/bin/env node
/**
 * setup_workspace_domain.mjs — one-command domain onboarding for a ClubOS workspace.
 *
 * Makes a workspace send transactional email from its OWN brand domain (verified in
 * Resend, DNS written to GoDaddy) and serves its public landing pages on join.<domain>
 * (DNS + Fly cert + custom_domains row). Idempotent + safe: only ever writes the
 * `send` + `resend._domainkey` subdomains for email (never the root @ MX, so real
 * Google Workspace mail is untouched) and the `join` subdomain for landing pages.
 *
 * Source of truth for which domain belongs to which workspace: shared/org-domains.ts
 *
 * Usage (run from apps/clubos):
 *   node scripts/setup_workspace_domain.mjs status                 # list Resend domains + verify state
 *   node scripts/setup_workspace_domain.mjs email <domain>|all     # provision + DNS + trigger verify
 *   node scripts/setup_workspace_domain.mjs verify <domain>|all    # re-check Resend verification only
 *   node scripts/setup_workspace_domain.mjs join <domain> <orgId>  # join.<domain> DNS + Fly cert + row
 */
import 'dotenv/config';
import pg from 'pg';
import { execFileSync } from 'node:child_process';

const RESEND = process.env.RESEND_API_KEY;
const GD_KEY = process.env.GODADDY_API_KEY;
const GD_SECRET = process.env.GODADDY_API_SECRET;
const GD_AUTH = `sso-key ${GD_KEY}:${GD_SECRET}`;
const FLY_APP = 'clubos';
const FLY_TARGET = 'clubos.fly.dev';   // join.<domain> CNAMEs here; Fly routes by Host + cert
const RESEND_REGION = 'ap-northeast-1'; // matches cufc.co.nz + unitedsportscentre.com

// Brand email domains to verify (one per active sender brand). Keep in sync with shared/org-domains.ts.
const EMAIL_DOMAINS = [
  'southislandunited.com',
  'minifootball.co.nz',
  'cicyouth.com',
  'cic7s.com',
  'cugc.co.nz',
  'unitedprints.co.nz',
];

if (!RESEND || !GD_KEY || !GD_SECRET) {
  console.error('Missing RESEND_API_KEY / GODADDY_API_KEY / GODADDY_API_SECRET in apps/clubos/.env');
  process.exit(1);
}

// ---------- Resend ----------
let _lastResend = 0;
async function resendThrottle() {
  const gap = 650; // stay under Resend's 2 req/s
  const wait = _lastResend + gap - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  _lastResend = Date.now();
}
async function resend(path, opts = {}) {
  await resendThrottle();
  const res = await fetch(`https://api.resend.com${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${RESEND}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) throw new Error(`Resend ${path} ${res.status}: ${text}`);
  return body;
}
async function resendFindDomain(name) {
  const list = await resend('/domains');
  return (list.data || []).find((d) => d.name === name) || null;
}
async function resendEnsureDomain(name) {
  const existing = await resendFindDomain(name);
  if (existing) {
    // fetch full record (list endpoint omits records)
    return await resend(`/domains/${existing.id}`);
  }
  return await resend('/domains', { method: 'POST', body: JSON.stringify({ name, region: RESEND_REGION }) });
}

// ---------- GoDaddy ----------
function rootDomain(host) {
  // southislandunited.com -> southislandunited.com ; also handles *.co.nz
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const twoLevelTld = ['co.nz', 'org.nz', 'net.nz', 'co.uk', 'com.au'];
  const lastTwo = parts.slice(-2).join('.');
  const lastThree = parts.slice(-3).join('.');
  return twoLevelTld.includes(lastTwo) ? lastThree : lastTwo;
}
async function godaddyPut(domain, type, name, records) {
  const res = await fetch(`https://api.godaddy.com/v1/domains/${domain}/records/${type}/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { Authorization: GD_AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify(records),
  });
  if (!res.ok) throw new Error(`GoDaddy PUT ${type}/${name} on ${domain} ${res.status}: ${await res.text()}`);
}
async function godaddyGet(domain, type, name) {
  const res = await fetch(`https://api.godaddy.com/v1/domains/${domain}/records/${type}/${encodeURIComponent(name)}`, {
    headers: { Authorization: GD_AUTH },
  });
  if (!res.ok) return [];
  return await res.json();
}

// Write the Resend-required records for <domain> into GoDaddy (send.* + resend._domainkey only).
async function writeEmailDns(domain, records) {
  for (const r of records) {
    const name = r.name; // 'send' or 'resend._domainkey' — relative to root
    if (r.type === 'MX') {
      await godaddyPut(domain, 'MX', name, [{ data: r.value, ttl: 600, priority: r.priority ?? 10 }]);
    } else if (r.type === 'TXT') {
      await godaddyPut(domain, 'TXT', name, [{ data: r.value, ttl: 600 }]);
    }
    console.log(`   wrote ${r.type} ${name}.${domain}`);
  }
}

// ---------- commands ----------
async function cmdEmail(domain) {
  console.log(`\n▶ ${domain}`);
  const d = await resendEnsureDomain(domain);
  console.log(`   Resend domain ${d.id} status=${d.status}`);
  if (d.status === 'verified') { console.log('   already verified ✓'); return d; }
  await writeEmailDns(domain, d.records || []);
  const v = await resend(`/domains/${d.id}/verify`, { method: 'POST' });
  console.log(`   triggered verify → ${v.status || 'pending'} (DNS may take a few min to propagate)`);
  return d;
}

async function cmdVerify(domain) {
  const d = await resendFindDomain(domain);
  if (!d) { console.log(`   ${domain}: NOT in Resend`); return null; }
  await resend(`/domains/${d.id}/verify`, { method: 'POST' }).catch(() => {});
  const full = await resend(`/domains/${d.id}`);
  console.log(`   ${domain}: ${full.status}`);
  return full;
}

async function cmdStatus() {
  const list = await resend('/domains');
  console.log('=== Resend domains ===');
  for (const d of (list.data || []).sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`  ${d.name.padEnd(30)} ${d.status}  (${d.region})`);
  }
}

async function cmdJoin(host, orgId) {
  const root = rootDomain(host);
  const sub = host.slice(0, host.length - root.length - 1); // 'join'
  console.log(`\n▶ landing host ${host} (root=${root}, sub=${sub}, org=${orgId})`);

  // 1. DNS — CNAME join -> clubos.fly.dev (skip if it already points at Fly)
  const existing = await godaddyGet(root, 'CNAME', sub);
  const already = existing.some((r) => (r.data || '').includes('fly.dev'));
  const aRecs = await godaddyGet(root, 'A', sub);
  const aAlready = aRecs.some((r) => r.data === '66.241.124.3');
  if (already || aAlready) {
    console.log('   DNS already points at Fly ✓');
  } else {
    await godaddyPut(root, 'CNAME', sub, [{ data: `${FLY_TARGET}.`, ttl: 600 }]);
    console.log(`   wrote CNAME ${host} -> ${FLY_TARGET}`);
  }

  // 2. Fly cert (idempotent — "add" is a no-op if it exists)
  try {
    execFileSync('flyctl', ['certs', 'add', host, '-a', FLY_APP], {
      stdio: 'pipe', env: { ...process.env, FLY_API_TOKEN: process.env.FLY_API_TOKEN },
    });
    console.log('   fly cert requested ✓');
  } catch (e) {
    const msg = String(e.stdout || e.stderr || e.message);
    if (/already/i.test(msg)) console.log('   fly cert already present ✓');
    else console.log(`   fly certs add note: ${msg.trim().split('\n').pop()}`);
  }

  // 3. custom_domains row (host -> org)
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    const r = await pool.query('SELECT id FROM custom_domains WHERE lower(domain)=lower($1)', [host]);
    if (r.rowCount === 0) {
      await pool.query(
        `INSERT INTO custom_domains (organization_id, domain, status, verified, is_primary, created_at)
         VALUES ($1,$2,'active',false,false, now())`,
        [orgId, host],
      );
      console.log('   custom_domains row inserted ✓');
    } else {
      console.log('   custom_domains row already exists ✓');
    }
  } finally {
    await pool.end();
  }
}

// ---------- main ----------
const [cmd, arg, arg2] = process.argv.slice(2);
try {
  if (cmd === 'status') {
    await cmdStatus();
  } else if (cmd === 'email') {
    const targets = arg === 'all' ? EMAIL_DOMAINS : [arg];
    for (const d of targets) await cmdEmail(d);
    console.log('\nRun `node scripts/setup_workspace_domain.mjs verify all` in ~5–15 min to confirm.');
  } else if (cmd === 'verify') {
    const targets = arg === 'all' ? EMAIL_DOMAINS : [arg];
    console.log('=== verification ===');
    for (const d of targets) await cmdVerify(d);
  } else if (cmd === 'join') {
    if (!arg || !arg2) { console.error('usage: join <host> <orgId>'); process.exit(1); }
    await cmdJoin(arg, Number(arg2));
  } else {
    console.log('commands: status | email <domain|all> | verify <domain|all> | join <host> <orgId>');
  }
} catch (e) {
  console.error('ERROR:', e.message);
  process.exit(1);
}
