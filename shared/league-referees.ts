// League (Mini Football Leagues) referee accounts — shared constants +
// validation, used by both the server (server/league-referee-routes.ts) and
// any client that needs the status list.
//
// This is the CIC referee system's shape exactly (shared/referees.ts), for a
// SEPARATE identity: `leagueReferees` holds only a scoped, MFL-only scoring
// credential and never a staff session — see server/league-referee-routes.ts
// for the full reasoning. The underlying logic (statuses, login gate, limits)
// is identical to CIC today, so it lives in one place (shared/referees.ts) and
// is re-exported here under MFL-specific names — callers say what domain they
// mean, and MFL-specific limits could diverge later without touching the CIC
// file (or vice versa).
export {
  REFEREE_STATUSES as LEAGUE_REFEREE_STATUSES,
  type RefereeStatus as LeagueRefereeStatus,
  isRefereeStatus as isLeagueRefereeStatus,
  refereeCanLogin as leagueRefereeCanLogin,
  REFEREE_LIMITS as LEAGUE_REFEREE_LIMITS,
} from "./referees";
