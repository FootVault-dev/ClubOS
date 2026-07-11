// ─────────────────────────────────────────────────────────────────────────────
// CIC GAME FEED — the "Game Feed" tab on the Tournaments page (/admin/tournaments).
// A read-only, auto-refreshing live board of every game across the active CIC
// (youth) tournaments — so Isaac/Rolof can watch scores, referee assignments
// and live status roll in from referees' phones without opening each
// tournament individually. Data: GET /api/admin/cic/game-feed — server-scoped
// to the CIC youth org regardless of X-Workspace-Slug (see
// server/cic-referee-routes.ts). No scoring here — that happens in the
// referee app (/ref) or the tournament detail page.
// ─────────────────────────────────────────────────────────────────────────────
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { nzTodayIso } from "@shared/academy";
import { Clock, Goal, MapPin, RefreshCw, Users } from "lucide-react";

interface GameFeedReferee {
  id: number;
  fullName: string;
}

interface GameFeedItem {
  id: number;
  tournamentId: number;
  tournamentName: string;
  ageGroup: string | null;
  gameNumber: number | null;
  stage: string;
  stageDetail: string | null;
  gameDate: string | null;
  startTime: string | null;
  field: string | null;
  status: "scheduled" | "final";
  isLive: boolean;
  homeTeamName: string | null;
  awayTeamName: string | null;
  homeScore: number | null;
  awayScore: number | null;
  homePenalties: number | null;
  awayPenalties: number | null;
  assignedReferees: GameFeedReferee[];
  lastScoredByName: string | null;
  lastScoredAt: string | null;
}

// Calendar-date label without a UTC round-trip — mirrors the same helper in
// client/src/pages/ref/RefHome.tsx (the referee-facing twin of this feed).
function dayLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString("en-NZ", { weekday: "short", day: "numeric", month: "short" });
}

function StatusPill({ status, isLive }: { status: GameFeedItem["status"]; isLive: boolean }) {
  if (status === "final") {
    return (
      <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-400 whitespace-nowrap">
        Final
      </span>
    );
  }
  if (isLive) {
    return (
      <span className="flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-red-500/20 text-red-400 whitespace-nowrap">
        <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" /> LIVE
      </span>
    );
  }
  return (
    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-white/5 text-white/35 whitespace-nowrap">
      Scheduled
    </span>
  );
}

function ScoreLine({ game }: { game: GameFeedItem }) {
  const hasScore = game.homeScore != null && game.awayScore != null;
  const hasPens = game.homePenalties != null && game.awayPenalties != null;
  return (
    <div className="flex items-center gap-3 min-w-0">
      <span className="text-sm font-medium text-white/80 text-right flex-1 truncate">
        {game.homeTeamName || "TBD"}
      </span>
      <div className="flex flex-col items-center shrink-0">
        {hasScore ? (
          <span className="text-base font-bold text-white tabular-nums">
            {game.homeScore}–{game.awayScore}
          </span>
        ) : (
          <span className="text-xs text-white/25 font-medium">vs</span>
        )}
        {hasPens && (
          <span className="text-[9px] font-semibold text-amber-400/80 tabular-nums leading-tight">
            ({game.homePenalties}–{game.awayPenalties} pens)
          </span>
        )}
      </div>
      <span className="text-sm font-medium text-white/80 flex-1 truncate">
        {game.awayTeamName || "TBD"}
      </span>
    </div>
  );
}

function GameRow({ game }: { game: GameFeedItem }) {
  const refNames = game.assignedReferees.map((r) => r.fullName).join(", ");
  return (
    <div
      className="rounded-xl border border-white/[0.05] bg-white/[0.015] p-3.5 space-y-2.5"
      data-testid={`game-feed-row-${game.id}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {game.ageGroup && (
            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400 shrink-0">
              {game.ageGroup}
            </span>
          )}
          <span className="text-[11px] text-white/35 truncate">
            {game.stageDetail || game.stage}
            {game.gameNumber != null ? ` · #${game.gameNumber}` : ""}
          </span>
        </div>
        <StatusPill status={game.status} isLive={game.isLive} />
      </div>

      <ScoreLine game={game} />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-white/35">
        <span className="flex items-center gap-1">
          <Clock className="w-3 h-3" /> {game.startTime || "—"}
        </span>
        <span className="flex items-center gap-1">
          <MapPin className="w-3 h-3" /> {game.field || "—"}
        </span>
        <span className="flex items-center gap-1 min-w-0">
          <Users className="w-3 h-3 shrink-0" />
          <span className={refNames ? "" : "text-white/20"}>{refNames || "Unassigned"}</span>
        </span>
      </div>

      {game.lastScoredByName && (
        <div className="text-[10px] text-white/25">
          Last scored by <span className="text-white/40">{game.lastScoredByName}</span>
          {game.lastScoredAt &&
            ` · ${new Date(game.lastScoredAt).toLocaleTimeString("en-NZ", { hour: "2-digit", minute: "2-digit" })}`}
        </div>
      )}
    </div>
  );
}

export function CicGameFeed() {
  const [filterMode, setFilterMode] = useState<"today" | "all">("today");
  const todayIso = nzTodayIso();

  const { data, isLoading, isFetching, dataUpdatedAt, refetch } = useQuery<{ games: GameFeedItem[] }>({
    queryKey: ["/api/admin/cic/game-feed"],
    queryFn: async () => (await apiRequest("GET", "/api/admin/cic/game-feed")).json(),
    // Tournament day: a second screen showing every game must not go stale —
    // referees are scoring live from their phones the whole time this is open.
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
  });

  const games = data?.games ?? [];
  const visible = filterMode === "today" ? games.filter((g) => g.gameDate === todayIso) : games;

  const grouped = useMemo(() => {
    const map = new Map<string, GameFeedItem[]>();
    for (const g of visible) {
      const key = g.gameDate ?? "unscheduled";
      const arr = map.get(key) ?? [];
      arr.push(g);
      map.set(key, arr);
    }
    const entries = Array.from(map.entries());
    entries.sort(([a], [b]) => a.localeCompare(b));
    for (const [, arr] of entries) {
      arr.sort((x, y) => {
        const tA = x.startTime || "99:99";
        const tB = y.startTime || "99:99";
        if (tA !== tB) return tA.localeCompare(tB);
        return (x.field || "").localeCompare(y.field || "");
      });
    }
    return entries;
  }, [visible]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-xs font-semibold text-green-400" data-testid="text-game-feed-live-indicator">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" /> Live
          </span>
          <span className="text-xs text-white/25">
            {dataUpdatedAt
              ? `Updated ${new Date(dataUpdatedAt).toLocaleTimeString("en-NZ", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`
              : "Loading…"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-lg bg-white/5 p-0.5">
            <button
              onClick={() => setFilterMode("today")}
              className={`text-xs font-medium px-3 py-1.5 rounded-md transition-colors ${
                filterMode === "today" ? "bg-blue-500/20 text-blue-400" : "text-white/40 hover:text-white/60"
              }`}
              data-testid="button-game-feed-today"
            >
              Today
            </button>
            <button
              onClick={() => setFilterMode("all")}
              className={`text-xs font-medium px-3 py-1.5 rounded-md transition-colors ${
                filterMode === "all" ? "bg-blue-500/20 text-blue-400" : "text-white/40 hover:text-white/60"
              }`}
              data-testid="button-game-feed-all"
            >
              All days
            </button>
          </div>
          <button
            onClick={() => refetch()}
            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-white/5 text-white/30 hover:text-white/60"
            title="Refresh now"
            data-testid="button-game-feed-refresh"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-24 rounded-xl bg-white/[0.02] animate-pulse" />
          ))}
        </div>
      ) : games.length === 0 ? (
        <div className="rounded-2xl border border-blue-500/10 bg-white/[0.02] p-5">
          <div className="flex flex-col items-center justify-center py-16 text-white/20">
            <Goal className="w-12 h-12 mb-3" />
            <p className="text-sm">No games yet</p>
            <p className="text-xs mt-1">Games will appear here once a tournament schedule is generated</p>
          </div>
        </div>
      ) : grouped.length === 0 ? (
        <div className="rounded-2xl border border-blue-500/10 bg-white/[0.02] p-5">
          <div className="flex flex-col items-center justify-center py-16 text-white/20">
            <Goal className="w-12 h-12 mb-3" />
            <p className="text-sm">No games today</p>
            <button
              onClick={() => setFilterMode("all")}
              className="text-xs mt-2 text-blue-400 hover:text-blue-300 underline underline-offset-2"
              data-testid="button-game-feed-view-all"
            >
              View all days
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-5">
          {grouped.map(([date, dayGames]) => (
            <div key={date}>
              <div className="flex items-center gap-2 mb-2.5 px-1">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-white/40">
                  {date === "unscheduled" ? "No date set" : dayLabel(date)}
                </h3>
                {date === todayIso && (
                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-green-500/15 text-green-400">TODAY</span>
                )}
                <span className="text-[10px] text-white/20">
                  {dayGames.length} game{dayGames.length !== 1 ? "s" : ""}
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2.5">
                {dayGames.map((g) => (
                  <GameRow key={g.id} game={g} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default CicGameFeed;
