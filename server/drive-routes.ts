// ─────────────────────────────────────────────────────────────────────────────
// Club Drive routes — the club's own file store.
//
// Universal tab (same as Chat, Feedback, Task Tracker, Knowledge Base), so every
// endpoint is gated by `requireAuth` only, never `requireTab`.
//
// 🔴 THE PERMISSION RULE, and why it is not the tab whitelist. `canAccessTab`
// returns true for EVERY tab when a member's role is admin or manager — Olga is
// an admin of Christchurch United, so a tab-based gate would hand her every
// employment contract in the building. Drive therefore judges each NODE against
// the accumulated gates of its ancestors (see `gatesFor`, and the
// `drive_node_gates` view for the readable definition of the same rule) using
// the same decider the Knowledge Base and Rambo use. One rule, three surfaces.
//
// The viewer is rebuilt from the live database on every request — revoking
// access has to bite on the next click, not the next login.
// ─────────────────────────────────────────────────────────────────────────────
import type { Express } from "express";
import { and, desc, eq, inArray, isNull, isNotNull, sql } from "drizzle-orm";
import multer from "multer";
import { db } from "./db";
import { requireAuth } from "./auth";
import { driveNodes, driveAccessLog, users as usersTable } from "@shared/schema";
import {
  driveCategory,
  driveGateLabel,
  driveIsExtractable,
  googleIsLiveEditable,
  googleLinkLabel,
  viewerCanReadDriveNode,
  type Viewer,
} from "@shared/drive";
import { buildViewer } from "./rambo";
import { driveStorage } from "./drive-storage";
import { extractText } from "./drive-extract";

const UPLOAD_MAX_BYTES = 200 * 1024 * 1024; // 200MB — a match video or a print-ready PDF
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: UPLOAD_MAX_BYTES } });

const clean = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;

// ── Gates ────────────────────────────────────────────────────────────────────

/**
 * The accumulated gates for a set of nodes: every `required_tab` on the chain
 * from each node up to its root. An empty list means open to all staff.
 */
async function gatesFor(nodeIds: number[]): Promise<Map<number, string[]>> {
  const map = new Map<number, string[]>();
  if (!nodeIds.length) return map;

  // 🔴 Walk UP from the nodes asked about, never down from the roots. The
  // `drive_node_gates` view is the readable definition of the rule, but a
  // filter cannot be pushed into a recursive CTE — querying it makes Postgres
  // expand the ENTIRE tree and then discard almost all of it, so the cost grows
  // with the size of the drive rather than with the size of the page. With a
  // few thousand files imported that is already slow enough to notice.
  //
  // Seeding the recursion with just these ids and climbing parent links is
  // O(rows on screen × folder depth) — a handful of index lookups. The result
  // is identical: every gate on the chain, accumulated, and a node with no
  // gated ancestor gets an empty list.
  const rows: any = await db.execute(sql`
    WITH RECURSIVE up AS (
      SELECT id AS start_id, id, parent_id, required_tab, required_workspace
      FROM drive_nodes
      WHERE id IN (${sql.join(nodeIds.map((i) => sql`${i}`), sql`, `)})
      UNION ALL
      SELECT u.start_id, n.id, n.parent_id, n.required_tab, n.required_workspace
      FROM drive_nodes n JOIN up u ON n.id = u.parent_id
    )
    SELECT start_id,
           coalesce(
             array_agg(required_tab || '@' || coalesce(required_workspace, ''))
               FILTER (WHERE required_tab IS NOT NULL),
             '{}'
           ) AS gates
    FROM up GROUP BY start_id
  `);
  const list = Array.isArray(rows) ? rows : (rows as any).rows ?? [];
  for (const r of list) map.set(Number(r.start_id), (r.gates ?? []) as string[]);
  // A node the query returned nothing for still needs an explicit answer.
  for (const id of nodeIds) if (!map.has(id)) map.set(id, []);
  return map;
}

/** Load one node and prove the viewer may read it. Returns null when they may not. */
async function readableNode(viewer: Viewer, id: number): Promise<any | null> {
  const [node] = await db.select().from(driveNodes).where(eq(driveNodes.id, id)).limit(1);
  if (!node) return null;
  const gates = (await gatesFor([id])).get(id) ?? [];
  if (!viewerCanReadDriveNode(viewer, gates)) return null;
  return node;
}

async function log(nodeId: number | null, userId: number, action: string, detail?: string) {
  try {
    await db.insert(driveAccessLog).values({ nodeId: nodeId ?? undefined, userId, action, detail });
  } catch {
    // An audit write must never take down the read it is recording.
  }
}

/** Breadcrumb trail from the root down to (and excluding) the node itself. */
async function breadcrumbs(nodeId: number | null): Promise<{ id: number; name: string }[]> {
  if (!nodeId) return [];
  const rows: any = await db.execute(sql`
    WITH RECURSIVE up AS (
      SELECT id, parent_id, name, 0 AS depth FROM drive_nodes WHERE id = ${nodeId}
      UNION ALL
      SELECT n.id, n.parent_id, n.name, up.depth + 1
      FROM drive_nodes n JOIN up ON n.id = up.parent_id
    )
    SELECT id, name FROM up ORDER BY depth DESC
  `);
  const list = Array.isArray(rows) ? rows : rows.rows ?? [];
  return list.map((r: any) => ({ id: Number(r.id), name: String(r.name) }));
}

/**
 * Folder paths for MANY nodes in one query.
 *
 * 🔴 The search results loop used to await breadcrumbs() per hit — up to 60
 * sequential recursive queries, each a round trip to the database in Sydney,
 * which made search take 5–7 SECONDS at real scale while the full-text query
 * itself was 10ms. One recursive CTE seeded with every parent id answers the
 * whole page at once.
 */
async function pathsFor(parentIds: (number | null)[]): Promise<Map<number, string[]>> {
  const ids = Array.from(new Set(parentIds.filter((x): x is number => typeof x === "number")));
  const map = new Map<number, string[]>();
  if (!ids.length) return map;
  const rows: any = await db.execute(sql`
    WITH RECURSIVE up AS (
      SELECT id AS start_id, id, parent_id, name, 0 AS depth
      FROM drive_nodes WHERE id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
      UNION ALL
      SELECT u.start_id, n.id, n.parent_id, n.name, u.depth + 1
      FROM drive_nodes n JOIN up u ON n.id = u.parent_id
    )
    SELECT start_id, array_agg(name ORDER BY depth DESC) AS path
    FROM up GROUP BY start_id
  `);
  const list = Array.isArray(rows) ? rows : rows.rows ?? [];
  for (const r of list) map.set(Number(r.start_id), (r.path ?? []) as string[]);
  return map;
}

/** The shape the client renders. Never leaks storage keys. */
function present(node: any, gates: string[]) {
  return {
    id: node.id,
    parentId: node.parentId,
    kind: node.kind,
    name: node.name,
    // 🔴 A folder has no mime type and usually no extension, so asking
    // driveCategory alone answers "other" and every folder renders with a file
    // icon. The kind decides first.
    category: node.kind === "folder" ? "folder" : driveCategory(node.mimeType, node.name),
    mimeType: node.mimeType,
    sizeBytes: node.sizeBytes === null || node.sizeBytes === undefined ? null : Number(node.sizeBytes),
    brand: node.brand,
    description: node.description,
    source: node.source,
    sourceUrl: node.sourceUrl,
    // 🔴 When Google holds the editable original, OUR file is a snapshot from
    // import time. Say which is which, or someone edits the download and
    // quietly loses the team's work.
    liveEditable: googleIsLiveEditable(node.sourceUrl),
    liveLabel: googleLinkLabel(node.sourceUrl),
    // Honest about the lock without naming what is behind it.
    restricted: gates.length > 0,
    restrictedLabel: driveGateLabel(gates),
    hasText: node.extractStatus === "done",
    extractStatus: node.extractStatus,
    trashedAt: node.trashedAt,
    updatedAt: node.updatedAt,
    createdAt: node.createdAt,
  };
}

// 🔴 A node cannot be moved inside itself or its own descendant — that severs
// the subtree from every root and it stops appearing anywhere at all.
async function isDescendant(candidateAncestorId: number, nodeId: number): Promise<boolean> {
  const rows: any = await db.execute(sql`
    WITH RECURSIVE down AS (
      SELECT id FROM drive_nodes WHERE id = ${nodeId}
      UNION ALL
      SELECT n.id FROM drive_nodes n JOIN down ON n.parent_id = down.id
    )
    SELECT 1 AS hit FROM down WHERE id = ${candidateAncestorId} LIMIT 1
  `);
  const list = Array.isArray(rows) ? rows : rows.rows ?? [];
  return list.length > 0;
}

export function registerDriveRoutes(app: Express) {
  // ── Who am I ──────────────────────────────────────────────────────────────
  app.get("/api/admin/drive/bootstrap", requireAuth, async (req, res) => {
    try {
      const viewer = await buildViewer(req.session.userId!);
      if (!viewer) return res.status(401).json({ message: "Not signed in" });
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(driveNodes)
        .where(isNull(driveNodes.trashedAt));
      res.json({
        viewer: { userId: viewer.userId, name: viewer.name, isSuperAdmin: viewer.globalRole === "super_admin" },
        totalNodes: count ?? 0,
      });
    } catch (e: any) {
      console.error("[drive] bootstrap failed:", e);
      res.status(500).json({ message: e.message });
    }
  });

  // ── Browse a folder ───────────────────────────────────────────────────────
  app.get("/api/admin/drive/list", requireAuth, async (req, res) => {
    try {
      const viewer = await buildViewer(req.session.userId!);
      if (!viewer) return res.status(401).json({ message: "Not signed in" });

      const parentIdRaw = clean(req.query.parentId as string);
      const parentId = parentIdRaw ? Number(parentIdRaw) : null;
      if (parentIdRaw && !Number.isFinite(parentId)) return res.status(400).json({ message: "Bad folder" });

      // 🔴 Prove the FOLDER is readable before listing it. Otherwise a locked
      // folder's contents are one guessed id away.
      if (parentId) {
        const folder = await readableNode(viewer, parentId);
        if (!folder) return res.status(404).json({ message: "Not found" });
      }

      const rows = await db
        .select()
        .from(driveNodes)
        .where(and(
          parentId ? eq(driveNodes.parentId, parentId) : isNull(driveNodes.parentId),
          isNull(driveNodes.trashedAt),
        ))
        .orderBy(desc(driveNodes.kind), driveNodes.name)
        .limit(1000);

      const gates = await gatesFor(rows.map((r: any) => r.id));
      // Folders first, then files, each alphabetical — the ordering people expect.
      const items = rows
        .filter((r: any) => viewerCanReadDriveNode(viewer, gates.get(r.id) ?? []))
        .map((r: any) => present(r, gates.get(r.id) ?? []))
        .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "folder" ? -1 : 1));

      res.json({ parentId, breadcrumbs: await breadcrumbs(parentId), items });
    } catch (e: any) {
      console.error("[drive] list failed:", e);
      res.status(500).json({ message: e.message });
    }
  });

  // ── Search ────────────────────────────────────────────────────────────────
  // Name (weighted highest — people half-remember filenames), description, and
  // the extracted text. Trigram similarity carries the typos.
  app.get("/api/admin/drive/search", requireAuth, async (req, res) => {
    try {
      const viewer = await buildViewer(req.session.userId!);
      if (!viewer) return res.status(401).json({ message: "Not signed in" });
      const q = clean(req.query.q as string);
      if (!q) return res.json({ items: [], query: "" });

      // 🔴 The three match branches MUST be parenthesised together. AND binds
      // tighter than OR, so `trashed_at IS NULL AND (fts) OR name LIKE …` parses
      // as `(trashed AND fts) OR (name LIKE …)` — and a file in the bin comes
      // straight back out of search on a name match.
      //
      // 🔴 Never SELECT * here. extracted_text holds up to 400KB per row, so
      // returning it for 60 hits shipped megabytes across the Tasman on every
      // keystroke — that, not the query, is what made search take 5–7 seconds.
      // The snippet is cut in SQL and only the columns the page renders come
      // back.
      const like = "%" + q.toLowerCase() + "%";
      const rows: any = await db.execute(sql`
        SELECT id, parent_id, kind, name, mime_type, size_bytes, brand, description,
               source, source_url, extract_status, trashed_at, updated_at, created_at,
          ts_rank(
            setweight(to_tsvector('english', coalesce(name,'')), 'A') ||
            setweight(to_tsvector('english', coalesce(description,'')), 'B') ||
            setweight(to_tsvector('english', coalesce(extracted_text,'')), 'C'),
            plainto_tsquery('english', ${q})
          ) AS rank,
          similarity(lower(name), lower(${q})) AS name_sim,
          CASE WHEN position(lower(${q}) in lower(coalesce(extracted_text,''))) > 0
               THEN substring(extracted_text
                      from greatest(1, position(lower(${q}) in lower(extracted_text)) - 60)
                      for 240)
               ELSE NULL END AS snippet
        FROM drive_nodes
        WHERE trashed_at IS NULL
          AND (
            (
              setweight(to_tsvector('english', coalesce(name,'')), 'A') ||
              setweight(to_tsvector('english', coalesce(description,'')), 'B') ||
              setweight(to_tsvector('english', coalesce(extracted_text,'')), 'C')
            ) @@ plainto_tsquery('english', ${q})
            OR lower(name) LIKE ${like}
            OR similarity(lower(name), lower(${q})) > 0.3
          )
        ORDER BY name_sim DESC, rank DESC, updated_at DESC
        LIMIT 60
      `);
      const list = Array.isArray(rows) ? rows : rows.rows ?? [];
      const gates = await gatesFor(list.map((r: any) => Number(r.id)));

      // Resolve every result's path in ONE query before the loop.
      const paths = await pathsFor(list.map((r: any) => (r.parent_id === null ? null : Number(r.parent_id))));

      const items = [] as any[];
      for (const r of list) {
        const id = Number(r.id);
        if (!viewerCanReadDriveNode(viewer, gates.get(id) ?? [])) continue;
        const node = {
          id, parentId: r.parent_id, kind: r.kind, name: r.name, mimeType: r.mime_type,
          sizeBytes: r.size_bytes, brand: r.brand, description: r.description,
          source: r.source, sourceUrl: r.source_url, extractStatus: r.extract_status,
          trashedAt: r.trashed_at, updatedAt: r.updated_at, createdAt: r.created_at,
        };
        const p: any = present(node, gates.get(id) ?? []);
        // A snippet of WHERE it matched, so a hit on page 40 of a PDF is
        // explicable rather than mysterious. Cut in SQL — see the query above.
        if (r.snippet) p.snippet = "…" + String(r.snippet).replace(/\s+/g, " ").trim() + "…";
        p.path = node.parentId ? (paths.get(Number(node.parentId)) ?? []) : [];
        items.push(p);
      }

      await log(null, viewer.userId, "search", q.slice(0, 200));
      res.json({ query: q, items });
    } catch (e: any) {
      console.error("[drive] search failed:", e);
      res.status(500).json({ message: e.message });
    }
  });

  // ── Create a folder ───────────────────────────────────────────────────────
  app.post("/api/admin/drive/folder", requireAuth, async (req, res) => {
    try {
      const viewer = await buildViewer(req.session.userId!);
      if (!viewer) return res.status(401).json({ message: "Not signed in" });
      const name = clean(req.body?.name);
      if (!name) return res.status(400).json({ message: "Give the folder a name" });
      const parentId = req.body?.parentId ? Number(req.body.parentId) : null;
      if (parentId) {
        const parent = await readableNode(viewer, parentId);
        if (!parent) return res.status(404).json({ message: "Not found" });
        if (parent.kind !== "folder") return res.status(400).json({ message: "That isn't a folder" });
      }
      const [row] = (await db.insert(driveNodes).values({
        parentId: parentId ?? undefined,
        kind: "folder",
        name: name.slice(0, 250),
        brand: clean(req.body?.brand) ?? "all",
        requiredTab: clean(req.body?.requiredTab),
        requiredWorkspace: clean(req.body?.requiredWorkspace),
        ownerUserId: viewer.userId,
        createdBy: viewer.userId,
      }).returning()) as any[];
      await log(row.id, viewer.userId, "create-folder", name);
      res.json(present(row, []));
    } catch (e: any) {
      if (String(e?.message ?? "").includes("drive_nodes_sibling_name") || String(e?.message ?? "").includes("drive_nodes_root_name")) {
        return res.status(409).json({ message: "Something with that name is already here" });
      }
      console.error("[drive] create folder failed:", e);
      res.status(500).json({ message: e.message });
    }
  });

  // ── Upload ────────────────────────────────────────────────────────────────
  app.post(
    "/api/admin/drive/upload",
    requireAuth,
    (req, res, next) =>
      upload.single("file")(req, res, (err: any) =>
        err ? res.status(400).json({ message: err.message ?? "Upload failed" }) : next()),
    async (req, res) => {
      try {
        const viewer = await buildViewer(req.session.userId!);
        if (!viewer) return res.status(401).json({ message: "Not signed in" });
        const file = (req as any).file as { buffer: Buffer; mimetype: string; originalname: string } | undefined;
        if (!file) return res.status(400).json({ message: "No file" });

        const parentId = req.body?.parentId ? Number(req.body.parentId) : null;
        if (parentId) {
          const parent = await readableNode(viewer, parentId);
          if (!parent) return res.status(404).json({ message: "Not found" });
          if (parent.kind !== "folder") return res.status(400).json({ message: "That isn't a folder" });
        }

        const name = (clean(req.body?.name) ?? file.originalname ?? "file").slice(0, 250);
        const contentType = (file.mimetype || "application/octet-stream").split(";")[0];
        const put = await driveStorage().put(file.buffer, contentType, name);

        // Extract inline: the file is already in memory, and a file that lands
        // unsearchable is the exact failure this whole feature exists to avoid.
        const extracted = driveIsExtractable(contentType, name)
          ? await extractText(file.buffer, contentType, name)
          : { text: null, status: "unsupported" as const };

        const [row] = (await db.insert(driveNodes).values({
          parentId: parentId ?? undefined,
          kind: "file",
          name,
          storageKey: put.storageKey,
          storageBackend: put.backend,
          mimeType: contentType,
          sizeBytes: put.sizeBytes,
          checksum: put.checksum,
          brand: clean(req.body?.brand) ?? "all",
          description: clean(req.body?.description),
          extractedText: extracted.text,
          extractStatus: extracted.status,
          extractError: (extracted as any).error,
          ownerUserId: viewer.userId,
          createdBy: viewer.userId,
        }).returning()) as any[];

        await log(row.id, viewer.userId, "upload", `${name} (${put.sizeBytes} bytes)`);
        const gates = (await gatesFor([row.id])).get(row.id) ?? [];
        res.json(present(row, gates));
      } catch (e: any) {
        if (String(e?.message ?? "").includes("drive_nodes_sibling_name")) {
          return res.status(409).json({ message: "A file with that name is already in this folder" });
        }
        console.error("[drive] upload failed:", e);
        res.status(500).json({ message: e.message });
      }
    },
  );

  // ── Open / download ───────────────────────────────────────────────────────
  // Redirects to a short-lived signed URL rather than streaming through the app:
  // it keeps a 200MB file out of the server's memory and gives the browser range
  // requests, so a video scrubs instead of buffering.
  const serve = (download: boolean) => async (req: any, res: any) => {
    try {
      const viewer = await buildViewer(req.session.userId!);
      if (!viewer) return res.status(401).json({ message: "Not signed in" });
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ message: "Bad id" });

      const node = await readableNode(viewer, id);
      // 🔴 404, never 403 — a 403 confirms the file exists and tells you its id
      // is worth guessing at. Same doctrine as the hiring by-id routes.
      if (!node || node.kind !== "file" || !node.storageKey) return res.status(404).json({ message: "Not found" });

      const url = await driveStorage().signedUrl(node.storageKey, {
        download: download ? node.name : undefined,
        expiresIn: 300,
      });
      await db.update(driveNodes)
        .set({ viewCount: sql`${driveNodes.viewCount} + 1`, lastOpenedAt: new Date() })
        .where(eq(driveNodes.id, id));
      await log(id, viewer.userId, download ? "download" : "view", node.name);
      res.redirect(url);
    } catch (e: any) {
      console.error("[drive] serve failed:", e);
      res.status(500).json({ message: e.message });
    }
  };
  app.get("/api/admin/drive/file/:id/open", requireAuth, serve(false));
  app.get("/api/admin/drive/file/:id/download", requireAuth, serve(true));

  // ── Details (with the text we extracted) ──────────────────────────────────
  app.get("/api/admin/drive/node/:id", requireAuth, async (req, res) => {
    try {
      const viewer = await buildViewer(req.session.userId!);
      if (!viewer) return res.status(401).json({ message: "Not signed in" });
      const id = Number(req.params.id);
      const node = await readableNode(viewer, id);
      if (!node) return res.status(404).json({ message: "Not found" });
      const gates = (await gatesFor([id])).get(id) ?? [];

      let owner: string | null = null;
      if (node.ownerUserId) {
        const [u] = await db
          .select({ first: usersTable.firstName, last: usersTable.lastName })
          .from(usersTable)
          .where(eq(usersTable.id, node.ownerUserId))
          .limit(1);
        owner = u ? `${u.first} ${u.last}`.trim() : null;
      }
      res.json({
        ...present(node, gates),
        owner,
        checksum: node.checksum,
        breadcrumbs: await breadcrumbs(node.parentId),
        textPreview: node.extractedText ? String(node.extractedText).slice(0, 4000) : null,
      });
    } catch (e: any) {
      console.error("[drive] node failed:", e);
      res.status(500).json({ message: e.message });
    }
  });

  // ── Rename / move / describe ──────────────────────────────────────────────
  app.patch("/api/admin/drive/node/:id", requireAuth, async (req, res) => {
    try {
      const viewer = await buildViewer(req.session.userId!);
      if (!viewer) return res.status(401).json({ message: "Not signed in" });
      const id = Number(req.params.id);
      const node = await readableNode(viewer, id);
      if (!node) return res.status(404).json({ message: "Not found" });

      const patch: any = { updatedBy: viewer.userId, updatedAt: new Date() };
      const name = clean(req.body?.name);
      if (name) patch.name = name.slice(0, 250);
      if ("description" in (req.body ?? {})) patch.description = clean(req.body?.description) ?? null;
      if (clean(req.body?.brand)) patch.brand = clean(req.body?.brand);

      if ("parentId" in (req.body ?? {})) {
        const target = req.body.parentId === null ? null : Number(req.body.parentId);
        if (target !== null) {
          if (!Number.isFinite(target)) return res.status(400).json({ message: "Bad folder" });
          const dest = await readableNode(viewer, target);
          if (!dest || dest.kind !== "folder") return res.status(404).json({ message: "Not found" });
          if (target === id) return res.status(400).json({ message: "A folder can't be moved into itself" });
          if (await isDescendant(target, id)) {
            return res.status(400).json({ message: "A folder can't be moved into one of its own subfolders" });
          }
        }
        patch.parentId = target;
      }

      // 🔴 Changing a gate. You cannot open a door you were never behind: the
      // viewer must be able to reach BOTH the old gate and the new one, or a
      // team member could unlock a restricted folder for the whole club.
      if ("requiredTab" in (req.body ?? {})) {
        const to = clean(req.body?.requiredTab) ?? null;
        const toWs = clean(req.body?.requiredWorkspace) ?? null;
        const currentGates = (await gatesFor([id])).get(id) ?? [];
        if (!viewerCanReadDriveNode(viewer, currentGates)) return res.status(404).json({ message: "Not found" });
        if (to && !viewerCanReadDriveNode(viewer, [`${to}@${toWs ?? ""}`])) {
          return res.status(403).json({ message: "You can't restrict something to a tab you can't open yourself" });
        }
        patch.requiredTab = to;
        patch.requiredWorkspace = toWs;
      }

      const [row] = (await db.update(driveNodes).set(patch).where(eq(driveNodes.id, id)).returning()) as any[];
      await log(id, viewer.userId, "update", Object.keys(patch).filter((k) => k !== "updatedBy" && k !== "updatedAt").join(","));
      res.json(present(row, (await gatesFor([id])).get(id) ?? []));
    } catch (e: any) {
      if (String(e?.message ?? "").includes("drive_nodes_sibling_name") || String(e?.message ?? "").includes("drive_nodes_root_name")) {
        return res.status(409).json({ message: "Something with that name is already there" });
      }
      console.error("[drive] patch failed:", e);
      res.status(500).json({ message: e.message });
    }
  });

  // ── Trash / restore ───────────────────────────────────────────────────────
  // 🔴 Nothing here ever issues a DELETE. A club's files are legal records.
  app.post("/api/admin/drive/node/:id/trash", requireAuth, async (req, res) => {
    try {
      const viewer = await buildViewer(req.session.userId!);
      if (!viewer) return res.status(401).json({ message: "Not signed in" });
      const id = Number(req.params.id);
      const node = await readableNode(viewer, id);
      if (!node) return res.status(404).json({ message: "Not found" });
      if (node.trashedAt) return res.json({ ok: true });

      // Trash the whole subtree in one statement — a folder whose children stay
      // live would leave them reachable by search with no way back to a parent.
      await db.execute(sql`
        WITH RECURSIVE down AS (
          SELECT id FROM drive_nodes WHERE id = ${id}
          UNION ALL
          SELECT n.id FROM drive_nodes n JOIN down ON n.parent_id = down.id
        )
        UPDATE drive_nodes SET trashed_at = now(), trashed_by = ${viewer.userId}
        WHERE id IN (SELECT id FROM down) AND trashed_at IS NULL
      `);
      await log(id, viewer.userId, "trash", node.name);
      res.json({ ok: true });
    } catch (e: any) {
      console.error("[drive] trash failed:", e);
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/admin/drive/node/:id/restore", requireAuth, async (req, res) => {
    try {
      const viewer = await buildViewer(req.session.userId!);
      if (!viewer) return res.status(401).json({ message: "Not signed in" });
      const id = Number(req.params.id);
      const [node] = await db.select().from(driveNodes).where(eq(driveNodes.id, id)).limit(1);
      if (!node) return res.status(404).json({ message: "Not found" });
      const gates = (await gatesFor([id])).get(id) ?? [];
      if (!viewerCanReadDriveNode(viewer, gates)) return res.status(404).json({ message: "Not found" });

      // Restoring into a trashed parent would put it somewhere unreachable, so
      // the ancestors come back with it.
      await db.execute(sql`
        WITH RECURSIVE up AS (
          SELECT id, parent_id FROM drive_nodes WHERE id = ${id}
          UNION ALL
          SELECT n.id, n.parent_id FROM drive_nodes n JOIN up ON n.id = up.parent_id
        ), down AS (
          SELECT id FROM drive_nodes WHERE id = ${id}
          UNION ALL
          SELECT n.id FROM drive_nodes n JOIN down ON n.parent_id = down.id
        )
        UPDATE drive_nodes SET trashed_at = NULL, trashed_by = NULL
        WHERE id IN (SELECT id FROM up UNION SELECT id FROM down)
      `);
      await log(id, viewer.userId, "restore", node.name);
      res.json({ ok: true });
    } catch (e: any) {
      console.error("[drive] restore failed:", e);
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/admin/drive/trash", requireAuth, async (req, res) => {
    try {
      const viewer = await buildViewer(req.session.userId!);
      if (!viewer) return res.status(401).json({ message: "Not signed in" });
      const rows = await db.select().from(driveNodes)
        .where(isNotNull(driveNodes.trashedAt))
        .orderBy(desc(driveNodes.trashedAt))
        .limit(200);
      const gates = await gatesFor(rows.map((r: any) => r.id));
      res.json({
        items: rows
          .filter((r: any) => viewerCanReadDriveNode(viewer, gates.get(r.id) ?? []))
          .map((r: any) => present(r, gates.get(r.id) ?? [])),
      });
    } catch (e: any) {
      console.error("[drive] trash list failed:", e);
      res.status(500).json({ message: e.message });
    }
  });
}
