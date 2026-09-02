import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useWorkspace } from "@/lib/workspace-context";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Plus, Search, X, ChevronRight, GraduationCap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DatePickerInput } from "@/components/ui/date-picker-input";
import { Skeleton } from "@/components/ui/skeleton";
import type { Program, Term } from "@shared/schema";

function formatDateRange(startDate: string | null, endDate: string | null): string {
  if (!startDate || !endDate) return "No dates set";
  const start = new Date(startDate + "T00:00:00");
  const end = new Date(endDate + "T00:00:00");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const startDay = String(start.getDate()).padStart(2, "0");
  const endDay = String(end.getDate()).padStart(2, "0");
  if (start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear()) {
    return `${startDay} – ${endDay} ${months[end.getMonth()]} ${end.getFullYear()}`;
  }
  return `${startDay} ${months[start.getMonth()]} – ${endDay} ${months[end.getMonth()]} ${end.getFullYear()}`;
}

const PROGRAM_TYPES: { value: string; label: string }[] = [
  { value: "open_training", label: "Class / Training" },
  { value: "holiday_camp", label: "Holiday Camp / Workshop" },
  { value: "academy", label: "Academy" },
  { value: "event", label: "Event" },
  { value: "trials", label: "Trials" },
];

function formatTermDateRange(start: string, end: string): string {
  const a = new Date(start + "T00:00:00");
  const b = new Date(end + "T00:00:00");
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${a.getDate()} ${months[a.getMonth()]} – ${b.getDate()} ${months[b.getMonth()]} ${b.getFullYear()}`;
}

interface CreateProgramModalProps {
  open: boolean;
  onClose: () => void;
  orgId: number | undefined;
  prefill?: Partial<{
    type: string; name: string; slug: string;
    startDate: string; endDate: string;
    scheduleType: "term" | "holiday" | "custom" | "event";
    holidayWindow: string;
  }>;
}

function CreateProgramModal({ open, onClose, orgId, prefill }: CreateProgramModalProps) {
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  const { data: terms = [] } = useQuery<Term[]>({
    queryKey: ["/api/admin/terms", { orgId }],
    queryFn: () => fetch(`/api/admin/terms?orgId=${orgId}`, { credentials: "include" }).then(r => r.json()),
    enabled: !!orgId && open,
  });

  const [form, setForm] = useState({
    name: prefill?.name ?? "",
    slug: prefill?.slug ?? "",
    description: "",
    location: "United Sports Centre",
    type: prefill?.type ?? "open_training",
    scheduleType: (prefill?.scheduleType ?? "term") as "term" | "holiday" | "custom" | "event",
    termId: "" as string,
    holidayWindow: prefill?.holidayWindow ?? "",
    startDate: prefill?.startDate ?? "",
    endDate: prefill?.endDate ?? "",
    ageMin: "",
    ageMax: "",
    pricingModel: "term_prorated" as "flat" | "term_prorated" | "per_day",
    termPrice: "",
    sessionCount: "10",
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!orgId) throw new Error("Organisation not loaded yet");
      const body: any = {
        organizationId: orgId,
        type: form.type,
        name: form.name,
        slug: form.slug,
        description: form.description,
        location: form.location,
        scheduleType: form.scheduleType,
        ageMin: form.ageMin ? parseInt(form.ageMin) : null,
        ageMax: form.ageMax ? parseInt(form.ageMax) : null,
        pricingModel: form.pricingModel,
        termPriceCents: form.termPrice ? Math.round(parseFloat(form.termPrice) * 100) : null,
        sessionCount: form.sessionCount ? parseInt(form.sessionCount) : null,
        isActive: true,
      };
      if (form.scheduleType === "term") {
        body.termId = form.termId ? parseInt(form.termId) : null;
        // Server will auto-fill start/end from the term
      } else if (form.scheduleType === "holiday") {
        body.holidayWindow = form.holidayWindow || null;
        body.startDate = form.startDate || null;
        body.endDate = form.endDate || null;
      } else {
        body.startDate = form.startDate || null;
        body.endDate = form.endDate || null;
      }
      const res = await apiRequest("POST", "/api/admin/programs", body);
      return res.json();
    },
    onSuccess: (program: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/programs"] });
      toast({ title: "Program created" });
      onClose();
      // Gymnastics programmes live under the Programs section.
      setLocation(`/admin/programs/${program.id}`);
    },
    onError: (e: Error) => toast({ title: "Couldn't create program", description: e.message, variant: "destructive" }),
  });

  // Live pro-rata preview based on selected term + price + today
  const selectedTerm = form.termId ? terms.find(t => String(t.id) === form.termId) : null;
  const todayIso = new Date().toISOString().split("T")[0];
  const fullPriceCents = form.termPrice ? Math.round(parseFloat(form.termPrice) * 100) : 0;
  const sessions = parseInt(form.sessionCount || "10");
  let proratedPreview: { payNow: number; remaining: number; reason: string } | null = null;
  if (form.pricingModel === "term_prorated" && selectedTerm && fullPriceCents > 0 && sessions > 0) {
    if (todayIso < selectedTerm.startDate) {
      proratedPreview = { payNow: fullPriceCents, remaining: sessions, reason: "Term hasn't started — full price applies" };
    } else if (todayIso > selectedTerm.endDate) {
      proratedPreview = { payNow: 0, remaining: 0, reason: "Term has ended — registration closed" };
    } else {
      const a = new Date(todayIso + "T00:00:00").getTime();
      const b = new Date(selectedTerm.endDate + "T00:00:00").getTime();
      const remaining = Math.max(1, Math.round((b - a) / (1000 * 60 * 60 * 24 * 7)) + 1);
      const capped = Math.min(remaining, sessions);
      const payNow = Math.round(fullPriceCents * capped / sessions);
      proratedPreview = { payNow, remaining: capped, reason: `${capped} of ${sessions} sessions remaining` };
    }
  }

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-lg mx-4 rounded-2xl border border-blue-500/[0.15] overflow-hidden max-h-[90vh] flex flex-col" style={{ background: "linear-gradient(135deg, hsl(214 60% 97%) 0%, hsl(var(--card)) 100%)" }}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-blue-500/[0.08] flex-shrink-0">
          <h3 className="text-[14px] font-semibold text-white/80">Create program</h3>
          <button onClick={onClose} className="w-7 h-7 rounded-lg bg-white/[0.04] border border-white/[0.06] flex items-center justify-center hover:bg-white/[0.08] transition-colors cursor-pointer">
            <X className="w-3.5 h-3.5 text-white/40" />
          </button>
        </div>
        <div className="p-5 space-y-5 overflow-auto flex-1">
          {/* Basics */}
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1.5">
              <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Type</label>
              <select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })} className="w-full text-white/80 rounded-xl bg-white/[0.03] border border-white/[0.06] px-3 py-2 text-sm">
                {PROGRAM_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            <div className="col-span-2 space-y-1.5">
              <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Name</label>
              <Input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Beginner Recreational Class" className="text-white/80 rounded-xl" />
            </div>
            <div className="col-span-2 space-y-1.5">
              <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">URL Slug</label>
              <Input value={form.slug} onChange={e => setForm({ ...form, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") })} placeholder="beginner-recreational" className="text-white/80 rounded-xl" />
              <p className="text-[10px] text-white/30">Public URL: {form.slug ? `app.usg.co.nz/${form.slug}` : "set the slug to see the URL"}</p>
            </div>
          </div>

          {/* Schedule */}
          <div className="space-y-2 pt-2 border-t border-white/5">
            <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Schedule</label>
            <div className="grid grid-cols-4 gap-1.5 mt-1">
              {[
                { value: "term", label: "Term" },
                { value: "holiday", label: "Holiday" },
                { value: "custom", label: "Custom" },
                { value: "event", label: "One-off" },
              ].map(s => (
                <button
                  key={s.value}
                  type="button"
                  onClick={() => setForm({ ...form, scheduleType: s.value as any })}
                  className={`px-3 py-2 rounded-lg text-xs font-medium transition ${
                    form.scheduleType === s.value
                      ? "bg-blue-600 text-white"
                      : "bg-white/[0.04] text-white/60 hover:bg-white/[0.08]"
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>

            {form.scheduleType === "term" && (
              <div className="mt-3 space-y-2">
                {terms.length === 0 ? (
                  <div className="p-3 rounded-lg bg-amber-500/5 border border-amber-500/20 text-xs text-amber-300">
                    No terms set up yet. <button onClick={() => setLocation("/admin/terms")} className="underline">Add terms first</button>.
                  </div>
                ) : (
                  <select
                    value={form.termId}
                    onChange={e => setForm({ ...form, termId: e.target.value })}
                    className="w-full text-white/80 rounded-xl bg-white/[0.03] border border-white/[0.06] px-3 py-2 text-sm"
                  >
                    <option value="">Pick a term…</option>
                    {terms.map(t => (
                      <option key={t.id} value={t.id}>
                        {t.name || `Term ${t.termNumber}`} {t.year} — {formatTermDateRange(t.startDate, t.endDate)}
                      </option>
                    ))}
                  </select>
                )}
                {selectedTerm && (
                  <p className="text-[10px] text-white/40">Dates auto-fill from the term ({formatTermDateRange(selectedTerm.startDate, selectedTerm.endDate)}). You can override after creating.</p>
                )}
              </div>
            )}

            {(form.scheduleType === "holiday" || form.scheduleType === "custom" || form.scheduleType === "event") && (
              <div className="mt-3 grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="text-[10px] text-white/40 uppercase">Start</label>
                  <DatePickerInput value={form.startDate} onChange={e => setForm({ ...form, startDate: e.target.value })} className="text-white/80 rounded-xl" />
                </div>
                {form.scheduleType !== "event" && (
                  <div className="space-y-1.5">
                    <label className="text-[10px] text-white/40 uppercase">End</label>
                    <DatePickerInput value={form.endDate} onChange={e => setForm({ ...form, endDate: e.target.value })} className="text-white/80 rounded-xl" />
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Pricing */}
          <div className="space-y-2 pt-2 border-t border-white/5">
            <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Pricing</label>
            <div className="grid grid-cols-3 gap-1.5 mt-1">
              {[
                { value: "term_prorated", label: "Per term (pro-rated)", desc: "Discount as term progresses" },
                { value: "flat", label: "Flat fee", desc: "Same price always" },
                { value: "per_day", label: "Per day", desc: "Holiday-camp style" },
              ].map(p => (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => setForm({ ...form, pricingModel: p.value as any })}
                  className={`p-2 rounded-lg text-left transition ${
                    form.pricingModel === p.value
                      ? "bg-blue-600/15 border border-blue-500/40"
                      : "bg-white/[0.02] border border-white/5 hover:bg-white/[0.04]"
                  }`}
                >
                  <div className="text-[11px] font-semibold text-white">{p.label}</div>
                  <div className="text-[9px] text-white/40 mt-0.5">{p.desc}</div>
                </button>
              ))}
            </div>
            {form.pricingModel !== "per_day" && (
              <div className="grid grid-cols-2 gap-3 mt-2">
                <div className="space-y-1.5">
                  <label className="text-[10px] text-white/40 uppercase">Full term price ($)</label>
                  <Input type="number" step="0.01" value={form.termPrice} onChange={e => setForm({ ...form, termPrice: e.target.value })} placeholder="200" className="text-white/80 rounded-xl" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] text-white/40 uppercase">Sessions</label>
                  <Input type="number" value={form.sessionCount} onChange={e => setForm({ ...form, sessionCount: e.target.value })} placeholder="10" className="text-white/80 rounded-xl" />
                </div>
              </div>
            )}
            {proratedPreview && (
              <div className="mt-2 p-3 rounded-lg bg-emerald-500/5 border border-emerald-500/20">
                <div className="text-[10px] uppercase tracking-wider text-emerald-300/70 mb-1">Today's price preview</div>
                <div className="text-sm text-white">
                  ${(fullPriceCents / 100).toFixed(2)} normally → <strong>${(proratedPreview.payNow / 100).toFixed(2)} pro-rated</strong>
                </div>
                <div className="text-[11px] text-emerald-300/70 mt-0.5">{proratedPreview.reason}</div>
              </div>
            )}
          </div>

          {/* Optional details */}
          <div className="space-y-3 pt-2 border-t border-white/5">
            <div className="space-y-1.5">
              <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Description (optional)</label>
              <textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="Short summary that appears on the landing page hero..." className="w-full h-16 px-3 py-2 rounded-xl bg-white/[0.03] border border-white/[0.06] text-[13px] text-white/80 placeholder:text-white/20 focus:outline-none focus:border-blue-500/30 resize-none" />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5 col-span-1">
                <label className="text-[10px] text-white/40 uppercase">Min age</label>
                <Input type="number" value={form.ageMin} onChange={e => setForm({ ...form, ageMin: e.target.value })} placeholder="3" className="text-white/80 rounded-xl" />
              </div>
              <div className="space-y-1.5 col-span-1">
                <label className="text-[10px] text-white/40 uppercase">Max age</label>
                <Input type="number" value={form.ageMax} onChange={e => setForm({ ...form, ageMax: e.target.value })} placeholder="12" className="text-white/80 rounded-xl" />
              </div>
              <div className="space-y-1.5 col-span-1">
                <label className="text-[10px] text-white/40 uppercase">Location</label>
                <Input value={form.location} onChange={e => setForm({ ...form, location: e.target.value })} className="text-white/80 rounded-xl" />
              </div>
            </div>
          </div>
        </div>
        <div className="px-5 py-4 border-t border-blue-500/[0.08] flex justify-end gap-2 flex-shrink-0">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => createMutation.mutate()}
            disabled={
              !form.name || !form.slug || createMutation.isPending ||
              (form.scheduleType === "term" && !form.termId)
            }
            className="bg-blue-600 hover:bg-blue-700 text-white"
          >
            {createMutation.isPending ? "Creating…" : "Create program"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function GymnasticsPrograms() {
  const { currentOrg } = useWorkspace();
  const orgId = currentOrg?.id;
  const [, setLocation] = useLocation();
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [prefill, setPrefill] = useState<any>(undefined);

  // If we landed here from a holiday-window card on the Terms tab,
  // open the create modal pre-filled with that holiday's dates + name.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const newParam = params.get("new");
    if (newParam) {
      setPrefill({
        type: newParam === "holiday_camp" ? "holiday_camp" : "open_training",
        scheduleType: newParam === "holiday_camp" ? "holiday" : "term",
        startDate: params.get("startDate") ?? "",
        endDate: params.get("endDate") ?? "",
        name: params.get("name") ?? "",
        slug: params.get("name")?.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") ?? "",
      });
      setShowCreate(true);
      // Clean the URL so a refresh doesn't reopen the modal
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  const { data: programs = [], isLoading } = useQuery<Program[]>({
    queryKey: ["/api/admin/programs", { orgId }],
    queryFn: () => fetch(`/api/admin/programs?orgId=${orgId}`, { credentials: "include" }).then(r => r.json()),
    enabled: !!orgId,
  });

  const filtered = programs.filter(p =>
    !search ||
    p.name.toLowerCase().includes(search.toLowerCase()) ||
    (p.slug?.toLowerCase().includes(search.toLowerCase()) ?? false)
  );

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Programs</h1>
          <p className="text-sm text-white/40 mt-1">Classes, camps, workshops, and the term calendar they run against.</p>
        </div>
        <Button
          onClick={() => setShowCreate(true)}
          className="bg-blue-600 hover:bg-blue-700 text-white"
          disabled={!orgId}
        >
          <Plus className="w-4 h-4 mr-1" /> New Program
        </Button>
      </div>

      <div className="flex items-center gap-1 border-b border-white/5">
        <button
          onClick={() => setLocation("/admin/programs")}
          className="px-4 py-2.5 text-sm font-medium text-white border-b-2 border-blue-500 -mb-px"
        >
          All Programs
        </button>
        <button
          onClick={() => setLocation("/admin/terms")}
          className="px-4 py-2.5 text-sm font-medium text-white/50 hover:text-white/80 border-b-2 border-transparent -mb-px"
        >
          Term Dates
        </button>
      </div>

      <div className="relative">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />
        <Input
          type="text"
          placeholder="Search programs…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="pl-10 bg-white/[0.02] border-white/10 text-white"
        />
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-xl bg-white/[0.02]" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-12 text-center">
          <GraduationCap className="w-10 h-10 text-white/20 mx-auto mb-3" />
          <p className="text-sm text-white/50 mb-1">
            {programs.length === 0 ? "No programs yet — create your first." : "No programs match your search."}
          </p>
          {programs.length === 0 && (
            <p className="text-xs text-white/30">
              Each program gets a public landing page parents can register through.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(p => (
            <button
              key={p.id}
              onClick={() => setLocation(`/admin/programs/${p.id}`)}
              className="w-full flex items-center gap-4 p-4 rounded-xl border border-white/5 bg-white/[0.02] hover:bg-white/[0.04] hover:border-white/10 transition text-left"
            >
              <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center flex-shrink-0">
                <GraduationCap className="w-5 h-5 text-blue-400" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-white truncate">{p.name}</span>
                  {!p.isActive && <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.04] text-white/40">draft</span>}
                </div>
                <div className="text-xs text-white/40 truncate">
                  {formatDateRange(p.startDate, p.endDate)} · /{p.slug}
                </div>
              </div>
              <ChevronRight className="w-4 h-4 text-white/20" />
            </button>
          ))}
        </div>
      )}

      <CreateProgramModal
        open={showCreate}
        onClose={() => { setShowCreate(false); setPrefill(undefined); }}
        orgId={orgId}
        prefill={prefill}
        key={prefill ? `prefill-${prefill.startDate}-${prefill.name}` : "new"}
      />
    </div>
  );
}
