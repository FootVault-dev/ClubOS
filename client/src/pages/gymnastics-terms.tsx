import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useWorkspace } from "@/lib/workspace-context";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Plus, X, Calendar as CalendarIcon, Pencil, Trash2, Sun, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DatePickerInput } from "@/components/ui/date-picker-input";
import { Skeleton } from "@/components/ui/skeleton";
import type { Term } from "@shared/schema";

function formatDate(d: string): string {
  const dt = new Date(d + "T00:00:00");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${String(dt.getDate()).padStart(2, "0")} ${months[dt.getMonth()]}`;
}

function formatRange(start: string, end: string): string {
  const a = new Date(start + "T00:00:00");
  const b = new Date(end + "T00:00:00");
  if (a.getFullYear() !== b.getFullYear()) {
    return `${formatDate(start)} ${a.getFullYear()} – ${formatDate(end)} ${b.getFullYear()}`;
  }
  return `${formatDate(start)} – ${formatDate(end)}`;
}

function termWeeks(start: string, end: string): number {
  const a = new Date(start + "T00:00:00").getTime();
  const b = new Date(end + "T00:00:00").getTime();
  return Math.round((b - a) / (1000 * 60 * 60 * 24 * 7)) + 1;
}

interface TermFormState {
  year: string;
  termNumber: string;
  name: string;
  startDate: string;
  endDate: string;
  notes: string;
}

const emptyForm = (year: number): TermFormState => ({
  year: String(year),
  termNumber: "1",
  name: "",
  startDate: "",
  endDate: "",
  notes: "",
});

function TermModal({
  open, onClose, orgId, editing,
}: { open: boolean; onClose: () => void; orgId: number | undefined; editing: Term | null }) {
  const { toast } = useToast();
  const currentYear = new Date().getFullYear();
  const [form, setForm] = useState<TermFormState>(
    editing
      ? {
          year: String(editing.year),
          termNumber: String(editing.termNumber),
          name: editing.name ?? "",
          startDate: editing.startDate,
          endDate: editing.endDate,
          notes: editing.notes ?? "",
        }
      : emptyForm(currentYear),
  );

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!orgId) throw new Error("Organisation not loaded yet");
      const body = {
        organizationId: orgId,
        year: parseInt(form.year),
        termNumber: parseInt(form.termNumber),
        name: form.name || null,
        startDate: form.startDate,
        endDate: form.endDate,
        notes: form.notes || null,
      };
      if (editing) {
        const res = await apiRequest("PATCH", `/api/admin/terms/${editing.id}`, body);
        return res.json();
      }
      const res = await apiRequest("POST", "/api/admin/terms", body);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/terms"] });
      toast({ title: editing ? "Term updated" : "Term added" });
      onClose();
    },
    onError: (e: Error) => toast({ title: "Couldn't save term", description: e.message, variant: "destructive" }),
  });

  if (!open) return null;

  const startBeforeEnd =
    !form.startDate || !form.endDate || new Date(form.startDate) <= new Date(form.endDate);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div
        className="relative w-full max-w-lg mx-4 rounded-2xl border border-blue-500/[0.15] overflow-hidden"
        style={{ background: "linear-gradient(135deg, rgba(3,86,197,0.04) 0%, hsl(var(--card)) 100%)" }}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-blue-500/[0.08]">
          <h3 className="text-[14px] font-semibold text-white/80">{editing ? "Edit term" : "Add term"}</h3>
          <button onClick={onClose} className="w-7 h-7 rounded-lg bg-white/[0.04] border border-white/[0.06] flex items-center justify-center hover:bg-white/[0.08]">
            <X className="w-3.5 h-3.5 text-white/40" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Year</label>
              <Input type="number" value={form.year} onChange={e => setForm({ ...form, year: e.target.value })} className="premium-input text-white/80 rounded-xl" />
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Term #</label>
              <select
                value={form.termNumber}
                onChange={e => setForm({ ...form, termNumber: e.target.value })}
                className="w-full text-white/80 rounded-xl bg-white/[0.03] border border-white/[0.06] px-3 py-2 text-sm"
              >
                <option value="1">Term 1</option>
                <option value="2">Term 2</option>
                <option value="3">Term 3</option>
                <option value="4">Term 4</option>
              </select>
            </div>
            <div className="col-span-2 space-y-1.5">
              <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Display Name (optional)</label>
              <Input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. Term 1 (10 weeks)" className="premium-input text-white/80 rounded-xl" />
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Start Date</label>
              <DatePickerInput value={form.startDate} onChange={e => setForm({ ...form, startDate: e.target.value })} className="premium-input text-white/80 rounded-xl" />
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">End Date</label>
              <DatePickerInput value={form.endDate} onChange={e => setForm({ ...form, endDate: e.target.value })} className="premium-input text-white/80 rounded-xl" />
            </div>
            {!startBeforeEnd && (
              <div className="col-span-2 text-[11px] text-amber-400/80">Start date must be on or before end date.</div>
            )}
            <div className="col-span-2 space-y-1.5">
              <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Notes (optional)</label>
              <textarea
                value={form.notes}
                onChange={e => setForm({ ...form, notes: e.target.value })}
                placeholder="Public holidays during this term, anything programs need to know..."
                className="w-full h-20 px-3 py-2 rounded-xl bg-white/[0.03] border border-white/[0.06] text-[13px] text-white/80 placeholder:text-white/20 focus:outline-none focus:border-blue-500/30 resize-none"
              />
            </div>
          </div>
        </div>
        <div className="px-5 py-4 border-t border-blue-500/[0.08] flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => saveMutation.mutate()}
            disabled={!form.year || !form.startDate || !form.endDate || !startBeforeEnd || saveMutation.isPending}
            className="bg-blue-600 hover:bg-blue-700 text-white"
          >
            {saveMutation.isPending ? "Saving…" : editing ? "Save changes" : "Add term"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function GymnasticsTerms() {
  const { currentOrg } = useWorkspace();
  const orgId = currentOrg?.id;
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Term | null>(null);

  const { data: terms = [], isLoading } = useQuery<Term[]>({
    queryKey: ["/api/admin/terms", { orgId }],
    queryFn: () => fetch(`/api/admin/terms?orgId=${orgId}`, { credentials: "include" }).then(r => r.json()),
    enabled: !!orgId,
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/admin/terms/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/terms"] });
      toast({ title: "Term deleted" });
    },
    onError: (e: Error) => toast({ title: "Couldn't delete term", description: e.message, variant: "destructive" }),
  });

  // Group by year, most recent first. Server sorts year DESC, term ASC.
  const byYear = new Map<number, Term[]>();
  for (const t of terms) {
    if (!byYear.has(t.year)) byYear.set(t.year, []);
    byYear.get(t.year)!.push(t);
  }
  const years = Array.from(byYear.keys()).sort((a, b) => b - a);

  const today = new Date();
  const todayIso = today.toISOString().split("T")[0];

  // Derive holiday windows. School holidays in NZ are by definition the
  // gaps between terms — Term 1 ends 2 Apr → Term 2 starts 20 Apr → autumn
  // holiday is the days in between. We build a synthetic 'HolidayWindow'
  // for each gap inside a year. The summer holiday (after Term 4) extends
  // into the next year and is rendered separately.
  type CalendarItem =
    | { kind: "term"; term: Term }
    | { kind: "holiday"; year: number; afterTermNumber: number; startDate: string; endDate: string; label: string };

  const HOLIDAY_LABELS: Record<number, string> = {
    1: "Autumn holiday", 2: "Winter holiday", 3: "Spring holiday", 4: "Summer holiday",
  };

  const addDays = (iso: string, days: number): string => {
    const d = new Date(iso + "T00:00:00");
    d.setDate(d.getDate() + days);
    return d.toISOString().split("T")[0];
  };

  const buildCalendar = (yearTerms: Term[]): CalendarItem[] => {
    const sorted = [...yearTerms].sort((a, b) => a.termNumber - b.termNumber);
    const items: CalendarItem[] = [];
    for (let i = 0; i < sorted.length; i++) {
      const term = sorted[i];
      items.push({ kind: "term", term });
      const next = sorted[i + 1];
      // Holiday between this term and the next one in the same year
      if (next) {
        const holStart = addDays(term.endDate, 1);
        const holEnd = addDays(next.startDate, -1);
        if (holStart <= holEnd) {
          items.push({
            kind: "holiday",
            year: term.year,
            afterTermNumber: term.termNumber,
            startDate: holStart,
            endDate: holEnd,
            label: HOLIDAY_LABELS[term.termNumber] ?? "School holiday",
          });
        }
      }
    }
    // Summer holiday after the final term — runs into next year, but we
    // show it within this year's section since that's where users plan it.
    const last = sorted[sorted.length - 1];
    if (last) {
      const next = terms.find(t => t.year === last.year + 1 && t.termNumber === 1);
      const summerStart = addDays(last.endDate, 1);
      const summerEnd = next ? addDays(next.startDate, -1) : `${last.year + 1}-01-25`;
      if (summerStart <= summerEnd) {
        items.push({
          kind: "holiday",
          year: last.year,
          afterTermNumber: last.termNumber,
          startDate: summerStart,
          endDate: summerEnd,
          label: "Summer holiday",
        });
      }
    }
    return items;
  };

  // Tab strip varies by workspace. Gymnastics has a dedicated /admin/programs
  // page so it shows "All Programs / Term Dates". CUFC reaches Terms via the
  // Academy page, so we mirror that pairing here ("Programs / Term Dates")
  // with the inactive Programs tab linking back to /admin/academy.
  const isGymnastics = currentOrg?.slug === "united-gymnastics";
  const showProgramsTabs = true;
  const programsHref = isGymnastics ? "/admin/programs" : "/admin/academy";
  const pageTitle = isGymnastics ? "Programs" : "Academy";
  const pageSubtitle = isGymnastics
    ? "Classes, camps, workshops, and the term calendar they run against."
    : "Academy programs and the term calendar they run against.";

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">{pageTitle}</h1>
          <p className="text-sm text-white/40 mt-1">{pageSubtitle}</p>
        </div>
        <Button
          onClick={() => { setEditing(null); setShowModal(true); }}
          className="bg-blue-600 hover:bg-blue-700 text-white"
          disabled={!orgId}
        >
          <Plus className="w-4 h-4 mr-1" /> Add Term
        </Button>
      </div>

      {showProgramsTabs && (
        <div className="flex items-center gap-1 border-b border-white/5">
          <button
            onClick={() => setLocation(programsHref)}
            className="px-4 py-2.5 text-sm font-medium text-white/50 hover:text-white/80 border-b-2 border-transparent -mb-px"
          >
            {isGymnastics ? "All Programs" : "Programs"}
          </button>
          <button
            onClick={() => setLocation("/admin/terms")}
            className="px-4 py-2.5 text-sm font-medium text-white border-b-2 border-blue-500 -mb-px"
          >
            Term Dates
          </button>
        </div>
      )}

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-16 rounded-xl bg-white/[0.02]" />)}
        </div>
      ) : terms.length === 0 ? (
        <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-12 text-center">
          <CalendarIcon className="w-10 h-10 text-white/20 mx-auto mb-3" />
          <p className="text-sm text-white/50 mb-1">No term dates yet — add your first.</p>
          <p className="text-xs text-white/30">Once added, programs can be scheduled against terms automatically.</p>
        </div>
      ) : (
        <div className="space-y-8">
          {years.map(year => {
            const calendar = buildCalendar(byYear.get(year)!);
            const termCount = byYear.get(year)!.length;
            const holidayCount = calendar.filter(c => c.kind === "holiday").length;
            return (
              <div key={year}>
                <div className="flex items-end justify-between mb-3">
                  <h2 className="text-sm font-semibold text-white/60">
                    <span className="text-2xl font-bold text-white mr-2">{year}</span>
                    <span className="text-white/30 text-xs uppercase tracking-wider">
                      {termCount} term{termCount === 1 ? "" : "s"} · {holidayCount} holiday window{holidayCount === 1 ? "" : "s"}
                    </span>
                  </h2>
                  <div className="flex items-center gap-3 text-[10px] uppercase tracking-wider">
                    <span className="flex items-center gap-1.5 text-white/40">
                      <span className="w-2 h-2 rounded-full bg-blue-400/60" /> Term
                    </span>
                    <span className="flex items-center gap-1.5 text-white/40">
                      <span className="w-2 h-2 rounded-full bg-amber-400/60" /> School holiday
                    </span>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                  {calendar.map((item, idx) => {
                    if (item.kind === "term") {
                      const t = item.term;
                      const isCurrent = t.startDate <= todayIso && todayIso <= t.endDate;
                      const isUpcoming = t.startDate > todayIso;
                      const isPast = t.endDate < todayIso;
                      return (
                        <div
                          key={`t-${t.id}`}
                          className="rounded-2xl border border-blue-500/20 bg-blue-500/[0.04] p-4 hover:border-blue-500/40 transition group"
                        >
                          <div className="flex items-start justify-between mb-2">
                            <div>
                              <div className="text-[10px] uppercase tracking-wider text-blue-300/60">Term {t.termNumber}</div>
                              <div className="text-base font-semibold text-white">{t.name || `Term ${t.termNumber}`}</div>
                            </div>
                            {isCurrent && <span className="text-[10px] px-2 py-0.5 rounded bg-green-500/15 text-green-400">Current</span>}
                            {isUpcoming && <span className="text-[10px] px-2 py-0.5 rounded bg-blue-500/15 text-blue-400">Upcoming</span>}
                            {isPast && <span className="text-[10px] px-2 py-0.5 rounded bg-white/[0.04] text-white/30">Ended</span>}
                          </div>
                          <div className="text-sm text-white/70 mb-1">{formatRange(t.startDate, t.endDate)}</div>
                          <div className="text-xs text-white/30 mb-3">{termWeeks(t.startDate, t.endDate)} weeks</div>
                          {t.notes && (
                            <div className="text-xs text-white/40 mb-3 line-clamp-2">{t.notes}</div>
                          )}
                          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition">
                            <button
                              onClick={() => { setEditing(t); setShowModal(true); }}
                              className="p-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06]"
                              title="Edit"
                            >
                              <Pencil className="w-3 h-3 text-white/60" />
                            </button>
                            <button
                              onClick={() => {
                                if (confirm(`Delete Term ${t.termNumber} ${t.year}?`)) deleteMutation.mutate(t.id);
                              }}
                              className="p-1.5 rounded-lg bg-white/[0.04] hover:bg-red-500/20 border border-white/[0.06]"
                              title="Delete"
                            >
                              <Trash2 className="w-3 h-3 text-white/60" />
                            </button>
                          </div>
                        </div>
                      );
                    }
                    // Holiday window — derived from the gap between terms.
                    // Click to start a holiday camp with these dates pre-filled.
                    const isCurrent = item.startDate <= todayIso && todayIso <= item.endDate;
                    const isUpcoming = item.startDate > todayIso;
                    const isPast = item.endDate < todayIso;
                    const weeks = termWeeks(item.startDate, item.endDate);
                    return (
                      <button
                        key={`h-${item.year}-${item.afterTermNumber}-${idx}`}
                        onClick={() => {
                          // Gymnastics has a unified /admin/programs page where
                          // the modal reads ?new=holiday_camp. Camps-style
                          // workspaces (CUFC) have a separate /admin/camps
                          // page that reads ?action=new. Branch the route
                          // and key names so the right page opens the
                          // create modal with the holiday dates pre-filled.
                          const holidayName = `${item.label.replace("School holiday", "Holiday")} Camp ${item.year}`;
                          if (isGymnastics) {
                            const params = new URLSearchParams({
                              new: "holiday_camp",
                              startDate: item.startDate,
                              endDate: item.endDate,
                              name: holidayName,
                            });
                            setLocation(`/admin/programs?${params.toString()}`);
                          } else {
                            const params = new URLSearchParams({
                              action: "new",
                              startDate: item.startDate,
                              endDate: item.endDate,
                              name: holidayName,
                            });
                            setLocation(`/admin/camps?${params.toString()}`);
                          }
                        }}
                        className="text-left rounded-2xl border border-amber-500/20 bg-amber-500/[0.04] p-4 hover:border-amber-500/40 hover:bg-amber-500/[0.08] transition group"
                      >
                        <div className="flex items-start justify-between mb-2">
                          <div>
                            <div className="text-[10px] uppercase tracking-wider text-amber-300/60 flex items-center gap-1">
                              {item.label === "Summer holiday"
                                ? <Sun className="w-3 h-3" />
                                : <Sparkles className="w-3 h-3" />}
                              School holiday
                            </div>
                            <div className="text-base font-semibold text-white">{item.label}</div>
                          </div>
                          {isCurrent && <span className="text-[10px] px-2 py-0.5 rounded bg-green-500/15 text-green-400">Current</span>}
                          {isUpcoming && <span className="text-[10px] px-2 py-0.5 rounded bg-amber-500/15 text-amber-400">Upcoming</span>}
                          {isPast && <span className="text-[10px] px-2 py-0.5 rounded bg-white/[0.04] text-white/30">Past</span>}
                        </div>
                        <div className="text-sm text-white/70 mb-1">{formatRange(item.startDate, item.endDate)}</div>
                        <div className="text-xs text-white/30 mb-3">{weeks} week{weeks === 1 ? "" : "s"}</div>
                        <div className="text-xs text-amber-300/80 group-hover:text-amber-300 flex items-center gap-1.5 mt-2 pt-2 border-t border-amber-500/10">
                          <Plus className="w-3 h-3" /> Plan a holiday camp here
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <TermModal
        open={showModal}
        onClose={() => { setShowModal(false); setEditing(null); }}
        orgId={orgId}
        editing={editing}
        key={editing?.id ?? "new"}
      />
    </div>
  );
}
