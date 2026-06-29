// Football Institute tab — CUFC workspace. Manages enrolment applications for
// the Football Institute (Christchurch United × Ao Tawhiti Unlimited Discovery).
// Applications arrive from the public marketing site's Apply form
// (/api/public/football-institute/apply) and land here; staff can triage status,
// add walk-ups, and review details. Data is scoped to the christchurch-united org.
import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { School, Plus, Search, Trash2, X, Inbox, CheckCircle2, Clock, ChevronDown, Mail, Phone, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type Status = "new" | "contacted" | "reviewing" | "accepted" | "declined";

interface Application {
  id: number;
  applicantName: string;
  yearLevel: string | null;
  position: string | null;
  currentSchool: string | null;
  currentClub: string | null;
  parentName: string | null;
  email: string;
  phone: string | null;
  studentEmail: string | null;
  videoUrl: string | null;
  message: string | null;
  intakeYear: number | null;
  status: Status;
  source: string;
  createdAt: string;
}

const STATUSES: Status[] = ["new", "contacted", "reviewing", "accepted", "declined"];
const YEAR_LEVELS = ["Year 10", "Year 11", "Year 12", "Year 13"];

const STATUS_STYLES: Record<Status, string> = {
  new: "text-blue-300 bg-blue-500/10 border-blue-500/20",
  contacted: "text-amber-300 bg-amber-500/10 border-amber-500/20",
  reviewing: "text-purple-300 bg-purple-500/10 border-purple-500/20",
  accepted: "text-emerald-300 bg-emerald-500/10 border-emerald-500/20",
  declined: "text-white/40 bg-white/5 border-white/10",
};

function fmtDate(s: string): string {
  try { return new Date(s).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" }); }
  catch { return s; }
}

function AddModal({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();
  const [form, setForm] = useState({
    applicantName: "", yearLevel: "Year 10", position: "", currentSchool: "",
    currentClub: "", parentName: "", email: "", phone: "", message: "",
  });

  const createMut = useMutation({
    mutationFn: (data: any) => apiRequest("POST", "/api/admin/football-institute/applications", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/football-institute/applications"] });
      toast({ title: "Application added" });
      onClose();
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-[#0a0e1a] border border-blue-500/15 rounded-2xl w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-white/5 sticky top-0 bg-[#0a0e1a]">
          <h2 className="text-lg font-semibold text-white">Add Application</h2>
          <button onClick={onClose} className="text-white/30 hover:text-white/60"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="text-xs text-white/50 mb-1.5 block">Student full name *</label>
            <Input value={form.applicantName} onChange={(e) => setForm({ ...form, applicantName: e.target.value })} placeholder="e.g. Charlie Smith" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-white/50 mb-1.5 block">Year level</label>
              <Select value={form.yearLevel} onValueChange={(v) => setForm({ ...form, yearLevel: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{YEAR_LEVELS.map((y) => <SelectItem key={y} value={y}>{y}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-white/50 mb-1.5 block">Position</label>
              <Input value={form.position} onChange={(e) => setForm({ ...form, position: e.target.value })} placeholder="e.g. Midfielder" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-white/50 mb-1.5 block">Current school</label>
              <Input value={form.currentSchool} onChange={(e) => setForm({ ...form, currentSchool: e.target.value })} />
            </div>
            <div>
              <label className="text-xs text-white/50 mb-1.5 block">Current club</label>
              <Input value={form.currentClub} onChange={(e) => setForm({ ...form, currentClub: e.target.value })} />
            </div>
          </div>
          <div>
            <label className="text-xs text-white/50 mb-1.5 block">Parent / guardian</label>
            <Input value={form.parentName} onChange={(e) => setForm({ ...form, parentName: e.target.value })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-white/50 mb-1.5 block">Contact email *</label>
              <Input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="email@example.com" />
            </div>
            <div>
              <label className="text-xs text-white/50 mb-1.5 block">Phone</label>
              <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </div>
          </div>
          <div>
            <label className="text-xs text-white/50 mb-1.5 block">Notes</label>
            <textarea value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })}
              className="w-full min-h-[80px] rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/30 outline-none focus:border-blue-400/40" />
          </div>
        </div>
        <div className="flex justify-end gap-2 p-5 border-t border-white/5 sticky bottom-0 bg-[#0a0e1a]">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => createMut.mutate({ ...form, intakeYear: new Date().getFullYear() + 1, source: "admin" })}
            disabled={!form.applicantName.trim() || !form.email.trim() || createMut.isPending}>
            {createMut.isPending ? "Adding..." : "Add Application"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function StatusSelect({ app }: { app: Application }) {
  const { toast } = useToast();
  const mut = useMutation({
    mutationFn: (status: Status) => apiRequest("PATCH", `/api/admin/football-institute/applications/${app.id}`, { status }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/admin/football-institute/applications"] }),
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });
  return (
    <Select value={app.status} onValueChange={(v) => mut.mutate(v as Status)}>
      <SelectTrigger className={`h-7 w-[120px] text-xs font-semibold capitalize border ${STATUS_STYLES[app.status]}`}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>{STATUSES.map((s) => <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>)}</SelectContent>
    </Select>
  );
}

function Row({ app }: { app: Application }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const deleteMut = useMutation({
    mutationFn: () => apiRequest("DELETE", `/api/admin/football-institute/applications/${app.id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/football-institute/applications"] });
      toast({ title: "Application deleted" });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="bg-white/[0.03] border border-white/5 rounded-xl overflow-hidden">
      <div className="flex items-center gap-3 p-4">
        <button onClick={() => setOpen(!open)} className="flex-1 flex items-center gap-3 text-left min-w-0">
          <ChevronDown className={`w-4 h-4 text-white/30 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
          <div className="min-w-0">
            <div className="text-white font-semibold truncate">{app.applicantName}</div>
            <div className="text-xs text-white/40 truncate">
              {[app.yearLevel, app.currentClub, app.currentSchool].filter(Boolean).join(" · ") || "—"}
            </div>
          </div>
        </button>
        <div className="hidden sm:block text-xs text-white/30 shrink-0">{fmtDate(app.createdAt)}</div>
        <StatusSelect app={app} />
        <button onClick={() => { if (confirm(`Delete ${app.applicantName}'s application?`)) deleteMut.mutate(); }}
          className="text-white/25 hover:text-red-400 shrink-0" title="Delete">
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
      {open && (
        <div className="px-4 pb-4 pt-1 border-t border-white/5 grid sm:grid-cols-2 gap-x-6 gap-y-2.5 text-sm">
          <Detail label="Position" value={app.position} />
          <Detail label="Intake" value={app.intakeYear ? String(app.intakeYear) : null} />
          <Detail label="Parent / guardian" value={app.parentName} />
          <Detail label="Source" value={app.source} />
          <div className="flex items-center gap-2 text-white/70"><Mail className="w-3.5 h-3.5 text-blue-400" /><a className="hover:text-blue-300" href={`mailto:${app.email}`}>{app.email}</a></div>
          {app.phone && <div className="flex items-center gap-2 text-white/70"><Phone className="w-3.5 h-3.5 text-blue-400" /><a className="hover:text-blue-300" href={`tel:${app.phone}`}>{app.phone}</a></div>}
          {app.studentEmail && <Detail label="Student email" value={app.studentEmail} />}
          {app.videoUrl && (
            <div className="flex items-center gap-2 text-white/70"><ExternalLink className="w-3.5 h-3.5 text-blue-400" />
              <a className="hover:text-blue-300 truncate" href={app.videoUrl} target="_blank" rel="noreferrer">Playing video</a></div>
          )}
          {app.message && (
            <div className="sm:col-span-2 mt-1">
              <div className="text-[11px] uppercase tracking-wide text-white/35 mb-1">Their message</div>
              <p className="text-white/70 whitespace-pre-wrap leading-relaxed">{app.message}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return <div><span className="text-[11px] uppercase tracking-wide text-white/35">{label}: </span><span className="text-white/75 capitalize">{value}</span></div>;
}

export default function FootballInstitute() {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [showAdd, setShowAdd] = useState(false);

  const { data: apps = [], isLoading } = useQuery<Application[]>({
    queryKey: ["/api/admin/football-institute/applications"],
  });

  const filtered = useMemo(() => apps.filter((a) => {
    if (statusFilter !== "all" && a.status !== statusFilter) return false;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      const hay = [a.applicantName, a.currentClub, a.currentSchool, a.email, a.parentName].filter(Boolean).join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }), [apps, statusFilter, search]);

  const stats = [
    { label: "Total", value: apps.length, icon: Inbox },
    { label: "New", value: apps.filter((a) => a.status === "new").length, icon: Clock },
    { label: "In progress", value: apps.filter((a) => a.status === "contacted" || a.status === "reviewing").length, icon: School },
    { label: "Accepted", value: apps.filter((a) => a.status === "accepted").length, icon: CheckCircle2 },
  ];

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2.5">
            <School className="w-6 h-6 text-amber-400" />
            Football Institute
          </h1>
          <p className="text-sm text-white/40 mt-1">
            Enrolment applications from the Football Institute website — Christchurch United × Ao Tawhiti.
          </p>
        </div>
        <Button onClick={() => setShowAdd(true)}><Plus className="w-4 h-4 mr-1.5" /> Add Application</Button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {stats.map((s) => (
          <div key={s.label} className="bg-white/[0.03] border border-white/5 rounded-2xl p-4">
            <div className="flex items-center gap-2 text-white/40 text-xs mb-1.5"><s.icon className="w-3.5 h-3.5" /> {s.label}</div>
            <div className="text-2xl font-bold text-white">{s.value}</div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, club, school, email..." className="pl-9" />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[150px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {STATUSES.map((s) => <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="text-white/40 text-sm py-12 text-center">Loading applications…</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 bg-white/[0.02] border border-white/5 rounded-2xl">
          <School className="w-10 h-10 text-white/15 mx-auto mb-3" />
          <p className="text-white/50 font-medium">{apps.length === 0 ? "No applications yet" : "No applications match your filters"}</p>
          <p className="text-white/30 text-sm mt-1">{apps.length === 0 ? "They'll appear here as they come in from the website." : "Try clearing the search or status filter."}</p>
        </div>
      ) : (
        <div className="space-y-2.5">{filtered.map((a) => <Row key={a.id} app={a} />)}</div>
      )}

      {showAdd && <AddModal onClose={() => setShowAdd(false)} />}
    </div>
  );
}
