// ─────────────────────────────────────────────────────────────────────────────
// Market Research — competitor & category intelligence (Sandbox workspace).
//
// Read-only. Serves the research snapshots produced by the offline research
// fleet (see DanielMeynOS: outputs/market-research/ + scripts/market_research/).
//
// Every snapshot carries its own evidence trail. The `sources` snapshot records
// which sources were reachable when the research ran and which were blocked —
// so a reader can never mistake an absent source for an absent finding.
//
// Access: locked to super_admin via requireAuth + requireTab("market-research")
// and the SUPER_ADMIN_ONLY_TABS entry in shared/tabs.ts.
// ─────────────────────────────────────────────────────────────────────────────
import type { Express } from "express";
import { sql } from "drizzle-orm";
import { db } from "./db";
import { requireAuth, requireTab } from "./auth";

type SnapshotRow = {
  slug: string;
  kind: "master" | "vertical" | "sources";
  title: string;
  generated_at: string;
  payload: unknown;
};

export function registerMarketResearchRoutes(app: Express) {
  // Index: everything the tab needs in one call. The corpus is small (single-digit
  // MB at most) and read by one person, so there is no value in paginating it.
  app.get(
    "/api/admin/market-research",
    requireAuth,
    requireTab("market-research"),
    async (_req, res) => {
      try {
        const result = await db.execute(sql`
          SELECT slug, kind, title, generated_at, payload
            FROM market_research_snapshots
           ORDER BY
             CASE kind WHEN 'sources' THEN 0 WHEN 'master' THEN 1 ELSE 2 END,
             title ASC
        `);

        const rows = (result.rows ?? []) as unknown as SnapshotRow[];

        // An empty table means the research has not been seeded into this
        // environment — say that explicitly rather than rendering a blank page
        // that reads like "no competitors found".
        if (rows.length === 0) {
          return res.json({
            seeded: false,
            message:
              "No research snapshots in this database yet. Run script/seed-market-research.ts against the research output.",
            sources: null,
            master: null,
            verticals: [],
          });
        }

        const sources = rows.find((r) => r.kind === "sources") ?? null;
        const master = rows.find((r) => r.kind === "master") ?? null;
        const verticals = rows.filter((r) => r.kind === "vertical");

        res.json({
          seeded: true,
          generatedAt: master?.generated_at ?? rows[0].generated_at,
          sources: sources?.payload ?? null,
          master: master?.payload ?? null,
          verticals: verticals.map((v) => ({
            slug: v.slug,
            title: v.title,
            generatedAt: v.generated_at,
            ...(v.payload as Record<string, unknown>),
          })),
        });
      } catch (err) {
        // A missing table is the common case before the migration is applied.
        const msg = err instanceof Error ? err.message : String(err);
        if (/market_research_snapshots/.test(msg) && /does not exist/i.test(msg)) {
          return res.status(503).json({
            seeded: false,
            message:
              "market_research_snapshots table is missing — apply migrations/2026-07-10_market_research.sql first.",
          });
        }
        console.error("[market-research] index failed:", err);
        res.status(500).json({ message: "Failed to load market research" });
      }
    },
  );

  // Single vertical, for deep-linking straight to one brief.
  app.get(
    "/api/admin/market-research/:slug",
    requireAuth,
    requireTab("market-research"),
    async (req, res) => {
      try {
        const result = await db.execute(sql`
          SELECT slug, kind, title, generated_at, payload
            FROM market_research_snapshots
           WHERE slug = ${req.params.slug}
           LIMIT 1
        `);
        const row = (result.rows ?? [])[0] as unknown as SnapshotRow | undefined;
        if (!row) return res.status(404).json({ message: "Snapshot not found" });
        res.json({ ...row, payload: row.payload });
      } catch (err) {
        console.error("[market-research] snapshot failed:", err);
        res.status(500).json({ message: "Failed to load snapshot" });
      }
    },
  );
}
