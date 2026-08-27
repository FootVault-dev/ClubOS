/**
 * Team Pay — HTTP.
 *
 * Public routes are authenticated by a token in the URL and nothing else. There
 * is no login: the manager is a member of the public, and so is every player.
 * That is why the tokens are 128 random bits and why nothing here is listable.
 */
import type { Express, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { organizations, teampayCompetitions } from "@shared/schema";
import { requireAuth, requireTab } from "./auth";
import * as tp from "./teampay";

const TAB = "team-entries";

// Brand sites that may POST to these endpoints from the browser.
const SITE_ORIGINS = [
  "https://ethniccup.com", "https://www.ethniccup.com",
  "https://cicyouth.com", "https://www.cicyouth.com",
  "https://cic7s.com", "https://www.cic7s.com",
  "https://minifootball.co.nz", "https://www.minifootball.co.nz",
];

function setCors(req: Request, res: Response) {
  const origin = String(req.headers.origin || "");
  if (SITE_ORIGINS.includes(origin) || /\.vercel\.app$/.test(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
  }
  res.header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
}

// ── rate limiting ────────────────────────────────────────────────────────────
// 🔴 Only on the two endpoints a stranger can hit unprompted: entering a team
// and joining the fill-in list.
//
// Deliberately NOT on the pay page, the open ping, or the payment endpoints. A
// squad paying from one office or one flat shares an IP, so a per-IP limit
// there is a per-SQUAD limit — the Lesnoy Terminal chat shipped exactly that
// bug and it blocked a company's third colleague from starting a conversation.
const hits = new Map<string, number[]>();
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_HOUR = 12;

function clientIp(req: Request): string {
  const fwd = String(req.headers["x-forwarded-for"] || "");
  return (fwd.split(",")[0] || req.ip || "unknown").trim();
}

function rateLimited(ip: string): boolean {
  const now = Date.now();
  if (hits.size > 5000) {
    for (const [k, times] of Array.from(hits.entries())) {
      if (!times.some((t) => now - t < WINDOW_MS)) hits.delete(k);
    }
  }
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_PER_HOUR) { hits.set(ip, recent); return true; }
  recent.push(now);
  hits.set(ip, recent);
  return false;
}

/** Anything token-addressed answers 404 on a miss — never 403, never a hint. */
function notFound(res: Response) {
  return res.status(404).json({ message: "We couldn't find that." });
}

export function registerTeampayRoutes(app: Express) {
  // CORS for every public Team Pay route, in one place, plus the preflight.
  //
  // 🔴 A mounted middleware, NOT `app.options("/api/public/teampay/*")`. Express 5
  // uses path-to-regexp v8, which rejects a bare `*` — that line crashed the
  // whole server at startup, which is a far better failure than a silent one but
  // still worth not shipping.
  app.use("/api/public/teampay", (req, res, next) => {
    setCors(req, res);
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  app.get("/api/public/teampay/competition/:slug", async (req, res) => {
    setCors(req, res);
    const c = await tp.competitionBySlug(String(req.params.slug));
    if (!c) return notFound(res);
    res.json(tp.competitionPublic(c));
  });

  // ── entering a team ────────────────────────────────────────────────────────
  app.post("/api/public/teampay/competition/:slug/enter", async (req, res) => {
    setCors(req, res);
    if (rateLimited(clientIp(req))) {
      return res.status(429).json({ message: "That's a few entries in a short time. Try again shortly." });
    }
    try {
      const r = await tp.createEntry({
        slug: String(req.params.slug),
        teamName: String(req.body?.teamName || ""),
        community: req.body?.community ?? null,
        managerName: String(req.body?.managerName || ""),
        managerEmail: String(req.body?.managerEmail || ""),
        managerPhone: req.body?.managerPhone ?? null,
        squadSize: req.body?.squadSize ?? null,
        managerPlays: req.body?.managerPlays !== false,
      });
      if (r.error) return res.status(400).json({ message: r.error });
      // 🔴 The dashboard link comes back in the response AND by email. The MFL
      // split link existed only on screen and in localStorage, and when a captain
      // lost it nothing could recover it.
      res.json({ ok: true, dashboardUrl: r.dashboardUrl });
    } catch (e: any) {
      console.error("[teampay enter]", e?.message || e);
      res.status(500).json({ message: "Couldn't enter your team just now. Please try again." });
    }
  });

  // ── the manager's dashboard ────────────────────────────────────────────────
  app.get("/api/public/teampay/team/:token", async (req, res) => {
    setCors(req, res);
    const v = await tp.dashboardView(String(req.params.token));
    if (!v) return notFound(res);
    res.set("X-Robots-Tag", "noindex, nofollow");
    res.set("Referrer-Policy", "no-referrer");
    res.json(v);
  });

  app.post("/api/public/teampay/team/:token/players", async (req, res) => {
    setCors(req, res);
    const rows = Array.isArray(req.body?.players) ? req.body.players : [req.body];
    if (rows.length > 60) return res.status(400).json({ message: "That's more players than a squad." });
    const r = await tp.addPlayers(String(req.params.token), rows);
    if (r.error === "not_found") return notFound(res);
    if (r.error) return res.status(400).json({ message: r.error });
    res.json(r);
  });

  app.patch("/api/public/teampay/team/:token/squad-size", async (req, res) => {
    setCors(req, res);
    const r = await tp.setSquadSize(String(req.params.token), Number(req.body?.squadSize));
    if (r.error === "not_found") return notFound(res);
    if (r.error) return res.status(400).json({ message: r.error });
    res.json(r);
  });

  app.delete("/api/public/teampay/team/:token/players/:id", async (req, res) => {
    setCors(req, res);
    const r = await tp.removePlayer(String(req.params.token), Number(req.params.id));
    if (r.error === "not_found") return notFound(res);
    if (r.error) return res.status(400).json({ message: r.error });
    res.json(r);
  });

  app.post("/api/public/teampay/team/:token/players/:id/nudge", async (req, res) => {
    setCors(req, res);
    const r = await tp.nudgePlayer(String(req.params.token), Number(req.params.id));
    if (r.error === "not_found") return notFound(res);
    if (r.error) return res.status(400).json({ message: r.error });
    res.json(r);
  });

  app.post("/api/public/teampay/team/:token/nudge-all", async (req, res) => {
    setCors(req, res);
    const r = await tp.nudgeAll(String(req.params.token));
    if (r.error === "not_found") return notFound(res);
    res.json(r);
  });

  // ── the fill-in marketplace, manager side ──────────────────────────────────
  app.get("/api/public/teampay/team/:token/fill-ins", async (req, res) => {
    setCors(req, res);
    const r = await tp.browseFillins(String(req.params.token));
    if (r.error === "not_found") return notFound(res);
    if (r.error) return res.status(400).json({ message: r.error });
    res.json(r);
  });

  app.post("/api/public/teampay/team/:token/fill-ins/:id/request", async (req, res) => {
    setCors(req, res);
    const r = await tp.requestFillin(
      String(req.params.token), Number(req.params.id), req.body?.note ?? null);
    if (r.error === "not_found") return notFound(res);
    if (r.error) return res.status(400).json({ message: r.error });
    res.json(r);
  });

  // ── the fill-in marketplace, player side ───────────────────────────────────
  app.post("/api/public/teampay/competition/:slug/fill-in", async (req, res) => {
    setCors(req, res);
    if (rateLimited(clientIp(req))) {
      return res.status(429).json({ message: "That's a few submissions in a short time. Try again shortly." });
    }
    try {
      const r = await tp.createFillin({
        slug: String(req.params.slug),
        firstName: String(req.body?.firstName || ""),
        lastName: req.body?.lastName ?? null,
        email: String(req.body?.email || ""),
        phone: req.body?.phone ?? null,
        position: req.body?.position ?? null,
        ability: req.body?.ability ?? null,
        highestLevel: req.body?.highestLevel ?? null,
        fromWhere: req.body?.fromWhere ?? null,
        motivation: req.body?.motivation ?? null,
        note: req.body?.note ?? null,
      });
      if (r.error === "not_found") return notFound(res);
      if (r.error) return res.status(400).json({ message: r.error });
      res.json(r);
    } catch (e: any) {
      console.error("[teampay fill-in]", e?.message || e);
      res.status(500).json({ message: "Couldn't save that just now. Please try again." });
    }
  });

  app.get("/api/public/teampay/hold/:token", async (req, res) => {
    setCors(req, res);
    const v = await tp.holdView(String(req.params.token));
    if (!v) return notFound(res);
    res.set("X-Robots-Tag", "noindex, nofollow");
    res.json(v);
  });

  app.post("/api/public/teampay/hold/:token/accept", async (req, res) => {
    setCors(req, res);
    const r = await tp.acceptHold(String(req.params.token));
    if (r.error === "not_found") return notFound(res);
    if (r.error) return res.status(400).json({ message: r.error });
    res.json(r);
  });

  app.post("/api/public/teampay/hold/:token/decline", async (req, res) => {
    setCors(req, res);
    const r = await tp.declineHold(String(req.params.token));
    if (r.error === "not_found") return notFound(res);
    if (r.error) return res.status(400).json({ message: r.error });
    res.json(r);
  });

  // ── the player's page ──────────────────────────────────────────────────────
  app.get("/api/public/teampay/pay/:token", async (req, res) => {
    setCors(req, res);
    const v = await tp.playerView(String(req.params.token));
    if (!v) return notFound(res);
    res.set("X-Robots-Tag", "noindex, nofollow");
    res.set("Referrer-Policy", "no-referrer");
    res.json(v);
  });

  /**
   * 🔴 A POST, on purpose, fired by the page after it mounts.
   *
   * Mail scanners and link previewers issue GETs; they do not run JavaScript.
   * Stamping "opened" from the GET that serves the link would tell a manager a
   * player had seen it when a robot had — and they would stop chasing exactly
   * the person who needs chasing.
   */
  app.post("/api/public/teampay/pay/:token/opened", async (req, res) => {
    setCors(req, res);
    const ok = await tp.markOpened(String(req.params.token));
    if (!ok) return notFound(res);
    res.json({ ok: true });
  });

  app.post("/api/public/teampay/pay/:token/intent", async (req, res) => {
    setCors(req, res);
    try {
      const r = await tp.payIntent(String(req.params.token));
      if (r.error === "not_found") return notFound(res);
      if (r.error === "already_paid") return res.status(409).json({ message: "You've already paid." });
      if (r.error) return res.status(400).json({ message: r.error });
      res.json(r);
    } catch (e: any) {
      console.error("[teampay intent]", e?.message || e);
      res.status(500).json({ message: "Couldn't start that payment. Please try again." });
    }
  });

  app.post("/api/public/teampay/pay/:token/confirm", async (req, res) => {
    setCors(req, res);
    try {
      const r = await tp.confirmPayment(String(req.params.token));
      if (r.error === "not_found") return notFound(res);
      if (r.error) return res.status(400).json({ message: r.error });
      res.json(r);
    } catch (e: any) {
      console.error("[teampay confirm]", e?.message || e);
      res.status(500).json({ message: "Couldn't confirm that payment." });
    }
  });

  app.post("/api/public/teampay/pay/:token/decline", async (req, res) => {
    setCors(req, res);
    const r = await tp.declinePlayer(String(req.params.token));
    if (r.error === "not_found") return notFound(res);
    if (r.error) return res.status(400).json({ message: r.error });
    res.json(r);
  });

  // ── staff ──────────────────────────────────────────────────────────────────
  app.get("/api/admin/teampay/overview", requireAuth, requireTab(TAB), async (req: any, res) => {
    try {
      const orgId = await orgIdForRequest(req);
      if (!orgId) return res.status(400).json({ message: "No workspace" });
      res.json({ competitions: await tp.adminOverview(orgId) });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.patch("/api/admin/teampay/competitions/:id", requireAuth, requireTab(TAB), async (req: any, res) => {
    try {
      const orgId = await orgIdForRequest(req);
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ message: "Bad id" });

      // Scoped to the caller's workspace so an id from another one is unreachable.
      const [existing] = await db.select().from(teampayCompetitions)
        .where(eq(teampayCompetitions.id, id));
      if (!existing || existing.organizationId !== orgId) return notFound(res);

      const patch: any = {};
      for (const k of ["entriesOpen", "paymentsEnabled", "fillinsOpen"]) {
        if (req.body?.[k] !== undefined) patch[k] = !!req.body[k];
      }
      if (req.body?.feeCents !== undefined) {
        const v = Number(req.body.feeCents);
        if (!Number.isInteger(v) || v < 0) return res.status(400).json({ message: "Fee must be a whole number of cents." });
        patch.feeCents = v;
      }
      if (req.body?.defaultSquadSize !== undefined) {
        const v = Number(req.body.defaultSquadSize);
        if (!Number.isInteger(v) || v < 1 || v > 40) return res.status(400).json({ message: "Squad size must be 1–40." });
        patch.defaultSquadSize = v;
      }
      if (req.body?.blurb !== undefined) patch.blurb = String(req.body.blurb).slice(0, 2000) || null;
      if (req.body?.payByDate !== undefined) patch.payByDate = req.body.payByDate || null;
      if (!Object.keys(patch).length) return res.status(400).json({ message: "Nothing to update" });

      res.json(await tp.adminSetSwitches(id, patch));
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/admin/teampay/entries/:id/resend-link", requireAuth, requireTab(TAB), async (req, res) => {
    const r = await tp.adminResendDashboardLink(Number(req.params.id));
    if (r.error === "not_found") return notFound(res);
    if (r.error) return res.status(400).json({ message: r.error });
    res.json(r);
  });
}

/**
 * The workspace the request is standing in — same mechanism every other admin
 * route file uses. Returns undefined rather than guessing an org: a wrong guess
 * here would show one workspace's team entries inside another's.
 */
async function orgIdForRequest(req: Request): Promise<number | undefined> {
  const slug = String(req.headers["x-workspace-slug"] || "").trim();
  if (!slug) return undefined;
  const [o] = await db.select().from(organizations).where(eq(organizations.slug, slug));
  return o?.id;
}
