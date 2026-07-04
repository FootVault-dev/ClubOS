import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useWorkspace } from "@/lib/workspace-context";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useLocation } from "wouter";
import { Award, Plus, Search, MoreVertical, Trash2, Archive, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/ui/money-input";
import { centsToDollarInput, dollarInputToCents } from "@/lib/format";
import { DatePickerInput } from "@/components/ui/date-picker-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { Tournament } from "@shared/schema";

function TournamentModal({ tournament, orgId, onClose }: { tournament?: Tournament; orgId: number; onClose: () => void }) {
  const { toast } = useToast();
  const [form, setForm] = useState({
    name: tournament?.name || "",
    ageGroup: tournament?.ageGroup || "",
    startDate: tournament?.startDate || "",
    endDate: tournament?.endDate || "",
    location: tournament?.location || "",
    numGroups: tournament?.numGroups?.toString() || "4",
    teamsPerGroup: tournament?.teamsPerGroup?.toString() || "4",
    gameDurationMinutes: tournament?.gameDurationMinutes?.toString() || "20",
    breakBetweenMinutes: tournament?.breakBetweenMinutes?.toString() || "5",
    pointsForWin: tournament?.pointsForWin?.toString() || "3",
    pointsForDraw: tournament?.pointsForDraw?.toString() || "1",
    pointsForLoss: tournament?.pointsForLoss?.toString() || "0",
    registrationFee: centsToDollarInput(tournament?.registrationFeeCents),
  });

  const createMut = useMutation({
    mutationFn: (data: any) => apiRequest("POST", "/api/admin/tournament/tournaments", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/tournament/tournaments"] });
      toast({ title: "Tournament created" });
      onClose();
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const updateMut = useMutation({
    mutationFn: (data: any) => apiRequest("PATCH", `/api/admin/tournament/tournaments/${tournament!.id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/tournament/tournaments"] });
      toast({ title: "Tournament updated" });
      onClose();
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const handleSubmit = () => {
    const data = {
      organizationId: orgId,
      name: form.name,
      ageGroup: form.ageGroup || null,
      startDate: form.startDate || null,
      endDate: form.endDate || null,
      location: form.location || null,
      numGroups: parseInt(form.numGroups) || 4,
      teamsPerGroup: parseInt(form.teamsPerGroup) || 4,
      gameDurationMinutes: parseInt(form.gameDurationMinutes) || 20,
      breakBetweenMinutes: parseInt(form.breakBetweenMinutes) || 5,
      pointsForWin: parseInt(form.pointsForWin),
      pointsForDraw: parseInt(form.pointsForDraw),
      pointsForLoss: parseInt(form.pointsForLoss),
      registrationFeeCents: dollarInputToCents(form.registrationFee),
    };
    tournament ? updateMut.mutate(data) : createMut.mutate(data);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-[#0a0e1a] border border-blue-500/15 rounded-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto shadow-2xl">
        <div className="flex items-center justify-between p-5 border-b border-white/5">
          <h2 className="text-lg font-semibold text-white">{tournament ? "Edit Tournament" : "New Tournament"}</h2>
          <button onClick={onClose} className="text-white/30 hover:text-white/60"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="text-xs text-white/40 mb-1 block">Tournament Name</label>
            <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="premium-input text-white" data-testid="input-tournament-name" placeholder="e.g. U10 Christchurch International Cup 2026" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-white/40 mb-1 block">Age Group</label>
              <Input value={form.ageGroup} onChange={e => setForm(f => ({ ...f, ageGroup: e.target.value }))} className="premium-input text-white" placeholder="e.g. U10" />
            </div>
            <div>
              <label className="text-xs text-white/40 mb-1 block">Location</label>
              <Input value={form.location} onChange={e => setForm(f => ({ ...f, location: e.target.value }))} className="premium-input text-white" placeholder="e.g. Football Centre" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-white/40 mb-1 block">Start Date</label>
              <DatePickerInput value={form.startDate} onChange={e => setForm(f => ({ ...f, startDate: e.target.value }))} className="premium-input text-white" data-testid="input-tournament-start" />
            </div>
            <div>
              <label className="text-xs text-white/40 mb-1 block">End Date</label>
              <DatePickerInput value={form.endDate} onChange={e => setForm(f => ({ ...f, endDate: e.target.value }))} className="premium-input text-white" />
            </div>
          </div>

          <div className="space-y-3 pt-2">
            <label className="text-xs text-white/30 uppercase tracking-wider font-semibold">Format</label>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-white/40 mb-1 block">Number of Groups</label>
                <Input type="number" value={form.numGroups} onChange={e => setForm(f => ({ ...f, numGroups: e.target.value }))} className="premium-input text-white" />
              </div>
              <div>
                <label className="text-xs text-white/40 mb-1 block">Teams per Group</label>
                <Input type="number" value={form.teamsPerGroup} onChange={e => setForm(f => ({ ...f, teamsPerGroup: e.target.value }))} className="premium-input text-white" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-white/40 mb-1 block">Game Duration (min)</label>
                <Input type="number" value={form.gameDurationMinutes} onChange={e => setForm(f => ({ ...f, gameDurationMinutes: e.target.value }))} className="premium-input text-white" />
              </div>
              <div>
                <label className="text-xs text-white/40 mb-1 block">Break Between (min)</label>
                <Input type="number" value={form.breakBetweenMinutes} onChange={e => setForm(f => ({ ...f, breakBetweenMinutes: e.target.value }))} className="premium-input text-white" />
              </div>
            </div>
          </div>

          <div className="space-y-3 pt-2">
            <label className="text-xs text-white/30 uppercase tracking-wider font-semibold">Points System</label>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="text-xs text-white/40 mb-1 block">Win</label>
                <Input type="number" value={form.pointsForWin} onChange={e => setForm(f => ({ ...f, pointsForWin: e.target.value }))} className="premium-input text-white" />
              </div>
              <div>
                <label className="text-xs text-white/40 mb-1 block">Draw</label>
                <Input type="number" value={form.pointsForDraw} onChange={e => setForm(f => ({ ...f, pointsForDraw: e.target.value }))} className="premium-input text-white" />
              </div>
              <div>
                <label className="text-xs text-white/40 mb-1 block">Loss</label>
                <Input type="number" value={form.pointsForLoss} onChange={e => setForm(f => ({ ...f, pointsForLoss: e.target.value }))} className="premium-input text-white" />
              </div>
            </div>
          </div>

          <div className="pt-2">
            <label className="text-xs text-white/40 mb-1 block">Registration Fee</label>
            <MoneyInput value={form.registrationFee} onChange={v => setForm(f => ({ ...f, registrationFee: v }))} className="premium-input text-white" placeholder="0.00" />
          </div>
        </div>
        <div className="p-5 border-t border-white/5 flex gap-2 justify-end">
          <Button variant="ghost" onClick={onClose} className="text-white/40">Cancel</Button>
          <Button onClick={handleSubmit} disabled={!form.name || createMut.isPending || updateMut.isPending} className="bg-blue-600 hover:bg-blue-700 text-white" data-testid="button-save-tournament">
            {tournament ? "Update" : "Create"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function TournamentList() {
  const { currentOrg } = useWorkspace();
  const orgId = currentOrg?.id;
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Tournament | undefined>();
  const [menuOpen, setMenuOpen] = useState<number | null>(null);

  const { data: tournaments = [], isLoading } = useQuery<Tournament[]>({
    queryKey: ["/api/admin/tournament/tournaments", { orgId }],
    queryFn: () => fetch(`/api/admin/tournament/tournaments?orgId=${orgId}`).then(r => r.json()),
    enabled: !!orgId,
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/admin/tournament/tournaments/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/tournament/tournaments"] });
      toast({ title: "Tournament deleted" });
    },
  });

  const archiveMut = useMutation({
    mutationFn: (t: Tournament) => apiRequest("PATCH", `/api/admin/tournament/tournaments/${t.id}`, { archived: !t.archived }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/tournament/tournaments"] });
      toast({ title: "Updated" });
    },
  });

  const filtered = tournaments
    .filter(t => showArchived ? t.archived : !t.archived)
    .filter(t => !search || t.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white" data-testid="text-tournaments-title">Tournaments</h1>
          <p className="text-sm text-white/40 mt-1">{tournaments.length} tournament{tournaments.length !== 1 ? "s" : ""}</p>
        </div>
        <Button onClick={() => { setEditing(undefined); setShowModal(true); }} className="bg-blue-600 hover:bg-blue-700 text-white gap-2" data-testid="button-new-tournament">
          <Plus className="w-4 h-4" />
          New Tournament
        </Button>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/20" />
          <Input placeholder="Search tournaments..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9 premium-input text-white" data-testid="input-search-tournaments" />
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
            <Award className="w-12 h-12 mb-3" />
            <p className="text-sm">{showArchived ? "No archived tournaments" : "No tournaments yet"}</p>
            <p className="text-xs mt-1">Create a new tournament to get started</p>
          </div>
        </div>
      ) : (
        <div className="rounded-2xl border border-blue-500/10 bg-white/[0.02] overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-white/5">
                <th className="text-left text-[10px] text-white/30 uppercase tracking-wider font-semibold px-5 py-3">Tournament</th>
                <th className="text-left text-[10px] text-white/30 uppercase tracking-wider font-semibold px-5 py-3 hidden sm:table-cell">Age</th>
                <th className="text-left text-[10px] text-white/30 uppercase tracking-wider font-semibold px-5 py-3 hidden sm:table-cell">Dates</th>
                <th className="text-left text-[10px] text-white/30 uppercase tracking-wider font-semibold px-5 py-3">Format</th>
                <th className="text-left text-[10px] text-white/30 uppercase tracking-wider font-semibold px-5 py-3">Status</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {filtered.map(t => (
                <tr
                  key={t.id}
                  className="border-b border-white/[0.03] hover:bg-white/[0.02] cursor-pointer transition-colors"
                  data-testid={`tournament-row-${t.id}`}
                  onClick={() => setLocation(`/admin/tournaments/${t.id}`)}
                >
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg bg-blue-500/15 flex items-center justify-center flex-shrink-0">
                        <Award className="w-4 h-4 text-blue-400" />
                      </div>
                      <span className="text-sm font-medium text-white/80">{t.name}</span>
                    </div>
                  </td>
                  <td className="px-5 py-3.5 text-sm text-white/50 hidden sm:table-cell">{t.ageGroup || "—"}</td>
                  <td className="px-5 py-3.5 text-sm text-white/40 hidden sm:table-cell">
                    {t.startDate ? new Date(t.startDate + "T12:00:00").toLocaleDateString("en-NZ", { day: "numeric", month: "short" }) : "—"}
                  </td>
                  <td className="px-5 py-3.5 text-xs text-white/40">{t.numGroups} groups · {t.teamsPerGroup}/grp</td>
                  <td className="px-5 py-3.5">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${
                      t.status === "active" ? "bg-green-500/15 text-green-400" :
                      t.status === "completed" ? "bg-blue-500/15 text-blue-400" :
                      "bg-white/5 text-white/30"
                    }`}>
                      {t.status.charAt(0).toUpperCase() + t.status.slice(1)}
                    </span>
                  </td>
                  <td className="px-3 py-3.5 relative">
                    <button
                      onClick={e => { e.stopPropagation(); setMenuOpen(menuOpen === t.id ? null : t.id); }}
                      className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-white/5 text-white/30"
                      data-testid={`button-tournament-menu-${t.id}`}
                    >
                      <MoreVertical className="w-4 h-4" />
                    </button>
                    {menuOpen === t.id && (
                      <>
                        <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(null)} />
                        <div className="absolute right-3 top-full z-50 bg-[#0a0e1a] border border-blue-500/15 rounded-xl shadow-xl py-1 w-40">
                          <button onClick={e => { e.stopPropagation(); setEditing(t); setShowModal(true); setMenuOpen(null); }} className="w-full px-3 py-2 text-sm text-white/60 hover:bg-white/5 text-left">Edit</button>
                          <button onClick={e => { e.stopPropagation(); archiveMut.mutate(t); setMenuOpen(null); }} className="w-full px-3 py-2 text-sm text-white/60 hover:bg-white/5 text-left flex items-center gap-2"><Archive className="w-3.5 h-3.5" />{t.archived ? "Unarchive" : "Archive"}</button>
                          <button onClick={e => { e.stopPropagation(); deleteMut.mutate(t.id); setMenuOpen(null); }} className="w-full px-3 py-2 text-sm text-red-400/70 hover:bg-red-500/10 text-left flex items-center gap-2"><Trash2 className="w-3.5 h-3.5" />Delete</button>
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

      {showModal && <TournamentModal tournament={editing} orgId={orgId!} onClose={() => { setShowModal(false); setEditing(undefined); }} />}
    </div>
  );
}
