import { Fragment, useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useRoute, useLocation } from "wouter";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Award, Users, Calendar, LayoutGrid, Settings2, Plus, Trash2, GripVertical, X, Shield, Clock, MapPin, Pencil, Check, ChevronDown, Goal, RefreshCw, Square, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TimePickerInput } from "@/components/ui/time-picker-input";
import { DatePickerInput } from "@/components/ui/date-picker-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Tournament, TournamentGroup, TournamentTeam, TournamentGame, TournamentPlayer, TournamentGoal, TournamentCard } from "@shared/schema";

// A player at or above this many yellow cards should sit out a game. CIC's
// actual rule — confirm with Isaac and change here if it's not 2.
const YELLOW_SUSPENSION_THRESHOLD = 2;

type Tab = "format" | "schedule" | "groups" | "teams" | "awards";

// Common pitches (suggestions only) — admins can type ANY value (S3, S4, a
// different venue, etc.) so a flooded/late-changed pitch can be set on the day.
const FIELDS = ["S1", "S2", "S3", "S4", "J1", "J2", "J3", "J4", "Mini 1", "Mini 2"];

function FormatTab({ tournament }: { tournament: Tournament }) {
  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-blue-500/10 bg-white/[0.02] p-5">
        <h3 className="text-sm font-semibold text-white mb-4">Tournament Format</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { label: "Groups", value: tournament.numGroups },
            { label: "Teams per Group", value: tournament.teamsPerGroup },
            { label: "Group Format", value: tournament.groupStageFormat === "round_robin" ? "Round Robin" : tournament.groupStageFormat },
            { label: "Knockout Format", value: tournament.knockoutFormat === "single_elimination" ? "Single Elimination" : tournament.knockoutFormat },
          ].map(item => (
            <div key={item.label} className="p-4 rounded-xl bg-white/[0.02] border border-white/5">
              <p className="text-xs text-white/30 mb-1">{item.label}</p>
              <p className="text-lg font-semibold text-white/80">{item.value}</p>
            </div>
          ))}
        </div>
      </div>
      <div className="rounded-2xl border border-blue-500/10 bg-white/[0.02] p-5">
        <h3 className="text-sm font-semibold text-white mb-4">Points & Timing</h3>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          {[
            { label: "Win", value: `${tournament.pointsForWin} pts` },
            { label: "Draw", value: `${tournament.pointsForDraw} pts` },
            { label: "Loss", value: `${tournament.pointsForLoss} pts` },
            { label: "Game Duration", value: `${tournament.gameDurationMinutes} min` },
            { label: "Break", value: `${tournament.breakBetweenMinutes} min` },
          ].map(item => (
            <div key={item.label} className="p-4 rounded-xl bg-white/[0.02] border border-white/5">
              <p className="text-xs text-white/30 mb-1">{item.label}</p>
              <p className="text-lg font-semibold text-white/80">{item.value}</p>
            </div>
          ))}
        </div>
      </div>
      <div className="rounded-2xl border border-blue-500/10 bg-white/[0.02] p-5">
        <h3 className="text-sm font-semibold text-white mb-4">Knockout Bracket (4 Groups)</h3>
        <div className="text-xs text-white/40 space-y-2 font-mono">
          <p className="text-white/60 font-semibold mb-2">CUP Quarter-Finals:</p>
          <p>QF1: A1 vs B2 &nbsp;&nbsp; QF2: B1 vs A2</p>
          <p>QF3: C1 vs D2 &nbsp;&nbsp; QF4: D1 vs C2</p>
          <p className="text-white/60 font-semibold mt-3 mb-2">PLATE Quarter-Finals:</p>
          <p>QF1: A3 vs B4 &nbsp;&nbsp; QF2: B3 vs A4</p>
          <p>QF3: C3 vs D4 &nbsp;&nbsp; QF4: D3 vs C4</p>
          <p className="text-white/60 font-semibold mt-3 mb-2">Semi-Finals → Finals</p>
          <p>SF1: W(QF1) vs W(QF4) &nbsp;&nbsp; SF2: W(QF2) vs W(QF3)</p>
          <p>3rd Place: L(SF1) vs L(SF2) &nbsp;&nbsp; FINAL: W(SF1) vs W(SF2)</p>
        </div>
      </div>
    </div>
  );
}

type GameWithRelations = TournamentGame & { homeTeam?: TournamentTeam; awayTeam?: TournamentTeam; group?: TournamentGroup };

// Per-game goal log + entry. Lets the admin record goals as a match
// progresses; these aggregate up into the public top-scorers feed.
// One MVP-vote row: a team picks the best player on the OPPOSING team.
function MvpVoteRow({ voterLabel, targetLabel, players, currentName, onSave, onClear, disabled }: {
  voterLabel: string; targetLabel: string; players: TournamentPlayer[];
  currentName: string | null; onSave: (v: { playerId?: number; playerName?: string }) => void;
  onClear: () => void; disabled: boolean;
}) {
  const [typed, setTyped] = useState("");
  return (
    <div className="rounded-lg bg-white/[0.015] border border-white/5 px-3 py-2.5 space-y-2">
      <div className="text-[11px] text-white/50">
        <span className="text-white/70 font-medium">{voterLabel}</span> votes — best <span className="text-white/70 font-medium">{targetLabel}</span> player
      </div>
      {currentName ? (
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm text-purple-300 flex items-center gap-1.5"><Award className="w-3.5 h-3.5" /> {currentName}</span>
          <button onClick={onClear} className="text-white/25 hover:text-red-400 text-xs">Clear</button>
        </div>
      ) : (
        <div className="space-y-2">
          {players.length > 0 && (
            <select
              defaultValue=""
              disabled={disabled}
              onChange={e => { if (e.target.value) onSave({ playerId: parseInt(e.target.value) }); }}
              className="w-full bg-white/[0.02] border border-white/10 text-white text-sm rounded-md px-3 py-2"
            >
              <option value="">Pick MVP…</option>
              {players.map(p => <option key={p.id} value={p.id}>#{p.shirtNumber ?? "—"} {p.firstName} {p.lastName}</option>)}
            </select>
          )}
          <div className="flex gap-2">
            <Input
              type="text"
              placeholder={players.length > 0 ? "…or type a name" : "Type the player's name"}
              value={typed}
              onChange={e => setTyped(e.target.value)}
              className="text-sm flex-1"
            />
            <Button size="sm" variant="outline" disabled={!typed.trim() || disabled}
              onClick={() => { onSave({ playerName: typed.trim() }); setTyped(""); }} className="text-xs">Set</Button>
          </div>
        </div>
      )}
    </div>
  );
}

// One goalkeeper-rating row: pick the keeper, then rate 1–5 (5 = best).
function GkRatingRow({ teamLabel, players, currentName, currentRating, onSave, onClear, disabled }: {
  teamLabel: string; players: TournamentPlayer[]; currentName: string | null; currentRating: number | null;
  onSave: (v: { playerId?: number; playerName?: string; rating: number }) => void; onClear: () => void; disabled: boolean;
}) {
  const [pickedId, setPickedId] = useState("");
  const [typed, setTyped] = useState("");
  const keeperChosen = !!pickedId || !!typed.trim() || !!currentName;
  const rate = (rating: number) => {
    if (currentName && !pickedId && !typed.trim()) { onSave({ rating }); return; }   // re-rate the existing keeper
    if (pickedId) onSave({ playerId: parseInt(pickedId), rating });
    else if (typed.trim()) onSave({ playerName: typed.trim(), rating });
  };
  return (
    <div className="rounded-lg bg-white/[0.015] border border-white/5 px-3 py-2.5 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-[11px] text-white/50"><span className="text-white/70 font-medium">{teamLabel}</span> goalkeeper</div>
        {currentName && (
          <span className="text-[11px] text-blue-300 flex items-center gap-1">
            {currentName}{currentRating != null ? <span className="text-white/40">· {currentRating}/5</span> : null}
            <button onClick={onClear} className="text-white/25 hover:text-red-400 ml-1">Clear</button>
          </span>
        )}
      </div>
      {!currentName && (
        <>
          {players.length > 0 && (
            <select value={pickedId} disabled={disabled}
              onChange={e => { setPickedId(e.target.value); if (e.target.value) setTyped(""); }}
              className="w-full bg-white/[0.02] border border-white/10 text-white text-sm rounded-md px-3 py-2">
              <option value="">Pick keeper…</option>
              {players.map(p => <option key={p.id} value={p.id}>#{p.shirtNumber ?? "—"} {p.firstName} {p.lastName}</option>)}
            </select>
          )}
          <Input type="text" placeholder={players.length > 0 ? "…or type the keeper's name" : "Type the keeper's name"}
            value={typed} onChange={e => { setTyped(e.target.value); if (e.target.value) setPickedId(""); }} className="text-sm" />
        </>
      )}
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] text-white/30 mr-1">Rate</span>
        {[1, 2, 3, 4, 5].map(n => (
          <button key={n} disabled={!keeperChosen || disabled} onClick={() => rate(n)}
            className={`w-8 h-8 rounded-md text-sm font-semibold transition-all disabled:opacity-30 ${
              currentRating === n ? "bg-blue-600 text-white" : "bg-white/[0.03] text-white/50 hover:bg-white/10 border border-white/10"
            }`}>{n}</button>
        ))}
        <span className="text-[10px] text-white/25 ml-1">5 = best</span>
      </div>
    </div>
  );
}

function GameGoalsModal({ game, onClose }: { game: GameWithRelations; onClose: () => void }) {
  const { toast } = useToast();
  const [pickerSide, setPickerSide] = useState<"home" | "away" | null>(null);
  const [pickedPlayerId, setPickedPlayerId] = useState<string>("");
  const [typedName, setTypedName] = useState<string>("");
  const [minute, setMinute] = useState<string>("");
  // Goal type — one choice per goal. Maps to the isPenalty / isOwnGoal flags the
  // API + public match timeline already use (a plain goal = both false).
  const [goalType, setGoalType] = useState<"goal" | "penalty" | "own_goal">("goal");
  // Card entry
  const [cardSide, setCardSide] = useState<"home" | "away" | null>(null);
  const [cardPlayerId, setCardPlayerId] = useState<string>("");
  const [cardTyped, setCardTyped] = useState<string>("");
  const [cardMinute, setCardMinute] = useState<string>("");

  const { data: goals = [] } = useQuery<TournamentGoal[]>({
    queryKey: ["/api/admin/tournament/games", game.id, "goals"],
    queryFn: () => fetch(`/api/admin/tournament/games/${game.id}/goals`).then(r => r.json()),
  });
  const { data: homePlayers = [] } = useQuery<TournamentPlayer[]>({
    queryKey: ["/api/admin/tournament/teams", game.homeTeamId, "players"],
    queryFn: () => fetch(`/api/admin/tournament/teams/${game.homeTeamId}/players`).then(r => r.json()),
    enabled: !!game.homeTeamId,
  });
  const { data: awayPlayers = [] } = useQuery<TournamentPlayer[]>({
    queryKey: ["/api/admin/tournament/teams", game.awayTeamId, "players"],
    queryFn: () => fetch(`/api/admin/tournament/teams/${game.awayTeamId}/players`).then(r => r.json()),
    enabled: !!game.awayTeamId,
  });

  const addGoalMut = useMutation({
    mutationFn: (data: any) => apiRequest("POST", "/api/admin/tournament/goals", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/tournament/games", game.id, "goals"] });
      // A typed scorer creates a player — refresh rosters so the name resolves.
      queryClient.invalidateQueries({ queryKey: ["/api/admin/tournament/teams", game.homeTeamId, "players"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/tournament/teams", game.awayTeamId, "players"] });
      setPickerSide(null);
      setPickedPlayerId("");
      setTypedName("");
      setMinute("");
      setGoalType("goal");
    },
    onError: (e: any) => toast({ title: "Couldn't add goal", description: e.message, variant: "destructive" }),
  });

  const deleteGoalMut = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/admin/tournament/goals/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/tournament/games", game.id, "goals"] });
    },
  });

  const playerById = useMemo(() => {
    const m = new Map<number, TournamentPlayer & { side: "home" | "away" }>();
    for (const p of homePlayers) m.set(p.id, { ...p, side: "home" });
    for (const p of awayPlayers) m.set(p.id, { ...p, side: "away" });
    return m;
  }, [homePlayers, awayPlayers]);

  // ── Individual awards (admin-only): MVP votes + goalkeeper ratings ──
  const { data: awards } = useQuery<{ mvpVotes: any[]; gkRatings: any[] }>({
    queryKey: ["/api/admin/tournament/games", game.id, "awards"],
    queryFn: () => fetch(`/api/admin/tournament/games/${game.id}/awards`).then(r => r.json()),
  });
  const invalidateAwards = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/admin/tournament/games", game.id, "awards"] });
    // A typed name find-or-creates a player → refresh rosters so it resolves.
    queryClient.invalidateQueries({ queryKey: ["/api/admin/tournament/teams", game.homeTeamId, "players"] });
    queryClient.invalidateQueries({ queryKey: ["/api/admin/tournament/teams", game.awayTeamId, "players"] });
  };
  const mvpMut = useMutation({
    mutationFn: (body: any) => apiRequest("PUT", `/api/admin/tournament/games/${game.id}/mvp-vote`, body),
    onSuccess: invalidateAwards,
    onError: (e: any) => toast({ title: "Couldn't save MVP vote", description: e.message, variant: "destructive" }),
  });
  const mvpDelMut = useMutation({
    mutationFn: (voterTeamId: number) => apiRequest("DELETE", `/api/admin/tournament/games/${game.id}/mvp-vote/${voterTeamId}`),
    onSuccess: invalidateAwards,
  });
  const gkMut = useMutation({
    mutationFn: (body: any) => apiRequest("PUT", `/api/admin/tournament/games/${game.id}/gk-rating`, body),
    onSuccess: invalidateAwards,
    onError: (e: any) => toast({ title: "Couldn't save keeper rating", description: e.message, variant: "destructive" }),
  });
  const gkDelMut = useMutation({
    mutationFn: (teamId: number) => apiRequest("DELETE", `/api/admin/tournament/games/${game.id}/gk-rating/${teamId}`),
    onSuccess: invalidateAwards,
  });

  const mvpByVoter = useMemo(() => {
    const m = new Map<number, number>(); // voterTeamId → playerId voted
    for (const v of awards?.mvpVotes ?? []) m.set(v.voterTeamId, v.playerId);
    return m;
  }, [awards]);
  const gkByTeam = useMemo(() => {
    const m = new Map<number, { playerId: number; rating: number }>();
    for (const r of awards?.gkRatings ?? []) m.set(r.teamId, { playerId: r.playerId, rating: r.rating });
    return m;
  }, [awards]);
  const nameOf = (playerId: number | undefined | null) => {
    if (!playerId) return null;
    const p = playerById.get(playerId);
    return p ? `${p.firstName} ${p.lastName}` : `Player ${playerId}`;
  };

  // ── Disciplinary cards (admin-only) ──
  const { data: cards = [] } = useQuery<TournamentCard[]>({
    queryKey: ["/api/admin/tournament/games", game.id, "cards"],
    queryFn: () => fetch(`/api/admin/tournament/games/${game.id}/cards`).then(r => r.json()),
  });
  const addCardMut = useMutation({
    mutationFn: (data: any) => apiRequest("POST", "/api/admin/tournament/cards", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/tournament/games", game.id, "cards"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/tournament/teams", game.homeTeamId, "players"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/tournament/teams", game.awayTeamId, "players"] });
      setCardPlayerId(""); setCardTyped(""); setCardMinute("");
    },
    onError: (e: any) => toast({ title: "Couldn't add card", description: e.message, variant: "destructive" }),
  });
  const deleteCardMut = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/admin/tournament/cards/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/admin/tournament/games", game.id, "cards"] }),
  });
  const addCard = (cardType: "yellow" | "red") => {
    if (!cardSide) return;
    if (!cardPlayerId && !cardTyped.trim()) return;
    const teamId = cardSide === "home" ? game.homeTeamId : game.awayTeamId;
    const common = { gameId: game.id, teamId, cardType, minute: cardMinute ? parseInt(cardMinute) : null };
    if (cardPlayerId) addCardMut.mutate({ ...common, playerId: parseInt(cardPlayerId) });
    else addCardMut.mutate({ ...common, playerName: cardTyped.trim(), playerTeamId: teamId });
  };

  const submit = () => {
    if (!pickerSide) return;
    if (!pickedPlayerId && !typedName.trim()) return;
    const isOwnGoal = goalType === "own_goal";
    const isPenalty = goalType === "penalty";
    const scorerTeamId = pickerSide === "home" ? game.homeTeamId : game.awayTeamId;
    const common = {
      gameId: game.id,
      // Own goals: the goal counts AGAINST the scorer's team, so the team
      // logged on the goal row is the OPPOSITE side from where the player plays.
      teamId: isOwnGoal
        ? (pickerSide === "home" ? game.awayTeamId : game.homeTeamId)
        : scorerTeamId,
      minute: minute ? parseInt(minute) : null,
      isOwnGoal,
      isPenalty,
    };
    if (pickedPlayerId) {
      addGoalMut.mutate({ ...common, playerId: parseInt(pickedPlayerId) });
    } else {
      // Typed name → server find-or-creates the player on the scorer's team.
      addGoalMut.mutate({ ...common, playerName: typedName.trim(), playerTeamId: scorerTeamId });
    }
  };

  const homeName = game.homeTeam?.name || game.homeTeamPlaceholder || "Home";
  const awayName = game.awayTeam?.name || game.awayTeamPlaceholder || "Away";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-[#0a0e1a] border border-blue-500/15 rounded-2xl w-full max-w-lg shadow-2xl max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-white/5 shrink-0">
          <div>
            <div className="text-xs text-white/40 uppercase tracking-wide">Game {game.gameNumber} · {game.stageDetail}</div>
            <h2 className="text-lg font-semibold text-white">{homeName} v {awayName}</h2>
          </div>
          <button onClick={onClose} className="text-white/40 hover:text-white/70"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          <div>
            <div className="text-xs text-white/40 uppercase tracking-wide mb-2">Goals ({goals.length})</div>
            {goals.length === 0 ? (
              <p className="text-xs text-white/30">No goals recorded yet.</p>
            ) : (
              <div className="space-y-1">
                {goals.map(g => {
                  const p = playerById.get(g.playerId);
                  const teamName = g.teamId === game.homeTeamId ? homeName : awayName;
                  return (
                    <div key={g.id} className="flex items-center justify-between rounded-md bg-white/[0.02] border border-white/5 px-3 py-1.5">
                      <div className="flex items-center gap-2 text-sm">
                        <span className="text-white/30 text-xs w-8">{g.minute ? `${g.minute}'` : "—"}</span>
                        <span className="text-white">{p ? `${p.firstName} ${p.lastName}` : `Player ${g.playerId}`}</span>
                        <span className="text-white/30 text-xs">({teamName})</span>
                        {g.isPenalty && <span className="text-[10px] px-1 rounded bg-yellow-500/15 text-yellow-400">PEN</span>}
                        {g.isOwnGoal && <span className="text-[10px] px-1 rounded bg-red-500/15 text-red-400">OG</span>}
                      </div>
                      <button
                        onClick={() => deleteGoalMut.mutate(g.id)}
                        className="w-6 h-6 flex items-center justify-center rounded text-white/15 hover:text-red-400 hover:bg-red-500/10"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="border-t border-white/5 pt-4 space-y-3">
            <div className="text-xs text-white/40 uppercase tracking-wide">Add a goal</div>
            <div className="flex gap-2">
              <Button
                size="sm" variant={pickerSide === "home" ? "default" : "outline"}
                onClick={() => { setPickerSide("home"); setPickedPlayerId(""); }}
                className="flex-1 text-xs"
              >
                {homeName}
              </Button>
              <Button
                size="sm" variant={pickerSide === "away" ? "default" : "outline"}
                onClick={() => { setPickerSide("away"); setPickedPlayerId(""); }}
                className="flex-1 text-xs"
              >
                {awayName}
              </Button>
            </div>

            {pickerSide && (
              <>
                {(pickerSide === "home" ? homePlayers : awayPlayers).length > 0 && (
                  <select
                    value={pickedPlayerId}
                    onChange={e => { setPickedPlayerId(e.target.value); if (e.target.value) setTypedName(""); }}
                    className="w-full bg-white/[0.02] border border-white/10 text-white text-sm rounded-md px-3 py-2"
                  >
                    <option value="">Pick scorer…</option>
                    {(pickerSide === "home" ? homePlayers : awayPlayers).map(p => (
                      <option key={p.id} value={p.id}>
                        #{p.shirtNumber ?? "—"} {p.firstName} {p.lastName}
                      </option>
                    ))}
                  </select>
                )}
                <Input
                  type="text"
                  placeholder={(pickerSide === "home" ? homePlayers : awayPlayers).length > 0 ? "…or type a scorer's name" : "Type the scorer's name"}
                  value={typedName}
                  onChange={e => { setTypedName(e.target.value); if (e.target.value) setPickedPlayerId(""); }}
                  className="w-full text-sm"
                  data-testid="input-typed-scorer"
                />
                {(pickerSide === "home" ? homePlayers : awayPlayers).length === 0 && (
                  <p className="text-[11px] text-white/40">
                    No squad loaded — just type the scorer and we'll track them on the Golden Boot.
                  </p>
                )}

                <div className="space-y-3">
                  {/* Goal type — pick one (a goal is exactly one of these) */}
                  <div>
                    <label className="block text-[11px] font-medium text-white/50 mb-1.5">Goal type</label>
                    <div className="grid grid-cols-3 gap-1.5">
                      {([["goal", "Goal"], ["penalty", "Penalty"], ["own_goal", "Own goal"]] as const).map(([val, lbl]) => (
                        <button
                          key={val}
                          type="button"
                          onClick={() => setGoalType(val)}
                          className={`rounded-md px-3 py-2 text-xs font-semibold transition border ${
                            goalType === val
                              ? "bg-blue-600 border-blue-500 text-white"
                              : "bg-white/[0.02] border-white/10 text-white/60 hover:text-white hover:border-white/25"
                          }`}
                        >
                          {lbl}
                        </button>
                      ))}
                    </div>
                    {goalType === "own_goal" && (
                      <p className="mt-1.5 text-[11px] text-amber-400/80">
                        Own goal by a {pickerSide === "home" ? homeName : awayName} player — counts as a goal for {pickerSide === "home" ? awayName : homeName}.
                      </p>
                    )}
                  </div>

                  {/* Goal time */}
                  <div>
                    <label className="block text-[11px] font-medium text-white/50 mb-1.5">
                      Goal time <span className="text-white/30">— the minute it was scored (feeds the match timeline)</span>
                    </label>
                    <div className="relative w-24">
                      <Input
                        type="number" min="0" max="120" placeholder="e.g. 34"
                        value={minute} onChange={e => setMinute(e.target.value)}
                        className="w-24 text-sm pr-6"
                      />
                      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-white/30 text-sm">'</span>
                    </div>
                  </div>
                </div>

                <Button
                  size="sm"
                  onClick={submit}
                  disabled={(!pickedPlayerId && !typedName.trim()) || addGoalMut.isPending}
                  className="w-full bg-blue-600 hover:bg-blue-700 text-white"
                >
                  {addGoalMut.isPending ? "Saving…" : "Add goal"}
                </Button>
              </>
            )}
          </div>

          {game.homeTeamId && game.awayTeamId && (
            <>
              {/* Disciplinary cards — admin only */}
              <div className="border-t border-white/5 pt-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="text-xs text-white/40 uppercase tracking-wide">Cards ({cards.length})</div>
                  <span className="text-[10px] text-amber-400/70 flex items-center gap-1"><Shield className="w-2.5 h-2.5" /> Private</span>
                </div>
                {cards.length > 0 && (
                  <div className="space-y-1">
                    {cards.map(c => {
                      const teamName = c.teamId === game.homeTeamId ? homeName : awayName;
                      return (
                        <div key={c.id} className="flex items-center justify-between rounded-md bg-white/[0.02] border border-white/5 px-3 py-1.5">
                          <div className="flex items-center gap-2 text-sm">
                            <span className="text-white/30 text-xs w-8">{c.minute ? `${c.minute}'` : "—"}</span>
                            <span className={`inline-block w-3 h-4 rounded-[2px] shrink-0 ${c.cardType === "red" ? "bg-red-500" : "bg-yellow-400"}`} />
                            <span className="text-white">{nameOf(c.playerId) ?? `Player ${c.playerId}`}</span>
                            <span className="text-white/30 text-xs">({teamName})</span>
                          </div>
                          <button onClick={() => deleteCardMut.mutate(c.id)} className="w-6 h-6 flex items-center justify-center rounded text-white/15 hover:text-red-400 hover:bg-red-500/10">
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
                <div className="flex gap-2">
                  <Button size="sm" variant={cardSide === "home" ? "default" : "outline"} onClick={() => { setCardSide("home"); setCardPlayerId(""); }} className="flex-1 text-xs">{homeName}</Button>
                  <Button size="sm" variant={cardSide === "away" ? "default" : "outline"} onClick={() => { setCardSide("away"); setCardPlayerId(""); }} className="flex-1 text-xs">{awayName}</Button>
                </div>
                {cardSide && (
                  <>
                    {(cardSide === "home" ? homePlayers : awayPlayers).length > 0 && (
                      <select value={cardPlayerId} onChange={e => { setCardPlayerId(e.target.value); if (e.target.value) setCardTyped(""); }}
                        className="w-full bg-white/[0.02] border border-white/10 text-white text-sm rounded-md px-3 py-2">
                        <option value="">Pick player…</option>
                        {(cardSide === "home" ? homePlayers : awayPlayers).map(p => <option key={p.id} value={p.id}>#{p.shirtNumber ?? "—"} {p.firstName} {p.lastName}</option>)}
                      </select>
                    )}
                    <div className="flex gap-2 items-center">
                      <Input type="text" placeholder={(cardSide === "home" ? homePlayers : awayPlayers).length > 0 ? "…or type a name" : "Type the player's name"}
                        value={cardTyped} onChange={e => { setCardTyped(e.target.value); if (e.target.value) setCardPlayerId(""); }} className="text-sm flex-1" />
                      <Input type="number" min="0" max="120" placeholder="Min" value={cardMinute} onChange={e => setCardMinute(e.target.value)} className="w-16 text-sm" />
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => addCard("yellow")} disabled={(!cardPlayerId && !cardTyped.trim()) || addCardMut.isPending}
                        className="flex-1 bg-yellow-500/90 hover:bg-yellow-500 text-black text-xs font-semibold">🟨 Yellow</Button>
                      <Button size="sm" onClick={() => addCard("red")} disabled={(!cardPlayerId && !cardTyped.trim()) || addCardMut.isPending}
                        className="flex-1 bg-red-600 hover:bg-red-700 text-white text-xs font-semibold">🟥 Red</Button>
                    </div>
                  </>
                )}
              </div>

              {/* MVP votes — admin only */}
              <div className="border-t border-white/5 pt-4 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="text-xs text-white/40 uppercase tracking-wide flex items-center gap-1.5"><Award className="w-3.5 h-3.5" /> MVP votes</div>
                  <span className="text-[10px] text-amber-400/70 flex items-center gap-1"><Shield className="w-2.5 h-2.5" /> Private</span>
                </div>
                <MvpVoteRow
                  voterLabel={homeName} targetLabel={awayName} players={awayPlayers}
                  currentName={nameOf(mvpByVoter.get(game.homeTeamId!))}
                  onSave={v => mvpMut.mutate({ voterTeamId: game.homeTeamId, ...v })}
                  onClear={() => mvpDelMut.mutate(game.homeTeamId!)} disabled={mvpMut.isPending}
                />
                <MvpVoteRow
                  voterLabel={awayName} targetLabel={homeName} players={homePlayers}
                  currentName={nameOf(mvpByVoter.get(game.awayTeamId!))}
                  onSave={v => mvpMut.mutate({ voterTeamId: game.awayTeamId, ...v })}
                  onClear={() => mvpDelMut.mutate(game.awayTeamId!)} disabled={mvpMut.isPending}
                />
              </div>

              {/* Goalkeeper ratings (Golden Glove) — admin only */}
              <div className="border-t border-white/5 pt-4 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="text-xs text-white/40 uppercase tracking-wide flex items-center gap-1.5"><Shield className="w-3.5 h-3.5" /> Goalkeeper rating</div>
                  <span className="text-[10px] text-amber-400/70 flex items-center gap-1"><Shield className="w-2.5 h-2.5" /> Referee · private</span>
                </div>
                <GkRatingRow
                  teamLabel={homeName} players={homePlayers}
                  currentName={nameOf(gkByTeam.get(game.homeTeamId!)?.playerId)} currentRating={gkByTeam.get(game.homeTeamId!)?.rating ?? null}
                  onSave={v => gkMut.mutate({ teamId: game.homeTeamId, ...v })}
                  onClear={() => gkDelMut.mutate(game.homeTeamId!)} disabled={gkMut.isPending}
                />
                <GkRatingRow
                  teamLabel={awayName} players={awayPlayers}
                  currentName={nameOf(gkByTeam.get(game.awayTeamId!)?.playerId)} currentRating={gkByTeam.get(game.awayTeamId!)?.rating ?? null}
                  onSave={v => gkMut.mutate({ teamId: game.awayTeamId, ...v })}
                  onClear={() => gkDelMut.mutate(game.awayTeamId!)} disabled={gkMut.isPending}
                />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ScheduleTab({ tournament }: { tournament: Tournament }) {
  const { toast } = useToast();
  const tournamentId = tournament.id;
  const [goalsModalGame, setGoalsModalGame] = useState<GameWithRelations | null>(null);
  const [editingGameId, setEditingGameId] = useState<number | null>(null);
  const [editTime, setEditTime] = useState("");
  const [editField, setEditField] = useState("");
  const [editDate, setEditDate] = useState("");

  const { data: games = [], isLoading } = useQuery<GameWithRelations[]>({
    queryKey: ["/api/admin/tournament/tournaments", tournamentId, "games"],
    queryFn: () => fetch(`/api/admin/tournament/tournaments/${tournamentId}/games`).then(r => r.json()),
  });

  const generateMut = useMutation({
    mutationFn: () => apiRequest("POST", `/api/admin/tournament/tournaments/${tournamentId}/generate-schedule`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/tournament/tournaments", tournamentId, "games"] });
      toast({ title: "Schedule generated" });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const updateGameMut = useMutation({
    mutationFn: ({ id, data }: { id: number; data: any }) => apiRequest("PATCH", `/api/admin/tournament/games/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/tournament/tournaments", tournamentId, "games"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/tournament/tournaments", tournamentId, "standings"] });
    },
  });

  // Bulk pitch move — e.g. a pitch floods: move EVERY game on one field to another
  // in one click (no per-game back-and-forth). Admins can also just type a new
  // "to" pitch (any venue). "from" blank = games with no pitch set.
  const [reassignFrom, setReassignFrom] = useState("");
  const [reassignTo, setReassignTo] = useState("");
  const bulkReassignMut = useMutation({
    mutationFn: async () => {
      const from = reassignFrom.trim(), to = reassignTo.trim();
      const affected = games.filter(g => (g.field || "") === from);
      for (const g of affected) await apiRequest("PATCH", `/api/admin/tournament/games/${g.id}`, { field: to || null });
      return { n: affected.length, from, to };
    },
    onSuccess: ({ n, from, to }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/tournament/tournaments", tournamentId, "games"] });
      toast({ title: `Moved ${n} game${n === 1 ? "" : "s"}`, description: `${from || "—"} → ${to || "—"}` });
      setReassignFrom(""); setReassignTo("");
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  // Tournament-level live-stream URL — the default "Watch" destination for the
  // whole age group. Admins mark individual games "Go Live" (below); the app
  // shows a LIVE badge + a Watch button that opens this URL.
  const [streamUrl, setStreamUrl] = useState(tournament.streamUrl || "");
  const streamUrlMut = useMutation({
    mutationFn: (url: string) => apiRequest("PATCH", `/api/admin/tournament/tournaments/${tournamentId}`, { streamUrl: url.trim() || null }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/tournament/tournaments", tournamentId] });
      toast({ title: "Live stream saved", description: "This is where the app's Watch button will send viewers." });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  // Teams for this tournament — used to let admins assign teams into knockout
  // slots that have no auto-fill rule (the U10–U14 finals).
  const { data: teams = [] } = useQuery<(TournamentTeam & { group?: TournamentGroup })[]>({
    queryKey: ["/api/admin/tournament/tournaments", tournamentId, "teams"],
    queryFn: () => fetch(`/api/admin/tournament/tournaments/${tournamentId}/teams`).then(r => r.json()),
  });
  const sortedTeams = useMemo(() => [...teams].sort((a, b) => a.name.localeCompare(b.name)), [teams]);

  // Belt-and-braces: re-flow the bracket from current pool standings + results.
  // (This also runs automatically on every score save server-side.)
  const resolveBracketsMut = useMutation({
    mutationFn: () => apiRequest("POST", `/api/admin/tournament/tournaments/${tournamentId}/resolve-brackets`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/tournament/tournaments", tournamentId, "games"] });
      toast({ title: "Brackets updated", description: "Knockout slots filled from current standings & results." });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  // Manual override: set the team AND clear the auto-fill placeholder, so the
  // bracket resolver won't overwrite the admin's choice on the next score save.
  // Lets admins instantly correct/seed any knockout slot when the draw is a
  // one-off exception (bye, undersized pool, etc.) — speed of comms is critical.
  const assignTeam = (gameId: number, side: "home" | "away", teamId: number) =>
    updateGameMut.mutate({
      id: gameId,
      data: {
        [side === "home" ? "homeTeamId" : "awayTeamId"]: teamId,
        [side === "home" ? "homeTeamPlaceholder" : "awayTeamPlaceholder"]: null,
      },
    });

  const startEditing = (game: GameWithRelations) => {
    setEditingGameId(game.id);
    setEditTime(game.startTime || "");
    setEditField(game.field || "");
    setEditDate(game.gameDate || "");
  };

  const saveEditing = () => {
    if (editingGameId) {
      updateGameMut.mutate({
        id: editingGameId,
        data: {
          startTime: editTime || null,
          field: editField.trim() || null,
          gameDate: editDate || null,
        },
      });
      setEditingGameId(null);
    }
  };

  const groupGames = games.filter(g => g.stage === "group");
  const knockoutAndFinalGames = games.filter(g => g.stage !== "group");

  const groupGamesByDate = useMemo(() => {
    const map = new Map<string, GameWithRelations[]>();
    const sorted = [...groupGames].sort((a, b) => {
      const dateA = a.gameDate || "9999";
      const dateB = b.gameDate || "9999";
      if (dateA !== dateB) return dateA.localeCompare(dateB);
      const timeA = a.startTime || "99:99";
      const timeB = b.startTime || "99:99";
      if (timeA !== timeB) return timeA.localeCompare(timeB);
      return (a.gameNumber || 0) - (b.gameNumber || 0);
    });
    for (const game of sorted) {
      const key = game.gameDate || "unscheduled";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(game);
    }
    return map;
  }, [groupGames]);

  const knockoutByDate = useMemo(() => {
    const map = new Map<string, GameWithRelations[]>();
    const sorted = [...knockoutAndFinalGames].sort((a, b) => {
      const dateA = a.gameDate || "9999";
      const dateB = b.gameDate || "9999";
      if (dateA !== dateB) return dateA.localeCompare(dateB);
      const timeA = a.startTime || "99:99";
      const timeB = b.startTime || "99:99";
      if (timeA !== timeB) return timeA.localeCompare(timeB);
      return (a.gameNumber || 0) - (b.gameNumber || 0);
    });
    for (const game of sorted) {
      const key = game.gameDate || "unscheduled";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(game);
    }
    return map;
  }, [knockoutAndFinalGames]);

  const formatDateHeader = (dateStr: string) => {
    if (dateStr === "unscheduled") return "Unscheduled";
    const d = new Date(dateStr + "T12:00:00");
    return d.toLocaleDateString("en-NZ", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  };

  const renderScheduleTable = (gamesForDate: GameWithRelations[], isKnockout: boolean) => (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" data-testid="schedule-table">
        <thead>
          <tr className="border-b border-white/[0.06]">
            <th className="text-left px-3 py-2 text-[10px] text-white/25 uppercase tracking-wider font-semibold w-10">Rd</th>
            <th className="text-left px-3 py-2 text-[10px] text-white/25 uppercase tracking-wider font-semibold w-28">{isKnockout ? "Stage" : "Pool"}</th>
            <th className="text-left px-3 py-2 text-[10px] text-white/25 uppercase tracking-wider font-semibold w-16">Time</th>
            <th className="text-center px-2 py-2 text-[10px] text-white/25 uppercase tracking-wider font-semibold w-14">Game #</th>
            <th className="text-center px-2 py-2 text-[10px] text-white/25 uppercase tracking-wider font-semibold w-14">Field</th>
            <th className="text-right px-3 py-2 text-[10px] text-white/25 uppercase tracking-wider font-semibold">Home Team</th>
            <th className="text-center px-1 py-2 text-[10px] text-white/25 uppercase tracking-wider font-semibold w-20">Score</th>
            <th className="text-left px-3 py-2 text-[10px] text-white/25 uppercase tracking-wider font-semibold">Away Team</th>
            <th className="w-20 px-2 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {gamesForDate.map(game => {
            const isEditing = editingGameId === game.id;
            const homeName = game.homeTeam?.name || game.homeTeamPlaceholder || "TBD";
            const awayName = game.awayTeam?.name || game.awayTeamPlaceholder || "TBD";
            const poolLabel = game.group?.name?.replace("Group ", "Pool ") || game.stageDetail || game.stage;

            return (
              <tr
                key={game.id}
                className="border-b border-white/[0.03] hover:bg-white/[0.015] transition-colors"
                data-testid={`game-row-${game.id}`}
              >
                <td className="px-3 py-2.5 text-xs text-white/25 font-mono">{game.roundNumber || "—"}</td>
                <td className="px-3 py-2.5">
                  <span className="text-xs text-white/40 font-medium">{poolLabel}</span>
                </td>
                <td className="px-3 py-2.5">
                  {isEditing ? (
                    <TimePickerInput
                      value={editTime}
                      onChange={e => setEditTime(e.target.value)}
                      className="w-24 h-7 text-xs premium-input text-white"
                      data-testid={`input-time-${game.id}`}
                    />
                  ) : (
                    <span className="text-xs text-white/50 font-mono" data-testid={`text-time-${game.id}`}>
                      {game.startTime || "—"}
                    </span>
                  )}
                </td>
                <td className="px-2 py-2.5 text-center">
                  <span className="text-xs text-white/20 font-mono">#{game.gameNumber}</span>
                </td>
                <td className="px-2 py-2.5 text-center">
                  {isEditing ? (
                    <>
                      {/* Free-text pitch: pick a common one or type any value (S3, S4, new venue…) */}
                      <input
                        list="cic-field-options"
                        value={editField}
                        onChange={e => setEditField(e.target.value)}
                        placeholder="Pitch"
                        className="w-24 h-7 text-xs premium-input text-white px-2 rounded-md text-center"
                        data-testid={`input-field-${game.id}`}
                      />
                    </>
                  ) : (
                    <span className={`text-xs font-medium ${game.field ? "text-blue-400/70" : "text-white/15"}`} data-testid={`text-field-${game.id}`}>
                      {game.field || "—"}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2.5 text-right">
                  {isKnockout ? (
                    <div className="flex flex-col items-end gap-0.5">
                      <Select value={game.homeTeamId ? String(game.homeTeamId) : ""} onValueChange={v => assignTeam(game.id, "home", Number(v))}>
                        <SelectTrigger className="w-44 h-7 text-xs premium-input text-white ml-auto" data-testid={`select-home-team-${game.id}`}>
                          <SelectValue placeholder={game.homeTeamPlaceholder || "Assign team"} />
                        </SelectTrigger>
                        <SelectContent>
                          {sortedTeams.map(t => <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>)}
                        </SelectContent>
                      </Select>
                      {game.homeTeamPlaceholder
                        ? <span className="text-[10px] text-white/25">auto · {game.homeTeamPlaceholder}</span>
                        : game.homeTeamId
                          ? <span className="text-[10px] text-amber-400/60">manual override</span>
                          : null}
                    </div>
                  ) : (
                    <span className="text-sm text-white/70 font-medium">{homeName}</span>
                  )}
                </td>
                <td className="px-1 py-2.5">
                  {game.status === "final" ? (
                    <div className="flex items-center justify-center gap-1">
                      <span className="text-sm font-bold text-white/90 w-6 text-right">{game.homeScore}</span>
                      <span className="text-white/20 text-xs">-</span>
                      <span className="text-sm font-bold text-white/90 w-6 text-left">{game.awayScore}</span>
                    </div>
                  ) : (
                    <div className="flex items-center justify-center gap-1">
                      <Input
                        type="number" min="0"
                        className="w-8 h-6 text-xs text-center premium-input text-white p-0"
                        defaultValue={game.homeScore ?? ""}
                        onBlur={e => { const v = e.target.value; if (v !== "") updateGameMut.mutate({ id: game.id, data: { homeScore: parseInt(v) } }); }}
                        data-testid={`input-home-score-${game.id}`}
                      />
                      <span className="text-white/20 text-xs">-</span>
                      <Input
                        type="number" min="0"
                        className="w-8 h-6 text-xs text-center premium-input text-white p-0"
                        defaultValue={game.awayScore ?? ""}
                        onBlur={e => { const v = e.target.value; if (v !== "") updateGameMut.mutate({ id: game.id, data: { awayScore: parseInt(v) } }); }}
                        data-testid={`input-away-score-${game.id}`}
                      />
                    </div>
                  )}
                </td>
                <td className="px-3 py-2.5 text-left">
                  {isKnockout ? (
                    <div className="flex flex-col items-start gap-0.5">
                      <Select value={game.awayTeamId ? String(game.awayTeamId) : ""} onValueChange={v => assignTeam(game.id, "away", Number(v))}>
                        <SelectTrigger className="w-44 h-7 text-xs premium-input text-white" data-testid={`select-away-team-${game.id}`}>
                          <SelectValue placeholder={game.awayTeamPlaceholder || "Assign team"} />
                        </SelectTrigger>
                        <SelectContent>
                          {sortedTeams.map(t => <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>)}
                        </SelectContent>
                      </Select>
                      {game.awayTeamPlaceholder
                        ? <span className="text-[10px] text-white/25">auto · {game.awayTeamPlaceholder}</span>
                        : game.awayTeamId
                          ? <span className="text-[10px] text-amber-400/60">manual override</span>
                          : null}
                    </div>
                  ) : (
                    <span className="text-sm text-white/70 font-medium">{awayName}</span>
                  )}
                </td>
                <td className="px-2 py-2.5">
                  <div className="flex items-center gap-1 justify-end">
                    {isEditing ? (
                      <button
                        onClick={saveEditing}
                        className="w-6 h-6 flex items-center justify-center rounded-md bg-green-500/15 text-green-400 hover:bg-green-500/25"
                        data-testid={`button-save-edit-${game.id}`}
                      >
                        <Check className="w-3.5 h-3.5" />
                      </button>
                    ) : (
                      <button
                        onClick={() => startEditing(game)}
                        className="w-6 h-6 flex items-center justify-center rounded-md text-white/15 hover:text-white/40 hover:bg-white/5"
                        data-testid={`button-edit-game-${game.id}`}
                      >
                        <Pencil className="w-3 h-3" />
                      </button>
                    )}
                    {(game.homeTeamId || game.awayTeamId) && (
                      <button
                        onClick={() => setGoalsModalGame(game)}
                        className="w-6 h-6 flex items-center justify-center rounded-md text-white/15 hover:text-yellow-400 hover:bg-yellow-500/10"
                        title="Record goals"
                        data-testid={`button-goals-${game.id}`}
                      >
                        <Goal className="w-3.5 h-3.5" />
                      </button>
                    )}
                    {game.status !== "final" && (
                      game.isLive ? (
                        <button
                          onClick={() => updateGameMut.mutate({ id: game.id, data: { isLive: false } })}
                          className="flex items-center gap-1 text-[9px] px-2 py-0.5 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30 font-bold"
                          title="Stop streaming this game"
                          data-testid={`button-end-live-${game.id}`}
                        >
                          <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" /> LIVE
                        </button>
                      ) : (
                        <button
                          onClick={() => updateGameMut.mutate({ id: game.id, data: { isLive: true } })}
                          className="text-[9px] px-2 py-0.5 rounded bg-white/5 text-white/40 hover:text-red-400 hover:bg-red-500/10"
                          title="Mark this game live (shows a LIVE badge + Watch button in the app)"
                          data-testid={`button-go-live-${game.id}`}
                        >
                          Go Live
                        </button>
                      )
                    )}
                    {game.status !== "final" && game.homeScore !== null && game.awayScore !== null && (
                      <button
                        onClick={() => updateGameMut.mutate({ id: game.id, data: { status: "final", isLive: false } })}
                        className="text-[9px] px-2 py-0.5 rounded bg-green-500/15 text-green-400 hover:bg-green-500/25"
                        data-testid={`button-confirm-score-${game.id}`}
                      >
                        Confirm
                      </button>
                    )}
                    {game.status === "final" && (
                      <span className="text-[9px] px-2 py-0.5 rounded bg-blue-500/10 text-blue-400">Final</span>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  if (games.length === 0) {
    return (
      <div className="rounded-2xl border border-blue-500/10 bg-white/[0.02] p-10 text-center">
        <Calendar className="w-10 h-10 text-white/10 mx-auto mb-3" />
        <p className="text-sm text-white/30 mb-4">No schedule generated yet</p>
        <Button onClick={() => generateMut.mutate()} disabled={generateMut.isPending} className="bg-blue-600 hover:bg-blue-700 text-white" data-testid="button-generate-schedule">
          Generate Schedule
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Live stream — the destination the app's "Watch Live" button opens */}
      <div className="rounded-xl border border-red-500/15 bg-red-500/[0.03] px-4 py-3 flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2 text-xs font-semibold text-red-300/90">
          <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" /> Live stream
        </div>
        <Input
          value={streamUrl}
          onChange={e => setStreamUrl(e.target.value)}
          placeholder="Paste the streaming link (e.g. https://watch.cicyouth.com/u12) — leave blank until it's ready"
          className="flex-1 min-w-[240px] h-8 text-xs premium-input text-white"
          data-testid="input-tournament-stream-url"
        />
        <button
          onClick={() => streamUrlMut.mutate(streamUrl)}
          disabled={streamUrlMut.isPending || streamUrl === (tournament.streamUrl || "")}
          className="text-xs px-3 py-1.5 rounded-md bg-red-500/20 text-red-300 hover:bg-red-500/30 disabled:opacity-40 font-medium"
          data-testid="button-save-stream-url"
        >
          Save
        </button>
        <span className="w-full text-[10px] text-white/30 sm:w-auto sm:ml-1">
          Then hit <span className="text-red-300/80">Go Live</span> on whichever game is on camera.
        </span>
      </div>

      {/* One shared list of common pitches — powers every "pitch" input below. */}
      <datalist id="cic-field-options">
        {FIELDS.map(f => <option key={f} value={f} />)}
      </datalist>

      {/* Bulk pitch move — a flooded/changed pitch: move every game on it at once. */}
      <div className="rounded-xl border border-blue-500/15 bg-blue-500/[0.03] px-4 py-3 flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-2 text-xs font-semibold text-blue-300/90">
          <MapPin className="w-3.5 h-3.5" /> Move pitch
        </div>
        <input
          list="cic-field-options" value={reassignFrom} onChange={e => setReassignFrom(e.target.value)}
          placeholder="From (e.g. S1)" className="w-32 h-8 text-xs premium-input text-white px-2 rounded-md"
          data-testid="input-reassign-from"
        />
        <span className="text-white/30 text-xs">→</span>
        <input
          list="cic-field-options" value={reassignTo} onChange={e => setReassignTo(e.target.value)}
          placeholder="To (e.g. S3, or new venue)" className="w-44 h-8 text-xs premium-input text-white px-2 rounded-md"
          data-testid="input-reassign-to"
        />
        <button
          onClick={() => bulkReassignMut.mutate()}
          disabled={bulkReassignMut.isPending || !reassignTo.trim()}
          className="text-xs px-3 py-1.5 rounded-md bg-blue-500/20 text-blue-300 hover:bg-blue-500/30 disabled:opacity-40 font-medium"
          data-testid="button-reassign-pitch"
        >
          {bulkReassignMut.isPending
            ? "Moving…"
            : `Move all ${reassignFrom.trim() ? `"${reassignFrom.trim()}"` : "unassigned"} games`}
        </button>
        <span className="w-full text-[10px] text-white/30 sm:w-auto sm:ml-1">
          Pitch flooded or changed? Move every game on one pitch to another instantly.
        </span>
      </div>

      {groupGames.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <h3 className="text-sm font-semibold text-white">Group Stage</h3>
            <span className="text-[10px] text-white/20 bg-white/5 px-2 py-0.5 rounded-full">{groupGames.length} games</span>
          </div>
          {Array.from(groupGamesByDate.entries()).map(([dateKey, gamesForDate]) => (
            <div key={dateKey} className="mb-4">
              <div className="px-3 py-2 bg-white/[0.03] border border-white/[0.05] rounded-t-xl">
                <h4 className="text-xs font-semibold text-white/50 flex items-center gap-2" data-testid={`date-header-${dateKey}`}>
                  <Calendar className="w-3.5 h-3.5 text-white/25" />
                  {formatDateHeader(dateKey)}
                </h4>
              </div>
              <div className="rounded-b-xl border border-t-0 border-white/[0.05] bg-white/[0.01] overflow-hidden">
                {renderScheduleTable(gamesForDate, false)}
              </div>
            </div>
          ))}
        </div>
      )}

      {knockoutAndFinalGames.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <h3 className="text-sm font-semibold text-white">Knockout & Finals</h3>
            <span className="text-[10px] text-white/20 bg-white/5 px-2 py-0.5 rounded-full">{knockoutAndFinalGames.length} games</span>
            <button
              onClick={() => resolveBracketsMut.mutate()}
              disabled={resolveBracketsMut.isPending}
              className="ml-auto text-[10px] px-2.5 py-1 rounded-md bg-blue-500/15 text-blue-300 hover:bg-blue-500/25 disabled:opacity-50 flex items-center gap-1"
              title="Fill knockout slots from current pool standings & results"
              data-testid="button-resolve-brackets"
            >
              <RefreshCw className={`w-3 h-3 ${resolveBracketsMut.isPending ? "animate-spin" : ""}`} /> Recompute brackets
            </button>
          </div>
          <p className="text-[11px] text-white/35 mb-3 leading-relaxed">
            Slots fill automatically as results come in (<span className="text-white/45">auto · CODE</span>). To handle
            a one-off (bye, undersized pool, late change), just pick any team from a dropdown — that
            <span className="text-amber-400/70"> locks it in (manual override)</span> and it won't be auto-changed.
            Goes live instantly.
          </p>
          {Array.from(knockoutByDate.entries()).map(([dateKey, gamesForDate]) => (
            <div key={dateKey} className="mb-4">
              <div className="px-3 py-2 bg-white/[0.03] border border-white/[0.05] rounded-t-xl">
                <h4 className="text-xs font-semibold text-white/50 flex items-center gap-2" data-testid={`date-header-ko-${dateKey}`}>
                  <Calendar className="w-3.5 h-3.5 text-white/25" />
                  {formatDateHeader(dateKey)}
                </h4>
              </div>
              <div className="rounded-b-xl border border-t-0 border-white/[0.05] bg-white/[0.01] overflow-hidden">
                {renderScheduleTable(gamesForDate, true)}
              </div>
            </div>
          ))}
        </div>
      )}

      {editingGameId && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-[#0a0e1a] border border-blue-500/20 rounded-xl px-4 py-2.5 shadow-2xl flex items-center gap-3 z-50">
          <span className="text-xs text-white/40">Edit date:</span>
          <DatePickerInput
            value={editDate}
            onChange={e => setEditDate(e.target.value)}
            className="w-36 h-7 text-xs premium-input text-white"
            data-testid="input-edit-date"
          />
          <Button onClick={saveEditing} size="sm" className="bg-blue-600 hover:bg-blue-700 text-white h-7 text-xs gap-1">
            <Check className="w-3 h-3" /> Save
          </Button>
          <button onClick={() => setEditingGameId(null)} className="text-white/30 hover:text-white/60">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {goalsModalGame && <GameGoalsModal game={goalsModalGame} onClose={() => setGoalsModalGame(null)} />}
    </div>
  );
}

function GroupsTab({ tournament }: { tournament: Tournament }) {
  const { toast } = useToast();
  const tournamentId = tournament.id;
  const [showTeamModal, setShowTeamModal] = useState(false);

  const { data: groups = [] } = useQuery<TournamentGroup[]>({
    queryKey: ["/api/admin/tournament/tournaments", tournamentId, "groups"],
    queryFn: () => fetch(`/api/admin/tournament/tournaments/${tournamentId}/groups`).then(r => r.json()),
  });

  const { data: teams = [] } = useQuery<(TournamentTeam & { group?: TournamentGroup })[]>({
    queryKey: ["/api/admin/tournament/tournaments", tournamentId, "teams"],
    queryFn: () => fetch(`/api/admin/tournament/tournaments/${tournamentId}/teams`).then(r => r.json()),
  });

  const { data: standings = [] } = useQuery<any[]>({
    queryKey: ["/api/admin/tournament/tournaments", tournamentId, "standings"],
    queryFn: () => fetch(`/api/admin/tournament/tournaments/${tournamentId}/standings`).then(r => r.json()),
  });

  const generateGroupsMut = useMutation({
    mutationFn: () => apiRequest("POST", `/api/admin/tournament/tournaments/${tournamentId}/generate-groups`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/tournament/tournaments", tournamentId, "groups"] });
      toast({ title: "Groups created" });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const assignTeamMut = useMutation({
    mutationFn: ({ teamId, groupId }: { teamId: number; groupId: number | null }) =>
      apiRequest("PATCH", `/api/admin/tournament/teams/${teamId}`, { groupId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/tournament/tournaments", tournamentId, "teams"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/tournament/tournaments", tournamentId, "standings"] });
    },
  });

  const unassigned = teams.filter(t => !t.groupId);

  const handleDragStart = (e: React.DragEvent, teamId: number) => {
    e.dataTransfer.setData("teamId", String(teamId));
  };

  const handleDrop = (e: React.DragEvent, groupId: number | null) => {
    e.preventDefault();
    const teamId = parseInt(e.dataTransfer.getData("teamId"));
    assignTeamMut.mutate({ teamId, groupId });
  };

  return (
    <div className="space-y-6">
      {groups.length === 0 ? (
        <div className="rounded-2xl border border-blue-500/10 bg-white/[0.02] p-10 text-center">
          <LayoutGrid className="w-10 h-10 text-white/10 mx-auto mb-3" />
          <p className="text-sm text-white/30 mb-4">No groups created yet</p>
          <Button onClick={() => generateGroupsMut.mutate()} disabled={generateGroupsMut.isPending} className="bg-blue-600 hover:bg-blue-700 text-white" data-testid="button-generate-groups">
            Generate {tournament.numGroups} Groups
          </Button>
        </div>
      ) : (
        <Fragment>
          {unassigned.length > 0 && (
            <div
              className="rounded-2xl border border-dashed border-yellow-500/20 bg-yellow-500/5 p-4"
              onDragOver={e => e.preventDefault()}
              onDrop={e => handleDrop(e, null)}
            >
              <h4 className="text-xs font-semibold text-yellow-400/70 uppercase tracking-wider mb-3">Unassigned Teams ({unassigned.length})</h4>
              <div className="flex flex-wrap gap-2">
                {unassigned.map(team => (
                  <div
                    key={team.id}
                    draggable
                    onDragStart={e => handleDragStart(e, team.id)}
                    className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 cursor-grab active:cursor-grabbing"
                    data-testid={`draggable-team-${team.id}`}
                  >
                    <GripVertical className="w-3 h-3 text-white/20" />
                    <span className="text-xs text-white/60">{team.name}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {groups.map(group => {
              const groupTeams = teams.filter(t => t.groupId === group.id);
              const groupStandings = standings.filter(s => s.groupId === group.id);
              return (
                <div
                  key={group.id}
                  className="rounded-2xl border border-blue-500/10 bg-white/[0.02]"
                  onDragOver={e => e.preventDefault()}
                  onDrop={e => handleDrop(e, group.id)}
                  data-testid={`group-card-${group.id}`}
                >
                  <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between">
                    <h4 className="text-sm font-semibold text-white">{group.name}</h4>
                    <span className="text-[10px] text-white/20">{groupTeams.length}/{tournament.teamsPerGroup}</span>
                  </div>
                  {groupStandings.length > 0 ? (
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-white/20">
                          <th className="text-left px-3 py-1.5">#</th>
                          <th className="text-left px-3 py-1.5">Team</th>
                          <th className="text-center px-1 py-1.5">MP</th>
                          <th className="text-center px-1 py-1.5">W</th>
                          <th className="text-center px-1 py-1.5">D</th>
                          <th className="text-center px-1 py-1.5">L</th>
                          <th className="text-center px-1 py-1.5">GD</th>
                          <th className="text-center px-1 py-1.5 font-bold">Pts</th>
                        </tr>
                      </thead>
                      <tbody>
                        {groupStandings.map((s, i) => (
                          <tr key={s.teamId} className="border-t border-white/[0.03] hover:bg-white/[0.02]" data-testid={`standing-row-${s.teamId}`}>
                            <td className="px-3 py-1.5 text-white/20">{i + 1}</td>
                            <td className="px-3 py-1.5">
                              <div
                                draggable
                                onDragStart={e => handleDragStart(e, s.teamId)}
                                className="flex items-center gap-1.5 cursor-grab active:cursor-grabbing"
                              >
                                <GripVertical className="w-3 h-3 text-white/10" />
                                <span className="text-white/60">{s.teamName}</span>
                              </div>
                            </td>
                            <td className="text-center px-1 py-1.5 text-white/40">{s.mp}</td>
                            <td className="text-center px-1 py-1.5 text-white/40">{s.w}</td>
                            <td className="text-center px-1 py-1.5 text-white/40">{s.d}</td>
                            <td className="text-center px-1 py-1.5 text-white/40">{s.l}</td>
                            <td className="text-center px-1 py-1.5 text-white/40">{s.gd > 0 ? `+${s.gd}` : s.gd}</td>
                            <td className="text-center px-1 py-1.5 font-bold text-white/70">{s.pts}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <div className="p-4 space-y-1">
                      {groupTeams.map(team => (
                        <div
                          key={team.id}
                          draggable
                          onDragStart={e => handleDragStart(e, team.id)}
                          className="flex items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-white/[0.02] cursor-grab active:cursor-grabbing"
                        >
                          <GripVertical className="w-3 h-3 text-white/10" />
                          <span className="text-xs text-white/60">{team.name}</span>
                        </div>
                      ))}
                      {groupTeams.length === 0 && (
                        <p className="text-xs text-white/15 text-center py-4">Drop teams here</p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Fragment>
      )}
    </div>
  );
}

function TeamsTab({ tournament }: { tournament: Tournament }) {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const tournamentId = tournament.id;
  const [showModal, setShowModal] = useState(false);
  const [teamForm, setTeamForm] = useState({ name: "", clubName: "", contactName: "", contactEmail: "", contactPhone: "" });

  const { data: teams = [], isLoading } = useQuery<(TournamentTeam & { group?: TournamentGroup; playerCount?: number; rosterStatus?: string | null })[]>({
    queryKey: ["/api/admin/tournament/tournaments", tournamentId, "teams"],
    queryFn: () => fetch(`/api/admin/tournament/tournaments/${tournamentId}/teams`).then(r => r.json()),
  });
  const missingRosters = teams.filter(t => t.rosterStatus === "missing").length;

  const createMut = useMutation({
    mutationFn: (data: any) => apiRequest("POST", "/api/admin/tournament/teams", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/tournament/tournaments", tournamentId, "teams"] });
      toast({ title: "Team added" });
      setShowModal(false);
      setTeamForm({ name: "", clubName: "", contactName: "", contactEmail: "", contactPhone: "" });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/admin/tournament/teams/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/tournament/tournaments", tournamentId, "teams"] });
      toast({ title: "Team deleted" });
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <p className="text-sm text-white/40">{teams.length} team{teams.length !== 1 ? "s" : ""}</p>
          {missingRosters > 0 && (
            <span className="text-xs px-2.5 py-1 rounded-full bg-red-500/15 text-red-400 font-medium" data-testid="badge-missing-rosters">
              ⚠ {missingRosters} missing squad{missingRosters === 1 ? "" : "s"}
            </span>
          )}
        </div>
        <Button onClick={() => setShowModal(true)} className="bg-blue-600 hover:bg-blue-700 text-white gap-2" data-testid="button-add-team">
          <Plus className="w-4 h-4" />Add Team
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-2">{[1, 2, 3].map(i => <div key={i} className="h-14 rounded-xl bg-white/[0.02] animate-pulse" />)}</div>
      ) : teams.length === 0 ? (
        <div className="rounded-2xl border border-blue-500/10 bg-white/[0.02] p-10 text-center">
          <Shield className="w-10 h-10 text-white/10 mx-auto mb-3" />
          <p className="text-sm text-white/30">No teams registered yet</p>
        </div>
      ) : (
        <div className="rounded-2xl border border-blue-500/10 bg-white/[0.02] overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-white/5">
                <th className="text-left text-[10px] text-white/30 uppercase tracking-wider font-semibold px-5 py-2.5">Team</th>
                <th className="text-left text-[10px] text-white/30 uppercase tracking-wider font-semibold px-5 py-2.5 hidden sm:table-cell">Club</th>
                <th className="text-left text-[10px] text-white/30 uppercase tracking-wider font-semibold px-5 py-2.5">Group</th>
                <th className="text-left text-[10px] text-white/30 uppercase tracking-wider font-semibold px-5 py-2.5">Roster</th>
                <th className="text-left text-[10px] text-white/30 uppercase tracking-wider font-semibold px-5 py-2.5 hidden sm:table-cell">Contact</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {teams.map(t => (
                <tr
                  key={t.id}
                  className="border-b border-white/[0.03] hover:bg-white/[0.02] cursor-pointer transition-colors"
                  onClick={() => setLocation(`/admin/tournaments/${tournamentId}/teams/${t.id}`)}
                  data-testid={`team-row-${t.id}`}
                >
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold text-white/70" style={{ background: t.primaryColor ? `${t.primaryColor}30` : "rgba(255,255,255,0.05)" }}>
                        {t.name.charAt(0)}
                      </div>
                      <span className="text-sm font-medium text-white/80">{t.name}</span>
                    </div>
                  </td>
                  <td className="px-5 py-3 text-xs text-white/40 hidden sm:table-cell">{t.clubName || "—"}</td>
                  <td className="px-5 py-3">
                    {t.group ? (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400/70">{t.group.name}</span>
                    ) : (
                      <span className="text-xs text-white/20">Unassigned</span>
                    )}
                  </td>
                  <td className="px-5 py-3">
                    {t.rosterStatus === "missing" ? (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/15 text-red-400 font-medium whitespace-nowrap" title="No squad list submitted — follow up with the club">⚠ No squad</span>
                    ) : (t.playerCount ?? 0) > 0 ? (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/10 text-green-400/80 whitespace-nowrap">{t.playerCount} player{t.playerCount === 1 ? "" : "s"}</span>
                    ) : (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400/80 whitespace-nowrap" title="Squad submitted but not entered into ClubOS yet">Pending entry</span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-xs text-white/40 hidden sm:table-cell">{t.contactName || "—"}</td>
                  <td className="px-3 py-3">
                    <button
                      onClick={e => { e.stopPropagation(); deleteMut.mutate(t.id); }}
                      className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-red-500/10 text-white/15 hover:text-red-400"
                      data-testid={`button-delete-team-${t.id}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-[#0a0e1a] border border-blue-500/15 rounded-2xl w-full max-w-md shadow-2xl">
            <div className="flex items-center justify-between p-5 border-b border-white/5">
              <h2 className="text-lg font-semibold text-white">Add Team</h2>
              <button onClick={() => setShowModal(false)} className="text-white/30 hover:text-white/60"><X className="w-5 h-5" /></button>
            </div>
            <div className="p-5 space-y-3">
              <div>
                <label className="text-xs text-white/40 mb-1 block">Team Name</label>
                <Input value={teamForm.name} onChange={e => setTeamForm(f => ({ ...f, name: e.target.value }))} className="premium-input text-white" data-testid="input-team-name" placeholder="e.g. Christchurch United Blue" />
              </div>
              <div>
                <label className="text-xs text-white/40 mb-1 block">Club Name</label>
                <Input value={teamForm.clubName} onChange={e => setTeamForm(f => ({ ...f, clubName: e.target.value }))} className="premium-input text-white" placeholder="e.g. Christchurch United FC" />
              </div>
              <div>
                <label className="text-xs text-white/40 mb-1 block">Contact Name</label>
                <Input value={teamForm.contactName} onChange={e => setTeamForm(f => ({ ...f, contactName: e.target.value }))} className="premium-input text-white" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-white/40 mb-1 block">Email</label>
                  <Input value={teamForm.contactEmail} onChange={e => setTeamForm(f => ({ ...f, contactEmail: e.target.value }))} className="premium-input text-white" />
                </div>
                <div>
                  <label className="text-xs text-white/40 mb-1 block">Phone</label>
                  <Input value={teamForm.contactPhone} onChange={e => setTeamForm(f => ({ ...f, contactPhone: e.target.value }))} className="premium-input text-white" />
                </div>
              </div>
            </div>
            <div className="p-5 border-t border-white/5 flex gap-2 justify-end">
              <Button variant="ghost" onClick={() => setShowModal(false)} className="text-white/40">Cancel</Button>
              <Button
                onClick={() => createMut.mutate({ tournamentId, ...teamForm })}
                disabled={!teamForm.name || createMut.isPending}
                className="bg-blue-600 hover:bg-blue-700 text-white"
                data-testid="button-save-team"
              >
                Add Team
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Individual Awards — live leaderboards for Golden Boot (public), plus the
// ADMIN-ONLY Golden Glove (keeper) + MVP. Golden Boot derives from goals;
// the other two derive from votes/ratings entered per game in the goals modal.
type AwardView = "boot" | "glove" | "mvp" | "cards";
function AwardsTab({ tournament }: { tournament: Tournament }) {
  const tournamentId = tournament.id;
  const [view, setView] = useState<AwardView>("boot");

  const { data: bootData = [], isLoading: bootLoading } = useQuery<any[]>({
    queryKey: ["/api/admin/tournament/tournaments", tournamentId, "top-scorers"],
    queryFn: () => fetch(`/api/admin/tournament/tournaments/${tournamentId}/top-scorers`).then(r => r.json()),
  });
  const { data: gloveData = [], isLoading: gloveLoading } = useQuery<any[]>({
    queryKey: ["/api/admin/tournament/tournaments", tournamentId, "gk-leaderboard"],
    queryFn: () => fetch(`/api/admin/tournament/tournaments/${tournamentId}/gk-leaderboard`).then(r => r.json()),
  });
  const { data: mvpData = [], isLoading: mvpLoading } = useQuery<any[]>({
    queryKey: ["/api/admin/tournament/tournaments", tournamentId, "mvp-leaderboard"],
    queryFn: () => fetch(`/api/admin/tournament/tournaments/${tournamentId}/mvp-leaderboard`).then(r => r.json()),
  });
  const { data: cardsData = [], isLoading: cardsLoading } = useQuery<any[]>({
    queryKey: ["/api/admin/tournament/tournaments", tournamentId, "discipline"],
    queryFn: () => fetch(`/api/admin/tournament/tournaments/${tournamentId}/discipline`).then(r => r.json()),
  });

  const views: { id: AwardView; label: string; icon: any }[] = [
    { id: "boot", label: "Golden Boot", icon: Goal },
    { id: "glove", label: "Golden Glove", icon: Shield },
    { id: "mvp", label: "MVP", icon: Award },
    { id: "cards", label: "Cards", icon: Square },
  ];

  const rows = view === "boot" ? bootData : view === "glove" ? gloveData : view === "mvp" ? mvpData : cardsData;
  const loading = view === "boot" ? bootLoading : view === "glove" ? gloveLoading : view === "mvp" ? mvpLoading : cardsLoading;
  const isPrivate = view !== "boot";
  const suspended = view === "cards" ? cardsData.filter((r: any) => (r.suspensions?.length ?? 0) > 0).length : 0;
  const fmtMiss = (m: any) => {
    if (!m) return "";
    const d = m.gameDate ? new Date(m.gameDate + "T12:00:00").toLocaleDateString("en-NZ", { weekday: "short", day: "numeric", month: "short" }) : "";
    return [d, m.startTime, m.field].filter(Boolean).join(" · ");
  };

  const rankBadge = (i: number) => {
    const styles = ["bg-yellow-400/20 text-yellow-300 border-yellow-400/30", "bg-white/10 text-white/60 border-white/15", "bg-amber-700/20 text-amber-500/80 border-amber-700/30"];
    return (
      <span className={`w-7 h-7 shrink-0 rounded-full border flex items-center justify-center text-xs font-semibold ${i < 3 ? styles[i] : "bg-white/[0.03] text-white/40 border-white/10"}`}>
        {i + 1}
      </span>
    );
  };

  const teamCell = (r: any) => (
    <div className="flex items-center gap-2 min-w-0">
      {r.teamLogoUrl
        ? <img src={r.teamLogoUrl} alt="" className="w-5 h-5 rounded-full object-contain shrink-0" />
        : <div className="w-5 h-5 rounded-full bg-white/5 shrink-0" />}
      <span className="text-white/40 text-xs truncate">{r.teamName}</span>
    </div>
  );

  return (
    <div className="space-y-5">
      {/* view toggle */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex gap-1 bg-white/[0.02] rounded-xl p-1 border border-white/5">
          {views.map(v => (
            <button
              key={v.id}
              onClick={() => setView(v.id)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm transition-all ${
                view === v.id ? "bg-blue-600/20 text-blue-400 font-medium" : "text-white/30 hover:text-white/50 hover:bg-white/[0.02]"
              }`}
              data-testid={`award-view-${v.id}`}
            >
              <v.icon className="w-3.5 h-3.5" />
              {v.label}
            </button>
          ))}
        </div>
        {isPrivate && (
          <span className="text-[11px] px-2.5 py-1 rounded-full bg-amber-500/10 text-amber-400/80 border border-amber-500/20 flex items-center gap-1.5">
            <Shield className="w-3 h-3" /> Private — staff only, never shown publicly
          </span>
        )}
      </div>

      <div className="rounded-2xl border border-blue-500/10 bg-white/[0.02] p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-white flex items-center gap-2">
            {view === "boot" ? <><Goal className="w-4 h-4 text-yellow-400/80" /> Golden Boot — top scorers</>
              : view === "glove" ? <><Shield className="w-4 h-4 text-blue-400/80" /> Golden Glove — best goalkeeper</>
              : view === "mvp" ? <><Award className="w-4 h-4 text-purple-400/80" /> Player of the Tournament (MVP)</>
              : <><Square className="w-4 h-4 text-yellow-400/80 fill-yellow-400/80" /> Card tracker — suspensions</>}
          </h3>
          <span className="text-xs text-white/25">{rows.length} {rows.length === 1 ? "player" : "players"}</span>
        </div>

        {view === "glove" && (
          <p className="text-[11px] text-white/35 mb-3">Referees rate each keeper 1–5 per game (5 = best). Ranked by average rating.</p>
        )}
        {view === "mvp" && (
          <p className="text-[11px] text-white/35 mb-3">Each team votes one opposition player per game. Most votes wins.</p>
        )}
        {view === "cards" && (
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <p className="text-[11px] text-white/35">A <span className="text-red-300">red card</span> or every <span className="text-amber-300">{YELLOW_SUSPENSION_THRESHOLD} yellows</span> = miss the next game. The exact game each player misses is shown below — coordinate with the refs.</p>
            {suspended > 0 && (
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-red-500/15 text-red-300 border border-red-500/25 flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" /> {suspended} to suspend
              </span>
            )}
          </div>
        )}

        {loading ? (
          <div className="h-24 rounded-xl bg-white/[0.02] animate-pulse" />
        ) : rows.length === 0 ? (
          <div className="text-center py-10 text-white/25 text-sm">
            {view === "boot" ? "No goals recorded yet." : view === "glove" ? "No goalkeeper ratings entered yet." : view === "mvp" ? "No MVP votes entered yet." : "No cards recorded yet."}
            <p className="text-[11px] text-white/20 mt-1">Entered per game in the Schedule tab (tap a game → scoresheet).</p>
          </div>
        ) : view === "cards" ? (
          <div className="space-y-1.5">
            {rows.map((r: any) => {
              const susps = r.suspensions ?? [];
              const flag = susps.length > 0;
              return (
                <div key={r.playerId} className={`rounded-lg border px-3 py-2.5 ${flag ? "bg-red-500/[0.06] border-red-500/25" : "bg-white/[0.015] border-white/5"}`}>
                  <div className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-white truncate">
                        {r.shirtNumber ? <span className="text-white/30 mr-1.5">#{r.shirtNumber}</span> : null}
                        {r.playerName}
                      </div>
                      <div className="sm:hidden mt-0.5">{teamCell(r)}</div>
                    </div>
                    <div className="hidden sm:block w-40">{teamCell(r)}</div>
                    <div className="flex items-center gap-2.5 shrink-0">
                      <span className="flex items-center gap-1" title="Yellow cards">
                        <span className="inline-block w-3 h-4 rounded-[2px] bg-yellow-400" />
                        <span className="text-base font-bold text-white tabular-nums">{r.yellows}</span>
                      </span>
                      {r.reds > 0 && (
                        <span className="flex items-center gap-1" title="Red cards">
                          <span className="inline-block w-3 h-4 rounded-[2px] bg-red-500" />
                          <span className="text-base font-bold text-white tabular-nums">{r.reds}</span>
                        </span>
                      )}
                    </div>
                  </div>
                  {flag && (
                    <div className="mt-2 pt-2 border-t border-red-500/15 space-y-1.5">
                      {susps.map((s: any, i: number) => (
                        <div key={i} className="flex items-start gap-2 text-xs">
                          <span className={`shrink-0 mt-px text-[10px] px-1.5 py-0.5 rounded flex items-center gap-1 whitespace-nowrap ${s.reason === "red" ? "bg-red-500/20 text-red-300" : "bg-yellow-400/15 text-yellow-300"}`}>
                            <span className={`inline-block w-2.5 h-3.5 rounded-[1px] ${s.reason === "red" ? "bg-red-500" : "bg-yellow-400"}`} />
                            {s.reason === "red" ? "Red" : "2 yellows"}
                          </span>
                          <span className="text-white/70 min-w-0">
                            {s.missesGame ? (
                              <>
                                <AlertTriangle className="w-3 h-3 inline text-red-400 mr-1 -mt-0.5" />
                                Misses <span className="text-white font-medium">Game {s.missesGame.gameNumber ?? "?"} v {s.missesGame.opponent}</span>
                                {fmtMiss(s.missesGame) && <span className="text-white/40"> · {fmtMiss(s.missesGame)}</span>}
                                <span className="text-white/25"> (from {s.triggerGameLabel})</span>
                              </>
                            ) : (
                              <span className="text-white/40">Ban from {s.triggerGameLabel} — no later game scheduled (carries over)</span>
                            )}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="space-y-1">
            {rows.map((r: any, i: number) => (
              <div key={r.playerId} className="flex items-center gap-3 rounded-lg bg-white/[0.015] border border-white/5 px-3 py-2">
                {rankBadge(i)}
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-white truncate">
                    {r.shirtNumber ? <span className="text-white/30 mr-1.5">#{r.shirtNumber}</span> : null}
                    {r.playerName}
                  </div>
                  <div className="sm:hidden mt-0.5">{teamCell(r)}</div>
                </div>
                <div className="hidden sm:block w-48">{teamCell(r)}</div>
                <div className="text-right shrink-0">
                  {view === "boot" && <span className="text-lg font-bold text-white tabular-nums">{r.goals}<span className="text-[10px] font-normal text-white/30 ml-1">goals</span></span>}
                  {view === "glove" && (
                    <div className="flex items-baseline gap-2 justify-end">
                      <span className="text-lg font-bold text-white tabular-nums">{Number(r.avgRating).toFixed(1)}</span>
                      <span className="text-[10px] text-white/30">avg · {r.games} {r.games === 1 ? "game" : "games"}</span>
                    </div>
                  )}
                  {view === "mvp" && <span className="text-lg font-bold text-white tabular-nums">{r.votes}<span className="text-[10px] font-normal text-white/30 ml-1">{r.votes === 1 ? "vote" : "votes"}</span></span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function TournamentDetail() {
  const [, params] = useRoute("/admin/tournaments/:id");
  const [, setLocation] = useLocation();
  const tournamentId = params?.id ? parseInt(params.id) : 0;
  const [tab, setTab] = useState<Tab>("format");

  const { data: tournament, isLoading } = useQuery<Tournament>({
    queryKey: ["/api/admin/tournament/tournaments", tournamentId],
    queryFn: () => fetch(`/api/admin/tournament/tournaments/${tournamentId}`).then(r => r.json()),
    enabled: !!tournamentId,
  });

  if (isLoading || !tournament) {
    return <div className="p-6"><div className="h-32 rounded-2xl bg-white/[0.02] animate-pulse" /></div>;
  }

  const tabs: { id: Tab; label: string; icon: any }[] = [
    { id: "format", label: "Format", icon: Settings2 },
    { id: "schedule", label: "Schedule", icon: Calendar },
    { id: "groups", label: "Groups & Draw", icon: LayoutGrid },
    { id: "teams", label: "Teams", icon: Users },
    { id: "awards", label: "Awards", icon: Award },
  ];

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="flex items-center gap-3">
        <button
          onClick={() => setLocation("/admin/tournaments")}
          className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-white/5 text-white/30"
          data-testid="button-back-tournaments"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div className="flex-1">
          <h1 className="text-xl font-bold text-white" data-testid="text-tournament-name">{tournament.name}</h1>
          <p className="text-xs text-white/30 mt-0.5">
            {tournament.ageGroup || "Open"} · {tournament.location || "No location"} ·{" "}
            {tournament.startDate ? new Date(tournament.startDate + "T12:00:00").toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" }) : "No date"}
          </p>
        </div>
        <span className={`text-xs px-3 py-1 rounded-full ${
          tournament.status === "active" ? "bg-green-500/15 text-green-400" :
          tournament.status === "completed" ? "bg-blue-500/15 text-blue-400" :
          "bg-white/5 text-white/30"
        }`}>
          {tournament.status.charAt(0).toUpperCase() + tournament.status.slice(1)}
        </span>
      </div>

      <div className="flex gap-1 bg-white/[0.02] rounded-xl p-1 border border-white/5">
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm transition-all ${
              tab === t.id ? "bg-blue-600/20 text-blue-400 font-medium" : "text-white/30 hover:text-white/50 hover:bg-white/[0.02]"
            }`}
            data-testid={`tab-${t.id}`}
          >
            <t.icon className="w-3.5 h-3.5" />
            {t.label}
          </button>
        ))}
      </div>

      {tab === "format" && <FormatTab tournament={tournament} />}
      {tab === "schedule" && <ScheduleTab tournament={tournament} />}
      {tab === "groups" && <GroupsTab tournament={tournament} />}
      {tab === "teams" && <TeamsTab tournament={tournament} />}
      {tab === "awards" && <AwardsTab tournament={tournament} />}
    </div>
  );
}
