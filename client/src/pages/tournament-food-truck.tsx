// Food Truck tab — CIC workspace. Per-day staff roster for the food truck
// across the tournament window. One card per day; under each day the five
// positions, where you assign people (name + optional AM/PM time). Add/remove
// inline. Internal-only — session + "food-truck" tab permission.
import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Truck, Plus, X, CalendarDays, Users, ClipboardList } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// CIC 2026 tournament window.
const START = "2026-07-05";
const END = "2026-07-16";

const POSITIONS = [
  { key: "lead", label: "Lead / Supervisor" },
  { key: "grill", label: "Grill & Fryer" },
  { key: "barista", label: "Barista (Coffee)" },
  { key: "till", label: "Till & Service" },
  { key: "float", label: "Float / Runner" },
] as const;

interface Shift {
  id: number;
  shiftDate: string; // YYYY-MM-DD
  position: string;
  staffName: string;
  timeLabel: string | null;
  notes: string | null;
}

// Build the inclusive day list from local date components (no UTC shift).
function dayList(start: string, end: string): string[] {
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = end.split("-").map(Number);
  const cur = new Date(sy, sm - 1, sd);
  const last = new Date(ey, em - 1, ed);
  const out: string[] = [];
  while (cur <= last) {
    out.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}-${String(cur.getDate()).padStart(2, "0")}`);
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

function fmtDay(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const dow = dt.getDay();
  return {
    weekday: dt.toLocaleDateString("en-NZ", { weekday: "short" }),
    date: dt.toLocaleDateString("en-NZ", { day: "numeric", month: "short" }),
    weekend: dow === 0 || dow === 6,
  };
}

function PersonChip({ shift, onDelete }: { shift: Shift; onDelete: (id: number) => void }) {
  return (
    <span className="inline-flex items-center gap-1.5 pl-2.5 pr-1 py-1 rounded-lg bg-white/[0.06] border border-white/5 text-sm text-white/85">
      <span className="truncate max-w-[140px]">{shift.staffName}</span>
      {shift.timeLabel && (
        <span className="text-[10px] uppercase tracking-wide text-amber-400/90 font-bold">{shift.timeLabel}</span>
      )}
      <button
        onClick={() => onDelete(shift.id)}
        className="text-white/25 hover:text-red-400 transition-colors"
        title="Remove"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </span>
  );
}

function AddSlot({ date, position }: { date: string; position: string }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [time, setTime] = useState("");

  const createMut = useMutation({
    mutationFn: (data: any) => apiRequest("POST", "/api/admin/food-truck/shifts", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/food-truck/shifts"] });
      setName("");
      setTime("");
      setOpen(false);
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const save = () => {
    if (!name.trim()) return;
    createMut.mutate({ shiftDate: date, position, staffName: name.trim(), timeLabel: time.trim() || null });
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-dashed border-white/15 text-xs text-white/40 hover:text-blue-300 hover:border-blue-400/40 transition-colors"
      >
        <Plus className="w-3.5 h-3.5" /> Add
      </button>
    );
  }

  return (
    <div className="inline-flex items-center gap-1.5">
      <Input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") setOpen(false);
        }}
        placeholder="Name"
        className="h-8 w-32 text-sm"
      />
      <Input
        value={time}
        onChange={(e) => setTime(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") setOpen(false);
        }}
        placeholder="AM/PM"
        className="h-8 w-20 text-sm"
      />
      <Button size="sm" className="h-8" disabled={!name.trim() || createMut.isPending} onClick={save}>
        Add
      </Button>
      <button onClick={() => setOpen(false)} className="text-white/30 hover:text-white/60">
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

export default function TournamentFoodTruck() {
  const { toast } = useToast();
  const days = useMemo(() => dayList(START, END), []);

  const { data: shifts = [], isLoading } = useQuery<Shift[]>({
    queryKey: ["/api/admin/food-truck/shifts"],
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/admin/food-truck/shifts/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/admin/food-truck/shifts"] }),
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  // Group: `${date}|${position}` -> shifts
  const byCell = useMemo(() => {
    const m = new Map<string, Shift[]>();
    for (const s of shifts) {
      const k = `${s.shiftDate}|${s.position}`;
      (m.get(k) ?? m.set(k, []).get(k)!).push(s);
    }
    return m;
  }, [shifts]);

  const stats = useMemo(() => {
    const daysCovered = new Set(shifts.map((s) => s.shiftDate)).size;
    const people = new Set(shifts.map((s) => s.staffName.trim().toLowerCase())).size;
    return { daysCovered, shiftsFilled: shifts.length, people };
  }, [shifts]);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2.5">
            <Truck className="w-6 h-6 text-amber-400" />
            Food Truck
          </h1>
          <p className="text-sm text-white/40 mt-1">
            Staff roster for the CIC food truck · 5–16 July. Add who's on each position, each day.
          </p>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: "Days covered", value: `${stats.daysCovered}/${days.length}`, icon: CalendarDays },
          { label: "Shifts filled", value: stats.shiftsFilled, icon: ClipboardList },
          { label: "People on roster", value: stats.people, icon: Users },
        ].map((s) => (
          <div key={s.label} className="bg-white/[0.03] border border-white/5 rounded-2xl p-4">
            <div className="flex items-center gap-2 text-white/40 text-xs mb-1.5">
              <s.icon className="w-3.5 h-3.5" /> {s.label}
            </div>
            <div className="text-2xl font-bold text-white">{s.value}</div>
          </div>
        ))}
      </div>

      {/* Day cards */}
      {isLoading ? (
        <div className="text-center text-white/30 py-16">Loading roster…</div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {days.map((iso) => {
            const f = fmtDay(iso);
            const dayCount = POSITIONS.reduce((n, p) => n + (byCell.get(`${iso}|${p.key}`)?.length ?? 0), 0);
            return (
              <div key={iso} className="bg-white/[0.03] border border-white/5 rounded-2xl overflow-hidden">
                <div className={`flex items-center justify-between px-4 py-3 border-b border-white/5 ${f.weekend ? "bg-amber-400/[0.04]" : ""}`}>
                  <div className="font-semibold text-white">
                    {f.weekday} <span className="text-white/45 font-normal">{f.date}</span>
                  </div>
                  <div className="text-xs text-white/30">{dayCount} on shift</div>
                </div>
                <div className="divide-y divide-white/5">
                  {POSITIONS.map((pos) => {
                    const cell = byCell.get(`${iso}|${pos.key}`) ?? [];
                    return (
                      <div key={pos.key} className="px-4 py-2.5 flex items-start gap-3">
                        <div className="w-28 shrink-0 text-xs text-white/45 pt-1.5">{pos.label}</div>
                        <div className="flex-1 flex flex-wrap gap-1.5 items-center">
                          {cell.map((s) => (
                            <PersonChip key={s.id} shift={s} onDelete={(id) => deleteMut.mutate(id)} />
                          ))}
                          <AddSlot date={iso} position={pos.key} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
