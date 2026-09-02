// CIC office "Score Game" screen — /admin/cic-score/:id.
//
// Session-authed twin of the referee scoring screen
// (client/src/pages/ref/RefGameDetail.tsx), reached from the Game Feed
// (client/src/components/cic-game-feed.tsx) so Isaac/Rolof can run the same
// live match timer + score/goals/cards/MVP/Golden-Glove/shootout flows from
// the office exactly like a referee does from the sideline — including the
// own-goal team-flip rule. The layout, MatchTimer component and hardcoded
// CIC gold-on-black look are all reused so it feels identical.
//
// The one real difference: every write here goes through the ADMIN session
// (apiRequest — cookie + X-Workspace-Slug, client/src/lib/queryClient.ts),
// never the referee Bearer-token helpers in ./ref/ref-api.ts. Types are
// imported `type`-only from ref-api (erased at compile time — no runtime
// coupling to the referee token logic) since the admin detail endpoint
// returns the same underlying DB shapes.
import { useMemo, useState, type ReactNode } from "react";
import { useLocation, useRoute } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Award,
  Check,
  Loader2,
  Minus,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import MatchTimer from "@/components/match-timer";
import { ForceDarkSurface } from "@/lib/theme-provider";
import type {
  RefCard,
  RefGameFull,
  RefGkRating,
  RefGoal,
  RefMvpVote,
  RefPlayer,
  RefShootoutKick,
  RefTeam,
  RefTimerAction,
} from "@/pages/ref/ref-api";

const GOLD = "#C9A43E";
const INK = "#141511";

const FONT_STYLE = `
  @import url('https://fonts.googleapis.com/css2?family=Kanit:wght@600;700;800;900&family=Inter:wght@400;500;600;700;800&display=swap');
  .cic-score-display { font-family: 'Kanit', 'Inter', sans-serif; }
  .cic-score-body { font-family: 'Inter', sans-serif; }
`;

const rowStyle: React.CSSProperties = { background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" };

interface ScoreGameDetailResponse {
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

const scoreGameQueryKey = (id: number) => ["/api/admin/cic/games", id, "detail"] as const;

// ═══════════════════════════ Page ══════════════════════════════════════════
export default function CicScoreGame() {
  const [, params] = useRoute("/admin/cic-score/:id");
  const [, navigate] = useLocation();
  const id = params?.id ? parseInt(params.id, 10) : NaN;

  const { data, isLoading, isError, error, isFetching } = useQuery({
    queryKey: Number.isFinite(id) ? scoreGameQueryKey(id) : ["cic-score-game", "invalid"],
    queryFn: async () => (await apiRequest("GET", `/api/admin/cic/games/${id}/detail`)).json() as Promise<ScoreGameDetailResponse>,
    enabled: Number.isFinite(id),
  });

  const goBack = () => navigate("/admin/tournaments");

  if (!Number.isFinite(id)) return <StatusScreen message="Invalid game." onBack={goBack} />;
  if (isLoading) return <StatusScreen loading />;
  if (isError || !data) return <StatusScreen message={(error as any)?.message || "Couldn't load this game."} onBack={goBack} />;

  const { game, teams, goals, cards, mvpVotes, gkRatings, shootout, players, halfLengthMinutes, breakMinutes } = data;
  const homeTeam = teams.find((t) => t.id === game.homeTeamId);
  const awayTeam = teams.find((t) => t.id === game.awayTeamId);
  const homeName = homeTeam?.name || game.homeTeamPlaceholder || "Home";
  const awayName = awayTeam?.name || game.awayTeamPlaceholder || "Away";
  const homePlayers = players.filter((p) => p.teamId === game.homeTeamId);
  const awayPlayers = players.filter((p) => p.teamId === game.awayTeamId);
  const bothTeamsSet = !!(game.homeTeamId && game.awayTeamId);

  return (
    <div className="cic-score-body min-h-screen w-full pb-16" style={{ background: INK }}>
      {/* A complete gold-on-black pitchside tool that happens to live under
          /admin. It opts out of the light mapping: without this its
          `text-white/70` CLASSES flip to dark ink while its inline white stays
          white, and the mixed result is the unreadable state. */}
      <ForceDarkSurface />
      <style>{FONT_STYLE}</style>
      <TopBar game={game} homeName={homeName} awayName={awayName} onBack={goBack} />
      <div className="px-4 pt-4 space-y-4">
        <TimerSection game={game} halfLengthMinutes={halfLengthMinutes} breakMinutes={breakMinutes} gameId={id} />
        <ScoreCard game={game} homeName={homeName} awayName={awayName} gameId={id} gameFetching={isFetching} />
        <GoalsCard
          game={game}
          goals={goals}
          homeName={homeName}
          awayName={awayName}
          homePlayers={homePlayers}
          awayPlayers={awayPlayers}
          gameId={id}
        />
        <CardsCard
          game={game}
          cards={cards}
          homeName={homeName}
          awayName={awayName}
          homePlayers={homePlayers}
          awayPlayers={awayPlayers}
          gameId={id}
        />
        {bothTeamsSet && (
          <>
            <MvpCard
              game={game}
              mvpVotes={mvpVotes}
              homeName={homeName}
              awayName={awayName}
              homePlayers={homePlayers}
              awayPlayers={awayPlayers}
              gameId={id}
            />
            <GkCard
              game={game}
              gkRatings={gkRatings}
              homeName={homeName}
              awayName={awayName}
              homePlayers={homePlayers}
              awayPlayers={awayPlayers}
              gameId={id}
            />
            {game.stage !== "group" && (
              <ShootoutCard game={game} shootout={shootout} homeName={homeName} awayName={awayName} gameId={id} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function StatusScreen({ loading, message, onBack }: { loading?: boolean; message?: string; onBack?: () => void }) {
  return (
    <div className="cic-score-body min-h-screen w-full flex flex-col items-center justify-center px-6 text-center" style={{ background: INK }}>
      <style>{FONT_STYLE}</style>
      {loading ? (
        <Loader2 className="h-8 w-8 animate-spin" style={{ color: GOLD }} />
      ) : (
        <>
          <p className="text-sm mb-4" style={{ color: "rgba(255,255,255,0.6)" }}>{message}</p>
          {onBack && (
            <button onClick={onBack} className="text-sm font-semibold" style={{ color: GOLD }}>
              ← Back to Game Feed
            </button>
          )}
        </>
      )}
    </div>
  );
}

// ── Live match timer ("Score Game") — owns starting/pausing/finishing the
// game; ScoreCard below keeps only the score steppers. ─────────────────────
function TimerSection({
  game,
  halfLengthMinutes,
  breakMinutes,
  gameId,
}: {
  game: RefGameFull;
  halfLengthMinutes: number;
  breakMinutes: number;
  gameId: number;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const key = scoreGameQueryKey(gameId);

  const timerMut = useMutation({
    mutationFn: (action: RefTimerAction) => apiRequest("POST", `/api/admin/cic/games/${gameId}/timer`, { action }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
    onError: (e: any) => toast({ title: "Couldn't update the timer", description: e.message, variant: "destructive" }),
  });

  return (
    <MatchTimer
      game={game}
      halfLengthMinutes={halfLengthMinutes}
      breakMinutes={breakMinutes}
      onAction={(action) => timerMut.mutate(action)}
    />
  );
}

function TopBar({
  game,
  homeName,
  awayName,
  onBack,
}: {
  game: RefGameFull;
  homeName: string;
  awayName: string;
  onBack: () => void;
}) {
  return (
    <div className="sticky top-0 z-20" style={{ background: INK, borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
      <div className="h-1 w-full" style={{ background: `linear-gradient(90deg, #8a6a1f, ${GOLD}, #e9d38a)` }} />
      <div className="flex items-center gap-3 px-3 py-2.5">
        <button
          onClick={onBack}
          className="h-10 w-10 shrink-0 flex items-center justify-center rounded-lg"
          style={{ background: "rgba(255,255,255,0.05)" }}
        >
          <ArrowLeft className="h-5 w-5 text-white" />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide" style={{ color: "rgba(255,255,255,0.4)" }}>
            {game.status === "final" ? (
              <span style={{ color: "rgba(255,255,255,0.5)" }}>Final</span>
            ) : game.isLive ? (
              <span className="flex items-center gap-1" style={{ color: "#f87171" }}>
                <span className="h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" /> Live
              </span>
            ) : (
              <span>Scheduled</span>
            )}
            {game.field && (
              <>
                <span>·</span>
                <span className="truncate">{game.field}</span>
              </>
            )}
          </div>
          <div className="flex items-center gap-2 text-sm font-bold text-white">
            <span className="truncate min-w-0">{homeName}</span>
            <span className="cic-score-display tabular-nums shrink-0" style={{ color: GOLD }}>
              {game.homeScore ?? "–"}–{game.awayScore ?? "–"}
            </span>
            <span className="truncate min-w-0">{awayName}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Shared small building blocks ────────────────────────────────────────────
function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-2xl p-4" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" }}>
      <div className="flex items-center justify-between mb-3 gap-2">
        <div className="text-xs font-bold uppercase tracking-wide" style={{ color: "rgba(255,255,255,0.5)" }}>{title}</div>
        {right}
      </div>
      {children}
    </section>
  );
}

function Tag({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded shrink-0" style={{ background: `${color}22`, color }}>
      {children}
    </span>
  );
}

function TeamToggle({
  side,
  onChange,
  homeName,
  awayName,
}: {
  side: "home" | "away" | null;
  onChange: (s: "home" | "away") => void;
  homeName: string;
  awayName: string;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {(["home", "away"] as const).map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => onChange(s)}
          className="h-11 rounded-xl text-sm font-bold truncate px-2"
          style={
            side === s
              ? { background: GOLD, color: INK }
              : { background: "rgba(255,255,255,0.05)", color: "rgba(255,255,255,0.7)", border: "1px solid rgba(255,255,255,0.1)" }
          }
        >
          {s === "home" ? homeName : awayName}
        </button>
      ))}
    </div>
  );
}

function ToggleChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="h-10 rounded-lg text-xs font-bold px-1"
      style={
        active
          ? { background: GOLD, color: INK }
          : { background: "rgba(255,255,255,0.05)", color: "rgba(255,255,255,0.6)", border: "1px solid rgba(255,255,255,0.1)" }
      }
    >
      {label}
    </button>
  );
}

function PlayerPicker({
  players,
  pickedId,
  onPick,
  typed,
  onType,
  placeholder,
}: {
  players: RefPlayer[];
  pickedId: string;
  onPick: (id: string) => void;
  typed: string;
  onType: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div className="space-y-2">
      {players.length > 0 && (
        <select
          value={pickedId}
          onChange={(e) => onPick(e.target.value)}
          className="w-full h-11 rounded-xl px-3 text-sm text-white"
          style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)" }}
        >
          <option value="" style={{ color: INK }}>Pick {placeholder}…</option>
          {players.map((p) => (
            <option key={p.id} value={p.id} style={{ color: INK }}>
              #{p.shirtNumber ?? "—"} {p.firstName} {p.lastName}
            </option>
          ))}
        </select>
      )}
      <Input
        value={typed}
        onChange={(e) => onType(e.target.value)}
        placeholder={players.length > 0 ? `…or type a ${placeholder}'s name` : `Type the ${placeholder}'s name`}
        className="h-11 text-sm rounded-xl bg-white/5 border-white/10 text-white placeholder:text-white/30 focus-visible:ring-[#C9A43E] focus-visible:ring-offset-0"
      />
      {players.length === 0 && (
        <p className="text-[11px]" style={{ color: "rgba(255,255,255,0.35)" }}>
          No squad loaded — just type the {placeholder} and we'll track them.
        </p>
      )}
    </div>
  );
}

function MinuteInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs" style={{ color: "rgba(255,255,255,0.4)" }}>Minute</span>
      <Input
        type="number"
        min={0}
        max={120}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="optional"
        className="h-10 w-24 text-sm rounded-lg bg-white/5 border-white/10 text-white placeholder:text-white/25 focus-visible:ring-[#C9A43E] focus-visible:ring-offset-0"
      />
    </div>
  );
}

// ── Score / live / final ─────────────────────────────────────────────────
function ScoreCard({
  game,
  homeName,
  awayName,
  gameId,
  gameFetching,
}: {
  game: RefGameFull;
  homeName: string;
  awayName: string;
  gameId: number;
  gameFetching: boolean;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const key = scoreGameQueryKey(gameId);

  const patchMut = useMutation({
    mutationFn: (body: Record<string, any>) => apiRequest("PATCH", `/api/admin/tournament/games/${gameId}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
    onError: (e: any) => toast({ title: "Couldn't update the game", description: e.message, variant: "destructive" }),
  });

  const busy = patchMut.isPending || gameFetching;

  const bump = (side: "home" | "away", delta: number) => {
    const current = (side === "home" ? game.homeScore : game.awayScore) ?? 0;
    const next = Math.max(0, current + delta);
    patchMut.mutate(side === "home" ? { homeScore: next } : { awayScore: next });
  };

  return (
    <section className="rounded-2xl p-4" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" }}>
      <div className="grid grid-cols-2 gap-3">
        {(["home", "away"] as const).map((side) => {
          const value = side === "home" ? game.homeScore : game.awayScore;
          const name = side === "home" ? homeName : awayName;
          return (
            <div key={side} className="text-center">
              <div className="text-xs font-semibold uppercase tracking-wide truncate mb-2" style={{ color: "rgba(255,255,255,0.5)" }}>
                {name}
              </div>
              <div className="flex items-center justify-center gap-2">
                <StepperButton icon={<Minus className="h-5 w-5" />} onClick={() => bump(side, -1)} disabled={busy} />
                <div className="cic-score-display text-6xl font-black tabular-nums w-16 text-center text-white">{value ?? 0}</div>
                <StepperButton icon={<Plus className="h-5 w-5" />} onClick={() => bump(side, 1)} disabled={busy} />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function StepperButton({ icon, onClick, disabled }: { icon: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="h-12 w-12 rounded-full flex items-center justify-center text-white active:scale-95 transition disabled:opacity-40"
      style={{ background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.12)" }}
    >
      {icon}
    </button>
  );
}

// ── Goals ────────────────────────────────────────────────────────────────
function GoalsCard({
  game,
  goals,
  homeName,
  awayName,
  homePlayers,
  awayPlayers,
  gameId,
}: {
  game: RefGameFull;
  goals: RefGoal[];
  homeName: string;
  awayName: string;
  homePlayers: RefPlayer[];
  awayPlayers: RefPlayer[];
  gameId: number;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const key = scoreGameQueryKey(gameId);
  const playerById = useMemo(() => {
    const m = new Map<number, RefPlayer>();
    for (const p of [...homePlayers, ...awayPlayers]) m.set(p.id, p);
    return m;
  }, [homePlayers, awayPlayers]);

  const [side, setSide] = useState<"home" | "away" | null>(null);
  const [pickedId, setPickedId] = useState("");
  const [typed, setTyped] = useState("");
  const [minute, setMinute] = useState("");
  const [type, setType] = useState<"goal" | "penalty" | "own_goal">("goal");

  const addMut = useMutation({
    mutationFn: (body: any) => apiRequest("POST", "/api/admin/tournament/goals", { gameId, ...body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: key });
      setSide(null);
      setPickedId("");
      setTyped("");
      setMinute("");
      setType("goal");
    },
    onError: (e: any) => toast({ title: "Couldn't add goal", description: e.message, variant: "destructive" }),
  });
  const delMut = useMutation({
    mutationFn: (goalId: number) => apiRequest("DELETE", `/api/admin/tournament/goals/${goalId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
    onError: (e: any) => toast({ title: "Couldn't remove goal", description: e.message, variant: "destructive" }),
  });

  const submit = () => {
    if (!side) return;
    if (!pickedId && !typed.trim()) return;
    const isOwnGoal = type === "own_goal";
    const isPenalty = type === "penalty";
    const scorerTeamId = side === "home" ? game.homeTeamId : game.awayTeamId;
    if (!scorerTeamId) return;
    // Own-goal team-flip: the goal is CREDITED to the opponent of the
    // scorer's own team — mirrors RefGameDetail.submit() (and, before it,
    // the admin GameGoalsModal) exactly.
    const common = {
      teamId: isOwnGoal ? (side === "home" ? game.awayTeamId : game.homeTeamId) : scorerTeamId,
      minute: minute ? parseInt(minute, 10) : null,
      isOwnGoal,
      isPenalty,
    };
    if (pickedId) addMut.mutate({ ...common, playerId: parseInt(pickedId, 10) });
    else addMut.mutate({ ...common, playerName: typed.trim(), playerTeamId: scorerTeamId });
  };

  const sidePlayers = side === "home" ? homePlayers : side === "away" ? awayPlayers : [];

  return (
    <Section title={`Goals (${goals.length})`}>
      {goals.length > 0 && (
        <div className="space-y-1.5 mb-3">
          {goals.map((g) => {
            const p = playerById.get(g.playerId);
            const teamName = g.teamId === game.homeTeamId ? homeName : awayName;
            return (
              <div key={g.id} className="flex items-center justify-between rounded-lg px-3 py-2" style={rowStyle}>
                <div className="flex items-center gap-2 text-sm text-white min-w-0">
                  <span className="text-xs w-8 shrink-0" style={{ color: "rgba(255,255,255,0.35)" }}>{g.minute ? `${g.minute}'` : "—"}</span>
                  <span className="truncate">{p ? `${p.firstName} ${p.lastName}` : "Player"}</span>
                  <span className="text-xs shrink-0 truncate" style={{ color: "rgba(255,255,255,0.35)" }}>({teamName})</span>
                  {g.isPenalty && <Tag color="#facc15">PEN</Tag>}
                  {g.isOwnGoal && <Tag color="#f87171">OG</Tag>}
                </div>
                <button
                  onClick={() => delMut.mutate(g.id)}
                  className="h-8 w-8 flex items-center justify-center rounded-lg shrink-0"
                  style={{ color: "rgba(255,255,255,0.3)" }}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <TeamToggle side={side} onChange={(s) => { setSide(s); setPickedId(""); }} homeName={homeName} awayName={awayName} />

      {side && (
        <div className="mt-3 space-y-2.5">
          <PlayerPicker
            players={sidePlayers}
            pickedId={pickedId}
            onPick={(v) => { setPickedId(v); if (v) setTyped(""); }}
            typed={typed}
            onType={(v) => { setTyped(v); if (v) setPickedId(""); }}
            placeholder="scorer"
          />
          <div className="grid grid-cols-3 gap-1.5">
            {(["goal", "penalty", "own_goal"] as const).map((t) => (
              <ToggleChip key={t} active={type === t} onClick={() => setType(t)} label={t === "goal" ? "Goal" : t === "penalty" ? "Penalty" : "Own goal"} />
            ))}
          </div>
          {type === "own_goal" && (
            <p className="text-[11px]" style={{ color: "#fbbf24" }}>
              Own goal by a {side === "home" ? homeName : awayName} player — credited to {side === "home" ? awayName : homeName}.
            </p>
          )}
          <MinuteInput value={minute} onChange={setMinute} />
          <Button
            onClick={submit}
            disabled={(!pickedId && !typed.trim()) || addMut.isPending}
            className="w-full h-11 rounded-xl text-sm font-bold border-none"
            style={{ background: GOLD, color: INK }}
          >
            {addMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Add goal"}
          </Button>
        </div>
      )}
    </Section>
  );
}

// ── Cards ────────────────────────────────────────────────────────────────
function CardsCard({
  game,
  cards,
  homeName,
  awayName,
  homePlayers,
  awayPlayers,
  gameId,
}: {
  game: RefGameFull;
  cards: RefCard[];
  homeName: string;
  awayName: string;
  homePlayers: RefPlayer[];
  awayPlayers: RefPlayer[];
  gameId: number;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const key = scoreGameQueryKey(gameId);
  const playerById = useMemo(() => {
    const m = new Map<number, RefPlayer>();
    for (const p of [...homePlayers, ...awayPlayers]) m.set(p.id, p);
    return m;
  }, [homePlayers, awayPlayers]);

  const [side, setSide] = useState<"home" | "away" | null>(null);
  const [pickedId, setPickedId] = useState("");
  const [typed, setTyped] = useState("");
  const [minute, setMinute] = useState("");

  const addMut = useMutation({
    mutationFn: (body: any) => apiRequest("POST", "/api/admin/tournament/cards", { gameId, ...body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: key });
      setPickedId("");
      setTyped("");
      setMinute("");
    },
    onError: (e: any) => toast({ title: "Couldn't add card", description: e.message, variant: "destructive" }),
  });
  const delMut = useMutation({
    mutationFn: (cardId: number) => apiRequest("DELETE", `/api/admin/tournament/cards/${cardId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
    onError: (e: any) => toast({ title: "Couldn't remove card", description: e.message, variant: "destructive" }),
  });

  const addCard = (cardType: "yellow" | "red") => {
    if (!side) return;
    if (!pickedId && !typed.trim()) return;
    const teamId = side === "home" ? game.homeTeamId : game.awayTeamId;
    if (!teamId) return;
    const common = { teamId, cardType, minute: minute ? parseInt(minute, 10) : null };
    if (pickedId) addMut.mutate({ ...common, playerId: parseInt(pickedId, 10) });
    else addMut.mutate({ ...common, playerName: typed.trim(), playerTeamId: teamId });
  };

  const sidePlayers = side === "home" ? homePlayers : side === "away" ? awayPlayers : [];

  return (
    <Section title={`Cards (${cards.length})`}>
      {cards.length > 0 && (
        <div className="space-y-1.5 mb-3">
          {cards.map((c) => {
            const p = playerById.get(c.playerId);
            const teamName = c.teamId === game.homeTeamId ? homeName : awayName;
            return (
              <div key={c.id} className="flex items-center justify-between rounded-lg px-3 py-2" style={rowStyle}>
                <div className="flex items-center gap-2 text-sm text-white min-w-0">
                  <span className="text-xs w-8 shrink-0" style={{ color: "rgba(255,255,255,0.35)" }}>{c.minute ? `${c.minute}'` : "—"}</span>
                  <span className="inline-block w-3 h-4 rounded-[2px] shrink-0" style={{ background: c.cardType === "red" ? "#ef4444" : "#facc15" }} />
                  <span className="truncate">{p ? `${p.firstName} ${p.lastName}` : "Player"}</span>
                  <span className="text-xs shrink-0 truncate" style={{ color: "rgba(255,255,255,0.35)" }}>({teamName})</span>
                </div>
                <button
                  onClick={() => delMut.mutate(c.id)}
                  className="h-8 w-8 flex items-center justify-center rounded-lg shrink-0"
                  style={{ color: "rgba(255,255,255,0.3)" }}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <TeamToggle side={side} onChange={(s) => { setSide(s); setPickedId(""); }} homeName={homeName} awayName={awayName} />

      {side && (
        <div className="mt-3 space-y-2.5">
          <PlayerPicker
            players={sidePlayers}
            pickedId={pickedId}
            onPick={(v) => { setPickedId(v); if (v) setTyped(""); }}
            typed={typed}
            onType={(v) => { setTyped(v); if (v) setPickedId(""); }}
            placeholder="player"
          />
          <MinuteInput value={minute} onChange={setMinute} />
          <div className="grid grid-cols-2 gap-2">
            <Button
              onClick={() => addCard("yellow")}
              disabled={(!pickedId && !typed.trim()) || addMut.isPending}
              className="h-11 rounded-xl text-sm font-bold border-none"
              style={{ background: "#facc15", color: INK }}
            >
              🟨 Yellow
            </Button>
            <Button
              onClick={() => addCard("red")}
              disabled={(!pickedId && !typed.trim()) || addMut.isPending}
              className="h-11 rounded-xl text-sm font-bold border-none"
              style={{ background: "#ef4444", color: "white" }}
            >
              🟥 Red
            </Button>
          </div>
        </div>
      )}
    </Section>
  );
}

// ── MVP ──────────────────────────────────────────────────────────────────
function MvpCard({
  game,
  mvpVotes,
  homeName,
  awayName,
  homePlayers,
  awayPlayers,
  gameId,
}: {
  game: RefGameFull;
  mvpVotes: RefMvpVote[];
  homeName: string;
  awayName: string;
  homePlayers: RefPlayer[];
  awayPlayers: RefPlayer[];
  gameId: number;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const key = scoreGameQueryKey(gameId);
  const playerById = useMemo(() => {
    const m = new Map<number, RefPlayer>();
    for (const p of [...homePlayers, ...awayPlayers]) m.set(p.id, p);
    return m;
  }, [homePlayers, awayPlayers]);
  const byVoter = useMemo(() => {
    const m = new Map<number, number>();
    for (const v of mvpVotes) m.set(v.voterTeamId, v.playerId);
    return m;
  }, [mvpVotes]);

  const setMut = useMutation({
    mutationFn: (body: { voterTeamId: number; playerId?: number; playerName?: string }) =>
      apiRequest("PUT", `/api/admin/tournament/games/${gameId}/mvp-vote`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
    onError: (e: any) => toast({ title: "Couldn't save MVP vote", description: e.message, variant: "destructive" }),
  });
  const clearMut = useMutation({
    mutationFn: (voterTeamId: number) => apiRequest("DELETE", `/api/admin/tournament/games/${gameId}/mvp-vote/${voterTeamId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
    onError: (e: any) => toast({ title: "Couldn't clear MVP vote", description: e.message, variant: "destructive" }),
  });

  const homeId = game.homeTeamId!;
  const awayId = game.awayTeamId!;

  return (
    <Section title="Best player (MVP)">
      <div className="space-y-3">
        <MvpRow
          voterLabel={homeName}
          targetLabel={awayName}
          players={awayPlayers}
          currentPlayer={byVoter.has(homeId) ? playerById.get(byVoter.get(homeId)!) : undefined}
          onSave={(v) => setMut.mutate({ voterTeamId: homeId, ...v })}
          onClear={() => clearMut.mutate(homeId)}
          disabled={setMut.isPending}
        />
        <MvpRow
          voterLabel={awayName}
          targetLabel={homeName}
          players={homePlayers}
          currentPlayer={byVoter.has(awayId) ? playerById.get(byVoter.get(awayId)!) : undefined}
          onSave={(v) => setMut.mutate({ voterTeamId: awayId, ...v })}
          onClear={() => clearMut.mutate(awayId)}
          disabled={setMut.isPending}
        />
      </div>
    </Section>
  );
}

function MvpRow({
  voterLabel,
  targetLabel,
  players,
  currentPlayer,
  onSave,
  onClear,
  disabled,
}: {
  voterLabel: string;
  targetLabel: string;
  players: RefPlayer[];
  currentPlayer?: RefPlayer;
  onSave: (v: { playerId?: number; playerName?: string }) => void;
  onClear: () => void;
  disabled: boolean;
}) {
  const [pickedId, setPickedId] = useState("");
  const [typed, setTyped] = useState("");
  return (
    <div className="rounded-xl p-3" style={rowStyle}>
      <div className="text-[11px] mb-2" style={{ color: "rgba(255,255,255,0.5)" }}>
        <span className="font-semibold text-white/80">{voterLabel}</span> votes best <span className="font-semibold text-white/80">{targetLabel}</span> player
      </div>
      {currentPlayer ? (
        <div className="flex items-center justify-between">
          <span className="text-sm flex items-center gap-1.5" style={{ color: GOLD }}>
            <Award className="h-4 w-4" /> {currentPlayer.firstName} {currentPlayer.lastName}
          </span>
          <button onClick={onClear} className="text-xs" style={{ color: "rgba(255,255,255,0.4)" }}>Clear</button>
        </div>
      ) : (
        <div className="space-y-2">
          <PlayerPicker
            players={players}
            pickedId={pickedId}
            onPick={(id) => { setPickedId(id); if (id) onSave({ playerId: parseInt(id, 10) }); }}
            typed={typed}
            onType={setTyped}
            placeholder="player"
          />
          {typed.trim() && (
            <Button
              size="sm"
              disabled={disabled}
              onClick={() => { onSave({ playerName: typed.trim() }); setTyped(""); }}
              className="h-9 rounded-lg text-xs font-bold border-none"
              style={{ background: GOLD, color: INK }}
            >
              Set MVP
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Golden Glove (goalkeeper rating) ────────────────────────────────────
function GkCard({
  game,
  gkRatings,
  homeName,
  awayName,
  homePlayers,
  awayPlayers,
  gameId,
}: {
  game: RefGameFull;
  gkRatings: RefGkRating[];
  homeName: string;
  awayName: string;
  homePlayers: RefPlayer[];
  awayPlayers: RefPlayer[];
  gameId: number;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const key = scoreGameQueryKey(gameId);
  const playerById = useMemo(() => {
    const m = new Map<number, RefPlayer>();
    for (const p of [...homePlayers, ...awayPlayers]) m.set(p.id, p);
    return m;
  }, [homePlayers, awayPlayers]);
  const byTeam = useMemo(() => {
    const m = new Map<number, RefGkRating>();
    for (const r of gkRatings) m.set(r.teamId, r);
    return m;
  }, [gkRatings]);

  const setMut = useMutation({
    mutationFn: (body: { teamId: number; playerId?: number; playerName?: string; rating: number }) =>
      apiRequest("PUT", `/api/admin/tournament/games/${gameId}/gk-rating`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
    onError: (e: any) => toast({ title: "Couldn't save keeper rating", description: e.message, variant: "destructive" }),
  });
  const clearMut = useMutation({
    mutationFn: (teamId: number) => apiRequest("DELETE", `/api/admin/tournament/games/${gameId}/gk-rating/${teamId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
    onError: (e: any) => toast({ title: "Couldn't clear keeper rating", description: e.message, variant: "destructive" }),
  });

  const homeId = game.homeTeamId!;
  const awayId = game.awayTeamId!;

  return (
    <Section title="Golden Glove (keeper rating)">
      <div className="space-y-3">
        <GkRow
          teamLabel={homeName}
          players={homePlayers}
          current={byTeam.get(homeId)}
          currentPlayer={byTeam.get(homeId) ? playerById.get(byTeam.get(homeId)!.playerId) : undefined}
          onSave={(v) => setMut.mutate({ teamId: homeId, ...v })}
          onClear={() => clearMut.mutate(homeId)}
          disabled={setMut.isPending}
        />
        <GkRow
          teamLabel={awayName}
          players={awayPlayers}
          current={byTeam.get(awayId)}
          currentPlayer={byTeam.get(awayId) ? playerById.get(byTeam.get(awayId)!.playerId) : undefined}
          onSave={(v) => setMut.mutate({ teamId: awayId, ...v })}
          onClear={() => clearMut.mutate(awayId)}
          disabled={setMut.isPending}
        />
      </div>
    </Section>
  );
}

function GkRow({
  teamLabel,
  players,
  current,
  currentPlayer,
  onSave,
  onClear,
  disabled,
}: {
  teamLabel: string;
  players: RefPlayer[];
  current?: RefGkRating;
  currentPlayer?: RefPlayer;
  onSave: (v: { playerId?: number; playerName?: string; rating: number }) => void;
  onClear: () => void;
  disabled: boolean;
}) {
  const [pickedId, setPickedId] = useState("");
  const [typed, setTyped] = useState("");
  const keeperChosen = !!pickedId || !!typed.trim() || !!currentPlayer;

  const rate = (rating: number) => {
    if (currentPlayer && !pickedId && !typed.trim()) { onSave({ rating }); return; }
    if (pickedId) onSave({ playerId: parseInt(pickedId, 10), rating });
    else if (typed.trim()) onSave({ playerName: typed.trim(), rating });
  };

  return (
    <div className="rounded-xl p-3" style={rowStyle}>
      <div className="flex items-center justify-between mb-2 gap-2">
        <div className="text-[11px]">
          <span className="font-semibold text-white/80">{teamLabel}</span>{" "}
          <span style={{ color: "rgba(255,255,255,0.5)" }}>goalkeeper</span>
        </div>
        {currentPlayer && (
          <div className="flex items-center gap-1.5 text-[11px] shrink-0" style={{ color: "#93c5fd" }}>
            <span className="truncate max-w-[110px]">{currentPlayer.firstName} {currentPlayer.lastName}</span>
            {current?.rating != null && <span style={{ color: "rgba(255,255,255,0.4)" }}>· {current.rating}/5</span>}
            <button onClick={onClear} className="ml-1" style={{ color: "rgba(255,255,255,0.35)" }}>Clear</button>
          </div>
        )}
      </div>
      {!currentPlayer && (
        <div className="mb-2">
          <PlayerPicker
            players={players}
            pickedId={pickedId}
            onPick={(id) => { setPickedId(id); if (id) setTyped(""); }}
            typed={typed}
            onType={(v) => { setTyped(v); if (v) setPickedId(""); }}
            placeholder="keeper"
          />
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] mr-0.5" style={{ color: "rgba(255,255,255,0.35)" }}>Rate</span>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            disabled={!keeperChosen || disabled}
            onClick={() => rate(n)}
            className="h-10 w-10 rounded-lg text-sm font-bold disabled:opacity-30"
            style={
              current?.rating === n
                ? { background: GOLD, color: INK }
                : { background: "rgba(255,255,255,0.05)", color: "rgba(255,255,255,0.6)", border: "1px solid rgba(255,255,255,0.1)" }
            }
          >
            {n}
          </button>
        ))}
        <span className="text-[10px] ml-1" style={{ color: "rgba(255,255,255,0.3)" }}>5 = best</span>
      </div>
    </div>
  );
}

// ── Penalty shootout ─────────────────────────────────────────────────────
function ShootoutCard({
  game,
  shootout,
  homeName,
  awayName,
  gameId,
}: {
  game: RefGameFull;
  shootout: RefShootoutKick[];
  homeName: string;
  awayName: string;
  gameId: number;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const key = scoreGameQueryKey(gameId);
  const [takerHome, setTakerHome] = useState("");
  const [takerAway, setTakerAway] = useState("");

  const addMut = useMutation({
    mutationFn: (body: any) => apiRequest("POST", "/api/admin/tournament/shootout", { gameId, ...body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: key });
      setTakerHome("");
      setTakerAway("");
    },
    onError: (e: any) => toast({ title: "Couldn't log penalty", description: e.message, variant: "destructive" }),
  });
  const delMut = useMutation({
    mutationFn: (kickId: number) => apiRequest("DELETE", `/api/admin/tournament/shootout/${kickId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
    onError: (e: any) => toast({ title: "Couldn't undo that kick", description: e.message, variant: "destructive" }),
  });

  const sorted = [...shootout].sort((a, b) => a.kickNumber - b.kickNumber);
  const lastKickId = sorted.length ? sorted[sorted.length - 1].id : null;
  const homeTally = sorted.filter((k) => k.teamId === game.homeTeamId && k.scored).length;
  const awayTally = sorted.filter((k) => k.teamId === game.awayTeamId && k.scored).length;

  const log = (side: "home" | "away", scored: boolean) => {
    const teamId = side === "home" ? game.homeTeamId : game.awayTeamId;
    if (!teamId) return;
    const taker = (side === "home" ? takerHome : takerAway).trim();
    addMut.mutate({ teamId, scored, ...(taker ? { playerName: taker, playerTeamId: teamId } : {}) });
  };

  return (
    <Section
      title="Penalty shootout"
      right={
        <div className="flex items-center gap-1.5 text-sm font-bold shrink-0">
          <span className="text-[10px] font-normal max-w-[56px] truncate" style={{ color: "rgba(255,255,255,0.4)" }}>{homeName}</span>
          <span style={{ color: GOLD }}>{homeTally}</span>
          <span style={{ color: "rgba(255,255,255,0.3)" }}>–</span>
          <span style={{ color: GOLD }}>{awayTally}</span>
          <span className="text-[10px] font-normal max-w-[56px] truncate" style={{ color: "rgba(255,255,255,0.4)" }}>{awayName}</span>
        </div>
      }
    >
      {sorted.length > 0 && (
        <div className="space-y-1.5 mb-3">
          {sorted.map((k) => {
            const home = k.teamId === game.homeTeamId;
            return (
              <div key={k.id} className="flex items-center justify-between rounded-lg px-3 py-1.5" style={rowStyle}>
                <div className="flex items-center gap-2 text-xs" style={{ color: "rgba(255,255,255,0.4)" }}>
                  <span className="tabular-nums">#{k.kickNumber}</span>
                  <KickMark scored={k.scored} />
                  <span style={{ color: "rgba(255,255,255,0.7)" }}>{home ? homeName : awayName}</span>
                </div>
                {k.id === lastKickId && (
                  <button onClick={() => delMut.mutate(k.id)} className="h-7 w-7 flex items-center justify-center rounded" style={{ color: "rgba(255,255,255,0.3)" }}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="space-y-2">
        {([
          ["home", homeName, takerHome, setTakerHome],
          ["away", awayName, takerAway, setTakerAway],
        ] as const).map(([side, name, taker, setTaker]) => (
          <div key={side} className="rounded-xl p-2.5" style={rowStyle}>
            <div className="flex items-center justify-between gap-2 mb-2">
              <span className="text-sm font-semibold text-white truncate">{name}</span>
              <div className="flex gap-1.5 shrink-0">
                <button
                  onClick={() => log(side, true)}
                  disabled={addMut.isPending}
                  className="h-9 px-3 rounded-lg flex items-center gap-1 text-xs font-bold disabled:opacity-40"
                  style={{ background: "rgba(34,197,94,0.15)", color: "#4ade80" }}
                >
                  <Check className="h-3.5 w-3.5" /> Scored
                </button>
                <button
                  onClick={() => log(side, false)}
                  disabled={addMut.isPending}
                  className="h-9 px-3 rounded-lg flex items-center gap-1 text-xs font-bold disabled:opacity-40"
                  style={{ background: "rgba(239,68,68,0.15)", color: "#f87171" }}
                >
                  <X className="h-3.5 w-3.5" /> Missed
                </button>
              </div>
            </div>
            <Input
              value={taker}
              onChange={(e) => setTaker(e.target.value)}
              placeholder="Taker name (optional)"
              className="h-9 text-xs rounded-lg bg-white/5 border-white/10 text-white placeholder:text-white/25 focus-visible:ring-[#C9A43E] focus-visible:ring-offset-0"
            />
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px]" style={{ color: "rgba(255,255,255,0.35)" }}>
        Tap Scored or Missed as each kick is taken — the order and running score build automatically. Only the most recent kick can be undone.
      </p>
    </Section>
  );
}

function KickMark({ scored }: { scored: boolean }) {
  return scored ? (
    <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-green-500 text-white">
      <Check className="h-2.5 w-2.5" strokeWidth={3.5} />
    </span>
  ) : (
    <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-white">
      <X className="h-2.5 w-2.5" strokeWidth={3.5} />
    </span>
  );
}
