// ─────────────────────────────────────────────────────────────────────────────
// HIRING — job postings and applications.
//
// Public (cookie-less, CORS-allow-listed to our own brand sites):
//   GET  /api/public/hiring/:brand/jobs             — open postings for a brand
//   GET  /api/public/hiring/:brand/jobs/:slug       — one posting + its questions
//   POST /api/public/hiring/:brand/jobs/:slug/apply — apply (JSON or multipart)
//
// Admin (session + the "hiring" tab, org-scoped to the managing workspace):
//   GET|POST                 /api/admin/hiring/jobs
//   PATCH|DELETE             /api/admin/hiring/jobs/:id
//   GET                      /api/admin/hiring/applications?jobId=
//   PATCH|DELETE             /api/admin/hiring/applications/:id
//   GET                      /api/admin/hiring/applications/:id/audition
//
// A job's `brand` is a public namespace, not an owner: the CUFC Club Commentator
// advert is managed from the United Sports Group workspace but served to
// footballinstitute.co.nz under brand "cufc". The owning org always comes from
// the job row, never from the request — a public caller cannot choose an org.
// ─────────────────────────────────────────────────────────────────────────────
import type { Express, Request, Response } from "express";
import multer from "multer";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "./db";
import { requireAuth, requireTab } from "./auth";
import { clientIp } from "./api-security";
import { organizations, hiringJobs, hiringApplications, users as usersTable } from "@shared/schema";
import {
  APPLICATION_STATUSES,
  CLOSED_APPLICATION_STATUSES,
  JOB_STATUSES,
  HIRING_LIMITS,
  AUDITION_MIME_PREFIXES,
  isApplicationStatus,
  isJobStatus,
  needsGuardianConsent,
  sanitiseAnswers,
  validateAnswers,
  type HiringQuestion,
} from "@shared/hiring";
import { sendHiringApplicationNotification } from "./email";

const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || "clubos-uploads";

const s = (v: any, max = 200): string => String(v ?? "").trim().slice(0, max);
const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const truthy = (v: any) => v === true || v === "true" || v === "on" || v === "1";

// ── CORS ─────────────────────────────────────────────────────────────────────
// Reflects an allow-listed origin. These endpoints are session-less and send no
// credentials, so reflection is safe. The origin is where the CAREERS PAGE is
// served from — never app.usg.co.nz, which is the API host.
const HIRING_HOSTS = new Set([
  "footballinstitute.co.nz", "www.footballinstitute.co.nz",
  "cufc.co.nz", "www.cufc.co.nz",
  "minifootball.co.nz", "www.minifootball.co.nz",
  "cicyouth.com", "www.cicyouth.com",
  "cugc.co.nz", "www.cugc.co.nz",
  "unitedprints.co.nz", "www.unitedprints.co.nz",
  "southislandunited.com", "www.southislandunited.com",
  "usg.co.nz", "www.usg.co.nz",
]);

function hiringAllowOrigin(origin: string | undefined): string | null {
  if (!origin) return null;
  try {
    const { hostname, protocol } = new URL(origin);
    const isLocal = hostname === "localhost" || hostname === "127.0.0.1";
    if (protocol !== "https:" && !isLocal) return null;
    if (HIRING_HOSTS.has(hostname) || hostname.endsWith(".vercel.app") || isLocal) return origin;
  } catch {
    /* malformed origin */
  }
  return null;
}

function hiringCors(req: Request, res: Response) {
  const allowed = hiringAllowOrigin(req.headers.origin as string | undefined);
  if (allowed) {
    res.set("Access-Control-Allow-Origin", allowed);
    res.set("Vary", "Origin");
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");
  }
}

// ── Rate limiting ────────────────────────────────────────────────────────────
// The first rate limiter on a public form in this codebase. A job advert invites
// strangers to POST us a 60 MB file, which the other public forms do not.
// In-memory, so the budget is per Fly machine (currently 2) — that is fine for a
// throttle whose job is to stop a script, not to be an exact quota.
const applyHits = new Map<string, number[]>();
const WINDOW_MS = 60 * 60 * 1000;

function rateLimited(ip: string): boolean {
  const now = Date.now();
  if (applyHits.size > 5000) {
    for (const [k, times] of Array.from(applyHits.entries())) {
      if (!times.some((t: number) => now - t < WINDOW_MS)) applyHits.delete(k);
    }
  }
  const recent = (applyHits.get(ip) ?? []).filter((t: number) => now - t < WINDOW_MS);
  if (recent.length >= HIRING_LIMITS.maxApplicationsPerIpPerHour) {
    applyHits.set(ip, recent);
    return true;
  }
  recent.push(now);
  applyHits.set(ip, recent);
  return false;
}

// ── Audition upload ──────────────────────────────────────────────────────────
const auditionUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: HIRING_LIMITS.maxAuditionBytes, files: 1 },
  fileFilter: (_req, file, cb) => {
    const mime = file.mimetype || "";
    if (AUDITION_MIME_PREFIXES.some((p) => mime.startsWith(p))) return cb(null, true);
    cb(new Error("Your audition needs to be an audio or video file."));
  },
});

const MB = (n: number) => Math.round(n / (1024 * 1024));

/** Parse the multipart body if there is one; otherwise leave the JSON body alone. */
function parseAuditionUpload(req: Request, res: Response, next: () => void) {
  const ct = String(req.headers["content-type"] || "");
  if (!ct.startsWith("multipart/form-data")) return next();
  auditionUpload.single("auditionFile")(req, res, (err: any) => {
    if (!err) return next();
    const message =
      err?.code === "LIMIT_FILE_SIZE"
        ? `That file is over ${MB(HIRING_LIMITS.maxAuditionBytes)} MB. Trim the clip, or paste a link instead.`
        : err?.message || "We couldn't read that upload.";
    res.status(400).json({ message });
  });
}

// ── Org scoping (mirrors workspaceOrg in routes.ts, which isn't exported) ─────
async function workspaceOrg(req: Request): Promise<{ id: number; slug: string } | null> {
  const slug = String(req.headers["x-workspace-slug"] || "").trim();
  if (!slug) return null;
  const [org] = await db.select().from(organizations).where(eq(organizations.slug, slug));
  return org ? { id: org.id, slug: org.slug } : null;
}

const jobIsOpen = (job: { status: string; closesAt: Date | null }) =>
  job.status === "open" && (!job.closesAt || job.closesAt.getTime() > Date.now());

/** What the public site is allowed to see about a posting. Never the notify email. */
const publicJob = (j: typeof hiringJobs.$inferSelect) => ({
  slug: j.slug,
  title: j.title,
  tagline: j.tagline,
  description: j.description,
  employmentType: j.employmentType,
  positions: j.positions,
  payLabel: j.payLabel,
  location: j.location,
  closesAt: j.closesAt,
  advertUrl: j.advertUrl,
  questions: j.questions ?? [],
  open: jobIsOpen(j),
});

export function registerHiringRoutes(app: Express) {
  // ═══════════════════════════ PUBLIC ═══════════════════════════════════════

  app.options("/api/public/hiring/:brand/jobs", (req, res) => { hiringCors(req, res); res.sendStatus(204); });
  app.get("/api/public/hiring/:brand/jobs", async (req, res) => {
    hiringCors(req, res);
    try {
      const brand = s(req.params.brand, 40).toLowerCase();
      const rows = await db.select().from(hiringJobs)
        .where(and(eq(hiringJobs.brand, brand), eq(hiringJobs.status, "open")))
        .orderBy(desc(hiringJobs.createdAt));
      res.json({ jobs: rows.filter(jobIsOpen).map(publicJob) });
    } catch (e: any) {
      console.error("[hiring] public list failed:", e);
      res.status(500).json({ message: "Couldn't load the roles right now." });
    }
  });

  app.options("/api/public/hiring/:brand/jobs/:slug", (req, res) => { hiringCors(req, res); res.sendStatus(204); });
  app.get("/api/public/hiring/:brand/jobs/:slug", async (req, res) => {
    hiringCors(req, res);
    try {
      const job = await findPublicJob(req);
      if (!job) return res.status(404).json({ message: "That role isn't listed." });
      res.json(publicJob(job));
    } catch (e: any) {
      console.error("[hiring] public get failed:", e);
      res.status(500).json({ message: "Couldn't load that role right now." });
    }
  });

  app.options("/api/public/hiring/:brand/jobs/:slug/apply", (req, res) => { hiringCors(req, res); res.sendStatus(204); });
  app.post(
    "/api/public/hiring/:brand/jobs/:slug/apply",
    // Throttle BEFORE multer, so a script can't make us buffer file after file.
    (req, res, next) => {
      hiringCors(req, res);
      if (rateLimited(clientIp(req) || "unknown")) {
        return res.status(429).json({ message: "That's a few applications in a short time. Try again shortly." });
      }
      next();
    },
    parseAuditionUpload,
    async (req: Request, res: Response) => {
      hiringCors(req, res);
      const file = (req as any).file as Express.Multer.File | undefined;
      try {
        const job = await findPublicJob(req);
        if (!job) return res.status(404).json({ message: "That role isn't listed." });
        if (!jobIsOpen(job)) return res.status(410).json({ message: "Applications for this role have closed." });

        const questions: HiringQuestion[] = job.questions ?? [];

        // Multipart sends `answers` as a JSON string; JSON bodies send an object.
        let rawAnswers: unknown = req.body?.answers;
        if (typeof rawAnswers === "string") {
          try { rawAnswers = JSON.parse(rawAnswers); } catch { rawAnswers = {}; }
        }
        const answers = sanitiseAnswers(questions, rawAnswers);

        const firstName = s(req.body?.firstName, 80);
        const lastName = s(req.body?.lastName, 80);
        const email = s(req.body?.email, 160).toLowerCase();
        const phone = s(req.body?.phone, 40);
        const dateOfBirth = s(req.body?.dateOfBirth, 10);
        const city = s(req.body?.city, 120);

        const errors: string[] = [];
        if (!firstName) errors.push("Your first name is required.");
        if (!isEmail(email)) errors.push("A valid email address is required.");
        if (!phone) errors.push("A phone number is required.");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) errors.push("Your date of birth is required.");
        if (!truthy(req.body?.consentContact)) errors.push("We need your permission to contact you about this role.");
        if (!truthy(req.body?.consentBroadcast)) errors.push("We need your consent to broadcast and record your commentary.");

        // Age gate is computed here, from the DOB, and never read from the body.
        const guardianRequired = dateOfBirth ? needsGuardianConsent(dateOfBirth, new Date()) : true;
        const guardianName = s(req.body?.guardianName, 120);
        const guardianEmail = s(req.body?.guardianEmail, 160).toLowerCase();
        const guardianPhone = s(req.body?.guardianPhone, 40);
        const guardianConsent = truthy(req.body?.guardianConsent);
        if (guardianRequired) {
          if (!guardianName) errors.push("A parent or guardian's name is required.");
          if (!isEmail(guardianEmail)) errors.push("A parent or guardian's email is required.");
          if (!guardianPhone) errors.push("A parent or guardian's phone number is required.");
          if (!guardianConsent) errors.push("A parent or guardian needs to give consent.");
        }

        errors.push(...validateAnswers(questions, answers as Record<string, unknown>, { hasAuditionFile: !!file }));
        if (errors.length) return res.status(400).json({ message: errors[0], errors });

        // Only touch object storage once we know the application is good.
        let audition: { objectPath: string } | null = null;
        if (file) {
          const { ObjectStorageService } = await import("./replit_integrations/object_storage/objectStorage");
          const { setObjectAclPolicy } = await import("./replit_integrations/object_storage/objectAcl");
          const svc = new ObjectStorageService();
          const ext = (file.originalname.match(/\.([^.]+)$/) || [])[1]?.toLowerCase() || "bin";
          const upload = await svc.uploadBufferToUploads(file.buffer, file.mimetype || "application/octet-stream", ext);
          // Private, and owned by nobody who can log in: the only way back to
          // this file is the tab-gated admin endpoint below.
          await setObjectAclPolicy(upload.file, { owner: `hiring-job-${job.id}`, visibility: "private" });
          audition = { objectPath: upload.objectPath };
        }

        const auditionAnswerId = questions.find((q) => q.type === "file-or-url")?.id;
        const auditionUrl = auditionAnswerId ? (answers[auditionAnswerId] as string | undefined) : undefined;

        let created;
        try {
          [created] = await db.insert(hiringApplications).values({
            jobId: job.id,
            organizationId: job.organizationId,
            firstName, lastName: lastName || null, email, phone,
            dateOfBirth, city: city || null,
            guardianRequired,
            guardianName: guardianRequired ? guardianName : null,
            guardianRelationship: guardianRequired ? s(req.body?.guardianRelationship, 60) || null : null,
            guardianEmail: guardianRequired ? guardianEmail : null,
            guardianPhone: guardianRequired ? guardianPhone : null,
            guardianConsent: guardianRequired ? guardianConsent : false,
            answers,
            auditionUrl: typeof auditionUrl === "string" ? auditionUrl.slice(0, 500) : null,
            auditionObjectPath: audition?.objectPath ?? null,
            auditionFilename: file ? s(file.originalname, 200) : null,
            auditionMime: file ? s(file.mimetype, 100) : null,
            auditionBytes: file ? file.size : null,
            status: "new",
            consentContact: true,
            consentBroadcast: true,
            rightToWork: truthy(req.body?.rightToWork),
            sourceUrl: s(req.body?.sourceUrl, 500) || null,
            userAgent: s(req.headers["user-agent"], 400) || null,
          }).returning();
        } catch (e: any) {
          // hiring_applications_job_email_unq — they already applied.
          if (String(e?.code) === "23505") {
            return res.status(409).json({
              message: "You've already applied for this one. We have it — we'll be in touch.",
            });
          }
          throw e;
        }

        // Email is best-effort. A Resend outage must never lose an application.
        try {
          await sendHiringApplicationNotification({
            to: job.notifyEmail || undefined,
            jobTitle: job.title,
            jobSlug: job.slug,
            applicationId: created.id,
            applicantName: [firstName, lastName].filter(Boolean).join(" "),
            email, phone,
            city: city || undefined,
            guardianRequired,
            guardianName: guardianRequired ? guardianName : undefined,
            guardianPhone: guardianRequired ? guardianPhone : undefined,
            auditionUrl: typeof auditionUrl === "string" ? auditionUrl : undefined,
            hasAuditionFile: !!file,
            answers: answers as Record<string, string | boolean>,
            questions,
          });
        } catch (mailErr) {
          console.error("[hiring] notification email failed:", mailErr);
        }

        res.json({ ok: true, id: created.id });
      } catch (e: any) {
        console.error("[hiring] apply failed:", e);
        res.status(500).json({ message: "Something went wrong sending your application." });
      }
    },
  );

  async function findPublicJob(req: Request) {
    const brand = s(req.params.brand, 40).toLowerCase();
    const slug = s(req.params.slug, 120).toLowerCase();
    if (!brand || !slug) return null;
    const [job] = await db.select().from(hiringJobs)
      .where(and(eq(hiringJobs.brand, brand), eq(hiringJobs.slug, slug)));
    // A draft posting must not be reachable by guessing its slug.
    return job && job.status !== "draft" ? job : null;
  }

  // ═══════════════════════════ ADMIN ════════════════════════════════════════
  // Every admin route is gated by the session AND the "hiring" tab, then scoped
  // to the workspace's own org. Written out on each route rather than spread
  // from a shared array, which express's overloads don't type cleanly.
  const tab = requireTab("hiring");

  app.get("/api/admin/hiring/jobs", requireAuth, tab, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "X-Workspace-Slug header required" });
      const jobs = await db.select().from(hiringJobs)
        .where(eq(hiringJobs.organizationId, org.id))
        .orderBy(desc(hiringJobs.createdAt));

      // Application counts per job, in one query rather than N.
      const ids = jobs.map((j) => j.id);
      const apps = ids.length
        ? await db.select({ jobId: hiringApplications.jobId, status: hiringApplications.status })
            .from(hiringApplications).where(inArray(hiringApplications.jobId, ids))
        : [];

      res.json({
        jobs: jobs.map((j) => {
          const mine = apps.filter((a) => a.jobId === j.id);
          return {
            ...j,
            open: jobIsOpen(j),
            applicationCount: mine.length,
            newCount: mine.filter((a) => a.status === "new").length,
            hiredCount: mine.filter((a) => a.status === "hired").length,
          };
        }),
      });
    } catch (e: any) {
      console.error("[hiring] admin jobs failed:", e);
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/admin/hiring/jobs", requireAuth, tab, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "X-Workspace-Slug header required" });
      const title = s(req.body?.title, 160);
      const brand = s(req.body?.brand, 40).toLowerCase();
      const slug = s(req.body?.slug, 120).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
      if (!title) return res.status(400).json({ message: "A job title is required" });
      if (!brand) return res.status(400).json({ message: "A brand is required" });
      if (!slug) return res.status(400).json({ message: "A url slug is required" });

      const [created] = await db.insert(hiringJobs).values({
        organizationId: org.id,
        brand, slug, title,
        tagline: s(req.body?.tagline, 300) || null,
        description: s(req.body?.description, 8000) || null,
        employmentType: s(req.body?.employmentType, 80) || null,
        positions: Number.isFinite(Number(req.body?.positions)) ? Math.max(1, Number(req.body.positions)) : 1,
        payLabel: s(req.body?.payLabel, 120) || null,
        location: s(req.body?.location, 200) || null,
        status: isJobStatus(req.body?.status) ? req.body.status : "draft",
        closesAt: req.body?.closesAt ? new Date(req.body.closesAt) : null,
        advertUrl: s(req.body?.advertUrl, 500) || null,
        notifyEmail: s(req.body?.notifyEmail, 160) || null,
        questions: Array.isArray(req.body?.questions) ? req.body.questions.slice(0, HIRING_LIMITS.maxQuestions) : [],
        createdBy: req.session.userId!,
      }).returning();
      res.status(201).json(created);
    } catch (e: any) {
      if (String(e?.code) === "23505") return res.status(409).json({ message: "That brand already has a job with this slug." });
      console.error("[hiring] create job failed:", e);
      res.status(500).json({ message: e.message });
    }
  });

  app.patch("/api/admin/hiring/jobs/:id", requireAuth, tab, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      const id = parseInt(String(req.params.id), 10);
      if (!org || !Number.isFinite(id)) return res.status(400).json({ message: "Bad request" });

      const patch: Record<string, any> = { updatedAt: new Date() };
      if (req.body.title !== undefined) {
        const t = s(req.body.title, 160);
        if (!t) return res.status(400).json({ message: "Title can't be blank" });
        patch.title = t;
      }
      if (req.body.tagline !== undefined) patch.tagline = s(req.body.tagline, 300) || null;
      if (req.body.description !== undefined) patch.description = s(req.body.description, 8000) || null;
      if (req.body.employmentType !== undefined) patch.employmentType = s(req.body.employmentType, 80) || null;
      if (req.body.payLabel !== undefined) patch.payLabel = s(req.body.payLabel, 120) || null;
      if (req.body.location !== undefined) patch.location = s(req.body.location, 200) || null;
      if (req.body.advertUrl !== undefined) patch.advertUrl = s(req.body.advertUrl, 500) || null;
      if (req.body.notifyEmail !== undefined) patch.notifyEmail = s(req.body.notifyEmail, 160) || null;
      if (req.body.positions !== undefined && Number.isFinite(Number(req.body.positions))) {
        patch.positions = Math.max(1, Number(req.body.positions));
      }
      if (req.body.status !== undefined) {
        if (!isJobStatus(req.body.status)) return res.status(400).json({ message: `Status must be one of ${JOB_STATUSES.join(", ")}` });
        patch.status = req.body.status;
      }
      if (req.body.closesAt !== undefined) patch.closesAt = req.body.closesAt ? new Date(req.body.closesAt) : null;
      if (Array.isArray(req.body.questions)) patch.questions = req.body.questions.slice(0, HIRING_LIMITS.maxQuestions);

      const [updated] = await db.update(hiringJobs).set(patch)
        .where(and(eq(hiringJobs.id, id), eq(hiringJobs.organizationId, org.id)))
        .returning();
      if (!updated) return res.status(404).json({ message: "Job not found" });
      res.json(updated);
    } catch (e: any) {
      console.error("[hiring] update job failed:", e);
      res.status(500).json({ message: e.message });
    }
  });

  app.delete("/api/admin/hiring/jobs/:id", requireAuth, tab, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      const id = parseInt(String(req.params.id), 10);
      if (!org || !Number.isFinite(id)) return res.status(400).json({ message: "Bad request" });

      // Deleting a job cascades its applications. Refuse if anyone applied —
      // close it instead. Losing a real person's application to a stray click
      // is not a recoverable mistake.
      const anyApplicants = await db.select({ id: hiringApplications.id }).from(hiringApplications)
        .where(eq(hiringApplications.jobId, id)).limit(1);
      if (anyApplicants.length) {
        return res.status(409).json({ message: "This job has applications. Close it instead of deleting it." });
      }

      const [deleted] = await db.delete(hiringJobs)
        .where(and(eq(hiringJobs.id, id), eq(hiringJobs.organizationId, org.id))).returning();
      if (!deleted) return res.status(404).json({ message: "Job not found" });
      res.json({ ok: true });
    } catch (e: any) {
      console.error("[hiring] delete job failed:", e);
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/admin/hiring/applications", requireAuth, tab, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "X-Workspace-Slug header required" });
      const jobId = parseInt(String(req.query.jobId ?? ""), 10);

      const where = Number.isFinite(jobId)
        ? and(eq(hiringApplications.organizationId, org.id), eq(hiringApplications.jobId, jobId))
        : eq(hiringApplications.organizationId, org.id);

      const rows = await db
        .select({
          app: hiringApplications,
          jobTitle: hiringJobs.title,
          jobSlug: hiringJobs.slug,
          reviewerFirst: usersTable.firstName,
          reviewerLast: usersTable.lastName,
        })
        .from(hiringApplications)
        .innerJoin(hiringJobs, eq(hiringApplications.jobId, hiringJobs.id))
        .leftJoin(usersTable, eq(hiringApplications.reviewedBy, usersTable.id))
        .where(where)
        .orderBy(desc(hiringApplications.createdAt));

      res.json({
        applications: rows.map((r) => {
          // The storage path is an internal detail; the client only ever hits
          // the /audition endpoint, which re-checks the tab and the org.
          const { auditionObjectPath, ...app } = r.app;
          return {
            ...app,
            jobTitle: r.jobTitle,
            jobSlug: r.jobSlug,
            reviewerName: [r.reviewerFirst, r.reviewerLast].filter(Boolean).join(" ") || null,
            hasAuditionFile: !!auditionObjectPath,
          };
        }),
      });
    } catch (e: any) {
      console.error("[hiring] list applications failed:", e);
      res.status(500).json({ message: e.message });
    }
  });

  app.patch("/api/admin/hiring/applications/:id", requireAuth, tab, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      const id = parseInt(String(req.params.id), 10);
      if (!org || !Number.isFinite(id)) return res.status(400).json({ message: "Bad request" });

      const patch: Record<string, any> = { updatedAt: new Date() };
      if (req.body.status !== undefined) {
        if (!isApplicationStatus(req.body.status)) {
          return res.status(400).json({ message: `Status must be one of ${APPLICATION_STATUSES.join(", ")}` });
        }
        patch.status = req.body.status;
        patch.reviewedBy = req.session.userId!;
        patch.decidedAt = CLOSED_APPLICATION_STATUSES.has(req.body.status) ? new Date() : null;
      }
      if (req.body.rating !== undefined) {
        const r = Number(req.body.rating);
        if (req.body.rating === null || req.body.rating === "") patch.rating = null;
        else if (!Number.isInteger(r) || r < 1 || r > 5) return res.status(400).json({ message: "Rating must be 1–5" });
        else patch.rating = r;
      }
      if (req.body.reviewerNotes !== undefined) patch.reviewerNotes = s(req.body.reviewerNotes, 4000) || null;

      const [updated] = await db.update(hiringApplications).set(patch)
        .where(and(eq(hiringApplications.id, id), eq(hiringApplications.organizationId, org.id)))
        .returning();
      if (!updated) return res.status(404).json({ message: "Application not found" });
      const { auditionObjectPath, ...safe } = updated;
      res.json({ ...safe, hasAuditionFile: !!auditionObjectPath });
    } catch (e: any) {
      console.error("[hiring] update application failed:", e);
      res.status(500).json({ message: e.message });
    }
  });

  app.delete("/api/admin/hiring/applications/:id", requireAuth, tab, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      const id = parseInt(String(req.params.id), 10);
      if (!org || !Number.isFinite(id)) return res.status(400).json({ message: "Bad request" });
      const [deleted] = await db.delete(hiringApplications)
        .where(and(eq(hiringApplications.id, id), eq(hiringApplications.organizationId, org.id))).returning();
      if (!deleted) return res.status(404).json({ message: "Application not found" });
      res.json({ ok: true });
    } catch (e: any) {
      console.error("[hiring] delete application failed:", e);
      res.status(500).json({ message: e.message });
    }
  });

  // Stream the uploaded audition to a reviewer.
  //
  // Deliberately NOT the /objects/ ACL route: that grants access only to the
  // file's `owner`, which for an applicant upload is nobody who can log in, so
  // every staff member would get a 403. Authorisation here is the hiring tab
  // plus the org on the application row. We hand back a short-lived Supabase
  // signed URL rather than proxying the bytes, so the browser gets range
  // requests (scrubbing works) and a 60 MB video never sits in the app's memory.
  app.get("/api/admin/hiring/applications/:id/audition", requireAuth, tab, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      const id = parseInt(String(req.params.id), 10);
      if (!org || !Number.isFinite(id)) return res.status(400).json({ message: "Bad request" });

      const [row] = await db.select().from(hiringApplications)
        .where(and(eq(hiringApplications.id, id), eq(hiringApplications.organizationId, org.id)));
      if (!row) return res.status(404).json({ message: "Application not found" });
      if (!row.auditionObjectPath) return res.status(404).json({ message: "No audition file was uploaded" });

      const { objectStorageClient } = await import("./replit_integrations/object_storage/objectStorage");
      const storagePath = row.auditionObjectPath.replace(/^\/objects\//, "");
      const { data, error } = await objectStorageClient.storage
        .from(BUCKET)
        .createSignedUrl(storagePath, 60 * 60, req.query.download ? { download: row.auditionFilename || true } : undefined);
      if (error || !data?.signedUrl) {
        console.error("[hiring] signed url failed:", error);
        return res.status(500).json({ message: "Couldn't open that audition file." });
      }
      res.redirect(data.signedUrl);
    } catch (e: any) {
      console.error("[hiring] audition failed:", e);
      res.status(500).json({ message: e.message });
    }
  });
}
