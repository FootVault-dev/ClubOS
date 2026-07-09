/**
 * CIC Media Library — staff (Max) upload photos/videos and organise them by
 * team + custom categories ("like our Google Drive"). Feeds a public catalog
 * API (/api/public/media/:brand/*) a future storefront will read.
 *
 * Storage: originals go to the PRIVATE `clubos-media` Supabase bucket
 * (storage_key). A watermarked preview + small thumb are generated with sharp
 * into the PUBLIC `clubos-media-previews` bucket (preview_key / thumb_key).
 * Video uploads skip the sharp pipeline (preview/thumb stay null — a later
 * phase can add video thumbnails).
 *
 * The public API NEVER returns storage_key or player_name — only preview/thumb
 * URLs, ids, kind, and bib numbers (a storefront lets parents search by bib).
 *
 * Multi-brand by design (mirrors server/shop-routes.ts) — CIC (org 5) first.
 * Admin routes are requireAuth + requireTab("media"); "media" is dark-launched
 * super-admin-only via shared/tabs.ts until Daniel opens it up to Max.
 */

import type { Express, Request, Response, NextFunction } from "express";
import multer from "multer";
import { randomUUID } from "crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { db } from "./db";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { requireAuth, requireTab } from "./auth";
import {
  mediaCategories, mediaGalleries, mediaAssets, tournaments, tournamentTeams,
  type MediaAsset,
} from "@shared/schema";

// ─── Brand registry — add a row per brand to open a new media library ──────

interface MediaBrand {
  brandKey: string;
  orgId: number;
  name: string;
  /** Extra origins allowed to call the public media API for this brand. */
  allowedOrigins: RegExp[];
}

const MEDIA_BRANDS: Record<string, MediaBrand> = {
  cic: {
    brandKey: "cic",
    orgId: 5,
    name: "CIC Media",
    allowedOrigins: [
      /^https:\/\/(www\.)?cicyouth\.com$/,
      /^https:\/\/content\.cicyouth\.com$/,
    ],
  },
};

function mediaBrand(brandKey: string): MediaBrand | undefined {
  return MEDIA_BRANDS[String(brandKey || "").toLowerCase()];
}

// ─── Storage — private originals + public watermarked previews ─────────────

const MEDIA_BUCKET = process.env.CIC_MEDIA_BUCKET || "clubos-media"; // private originals
const MEDIA_PREVIEWS_BUCKET = process.env.CIC_MEDIA_PREVIEWS_BUCKET || "clubos-media-previews"; // public

let mediaStorageClient: SupabaseClient | null = null;
function getMediaStorageClient(): SupabaseClient {
  if (!mediaStorageClient) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set for media uploads");
    mediaStorageClient = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  return mediaStorageClient;
}

/** Public URL for a key in the PUBLIC previews bucket. Null-safe passthrough. */
function mediaPreviewUrl(key: string | null | undefined): string | null {
  if (!key) return null;
  const base = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  return `${base}/storage/v1/object/public/${MEDIA_PREVIEWS_BUCKET}/${key}`;
}

// ─── Small helpers ──────────────────────────────────────────────────────────

class MediaError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function slugify(text: string): string {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "gallery";
}

function safeFilename(name: string): string {
  return String(name || "file").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

function adminOrgId(req: Request): number {
  const orgId = parseInt(String(req.query.orgId || req.body?.organizationId || req.body?.orgId || ""));
  if (!Number.isFinite(orgId)) throw new MediaError("orgId required");
  return orgId;
}

/** Recompute the denormalised asset_count on a gallery after any mutation
 *  that could change its membership (upload, delete, move, bulk-assign). */
async function recomputeGalleryAssetCount(galleryId: number | null | undefined): Promise<void> {
  if (!galleryId) return;
  await db.execute(sql`
    UPDATE media_galleries SET asset_count = (
      SELECT COUNT(*)::int FROM media_assets WHERE gallery_id = ${galleryId}
    ), updated_at = now()
    WHERE id = ${galleryId}
  `);
}

// ─── Watermarking — sharp resize + a tiled "CIC · PREVIEW" overlay ──────────

/** Diagonal tiled text overlay, rasterised from SVG. ~35% opacity white text. */
function watermarkSvg(width: number, height: number, label = "CIC · PREVIEW"): Buffer {
  const tile = 260;
  const fontSize = 22;
  const svg = `
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <pattern id="wm" width="${tile}" height="${tile}" patternUnits="userSpaceOnUse" patternTransform="rotate(-30)">
      <text x="0" y="${tile / 2}" font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="700"
        fill="#ffffff" fill-opacity="0.35" letter-spacing="2">${label}</text>
    </pattern>
  </defs>
  <rect width="100%" height="100%" fill="url(#wm)" />
</svg>`.trim();
  return Buffer.from(svg);
}

/** Resize a photo to a max ~1600px edge, stamp the watermark, and produce a
 *  small thumb from the (already watermarked) preview. Throws MediaError if
 *  the buffer isn't a real, decodable image. */
async function processPhotoUpload(buffer: Buffer): Promise<{
  previewBuf: Buffer; thumbBuf: Buffer; width: number; height: number;
}> {
  const sharp = (await import("sharp")).default;
  let meta: import("sharp").Metadata;
  try {
    meta = await sharp(buffer, { failOn: "error", animated: false, limitInputPixels: 80_000_000 }).metadata();
  } catch {
    throw new MediaError("That file isn't a valid image.");
  }
  if (!meta.format || !["jpeg", "jpg", "png", "webp", "avif", "gif", "tiff"].includes(meta.format)) {
    throw new MediaError(`Unsupported image format: ${meta.format || "unknown"}`);
  }

  const resized = await sharp(buffer)
    .rotate()
    .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
    .toBuffer({ resolveWithObject: true });

  const wmSvg = watermarkSvg(resized.info.width, resized.info.height);
  const previewBuf = await sharp(resized.data)
    .composite([{ input: wmSvg, top: 0, left: 0 }])
    .webp({ quality: 82, effort: 4 })
    .toBuffer();

  const thumbBuf = await sharp(previewBuf)
    .resize({ width: 480, height: 480, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 78, effort: 4 })
    .toBuffer();

  return {
    previewBuf, thumbBuf,
    width: meta.width || resized.info.width,
    height: meta.height || resized.info.height,
  };
}

// ─── Route registration ─────────────────────────────────────────────────────

export function registerMediaRoutes(app: Express) {
  const handleMediaError = (res: Response, e: any, context: string) => {
    if (e instanceof MediaError) return res.status(e.status).json({ message: e.message });
    console.error(`[Media] ${context} error:`, e);
    return res.status(500).json({ message: "Something went wrong. Please try again." });
  };

  // CORS for the public catalog API (cicyouth.com + a future content subdomain,
  // Vercel staging aliases, and local dev). Same allowlist shape as the shop.
  const setMediaCors = (req: Request, res: Response) => {
    const origin = String(req.headers.origin || "");
    const allowed =
      Object.values(MEDIA_BRANDS).some((b) => b.allowedOrigins.some((rx) => rx.test(origin))) ||
      /\.vercel\.app$/.test(origin) ||
      /^https?:\/\/localhost(:\d+)?$/.test(origin) ||
      /^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin);
    if (allowed) {
      res.header("Access-Control-Allow-Origin", origin);
      res.header("Vary", "Origin");
    }
    res.header("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type");
  };
  app.use("/api/public/media", (req: Request, res: Response, next: NextFunction) => {
    setMediaCors(req, res);
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  // ── Public: published galleries for a brand ────────────────────────────────
  app.get("/api/public/media/:brand/galleries", async (req, res) => {
    try {
      const brand = mediaBrand(String(req.params.brand));
      if (!brand) return res.status(404).json({ message: "Not found" });

      const rows = await db.select().from(mediaGalleries).where(and(
        eq(mediaGalleries.organizationId, brand.orgId),
        eq(mediaGalleries.status, "published"),
      )).orderBy(asc(mediaGalleries.sortOrder), desc(mediaGalleries.shootDate));

      const coverIds = rows.map((g) => g.coverAssetId).filter((x): x is number => x != null);
      const covers = coverIds.length > 0
        ? await db.select().from(mediaAssets).where(inArray(mediaAssets.id, coverIds))
        : [];

      res.json(rows.map((g) => {
        const cover = covers.find((c) => c.id === g.coverAssetId);
        return {
          id: g.id,
          slug: g.slug,
          title: g.title,
          ageGroup: g.ageGroup || undefined,
          clubName: g.clubName || undefined,
          shootDate: g.shootDate || undefined,
          assetCount: g.assetCount,
          coverImage: cover ? (mediaPreviewUrl(cover.previewKey) || mediaPreviewUrl(cover.thumbKey)) : null,
        };
      }));
    } catch (e: any) {
      handleMediaError(res, e, "public galleries");
    }
  });

  // ── Public: one gallery's published assets ─────────────────────────────────
  // NEVER returns storage_key or player_name — preview/thumb URLs, id, kind
  // and bib only (a storefront lets parents search their kid by bib number).
  app.get("/api/public/media/:brand/gallery/:slug", async (req, res) => {
    try {
      const brand = mediaBrand(String(req.params.brand));
      if (!brand) return res.status(404).json({ message: "Not found" });

      const [gallery] = await db.select().from(mediaGalleries).where(and(
        eq(mediaGalleries.organizationId, brand.orgId),
        eq(mediaGalleries.slug, String(req.params.slug)),
        eq(mediaGalleries.status, "published"),
      ));
      if (!gallery) return res.status(404).json({ message: "Gallery not found" });

      const assets = await db.select().from(mediaAssets).where(and(
        eq(mediaAssets.galleryId, gallery.id),
        eq(mediaAssets.status, "published"),
      )).orderBy(asc(mediaAssets.sortOrder), asc(mediaAssets.id));

      res.json({
        id: gallery.id,
        slug: gallery.slug,
        title: gallery.title,
        ageGroup: gallery.ageGroup || undefined,
        clubName: gallery.clubName || undefined,
        shootDate: gallery.shootDate || undefined,
        assets: assets.map((a) => ({
          id: a.id,
          kind: a.kind,
          bibNumber: a.bibNumber ?? undefined,
          previewUrl: mediaPreviewUrl(a.previewKey),
          thumbUrl: mediaPreviewUrl(a.thumbKey),
          ...(a.priceCents != null ? { priceDollars: Math.round(a.priceCents) / 100 } : {}),
        })),
      });
    } catch (e: any) {
      handleMediaError(res, e, "public gallery detail");
    }
  });

  // ═══ Admin — everything below is requireAuth + requireTab("media") ═════════
  // ("media" is in SUPER_ADMIN_ONLY_TABS for the dark launch — Daniel-only
  // until he opens it up to Max in Team.)

  // ── Admin: categories ───────────────────────────────────────────────────────
  app.get("/api/admin/media/categories", requireAuth, requireTab("media"), async (req, res) => {
    try {
      const orgId = adminOrgId(req);
      const rows = await db.select().from(mediaCategories)
        .where(eq(mediaCategories.organizationId, orgId))
        .orderBy(asc(mediaCategories.sortOrder), asc(mediaCategories.id));
      res.json(rows);
    } catch (e: any) {
      handleMediaError(res, e, "categories list");
    }
  });

  app.post("/api/admin/media/categories", requireAuth, requireTab("media"), async (req, res) => {
    try {
      const orgId = adminOrgId(req);
      const name = String(req.body?.name || "").trim();
      if (!name) throw new MediaError("Name is required");
      const slug = slugify(String(req.body?.slug || "").trim() || name);
      const siblings = await db.select({ id: mediaCategories.id }).from(mediaCategories)
        .where(eq(mediaCategories.organizationId, orgId));
      const [created] = await db.insert(mediaCategories).values({
        organizationId: orgId, name, slug, sortOrder: siblings.length,
      }).returning();
      res.status(201).json(created);
    } catch (e: any) {
      if (e?.code === "23505") return res.status(409).json({ message: "A category with that name already exists." });
      handleMediaError(res, e, "category create");
    }
  });

  app.patch("/api/admin/media/categories/:id", requireAuth, requireTab("media"), async (req, res) => {
    try {
      const id = parseInt(String(req.params.id));
      const patch: Record<string, any> = {};
      const b = req.body || {};
      if (b.name !== undefined) patch.name = String(b.name).trim();
      if (b.slug !== undefined) patch.slug = slugify(String(b.slug));
      if (b.sortOrder !== undefined) patch.sortOrder = parseInt(String(b.sortOrder)) || 0;
      const [updated] = await db.update(mediaCategories).set(patch).where(eq(mediaCategories.id, id)).returning();
      if (!updated) return res.status(404).json({ message: "Category not found" });
      res.json(updated);
    } catch (e: any) {
      if (e?.code === "23505") return res.status(409).json({ message: "A category with that name already exists." });
      handleMediaError(res, e, "category update");
    }
  });

  app.delete("/api/admin/media/categories/:id", requireAuth, requireTab("media"), async (req, res) => {
    try {
      await db.delete(mediaCategories).where(eq(mediaCategories.id, parseInt(String(req.params.id))));
      res.json({ ok: true });
    } catch (e: any) {
      handleMediaError(res, e, "category delete");
    }
  });

  // ── Admin: galleries ────────────────────────────────────────────────────────
  app.get("/api/admin/media/galleries", requireAuth, requireTab("media"), async (req, res) => {
    try {
      const orgId = adminOrgId(req);
      const rows = await db.select().from(mediaGalleries)
        .where(eq(mediaGalleries.organizationId, orgId))
        .orderBy(asc(mediaGalleries.sortOrder), desc(mediaGalleries.createdAt));

      const coverIds = rows.map((g) => g.coverAssetId).filter((x): x is number => x != null);
      const covers = coverIds.length > 0
        ? await db.select().from(mediaAssets).where(inArray(mediaAssets.id, coverIds))
        : [];

      res.json(rows.map((g) => {
        const cover = covers.find((c) => c.id === g.coverAssetId);
        return {
          ...g,
          coverThumbUrl: cover ? (mediaPreviewUrl(cover.thumbKey) || mediaPreviewUrl(cover.previewKey)) : null,
        };
      }));
    } catch (e: any) {
      handleMediaError(res, e, "galleries list");
    }
  });

  app.post("/api/admin/media/galleries", requireAuth, requireTab("media"), async (req, res) => {
    try {
      const orgId = adminOrgId(req);
      const title = String(req.body?.title || "").trim();
      if (!title) throw new MediaError("Title is required");
      const slug = slugify(String(req.body?.slug || "").trim() || title);
      const [created] = await db.insert(mediaGalleries).values({
        organizationId: orgId,
        tournamentId: req.body?.tournamentId != null && req.body.tournamentId !== "" ? parseInt(String(req.body.tournamentId)) : null,
        teamId: req.body?.teamId != null && req.body.teamId !== "" ? parseInt(String(req.body.teamId)) : null,
        ageGroup: String(req.body?.ageGroup || "").trim() || null,
        clubName: String(req.body?.clubName || "").trim() || null,
        title,
        slug,
        shootDate: String(req.body?.shootDate || "").trim() || null,
        status: ["draft", "published", "hidden"].includes(req.body?.status) ? req.body.status : "draft",
      }).returning();
      res.status(201).json(created);
    } catch (e: any) {
      if (e?.code === "23505") return res.status(409).json({ message: "A gallery with that slug already exists." });
      handleMediaError(res, e, "gallery create");
    }
  });

  // Pre-fill a gallery from a CIC team (org 5 tournaments/tournament_teams).
  app.post("/api/admin/media/galleries/from-team", requireAuth, requireTab("media"), async (req, res) => {
    try {
      const orgId = adminOrgId(req);
      const tournamentId = parseInt(String(req.body?.tournamentId));
      const teamId = parseInt(String(req.body?.teamId));
      if (!Number.isFinite(tournamentId) || !Number.isFinite(teamId)) {
        throw new MediaError("tournamentId and teamId are required");
      }
      const [tournament] = await db.select().from(tournaments)
        .where(and(eq(tournaments.id, tournamentId), eq(tournaments.organizationId, orgId)));
      if (!tournament) throw new MediaError("Tournament not found", 404);
      const [team] = await db.select().from(tournamentTeams)
        .where(and(eq(tournamentTeams.id, teamId), eq(tournamentTeams.tournamentId, tournamentId)));
      if (!team) throw new MediaError("Team not found", 404);

      const title = `${team.name}${tournament.ageGroup ? ` — ${tournament.ageGroup}` : ""}`;
      const baseSlug = slugify(title);
      let slug = baseSlug;
      let attempt = 1;
      // Small uniqueness loop — org-scoped slug clashes are rare but possible
      // (same team name reused across seasons).
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const [clash] = await db.select({ id: mediaGalleries.id }).from(mediaGalleries)
          .where(and(eq(mediaGalleries.organizationId, orgId), eq(mediaGalleries.slug, slug)));
        if (!clash) break;
        attempt += 1;
        slug = `${baseSlug}-${attempt}`;
      }

      const [created] = await db.insert(mediaGalleries).values({
        organizationId: orgId,
        tournamentId: tournament.id,
        teamId: team.id,
        ageGroup: tournament.ageGroup || null,
        clubName: team.clubName || team.name,
        title,
        slug,
        status: "draft",
      }).returning();
      res.status(201).json(created);
    } catch (e: any) {
      handleMediaError(res, e, "gallery from-team");
    }
  });

  app.patch("/api/admin/media/galleries/:id", requireAuth, requireTab("media"), async (req, res) => {
    try {
      const id = parseInt(String(req.params.id));
      const patch: Record<string, any> = { updatedAt: new Date() };
      const b = req.body || {};
      if (b.title !== undefined) patch.title = String(b.title).trim();
      if (b.slug !== undefined) patch.slug = slugify(String(b.slug));
      if (b.ageGroup !== undefined) patch.ageGroup = String(b.ageGroup).trim() || null;
      if (b.clubName !== undefined) patch.clubName = String(b.clubName).trim() || null;
      if (b.shootDate !== undefined) patch.shootDate = String(b.shootDate || "").trim() || null;
      if (b.status !== undefined && ["draft", "published", "hidden"].includes(b.status)) patch.status = b.status;
      if (b.coverAssetId !== undefined) patch.coverAssetId = b.coverAssetId === null || b.coverAssetId === "" ? null : parseInt(String(b.coverAssetId));
      if (b.sortOrder !== undefined) patch.sortOrder = parseInt(String(b.sortOrder)) || 0;
      if (b.tournamentId !== undefined) patch.tournamentId = b.tournamentId === null || b.tournamentId === "" ? null : parseInt(String(b.tournamentId));
      if (b.teamId !== undefined) patch.teamId = b.teamId === null || b.teamId === "" ? null : parseInt(String(b.teamId));
      const [updated] = await db.update(mediaGalleries).set(patch).where(eq(mediaGalleries.id, id)).returning();
      if (!updated) return res.status(404).json({ message: "Gallery not found" });
      res.json(updated);
    } catch (e: any) {
      if (e?.code === "23505") return res.status(409).json({ message: "A gallery with that slug already exists." });
      handleMediaError(res, e, "gallery update");
    }
  });

  app.delete("/api/admin/media/galleries/:id", requireAuth, requireTab("media"), async (req, res) => {
    try {
      // gallery_id on media_assets is ON DELETE SET NULL — deleting a gallery
      // un-groups its assets rather than deleting the files.
      await db.delete(mediaGalleries).where(eq(mediaGalleries.id, parseInt(String(req.params.id))));
      res.json({ ok: true });
    } catch (e: any) {
      handleMediaError(res, e, "gallery delete");
    }
  });

  app.post("/api/admin/media/galleries/reorder", requireAuth, requireTab("media"), async (req, res) => {
    try {
      const ids: number[] = Array.isArray(req.body?.ids) ? req.body.ids.map((v: any) => parseInt(v)).filter(Number.isFinite) : [];
      for (let i = 0; i < ids.length; i++) {
        await db.update(mediaGalleries).set({ sortOrder: i, updatedAt: new Date() }).where(eq(mediaGalleries.id, ids[i]));
      }
      res.json({ ok: true });
    } catch (e: any) {
      handleMediaError(res, e, "gallery reorder");
    }
  });

  // Source list for the "New gallery from team" picker — every CIC tournament
  // (age group) with its teams.
  app.get("/api/admin/media/tournament-teams", requireAuth, requireTab("media"), async (req, res) => {
    try {
      const orgId = adminOrgId(req);
      const tRows = await db.select().from(tournaments)
        .where(eq(tournaments.organizationId, orgId))
        .orderBy(asc(tournaments.name));
      const tIds = tRows.map((t) => t.id);
      const teamRows = tIds.length > 0
        ? await db.select().from(tournamentTeams).where(inArray(tournamentTeams.tournamentId, tIds)).orderBy(asc(tournamentTeams.name))
        : [];
      res.json(tRows.map((t) => ({
        id: t.id,
        name: t.name,
        ageGroup: t.ageGroup,
        teams: teamRows.filter((tm) => tm.tournamentId === t.id).map((tm) => ({
          id: tm.id, name: tm.name, clubName: tm.clubName, logoUrl: tm.logoUrl,
        })),
      })));
    } catch (e: any) {
      handleMediaError(res, e, "tournament-teams source");
    }
  });

  // ── Admin: assets ───────────────────────────────────────────────────────────
  app.get("/api/admin/media/assets", requireAuth, requireTab("media"), async (req, res) => {
    try {
      const orgId = adminOrgId(req);
      const conditions = [eq(mediaAssets.organizationId, orgId)];
      if (req.query.galleryId) conditions.push(eq(mediaAssets.galleryId, parseInt(String(req.query.galleryId))));
      if (req.query.categoryId) conditions.push(eq(mediaAssets.categoryId, parseInt(String(req.query.categoryId))));
      if (req.query.teamId) conditions.push(eq(mediaAssets.teamId, parseInt(String(req.query.teamId))));
      if (req.query.status) conditions.push(eq(mediaAssets.status, String(req.query.status)));
      const rows = await db.select().from(mediaAssets).where(and(...conditions))
        .orderBy(asc(mediaAssets.sortOrder), desc(mediaAssets.createdAt));
      res.json(rows.map((a) => ({
        ...a,
        previewUrl: mediaPreviewUrl(a.previewKey),
        thumbUrl: mediaPreviewUrl(a.thumbKey),
      })));
    } catch (e: any) {
      handleMediaError(res, e, "assets list");
    }
  });

  // Multipart upload — multiple files, photo + video, ~50MB/file. Photos get a
  // watermarked preview + thumb; videos store the original only (v1).
  const mediaUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024, files: 60 } });
  app.post(
    "/api/admin/media/upload",
    requireAuth,
    requireTab("media"),
    (req: Request, res: Response, next: NextFunction) => {
      mediaUpload.array("files", 60)(req, res, (err: any) => {
        if (err) {
          const msg = err?.code === "LIMIT_FILE_SIZE" ? "A file is too big — max 50MB"
            : err?.code === "LIMIT_FILE_COUNT" ? "Too many files in one upload (max 60)"
            : err?.message || "Upload rejected";
          return res.status(400).json({ message: msg });
        }
        next();
      });
    },
    async (req: Request, res: Response) => {
      try {
        const orgId = adminOrgId(req);
        const files = (req.files as Express.Multer.File[] | undefined) || [];
        if (files.length === 0) throw new MediaError("No files uploaded");

        const galleryId = req.body?.galleryId != null && req.body.galleryId !== "" ? parseInt(String(req.body.galleryId)) : null;
        const categoryId = req.body?.categoryId != null && req.body.categoryId !== "" ? parseInt(String(req.body.categoryId)) : null;
        const teamId = req.body?.teamId != null && req.body.teamId !== "" ? parseInt(String(req.body.teamId)) : null;
        const bibNumber = req.body?.bibNumber != null && req.body.bibNumber !== "" ? parseInt(String(req.body.bibNumber)) : null;

        const client = getMediaStorageClient();
        const created: MediaAsset[] = [];
        const errors: { filename: string; message: string }[] = [];

        for (const file of files) {
          try {
            const isVideo = file.mimetype.startsWith("video/");
            const kind = isVideo ? "video" : "photo";
            const safeName = safeFilename(file.originalname);
            const uuid = randomUUID();
            const originalKey = `media/${orgId}/${galleryId ?? "unsorted"}/${uuid}-${safeName}`;

            const { error: upErr } = await client.storage.from(MEDIA_BUCKET).upload(originalKey, file.buffer, {
              contentType: file.mimetype,
              upsert: false,
            });
            if (upErr) throw new Error(`Original upload failed: ${upErr.message}`);

            let previewKey: string | null = null;
            let thumbKey: string | null = null;
            let width: number | null = null;
            let height: number | null = null;

            if (!isVideo) {
              try {
                const { previewBuf, thumbBuf, width: w, height: h } = await processPhotoUpload(file.buffer);
                const pKey = `previews/${orgId}/${galleryId ?? "unsorted"}/${uuid}.webp`;
                const tKey = `previews/${orgId}/${galleryId ?? "unsorted"}/${uuid}-thumb.webp`;
                const [{ error: pErr }, { error: tErr }] = await Promise.all([
                  client.storage.from(MEDIA_PREVIEWS_BUCKET).upload(pKey, previewBuf, { contentType: "image/webp", cacheControl: "public, max-age=31536000", upsert: false }),
                  client.storage.from(MEDIA_PREVIEWS_BUCKET).upload(tKey, thumbBuf, { contentType: "image/webp", cacheControl: "public, max-age=31536000", upsert: false }),
                ]);
                if (pErr || tErr) throw new Error(`Preview upload failed: ${(pErr || tErr)!.message}`);
                previewKey = pKey;
                thumbKey = tKey;
                width = w;
                height = h;
              } catch (procErr: any) {
                // Keep the original; the asset just has no preview/thumb yet.
                console.error(`[Media] preview generation failed for "${file.originalname}":`, procErr);
              }
            }

            const [row] = await db.insert(mediaAssets).values({
              organizationId: orgId,
              galleryId, categoryId, teamId,
              kind,
              storageKey: originalKey,
              previewKey, thumbKey,
              originalFilename: file.originalname,
              contentType: file.mimetype,
              sizeBytes: file.size,
              width, height,
              bibNumber,
              status: "draft",
              uploadedBy: req.session.userId ?? null,
            }).returning();
            created.push(row);
          } catch (fileErr: any) {
            console.error(`[Media] upload failed for "${file.originalname}":`, fileErr);
            errors.push({ filename: file.originalname, message: fileErr.message || "Upload failed" });
          }
        }

        if (galleryId) await recomputeGalleryAssetCount(galleryId);
        res.status(created.length > 0 ? 201 : 400).json({ created, errors });
      } catch (e: any) {
        handleMediaError(res, e, "upload");
      }
    },
  );

  app.patch("/api/admin/media/assets/:id", requireAuth, requireTab("media"), async (req, res) => {
    try {
      const id = parseInt(String(req.params.id));
      const [existing] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, id));
      if (!existing) return res.status(404).json({ message: "Asset not found" });

      const patch: Record<string, any> = {};
      const b = req.body || {};
      if (b.galleryId !== undefined) patch.galleryId = b.galleryId === null || b.galleryId === "" ? null : parseInt(String(b.galleryId));
      if (b.categoryId !== undefined) patch.categoryId = b.categoryId === null || b.categoryId === "" ? null : parseInt(String(b.categoryId));
      if (b.teamId !== undefined) patch.teamId = b.teamId === null || b.teamId === "" ? null : parseInt(String(b.teamId));
      if (b.bibNumber !== undefined) patch.bibNumber = b.bibNumber === null || b.bibNumber === "" ? null : parseInt(String(b.bibNumber));
      if (b.playerName !== undefined) patch.playerName = String(b.playerName).trim() || null;
      if (b.status !== undefined && ["draft", "published"].includes(b.status)) patch.status = b.status;
      if (b.priceCents !== undefined) patch.priceCents = b.priceCents === null || b.priceCents === "" ? null : parseInt(String(b.priceCents));
      if (b.sortOrder !== undefined) patch.sortOrder = parseInt(String(b.sortOrder)) || 0;

      const [updated] = await db.update(mediaAssets).set(patch).where(eq(mediaAssets.id, id)).returning();

      if (patch.galleryId !== undefined && patch.galleryId !== existing.galleryId) {
        await recomputeGalleryAssetCount(existing.galleryId);
        await recomputeGalleryAssetCount(updated.galleryId);
      }
      res.json({
        ...updated,
        previewUrl: mediaPreviewUrl(updated.previewKey),
        thumbUrl: mediaPreviewUrl(updated.thumbKey),
      });
    } catch (e: any) {
      handleMediaError(res, e, "asset update");
    }
  });

  // Multi-select bulk assign (category / team / publish status).
  app.patch("/api/admin/media/assets/bulk", requireAuth, requireTab("media"), async (req, res) => {
    try {
      const ids: number[] = Array.isArray(req.body?.ids) ? req.body.ids.map((v: any) => parseInt(v)).filter(Number.isFinite) : [];
      if (ids.length === 0) throw new MediaError("ids required");

      const patch: Record<string, any> = {};
      const b = req.body?.patch || {};
      if (b.galleryId !== undefined) patch.galleryId = b.galleryId === null || b.galleryId === "" ? null : parseInt(String(b.galleryId));
      if (b.categoryId !== undefined) patch.categoryId = b.categoryId === null || b.categoryId === "" ? null : parseInt(String(b.categoryId));
      if (b.teamId !== undefined) patch.teamId = b.teamId === null || b.teamId === "" ? null : parseInt(String(b.teamId));
      if (b.status !== undefined && ["draft", "published"].includes(b.status)) patch.status = b.status;
      if (Object.keys(patch).length === 0) throw new MediaError("Nothing to update");

      const existingRows = await db.select({ id: mediaAssets.id, galleryId: mediaAssets.galleryId })
        .from(mediaAssets).where(inArray(mediaAssets.id, ids));
      await db.update(mediaAssets).set(patch).where(inArray(mediaAssets.id, ids));

      const affectedGalleries = new Set<number>();
      existingRows.forEach((r) => { if (r.galleryId) affectedGalleries.add(r.galleryId); });
      if (patch.galleryId) affectedGalleries.add(patch.galleryId);
      for (const gid of Array.from(affectedGalleries)) await recomputeGalleryAssetCount(gid);

      res.json({ ok: true, updated: ids.length });
    } catch (e: any) {
      handleMediaError(res, e, "assets bulk update");
    }
  });

  app.post("/api/admin/media/assets/reorder", requireAuth, requireTab("media"), async (req, res) => {
    try {
      const ids: number[] = Array.isArray(req.body?.ids) ? req.body.ids.map((v: any) => parseInt(v)).filter(Number.isFinite) : [];
      for (let i = 0; i < ids.length; i++) {
        await db.update(mediaAssets).set({ sortOrder: i }).where(eq(mediaAssets.id, ids[i]));
      }
      res.json({ ok: true });
    } catch (e: any) {
      handleMediaError(res, e, "assets reorder");
    }
  });

  app.delete("/api/admin/media/assets/:id", requireAuth, requireTab("media"), async (req, res) => {
    try {
      const id = parseInt(String(req.params.id));
      const [existing] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, id));
      if (!existing) return res.status(404).json({ message: "Asset not found" });

      await db.delete(mediaAssets).where(eq(mediaAssets.id, id));

      // Best-effort storage cleanup — the row being gone is the source of truth.
      const client = getMediaStorageClient();
      await client.storage.from(MEDIA_BUCKET).remove([existing.storageKey]).catch(() => {});
      const previewRemovals = [existing.previewKey, existing.thumbKey].filter((k): k is string => !!k);
      if (previewRemovals.length > 0) {
        await client.storage.from(MEDIA_PREVIEWS_BUCKET).remove(previewRemovals).catch(() => {});
      }

      if (existing.galleryId) await recomputeGalleryAssetCount(existing.galleryId);
      res.json({ ok: true });
    } catch (e: any) {
      handleMediaError(res, e, "asset delete");
    }
  });

  // Admin preview of the clean original (no watermark) via a short-lived
  // signed URL — never expose the private storage_key directly.
  app.get("/api/admin/media/assets/:id/original-url", requireAuth, requireTab("media"), async (req, res) => {
    try {
      const id = parseInt(String(req.params.id));
      const [existing] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, id));
      if (!existing) return res.status(404).json({ message: "Asset not found" });
      const { data, error } = await getMediaStorageClient().storage.from(MEDIA_BUCKET).createSignedUrl(existing.storageKey, 60 * 60);
      if (error) throw new Error(error.message);
      res.json({ url: data.signedUrl });
    } catch (e: any) {
      handleMediaError(res, e, "asset original-url");
    }
  });

  // ── Admin: stats ─────────────────────────────────────────────────────────
  app.get("/api/admin/media/stats", requireAuth, requireTab("media"), async (req, res) => {
    try {
      const orgId = adminOrgId(req);
      const assetRows = (await db.execute(sql`
        SELECT
          COUNT(*)::int AS "totalAssets",
          COUNT(*) FILTER (WHERE status = 'published')::int AS "publishedAssets",
          COUNT(*) FILTER (WHERE kind = 'photo')::int AS "photoCount",
          COUNT(*) FILTER (WHERE kind = 'video')::int AS "videoCount",
          COALESCE(SUM(size_bytes), 0)::bigint AS "totalBytes"
        FROM media_assets WHERE organization_id = ${orgId}
      `)).rows as any[];
      const galleryRows = (await db.execute(sql`
        SELECT
          COUNT(*)::int AS "totalGalleries",
          COUNT(*) FILTER (WHERE status = 'published')::int AS "publishedGalleries"
        FROM media_galleries WHERE organization_id = ${orgId}
      `)).rows as any[];

      const a = assetRows[0] || { totalAssets: 0, publishedAssets: 0, photoCount: 0, videoCount: 0, totalBytes: 0 };
      const g = galleryRows[0] || { totalGalleries: 0, publishedGalleries: 0 };

      res.json({
        totalAssets: a.totalAssets,
        publishedAssets: a.publishedAssets,
        photoCount: a.photoCount,
        videoCount: a.videoCount,
        totalBytes: Number(a.totalBytes),
        totalGalleries: g.totalGalleries,
        publishedGalleries: g.publishedGalleries,
      });
    } catch (e: any) {
      handleMediaError(res, e, "stats");
    }
  });
}
