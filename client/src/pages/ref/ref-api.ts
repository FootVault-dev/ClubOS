// CIC referee scoring app — API layer.
//
// Deliberately independent from the admin app's apiRequest/queryClient
// (client/src/lib/queryClient.ts): that helper sends the STAFF session
// cookie + X-Workspace-Slug header, which a referee credential must never
// carry (see server/cic-referee-routes.ts — a referee is a structurally
// separate identity from ClubOS staff `users`, on purpose). Every call here
// is a plain `fetch`, same-origin, relative `/api/...` URL, with a Bearer
// token attached from localStorage.
//
// react-query (`useQuery`/`useMutation`/`useQueryClient` imported directly
// from "@tanstack/react-query", not from "@/lib/queryClient") is still fine
// to use on top of this — it's just a cache; every queryFn/mutationFn below
// goes through `refFetch`, so the ambient QueryClientProvider mounted in
// App.tsx never touches these requests with its default (cookie-based)
// fetcher.

const TOKEN_KEY = "cic_ref_token";

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
// callers can show it verbatim (the server routes always return a plain-
// English `message`).
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
export const refPut = <T = any>(path: string, body?: any) =>
  refFetch<T>(path, { method: "PUT", body: body !== undefined ? JSON.stringify(body) : undefined });
export const refDelete = <T = any>(path: string) => refFetch<T>(path, { method: "DELETE" });

// Single source of truth for the game-detail query key, shared by the main
// fetch and every mutation's invalidation in RefGameDetail.tsx.
export const refGameQueryKey = (id: number) => ["ref-game", id] as const;

// ── Types (referee-facing subset of shared/schema.ts) ──────────────────────

export interface Referee {
  id: number;
  fullName: string;
  email: string;
  phone?: string;
}

export interface RefGameListItem {
  id: number;
  tournamentId: number;
  tournamentName: string;
  ageGroup: string | null;
  stage: string;
  stageDetail: string | null;
  gameDate: string | null; // 'YYYY-MM-DD'
  startTime: string | null;
  field: string | null;
  status: "scheduled" | "final" | string;
  isLive: boolean;
  homeTeamId: number | null;
  awayTeamId: number | null;
  homeTeamName: string | null;
  awayTeamName: string | null;
  homeScore: number | null;
  awayScore: number | null;
  assigned: boolean;
}

export interface RefTeam {
  id: number;
  name: string;
  [key: string]: any;
}

export interface RefPlayer {
  id: number;
  teamId: number;
  firstName: string;
  lastName: string;
  shirtNumber: number | null;
}

export interface RefGoal {
  id: number;
  gameId: number;
  teamId: number;
  playerId: number;
  minute: number | null;
  isOwnGoal: boolean;
  isPenalty: boolean;
}

export interface RefCard {
  id: number;
  gameId: number;
  teamId: number;
  playerId: number;
  cardType: "yellow" | "red";
  minute: number | null;
}

export interface RefMvpVote {
  gameId: number;
  voterTeamId: number;
  playerId: number;
}

export interface RefGkRating {
  gameId: number;
  teamId: number;
  playerId: number;
  rating: number;
}

export interface RefShootoutKick {
  id: number;
  gameId: number;
  kickNumber: number;
  teamId: number;
  scored: boolean;
  playerId: number | null;
}

// Timer phases: pre → first_half → half_time → second_half → finished.
// See server/cic-referee-routes.ts applyTimerAction() — the clock is always
// DERIVED from timerRunning/timerStartedAt/timerBaseSeconds, never stored ticking.
export type RefTimerPhase = "pre" | "first_half" | "half_time" | "second_half" | "finished";
export type RefTimerAction = "start_1h" | "pause" | "resume" | "finish_1h" | "start_2h" | "finish_game" | "reset";

export interface RefGameFull {
  id: number;
  tournamentId: number;
  homeTeamId: number | null;
  awayTeamId: number | null;
  homeTeamPlaceholder: string | null;
  awayTeamPlaceholder: string | null;
  stage: string;
  stageDetail: string | null;
  gameDate: string | null;
  startTime: string | null;
  field: string | null;
  status: string;
  isLive: boolean;
  homeScore: number | null;
  awayScore: number | null;
  homePenalties: number | null;
  awayPenalties: number | null;
  timerPhase: RefTimerPhase;
  timerRunning: boolean;
  timerStartedAt: string | null;
  timerBaseSeconds: number;
  [key: string]: any;
}

export interface RefGameDetailResponse {
  game: RefGameFull;
  teams: RefTeam[];
  goals: RefGoal[];
  cards: RefCard[];
  mvpVotes: RefMvpVote[];
  gkRatings: RefGkRating[];
  shootout: RefShootoutKick[];
  players: RefPlayer[];
  halfLengthMinutes: number;
  breakMinutes: number;
}
