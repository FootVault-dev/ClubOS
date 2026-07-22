// ─────────────────────────────────────────────────────────────────────────────
// FRIENDLY MANAGER COMPETITIONS — 11 years of tournaments + social leagues,
// imported 2026-07-17 from FM's re-enabled Competitions module.
//
// Read-only over the additive fm_competition_* tables (apply-fm-competitions.ts,
// raw-SQL tables). Org-segmented at import (CIC→5, social leagues→3, festival→1)
// but this is Daniel's unified historical browser, so the routes read ALL of it.
//
//   GET /api/admin/fm-competitions/stats               — headline totals + segments
//   GET /api/admin/fm-competitions/list?segment=&q=    — competition list
//   GET /api/admin/fm-competitions/comp/:id            — one comp: teams, games, placings
//   GET /api/admin/fm-competitions/club-loyalty        — CIC club × year ledger
//
// Gated by requireTab("fm-competitions") ∈ SUPER_ADMIN_ONLY_TABS — carries team
// managers' phones/emails, Daniel-only until he opens it up. No public surface.
// ─────────────────────────────────────────────────────────────────────────────
import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "./db";
import { requireAuth, requireTab } from "./auth";

export function registerFmCompetitionsRoutes(app: Express) {
  const tab = requireTab("fm-competitions");

  app.get("/api/admin/fm-competitions/stats", requireAuth, tab, async (_req: Request, res: Response) => {
    try {
      const head: any = (await db.execute(sql`
        SELECT
          (SELECT count(*) FROM fm_competition_history)::int AS "competitions",
          (SELECT count(*) FROM fm_competition_teams)::int AS "teams",
          (SELECT count(*) FROM fm_competition_games)::int AS "games",
          (SELECT count(*) FROM fm_competition_games WHERE home_score IS NOT NULL AND away_score IS NOT NULL)::int AS "scoredGames",
          (SELECT count(*) FROM fm_competition_placings)::int AS "placings",
          (SELECT count(DISTINCT lower(trim(club_name))) FROM fm_competition_teams WHERE club_name IS NOT NULL AND trim(club_name) <> '')::int AS "clubs",
          (SELECT min(season_year) FROM fm_competition_history) AS "firstYear",
          (SELECT max(season_year) FROM fm_competition_history) AS "lastYear"
      `)).rows[0];
      const segments = (await db.execute(sql`
        SELECT segment, count(*)::int AS "competitions",
               (SELECT count(*) FROM fm_competition_teams t WHERE t.fm_comp_id IN
                  (SELECT fm_comp_id FROM fm_competition_history h2 WHERE h2.segment = h.segment))::int AS "teams"
        FROM fm_competition_history h GROUP BY segment ORDER BY 2 DESC
      `)).rows;
      const byYear = (await db.execute(sql`
        SELECT season_year AS "year", count(*)::int AS "competitions",
               (SELECT count(*) FROM fm_competition_teams t
                 JOIN fm_competition_history h2 ON h2.fm_comp_id = t.fm_comp_id
                WHERE h2.season_year = h.season_year)::int AS "teams"
        FROM fm_competition_history h GROUP BY season_year ORDER BY season_year NULLS LAST
      `)).rows;
      res.json({ ...head, segments, byYear });
    } catch (err) {
      console.error("[fm-competitions] stats:", err);
      res.status(500).json({ message: "Failed to load stats" });
    }
  });

  app.get("/api/admin/fm-competitions/list", requireAuth, tab, async (req: Request, res: Response) => {
    try {
      const segment = String(req.query.segment ?? "").trim();
      const q = String(req.query.q ?? "").trim().slice(0, 80);
      const rows = (await db.execute(sql`
        SELECT h.fm_comp_id AS "id", h.name, h.segment, h.season_year AS "seasonYear",
               to_char(h.start_date,'YYYY-MM-DD') AS "start", to_char(h.end_date,'YYYY-MM-DD') AS "end",
               coalesce(tc.teams,0)::int AS "teams",
               coalesce(gc.games,0)::int AS "games",
               coalesce(gc.scored,0)::int AS "scored",
               coalesce(pc.placings,0)::int AS "placings"
        FROM fm_competition_history h
        LEFT JOIN LATERAL (SELECT count(*) teams FROM fm_competition_teams t WHERE t.fm_comp_id = h.fm_comp_id) tc ON true
        LEFT JOIN LATERAL (SELECT count(*) games, count(*) FILTER (WHERE home_score IS NOT NULL AND away_score IS NOT NULL) scored
                           FROM fm_competition_games g WHERE g.fm_comp_id = h.fm_comp_id) gc ON true
        LEFT JOIN LATERAL (SELECT count(*) placings FROM fm_competition_placings p WHERE p.fm_comp_id = h.fm_comp_id) pc ON true
        WHERE (${segment} = '' OR h.segment = ${segment})
          AND (${q} = '' OR h.name ILIKE ${"%" + q + "%"})
        ORDER BY h.start_date DESC NULLS LAST
      `)).rows;
      res.json(rows);
    } catch (err) {
      console.error("[fm-competitions] list:", err);
      res.status(500).json({ message: "Failed to load competitions" });
    }
  });

  app.get("/api/admin/fm-competitions/comp/:id", requireAuth, tab, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ message: "Bad id" });
      const comp: any = (await db.execute(sql`
        SELECT fm_comp_id AS "id", name, segment, season_year AS "seasonYear",
               to_char(start_date,'YYYY-MM-DD') AS "start", to_char(end_date,'YYYY-MM-DD') AS "end", organization_id AS "orgId"
        FROM fm_competition_history WHERE fm_comp_id = ${id}
      `)).rows[0];
      if (!comp) return res.status(404).json({ message: "Not found" });
      const teams = (await db.execute(sql`
        SELECT division_name AS "division", team_name AS "team", club_name AS "club",
               manager_name AS "manager", manager_phone AS "phone", manager_email AS "email", num_players AS "players"
        FROM fm_competition_teams WHERE fm_comp_id = ${id}
        ORDER BY division_name NULLS LAST, team_name
      `)).rows;
      const games = (await db.execute(sql`
        SELECT fm_division_id AS "divisionId", fm_round_id AS "roundId", pool,
               to_char(game_date,'YYYY-MM-DD') AS "date", game_time AS "time", venue,
               home_team AS "home", away_team AS "away", home_score AS "homeScore", away_score AS "awayScore", status
        FROM fm_competition_games WHERE fm_comp_id = ${id}
        ORDER BY game_date NULLS LAST, game_time NULLS LAST
      `)).rows;
      const placings = (await db.execute(sql`
        SELECT division_name AS "division", place AS "place", team_name AS "team", club_name AS "club"
        FROM fm_competition_placings p
        LEFT JOIN LATERAL (SELECT division_name FROM fm_competition_teams t WHERE t.fm_comp_id = p.fm_comp_id AND t.fm_division_id = p.fm_division_id LIMIT 1) d ON true
        WHERE p.fm_comp_id = ${id} ORDER BY p.fm_division_id NULLS LAST, p.place
      `)).rows;
      res.json({ comp, teams, games, placings });
    } catch (err) {
      console.error("[fm-competitions] comp:", err);
      res.status(500).json({ message: "Failed to load competition" });
    }
  });

  app.get("/api/admin/fm-competitions/club-loyalty", requireAuth, tab, async (_req: Request, res: Response) => {
    try {
      // A club's CIC participation, one row per club, columns = years entered.
      const rows = (await db.execute(sql`
        WITH cic AS (
          SELECT DISTINCT lower(trim(t.club_name)) AS club_key,
                 trim(t.club_name) AS club_name, h.season_year AS yr
          FROM fm_competition_teams t
          JOIN fm_competition_history h ON h.fm_comp_id = t.fm_comp_id AND h.segment = 'cic'
          WHERE t.club_name IS NOT NULL AND trim(t.club_name) <> ''
        )
        SELECT max(club_name) AS "club",
               count(DISTINCT yr)::int AS "yearsEntered",
               array_agg(DISTINCT yr ORDER BY yr) AS "years"
        FROM cic GROUP BY club_key
        ORDER BY count(DISTINCT yr) DESC, max(club_name)
      `)).rows;
      res.json(rows);
    } catch (err) {
      console.error("[fm-competitions] club-loyalty:", err);
      res.status(500).json({ message: "Failed to load club loyalty" });
    }
  });
}
