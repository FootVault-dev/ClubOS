import { Fragment, useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useRoute, useLocation } from "wouter";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Award, Users, Calendar, LayoutGrid, Settings2, Plus, Trash2, GripVertical, X, Shield, Clock, MapPin, Pencil, Check, ChevronDown, Goal, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TimePickerInput } from "@/components/ui/time-picker-input";
import { DatePickerInput } from "@/components/ui/date-picker-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Tournament, TournamentGroup, TournamentTeam, TournamentGame, TournamentPlayer, TournamentGoal } from "@shared/schema";

type Tab = "format" | "schedule" | "groups" | "teams";

const FIELDS = ["S1", "S2", "J1", "J2", "J3", "J4", "Mini 1", "Mini 2"];

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
function GameGoalsModal({ game, onClose }: { game: GameWithRelations; onClose: () => void }) {
  const { toast } = useToast();
  const [pickerSide, setPickerSide] = useState<"home" | "away" | null>(null);
  const [pickedPlayerId, setPickedPlayerId] = useState<string>("");
  const [typedName, setTypedName] = useState<string>("");
  const [minute, setMinute] = useState<string>("");
  const [isOwnGoal, setIsOwnGoal] = useState(false);
  const [isPenalty, setIsPenalty] = useState(false);

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
      setIsOwnGoal(false);
      setIsPenalty(false);
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

  const submit = () => {
    if (!pickerSide) return;
    if (!pickedPlayerId && !typedName.trim()) return;
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
      <div className="bg-[#0a0e1a] border border-blue-500/15 rounded-2xl w-full max-w-lg shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-white/5">
          <div>
            <div className="text-xs text-white/40 uppercase tracking-wide">Game {game.gameNumber} · {game.stageDetail}</div>
            <h2 className="text-lg font-semibold text-white">{homeName} v {awayName}</h2>
          </div>
          <button onClick={onClose} className="text-white/40 hover:text-white/70"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-5 space-y-4">
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

                <div className="flex items-center gap-2">
                  <Input
                    type="number" min="0" max="120" placeholder="Min"
                    value={minute} onChange={e => setMinute(e.target.value)}
                    className="w-20 text-sm"
                  />
                  <label className="flex items-center gap-1.5 text-xs text-white/60">
                    <input type="checkbox" checked={isPenalty} onChange={e => setIsPenalty(e.target.checked)} /> Penalty
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-white/60">
                    <input type="checkbox" checked={isOwnGoal} onChange={e => setIsOwnGoal(e.target.checked)} /> Own goal
                  </label>
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

  const assignTeam = (gameId: number, side: "home" | "away", teamId: number) =>
    updateGameMut.mutate({ id: gameId, data: { [side === "home" ? "homeTeamId" : "awayTeamId"]: teamId } });

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
          field: editField === "none" ? null : (editField || null),
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
                    <Select value={editField} onValueChange={setEditField}>
                      <SelectTrigger className="w-16 h-7 text-xs premium-input text-white" data-testid={`select-field-${game.id}`}>
                        <SelectValue placeholder="—" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">—</SelectItem>
                        {FIELDS.map(f => (
                          <SelectItem key={f} value={f}>{f}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <span className={`text-xs font-medium ${game.field ? "text-blue-400/70" : "text-white/15"}`} data-testid={`text-field-${game.id}`}>
                      {game.field || "—"}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2.5 text-right">
                  {isKnockout && !game.homeTeam && !game.homeTeamPlaceholder ? (
                    <Select value={game.homeTeamId ? String(game.homeTeamId) : ""} onValueChange={v => assignTeam(game.id, "home", Number(v))}>
                      <SelectTrigger className="w-44 h-7 text-xs premium-input text-white ml-auto" data-testid={`select-home-team-${game.id}`}>
                        <SelectValue placeholder="Assign team" />
                      </SelectTrigger>
                      <SelectContent>
                        {sortedTeams.map(t => <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
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
                  {isKnockout && !game.awayTeam && !game.awayTeamPlaceholder ? (
                    <Select value={game.awayTeamId ? String(game.awayTeamId) : ""} onValueChange={v => assignTeam(game.id, "away", Number(v))}>
                      <SelectTrigger className="w-44 h-7 text-xs premium-input text-white" data-testid={`select-away-team-${game.id}`}>
                        <SelectValue placeholder="Assign team" />
                      </SelectTrigger>
                      <SelectContent>
                        {sortedTeams.map(t => <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
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
                    {game.status !== "final" && game.homeScore !== null && game.awayScore !== null && (
                      <button
                        onClick={() => updateGameMut.mutate({ id: game.id, data: { status: "final" } })}
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
    </div>
  );
}
