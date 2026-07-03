import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useWorkspace } from "@/lib/workspace-context";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { UsersRound, Plus, Search, Pencil, Trash2, X, Hourglass } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { LeagueTeam, LeagueCompetition, LeagueDivision } from "@shared/schema";

type TeamWithDiv = LeagueTeam & { division?: LeagueDivision };

function TeamModal({ team, orgId, competitions, onClose }: { team?: TeamWithDiv; orgId: number; competitions: LeagueCompetition[]; onClose: () => void }) {
  const { toast } = useToast();
  const [form, setForm] = useState({
    name: team?.name || "",
    competitionId: team?.competitionId?.toString() || (competitions[0]?.id?.toString() || ""),
    divisionId: team?.divisionId?.toString() || "",
    contactName: team?.contactName || "",
    contactEmail: team?.contactEmail || "",
    contactPhone: team?.contactPhone || "",
    primaryColor: team?.primaryColor || "",
    secondaryColor: team?.secondaryColor || "",
  });

  const selectedCompId = form.competitionId ? parseInt(form.competitionId) : undefined;
  const { data: divisions = [] } = useQuery<LeagueDivision[]>({
    queryKey: ["/api/admin/league/competitions", selectedCompId, "divisions"],
    queryFn: () => fetch(`/api/admin/league/competitions/${selectedCompId}/divisions`).then(r => r.json()),
    enabled: !!selectedCompId,
  });

  const createMut = useMutation({
    mutationFn: (d: any) => apiRequest("POST", "/api/admin/league/teams", d),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/admin/league/teams"] }); toast({ title: "Team created" }); onClose(); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });
  const updateMut = useMutation({
    mutationFn: (d: any) => apiRequest("PATCH", `/api/admin/league/teams/${team!.id}`, d),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/admin/league/teams"] }); toast({ title: "Team updated" }); onClose(); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const handleSave = () => {
    const data = {
      organizationId: orgId,
      name: form.name,
      competitionId: parseInt(form.competitionId),
      divisionId: form.divisionId ? parseInt(form.divisionId) : null,
      contactName: form.contactName || null,
      contactEmail: form.contactEmail || null,
      contactPhone: form.contactPhone || null,
      primaryColor: form.primaryColor || null,
      secondaryColor: form.secondaryColor || null,
    };
    team ? updateMut.mutate(data) : createMut.mutate(data);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-[#0a0e1a] border border-blue-500/15 rounded-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto shadow-2xl">
        <div className="flex items-center justify-between p-5 border-b border-white/5">
          <h2 className="text-lg font-semibold text-white">{team ? "Edit Team" : "New Team"}</h2>
          <button onClick={onClose} className="text-white/30 hover:text-white/60"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 space-y-3">
          <div><label className="text-xs text-white/40 mb-1 block">Team Name</label><Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="premium-input text-white" data-testid="input-team-name" /></div>
          <div><label className="text-xs text-white/40 mb-1 block">Competition</label>
            <Select value={form.competitionId} onValueChange={v => setForm(f => ({ ...f, competitionId: v, divisionId: "" }))}>
              <SelectTrigger className="premium-input text-white"><SelectValue placeholder="Select competition" /></SelectTrigger>
              <SelectContent>{competitions.map(c => <SelectItem key={c.id} value={c.id.toString()}>{c.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          {divisions.length > 0 && (
            <div><label className="text-xs text-white/40 mb-1 block">Division</label>
              <Select value={form.divisionId} onValueChange={v => setForm(f => ({ ...f, divisionId: v }))}>
                <SelectTrigger className="premium-input text-white"><SelectValue placeholder="Select division" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No Division</SelectItem>
                  {divisions.map(d => <SelectItem key={d.id} value={d.id.toString()}>{d.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-3 pt-2">
            <label className="text-xs text-white/30 uppercase tracking-wider font-semibold">Contact</label>
            <Input placeholder="Contact Name" value={form.contactName} onChange={e => setForm(f => ({ ...f, contactName: e.target.value }))} className="premium-input text-white" />
            <Input placeholder="Email" value={form.contactEmail} onChange={e => setForm(f => ({ ...f, contactEmail: e.target.value }))} className="premium-input text-white" />
            <Input placeholder="Phone" value={form.contactPhone} onChange={e => setForm(f => ({ ...f, contactPhone: e.target.value }))} className="premium-input text-white" />
          </div>
          <div className="grid grid-cols-2 gap-3 pt-2">
            <div><label className="text-xs text-white/40 mb-1 block">Primary Color</label><Input type="color" value={form.primaryColor || "#22399B"} onChange={e => setForm(f => ({ ...f, primaryColor: e.target.value }))} className="h-9 p-1 bg-transparent border border-white/10 rounded-lg" /></div>
            <div><label className="text-xs text-white/40 mb-1 block">Secondary Color</label><Input type="color" value={form.secondaryColor || "#FFFFFF"} onChange={e => setForm(f => ({ ...f, secondaryColor: e.target.value }))} className="h-9 p-1 bg-transparent border border-white/10 rounded-lg" /></div>
          </div>
        </div>
        <div className="p-5 border-t border-white/5 flex gap-2 justify-end">
          <Button variant="ghost" onClick={onClose} className="text-white/40">Cancel</Button>
          <Button onClick={handleSave} disabled={!form.name || !form.competitionId} className="bg-blue-600 hover:bg-blue-700 text-white" data-testid="button-save-team">Save</Button>
        </div>
      </div>
    </div>
  );
}

export default function LeagueTeams() {
  const { currentOrg } = useWorkspace();
  const orgId = currentOrg?.id;
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [compFilter, setCompFilter] = useState("all");
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<TeamWithDiv | undefined>();

  const { data: teams = [], isLoading } = useQuery<TeamWithDiv[]>({
    queryKey: ["/api/admin/league/teams", { orgId }],
    queryFn: () => fetch(`/api/admin/league/teams?orgId=${orgId}`).then(r => r.json()),
    enabled: !!orgId,
  });

  const { data: competitions = [] } = useQuery<LeagueCompetition[]>({
    queryKey: ["/api/admin/league/competitions", { orgId }],
    queryFn: () => fetch(`/api/admin/league/competitions?orgId=${orgId}`).then(r => r.json()),
    enabled: !!orgId,
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/admin/league/teams/${id}`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/admin/league/teams"] }); toast({ title: "Team deleted" }); },
  });

  const filtered = teams
    .filter(t => compFilter === "all" || t.competitionId.toString() === compFilter)
    .filter(t => !search || t.name.toLowerCase().includes(search.toLowerCase()));

  const compMap = Object.fromEntries(competitions.map(c => [c.id, c.name]));

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white" data-testid="text-teams-title">Teams</h1>
          <p className="text-sm text-white/40 mt-1">{teams.length} team{teams.length !== 1 ? "s" : ""} across all competitions</p>
        </div>
        <Button onClick={() => { setEditing(undefined); setShowModal(true); }} className="bg-blue-600 hover:bg-blue-700 text-white gap-2" data-testid="button-new-team" disabled={competitions.length === 0}>
          <Plus className="w-4 h-4" />
          New Team
        </Button>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/20" />
          <Input placeholder="Search teams..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9 premium-input text-white" data-testid="input-search-teams" />
        </div>
        {competitions.length > 0 && (
          <Select value={compFilter} onValueChange={setCompFilter}>
            <SelectTrigger className="premium-input text-white w-[200px]"><SelectValue placeholder="Competition" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Competitions</SelectItem>
              {competitions.map(c => <SelectItem key={c.id} value={c.id.toString()}>{c.name}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map(i => <div key={i} className="h-16 rounded-2xl bg-white/[0.02] animate-pulse" />)}
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-blue-500/10 bg-white/[0.02] p-5">
          <div className="flex flex-col items-center justify-center py-16 text-white/20">
            <UsersRound className="w-12 h-12 mb-3" />
            <p className="text-sm">No teams yet</p>
            {competitions.length === 0 && <p className="text-xs mt-1">Create a competition first, then add teams</p>}
          </div>
        </div>
      ) : (
        <div className="rounded-2xl border border-blue-500/10 bg-white/[0.02] overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-white/5">
                <th className="text-left text-[10px] text-white/30 uppercase tracking-wider font-semibold px-5 py-3">Team</th>
                <th className="text-left text-[10px] text-white/30 uppercase tracking-wider font-semibold px-5 py-3 hidden sm:table-cell">Competition</th>
                <th className="text-left text-[10px] text-white/30 uppercase tracking-wider font-semibold px-5 py-3 hidden md:table-cell">Division</th>
                <th className="text-left text-[10px] text-white/30 uppercase tracking-wider font-semibold px-5 py-3 hidden md:table-cell">Contact</th>
                <th className="w-20" />
              </tr>
            </thead>
            <tbody>
              {filtered.map(t => (
                <tr key={t.id} className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors" data-testid={`team-row-${t.id}`}>
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 border border-white/10" style={{ backgroundColor: t.primaryColor || "#22399B" }}>
                        <span className="text-[10px] font-bold text-white">{t.name.substring(0, 2).toUpperCase()}</span>
                      </div>
                      <span className="text-sm font-medium text-white/80">{t.name}</span>
                    </div>
                  </td>
                  <td className="px-5 py-3.5 text-sm text-white/40 hidden sm:table-cell">{compMap[t.competitionId] || "—"}</td>
                  <td className="px-5 py-3.5 text-sm text-white/40 hidden md:table-cell">{t.division?.name || "—"}</td>
                  <td className="px-5 py-3.5 text-sm text-white/40 hidden md:table-cell">{t.contactName || "—"}</td>
                  <td className="px-3 py-3.5">
                    <div className="flex items-center gap-1">
                      <button onClick={() => { setEditing(t); setShowModal(true); }} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-white/5 text-white/30" data-testid={`button-edit-team-${t.id}`}><Pencil className="w-3.5 h-3.5" /></button>
                      <button onClick={() => deleteMut.mutate(t.id)} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-red-500/10 text-white/30 hover:text-red-400"><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <WaitlistPanel orgId={orgId!} />

      {showModal && <TeamModal team={editing} orgId={orgId!} competitions={competitions} onClose={() => { setShowModal(false); setEditing(undefined); }} />}
    </div>
  );
}

// Waitlist signups from the public join site (sold-out nights). Shown only when
// entries exist — first call goes to the oldest 'waiting' entry when a spot opens.
type WaitlistEntry = {
  id: number; teamName: string; contactName: string; email: string; phone: string | null;
  status: string; createdAt: string;
  divisions: { id: number; name: string; dayOfWeek: string | null }[];
};

const WAITLIST_STATUSES = [
  { value: "waiting", label: "Waiting" },
  { value: "contacted", label: "Contacted" },
  { value: "converted", label: "Converted" },
];

function WaitlistPanel({ orgId }: { orgId: number }) {
  const { toast } = useToast();
  const { data: entries = [] } = useQuery<WaitlistEntry[]>({
    queryKey: ["/api/admin/league/waitlist", { orgId }],
    queryFn: () => fetch(`/api/admin/league/waitlist?orgId=${orgId}`).then(r => r.json()),
    enabled: !!orgId,
  });

  const statusMut = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) => apiRequest("PATCH", `/api/admin/league/waitlist/${id}`, { status }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/admin/league/waitlist", { orgId }] }),
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });
  const deleteMut = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/admin/league/waitlist/${id}`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/admin/league/waitlist", { orgId }] }); toast({ title: "Waitlist entry removed" }); },
  });

  if (!Array.isArray(entries) || entries.length === 0) return null;
  const waiting = entries.filter(e => e.status === "waiting").length;

  return (
    <div>
      <div className="flex items-center gap-2.5 mb-3 mt-2">
        <Hourglass className="w-4 h-4 text-amber-400" />
        <h2 className="text-lg font-semibold text-white" data-testid="text-waitlist-title">Waitlist</h2>
        <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-400/10 text-amber-400 border border-amber-400/20">{waiting} waiting</span>
      </div>
      <p className="text-xs text-white/40 mb-3">Captains who wanted a sold-out night. When a spot opens, call the oldest "Waiting" entry first.</p>
      <div className="rounded-2xl border border-blue-500/10 bg-white/[0.02] overflow-hidden overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-white/5">
              <th className="text-left text-[10px] text-white/30 uppercase tracking-wider font-semibold px-5 py-3">Team</th>
              <th className="text-left text-[10px] text-white/30 uppercase tracking-wider font-semibold px-5 py-3">Wants</th>
              <th className="text-left text-[10px] text-white/30 uppercase tracking-wider font-semibold px-5 py-3 hidden md:table-cell">Contact</th>
              <th className="text-left text-[10px] text-white/30 uppercase tracking-wider font-semibold px-5 py-3 hidden sm:table-cell">Since</th>
              <th className="text-left text-[10px] text-white/30 uppercase tracking-wider font-semibold px-5 py-3">Status</th>
              <th className="w-14" />
            </tr>
          </thead>
          <tbody>
            {entries.map(e => (
              <tr key={e.id} className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors" data-testid={`waitlist-row-${e.id}`}>
                <td className="px-5 py-3.5">
                  <p className="text-sm font-medium text-white/80">{e.teamName}</p>
                  <p className="text-xs text-white/35">{e.contactName}</p>
                </td>
                <td className="px-5 py-3.5">
                  <div className="flex flex-wrap gap-1.5">
                    {e.divisions.map(d => (
                      <span key={d.id} className="text-[11px] px-2 py-0.5 rounded-full bg-white/5 text-white/60 border border-white/10 whitespace-nowrap">{d.name}</span>
                    ))}
                  </div>
                </td>
                <td className="px-5 py-3.5 text-sm hidden md:table-cell">
                  <a href={`mailto:${e.email}`} className="block text-blue-400/80 hover:text-blue-300">{e.email}</a>
                  {e.phone && <a href={`tel:${e.phone}`} className="block text-white/40 hover:text-white/70 text-xs mt-0.5">{e.phone}</a>}
                </td>
                <td className="px-5 py-3.5 text-sm text-white/40 hidden sm:table-cell whitespace-nowrap">
                  {new Date(e.createdAt).toLocaleDateString("en-NZ", { day: "numeric", month: "short" })}
                </td>
                <td className="px-5 py-3.5">
                  <Select value={e.status} onValueChange={(v) => statusMut.mutate({ id: e.id, status: v })}>
                    <SelectTrigger className="premium-input text-white h-8 w-[130px] text-xs" data-testid={`waitlist-status-${e.id}`}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {WAITLIST_STATUSES.map(s => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </td>
                <td className="px-3 py-3.5">
                  <button onClick={() => deleteMut.mutate(e.id)} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-red-500/10 text-white/30 hover:text-red-400" data-testid={`waitlist-delete-${e.id}`}><Trash2 className="w-3.5 h-3.5" /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
