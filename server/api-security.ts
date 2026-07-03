// ── External API security layer ──────────────────────────────────────────────
// Everything that protects the keyed /api/v1 surface beyond scope checks:
//
//   · security headers on every /api/v1 response
//   · per-IP brute-force limiter for invalid/expired keys (+ DB failure log)
//   · per-KEY rate limit counted from api_key_request_logs — exact across
//     machines and deploy restarts (in-memory fast-path avoids hammering the
//     DB once a key is already over the limit)
//   · throttled security-alert emails (brute force, rate limit, scope probing)
//   · nightly retention pruning of the audit tables
//
// Used by requireApiKey/requireScope in routes.ts; jobs started from index.ts.

import type { Request, Response, NextFunction } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { apiAuthFailures } from "@shared/schema";
import { sendEmail } from "./email";

// ── Tunables ─────────────────────────────────────────────────────────────────
export const API_KEY_RATE_LIMIT_PER_MIN = 240;
const BRUTE_FORCE_MAX_FAILURES = 20;              // invalid keys per IP…
const BRUTE_FORCE_WINDOW_MS = 10 * 60_000;        // …per 10 minutes
const FAILURE_LOG_CAP_PER_IP_PER_HOUR = 60;       // don't let attackers flood the log
const SCOPE_PROBE_403_THRESHOLD = 15;             // 403s per key per hour → alert
const ALERT_THROTTLE_MS = 6 * 60 * 60_000;        // one alert per topic per 6h
const REQUEST_LOG_RETENTION_DAYS = 90;
const AUTH_FAILURE_RETENTION_DAYS = 30;
const SECURITY_ALERT_TO = process.env.API_SECURITY_ALERT_TO || "daniel@cufc.co.nz";
const SECURITY_ALERT_FROM = "ClubOS Security <noreply@cufc.co.nz>";

export function clientIp(req: Request): string {
  return (
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

// ── Security headers (JSON API: never cache, never sniff, always TLS) ────────
export function apiSecurityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  next();
}

// ── Throttled security alerts ────────────────────────────────────────────────
const lastAlertAt = new Map<string, number>();

export function securityAlert(topicKey: string, subject: string, detailHtml: string) {
  const now = Date.now();
  const last = lastAlertAt.get(topicKey) || 0;
  if (now - last < ALERT_THROTTLE_MS) return;
  lastAlertAt.set(topicKey, now);
  sendEmail({
    from: SECURITY_ALERT_FROM,
    to: SECURITY_ALERT_TO,
    subject: `[ClubOS Security] ${subject}`,
    html: `
      <div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:560px">
        <h2 style="color:#b91c1c;margin:0 0 8px">${subject}</h2>
        ${detailHtml}
        <p style="color:#666;font-size:13px">Check ClubOS &rarr; Settings &rarr; API Keys for per-key activity.
        Alerts on this topic are muted for 6 hours.</p>
      </div>`,
  }).catch((e) => console.error("[api-security] alert email failed:", e?.message || e));
}

// ── Brute-force protection (invalid/expired keys, per IP) ────────────────────
// The failure LOG is the authoritative cross-machine counter (the app runs on
// multiple Fly machines — per-machine memory alone would let an attacker split
// attempts across machines and never trip the threshold). Memory holds the
// local fast-path counts and the confirmed-block cache.
const ipFailures = new Map<string, number[]>();
const ipFailureLogCount = new Map<string, { hourStart: number; count: number }>();
const blockedIps = new Map<string, number>(); // ip → blocked-until (epoch ms)

export function isIpBlocked(ip: string): boolean {
  const now = Date.now();
  const until = blockedIps.get(ip);
  if (until) {
    if (now < until) return true;
    blockedIps.delete(ip);
  }
  const hits = (ipFailures.get(ip) || []).filter((t) => now - t < BRUTE_FORCE_WINDOW_MS);
  ipFailures.set(ip, hits);
  return hits.length >= BRUTE_FORCE_MAX_FAILURES;
}

export function recordAuthFailure(req: Request, presentedKey: string) {
  const ip = clientIp(req);
  const now = Date.now();
  const hits = (ipFailures.get(ip) || []).filter((t) => now - t < BRUTE_FORCE_WINDOW_MS);
  hits.push(now);
  ipFailures.set(ip, hits);

  // Log to the DB, capped per IP per hour so an attacker can't balloon the table.
  const cap = ipFailureLogCount.get(ip);
  const hourStart = Math.floor(now / 3_600_000);
  const count = cap && cap.hourStart === hourStart ? cap.count : 0;
  if (count >= FAILURE_LOG_CAP_PER_IP_PER_HOUR) return;
  ipFailureLogCount.set(ip, { hourStart, count: count + 1 });

  // Insert, then check the CROSS-MACHINE failure count for this IP. If it has
  // crossed the threshold, cache the block locally and alert. Each machine
  // learns of the block on the next failure it handles, so a distributed
  // attacker gets at most a couple of extra 401s before every machine denies.
  db.insert(apiAuthFailures).values({
    ip,
    path: (req.originalUrl || req.path || "").slice(0, 500),
    presentedPrefix: presentedKey.slice(0, 12),
  })
    .then(() => db.execute(sql`
      SELECT COUNT(*)::int AS n FROM api_auth_failures
      WHERE ip = ${ip} AND created_at > now() - interval '10 minutes'
    `))
    .then(({ rows }) => {
      const n = Number((rows[0] as any)?.n || 0);
      if (n >= BRUTE_FORCE_MAX_FAILURES) {
        blockedIps.set(ip, Date.now() + BRUTE_FORCE_WINDOW_MS);
        securityAlert(
          `bruteforce:${ip}`,
          `Possible API key brute-force from ${ip}`,
          `<p><b>${n} invalid API keys</b> were presented from IP <b>${ip}</b>
           within 10 minutes. That IP is now blocked from the external API for the
           rest of the window.</p>`
        );
      }
    })
    .catch(() => {});
}

// ── Per-key rate limiting (DB-authoritative, memory fast-path) ───────────────
// The audit log doubles as a distributed counter: COUNT of a key's rows in the
// last 60s is exact across every machine and survives deploys. The in-memory
// map only short-circuits the DB query for keys already over the limit.
const keyHitMemory = new Map<number, number[]>();

export async function keyRateLimitExceeded(keyId: number, keyName: string): Promise<boolean> {
  const now = Date.now();
  const mem = (keyHitMemory.get(keyId) || []).filter((t) => now - t < 60_000);
  mem.push(now);
  keyHitMemory.set(keyId, mem);
  if (mem.length > API_KEY_RATE_LIMIT_PER_MIN) return true; // this machine alone is over

  const { rows } = await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM api_key_request_logs
    WHERE api_key_id = ${keyId} AND created_at > now() - interval '60 seconds'
  `);
  const n = Number((rows[0] as any)?.n || 0);
  const exceeded = n >= API_KEY_RATE_LIMIT_PER_MIN;
  if (exceeded) {
    securityAlert(
      `ratelimit:${keyId}`,
      `API key "${keyName}" hit its rate limit`,
      `<p>The key <b>${keyName}</b> exceeded <b>${API_KEY_RATE_LIMIT_PER_MIN} requests/minute</b>.
       If this isn't an expected burst from a collector, the key may be misused — consider rotating it.</p>`
    );
  }
  return exceeded;
}

// ── Scope-probe detection (repeated 403s on one key) ─────────────────────────
const keyForbiddenHits = new Map<number, number[]>();

export function noteScopeDenial(keyId: number, keyName: string, scope: string) {
  const now = Date.now();
  const hits = (keyForbiddenHits.get(keyId) || []).filter((t) => now - t < 3_600_000);
  hits.push(now);
  keyForbiddenHits.set(keyId, hits);
  if (hits.length === SCOPE_PROBE_403_THRESHOLD) {
    securityAlert(
      `scopeprobe:${keyId}`,
      `API key "${keyName}" keeps requesting data outside its scopes`,
      `<p>The key <b>${keyName}</b> was denied <b>${SCOPE_PROBE_403_THRESHOLD} times</b> in the last hour
       (latest: missing <code>${scope}</code>). A correctly configured collector never does this —
       someone may be probing what the key can reach.</p>`
    );
  }
}

// ── Retention pruning (nightly) ──────────────────────────────────────────────
async function pruneAuditTables() {
  try {
    const r1 = await db.execute(sql`
      DELETE FROM api_key_request_logs
      WHERE created_at < now() - make_interval(days => ${REQUEST_LOG_RETENTION_DAYS})
    `);
    const r2 = await db.execute(sql`
      DELETE FROM api_auth_failures
      WHERE created_at < now() - make_interval(days => ${AUTH_FAILURE_RETENTION_DAYS})
    `);
    const n1 = (r1 as any).rowCount ?? 0;
    const n2 = (r2 as any).rowCount ?? 0;
    if (n1 || n2) console.log(`[api-security] pruned ${n1} request logs, ${n2} auth failures`);
  } catch (e: any) {
    console.error("[api-security] prune error:", e?.message || e);
  }
}

export function startApiSecurityJobs() {
  setTimeout(pruneAuditTables, 60_000);            // once shortly after boot
  setInterval(pruneAuditTables, 24 * 60 * 60_000); // then daily
}
