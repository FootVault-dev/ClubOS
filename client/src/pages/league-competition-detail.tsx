import { useState, useEffect, Fragment } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useWorkspace } from "@/lib/workspace-context";
import { formatCurrency } from "@/lib/format";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useLocation } from "wouter";
import { Trophy, ArrowLeft, Calendar, BarChart3, Settings, Ticket, Tag, Plus, X, Trash2, Pencil, ChevronDown, ChevronRight, Users, Wand2, ExternalLink, Loader2, Mail, Phone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TimePickerInput } from "@/components/ui/time-picker-input";
import { DatePickerInput } from "@/components/ui/date-picker-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { LeagueCompetition, LeagueDivision, LeagueTeam, LeagueGame, LeagueCoupon } from "@shared/schema";

type GameWithTeams = LeagueGame & { homeTeam?: LeagueTeam; awayTeam?: LeagueTeam; division?: LeagueDivision };
type Standing = { teamId: number; teamName: string; divisionId: number | null; divisionName: string; mp: number; w: number; l: number; d: number; gf: number; ga: number; gd: number; pts: number };

// A Term's tabs. The leagues (divisions) are the hub; per-league management
// (schedule/standings/payments) lives on each League's own page.
const TABS = [
  { id: "setup", label: "Leagues", icon: Trophy },
  { id: "registration", label: "Settings", icon: Ticket },
  { id: "coupons", label: "Coupons", icon: Tag },
] as const;

type TabId = typeof TABS[number]["id"];

function DivisionModal({ competitionId, division, onClose }: { competitionId: number; division?: LeagueDivision; onClose: () => void }) {
  const { toast } = useToast();
  const [form, setForm] = useState({
    name: division?.name || "",
    gender: division?.gender || "",
    ageGroup: division?.ageGroup || "",
    dayOfWeek: division?.dayOfWeek || "",
    maxTeams: division?.maxTeams?.toString() || "",
    teamCostCents: division?.teamCostCents?.toString() || "0",
    playerCostCents: division?.playerCostCents?.toString() || "0",
  });

  const createMut = useMutation({
    mutationFn: (d: any) => apiRequest("POST", "/api/admin/league/divisions", d),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/admin/league/competitions", competitionId, "divisions"] }); toast({ title: "Division created" }); onClose(); },
  });
  const updateMut = useMutation({
    mutationFn: (d: any) => apiRequest("PATCH", `/api/admin/league/divisions/${division!.id}`, d),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/admin/league/competitions", competitionId, "divisions"] }); toast({ title: "Division updated" }); onClose(); },
  });

  const handleSave = () => {
    const data = {
      competitionId,
      name: form.name,
      gender: form.gender || null,
      ageGroup: form.ageGroup || null,
      dayOfWeek: form.dayOfWeek || null,
      maxTeams: form.maxTeams ? parseInt(form.maxTeams) : null,
      teamCostCents: parseInt(form.teamCostCents) || 0,
      playerCostCents: parseInt(form.playerCostCents) || 0,
    };
    division ? updateMut.mutate(data) : createMut.mutate(data);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-[#0a0e1a] border border-blue-500/15 rounded-2xl w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between p-5 border-b border-white/5">
          <h2 className="text-lg font-semibold text-white">{division ? "Edit Division" : "New Division"}</h2>
          <button onClick={onClose} className="text-white/30 hover:text-white/60"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 space-y-3">
          <div><label className="text-xs text-white/40 mb-1 block">Name</label><Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="premium-input text-white" data-testid="input-div-name" /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-xs text-white/40 mb-1 block">Gender</label><Input value={form.gender} onChange={e => setForm(f => ({ ...f, gender: e.target.value }))} className="premium-input text-white" placeholder="e.g. Mixed" /></div>
            <div><label className="text-xs text-white/40 mb-1 block">Age Group</label><Input value={form.ageGroup} onChange={e => setForm(f => ({ ...f, ageGroup: e.target.value }))} className="premium-input text-white" placeholder="e.g. U10" /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-xs text-white/40 mb-1 block">Day of Week</label><Input value={form.dayOfWeek} onChange={e => setForm(f => ({ ...f, dayOfWeek: e.target.value }))} className="premium-input text-white" placeholder="e.g. Saturday" /></div>
            <div><label className="text-xs text-white/40 mb-1 block">Max Teams</label><Input type="number" value={form.maxTeams} onChange={e => setForm(f => ({ ...f, maxTeams: e.target.value }))} className="premium-input text-white" /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-xs text-white/40 mb-1 block">Team Cost (cents)</label><Input type="number" value={form.teamCostCents} onChange={e => setForm(f => ({ ...f, teamCostCents: e.target.value }))} className="premium-input text-white" /></div>
            <div><label className="text-xs text-white/40 mb-1 block">Player Cost (cents)</label><Input type="number" value={form.playerCostCents} onChange={e => setForm(f => ({ ...f, playerCostCents: e.target.value }))} className="premium-input text-white" /></div>
          </div>
        </div>
        <div className="p-5 border-t border-white/5 flex gap-2 justify-end">
          <Button variant="ghost" onClick={onClose} className="text-white/40">Cancel</Button>
          <Button onClick={handleSave} disabled={!form.name} className="bg-blue-600 hover:bg-blue-700 text-white" data-testid="button-save-div">Save</Button>
        </div>
      </div>
    </div>
  );
}

function GameModal({ competitionId, teams, divisions, game, onClose }: { competitionId: number; teams: LeagueTeam[]; divisions: LeagueDivision[]; game?: GameWithTeams; onClose: () => void }) {
  const { toast } = useToast();
  const [form, setForm] = useState({
    divisionId: game?.divisionId?.toString() || "",
    homeTeamId: game?.homeTeamId?.toString() || "",
    awayTeamId: game?.awayTeamId?.toString() || "",
    gameDate: game?.gameDate || "",
    startTime: game?.startTime || "",
    endTime: game?.endTime || "",
    location: game?.location || "",
    status: game?.status || "scheduled",
    homeScore: game?.homeScore?.toString() || "",
    awayScore: game?.awayScore?.toString() || "",
  });

  const createMut = useMutation({
    mutationFn: (d: any) => apiRequest("POST", "/api/admin/league/games", d),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/admin/league/competitions", competitionId, "games"] }); toast({ title: "Game created" }); onClose(); },
  });
  const updateMut = useMutation({
    mutationFn: (d: any) => apiRequest("PATCH", `/api/admin/league/games/${game!.id}`, d),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/admin/league/competitions", competitionId, "games"] }); queryClient.invalidateQueries({ queryKey: ["/api/admin/league/competitions", competitionId, "standings"] }); toast({ title: "Game updated" }); onClose(); },
  });

  const handleSave = () => {
    const data = {
      competitionId,
      divisionId: form.divisionId ? parseInt(form.divisionId) : null,
      homeTeamId: form.homeTeamId ? parseInt(form.homeTeamId) : null,
      awayTeamId: form.awayTeamId ? parseInt(form.awayTeamId) : null,
      gameDate: form.gameDate || null,
      startTime: form.startTime || null,
      endTime: form.endTime || null,
      location: form.location || null,
      status: form.status,
      homeScore: form.homeScore !== "" ? parseInt(form.homeScore) : null,
      awayScore: form.awayScore !== "" ? parseInt(form.awayScore) : null,
    };
    game ? updateMut.mutate(data) : createMut.mutate(data);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-[#0a0e1a] border border-blue-500/15 rounded-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto shadow-2xl">
        <div className="flex items-center justify-between p-5 border-b border-white/5">
          <h2 className="text-lg font-semibold text-white">{game ? "Edit Game" : "New Game"}</h2>
          <button onClick={onClose} className="text-white/30 hover:text-white/60"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 space-y-3">
          {divisions.length > 0 && (
            <div><label className="text-xs text-white/40 mb-1 block">Division</label>
              <Select value={form.divisionId} onValueChange={v => setForm(f => ({ ...f, divisionId: v }))}>
                <SelectTrigger className="premium-input text-white"><SelectValue placeholder="Select division" /></SelectTrigger>
                <SelectContent>{divisions.map(d => <SelectItem key={d.id} value={d.id.toString()}>{d.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-xs text-white/40 mb-1 block">Home Team</label>
              <Select value={form.homeTeamId} onValueChange={v => setForm(f => ({ ...f, homeTeamId: v }))}>
                <SelectTrigger className="premium-input text-white"><SelectValue placeholder="Home" /></SelectTrigger>
                <SelectContent>{teams.map(t => <SelectItem key={t.id} value={t.id.toString()}>{t.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div><label className="text-xs text-white/40 mb-1 block">Away Team</label>
              <Select value={form.awayTeamId} onValueChange={v => setForm(f => ({ ...f, awayTeamId: v }))}>
                <SelectTrigger className="premium-input text-white"><SelectValue placeholder="Away" /></SelectTrigger>
                <SelectContent>{teams.map(t => <SelectItem key={t.id} value={t.id.toString()}>{t.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div><label className="text-xs text-white/40 mb-1 block">Date</label><DatePickerInput value={form.gameDate} onChange={e => setForm(f => ({ ...f, gameDate: e.target.value }))} className="premium-input text-white" data-testid="input-game-date" /></div>
            <div><label className="text-xs text-white/40 mb-1 block">Start</label><TimePickerInput value={form.startTime} onChange={e => setForm(f => ({ ...f, startTime: e.target.value }))} className="premium-input text-white" /></div>
            <div><label className="text-xs text-white/40 mb-1 block">End</label><TimePickerInput value={form.endTime} onChange={e => setForm(f => ({ ...f, endTime: e.target.value }))} className="premium-input text-white" /></div>
          </div>
          <div><label className="text-xs text-white/40 mb-1 block">Location</label><Input value={form.location} onChange={e => setForm(f => ({ ...f, location: e.target.value }))} className="premium-input text-white" /></div>
          <div><label className="text-xs text-white/40 mb-1 block">Status</label>
            <Select value={form.status} onValueChange={v => setForm(f => ({ ...f, status: v }))}>
              <SelectTrigger className="premium-input text-white"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="scheduled">Scheduled</SelectItem>
                <SelectItem value="in_progress">In Progress</SelectItem>
                <SelectItem value="final">Final</SelectItem>
                <SelectItem value="cancelled">Cancelled</SelectItem>
                <SelectItem value="forfeit">Forfeit</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-xs text-white/40 mb-1 block">Home Score</label><Input type="number" value={form.homeScore} onChange={e => setForm(f => ({ ...f, homeScore: e.target.value }))} className="premium-input text-white" /></div>
            <div><label className="text-xs text-white/40 mb-1 block">Away Score</label><Input type="number" value={form.awayScore} onChange={e => setForm(f => ({ ...f, awayScore: e.target.value }))} className="premium-input text-white" /></div>
          </div>
        </div>
        <div className="p-5 border-t border-white/5 flex gap-2 justify-end">
          <Button variant="ghost" onClick={onClose} className="text-white/40">Cancel</Button>
          <Button onClick={handleSave} className="bg-blue-600 hover:bg-blue-700 text-white" data-testid="button-save-game">Save</Button>
        </div>
      </div>
    </div>
  );
}

// Auto-generate a round-robin fixture list for a division.
function FixtureGenModal({ competitionId, divisions, teams, onClose }: { competitionId: number; divisions: LeagueDivision[]; teams: LeagueTeam[]; onClose: () => void }) {
  const { toast } = useToast();
  const divsWithTeams = divisions.filter(d => teams.filter(t => t.divisionId === d.id && t.active).length >= 2);
  const [divisionId, setDivisionId] = useState(divsWithTeams[0]?.id?.toString() || "");
  const [startDate, setStartDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [intervalDays, setIntervalDays] = useState("7");
  const [doubleRound, setDoubleRound] = useState(false);
  const [replaceExisting, setReplaceExisting] = useState(false);

  const teamCount = teams.filter(t => t.divisionId?.toString() === divisionId && t.active).length;

  const genMut = useMutation({
    mutationFn: () => apiRequest("POST", `/api/admin/league/competitions/${competitionId}/generate-fixtures`, {
      divisionId: parseInt(divisionId),
      startDate, startTime: startTime || null,
      intervalDays: parseInt(intervalDays) || 7,
      doubleRound, replaceExisting,
    }),
    onSuccess: async (res: any) => {
      const body = await res.json().catch(() => ({}));
      queryClient.invalidateQueries({ queryKey: ["/api/admin/league/competitions", competitionId, "games"] });
      toast({ title: `Created ${body.created ?? 0} fixtures across ${body.rounds ?? 0} rounds` });
      onClose();
    },
    onError: (e: any) => toast({ title: "Could not generate", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-[#0a0e1a] border border-blue-500/15 rounded-2xl w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between p-5 border-b border-white/5">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2"><Wand2 className="w-4 h-4 text-blue-400" /> Generate Fixtures</h2>
          <button onClick={onClose} className="text-white/30 hover:text-white/60"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 space-y-3">
          <div>
            <label className="text-xs text-white/40 mb-1 block">Division</label>
            <Select value={divisionId} onValueChange={setDivisionId}>
              <SelectTrigger className="premium-input text-white"><SelectValue placeholder="Select division" /></SelectTrigger>
              <SelectContent>{divsWithTeams.map(d => <SelectItem key={d.id} value={d.id.toString()}>{d.name}</SelectItem>)}</SelectContent>
            </Select>
            <p className="text-[11px] text-white/30 mt-1">{teamCount} active team{teamCount !== 1 ? "s" : ""} — a full round-robin is {teamCount > 1 ? teamCount - 1 : 0} round{teamCount - 1 !== 1 ? "s" : ""}{doubleRound ? " ×2" : ""}.</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-xs text-white/40 mb-1 block">First game date</label><DatePickerInput value={startDate} onChange={e => setStartDate(e.target.value)} className="premium-input text-white" data-testid="input-gen-startdate" /></div>
            <div><label className="text-xs text-white/40 mb-1 block">Kick-off time</label><TimePickerInput value={startTime} onChange={e => setStartTime(e.target.value)} className="premium-input text-white" /></div>
          </div>
          <div><label className="text-xs text-white/40 mb-1 block">Days between rounds</label><Input type="number" value={intervalDays} onChange={e => setIntervalDays(e.target.value)} className="premium-input text-white" /></div>
          <label className="flex items-center gap-2 text-sm text-white/60 cursor-pointer">
            <input type="checkbox" checked={doubleRound} onChange={e => setDoubleRound(e.target.checked)} /> Double round-robin (home & away)
          </label>
          <label className="flex items-center gap-2 text-sm text-white/60 cursor-pointer">
            <input type="checkbox" checked={replaceExisting} onChange={e => setReplaceExisting(e.target.checked)} /> Replace existing scheduled games
          </label>
        </div>
        <div className="p-5 border-t border-white/5 flex gap-2 justify-end">
          <Button variant="ghost" onClick={onClose} className="text-white/40">Cancel</Button>
          <Button onClick={() => genMut.mutate()} disabled={!divisionId || !startDate || genMut.isPending} className="bg-blue-600 hover:bg-blue-700 text-white gap-2" data-testid="button-run-generate">
            {genMut.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />} Generate
          </Button>
        </div>
      </div>
    </div>
  );
}

function ScheduleTab({ competitionId, teams, divisions, lockedDivisionId }: { competitionId: number; teams: LeagueTeam[]; divisions: LeagueDivision[]; lockedDivisionId?: number }) {
  const [showGameModal, setShowGameModal] = useState(false);
  const [showGenModal, setShowGenModal] = useState(false);
  const [editingGame, setEditingGame] = useState<GameWithTeams | undefined>();
  const [divFilter, setDivFilter] = useState(lockedDivisionId ? String(lockedDivisionId) : "all");
  // When locked to one league, modals default new games to that division.
  const modalDivisions = lockedDivisionId ? divisions.filter(d => d.id === lockedDivisionId) : divisions;

  const { data: games = [] } = useQuery<GameWithTeams[]>({
    queryKey: ["/api/admin/league/competitions", competitionId, "games"],
    queryFn: () => fetch(`/api/admin/league/competitions/${competitionId}/games`).then(r => r.json()),
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/admin/league/games/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/admin/league/competitions", competitionId, "games"] }),
  });

  const filtered = divFilter === "all" ? games : games.filter(g => g.divisionId?.toString() === divFilter);

  const gamesByDate: Record<string, GameWithTeams[]> = {};
  filtered.forEach(g => {
    const key = g.gameDate || "Unscheduled";
    if (!gamesByDate[key]) gamesByDate[key] = [];
    gamesByDate[key].push(g);
  });

  const statusColors: Record<string, string> = {
    scheduled: "bg-blue-500/15 text-blue-400",
    in_progress: "bg-yellow-500/15 text-yellow-400",
    final: "bg-green-500/15 text-green-400",
    cancelled: "bg-red-500/15 text-red-400",
    forfeit: "bg-orange-500/15 text-orange-400",
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {!lockedDivisionId && divisions.length > 0 && (
            <Select value={divFilter} onValueChange={setDivFilter}>
              <SelectTrigger className="premium-input text-white w-[160px]"><SelectValue placeholder="Division" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Divisions</SelectItem>
                {divisions.map(d => <SelectItem key={d.id} value={d.id.toString()}>{d.name}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
          <span className="text-xs text-white/30">{filtered.length} game{filtered.length !== 1 ? "s" : ""}</span>
        </div>
        <div className="flex items-center gap-2">
          {divisions.length > 0 && teams.length >= 2 && (
            <Button onClick={() => setShowGenModal(true)} variant="outline" className="border-white/10 text-white/70 hover:text-white gap-2" size="sm" data-testid="button-generate-fixtures">
              <Wand2 className="w-3.5 h-3.5" />Generate
            </Button>
          )}
          <Button onClick={() => { setEditingGame(undefined); setShowGameModal(true); }} className="bg-blue-600 hover:bg-blue-700 text-white gap-2" size="sm" data-testid="button-new-game">
            <Plus className="w-3.5 h-3.5" />Game
          </Button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-12 text-white/20">
          <Calendar className="w-10 h-10 mx-auto mb-2" />
          <p className="text-sm">No games scheduled</p>
        </div>
      ) : (
        Object.entries(gamesByDate).sort(([a], [b]) => a.localeCompare(b)).map(([date, dayGames]) => (
          <div key={date} className="space-y-2">
            <h4 className="text-xs text-white/30 uppercase tracking-wider font-semibold px-1">
              {date === "Unscheduled" ? date : new Date(date + "T12:00:00").toLocaleDateString("en-NZ", { weekday: "long", day: "numeric", month: "long" })}
            </h4>
            <div className="space-y-2">
              {dayGames.map(g => (
                <div
                  key={g.id}
                  className="rounded-xl border border-white/5 bg-white/[0.02] p-4 hover:bg-white/[0.04] cursor-pointer transition-colors"
                  onClick={() => { setEditingGame(g); setShowGameModal(true); }}
                  data-testid={`game-card-${g.id}`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      {g.division && <span className="text-[10px] text-white/25 uppercase tracking-wider">{g.division.name}</span>}
                      {g.gameNumber && <span className="text-[10px] text-white/20">#{g.gameNumber}</span>}
                    </div>
                    <span className={`text-[10px] px-2 py-0.5 rounded-full ${statusColors[g.status] || "bg-white/5 text-white/30"}`}>
                      {g.status === "in_progress" ? "Live" : g.status.charAt(0).toUpperCase() + g.status.slice(1)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="flex-1">
                      <p className="text-sm text-white/70 font-medium">{g.homeTeam?.name || "TBD"}</p>
                    </div>
                    <div className="flex items-center gap-3 px-4">
                      {g.status === "final" || g.homeScore !== null ? (
                        <div className="flex items-center gap-2">
                          <span className="text-lg font-bold text-white">{g.homeScore ?? "—"}</span>
                          <span className="text-xs text-white/20">-</span>
                          <span className="text-lg font-bold text-white">{g.awayScore ?? "—"}</span>
                        </div>
                      ) : (
                        <span className="text-xs text-white/20">{g.startTime || "vs"}</span>
                      )}
                    </div>
                    <div className="flex-1 text-right">
                      <p className="text-sm text-white/70 font-medium">{g.awayTeam?.name || "TBD"}</p>
                    </div>
                  </div>
                  {(g.location || g.startTime) && (
                    <div className="flex items-center gap-2 mt-2 text-[10px] text-white/20">
                      {g.startTime && <span>{g.startTime}{g.endTime ? ` - ${g.endTime}` : ""}</span>}
                      {g.location && <span>@ {g.location}</span>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))
      )}

      {showGameModal && <GameModal competitionId={competitionId} teams={teams} divisions={modalDivisions} game={editingGame} onClose={() => { setShowGameModal(false); setEditingGame(undefined); }} />}
      {showGenModal && <FixtureGenModal competitionId={competitionId} divisions={modalDivisions} teams={teams} onClose={() => setShowGenModal(false)} />}
    </div>
  );
}

function StandingsTab({ competitionId, divisions, lockedDivisionId }: { competitionId: number; divisions: LeagueDivision[]; lockedDivisionId?: number }) {
  const [divFilter, setDivFilter] = useState(lockedDivisionId ? String(lockedDivisionId) : "all");

  const { data: standings = [] } = useQuery<Standing[]>({
    queryKey: ["/api/admin/league/competitions", competitionId, "standings"],
    queryFn: () => fetch(`/api/admin/league/competitions/${competitionId}/standings`).then(r => r.json()),
  });

  const divisionGroups: Record<string, Standing[]> = {};
  standings.forEach(s => {
    if (divFilter !== "all" && s.divisionId?.toString() !== divFilter) return;
    const key = s.divisionName;
    if (!divisionGroups[key]) divisionGroups[key] = [];
    divisionGroups[key].push(s);
  });

  return (
    <div className="space-y-4">
      {!lockedDivisionId && divisions.length > 0 && (
        <Select value={divFilter} onValueChange={setDivFilter}>
          <SelectTrigger className="premium-input text-white w-[160px]"><SelectValue placeholder="Division" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Divisions</SelectItem>
            {divisions.map(d => <SelectItem key={d.id} value={d.id.toString()}>{d.name}</SelectItem>)}
          </SelectContent>
        </Select>
      )}

      {standings.length === 0 ? (
        <div className="text-center py-12 text-white/20">
          <BarChart3 className="w-10 h-10 mx-auto mb-2" />
          <p className="text-sm">No standings data yet</p>
          <p className="text-xs mt-1">Complete some games to see standings</p>
        </div>
      ) : (
        Object.entries(divisionGroups).map(([divName, rows]) => (
          <div key={divName} className="rounded-xl border border-white/5 bg-white/[0.02] overflow-hidden">
            <div className="px-4 py-2.5 border-b border-white/5 bg-white/[0.02]">
              <h4 className="text-xs text-white/50 font-semibold uppercase tracking-wider">{divName}</h4>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-white/[0.03]">
                    <th className="text-left text-[10px] text-white/30 uppercase px-4 py-2 font-semibold">Team</th>
                    <th className="text-center text-[10px] text-white/30 uppercase px-2 py-2 font-semibold">MP</th>
                    <th className="text-center text-[10px] text-white/30 uppercase px-2 py-2 font-semibold">W</th>
                    <th className="text-center text-[10px] text-white/30 uppercase px-2 py-2 font-semibold">L</th>
                    <th className="text-center text-[10px] text-white/30 uppercase px-2 py-2 font-semibold">D</th>
                    <th className="text-center text-[10px] text-white/30 uppercase px-2 py-2 font-semibold">GF</th>
                    <th className="text-center text-[10px] text-white/30 uppercase px-2 py-2 font-semibold">GA</th>
                    <th className="text-center text-[10px] text-white/30 uppercase px-2 py-2 font-semibold">GD</th>
                    <th className="text-center text-[10px] text-white/30 uppercase px-2 py-2 font-semibold">PTS</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.sort((a, b) => b.pts - a.pts || b.gd - a.gd).map((s, i) => (
                    <tr key={s.teamId} className="border-b border-white/[0.02] hover:bg-white/[0.02]">
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-white/20 w-4">{i + 1}</span>
                          <span className="text-sm text-white/70 font-medium">{s.teamName}</span>
                        </div>
                      </td>
                      <td className="text-center text-sm text-white/50 px-2">{s.mp}</td>
                      <td className="text-center text-sm text-white/50 px-2">{s.w}</td>
                      <td className="text-center text-sm text-white/50 px-2">{s.l}</td>
                      <td className="text-center text-sm text-white/50 px-2">{s.d}</td>
                      <td className="text-center text-sm text-white/50 px-2">{s.gf}</td>
                      <td className="text-center text-sm text-white/50 px-2">{s.ga}</td>
                      <td className="text-center text-sm text-white/50 px-2">{s.gd > 0 ? `+${s.gd}` : s.gd}</td>
                      <td className="text-center text-sm text-white font-bold px-2">{s.pts}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function SetupTab({ competitionId, teams }: { competitionId: number; teams: LeagueTeam[] }) {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [showDivModal, setShowDivModal] = useState(false);
  const [editingDiv, setEditingDiv] = useState<LeagueDivision | undefined>();

  const { data: divisions = [] } = useQuery<LeagueDivision[]>({
    queryKey: ["/api/admin/league/competitions", competitionId, "divisions"],
    queryFn: () => fetch(`/api/admin/league/competitions/${competitionId}/divisions`).then(r => r.json()),
  });

  // The actual teams in this competition, grouped per league night by division id
  // (includes both registered teams and ones added manually / transferred in).
  const teamsFor = (d: LeagueDivision) => teams.filter(t => t.divisionId === d.id && t.active);

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/admin/league/divisions/${id}`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/admin/league/competitions", competitionId, "divisions"] }); toast({ title: "Division deleted" }); },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">Leagues</h3>
        <Button onClick={() => { setEditingDiv(undefined); setShowDivModal(true); }} className="bg-blue-600 hover:bg-blue-700 text-white gap-2" size="sm" data-testid="button-new-division">
          <Plus className="w-3.5 h-3.5" />League
        </Button>
      </div>

      {divisions.length === 0 ? (
        <div className="text-center py-12 text-white/20">
          <Settings className="w-10 h-10 mx-auto mb-2" />
          <p className="text-sm">No leagues created</p>
          <p className="text-xs mt-1">Add a league night to organise your competition</p>
        </div>
      ) : (
        <div className="space-y-2">
          {divisions.map(d => {
            const dTeams = teamsFor(d);
            return (
              <div key={d.id}
                onClick={() => setLocation(`/admin/competitions/${competitionId}/divisions/${d.id}`)}
                className="rounded-xl border border-white/5 bg-white/[0.02] hover:bg-white/[0.05] p-4 flex items-center justify-between cursor-pointer transition-colors group"
                data-testid={`div-row-${d.id}`}>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-white/80">{d.name}</p>
                  <div className="flex items-center gap-2 mt-0.5 text-xs text-white/30">
                    {d.dayOfWeek && <span>{d.dayOfWeek}</span>}
                    {d.maxTeams != null
                      ? <span>· {dTeams.length}/{d.maxTeams} teams</span>
                      : <span>· {dTeams.length} team{dTeams.length === 1 ? "" : "s"}</span>}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-[11px] text-white/40 mr-1 hidden sm:inline opacity-0 group-hover:opacity-100 transition-opacity">View teams</span>
                  <ChevronRight className="w-4 h-4 text-white/25 mr-1" />
                  <button onClick={(e) => { e.stopPropagation(); setEditingDiv(d); setShowDivModal(true); }} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-white/5 text-white/30" data-testid={`edit-div-${d.id}`}><Pencil className="w-3.5 h-3.5" /></button>
                  <button onClick={(e) => { e.stopPropagation(); if (window.confirm(`Delete "${d.name}"? This can't be undone.`)) deleteMut.mutate(d.id); }} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-red-500/10 text-white/30 hover:text-red-400" data-testid={`delete-div-${d.id}`}><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showDivModal && <DivisionModal competitionId={competitionId} division={editingDiv} onClose={() => { setShowDivModal(false); setEditingDiv(undefined); }} />}
    </div>
  );
}

// The teams entered in one league (used on the League detail page's Setup tab).
function LeagueTeamsList({ teams }: { teams: LeagueTeam[] }) {
  if (teams.length === 0) {
    return (
      <div className="text-center py-10 text-white/20">
        <Users className="w-9 h-9 mx-auto mb-2" />
        <p className="text-sm">No teams entered yet</p>
        <p className="text-xs mt-1">Teams appear here as captains register, or when you add them.</p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {teams.map(t => (
        <div key={t.id} className="rounded-xl border border-white/5 bg-white/[0.02] p-3.5" data-testid={`team-row-${t.id}`}>
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm font-medium text-white/85 truncate">{t.name || "Unnamed team"}</p>
              <p className="text-xs text-white/40 mt-0.5 truncate">{t.contactName || "—"}{t.contactEmail ? ` · ${t.contactEmail}` : ""}</p>
            </div>
            <span className={`text-[11px] px-2 py-1 rounded-md font-medium whitespace-nowrap ${PAY_BADGE[t.paymentStatus || "unpaid"] || PAY_BADGE.unpaid}`}>{PAY_LABEL[t.paymentStatus || "unpaid"] || t.paymentStatus}</span>
          </div>
          {(t.contactPhone || t.contactEmail) && (
            <div className="flex items-center gap-3 mt-2 text-[11px] text-white/35">
              {t.contactPhone && <span>{t.contactPhone}</span>}
              {t.contactEmail && <a href={`mailto:${t.contactEmail}`} onClick={(e) => e.stopPropagation()} className="text-blue-400 hover:underline ml-auto">Email</a>}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

type LeagueReg = {
  id: number; teamName: string | null; status: string; divisionName: string | null;
  captainName: string; captainEmail: string | null; captainPhone: string | null;
  totalCents: number | null; amountPaid: string | null; paymentMode: string | null;
  depositCents: number | null; balanceCents: number | null; balanceDueDate: string | null;
  balanceStatus: string | null; paymentStatus: string; registeredAt: string;
};

const PAY_BADGE: Record<string, string> = {
  paid_in_full: "bg-green-500/15 text-green-400",
  deposit_paid: "bg-yellow-500/15 text-yellow-400",
  refunded: "bg-red-500/15 text-red-400",
  partially_refunded: "bg-orange-500/15 text-orange-400",
  unpaid: "bg-white/10 text-white/40",
};
const PAY_LABEL: Record<string, string> = {
  paid_in_full: "Paid",
  deposit_paid: "Deposit",
  refunded: "Refunded",
  partially_refunded: "Part. refund",
  unpaid: "Unpaid",
};

function RegistrationsTab({ competitionId, divisionName }: { competitionId: number; divisionName?: string }) {
  const { data: allRegs = [], isLoading } = useQuery<LeagueReg[]>({
    queryKey: ["/api/admin/league/competitions", competitionId, "registrations"],
    queryFn: () => fetch(`/api/admin/league/competitions/${competitionId}/registrations`).then(r => r.json()),
  });
  const regs = divisionName ? allRegs.filter(r => r.divisionName === divisionName) : allRegs;

  const paid = regs.filter(r => r.paymentStatus === "paid_in_full").length;
  const deposit = regs.filter(r => r.paymentStatus === "deposit_paid").length;
  const balanceOwed = regs.reduce((s, r) => s + (r.balanceStatus && r.balanceStatus !== "paid" ? (r.balanceCents || 0) : 0), 0);

  if (isLoading) return <div className="text-center py-12 text-white/20 text-sm">Loading…</div>;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Teams", value: regs.length },
          { label: "Paid in full", value: paid },
          { label: "Deposit only", value: deposit },
          { label: "Balance owed", value: formatCurrency(balanceOwed, { fromCents: true }) },
        ].map((s, i) => (
          <div key={i} className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
            <p className="text-[10px] uppercase tracking-wider text-white/30">{s.label}</p>
            <p className="text-lg font-bold text-white mt-0.5">{s.value}</p>
          </div>
        ))}
      </div>

      {regs.length === 0 ? (
        <div className="text-center py-12 text-white/20">
          <Users className="w-10 h-10 mx-auto mb-2" />
          <p className="text-sm">No registrations yet</p>
        </div>
      ) : (
        <div className="rounded-xl border border-white/5 bg-white/[0.02] overflow-x-auto">
          <table className="w-full min-w-[720px]">
            <thead>
              <tr className="border-b border-white/5">
                {["Team", "Night", "Captain", "Status", "Paid", "Balance"].map(h => (
                  <th key={h} className="text-left text-[10px] text-white/30 uppercase px-4 py-2 font-semibold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {regs.map(r => (
                <tr key={r.id} className="border-b border-white/[0.02]" data-testid={`reg-row-${r.id}`}>
                  <td className="px-4 py-2.5 text-sm text-white/80 font-medium">{r.teamName || `#${r.id}`}</td>
                  <td className="px-4 py-2.5 text-sm text-white/50">{r.divisionName || "—"}</td>
                  <td className="px-4 py-2.5 text-sm text-white/60">
                    <div>{r.captainName}</div>
                    <div className="flex items-center gap-3 text-[11px] text-white/30 mt-0.5">
                      {r.captainEmail && <a href={`mailto:${r.captainEmail}`} className="flex items-center gap-1 hover:text-white/50"><Mail className="w-3 h-3" />{r.captainEmail}</a>}
                      {r.captainPhone && <span className="flex items-center gap-1"><Phone className="w-3 h-3" />{r.captainPhone}</span>}
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`text-[10px] px-2 py-0.5 rounded-full ${PAY_BADGE[r.paymentStatus] || PAY_BADGE.unpaid}`}>
                      {PAY_LABEL[r.paymentStatus] || "Unpaid"}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-sm text-white/60">${r.amountPaid || "0.00"}</td>
                  <td className="px-4 py-2.5 text-sm">
                    {r.paymentMode === "installment" && r.balanceStatus !== "paid" && (r.balanceCents || 0) > 0 ? (
                      <span className="text-yellow-400/80">
                        {formatCurrency(r.balanceCents || 0, { fromCents: true })}
                        {r.balanceDueDate && <span className="text-white/30"> · due {new Date(r.balanceDueDate + "T12:00:00").toLocaleDateString("en-NZ", { day: "numeric", month: "short" })}</span>}
                        {r.balanceStatus === "failed" && <span className="text-red-400"> · failed</span>}
                      </span>
                    ) : <span className="text-white/20">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Configures the public team-registration page (the league_team program):
// slug, deposit, early-bird late fee, upsells and hero copy.
function RegSettingsCard({ competitionId, competitionName }: { competitionId: number; competitionName: string }) {
  const { toast } = useToast();
  const [slug, setSlug] = useState("");
  const [deposit, setDeposit] = useState("");          // dollars
  const [earlyBirdDeadline, setEarlyBirdDeadline] = useState("");
  const [lateFee, setLateFee] = useState("");          // dollars
  const [refereePrice, setRefereePrice] = useState(""); // dollars
  const [photoPrice, setPhotoPrice] = useState("");    // dollars
  const [headline, setHeadline] = useState("");
  const [subheadline, setSubheadline] = useState("");

  const { data } = useQuery<{ program: any }>({
    queryKey: ["/api/admin/league/competitions", competitionId, "registration-settings"],
    queryFn: () => fetch(`/api/admin/league/competitions/${competitionId}/registration-settings`).then(r => r.json()),
  });
  const program = data?.program;

  useEffect(() => {
    if (!program) return;
    setSlug(program.slug || "");
    setDeposit(program.depositCents != null ? String(program.depositCents / 100) : "");
    setEarlyBirdDeadline(program.earlyBirdDeadline || "");
    setLateFee(program.lateFeeCents ? String(program.lateFeeCents / 100) : "");
    setHeadline(program.heroHeadline || "");
    setSubheadline(program.heroSubheadline || "");
    const ups: any[] = Array.isArray(program.upsellsJson) ? program.upsellsJson : [];
    const ref = ups.find(u => u.type === "referee");
    const photo = ups.find(u => u.type === "photo_pack");
    setRefereePrice(ref ? String(ref.priceCents / 100) : "");
    setPhotoPrice(photo ? String(photo.priceCents / 100) : "");
  }, [program]);

  const toCents = (v: string) => (v && !isNaN(parseFloat(v)) ? Math.round(parseFloat(v) * 100) : 0);

  const saveMut = useMutation({
    mutationFn: () => {
      const upsells: any[] = [];
      if (toCents(refereePrice) > 0) upsells.push({ type: "referee", label: "Qualified referee (season)", priceCents: toCents(refereePrice) });
      if (toCents(photoPrice) > 0) upsells.push({ type: "photo_pack", label: "Season photo pack", priceCents: toCents(photoPrice) });
      return apiRequest("POST", `/api/admin/league/competitions/${competitionId}/registration-settings`, {
        slug: slug.trim() || undefined,
        name: competitionName,
        depositCents: deposit ? toCents(deposit) : null,
        earlyBirdDeadline: earlyBirdDeadline || null,
        lateFeeCents: toCents(lateFee),
        upsellsJson: upsells,
        heroHeadline: headline || null,
        heroSubheadline: subheadline || null,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/league/competitions", competitionId, "registration-settings"] });
      toast({ title: "Public registration page saved" });
    },
    onError: (e: any) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  const publicUrl = slug ? `https://join.minifootball.co.nz/league/${slug}` : null;

  return (
    <div className="rounded-xl border border-white/5 bg-white/[0.02] p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">Public Registration Page</h3>
        {publicUrl && program && (
          <a href={publicUrl} target="_blank" rel="noreferrer" className="text-[11px] text-blue-400 hover:text-blue-300 flex items-center gap-1" data-testid="link-public-page">
            <ExternalLink className="w-3 h-3" /> View page
          </a>
        )}
      </div>

      <div className="grid sm:grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-white/40 mb-1 block">URL slug</label>
          <Input value={slug} onChange={e => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} placeholder="term-3-7-aside" className="premium-input text-white" data-testid="input-reg-slug" />
          {publicUrl && <p className="text-[10px] text-white/25 mt-1 truncate">{publicUrl}</p>}
        </div>
        <div>
          <label className="text-xs text-white/40 mb-1 block">Deposit ($, blank = pay in full)</label>
          <Input value={deposit} onChange={e => setDeposit(e.target.value)} type="number" placeholder="300" className="premium-input text-white" data-testid="input-reg-deposit" />
        </div>
        <div>
          <label className="text-xs text-white/40 mb-1 block">Early-bird deadline</label>
          <DatePickerInput value={earlyBirdDeadline} onChange={e => setEarlyBirdDeadline(e.target.value)} className="premium-input text-white" />
        </div>
        <div>
          <label className="text-xs text-white/40 mb-1 block">Late fee after deadline ($)</label>
          <Input value={lateFee} onChange={e => setLateFee(e.target.value)} type="number" placeholder="35" className="premium-input text-white" data-testid="input-reg-latefee" />
        </div>
        <div>
          <label className="text-xs text-white/40 mb-1 block">Referee upsell ($, blank = off)</label>
          <Input value={refereePrice} onChange={e => setRefereePrice(e.target.value)} type="number" placeholder="80" className="premium-input text-white" data-testid="input-reg-referee" />
        </div>
        <div>
          <label className="text-xs text-white/40 mb-1 block">Photo pack upsell ($, blank = off)</label>
          <Input value={photoPrice} onChange={e => setPhotoPrice(e.target.value)} type="number" placeholder="40" className="premium-input text-white" data-testid="input-reg-photo" />
        </div>
      </div>

      <div className="grid gap-3">
        <div>
          <label className="text-xs text-white/40 mb-1 block">Hero headline</label>
          <Input value={headline} onChange={e => setHeadline(e.target.value)} placeholder="Christchurch's #1 Social Football League" className="premium-input text-white" data-testid="input-reg-headline" />
        </div>
        <div>
          <label className="text-xs text-white/40 mb-1 block">Hero subheadline</label>
          <Input value={subheadline} onChange={e => setSubheadline(e.target.value)} placeholder="Register your team for Term 3 — grab your mates and play every week." className="premium-input text-white" data-testid="input-reg-subheadline" />
        </div>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-[11px] text-white/25">{program ? "Editing live page" : "Not yet published — save to create the page"}</p>
        <Button onClick={() => saveMut.mutate()} disabled={saveMut.isPending} className="bg-blue-600 hover:bg-blue-700 text-white gap-2" size="sm" data-testid="button-save-reg-settings">
          {saveMut.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null} Save page
        </Button>
      </div>
    </div>
  );
}

function RegistrationTab({ competition, divisions }: { competition: LeagueCompetition; divisions: LeagueDivision[] }) {
  const { toast } = useToast();

  const updateMut = useMutation({
    mutationFn: (data: any) => apiRequest("PATCH", `/api/admin/league/competitions/${competition.id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/league/competitions", competition.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/league/competitions"] });
      toast({ title: "Registration updated" });
    },
  });

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-white/5 bg-white/[0.02] p-5">
        <h3 className="text-sm font-semibold text-white mb-3">Registration Status</h3>
        <div className="flex items-center gap-3">
          {(["none", "open", "closed"] as const).map(status => (
            <button
              key={status}
              onClick={() => updateMut.mutate({ registrationStatus: status })}
              className={`px-4 py-2 rounded-xl text-sm font-medium transition-all ${
                competition.registrationStatus === status
                  ? status === "open" ? "bg-green-500/20 text-green-400 border border-green-500/30" :
                    status === "closed" ? "bg-red-500/20 text-red-400 border border-red-500/30" :
                    "bg-white/10 text-white/60 border border-white/20"
                  : "bg-white/[0.03] text-white/30 border border-white/5 hover:bg-white/[0.06]"
              }`}
              data-testid={`button-reg-${status}`}
            >
              {status === "none" ? "No Registration" : status.charAt(0).toUpperCase() + status.slice(1)}
            </button>
          ))}
        </div>
      </div>

      <RegSettingsCard competitionId={competition.id} competitionName={competition.name} />

      {divisions.length > 0 && (
        <div className="rounded-xl border border-white/5 bg-white/[0.02] p-5">
          <h3 className="text-sm font-semibold text-white mb-3">Division Pricing</h3>
          <div className="space-y-2">
            {divisions.map(d => (
              <div key={d.id} className="flex items-center justify-between py-2 border-b border-white/[0.03] last:border-0">
                <span className="text-sm text-white/60">{d.name}</span>
                <div className="flex items-center gap-3 text-xs text-white/40">
                  <span>Team: ${(d.teamCostCents || 0) / 100}</span>
                  <span>Player: ${(d.playerCostCents || 0) / 100}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function CouponsTab({ competitionId }: { competitionId: number }) {
  const { toast } = useToast();
  const [showForm, setShowForm] = useState(false);
  const [code, setCode] = useState("");
  const [discountPercent, setDiscountPercent] = useState("");
  const [maxUsage, setMaxUsage] = useState("");

  const { data: coupons = [] } = useQuery<LeagueCoupon[]>({
    queryKey: ["/api/admin/league/competitions", competitionId, "coupons"],
    queryFn: () => fetch(`/api/admin/league/competitions/${competitionId}/coupons`).then(r => r.json()),
  });

  const createMut = useMutation({
    mutationFn: (data: any) => apiRequest("POST", "/api/admin/league/coupons", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/league/competitions", competitionId, "coupons"] });
      toast({ title: "Coupon created" });
      setShowForm(false);
      setCode(""); setDiscountPercent(""); setMaxUsage("");
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/admin/league/coupons/${id}`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/admin/league/competitions", competitionId, "coupons"] }); toast({ title: "Coupon deleted" }); },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-xs text-white/30">{coupons.length} coupon{coupons.length !== 1 ? "s" : ""}</span>
        <Button onClick={() => setShowForm(!showForm)} className="bg-blue-600 hover:bg-blue-700 text-white gap-2" size="sm" data-testid="button-new-coupon">
          <Plus className="w-3.5 h-3.5" />Coupon
        </Button>
      </div>

      {showForm && (
        <div className="rounded-xl border border-blue-500/15 bg-white/[0.03] p-4 space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <div><label className="text-xs text-white/40 mb-1 block">Code</label><Input value={code} onChange={e => setCode(e.target.value.toUpperCase())} className="premium-input text-white" data-testid="input-coupon-code" placeholder="e.g. EARLYBIRD" /></div>
            <div><label className="text-xs text-white/40 mb-1 block">Discount %</label><Input type="number" value={discountPercent} onChange={e => setDiscountPercent(e.target.value)} className="premium-input text-white" /></div>
            <div><label className="text-xs text-white/40 mb-1 block">Max Usage</label><Input type="number" value={maxUsage} onChange={e => setMaxUsage(e.target.value)} className="premium-input text-white" /></div>
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" onClick={() => setShowForm(false)} className="text-white/40" size="sm">Cancel</Button>
            <Button onClick={() => createMut.mutate({ competitionId, code, discountPercent: discountPercent ? parseInt(discountPercent) : null, maxUsage: maxUsage ? parseInt(maxUsage) : null })} disabled={!code} className="bg-blue-600 hover:bg-blue-700 text-white" size="sm" data-testid="button-save-coupon">Add</Button>
          </div>
        </div>
      )}

      {coupons.length === 0 && !showForm ? (
        <div className="text-center py-12 text-white/20">
          <Tag className="w-10 h-10 mx-auto mb-2" />
          <p className="text-sm">No coupons</p>
        </div>
      ) : (
        <div className="rounded-xl border border-white/5 bg-white/[0.02] overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-white/5">
                <th className="text-left text-[10px] text-white/30 uppercase px-4 py-2 font-semibold">Code</th>
                <th className="text-left text-[10px] text-white/30 uppercase px-4 py-2 font-semibold">Discount</th>
                <th className="text-left text-[10px] text-white/30 uppercase px-4 py-2 font-semibold">Usage</th>
                <th className="text-left text-[10px] text-white/30 uppercase px-4 py-2 font-semibold">Status</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {coupons.map(c => (
                <tr key={c.id} className="border-b border-white/[0.02]">
                  <td className="px-4 py-2.5 text-sm text-white/70 font-mono">{c.code}</td>
                  <td className="px-4 py-2.5 text-sm text-white/50">{c.discountPercent ? `${c.discountPercent}%` : c.discountAmountCents ? formatCurrency(c.discountAmountCents, { fromCents: true }) : "—"}</td>
                  <td className="px-4 py-2.5 text-sm text-white/40">{c.currentUsage || 0}{c.maxUsage ? ` / ${c.maxUsage}` : ""}</td>
                  <td className="px-4 py-2.5"><span className={`text-xs px-2 py-0.5 rounded-full ${c.active ? "bg-green-500/15 text-green-400" : "bg-red-500/15 text-red-400"}`}>{c.active ? "Active" : "Inactive"}</span></td>
                  <td className="px-3 py-2.5">
                    <button onClick={() => deleteMut.mutate(c.id)} className="w-6 h-6 flex items-center justify-center rounded hover:bg-red-500/10 text-white/20 hover:text-red-400"><Trash2 className="w-3.5 h-3.5" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function LeagueCompetitionDetail({ params }: { params: { id: string } }) {
  const [, setLocation] = useLocation();
  const { currentOrg } = useWorkspace();
  const orgId = currentOrg?.id;
  const competitionId = parseInt(params.id);
  const [activeTab, setActiveTab] = useState<TabId>("setup");

  const { data: competition } = useQuery<LeagueCompetition>({
    queryKey: ["/api/admin/league/competitions", competitionId],
    queryFn: () => fetch(`/api/admin/league/competitions/${competitionId}`).then(r => r.json()),
  });

  const { data: divisions = [] } = useQuery<LeagueDivision[]>({
    queryKey: ["/api/admin/league/competitions", competitionId, "divisions"],
    queryFn: () => fetch(`/api/admin/league/competitions/${competitionId}/divisions`).then(r => r.json()),
  });

  const { data: teams = [] } = useQuery<LeagueTeam[]>({
    queryKey: ["/api/admin/league/teams", { orgId, competitionId }],
    queryFn: () => fetch(`/api/admin/league/teams?orgId=${orgId}&competitionId=${competitionId}`).then(r => r.json()),
    enabled: !!orgId,
  });

  if (!competition) {
    return (
      <div className="p-6 flex items-center justify-center h-64">
        <div className="text-white/20 text-sm">Loading...</div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="flex items-center gap-3">
        <button onClick={() => setLocation("/admin/competitions")} className="w-8 h-8 rounded-lg bg-white/[0.03] border border-white/[0.06] flex items-center justify-center hover:bg-white/[0.06] text-white/30 hover:text-white/60 transition-all" data-testid="button-back-comps">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div>
          <h1 className="text-xl font-bold text-white" data-testid="text-comp-detail-title">{competition.name}</h1>
          <div className="flex items-center gap-2 mt-0.5">
            {competition.startDate && (
              <span className="text-xs text-white/20">
                {new Date(competition.startDate + "T12:00:00").toLocaleDateString("en-NZ", { day: "numeric", month: "short" })}
                {competition.endDate && ` - ${new Date(competition.endDate + "T12:00:00").toLocaleDateString("en-NZ", { day: "numeric", month: "short" })}`}
              </span>
            )}
            <span className={`text-[10px] px-2 py-0.5 rounded-full ${
              competition.registrationStatus === "open" ? "bg-green-500/15 text-green-400" :
              competition.registrationStatus === "closed" ? "bg-red-500/15 text-red-400" :
              "bg-white/5 text-white/25"
            }`}>
              {competition.registrationStatus === "open" ? "Reg. Open" : competition.registrationStatus === "closed" ? "Reg. Closed" : "—"}
            </span>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1 border-b border-white/[0.06] overflow-x-auto">
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-all whitespace-nowrap ${
              activeTab === tab.id
                ? "border-blue-500 text-blue-400"
                : "border-transparent text-white/30 hover:text-white/50"
            }`}
            data-testid={`tab-${tab.id}`}
          >
            <tab.icon className="w-3.5 h-3.5" />
            {tab.label}
          </button>
        ))}
      </div>

      <div>
        {activeTab === "setup" && <SetupTab competitionId={competitionId} teams={teams} />}
        {activeTab === "registration" && <RegistrationTab competition={competition} divisions={divisions} />}
        {activeTab === "coupons" && <CouponsTab competitionId={competitionId} />}
      </div>
    </div>
  );
}

// ── League (division) detail page — each league night, scoped to its division ──
const LEAGUE_TABS = [
  { id: "setup", label: "Setup", icon: Users },
  { id: "schedule", label: "Schedule", icon: Calendar },
  { id: "standings", label: "Standings", icon: BarChart3 },
  { id: "payments", label: "Payments", icon: Ticket },
  { id: "settings", label: "Settings", icon: Settings },
  { id: "discounts", label: "Discounts", icon: Tag },
] as const;

export function LeagueDetail({ params }: { params: { id: string; divisionId: string } }) {
  const [, setLocation] = useLocation();
  const { currentOrg } = useWorkspace();
  const orgId = currentOrg?.id;
  const competitionId = parseInt(params.id);
  const divisionId = parseInt(params.divisionId);
  const [activeTab, setActiveTab] = useState<string>("setup");
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showGenModal, setShowGenModal] = useState(false);

  const { data: divisions = [] } = useQuery<LeagueDivision[]>({
    queryKey: ["/api/admin/league/competitions", competitionId, "divisions"],
    queryFn: () => fetch(`/api/admin/league/competitions/${competitionId}/divisions`).then(r => r.json()),
  });
  const { data: teams = [] } = useQuery<LeagueTeam[]>({
    queryKey: ["/api/admin/league/teams", { orgId, competitionId }],
    queryFn: () => fetch(`/api/admin/league/teams?orgId=${orgId}&competitionId=${competitionId}`).then(r => r.json()),
    enabled: !!orgId,
  });

  const division = divisions.find(d => d.id === divisionId);
  const leagueTeams = teams.filter(t => t.divisionId === divisionId && t.active);

  if (divisions.length > 0 && !division) {
    return (
      <div className="p-6 text-sm text-white/40">
        League not found. <button onClick={() => setLocation(`/admin/competitions/${competitionId}`)} className="text-blue-400 hover:underline">Back to term</button>
      </div>
    );
  }
  if (!division) {
    return <div className="p-6 flex items-center justify-center h-64"><div className="text-white/20 text-sm">Loading...</div></div>;
  }

  const meta = [division.dayOfWeek, division.maxTeams != null ? `${leagueTeams.length}/${division.maxTeams} teams` : `${leagueTeams.length} team${leagueTeams.length === 1 ? "" : "s"}`].filter(Boolean).join(" · ");

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="flex items-center gap-3">
        <button onClick={() => setLocation(`/admin/competitions/${competitionId}`)} className="w-8 h-8 rounded-lg bg-white/[0.03] border border-white/[0.06] flex items-center justify-center hover:bg-white/[0.06] text-white/30 hover:text-white/60 transition-all" data-testid="button-back-term">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div>
          <h1 className="text-xl font-bold text-white" data-testid="text-league-title">{division.name}</h1>
          <p className="text-xs text-white/30 mt-0.5">{meta}</p>
        </div>
      </div>

      <div className="flex items-center gap-1 border-b border-white/[0.06] overflow-x-auto">
        {LEAGUE_TABS.map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-all whitespace-nowrap ${activeTab === tab.id ? "border-blue-500 text-blue-400" : "border-transparent text-white/30 hover:text-white/50"}`}
            data-testid={`ltab-${tab.id}`}>
            <tab.icon className="w-3.5 h-3.5" />{tab.label}
          </button>
        ))}
      </div>

      <div>
        {activeTab === "setup" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white">Teams</h3>
              {leagueTeams.length >= 2 && (
                <Button onClick={() => setShowGenModal(true)} variant="outline" className="border-white/10 text-white/70 hover:text-white gap-2" size="sm" data-testid="button-gen-fixtures">
                  <Wand2 className="w-3.5 h-3.5" />Generate fixtures
                </Button>
              )}
            </div>
            <LeagueTeamsList teams={leagueTeams} />
          </div>
        )}
        {activeTab === "schedule" && <ScheduleTab competitionId={competitionId} teams={teams} divisions={divisions} lockedDivisionId={divisionId} />}
        {activeTab === "standings" && <StandingsTab competitionId={competitionId} divisions={divisions} lockedDivisionId={divisionId} />}
        {activeTab === "payments" && <RegistrationsTab competitionId={competitionId} divisionName={division.name} />}
        {activeTab === "settings" && (
          <div className="rounded-xl border border-white/5 bg-white/[0.02] p-5 space-y-3 max-w-md">
            <div className="flex items-center justify-between"><span className="text-xs text-white/30 uppercase tracking-wider">League</span><span className="text-sm text-white/80">{division.name}</span></div>
            <div className="flex items-center justify-between"><span className="text-xs text-white/30 uppercase tracking-wider">Day</span><span className="text-sm text-white/80">{division.dayOfWeek || "—"}</span></div>
            <div className="flex items-center justify-between"><span className="text-xs text-white/30 uppercase tracking-wider">Max teams</span><span className="text-sm text-white/80">{division.maxTeams ?? "—"}</span></div>
            <div className="flex items-center justify-between"><span className="text-xs text-white/30 uppercase tracking-wider">Team cost</span><span className="text-sm text-white/80">{formatCurrency(division.teamCostCents || 0, { fromCents: true })}</span></div>
            <Button onClick={() => setShowSettingsModal(true)} className="bg-blue-600 hover:bg-blue-700 text-white gap-2 mt-2" size="sm" data-testid="button-edit-league-settings"><Pencil className="w-3.5 h-3.5" />Edit league</Button>
          </div>
        )}
        {activeTab === "discounts" && (
          <div className="rounded-xl border border-white/5 bg-white/[0.02] p-8 text-center space-y-3">
            <Tag className="w-8 h-8 mx-auto text-white/20" />
            <p className="text-sm text-white/60">Discount codes are shared across all Mini Football Leagues.</p>
            <Button onClick={() => setLocation("/admin/discounts")} variant="outline" className="border-white/10 text-white/70 hover:text-white gap-2" size="sm"><ExternalLink className="w-3.5 h-3.5" />Manage discount codes</Button>
          </div>
        )}
      </div>

      {showSettingsModal && <DivisionModal competitionId={competitionId} division={division} onClose={() => setShowSettingsModal(false)} />}
      {showGenModal && <FixtureGenModal competitionId={competitionId} divisions={[division]} teams={teams} onClose={() => setShowGenModal(false)} />}
    </div>
  );
}
