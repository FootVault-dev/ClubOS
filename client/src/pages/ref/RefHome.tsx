// CIC referee scoring app — /ref. Maps to a single route that internally
// decides between two screens: no token (or a rejected token) shows the
// LOGIN screen; a valid, approved referee sees their GAME LIST. Standalone
// mobile-first experience — no admin shell, no sidebar. Brand: CIC near-
// black #141511 / gold #C9A43E, Kanit + Inter (matches cic-skills-landing.tsx
// and the /sign gold gradient bar).
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  BadgeCheck,
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
          onGoSignup={() => navigate("/ref/signup")}
        />
      )}
      {phase === "games" && referee && (
        <GameListScreen
          referee={referee}
          onSignOut={handleSignOut}
          onOpenGame={(id) => navigate(`/ref/game/${id}`)}
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
  const [day, setDay] = useState<string>(nzTodayIso());
  // Upcoming defaults to today with day-by-day nav; Past defaults to "all
  // days" since results can span the whole draw — but the day filter still
  // works if a ref wants one specific day's results.
  const [showAllDays, setShowAllDays] = useState(false);
  const switchTab = (t: FeedTab) => {
    setTab(t);
    setShowAllDays(t === "past");
  };

  // Daniel wants the WHOLE tournament feed visible, not just this referee's
  // assignments — scope=all. The API still tells us which games are theirs
  // via `assigned`, so those get highlighted rather than filtered down to.
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["ref-games", "all"],
    queryFn: () => refGet<{ games: RefGameListItem[] }>(`/api/public/cic-referees/games?scope=all`),
  });

  const games = data?.games ?? [];
  const tabGames = games.filter((g) => (tab === "upcoming" ? g.status !== "final" : g.status === "final"));
  // API sorts ascending by date/time. Upcoming stays soonest-first; Past is
  // flipped so the most recent result shows first.
  const orderedTabGames = tab === "past" ? [...tabGames].reverse() : tabGames;
  const dayGames = showAllDays ? orderedTabGames : orderedTabGames.filter((g) => g.gameDate === day);

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

      <div className="px-5 mt-3 flex items-center justify-between gap-2">
        <button
          onClick={() => setDay(shiftIso(day, -1))}
          disabled={showAllDays}
          className="h-11 w-11 flex items-center justify-center rounded-lg disabled:opacity-30 shrink-0"
          style={{ background: "rgba(255,255,255,0.05)", color: "white" }}
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <button
          onClick={() => setShowAllDays((v) => !v)}
          className="flex-1 h-11 rounded-lg text-sm font-semibold"
          style={
            showAllDays
              ? { background: "rgba(201,164,62,0.15)", color: GOLD, border: "1px solid rgba(201,164,62,0.4)" }
              : { background: "rgba(255,255,255,0.05)", color: "white" }
          }
        >
          {showAllDays ? "All days — tap for today" : dayLabel(day)}
        </button>
        <button
          onClick={() => setDay(shiftIso(day, 1))}
          disabled={showAllDays}
          className="h-11 w-11 flex items-center justify-center rounded-lg disabled:opacity-30 shrink-0"
          style={{ background: "rgba(255,255,255,0.05)", color: "white" }}
        >
          <ChevronRight className="h-5 w-5" />
        </button>
      </div>
      {!showAllDays && day !== nzTodayIso() && (
        <div className="px-5 mt-2 text-center">
          <button onClick={() => setDay(nzTodayIso())} className="text-[11px] font-semibold" style={{ color: GOLD }}>
            Jump to today
          </button>
        </div>
      )}

      <div className="px-5 mt-4 space-y-2.5">
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
            <div className="cic-ref-display text-base font-bold text-white mb-1.5">No games in the draw yet</div>
            <p className="text-sm leading-relaxed max-w-xs mx-auto" style={{ color: "rgba(255,255,255,0.4)" }}>
              Check back once the tournament schedule is published.
            </p>
          </div>
        )}
        {!isLoading && !isError && games.length > 0 && tabGames.length === 0 && (
          <div className="text-center py-14 text-sm" style={{ color: "rgba(255,255,255,0.35)" }}>
            {tab === "upcoming" ? "No upcoming games." : "No results yet."}
          </div>
        )}
        {!isLoading && !isError && tabGames.length > 0 && dayGames.length === 0 && (
          <div className="text-center py-14 text-sm" style={{ color: "rgba(255,255,255,0.35)" }}>
            No {tab === "upcoming" ? "upcoming games" : "results"} on this day.
            {!showAllDays && (
              <>
                {" "}
                <button onClick={() => setShowAllDays(true)} className="underline font-semibold" style={{ color: GOLD }}>
                  View all days
                </button>
              </>
            )}
          </div>
        )}
        {dayGames.map((g) => (
          <GameCard key={g.id} game={g} onClick={() => onOpenGame(g.id)} />
        ))}
      </div>
    </div>
  );
}

function GameCard({ game, onClick }: { game: RefGameListItem; onClick: () => void }) {
  const hasScore = game.homeScore != null && game.awayScore != null;
  const assigned = game.assigned;
  return (
    <div
      className="rounded-2xl p-4"
      style={
        assigned
          ? { background: "rgba(201,164,62,0.07)", border: "1.5px solid rgba(201,164,62,0.5)" }
          : { background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" }
      }
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
          {assigned && (
            <span
              className="text-[9px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1"
              style={{ background: "rgba(201,164,62,0.18)", color: GOLD, border: "1px solid rgba(201,164,62,0.45)" }}
            >
              <BadgeCheck className="h-3 w-3" /> You're reffing
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
