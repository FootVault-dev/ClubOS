// MFL referee match-day scoring screen — /mfl-ref/game/:id. Cloned from
// client/src/pages/ref/RefGameDetail.tsx (the CIC referee app), simplified
// for leagues: MFL teams have NO player rosters, so every goal/card is a
// FREE-TEXT scorer/player name against a credited team — no PlayerPicker, no
// MVP vote, no golden-glove rating, and no penalty shootout (leagues don't
// run any of those). The own-goal team-flip rule is preserved exactly.
//
// The live match timer (client/src/components/match-timer.tsx) is REUSED
// UNTOUCHED — it's a pure UI component that only reads
// timerPhase/timerRunning/timerStartedAt/timerBaseSeconds/homeScore/
// awayScore off whatever `game` object it's given and fires an `onAction`
// callback; the actual endpoint call happens in TimerSection below (mirrors
// CIC's RefGameDetail.tsx exactly). It's typed against CIC's `RefGameFull` —
// passed here `as any` since our MflGameFull is a structural superset of
// the fields it actually reads.
//
// Every write goes through the referee-scoped API (server/mfl-referee-routes.ts)
// via the Bearer-token helper in ./mfl-ref-api — never the admin
// apiRequest/queryClient.
import { useState, type ReactNode } from "react";
import { useLocation, useRoute } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Loader2, Minus, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import MatchTimer from "@/components/match-timer";
import {
  refDelete,
  refGameQueryKey,
  refGet,
  refPatch,
  refPost,
  RefApiError,
  type MflGameFull,
  type MflRefCard,
  type MflRefGameDetailResponse,
  type MflRefGoal,
  type RefTimerAction,
} from "./mfl-ref-api";
import { useMflBrand } from "./useMflBrand";

const GOLD = "#d1b96e";
const INK = "#000000";

const FONT_STYLE = `
  .mfl-ref-display { font-family: 'Anton', 'Inter Tight', 'Inter', sans-serif; }
  .mfl-ref-body { font-family: 'Inter Tight', 'Inter', sans-serif; }
`;

const rowStyle: React.CSSProperties = { background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" };

function errDesc(e: any): string {
  return e instanceof RefApiError ? e.message : "Something went wrong — try again.";
}

// ═══════════════════════════ Page ══════════════════════════════════════════
export default function MflRefGameDetail() {
  useMflBrand();
  const [, params] = useRoute("/mfl-ref/game/:id");
  const [, navigate] = useLocation();
  const id = params?.id ? parseInt(params.id, 10) : NaN;

  const { data, isLoading, isError, error, isFetching } = useQuery({
    queryKey: Number.isFinite(id) ? refGameQueryKey(id) : ["mfl-ref-game", "invalid"],
    queryFn: () => refGet<MflRefGameDetailResponse>(`/api/public/mfl-referees/games/${id}`),
    enabled: Number.isFinite(id),
  });

  const goBack = () => navigate("/mfl-ref");

  if (!Number.isFinite(id)) return <StatusScreen message="Invalid game." onBack={goBack} />;
  if (isLoading) return <StatusScreen loading />;
  if (isError || !data) return <StatusScreen message={(error as any)?.message || "Couldn't load this game."} onBack={goBack} />;

  const { game, homeTeam, awayTeam, goals, cards, halfLengthMinutes, breakMinutes } = data;
  const homeName = homeTeam?.name || "Home";
  const awayName = awayTeam?.name || "Away";

  return (
    <div className="mfl-ref-body min-h-screen w-full pb-16" style={{ background: INK }}>
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
          gameId={id}
        />
        <CardsCard
          game={game}
          cards={cards}
          homeName={homeName}
          awayName={awayName}
          gameId={id}
        />
      </div>
    </div>
  );
}

function StatusScreen({ loading, message, onBack }: { loading?: boolean; message?: string; onBack?: () => void }) {
  return (
    <div className="mfl-ref-body min-h-screen w-full flex flex-col items-center justify-center px-6 text-center" style={{ background: INK }}>
      <style>{FONT_STYLE}</style>
      {loading ? (
        <Loader2 className="h-8 w-8 animate-spin" style={{ color: GOLD }} />
      ) : (
        <>
          <p className="text-sm mb-4" style={{ color: "rgba(255,255,255,0.6)" }}>{message}</p>
          {onBack && (
            <button onClick={onBack} className="text-sm font-semibold" style={{ color: GOLD }}>
              ← Back to games
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
  game: MflGameFull;
  halfLengthMinutes: number;
  breakMinutes: number;
  gameId: number;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const key = refGameQueryKey(gameId);

  const timerMut = useMutation({
    mutationFn: (action: RefTimerAction) => refPost(`/api/public/mfl-referees/games/${gameId}/timer`, { action }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
    onError: (e: any) => toast({ title: "Couldn't update the timer", description: errDesc(e), variant: "destructive" }),
  });

  return (
    <MatchTimer
      game={game as any}
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
  game: MflGameFull;
  homeName: string;
  awayName: string;
  onBack: () => void;
}) {
  const live = game.timerPhase === "first_half" || game.timerPhase === "half_time" || game.timerPhase === "second_half";
  return (
    <div className="sticky top-0 z-20" style={{ background: INK, borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
      <div className="h-1 w-full" style={{ background: `linear-gradient(90deg, #8a774a, ${GOLD}, #ecd9a6)` }} />
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
            ) : live ? (
              <span className="flex items-center gap-1" style={{ color: "#f87171" }}>
                <span className="h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" /> Live
              </span>
            ) : (
              <span>Scheduled</span>
            )}
            {game.location && (
              <>
                <span>·</span>
                <span className="truncate">{game.location}</span>
              </>
            )}
          </div>
          <div className="flex items-center gap-2 text-sm font-bold text-white">
            <span className="truncate min-w-0">{homeName}</span>
            <span className="mfl-ref-display tabular-nums shrink-0" style={{ color: GOLD }}>
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
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl p-4" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" }}>
      <div className="flex items-center justify-between mb-3 gap-2">
        <div className="text-xs font-bold uppercase tracking-wide" style={{ color: "rgba(255,255,255,0.5)" }}>{title}</div>
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
        className="h-10 w-24 text-sm rounded-lg bg-white/5 border-white/10 text-white placeholder:text-white/25 focus-visible:ring-[#d1b96e] focus-visible:ring-offset-0"
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
  game: MflGameFull;
  homeName: string;
  awayName: string;
  gameId: number;
  gameFetching: boolean;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const key = refGameQueryKey(gameId);

  const patchMut = useMutation({
    mutationFn: (body: Record<string, any>) => refPatch(`/api/public/mfl-referees/games/${gameId}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
    onError: (e: any) => toast({ title: "Couldn't update the game", description: errDesc(e), variant: "destructive" }),
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
                <div className="mfl-ref-display text-6xl font-black tabular-nums w-16 text-center text-white">{value ?? 0}</div>
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

// ── Goals — free-text scorer name only, no roster (leagues have none). ────
function GoalsCard({
  game,
  goals,
  homeName,
  awayName,
  gameId,
}: {
  game: MflGameFull;
  goals: MflRefGoal[];
  homeName: string;
  awayName: string;
  gameId: number;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const key = refGameQueryKey(gameId);

  const [side, setSide] = useState<"home" | "away" | null>(null);
  const [name, setName] = useState("");
  const [minute, setMinute] = useState("");
  const [type, setType] = useState<"goal" | "penalty" | "own_goal">("goal");

  const addMut = useMutation({
    mutationFn: (body: any) => refPost(`/api/public/mfl-referees/games/${gameId}/goals`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: key });
      setSide(null);
      setName("");
      setMinute("");
      setType("goal");
    },
    onError: (e: any) => toast({ title: "Couldn't add goal", description: errDesc(e), variant: "destructive" }),
  });
  const delMut = useMutation({
    mutationFn: (goalId: number) => refDelete(`/api/public/mfl-referees/games/${gameId}/goals/${goalId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
    onError: (e: any) => toast({ title: "Couldn't remove goal", description: errDesc(e), variant: "destructive" }),
  });

  const submit = () => {
    if (!side) return;
    if (!name.trim()) return;
    const isOwnGoal = type === "own_goal";
    const isPenalty = type === "penalty";
    const scorerTeamId = side === "home" ? game.homeTeamId : game.awayTeamId;
    if (!scorerTeamId) return;
    // Own-goal team-flip: the goal is CREDITED to the opponent of the
    // scorer's own team — mirrors the CIC referee app's submit() exactly.
    const teamId = isOwnGoal ? (side === "home" ? game.awayTeamId : game.homeTeamId) : scorerTeamId;
    addMut.mutate({
      teamId,
      playerName: name.trim(),
      minute: minute ? parseInt(minute, 10) : null,
      isOwnGoal,
      isPenalty,
    });
  };

  return (
    <Section title={`Goals (${goals.length})`}>
      {goals.length > 0 && (
        <div className="space-y-1.5 mb-3">
          {goals.map((g) => {
            const teamName = g.teamId === game.homeTeamId ? homeName : awayName;
            return (
              <div key={g.id} className="flex items-center justify-between rounded-lg px-3 py-2" style={rowStyle}>
                <div className="flex items-center gap-2 text-sm text-white min-w-0">
                  <span className="text-xs w-8 shrink-0" style={{ color: "rgba(255,255,255,0.35)" }}>{g.minute ? `${g.minute}'` : "—"}</span>
                  <span className="truncate">{g.playerName}</span>
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

      <TeamToggle side={side} onChange={setSide} homeName={homeName} awayName={awayName} />

      {side && (
        <div className="mt-3 space-y-2.5">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Scorer's name"
            className="h-11 text-sm rounded-xl bg-white/5 border-white/10 text-white placeholder:text-white/30 focus-visible:ring-[#d1b96e] focus-visible:ring-offset-0"
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
            disabled={!name.trim() || addMut.isPending}
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

// ── Cards — free-text player name only. ─────────────────────────────────
function CardsCard({
  game,
  cards,
  homeName,
  awayName,
  gameId,
}: {
  game: MflGameFull;
  cards: MflRefCard[];
  homeName: string;
  awayName: string;
  gameId: number;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const key = refGameQueryKey(gameId);

  const [side, setSide] = useState<"home" | "away" | null>(null);
  const [name, setName] = useState("");
  const [minute, setMinute] = useState("");

  const addMut = useMutation({
    mutationFn: (body: any) => refPost(`/api/public/mfl-referees/games/${gameId}/cards`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: key });
      setName("");
      setMinute("");
    },
    onError: (e: any) => toast({ title: "Couldn't add card", description: errDesc(e), variant: "destructive" }),
  });
  const delMut = useMutation({
    mutationFn: (cardId: number) => refDelete(`/api/public/mfl-referees/games/${gameId}/cards/${cardId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
    onError: (e: any) => toast({ title: "Couldn't remove card", description: errDesc(e), variant: "destructive" }),
  });

  const addCard = (cardType: "yellow" | "red") => {
    if (!side) return;
    if (!name.trim()) return;
    const teamId = side === "home" ? game.homeTeamId : game.awayTeamId;
    if (!teamId) return;
    addMut.mutate({ teamId, playerName: name.trim(), cardType, minute: minute ? parseInt(minute, 10) : null });
  };

  return (
    <Section title={`Cards (${cards.length})`}>
      {cards.length > 0 && (
        <div className="space-y-1.5 mb-3">
          {cards.map((c) => {
            const teamName = c.teamId === game.homeTeamId ? homeName : awayName;
            return (
              <div key={c.id} className="flex items-center justify-between rounded-lg px-3 py-2" style={rowStyle}>
                <div className="flex items-center gap-2 text-sm text-white min-w-0">
                  <span className="text-xs w-8 shrink-0" style={{ color: "rgba(255,255,255,0.35)" }}>{c.minute ? `${c.minute}'` : "—"}</span>
                  <span className="inline-block w-3 h-4 rounded-[2px] shrink-0" style={{ background: c.cardType === "red" ? "#ef4444" : "#facc15" }} />
                  <span className="truncate">{c.playerName}</span>
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

      <TeamToggle side={side} onChange={setSide} homeName={homeName} awayName={awayName} />

      {side && (
        <div className="mt-3 space-y-2.5">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Player's name"
            className="h-11 text-sm rounded-xl bg-white/5 border-white/10 text-white placeholder:text-white/30 focus-visible:ring-[#d1b96e] focus-visible:ring-offset-0"
          />
          <MinuteInput value={minute} onChange={setMinute} />
          <div className="grid grid-cols-2 gap-2">
            <Button
              onClick={() => addCard("yellow")}
              disabled={!name.trim() || addMut.isPending}
              className="h-11 rounded-xl text-sm font-bold border-none"
              style={{ background: "#facc15", color: INK }}
            >
              🟨 Yellow
            </Button>
            <Button
              onClick={() => addCard("red")}
              disabled={!name.trim() || addMut.isPending}
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
