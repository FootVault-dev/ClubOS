// MFL (Mini Football Leagues) referee scoring app — API layer.
//
// Cloned from client/src/pages/ref/ref-api.ts (the CIC referee app). Same
// reasoning applies: deliberately independent from the admin app's
// apiRequest/queryClient (client/src/lib/queryClient.ts), which sends the
// STAFF session cookie + X-Workspace-Slug header — a referee credential must
// never carry that (server/mfl-referee-routes.ts models a referee as a
// structurally separate identity from ClubOS staff `users`, same pattern as
// the CIC referees). Every call here is a plain `fetch`, same-origin,
// relative `/api/...` URL, with a Bearer token attached from localStorage.
//
// react-query is still fine to use on top of this — every queryFn/mutationFn
// below goes through `refFetch`, so the ambient QueryClientProvider mounted
// in App.tsx never touches these requests with its default (cookie-based)
// fetcher.
//
// The one real shape difference from CIC: MFL teams have NO player rosters.
// Every goal/card is a free-text `playerName` against a credited `teamId` —
// there is no RefPlayer/PlayerPicker, no MVP vote, no golden-glove rating,
// and no penalty shootout (leagues don't have any of those).

const TOKEN_KEY = "mfl_ref_token";

export function getRefToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setRefToken(token: string) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* localStorage unavailable (private mode etc.) — token just won't persist */
  }
}

export function clearRefToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* noop */
  }
}

export class RefApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Core fetch helper — attaches the Bearer token, parses JSON, and throws
// RefApiError with the server's own `message` on any non-2xx response so
// callers can show it verbatim.
export async function refFetch<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getRefToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((init.headers as Record<string, string>) || {}),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(path, { ...init, headers });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* no/invalid JSON body */
  }
  if (!res.ok) {
    const message = json?.message || `Something went wrong (${res.status}).`;
    throw new RefApiError(res.status, message);
  }
  return json as T;
}

export const refGet = <T = any>(path: string) => refFetch<T>(path);
export const refPost = <T = any>(path: string, body?: any) =>
  refFetch<T>(path, { method: "POST", body: body !== undefined ? JSON.stringify(body) : undefined });
export const refPatch = <T = any>(path: string, body?: any) =>
  refFetch<T>(path, { method: "PATCH", body: body !== undefined ? JSON.stringify(body) : undefined });
export const refDelete = <T = any>(path: string) => refFetch<T>(path, { method: "DELETE" });

// Single source of truth for the game-detail query key, shared by the main
// fetch and every mutation's invalidation in MflRefGameDetail.tsx.
export const refGameQueryKey = (id: number) => ["mfl-ref-game", id] as const;

// ── Types (referee-facing subset of shared/schema.ts's leagueGames/leagueTeams) ──

export interface Referee {
  id: number;
  fullName: string;
  email: string;
  phone?: string;
}

export type MflGameStatus = "scheduled" | "in_progress" | "final" | "cancelled" | "forfeit";

// Timer phases: pre → first_half → half_time → second_half → finished.
// Identical machine to CIC's (server applies the same state transitions) —
// see client/src/components/match-timer.tsx, reused untouched below. The
// clock is always DERIVED from timerRunning/timerStartedAt/timerBaseSeconds,
// never stored ticking.
export type RefTimerPhase = "pre" | "first_half" | "half_time" | "second_half" | "finished";
export type RefTimerAction = "start_1h" | "pause" | "resume" | "finish_1h" | "start_2h" | "finish_game" | "reset";

export interface MflRefGameListItem {
  id: number;
  competitionId: number;
  competitionName: string;
  divisionId: number | null;
  divisionName: string | null;
  gameNumber: number | null;
  gameDate: string | null; // 'YYYY-MM-DD'
  startTime: string | null;
  endTime: string | null;
  location: string | null;
  surface: string | null;
  status: MflGameStatus;
  homeTeamId: number | null;
  awayTeamId: number | null;
  homeTeamName: string | null;
  awayTeamName: string | null;
  homeScore: number | null;
  awayScore: number | null;
  assigned: boolean;
  timerPhase: RefTimerPhase;
  timerRunning: boolean;
  timerStartedAt: string | null;
  timerBaseSeconds: number;
  halfLengthMinutes: number;
  breakMinutes: number;
}

// A league night is "live" whenever the clock is actually mid-match —
// derived the same way everywhere in this app (list, top bar, game feed),
// never trusted off `status` alone (a referee might not have flipped it yet).
export function isGameLive(g: { timerPhase: RefTimerPhase }): boolean {
  return g.timerPhase === "first_half" || g.timerPhase === "half_time" || g.timerPhase === "second_half";
}

export interface MflRefTeam {
  id: number;
  name: string;
  [key: string]: any;
}

// MFL has no player rosters — every goal/card is a free-text name against a
// CREDITED team (own-goal flip already applied by the time it's posted, see
// MflRefGameDetail's submit()).
export interface MflRefGoal {
  id: number;
  gameId: number;
  teamId: number;
  playerName: string;
  minute: number | null;
  isOwnGoal: boolean;
  isPenalty: boolean;
}

export interface MflRefCard {
  id: number;
  gameId: number;
  teamId: number;
  playerName: string;
  cardType: "yellow" | "red";
  minute: number | null;
}

// Structural subset MatchTimer (client/src/components/match-timer.tsx) reads
// — that component takes `game: RefGameFull` typed from ./ref-api (the CIC
// module), so we pass this cast through `as any` rather than fork or edit
// it. It only ever touches timerPhase/timerRunning/timerStartedAt/
// timerBaseSeconds/homeScore/awayScore, all present here.
export interface MflGameFull {
  id: number;
  competitionId: number;
  divisionId: number | null;
  homeTeamId: number | null;
  awayTeamId: number | null;
  gameNumber: number | null;
  gameDate: string | null;
  startTime: string | null;
  endTime: string | null;
  location: string | null;
  surface: string | null;
  status: MflGameStatus;
  homeScore: number | null;
  awayScore: number | null;
  notes: string | null;
  timerPhase: RefTimerPhase;
  timerRunning: boolean;
  timerStartedAt: string | null;
  timerBaseSeconds: number;
  [key: string]: any;
}

export interface MflRefGameDetailResponse {
  game: MflGameFull;
  homeTeam: MflRefTeam | null;
  awayTeam: MflRefTeam | null;
  goals: MflRefGoal[];
  cards: MflRefCard[];
  assigned: boolean;
  halfLengthMinutes: number;
  breakMinutes: number;
}
