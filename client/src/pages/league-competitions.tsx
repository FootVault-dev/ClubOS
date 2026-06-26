import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useWorkspace } from "@/lib/workspace-context";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useLocation } from "wouter";
import { Trophy, Plus, Search, Archive, MoreVertical, Copy, Trash2, X, Calendar } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DatePickerInput } from "@/components/ui/date-picker-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { LeagueCompetition } from "@shared/schema";

function CompetitionModal({ competition, orgId, onClose }: { competition?: LeagueCompetition; orgId: number; onClose: () => void }) {
  const { toast } = useToast();
  const [form, setForm] = useState({
    name: competition?.name || "",
    sport: competition?.sport || "Soccer",
    startDate: competition?.startDate || "",
    endDate: competition?.endDate || "",
    youthLeague: competition?.youthLeague ?? true,
    teamChat: competition?.teamChat ?? false,
    playoffCompetition: competition?.playoffCompetition ?? false,
    enableRegistration: competition?.enableRegistration ?? false,
    isPrivate: competition?.isPrivate ?? false,
    contactEmail: competition?.contactEmail || "",
    contactPhone: competition?.contactPhone || "",
    contactWebsite: competition?.contactWebsite || "",
  });

  const createMutation = useMutation({
    mutationFn: (data: any) => apiRequest("POST", "/api/admin/league/competitions", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/league/competitions"] });
      toast({ title: "League created" });
      onClose();
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: (data: any) => apiRequest("PATCH", `/api/admin/league/competitions/${competition!.id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/league/competitions"] });
      toast({ title: "League updated" });
      onClose();
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const handleSubmit = () => {
    const data = { ...form, organizationId: orgId };
    if (competition) updateMutation.mutate(data);
    else createMutation.mutate(data);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-[#0a0e1a] border border-blue-500/15 rounded-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto shadow-2xl">
        <div className="flex items-center justify-between p-5 border-b border-white/5">
          <h2 className="text-lg font-semibold text-white">{competition ? "Edit League" : "New League"}</h2>
          <button onClick={onClose} className="text-white/30 hover:text-white/60"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="text-xs text-white/40 mb-1 block">Name</label>
            <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="premium-input text-white" data-testid="input-comp-name" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-white/40 mb-1 block">Start Date</label>
              <DatePickerInput value={form.startDate} onChange={e => setForm(f => ({ ...f, startDate: e.target.value }))} className="premium-input text-white" data-testid="input-comp-start" />
            </div>
            <div>
              <label className="text-xs text-white/40 mb-1 block">End Date</label>
              <DatePickerInput value={form.endDate} onChange={e => setForm(f => ({ ...f, endDate: e.target.value }))} className="premium-input text-white" data-testid="input-comp-end" />
            </div>
          </div>

          <div className="space-y-3 pt-2">
            <label className="text-xs text-white/30 uppercase tracking-wider font-semibold">Options</label>
            <div className="flex items-center justify-between">
              <span className="text-sm text-white/60">Youth League</span>
              <Switch checked={form.youthLeague} onCheckedChange={v => setForm(f => ({ ...f, youthLeague: v }))} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-white/60">Team Chat</span>
              <Switch checked={form.teamChat} onCheckedChange={v => setForm(f => ({ ...f, teamChat: v }))} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-white/60">Playoff League</span>
              <Switch checked={form.playoffCompetition} onCheckedChange={v => setForm(f => ({ ...f, playoffCompetition: v }))} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-white/60">Enable Registration</span>
              <Switch checked={form.enableRegistration} onCheckedChange={v => setForm(f => ({ ...f, enableRegistration: v }))} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-white/60">Private</span>
              <Switch checked={form.isPrivate} onCheckedChange={v => setForm(f => ({ ...f, isPrivate: v }))} />
            </div>
          </div>

          <div className="space-y-3 pt-2">
            <label className="text-xs text-white/30 uppercase tracking-wider font-semibold">Contact Info</label>
            <Input placeholder="Email" value={form.contactEmail} onChange={e => setForm(f => ({ ...f, contactEmail: e.target.value }))} className="premium-input text-white" data-testid="input-comp-email" />
            <Input placeholder="Phone" value={form.contactPhone} onChange={e => setForm(f => ({ ...f, contactPhone: e.target.value }))} className="premium-input text-white" />
            <Input placeholder="Website" value={form.contactWebsite} onChange={e => setForm(f => ({ ...f, contactWebsite: e.target.value }))} className="premium-input text-white" />
          </div>
        </div>
        <div className="p-5 border-t border-white/5 flex gap-2 justify-end">
          <Button variant="ghost" onClick={onClose} className="text-white/40">Cancel</Button>
          <Button onClick={handleSubmit} disabled={!form.name || createMutation.isPending || updateMutation.isPending} className="bg-blue-600 hover:bg-blue-700 text-white" data-testid="button-save-comp">
            {competition ? "Update" : "Create"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function LeagueCompetitions() {
  const { currentOrg } = useWorkspace();
  const orgId = currentOrg?.id;
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<LeagueCompetition | undefined>();
  const [menuOpen, setMenuOpen] = useState<number | null>(null);

  const { data: competitions = [], isLoading } = useQuery<LeagueCompetition[]>({
    queryKey: ["/api/admin/league/competitions", { orgId }],
    queryFn: () => fetch(`/api/admin/league/competitions?orgId=${orgId}`).then(r => r.json()),
    enabled: !!orgId,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/admin/league/competitions/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/league/competitions"] });
      toast({ title: "League deleted" });
    },
  });

  const archiveMutation = useMutation({
    mutationFn: (comp: LeagueCompetition) => apiRequest("PATCH", `/api/admin/league/competitions/${comp.id}`, { archived: !comp.archived }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/league/competitions"] });
      toast({ title: "Updated" });
    },
  });

  const cloneMutation = useMutation({
    mutationFn: (comp: LeagueCompetition) => apiRequest("POST", "/api/admin/league/competitions", {
      organizationId: comp.organizationId,
      name: `${comp.name} (Copy)`,
      sport: comp.sport,
      youthLeague: comp.youthLeague,
      teamChat: comp.teamChat,
      playoffCompetition: comp.playoffCompetition,
      enableRegistration: comp.enableRegistration,
      isPrivate: comp.isPrivate,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/league/competitions"] });
      toast({ title: "League cloned" });
    },
  });

  const filtered = competitions
    .filter(c => showArchived ? c.archived : !c.archived)
    .filter(c => !search || c.name.toLowerCase().includes(search.toLowerCase()));

  const gamesCountMap: Record<number, number> = {};

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white" data-testid="text-competitions-title">Leagues</h1>
          <p className="text-sm text-white/40 mt-1">{competitions.length} league{competitions.length !== 1 ? "s" : ""}</p>
        </div>
        <Button onClick={() => { setEditing(undefined); setShowModal(true); }} className="bg-blue-600 hover:bg-blue-700 text-white gap-2" data-testid="button-new-competition">
          <Plus className="w-4 h-4" />
          New League
        </Button>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/20" />
          <Input placeholder="Search leagues..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9 premium-input text-white" data-testid="input-search-competitions" />
        </div>
        <div className="flex items-center gap-2">
          <Switch checked={showArchived} onCheckedChange={setShowArchived} />
          <span className="text-xs text-white/30">Show Archived</span>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map(i => <div key={i} className="h-20 rounded-2xl bg-white/[0.02] animate-pulse" />)}
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-blue-500/10 bg-white/[0.02] p-5">
          <div className="flex flex-col items-center justify-center py-16 text-white/20">
            <Trophy className="w-12 h-12 mb-3" />
            <p className="text-sm">{showArchived ? "No archived leagues" : "No leagues yet"}</p>
            <p className="text-xs mt-1">Create a new league to get started</p>
          </div>
        </div>
      ) : (
        <div className="rounded-2xl border border-blue-500/10 bg-white/[0.02] overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-white/5">
                <th className="text-left text-[10px] text-white/30 uppercase tracking-wider font-semibold px-5 py-3">Name</th>
                <th className="text-left text-[10px] text-white/30 uppercase tracking-wider font-semibold px-5 py-3 hidden sm:table-cell">Start</th>
                <th className="text-left text-[10px] text-white/30 uppercase tracking-wider font-semibold px-5 py-3 hidden sm:table-cell">End</th>
                <th className="text-left text-[10px] text-white/30 uppercase tracking-wider font-semibold px-5 py-3">Registration</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {filtered.map(c => (
                <tr
                  key={c.id}
                  className="border-b border-white/[0.03] hover:bg-white/[0.02] cursor-pointer transition-colors"
                  data-testid={`comp-row-${c.id}`}
                  onClick={() => setLocation(`/admin/competitions/${c.id}`)}
                >
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg bg-blue-500/15 flex items-center justify-center flex-shrink-0">
                        <Trophy className="w-4 h-4 text-blue-400" />
                      </div>
                      <span className="text-sm font-medium text-white/80">{c.name}</span>
                    </div>
                  </td>
                  <td className="px-5 py-3.5 text-sm text-white/40 hidden sm:table-cell">
                    {c.startDate ? new Date(c.startDate + "T12:00:00").toLocaleDateString("en-NZ", { day: "numeric", month: "short" }) : "—"}
                  </td>
                  <td className="px-5 py-3.5 text-sm text-white/40 hidden sm:table-cell">
                    {c.endDate ? new Date(c.endDate + "T12:00:00").toLocaleDateString("en-NZ", { day: "numeric", month: "short" }) : "—"}
                  </td>
                  <td className="px-5 py-3.5">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${
                      c.registrationStatus === "open" ? "bg-green-500/15 text-green-400" :
                      c.registrationStatus === "closed" ? "bg-red-500/15 text-red-400" :
                      "bg-white/5 text-white/30"
                    }`}>
                      {c.registrationStatus === "open" ? "Open" : c.registrationStatus === "closed" ? "Closed" : "—"}
                    </span>
                  </td>
                  <td className="px-3 py-3.5 relative">
                    <button
                      onClick={e => { e.stopPropagation(); setMenuOpen(menuOpen === c.id ? null : c.id); }}
                      className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-white/5 text-white/30"
                      data-testid={`button-comp-menu-${c.id}`}
                    >
                      <MoreVertical className="w-4 h-4" />
                    </button>
                    {menuOpen === c.id && (
                      <>
                        <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(null)} />
                        <div className="absolute right-3 top-full z-50 bg-[#0a0e1a] border border-blue-500/15 rounded-xl shadow-xl py-1 w-40">
                          <button onClick={e => { e.stopPropagation(); setEditing(c); setShowModal(true); setMenuOpen(null); }} className="w-full px-3 py-2 text-sm text-white/60 hover:bg-white/5 text-left">Edit</button>
                          <button onClick={e => { e.stopPropagation(); cloneMutation.mutate(c); setMenuOpen(null); }} className="w-full px-3 py-2 text-sm text-white/60 hover:bg-white/5 text-left flex items-center gap-2"><Copy className="w-3.5 h-3.5" />Clone</button>
                          <button onClick={e => { e.stopPropagation(); archiveMutation.mutate(c); setMenuOpen(null); }} className="w-full px-3 py-2 text-sm text-white/60 hover:bg-white/5 text-left flex items-center gap-2"><Archive className="w-3.5 h-3.5" />{c.archived ? "Unarchive" : "Archive"}</button>
                          <button onClick={e => { e.stopPropagation(); deleteMutation.mutate(c.id); setMenuOpen(null); }} className="w-full px-3 py-2 text-sm text-red-400/70 hover:bg-red-500/10 text-left flex items-center gap-2"><Trash2 className="w-3.5 h-3.5" />Delete</button>
                        </div>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showModal && <CompetitionModal competition={editing} orgId={orgId!} onClose={() => { setShowModal(false); setEditing(undefined); }} />}
    </div>
  );
}
