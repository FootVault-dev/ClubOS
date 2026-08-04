// ─────────────────────────────────────────────────────────────────────────────
// PARENT ACCOUNTS — the family's own view of the club (join.cufc.co.nz/account)
//
// Built 2026-08-04 to replace the one thing Friendly Manager still did better:
// a parent could log in, see their kids, see what they owed, and re-register
// next term without retyping everything. ClubOS held all of that data and gave
// families no way to reach it, so every term they typed it again — which is
// why the database now holds 207 duplicate children and 2,761 email addresses
// that map to more than one contact row.
//
//   POST /api/public/parent/request-code   — email → a 6-digit code
//   POST /api/public/parent/verify         — code → a session cookie
//   POST /api/public/parent/logout
//   GET  /api/public/parent/me             — the whole family
//   PATCH /api/public/parent/profile       — the parent's own details
//   PATCH /api/public/parent/children/:key — one child's details
//   GET  /api/public/parent/prefill        — what the checkout pre-fills from
//
// ── The three rules this file exists to enforce ──────────────────────────────
//
// 1. A SESSION ANCHORS ON GUARDIAN ROWS ONLY. A child's contact row is stamped
//    with the parent's email (4,662 of 6,508 player rows carry one), so
//    "the contact with this email" can be a child. Anchoring on type='guardian'
//    is what stops a login from resolving to a child's record.
//
// 2. THE FAMILY IS THE UNION ACROSS EVERY GUARDIAN ROW SHARING THE ADDRESS.
//    One human commonly has several guardian rows — one per time they
//    registered before this existed. Resolving one of them shows a parent a
//    fraction of their family. The token therefore carries the verified EMAIL,
//    not a contact id, and the guardian set is re-resolved on every request:
//    a merge or a new link takes effect immediately, exactly as the referee
//    token re-loads its referee row every time.
//
// 3. OWNERSHIP IS CHECKED SERVER-SIDE ON EVERY READ AND WRITE. The client
//    sends a child key; the server answers only if that child is in this
//    login's family. A parent must never be able to reach another family's
//    child by editing a URL — the payload is a child's date of birth, medical
//    notes and allergies.
//
// This is a PARENT credential and never a staff session (the CIC referee
// doctrine): its own cookie, its own HMAC domain ("par:"), and it grants
// nothing beyond these endpoints.
// ─────────────────────────────────────────────────────────────────────────────
import type { Express, Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { sql } from "drizzle-orm";
import { db } from "./db";
import { sendCufcParentLoginCode } from "./email";
import { nzTodayIso } from "@shared/housing";
import { parsePersonKey, mergeChildRecords, ageFromDob, type FamilyChild } from "@shared/family";
import { resolveFamily } from "./family-routes";
import {
  PARENT_SESSION_TTL_MS, PARENT_CODE_TTL_MS, PARENT_CODE_MAX_ATTEMPTS,
  PARENT_CODE_MAX_PER_EMAIL_HOUR, PARENT_CODE_MAX_PER_IP_HOUR, PARENT_COOKIE,
  normalizeParentEmail, looksLikeEmail, owingFor, feeStateFor, ageGradeFor,
  type ParentMe, type ParentChild, type ParentRegistration,
} from "@shared/parent";

const s = (v: any, max = 300): string | null => {
  const out = String(v ?? "").trim().slice(0, max);
  return out === "" ? null : out;
};

// ── The credential ───────────────────────────────────────────────────────────
// `par:<base64url(email)>.<expiry>.<hmac>`. Base64 because an email contains
// dots and the token is dot-delimited. The "par:" prefix is a domain separator:
// the referee parsers require "ref:"/"lref:" and reject this, and this parser
// rejects theirs — a parent credential can never be replayed as a referee's,
// and neither is ever a staff session.
const parentSecret = () => process.env.SESSION_SECRET || "cufc-dev-secret";

function makeParentToken(email: string): { token: string; expiresAt: number } {
  const expiresAt = Date.now() + PARENT_SESSION_TTL_MS;
  const payload = `par:${Buffer.from(email, "utf8").toString("base64url")}.${expiresAt}`;
  const sig = crypto.createHmac("sha256", parentSecret()).update(payload).digest("hex");
  return { token: `${payload}.${sig}`, expiresAt };
}

function parseParentToken(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [idPart, expStr, sig] = parts;
  if (!idPart.startsWith("par:")) return null;
  const expected = crypto.createHmac("sha256", parentSecret()).update(`${idPart}.${expStr}`).digest("hex");
  // timingSafeEqual throws on a length mismatch, so check length first.
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const exp = parseInt(expStr, 10);
  if (!exp || Date.now() > exp) return null;
  try {
    const email = Buffer.from(idPart.slice(4), "base64url").toString("utf8");
    return looksLikeEmail(email) ? normalizeParentEmail(email) : null;
  } catch { return null; }
}

// ClubOS has no cookie-parser mounted — `req.cookies` is silently undefined,
// which fails OPEN if you trust it. Read the raw header.
function readCookie(req: Request, name: string): string | null {
  const raw = String(req.headers.cookie || "");
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

const isProd = () => process.env.NODE_ENV === "production";

function setSessionCookie(res: Response, token: string, maxAgeMs: number) {
  const bits = [
    `${PARENT_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",           // survives the top-level hop from cufc.co.nz
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (isProd()) bits.push("Secure");
  res.append("Set-Cookie", bits.join("; "));
}

function clearSessionCookie(res: Response) {
  const bits = [`${PARENT_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (isProd()) bits.push("Secure");
  res.append("Set-Cookie", bits.join("; "));
}

// ── Guardian resolution ──────────────────────────────────────────────────────

/**
 * Every guardian contact row that carries this address.
 *
 * type='guardian' is the whole security property: a player row stamped with
 * the parent's email is a CHILD, and must never become the account holder.
 * Matched case- and whitespace-insensitively because families type their
 * address however they like, and the club's records were typed by many hands.
 */
async function guardianIdsForEmail(email: string): Promise<number[]> {
  const r = await db.execute(sql`
    SELECT id FROM contacts
    WHERE type = 'guardian'
      AND email IS NOT NULL AND LOWER(TRIM(email)) = ${email}
    ORDER BY id`);
  return (r.rows as any[]).map((x) => Number(x.id)).filter(Number.isFinite);
}

type ParentSession = { email: string; guardianIds: number[] };

/**
 * The guard. Re-resolves the guardian set on EVERY request rather than trusting
 * ids baked into the token, so a merge, a new link or a removed record takes
 * effect at once. A signed token whose address no longer matches any guardian
 * gets 401 and the cookie is cleared — that is a family whose record was
 * deleted, not an error to paper over.
 */
async function requireParent(req: Request, res: Response, next: NextFunction) {
  try {
    const raw = readCookie(req, PARENT_COOKIE);
    const email = raw ? parseParentToken(raw) : null;
    if (!email) {
      clearSessionCookie(res);
      return res.status(401).json({ message: "Please sign in." });
    }
    const guardianIds = await guardianIdsForEmail(email);
    if (guardianIds.length === 0) {
      clearSessionCookie(res);
      return res.status(401).json({ message: "We can't find an account for that email any more." });
    }
    (req as any).parent = { email, guardianIds } satisfies ParentSession;
    next();
  } catch (e) {
    console.error("[parent] auth error", e);
    res.status(500).json({ message: "Sign-in check failed." });
  }
}

const sessionOf = (req: Request): ParentSession => (req as any).parent;

// ── The family ───────────────────────────────────────────────────────────────

/**
 * Resolve the whole family across every guardian row this login speaks for,
 * then merge duplicate children.
 *
 * resolveFamily() is the Families resolver from 2026-08-02 — the ONE place
 * that knows a family is recorded three different ways (contact_relationships,
 * registrations.guardian_id, children.parent_id). Reusing it is deliberate: a
 * second resolver reading one mechanism is exactly the bug Families was built
 * to fix, and it would show a parent a child the office cannot see.
 */
async function familyFor(session: ParentSession): Promise<FamilyChild[]> {
  const families = await Promise.all(
    session.guardianIds.map((id) => resolveFamily("contact", id).catch((e) => {
      console.error("[parent] resolveFamily failed for guardian", id, e);
      return null;
    })),
  );
  const all: FamilyChild[] = [];
  for (const fam of families) if (fam) all.push(...fam.children);
  // The same child reached through two guardian rows is one child. mergeChildRecords
  // pools their programmes rather than picking a survivor — a live term enrolment
  // must never hide behind an old camp booking.
  return mergeChildRecords(all);
}

/** The parent's own details. Several guardian rows may exist; the one with the
 *  most complete record wins for display, and a write updates them ALL so the
 *  duplicates converge instead of drifting further apart. */
async function profileFor(session: ParentSession) {
  const r = await db.execute(sql`
    SELECT id, first_name, last_name, email, phone, alternate_phone, address
    FROM contacts
    WHERE id IN (${sql.join(session.guardianIds.map((i) => sql`${i}`), sql`, `)})`);
  const rows = r.rows as any[];
  const score = (x: any) => (x.phone ? 2 : 0) + (x.address ? 1 : 0) + (x.alternate_phone ? 1 : 0);
  const best = rows.slice().sort((a, b) => score(b) - score(a))[0] ?? {};
  return {
    firstName: best.first_name ?? "",
    lastName: best.last_name ?? "",
    email: session.email,
    phone: best.phone ?? null,
    alternatePhone: best.alternate_phone ?? null,
    address: best.address ?? null,
  };
}

/**
 * The detail fields a parent can see and correct.
 *
 * resolveFamily() returns family MEMBERSHIP plus the medical fields the office
 * needs; it deliberately does not carry consents, school or the NZF identity
 * columns. Those are fetched here in ONE batched query over the contact ids the
 * resolver already vouched for — never per child in a loop, which exhausted the
 * connection pool once already.
 */
type ChildDetailRow = {
  medicalNotes: string | null; allergies: string | null;
  emergencyContact: string | null; emergencyPhone: string | null;
  school: string | null; photoConsent: boolean; medicalConsent: boolean;
  countryOfBirth: string | null; nationality: string | null;
  ethnicity: string | null; subEthnicity: string | null;
};

async function childDetailsFor(contactIds: number[]): Promise<Map<number, ChildDetailRow>> {
  const map = new Map<number, ChildDetailRow>();
  if (contactIds.length === 0) return map;
  const r = await db.execute(sql`
    SELECT id, medical_notes, allergies, emergency_contact, emergency_phone, school,
           photo_consent, medical_consent, country_of_birth, nationality,
           ethnicity, sub_ethnicity
    FROM contacts
    WHERE id IN (${sql.join(contactIds.map((i) => sql`${i}`), sql`, `)})`);
  for (const row of r.rows as any[]) {
    map.set(Number(row.id), {
      medicalNotes: row.medical_notes ?? null,
      allergies: row.allergies ?? null,
      emergencyContact: row.emergency_contact ?? null,
      emergencyPhone: row.emergency_phone ?? null,
      school: row.school ?? null,
      photoConsent: !!row.photo_consent,
      medicalConsent: !!row.medical_consent,
      countryOfBirth: row.country_of_birth ?? null,
      nationality: row.nationality ?? null,
      ethnicity: row.ethnicity ?? null,
      subEthnicity: row.sub_ethnicity ?? null,
    });
  }
  return map;
}

/** payment_mode per registration — 'weekly' changes what a balance MEANS, so a
 *  parent on a weekly plan is never told they are behind. Batched, same reason. */
async function paymentModesFor(regIds: number[]): Promise<Map<number, string | null>> {
  const map = new Map<number, string | null>();
  if (regIds.length === 0) return map;
  const r = await db.execute(sql`
    SELECT id, payment_mode FROM registrations
    WHERE id IN (${sql.join(regIds.map((i) => sql`${i}`), sql`, `)})`);
  for (const row of r.rows as any[]) map.set(Number(row.id), row.payment_mode ?? null);
  return map;
}

/** Registrations → the money, as the club's own ledger sees it.
 *  🔴 `total_cents` is the truth, NOT `amount_paid` — amount_paid is left at 0
 *  by the camp checkout (367 of 535 live registrations), which is how a paid
 *  holiday camp reads $0.00 next to the word CONFIRMED.
 *  amount_paid is DECIMAL DOLLARS; total_cents is integer cents. */
function toParentRegistration(r: any, paymentMode: string | null): ParentRegistration {
  const totalCents = Number(r.totalCents ?? 0) || 0;
  const paidCents = Math.round(Number(r.amountPaid ?? 0) * 100) || 0;
  const status = String(r.status ?? "pending");
  return {
    id: Number(r.id),
    programId: Number(r.programId),
    programName: String(r.programName ?? "Programme"),
    programType: r.programType ?? null,
    status,
    registeredAt: r.registeredAt ? String(r.registeredAt).slice(0, 10) : null,
    totalCents,
    paidCents,
    owingCents: owingFor(totalCents, paidCents, status),
    feeState: feeStateFor(totalCents, paidCents, status),
    paymentMode,
  };
}

/** Every `contact`-shaped record behind a (possibly merged) child card. */
function contactIdsOf(child: FamilyChild): number[] {
  return (child.records ?? [])
    .filter((r) => r.kind === "contact")
    .map((r) => r.id)
    .filter(Number.isFinite);
}

/** Every `children`-shaped (holiday camp) record behind the same card. */
function campChildIdsOf(child: FamilyChild): number[] {
  return (child.records ?? [])
    .filter((r) => r.kind === "child")
    .map((r) => r.id)
    .filter(Number.isFinite);
}

/** Does this card stand for the key the client sent? A merged child answers to
 *  any of the record keys it was merged from, not just its primary key. */
function childMatchesKey(child: FamilyChild, key: string): boolean {
  if (child.key === key) return true;
  return (child.records ?? []).some((r) => r.key === key);
}

export function registerParentRoutes(app: Express) {
  const BASE = "/api/public/parent";

  // ── Request a code ─────────────────────────────────────────────────────────
  // 🔴 Always answers the same way, whether or not the address is known. The
  // response to "is this family in your database?" must not be an oracle a
  // stranger can query about other people.
  app.post(`${BASE}/request-code`, async (req, res) => {
    const generic = { ok: true, message: "If that email is on our records, we've sent you a code." };
    try {
      const email = normalizeParentEmail(req.body?.email);
      if (!looksLikeEmail(email)) {
        return res.status(400).json({ message: "That doesn't look like an email address." });
      }
      const ip = s(req.headers["x-forwarded-for"] || req.socket.remoteAddress, 60);

      // Rate limits — per address (someone else's inbox is not a toy) and per
      // origin (one host must not farm codes at every address it can guess).
      const since = new Date(Date.now() - 60 * 60 * 1000);
      const counts = await db.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE email = ${email}) AS by_email,
          COUNT(*) FILTER (WHERE request_ip IS NOT NULL AND request_ip = ${ip}) AS by_ip
        FROM parent_login_codes WHERE created_at > ${since}`);
      const c = (counts.rows as any[])[0] ?? {};
      if (Number(c.by_email ?? 0) >= PARENT_CODE_MAX_PER_EMAIL_HOUR ||
          Number(c.by_ip ?? 0) >= PARENT_CODE_MAX_PER_IP_HOUR) {
        return res.status(429).json({ message: "Too many attempts. Please try again in an hour." });
      }

      const guardianIds = await guardianIdsForEmail(email);
      if (guardianIds.length === 0) return res.json(generic);   // same shape, no code sent

      const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
      const codeHash = crypto.createHash("sha256").update(`${code}:${email}`).digest("hex");
      await db.execute(sql`
        INSERT INTO parent_login_codes (email, code_hash, expires_at, request_ip)
        VALUES (${email}, ${codeHash}, ${new Date(Date.now() + PARENT_CODE_TTL_MS)}, ${ip})`);

      const [first] = await db.execute(sql`
        SELECT first_name FROM contacts WHERE id = ${guardianIds[0]}`).then((r) => r.rows as any[]);
      await sendCufcParentLoginCode({
        to: email,
        firstName: first?.first_name ?? null,
        code,
        minutes: Math.round(PARENT_CODE_TTL_MS / 60000),
      });

      // Local testing only. The sibling apps gate their echo on an env var
      // alone (FANTASY_ECHO_CODE, COACH_ECHO_CODE …), which means a stray
      // production env var hands out live credentials. This one ALSO requires
      // a non-production build, so it cannot fire on prod whatever is set.
      if (process.env.PARENT_ECHO_CODE === "1" && process.env.NODE_ENV !== "production") {
        console.log(`[parent] DEV echo — code for ${email}: ${code}`);
        return res.json({ ...generic, devCode: code });
      }
      res.json(generic);
    } catch (e: any) {
      console.error("[parent] request-code", e);
      res.json(generic);   // never leak a failure shape that differs from success
    }
  });

  // ── Verify ────────────────────────────────────────────────────────────────
  app.post(`${BASE}/verify`, async (req, res) => {
    try {
      const email = normalizeParentEmail(req.body?.email);
      const code = String(req.body?.code ?? "").trim();
      if (!looksLikeEmail(email) || !/^\d{6}$/.test(code)) {
        return res.status(400).json({ message: "Enter the 6-digit code from your email." });
      }
      const codeHash = crypto.createHash("sha256").update(`${code}:${email}`).digest("hex");

      // EVERY un-consumed, unexpired, un-exhausted code for this address —
      // not just the newest. A parent who taps "email me a code" twice and then
      // types the first one is holding a code we really did send them; telling
      // them it is wrong (and burning an attempt on the other one) is how a
      // legitimate family locks itself out. Each code is still single-use,
      // time-limited and attempt-limited, so accepting any live one is no
      // weaker — there are at most PARENT_CODE_MAX_PER_EMAIL_HOUR of them.
      const live = await db.execute(sql`
        SELECT id, code_hash FROM parent_login_codes
        WHERE email = ${email} AND consumed_at IS NULL
          AND expires_at > now() AND attempts < ${PARENT_CODE_MAX_ATTEMPTS}
        ORDER BY created_at DESC`);
      const rows = live.rows as any[];
      if (rows.length === 0) {
        return res.status(400).json({ message: "That code has expired. Please request a new one." });
      }

      const given = Buffer.from(codeHash, "hex");
      const match = rows.find((r) => {
        const stored = Buffer.from(String(r.code_hash), "hex");
        return given.length === stored.length && crypto.timingSafeEqual(given, stored);
      });
      if (!match) {
        // A code we really did issue, already spent — a back button or a double
        // tap, not an attack. Say so plainly, and do NOT burn an attempt on the
        // family's other live codes for it.
        const spent = await db.execute(sql`
          SELECT 1 FROM parent_login_codes
          WHERE email = ${email} AND code_hash = ${codeHash} AND consumed_at IS NOT NULL
          LIMIT 1`);
        if ((spent.rows as any[]).length > 0) {
          return res.status(400).json({
            message: "That code has already been used. Please request a new one.",
          });
        }
        // Burn an attempt on every live code, so guessing is bounded across all
        // of them rather than resetting each time a new one is requested.
        await db.execute(sql`
          UPDATE parent_login_codes SET attempts = attempts + 1
          WHERE id IN (${sql.join(rows.map((r) => sql`${r.id}`), sql`, `)})`);
        return res.status(400).json({ message: "That code isn't right. Please check and try again." });
      }
      const row = match;

      // Single-use. Consume BEFORE minting the session so a replay cannot ride
      // the same code twice, and only if it is still un-consumed (two requests
      // racing the same code — the loser gets nothing).
      const consumed = await db.execute(sql`
        UPDATE parent_login_codes SET consumed_at = now()
        WHERE id = ${row.id} AND consumed_at IS NULL RETURNING id`);
      if ((consumed.rows as any[]).length === 0) {
        return res.status(400).json({ message: "That code has already been used. Please request a new one." });
      }

      // Re-check the guardian still exists — the record could have been removed
      // between requesting the code and typing it.
      const guardianIds = await guardianIdsForEmail(email);
      if (guardianIds.length === 0) {
        return res.status(400).json({ message: "We can't find an account for that email." });
      }

      const { token } = makeParentToken(email);
      setSessionCookie(res, token, PARENT_SESSION_TTL_MS);
      res.json({ ok: true });
    } catch (e: any) {
      console.error("[parent] verify", e);
      res.status(500).json({ message: "Something went wrong signing you in." });
    }
  });

  app.post(`${BASE}/logout`, (_req, res) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  // ── The dashboard ─────────────────────────────────────────────────────────
  app.get(`${BASE}/me`, requireParent, async (req, res) => {
    try {
      const session = sessionOf(req);
      const today = nzTodayIso();
      const [profile, children] = await Promise.all([profileFor(session), familyFor(session)]);

      // Two batched lookups for the whole family, never one per child.
      const [details, modes] = await Promise.all([
        childDetailsFor(children.flatMap(contactIdsOf)),
        paymentModesFor(children.flatMap((c) => (c.registrations ?? []).map((r) => r.id))),
      ]);

      const out: ParentChild[] = children.map((ch) => {
        const regs = (ch.registrations ?? []).map((r) =>
          toParentRegistration(r, modes.get(Number(r.id)) ?? null),
        );
        // Merged children have several contact rows; take the first row that
        // actually holds each answer, so a detail recorded on one record is not
        // hidden because the card opens the other.
        const rows = contactIdsOf(ch).map((id) => details.get(id)).filter(Boolean) as ChildDetailRow[];
        const pick = <K extends keyof ChildDetailRow>(k: K): ChildDetailRow[K] | null =>
          (rows.map((r) => r[k]).find((v) => v !== null && v !== undefined && v !== "") ?? null) as any;

        const merged: ChildDetailRow = {
          // The resolver already pooled the medical fields across records.
          medicalNotes: ch.medicalNotes ?? pick("medicalNotes"),
          allergies: ch.allergies ?? pick("allergies"),
          emergencyContact: pick("emergencyContact"),
          emergencyPhone: pick("emergencyPhone"),
          school: pick("school"),
          // A consent is true only if some record says so — never defaulted true.
          photoConsent: rows.some((r) => r.photoConsent),
          medicalConsent: rows.some((r) => r.medicalConsent),
          countryOfBirth: pick("countryOfBirth"),
          nationality: pick("nationality"),
          ethnicity: pick("ethnicity"),
          subEthnicity: pick("subEthnicity"),
        };

        return {
          key: ch.key,
          firstName: ch.firstName,
          lastName: ch.lastName,
          dateOfBirth: ch.dateOfBirth ?? null,
          age: ageFromDob(ch.dateOfBirth, today),
          ageGrade: ageGradeFor(ch.dateOfBirth, today),
          registrations: regs,
          owingCents: regs.reduce((n, r) => n + r.owingCents, 0),
          details: merged,
          // A prompt, never a block. NZ Football needs these and 3,817 player
          // records carry legacy free text or nothing at all — the backfill is
          // the only thing between the club and a clean national register, and
          // the family is the only one who actually knows the answers.
          needsIdentity: !(merged.ethnicity && merged.nationality && merged.countryOfBirth)
            || !ch.dateOfBirth,
        };
      });

      const payload: ParentMe = {
        profile,
        children: out,
        owingCents: out.reduce((n, c) => n + c.owingCents, 0),
        today,
        guardianIds: session.guardianIds,
      };
      res.json(payload);
    } catch (e: any) {
      console.error("[parent] me", e);
      res.status(500).json({ message: "Couldn't load your account." });
    }
  });

  // ── The parent's own details ──────────────────────────────────────────────
  // Writes to EVERY guardian row this login speaks for, so the duplicates
  // converge on the truth instead of drifting further apart. The email is NOT
  // editable here: it is the credential, and changing it would either strand
  // the session or hand this family's data to another address.
  app.patch(`${BASE}/profile`, requireParent, async (req, res) => {
    try {
      const session = sessionOf(req);
      const firstName = s(req.body?.firstName, 100);
      const lastName = s(req.body?.lastName, 100);
      const phone = s(req.body?.phone, 40);
      if (!firstName || !lastName) {
        return res.status(400).json({ message: "Please give us your first and last name." });
      }
      if (!phone) {
        return res.status(400).json({ message: "Please give us a contact phone number." });
      }
      await db.execute(sql`
        UPDATE contacts SET
          first_name = ${firstName},
          last_name = ${lastName},
          phone = ${phone},
          alternate_phone = ${s(req.body?.alternatePhone, 40)},
          address = ${s(req.body?.address, 300)}
        WHERE id IN (${sql.join(session.guardianIds.map((i) => sql`${i}`), sql`, `)})`);
      res.json({ ok: true });
    } catch (e: any) {
      console.error("[parent] profile", e);
      res.status(500).json({ message: "Couldn't save your details." });
    }
  });

  // ── One child's details ───────────────────────────────────────────────────
  // 🔴 The ownership check is the point. The key comes from the client, so the
  // child is re-resolved from THIS login's family and a key outside it 404s —
  // never 403, which would confirm the record exists.
  app.patch(`${BASE}/children/:key`, requireParent, async (req, res) => {
    try {
      const session = sessionOf(req);
      const key = String(req.params.key ?? "");
      // Reject a malformed key before doing any family work.
      if (!parsePersonKey(key)) return res.status(404).json({ message: "Not found" });

      const family = await familyFor(session);
      const mine = family.find((c) => childMatchesKey(c, key));
      if (!mine) return res.status(404).json({ message: "Not found" });

      // Write to every underlying record this child was merged from, so a
      // correction lands on whichever row the next registration reads.
      const contactIds = contactIdsOf(mine);
      const childIds = campChildIdsOf(mine);

      const medicalNotes = s(req.body?.medicalNotes, 2000);
      const allergies = s(req.body?.allergies, 1000);
      const emergencyContact = s(req.body?.emergencyContact, 200);
      const emergencyPhone = s(req.body?.emergencyPhone, 40);
      const school = s(req.body?.school, 200);
      const photoConsent = !!req.body?.photoConsent;
      const medicalConsent = !!req.body?.medicalConsent;

      if (contactIds.length) {
        await db.execute(sql`
          UPDATE contacts SET
            medical_notes = ${medicalNotes},
            allergies = ${allergies},
            emergency_contact = ${emergencyContact},
            emergency_phone = ${emergencyPhone},
            school = ${school},
            photo_consent = ${photoConsent},
            medical_consent = ${medicalConsent}
          WHERE id IN (${sql.join(contactIds.map((i) => sql`${i}`), sql`, `)})`);
      }
      // Camp children live in their own table with a narrower shape.
      if (childIds.length) {
        await db.execute(sql`
          UPDATE children SET
            medical_notes = ${medicalNotes},
            allergies = ${allergies}
          WHERE id IN (${sql.join(childIds.map((i) => sql`${i}`), sql`, `)})`);
      }
      res.json({ ok: true });
    } catch (e: any) {
      console.error("[parent] child update", e);
      res.status(500).json({ message: "Couldn't save those details." });
    }
  });

  // ── What the checkout pre-fills from ──────────────────────────────────────
  // The whole promise of the account: a returning family types nothing they
  // have already told us. 200 with `signedIn:false` rather than 401, so the
  // checkout can call it unconditionally and simply render its blank form for
  // a visitor who has never signed in.
  app.get(`${BASE}/prefill`, async (req, res) => {
    try {
      const raw = readCookie(req, PARENT_COOKIE);
      const email = raw ? parseParentToken(raw) : null;
      if (!email) return res.json({ signedIn: false });
      const guardianIds = await guardianIdsForEmail(email);
      if (guardianIds.length === 0) return res.json({ signedIn: false });

      const session: ParentSession = { email, guardianIds };
      const [profile, children] = await Promise.all([profileFor(session), familyFor(session)]);
      const today = nzTodayIso();
      res.json({
        signedIn: true,
        parent: profile,
        children: children.map((c) => ({
          key: c.key,
          firstName: c.firstName,
          lastName: c.lastName,
          dateOfBirth: c.dateOfBirth ?? null,
          ageGrade: ageGradeFor(c.dateOfBirth, today),
        })),
      });
    } catch (e: any) {
      console.error("[parent] prefill", e);
      res.json({ signedIn: false });   // a broken prefill must never block a sale
    }
  });
}

/**
 * Resolve a child key the checkout was given against a parent cookie, for the
 * registration intent route.
 *
 * Returns the CONTACT id of an existing child when the signed-in family really
 * owns that key — which lets the intent route re-use the child instead of
 * minting a new contact row. That unconditional createContact is why the
 * database holds 207 duplicate children today.
 *
 * Returns null for anything it cannot prove, and the caller falls back to
 * creating a child exactly as before: an unprovable claim must never widen
 * access, and must never break the sale either.
 */
export async function resolveOwnedChildContactId(
  req: Request,
  childKey: unknown,
): Promise<number | null> {
  try {
    const key = String(childKey ?? "");
    if (!key) return null;
    const raw = readCookie(req, PARENT_COOKIE);
    const email = raw ? parseParentToken(raw) : null;
    if (!email) return null;
    const guardianIds = await guardianIdsForEmail(email);
    if (guardianIds.length === 0) return null;

    const family = await familyFor({ email, guardianIds });
    const mine = family.find((c) => childMatchesKey(c, key));
    if (!mine) return null;

    // Only a `contact`-shaped child can carry an academy registration. A camp
    // child (a `children` row) has no contacts row to register against, so we
    // return null and the caller creates one exactly as it does today.
    const ids = contactIdsOf(mine);
    return ids.length ? ids[0] : null;
  } catch (e) {
    console.error("[parent] resolveOwnedChildContactId", e);
    return null;
  }
}

export { requireParent, guardianIdsForEmail };
