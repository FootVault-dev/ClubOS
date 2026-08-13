// ─────────────────────────────────────────────────────────────────────────────
// VIEW AS — see ClubOS exactly as a member of staff sees it.
//
// Built 2026-08-13 (Daniel). Twice in two days a staff member reported a
// feature as broken or half-finished when it was built and working — Olga's
// blank Contacts tab and Travis's blank CRM detail page — and both times the
// only reason it took an investigation is that a super admin CANNOT REPRODUCE
// what staff see. Daniel logs in and everything works, because super_admin
// short-circuits the permission checks that everyone else runs. This closes
// that gap: pick a person, see their ClubOS, come back.
//
//   GET  /api/admin/view-as/users     — who can be viewed as
//   POST /api/admin/view-as/:userId   — start
//   POST /api/admin/view-as/stop      — stop  (the ONE write allowed while on)
//
// ── The safety rules ────────────────────────────────────────────────────────
//
// 🔴 READ-ONLY, enforced globally. While viewing as someone, every non-GET
//    request is refused. This codebase treats "who did this" as load-bearing —
//    served_by_user_id is ON DELETE RESTRICT so a cash sale never loses its
//    operator, refunds are attributed to a named person, and the roll records
//    who marked it. A write made while impersonating would land in those
//    records under the staff member's name. An accidental click must never
//    make it look like Travis refunded a customer. Looking is the whole
//    feature; writing is not part of it.
//
// 🔴 SUPER ADMIN ONLY, and never onto another super admin. The first is who is
//    trusted with it; the second means it can never be used to launder an
//    action through a peer account.
//
// 🔴 EVERY SESSION IS AUDITED to view_as_events — who, whom, when it started,
//    when it ended. An impersonation feature that leaves no trace is exactly
//    the thing a security review should refuse.
//
// 🔴 THE REAL IDENTITY IS NEVER OVERWRITTEN. session.viewAsOriginalUserId holds
//    Daniel; session.userId becomes the target so every existing permission
//    check runs unmodified — which is the point, since a bespoke "preview"
//    path would be a second implementation of permissions and would drift from
//    the real one. Stopping restores from that field, so a session can always
//    get home even if the target account is later deleted.
// ─────────────────────────────────────────────────────────────────────────────
import type { Express, Request, Response, NextFunction } from "express";
import { sql } from "drizzle-orm";
import { db } from "./db";
import { storage } from "./storage";
import { requireAuth } from "./auth";

/** Endpoints that must keep working while viewing as someone. */
const ALWAYS_ALLOWED = new Set(["/api/admin/view-as/stop"]);

/**
 * Global gate: while a view-as session is active, nothing may be written.
 * Mounted before the routes so no handler can be reached another way.
 */
export function viewAsReadOnly(req: Request, res: Response, next: NextFunction) {
  const original = (req.session as any).viewAsOriginalUserId;
  if (!original) return next();
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  if (ALWAYS_ALLOWED.has(req.path)) return next();
  return res.status(403).json({
    message: "You're viewing as someone else, which is read-only. Stop viewing to make changes.",
    viewAsReadOnly: true,
  });
}

async function isSuperAdmin(userId: number): Promise<boolean> {
  const u = await storage.getUser(userId);
  return !!u && u.role === "super_admin";
}

/** The real person behind the session, whoever is being viewed. */
export function actingUserId(req: Request): number | undefined {
  return (req.session as any).viewAsOriginalUserId ?? req.session.userId;
}

export function registerViewAsRoutes(app: Express) {
  // Who can be viewed as. Deliberately NOT every contact — only real staff
  // logins, with the workspaces they belong to so Daniel can pick the person
  // whose complaint he is chasing.
  app.get("/api/admin/view-as/users", requireAuth, async (req: Request, res: Response) => {
    try {
      const me = actingUserId(req)!;
      if (!(await isSuperAdmin(me))) return res.status(403).json({ message: "Super admin only" });

      const rows = await db.execute(sql`
        SELECT u.id, u.email, u.first_name, u.last_name, u.role::text AS role, u.active,
               COALESCE(json_agg(json_build_object(
                 'slug', o.slug, 'name', o.name, 'role', uo.role::text, 'tabs', uo.tabs
               ) ORDER BY o.id) FILTER (WHERE o.id IS NOT NULL), '[]') AS workspaces
        FROM users u
        LEFT JOIN user_organizations uo ON uo.user_id = u.id
        LEFT JOIN organizations o ON o.id = uo.organization_id
        WHERE u.active = true AND u.role <> 'super_admin' AND u.id <> ${me}
        GROUP BY u.id
        ORDER BY lower(u.first_name), lower(u.last_name)`);

      res.json({
        users: (rows.rows as any[]).map(r => ({
          id: Number(r.id), email: r.email,
          firstName: r.first_name, lastName: r.last_name,
          role: r.role, workspaces: r.workspaces || [],
        })),
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/admin/view-as/:userId", requireAuth, async (req: Request, res: Response) => {
    try {
      const me = actingUserId(req)!;
      if (!(await isSuperAdmin(me))) return res.status(403).json({ message: "Super admin only" });

      const targetId = parseInt(String(req.params.userId), 10);
      if (!Number.isFinite(targetId)) return res.status(400).json({ message: "Invalid user" });
      if (targetId === me) return res.status(400).json({ message: "That's already you" });

      const target = await storage.getUser(targetId);
      if (!target || !target.active) return res.status(404).json({ message: "No such active staff account" });
      // Never onto a peer: impersonation must not be a way to act as another
      // person who also holds the highest privilege.
      if (target.role === "super_admin") {
        return res.status(403).json({ message: "You can't view as another super admin." });
      }

      const ins = await db.execute(sql`
        INSERT INTO view_as_events (actor_user_id, target_user_id, started_at)
        VALUES (${me}, ${targetId}, now()) RETURNING id`);

      (req.session as any).viewAsOriginalUserId = me;
      (req.session as any).viewAsEventId = Number((ins.rows as any[])[0].id);
      req.session.userId = targetId;
      req.session.save(() => {
        res.json({
          viewingAs: {
            id: target.id, firstName: target.firstName, lastName: target.lastName,
            email: target.email,
          },
        });
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/admin/view-as/stop", requireAuth, async (req: Request, res: Response) => {
    try {
      const original = (req.session as any).viewAsOriginalUserId;
      if (!original) return res.status(400).json({ message: "You're not viewing as anyone" });
      const eventId = (req.session as any).viewAsEventId;

      req.session.userId = Number(original);
      delete (req.session as any).viewAsOriginalUserId;
      delete (req.session as any).viewAsEventId;

      if (eventId) {
        await db.execute(sql`UPDATE view_as_events SET ended_at = now() WHERE id = ${eventId}`);
      }
      req.session.save(() => res.json({ stopped: true }));
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });
}
