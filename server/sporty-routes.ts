// Sporty / NZ Football NRS sync — admin API. Gated by requireTab("sporty"),
// which sits in SUPER_ADMIN_ONLY_TABS (Daniel-only while the integration is in
// UAT). Org comes from the X-Workspace-Slug header, never the body — the tab
// lives in the camps workspaces (CUFC is the club whose players register with
// NZF). There are NO public endpoints here and no API-key surface: pushing
// children's identity data to a national register is a staff-session action.

import type { Express, Request, Response, NextFunction } from "express";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { organizations } from "@shared/schema";
import { requireAuth, requireTab } from "./auth";
import {
  buildCandidates,
  pushCandidates,
  refreshReferenceData,
  sportyLogFor,
  sportyOverview,
  setExcluded,
} from "./sporty-engine";
import { SportyClient, readSportyConfig } from "./sporty-client";

class BadRequest extends Error {}

async function workspaceOrg(req: Request): Promise<{ id: number; slug: string } | null> {
  const slug = String(req.headers["x-workspace-slug"] || "").trim();
  if (!slug) return null;
  const [org] = await db.select().from(organizations).where(eq(organizations.slug, slug));
  return org ? { id: org.id, slug: org.slug } : null;
}

function handler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, _next: NextFunction) => {
    fn(req, res).catch((e) => {
      if (e instanceof BadRequest) {
        res.status(400).json({ message: e.message });
        return;
      }
      console.error("[sporty] route error:", e);
      res.status(500).json({ message: e?.message || "Internal error" });
    });
  };
}

function scopeParam(req: Request): string {
  const scope = String(req.query.scope || req.body?.scope || "academy");
  return scope === "all" ? "all" : "academy";
}

export function registerSportyRoutes(app: Express) {
  const tab = requireTab("sporty");

  async function orgOf(req: Request): Promise<number> {
    const org = await workspaceOrg(req);
    if (!org) throw new BadRequest("X-Workspace-Slug header required");
    return org.id;
  }

  app.get(
    "/api/admin/sporty/overview",
    requireAuth,
    tab,
    handler(async (req, res) => {
      const orgId = await orgOf(req);
      res.json(await sportyOverview(orgId, scopeParam(req)));
    }),
  );

  // Candidates + their preflight verdicts + the exact payload each push would
  // send. The payload IS the preview — staff eyeball what reaches NZF before
  // anything reaches NZF. No network calls happen here.
  app.get(
    "/api/admin/sporty/candidates",
    requireAuth,
    tab,
    handler(async (req, res) => {
      const orgId = await orgOf(req);
      const search = String(req.query.search || "").trim() || undefined;
      const built = await buildCandidates(orgId, { scope: scopeParam(req), search });
      res.json({
        rows: built.map(({ candidate, build, displayStatus }) => ({
          contactId: candidate.contactId,
          firstName: candidate.firstName,
          lastName: candidate.lastName,
          dateOfBirth: candidate.dateOfBirth,
          gender: candidate.gender,
          programs: candidate.programs,
          seasonYears: candidate.seasonYears,
          lastRegisteredAt: candidate.lastRegisteredAt,
          displayStatus,
          isMinor: build.isMinor,
          sportyId: candidate.state?.sportyId ?? null,
          personFifaId: candidate.state?.personFifaId ?? null,
          blockReason: candidate.state?.blockReason ?? null,
          lastError: candidate.state?.lastError ?? null,
          lastPushedAt: candidate.state?.lastPushedAt?.toISOString() ?? null,
          excludedReason: candidate.state?.excludedReason ?? null,
          issues: build.issues,
          payload: build.payload,
        })),
      });
    }),
  );

  // The live push. Explicit contact ids + confirm:true — "push everything"
  // is expressed by the client sending every ready id it can see, so the
  // request always records exactly which children were pushed on whose click.
  app.post(
    "/api/admin/sporty/push",
    requireAuth,
    tab,
    handler(async (req, res) => {
      const orgId = await orgOf(req);
      const body = req.body ?? {};
      if (body.confirm !== true) throw new BadRequest("Set confirm:true to push to Sporty");
      const contactIds: unknown = body.contactIds;
      if (!Array.isArray(contactIds) || contactIds.length === 0) throw new BadRequest("contactIds[] required");
      if (contactIds.length > 500) throw new BadRequest("Push at most 500 players per run");
      const ids = contactIds.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0);
      if (ids.length !== contactIds.length) throw new BadRequest("contactIds must be positive integers");
      const result = await pushCandidates(orgId, ids, { scope: scopeParam(req), force: body.force === true });
      res.json(result);
    }),
  );

  app.post(
    "/api/admin/sporty/refresh-reference",
    requireAuth,
    tab,
    handler(async (_req, res) => {
      const config = readSportyConfig();
      if (!config) throw new BadRequest("Sporty API credentials are not installed yet (SPORTY_API_KEY / SPORTY_API_USERNAME / SPORTY_API_PASSWORD in .env)");
      const counts = await refreshReferenceData(new SportyClient(config));
      res.json({ ok: true, ...counts });
    }),
  );

  app.post(
    "/api/admin/sporty/test-connection",
    requireAuth,
    tab,
    handler(async (_req, res) => {
      const config = readSportyConfig();
      if (!config) {
        res.json({ ok: false, installed: false, error: "Sporty API credentials are not installed yet. NZ Football provides UAT keys once we confirm development is complete." });
        return;
      }
      const result = await new SportyClient(config).testConnection();
      res.json({ installed: true, baseUrl: config.baseUrl, ...result });
    }),
  );

  app.get(
    "/api/admin/sporty/log",
    requireAuth,
    tab,
    handler(async (req, res) => {
      const orgId = await orgOf(req);
      const contactId = req.query.contactId ? Number(req.query.contactId) : undefined;
      if (contactId !== undefined && (!Number.isInteger(contactId) || contactId <= 0)) throw new BadRequest("contactId must be a positive integer");
      const rows = await sportyLogFor(orgId, contactId);
      res.json({ rows });
    }),
  );

  app.post(
    "/api/admin/sporty/exclude",
    requireAuth,
    tab,
    handler(async (req, res) => {
      const orgId = await orgOf(req);
      const contactId = Number(req.body?.contactId);
      if (!Number.isInteger(contactId) || contactId <= 0) throw new BadRequest("contactId must be a positive integer");
      const excluded = req.body?.excluded === true;
      const reason = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 500) : undefined;
      await setExcluded(orgId, contactId, excluded, reason);
      res.json({ ok: true });
    }),
  );
}
