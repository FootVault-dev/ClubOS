// ─────────────────────────────────────────────────────────────────────────────
// MFL (MINI FOOTBALL LEAGUES) REFEREE SCORING
//
// Referees score their MFL games from their phones. Clone of the CIC referee
// system (server/cic-referee-routes.ts) — read that file's header for the full
// reasoning; only the MFL-specific differences are called out below.
//
// They are a SEPARATE account type from ClubOS staff `users` AND from
// `leagueGameReferees` (a ClubOS `users` row assigned as ref, used by the
// older session-based /api/league/games/:id/score + /api/league/me paths —
// see server/routes.ts. Left untouched by this file). A referee holds NO
// staff session — deliberately. Many /api/admin/* routes carry no org check
// (e.g. GET /api/admin/contacts returns the whole cross-club contacts DB to
// ANY logged-in session), so a referee credential must be structurally
// incapable of reaching them. It is: a referee authenticates with an HMAC
// token that carries a REFEREE id (prefixed "lref:") and never sets
// req.session.userId, and every scoring route below resolves the MFL org
// server-side and refuses any game that isn't an MFL game — whatever id the
// caller sends.
//
// Public (referee token, cookie-less):
//   POST /api/public/mfl-referees/signup            — self sign-up → 'pending'
//   POST /api/public/mfl-referees/login             — approved refs only → token
//   GET  /api/public/mfl-referees/me
//   GET  /api/public/mfl-referees/games?scope=mine|all
//   GET  /api/public/mfl-referees/games/:id
//   PATCH/POST/DELETE .../games/:id/(score|goals|cards|timer)
//
// Admin (staff session, scoped to the MFL workspace):
//   GET   /api/admin/mfl-referees                   — the approval list ("mfl-referees" tab)
//   PATCH /api/admin/mfl-referees/:id               — approve / decline / suspend
//   DELETE .../mfl-referees/:id
//   GET/POST/DELETE .../mfl-referees/assignments     — assign refs↔games ("competitions" tab)
//   GET   /api/admin/mfl/approved-referees           — pick-list for assigning
//   GET   /api/admin/mfl/game-feed                   — live Game Feed
//   GET   /api/admin/mfl/games/:id/detail            — Score Game bundle
//   PATCH /api/admin/mfl/games/:id                   — staff score/status write
//   POST/DELETE /api/admin/mfl/games/:id/goals[/:goalId]  — staff goal writes
//   POST/DELETE /api/admin/mfl/games/:id/cards[/:cardId]  — staff card writes
//   POST  /api/admin/mfl/games/:id/timer
//   GET/POST/PATCH/DELETE /api/admin/league/media    — photo/highlight gallery
//
// Unlike CIC's tournament games, MFL league games have no player-roster table
// (tournamentPlayers), no brackets, and no isLive column — so goals/cards take
// a free-text player name, there is no MVP/golden-glove/shootout, and
// status='in_progress' plays the "is this live right now" role the timer
// state machine needs.
// ─────────────────────────────────────────────────────────────────────────────
import type { Express, Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "./db";
import { storage } from "./storage";
import { requireAuth, requireTab, hashPassword, verifyPassword } from "./auth";
import { clientIp } from "./api-security";
import {
  organizations,
  leagueReferees,
  leagueRefereeAssignments,
  leagueGoals,
  leagueCards,
  leagueMedia,
  leagueCompetitions,
  leagueDivisions,
  leagueTeams,
  leagueGames,
  type LeagueGame,
} from "@shared/schema";
import {
  LEAGUE_REFEREE_LIMITS,
  LEAGUE_REFEREE_STATUSES,
  isLeagueRefereeStatus,
  leagueRefereeCanLogin,
} from "@shared/league-referees";
import { sendMflRefereeSignupNotification, sendMflRefereeApprovedEmail } from "./email";

const MFL_ORG_SLUG = "mini-football-leagues";

const s = (v: any, max = 200): string => String(v ?? "").trim().slice(0, max);
const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

// MFL org id, resolved from the slug (never trusted from the client) and cached.
let mflOrgIdCache: number | null = null;
async function mflOrgId(): Promise<number> {
  if (mflOrgIdCache) return mflOrgIdCache;
  const [org] = await db.select().from(organizations).where(eq(organizations.slug, MFL_ORG_SLUG));
  if (!org) throw new Error("MFL organization not found");
  mflOrgIdCache = org.id;
  return org.id;
}

// ── Referee token ────────────────────────────────────────────────────────────
// `lref:<refereeId>.<expiry>.<hmac>`, signed with the session secret. The
// "lref:" prefix is a domain separator: the CIC referee token parser (which
// requires a strict "ref:" prefix) rejects this token, and this file's parser
// requires a strict "lref:" prefix and so rejects a CIC "ref:" token — the two
// credentials can never be confused for one another. 30 days covers a season.
const LEAGUE_REF_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const leagueRefSecret = () => process.env.SESSION_SECRET || "cufc-dev-secret";

function makeLeagueRefereeToken(refereeId: number) {
  const expiresAt = Date.now() + LEAGUE_REF_TOKEN_TTL_MS;
  const payload = `lref:${refereeId}.${expiresAt}`;
  const sig = crypto.createHmac("sha256", leagueRefSecret()).update(payload).digest("hex");
  return { token: `${payload}.${sig}`, expiresAt };
}

function parseLeagueRefereeToken(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [idPart, expStr, sig] = parts;
  if (!idPart.startsWith("lref:")) return null;
  const expected = crypto.createHmac("sha256", leagueRefSecret()).update(`${idPart}.${expStr}`).digest("hex");
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const refereeId = parseInt(idPart.slice(5), 10);
  const exp = parseInt(expStr, 10);
  if (!refereeId || !exp || Date.now() > exp) return null;
  return refereeId;
}

// The referee row is re-loaded and re-checked on EVERY request — approval
// pulled by a staffer takes effect instantly, without waiting for the token to
// expire.
async function requireLeagueRefereeToken(req: Request, res: Response, next: NextFunction) {
  try {
    const header = String(req.headers.authorization || "");
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const refereeId = token ? parseLeagueRefereeToken(token) : null;
    if (!refereeId) return res.status(401).json({ message: "Please sign in again." });
    const [ref] = await db.select().from(leagueReferees).where(eq(leagueReferees.id, refereeId));
    if (!ref || !leagueRefereeCanLogin(ref.status)) {
      return res.status(403).json({ message: "This referee account isn't active." });
    }
    // Defence in depth: a referee is always, only, an MFL account.
    if (ref.organizationId !== (await mflOrgId())) {
      return res.status(403).json({ message: "Access denied." });
    }
    (req as any).leagueReferee = ref;
    next();
  } catch (e) {
    console.error("[league-ref] auth error", e);
    res.status(500).json({ message: "Auth check failed." });
  }
}

// THE security check for every referee write: the game must belong to an MFL
// competition. Returns null (→ 404) for any game that isn't MFL, so a referee
// can never read or write another workspace's game whatever id they send.
async function loadMflGame(gameId: number): Promise<{ game: LeagueGame; competition: typeof leagueCompetitions.$inferSelect } | null> {
  if (!Number.isFinite(gameId)) return null;
  const game = await storage.getLeagueGame(gameId);
  if (!game) return null;
  const [competition] = await db.select().from(leagueCompetitions).where(eq(leagueCompetitions.id, game.competitionId));
  if (!competition) return null;
  if (competition.organizationId !== (await mflOrgId())) return null;
  return { game, competition };
}

// Accountability stamp: who last saved a score on this game, and when.
async function stampScored(gameId: number, refereeId: number) {
  try {
    await db.update(leagueGames)
      .set({ lastScoredByRefereeId: refereeId, lastScoredAt: new Date() })
      .where(eq(leagueGames.id, gameId));
  } catch (e) {
    console.error("[league-ref] stamp failed", e);
  }
}

const isTeamOf = (game: LeagueGame, teamId: number) => teamId === game.homeTeamId || teamId === game.awayTeamId;

// ── Shared score / goal / card write cores ───────────────────────────────────
// One implementation behind both credentials: the referee-token routes pass
// their refereeId (which stamps last_scored_by for accountability), the staff-
// session admin routes pass null — a staff write is NOT a referee write, so
// the stamp is left exactly as-is. Every core goes through loadMflGame, so
// neither caller can ever touch a non-MFL game.

type WriteResult = { error?: string; status?: number; body?: any };

// Score / final. Only homeScore, awayScore and status ('scheduled'|'final')
// may ever be set through this path — whatever else the caller sends.
async function applyGamePatch(gameId: number, input: any, refereeId: number | null): Promise<WriteResult> {
  const found = await loadMflGame(gameId);
  if (!found) return { error: "Game not found.", status: 404 };

  const patch: Record<string, any> = {};
  const intOrNull = (v: any): number | null | undefined => {
    if (v === null || v === "") return null;
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 ? n : undefined;
  };
  if ("homeScore" in input) {
    const n = intOrNull(input.homeScore);
    if (n === undefined) return { error: "Home score must be a whole number.", status: 400 };
    patch.homeScore = n;
  }
  if ("awayScore" in input) {
    const n = intOrNull(input.awayScore);
    if (n === undefined) return { error: "Away score must be a whole number.", status: 400 };
    patch.awayScore = n;
  }
  if ("status" in input) {
    const st = String(input.status);
    if (st !== "scheduled" && st !== "final") return { error: "Status must be scheduled or final.", status: 400 };
    patch.status = st;
  }
  if (Object.keys(patch).length === 0) return { error: "Nothing to update.", status: 400 };

  const updated = await storage.updateLeagueGame(gameId, patch);
  if (!updated) return { error: "Game not found.", status: 404 };
  if (refereeId) await stampScored(gameId, refereeId);
  return { body: updated };
}

// Goals — MFL has no player-roster table, so the scorer is a typed name.
// Own goals send teamId = the CREDITED team (the client computes the flip).
async function addGoal(gameId: number, input: any, refereeId: number | null): Promise<WriteResult> {
  const found = await loadMflGame(gameId);
  if (!found) return { error: "Game not found.", status: 404 };
  const { game } = found;

  const teamId = Number(input?.teamId);
  if (!isTeamOf(game, teamId)) return { error: "teamId must be one of this game's teams.", status: 400 };
  const playerName = s(input?.playerName, 120);
  if (!playerName) return { error: "A scorer's name is required.", status: 400 };

  const minute = input?.minute;
  const [goal] = await db.insert(leagueGoals).values({
    gameId,
    teamId,
    playerName,
    minute: minute == null || minute === "" ? null : Number(minute),
    isOwnGoal: !!input?.isOwnGoal,
    isPenalty: !!input?.isPenalty,
  }).returning();
  if (refereeId) await stampScored(gameId, refereeId);
  return { body: goal };
}

async function removeGoal(gameId: number, goalId: number, refereeId: number | null): Promise<WriteResult> {
  const found = await loadMflGame(gameId);
  if (!found) return { error: "Game not found.", status: 404 };
  const [goal] = await db.select().from(leagueGoals).where(eq(leagueGoals.id, goalId));
  if (!goal || goal.gameId !== gameId) return { error: "Goal not found.", status: 404 };
  await db.delete(leagueGoals).where(eq(leagueGoals.id, goalId));
  if (refereeId) await stampScored(gameId, refereeId);
  return { body: { ok: true } };
}

async function addCard(gameId: number, input: any, refereeId: number | null): Promise<WriteResult> {
  const found = await loadMflGame(gameId);
  if (!found) return { error: "Game not found.", status: 404 };
  const { game } = found;

  const teamId = Number(input?.teamId);
  if (!isTeamOf(game, teamId)) return { error: "teamId must be one of this game's teams.", status: 400 };
  const cardType = String(input?.cardType);
  if (cardType !== "yellow" && cardType !== "red") return { error: "cardType must be 'yellow' or 'red'.", status: 400 };
  const playerName = s(input?.playerName, 120);
  if (!playerName) return { error: "A player's name is required.", status: 400 };

  const minute = input?.minute;
  const [card] = await db.insert(leagueCards).values({
    gameId,
    teamId,
    playerName,
    cardType,
    minute: minute == null || minute === "" ? null : Number(minute),
  }).returning();
  if (refereeId) await stampScored(gameId, refereeId);
  return { body: card };
}

async function removeCard(gameId: number, cardId: number, refereeId: number | null): Promise<WriteResult> {
  const found = await loadMflGame(gameId);
  if (!found) return { error: "Game not found.", status: 404 };
  const [card] = await db.select().from(leagueCards).where(eq(leagueCards.id, cardId));
  if (!card || card.gameId !== gameId) return { error: "Card not found.", status: 404 };
  await db.delete(leagueCards).where(eq(leagueCards.id, cardId));
  if (refereeId) await stampScored(gameId, refereeId);
  return { body: { ok: true } };
}

// ── Match timer state machine (Score Game) ───────────────────────────────────
// Phases: pre → first_half → half_time → second_half → finished. The clock is
// DERIVED from these fields (never stored ticking) — same convention as
// tournamentGames (server/cic-referee-routes.ts applyTimerAction). Leagues
// have no brackets to resolve and no isLive column: finish_game/reset flip
// `status` instead, which plays the "is this game live" role for the public
// API's derived isLive flag (see server/routes.ts).
const LEAGUE_TIMER_ACTIONS = ["start_1h", "pause", "resume", "finish_1h", "start_2h", "finish_game", "reset"] as const;

async function applyLeagueTimerAction(
  gameId: number,
  action: string,
  refereeId: number | null,
): Promise<{ error?: string; status?: number; game?: any }> {
  const found = await loadMflGame(gameId);
  if (!found) return { error: "Game not found.", status: 404 };
  const g = found.game;
  const now = new Date();
  const ran = g.timerRunning && g.timerStartedAt
    ? Math.max(0, Math.floor((now.getTime() - new Date(g.timerStartedAt).getTime()) / 1000))
    : 0;
  const patch: Record<string, any> = {};
  switch (action) {
    case "start_1h":
      Object.assign(patch, { timerPhase: "first_half", timerRunning: true, timerStartedAt: now, timerBaseSeconds: 0, status: "in_progress" });
      break;
    case "pause":
      Object.assign(patch, { timerRunning: false, timerStartedAt: null, timerBaseSeconds: (g.timerBaseSeconds || 0) + ran });
      break;
    case "resume":
      Object.assign(patch, { timerRunning: true, timerStartedAt: now });
      break;
    case "finish_1h":
      Object.assign(patch, { timerPhase: "half_time", timerRunning: true, timerStartedAt: now, timerBaseSeconds: 0 });
      break;
    case "start_2h":
      Object.assign(patch, { timerPhase: "second_half", timerRunning: true, timerStartedAt: now, timerBaseSeconds: 0 });
      break;
    case "finish_game":
      Object.assign(patch, { timerPhase: "finished", timerRunning: false, timerStartedAt: null, status: "final" });
      break;
    case "reset":
      // Scores are untouched — only the clock + status reset.
      Object.assign(patch, { timerPhase: "pre", timerRunning: false, timerStartedAt: null, timerBaseSeconds: 0, status: "scheduled" });
      break;
    default:
      return { error: `Unknown timer action. One of: ${LEAGUE_TIMER_ACTIONS.join(", ")}`, status: 400 };
  }
  const updated = await storage.updateLeagueGame(gameId, patch);
  if (refereeId) await stampScored(gameId, refereeId);
  return { game: updated };
}

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

const publicLeagueRef = (r: typeof leagueReferees.$inferSelect) => ({
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

export function registerLeagueRefereeRoutes(app: Express) {
  // ═══════════════════════════ PUBLIC (referee) ═════════════════════════════

  app.post("/api/public/mfl-referees/signup", async (req, res) => {
    try {
      const ip = clientIp(req) || "unknown";
      if (hit(signupHits, ip, LEAGUE_REFEREE_LIMITS.maxSignupsPerIpPerHour)) {
        return res.status(429).json({ message: "That's a few sign-ups in a short time. Try again shortly." });
      }
      const fullName = s(req.body?.fullName, LEAGUE_REFEREE_LIMITS.maxNameLength);
      const email = s(req.body?.email, LEAGUE_REFEREE_LIMITS.maxEmailLength).toLowerCase();
      const phone = s(req.body?.phone, LEAGUE_REFEREE_LIMITS.maxPhoneLength);
      const password = String(req.body?.password ?? "");

      const errors: string[] = [];
      if (!fullName) errors.push("Your full name is required.");
      if (!isEmail(email)) errors.push("A valid email address is required.");
      if (!phone) errors.push("A phone number is required.");
      if (password.length < LEAGUE_REFEREE_LIMITS.minPasswordLength) {
        errors.push(`Choose a password of at least ${LEAGUE_REFEREE_LIMITS.minPasswordLength} characters.`);
      }
      if (errors.length) return res.status(400).json({ message: errors[0], errors });

      const orgId = await mflOrgId();
      const passwordHash = await hashPassword(password);
      let created;
      try {
        [created] = await db.insert(leagueReferees)
          .values({ organizationId: orgId, fullName, email, phone, passwordHash, status: "pending" })
          .returning();
      } catch (e: any) {
        // league_referees_org_email_unq — someone already signed up with this email.
        if (String(e?.code) === "23505") {
          return res.status(409).json({
            message: "There's already a sign-up with this email. If it's yours, wait for approval or contact the MFL team.",
          });
        }
        throw e;
      }

      // Best-effort heads-up so staff can approve promptly. Never fail signup on it.
      try {
        await sendMflRefereeSignupNotification({ orgId, refereeName: fullName, email, phone });
      } catch (mailErr) {
        console.error("[league-ref] signup notification failed", mailErr);
      }

      res.json({ ok: true, id: created.id });
    } catch (e: any) {
      console.error("[league-ref] signup failed", e);
      res.status(500).json({ message: "Something went wrong creating your account." });
    }
  });

  app.post("/api/public/mfl-referees/login", async (req, res) => {
    try {
      const ip = clientIp(req) || "unknown";
      // Brute-force guard: too many recent failures from this IP → cool off.
      if ((loginFails.get(ip) ?? []).filter((t) => Date.now() - t < HOUR).length >= LEAGUE_REFEREE_LIMITS.maxLoginFailsPerIpPerHour) {
        return res.status(429).json({ message: "Too many attempts. Please wait a few minutes and try again." });
      }
      const email = s(req.body?.email, LEAGUE_REFEREE_LIMITS.maxEmailLength).toLowerCase();
      const password = String(req.body?.password ?? "");
      if (!email || !password) return res.status(400).json({ message: "Email and password are required." });

      const orgId = await mflOrgId();
      const [ref] = await db.select().from(leagueReferees)
        .where(and(eq(leagueReferees.organizationId, orgId), eq(leagueReferees.email, email)));
      const ok = ref ? await verifyPassword(password, ref.passwordHash) : false;
      if (!ref || !ok) {
        hit(loginFails, ip, Number.MAX_SAFE_INTEGER); // record the failure
        return res.status(401).json({ message: "Invalid email or password." });
      }
      if (!leagueRefereeCanLogin(ref.status)) {
        const message = ref.status === "pending"
          ? "Your referee account is awaiting approval. We'll email you as soon as it's active."
          : "This referee account isn't active. Please contact the MFL team.";
        return res.status(403).json({ message });
      }

      await db.update(leagueReferees).set({ lastLoginAt: new Date() }).where(eq(leagueReferees.id, ref.id));
      const { token, expiresAt } = makeLeagueRefereeToken(ref.id);
      res.json({ token, expiresAt, referee: { id: ref.id, fullName: ref.fullName, email: ref.email } });
    } catch (e: any) {
      console.error("[league-ref] login failed", e);
      res.status(500).json({ message: "Something went wrong signing in." });
    }
  });

  app.get("/api/public/mfl-referees/me", requireLeagueRefereeToken, async (req, res) => {
    const r = (req as any).leagueReferee;
    res.json({ referee: { id: r.id, fullName: r.fullName, email: r.email, phone: r.phone } });
  });

  // The referee's game list. scope=mine → their assigned games; scope=all →
  // every MFL game across active competitions (the flexibility Daniel asked
  // for on the CIC version, when fixtures shift).
  app.get("/api/public/mfl-referees/games", requireLeagueRefereeToken, async (req, res) => {
    try {
      const orgId = await mflOrgId();
      const refereeId = (req as any).leagueReferee.id;
      const scope = String(req.query.scope || "all");

      const comps = await db.select().from(leagueCompetitions)
        .where(and(eq(leagueCompetitions.organizationId, orgId), eq(leagueCompetitions.active, true), eq(leagueCompetitions.archived, false)));
      const cids = comps.map((c) => c.id);
      if (!cids.length) return res.json({ games: [] });
      const compById = new Map(comps.map((c) => [c.id, c]));

      const [games, divisions, teams, myAssigns] = await Promise.all([
        db.select().from(leagueGames).where(inArray(leagueGames.competitionId, cids)),
        db.select({ id: leagueDivisions.id, name: leagueDivisions.name }).from(leagueDivisions).where(inArray(leagueDivisions.competitionId, cids)),
        db.select({ id: leagueTeams.id, name: leagueTeams.name }).from(leagueTeams).where(inArray(leagueTeams.competitionId, cids)),
        db.select({ gameId: leagueRefereeAssignments.gameId }).from(leagueRefereeAssignments).where(eq(leagueRefereeAssignments.refereeId, refereeId)),
      ]);
      const divName = new Map(divisions.map((d) => [d.id, d.name]));
      const teamName = new Map(teams.map((t) => [t.id, t.name]));
      const mine = new Set(myAssigns.map((a) => a.gameId));

      let list = games.map((g) => {
        const comp = compById.get(g.competitionId);
        return {
          id: g.id,
          competitionId: g.competitionId,
          competitionName: comp?.name ?? "",
          divisionId: g.divisionId,
          divisionName: g.divisionId ? (divName.get(g.divisionId) ?? null) : null,
          gameDate: g.gameDate,
          startTime: g.startTime,
          location: g.location,
          status: g.status,
          homeTeamId: g.homeTeamId,
          awayTeamId: g.awayTeamId,
          homeTeamName: g.homeTeamId ? (teamName.get(g.homeTeamId) ?? null) : null,
          awayTeamName: g.awayTeamId ? (teamName.get(g.awayTeamId) ?? null) : null,
          homeScore: g.homeScore,
          awayScore: g.awayScore,
          timerPhase: g.timerPhase,
          timerRunning: g.timerRunning,
          timerStartedAt: g.timerStartedAt,
          timerBaseSeconds: g.timerBaseSeconds,
          halfLengthMinutes: comp?.halfLengthMinutes ?? 20,
          breakMinutes: comp?.breakMinutes ?? 5,
          assigned: mine.has(g.id),
        };
      });
      if (scope === "mine") list = list.filter((g) => g.assigned);
      list.sort((a, b) =>
        (`${a.gameDate ?? ""}${a.startTime ?? ""}`).localeCompare(`${b.gameDate ?? ""}${b.startTime ?? ""}`) || a.id - b.id);

      res.json({ games: list });
    } catch (e: any) {
      console.error("[league-ref] games list failed", e);
      res.status(500).json({ message: "Couldn't load your games right now." });
    }
  });

  app.get("/api/public/mfl-referees/games/:id", requireLeagueRefereeToken, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const found = await loadMflGame(id);
      if (!found) return res.status(404).json({ message: "Game not found." });
      const { game, competition } = found;
      const teamIds = [game.homeTeamId, game.awayTeamId].filter((x): x is number => !!x);

      const [teams, goals, cards, myAssign] = await Promise.all([
        teamIds.length ? db.select().from(leagueTeams).where(inArray(leagueTeams.id, teamIds)) : Promise.resolve([]),
        db.select().from(leagueGoals).where(eq(leagueGoals.gameId, id)),
        db.select().from(leagueCards).where(eq(leagueCards.gameId, id)),
        db.select().from(leagueRefereeAssignments)
          .where(and(eq(leagueRefereeAssignments.gameId, id), eq(leagueRefereeAssignments.refereeId, (req as any).leagueReferee.id))),
      ]);
      const byId = new Map(teams.map((t) => [t.id, t]));

      res.json({
        game,
        homeTeam: game.homeTeamId ? byId.get(game.homeTeamId) ?? null : null,
        awayTeam: game.awayTeamId ? byId.get(game.awayTeamId) ?? null : null,
        goals,
        cards,
        assigned: myAssign.length > 0,
        // Timer needs the half length + break from the competition, not the game.
        halfLengthMinutes: competition.halfLengthMinutes ?? 20,
        breakMinutes: competition.breakMinutes ?? 5,
      });
    } catch (e: any) {
      console.error("[league-ref] game detail failed", e);
      res.status(500).json({ message: "Couldn't load that game right now." });
    }
  });

  // Score / final. A referee may only ever touch these three fields — the
  // whitelist lives in applyGamePatch (shared with the staff Score Game twin).
  app.patch("/api/public/mfl-referees/games/:id", requireLeagueRefereeToken, async (req, res) => {
    try {
      const r = await applyGamePatch(parseInt(String(req.params.id), 10), req.body ?? {}, (req as any).leagueReferee.id);
      if (r.error) return res.status(r.status || 400).json({ message: r.error });
      res.json(r.body);
    } catch (e: any) {
      console.error("[league-ref] patch game failed", e);
      res.status(400).json({ message: e.message });
    }
  });

  // Goals — MFL has no player-roster table, so the scorer is a typed name.
  // Own goals send teamId = the CREDITED team (the client computes the flip).
  app.post("/api/public/mfl-referees/games/:id/goals", requireLeagueRefereeToken, async (req, res) => {
    try {
      const r = await addGoal(parseInt(String(req.params.id), 10), req.body ?? {}, (req as any).leagueReferee.id);
      if (r.error) return res.status(r.status || 400).json({ message: r.error });
      res.status(201).json(r.body);
    } catch (e: any) {
      console.error("[league-ref] add goal failed", e);
      res.status(400).json({ message: e.message });
    }
  });

  app.delete("/api/public/mfl-referees/games/:id/goals/:goalId", requireLeagueRefereeToken, async (req, res) => {
    try {
      const r = await removeGoal(parseInt(String(req.params.id), 10), parseInt(String(req.params.goalId), 10), (req as any).leagueReferee.id);
      if (r.error) return res.status(r.status || 400).json({ message: r.error });
      res.json(r.body);
    } catch (e: any) {
      res.status(400).json({ message: e.message });
    }
  });

  app.post("/api/public/mfl-referees/games/:id/cards", requireLeagueRefereeToken, async (req, res) => {
    try {
      const r = await addCard(parseInt(String(req.params.id), 10), req.body ?? {}, (req as any).leagueReferee.id);
      if (r.error) return res.status(r.status || 400).json({ message: r.error });
      res.status(201).json(r.body);
    } catch (e: any) {
      console.error("[league-ref] add card failed", e);
      res.status(400).json({ message: e.message });
    }
  });

  app.delete("/api/public/mfl-referees/games/:id/cards/:cardId", requireLeagueRefereeToken, async (req, res) => {
    try {
      const r = await removeCard(parseInt(String(req.params.id), 10), parseInt(String(req.params.cardId), 10), (req as any).leagueReferee.id);
      if (r.error) return res.status(r.status || 400).json({ message: r.error });
      res.json(r.body);
    } catch (e: any) {
      res.status(400).json({ message: e.message });
    }
  });

  // Match timer — Score Game state machine, run live by the referee.
  // Body: { action: start_1h | pause | resume | finish_1h | start_2h | finish_game | reset }.
  app.post("/api/public/mfl-referees/games/:id/timer", requireLeagueRefereeToken, async (req, res) => {
    try {
      const r = await applyLeagueTimerAction(parseInt(String(req.params.id), 10), String(req.body?.action || ""), (req as any).leagueReferee.id);
      if (r.error) return res.status(r.status || 400).json({ message: r.error });
      res.json(r.game);
    } catch (e: any) {
      console.error("[league-ref] timer failed", e);
      res.status(400).json({ message: e.message });
    }
  });

  // ═══════════════════════ ADMIN (staff session + tab) ══════════════════════
  // Approve referees and assign them to games. Gated by the "mfl-referees" tab
  // (approvals) and the "competitions" tab (scheduling/assignment/media/game
  // feed) — same split as CIC's "cic-referees" vs "tournaments" tabs, both
  // scoped to the caller's workspace org (the MFL workspace).
  const tab = requireTab("mfl-referees");
  const schedTab = requireTab("competitions");

  async function workspaceOrg(req: Request): Promise<{ id: number; slug: string } | null> {
    const slug = String(req.headers["x-workspace-slug"] || "").trim();
    if (!slug) return null;
    const [org] = await db.select().from(organizations).where(eq(organizations.slug, slug));
    return org ? { id: org.id, slug: org.slug } : null;
  }

  // Approved referees only — the pick-list for assigning a ref to a game in
  // the Schedule tab (type-to-search). Gated by the competitions tab, not
  // referees.
  app.get("/api/admin/mfl/approved-referees", requireAuth, schedTab, async (_req, res) => {
    try {
      const orgId = await mflOrgId();
      const rows = await db.select({ id: leagueReferees.id, fullName: leagueReferees.fullName, phone: leagueReferees.phone })
        .from(leagueReferees)
        .where(and(eq(leagueReferees.organizationId, orgId), eq(leagueReferees.status, "approved")))
        .orderBy(leagueReferees.fullName);
      res.json({ referees: rows });
    } catch (e: any) {
      console.error("[league-ref] approved list failed", e);
      res.status(500).json({ message: e.message });
    }
  });

  // The live Game Feed — every game across the active MFL competitions as one
  // flat feed with team names, status/score, assigned referee(s) and who last
  // scored.
  app.get("/api/admin/mfl/game-feed", requireAuth, schedTab, async (_req, res) => {
    try {
      const orgId = await mflOrgId();
      const comps = await db.select().from(leagueCompetitions)
        .where(and(eq(leagueCompetitions.organizationId, orgId), eq(leagueCompetitions.active, true), eq(leagueCompetitions.archived, false)));
      const cids = comps.map((c) => c.id);
      if (!cids.length) return res.json({ games: [] });
      const compById = new Map(comps.map((c) => [c.id, c]));

      const [games, divisions, teamRows, assignRows, refRows] = await Promise.all([
        db.select().from(leagueGames).where(inArray(leagueGames.competitionId, cids)),
        db.select({ id: leagueDivisions.id, name: leagueDivisions.name }).from(leagueDivisions).where(inArray(leagueDivisions.competitionId, cids)),
        db.select({ id: leagueTeams.id, name: leagueTeams.name }).from(leagueTeams).where(inArray(leagueTeams.competitionId, cids)),
        db.select().from(leagueRefereeAssignments),
        db.select({ id: leagueReferees.id, fullName: leagueReferees.fullName }).from(leagueReferees).where(eq(leagueReferees.organizationId, orgId)),
      ]);
      const divName = new Map(divisions.map((d) => [d.id, d.name]));
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
        competitionId: g.competitionId,
        competitionName: compById.get(g.competitionId)?.name ?? "",
        divisionId: g.divisionId,
        divisionName: g.divisionId ? (divName.get(g.divisionId) ?? null) : null,
        gameNumber: g.gameNumber,
        gameDate: g.gameDate,
        startTime: g.startTime,
        location: g.location,
        status: g.status,
        homeTeamName: g.homeTeamId ? (teamName.get(g.homeTeamId) ?? null) : null,
        awayTeamName: g.awayTeamId ? (teamName.get(g.awayTeamId) ?? null) : null,
        homeScore: g.homeScore,
        awayScore: g.awayScore,
        timerPhase: g.timerPhase ?? "pre",
        timerRunning: g.timerRunning ?? false,
        timerStartedAt: g.timerStartedAt ?? null,
        timerBaseSeconds: g.timerBaseSeconds ?? 0,
        assignedReferees: byGame.get(g.id) ?? [],
        lastScoredByRefereeId: g.lastScoredByRefereeId ?? null,
        lastScoredByName: g.lastScoredByRefereeId ? (refName.get(g.lastScoredByRefereeId) ?? null) : null,
        lastScoredAt: g.lastScoredAt ?? null,
      }));
      feed.sort((a, b) => (`${a.gameDate ?? ""}${a.startTime ?? ""}`).localeCompare(`${b.gameDate ?? ""}${b.startTime ?? ""}`) || a.id - b.id);
      res.json({ games: feed });
    } catch (e: any) {
      console.error("[league-ref] game feed failed", e);
      res.status(500).json({ message: e.message });
    }
  });

  // Match timer — admin/office. Same state machine, session + competitions
  // tab instead of the referee token.
  app.post("/api/admin/mfl/games/:id/timer", requireAuth, schedTab, async (req, res) => {
    try {
      const r = await applyLeagueTimerAction(parseInt(String(req.params.id), 10), String(req.body?.action || ""), null);
      if (r.error) return res.status(r.status || 400).json({ message: r.error });
      res.json(r.game);
    } catch (e: any) {
      console.error("[league-ref] admin timer failed", e);
      res.status(400).json({ message: e.message });
    }
  });

  // Full game bundle for the staff "Score Game" screen (from the Game Feed) —
  // mirrors the referee game-detail, but session + competitions tab.
  app.get("/api/admin/mfl/games/:id/detail", requireAuth, schedTab, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const found = await loadMflGame(id);
      if (!found) return res.status(404).json({ message: "Game not found." });
      const { game, competition } = found;
      const teamIds = [game.homeTeamId, game.awayTeamId].filter((x): x is number => !!x);
      const [teams, goals, cards] = await Promise.all([
        teamIds.length ? db.select().from(leagueTeams).where(inArray(leagueTeams.id, teamIds)) : Promise.resolve([]),
        db.select().from(leagueGoals).where(eq(leagueGoals.gameId, id)),
        db.select().from(leagueCards).where(eq(leagueCards.gameId, id)),
      ]);
      res.json({
        game, teams, goals, cards,
        halfLengthMinutes: competition.halfLengthMinutes ?? 20,
        breakMinutes: competition.breakMinutes ?? 5,
      });
    } catch (e: any) {
      console.error("[league-ref] admin game detail failed", e);
      res.status(500).json({ message: e.message });
    }
  });

  // Staff Score Game writes — the same cores the referee routes run (same
  // whitelist + validation, same loadMflGame org gate), but session +
  // competitions tab, and refereeId = null: a staff write is NOT a referee
  // write, so last_scored_by is deliberately left as-is.
  app.patch("/api/admin/mfl/games/:id", requireAuth, schedTab, async (req, res) => {
    try {
      const r = await applyGamePatch(parseInt(String(req.params.id), 10), req.body ?? {}, null);
      if (r.error) return res.status(r.status || 400).json({ message: r.error });
      res.json(r.body);
    } catch (e: any) {
      console.error("[league-ref] admin patch game failed", e);
      res.status(400).json({ message: e.message });
    }
  });

  app.post("/api/admin/mfl/games/:id/goals", requireAuth, schedTab, async (req, res) => {
    try {
      const r = await addGoal(parseInt(String(req.params.id), 10), req.body ?? {}, null);
      if (r.error) return res.status(r.status || 400).json({ message: r.error });
      res.status(201).json(r.body);
    } catch (e: any) {
      console.error("[league-ref] admin add goal failed", e);
      res.status(400).json({ message: e.message });
    }
  });

  app.delete("/api/admin/mfl/games/:id/goals/:goalId", requireAuth, schedTab, async (req, res) => {
    try {
      const r = await removeGoal(parseInt(String(req.params.id), 10), parseInt(String(req.params.goalId), 10), null);
      if (r.error) return res.status(r.status || 400).json({ message: r.error });
      res.json(r.body);
    } catch (e: any) {
      res.status(400).json({ message: e.message });
    }
  });

  app.post("/api/admin/mfl/games/:id/cards", requireAuth, schedTab, async (req, res) => {
    try {
      const r = await addCard(parseInt(String(req.params.id), 10), req.body ?? {}, null);
      if (r.error) return res.status(r.status || 400).json({ message: r.error });
      res.status(201).json(r.body);
    } catch (e: any) {
      console.error("[league-ref] admin add card failed", e);
      res.status(400).json({ message: e.message });
    }
  });

  app.delete("/api/admin/mfl/games/:id/cards/:cardId", requireAuth, schedTab, async (req, res) => {
    try {
      const r = await removeCard(parseInt(String(req.params.id), 10), parseInt(String(req.params.cardId), 10), null);
      if (r.error) return res.status(r.status || 400).json({ message: r.error });
      res.json(r.body);
    } catch (e: any) {
      res.status(400).json({ message: e.message });
    }
  });

  app.get("/api/admin/mfl-referees", requireAuth, tab, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "X-Workspace-Slug header required" });
      const rows = await db.select().from(leagueReferees)
        .where(eq(leagueReferees.organizationId, org.id))
        .orderBy(desc(leagueReferees.createdAt));
      const ids = rows.map((r) => r.id);
      const assigns = ids.length
        ? await db.select({ refereeId: leagueRefereeAssignments.refereeId }).from(leagueRefereeAssignments).where(inArray(leagueRefereeAssignments.refereeId, ids))
        : [];
      res.json({
        referees: rows.map((r) => ({
          ...publicLeagueRef(r),
          assignmentCount: assigns.filter((a) => a.refereeId === r.id).length,
        })),
      });
    } catch (e: any) {
      console.error("[league-ref] admin list failed", e);
      res.status(500).json({ message: e.message });
    }
  });

  app.patch("/api/admin/mfl-referees/:id", requireAuth, tab, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      const id = parseInt(String(req.params.id), 10);
      if (!org || !Number.isFinite(id)) return res.status(400).json({ message: "Bad request" });

      const patch: Record<string, any> = {};
      if (req.body.status !== undefined) {
        if (!isLeagueRefereeStatus(req.body.status)) {
          return res.status(400).json({ message: `Status must be one of ${LEAGUE_REFEREE_STATUSES.join(", ")}` });
        }
        patch.status = req.body.status;
        patch.approvedBy = req.session.userId!;
        patch.decidedAt = new Date();
      }
      if (Object.keys(patch).length === 0) return res.status(400).json({ message: "Nothing to update" });

      const [before] = await db.select().from(leagueReferees)
        .where(and(eq(leagueReferees.id, id), eq(leagueReferees.organizationId, org.id)));
      if (!before) return res.status(404).json({ message: "Referee not found" });

      const [updated] = await db.update(leagueReferees).set(patch)
        .where(and(eq(leagueReferees.id, id), eq(leagueReferees.organizationId, org.id)))
        .returning();

      // Only email on the transition INTO approved — not on every re-save.
      if (patch.status === "approved" && before.status !== "approved") {
        try {
          await sendMflRefereeApprovedEmail({ orgId: org.id, to: updated.email, refereeName: updated.fullName });
        } catch (mailErr) {
          console.error("[league-ref] approval email failed", mailErr);
        }
      }
      res.json(publicLeagueRef(updated));
    } catch (e: any) {
      console.error("[league-ref] admin patch failed", e);
      res.status(500).json({ message: e.message });
    }
  });

  app.delete("/api/admin/mfl-referees/:id", requireAuth, tab, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      const id = parseInt(String(req.params.id), 10);
      if (!org || !Number.isFinite(id)) return res.status(400).json({ message: "Bad request" });
      const [deleted] = await db.delete(leagueReferees)
        .where(and(eq(leagueReferees.id, id), eq(leagueReferees.organizationId, org.id))).returning();
      if (!deleted) return res.status(404).json({ message: "Referee not found" });
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // Assignments (referee ↔ game). Games are validated to be MFL games.
  app.get("/api/admin/mfl-referees/assignments", requireAuth, schedTab, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "X-Workspace-Slug header required" });
      const refs = await db.select({ id: leagueReferees.id }).from(leagueReferees).where(eq(leagueReferees.organizationId, org.id));
      const rids = refs.map((r) => r.id);
      const rows = rids.length
        ? await db.select().from(leagueRefereeAssignments).where(inArray(leagueRefereeAssignments.refereeId, rids))
        : [];
      res.json({ assignments: rows });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/admin/mfl-referees/assignments", requireAuth, schedTab, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "X-Workspace-Slug header required" });
      const refereeId = Number(req.body?.refereeId);
      const gameId = Number(req.body?.gameId);
      const [ref] = await db.select().from(leagueReferees)
        .where(and(eq(leagueReferees.id, refereeId), eq(leagueReferees.organizationId, org.id)));
      if (!ref) return res.status(404).json({ message: "Referee not found" });
      if (!(await loadMflGame(gameId))) return res.status(404).json({ message: "Game not found" });

      const [row] = await db.insert(leagueRefereeAssignments)
        .values({ refereeId, gameId, assignedBy: req.session.userId! })
        .onConflictDoNothing()
        .returning();
      res.status(201).json(row ?? { ok: true, alreadyAssigned: true });
    } catch (e: any) {
      console.error("[league-ref] assign failed", e);
      res.status(500).json({ message: e.message });
    }
  });

  app.delete("/api/admin/mfl-referees/assignments", requireAuth, schedTab, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "X-Workspace-Slug header required" });
      const refereeId = Number(req.body?.refereeId);
      const gameId = Number(req.body?.gameId);
      const [ref] = await db.select().from(leagueReferees)
        .where(and(eq(leagueReferees.id, refereeId), eq(leagueReferees.organizationId, org.id)));
      if (!ref) return res.status(404).json({ message: "Referee not found" });
      await db.delete(leagueRefereeAssignments)
        .where(and(eq(leagueRefereeAssignments.refereeId, refereeId), eq(leagueRefereeAssignments.gameId, gameId)));
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // Photo/highlight gallery for MFL competitions. Org = MFL via workspace
  // scoping (competitions tab) — no public surface here; the read side is
  // GET /api/public/league/media in server/routes.ts.
  app.get("/api/admin/league/media", requireAuth, schedTab, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "X-Workspace-Slug header required" });
      const rows = await db.select().from(leagueMedia)
        .where(eq(leagueMedia.organizationId, org.id))
        .orderBy(desc(leagueMedia.createdAt));
      res.json({ media: rows });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/admin/league/media", requireAuth, schedTab, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      if (!org) return res.status(400).json({ message: "X-Workspace-Slug header required" });
      const url = s(req.body?.url, 2000);
      if (!url) return res.status(400).json({ message: "url is required." });
      const [row] = await db.insert(leagueMedia).values({
        organizationId: org.id,
        competitionId: req.body?.competitionId ? Number(req.body.competitionId) : null,
        url,
        caption: req.body?.caption ? s(req.body.caption, 500) : null,
        takenAt: req.body?.takenAt || null,
        sortOrder: req.body?.sortOrder != null ? Number(req.body.sortOrder) : 0,
        published: req.body?.published !== undefined ? !!req.body.published : true,
      }).returning();
      res.status(201).json(row);
    } catch (e: any) {
      console.error("[league-ref] media create failed", e);
      res.status(400).json({ message: e.message });
    }
  });

  app.patch("/api/admin/league/media/:id", requireAuth, schedTab, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      const id = parseInt(String(req.params.id), 10);
      if (!org || !Number.isFinite(id)) return res.status(400).json({ message: "Bad request" });
      const patch: Record<string, any> = {};
      if (req.body.url !== undefined) patch.url = s(req.body.url, 2000);
      if (req.body.caption !== undefined) patch.caption = req.body.caption ? s(req.body.caption, 500) : null;
      if (req.body.takenAt !== undefined) patch.takenAt = req.body.takenAt || null;
      if (req.body.competitionId !== undefined) patch.competitionId = req.body.competitionId ? Number(req.body.competitionId) : null;
      if (req.body.sortOrder !== undefined) patch.sortOrder = Number(req.body.sortOrder);
      if (req.body.published !== undefined) patch.published = !!req.body.published;
      if (Object.keys(patch).length === 0) return res.status(400).json({ message: "Nothing to update" });

      const [updated] = await db.update(leagueMedia).set(patch)
        .where(and(eq(leagueMedia.id, id), eq(leagueMedia.organizationId, org.id)))
        .returning();
      if (!updated) return res.status(404).json({ message: "Not found" });
      res.json(updated);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.delete("/api/admin/league/media/:id", requireAuth, schedTab, async (req, res) => {
    try {
      const org = await workspaceOrg(req);
      const id = parseInt(String(req.params.id), 10);
      if (!org || !Number.isFinite(id)) return res.status(400).json({ message: "Bad request" });
      const [deleted] = await db.delete(leagueMedia)
        .where(and(eq(leagueMedia.id, id), eq(leagueMedia.organizationId, org.id))).returning();
      if (!deleted) return res.status(404).json({ message: "Not found" });
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });
}
