import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TimePickerInput } from "@/components/ui/time-picker-input";
import { DatePickerInput } from "@/components/ui/date-picker-input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useRoute, Link, useLocation } from "wouter";
import { useWorkspace } from "@/lib/workspace-context";
import { programBasePath, useProgramRoute } from "@/lib/program-path";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/format";
import { ArrowLeft, Calendar, DollarSign, Settings, Percent, Tent, Trash2, Plus, X, Save, FileText, BarChart3, Users, TrendingUp, ChevronRight, UserCheck, UserX, AlertTriangle, Phone, Mail, Clock, User, FlaskConical, Trophy, Eye, Ban, Pencil } from "lucide-react";
import { Progress } from "@/components/ui/progress";

function OverviewTab({ camp, onUpdate }: { camp: any; onUpdate: (data: any) => void }) {
  const [name, setName] = useState(camp.name);
  const [description, setDescription] = useState(camp.description || "");
  const [location, setLocation] = useState(camp.location || "");
  const [startDate, setStartDate] = useState(camp.startDate || "");
  const [endDate, setEndDate] = useState(camp.endDate || "");
  const [ageMin, setAgeMin] = useState(String(camp.ageMin || ""));
  const [ageMax, setAgeMax] = useState(String(camp.ageMax || ""));
  const [capacity, setCapacity] = useState(String(camp.capacity || ""));
  const [isActive, setIsActive] = useState(camp.isActive);
  // Academy programmes only. Separate from isActive on purpose: a programme can
  // be publicly listed and described while its registrations are shut. Defaults
  // false so a newly seeded programme can never take money by accident.
  const [registrationOpen, setRegistrationOpen] = useState<boolean>(
    Boolean((camp as any).registrationOpen),
  );
  const isAcademy = (camp as any).type === "academy";

  // Local mode — starts with whatever's saved, can be flipped in-place so an
  // existing holiday camp can be converted to a term program without
  // delete/recreate. Saving with mode=term promotes scheduleType.
  type Mode = "holiday" | "term";
  const initialMode: Mode = camp.scheduleType === "term" ? "term" : "holiday";
  const [mode, setMode] = useState<Mode>(initialMode);
  const isTermMode = mode === "term";

  // Term-binding state — only used when mode === "term".
  const [termId, setTermId] = useState<string>(camp.termId ? String(camp.termId) : "");
  const [termPrice, setTermPrice] = useState<string>(
    camp.termPriceCents ? (camp.termPriceCents / 100).toFixed(2) : ""
  );
  const [sessionCount, setSessionCount] = useState<string>(
    camp.sessionCount ? String(camp.sessionCount) : ""
  );

  const { data: termsList } = useQuery<{ id: number; name: string; year: number; termNumber: number; startDate: string; endDate: string }[]>({
    queryKey: ["/api/admin/terms", { orgId: camp.organizationId }],
    enabled: isTermMode && !!camp.organizationId,
  });

  const handleSave = () => {
    const payload: Record<string, unknown> = {
      name, description, location,
      startDate: startDate || null,
      endDate: endDate || null,
      ageMin: parseInt(ageMin) || null,
      ageMax: parseInt(ageMax) || null,
      capacity: parseInt(capacity) || null,
      isActive,
      ...(isAcademy ? { registrationOpen } : {}),
    };
    if (isTermMode) {
      // Promote to term mode (or keep it). Backend will auto-fill startDate/
      // endDate from the linked term if they're not already set.
      payload.scheduleType = "term";
      payload.pricingModel = camp.pricingModel ?? "term_prorated";
      payload.termId = termId ? parseInt(termId) : null;
      payload.termPriceCents = termPrice ? Math.round(parseFloat(termPrice) * 100) : null;
      payload.sessionCount = sessionCount ? parseInt(sessionCount) : null;
    } else if (initialMode === "term") {
      // Demoting term → holiday: clear the binding so the holiday-camp
      // tabs render correctly.
      payload.scheduleType = null;
      payload.termId = null;
      payload.pricingModel = "flat";
    }
    onUpdate(payload);
  };

  return (
    <div className="space-y-4">
      {/* Mode toggle — flip between holiday camp and term program. Surfaces
          existing programs to be converted in place without delete/recreate. */}
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.015] p-3">
        <div className="text-[10px] uppercase tracking-wider font-semibold text-white/40 mb-2">Program mode</div>
        <div className="grid grid-cols-2 gap-1 p-1 rounded-lg bg-white/[0.03] border border-white/[0.04]">
          <button
            type="button"
            onClick={() => setMode("holiday")}
            className={`text-[12px] font-semibold py-2 rounded-md transition-colors ${mode === "holiday" ? "bg-blue-500/20 text-blue-200 border border-blue-500/40" : "text-white/40 hover:text-white/60"}`}
            data-testid="overview-mode-holiday"
          >
            Holiday Camp
          </button>
          <button
            type="button"
            onClick={() => setMode("term")}
            className={`text-[12px] font-semibold py-2 rounded-md transition-colors ${mode === "term" ? "bg-amber-400/20 text-amber-200 border border-amber-400/50" : "text-white/40 hover:text-white/60"}`}
            data-testid="overview-mode-term"
          >
            Term Program
          </button>
        </div>
        {mode !== initialMode && (
          <div className="mt-2 text-[11px] text-amber-300/70">
            ⚠ Mode change will be applied when you click Save Changes. {mode === "term" ? "After saving, set the weekly schedule on the Schedule tab." : "Existing sessions will not be deleted automatically."}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="sm:col-span-2 space-y-1.5">
          <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Program Name</label>
          <Input value={name} onChange={e => setName(e.target.value)} className="premium-input text-white/80 rounded-xl" data-testid="input-camp-name" />
        </div>
        <div className="sm:col-span-2 space-y-1.5">
          <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Description</label>
          <textarea value={description} onChange={e => setDescription(e.target.value)} className="w-full h-24 px-3 py-2 rounded-xl bg-white/[0.03] border border-white/[0.06] text-[13px] text-white/80 placeholder:text-white/20 focus:outline-none focus:border-blue-500/30 resize-none" data-testid="input-camp-description" />
        </div>
        <div className="sm:col-span-2 space-y-1.5">
          <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Location</label>
          <Input value={location} onChange={e => setLocation(e.target.value)} className="premium-input text-white/80 rounded-xl" data-testid="input-camp-location" />
        </div>
        <div className="space-y-1.5">
          <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Start Date</label>
          <DatePickerInput value={startDate} onChange={e => setStartDate(e.target.value)} className="premium-input text-white/80 rounded-xl" data-testid="input-camp-start" />
        </div>
        <div className="space-y-1.5">
          <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">End Date</label>
          <DatePickerInput value={endDate} onChange={e => setEndDate(e.target.value)} className="premium-input text-white/80 rounded-xl" data-testid="input-camp-end" />
        </div>
        <div className="space-y-1.5">
          <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Min Age</label>
          <Input type="number" value={ageMin} onChange={e => setAgeMin(e.target.value)} className="premium-input text-white/80 rounded-xl" data-testid="input-camp-age-min" />
        </div>
        <div className="space-y-1.5">
          <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Max Age</label>
          <Input type="number" value={ageMax} onChange={e => setAgeMax(e.target.value)} className="premium-input text-white/80 rounded-xl" data-testid="input-camp-age-max" />
        </div>
        <div className="space-y-1.5">
          <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Total Capacity</label>
          <Input type="number" value={capacity} onChange={e => setCapacity(e.target.value)} className="premium-input text-white/80 rounded-xl" data-testid="input-camp-capacity" />
        </div>
        <div className="space-y-1.5 flex items-end">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={isActive} onChange={e => setIsActive(e.target.checked)} className="w-4 h-4 rounded" data-testid="input-camp-active" />
            <span className="text-[13px] text-white/60">Active</span>
          </label>
          {isAcademy && (
            <label
              className="flex items-center gap-2 cursor-pointer ml-5"
              title="Parents can register and pay online. Requires at least one active option with a real price."
            >
              <input
                type="checkbox"
                checked={registrationOpen}
                onChange={e => setRegistrationOpen(e.target.checked)}
                className="w-4 h-4 rounded"
                data-testid="input-camp-registration-open"
              />
              <span className="text-[13px] text-white/60">Registrations open</span>
            </label>
          )}
        </div>
      </div>

      {isTermMode && (
        <div className="rounded-xl border border-amber-400/15 bg-amber-400/[0.03] p-4 space-y-3">
          <div className="text-[11px] uppercase tracking-wider font-semibold text-amber-200/60">Term binding</div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2 space-y-1.5">
              <label className="text-[10px] text-white/40 uppercase">Term</label>
              <select
                value={termId}
                onChange={e => setTermId(e.target.value)}
                className="premium-input text-white/80 rounded-xl w-full"
                data-testid="select-camp-term"
              >
                <option value="">— Not bound —</option>
                {(termsList ?? []).map(t => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.year} T{t.termNumber}) — {t.startDate} → {t.endDate}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] text-white/40 uppercase">Sessions in term</label>
              <Input type="number" value={sessionCount} onChange={e => setSessionCount(e.target.value)} placeholder="auto" className="premium-input text-white/80 rounded-xl" />
            </div>
            <div className="sm:col-span-3 space-y-1.5">
              <label className="text-[10px] text-white/40 uppercase">Term price ($NZD, full term)</label>
              <Input type="number" step="0.01" value={termPrice} onChange={e => setTermPrice(e.target.value)} placeholder="e.g. 195.00" className="premium-input text-white/80 rounded-xl" data-testid="input-camp-term-price" />
              <p className="text-[10px] text-white/30">
                Pro-rated automatically for parents who sign up after the term has started — same logic as the gymnastics programs.
              </p>
            </div>
          </div>
        </div>
      )}

      <Button onClick={handleSave} className="bg-gradient-to-r from-blue-500 to-blue-600 text-white border-0 rounded-xl h-9 text-[13px] glow-btn" data-testid="button-save-overview">
        <Save className="w-4 h-4 mr-1.5" /> Save Changes
      </Button>
    </div>
  );
}

// Class-mode "Schedule" tab — defines the recurring weekly pattern for a
// term program and bulk-generates one session per (day, slot) combination
// across the entire term. Supports multiple slots so the U4-U8 academy can
// run Mon-Fri training + two age-split Saturday slots from the same form.
type ScheduleSlot = {
  id: string;            // local-only React key
  daysOfWeek: number[];  // 0=Sun..6=Sat
  startTime: string;     // "HH:MM"
  endTime: string;
  capacity: string;
  name: string;          // optional label, e.g. "Age 4-6"
};

const DOW_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DOW_SHORT = ["S", "M", "T", "W", "T", "F", "S"];
// Visual order: Monday-first (NZ / international convention). Underlying
// `daysOfWeek: number[]` still stores 0=Sun..6=Sat to match JS Date.getDay()
// — only the chip render order changes.
const DOW_DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

function newSlot(partial: Partial<ScheduleSlot> = {}): ScheduleSlot {
  return {
    id: `slot-${Math.random().toString(36).slice(2, 9)}`,
    daysOfWeek: partial.daysOfWeek ?? [],
    startTime: partial.startTime ?? "16:30",
    endTime: partial.endTime ?? "17:15",
    capacity: partial.capacity ?? "20",
    name: partial.name ?? "",
  };
}

function ClassDatesTab({ campId, camp }: { campId: number; camp: any }) {
  const { toast } = useToast();
  const { data: dates, isLoading } = useQuery<any[]>({
    queryKey: ["/api/admin/camps", campId, "dates"],
    queryFn: () => fetch(`/api/admin/camps/${campId}/dates`, { credentials: "include" }).then(r => r.json()),
  });

  // Seed slot rows from the persisted weekly_pattern_json if there is one,
  // otherwise default to the U4-U8 academy starter pattern Daniel asked for:
  //   Mon-Fri 4:30-5:15pm + Sat 9:30-10:15 (Age 4-6) + Sat 10:30-11:15 (Age 7-8).
  const initialSlots = (() => {
    if (camp?.weeklyPatternJson) {
      try {
        const parsed = JSON.parse(camp.weeklyPatternJson);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed.map((s: any) => newSlot({
            daysOfWeek: s.daysOfWeek ?? [],
            startTime: s.startTime,
            endTime: s.endTime,
            capacity: s.capacity != null ? String(s.capacity) : "",
            name: s.name ?? "",
          }));
        }
      } catch { /* ignore — fall through to defaults */ }
    }
    return [
      newSlot({ daysOfWeek: [1, 2, 3, 4, 5], startTime: "16:30", endTime: "17:15", capacity: "20", name: "" }),
      newSlot({ daysOfWeek: [6], startTime: "09:30", endTime: "10:15", capacity: "20", name: "Age 4-6" }),
      newSlot({ daysOfWeek: [6], startTime: "10:30", endTime: "11:15", capacity: "20", name: "Age 7-8" }),
    ];
  })();

  const [slots, setSlots] = useState<ScheduleSlot[]>(initialSlots);

  const updateSlot = (id: string, patch: Partial<ScheduleSlot>) => {
    setSlots(prev => prev.map(s => (s.id === id ? { ...s, ...patch } : s)));
  };
  const toggleDay = (id: string, day: number) => {
    setSlots(prev => prev.map(s => {
      if (s.id !== id) return s;
      const next = s.daysOfWeek.includes(day)
        ? s.daysOfWeek.filter(d => d !== day)
        : [...s.daysOfWeek, day].sort((a, b) => a - b);
      return { ...s, daysOfWeek: next };
    }));
  };
  const addSlot = () => setSlots(prev => [...prev, newSlot()]);
  const removeSlot = (id: string) => setSlots(prev => prev.filter(s => s.id !== id));

  const generate = useMutation({
    mutationFn: async (replaceExisting: boolean) => {
      const validSlots = slots
        .filter(s => s.daysOfWeek.length > 0 && s.startTime && s.endTime)
        .map(s => ({
          daysOfWeek: s.daysOfWeek,
          startTime: s.startTime,
          endTime: s.endTime,
          capacity: parseInt(s.capacity) || null,
          name: s.name.trim() || null,
        }));
      if (validSlots.length === 0) {
        throw new Error("Add at least one slot with a day, start time and end time before generating.");
      }
      const res = await apiRequest("POST", `/api/admin/camps/${campId}/dates/generate-from-term`, {
        slots: validSlots,
        replaceExisting,
        persistPattern: true,
      });
      return res.json();
    },
    onSuccess: (r: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/camps", campId, "dates"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/camps", campId, "sessions-summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/camps", campId] });
      toast({ title: `Generated ${r.count} session${r.count === 1 ? "" : "s"}` });
    },
    onError: (e: Error) => toast({ title: "Couldn't generate", description: e.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/admin/camp-dates/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/camps", campId, "dates"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/camps", campId, "sessions-summary"] });
      toast({ title: "Session removed" });
    },
  });

  if (!camp.termId) {
    return (
      <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 text-sm text-amber-200">
        This is a term program but it isn't linked to a specific term yet. Open the Overview tab and pick a term so we can generate the weekly sessions.
      </div>
    );
  }

  // Estimate how many sessions the current pattern will produce so the
  // admin can sanity-check before generating (e.g. 70 for U4-U8 over 10 weeks).
  const estimateCount = (): number => {
    if (!camp.startDate || !camp.endDate) return 0;
    const start = new Date(camp.startDate + "T00:00:00");
    const end = new Date(camp.endDate + "T00:00:00");
    let count = 0;
    const cursor = new Date(start);
    while (cursor <= end) {
      const dow = cursor.getDay();
      for (const slot of slots) if (slot.daysOfWeek.includes(dow)) count++;
      cursor.setDate(cursor.getDate() + 1);
    }
    return count;
  };
  const estimated = estimateCount();

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-blue-500/[0.08] bg-blue-500/[0.02] p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[11px] uppercase tracking-wider font-semibold text-blue-300/40">Weekly schedule</div>
            <div className="text-[11px] text-white/30 mt-0.5">
              {camp.startDate && camp.endDate ? <>Repeats every week between <span className="font-mono text-white/50">{camp.startDate}</span> and <span className="font-mono text-white/50">{camp.endDate}</span>.</> : "Set the term dates first."}
            </div>
          </div>
          <button
            type="button"
            onClick={addSlot}
            className="text-[11px] text-blue-300/70 hover:text-blue-200 inline-flex items-center gap-1"
          >
            <Plus className="w-3.5 h-3.5" /> Add slot
          </button>
        </div>

        <div className="space-y-2">
          {slots.map((slot, idx) => (
            <div key={slot.id} className="rounded-lg border border-white/[0.06] bg-white/[0.015] p-3 space-y-3">
              <div className="flex items-center gap-2">
                <span className="text-[10px] uppercase tracking-wider text-white/30 font-semibold">Slot {idx + 1}</span>
                {slots.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeSlot(slot.id)}
                    className="ml-auto text-red-400/50 hover:text-red-400 text-[10px] inline-flex items-center gap-1"
                  >
                    <Trash2 className="w-3 h-3" /> Remove
                  </button>
                )}
              </div>

              <div>
                <label className="text-[10px] text-white/40 uppercase">Days of week</label>
                <div className="flex gap-1.5 mt-1">
                  {DOW_DISPLAY_ORDER.map(dayIndex => (
                    <button
                      type="button"
                      key={dayIndex}
                      onClick={() => toggleDay(slot.id, dayIndex)}
                      className={`flex-1 h-9 rounded-lg text-[12px] font-bold transition-colors ${slot.daysOfWeek.includes(dayIndex) ? "bg-blue-500/30 border border-blue-400 text-white" : "bg-white/[0.03] border border-white/[0.06] text-white/35 hover:text-white/60"}`}
                      data-testid={`slot-${idx}-day-${dayIndex}`}
                    >
                      {DOW_SHORT[dayIndex]}
                    </button>
                  ))}
                </div>
                <div className="text-[10px] text-white/25 mt-1">
                  {slot.daysOfWeek.length === 0 ? "Pick at least one day" : slot.daysOfWeek.map(i => DOW_LABELS[i]).join(", ")}
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div className="space-y-1">
                  <label className="text-[10px] text-white/40 uppercase">Start</label>
                  <TimePickerInput value={slot.startTime} onChange={e => updateSlot(slot.id, { startTime: e.target.value })} className="text-white/80 rounded-lg" />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] text-white/40 uppercase">End</label>
                  <TimePickerInput value={slot.endTime} onChange={e => updateSlot(slot.id, { endTime: e.target.value })} className="text-white/80 rounded-lg" />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] text-white/40 uppercase">Capacity</label>
                  <Input type="number" value={slot.capacity} onChange={e => updateSlot(slot.id, { capacity: e.target.value })} className="text-white/80 rounded-lg" />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] text-white/40 uppercase">Label (optional)</label>
                  <Input type="text" placeholder="e.g. Age 4-6" value={slot.name} onChange={e => updateSlot(slot.id, { name: e.target.value })} className="text-white/80 rounded-lg" />
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between pt-1">
          <p className="text-[11px] text-white/30">
            {estimated > 0 ? <>Will generate <span className="text-white/60 font-semibold">{estimated}</span> session{estimated === 1 ? "" : "s"} across the term.</> : "Set days + times to preview the count."}
          </p>
          <Button
            onClick={() => {
              const hasExisting = dates && dates.length > 0;
              if (hasExisting) {
                if (!confirm(`Replace the ${dates!.length} existing session${dates!.length === 1 ? "" : "s"} with the new schedule? Sessions with confirmed registrations are protected and will block the regenerate.`)) return;
                generate.mutate(true);
              } else {
                generate.mutate(false);
              }
            }}
            disabled={generate.isPending || estimated === 0}
            className="bg-gradient-to-r from-blue-500 to-blue-600 text-white border-0 rounded-xl h-9 text-[13px]"
            data-testid="button-generate-sessions"
          >
            <Plus className="w-4 h-4 mr-1" /> {generate.isPending ? "Generating…" : (dates && dates.length > 0 ? "Regenerate sessions" : "Generate sessions")}
          </Button>
        </div>
      </div>

      {isLoading ? (
        <Skeleton className="h-32 w-full rounded-xl bg-blue-500/[0.04]" />
      ) : !dates || dates.length === 0 ? (
        <p className="text-[13px] text-white/25 text-center py-8">No sessions yet — set the schedule above and hit Generate.</p>
      ) : (
        <div className="rounded-xl border border-blue-500/[0.08] overflow-hidden">
          <div className="px-4 py-2.5 border-b border-blue-500/[0.06] flex items-center justify-between">
            <div className="text-[11px] text-blue-300/40 uppercase tracking-wider font-semibold">Generated sessions</div>
            <div className="text-[11px] text-white/35">{dates.length} session{dates.length === 1 ? "" : "s"}</div>
          </div>
          <table className="w-full">
            <thead>
              <tr className="border-b border-blue-500/[0.06]">
                <th className="text-left px-4 py-2.5 text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Date</th>
                <th className="text-left px-4 py-2.5 text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Day</th>
                <th className="text-left px-4 py-2.5 text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Time</th>
                <th className="text-left px-4 py-2.5 text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Label</th>
                <th className="text-center px-4 py-2.5 text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Capacity</th>
                <th className="w-12"></th>
              </tr>
            </thead>
            <tbody>
              {dates.map(d => {
                const dt = new Date(d.date + "T00:00:00");
                return (
                  <tr key={d.id} className="border-b border-white/[0.03] last:border-b-0 hover:bg-white/[0.01]">
                    <td className="px-4 py-2.5 text-sm text-white">{d.date}</td>
                    <td className="px-4 py-2.5 text-sm text-white/60">{DOW_LABELS[dt.getDay()]}</td>
                    <td className="px-4 py-2.5 text-sm text-white/80 font-mono">{d.startTime ?? "—"}–{d.endTime ?? "—"}</td>
                    <td className="px-4 py-2.5 text-sm text-white/60">{d.name || "—"}</td>
                    <td className="px-4 py-2.5 text-sm text-white/60 text-center">{d.capacityFullDay ?? "—"}</td>
                    <td className="px-2 py-2.5">
                      <button
                        onClick={() => { if (confirm("Remove this session?")) deleteMutation.mutate(d.id); }}
                        className="text-red-400/60 hover:text-red-400 p-1.5"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Class-mode pricing tab — manages program options. Each option = a priced
// package (e.g. Beginner Thursday $295, Beginner Combo $565 with weekly pay).
// Falls back to the single-price-on-program model if no options are defined.
function ClassPricingTab({ campId, camp }: { campId: number; camp: any }) {
  const { toast } = useToast();
  const { data: options = [], isLoading } = useQuery<any[]>({
    queryKey: ["/api/admin/programs", campId, "options"],
    queryFn: () => fetch(`/api/admin/programs/${campId}/options`, { credentials: "include" }).then(r => r.json()),
  });

  const [editing, setEditing] = useState<any | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const deleteOption = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/admin/program-options/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/programs", campId, "options"] });
      toast({ title: "Option removed" });
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-white">Pricing options</h3>
          <p className="text-xs text-white/40 mt-0.5">Parents pick one option on the registration page. Each has its own schedule + price.</p>
        </div>
        <Button onClick={() => setShowAdd(true)} className="bg-blue-600 hover:bg-blue-700 text-white text-sm">
          <Plus className="w-4 h-4 mr-1" /> Add option
        </Button>
      </div>

      {isLoading ? (
        <Skeleton className="h-32 w-full rounded-xl bg-blue-500/[0.04]" />
      ) : options.length === 0 ? (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 text-sm text-amber-200">
          No options yet. Add at least one — even a simple 'Term Pass — $200' covers a single-class program.
        </div>
      ) : (
        <div className="space-y-2">
          {options.map(o => (
            <div
              key={o.id}
              className="rounded-xl border border-blue-500/[0.08] bg-white/[0.02] p-4 hover:bg-white/[0.04] transition group"
            >
              <div className="flex items-start justify-between gap-3 mb-2">
                <div>
                  <div className="font-semibold text-white">{o.name}</div>
                  {o.scheduleText && <div className="text-xs text-white/50 mt-0.5">{o.scheduleText}</div>}
                  {o.description && <div className="text-xs text-white/40 mt-1">{o.description}</div>}
                </div>
                <div className="text-right">
                  <div className="text-lg font-bold text-white">${(o.fullPriceCents / 100).toFixed(0)}<span className="text-xs text-white/40">/term</span></div>
                  <div className="text-[10px] text-white/40">{o.sessionCount ?? "—"} sessions</div>
                </div>
              </div>
              <div className="flex items-center justify-between mt-2 pt-2 border-t border-white/5">
                <div className="flex items-center gap-3 text-[10px] uppercase tracking-wider">
                  <span className={o.isActive ? "text-emerald-400" : "text-white/30"}>
                    {o.isActive ? "● Live" : "○ Inactive"}
                  </span>
                  <span className="text-white/40">{o.pricingModel === "term_prorated" ? "Pro-rated" : "Flat"}</span>
                  {o.allowPayWeekly && <span className="text-blue-400">+ Weekly pay</span>}
                </div>
                <div className="opacity-0 group-hover:opacity-100 transition flex gap-1">
                  <button onClick={() => setEditing(o)} className="p-1.5 rounded bg-white/[0.04] hover:bg-white/[0.08] text-white/60">
                    <Pencil className="w-3 h-3" />
                  </button>
                  <button
                    onClick={() => { if (confirm(`Delete "${o.name}"?`)) deleteOption.mutate(o.id); }}
                    className="p-1.5 rounded bg-white/[0.04] hover:bg-red-500/20 text-white/60"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {(showAdd || editing) && (
        <OptionEditModal
          campId={campId}
          option={editing}
          defaultSessionCount={camp.sessionCount ?? 10}
          onClose={() => { setShowAdd(false); setEditing(null); }}
        />
      )}
    </div>
  );
}

function OptionEditModal({ campId, option, defaultSessionCount, onClose }: {
  campId: number; option: any | null; defaultSessionCount: number; onClose: () => void;
}) {
  const { toast } = useToast();
  const isEdit = !!option;
  const [form, setForm] = useState({
    name: option?.name ?? "",
    description: option?.description ?? "",
    scheduleText: option?.scheduleText ?? "",
    fullPrice: option ? (option.fullPriceCents / 100).toFixed(2) : "",
    pricingModel: option?.pricingModel ?? "term_prorated",
    sessionCount: String(option?.sessionCount ?? defaultSessionCount),
    allowPayWeekly: option?.allowPayWeekly ?? false,
    weeklyPrice: option?.weeklyPriceCents ? (option.weeklyPriceCents / 100).toFixed(2) : "",
    isActive: option?.isActive ?? true,
    displayOrder: String(option?.displayOrder ?? 0),
  });

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        name: form.name,
        description: form.description || null,
        scheduleText: form.scheduleText || null,
        fullPriceCents: Math.round(parseFloat(form.fullPrice) * 100),
        pricingModel: form.pricingModel,
        sessionCount: parseInt(form.sessionCount) || null,
        allowPayWeekly: form.allowPayWeekly,
        weeklyPriceCents: form.allowPayWeekly && form.weeklyPrice ? Math.round(parseFloat(form.weeklyPrice) * 100) : null,
        isActive: form.isActive,
        displayOrder: parseInt(form.displayOrder) || 0,
      };
      if (isEdit) {
        await apiRequest("PATCH", `/api/admin/program-options/${option.id}`, body);
      } else {
        await apiRequest("POST", `/api/admin/programs/${campId}/options`, body);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/programs", campId, "options"] });
      toast({ title: isEdit ? "Option updated" : "Option added" });
      onClose();
    },
    onError: (e: Error) => toast({ title: "Couldn't save", description: e.message, variant: "destructive" }),
  });

  // Auto-suggest weekly price from full / sessions when toggle flips on
  const suggestedWeekly = form.fullPrice && form.sessionCount
    ? (parseFloat(form.fullPrice) / parseInt(form.sessionCount)).toFixed(2)
    : "";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-lg rounded-2xl border border-blue-500/[0.15] bg-[#02060E] max-h-[90vh] overflow-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-blue-500/[0.08]">
          <h3 className="text-sm font-semibold text-white/80">{isEdit ? "Edit option" : "Add option"}</h3>
          <button onClick={onClose} className="text-white/40 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <div className="space-y-1.5">
            <label className="text-[11px] text-blue-300/30 uppercase tracking-wider font-semibold">Option name</label>
            <Input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Beginner Thursday" className="text-white/80 rounded-xl" />
          </div>
          <div className="space-y-1.5">
            <label className="text-[11px] text-blue-300/30 uppercase tracking-wider font-semibold">Schedule (shown to parents)</label>
            <Input value={form.scheduleText} onChange={e => setForm({ ...form, scheduleText: e.target.value })} placeholder="Thursdays 4pm – 6pm" className="text-white/80 rounded-xl" />
          </div>
          <div className="space-y-1.5">
            <label className="text-[11px] text-blue-300/30 uppercase tracking-wider font-semibold">Description (optional)</label>
            <textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="Includes ballet warm-up. Suitable for ages 5+..." className="w-full h-16 px-3 py-2 rounded-xl bg-white/[0.03] border border-white/[0.06] text-[13px] text-white/80 placeholder:text-white/20 focus:outline-none focus:border-blue-500/30 resize-none" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-[11px] text-blue-300/30 uppercase tracking-wider font-semibold">Full term price ($)</label>
              <Input type="number" step="0.01" value={form.fullPrice} onChange={e => setForm({ ...form, fullPrice: e.target.value })} placeholder="295.00" className="text-white/80 rounded-xl" />
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] text-blue-300/30 uppercase tracking-wider font-semibold">Sessions</label>
              <Input type="number" value={form.sessionCount} onChange={e => setForm({ ...form, sessionCount: e.target.value })} placeholder="10" className="text-white/80 rounded-xl" />
            </div>
          </div>
          <div className="space-y-2">
            <label className="text-[11px] text-blue-300/30 uppercase tracking-wider font-semibold">Pricing model</label>
            <div className="grid grid-cols-2 gap-2">
              {[
                { value: "term_prorated", label: "Pro-rated" },
                { value: "flat", label: "Flat" },
              ].map(m => (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => setForm({ ...form, pricingModel: m.value })}
                  className={`p-2 rounded-lg text-sm transition border ${
                    form.pricingModel === m.value
                      ? "bg-blue-500/15 border-blue-500/40 text-white"
                      : "bg-white/[0.02] border-white/5 text-white/60 hover:bg-white/[0.04]"
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
          <div className="pt-2 border-t border-white/5">
            <label className="flex items-center gap-2 text-sm text-white/80 cursor-pointer">
              <input type="checkbox" checked={form.allowPayWeekly} onChange={e => setForm({ ...form, allowPayWeekly: e.target.checked, weeklyPrice: e.target.checked ? suggestedWeekly : "" })} />
              Allow weekly payment (Stripe subscription)
            </label>
            <p className="text-[10px] text-white/30 mt-1 ml-5">Better for combo / high-priced options ($500+). Customer pays per week instead of upfront.</p>
            {form.allowPayWeekly && (
              <div className="mt-3 ml-5 space-y-1.5">
                <label className="text-[10px] text-white/40 uppercase">Weekly price ($)</label>
                <Input
                  type="number"
                  step="0.01"
                  value={form.weeklyPrice}
                  onChange={e => setForm({ ...form, weeklyPrice: e.target.value })}
                  placeholder={suggestedWeekly}
                  className="text-white/80 rounded-xl"
                />
                <p className="text-[10px] text-white/30">Suggested: ${suggestedWeekly} (full price ÷ sessions). Leave blank to use auto.</p>
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3 pt-2 border-t border-white/5">
            <div className="space-y-1.5">
              <label className="text-[11px] text-white/40 uppercase">Display order</label>
              <Input type="number" value={form.displayOrder} onChange={e => setForm({ ...form, displayOrder: e.target.value })} className="text-white/80 rounded-xl" />
            </div>
            <label className="flex items-center gap-2 text-sm text-white/80 cursor-pointer pt-6">
              <input type="checkbox" checked={form.isActive} onChange={e => setForm({ ...form, isActive: e.target.checked })} />
              Active (live to parents)
            </label>
          </div>
        </div>
        <div className="px-5 py-4 border-t border-blue-500/[0.08] flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => save.mutate()}
            disabled={!form.name || !form.fullPrice || save.isPending}
            className="bg-blue-600 hover:bg-blue-700 text-white"
          >
            {save.isPending ? "Saving…" : isEdit ? "Save changes" : "Add option"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// Legacy single-price tab kept for any path that still references it
function ClassPricingTab_LEGACY({ campId, camp }: { campId: number; camp: any }) {
  const { toast } = useToast();
  const [price, setPrice] = useState(
    camp.termPriceCents ? (camp.termPriceCents / 100).toFixed(2) : ""
  );
  const [sessionCount, setSessionCount] = useState(String(camp.sessionCount ?? 10));
  const [pricingModel, setPricingModel] = useState<string>(camp.pricingModel ?? "term_prorated");

  const save = useMutation({
    mutationFn: async () => {
      const cents = price ? Math.round(parseFloat(price) * 100) : null;
      await apiRequest("PATCH", `/api/admin/camps/${campId}`, {
        termPriceCents: cents,
        sessionCount: parseInt(sessionCount) || null,
        pricingModel,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/camps", campId] });
      toast({ title: "Pricing saved" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-5 max-w-xl">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Term price (NZD)</label>
          <div className="relative">
            <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/20" />
            <Input type="number" step="0.01" value={price} onChange={e => setPrice(e.target.value)} placeholder="200.00" className="pl-9 text-white/80 rounded-xl" />
          </div>
        </div>
        <div className="space-y-1.5">
          <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Sessions per term</label>
          <Input type="number" value={sessionCount} onChange={e => setSessionCount(e.target.value)} placeholder="10" className="text-white/80 rounded-xl" />
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Pricing model</label>
        <div className="grid grid-cols-2 gap-2">
          {[
            { value: "term_prorated", label: "Pro-rated", desc: "Discount as the term progresses" },
            { value: "flat", label: "Flat", desc: "Same price always" },
          ].map(m => (
            <button
              key={m.value}
              type="button"
              onClick={() => setPricingModel(m.value)}
              className={`p-3 rounded-lg text-left transition border ${
                pricingModel === m.value
                  ? "bg-blue-500/15 border-blue-500/40"
                  : "bg-white/[0.02] border-white/5 hover:bg-white/[0.04]"
              }`}
            >
              <div className="text-sm font-semibold text-white">{m.label}</div>
              <div className="text-xs text-white/50 mt-0.5">{m.desc}</div>
            </button>
          ))}
        </div>
        {pricingModel === "term_prorated" && price && sessionCount && (
          <div className="text-[11px] text-white/40 mt-2">
            If a parent registers with 5 of {sessionCount} sessions remaining, they'd pay <strong className="text-emerald-400">${(parseFloat(price) * 5 / parseInt(sessionCount)).toFixed(2)}</strong> instead of ${parseFloat(price).toFixed(2)}.
          </div>
        )}
      </div>

      <Button onClick={() => save.mutate()} disabled={save.isPending} className="bg-gradient-to-r from-blue-500 to-blue-600 text-white border-0 rounded-xl h-9 text-[13px]">
        <Save className="w-4 h-4 mr-1.5" /> Save pricing
      </Button>
    </div>
  );
}

function DatesTab({ campId }: { campId: number }) {
  const { data: dates, isLoading } = useQuery<any[]>({
    queryKey: ["/api/admin/camps", campId, "dates"],
    queryFn: async () => {
      const res = await fetch(`/api/admin/camps/${campId}/dates`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load dates");
      return res.json();
    },
  });
  const { toast } = useToast();
  const [newDate, setNewDate] = useState("");
  const [capFull, setCapFull] = useState("30");
  const [capMorn, setCapMorn] = useState("30");
  const [capAfter, setCapAfter] = useState("30");

  const addMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/admin/camps/${campId}/dates`, {
        date: newDate,
        capacityFullDay: parseInt(capFull),
        capacityMorning: parseInt(capMorn),
        capacityAfternoon: parseInt(capAfter),
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/camps", campId, "dates"] });
      setNewDate("");
      toast({ title: "Date added" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/admin/camp-dates/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/camps", campId, "dates"] });
      toast({ title: "Date removed" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const updateDateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: any }) => apiRequest("PATCH", `/api/admin/camp-dates/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/camps", campId, "dates"] });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3 flex-wrap">
        <div className="space-y-1.5">
          <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Date</label>
          <DatePickerInput value={newDate} onChange={e => setNewDate(e.target.value)} className="premium-input text-white/80 rounded-xl w-44" data-testid="input-new-date" />
        </div>
        <div className="space-y-1.5">
          <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Full Day Cap</label>
          <Input type="number" value={capFull} onChange={e => setCapFull(e.target.value)} className="premium-input text-white/80 rounded-xl w-24" data-testid="input-cap-full" />
        </div>
        <div className="space-y-1.5">
          <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">AM Cap</label>
          <Input type="number" value={capMorn} onChange={e => setCapMorn(e.target.value)} className="premium-input text-white/80 rounded-xl w-24" data-testid="input-cap-morning" />
        </div>
        <div className="space-y-1.5">
          <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">PM Cap</label>
          <Input type="number" value={capAfter} onChange={e => setCapAfter(e.target.value)} className="premium-input text-white/80 rounded-xl w-24" data-testid="input-cap-afternoon" />
        </div>
        <Button onClick={() => addMutation.mutate()} disabled={!newDate || addMutation.isPending} className="bg-gradient-to-r from-blue-500 to-blue-600 text-white border-0 rounded-xl h-9 text-[13px] glow-btn" data-testid="button-add-date">
          <Plus className="w-4 h-4 mr-1" /> Add
        </Button>
      </div>

      {isLoading ? (
        <Skeleton className="h-32 w-full rounded-xl bg-blue-500/[0.04]" />
      ) : dates && dates.length > 0 ? (
        <div className="rounded-xl border border-blue-500/[0.08] overflow-hidden overflow-x-auto">
          <table className="w-full min-w-[420px]">
            <thead>
              <tr className="border-b border-blue-500/[0.06]">
                <th className="text-left px-4 py-2.5 text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Date</th>
                <th className="text-center px-4 py-2.5 text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Full Day</th>
                <th className="text-center px-4 py-2.5 text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Morning</th>
                <th className="text-center px-4 py-2.5 text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Afternoon</th>
                <th className="w-12"></th>
              </tr>
            </thead>
            <tbody>
              {dates.map((d: any) => (
                <tr key={d.id} className="border-b border-blue-500/[0.04] row-hover" data-testid={`row-date-${d.id}`}>
                  <td className="px-4 py-2.5 text-[13px] text-white/70">{d.date}</td>
                  {(["capacityFullDay", "capacityMorning", "capacityAfternoon"] as const).map(field => (
                    <td key={field} className="text-center px-2 py-1.5">
                      <input
                        type="number"
                        defaultValue={d[field]}
                        onBlur={e => {
                          const val = parseInt(e.target.value);
                          if (!isNaN(val) && val !== d[field]) {
                            updateDateMutation.mutate({ id: d.id, data: { [field]: val } });
                          }
                        }}
                        onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                        className="w-16 mx-auto text-center text-[13px] text-white/50 bg-transparent border border-transparent hover:border-blue-500/20 focus:border-blue-500/40 focus:text-white/80 rounded-lg px-2 py-1 outline-none transition-all"
                        data-testid={`input-${field}-${d.id}`}
                      />
                    </td>
                  ))}
                  <td className="px-2">
                    <button onClick={() => deleteMutation.mutate(d.id)} className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-red-500/10 transition-colors cursor-pointer" data-testid={`button-delete-date-${d.id}`}>
                      <Trash2 className="w-3.5 h-3.5 text-white/20 hover:text-red-400" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-[13px] text-white/25 text-center py-8">No dates added yet</p>
      )}
    </div>
  );
}

function PricingTab({ campId }: { campId: number }) {
  const { data: pricing, isLoading } = useQuery<any[]>({
    queryKey: ["/api/admin/camps", campId, "pricing"],
    queryFn: async () => {
      const res = await fetch(`/api/admin/camps/${campId}/pricing`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load pricing");
      return res.json();
    },
  });
  const { toast } = useToast();
  const [fullDay, setFullDay] = useState("");
  const [morning, setMorning] = useState("");
  const [afternoon, setAfternoon] = useState("");

  const saveMutation = useMutation({
    mutationFn: async () => {
      const items = [
        { productType: "FULL_DAY", priceCents: Math.round(parseFloat(fullDay) * 100), currency: "NZD" },
        { productType: "MORNING", priceCents: Math.round(parseFloat(morning) * 100), currency: "NZD" },
        { productType: "AFTERNOON", priceCents: Math.round(parseFloat(afternoon) * 100), currency: "NZD" },
      ].filter(p => !isNaN(p.priceCents) && p.priceCents > 0);
      await apiRequest("PUT", `/api/admin/camps/${campId}/pricing`, items);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/camps", campId, "pricing"] });
      toast({ title: "Pricing saved" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const loaded = pricing && !isLoading;
  if (loaded && !fullDay && !morning && !afternoon) {
    const fd = pricing.find((p: any) => p.productType === "FULL_DAY");
    const am = pricing.find((p: any) => p.productType === "MORNING");
    const pm = pricing.find((p: any) => p.productType === "AFTERNOON");
    if (fd) setTimeout(() => setFullDay((fd.priceCents / 100).toFixed(2)), 0);
    if (am) setTimeout(() => setMorning((am.priceCents / 100).toFixed(2)), 0);
    if (pm) setTimeout(() => setAfternoon((pm.priceCents / 100).toFixed(2)), 0);
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="space-y-1.5">
          <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Full Day (NZD)</label>
          <div className="relative">
            <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/20" />
            <Input type="number" step="0.01" value={fullDay} onChange={e => setFullDay(e.target.value)} placeholder="75.00" className="pl-9 premium-input text-white/80 rounded-xl" data-testid="input-price-full-day" />
          </div>
        </div>
        <div className="space-y-1.5">
          <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Morning (NZD)</label>
          <div className="relative">
            <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/20" />
            <Input type="number" step="0.01" value={morning} onChange={e => setMorning(e.target.value)} placeholder="45.00" className="pl-9 premium-input text-white/80 rounded-xl" data-testid="input-price-morning" />
          </div>
        </div>
        <div className="space-y-1.5">
          <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Afternoon (NZD)</label>
          <div className="relative">
            <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/20" />
            <Input type="number" step="0.01" value={afternoon} onChange={e => setAfternoon(e.target.value)} placeholder="45.00" className="pl-9 premium-input text-white/80 rounded-xl" data-testid="input-price-afternoon" />
          </div>
        </div>
      </div>
      <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending} className="bg-gradient-to-r from-blue-500 to-blue-600 text-white border-0 rounded-xl h-9 text-[13px] glow-btn" data-testid="button-save-pricing">
        <Save className="w-4 h-4 mr-1.5" /> Save Pricing
      </Button>
    </div>
  );
}

function DiscountsTab({ campId }: { campId: number }) {
  const { data: discounts, isLoading } = useQuery<any[]>({
    queryKey: ["/api/admin/camps", campId, "discounts"],
    queryFn: async () => {
      const res = await fetch(`/api/admin/camps/${campId}/discounts`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load discounts");
      return res.json();
    },
  });
  const { toast } = useToast();
  const [items, setItems] = useState<{ minBookings: string; discountPercent: string }[]>([]);
  const [loaded, setLoaded] = useState(false);

  if (discounts && !isLoading && !loaded) {
    setItems(discounts.map((d: any) => ({ minBookings: String(d.minBookings), discountPercent: String(d.discountPercent) })));
    setLoaded(true);
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      const data = items.filter(i => parseInt(i.minBookings) > 0 && parseFloat(i.discountPercent) > 0).map(i => ({
        minBookings: parseInt(i.minBookings),
        discountPercent: i.discountPercent,
      }));
      await apiRequest("PUT", `/api/admin/camps/${campId}/discounts`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/camps", campId, "discounts"] });
      toast({ title: "Discounts saved" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-4">
      <p className="text-[12px] text-white/30">Volume discounts based on total session bookings per registration</p>
      <div className="space-y-2">
        {items.map((item, i) => (
          <div key={i} className="flex items-center gap-3">
            <div className="space-y-1">
              <label className="text-[10px] text-blue-300/25 uppercase tracking-wider font-semibold">Min Bookings</label>
              <Input type="number" value={item.minBookings} onChange={e => { const n = [...items]; n[i].minBookings = e.target.value; setItems(n); }} className="premium-input text-white/80 rounded-xl w-28" data-testid={`input-discount-min-${i}`} />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] text-blue-300/25 uppercase tracking-wider font-semibold">Discount %</label>
              <Input type="number" step="0.01" value={item.discountPercent} onChange={e => { const n = [...items]; n[i].discountPercent = e.target.value; setItems(n); }} className="premium-input text-white/80 rounded-xl w-28" data-testid={`input-discount-pct-${i}`} />
            </div>
            <button onClick={() => setItems(items.filter((_, j) => j !== i))} className="mt-5 w-7 h-7 rounded-lg flex items-center justify-center hover:bg-red-500/10 transition-colors cursor-pointer">
              <X className="w-3.5 h-3.5 text-white/20" />
            </button>
          </div>
        ))}
      </div>
      <div className="flex gap-3">
        <Button variant="outline" onClick={() => setItems([...items, { minBookings: "", discountPercent: "" }])} className="rounded-xl h-8 text-[12px] border-blue-500/20 text-blue-400/60 hover:bg-blue-500/5" data-testid="button-add-discount">
          <Plus className="w-3.5 h-3.5 mr-1" /> Add Tier
        </Button>
        <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending} className="bg-gradient-to-r from-blue-500 to-blue-600 text-white border-0 rounded-xl h-8 text-[12px] glow-btn" data-testid="button-save-discounts">
          <Save className="w-3.5 h-3.5 mr-1" /> Save
        </Button>
      </div>
    </div>
  );
}

function ContentTab({ camp, onUpdate }: { camp: any; onUpdate: (data: any) => void }) {
  const [heroHeadline, setHeroHeadline] = useState(camp.heroHeadline || "");
  const [heroSubheadline, setHeroSubheadline] = useState(camp.heroSubheadline || "");
  const [descriptionShort, setDescriptionShort] = useState(camp.descriptionShort || "");
  const [descriptionLong, setDescriptionLong] = useState(camp.descriptionLong || "");
  const [whatToBring, setWhatToBring] = useState(camp.whatToBring || "");
  const [inclusions, setInclusions] = useState(camp.inclusions || "");
  const [refundPolicy, setRefundPolicy] = useState(camp.refundPolicy || "");
  const [contactEmail, setContactEmail] = useState(camp.contactEmail || "");
  const [primaryCta, setPrimaryCta] = useState(camp.primaryCta || "Book Now");
  const [faqItems, setFaqItems] = useState<{q: string; a: string}[]>(() => {
    try { return camp.faqJson ? JSON.parse(camp.faqJson) : []; } catch { return []; }
  });

  const handleSave = () => {
    onUpdate({
      heroHeadline: heroHeadline || null,
      heroSubheadline: heroSubheadline || null,
      descriptionShort: descriptionShort || null,
      descriptionLong: descriptionLong || null,
      whatToBring: whatToBring || null,
      inclusions: inclusions || null,
      refundPolicy: refundPolicy || null,
      contactEmail: contactEmail || null,
      primaryCta: primaryCta || "Book Now",
      faqJson: faqItems.length > 0 ? JSON.stringify(faqItems.filter(f => f.q)) : null,
    });
  };

  return (
    <div className="space-y-5">
      <p className="text-[12px] text-white/30">These fields control the public landing page for this camp</p>

      <div className="space-y-4">
        <div className="space-y-1.5">
          <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Hero Headline</label>
          <Input value={heroHeadline} onChange={e => setHeroHeadline(e.target.value)} placeholder="Give Your Child the Best School Holiday Experience" className="premium-input text-white/80 rounded-xl" data-testid="input-hero-headline" />
        </div>
        <div className="space-y-1.5">
          <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Hero Subheadline</label>
          <Input value={heroSubheadline} onChange={e => setHeroSubheadline(e.target.value)} className="premium-input text-white/80 rounded-xl" data-testid="input-hero-subheadline" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">CTA Button Text</label>
            <Input value={primaryCta} onChange={e => setPrimaryCta(e.target.value)} className="premium-input text-white/80 rounded-xl" data-testid="input-primary-cta" />
          </div>
          <div className="space-y-1.5">
            <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Contact Email</label>
            <Input value={contactEmail} onChange={e => setContactEmail(e.target.value)} className="premium-input text-white/80 rounded-xl" data-testid="input-contact-email" />
          </div>
        </div>
        <div className="space-y-1.5">
          <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Short Description</label>
          <textarea value={descriptionShort} onChange={e => setDescriptionShort(e.target.value)} className="w-full h-16 px-3 py-2 rounded-xl bg-white/[0.03] border border-white/[0.06] text-[13px] text-white/80 placeholder:text-white/20 focus:outline-none focus:border-blue-500/30 resize-none" placeholder="One-liner for program listing cards" data-testid="input-description-short" />
        </div>
        <div className="space-y-1.5">
          <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Long Description</label>
          <textarea value={descriptionLong} onChange={e => setDescriptionLong(e.target.value)} className="w-full h-28 px-3 py-2 rounded-xl bg-white/[0.03] border border-white/[0.06] text-[13px] text-white/80 placeholder:text-white/20 focus:outline-none focus:border-blue-500/30 resize-none" placeholder="Detailed description for the About section" data-testid="input-description-long" />
        </div>
        <div className="space-y-1.5">
          <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">What's Included (one per line)</label>
          <textarea value={inclusions} onChange={e => setInclusions(e.target.value)} className="w-full h-24 px-3 py-2 rounded-xl bg-white/[0.03] border border-white/[0.06] text-[13px] text-white/80 placeholder:text-white/20 focus:outline-none focus:border-blue-500/30 resize-none" data-testid="input-inclusions" />
        </div>
        <div className="space-y-1.5">
          <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">What to Bring (one per line)</label>
          <textarea value={whatToBring} onChange={e => setWhatToBring(e.target.value)} className="w-full h-24 px-3 py-2 rounded-xl bg-white/[0.03] border border-white/[0.06] text-[13px] text-white/80 placeholder:text-white/20 focus:outline-none focus:border-blue-500/30 resize-none" data-testid="input-what-to-bring" />
        </div>
        <div className="space-y-1.5">
          <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Refund Policy</label>
          <textarea value={refundPolicy} onChange={e => setRefundPolicy(e.target.value)} className="w-full h-16 px-3 py-2 rounded-xl bg-white/[0.03] border border-white/[0.06] text-[13px] text-white/80 placeholder:text-white/20 focus:outline-none focus:border-blue-500/30 resize-none" data-testid="input-refund-policy" />
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">FAQ Items</label>
          <Button variant="outline" onClick={() => setFaqItems([...faqItems, { q: "", a: "" }])} className="rounded-lg h-7 text-[11px] border-blue-500/20 text-blue-400/60 hover:bg-blue-500/5" data-testid="button-add-faq">
            <Plus className="w-3 h-3 mr-1" /> Add FAQ
          </Button>
        </div>
        {faqItems.map((item, i) => (
          <div key={i} className="rounded-xl bg-white/[0.02] border border-white/[0.06] p-3 space-y-2">
            <div className="flex items-start gap-2">
              <div className="flex-1 space-y-2">
                <Input value={item.q} onChange={e => { const n = [...faqItems]; n[i].q = e.target.value; setFaqItems(n); }} placeholder="Question" className="premium-input text-white/80 rounded-lg text-[12px]" data-testid={`input-faq-q-${i}`} />
                <textarea value={item.a} onChange={e => { const n = [...faqItems]; n[i].a = e.target.value; setFaqItems(n); }} placeholder="Answer" className="w-full h-14 px-3 py-2 rounded-lg bg-white/[0.03] border border-white/[0.06] text-[12px] text-white/80 placeholder:text-white/20 focus:outline-none focus:border-blue-500/30 resize-none" data-testid={`input-faq-a-${i}`} />
              </div>
              <button onClick={() => setFaqItems(faqItems.filter((_, j) => j !== i))} className="w-6 h-6 rounded-md flex items-center justify-center hover:bg-red-500/10 transition-colors cursor-pointer mt-1">
                <X className="w-3 h-3 text-white/20" />
              </button>
            </div>
          </div>
        ))}
      </div>

      <Button onClick={handleSave} className="bg-gradient-to-r from-blue-500 to-blue-600 text-white border-0 rounded-xl h-9 text-[13px] glow-btn" data-testid="button-save-content">
        <Save className="w-4 h-4 mr-1.5" /> Save Content
      </Button>
    </div>
  );
}

function PerformanceTab({ campId }: { campId: number }) {
  const { toast } = useToast();
  const { data: tests, isLoading } = useQuery<any[]>({
    queryKey: ["/api/admin/split-tests", campId],
    queryFn: async () => {
      const res = await fetch(`/api/admin/split-tests/${campId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load");
      return res.json();
    },
  });

  const cancelMutation = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/admin/split-tests/${id}/cancel`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/split-tests", campId] });
      toast({ title: "Test cancelled" });
    },
  });

  const completeMutation = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/admin/split-tests/${id}/complete`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/split-tests", campId] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/camps", campId] });
      toast({ title: "Test completed — winner applied!" });
    },
  });

  const fieldLabels: Record<string, string> = {
    heroHeadline: "Headline",
    heroSubheadline: "Subheadline",
    primaryCta: "CTA Button",
  };

  if (isLoading) return <div className="flex justify-center py-8"><div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" /></div>;

  const activeTests = (tests || []).filter(t => t.status === "active");
  const pastTests = (tests || []).filter(t => t.status !== "active");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white/80 flex items-center gap-2">
          <FlaskConical className="w-4 h-4 text-purple-400" />
          Split Tests
        </h3>
        <p className="text-xs text-white/40">Create tests from the Edit Page editor</p>
      </div>

      {activeTests.length === 0 && pastTests.length === 0 && (
        <div className="text-center py-12">
          <FlaskConical className="w-10 h-10 text-white/10 mx-auto mb-3" />
          <p className="text-sm text-white/40">No split tests yet</p>
          <p className="text-xs text-white/25 mt-1">Go to Edit Page and hover over a headline to create one</p>
        </div>
      )}

      {activeTests.map(test => {
        const totalViews = test.variants.reduce((s: number, v: any) => s + v.views, 0);
        const totalRegs = test.variants.reduce((s: number, v: any) => s + v.registrations, 0);
        const totalRev = test.variants.reduce((s: number, v: any) => s + v.revenue, 0);
        const elapsed = Math.round((Date.now() - new Date(test.startedAt).getTime()) / 86400000);
        const progress = test.endCondition === "days"
          ? Math.min(100, Math.round((elapsed / test.endValue) * 100))
          : Math.min(100, Math.round((totalViews / test.endValue) * 100));

        return (
          <div key={test.id} className="rounded-xl border border-purple-500/15 bg-purple-500/[0.03] overflow-hidden" data-testid={`split-test-${test.id}`}>
            <div className="px-4 py-3 border-b border-purple-500/10 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Badge className="bg-green-500/15 text-green-400 border-green-500/20 text-[10px]">ACTIVE</Badge>
                <span className="text-sm font-medium text-white">{fieldLabels[test.field] || test.field} Split Test</span>
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="ghost" onClick={() => completeMutation.mutate(test.id)} className="text-green-400 hover:text-green-300 hover:bg-green-500/10 text-xs h-7" data-testid={`btn-complete-${test.id}`}>
                  <Trophy className="w-3 h-3 mr-1" /> End & Pick Winner
                </Button>
                <Button size="sm" variant="ghost" onClick={() => cancelMutation.mutate(test.id)} className="text-red-400 hover:text-red-300 hover:bg-red-500/10 text-xs h-7" data-testid={`btn-cancel-${test.id}`}>
                  <Ban className="w-3 h-3 mr-1" /> Cancel
                </Button>
              </div>
            </div>

            <div className="px-4 py-3 border-b border-purple-500/5">
              <div className="flex items-center gap-4 text-xs text-white/50">
                <span>Started: {new Date(test.startedAt).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                <span>End: {test.endCondition === "days" ? `After ${test.endValue} days` : `After ${test.endValue} views`}</span>
                <span>{elapsed} day{elapsed !== 1 ? 's' : ''} elapsed</span>
              </div>
              <div className="mt-2">
                <Progress value={progress} className="h-1.5" />
                <p className="text-[10px] text-white/30 mt-1">{progress}% complete</p>
              </div>
            </div>

            <div className="divide-y divide-white/[0.04]">
              {test.variants.map((v: any, i: number) => {
                const maxRev = Math.max(...test.variants.map((x: any) => x.revenue), 1);
                const revPct = (v.revenue / maxRev) * 100;
                const convRate = v.views > 0 ? ((v.registrations / v.views) * 100).toFixed(1) : "0.0";
                const isLeading = v.revenue === Math.max(...test.variants.map((x: any) => x.revenue)) && v.revenue > 0;
                return (
                  <div key={v.id} className={`px-4 py-3 ${isLeading ? 'bg-green-500/[0.03]' : ''}`} data-testid={`variant-row-${v.id}`}>
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <span className={`text-xs font-bold w-5 h-5 rounded flex items-center justify-center ${isLeading ? 'bg-green-500/20 text-green-400' : 'bg-white/5 text-white/40'}`}>
                          {String.fromCharCode(65 + i)}
                        </span>
                        <span className="text-sm text-white/90 truncate">{v.value}</span>
                        {v.isControl && <Badge variant="outline" className="text-[9px] border-white/10 text-white/30">Control</Badge>}
                        {isLeading && <Badge className="bg-green-500/15 text-green-400 border-green-500/20 text-[9px]">Leading</Badge>}
                      </div>
                    </div>
                    <div className="grid grid-cols-4 gap-3 text-xs">
                      <div>
                        <p className="text-white/40">Views</p>
                        <p className="font-semibold text-white">{v.views.toLocaleString()}</p>
                      </div>
                      <div>
                        <p className="text-white/40">Registrations</p>
                        <p className="font-semibold text-white">{v.registrations}</p>
                      </div>
                      <div>
                        <p className="text-white/40">Revenue</p>
                        <p className="font-semibold text-green-400">{formatCurrency(v.revenue, { fromCents: true })}</p>
                      </div>
                      <div>
                        <p className="text-white/40">Conv Rate</p>
                        <p className="font-semibold text-white">{convRate}%</p>
                      </div>
                    </div>
                    <div className="mt-2 h-1.5 bg-white/5 rounded overflow-hidden">
                      <div className={`h-full rounded ${isLeading ? 'bg-green-500/60' : 'bg-purple-500/40'}`} style={{ width: `${revPct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="px-4 py-2 border-t border-purple-500/10 bg-white/[0.01] flex items-center gap-6 text-xs text-white/40">
              <span>Total Views: {totalViews.toLocaleString()}</span>
              <span>Total Regs: {totalRegs}</span>
              <span>Total Revenue: {formatCurrency(totalRev, { fromCents: true })}</span>
            </div>
          </div>
        );
      })}

      {pastTests.length > 0 && (
        <div className="space-y-3">
          <h4 className="text-xs font-medium text-white/40 uppercase tracking-wider">Past Tests</h4>
          {pastTests.map(test => {
            const winnerVariant = test.variants.find((v: any) => v.id === test.winnerId);
            return (
              <div key={test.id} className="rounded-xl border border-white/5 bg-white/[0.02] overflow-hidden" data-testid={`past-test-${test.id}`}>
                <div className="px-4 py-3 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Badge className={test.status === "completed" ? "bg-blue-500/15 text-blue-400 border-blue-500/20 text-[10px]" : "bg-red-500/15 text-red-400 border-red-500/20 text-[10px]"}>
                      {test.status === "completed" ? "COMPLETED" : "CANCELLED"}
                    </Badge>
                    <span className="text-sm text-white/60">{fieldLabels[test.field] || test.field} Split Test</span>
                  </div>
                  <span className="text-xs text-white/30">
                    {new Date(test.startedAt).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' })} — {test.endedAt ? new Date(test.endedAt).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' }) : 'N/A'}
                  </span>
                </div>
                {test.status === "completed" && winnerVariant && (
                  <div className="px-4 py-2 border-t border-white/5 flex items-center gap-2">
                    <Trophy className="w-3.5 h-3.5 text-yellow-500" />
                    <span className="text-xs text-white/50">Winner:</span>
                    <span className="text-xs text-white/80 font-medium truncate">{winnerVariant.value}</span>
                    <span className="text-xs text-green-400 ml-auto">{formatCurrency(winnerVariant.revenue, { fromCents: true })} rev · {winnerVariant.registrations} regs</span>
                  </div>
                )}
                <div className="divide-y divide-white/[0.03]">
                  {test.variants.map((v: any, i: number) => (
                    <div key={v.id} className={`px-4 py-2 flex items-center gap-3 text-xs ${v.id === test.winnerId ? 'bg-green-500/[0.03]' : ''}`}>
                      <span className="text-white/30 font-bold w-4">{String.fromCharCode(65 + i)}</span>
                      <span className="text-white/50 flex-1 truncate">{v.value}</span>
                      <span className="text-white/30">{v.views} views</span>
                      <span className="text-white/30">{v.registrations} regs</span>
                      <span className="text-white/40">{formatCurrency(v.revenue, { fromCents: true })}</span>
                      {v.id === test.winnerId && <Trophy className="w-3 h-3 text-yellow-500" />}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function EmailTab({ campId }: { campId: number }) {
  const { data: settings, isLoading } = useQuery<any>({
    queryKey: ["/api/admin/camps", campId, "settings"],
    queryFn: async () => {
      const res = await fetch(`/api/admin/camps/${campId}/settings`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load settings");
      return res.json();
    },
  });
  const { toast } = useToast();
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [fromEmail, setFromEmail] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [loaded, setLoaded] = useState(false);

  if (settings && !isLoading && !loaded && settings.id) {
    setSubject(settings.confirmationEmailSubject || "");
    setBody(settings.confirmationEmailBody || "");
    setFromEmail(settings.fromEmail || "");
    setReplyTo(settings.replyTo || "");
    setLoaded(true);
  }

  const saveMutation = useMutation({
    mutationFn: () => apiRequest("PUT", `/api/admin/camps/${campId}/settings`, {
      confirmationEmailSubject: subject,
      confirmationEmailBody: body,
      fromEmail,
      replyTo,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/camps", campId, "settings"] });
      toast({ title: "Email template saved" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-4">
      <p className="text-[12px] text-white/30">Variables: {"{{campName}}, {{parentName}}, {{childrenList}}, {{campDates}}, {{location}}, {{totalPaid}}"}</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">From Email</label>
          <Input value={fromEmail} onChange={e => setFromEmail(e.target.value)} className="premium-input text-white/80 rounded-xl" data-testid="input-from-email" />
        </div>
        <div className="space-y-1.5">
          <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Reply-To</label>
          <Input value={replyTo} onChange={e => setReplyTo(e.target.value)} className="premium-input text-white/80 rounded-xl" data-testid="input-reply-to" />
        </div>
        <div className="sm:col-span-2 space-y-1.5">
          <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Subject</label>
          <Input value={subject} onChange={e => setSubject(e.target.value)} className="premium-input text-white/80 rounded-xl" data-testid="input-email-subject" />
        </div>
        <div className="sm:col-span-2 space-y-1.5">
          <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Body</label>
          <textarea value={body} onChange={e => setBody(e.target.value)} className="w-full h-40 px-3 py-2 rounded-xl bg-white/[0.03] border border-white/[0.06] text-[13px] text-white/80 placeholder:text-white/20 focus:outline-none focus:border-blue-500/30 resize-none font-mono" data-testid="input-email-body" />
        </div>
      </div>
      <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending} className="bg-gradient-to-r from-blue-500 to-blue-600 text-white border-0 rounded-xl h-9 text-[13px] glow-btn" data-testid="button-save-email">
        <Save className="w-4 h-4 mr-1.5" /> Save Template
      </Button>
    </div>
  );
}

type SessionSummary = { campDateId: number; date: string; productType: string; bookedCount: number; capacity: number };
type CampStats = { totalRegistrations: number; confirmedRegistrations: number; totalRevenueCents: number; totalSessions: number };

function StatsHeader({ campId }: { campId: number }) {
  const { data: stats, isLoading } = useQuery<CampStats>({
    queryKey: ["/api/admin/camps", campId, "stats"],
    queryFn: async () => {
      const res = await fetch(`/api/admin/camps/${campId}/stats`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load stats");
      return res.json();
    },
  });

  const { data: sessions } = useQuery<SessionSummary[]>({
    queryKey: ["/api/admin/camps", campId, "sessions-summary"],
    queryFn: async () => {
      const res = await fetch(`/api/admin/camps/${campId}/sessions-summary`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load sessions");
      return res.json();
    },
  });

  const avgOccupancy = sessions && sessions.length > 0
    ? Math.round(sessions.filter(s => s.capacity > 0).reduce((sum, s) => sum + (s.bookedCount / s.capacity) * 100, 0) / (sessions.filter(s => s.capacity > 0).length || 1))
    : 0;

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-[72px] rounded-xl bg-blue-500/[0.04]" />)}
      </div>
    );
  }

  const statItems = [
    { label: "Total Registrations", value: stats?.totalRegistrations || 0, icon: Users, color: "text-blue-400" },
    { label: "Confirmed", value: stats?.confirmedRegistrations || 0, icon: TrendingUp, color: "text-emerald-400" },
    { label: "Revenue", value: formatCurrency(stats?.totalRevenueCents || 0, { fromCents: true, decimals: 0 }), icon: DollarSign, color: "text-amber-400" },
    { label: "Avg Occupancy", value: `${avgOccupancy}%`, icon: BarChart3, color: "text-purple-400" },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3" data-testid="stats-header">
      {statItems.map((s) => (
        <div key={s.label} className="rounded-xl border border-blue-500/[0.08] bg-white/[0.02] px-4 py-3">
          <div className="flex items-center gap-2 mb-1">
            <s.icon className={`w-3.5 h-3.5 ${s.color} opacity-50`} />
            <span className="text-[10px] text-blue-300/25 uppercase tracking-wider font-semibold">{s.label}</span>
          </div>
          <p className={`text-lg font-semibold ${s.color}/80`} data-testid={`stat-${s.label.toLowerCase().replace(/\s/g, '-')}`}>{s.value}</p>
        </div>
      ))}
    </div>
  );
}

function getDayLabel(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const day = days[d.getDay()];
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${day} ${dd}/${mm}`;
}

function getWeekKey(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  const startOfWeek = new Date(d);
  startOfWeek.setDate(d.getDate() - d.getDay() + 1);
  const dd = String(startOfWeek.getDate()).padStart(2, "0");
  const mm = String(startOfWeek.getMonth() + 1).padStart(2, "0");
  return `Week of ${dd}/${mm}`;
}

type RollPlayer = {
  child: { id: number; firstName: string; lastName: string; dateOfBirth?: string | null; gender?: string | null; parentId: number; medical?: { allergies?: string | null; epiPen?: boolean; notes?: string | null } };
  parent: { id: number; firstName: string; lastName: string; email?: string | null; phone?: string | null };
  attendance?: { id: number; checkedInAt?: string | null; checkedOutAt?: string | null; note?: string | null };
  productType: string;
};

function formatAge(dob: string | null | undefined): string {
  if (!dob) return "—";
  const birth = new Date(dob + "T00:00:00");
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  if (now.getMonth() < birth.getMonth() || (now.getMonth() === birth.getMonth() && now.getDate() < birth.getDate())) age--;
  return `${age}y`;
}

function formatDob(dob: string | null | undefined): string {
  if (!dob) return "—";
  const d = new Date(dob + "T00:00:00");
  return d.toLocaleDateString("en-NZ", { day: "2-digit", month: "short", year: "numeric" });
}

function PlayerProfileModal({ player, onClose }: { player: RollPlayer; onClose: () => void }) {
  const c = player.child;
  const p = player.parent;
  const med = c.medical;
  const hasAllergies = med?.allergies && med.allergies.trim().length > 0;
  const hasEpiPen = med?.epiPen;
  const hasMedNotes = med?.notes && med.notes.trim().length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md mx-4 rounded-2xl border border-blue-500/[0.15] overflow-hidden animate-fade-in-up" style={{ background: "linear-gradient(135deg, rgba(3,86,197,0.06) 0%, #02060E 100%)", animationDelay: "0ms", opacity: 0 }} data-testid="modal-player-profile">
        <div className="flex items-center justify-between px-5 py-4 border-b border-blue-500/[0.08]">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-blue-500/15 border border-blue-500/20 flex items-center justify-center">
              <User className="w-4 h-4 text-blue-400/70" />
            </div>
            <div>
              <h3 className="text-[14px] font-semibold text-white/80" data-testid="text-player-name">{c.firstName} {c.lastName}</h3>
              <p className="text-[11px] text-blue-400/35">{formatAge(c.dateOfBirth)} old · {c.gender || "—"}</p>
            </div>
          </div>
          <button onClick={onClose} className="w-7 h-7 rounded-lg bg-white/[0.04] border border-white/[0.06] flex items-center justify-center hover:bg-white/[0.08] transition-colors cursor-pointer" data-testid="button-close-profile">
            <X className="w-3.5 h-3.5 text-white/40" />
          </button>
        </div>

        <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
          <div className="space-y-2">
            <label className="text-[10px] text-blue-300/25 uppercase tracking-wider font-semibold">Player Details</label>
            <div className="rounded-xl bg-white/[0.02] border border-white/[0.06] p-3 space-y-2">
              <div className="flex justify-between">
                <span className="text-[12px] text-white/40">Date of Birth</span>
                <span className="text-[12px] text-white/70" data-testid="text-player-dob">{formatDob(c.dateOfBirth)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[12px] text-white/40">Gender</span>
                <span className="text-[12px] text-white/70">{c.gender || "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[12px] text-white/40">Session Type</span>
                <span className="text-[12px] text-white/70">{player.productType === "FULL_DAY" ? "Full Day" : player.productType === "MORNING" ? "Morning" : "Afternoon"}</span>
              </div>
            </div>
          </div>

          {(hasAllergies || hasEpiPen || hasMedNotes) && (
            <div className="space-y-2">
              <label className="text-[10px] text-blue-300/25 uppercase tracking-wider font-semibold flex items-center gap-1.5">
                <AlertTriangle className="w-3 h-3 text-amber-400/50" /> Medical Info
              </label>
              <div className="rounded-xl bg-amber-500/[0.04] border border-amber-500/[0.12] p-3 space-y-2">
                {hasAllergies && (
                  <div>
                    <span className="text-[11px] text-amber-400/50 font-medium">Allergies</span>
                    <p className="text-[12px] text-white/70 mt-0.5" data-testid="text-player-allergies">{med!.allergies}</p>
                  </div>
                )}
                {hasEpiPen && (
                  <div className="flex items-center gap-1.5">
                    <Badge variant="outline" className="text-[9px] text-red-400/80 border-red-500/20 bg-red-500/10 uppercase tracking-wider no-default-hover-elevate no-default-active-elevate" data-testid="badge-epipen">EpiPen Required</Badge>
                  </div>
                )}
                {hasMedNotes && (
                  <div>
                    <span className="text-[11px] text-amber-400/50 font-medium">Medical Notes</span>
                    <p className="text-[12px] text-white/70 mt-0.5" data-testid="text-player-medical-notes">{med!.notes}</p>
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="space-y-2">
            <label className="text-[10px] text-blue-300/25 uppercase tracking-wider font-semibold">Parent / Guardian</label>
            <div className="rounded-xl bg-white/[0.02] border border-white/[0.06] p-3 space-y-2">
              <div className="flex justify-between items-center">
                <span className="text-[12px] text-white/40">Name</span>
                <span className="text-[12px] text-white/70 font-medium" data-testid="text-parent-name">{p.firstName} {p.lastName}</span>
              </div>
              {p.email && (
                <div className="flex justify-between items-center">
                  <span className="text-[12px] text-white/40 flex items-center gap-1"><Mail className="w-3 h-3" /> Email</span>
                  <a href={`mailto:${p.email}`} className="text-[12px] text-blue-400/70 hover:text-blue-400 transition-colors" data-testid="text-parent-email">{p.email}</a>
                </div>
              )}
              {p.phone && (
                <div className="flex justify-between items-center">
                  <span className="text-[12px] text-white/40 flex items-center gap-1"><Phone className="w-3 h-3" /> Phone</span>
                  <a href={`tel:${p.phone}`} className="text-[12px] text-blue-400/70 hover:text-blue-400 transition-colors" data-testid="text-parent-phone">{p.phone}</a>
                </div>
              )}
            </div>
          </div>

          {player.attendance && (
            <div className="space-y-2">
              <label className="text-[10px] text-blue-300/25 uppercase tracking-wider font-semibold">Attendance</label>
              <div className="rounded-xl bg-white/[0.02] border border-white/[0.06] p-3 space-y-2">
                <div className="flex justify-between">
                  <span className="text-[12px] text-white/40">Signed In</span>
                  <span className="text-[12px] text-white/70">{player.attendance.checkedInAt ? new Date(player.attendance.checkedInAt).toLocaleTimeString("en-NZ", { hour: "2-digit", minute: "2-digit" }) : "—"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[12px] text-white/40">Signed Out</span>
                  <span className="text-[12px] text-white/70">{player.attendance.checkedOutAt ? new Date(player.attendance.checkedOutAt).toLocaleTimeString("en-NZ", { hour: "2-digit", minute: "2-digit" }) : "—"}</span>
                </div>
                {player.attendance.note && (
                  <div>
                    <span className="text-[12px] text-white/40">Note</span>
                    <p className="text-[12px] text-white/70 mt-0.5">{player.attendance.note}</p>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

type ProgramPlayer = {
  childId: number;
  firstName: string;
  lastName: string;
  dateOfBirth: string | null;
  gender: string | null;
  allergies: string | null;
  epiPen: boolean;
  medicalNotes: string | null;
  parent: { id: number; firstName: string; lastName: string; email: string | null; phone: string | null } | null;
  status: string;
  registrationIds: number[];
  orderNumbers: number[];
  sessionsBooked: number;
  firstRegisteredAt: string | null;
  latestRegisteredAt: string | null;
};

/** Age in whole years at today, or null when we have no date of birth. */
function ageFromDob(dob: string | null): number | null {
  if (!dob) return null;
  const born = new Date(dob);
  if (isNaN(born.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - born.getFullYear();
  const m = now.getMonth() - born.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < born.getDate())) age--;
  return age;
}

const PLAYER_STATUS_STYLES: Record<string, string> = {
  confirmed: "text-emerald-400/70 border-emerald-500/15 bg-emerald-500/10",
  pending: "text-amber-400/60 border-amber-500/15 bg-amber-500/10",
  cancelled: "text-red-400/60 border-red-500/15 bg-red-500/10",
};

/**
 * Who has actually signed up. First tab on every programme, because "which
 * kids are in this programme" is the question staff open the page to answer —
 * Sessions answers "how full is each night", which is the second question.
 *
 * One row per child, not per registration. Missing dates of birth are flagged
 * rather than hidden: the NZF / Mainland Football audit needs a real DOB on
 * every player, and a blank here is the thing to chase.
 */
function PlayersTab({ campId, camp }: { campId: number; camp?: any }) {
  const [, navigate] = useLocation();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const { data: players, isLoading } = useQuery<ProgramPlayer[]>({
    queryKey: ["/api/admin/camps", campId, "players"],
    queryFn: async () => {
      const res = await fetch(`/api/admin/camps/${campId}/players`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load players");
      return res.json();
    },
  });

  if (isLoading) {
    return <Skeleton className="h-64 w-full rounded-xl bg-blue-500/[0.04]" />;
  }

  const all = players ?? [];

  if (all.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <Users className="w-10 h-10 text-blue-400/10 mb-3" />
        <p className="text-[13px] text-white/25">No players signed up yet</p>
        <p className="text-[11px] text-white/15 mt-1">Registrations appear here the moment someone books.</p>
      </div>
    );
  }

  const counts = all.reduce<Record<string, number>>((acc, p) => {
    acc[p.status] = (acc[p.status] ?? 0) + 1;
    return acc;
  }, {});
  const missingDob = all.filter(p => !p.dateOfBirth).length;

  const q = search.trim().toLowerCase();
  const filtered = all.filter(p => {
    if (statusFilter !== "all" && p.status !== statusFilter) return false;
    if (!q) return true;
    const hay = [
      p.firstName, p.lastName,
      p.parent?.firstName, p.parent?.lastName, p.parent?.email, p.parent?.phone,
    ].filter(Boolean).join(" ").toLowerCase();
    return hay.includes(q);
  });

  const exportCsv = () => {
    const header = ["First name", "Last name", "Date of birth", "Age", "Gender", "Status", "Sessions booked", "Parent", "Parent email", "Parent phone", "Allergies", "EpiPen", "Registered"];
    const rows = filtered.map(p => [
      p.firstName,
      p.lastName,
      p.dateOfBirth ?? "",
      ageFromDob(p.dateOfBirth) ?? "",
      p.gender ?? "",
      p.status,
      p.sessionsBooked,
      p.parent ? `${p.parent.firstName} ${p.parent.lastName}`.trim() : "",
      p.parent?.email ?? "",
      p.parent?.phone ?? "",
      p.allergies ?? "",
      p.epiPen ? "Yes" : "",
      p.firstRegisteredAt ? new Date(p.firstRegisteredAt).toLocaleDateString("en-NZ") : "",
    ]);
    const esc = (v: any) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [header, ...rows].map(r => r.map(esc).join(",")).join("\n");
    const slug = (camp?.slug || camp?.name || "programme").toString().replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slug}-players.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const chips: { key: string; label: string; count: number }[] = [
    { key: "all", label: "All", count: all.length },
    ...["confirmed", "pending", "cancelled"]
      .filter(s => counts[s])
      .map(s => ({ key: s, label: s.charAt(0).toUpperCase() + s.slice(1), count: counts[s] })),
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-col sm:flex-row sm:items-center gap-2">
        <div className="flex items-center gap-1.5 flex-wrap">
          {chips.map(c => (
            <button
              key={c.key}
              onClick={() => setStatusFilter(c.key)}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all cursor-pointer border ${
                statusFilter === c.key
                  ? "bg-blue-500/15 text-blue-400 border-blue-500/25"
                  : "text-white/35 border-transparent hover:text-white/55 hover:bg-white/[0.03]"
              }`}
              data-testid={`filter-players-${c.key}`}
            >
              {c.label} <span className="text-white/25">{c.count}</span>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 sm:ml-auto">
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search player or parent…"
            className="premium-input text-white/80 rounded-xl h-8 text-[12px] w-full sm:w-56"
            data-testid="input-players-search"
          />
          <Button
            variant="outline"
            onClick={exportCsv}
            className="rounded-xl h-8 text-[12px] border-blue-500/20 text-blue-400/60 hover:bg-blue-500/5 cursor-pointer flex-shrink-0"
            data-testid="button-export-players"
          >
            Export CSV
          </Button>
        </div>
      </div>

      {missingDob > 0 && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-xl bg-amber-500/[0.06] border border-amber-500/15">
          <AlertTriangle className="w-3.5 h-3.5 text-amber-400/70 flex-shrink-0 mt-0.5" />
          <p className="text-[11px] text-amber-200/60">
            {missingDob} player{missingDob === 1 ? " has" : "s have"} no date of birth on file — NZ Football registration needs one for every player.
          </p>
        </div>
      )}

      <div className="rounded-xl border border-blue-500/[0.08] overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px]" data-testid="table-players">
            <thead>
              <tr className="border-b border-blue-500/[0.06] bg-blue-500/[0.03]">
                <th className="text-left px-4 py-2 text-[10px] text-blue-300/25 uppercase tracking-wider font-semibold">Player</th>
                <th className="text-left px-4 py-2 text-[10px] text-blue-300/25 uppercase tracking-wider font-semibold">Age</th>
                <th className="text-left px-4 py-2 text-[10px] text-blue-300/25 uppercase tracking-wider font-semibold hidden md:table-cell">Parent</th>
                <th className="text-left px-4 py-2 text-[10px] text-blue-300/25 uppercase tracking-wider font-semibold hidden lg:table-cell">Contact</th>
                <th className="text-center px-4 py-2 text-[10px] text-blue-300/25 uppercase tracking-wider font-semibold hidden sm:table-cell">Sessions</th>
                <th className="text-left px-4 py-2 text-[10px] text-blue-300/25 uppercase tracking-wider font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(p => {
                const age = ageFromDob(p.dateOfBirth);
                return (
                  <tr
                    key={p.childId}
                    onClick={() => navigate(`/admin/contacts/player/${p.childId}`)}
                    className="border-b border-blue-500/[0.03] hover:bg-blue-500/[0.04] transition-colors cursor-pointer"
                    data-testid={`row-player-${p.childId}`}
                  >
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2 min-w-0">
                        <ChevronRight className="w-3.5 h-3.5 text-white/20 flex-shrink-0" />
                        <span className="text-[13px] text-white/75 font-medium truncate">{p.firstName} {p.lastName}</span>
                        {p.epiPen && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-red-500/10 border border-red-500/20 text-red-400/80 uppercase tracking-wider flex-shrink-0" title="EpiPen on file">EpiPen</span>
                        )}
                        {!p.epiPen && p.allergies && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/20 text-amber-400/70 uppercase tracking-wider flex-shrink-0" title={p.allergies}>Allergy</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      {age !== null ? (
                        <span className="text-[12px] text-white/55">{age} yrs</span>
                      ) : (
                        <span className="text-[11px] text-amber-400/50" title="No date of birth on file">No DOB</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 hidden md:table-cell">
                      <span className="text-[12px] text-white/50 truncate">
                        {p.parent ? `${p.parent.firstName} ${p.parent.lastName}`.trim() || "—" : "—"}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 hidden lg:table-cell">
                      <div className="flex flex-col">
                        {p.parent?.email && <span className="text-[11px] text-white/40 truncate max-w-[220px]">{p.parent.email}</span>}
                        {p.parent?.phone && <span className="text-[11px] text-white/25 font-mono">{p.parent.phone}</span>}
                        {!p.parent?.email && !p.parent?.phone && <span className="text-[11px] text-white/20">—</span>}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-center hidden sm:table-cell">
                      <span className="text-[12px] text-white/50">{p.sessionsBooked || "—"}</span>
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge
                        variant="outline"
                        className={`text-[9px] uppercase tracking-wider no-default-hover-elevate no-default-active-elevate ${PLAYER_STATUS_STYLES[p.status] ?? "text-white/40 border-white/10 bg-white/[0.03]"}`}
                      >
                        {p.status}
                      </Badge>
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-[12px] text-white/25">
                    No players match that filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-[11px] text-white/20 px-1">
        Showing {filtered.length} of {all.length} player{all.length === 1 ? "" : "s"}. One row per child — a child who registered more than once appears once.
      </p>
    </div>
  );
}

function SessionsTab({ campId, camp, detailPath }: { campId: number; camp?: any; detailPath: string }) {
  const [, navigate] = useLocation();

  const { data: sessions, isLoading } = useQuery<(SessionSummary & { name?: string | null; startTime?: string | null; endTime?: string | null })[]>({
    queryKey: ["/api/admin/camps", campId, "sessions-summary"],
    queryFn: async () => {
      const res = await fetch(`/api/admin/camps/${campId}/sessions-summary`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load sessions");
      return res.json();
    },
  });

  if (isLoading) {
    return <Skeleton className="h-64 w-full rounded-xl bg-blue-500/[0.04]" />;
  }

  if (!sessions || sessions.length === 0) {
    return <p className="text-[13px] text-white/25 text-center py-8">No sessions available. Add dates first.</p>;
  }

  const isTermMode = camp?.scheduleType === "term";

  // Term-mode: each row is one session (one camp_date) — no morning/afternoon
  // split. Group by week so 70 sessions across a 10-week term don't render
  // as a wall of rows.
  if (isTermMode) {
    const weeks: Record<string, typeof sessions> = {};
    sessions.forEach(s => {
      const wk = getWeekKey(s.date);
      if (!weeks[wk]) weeks[wk] = [];
      weeks[wk].push(s);
    });

    return (
      <div className="space-y-4">
        {Object.entries(weeks).map(([weekLabel, weekSessions]) => {
          const weekBooked = weekSessions.reduce((sum, s) => sum + (s.bookedCount ?? 0), 0);
          const weekCapacity = weekSessions.reduce((sum, s) => sum + (s.capacity ?? 0), 0);
          const sorted = [...weekSessions].sort((a, b) => {
            if (a.date !== b.date) return a.date.localeCompare(b.date);
            return (a.startTime ?? "").localeCompare(b.startTime ?? "");
          });

          return (
            <div key={weekLabel} className="rounded-xl border border-blue-500/[0.08] overflow-hidden">
              <div className="px-4 py-2.5 bg-blue-500/[0.04] border-b border-blue-500/[0.06] flex items-center justify-between">
                <span className="text-[11px] text-blue-300/40 uppercase tracking-wider font-semibold">{weekLabel}</span>
                <span className="text-[11px] text-white/40">{weekSessions.length} session{weekSessions.length === 1 ? "" : "s"}</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[420px]" data-testid={`table-sessions-${weekLabel}`}>
                  <thead>
                    <tr className="border-b border-blue-500/[0.06]">
                      <th className="text-left px-4 py-2 text-[10px] text-blue-300/25 uppercase tracking-wider font-semibold">Day</th>
                      <th className="text-left px-4 py-2 text-[10px] text-blue-300/25 uppercase tracking-wider font-semibold">Time</th>
                      <th className="text-left px-4 py-2 text-[10px] text-blue-300/25 uppercase tracking-wider font-semibold hidden sm:table-cell">Slot</th>
                      <th className="text-center px-4 py-2 text-[10px] text-blue-300/25 uppercase tracking-wider font-semibold">Roll</th>
                      <th className="text-left px-4 py-2 text-[10px] text-blue-300/25 uppercase tracking-wider font-semibold w-32 hidden md:table-cell">Occupancy</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map(s => {
                      const pct = s.capacity > 0 ? Math.round((s.bookedCount / s.capacity) * 100) : 0;
                      const barColor = pct >= 90 ? "bg-red-400" : pct >= 60 ? "bg-amber-400" : "bg-blue-400";
                      return (
                        <tr
                          key={`${s.campDateId}`}
                          onClick={() => navigate(`${detailPath}/session/${s.campDateId}/SESSION`)}
                          className="border-b border-blue-500/[0.03] hover:bg-blue-500/[0.04] transition-colors cursor-pointer"
                          data-testid={`row-session-${s.campDateId}`}
                        >
                          <td className="px-4 py-2.5">
                            <div className="flex items-center gap-2">
                              <ChevronRight className="w-3.5 h-3.5 text-white/20" />
                              <span className="text-[13px] text-white/70 font-medium">{getDayLabel(s.date)}</span>
                            </div>
                          </td>
                          <td className="px-4 py-2.5">
                            <span className="text-[12px] text-white/60 font-mono">
                              {(s.startTime ?? "").slice(0, 5)}–{(s.endTime ?? "").slice(0, 5)}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 hidden sm:table-cell">
                            <span className="text-[11px] text-amber-400/70 font-medium">{s.name || "—"}</span>
                          </td>
                          <td className="px-4 py-2.5 text-center">
                            <span className="text-[13px] text-white/60">
                              <span className="font-semibold text-white/80">{s.bookedCount}</span>
                              <span className="text-white/25 mx-1">/</span>
                              <span>{s.capacity}</span>
                            </span>
                          </td>
                          <td className="px-4 py-2.5 hidden md:table-cell">
                            <div className="flex items-center gap-2">
                              <div className="flex-1 h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
                                <div className={`h-full rounded-full ${barColor} transition-all duration-500`} style={{ width: `${Math.min(pct, 100)}%` }} />
                              </div>
                              <span className="text-[10px] text-white/30 w-8 text-right">{pct}%</span>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                    <tr className="bg-blue-500/[0.03]">
                      <td className="px-4 py-2 text-[11px] text-blue-300/30 font-semibold uppercase tracking-wider" colSpan={3}>Week Total</td>
                      <td className="px-4 py-2 text-center">
                        <span className="text-[12px] text-white/50 font-medium">{weekBooked} / {weekCapacity}</span>
                      </td>
                      <td className="px-4 py-2 hidden md:table-cell">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
                            <div className="h-full rounded-full bg-blue-400/60 transition-all duration-500" style={{ width: `${weekCapacity > 0 ? Math.min(Math.round((weekBooked / weekCapacity) * 100), 100) : 0}%` }} />
                          </div>
                          <span className="text-[10px] text-white/30 w-8 text-right">{weekCapacity > 0 ? Math.round((weekBooked / weekCapacity) * 100) : 0}%</span>
                        </div>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  // Holiday-camp mode (legacy) — keep MORNING/AFTERNOON pair-per-date.
  const uniqueDates = [...new Set(sessions.map(s => s.date))].sort();
  const weeks: Record<string, string[]> = {};
  uniqueDates.forEach(d => {
    const wk = getWeekKey(d);
    if (!weeks[wk]) weeks[wk] = [];
    weeks[wk].push(d);
  });

  return (
    <div className="space-y-4">
      {Object.entries(weeks).map(([weekLabel, dates]) => {
        let weekBooked = 0;
        let weekCapacity = 0;
        dates.forEach(d => {
          sessions.filter(s => s.date === d).forEach(s => {
            weekBooked += s.bookedCount;
            weekCapacity += s.capacity;
          });
        });

        return (
          <div key={weekLabel} className="rounded-xl border border-blue-500/[0.08] overflow-hidden">
            <div className="px-4 py-2.5 bg-blue-500/[0.04] border-b border-blue-500/[0.06]">
              <span className="text-[11px] text-blue-300/40 uppercase tracking-wider font-semibold">{weekLabel}</span>
            </div>
            <div className="overflow-x-auto">
            <table className="w-full min-w-[400px]" data-testid={`table-sessions-${weekLabel}`}>
              <thead>
                <tr className="border-b border-blue-500/[0.06]">
                  <th className="text-left px-4 py-2 text-[10px] text-blue-300/25 uppercase tracking-wider font-semibold">Session</th>
                  <th className="text-left px-4 py-2 text-[10px] text-blue-300/25 uppercase tracking-wider font-semibold hidden sm:table-cell">Type</th>
                  <th className="text-center px-4 py-2 text-[10px] text-blue-300/25 uppercase tracking-wider font-semibold">Booked / Limit</th>
                  <th className="text-left px-4 py-2 text-[10px] text-blue-300/25 uppercase tracking-wider font-semibold w-32 hidden md:table-cell">Occupancy</th>
                </tr>
              </thead>
              <tbody>
                {dates.map(date =>
                  ["MORNING", "AFTERNOON"].map(pt => {
                    const s = sessions.find(x => x.date === date && x.productType === pt);
                    if (!s || s.capacity === 0) return null;
                    const sessionKey = `${date}-${pt}`;
                    const pct = s.capacity > 0 ? Math.round((s.bookedCount / s.capacity) * 100) : 0;
                    const barColor = pct >= 90 ? "bg-red-400" : pct >= 60 ? "bg-amber-400" : (pt === "MORNING" ? "bg-amber-400" : "bg-orange-400");
                    return (
                      <tr
                        key={sessionKey}
                        onClick={() => navigate(`${detailPath}/session/${s.campDateId}/${pt}`)}
                        className="border-b border-blue-500/[0.03] hover:bg-blue-500/[0.04] transition-colors cursor-pointer"
                        data-testid={`row-session-${s.campDateId}-${pt}`}
                      >
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2">
                            <ChevronRight className="w-3.5 h-3.5 text-white/20" />
                            <span className="text-[13px] text-white/70 font-medium">{getDayLabel(date)}</span>
                          </div>
                        </td>
                        <td className="px-4 py-2.5 hidden sm:table-cell">
                          <span className={`text-[11px] font-medium ${pt === "MORNING" ? "text-amber-400/60" : "text-orange-400/60"}`}>
                            {pt === "MORNING" ? "Morning" : "Afternoon"}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-center">
                          <span className="text-[13px] text-white/60">
                            <span className="font-semibold text-white/80">{s.bookedCount}</span>
                            <span className="text-white/25 mx-1">/</span>
                            <span>{s.capacity}</span>
                          </span>
                        </td>
                        <td className="px-4 py-2.5 hidden md:table-cell">
                          <div className="flex items-center gap-2">
                            <div className="flex-1 h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
                              <div className={`h-full rounded-full ${barColor} transition-all duration-500`} style={{ width: `${Math.min(pct, 100)}%` }} />
                            </div>
                            <span className="text-[10px] text-white/30 w-8 text-right">{pct}%</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
                <tr className="bg-blue-500/[0.03]">
                  <td className="px-4 py-2 text-[11px] text-blue-300/30 font-semibold uppercase tracking-wider" colSpan={2}>Week Total</td>
                  <td className="px-4 py-2 text-center">
                    <span className="text-[12px] text-white/50 font-medium">{weekBooked} / {weekCapacity}</span>
                  </td>
                  <td className="px-4 py-2 hidden md:table-cell">
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
                        <div className="h-full rounded-full bg-blue-400/60 transition-all duration-500" style={{ width: `${weekCapacity > 0 ? Math.min(Math.round((weekBooked / weekCapacity) * 100), 100) : 0}%` }} />
                      </div>
                      <span className="text-[10px] text-white/30 w-8 text-right">{weekCapacity > 0 ? Math.round((weekBooked / weekCapacity) * 100) : 0}%</span>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function AdminCampDetail() {
  // Matches /admin/camps/:id, /admin/academy/:id and /admin/programs/:id —
  // `base` is the section the user came in through, so every link on this page
  // stays inside it and the sidebar keeps the right item highlighted.
  const route = useProgramRoute();
  const campId = route?.id || 0;
  const [tab, setTab] = useState("players");
  const [showEditModal, setShowEditModal] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const { currentOrg } = useWorkspace();

  const { data: camp, isLoading } = useQuery<any>({
    queryKey: ["/api/admin/camps", campId],
    queryFn: async () => {
      const res = await fetch(`/api/admin/camps/${campId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load camp");
      return res.json();
    },
  });

  // Where 'back' goes depends on the workspace AND the program type, since
  // CUFC has a separate /admin/academy list for type === "academy" and
  // /admin/camps for everything else (holiday_camp etc.). Gymnastics uses
  // a single /admin/programs list. Until the camp record loads, fall back to
  // the section in the URL so the back button is never wrong or undefined.
  const listPath = camp
    ? programBasePath(camp, currentOrg?.slug)
    : route?.base ?? "/admin/camps";
  // Sub-pages (landing-page editor, session roll) live under the same section
  // as the page you opened them from — never hard-coded to /admin/camps.
  const detailPath = `${listPath}/${campId}`;

  const updateMutation = useMutation({
    mutationFn: async (data: any) => {
      const res = await apiRequest("PATCH", `/api/admin/camps/${campId}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/camps", campId] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/camps"] });
      toast({ title: "Program updated" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/admin/camps/${campId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/camps"] });
      toast({ title: "Program deleted" });
      navigate(listPath);
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const isTermProgram = camp?.scheduleType === "term";
  const tabs = [
    { key: "players", label: "Players", icon: Users },
    { key: "sessions", label: "Sessions", icon: BarChart3 },
    { key: "content", label: "Content", icon: FileText },
    { key: "dates", label: isTermProgram ? "Schedule" : "Dates & Capacity", icon: Calendar },
    { key: "pricing", label: "Pricing", icon: DollarSign },
    { key: "discounts", label: "Discounts", icon: Percent },
    { key: "email", label: "Email Template", icon: Settings },
    { key: "performance", label: "Performance", icon: FlaskConical },
  ];

  if (isLoading) {
    return (
      <div className="p-8 max-w-5xl mx-auto space-y-6">
        <Skeleton className="h-8 w-64 bg-blue-500/[0.04]" />
        <Skeleton className="h-[400px] w-full rounded-2xl bg-blue-500/[0.04]" />
      </div>
    );
  }

  if (!camp) {
    return (
      <div className="p-8 max-w-5xl mx-auto">
        <p className="text-white/40">Program not found</p>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-8 space-y-4 sm:space-y-6 max-w-5xl mx-auto">
      <div className="flex items-start sm:items-center gap-3 animate-fade-in-up" style={{ animationDelay: '0ms', opacity: 0 }}>
        <Link href={listPath}>
          <button className="w-8 h-8 rounded-xl bg-white/[0.03] border border-white/[0.06] flex items-center justify-center hover:bg-white/[0.06] transition-colors cursor-pointer flex-shrink-0 mt-0.5 sm:mt-0" data-testid="button-back">
            <ArrowLeft className="w-4 h-4 text-white/40" />
          </button>
        </Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-lg sm:text-xl font-semibold text-white tracking-tight truncate" data-testid="text-camp-name">{camp.name}</h1>
          <p className="text-[12px] text-blue-400/35 truncate">/{camp.slug}</p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Button
            variant="outline"
            onClick={() => setShowEditModal(true)}
            className="rounded-xl h-8 text-[12px] border-blue-500/20 text-blue-400/60 hover:bg-blue-500/5 cursor-pointer"
            data-testid="button-edit-camp"
          >
            <Settings className="w-3.5 h-3.5 sm:mr-1.5" /> <span className="hidden sm:inline">Edit</span>
          </Button>
          <Button variant="outline" asChild className="rounded-xl h-8 text-[12px] border-blue-500/20 text-blue-400/60 hover:bg-blue-500/5">
            <Link href={`${detailPath}/edit-page`} data-testid="link-edit-page">
              <FileText className="w-3.5 h-3.5 sm:mr-1.5" /> <span className="hidden sm:inline">Edit Page</span>
            </Link>
          </Button>
          {camp.slug && (
            <Button variant="outline" asChild className="rounded-xl h-8 text-[12px] border-blue-500/20 text-blue-400/60 hover:bg-blue-500/5">
              <a href={`/${camp.slug}`} target="_blank" rel="noopener noreferrer" data-testid="link-view-page">
                <ChevronRight className="w-3.5 h-3.5 sm:mr-1.5" /> <span className="hidden sm:inline">View Page</span>
              </a>
            </Button>
          )}
          <Button
            variant="outline"
            onClick={() => setShowDeleteConfirm(true)}
            className="rounded-xl h-8 text-[12px] border-red-500/30 text-red-400/80 hover:bg-red-500/10 hover:text-red-400 cursor-pointer"
            data-testid="button-delete-camp"
          >
            <Trash2 className="w-3.5 h-3.5 sm:mr-1.5" /> <span className="hidden sm:inline">Delete Program</span>
          </Button>
        </div>
      </div>

      <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0 animate-fade-in-up scrollbar-hide" style={{ animationDelay: '50ms', opacity: 0 }}>
        <div className="flex gap-1 p-1 rounded-xl bg-white/[0.02] border border-white/[0.04] w-max sm:w-auto">
          {tabs.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-medium transition-all cursor-pointer whitespace-nowrap ${
                tab === t.key
                  ? "bg-blue-500/15 text-blue-400 border border-blue-500/25"
                  : "text-white/35 hover:text-white/55 border border-transparent"
              }`}
              data-testid={`tab-${t.key}`}
            >
              <t.icon className="w-3.5 h-3.5" />
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="animate-fade-in-up" style={{ animationDelay: '75ms', opacity: 0 }}>
        <StatsHeader campId={campId} />
      </div>

      <div className="rounded-2xl glass-card p-3 sm:p-5 animate-fade-in-up" style={{ animationDelay: '100ms', opacity: 0 }}>
        {tab === "players" && <PlayersTab campId={campId} camp={camp} />}
        {tab === "sessions" && <SessionsTab campId={campId} camp={camp} detailPath={detailPath} />}
        {tab === "content" && <ContentTab camp={camp} onUpdate={(data) => updateMutation.mutate(data)} />}
        {tab === "dates" && (camp.scheduleType === "term" ? <ClassDatesTab campId={campId} camp={camp} /> : <DatesTab campId={campId} />)}
        {tab === "pricing" && (camp.scheduleType === "term" ? <ClassPricingTab campId={campId} camp={camp} /> : <PricingTab campId={campId} />)}
        {tab === "discounts" && <DiscountsTab campId={campId} />}
        {tab === "email" && <EmailTab campId={campId} />}
        {tab === "performance" && <PerformanceTab campId={campId} />}
      </div>

      {showEditModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setShowEditModal(false)} />
          <div
            className="relative w-full max-w-2xl mx-4 max-h-[85vh] rounded-2xl border border-blue-500/[0.15] overflow-hidden flex flex-col animate-fade-in-up"
            style={{ background: "linear-gradient(135deg, rgba(3,86,197,0.06) 0%, #02060E 100%)", animationDelay: "0ms", opacity: 0 }}
            data-testid="modal-edit-camp"
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-blue-500/[0.08] flex-shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-blue-500/15 border border-blue-500/20 flex items-center justify-center">
                  <Settings className="w-4 h-4 text-blue-400/70" />
                </div>
                <div>
                  <h3 className="text-[14px] font-semibold text-white/80">Edit Program</h3>
                  <p className="text-[11px] text-blue-400/35">Update camp settings</p>
                </div>
              </div>
              <button
                onClick={() => setShowEditModal(false)}
                className="w-7 h-7 rounded-lg bg-white/[0.04] border border-white/[0.06] flex items-center justify-center hover:bg-white/[0.08] transition-colors cursor-pointer"
                data-testid="button-close-edit"
              >
                <X className="w-3.5 h-3.5 text-white/40" />
              </button>
            </div>
            <div className="overflow-y-auto flex-1 p-6">
              <OverviewTab camp={camp} onUpdate={(data) => { updateMutation.mutate(data, { onSuccess: () => setShowEditModal(false) }); }} />
            </div>
          </div>
        </div>
      )}

      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setShowDeleteConfirm(false)} />
          <div
            className="relative w-full max-w-md mx-4 rounded-2xl border border-red-500/[0.2] p-6 animate-fade-in-up"
            style={{ background: "linear-gradient(135deg, rgba(197,3,3,0.06) 0%, #02060E 100%)", animationDelay: "0ms", opacity: 0 }}
            data-testid="modal-delete-camp"
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-red-500/15 border border-red-500/20 flex items-center justify-center">
                <AlertTriangle className="w-5 h-5 text-red-400" />
              </div>
              <div>
                <h3 className="text-[15px] font-semibold text-white/90">Delete Program</h3>
                <p className="text-[12px] text-white/40">This action cannot be undone</p>
              </div>
            </div>
            <p className="text-[13px] text-white/60 mb-6">
              Are you sure you want to delete <span className="font-semibold text-white/80">{camp.name}</span>? All associated dates, pricing, registrations, and settings will be permanently removed.
            </p>
            <div className="flex items-center justify-end gap-3">
              <Button
                variant="outline"
                onClick={() => setShowDeleteConfirm(false)}
                className="rounded-xl h-9 text-[12px] border-white/10 text-white/50 hover:bg-white/5 cursor-pointer"
                data-testid="button-cancel-delete"
              >
                Cancel
              </Button>
              <Button
                onClick={() => deleteMutation.mutate()}
                disabled={deleteMutation.isPending}
                className="rounded-xl h-9 text-[12px] bg-red-600 hover:bg-red-500 text-white border-0 cursor-pointer"
                data-testid="button-confirm-delete"
              >
                {deleteMutation.isPending ? "Deleting..." : "Yes, Delete Program"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
