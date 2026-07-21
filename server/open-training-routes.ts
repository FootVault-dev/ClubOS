// ─────────────────────────────────────────────────────────────────────────────
// OPEN TRAININGS — free open-training requests for Christchurch United.
//
// U9–U20 academy programmes are invite-only (Daniel, 2026-07-21): cufc.co.nz
// no longer links their checkout. The door in is this form — a parent requests
// a free open training, academy staff approve or decline it in the CUFC
// workspace "Open Trainings" tab, and an approval emails the family their
// session confirmation. U4–U8 offers the same form alongside its paid signup.
//
//   OPTIONS/POST /api/public/cufc/open-training      (cross-origin, cufc.co.nz)
//   GET          /api/admin/cufc/open-trainings       (session + "open-trainings" tab)
//   PATCH        /api/admin/cufc/open-trainings/:id   (approve / decline / notes)
//
// The age band is DERIVED server-side from the child's date of birth (NZF
// rule: grade = season year − birth year, parsed from the ISO string — never
// through `new Date`), so a parent picking the wrong band on the form can't
// mis-file a request. All data is org-scoped to CUFC (org slug
// christchurch-united) — a caller can never choose an org.
// ─────────────────────────────────────────────────────────────────────────────
import type { Express, Request, Response } from "express";
import { desc, eq } from "drizzle-orm";
import { db } from "./db";
import { requireAuth, requireTab } from "./auth";
import { storage } from "./storage";
import { clientIp } from "./api-security";
import { organizations, cufcOpenTrainings } from "@shared/schema";
import { ageGradeFor, nzTodayIso } from "@shared/academy";
import {
  sendCufcOpenTrainingReceived,
  sendCufcOpenTrainingNotification,
  sendCufcOpenTrainingConfirmed,
} from "./email";

const CUFC_ORG_SLUG = "christchurch-united";
// Requests are reviewed by the academy office (Paul Holocher's inbox).
const OPEN_TRAINING_NOTIFY_TO = "academy@cufc.co.nz";

export const OPEN_TRAINING_GROUPS = ["u4-u8", "u9-u12", "u13-plus"] as const;
export type OpenTrainingGroup = (typeof OPEN_TRAINING_GROUPS)[number];
const GROUP_LABEL: Record<OpenTrainingGroup, string> = {
  "u4-u8": "U4–U8 (FUNiño)",
  "u9-u12": "U9–U12 (Juniors / Pre-Academy)",
  "u13-plus": "U13+ (Academy)",
};

const OPEN_TRAINING_STATUSES = ["pending", "approved", "declined"] as const;

/** The band a grade files under. Null = outside the club's youth programmes. */
function groupForGrade(grade: number): OpenTrainingGroup | null {
  if (grade < 1 || grade > 20) return null;
  if (grade <= 8) return "u4-u8";
  if (grade <= 12) return "u9-u12";
  return "u13-plus";
}

const s = (v: any, max = 300): string => String(v ?? "").trim().slice(0, max);
const sOrNull = (v: any, max = 1000): string | null => { const t = s(v, max); return t ? t : null; };

let orgIdCache: number | null = null;
async function cufcOrgId(): Promise<number> {
  if (orgIdCache) return orgIdCache;
  const [org] = await db.select().from(organizations).where(eq(organizations.slug, CUFC_ORG_SLUG));
  if (!org) throw new Error("Christchurch United organization not found");
  orgIdCache = org.id;
  return org.id;
}

// Same origins as the predictor + contact endpoints on the CUFC site.
const SITE_ORIGINS = ["https://cufc.co.nz", "https://www.cufc.co.nz"];
function setCors(req: Request, res: Response) {
  const origin = String(req.headers.origin || "");
  if (SITE_ORIGINS.includes(origin) || /\.vercel\.app$/.test(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
  }
  res.header("Vary", "Origin");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
}

// Per-IP throttle — a public form that invites strangers to POST. Mirrors the
// hiring-application limiter: 5 per IP per hour, in-memory, pruned when large.
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX = 5;
const hits = new Map<string, number[]>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  if (hits.size > 5000) {
    hits.forEach((v, k) => { if (!v.some((t) => now - t < RATE_WINDOW_MS)) hits.delete(k); });
  }
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX) { hits.set(ip, recent); return true; }
  recent.push(now);
  hits.set(ip, recent);
  return false;
}

/** Who decided this? Best-effort — never blocks the action. */
async function actorFromSession(req: Request): Promise<string | null> {
  const userId = (req as any).session?.userId;
  if (!userId) return null;
  const user = await storage.getUser(userId).catch(() => null);
  if (!user) return null;
  const name = `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim();
  return name || user.email || null;
}

export function registerOpenTrainingRoutes(app: Express) {
  const tab = requireTab("open-trainings");

  // ── Public: request an open training (cufc.co.nz/open-training) ───────────
  app.options("/api/public/cufc/open-training", (req, res) => { setCors(req, res); res.sendStatus(204); });
  app.post("/api/public/cufc/open-training", async (req, res) => {
    setCors(req, res);
    try {
      if (rateLimited(clientIp(req) || "unknown")) {
        return res.status(429).json({ message: "That's a few requests in a short time — please try again shortly." });
      }

      const childFirstName = s(req.body.childFirstName, 100);
      const childLastName = s(req.body.childLastName, 100);
      const childDob = s(req.body.childDob, 10);
      const guardianName = s(req.body.guardianName, 150);
      const email = s(req.body.email, 200);
      const phone = s(req.body.phone, 50);

      if (!childFirstName || !childLastName) return res.status(400).json({ message: "Please add the player's name." });
      if (!guardianName) return res.status(400).json({ message: "Please add a parent or guardian name." });
      if (!/.+@.+\..+/.test(email)) return res.status(400).json({ message: "Please add a valid email address." });
      if (!phone) return res.status(400).json({ message: "Please add a phone number." });

      // Grade from DOB — the ISO string is parsed directly (never `new Date`,
      // which reads a day early in NZ). An unparseable DOB fails closed.
      const seasonYear = Number(nzTodayIso().slice(0, 4));
      const grade = ageGradeFor(childDob, seasonYear);
      if (grade === null) return res.status(400).json({ message: "Please add the player's date of birth." });
      const ageGroup = groupForGrade(grade);
      if (!ageGroup) {
        return res.status(400).json({
          message: `Open trainings cover players from U4 to U20. For anything else, email ${OPEN_TRAINING_NOTIFY_TO}.`,
        });
      }

      const orgId = await cufcOrgId();
      const [row] = await db.insert(cufcOpenTrainings).values({
        organizationId: orgId,
        ageGroup,
        childFirstName,
        childLastName,
        childDob,
        ageGrade: grade,
        guardianName,
        email,
        phone,
        currentClub: sOrNull(req.body.currentClub, 200),
        notes: sOrNull(req.body.notes, 2000),
        status: "pending",
        source: sOrNull(req.body.source, 100),
        sourceUrl: sOrNull(req.body.sourceUrl, 500),
      }).returning();

      const childName = `${childFirstName} ${childLastName}`;
      // Best-effort emails — a failed send must never lose the request.
      sendCufcOpenTrainingReceived({
        to: email, guardianName, childName, groupLabel: GROUP_LABEL[ageGroup],
      }).catch((e) => console.error("[open-training] ack email failed:", e));
      sendCufcOpenTrainingNotification({
        to: OPEN_TRAINING_NOTIFY_TO,
        childName, dob: childDob, grade, groupLabel: GROUP_LABEL[ageGroup],
        guardianName, email, phone,
        currentClub: row.currentClub, notes: row.notes,
        sourceUrl: row.sourceUrl || undefined,
      }).catch((e) => console.error("[open-training] notify email failed:", e));

      res.json({ ok: true });
    } catch (e: any) {
      console.error("[open-training] submit error:", e);
      res.status(500).json({ message: "Something went wrong — please try again." });
    }
  });

  // ── Admin: the CUFC "Open Trainings" tab ───────────────────────────────────
  app.get("/api/admin/cufc/open-trainings", requireAuth, tab, async (_req, res) => {
    try {
      const orgId = await cufcOrgId();
      const rows = await db.select().from(cufcOpenTrainings)
        .where(eq(cufcOpenTrainings.organizationId, orgId))
        .orderBy(desc(cufcOpenTrainings.createdAt));
      res.json(rows);
    } catch (e: any) {
      console.error("[open-training] list error:", e);
      res.status(500).json({ message: e.message });
    }
  });

  app.patch("/api/admin/cufc/open-trainings/:id", requireAuth, tab, async (req, res) => {
    try {
      const orgId = await cufcOrgId();
      const id = parseInt(String(req.params.id));
      if (!Number.isInteger(id)) return res.status(400).json({ message: "Bad id" });

      const [existing] = await db.select().from(cufcOpenTrainings)
        .where(eq(cufcOpenTrainings.id, id));
      if (!existing || existing.organizationId !== orgId) return res.status(404).json({ message: "Request not found" });

      const updates: Record<string, any> = {};
      if ("staffNotes" in req.body) updates.staffNotes = sOrNull(req.body.staffNotes, 4000);
      if ("sessionDetails" in req.body) updates.sessionDetails = sOrNull(req.body.sessionDetails, 2000);

      let becameApproved = false;
      if ("status" in req.body) {
        const status = String(req.body.status);
        if (!OPEN_TRAINING_STATUSES.includes(status as any)) {
          return res.status(400).json({ message: "Bad status" });
        }
        updates.status = status;
        if (status !== existing.status) {
          updates.decidedAt = status === "pending" ? null : new Date();
          updates.decidedBy = status === "pending" ? null : await actorFromSession(req);
          becameApproved = status === "approved";
        }
      }
      if (Object.keys(updates).length === 0) return res.status(400).json({ message: "Nothing to update" });

      const [row] = await db.update(cufcOpenTrainings).set(updates)
        .where(eq(cufcOpenTrainings.id, id)).returning();

      // The confirmation email — the whole point of the approve step. Sent on
      // the transition into `approved` only (re-saving notes never re-emails).
      if (becameApproved) {
        sendCufcOpenTrainingConfirmed({
          to: row.email,
          guardianName: row.guardianName,
          childName: `${row.childFirstName} ${row.childLastName}`,
          sessionDetails: row.sessionDetails,
        }).catch((e) => console.error("[open-training] confirm email failed:", e));
      }

      res.json(row);
    } catch (e: any) {
      console.error("[open-training] patch error:", e);
      res.status(500).json({ message: e.message });
    }
  });
}
