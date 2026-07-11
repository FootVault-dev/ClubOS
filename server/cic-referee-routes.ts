// ─────────────────────────────────────────────────────────────────────────────
// CIC REFEREE SCORING
//
// Referees score their Christchurch International Cup games from their phones.
// They are a SEPARATE account type from ClubOS staff `users` and hold NO staff
// session — deliberately. Many /api/admin/* routes carry no org check (e.g.
// GET /api/admin/contacts returns the whole cross-club contacts DB to ANY
// logged-in session), so a referee credential must be structurally incapable of
// reaching them. It is: a referee authenticates with an HMAC token that carries
// a REFEREE id (prefixed "ref:") and never sets req.session.userId, and every
// scoring route below resolves the CIC org server-side and refuses any game that
// isn't a CIC game — whatever id the caller sends.
//
// Public (referee token, cookie-less):
//   POST /api/public/cic-referees/signup            — self sign-up → 'pending'
//   POST /api/public/cic-referees/login             — approved refs only → token
//   GET  /api/public/cic-referees/me
//   GET  /api/public/cic-referees/games?scope=mine|all
//   GET  /api/public/cic-referees/games/:id
//   PATCH/POST/DELETE/PUT .../games/:id/(score|goals|cards|mvp-vote|gk-rating|shootout)
//
// Admin (staff session + the "cic-referees" tab, scoped to the CIC workspace):
//   GET   /api/admin/cic-referees                   — the approval list
//   PATCH /api/admin/cic-referees/:id               — approve / decline / suspend
//   DELETE/GET/POST .../cic-referees[/assignments]  — remove + assign refs↔games
//
// The scoring engine (goals, cards, MVP, golden glove, shootouts, bracket
// resolution) is REUSED verbatim from the admin tournament routes — a referee
// write goes through the exact same storage functions the office already uses.
// ─────────────────────────────────────────────────────────────────────────────
import type { Express, Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "./db";
import { storage } from "./storage";
import { requireAuth, requireTab, hashPassword, verifyPassword } from "./auth";
import { clientIp } from "./api-security";
import { resolveTournamentBrackets } from "./tournament-brackets";
import {
  organizations,
  cicReferees,
  cicRefereeAssignments,
  tournaments,
  tournamentGames,
  tournamentTeams,
  tournamentPlayers,
  tournamentGoals,
  tournamentCards,
} from "@shared/schema";
import { REFEREE_LIMITS, REFEREE_STATUSES, isRefereeStatus, refereeCanLogin } from "@shared/referees";
import { sendRefereeSignupNotification, sendRefereeApprovedEmail } from "./email";

const CIC_ORG_SLUG = "christchurch-international-cup";

const s = (v: any, max = 200): string => String(v ?? "").trim().slice(0, max);
const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

// CIC org id, resolved from the slug (never trusted from the client) and cached.
let cicOrgIdCache: number | null = null;
async function cicOrgId(): Promise<number> {
  if (cicOrgIdCache) return cicOrgIdCache;
  const [org] = await db.select().from(organizations).where(eq(organizations.slug, CIC_ORG_SLUG));
  if (!org) throw new Error("CIC organization not found");
  cicOrgIdCache = org.id;
  return org.id;
}

// ── Referee token ────────────────────────────────────────────────────────────
// `ref:<refereeId>.<expiry>.<hmac>`, signed with the session secret. The "ref:"
// prefix is a domain separator: the Skills Challenge token parser (which expects
// a bare numeric first segment) rejects it, and vice versa — the two credentials
// can never be confused for one another. 30 days covers the tournament window.
const REF_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const refSecret = () => process.env.SESSION_SECRET || "cufc-dev-secret";

function makeRefereeToken(refereeId: number) {
  const expiresAt = Date.now() + REF_TOKEN_TTL_MS;
  const payload = `ref:${refereeId}.${expiresAt}`;
  const sig = crypto.createHmac("sha256", refSecret()).update(payload).digest("hex");
  return { token: `${payload}.${sig}`, expiresAt };
}

function parseRefereeToken(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [idPart, expStr, sig] = parts;
  if (!idPart.startsWith("ref:")) return null;
  const expected = crypto.createHmac("sha256", refSecret()).update(`${idPart}.${expStr}`).digest("hex");
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const refereeId = parseInt(idPart.slice(4), 10);
  const exp = parseInt(expStr, 10);
  if (!refereeId || !exp || Date.now() > exp) return null;
  return refereeId;
}

// The referee row is re-loaded and re-checked on EVERY request — approval pulled
// by a staffer takes effect instantly, without waiting for the token to expire.
async function requireRefereeToken(req: Request, res: Response, next: NextFunction) {
  try {
    const header = String(req.headers.authorization || "");
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const refereeId = token ? parseRefereeToken(token) : null;
    if (!refereeId) return res.status(401).json({ message: "Please sign in again." });
    const [ref] = await db.select().from(cicReferees).where(eq(cicReferees.id, refereeId));
    if (!ref || !refereeCanLogin(ref.status)) {
      return res.status(403).json({ message: "This referee account isn't active." });
    }
    // Defence in depth: a referee is always, only, a CIC account.
    if (ref.organizationId !== (await cicOrgId())) {
      return res.status(403).json({ message: "Access denied." });
    }
    (req as any).referee = ref;
    next();
  } catch (e) {
    console.error("[cic-ref] auth error", e);
    res.status(500).json({ message: "Auth check failed." });
  }
}

// THE security check for every referee write: the game must belong to a CIC
// tournament. Returns null (→ 404) for any game that isn't CIC, so a referee can
// never read or write another workspace's game whatever id they send.
async function loadCicGame(gameId: number): Promise<{ game: any; tournament: any } | null> {
  if (!Number.isFinite(gameId)) return null;
  const game = await storage.getTournamentGame(gameId);
  if (!game) return null;
  const [tournament] = await db.select().from(tournaments).where(eq(tournaments.id, game.tournamentId));
  if (!tournament) return null;
  if (tournament.organizationId !== (await cicOrgId())) return null;
  return { game, tournament };
}

// Accountability stamp: who last saved a score on this game, and when.
async function stampScored(gameId: number, refereeId: number) {
  try {
    await db.update(tournamentGames)
      .set({ lastScoredByRefereeId: refereeId, lastScoredAt: new Date() })
      .where(eq(tournamentGames.id, gameId));
  } catch (e) {
    console.error("[cic-ref] stamp failed", e);
  }
}

const isTeamOf = (game: any, teamId: number) => teamId === game.homeTeamId || teamId === game.awayTeamId;

// ── In-memory throttles (per Fly machine — enough to stop a script) ──────────
const HOUR = 60 * 60 * 1000;
const signupHits = new Map<string, number[]>();
const loginFails = new Map<string, number[]>();

function hit(map: Map<string, number[]>, ip: string, cap: number): boolean {
  const now = Date.now();
  if (map.size > 5000) {
    for (const [k, times] of Array.from(map.entries())) {
      if (!times.some((t) => now - t < HOUR)) map.delete(k);
    }
  }
  const recent = (map.get(ip) ?? []).filter((t) => now - t < HOUR);
  if (recent.length >= cap) {
    map.set(ip, recent);
    return true;
  }
  recent.push(now);
  map.set(ip, recent);
  return false;
}

const publicRef = (r: typeof cicReferees.$inferSelect) => ({
  id: r.id,
  fullName: r.fullName,
  email: r.email,
  phone: r.phone,
  status: r.status,
  approvedBy: r.approvedBy,
  decidedAt: r.decidedAt,
  lastLoginAt: r.lastLoginAt,
  createdAt: r.createdAt,
});

export function registerCicRefereeRoutes(app: Express) {
  // ═══════════════════════════ PUBLIC (referee) ═════════════════════════════

  app.post("/api/public/cic-referees/signup", async (req, res) => {
    try {
      const ip = clientIp(req) || "unknown";
      if (hit(signupHits, ip, REFEREE_LIMITS.maxSignupsPerIpPerHour)) {
        return res.status(429).json({ message: "That's a few sign-ups in a short time. Try again shortly." });
      }
      const fullName = s(req.body?.fullName, REFEREE_LIMITS.maxNameLength);
      const email = s(req.body?.email, REFEREE_LIMITS.maxEmailLength).toLowerCase();
      const phone = s(req.body?.phone, REFEREE_LIMITS.maxPhoneLength);
      const password = String(req.body?.password ?? "");

      const errors: string[] = [];
      if (!fullName) errors.push("Your full name is required.");
      if (!isEmail(email)) errors.push("A valid email address is required.");
      if (!phone) errors.push("A phone number is required.");
      if (password.length < REFEREE_LIMITS.minPasswordLength) {
        errors.push(`Choose a password of at least ${REFEREE_LIMITS.minPasswordLength} characters.`);
      }
      if (errors.length) return res.status(400).json({ message: errors[0], errors });

      const orgId = await cicOrgId();
      const passwordHash = await hashPassword(password);
      let created;
      try {
        [created] = await db.insert(cicReferees)
          .values({ organizationId: orgId, fullName, email, phone, passwordHash, status: "pending" })
          .returning();
      } catch (e: any) {
        // cic_referees_org_email_unq — someone already signed up with this email.
        if (String(e?.code) === "23505") {
          return res.status(409).json({
            message: "There's already a sign-up with this email. If it's yours, wait for approval or contact the CIC team.",
          });
        }
        throw e;
      }

      // Best-effort heads-up so staff can approve promptly. Never fail signup on it.
      try {
        await sendRefereeSignupNotification({ orgId, refereeName: fullName, email, phone });
      } catch (mailErr) {
        console.error("[cic-ref] signup notification failed", mailErr);
      }

      res.json({ ok: true, id: created.id });
    } catch (e: any) {
      console.error("[cic-ref] signup failed", e);
      res.status(500).json({ message: "Something went wrong creating your account." });
    }
  });

  app.post("/api/public/cic-referees/login", async (req, res) => {
    try {
      const ip = clientIp(req) || "unknown";
      // Brute-force guard: too many recent failures from this IP → cool off.
      if ((loginFails.get(ip) ?? []).filter((t) => Date.now() - t < HOUR).length >= REFEREE_LIMITS.maxLoginFailsPerIpPerHour) {
        return res.status(429).json({ message: "Too many attempts. Please wait a few minutes and try again." });
      }
      const email = s(req.body?.email, REFEREE_LIMITS.maxEmailLength).toLowerCase();
      const password = String(req.body?.password ?? "");
      if (!email || !password) return res.status(400).json({ message: "Email and password are required." });

      const orgId = await cicOrgId();
      const [ref] = await db.select().from(cicReferees)
        .where(and(eq(cicReferees.organizationId, orgId), eq(cicReferees.email, email)));
      const ok = ref ? await verifyPassword(password, ref.passwordHash) : false;
      if (!ref || !ok) {
        hit(loginFails, ip, Number.MAX_SAFE_INTEGER); // record the failure
        return res.status(401).json({ message: "Invalid email or password." });
      }
      if (!refereeCanLogin(ref.status)) {
        const message = ref.status === "pending"
          ? "Your referee account is awaiting approval. We'll email you as soon as it's active."
          : "This referee account isn't active. Please contact the CIC team.";
        return res.status(403).json({ message });
      }

      await db.update(cicReferees).set({ lastLoginAt: new Date() }).where(eq(cicReferees.id, ref.id));
      const { token, expiresAt } = makeRefereeToken(ref.id);
      res.json({ token, expiresAt, referee: { id: ref.id, fullName: ref.fullName, email: ref.email } });
    } catch (e: any) {
      console.error("[cic-ref] login failed", e);
      res.status(500).json({ message: "Something went wrong signing in." });
    }
  });

  app.get("/api/public/cic-referees/me", requireRefereeToken, async (req, res) => {
    const r = (req as any).referee;
    res.json({ referee: { id: r.id, fullName: r.fullName, email: r.email, phone: r.phone } });
  });

  // The referee's game list. scope=mine → their assigned games; scope=all → every
  // CIC game (the flexibility Daniel asked for when fixtures shift).
  app.get("/api/public/cic-referees/games", requireRefereeToken, async (req, res) => {
    try {
      const orgId = await cicOrgId();
      const refereeId = (req as any).referee.id;
      const scope = String(req.query.scope || "all");

      const tourns = await db.select().from(tournaments)
        .where(and(eq(tournaments.organizationId, orgId), eq(tournaments.active, true), eq(tournaments.archived, false)));
      const tids = tourns.map((t) => t.id);
      if (!tids.length) return res.json({ games: [] });
      const tById = new Map(tourns.map((t) => [t.id, t]));

      const [games, teams, myAssigns] = await Promise.all([
        db.select().from(tournamentGames).where(inArray(tournamentGames.tournamentId, tids)),
        db.select({ id: tournamentTeams.id, name: tournamentTeams.name }).from(tournamentTeams).where(inArray(tournamentTeams.tournamentId, tids)),
        db.select({ gameId: cicRefereeAssignments.gameId }).from(cicRefereeAssignments).where(eq(cicRefereeAssignments.refereeId, refereeId)),
      ]);
      const teamName = new Map(teams.map((t) => [t.id, t.name]));
      const mine = new Set(myAssigns.map((a) => a.gameId));

      let list = games.map((g) => ({
        id: g.id,
        tournamentId: g.tournamentId,
        tournamentName: tById.get(g.tournamentId)?.name ?? "",
        ageGroup: tById.get(g.tournamentId)?.ageGroup ?? null,
        stage: g.stage,
        stageDetail: g.stageDetail,
        gameDate: g.gameDate,
        startTime: g.startTime,
        field: g.field,
        status: g.status,
        isLive: g.isLive,
        homeTeamId: g.homeTeamId,
        awayTeamId: g.awayTeamId,
        homeTeamName: g.homeTeamId ? (teamName.get(g.homeTeamId) ?? null) : (g.homeTeamPlaceholder ?? null),
        awayTeamName: g.awayTeamId ? (teamName.get(g.awayTeamId) ?? null) : (g.awayTeamPlaceholder ?? null),
        homeScore: g.homeScore,
        awayScore: g.awayScore,
        assigned: mine.has(g.id),
      }));
      if (scope === "mine") list = list.filter((g) => g.assigned);
      list.sort((a, b) =>
        (`${a.gameDate ?? ""}${a.startTime ?? ""}`).localeCompare(`${b.gameDate ?? ""}${b.startTime ?? ""}`) || a.id - b.id);

      res.json({ games: list });
    } catch (e: any) {
      console.error("[cic-ref] games list failed", e);
      res.status(500).json({ message: "Couldn't load your games right now." });
    }
  });

  app.get("/api/public/cic-referees/games/:id", requireRefereeToken, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const found = await loadCicGame(id);
      if (!found) return res.status(404).json({ message: "Game not found." });
      const { game } = found;
      const teamIds = [game.homeTeamId, game.awayTeamId].filter((x): x is number => !!x);

      const [teams, goals, cards, mvpVotes, gkRatings, shootout, players] = await Promise.all([
        teamIds.length ? db.select().from(tournamentTeams).where(inArray(tournamentTeams.id, teamIds)) : Promise.resolve([]),
        storage.getTournamentGoalsByGame(id),
        storage.getTournamentCardsByGame(id),
        storage.getTournamentMvpVotesByGame(id),
        storage.getTournamentGkRatingsByGame(id),
        storage.getPenaltyKicksByGame(id),
        teamIds.length ? db.select().from(tournamentPlayers).where(inArray(tournamentPlayers.teamId, teamIds)) : Promise.resolve([]),
      ]);

      res.json({ game, teams, goals, cards, mvpVotes, gkRatings, shootout, players });
    } catch (e: any) {
      console.error("[cic-ref] game detail failed", e);
      res.status(500).json({ message: "Couldn't load that game right now." });
    }
  });

  // Score / live / final. A referee may only ever touch these four fields.
  app.patch("/api/public/cic-referees/games/:id", requireRefereeToken, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const found = await loadCicGame(id);
      if (!found) return res.status(404).json({ message: "Game not found." });

      const patch: Record<string, any> = {};
      const intOrNull = (v: any): number | null | undefined => {
        if (v === null || v === "") return null;
        const n = Number(v);
        return Number.isInteger(n) && n >= 0 ? n : undefined;
      };
      if ("homeScore" in req.body) {
        const n = intOrNull(req.body.homeScore);
        if (n === undefined) return res.status(400).json({ message: "Home score must be a whole number." });
        patch.homeScore = n;
      }
      if ("awayScore" in req.body) {
        const n = intOrNull(req.body.awayScore);
        if (n === undefined) return res.status(400).json({ message: "Away score must be a whole number." });
        patch.awayScore = n;
      }
      if ("isLive" in req.body) patch.isLive = !!req.body.isLive;
      if ("status" in req.body) {
        const st = String(req.body.status);
        if (st !== "scheduled" && st !== "final") return res.status(400).json({ message: "Status must be scheduled or final." });
        patch.status = st;
      }
      if (Object.keys(patch).length === 0) return res.status(400).json({ message: "Nothing to update." });

      const updated = await storage.updateTournamentGame(id, patch);
      if (!updated) return res.status(404).json({ message: "Game not found." });
      try { await resolveTournamentBrackets(updated.tournamentId); } catch (e) { console.error("[cic-ref] bracket resolve failed", e); }
      await stampScored(id, (req as any).referee.id);
      res.json(updated);
    } catch (e: any) {
      console.error("[cic-ref] patch game failed", e);
      res.status(400).json({ message: e.message });
    }
  });

  // Goals — mirrors the admin route: playerId OR a typed name + playerTeamId
  // (find-or-creates). Own goals send teamId = the CREDITED team and
  // playerTeamId = the scorer's own team (the client computes the flip).
  app.post("/api/public/cic-referees/games/:id/goals", requireRefereeToken, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const found = await loadCicGame(id);
      if (!found) return res.status(404).json({ message: "Game not found." });
      const { game } = found;

      const teamId = Number(req.body?.teamId);
      if (!isTeamOf(game, teamId)) return res.status(400).json({ message: "teamId must be one of this game's teams." });

      let playerId = req.body?.playerId ? Number(req.body.playerId) : 0;
      const { playerName, playerTeamId } = req.body ?? {};
      if (!playerId && playerName && playerTeamId) {
        if (!isTeamOf(game, Number(playerTeamId))) return res.status(400).json({ message: "playerTeamId must be one of this game's teams." });
        playerId = await storage.findOrCreateTournamentPlayerByName(Number(playerTeamId), String(playerName));
      }
      if (!playerId) return res.status(400).json({ message: "A scorer is required — pick a player or type a name." });

      const minute = req.body?.minute;
      const goal = await storage.createTournamentGoal({
        gameId: id,
        teamId,
        playerId,
        minute: minute == null || minute === "" ? null : Number(minute),
        isOwnGoal: !!req.body?.isOwnGoal,
        isPenalty: !!req.body?.isPenalty,
      });
      await stampScored(id, (req as any).referee.id);
      res.status(201).json(goal);
    } catch (e: any) {
      console.error("[cic-ref] add goal failed", e);
      res.status(400).json({ message: e.message });
    }
  });

  app.delete("/api/public/cic-referees/games/:id/goals/:goalId", requireRefereeToken, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const goalId = parseInt(String(req.params.goalId), 10);
      const found = await loadCicGame(id);
      if (!found) return res.status(404).json({ message: "Game not found." });
      const [goal] = await db.select().from(tournamentGoals).where(eq(tournamentGoals.id, goalId));
      if (!goal || goal.gameId !== id) return res.status(404).json({ message: "Goal not found." });
      await storage.deleteTournamentGoal(goalId);
      await stampScored(id, (req as any).referee.id);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(400).json({ message: e.message });
    }
  });

  app.post("/api/public/cic-referees/games/:id/cards", requireRefereeToken, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const found = await loadCicGame(id);
      if (!found) return res.status(404).json({ message: "Game not found." });
      const { game } = found;

      const teamId = Number(req.body?.teamId);
      if (!isTeamOf(game, teamId)) return res.status(400).json({ message: "teamId must be one of this game's teams." });
      const cardType = String(req.body?.cardType);
      if (cardType !== "yellow" && cardType !== "red") return res.status(400).json({ message: "cardType must be 'yellow' or 'red'." });

      let playerId = req.body?.playerId ? Number(req.body.playerId) : 0;
      const { playerName, playerTeamId } = req.body ?? {};
      if (!playerId && playerName && playerTeamId) {
        if (!isTeamOf(game, Number(playerTeamId))) return res.status(400).json({ message: "playerTeamId must be one of this game's teams." });
        playerId = await storage.findOrCreateTournamentPlayerByName(Number(playerTeamId), String(playerName));
      }
      if (!playerId) return res.status(400).json({ message: "A player is required — pick one or type a name." });

      const minute = req.body?.minute;
      const card = await storage.createTournamentCard({
        gameId: id,
        teamId,
        playerId,
        cardType,
        minute: minute == null || minute === "" ? null : Number(minute),
      });
      await stampScored(id, (req as any).referee.id);
      res.status(201).json(card);
    } catch (e: any) {
      console.error("[cic-ref] add card failed", e);
      res.status(400).json({ message: e.message });
    }
  });

  app.delete("/api/public/cic-referees/games/:id/cards/:cardId", requireRefereeToken, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const cardId = parseInt(String(req.params.cardId), 10);
      const found = await loadCicGame(id);
      if (!found) return res.status(404).json({ message: "Game not found." });
      const [card] = await db.select().from(tournamentCards).where(eq(tournamentCards.id, cardId));
      if (!card || card.gameId !== id) return res.status(404).json({ message: "Card not found." });
      await storage.deleteTournamentCard(cardId);
      await stampScored(id, (req as any).referee.id);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(400).json({ message: e.message });
    }
  });

  // MVP — one vote per team, for a player on the OPPOSING team.
  app.put("/api/public/cic-referees/games/:id/mvp-vote", requireRefereeToken, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const found = await loadCicGame(id);
      if (!found) return res.status(404).json({ message: "Game not found." });
      const { game } = found;

      const voterTeamId = Number(req.body?.voterTeamId);
      if (!isTeamOf(game, voterTeamId)) return res.status(400).json({ message: "voterTeamId must be one of this game's teams." });
      const otherTeamId = voterTeamId === game.homeTeamId ? game.awayTeamId : game.homeTeamId;

      let playerId = req.body?.playerId ? Number(req.body.playerId) : 0;
      if (!playerId && req.body?.playerName && otherTeamId) {
        playerId = await storage.findOrCreateTournamentPlayerByName(otherTeamId, String(req.body.playerName));
      }
      if (!playerId) return res.status(400).json({ message: "A player is required — pick one or type a name." });
      const player = await storage.getTournamentPlayer(playerId);
      if (player && player.teamId === voterTeamId) {
        return res.status(400).json({ message: "A team can't vote for its own player." });
      }
      await storage.upsertTournamentMvpVote(id, voterTeamId, playerId);
      await stampScored(id, (req as any).referee.id);
      res.json({ ok: true });
    } catch (e: any) {
      console.error("[cic-ref] mvp vote failed", e);
      res.status(400).json({ message: e.message });
    }
  });

  app.delete("/api/public/cic-referees/games/:id/mvp-vote/:voterTeamId", requireRefereeToken, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const found = await loadCicGame(id);
      if (!found) return res.status(404).json({ message: "Game not found." });
      await storage.deleteTournamentMvpVote(id, parseInt(String(req.params.voterTeamId), 10));
      res.json({ ok: true });
    } catch (e: any) {
      res.status(400).json({ message: e.message });
    }
  });

  // Golden Glove — referee rates each team's keeper 1–5.
  app.put("/api/public/cic-referees/games/:id/gk-rating", requireRefereeToken, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const found = await loadCicGame(id);
      if (!found) return res.status(404).json({ message: "Game not found." });
      const { game } = found;

      const teamId = Number(req.body?.teamId);
      if (!isTeamOf(game, teamId)) return res.status(400).json({ message: "teamId must be one of this game's teams." });
      const rating = Number(req.body?.rating);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ message: "Rating must be a whole number 1–5." });

      let playerId = req.body?.playerId ? Number(req.body.playerId) : 0;
      if (!playerId && req.body?.playerName) {
        playerId = await storage.findOrCreateTournamentPlayerByName(teamId, String(req.body.playerName));
      }
      if (!playerId) return res.status(400).json({ message: "A goalkeeper is required — pick one or type a name." });
      await storage.upsertTournamentGkRating(id, teamId, playerId, rating);
      await stampScored(id, (req as any).referee.id);
      res.json({ ok: true });
    } catch (e: any) {
      console.error("[cic-ref] gk rating failed", e);
      res.status(400).json({ message: e.message });
    }
  });

  app.delete("/api/public/cic-referees/games/:id/gk-rating/:teamId", requireRefereeToken, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const found = await loadCicGame(id);
      if (!found) return res.status(404).json({ message: "Game not found." });
      await storage.deleteTournamentGkRating(id, parseInt(String(req.params.teamId), 10));
      res.json({ ok: true });
    } catch (e: any) {
      res.status(400).json({ message: e.message });
    }
  });

  // Penalty shootout — knockout games that finish level. Totals + brackets are
  // re-synced after every change, exactly as the admin route does.
  app.get("/api/public/cic-referees/games/:id/shootout", requireRefereeToken, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const found = await loadCicGame(id);
      if (!found) return res.status(404).json({ message: "Game not found." });
      res.json(await storage.getPenaltyKicksByGame(id));
    } catch (e: any) {
      res.status(400).json({ message: e.message });
    }
  });

  app.post("/api/public/cic-referees/games/:id/shootout", requireRefereeToken, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const found = await loadCicGame(id);
      if (!found) return res.status(404).json({ message: "Game not found." });
      const { game } = found;

      const teamId = Number(req.body?.teamId);
      if (!isTeamOf(game, teamId)) return res.status(400).json({ message: "teamId must be one of this game's teams." });
      if (typeof req.body?.scored !== "boolean") return res.status(400).json({ message: "scored (true/false) is required." });

      let playerId: number | undefined = req.body?.playerId ? Number(req.body.playerId) : undefined;
      const { playerName, playerTeamId } = req.body ?? {};
      if (!playerId && playerName && playerTeamId && isTeamOf(game, Number(playerTeamId))) {
        playerId = await storage.findOrCreateTournamentPlayerByName(Number(playerTeamId), String(playerName));
      }
      const kick = await storage.addPenaltyKick({ gameId: id, teamId, scored: req.body.scored, ...(playerId ? { playerId } : {}) });
      await storage.syncShootoutTotals(id);
      try { await resolveTournamentBrackets(game.tournamentId); } catch (e) { console.error("[cic-ref] bracket resolve failed", e); }
      await stampScored(id, (req as any).referee.id);
      res.status(201).json(kick);
    } catch (e: any) {
      console.error("[cic-ref] shootout add failed", e);
      res.status(400).json({ message: e.message });
    }
  });

  app.delete("/api/public/cic-referees/games/:id/shootout/:kickId", requireRefereeToken, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const found = await loadCicGame(id);
      if (!found) return res.status(404).json({ message: "Game not found." });
      const gameId = await storage.deletePenaltyKick(parseInt(String(req.params.kickId), 10));
      if (gameId === id) {
        await storage.syncShootoutTotals(id);
        try { await resolveTournamentBrackets(found.game.tournamentId); } catch (e) { console.error("[cic-ref] bracket resolve failed", e); }
        await stampScored(id, (req as any).referee.id);
      }
      res.json({ ok: true });
    } catch (e: any) {
      res.status(400).json({ message: e.message });
    }
  });

  // ═══════════════════════ ADMIN (staff session + tab) ══════════════════════
  // Approve referees and assign them to games. Gated by the "cic-referees" tab
  // and scoped to the caller's workspace org (which is the CIC workspace).
  const tab = requireTab("cic-referees");
  // Assigning refs to games + the Game Feed live on the Tournaments page, so they
  // are gated by the "tournaments" tab (Isaac/Rolof schedule there), not the
  // referee-approvals tab. Approving/removing referees stays on "cic-referees".
  const schedTab = requireTab("tournaments");

  async function workspaceOrg(req: Request): Promise<{ id: number; slug: string } | null> {
    const slug = String(req.headers["x-workspace-slug"] || "").trim();
    if (!slug) return null;
    const [org] = await db.select().from(organizations).where(eq(organizations.slug, slug));
    return org ? { id: org.id, slug: org.slug } : null;
  }

  // Approved referees only — the pick-list for assigning a ref to a game in the
  // Schedule tab (type-to-search). Gated by the tournaments tab, not referees.
  app.get("/api/admin/cic/approved-referees", requireAuth, schedTab, async (_req, res) => {
    try {
      const orgId = await cicOrgId();
      const rows = await db.select({ id: cicReferees.id, fullName: cicReferees.fullName, phone: cicReferees.phone })
        .from(cicReferees)
        .where(and(eq(cicReferees.organizationId, orgId), eq(cicReferees.status, "approved")))
        .orderBy(cicReferees.fullName);
      res.json({ referees: rows });
    } catch (e: any) {
      console.error("[cic-ref] approved list failed", e);
      res.status(500).json({ message: e.message });
    }
  });

  // The live Game Feed — every game across the active CIC tournaments as one flat
  // feed with team names, status/score, assigned referee(s) and who last scored.
  // Powers the "Game Feed" tab on the Tournaments page (Isaac/Rolof's overview).
  app.get("/api/admin/cic/game-feed", requireAuth, schedTab, async (_req, res) => {
    try {
      const orgId = await cicOrgId();
      const tourns = await db.select().from(tournaments)
        .where(and(eq(tournaments.organizationId, orgId), eq(tournaments.active, true), eq(tournaments.archived, false)));
      const tids = tourns.map((t) => t.id);
      if (!tids.length) return res.json({ games: [] });
      const tById = new Map(tourns.map((t) => [t.id, t]));

      const [games, teamRows, assignRows, refRows] = await Promise.all([
        db.select().from(tournamentGames).where(inArray(tournamentGames.tournamentId, tids)),
        db.select({ id: tournamentTeams.id, name: tournamentTeams.name }).from(tournamentTeams).where(inArray(tournamentTeams.tournamentId, tids)),
        db.select().from(cicRefereeAssignments),
        db.select({ id: cicReferees.id, fullName: cicReferees.fullName }).from(cicReferees).where(eq(cicReferees.organizationId, orgId)),
      ]);
      const teamName = new Map(teamRows.map((t) => [t.id, t.name]));
      const refName = new Map(refRows.map((r) => [r.id, r.fullName]));
      const byGame = new Map<number, { id: number; fullName: string }[]>();
      for (const a of assignRows) {
        const nm = refName.get(a.refereeId);
        if (!nm) continue;
        const arr = byGame.get(a.gameId) ?? [];
        arr.push({ id: a.refereeId, fullName: nm });
        byGame.set(a.gameId, arr);
      }

      const feed = games.map((g) => ({
        id: g.id,
        tournamentId: g.tournamentId,
        tournamentName: tById.get(g.tournamentId)?.name ?? "",
        ageGroup: tById.get(g.tournamentId)?.ageGroup ?? null,
        gameNumber: g.gameNumber,
        stage: g.stage,
        stageDetail: g.stageDetail,
        gameDate: g.gameDate,
        startTime: g.startTime,
        field: g.field,
        status: g.status,
        isLive: g.isLive,
        homeTeamName: g.homeTeamId ? (teamName.get(g.homeTeamId) ?? null) : (g.homeTeamPlaceholder ?? null),
        awayTeamName: g.awayTeamId ? (teamName.get(g.awayTeamId) ?? null) : (g.awayTeamPlaceholder ?? null),
        homeScore: g.homeScore,
        awayScore: g.awayScore,
        homePenalties: g.homePenalties,
        awayPenalties: g.awayPenalties,
        assignedReferees: byGame.get(g.id) ?? [],
        lastScoredByRefereeId: g.lastScoredByRefereeId ?? null,
        lastScoredByName: g.lastScoredByRefereeId ? (refName.get(g.lastScoredByRefereeId) ?? null) : null,
        lastScoredAt: g.lastScoredAt ?? null,
      }));
      feed.sort((a, b) => (`${a.gameDate ?? ""}${a.startTime ?? ""}`).localeCompare(`${b.gameDate ?? ""}${b.startTime ?? ""}`) || a.id - b.id);
      res.json({ games: feed });
    } catch (e: any) {
      console.error("[cic-ref] game feed failed", e);
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/admin/cic-referees", requireAuth, tab, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "X-Workspace-Slug header required" });
      const rows = await db.select().from(cicReferees)
        .where(eq(cicReferees.organizationId, org.id))
        .orderBy(desc(cicReferees.createdAt));
      const ids = rows.map((r) => r.id);
      const assigns = ids.length
        ? await db.select({ refereeId: cicRefereeAssignments.refereeId }).from(cicRefereeAssignments).where(inArray(cicRefereeAssignments.refereeId, ids))
        : [];
      res.json({
        referees: rows.map((r) => ({
          ...publicRef(r),
          assignmentCount: assigns.filter((a) => a.refereeId === r.id).length,
        })),
      });
    } catch (e: any) {
      console.error("[cic-ref] admin list failed", e);
      res.status(500).json({ message: e.message });
    }
  });

  app.patch("/api/admin/cic-referees/:id", requireAuth, tab, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      const id = parseInt(String(req.params.id), 10);
      if (!org || !Number.isFinite(id)) return res.status(400).json({ message: "Bad request" });

      const patch: Record<string, any> = {};
      if (req.body.status !== undefined) {
        if (!isRefereeStatus(req.body.status)) {
          return res.status(400).json({ message: `Status must be one of ${REFEREE_STATUSES.join(", ")}` });
        }
        patch.status = req.body.status;
        patch.approvedBy = req.session.userId!;
        patch.decidedAt = new Date();
      }
      if (Object.keys(patch).length === 0) return res.status(400).json({ message: "Nothing to update" });

      const [before] = await db.select().from(cicReferees)
        .where(and(eq(cicReferees.id, id), eq(cicReferees.organizationId, org.id)));
      if (!before) return res.status(404).json({ message: "Referee not found" });

      const [updated] = await db.update(cicReferees).set(patch)
        .where(and(eq(cicReferees.id, id), eq(cicReferees.organizationId, org.id)))
        .returning();

      // Only email on the transition INTO approved — not on every re-save.
      if (patch.status === "approved" && before.status !== "approved") {
        try {
          await sendRefereeApprovedEmail({ orgId: org.id, to: updated.email, refereeName: updated.fullName });
        } catch (mailErr) {
          console.error("[cic-ref] approval email failed", mailErr);
        }
      }
      res.json(publicRef(updated));
    } catch (e: any) {
      console.error("[cic-ref] admin patch failed", e);
      res.status(500).json({ message: e.message });
    }
  });

  app.delete("/api/admin/cic-referees/:id", requireAuth, tab, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      const id = parseInt(String(req.params.id), 10);
      if (!org || !Number.isFinite(id)) return res.status(400).json({ message: "Bad request" });
      const [deleted] = await db.delete(cicReferees)
        .where(and(eq(cicReferees.id, id), eq(cicReferees.organizationId, org.id))).returning();
      if (!deleted) return res.status(404).json({ message: "Referee not found" });
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // Assignments (referee ↔ game). Games are validated to be CIC games.
  app.get("/api/admin/cic-referees/assignments", requireAuth, schedTab, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "X-Workspace-Slug header required" });
      const refs = await db.select({ id: cicReferees.id }).from(cicReferees).where(eq(cicReferees.organizationId, org.id));
      const rids = refs.map((r) => r.id);
      const rows = rids.length
        ? await db.select().from(cicRefereeAssignments).where(inArray(cicRefereeAssignments.refereeId, rids))
        : [];
      res.json({ assignments: rows });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/admin/cic-referees/assignments", requireAuth, schedTab, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "X-Workspace-Slug header required" });
      const refereeId = Number(req.body?.refereeId);
      const gameId = Number(req.body?.gameId);
      const [ref] = await db.select().from(cicReferees)
        .where(and(eq(cicReferees.id, refereeId), eq(cicReferees.organizationId, org.id)));
      if (!ref) return res.status(404).json({ message: "Referee not found" });
      if (!(await loadCicGame(gameId))) return res.status(404).json({ message: "Game not found" });

      const [row] = await db.insert(cicRefereeAssignments)
        .values({ refereeId, gameId, assignedBy: req.session.userId! })
        .onConflictDoNothing()
        .returning();
      res.status(201).json(row ?? { ok: true, alreadyAssigned: true });
    } catch (e: any) {
      console.error("[cic-ref] assign failed", e);
      res.status(500).json({ message: e.message });
    }
  });

  app.delete("/api/admin/cic-referees/assignments", requireAuth, schedTab, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "X-Workspace-Slug header required" });
      const refereeId = Number(req.body?.refereeId);
      const gameId = Number(req.body?.gameId);
      const [ref] = await db.select().from(cicReferees)
        .where(and(eq(cicReferees.id, refereeId), eq(cicReferees.organizationId, org.id)));
      if (!ref) return res.status(404).json({ message: "Referee not found" });
      await db.delete(cicRefereeAssignments)
        .where(and(eq(cicRefereeAssignments.refereeId, refereeId), eq(cicRefereeAssignments.gameId, gameId)));
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });
}
