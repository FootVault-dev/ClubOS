// ─────────────────────────────────────────────────────────────────────────────
// UNITED PRINTS — CUSTOMER ACCOUNTS (join.unitedprints.co.nz/account)
//
//   POST /api/public/unitedprints/account/signup   — email + password → account
//   POST /api/public/unitedprints/account/login    — email + password → session
//   POST /api/public/unitedprints/account/forgot   — email → a 6-digit reset code
//   POST /api/public/unitedprints/account/reset    — code + new password → session
//   POST /api/public/unitedprints/account/logout
//   GET  /api/public/unitedprints/account/me       — profile + their orders
//   PATCH /api/public/unitedprints/account/profile
//
// ── Why this is same-origin, and why that matters ───────────────────────────
//
// The portal is served BY ClubOS at join.unitedprints.co.nz (Fly cert issued,
// host already routed in client/src/App.tsx). So the session cookie is
// first-party: `__Host-` prefixed, httpOnly, Secure, SameSite=Lax.
//
// 🔴 It is deliberately NOT reachable cross-origin from unitedprints.co.nz.
// The existing print CORS (server/print-quote-routes.ts) reflects ANY
// *.vercel.app origin, and its own comment says that is safe precisely because
// those endpoints carry no credentials. Adding Allow-Credentials to that
// reflection would let any vercel.app page act as a signed-in customer. So the
// marketing site LINKS here rather than calling across — the login button is an
// anchor, not a fetch. That also means no SameSite=None cookie and no CSRF
// surface from another origin at all.
//
// ── The three rules ─────────────────────────────────────────────────────────
//
// 1. THE SESSION ANCHORS ON A VERIFIED EMAIL, and the order list is re-resolved
//    from print_orders.customer_email on every request. No customer_id was
//    added to print_orders: every existing order would carry NULL, so the
//    customers with the longest history would see the emptiest portal.
//
// 2. THIS IS A CUSTOMER CREDENTIAL AND NEVER A STAFF SESSION. Its own cookie,
//    its own table, its own routes. It grants nothing but these endpoints —
//    the CIC referee doctrine, applied again.
//
// 3. THE DISCOUNT IS READ FROM THE ROW ON EVERY REQUEST, never carried in the
//    token. Dima withdrawing a trade rate has to bite on the next page load,
//    not whenever a 30-day cookie happens to expire.
// ─────────────────────────────────────────────────────────────────────────────
import type { Express, Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { sql } from "drizzle-orm";
import { db } from "./db";
import { sendPrintAccountLoginCode } from "./print-email";
import { requireAuth, requireTab } from "./auth";
import {
  PRINT_ACCOUNT_COOKIE,
  PRINT_ACCOUNT_SESSION_TTL_MS,
  PRINT_ACCOUNT_CODE_TTL_MS,
  PRINT_ACCOUNT_CODE_MAX_ATTEMPTS,
  normalizePrintEmail,
  looksLikeEmail,
  passwordProblem,
  SIGNIN_FAILED,
  accountDiscountPct,
  customerStatusLabel,
  countsTowardSpend,
  type PrintAccountMe,
  type PrintAccountOrder,
} from "@shared/print-account";

const UP_ORG_ID = 8; // United Prints

const s = (v: any, max = 300): string | null => {
  const out = String(v ?? "").trim().slice(0, max);
  return out === "" ? null : out;
};

const ipOf = (req: Request) =>
  s(String(req.headers["x-forwarded-for"] ?? "").split(",")[0] || req.socket.remoteAddress, 60);

const uaOf = (req: Request) => s(req.headers["user-agent"], 300);

/** 🔴 A date column must never be round-tripped through a JS Date — that reads
 *  a day early in NZ. pg gives DATE back as a local-midnight Date, so format
 *  the parts rather than calling toISOString(). */
function isoDate(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === "string") return v.slice(0, 10);
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, "0");
    const d = String(v.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return null;
}

// ── Audit ────────────────────────────────────────────────────────────────────
// Every attempt, success or failure. Best-effort: an audit write that throws
// must never be the reason a customer cannot sign in.
async function audit(params: {
  email?: string | null;
  customerId?: number | null;
  event: string;
  detail?: string | null;
  req: Request;
}) {
  try {
    await db.execute(sql`
      INSERT INTO print_customer_auth_events (email, customer_id, event, detail, ip, user_agent)
      VALUES (${params.email ?? null}, ${params.customerId ?? null}, ${params.event},
              ${params.detail ?? null}, ${ipOf(params.req)}, ${uaOf(params.req)})`);
  } catch (e) {
    console.error("[up-account] audit", e);
  }
}

// ── Passwords ────────────────────────────────────────────────────────────────
// scrypt, `s1$salt$hex`. The SAME scheme as natural-footballers-web,
// atarangi-lodge and conscious-agency, so the workspace has one password format
// rather than four half-remembered ones (reference/app-baseline-standard.md §1).
const SCRYPT = { N: 16384, r: 8, p: 1 } as const;

function hashPrintPassword(plain: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(plain, salt, 64, SCRYPT).toString("hex");
  return `s1$${salt}$${hash}`;
}

/**
 * 🔴 Returns false for a NULL or malformed stored hash, never true.
 *
 * password_hash is nullable because accounts created during the passwordless
 * window have none. "No password set" must fail closed — a verifier that
 * treated a blank column as a match would let anyone into every legacy account
 * by typing anything.
 */
function verifyPrintPassword(candidate: string, stored: string | null): boolean {
  const [scheme, salt, hashHex] = String(stored ?? "").split("$");
  if (scheme !== "s1" || !salt || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  if (expected.length === 0) return false;
  const got = crypto.scryptSync(candidate, salt, expected.length, SCRYPT);
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

// ── Sessions ─────────────────────────────────────────────────────────────────
// 🔴 Only the HASH is stored. This table is a list of live sessions, not a list
// of working credentials — a read of it cannot sign anyone in.

function newSessionToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(32).toString("base64url");
  return { token, hash: crypto.createHash("sha256").update(token).digest("hex") };
}

const hashToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

function setSessionCookie(res: Response, token: string) {
  res.cookie?.(PRINT_ACCOUNT_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: PRINT_ACCOUNT_SESSION_TTL_MS,
  });
  // 🔴 ClubOS has no cookie-parser and `res.cookie` is only present because
  // Express provides it — but `req.cookies` is silently undefined (this cost a
  // fast-follow deploy on Staff Videos). So the header is also set by hand
  // where res.cookie is unavailable, and reads always parse the raw header.
  if (typeof (res as any).cookie !== "function") {
    res.setHeader(
      "Set-Cookie",
      `${PRINT_ACCOUNT_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(
        PRINT_ACCOUNT_SESSION_TTL_MS / 1000,
      )}`,
    );
  }
}

function clearSessionCookie(res: Response) {
  res.setHeader("Set-Cookie", `${PRINT_ACCOUNT_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}

/** 🔴 Read cookies from the raw header. `req.cookies` is undefined in ClubOS. */
function cookieFromRequest(req: Request, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

export type PrintCustomer = {
  id: number;
  email: string;
  name: string | null;
  phone: string | null;
  company: string | null;
  tier: string;
  discountPct: number;
  disabledAt: Date | null;
  createdAt: Date | null;
};

/**
 * Resolve the signed-in customer, or null.
 *
 * 🔴 Joins to print_customers on EVERY call rather than trusting anything in
 * the cookie, so a disabled account and a withdrawn discount both take effect
 * on the next request. The session is also checked for revocation and expiry
 * here — that is the whole reason sessions are a table and not a signed token.
 */
export async function currentPrintCustomer(req: Request): Promise<PrintCustomer | null> {
  const token = cookieFromRequest(req, PRINT_ACCOUNT_COOKIE);
  if (!token) return null;
  try {
    const r = await db.execute(sql`
      SELECT c.id, c.email, c.name, c.phone, c.company, c.tier, c.discount_pct,
             c.disabled_at, c.created_at
      FROM print_customer_sessions s
      JOIN print_customers c ON c.id = s.customer_id
      WHERE s.token_hash = ${hashToken(token)}
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND c.disabled_at IS NULL
      LIMIT 1`);
    const row = (r.rows as any[])[0];
    if (!row) return null;
    return {
      id: Number(row.id),
      email: String(row.email),
      name: row.name ?? null,
      phone: row.phone ?? null,
      company: row.company ?? null,
      tier: String(row.tier ?? "standard"),
      discountPct: Number(row.discount_pct ?? 0),
      disabledAt: row.disabled_at ?? null,
      createdAt: row.created_at ?? null,
    };
  } catch (e) {
    console.error("[up-account] currentPrintCustomer", e);
    return null;
  }
}

/** Express guard for the signed-in-only endpoints. */
async function requirePrintCustomer(req: Request, res: Response, next: NextFunction) {
  const customer = await currentPrintCustomer(req);
  if (!customer) return res.status(401).json({ message: "Please sign in." });
  (req as any).printCustomer = customer;
  next();
}

// ── Their orders ─────────────────────────────────────────────────────────────

/**
 * Every order placed under this verified address.
 *
 * Matched case-insensitively because print_orders.customer_email was typed by
 * whoever took the job — by phone, at the counter, off an email — and
 * "Dima@Example.com" and "dima@example.com" are one customer.
 *
 * Scoped to the United Prints org as well as the email: an address that also
 * appears on another org's record must not surface here.
 */
async function ordersForEmail(email: string): Promise<PrintAccountOrder[]> {
  const r = await db.execute(sql`
    SELECT o.id, o.order_number, o.title, o.status, o.total_cents, o.paid_cents,
           o.created_at, o.due_date, o.pickup_ready_date,
           COALESCE(
             json_agg(
               json_build_object(
                 'description', COALESCE(i.description, i.material_name),
                 'quantity',    i.quantity,
                 'widthMm',     i.width_mm,
                 'heightMm',    i.height_mm
               ) ORDER BY i.id
             ) FILTER (WHERE i.id IS NOT NULL), '[]'
           ) AS lines
    FROM print_orders o
    LEFT JOIN print_order_items i ON i.order_id = o.id
    WHERE lower(o.customer_email) = ${email}
      AND (o.organization_id = ${UP_ORG_ID} OR o.organization_id IS NULL)
    GROUP BY o.id
    ORDER BY o.created_at DESC
    LIMIT 200`);

  return (r.rows as any[]).map((row) => {
    const totalCents = Number(row.total_cents ?? 0);
    const paidCents = Number(row.paid_cents ?? 0);
    return {
      id: Number(row.id),
      orderNumber: row.order_number ?? null,
      title: String(row.title ?? "Print job"),
      status: String(row.status ?? ""),
      statusLabel: customerStatusLabel(row.status),
      placedOn: isoDate(row.created_at),
      dueOn: isoDate(row.due_date),
      readyOn: isoDate(row.pickup_ready_date),
      totalCents,
      paidCents,
      // 🔴 DERIVED, never stored. And never negative: an overpayment is a
      // conversation with the office, not a credit the portal invents.
      outstandingCents: Math.max(0, totalCents - paidCents),
      lines: (Array.isArray(row.lines) ? row.lines : []).map((l: any) => ({
        description: String(l.description ?? "Item"),
        quantity: Number(l.quantity ?? 1),
        sizeLabel:
          l.widthMm && l.heightMm ? `${Number(l.widthMm)} × ${Number(l.heightMm)} mm` : null,
      })),
    };
  });
}

async function buildMe(customer: PrintCustomer): Promise<PrintAccountMe> {
  const orders = await ordersForEmail(customer.email);
  return {
    email: customer.email,
    name: customer.name,
    phone: customer.phone,
    company: customer.company,
    tier: customer.tier,
    discountPct: accountDiscountPct(customer),
    memberSince: isoDate(customer.createdAt),
    orders,
    orderCount: orders.length,
    lifetimeSpentCents: orders
      .filter((o) => countsTowardSpend(o.status))
      .reduce((sum, o) => sum + o.paidCents, 0),
  };
}

// ─────────────────────────────────────────────────────────────────────────────

/** Issue a session, set the cookie, and return the payload. ONE path, used by
 *  sign-up, sign-in and password reset alike, so the three cannot drift on
 *  cookie flags or expiry. */
async function startSession(req: Request, res: Response, customerId: number): Promise<PrintAccountMe> {
  const { token, hash } = newSessionToken();
  await db.execute(sql`
    INSERT INTO print_customer_sessions (customer_id, token_hash, expires_at, ip, user_agent)
    VALUES (${customerId}, ${hash}, ${new Date(Date.now() + PRINT_ACCOUNT_SESSION_TTL_MS)},
            ${ipOf(req)}, ${uaOf(req)})`);
  await db.execute(sql`UPDATE print_customers SET last_login_at = now() WHERE id = ${customerId}`);
  setSessionCookie(res, token);

  const r = await db.execute(sql`
    SELECT id, email, name, phone, company, tier, discount_pct, disabled_at, created_at
    FROM print_customers WHERE id = ${customerId}`);
  const row = (r.rows as any[])[0];
  return buildMe({
    id: customerId,
    email: String(row.email),
    name: row.name ?? null,
    phone: row.phone ?? null,
    company: row.company ?? null,
    tier: String(row.tier ?? "standard"),
    discountPct: Number(row.discount_pct ?? 0),
    disabledAt: row.disabled_at ?? null,
    createdAt: row.created_at ?? null,
  });
}

/** Shared rate-limit gate for anything that takes an email + a guessable secret. */
async function tooManyAttempts(email: string, ip: string | null): Promise<boolean> {
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const r = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE lower(email) = ${email}) AS by_email,
      COUNT(*) FILTER (WHERE ip IS NOT NULL AND ip = ${ip}) AS by_ip
    FROM print_customer_auth_events
    WHERE created_at > ${since} AND event IN ('signin_failed','code_sent','rate_limited')`);
  const c = (r.rows as any[])[0] ?? {};
  // Per-email is tight (someone guessing one business's password); per-IP is
  // loose, because a whole office shares one address and a per-IP limit would
  // otherwise lock out a customer's colleagues.
  return Number(c.by_email ?? 0) >= 10 || Number(c.by_ip ?? 0) >= 50;
}

export function registerPrintAccountRoutes(app: Express) {
  const BASE = "/api/public/unitedprints/account";

  // ── Create an account ─────────────────────────────────────────────────────
  app.post(`${BASE}/signup`, async (req, res) => {
    try {
      const email = normalizePrintEmail(req.body?.email);
      const password = String(req.body?.password ?? "");
      const name = s(req.body?.name, 120);
      const company = s(req.body?.company, 160);
      const phone = s(req.body?.phone, 40);

      if (!looksLikeEmail(email)) return res.status(400).json({ message: "That doesn't look like an email address." });
      const pwProblem = passwordProblem(password);
      if (pwProblem) return res.status(400).json({ message: pwProblem });

      if (await tooManyAttempts(email, ipOf(req))) {
        await audit({ email, event: "rate_limited", req });
        return res.status(429).json({ message: "Too many attempts. Please try again in an hour." });
      }

      const existing = await db.execute(sql`
        SELECT id, password_hash, disabled_at FROM print_customers WHERE lower(email) = ${email} LIMIT 1`);
      const found = (existing.rows as any[])[0];

      if (found?.password_hash) {
        // 🔴 An address that already has a password is NOT told so in a way that
        // confirms it exists to a stranger — the copy points at signing in and
        // at the reset, both of which a real owner can act on and a stranger
        // learns nothing from beyond "this form is for new accounts".
        await audit({ email, customerId: Number(found.id), event: "signup_existing", req });
        return res.status(409).json({
          message: "There's already an account for that email. Sign in instead, or use 'Forgot password'.",
        });
      }

      const hash = hashPrintPassword(password);
      if (found) {
        // A legacy passwordless account, or one part-created. Claim it by
        // setting the password — same address, same orders, no duplicate row.
        if (found.disabled_at) return res.status(403).json({ message: "This account isn't active. Please contact the office." });
        await db.execute(sql`
          UPDATE print_customers
          SET password_hash = ${hash}, password_set_at = now(),
              name = COALESCE(${name}, name), company = COALESCE(${company}, company),
              phone = COALESCE(${phone}, phone)
          WHERE id = ${found.id}`);
      } else {
        await db.execute(sql`
          INSERT INTO print_customers (email, name, company, phone, password_hash, password_set_at)
          VALUES (${email}, ${name}, ${company}, ${phone}, ${hash}, now())
          ON CONFLICT (lower(email)) DO NOTHING`);
      }

      const row = await db.execute(sql`SELECT id FROM print_customers WHERE lower(email) = ${email} LIMIT 1`);
      const id = Number((row.rows as any[])[0]?.id);
      if (!Number.isFinite(id)) return res.status(500).json({ message: "Something went wrong. Please try again." });

      await audit({ email, customerId: id, event: "signup_ok", req });
      res.json({ ok: true, me: await startSession(req, res, id) });
    } catch (e: any) {
      console.error("[up-account] signup", e);
      res.status(500).json({ message: "Something went wrong. Please try again." });
    }
  });

  // ── Sign in ───────────────────────────────────────────────────────────────
  app.post(`${BASE}/login`, async (req, res) => {
    try {
      const email = normalizePrintEmail(req.body?.email);
      const password = String(req.body?.password ?? "");
      if (!looksLikeEmail(email) || !password) {
        return res.status(400).json({ message: SIGNIN_FAILED });
      }
      if (await tooManyAttempts(email, ipOf(req))) {
        await audit({ email, event: "rate_limited", req });
        return res.status(429).json({ message: "Too many attempts. Please try again in an hour." });
      }

      const r = await db.execute(sql`
        SELECT id, password_hash, disabled_at FROM print_customers WHERE lower(email) = ${email} LIMIT 1`);
      const row = (r.rows as any[])[0];

      // 🔴 ONE answer for every failure — unknown address, wrong password, no
      // password set, closed account. Anything more specific makes this form an
      // oracle for which businesses bank with the print shop.
      const okPassword = !!row && !row.disabled_at && verifyPrintPassword(password, row.password_hash ?? null);
      if (!okPassword) {
        await audit({ email, customerId: row ? Number(row.id) : null, event: "signin_failed", req });
        return res.status(401).json({ message: SIGNIN_FAILED });
      }

      const id = Number(row.id);
      await audit({ email, customerId: id, event: "signin_ok", req });
      res.json({ ok: true, me: await startSession(req, res, id) });
    } catch (e: any) {
      console.error("[up-account] login", e);
      res.status(500).json({ message: "Something went wrong. Please try again." });
    }
  });

  // ── Forgot password ───────────────────────────────────────────────────────
  // The emailed code lives on, doing the job it is genuinely best at: proving
  // control of an inbox. It is no longer how anyone signs in.
  app.post(`${BASE}/forgot`, async (req, res) => {
    const generic = { ok: true, message: "If there's an account for that email, we've sent a reset code." };
    try {
      const email = normalizePrintEmail(req.body?.email);
      if (!looksLikeEmail(email)) return res.status(400).json({ message: "That doesn't look like an email address." });
      const ip = ipOf(req);
      if (await tooManyAttempts(email, ip)) {
        await audit({ email, event: "rate_limited", req });
        return res.status(429).json({ message: "Too many attempts. Please try again in an hour." });
      }

      const found = await db.execute(sql`
        SELECT id, name FROM print_customers WHERE lower(email) = ${email} AND disabled_at IS NULL LIMIT 1`);
      const row = (found.rows as any[])[0];
      // 🔴 No account → the SAME response, and no email. The reply must not
      // differ by a byte between "we sent one" and "there is nobody here".
      if (!row) return res.json(generic);

      const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
      const codeHash = crypto.createHash("sha256").update(`${code}:${email}`).digest("hex");
      await db.execute(sql`
        INSERT INTO print_customer_codes (email, code_hash, expires_at, request_ip, purpose)
        VALUES (${email}, ${codeHash}, ${new Date(Date.now() + PRINT_ACCOUNT_CODE_TTL_MS)}, ${ip}, 'reset')`);

      // AWAITED — an un-awaited send after the response has gone may never run.
      await sendPrintAccountLoginCode({
        to: email,
        firstName: (String(row.name ?? "").split(" ")[0] || null),
        code,
        minutes: Math.round(PRINT_ACCOUNT_CODE_TTL_MS / 60000),
      });
      await audit({ email, customerId: Number(row.id), event: "code_sent", req });

      if (process.env.PRINT_ACCOUNT_ECHO_CODE === "1" && process.env.NODE_ENV !== "production") {
        return res.json({ ...generic, devCode: code });
      }
      res.json(generic);
    } catch (e: any) {
      console.error("[up-account] forgot", e);
      res.json(generic);
    }
  });

  // ── Set a new password with the code ──────────────────────────────────────
  app.post(`${BASE}/reset`, async (req, res) => {
    try {
      const email = normalizePrintEmail(req.body?.email);
      const code = String(req.body?.code ?? "").trim();
      const password = String(req.body?.password ?? "");
      if (!looksLikeEmail(email) || !/^\d{6}$/.test(code)) {
        return res.status(400).json({ message: "Enter the 6-digit code from your email." });
      }
      const pwProblem = passwordProblem(password);
      if (pwProblem) return res.status(400).json({ message: pwProblem });

      const codeHash = crypto.createHash("sha256").update(`${code}:${email}`).digest("hex");
      const live = await db.execute(sql`
        SELECT id, code_hash FROM print_customer_codes
        WHERE lower(email) = ${email} AND purpose = 'reset' AND consumed_at IS NULL
          AND expires_at > now() AND attempts < ${PRINT_ACCOUNT_CODE_MAX_ATTEMPTS}
        ORDER BY created_at DESC`);
      const rows = live.rows as any[];
      if (rows.length === 0) {
        await audit({ email, event: "reset_expired", req });
        return res.status(400).json({ message: "That code has expired. Please request a new one." });
      }

      const given = Buffer.from(codeHash, "hex");
      const match = rows.find((r) => {
        const stored = Buffer.from(String(r.code_hash), "hex");
        return given.length === stored.length && crypto.timingSafeEqual(given, stored);
      });
      if (!match) {
        await db.execute(sql`
          UPDATE print_customer_codes SET attempts = attempts + 1
          WHERE lower(email) = ${email} AND purpose = 'reset' AND consumed_at IS NULL AND expires_at > now()`);
        await audit({ email, event: "reset_bad_code", req });
        return res.status(400).json({ message: "That code isn't right. Check the email and try again." });
      }

      const found = await db.execute(sql`
        SELECT id FROM print_customers WHERE lower(email) = ${email} AND disabled_at IS NULL LIMIT 1`);
      const row = (found.rows as any[])[0];
      if (!row) return res.status(400).json({ message: "That code has expired. Please request a new one." });
      const id = Number(row.id);

      await db.execute(sql`UPDATE print_customer_codes SET consumed_at = now() WHERE id = ${match.id}`);
      await db.execute(sql`
        UPDATE print_customers
        SET password_hash = ${hashPrintPassword(password)}, password_set_at = now(),
            email_verified_at = COALESCE(email_verified_at, now())
        WHERE id = ${id}`);

      // 🔴 Changing a password ends every OTHER session. If somebody else was
      // signed in — which is the usual reason a person resets — the reset has
      // to actually push them out, not just add a second key to the door.
      await db.execute(sql`
        UPDATE print_customer_sessions SET revoked_at = now()
        WHERE customer_id = ${id} AND revoked_at IS NULL`);

      await audit({ email, customerId: id, event: "reset_ok", req });
      res.json({ ok: true, me: await startSession(req, res, id) });
    } catch (e: any) {
      console.error("[up-account] reset", e);
      res.status(500).json({ message: "Something went wrong. Please try again." });
    }
  });

  // ── The passwordless sign-in that used to live here is GONE ───────────────
  // Daniel, 2026-09-03: "make this email password standard sign up and login."
  //
  // 🔴 Deleted rather than left mounted. An emailed code that signs somebody
  // straight in is a SECOND way through the door that skips the password
  // entirely — so the account would only ever be as strong as the weaker of the
  // two, and revoking a password would not actually close it. The same
  // mechanism now backs /forgot + /reset, where proving control of the inbox
  // earns you a password change rather than a session.

  // ── Logout ────────────────────────────────────────────────────────────────
  // Revokes the row, so it is a real sign-out and not just a discarded cookie.
  app.post(`${BASE}/logout`, async (req, res) => {
    try {
      const token = cookieFromRequest(req, PRINT_ACCOUNT_COOKIE);
      if (token) {
        await db.execute(sql`
          UPDATE print_customer_sessions SET revoked_at = now()
          WHERE token_hash = ${hashToken(token)} AND revoked_at IS NULL`);
        await audit({ event: "logout", req });
      }
    } catch (e) {
      console.error("[up-account] logout", e);
    }
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  // ── Me ────────────────────────────────────────────────────────────────────
  app.get(`${BASE}/me`, requirePrintCustomer, async (req, res) => {
    try {
      res.json({ me: await buildMe((req as any).printCustomer as PrintCustomer) });
    } catch (e: any) {
      console.error("[up-account] me", e);
      res.status(500).json({ message: "Couldn't load your account." });
    }
  });

  // ── Profile ───────────────────────────────────────────────────────────────
  // 🔴 The customer may edit their name, phone and company — and nothing else.
  // tier, discount_pct and the approver are absent from this handler on
  // purpose: they are the shop's decisions about that customer, and a PATCH
  // body must never be able to reach them.
  app.patch(`${BASE}/profile`, requirePrintCustomer, async (req, res) => {
    try {
      const customer = (req as any).printCustomer as PrintCustomer;
      const name = s(req.body?.name, 120);
      const phone = s(req.body?.phone, 40);
      const company = s(req.body?.company, 160);
      await db.execute(sql`
        UPDATE print_customers
        SET name = ${name}, phone = ${phone}, company = ${company}
        WHERE id = ${customer.id}`);
      const fresh = await db.execute(sql`
        SELECT id, email, name, phone, company, tier, discount_pct, disabled_at, created_at
        FROM print_customers WHERE id = ${customer.id}`);
      const r = (fresh.rows as any[])[0];
      res.json({
        ok: true,
        me: await buildMe({
          id: customer.id,
          email: String(r.email),
          name: r.name ?? null,
          phone: r.phone ?? null,
          company: r.company ?? null,
          tier: String(r.tier ?? "standard"),
          discountPct: Number(r.discount_pct ?? 0),
          disabledAt: r.disabled_at ?? null,
          createdAt: r.created_at ?? null,
        }),
      });
    } catch (e: any) {
      console.error("[up-account] profile", e);
      res.status(500).json({ message: "Couldn't save that." });
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// DIMA'S SIDE — who has an account, and who gets trade pricing.
//
// Gated on the `crm` tab, which Dima already has. Deliberately NOT a new tab:
// a tab has to be registered in shared/tabs.ts, the workspace's route Switch in
// App.tsx AND app-sidebar.tsx's own nav array, and missing the third of those
// once left a staff member with a completely empty sidebar.
// ─────────────────────────────────────────────────────────────────────────────
export function registerPrintAccountAdminRoutes(app: Express) {
  const tab = requireTab("crm");

  app.get("/api/admin/print-customers", requireAuth, tab, async (_req, res) => {
    try {
      const r = await db.execute(sql`
        SELECT c.id, c.email, c.name, c.phone, c.company, c.tier, c.discount_pct,
               c.approved_at, c.approval_note, c.disabled_at, c.last_login_at, c.created_at,
               u.first_name AS approver_first, u.last_name AS approver_last,
               (SELECT COUNT(*) FROM print_orders o
                 WHERE lower(o.customer_email) = lower(c.email)) AS order_count,
               (SELECT COALESCE(SUM(o.paid_cents), 0) FROM print_orders o
                 WHERE lower(o.customer_email) = lower(c.email)
                   AND o.status NOT IN ('cancelled','draft','inquiry')) AS paid_cents
        FROM print_customers c
        LEFT JOIN users u ON u.id = c.approved_by_user_id
        ORDER BY c.created_at DESC
        LIMIT 500`);
      res.json({
        customers: (r.rows as any[]).map((row) => ({
          id: Number(row.id),
          email: row.email,
          name: row.name,
          phone: row.phone,
          company: row.company,
          tier: row.tier,
          discountPct: Number(row.discount_pct ?? 0),
          approvedAt: row.approved_at,
          approvalNote: row.approval_note,
          disabledAt: row.disabled_at,
          lastLoginAt: row.last_login_at,
          createdAt: row.created_at,
          // Null reads as "we don't know", never as "nobody".
          approvedBy: row.approver_first
            ? [row.approver_first, row.approver_last].filter(Boolean).join(" ")
            : null,
          orderCount: Number(row.order_count ?? 0),
          paidCents: Number(row.paid_cents ?? 0),
        })),
      });
    } catch (e: any) {
      console.error("[up-account] admin list", e);
      res.status(500).json({ message: "Couldn't load customer accounts." });
    }
  });

  // 🔴 The approver is taken from the SESSION, never the body. "Who agreed to
  // this discount" is exactly the kind of fact a request body must not be able
  // to assert — the same reason served_by_user_id is set server-side on an
  // office payment.
  app.patch("/api/admin/print-customers/:id", requireAuth, tab, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ message: "Bad id." });

      // req.session.userId is how this codebase names the signed-in staff
      // member everywhere else (see routes.ts); requireAuth guarantees it.
      const actorId = (req as any).session?.userId ?? (req as any).user?.id;
      if (!actorId) return res.status(401).json({ message: "Not signed in." });

      const current = await db.execute(sql`
        SELECT discount_pct, approved_by_user_id, approved_at FROM print_customers WHERE id = ${id}`);
      const row = (current.rows as any[])[0];
      if (!row) return res.status(404).json({ message: "No such account." });

      const hasTier = Object.prototype.hasOwnProperty.call(req.body ?? {}, "tier");
      const hasPct = Object.prototype.hasOwnProperty.call(req.body ?? {}, "discountPct");
      const hasDisabled = Object.prototype.hasOwnProperty.call(req.body ?? {}, "disabled");

      const tier = hasTier ? String(req.body.tier ?? "standard") : null;
      const pctRaw = hasPct ? Number(req.body.discountPct) : null;
      if (hasPct && (!Number.isFinite(pctRaw!) || pctRaw! < 0 || pctRaw! > 100)) {
        return res.status(400).json({ message: "A discount has to be between 0 and 100 percent." });
      }
      const note = s(req.body?.approvalNote, 400);

      // Stamp the approver whenever a discount is being SET above zero. Moving
      // it back to 0 clears the approval, so a re-grant is a fresh decision by
      // whoever makes it rather than one inherited from an old one.
      const nextPct = hasPct ? Math.round(pctRaw!) : Number(row.discount_pct ?? 0);
      const grantingNow = nextPct > 0;

      await db.execute(sql`
        UPDATE print_customers SET
          tier                = ${hasTier ? tier : sql`tier`},
          discount_pct        = ${hasPct ? Math.round(pctRaw!) : sql`discount_pct`},
          approved_by_user_id = ${grantingNow ? actorId : null},
          approved_at         = ${grantingNow ? sql`now()` : null},
          approval_note       = ${grantingNow ? note : null},
          disabled_at         = ${hasDisabled ? (req.body.disabled ? sql`now()` : null) : sql`disabled_at`}
        WHERE id = ${id}`);

      // 🔴 Disabling has to end the sessions, not just flag the row. Without
      // this a closed account keeps working for up to 30 days on a cookie that
      // was already issued.
      if (hasDisabled && req.body.disabled) {
        await db.execute(sql`
          UPDATE print_customer_sessions SET revoked_at = now()
          WHERE customer_id = ${id} AND revoked_at IS NULL`);
      }

      res.json({ ok: true });
    } catch (e: any) {
      console.error("[up-account] admin patch", e);
      res.status(500).json({ message: e.message ?? "Couldn't save that." });
    }
  });
}
