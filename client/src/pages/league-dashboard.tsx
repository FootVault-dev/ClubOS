import { useQuery } from "@tanstack/react-query";
import { useWorkspace } from "@/lib/workspace-context";
import { Trophy, UsersRound, Calendar, TrendingUp, Sparkles } from "lucide-react";
import type { LeagueCompetition, LeagueTeam, LeagueGame } from "@shared/schema";

export default function LeagueDashboard() {
  const { currentOrg } = useWorkspace();
  const orgId = currentOrg?.id;

  const { data: competitions = [] } = useQuery<LeagueCompetition[]>({
    queryKey: ["/api/admin/league/competitions", { orgId }],
    queryFn: () => fetch(`/api/admin/league/competitions?orgId=${orgId}`).then(r => r.json()),
    enabled: !!orgId,
  });

  const { data: teams = [] } = useQuery<LeagueTeam[]>({
    queryKey: ["/api/admin/league/teams", { orgId }],
    queryFn: () => fetch(`/api/admin/league/teams?orgId=${orgId}`).then(r => r.json()),
    enabled: !!orgId,
  });

  const activeComps = competitions.filter(c => c.active && !c.archived);
  const openReg = competitions.filter(c => c.registrationStatus === "open");

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white" data-testid="text-league-dashboard-title">Dashboard</h1>
        <p className="text-sm text-white/40 mt-1">Overview of your league management</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-2xl border border-blue-500/15 bg-gradient-to-br from-blue-500/10 to-blue-500/5 p-5" data-testid="stat-competitions">
          <Trophy className="w-5 h-5 text-white/50 mb-3" />
          <p className="text-2xl font-bold text-white">{competitions.length}</p>
          <p className="text-xs text-white/40 mt-1">Competitions</p>
        </div>
        <div className="rounded-2xl border border-blue-500/15 bg-gradient-to-br from-blue-500/10 to-blue-500/5 p-5" data-testid="stat-active-comps">
          <Sparkles className="w-5 h-5 text-white/50 mb-3" />
          <p className="text-2xl font-bold text-white">{activeComps.length}</p>
          <p className="text-xs text-white/40 mt-1">Active</p>
        </div>
        <div className="rounded-2xl border border-blue-500/15 bg-gradient-to-br from-blue-500/10 to-blue-500/5 p-5" data-testid="stat-teams">
          <UsersRound className="w-5 h-5 text-white/50 mb-3" />
          <p className="text-2xl font-bold text-white">{teams.length}</p>
          <p className="text-xs text-white/40 mt-1">Total Teams</p>
        </div>
        <div className="rounded-2xl border border-blue-500/15 bg-gradient-to-br from-blue-500/10 to-blue-500/5 p-5" data-testid="stat-open-reg">
          <TrendingUp className="w-5 h-5 text-white/50 mb-3" />
          <p className="text-2xl font-bold text-white">{openReg.length}</p>
          <p className="text-xs text-white/40 mt-1">Registration Open</p>
        </div>
      </div>

      <div className="rounded-2xl border border-blue-500/10 bg-white/[0.02] p-5">
        <div className="flex items-center gap-2 mb-4">
          <Trophy className="w-4 h-4 text-white/40" />
          <h3 className="text-sm font-semibold text-white">Active Competitions</h3>
        </div>
        {activeComps.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-white/20">
            <Trophy className="w-10 h-10 mb-2" />
            <p className="text-sm">No active competitions</p>
            <p className="text-xs mt-1">Create your first competition to get started</p>
          </div>
        ) : (
          <div className="space-y-2">
            {activeComps.map(c => {
              const compTeams = teams.filter(t => t.competitionId === c.id);
              return (
                <div key={c.id} className="flex items-center justify-between py-3 border-b border-white/5 last:border-0" data-testid={`comp-row-${c.id}`}>
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-blue-500/15 flex items-center justify-center">
                      <Trophy className="w-4 h-4 text-blue-400" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-white/80">{c.name}</p>
                      <p className="text-xs text-white/30">{compTeams.length} team{compTeams.length === 1 ? "" : "s"}</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${
                      c.registrationStatus === "open" ? "bg-green-500/15 text-green-400" :
                      c.registrationStatus === "closed" ? "bg-red-500/15 text-red-400" :
                      "bg-white/5 text-white/30"
                    }`}>
                      {c.registrationStatus === "open" ? "Registration Open" :
                       c.registrationStatus === "closed" ? "Registration Closed" : "No Registration"}
                    </span>
                    {c.startDate && (
                      <p className="text-[10px] text-white/20 mt-1">
                        {new Date(c.startDate + "T12:00:00").toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" })}
                        {c.endDate && ` - ${new Date(c.endDate + "T12:00:00").toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" })}`}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-blue-500/10 bg-white/[0.02] p-5">
        <div className="flex items-center gap-2 mb-4">
          <UsersRound className="w-4 h-4 text-white/40" />
          <h3 className="text-sm font-semibold text-white">Teams by Competition</h3>
        </div>
        {competitions.length === 0 ? (
          <p className="text-sm text-white/20 text-center py-6">No data yet</p>
        ) : (
          <div className="space-y-3">
            {competitions.filter(c => !c.archived).map(c => {
              const count = teams.filter(t => t.competitionId === c.id).length;
              const maxCount = Math.max(...competitions.map(comp => teams.filter(t => t.competitionId === comp.id).length), 1);
              return (
                <div key={c.id} className="flex items-center gap-3">
                  <span className="text-xs text-white/50 w-32 text-right truncate">{c.name}</span>
                  <div className="flex-1 h-5 bg-white/5 rounded overflow-hidden">
                    <div className="h-full bg-blue-500 rounded" style={{ width: `${(count / maxCount) * 100}%` }} />
                  </div>
                  <span className="text-xs text-white/30 w-6">{count}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
