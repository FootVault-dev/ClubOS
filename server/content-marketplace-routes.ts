// ─────────────────────────────────────────────────────────────────────────────
// CIC Content Marketplace — live sales + engagement analytics.
//
// The CIC photo store (content.cicyouth.com, the `apps/cic-photos` app) keeps
// its data in the SEPARATE usg-meet Supabase project — NOT ClubOS's own DB —
// in two tables:
//   • photos_orders  — one row per checkout (paid / pending)
//   • photos_events  — storefront funnel events (impression → view → … → purchase)
//
// This module reads those two tables (service-role, read-only) and returns the
// aggregates the CIC "Content Marketplace" tab renders. It mirrors the
// storefront's own token-gated /api/admin dashboard so ClubOS shows the same
// numbers the store owner sees — but behind ClubOS staff auth instead of a token.
//
// Reuses `meetDb` (the usg-meet client) already exported by watch-supabase.ts.
// No ClubOS DB tables, no migration — all data lives in usg-meet.
//
// Gated: requireAuth + requireTab("cic-content-marketplace"). Because that slug
// is NOT in SUPER_ADMIN_ONLY_TABS, requireTab lets super_admin AND anyone with
// admin/manager role in the CIC (tournament) workspace through — same as the
// sibling CIC tabs (Mailer, Registrations, Logo Consents).
// ─────────────────────────────────────────────────────────────────────────────
import type { Express } from "express";
import { meetDb } from "./watch-supabase";
import { requireAuth, requireTab } from "./auth";

// Funnel event names, in journey order. `visit` is a page-load event (carries a
// traffic `source`); the rest are per-photo interactions.
const FUNNEL_EVENTS = [
  "impression",
  "view",
  "quickview",
  "click",
  "addtocart",
  "purchase",
  "visit",
] as const;

// Per-photo metrics (everything except `visit`, which has no photo_id).
type PhotoCounts = {
  id: string;
  impression: number;
  view: number;
  quickview: number;
  click: number;
  addtocart: number;
  purchase: number;
};

export function registerContentMarketplaceRoutes(app: Express) {
  app.get(
    "/api/admin/cic/content-marketplace",
    requireAuth,
    requireTab("cic-content-marketplace"),
    async (_req, res) => {
      try {
        // ── Events → funnel totals, per-photo leaderboard, traffic sources ────
        const { data: events, error: evErr } = await meetDb
          .from("photos_events")
          .select("event, photo_id, source")
          .limit(200000);
        if (evErr) throw new Error(evErr.message);

        const totals: Record<string, number> = {
          impression: 0,
          view: 0,
          quickview: 0,
          click: 0,
          addtocart: 0,
          purchase: 0,
          visit: 0,
        };
        const perPhoto: Record<string, PhotoCounts> = {};
        const visitsBySource: Record<string, number> = {};

        for (const e of events || []) {
          const ev = e.event as string;
          if (ev in totals) totals[ev] += 1;
          if (ev === "visit") {
            const src = ((e.source as string) || "direct").trim() || "direct";
            visitsBySource[src] = (visitsBySource[src] || 0) + 1;
          }
          const pid = e.photo_id as string | null;
          if (pid) {
            const p = (perPhoto[pid] ||= {
              id: pid,
              impression: 0,
              view: 0,
              quickview: 0,
              click: 0,
              addtocart: 0,
              purchase: 0,
            });
            if (ev in p) (p as any)[ev] += 1;
          }
        }

        // ── Orders → KPIs + table (most recent first) ─────────────────────────
        const { data: orders, error: ordErr } = await meetDb
          .from("photos_orders")
          .select(
            "order_ref, order_number, email, name, qty, total_cents, discount_code, status, created_at, paid_at",
          )
          .order("created_at", { ascending: false })
          .limit(1000);
        if (ordErr) throw new Error(ordErr.message);

        const paid = (orders || []).filter((o) => o.status === "paid");
        const revenueCents = paid.reduce((s, o) => s + (o.total_cents || 0), 0);
        const photosSold = paid.reduce((s, o) => s + (o.qty || 0), 0);

        res.json({
          totals,
          revenueCents,
          paidOrders: paid.length,
          photosSold,
          totalViews: totals.view,
          visitsBySource,
          perPhoto: Object.values(perPhoto),
          orders: orders || [],
          generatedAt: new Date().toISOString(),
        });
      } catch (e: any) {
        console.error("[content-marketplace] load failed:", e);
        res.status(500).json({ message: e?.message || "Failed to load analytics" });
      }
    },
  );
}
