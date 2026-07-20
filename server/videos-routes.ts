// ─────────────────────────────────────────────────────────────────────────────
// STAFF VIDEOS — the in-house Loom. USG (group) workspace, tab "videos".
//
//   POST /api/admin/videos/uploads            create an upload session (basic or tus)
//   POST /api/admin/videos/:id/uploaded       client finished uploading → poll Stream
//   GET  /api/admin/videos?scope=mine|all     library
//   GET  /api/admin/videos/:id                detail (refreshes from Stream until ready)
//   GET  /api/admin/videos/:id/insights       views/uniques/watch-through/viewers/comments
//   PATCH /api/admin/videos/:id               title/description/visibility/toggles
//   DELETE /api/admin/videos/:id[?forever=1]  soft delete; forever also frees Stream quota
//   POST /api/admin/videos/:id/trim           Stream clip API — share token survives the trim
//   POST /api/admin/videos/:id/captions       generate English captions
//   POST /api/admin/videos/:id/download       create/poll the MP4 download
//
//   GET  /api/public/videos/:token            share-page payload (visibility-gated)
//   POST /api/public/videos/:token/events     view/play/milestone (anonymous viewer cookie)
//   POST /api/public/videos/:token/comments   comments + emoji reactions (rate-limited)
//
// Videos live on Cloudflare Stream (same account as the OTT vaults). The public
// share id is a random token — /v/{token} — because a staff recording may show
// internal systems, so the set of videos must not be enumerable. Trims swap
// stream_uid IN PLACE: the link a video was shared under keeps working after a
// trim, and the superseded Stream asset is deleted to free storage quota.
// Staff opens (any logged-in session) are flagged is_staff and excluded from
// headline analytics — the house rule from invoice pages and sponsor traffic.
// ─────────────────────────────────────────────────────────────────────────────
import type { Express, Request, Response } from "express";
import { randomBytes } from "crypto";
import { and, desc, eq, isNull, sql as dsql } from "drizzle-orm";
import { db } from "./db";
import { requireAuth, requireTab } from "./auth";
import { organizations, staffVideos, staffVideoComments, staffVideoEvents, users } from "@shared/schema";

const CF_ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || "";
const CF_TOKEN = process.env.CLOUDFLARE_STREAM_TOKEN || "";
const CF_CUSTOMER = process.env.CLOUDFLARE_STREAM_CUSTOMER || "customer-cmfpri2ovjthkmgr";
const CF_API = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}`;
// Above this size the basic direct-upload URL 4xxes (Cloudflare caps it at
// 200MB) — the client must use the resumable tus session instead.
const BASIC_UPLOAD_LIMIT = 190 * 1024 * 1024;
const MAX_DURATION_SECONDS = 6 * 3600; // Stream requires a ceiling on direct uploads; 6h ≫ any tutorial

class BadRequest extends Error {}
class NotFound extends Error {}
class Forbidden extends Error {}
/** Cloudflare error 10011 — the shared Stream account is out of storage minutes. */
class StorageFull extends Error {}

function fail(res: Response, err: unknown): void {
  if (err instanceof BadRequest) res.status(400).json({ error: err.message });
  else if (err instanceof Forbidden) res.status(403).json({ error: err.message || "Not allowed" });
  else if (err instanceof NotFound) res.status(404).json({ error: err.message || "Not found" });
  else if (err instanceof StorageFull)
    res.status(507).json({
      error: "storage_full",
      message:
        "The Cloudflare Stream account is out of storage minutes — buy more minutes (or delete old videos) and try again.",
    });
  else {
    console.error("[videos]", err);
    res.status(500).json({ error: "Something went wrong" });
  }
}

// ── Org scoping (mirrors workspaceOrg in routes.ts, which isn't exported) ─────
async function workspaceOrg(req: Request): Promise<{ id: number; slug: string } | null> {
  const slug = String(req.headers["x-workspace-slug"] || "").trim();
  if (!slug) return null;
  const [org] = await db.select().from(organizations).where(eq(organizations.slug, slug));
  return org ? { id: org.id, slug: org.slug } : null;
}

const str = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return s.length ? s : null;
};
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** URL-safe random share token, 12 chars — non-enumerable by construction. */
function newToken(): string {
  return randomBytes(9).toString("base64url");
}

function deviceFrom(ua: string): string {
  if (/ipad|tablet/i.test(ua)) return "tablet";
  if (/mobi|iphone|android/i.test(ua)) return "mobile";
  return "desktop";
}

async function cf(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${CF_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${CF_TOKEN}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || body?.success === false) {
    const codes: number[] = (body?.errors || []).map((e: any) => e.code);
    const msg = (body?.errors || []).map((e: any) => e.message).join("; ") || `HTTP ${res.status}`;
    if (codes.includes(10011) || /storage capacity exceeded/i.test(msg)) throw new StorageFull(msg);
    throw new Error(`Cloudflare Stream: ${msg}`);
  }
  return body;
}

function manifestUrl(uid: string): string {
  return `https://${CF_CUSTOMER}.cloudflarestream.com/${uid}/manifest/video.m3u8`;
}
function thumbUrl(uid: string): string {
  return `https://${CF_CUSTOMER}.cloudflarestream.com/${uid}/thumbnails/thumbnail.jpg?time=1s&height=540`;
}
function animatedThumbUrl(uid: string): string {
  // Animated previews don't count against delivered minutes — free hover previews.
  return `https://${CF_CUSTOMER}.cloudflarestream.com/${uid}/thumbnails/thumbnail.gif?time=1s&height=270&duration=4s`;
}

type VideoRow = typeof staffVideos.$inferSelect;

async function loadVideo(id: number, orgId: number): Promise<VideoRow> {
  const [row] = await db
    .select()
    .from(staffVideos)
    .where(and(eq(staffVideos.id, id), eq(staffVideos.organizationId, orgId), isNull(staffVideos.deletedAt)));
  if (!row) throw new NotFound("Video not found");
  return row;
}

async function isSuperAdmin(userId: number): Promise<boolean> {
  const [u] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId));
  return u?.role === "super_admin";
}

async function requireOwnership(row: VideoRow, userId: number): Promise<void> {
  if (row.createdBy === userId) return;
  if (await isSuperAdmin(userId)) return;
  throw new Forbidden("Only the video's owner can do that");
}

/** Poll Cloudflare for the latest state of this row's Stream asset and persist
 *  what changed. Also completes an in-flight trim (deletes the superseded
 *  asset once the clip is ready) and tracks caption generation. */
async function refreshFromStream(row: VideoRow): Promise<VideoRow> {
  if (!row.streamUid) return row;
  let details: any;
  try {
    details = await cf(`/stream/${row.streamUid}`);
  } catch (e) {
    if (e instanceof StorageFull) throw e;
    return row; // transient CF hiccup — keep our last known state
  }
  const r = details.result || {};
  const state: string = r.status?.state || "";
  const patch: Partial<VideoRow> = {};

  if (state === "ready" && r.readyToStream) {
    patch.status = "ready";
    if (typeof r.duration === "number" && r.duration > 0) patch.durationSeconds = r.duration;
    if (r.input?.width) patch.width = r.input.width;
    if (r.input?.height) patch.height = r.input.height;
    if (typeof r.size === "number" && r.size > 0) patch.sizeBytes = r.size;
    patch.thumbnailUrl = thumbUrl(row.streamUid);
    patch.playbackHlsUrl = r.playback?.hls || manifestUrl(row.streamUid);
    // A trim was in flight and its clip is now ready → the old asset is
    // superseded. Delete it from Stream to free storage minutes.
    if (row.prevStreamUid && row.prevStreamUid !== row.streamUid) {
      await cf(`/stream/${row.prevStreamUid}`, { method: "DELETE" }).catch(() => undefined);
      patch.prevStreamUid = null as any;
    }
  } else if (state === "error") {
    // A failed CLIP must not destroy the original video: fall back to it.
    if (row.prevStreamUid) {
      await cf(`/stream/${row.streamUid}`, { method: "DELETE" }).catch(() => undefined);
      patch.streamUid = row.prevStreamUid;
      patch.prevStreamUid = null as any;
      patch.status = "ready";
    } else {
      patch.status = "error";
    }
  } else if (state && row.status === "uploading") {
    patch.status = "processing";
  }

  // Caption generation in flight?
  if (row.captionsStatus === "inprogress") {
    try {
      const caps = await cf(`/stream/${row.streamUid}/captions`);
      const en = (caps.result || []).find((c: any) => String(c.language).startsWith("en"));
      if (en?.status === "ready" || (en && en.status === undefined)) patch.captionsStatus = "ready";
      else if (en?.status === "error") patch.captionsStatus = "error";
    } catch {
      /* keep polling next time */
    }
  }

  if (Object.keys(patch).length === 0) return row;
  (patch as any).updatedAt = new Date();
  const [updated] = await db.update(staffVideos).set(patch as any).where(eq(staffVideos.id, row.id)).returning();
  return updated || row;
}

function publicShape(row: VideoRow, ownerName: string | null) {
  return {
    token: row.token,
    title: row.title,
    description: row.description,
    ownerName,
    status: row.status,
    durationSeconds: row.durationSeconds,
    thumbnailUrl: row.thumbnailUrl,
    playbackUrl: row.status === "ready" && row.streamUid ? row.playbackHlsUrl || manifestUrl(row.streamUid) : null,
    downloadUrl: row.allowDownload ? row.downloadUrl : null,
    allowComments: row.allowComments,
    captionsReady: row.captionsStatus === "ready",
    viewCount: row.viewCount,
    createdAt: row.createdAt,
  };
}

// ── Public comment/event rate limiting (per IP, in-memory) ───────────────────
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
function rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const b = rateBuckets.get(key);
  if (!b || b.resetAt < now) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  b.count += 1;
  return b.count <= max;
}

const VIEWER_COOKIE = "usg_vv";
function viewerKey(req: Request, res: Response): string {
  const existing = req.cookies?.[VIEWER_COOKIE];
  if (typeof existing === "string" && /^[a-f0-9]{32}$/.test(existing)) return existing;
  const key = randomBytes(16).toString("hex");
  res.cookie(VIEWER_COOKIE, key, {
    maxAge: 365 * 24 * 3600 * 1000,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
  return key;
}

export function registerVideoRoutes(app: Express): void {
  // ── Create an upload session ───────────────────────────────────────────────
  app.post("/api/admin/videos/uploads", requireAuth, requireTab("videos"), async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) throw new BadRequest("Unknown workspace");
      const userId = (req.session as any).userId as number;
      const title = str(req.body?.title) || "Untitled video";
      const source = str(req.body?.source) === "upload" ? "upload" : "recording";
      const sizeBytes = num(req.body?.sizeBytes);

      let uid: string;
      let uploadURL: string;
      let kind: "basic" | "tus";

      if (sizeBytes !== null && sizeBytes > BASIC_UPLOAD_LIMIT) {
        // Resumable tus session: the server creates it (the API token never
        // reaches the browser); the client PATCHes chunks straight to Cloudflare.
        kind = "tus";
        const metaName = Buffer.from(title).toString("base64");
        const tusRes = await fetch(`${CF_API}/stream?direct_user=true`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${CF_TOKEN}`,
            "Tus-Resumable": "1.0.0",
            "Upload-Length": String(sizeBytes),
            "Upload-Metadata": `name ${metaName},maxDurationSeconds ${Buffer.from(String(MAX_DURATION_SECONDS)).toString("base64")}`,
          },
        });
        if (!tusRes.ok) {
          const text = await tusRes.text().catch(() => "");
          if (/storage capacity exceeded|10011/i.test(text)) throw new StorageFull(text);
          throw new Error(`Cloudflare tus create failed: HTTP ${tusRes.status} ${text.slice(0, 200)}`);
        }
        uploadURL = tusRes.headers.get("location") || "";
        uid = tusRes.headers.get("stream-media-id") || "";
        if (!uploadURL || !uid) throw new Error("Cloudflare tus create returned no location/uid");
      } else {
        kind = "basic";
        const created = await cf(`/stream/direct_upload`, {
          method: "POST",
          body: JSON.stringify({
            maxDurationSeconds: MAX_DURATION_SECONDS,
            meta: { name: title },
          }),
        });
        uid = created.result.uid;
        uploadURL = created.result.uploadURL;
      }

      const [row] = await db
        .insert(staffVideos)
        .values({
          organizationId: org.id,
          createdBy: userId,
          token: newToken(),
          title,
          streamUid: uid,
          status: "uploading",
          source,
          sizeBytes: sizeBytes ?? undefined,
        })
        .returning();

      res.json({ id: row.id, token: row.token, uid, kind, uploadURL });
    } catch (e) {
      fail(res, e);
    }
  });

  // ── Client finished pushing bytes ──────────────────────────────────────────
  app.post("/api/admin/videos/:id/uploaded", requireAuth, requireTab("videos"), async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) throw new BadRequest("Unknown workspace");
      let row = await loadVideo(Number(req.params.id), org.id);
      await requireOwnership(row, (req.session as any).userId);
      if (row.status === "uploading") {
        const clientDuration = num(req.body?.durationSeconds);
        const [u] = await db
          .update(staffVideos)
          .set({ status: "processing", durationSeconds: clientDuration ?? row.durationSeconds, updatedAt: new Date() })
          .where(eq(staffVideos.id, row.id))
          .returning();
        row = u;
      }
      row = await refreshFromStream(row);
      res.json({ id: row.id, status: row.status });
    } catch (e) {
      fail(res, e);
    }
  });

  // ── Library ────────────────────────────────────────────────────────────────
  app.get("/api/admin/videos", requireAuth, requireTab("videos"), async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) throw new BadRequest("Unknown workspace");
      const userId = (req.session as any).userId as number;
      const scope = req.query.scope === "mine" ? "mine" : "all";
      const where =
        scope === "mine"
          ? and(eq(staffVideos.organizationId, org.id), isNull(staffVideos.deletedAt), eq(staffVideos.createdBy, userId))
          : and(eq(staffVideos.organizationId, org.id), isNull(staffVideos.deletedAt));
      const rows = await db
        .select({
          video: staffVideos,
          ownerFirst: users.firstName,
          ownerLast: users.lastName,
          ownerEmail: users.email,
        })
        .from(staffVideos)
        .leftJoin(users, eq(users.id, staffVideos.createdBy))
        .where(where)
        .orderBy(desc(staffVideos.createdAt))
        .limit(500);
      res.json(
        rows.map(({ video: v, ownerFirst, ownerLast, ownerEmail }) => ({
          id: v.id,
          token: v.token,
          title: v.title,
          status: v.status,
          source: v.source,
          visibility: v.visibility,
          durationSeconds: v.durationSeconds,
          thumbnailUrl: v.thumbnailUrl,
          animatedThumbUrl: v.status === "ready" && v.streamUid ? animatedThumbUrl(v.streamUid) : null,
          viewCount: v.viewCount,
          ownerName: [ownerFirst, ownerLast].filter(Boolean).join(" ") || ownerEmail || "—",
          mine: v.createdBy === userId,
          createdAt: v.createdAt,
        })),
      );
    } catch (e) {
      fail(res, e);
    }
  });

  // ── Detail ─────────────────────────────────────────────────────────────────
  app.get("/api/admin/videos/:id", requireAuth, requireTab("videos"), async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) throw new BadRequest("Unknown workspace");
      let row = await loadVideo(Number(req.params.id), org.id);
      if (row.status !== "ready" || row.captionsStatus === "inprogress") row = await refreshFromStream(row);
      const userId = (req.session as any).userId as number;
      const [owner] = await db
        .select({ firstName: users.firstName, lastName: users.lastName, email: users.email })
        .from(users)
        .where(eq(users.id, row.createdBy));
      const ownerName = owner ? [owner.firstName, owner.lastName].filter(Boolean).join(" ") || owner.email : "—";
      res.json({
        id: row.id,
        token: row.token,
        title: row.title,
        description: row.description,
        status: row.status,
        source: row.source,
        visibility: row.visibility,
        allowDownload: row.allowDownload,
        allowComments: row.allowComments,
        durationSeconds: row.durationSeconds,
        width: row.width,
        height: row.height,
        sizeBytes: row.sizeBytes,
        thumbnailUrl: row.thumbnailUrl,
        playbackUrl: row.status === "ready" && row.streamUid ? row.playbackHlsUrl || manifestUrl(row.streamUid) : null,
        downloadUrl: row.downloadUrl,
        captionsStatus: row.captionsStatus,
        viewCount: row.viewCount,
        trimming: !!row.prevStreamUid,
        ownerName,
        mine: row.createdBy === userId,
        createdAt: row.createdAt,
      });
    } catch (e) {
      fail(res, e);
    }
  });

  // ── Insights ───────────────────────────────────────────────────────────────
  app.get("/api/admin/videos/:id/insights", requireAuth, requireTab("videos"), async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) throw new BadRequest("Unknown workspace");
      const row = await loadVideo(Number(req.params.id), org.id);

      // External (non-staff) analytics only — staff opens are recorded but
      // never counted, same as invoice pages and sponsor traffic.
      const [totals] = await db
        .select({
          views: dsql<number>`count(*) filter (where kind = 'view' and not is_staff)`,
          uniques: dsql<number>`count(distinct viewer_key) filter (where kind = 'view' and not is_staff)`,
          staffViews: dsql<number>`count(*) filter (where kind = 'view' and is_staff)`,
        })
        .from(staffVideoEvents)
        .where(eq(staffVideoEvents.videoId, row.id));

      // Watch-through: each viewer's best milestone, averaged.
      const perViewer = await db
        .select({
          viewerKey: staffVideoEvents.viewerKey,
          bestPercent: dsql<number>`max(coalesce(percent, 0))`,
          lastSeen: dsql<string>`max(created_at)`,
          device: dsql<string>`max(device)`,
        })
        .from(staffVideoEvents)
        .where(and(eq(staffVideoEvents.videoId, row.id), dsql`not is_staff`, dsql`viewer_key is not null`))
        .groupBy(staffVideoEvents.viewerKey)
        .orderBy(dsql`max(created_at) desc`)
        .limit(100);

      const byDay = await db
        .select({
          day: dsql<string>`to_char(created_at, 'YYYY-MM-DD')`,
          views: dsql<number>`count(*)`,
        })
        .from(staffVideoEvents)
        .where(
          and(
            eq(staffVideoEvents.videoId, row.id),
            eq(staffVideoEvents.kind, "view"),
            dsql`not is_staff`,
            dsql`created_at > now() - interval '30 days'`,
          ),
        )
        .groupBy(dsql`to_char(created_at, 'YYYY-MM-DD')`)
        .orderBy(dsql`to_char(created_at, 'YYYY-MM-DD')`);

      const comments = await db
        .select()
        .from(staffVideoComments)
        .where(eq(staffVideoComments.videoId, row.id))
        .orderBy(desc(staffVideoComments.createdAt))
        .limit(200);

      const watched = perViewer.map((v) => Number(v.bestPercent) || 0);
      res.json({
        views: Number(totals?.views || 0),
        uniques: Number(totals?.uniques || 0),
        staffViews: Number(totals?.staffViews || 0),
        avgWatchPercent: watched.length ? Math.round(watched.reduce((a, b) => a + b, 0) / watched.length) : null,
        viewers: perViewer.map((v, i) => ({
          label: `Viewer ${i + 1}`,
          bestPercent: Number(v.bestPercent) || 0,
          lastSeen: v.lastSeen,
          device: v.device,
        })),
        byDay,
        comments: comments.map((c) => ({
          id: c.id,
          authorName: c.authorName,
          body: c.body,
          emoji: c.emoji,
          atSeconds: c.atSeconds,
          isStaff: c.isStaff,
          createdAt: c.createdAt,
        })),
      });
    } catch (e) {
      fail(res, e);
    }
  });

  // ── Edit metadata ──────────────────────────────────────────────────────────
  app.patch("/api/admin/videos/:id", requireAuth, requireTab("videos"), async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) throw new BadRequest("Unknown workspace");
      const row = await loadVideo(Number(req.params.id), org.id);
      await requireOwnership(row, (req.session as any).userId);

      const patch: Record<string, unknown> = {};
      const title = str(req.body?.title);
      if (title) patch.title = title.slice(0, 300);
      if (req.body?.description !== undefined) patch.description = str(req.body.description);
      const visibility = str(req.body?.visibility);
      if (visibility) {
        if (!["link", "staff", "private"].includes(visibility)) throw new BadRequest("visibility must be link, staff or private");
        patch.visibility = visibility;
      }
      if (typeof req.body?.allowDownload === "boolean") patch.allowDownload = req.body.allowDownload;
      if (typeof req.body?.allowComments === "boolean") patch.allowComments = req.body.allowComments;
      if (!Object.keys(patch).length) throw new BadRequest("Nothing to update");
      patch.updatedAt = new Date();

      const [updated] = await db.update(staffVideos).set(patch as any).where(eq(staffVideos.id, row.id)).returning();
      res.json({ id: updated.id, title: updated.title, visibility: updated.visibility });
    } catch (e) {
      fail(res, e);
    }
  });

  // ── Delete (soft; ?forever=1 also frees the Stream asset) ──────────────────
  app.delete("/api/admin/videos/:id", requireAuth, requireTab("videos"), async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) throw new BadRequest("Unknown workspace");
      const row = await loadVideo(Number(req.params.id), org.id);
      await requireOwnership(row, (req.session as any).userId);
      const forever = req.query.forever === "1";
      if (forever && row.streamUid) {
        await cf(`/stream/${row.streamUid}`, { method: "DELETE" }).catch(() => undefined);
        if (row.prevStreamUid) await cf(`/stream/${row.prevStreamUid}`, { method: "DELETE" }).catch(() => undefined);
      }
      await db
        .update(staffVideos)
        .set({
          deletedAt: new Date(),
          updatedAt: new Date(),
          ...(forever ? { streamUid: null as any, prevStreamUid: null as any, playbackHlsUrl: null as any } : {}),
        })
        .where(eq(staffVideos.id, row.id));
      res.json({ ok: true, freedStorage: forever });
    } catch (e) {
      fail(res, e);
    }
  });

  // ── Trim (Stream clip API — the share link survives) ──────────────────────
  app.post("/api/admin/videos/:id/trim", requireAuth, requireTab("videos"), async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) throw new BadRequest("Unknown workspace");
      const row = await loadVideo(Number(req.params.id), org.id);
      await requireOwnership(row, (req.session as any).userId);
      if (row.status !== "ready" || !row.streamUid) throw new BadRequest("Video must be ready before trimming");
      if (row.prevStreamUid) throw new BadRequest("A trim is already in progress");

      const start = num(req.body?.startSeconds);
      const end = num(req.body?.endSeconds);
      const dur = row.durationSeconds || 0;
      if (start === null || end === null || start < 0 || end <= start || (dur > 0 && end > dur + 1)) {
        throw new BadRequest("Pick a valid start and end inside the video");
      }
      if (end - start < 1) throw new BadRequest("The trimmed video would be under a second long");

      const clip = await cf(`/stream/clip`, {
        method: "POST",
        body: JSON.stringify({
          clippedFromVideoUID: row.streamUid,
          startTimeSeconds: Math.floor(start),
          endTimeSeconds: Math.ceil(end),
          meta: { name: row.title },
        }),
      });
      const clipUid = clip.result?.uid;
      if (!clipUid) throw new Error("Cloudflare clip API returned no uid");

      await db
        .update(staffVideos)
        .set({
          prevStreamUid: row.streamUid,
          streamUid: clipUid,
          status: "processing",
          captionsStatus: null as any, // captions belong to the old asset
          downloadUrl: null as any,
          updatedAt: new Date(),
        })
        .where(eq(staffVideos.id, row.id));
      res.json({ ok: true, status: "processing" });
    } catch (e) {
      fail(res, e);
    }
  });

  // ── Generate captions ──────────────────────────────────────────────────────
  app.post("/api/admin/videos/:id/captions", requireAuth, requireTab("videos"), async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) throw new BadRequest("Unknown workspace");
      const row = await loadVideo(Number(req.params.id), org.id);
      await requireOwnership(row, (req.session as any).userId);
      if (row.status !== "ready" || !row.streamUid) throw new BadRequest("Video must be ready first");
      await cf(`/stream/${row.streamUid}/captions/en/generate`, { method: "POST" });
      await db.update(staffVideos).set({ captionsStatus: "inprogress", updatedAt: new Date() }).where(eq(staffVideos.id, row.id));
      res.json({ ok: true, captionsStatus: "inprogress" });
    } catch (e) {
      fail(res, e);
    }
  });

  // ── MP4 download (create + poll in one endpoint) ──────────────────────────
  app.post("/api/admin/videos/:id/download", requireAuth, requireTab("videos"), async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) throw new BadRequest("Unknown workspace");
      const row = await loadVideo(Number(req.params.id), org.id);
      if (row.status !== "ready" || !row.streamUid) throw new BadRequest("Video must be ready first");
      const created = await cf(`/stream/${row.streamUid}/downloads`, { method: "POST" });
      const dl = created.result?.default;
      if (dl?.status === "ready" && dl?.url && row.downloadUrl !== dl.url) {
        await db.update(staffVideos).set({ downloadUrl: dl.url, updatedAt: new Date() }).where(eq(staffVideos.id, row.id));
      }
      res.json({ status: dl?.status || "inprogress", url: dl?.status === "ready" ? dl.url : null, percent: dl?.percentComplete ?? null });
    } catch (e) {
      fail(res, e);
    }
  });

  // ═══ PUBLIC — the share page ════════════════════════════════════════════════

  app.get("/api/public/videos/:token", async (req, res) => {
    try {
      const token = String(req.params.token || "");
      const [row] = await db
        .select()
        .from(staffVideos)
        .where(and(eq(staffVideos.token, token), isNull(staffVideos.deletedAt)));
      if (!row) throw new NotFound("This video doesn't exist or was deleted");

      const sessionUserId = (req.session as any)?.userId as number | undefined;
      if (row.visibility === "staff" && !sessionUserId) {
        res.status(401).json({ error: "staff_only", message: "Sign in to ClubOS to watch this video." });
        return;
      }
      if (row.visibility === "private") {
        const ok = sessionUserId && (sessionUserId === row.createdBy || (await isSuperAdmin(sessionUserId)));
        if (!ok) {
          res.status(403).json({ error: "private", message: "This video is private." });
          return;
        }
      }

      let fresh = row;
      if (row.status !== "ready") fresh = await refreshFromStream(row);
      const [owner] = await db
        .select({ firstName: users.firstName, lastName: users.lastName, email: users.email })
        .from(users)
        .where(eq(users.id, fresh.createdBy));
      const ownerName = owner ? [owner.firstName, owner.lastName].filter(Boolean).join(" ") || owner.email : null;

      const comments = fresh.allowComments
        ? await db
            .select()
            .from(staffVideoComments)
            .where(eq(staffVideoComments.videoId, fresh.id))
            .orderBy(staffVideoComments.createdAt)
            .limit(200)
        : [];
      const reactions: Record<string, number> = {};
      const pins: Array<{ emoji: string; atSeconds: number }> = [];
      for (const c of comments) {
        if (c.emoji && !c.body) {
          reactions[c.emoji] = (reactions[c.emoji] || 0) + 1;
          if (c.atSeconds !== null && c.atSeconds !== undefined) pins.push({ emoji: c.emoji, atSeconds: c.atSeconds });
        }
      }

      res.json({
        ...publicShape(fresh, ownerName),
        reactions,
        reactionPins: pins.slice(-50),
        comments: comments
          .filter((c) => c.body)
          .map((c) => ({
            id: c.id,
            authorName: c.authorName || "Someone",
            body: c.body,
            atSeconds: c.atSeconds,
            isStaff: c.isStaff,
            createdAt: c.createdAt,
          })),
      });
    } catch (e) {
      fail(res, e);
    }
  });

  app.post("/api/public/videos/:token/events", async (req, res) => {
    try {
      const token = String(req.params.token || "");
      const [row] = await db
        .select({ id: staffVideos.id, viewCount: staffVideos.viewCount })
        .from(staffVideos)
        .where(and(eq(staffVideos.token, token), isNull(staffVideos.deletedAt)));
      if (!row) throw new NotFound();

      const kind = String(req.body?.kind || "");
      if (!["view", "play", "milestone"].includes(kind)) throw new BadRequest("bad kind");
      const key = viewerKey(req, res);
      const isStaff = !!(req.session as any)?.userId;
      const percent = num(req.body?.percent);

      if (kind === "view") {
        // one view per viewer per hour
        const [dup] = await db
          .select({ id: staffVideoEvents.id })
          .from(staffVideoEvents)
          .where(
            and(
              eq(staffVideoEvents.videoId, row.id),
              eq(staffVideoEvents.kind, "view"),
              eq(staffVideoEvents.viewerKey, key),
              dsql`created_at > now() - interval '1 hour'`,
            ),
          )
          .limit(1);
        if (dup) {
          res.json({ ok: true, deduped: true });
          return;
        }
      }

      await db.insert(staffVideoEvents).values({
        videoId: row.id,
        kind,
        viewerKey: key,
        percent: percent !== null ? Math.max(0, Math.min(100, Math.round(percent))) : null,
        positionSeconds: num(req.body?.positionSeconds),
        isStaff,
        device: deviceFrom(String(req.headers["user-agent"] || "")),
        referrer: str(req.headers.referer) ?? undefined,
        userAgent: String(req.headers["user-agent"] || "").slice(0, 500),
      });
      if (kind === "view" && !isStaff) {
        await db
          .update(staffVideos)
          .set({ viewCount: dsql`view_count + 1` as any })
          .where(eq(staffVideos.id, row.id));
      }
      res.json({ ok: true });
    } catch (e) {
      fail(res, e);
    }
  });

  app.post("/api/public/videos/:token/comments", async (req, res) => {
    try {
      const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?").split(",")[0].trim();
      if (!rateLimit(`vc:${ip}`, 30, 3600_000)) {
        res.status(429).json({ error: "Slow down — try again in a bit." });
        return;
      }
      const token = String(req.params.token || "");
      const [row] = await db
        .select({ id: staffVideos.id, allowComments: staffVideos.allowComments, visibility: staffVideos.visibility })
        .from(staffVideos)
        .where(and(eq(staffVideos.token, token), isNull(staffVideos.deletedAt)));
      if (!row) throw new NotFound();
      if (!row.allowComments) throw new Forbidden("Comments are off for this video");

      const body = str(req.body?.body);
      const emoji = str(req.body?.emoji);
      if (!body && !emoji) throw new BadRequest("Say something or react with an emoji");
      if (body && body.length > 2000) throw new BadRequest("Keep comments under 2000 characters");
      if (emoji && Array.from(emoji).length > 4) throw new BadRequest("bad emoji");

      const sessionUserId = (req.session as any)?.userId as number | undefined;
      const [c] = await db
        .insert(staffVideoComments)
        .values({
          videoId: row.id,
          authorUserId: sessionUserId ?? undefined,
          authorName: (str(req.body?.name) || (sessionUserId ? "Staff" : "Someone")).slice(0, 120),
          body: body ?? undefined,
          emoji: emoji ?? undefined,
          atSeconds: num(req.body?.atSeconds),
          isStaff: !!sessionUserId,
        })
        .returning();
      res.json({ id: c.id, ok: true });
    } catch (e) {
      fail(res, e);
    }
  });
}
