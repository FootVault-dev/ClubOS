// MFL referee scoring app — /mfl-ref (login screen OR game list). Cloned
// from client/src/pages/ref/RefHome.tsx (the CIC referee app) and re-branded
// for Mini Football Leagues: pure black background, gold #d1b96e accents —
// the same palette already used across the live MFL site (mfl-landing-page.tsx).
// Standalone mobile-first experience — no admin shell, no sidebar.
//
// 'Inter Tight' and 'Anton' are both already loaded globally
// (client/index.html / client/src/index.css) — no per-page @import needed,
// unlike the CIC pages which pull in Kanit specially.
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  CalendarClock,
  ChevronDown,
  CreditCard,
  Loader2,
  LogOut,
  MapPin,
  Pencil,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  clearRefToken,
  formatBankAccountInput,
  getRefToken,
  isGameLive,
  refGet,
  refPost,
  setRefToken,
  updateMyDetails,
  RefApiError,
  type MflRefGameListItem,
  type Referee,
} from "./mfl-ref-api";
import { useMflBrand } from "./useMflBrand";

const GOLD = "#d1b96e";
const INK = "#000000";
const CARD_BG = "rgba(255,255,255,0.03)";
const CARD_BORDER = "rgba(255,255,255,0.08)";

const FONT_STYLE = `
  .mfl-ref-display { font-family: 'Anton', 'Inter Tight', 'Inter', sans-serif; }
  .mfl-ref-body { font-family: 'Inter Tight', 'Inter', sans-serif; }
`;

const fieldClass =
  "h-12 text-base rounded-xl bg-white/5 border-white/10 text-white placeholder:text-white/30 focus-visible:ring-[#d1b96e] focus-visible:ring-offset-0";
const textareaClass =
  "min-h-[68px] text-base rounded-xl bg-white/5 border-white/10 text-white placeholder:text-white/30 focus-visible:ring-[#d1b96e] focus-visible:ring-offset-0";

function RefShell({ children }: { children: ReactNode }) {
  return (
    <div className="mfl-ref-body min-h-screen w-full" style={{ background: INK }}>
      <style>{FONT_STYLE}</style>
      <div className="h-1.5 w-full" style={{ background: `linear-gradient(90deg, #8a774a, ${GOLD}, #ecd9a6)` }} />
      {children}
    </div>
  );
}

// ── Date helpers (calendar-date arithmetic, no UTC round-trip) ─────────────
function dayLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString("en-NZ", { weekday: "short", day: "numeric", month: "short" });
}

export default function MflRefHome() {
  useMflBrand();
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
        const res = await refGet<{ referee: Referee }>("/api/public/mfl-referees/me");
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
          onGoSignup={() => navigate("/mfl-ref/signup")}
        />
      )}
      {phase === "games" && referee && (
        <GameListScreen
          referee={referee}
          onSignOut={handleSignOut}
          onOpenGame={(id) => navigate(`/mfl-ref/game/${id}`)}
          onRefereeUpdated={setReferee}
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
        "/api/public/mfl-referees/login",
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
            style={{ background: "rgba(209,185,110,0.12)", border: "1px solid rgba(209,185,110,0.35)" }}
          >
            <ShieldCheck className="h-7 w-7" style={{ color: GOLD }} />
          </div>
          <div className="text-xs uppercase tracking-[0.25em]" style={{ color: "rgba(255,255,255,0.4)" }}>
            Mini Football Leagues
          </div>
          <h1 className="mfl-ref-display text-3xl font-extrabold text-white mt-1">Referee Sign In</h1>
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
  onRefereeUpdated,
}: {
  referee: Referee;
  onSignOut: () => void;
  onOpenGame: (id: number) => void;
  onRefereeUpdated: (r: Referee) => void;
}) {
  const [tab, setTab] = useState<FeedTab>("upcoming");
  const [scope, setScope] = useState<"mine" | "all">("mine");
  const switchTab = (t: FeedTab) => setTab(t);

  // Referees default to ONLY their assigned games (scope=mine). A league
  // night shifts fast — no-shows, pull-outs — so "All Games" (scope=all)
  // lets a ref pick up ANY MFL game as a contingency. Upcoming = not final;
  // Past = final.
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["mfl-ref-games", scope],
    queryFn: () => refGet<{ games: MflRefGameListItem[] }>(`/api/public/mfl-referees/games?scope=${scope}`),
  });

  const games = data?.games ?? [];
  const tabGames = games.filter((g) => (tab === "upcoming" ? g.status !== "final" : g.status === "final"));
  const orderedTabGames = tab === "past" ? [...tabGames].reverse() : tabGames;
  const byDay: { date: string | null; games: MflRefGameListItem[] }[] = [];
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
            Mini Football Leagues
          </div>
          <div className="mfl-ref-display text-xl font-extrabold text-white mt-0.5 truncate">{referee.fullName}</div>
        </div>
        <button
          onClick={onSignOut}
          className="flex items-center gap-1.5 text-xs font-semibold px-3 h-9 rounded-lg shrink-0"
          style={{ color: "rgba(255,255,255,0.6)", background: "rgba(255,255,255,0.05)" }}
        >
          <LogOut className="h-3.5 w-3.5" /> Sign out
        </button>
      </div>

      <div className="px-5 mb-2.5">
        <PaymentDetailsCard referee={referee} onUpdated={onRefereeUpdated} />
      </div>

      {/* Which games — My Games (assigned, default) vs All Games (every MFL
          game, the contingency for last-minute referee changes). */}
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
            Every MFL game — pick up any match if a ref can't make it. Your assigned games are marked{" "}
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
              style={{ background: "rgba(209,185,110,0.1)", border: "1px solid rgba(209,185,110,0.3)" }}
            >
              <CalendarClock className="h-6 w-6" style={{ color: GOLD }} />
            </div>
            <div className="mfl-ref-display text-base font-bold text-white mb-1.5">
              {scope === "mine" ? "No games assigned to you yet" : "No games scheduled yet"}
            </div>
            <p className="text-sm leading-relaxed max-w-xs mx-auto" style={{ color: "rgba(255,255,255,0.4)" }}>
              {scope === "mine"
                ? "Your MFL coordinator will assign your league nights — or tap All Games to pick one up."
                : "Games will appear here once the term's fixtures are loaded."}
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
  game: MflRefGameListItem;
  onClick: () => void;
  showAssignedBadge?: boolean;
}) {
  const hasScore = game.homeScore != null && game.awayScore != null;
  const assigned = game.assigned;
  const live = isGameLive(game);
  return (
    <div
      className="rounded-2xl p-4"
      style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}
    >
      <div className="flex items-center justify-between mb-2 gap-2">
        <div
          className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide truncate"
          style={{ color: "rgba(255,255,255,0.4)" }}
        >
          <span>{game.competitionName}</span>
          {game.divisionName && (
            <>
              <span>·</span>
              <span className="truncate">{game.divisionName}</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {showAssignedBadge && assigned && (
            <span
              className="text-[9px] font-bold px-2 py-0.5 rounded-full"
              style={{ background: "rgba(209,185,110,0.15)", color: GOLD, border: "1px solid rgba(209,185,110,0.4)" }}
            >
              YOURS
            </span>
          )}
          {live && (
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
          <div className={`mfl-ref-display text-base font-bold truncate ${assigned ? "text-white" : "text-white/80"}`}>
            {game.homeTeamName ?? "TBD"}
          </div>
          <div className={`mfl-ref-display text-base font-bold truncate ${assigned ? "text-white" : "text-white/80"}`}>
            {game.awayTeamName ?? "TBD"}
          </div>
        </div>
        <div className="text-right shrink-0">
          {hasScore ? (
            <div
              className="mfl-ref-display text-2xl font-extrabold tabular-nums leading-tight"
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
        {game.location && (
          <span className="inline-flex items-center gap-1">
            <MapPin className="h-3 w-3" /> {game.location}
          </span>
        )}
        {game.startTime && (
          <span className="inline-flex items-center gap-1">
            {game.startTime}
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

// ── Payment details ─────────────────────────────────────────────────────
// Collapsible card — what the MFL coordinator needs for the fortnightly
// per-ref invoice (server/league-referee-routes.ts). Compact: collapsed by
// default, view mode shows the five values, edit mode is the same fields as
// signup, saved via PATCH /api/public/mfl-referees/me.
function PaymentDetailsCard({
  referee,
  onUpdated,
}: {
  referee: Referee;
  onUpdated: (r: Referee) => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [bankAccountName, setBankAccountName] = useState(referee.bankAccountName ?? "");
  const [bankName, setBankName] = useState(referee.bankName ?? "");
  const [bankAccountNumber, setBankAccountNumber] = useState(referee.bankAccountNumber ?? "");
  const [address, setAddress] = useState(referee.address ?? "");
  const [gstNumber, setGstNumber] = useState(referee.gstNumber ?? "");

  const bankDigits = bankAccountNumber.replace(/\D/g, "");
  const bankAccountNumberValid = bankDigits.length === 15 || bankDigits.length === 16;
  const gstNumberValid = !gstNumber.trim() || /^[\d-]+$/.test(gstNumber.trim());
  const valid = Boolean(
    bankAccountName.trim() && bankName.trim() && bankAccountNumberValid && address.trim() && gstNumberValid,
  );

  const hasDetails = !!(referee.bankAccountName || referee.bankAccountNumber || referee.bankName || referee.address);

  const startEdit = () => {
    setBankAccountName(referee.bankAccountName ?? "");
    setBankName(referee.bankName ?? "");
    setBankAccountNumber(referee.bankAccountNumber ?? "");
    setAddress(referee.address ?? "");
    setGstNumber(referee.gstNumber ?? "");
    setError(null);
    setSaved(false);
    setEditing(true);
    setOpen(true);
  };

  const save = async () => {
    if (!valid) return;
    setSaving(true);
    setError(null);
    try {
      const res = await updateMyDetails({
        bankAccountName: bankAccountName.trim(),
        bankName: bankName.trim(),
        bankAccountNumber,
        address: address.trim(),
        gstNumber: gstNumber.trim() || undefined,
      });
      onUpdated(res.referee);
      setEditing(false);
      setSaved(true);
    } catch (e: any) {
      setError(e instanceof RefApiError ? e.message : "Couldn't save your details.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-2xl" style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3"
      >
        <div className="flex items-center gap-2 min-w-0">
          <CreditCard className="h-4 w-4 shrink-0" style={{ color: GOLD }} />
          <span className="text-[13px] font-bold text-white">Payment details</span>
          {!hasDetails && (
            <span
              className="text-[9px] font-bold px-2 py-0.5 rounded-full shrink-0"
              style={{ background: "rgba(239,68,68,0.15)", color: "#f87171", border: "1px solid rgba(239,68,68,0.4)" }}
            >
              MISSING
            </span>
          )}
        </div>
        <ChevronDown
          className={`h-4 w-4 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
          style={{ color: "rgba(255,255,255,0.4)" }}
        />
      </button>

      {open && (
        <div className="px-4 pb-4">
          {!editing ? (
            <>
              {hasDetails ? (
                <div className="space-y-1.5 text-[13px]" style={{ color: "rgba(255,255,255,0.75)" }}>
                  <PaymentRow label="Name on account" value={referee.bankAccountName} />
                  <PaymentRow label="Bank" value={referee.bankName} />
                  <PaymentRow label="Account number" value={referee.bankAccountNumber} />
                  <PaymentRow label="Address" value={referee.address} />
                  <PaymentRow label="GST number" value={referee.gstNumber} />
                </div>
              ) : (
                <p className="text-[13px] leading-relaxed" style={{ color: "rgba(255,255,255,0.4)" }}>
                  No payment details on file yet — add them so we can pay your match fees.
                </p>
              )}
              {saved && (
                <p className="mt-2 text-[12px] font-semibold" style={{ color: "#4ade80" }}>
                  Saved.
                </p>
              )}
              <button
                onClick={startEdit}
                className="mt-3 inline-flex items-center gap-1.5 text-[12px] font-bold px-3 h-8 rounded-lg"
                style={{ color: GOLD, background: "rgba(209,185,110,0.1)", border: "1px solid rgba(209,185,110,0.3)" }}
              >
                <Pencil className="h-3 w-3" /> {hasDetails ? "Edit" : "Add details"}
              </button>
            </>
          ) : (
            <div className="space-y-2.5">
              {error && (
                <div
                  className="rounded-lg border px-3 py-2 text-[12px]"
                  style={{ borderColor: "rgba(239,68,68,0.4)", background: "rgba(239,68,68,0.08)", color: "#fca5a5" }}
                >
                  {error}
                </div>
              )}
              <MiniField label="Name on bank account">
                <Input
                  value={bankAccountName}
                  onChange={(e) => setBankAccountName(e.target.value)}
                  className={fieldClass}
                />
              </MiniField>
              <MiniField label="Bank">
                <Input
                  value={bankName}
                  onChange={(e) => setBankName(e.target.value)}
                  className={fieldClass}
                  placeholder="e.g. ANZ, ASB, BNZ, Kiwibank"
                />
              </MiniField>
              <MiniField label="Bank account number">
                <Input
                  inputMode="numeric"
                  autoComplete="off"
                  value={bankAccountNumber}
                  onChange={(e) => setBankAccountNumber(formatBankAccountInput(e.target.value))}
                  className={fieldClass}
                  placeholder="00-0000-0000000-000"
                />
              </MiniField>
              <MiniField label="Home address">
                <Textarea value={address} onChange={(e) => setAddress(e.target.value)} className={textareaClass} />
              </MiniField>
              <MiniField label="GST number (optional)">
                <Input
                  value={gstNumber}
                  onChange={(e) => setGstNumber(e.target.value)}
                  className={fieldClass}
                  placeholder="123-456-789"
                />
              </MiniField>
              <div className="flex gap-2 pt-1">
                <button
                  onClick={() => {
                    setEditing(false);
                    setError(null);
                  }}
                  className="flex-1 h-10 rounded-lg text-[13px] font-semibold"
                  style={{ background: "rgba(255,255,255,0.05)", color: "rgba(255,255,255,0.6)" }}
                >
                  Cancel
                </button>
                <button
                  onClick={save}
                  disabled={saving || !valid}
                  className="flex-1 h-10 rounded-lg text-[13px] font-bold disabled:opacity-50"
                  style={{ background: GOLD, color: INK }}
                >
                  {saving ? <Loader2 className="h-4 w-4 animate-spin mx-auto" /> : "Save"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PaymentRow({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="shrink-0 w-32 text-[11px] uppercase tracking-wide" style={{ color: "rgba(255,255,255,0.35)" }}>
        {label}
      </span>
      <span className="truncate">{value || "—"}</span>
    </div>
  );
}

function MiniField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <label
        className="block text-[10px] font-semibold uppercase tracking-wide mb-1"
        style={{ color: "rgba(255,255,255,0.4)" }}
      >
        {label}
      </label>
      {children}
    </div>
  );
}
