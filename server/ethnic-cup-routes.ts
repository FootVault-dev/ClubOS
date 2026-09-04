/**
 * Christchurch Ethnic Cup — registrations of interest.
 *
 * Phase 1 of the Ethnic Cup module: get the register-interest form on
 * ethniccup.com off email-only and into ClubOS, where it can be worked through.
 * Entries and payment are Phase 2 and deliberately not here — Daniel's call was
 * that no money is taken until the venue is confirmed.
 *
 * The Cup lives under the CIC organisation (same as CIC 7's), surfaced through
 * the CIC workspace's view switcher rather than its own workspace.
 */
import type { Express, Request, Response } from "express";
import { eq, desc, and } from "drizzle-orm";
import { db } from "./db";
import { ethnicCupRegistrations, organizations } from "@shared/schema";
import { requireAuth, requireTab } from "./auth";
import * as tp from "./teampay";

const CIC_ORG_SLUG = "christchurch-international-cup";
const TAB = "ethnic-cup-registrations";

/**
 * The Team Pay competition a registration turns into. One Cup, one competition
 * row, so this is a constant rather than a lookup — and it is overridable in
 * the request body for the year this stops being true.
 */
const DEFAULT_COMPETITION_SLUG = "ethnic-cup-2026";

// Statuses are validated in app code, not by a DB CHECK — a stale CHECK
// constraint is how the MFL checkout once 500'd.
const STATUSES = ["new", "contacted", "entered", "declined", "archived"] as const;
type Status = (typeof STATUSES)[number];

let orgIdCache: number | null = null;
async function cicOrgId(): Promise<number> {
  if (orgIdCache) return orgIdCache;
  const [org] = await db.select().from(organizations).where(eq(organizations.slug, CIC_ORG_SLUG));
  if (!org) throw new Error("CIC organization not found");
  orgIdCache = org.id;
  return org.id;
}

const SITE_ORIGINS = ["https://ethniccup.com", "https://www.ethniccup.com"];
function setCors(req: Request, res: Response) {
  const origin = String(req.headers.origin || "");
  if (SITE_ORIGINS.includes(origin) || /\.vercel\.app$/.test(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
  }
  res.header("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
}

export function registerEthnicCupRoutes(app: Express) {
  // ── public: the form on ethniccup.com ────────────────────────────────────
  app.options("/api/public/ethnic-cup/register-interest", (req, res) => {
    setCors(req, res);
    res.sendStatus(204);
  });

  app.post("/api/public/ethnic-cup/register-interest", async (req: Request, res: Response) => {
    setCors(req, res);
    try {
      const firstName = String(req.body?.firstName || "").trim();
      const lastName = String(req.body?.lastName || "").trim();
      const email = String(req.body?.email || "").trim();
      const phone = String(req.body?.phone || "").trim();
      const community = String(req.body?.community || "").trim();
      const grade = String(req.body?.grade || "").trim();
      const message = String(req.body?.message || "").trim().slice(0, 2000);
      const sourceUrl = String(req.body?.sourceUrl || "ethniccup.com").slice(0, 300);

      if (!firstName || !community || !/.+@.+\..+/.test(email)) {
        return res.status(400).json({ message: "Please add your name, community and a valid email." });
      }

      const organizationId = await cicOrgId();
      const [row] = await db
        .insert(ethnicCupRegistrations)
        .values({
          organizationId,
          firstName,
          lastName: lastName || null,
          email,
          phone: phone || null,
          community,
          grade: grade || null,
          message: message || null,
          sourceUrl,
          status: "new",
        })
        .returning({ id: ethnicCupRegistrations.id });

      // The site still sends its own emails via Resend; ClubOS is the record.
      res.json({ ok: true, id: row?.id });
    } catch (e: any) {
      console.error("[EthnicCup register] error:", e?.message || e);
      res.status(500).json({ message: "Could not save that just now. Please try again." });
    }
  });

  // ── admin: the Registrations board in the CIC workspace ──────────────────
  app.get("/api/admin/ethnic-cup/registrations", requireAuth, requireTab(TAB), async (_req, res) => {
    try {
      const organizationId = await cicOrgId();
      const rows = await db
        .select()
        .from(ethnicCupRegistrations)
        .where(eq(ethnicCupRegistrations.organizationId, organizationId))
        .orderBy(desc(ethnicCupRegistrations.createdAt));

      // Counts are DERIVED here, never stored — a stored tally drifts the first
      // time a row is edited outside this endpoint.
      const counts: Record<string, number> = { total: rows.length };
      for (const s of STATUSES) counts[s] = rows.filter((r) => r.status === s).length;

      res.json({ rows, counts, statuses: STATUSES });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.patch("/api/admin/ethnic-cup/registrations/:id", requireAuth, requireTab(TAB), async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ message: "Bad id" });

      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (req.body?.status !== undefined) {
        const status = String(req.body.status) as Status;
        if (!STATUSES.includes(status)) return res.status(400).json({ message: "Unknown status" });
        patch.status = status;
      }
      if (req.body?.notes !== undefined) patch.notes = String(req.body.notes).slice(0, 4000) || null;
      if (Object.keys(patch).length === 1) return res.status(400).json({ message: "Nothing to update" });

      // Scoped to the CIC org so an id from another workspace can never be
      // reached; a miss answers 404 rather than leaking that the row exists.
      const organizationId = await cicOrgId();
      const [row] = await db
        .update(ethnicCupRegistrations)
        .set(patch)
        .where(and(eq(ethnicCupRegistrations.id, id), eq(ethnicCupRegistrations.organizationId, organizationId)))
        .returning();
      if (!row) return res.status(404).json({ message: "Not found" });
      res.json(row);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  /**
   * Turn a registration of interest into a real, payable team entry.
   *
   * 🔴 This is the whole point of the bridge. Before it, a registration was a
   * name in a list and "entered" was a word somebody typed; the person who had
   * put their hand up had no way to pay and no link to follow. Now one click
   * creates their entry, emails them their team page, and records WHICH entry
   * they became.
   *
   * Deliberately staff-triggered rather than automatic on submission. Interest
   * is not commitment — auto-creating an entry for everyone who fills in a form
   * would put phantom teams in the draw, each holding a squad nobody is filling.
   */
  app.post("/api/admin/ethnic-cup/registrations/:id/create-entry", requireAuth, requireTab(TAB), async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ message: "Bad id" });

      const organizationId = await cicOrgId();
      const [reg] = await db
        .select()
        .from(ethnicCupRegistrations)
        .where(and(eq(ethnicCupRegistrations.id, id), eq(ethnicCupRegistrations.organizationId, organizationId)));
      if (!reg) return res.status(404).json({ message: "Not found" });

      // 🔴 Checked before the insert AND enforced by a unique index, because
      // this endpoint is a button a staff member can double-click. Without the
      // index the second click gives one community two teams in the draw.
      if (reg.teampayEntryId) {
        return res.status(409).json({ message: "This registration already has a team entry." });
      }

      const slug = String(req.body?.slug || DEFAULT_COMPETITION_SLUG);
      const teamName = String(req.body?.teamName || reg.community || "").trim();
      if (!teamName) {
        return res.status(400).json({ message: "This registration has no community or team name — add one first." });
      }

      const r = await tp.createEntry({
        slug,
        teamName,
        community: reg.community,
        managerName: [reg.firstName, reg.lastName].filter(Boolean).join(" "),
        managerEmail: reg.email,
        managerPhone: reg.phone,
        // Left unset on purpose: the competition's own default applies, and
        // nobody has asked this person how big their squad is.
        squadSize: null,
        paymentMode: req.body?.paymentMode ?? null,
      });
      if (r.error || !r.entry) return res.status(400).json({ message: r.error || "Could not create that entry." });

      await db
        .update(ethnicCupRegistrations)
        .set({ teampayEntryId: r.entry.id, status: "entered", updatedAt: new Date() })
        .where(eq(ethnicCupRegistrations.id, id));

      res.json({ ok: true, entryId: r.entry.id, dashboardUrl: r.dashboardUrl });
    } catch (e: any) {
      console.error("[EthnicCup create-entry] error:", e?.message || e);
      res.status(500).json({ message: e.message });
    }
  });
}
