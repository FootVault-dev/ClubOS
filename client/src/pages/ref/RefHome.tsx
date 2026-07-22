// CIC referee scoring app — /login (old /ref redirects here). Maps to a single route that internally
// decides between two screens: no token (or a rejected token) shows the
// LOGIN screen; a valid, approved referee sees their GAME LIST. Standalone
// mobile-first experience — no admin shell, no sidebar. Brand: CIC near-
// black #141511 / gold #C9A43E, Kanit + Inter (matches cic-skills-landing.tsx
// and the /sign gold gradient bar).
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Clock,
  Loader2,
  LogOut,
  MapPin,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  clearRefToken,
  getRefToken,
  refGet,
  refPost,
  setRefToken,
  RefApiError,
  type Referee,
  type RefGameListItem,
} from "./ref-api";
import { useCicBrand } from "./useCicBrand";
import { nzTodayIso } from "@shared/academy";

const GOLD = "#C9A43E";
const INK = "#141511";

const FONT_STYLE = `
  @import url('https://fonts.googleapis.com/css2?family=Kanit:wght@600;700;800;900&family=Inter:wght@400;500;600;700;800&display=swap');
  .cic-ref-display { font-family: 'Kanit', 'Inter', sans-serif; }
  .cic-ref-body { font-family: 'Inter', sans-serif; }
`;

const fieldClass =
  "h-12 text-base rounded-xl bg-white/5 border-white/10 text-white placeholder:text-white/30 focus-visible:ring-[#C9A43E] focus-visible:ring-offset-0";

function RefShell({ children }: { children: ReactNode }) {
  return (
    <div className="cic-ref-body min-h-screen w-full" style={{ background: INK }}>
      <style>{FONT_STYLE}</style>
      <div className="h-1.5 w-full" style={{ background: `linear-gradient(90deg, #8a6a1f, ${GOLD}, #e9d38a)` }} />
      {children}
    </div>
  );
}

// ── Date helpers (calendar-date arithmetic, no UTC round-trip) ─────────────
function shiftIso(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y || 2026, (m || 1) - 1, d || 1);
  dt.setDate(dt.getDate() + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}
function dayLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString("en-NZ", { weekday: "short", day: "numeric", month: "short" });
}

export default function RefHome() {
  useCicBrand();
  const [, navigate] = useLocation();
  const [phase, setPhase] = useState<"checking" | "login" | "games">(() => (getRefToken() ? "checking" : "login"));
  const [authError, setAuthError] = useState<string | null>(null);
  const [referee, setReferee] = useState<Referee | null>(null);

  useEffect(() => {
    let active = true;
    if (!getRefToken()) {
      setPhase("login");
      return;
    }
    (async () => {
      try {
        const res = await refGet<{ referee: Referee }>("/api/public/cic-referees/me");
        if (!active) return;
        setReferee(res.referee);
        setPhase("games");
      } catch (e: any) {
        if (!active) return;
        clearRefToken();
        setAuthError(e instanceof RefApiError && (e.status === 401 || e.status === 403) ? e.message : null);
        setPhase("login");
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const handleLoggedIn = (ref: Referee) => {
    setReferee(ref);
    setAuthError(null);
    setPhase("games");
  };
  const handleSignOut = () => {
    clearRefToken();
    setReferee(null);
    setPhase("login");
  };

  return (
    <RefShell>
      {phase === "checking" && (
        <div className="min-h-screen flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin" style={{ color: GOLD }} />
        </div>
      )}
      {phase === "login" && (
        <LoginScreen
          initialError={authError}
          onLoggedIn={handleLoggedIn}
          onGoSignup={() => navigate("/signup")}
        />
      )}
      {phase === "games" && referee && (
        <GameListScreen
          referee={referee}
          onSignOut={handleSignOut}
          onOpenGame={(id) => navigate(`/game/${id}`)}
        />
      )}
    </RefShell>
  );
}

// ── Login ────────────────────────────────────────────────────────────────
function LoginScreen({
  initialError,
  onLoggedIn,
  onGoSignup,
}: {
  initialError?: string | null;
  onLoggedIn: (r: Referee) => void;
  onGoSignup: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await refPost<{ token: string; expiresAt: number; referee: Referee }>(
        "/api/public/cic-referees/login",
        { email: email.trim(), password },
      );
      setRefToken(res.token);
      onLoggedIn(res.referee);
    } catch (e: any) {
      if (e instanceof RefApiError && e.status === 401) setError("Invalid email or password.");
      else setError(e instanceof RefApiError ? e.message : "Something went wrong signing in.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-5 py-10">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div
            className="mx-auto mb-3 h-14 w-14 rounded-2xl flex items-center justify-center"
            style={{ background: "rgba(201,164,62,0.12)", border: "1px solid rgba(201,164,62,0.35)" }}
          >
            <ShieldCheck className="h-7 w-7" style={{ color: GOLD }} />
          </div>
          <div className="text-xs uppercase tracking-[0.25em]" style={{ color: "rgba(255,255,255,0.4)" }}>
            Christchurch International Cup
          </div>
          <h1 className="cic-ref-display text-3xl font-extrabold text-white mt-1">Referee Sign In</h1>
        </div>

        {error && (
          <div
            className="mb-4 rounded-xl border px-4 py-3 text-sm"
            style={{ borderColor: "rgba(239,68,68,0.4)", background: "rgba(239,68,68,0.08)", color: "#fca5a5" }}
          >
            {error}
          </div>
        )}

        <form onSubmit={submit} className="space-y-3">
          <div>
            <label
              className="block text-xs font-semibold uppercase tracking-wide mb-1.5"
              style={{ color: "rgba(255,255,255,0.5)" }}
            >
              Email
            </label>
            <Input
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={fieldClass}
              placeholder="you@example.com"
            />
          </div>
          <div>
            <label
              className="block text-xs font-semibold uppercase tracking-wide mb-1.5"
              style={{ color: "rgba(255,255,255,0.5)" }}
            >
              Password
            </label>
            <Input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={fieldClass}
              placeholder="••••••••"
            />
          </div>
          <Button
            type="submit"
            disabled={loading || !email || !password}
            className="w-full h-12 rounded-xl text-base font-bold border-none"
            style={{ background: GOLD, color: INK }}
          >
            {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : "Sign in"}
          </Button>
        </form>

        <div className="mt-6 text-center">
          <button onClick={onGoSignup} className="text-sm font-medium" style={{ color: GOLD }}>
            New referee? Create an account
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Game list ────────────────────────────────────────────────────────────
type FeedTab = "upcoming" | "past";

function GameListScreen({
  referee,
  onSignOut,
  onOpenGame,
}: {
  referee: Referee;
  onSignOut: () => void;
  onOpenGame: (id: number) => void;
}) {
  const [tab, setTab] = useState<FeedTab>("upcoming");
  const [scope, setScope] = useState<"mine" | "all">("mine");
  const switchTab = (t: FeedTab) => setTab(t);

  // Referees default to ONLY their assigned games (scope=mine) in one continuous
  // feed (no day-by-day paging). But a live tournament shifts fast — no-shows,
  // injuries, pull-outs — so "All Games" (scope=all) lets a ref pick up ANY CIC
  // game as a contingency; any approved ref may score any CIC game (the server's
  // loadCicGame gates on CIC-org, not on assignment), and assignments can be
  // recorded during/after a game for post-tournament referee-payment tracking.
  // Upcoming = not final; Past = final.
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["ref-games", scope],
    queryFn: () => refGet<{ games: RefGameListItem[] }>(`/api/public/cic-referees/games?scope=${scope}`),
  });

  const games = data?.games ?? [];
  const tabGames = games.filter((g) => (tab === "upcoming" ? g.status !== "final" : g.status === "final"));
  // Soonest-first for upcoming; most-recent-first for past. No day filter.
  const orderedTabGames = tab === "past" ? [...tabGames].reverse() : tabGames;
  // Group by day so the single feed still has date headers (all visible at once).
  const byDay: { date: string | null; games: RefGameListItem[] }[] = [];
  for (const g of orderedTabGames) {
    const last = byDay[byDay.length - 1];
    if (last && last.date === g.gameDate) last.games.push(g);
    else byDay.push({ date: g.gameDate, games: [g] });
  }

  return (
    <div className="min-h-screen pb-10">
      <div className="px-5 pt-6 pb-4 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-[0.2em] truncate" style={{ color: "rgba(255,255,255,0.4)" }}>
            Christchurch International Cup
          </div>
          <div className="cic-ref-display text-xl font-extrabold text-white mt-0.5 truncate">{referee.fullName}</div>
        </div>
        <button
          onClick={onSignOut}
          className="flex items-center gap-1.5 text-xs font-semibold px-3 h-9 rounded-lg shrink-0"
          style={{ color: "rgba(255,255,255,0.6)", background: "rgba(255,255,255,0.05)" }}
        >
          <LogOut className="h-3.5 w-3.5" /> Sign out
        </button>
      </div>

      {/* Which games — My Games (assigned, default) vs All Games (every CIC game,
          the contingency for last-minute referee changes). */}
      <div className="px-5 mb-2.5">
        <div
          className="flex rounded-xl p-1 gap-1"
          style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)" }}
        >
          {([
            { key: "mine", label: "My Games" },
            { key: "all", label: "All Games" },
          ] as const).map((opt) => (
            <button
              key={opt.key}
              onClick={() => setScope(opt.key)}
              className="flex-1 h-9 rounded-lg text-[13px] font-bold transition"
              style={
                scope === opt.key
                  ? { background: GOLD, color: INK }
                  : { background: "transparent", color: "rgba(255,255,255,0.55)" }
              }
            >
              {opt.label}
            </button>
          ))}
        </div>
        {scope === "all" && (
          <p className="text-[11px] mt-1.5 px-1 leading-snug" style={{ color: "rgba(255,255,255,0.4)" }}>
            Every CIC game — pick up any match if a ref can't make it. Your assigned games are marked{" "}
            <span className="font-bold" style={{ color: GOLD }}>YOURS</span>.
          </p>
        )}
      </div>

      <div className="px-5 grid grid-cols-2 gap-2">
        <button
          onClick={() => switchTab("upcoming")}
          className="h-11 rounded-xl text-sm font-bold"
          style={
            tab === "upcoming"
              ? { background: GOLD, color: INK }
              : { background: "rgba(255,255,255,0.05)", color: "rgba(255,255,255,0.6)", border: "1px solid rgba(255,255,255,0.1)" }
          }
        >
          Upcoming
        </button>
        <button
          onClick={() => switchTab("past")}
          className="h-11 rounded-xl text-sm font-bold"
          style={
            tab === "past"
              ? { background: GOLD, color: INK }
              : { background: "rgba(255,255,255,0.05)", color: "rgba(255,255,255,0.6)", border: "1px solid rgba(255,255,255,0.1)" }
          }
        >
          Past
        </button>
      </div>

      <div className="px-5 mt-4 space-y-3">
        {isLoading && (
          <div className="flex justify-center py-14">
            <Loader2 className="h-6 w-6 animate-spin" style={{ color: GOLD }} />
          </div>
        )}
        {isError && (
          <div
            className="rounded-xl border px-4 py-3 text-sm"
            style={{ borderColor: "rgba(239,68,68,0.4)", background: "rgba(239,68,68,0.08)", color: "#fca5a5" }}
          >
            {(error as any)?.message || "Couldn't load games."}{" "}
            <button onClick={() => refetch()} className="underline font-semibold">
              Retry
            </button>
          </div>
        )}
        {!isLoading && !isError && games.length === 0 && (
          <div className="text-center py-16 px-4">
            <div
              className="mx-auto mb-4 h-14 w-14 rounded-2xl flex items-center justify-center"
              style={{ background: "rgba(201,164,62,0.1)", border: "1px solid rgba(201,164,62,0.3)" }}
            >
              <CalendarClock className="h-6 w-6" style={{ color: GOLD }} />
            </div>
            <div className="cic-ref-display text-base font-bold text-white mb-1.5">
              {scope === "mine" ? "No games assigned to you yet" : "No games scheduled yet"}
            </div>
            <p className="text-sm leading-relaxed max-w-xs mx-auto" style={{ color: "rgba(255,255,255,0.4)" }}>
              {scope === "mine"
                ? "Your referee coordinator will assign your matches — or tap All Games to pick one up."
                : "Games will appear here once the tournament schedule is loaded."}
            </p>
          </div>
        )}
        {!isLoading && !isError && games.length > 0 && tabGames.length === 0 && (
          <div className="text-center py-14 text-sm" style={{ color: "rgba(255,255,255,0.35)" }}>
            {tab === "upcoming" ? "No upcoming games." : "No results yet."}
          </div>
        )}
        {!isLoading && !isError && byDay.map((grp) => (
          <div key={grp.date ?? "nodate"} className="space-y-2.5">
            <div className="text-[11px] uppercase tracking-[0.15em] font-semibold pt-1" style={{ color: "rgba(255,255,255,0.35)" }}>
              {grp.date ? dayLabel(grp.date) : "Date TBC"}
            </div>
            {grp.games.map((g) => (
              <GameCard key={g.id} game={g} showAssignedBadge={scope === "all"} onClick={() => onOpenGame(g.id)} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function GameCard({
  game,
  onClick,
  showAssignedBadge,
}: {
  game: RefGameListItem;
  onClick: () => void;
  showAssignedBadge?: boolean;
}) {
  const hasScore = game.homeScore != null && game.awayScore != null;
  const assigned = game.assigned;
  return (
    <div
      className="rounded-2xl p-4"
      style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" }}
    >
      <div className="flex items-center justify-between mb-2 gap-2">
        <div
          className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide truncate"
          style={{ color: "rgba(255,255,255,0.4)" }}
        >
          {game.ageGroup && <span>{game.ageGroup}</span>}
          {game.ageGroup && game.stageDetail && <span>·</span>}
          {game.stageDetail && <span className="truncate">{game.stageDetail}</span>}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {showAssignedBadge && assigned && (
            <span
              className="text-[9px] font-bold px-2 py-0.5 rounded-full"
              style={{ background: "rgba(201,164,62,0.15)", color: GOLD, border: "1px solid rgba(201,164,62,0.4)" }}
            >
              YOURS
            </span>
          )}
          {game.isLive && (
            <span
              className="text-[9px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1"
              style={{ background: "rgba(239,68,68,0.15)", color: "#f87171", border: "1px solid rgba(239,68,68,0.4)" }}
            >
              <span className="h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" /> LIVE
            </span>
          )}
          {game.status === "final" && (
            <span
              className="text-[9px] font-bold px-2 py-0.5 rounded-full"
              style={{ background: "rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.6)" }}
            >
              FINAL
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center justify-between gap-3">
        <div className="flex-1 min-w-0 space-y-0.5">
          <div className={`cic-ref-display text-base font-bold truncate ${assigned ? "text-white" : "text-white/80"}`}>
            {game.homeTeamName ?? "TBD"}
          </div>
          <div className={`cic-ref-display text-base font-bold truncate ${assigned ? "text-white" : "text-white/80"}`}>
            {game.awayTeamName ?? "TBD"}
          </div>
        </div>
        <div className="text-right shrink-0">
          {hasScore ? (
            <div
              className="cic-ref-display text-2xl font-extrabold tabular-nums leading-tight"
              style={{ color: GOLD }}
            >
              <div>{game.homeScore}</div>
              <div>{game.awayScore}</div>
            </div>
          ) : (
            <div className="text-lg font-semibold" style={{ color: "rgba(255,255,255,0.25)" }}>
              vs
            </div>
          )}
        </div>
      </div>
      <div className="mt-2.5 flex items-center gap-3 text-xs" style={{ color: "rgba(255,255,255,0.4)" }}>
        {game.field && (
          <span className="inline-flex items-center gap-1">
            <MapPin className="h-3 w-3" /> {game.field}
          </span>
        )}
        {game.startTime && (
          <span className="inline-flex items-center gap-1">
            <Clock className="h-3 w-3" /> {game.startTime}
          </span>
        )}
      </div>
      <button
        onClick={onClick}
        className="mt-3 w-full h-12 rounded-xl text-sm font-bold active:scale-[0.98] transition"
        style={{ background: GOLD, color: INK }}
      >
        Score Game
      </button>
    </div>
  );
}
