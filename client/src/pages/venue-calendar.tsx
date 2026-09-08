import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useWorkspace } from "@/lib/workspace-context";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Calendar as CalIcon, ChevronLeft, ChevronRight, Pencil, Plus, X, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DatePickerInput } from "@/components/ui/date-picker-input";
import { TimePickerInput } from "@/components/ui/time-picker-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { FacilityBooking, Facility } from "@shared/schema";
import { QUARTER_POSITIONS, cellsOverlap, type FieldSize } from "@shared/field-cells";

type BookingWithFacility = FacilityBooking & { facility?: Facility };

const HOURS = Array.from({ length: 16 }, (_, i) => i + 6);
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const statusColors: Record<string, string> = {
  confirmed: "bg-green-500/20 border-green-500/30 text-green-400",
  paid: "bg-blue-500/20 border-blue-500/30 text-blue-400",
  pending: "bg-yellow-500/20 border-yellow-500/30 text-yellow-400",
  cancelled: "bg-red-500/20 border-red-500/30 text-red-400",
};

// Color swatches for booking color tagging — picked to be visually distinct against dark UI.
const COLOR_SWATCHES = [
  { label: "Blue",   hex: "#3b82f6" },
  { label: "Green",  hex: "#10b981" },
  { label: "Amber",  hex: "#f59e0b" },
  { label: "Red",    hex: "#ef4444" },
  { label: "Purple", hex: "#8b5cf6" },
  { label: "Pink",   hex: "#ec4899" },
  { label: "Teal",   hex: "#14b8a6" },
  { label: "Slate",  hex: "#64748b" },
];

const WEEKDAY_BUTTONS = [
  { n: 1, label: "M" }, { n: 2, label: "T" }, { n: 3, label: "W" },
  { n: 4, label: "T" }, { n: 5, label: "F" }, { n: 6, label: "S" }, { n: 0, label: "S" },
];

type RepeatFreq = "none" | "daily" | "weekly" | "weekdays" | "custom";

// In-modal edit form for an existing booking. Deliberately edits ONE row —
// a series/multi-facility group is a set of independent rows, and editing
// just the clicked one is the honest, predictable behaviour.
type EditFormState = {
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  facilityId: string;
  bookingDate: string;
  startTime: string;
  endTime: string;
  totalAmount: string;
  color: string;
  notes: string;
  status: string;
} & SizeState;

const emptyForm = {
  customerName: "",
  customerEmail: "",
  facilityId: "",
  additionalFacilityIds: [] as string[],
  bookingDate: "",
  startTime: "",
  endTime: "",
  totalAmount: "0",
  color: "" as string,
  repeatFreq: "none" as RepeatFreq,
  repeatByDay: [] as number[],
  repeatUntil: "",
  fieldSize: "full" as FieldSize,
  halfPosition: "front" as "front" | "back",
  quarterPos: "q1" as QuarterPos,
};

// Field size for a manual booking — the same full / half / quarter vocabulary
// the public site sells, offered only where the facility is actually split
// (facilities.half_full / quarter_field). Conflicts are decided by the shared
// cell model in shared/field-cells.ts, so a half entered here and a half sold
// online can never disagree about whether they collide.
type QuarterPos = "q1" | "q2" | "q3" | "q4";
type SizeState = { fieldSize: FieldSize; halfPosition: "front" | "back"; quarterPos: QuarterPos };

function sizeFromBooking(b: { halfFull: string | null; halfPosition: string | null }): SizeState {
  const fieldSize: FieldSize = b.halfFull === "half" || b.halfFull === "quarter" ? b.halfFull : "full";
  const quarterPos: QuarterPos = (["q1", "q2", "q3", "q4"] as const).includes(b.halfPosition as QuarterPos) ? (b.halfPosition as QuarterPos) : "q1";
  return { fieldSize, halfPosition: b.halfPosition === "back" ? "back" : "front", quarterPos };
}

// What the server stores. Full is NULL, matching every manual row before the
// picker existed; the cell model treats "full" and null identically.
function sizePayload(s: SizeState): { halfFull: FieldSize | null; halfPosition: string | null } {
  if (s.fieldSize === "half") return { halfFull: "half", halfPosition: s.halfPosition };
  if (s.fieldSize === "quarter") return { halfFull: "quarter", halfPosition: s.quarterPos };
  return { halfFull: null, halfPosition: null };
}

function FieldSizePicker({ facility, value, onChange, extrasNote, testPrefix }: {
  facility: Facility | undefined;
  value: SizeState;
  onChange: (patch: Partial<SizeState>) => void;
  extrasNote?: boolean;
  testPrefix: string;
}) {
  if (!facility || (!facility.halfFull && !facility.quarterField)) return null;
  const options = (["full", "half", "quarter"] as FieldSize[]).filter(o =>
    o === "full" || (o === "half" && facility.halfFull) || (o === "quarter" && facility.quarterField));
  const btn = (active: boolean) =>
    `flex-1 px-3 py-2 rounded-lg text-sm border transition-colors capitalize ${active ? "bg-blue-600 border-blue-500 text-white" : "bg-white/5 border-white/10 text-white/60 hover:bg-white/10"}`;
  return (
    <div className="mt-3" data-testid={`${testPrefix}-field-size`}>
      <label className="text-xs text-white/40 mb-1 block">Field size</label>
      <div className="flex gap-2">
        {options.map(o => (
          <button key={o} type="button" onClick={() => onChange({ fieldSize: o })} className={btn(value.fieldSize === o)} data-testid={`button-${testPrefix}-size-${o}`}>
            {o === "full" ? "Full pitch" : o === "half" ? "½ Half" : "¼ Quarter"}
          </button>
        ))}
      </div>
      {value.fieldSize === "half" && (
        <div className="mt-2">
          <label className="text-xs text-white/40 mb-1 block">Which half?</label>
          <div className="flex gap-2">
            {(["front", "back"] as const).map(p => (
              <button key={p} type="button" onClick={() => onChange({ halfPosition: p })} className={btn(value.halfPosition === p)} data-testid={`button-${testPrefix}-half-${p}`}>
                {p} half
              </button>
            ))}
          </div>
          <p className="text-[10px] text-white/40 mt-1">The other half stays free to book.</p>
        </div>
      )}
      {value.fieldSize === "quarter" && (
        <div className="mt-2">
          <label className="text-xs text-white/40 mb-1 block">Which quarter?</label>
          <div className="grid grid-cols-2 gap-2">
            {QUARTER_POSITIONS.map(q => (
              <button key={q.value} type="button" onClick={() => onChange({ quarterPos: q.value })} className={btn(value.quarterPos === q.value)} data-testid={`button-${testPrefix}-quarter-${q.value}`}>
                {q.label}
              </button>
            ))}
          </div>
          <p className="text-[10px] text-white/40 mt-1">Q1–Q2 are the front half, Q3–Q4 the back half. The rest stays free to book.</p>
        </div>
      )}
      {extrasNote && value.fieldSize !== "full" && (
        <p className="text-[10px] text-amber-300/80 mt-1">Size applies to {facility.name} only — any added facility is booked whole.</p>
      )}
    </div>
  );
}

// Existing bookings a manual entry would sit on top of — same pitch, same day,
// overlapping time, and the shared cell model says the areas collide. A
// heads-up, deliberately not a block: staff enter bookings over internal
// blocks on purpose (the CIC widening left team bookings under it).
function manualOverlaps(
  bookings: BookingWithFacility[],
  form: { facilityId: string; bookingDate: string; startTime: string; endTime: string; repeatFreq: RepeatFreq } & SizeState,
): BookingWithFacility[] {
  if (!form.facilityId || !form.bookingDate || !form.startTime || !form.endTime || form.repeatFreq !== "none") return [];
  const fid = parseInt(form.facilityId);
  const mine = sizePayload(form);
  return bookings.filter(b =>
    b.facilityId === fid &&
    b.bookingDate === form.bookingDate &&
    b.status !== "cancelled" &&
    b.startTime < form.endTime && b.endTime > form.startTime &&
    cellsOverlap(b.halfFull, b.halfPosition, mine.halfFull, mine.halfPosition),
  );
}

// "· front half" / "· quarter Q3" suffix for a booking's field size. Empty for
// full-field or non-divisible facilities.
function sizeLabel(b: { halfFull: string | null; halfPosition: string | null }): string {
  if (b.halfFull === "half") return b.halfPosition ? ` · ${b.halfPosition} half` : " · half";
  if (b.halfFull === "quarter") return b.halfPosition ? ` · quarter ${b.halfPosition.toUpperCase()}` : " · quarter";
  return "";
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2 border-b border-white/5 last:border-0">
      <span className="text-xs text-white/40 flex-shrink-0 pt-0.5">{label}</span>
      <span className="text-xs text-white text-right min-w-0">{children}</span>
    </div>
  );
}

function getWeekDates(date: Date): Date[] {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(d.setDate(diff));
  return Array.from({ length: 7 }, (_, i) => {
    const dd = new Date(monday);
    dd.setDate(monday.getDate() + i);
    return dd;
  });
}

function formatDateRange(dates: Date[]) {
  const start = dates[0];
  const end = dates[6];
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
  return `${start.toLocaleDateString("en-NZ", opts)} - ${end.toLocaleDateString("en-NZ", opts)} ${end.getFullYear()}`;
}

function ymd(d: Date): string {
  // Local-time YYYY-MM-DD (avoid UTC shift that toISOString causes around midnight).
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function getMonthGrid(date: Date): Date[] {
  // 6×7 grid starting on the Monday of the week containing the 1st of the month.
  const first = new Date(date.getFullYear(), date.getMonth(), 1);
  const day = first.getDay();
  const offset = day === 0 ? -6 : 1 - day;
  const start = new Date(first);
  start.setDate(first.getDate() + offset);
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

function getMonthDays(year: number, month: number): Date[] {
  const days: Date[] = [];
  const d = new Date(year, month, 1);
  while (d.getMonth() === month) {
    days.push(new Date(d));
    d.setDate(d.getDate() + 1);
  }
  return days;
}

export default function VenueCalendar() {
  const { currentOrg } = useWorkspace();
  const orgId = currentOrg?.id;
  const { toast } = useToast();
  const [currentDate, setCurrentDate] = useState(new Date());
  const [view, setView] = useState<"Day" | "Week" | "Month" | "Year" | "List" | "Planner">("Week");
  // Facility filter — "all" shows everything, otherwise the string is a
  // facility id. Applies across every view (Day, Week, Month, Year, List,
  // Planner) by narrowing `activeBookings` below before any other slicing.
  const [facilityFilter, setFacilityFilter] = useState<string>("all");
  const [showNewBooking, setShowNewBooking] = useState(false);
  const [newBooking, setNewBooking] = useState({ ...emptyForm });
  // Booking the user clicked — opens the details modal.
  const [selectedBooking, setSelectedBooking] = useState<BookingWithFacility | null>(null);
  // Delete confirmation step inside the details modal. Holds the scope the
  // admin picked; notifyCancel drives the "email the customer" checkbox.
  const [deleteIntent, setDeleteIntent] = useState<null | { scope?: "series" }>(null);
  const [notifyCancel, setNotifyCancel] = useState(true);
  // When set, the details modal swaps to an edit form pre-filled from the booking.
  const [editForm, setEditForm] = useState<EditFormState | null>(null);
  useEffect(() => {
    setDeleteIntent(null);
    setNotifyCancel(true);
    setEditForm(null);
  }, [selectedBooking?.id]);

  const weekDates = getWeekDates(currentDate);

  const { data: bookings = [] } = useQuery<BookingWithFacility[]>({
    queryKey: ["/api/admin/venue/bookings", { orgId }],
    queryFn: () => fetch(`/api/admin/venue/bookings?orgId=${orgId}`).then(r => r.json()),
    enabled: !!orgId,
  });

  const { data: facs = [] } = useQuery<Facility[]>({
    queryKey: ["/api/admin/venue/facilities", { orgId }],
    queryFn: () => fetch(`/api/admin/venue/facilities?orgId=${orgId}`).then(r => r.json()),
    enabled: !!orgId,
  });

  const createMutation = useMutation({
    mutationFn: async (data: any) => {
      const r = await apiRequest("POST", "/api/admin/venue/bookings", data);
      return await r.json();
    },
    onSuccess: (result: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/venue/bookings"] });
      setShowNewBooking(false);
      setNewBooking({ ...emptyForm });
      const count = result?.count;
      toast({
        title: count && count > 1 ? `${count} bookings created` : "Booking created",
        description: count && count > 1 ? "All occurrences are linked and can be cancelled together." : undefined,
      });
    },
    onError: (e: any) => {
      toast({ title: "Couldn't create booking", description: e?.message || String(e), variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async ({ id, scope, notify }: { id: number; scope?: "series"; notify?: boolean }) => {
      const params = new URLSearchParams();
      if (scope === "series") params.set("scope", "series");
      if (notify) params.set("notify", "true");
      const qs = params.toString();
      const r = await apiRequest("DELETE", `/api/admin/venue/bookings/${id}${qs ? `?${qs}` : ""}`);
      return await r.json();
    },
    onSuccess: (result: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/venue/bookings"] });
      setSelectedBooking(null);
      toast({
        title: result?.deleted > 1 ? `${result.deleted} bookings removed` : "Booking removed",
        description: result?.notified
          ? "The customer has been emailed a cancellation notice."
          : "The time slot is available again.",
      });
    },
    onError: (e: any) => toast({ title: "Couldn't delete booking", description: e?.message || String(e), variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, patch }: { id: number; patch: any }) => {
      const r = await apiRequest("PATCH", `/api/admin/venue/bookings/${id}`, patch);
      return await r.json();
    },
    onSuccess: (updated: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/venue/bookings"] });
      // Keep the open modal showing the fresh values. The server row has no
      // joined facility, so re-attach it from the facilities list.
      setSelectedBooking(prev => prev
        ? { ...prev, ...updated, facility: facs.find(f => f.id === updated.facilityId) || prev.facility }
        : prev);
      setEditForm(null);
      toast({ title: "Booking updated" });
    },
    onError: (e: any) => toast({ title: "Couldn't update booking", description: e?.message || String(e), variant: "destructive" }),
  });

  const startEdit = (b: BookingWithFacility) => {
    setDeleteIntent(null);
    setEditForm({
      customerName: b.customerName || "",
      customerEmail: b.customerEmail || "",
      customerPhone: b.customerPhone || "",
      facilityId: String(b.facilityId),
      bookingDate: b.bookingDate,
      startTime: b.startTime,
      endTime: b.endTime,
      totalAmount: b.totalAmount != null ? String(Number(b.totalAmount)) : "0",
      color: b.color || "",
      notes: b.notes || "",
      status: b.status,
      ...sizeFromBooking(b),
    });
  };

  // Deep link: ?booking=<id> opens that booking's details on load; add &edit=1
  // to jump straight into the edit form. One-shot — after the first resolution
  // the calendar behaves normally.
  const deepLinkDone = useRef(false);
  const pendingDeepEdit = useRef(false);
  useEffect(() => {
    if (deepLinkDone.current || bookings.length === 0) return;
    deepLinkDone.current = true;
    const params = new URLSearchParams(window.location.search);
    const idStr = params.get("booking");
    if (!idStr) return;
    const target = bookings.find(x => x.id === parseInt(idStr));
    if (!target) return;
    pendingDeepEdit.current = params.get("edit") === "1";
    setCurrentDate(new Date(target.bookingDate + "T00:00:00"));
    setSelectedBooking(target);
  }, [bookings]);
  // Declared AFTER the reset-on-selection effect so it runs after it in the
  // same commit — otherwise the reset would wipe the deep-linked edit form.
  useEffect(() => {
    if (pendingDeepEdit.current && selectedBooking) {
      pendingDeepEdit.current = false;
      startEdit(selectedBooking);
    }
  }, [selectedBooking?.id]);

  const weekDateStrs = weekDates.map(d => ymd(d));
  const facilityFilterId = facilityFilter === "all" ? null : Number(facilityFilter);
  const activeBookings = bookings.filter(b =>
    b.status !== "cancelled" &&
    (facilityFilterId === null || b.facilityId === facilityFilterId)
  );
  const weekBookings = activeBookings.filter(b => weekDateStrs.includes(b.bookingDate));

  const getBookingsForSlot = (dayIdx: number, hour: number) => {
    const dateStr = weekDateStrs[dayIdx];
    return weekBookings.filter(b => {
      if (b.bookingDate !== dateStr) return false;
      const startH = parseInt(b.startTime.split(":")[0]);
      return startH === hour;
    });
  };

  // Navigation step depends on the active view so that prev/next "feels right".
  // For Month/Year, build the target date from year+month explicitly (with day=1) to
  // avoid JS Date.setMonth overflow when the current day-of-month doesn't exist in
  // the target month (e.g. Jan 31 + 1 month would otherwise jump to Mar 3).
  const stepDate = (delta: number): Date => {
    const d = new Date(currentDate);
    if (view === "Day" || view === "Planner") {
      d.setDate(d.getDate() + delta);
      return d;
    }
    if (view === "Month") return new Date(d.getFullYear(), d.getMonth() + delta, 1);
    if (view === "Year") return new Date(d.getFullYear() + delta, 0, 1);
    d.setDate(d.getDate() + delta * 7); // Week, List
    return d;
  };

  const prev = () => setCurrentDate(stepDate(-1));
  const next = () => setCurrentDate(stepDate(1));

  const today = new Date();
  const todayStr = ymd(today);
  const todayIdx = weekDates.findIndex(d => ymd(d) === todayStr);

  // Title shown above the grid — adapts per view.
  const headerTitle = (() => {
    if (view === "Day" || view === "Planner") {
      return currentDate.toLocaleDateString("en-NZ", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    }
    if (view === "Month") {
      return currentDate.toLocaleDateString("en-NZ", { month: "long", year: "numeric" });
    }
    if (view === "Year") return String(currentDate.getFullYear());
    if (view === "List") return "Upcoming bookings";
    return formatDateRange(weekDates);
  })();

  return (
    <div className="p-4 sm:p-6 space-y-4">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-3">
            <CalIcon className="w-6 h-6 text-white/40" />
            <h1 className="text-2xl font-bold text-white" data-testid="text-venue-calendar-title">Bookings Calendar</h1>
          </div>
          <p className="text-sm text-white/40 mt-1">View and manage all bookings</p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => setShowNewBooking(true)} className="bg-white/10 hover:bg-white/15 text-white border border-white/10" data-testid="button-new-booking">
            <Plus className="w-4 h-4 mr-1" /> New Booking
          </Button>
          <div className="flex rounded-lg border border-white/10 overflow-hidden">
            {(["Day", "Week", "Month", "Year", "List", "Planner"] as const).map(v => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${view === v ? "bg-white/15 text-white" : "text-white/30 hover:text-white/50"}`}
                data-testid={`button-view-${v.toLowerCase()}`}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <button onClick={prev} className="w-8 h-8 rounded-lg border border-white/10 flex items-center justify-center text-white/40 hover:text-white/60 hover:bg-white/5" data-testid="button-prev-week">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button onClick={next} className="w-8 h-8 rounded-lg border border-white/10 flex items-center justify-center text-white/40 hover:text-white/60 hover:bg-white/5" data-testid="button-next-week">
            <ChevronRight className="w-4 h-4" />
          </button>
          <button onClick={() => setCurrentDate(new Date())} className="px-3 py-1.5 rounded-lg border border-white/10 text-xs text-white/50 hover:text-white/70 hover:bg-white/5" data-testid="button-today">
            Today
          </button>
          {facs.length > 0 && (
            <Select value={facilityFilter} onValueChange={setFacilityFilter}>
              <SelectTrigger className="h-8 w-[180px] bg-white/5 border-white/10 text-white/70 text-xs" data-testid="select-facility-filter">
                <SelectValue placeholder="All facilities" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All facilities</SelectItem>
                {facs
                  .slice()
                  .sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0) || a.name.localeCompare(b.name))
                  .map(f => (
                    <SelectItem key={f.id} value={String(f.id)} data-testid={`select-facility-${f.id}`}>
                      {f.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          )}
        </div>
        <h2 className="text-lg font-semibold text-white" data-testid="text-date-range">{headerTitle}</h2>
        <div className="flex items-center gap-4 text-[10px]">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-500" /> Confirmed</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-500" /> Paid</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-yellow-500" /> Pending</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500" /> Cancelled</span>
        </div>
      </div>

      {view === "Week" && (
        <div className="rounded-2xl border border-blue-500/10 bg-white/[0.02] overflow-hidden" data-testid="calendar-week">
          <div className="grid grid-cols-[60px_repeat(7,1fr)]">
            <div className="border-b border-r border-white/5 h-10" />
            {DAYS.map((day, i) => (
              <div key={day} className={`border-b border-r border-white/5 h-10 flex items-center justify-center ${todayIdx === i ? "bg-blue-500/10" : ""}`}>
                <span className="text-xs font-medium text-white/50">{day}</span>
                <span className={`text-xs font-semibold ml-2 ${todayIdx === i ? "text-blue-400" : "text-white/30"}`}>{weekDates[i].getDate()}</span>
              </div>
            ))}
          </div>
          <div className="max-h-[600px] overflow-y-auto">
            {HOURS.map(hour => (
              <div key={hour} className="grid grid-cols-[60px_repeat(7,1fr)] min-h-[50px]">
                <div className="border-r border-b border-white/5 flex items-start justify-end pr-2 pt-1">
                  <span className="text-[10px] text-white/20">{String(hour).padStart(2, "0")}:00</span>
                </div>
                {Array.from({ length: 7 }, (_, dayIdx) => {
                  const slotBookings = getBookingsForSlot(dayIdx, hour);
                  return (
                    <div key={dayIdx} className={`border-r border-b border-white/5 p-0.5 min-w-0 overflow-hidden ${todayIdx === dayIdx ? "bg-blue-500/[0.03]" : ""}`}>
                      {slotBookings.map(b => {
                        // If the booking has a custom color, render with that; otherwise fall
                        // back to the status-based color scheme for backwards compatibility.
                        const inline = b.color
                          ? { backgroundColor: `${b.color}33`, borderColor: `${b.color}55`, color: b.color }
                          : undefined;
                        const extra = (b.additionalFacilityIds?.length || 0) > 0 ? ` +${b.additionalFacilityIds!.length}` : "";
                        return (
                          <div
                            key={b.id}
                            style={inline}
                            onClick={() => setSelectedBooking(b)}
                            role="button"
                            title={`${b.customerName || b.facility?.name || "Booking"} · ${b.startTime}–${b.endTime}`}
                            className={`rounded px-1.5 py-0.5 text-[10px] font-medium border cursor-pointer hover:brightness-125 transition min-w-0 overflow-hidden ${b.color ? "" : statusColors[b.status]}`}
                            data-testid={`calendar-booking-${b.id}`}
                          >
                            <div className="truncate">{b.customerName || b.facility?.name || "Booking"}</div>
                            <div className="truncate opacity-70 font-normal">
                              {(b.facility?.name || "Facility") + extra}{sizeLabel(b)} · {b.startTime}–{b.endTime}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}

      {view === "Day" && (() => {
        const dayStr = ymd(currentDate);
        const isToday = dayStr === todayStr;
        const dayBookings = activeBookings
          .filter(b => b.bookingDate === dayStr)
          .sort((a, b) => a.startTime.localeCompare(b.startTime));
        return (
          <div className="rounded-2xl border border-blue-500/10 bg-white/[0.02] overflow-hidden" data-testid="calendar-day">
            <div className="grid grid-cols-[60px_1fr]">
              <div className="border-b border-r border-white/5 h-10" />
              <div className={`border-b border-r border-white/5 h-10 flex items-center justify-center ${isToday ? "bg-blue-500/10" : ""}`}>
                <span className="text-xs font-medium text-white/50">{currentDate.toLocaleDateString("en-NZ", { weekday: "long" })}</span>
                <span className={`text-xs font-semibold ml-2 ${isToday ? "text-blue-400" : "text-white/30"}`}>{currentDate.getDate()}</span>
              </div>
            </div>
            <div className="max-h-[600px] overflow-y-auto">
              {HOURS.map(hour => {
                const hourBookings = dayBookings.filter(b => parseInt(b.startTime.split(":")[0]) === hour);
                return (
                  <div key={hour} className="grid grid-cols-[60px_1fr] min-h-[50px]">
                    <div className="border-r border-b border-white/5 flex items-start justify-end pr-2 pt-1">
                      <span className="text-[10px] text-white/20">{String(hour).padStart(2, "0")}:00</span>
                    </div>
                    <div className={`border-r border-b border-white/5 p-1 min-w-0 overflow-hidden ${isToday ? "bg-blue-500/[0.03]" : ""}`}>
                      {hourBookings.map(b => {
                        const inline = b.color
                          ? { backgroundColor: `${b.color}33`, borderColor: `${b.color}55`, color: b.color }
                          : undefined;
                        const extra = (b.additionalFacilityIds?.length || 0) > 0 ? ` +${b.additionalFacilityIds!.length}` : "";
                        return (
                          <div
                            key={b.id}
                            style={inline}
                            onClick={() => setSelectedBooking(b)}
                            role="button"
                            title={`${b.customerName || b.facility?.name || "Booking"} · ${b.startTime}–${b.endTime}`}
                            className={`rounded px-2 py-1 text-xs font-medium border mb-0.5 cursor-pointer hover:brightness-125 transition truncate ${b.color ? "" : statusColors[b.status]}`}
                            data-testid={`calendar-booking-${b.id}`}
                          >
                            <span className="opacity-70 mr-2">{b.startTime}–{b.endTime}</span>
                            {b.customerName || b.facility?.name || "Booking"}
                            <span className="opacity-60 ml-2">· {(b.facility?.name || "Facility") + extra}{sizeLabel(b)}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {view === "Month" && (() => {
        const cells = getMonthGrid(currentDate);
        const monthIdx = currentDate.getMonth();
        const byDate = new Map<string, BookingWithFacility[]>();
        for (const b of activeBookings) {
          const arr = byDate.get(b.bookingDate) || [];
          arr.push(b);
          byDate.set(b.bookingDate, arr);
        }
        return (
          <div className="rounded-2xl border border-blue-500/10 bg-white/[0.02] overflow-hidden" data-testid="calendar-month">
            <div className="grid grid-cols-7">
              {DAYS.map(d => (
                <div key={d} className="border-b border-r border-white/5 h-9 flex items-center justify-center text-xs font-medium text-white/50">{d}</div>
              ))}
            </div>
            <div className="grid grid-cols-7">
              {cells.map((d, i) => {
                const dStr = ymd(d);
                const inMonth = d.getMonth() === monthIdx;
                const isToday = dStr === todayStr;
                const dayB = (byDate.get(dStr) || []).sort((a, b) => a.startTime.localeCompare(b.startTime));
                return (
                  <button
                    key={i}
                    onClick={() => { setCurrentDate(new Date(d)); setView("Day"); }}
                    className={`border-r border-b border-white/5 min-h-[90px] p-1.5 text-left transition-colors hover:bg-white/[0.04] ${isToday ? "bg-blue-500/[0.06]" : ""} ${inMonth ? "" : "opacity-40"}`}
                    data-testid={`day-cell-${dStr}`}
                  >
                    <div className={`text-xs font-semibold mb-1 ${isToday ? "text-blue-400" : "text-white/60"}`}>{d.getDate()}</div>
                    <div className="space-y-0.5">
                      {dayB.slice(0, 6).map(b => {
                        const inline = b.color ? { backgroundColor: `${b.color}33`, borderColor: `${b.color}55`, color: b.color } : undefined;
                        // Calendar.online-style label: time + customer + half marker.
                        // Customer name is what the operator actually scans for.
                        const halfTag = b.halfFull === "half"
                          ? ` (${b.halfPosition ? b.halfPosition[0].toUpperCase() : "½"})`
                          : b.halfFull === "quarter"
                          ? ` (${b.halfPosition ? b.halfPosition.toUpperCase() : "¼"})`
                          : "";
                        const label = b.customerName
                          ? `${b.startTime} ${b.customerName}${halfTag}`
                          : `${b.startTime} ${b.facility?.name || "Booking"}${halfTag}`;
                        return (
                          <div
                            key={b.id}
                            style={inline}
                            title={`${b.startTime}–${b.endTime} · ${b.facility?.name || ""} · ${b.customerName || ""}`}
                            onClick={(e) => { e.stopPropagation(); setSelectedBooking(b); }}
                            role="button"
                            className={`rounded px-1 py-0.5 text-[9px] font-medium border truncate cursor-pointer hover:brightness-125 transition ${b.color ? "" : statusColors[b.status]}`}
                            data-testid={`calendar-booking-${b.id}`}
                          >
                            {label}
                          </div>
                        );
                      })}
                      {dayB.length > 6 && (
                        <div className="text-[9px] text-white/40 px-1">+{dayB.length - 6} more</div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })()}

      {view === "Year" && (() => {
        const year = currentDate.getFullYear();
        const bookedDates = new Set(activeBookings.map(b => b.bookingDate));
        return (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3" data-testid="calendar-year">
            {Array.from({ length: 12 }, (_, m) => {
              const monthDays = getMonthDays(year, m);
              // Pad the start so day 1 lines up with its weekday column (Mon-first).
              const firstDow = monthDays[0].getDay();
              const padStart = firstDow === 0 ? 6 : firstDow - 1;
              return (
                <div key={m} className="rounded-xl border border-blue-500/10 bg-white/[0.02] p-3" data-testid={`year-month-${m}`}>
                  <div className="text-xs font-semibold text-white/70 mb-2">
                    {new Date(year, m, 1).toLocaleDateString("en-NZ", { month: "long" })}
                  </div>
                  <div className="grid grid-cols-7 gap-y-0.5 text-center">
                    {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
                      <div key={i} className="text-[9px] text-white/30 mb-0.5">{d}</div>
                    ))}
                    {Array.from({ length: padStart }).map((_, i) => <div key={`p${i}`} />)}
                    {monthDays.map(d => {
                      const dStr = ymd(d);
                      const isToday = dStr === todayStr;
                      const hasBooking = bookedDates.has(dStr);
                      return (
                        <button
                          key={dStr}
                          onClick={() => { setCurrentDate(new Date(d)); setView("Day"); }}
                          className={`relative w-7 h-7 rounded-md text-[10px] font-medium transition-colors ${isToday ? "bg-blue-500/30 text-blue-100" : "text-white/50 hover:bg-white/10"}`}
                          data-testid={`year-day-${dStr}`}
                        >
                          {d.getDate()}
                          {hasBooking && <span className="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-blue-400" />}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })()}

      {view === "List" && (() => {
        const upcoming = activeBookings
          .filter(b => b.bookingDate >= todayStr)
          .sort((a, b) => a.bookingDate.localeCompare(b.bookingDate) || a.startTime.localeCompare(b.startTime));
        const past = activeBookings
          .filter(b => b.bookingDate < todayStr)
          .sort((a, b) => b.bookingDate.localeCompare(a.bookingDate) || b.startTime.localeCompare(a.startTime));
        const renderRow = (b: BookingWithFacility) => {
          const dot = b.color || "#3b82f6";
          return (
            <div key={b.id} onClick={() => setSelectedBooking(b)} role="button" className="flex items-center gap-3 px-4 py-2.5 border-b border-white/5 hover:bg-white/[0.03] cursor-pointer" data-testid={`list-booking-${b.id}`}>
              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: dot }} />
              <div className="w-32 text-xs text-white/60 flex-shrink-0">
                {new Date(b.bookingDate + "T00:00:00").toLocaleDateString("en-NZ", { weekday: "short", day: "numeric", month: "short" })}
              </div>
              <div className="w-24 text-xs text-white/40 flex-shrink-0">{b.startTime}–{b.endTime}</div>
              <div className="flex-1 text-xs text-white truncate">
                {b.facility?.name || "Booking"}
                {b.halfFull === "half" && (
                  <span className="text-white/50 ml-1">· {b.halfPosition ? `${b.halfPosition} half` : "half"}</span>
                )}
                {b.halfFull === "quarter" && (
                  <span className="text-white/50 ml-1">· quarter {b.halfPosition?.toUpperCase() || ""}</span>
                )}
              </div>
              <div className="text-xs text-white/40 truncate">{b.customerName}</div>
              <span className={`text-[10px] px-2 py-0.5 rounded font-medium border ${statusColors[b.status]}`}>{b.status}</span>
            </div>
          );
        };
        return (
          <div className="rounded-2xl border border-blue-500/10 bg-white/[0.02] overflow-hidden" data-testid="calendar-list">
            <div className="px-4 py-2 border-b border-white/10 text-[11px] uppercase tracking-wider text-white/40">
              Upcoming ({upcoming.length})
            </div>
            {upcoming.length === 0 ? (
              <div className="px-4 py-8 text-center text-xs text-white/30">No upcoming bookings.</div>
            ) : upcoming.map(renderRow)}
            {past.length > 0 && (
              <>
                <div className="px-4 py-2 border-b border-t border-white/10 text-[11px] uppercase tracking-wider text-white/40">
                  Past ({past.length})
                </div>
                {past.slice(0, 50).map(renderRow)}
              </>
            )}
          </div>
        );
      })()}

      {view === "Planner" && (() => {
        // Facilities × hours grid for a single day.
        const dayStr = ymd(currentDate);
        const isToday = dayStr === todayStr;
        const dayBookings = activeBookings.filter(b => b.bookingDate === dayStr);
        return (
          <div className="rounded-2xl border border-blue-500/10 bg-white/[0.02] overflow-hidden" data-testid="calendar-planner">
            <div className="grid" style={{ gridTemplateColumns: `160px repeat(${HOURS.length}, minmax(48px, 1fr))` }}>
              <div className={`border-b border-r border-white/5 h-10 flex items-center px-3 ${isToday ? "bg-blue-500/10" : ""}`}>
                <span className="text-xs font-medium text-white/60">Facility</span>
              </div>
              {HOURS.map(h => (
                <div key={h} className={`border-b border-r border-white/5 h-10 flex items-center justify-center ${isToday ? "bg-blue-500/10" : ""}`}>
                  <span className="text-[10px] text-white/40">{String(h).padStart(2, "0")}</span>
                </div>
              ))}
            </div>
            <div className="max-h-[600px] overflow-y-auto">
              {facs.length === 0 ? (
                <div className="px-4 py-8 text-center text-xs text-white/30">No facilities yet.</div>
              ) : facs.map(f => {
                const fb = dayBookings.filter(b => b.facilityId === f.id);
                return (
                  <div key={f.id} className="grid relative" style={{ gridTemplateColumns: `160px repeat(${HOURS.length}, minmax(48px, 1fr))` }}>
                    <div className="border-r border-b border-white/5 px-3 py-2 text-xs text-white/70 truncate">{f.name}</div>
                    {HOURS.map(h => (
                      <div key={h} className="border-r border-b border-white/5 min-h-[44px]" />
                    ))}
                    {fb.map(b => {
                      const startH = parseInt(b.startTime.split(":")[0]) + parseInt(b.startTime.split(":")[1]) / 60;
                      const endH = parseInt(b.endTime.split(":")[0]) + parseInt(b.endTime.split(":")[1]) / 60;
                      // Clip the booking to the visible HOURS window so a booking that
                      // starts at 05:30 (before the window) or ends at 23:30 (after) is
                      // still rendered, just clipped — instead of being silently hidden.
                      const windowStart = HOURS[0];
                      const windowEnd = HOURS[HOURS.length - 1] + 1;
                      const visStart = Math.max(startH, windowStart);
                      const visEnd = Math.min(endH, windowEnd);
                      if (visEnd <= visStart) return null;
                      const startCol = visStart - windowStart;
                      const span = Math.max(0.25, visEnd - visStart);
                      const inline = b.color
                        ? { backgroundColor: `${b.color}33`, borderColor: `${b.color}55`, color: b.color }
                        : undefined;
                      return (
                        <div
                          key={b.id}
                          style={{
                            position: "absolute",
                            left: `calc(160px + ${startCol} * ((100% - 160px) / ${HOURS.length}))`,
                            width: `calc(${span} * ((100% - 160px) / ${HOURS.length}))`,
                            top: 4,
                            bottom: 4,
                            ...inline,
                          }}
                          onClick={() => setSelectedBooking(b)}
                          role="button"
                          className={`rounded px-1.5 py-0.5 text-[10px] font-medium border truncate flex items-center cursor-pointer hover:brightness-125 transition ${b.color ? "" : statusColors[b.status]}`}
                          data-testid={`planner-booking-${b.id}`}
                        >
                          <span className="opacity-70 mr-1.5">{b.startTime}</span>
                          {b.customerName || b.facility?.name || "Booking"}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* Booking details — opens when any booking chip/row is clicked. Read-only. */}
      {selectedBooking && (() => {
        const b = selectedBooking;
        const primaryName = b.facility?.name || facs.find(f => f.id === b.facilityId)?.name || "Facility";
        const extraNames = (b.additionalFacilityIds || []).map(id => facs.find(f => f.id === id)?.name || `Facility #${id}`);
        const amount = Number(b.totalAmount || 0);
        const isMemberBooking = b.source === "member_request" || (b.notes || "").startsWith("Member booking request");
        // Audit trail — plain-English line for who put this booking on the calendar.
        const attribution = b.source === "public"
          ? "Booked online through the booking website"
          : b.source === "member_request"
          ? `Member request${b.createdByName ? ` · approved by ${b.createdByName}` : ""}`
          : b.source === "manual"
          ? (b.createdByName ? `Added by ${b.createdByName}` : "Added manually (staff)")
          : null;
        const dateLong = new Date(b.bookingDate + "T00:00:00").toLocaleDateString("en-NZ", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setSelectedBooking(null)}>
            <div className="bg-[#0f1423] border border-white/10 rounded-2xl p-6 w-[460px] max-w-[95vw] max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()} data-testid="booking-details-modal">
              <div className="flex items-start justify-between gap-3 mb-1">
                <div className="min-w-0">
                  <h3 className="text-lg font-semibold text-white break-words" data-testid="text-details-name">{b.customerName || "Booking"}</h3>
                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                    <span className={`text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-full border ${statusColors[b.status]}`}>{b.status}</span>
                    {isMemberBooking && (
                      <span className="text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-full border bg-indigo-500/15 text-indigo-300 border-indigo-500/30">Member booking</span>
                    )}
                  </div>
                </div>
                <button onClick={() => setSelectedBooking(null)} className="text-white/30 hover:text-white/60 flex-shrink-0" data-testid="button-close-details"><X className="w-5 h-5" /></button>
              </div>

              {!editForm && (
              <div className="mt-4">
                <DetailRow label={extraNames.length > 0 ? "Facilities" : "Facility"}>
                  <span className="font-medium">{primaryName}{sizeLabel(b)}</span>
                  {extraNames.map(n => <span key={n} className="block text-white/80">{n}</span>)}
                </DetailRow>
                <DetailRow label="Date">{dateLong}</DetailRow>
                <DetailRow label="Time">{b.startTime} – {b.endTime}</DetailRow>
                {b.customerEmail && (
                  <DetailRow label="Email"><a href={`mailto:${b.customerEmail}`} className="text-blue-400 hover:underline break-all">{b.customerEmail}</a></DetailRow>
                )}
                {b.customerPhone && (
                  <DetailRow label="Phone"><a href={`tel:${b.customerPhone}`} className="text-blue-400 hover:underline">{b.customerPhone}</a></DetailRow>
                )}
                {b.customerClub && <DetailRow label="Club / org">{b.customerClub}</DetailRow>}
                <DetailRow label="Amount">
                  {amount > 0 ? `$${amount.toFixed(2)} incl. GST` : "No charge"}
                  {b.discountCode && <span className="block text-white/50">Code: {b.discountCode}</span>}
                </DetailRow>
                {b.paidAt && (
                  <DetailRow label="Paid">{new Date(b.paidAt).toLocaleString("en-NZ", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" })}</DetailRow>
                )}
                {b.recurrenceRule && (
                  <DetailRow label="Repeats">
                    {b.recurrenceRule.replace("FREQ=", "").toLowerCase()}
                    {b.recurrenceEndDate ? ` until ${new Date(b.recurrenceEndDate + "T00:00:00").toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" })}` : ""}
                  </DetailRow>
                )}
                {b.notes && <DetailRow label="Notes"><span className="whitespace-pre-wrap">{b.notes}</span></DetailRow>}
                {b.bookingGroupId && <DetailRow label="Reference"><span className="text-white/60 break-all">{b.bookingGroupId}</span></DetailRow>}
                {b.createdAt && (
                  <DetailRow label="Booked on">{new Date(b.createdAt).toLocaleString("en-NZ", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" })}</DetailRow>
                )}
              </div>
              )}

              {/* Audit trail — small print at the bottom: who added this booking. */}
              {!editForm && attribution && (
                <p className="mt-3 pt-3 border-t border-white/5 text-[11px] text-white/40" data-testid="text-booking-attribution">
                  {attribution}
                </p>
              )}

              {editForm && (
                <div className="mt-4 space-y-3" data-testid="edit-booking-panel">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs text-white/40 mb-1 block">Customer Name</label>
                      <Input value={editForm.customerName} onChange={e => setEditForm({ ...editForm, customerName: e.target.value })} className="bg-white/5 border-white/10 text-white" data-testid="input-edit-name" />
                    </div>
                    <div>
                      <label className="text-xs text-white/40 mb-1 block">Email</label>
                      <Input value={editForm.customerEmail} onChange={e => setEditForm({ ...editForm, customerEmail: e.target.value })} className="bg-white/5 border-white/10 text-white" data-testid="input-edit-email" />
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-white/40 mb-1 block">Phone (optional)</label>
                    <Input value={editForm.customerPhone} onChange={e => setEditForm({ ...editForm, customerPhone: e.target.value })} className="bg-white/5 border-white/10 text-white" data-testid="input-edit-phone" />
                  </div>
                  <div>
                    <label className="text-xs text-white/40 mb-1 block">Facility</label>
                    <Select value={editForm.facilityId} onValueChange={v => setEditForm({ ...editForm, facilityId: v, fieldSize: "full" })}>
                      <SelectTrigger className="bg-white/5 border-white/10 text-white" data-testid="select-edit-facility"><SelectValue placeholder="Select facility" /></SelectTrigger>
                      <SelectContent>
                        {facs
                          .slice()
                          .sort((a, f2) => (a.displayOrder ?? 0) - (f2.displayOrder ?? 0) || a.name.localeCompare(f2.name))
                          .map(f => <SelectItem key={f.id} value={String(f.id)}>{f.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <FieldSizePicker
                      facility={facs.find(f => String(f.id) === editForm.facilityId)}
                      value={editForm}
                      onChange={patch => setEditForm({ ...editForm, ...patch })}
                      testPrefix="edit"
                    />
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="text-xs text-white/40 mb-1 block">Date</label>
                      <DatePickerInput value={editForm.bookingDate} onChange={e => setEditForm({ ...editForm, bookingDate: e.target.value })} className="bg-white/5 border-white/10 text-white" data-testid="input-edit-date" />
                    </div>
                    <div>
                      <label className="text-xs text-white/40 mb-1 block">Start</label>
                      <TimePickerInput value={editForm.startTime} onChange={e => setEditForm({ ...editForm, startTime: e.target.value })} className="bg-white/5 border-white/10 text-white" data-testid="input-edit-start" />
                    </div>
                    <div>
                      <label className="text-xs text-white/40 mb-1 block">End</label>
                      <TimePickerInput value={editForm.endTime} onChange={e => setEditForm({ ...editForm, endTime: e.target.value })} className="bg-white/5 border-white/10 text-white" data-testid="input-edit-end" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs text-white/40 mb-1 block">Amount (inc GST)</label>
                      <Input type="number" step="0.01" value={editForm.totalAmount} onChange={e => setEditForm({ ...editForm, totalAmount: e.target.value })} className="bg-white/5 border-white/10 text-white" data-testid="input-edit-amount" />
                    </div>
                    <div>
                      <label className="text-xs text-white/40 mb-1 block">Status</label>
                      <Select value={editForm.status} onValueChange={v => setEditForm({ ...editForm, status: v })}>
                        <SelectTrigger className="bg-white/5 border-white/10 text-white" data-testid="select-edit-status"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="confirmed">Confirmed</SelectItem>
                          <SelectItem value="paid">Paid</SelectItem>
                          <SelectItem value="pending">Pending</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-white/40 mb-1 block">Color</label>
                    <div className="flex items-center gap-2 flex-wrap" data-testid="edit-color-picker">
                      <button
                        type="button"
                        onClick={() => setEditForm({ ...editForm, color: "" })}
                        className={`w-7 h-7 rounded-full border-2 flex items-center justify-center text-[10px] text-white/50 ${editForm.color === "" ? "border-white" : "border-white/20"}`}
                        title="No color (use status color)"
                        data-testid="button-edit-color-none"
                      >
                        <X className="w-3 h-3" />
                      </button>
                      {COLOR_SWATCHES.map(s => (
                        <button
                          key={s.hex}
                          type="button"
                          onClick={() => setEditForm({ ...editForm, color: s.hex })}
                          style={{ backgroundColor: s.hex }}
                          className={`w-7 h-7 rounded-full border-2 transition-all ${editForm.color === s.hex ? "border-white scale-110" : "border-transparent hover:scale-105"}`}
                          title={s.label}
                          data-testid={`button-edit-color-${s.label.toLowerCase()}`}
                        />
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-white/40 mb-1 block">Notes</label>
                    <Textarea value={editForm.notes} onChange={e => setEditForm({ ...editForm, notes: e.target.value })} rows={3} className="bg-white/5 border-white/10 text-white" data-testid="input-edit-notes" />
                  </div>
                  {b.bookingGroupId && bookings.filter(x => x.bookingGroupId === b.bookingGroupId && x.status !== "cancelled").length > 1 && (
                    <p className="text-[11px] text-white/40">
                      This booking is part of a linked series — edits apply to this booking only, the rest of the series is unchanged.
                    </p>
                  )}
                  <div className="flex justify-end gap-2 pt-1">
                    <Button variant="ghost" size="sm" onClick={() => setEditForm(null)} disabled={updateMutation.isPending} className="text-white/50" data-testid="button-edit-cancel">
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => {
                        const amt = editForm.totalAmount === "" ? "0" : editForm.totalAmount;
                        updateMutation.mutate({
                          id: b.id,
                          patch: {
                            customerName: editForm.customerName.trim(),
                            customerEmail: editForm.customerEmail.trim(),
                            customerPhone: editForm.customerPhone.trim() || null,
                            facilityId: parseInt(editForm.facilityId),
                            bookingDate: editForm.bookingDate,
                            startTime: editForm.startTime,
                            endTime: editForm.endTime,
                            totalAmount: amt,
                            gstAmount: String(Number(amt) * 3 / 23),
                            color: editForm.color || null,
                            notes: editForm.notes.trim() || null,
                            status: editForm.status,
                            ...sizePayload(editForm),
                          },
                        });
                      }}
                      disabled={
                        !editForm.customerName.trim() ||
                        !editForm.customerEmail.trim() ||
                        !editForm.facilityId ||
                        !editForm.bookingDate ||
                        !editForm.startTime ||
                        !editForm.endTime ||
                        updateMutation.isPending
                      }
                      className="bg-blue-600 hover:bg-blue-700 text-white"
                      data-testid="button-save-edit"
                    >
                      {updateMutation.isPending ? "Saving…" : "Save changes"}
                    </Button>
                  </div>
                </div>
              )}

              {!editForm && (() => {
                // Other rows sharing this booking's group id (recurring series /
                // multi-facility) — offers a one-click series delete.
                const seriesCount = b.bookingGroupId
                  ? bookings.filter(x => x.bookingGroupId === b.bookingGroupId && x.status !== "cancelled").length
                  : 0;

                if (deleteIntent) {
                  const isSeries = deleteIntent.scope === "series";
                  return (
                    <div className="mt-4 rounded-xl border border-red-500/30 bg-red-500/[0.06] p-4 space-y-3" data-testid="delete-confirm-panel">
                      <p className="text-sm text-red-200 font-medium">
                        {isSeries
                          ? `Delete the entire series — all ${seriesCount} linked bookings?`
                          : "Delete this booking?"}
                      </p>
                      <p className="text-xs text-white/50">
                        The time slot{isSeries ? "s become" : " becomes"} available again. This can't be undone.
                      </p>
                      {b.customerEmail && (
                        <label className="flex items-start gap-2.5 cursor-pointer rounded-lg border border-white/10 bg-white/[0.03] p-3">
                          <input
                            type="checkbox"
                            checked={notifyCancel}
                            onChange={e => setNotifyCancel(e.target.checked)}
                            className="mt-0.5 w-4 h-4 accent-red-500 flex-shrink-0"
                            data-testid="checkbox-notify-cancel"
                          />
                          <span className="text-xs text-white/70 leading-relaxed">
                            Email a cancellation notice to <span className="text-white">{b.customerEmail}</span>
                          </span>
                        </label>
                      )}
                      <div className="flex justify-end gap-2 pt-1">
                        <Button variant="ghost" size="sm" onClick={() => setDeleteIntent(null)} disabled={deleteMutation.isPending} className="text-white/50" data-testid="button-delete-back">
                          Back
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => deleteMutation.mutate({ id: b.id, scope: deleteIntent.scope, notify: !!b.customerEmail && notifyCancel })}
                          disabled={deleteMutation.isPending}
                          className="bg-red-600 hover:bg-red-700 text-white"
                          data-testid="button-confirm-delete"
                        >
                          {deleteMutation.isPending
                            ? "Deleting…"
                            : isSeries
                              ? `Delete ${seriesCount} bookings`
                              : "Delete booking"}
                        </Button>
                      </div>
                    </div>
                  );
                }

                return (
                  <div className="flex items-center justify-between gap-2 pt-4 flex-wrap">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => startEdit(b)}
                        disabled={deleteMutation.isPending}
                        className="border-white/15 text-white/80 hover:bg-white/10"
                        data-testid="button-edit-booking"
                      >
                        <Pencil className="w-3.5 h-3.5 mr-1.5" /> Edit booking
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setDeleteIntent({})}
                        disabled={deleteMutation.isPending}
                        className="border-red-500/30 text-red-300 hover:bg-red-500/10"
                        data-testid="button-delete-booking"
                      >
                        <Trash2 className="w-3.5 h-3.5 mr-1.5" /> Delete booking
                      </Button>
                      {seriesCount > 1 && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setDeleteIntent({ scope: "series" })}
                          disabled={deleteMutation.isPending}
                          className="border-red-500/30 text-red-300 hover:bg-red-500/10"
                          data-testid="button-delete-series"
                        >
                          <Trash2 className="w-3.5 h-3.5 mr-1.5" /> Delete series ({seriesCount})
                        </Button>
                      )}
                    </div>
                    <Button variant="ghost" onClick={() => setSelectedBooking(null)} className="text-white/50" data-testid="button-details-close">Close</Button>
                  </div>
                );
              })()}
            </div>
          </div>
        );
      })()}

      {showNewBooking && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setShowNewBooking(false)}>
          <div className="bg-[#0f1423] border border-white/10 rounded-2xl p-6 w-[520px] max-w-[95vw] max-h-[90vh] overflow-y-auto space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-white">New Booking</h3>
              <button onClick={() => setShowNewBooking(false)} className="text-white/30 hover:text-white/60" data-testid="button-close-modal"><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-white/40 mb-1 block">Customer Name</label>
                <Input value={newBooking.customerName} onChange={e => setNewBooking({ ...newBooking, customerName: e.target.value })} className="bg-white/5 border-white/10 text-white" data-testid="input-booking-name" />
              </div>
              <div>
                <label className="text-xs text-white/40 mb-1 block">Email</label>
                <Input value={newBooking.customerEmail} onChange={e => setNewBooking({ ...newBooking, customerEmail: e.target.value })} className="bg-white/5 border-white/10 text-white" data-testid="input-booking-email" />
              </div>

              {/* Facility (primary + optional additional) */}
              <div>
                <label className="text-xs text-white/40 mb-1 block">Facility</label>
                <Select value={newBooking.facilityId} onValueChange={v => setNewBooking({ ...newBooking, facilityId: v, fieldSize: "full" })}>
                  <SelectTrigger className="bg-white/5 border-white/10 text-white" data-testid="select-booking-facility"><SelectValue placeholder="Select facility" /></SelectTrigger>
                  <SelectContent>
                    {facs
                      .filter(f => !newBooking.additionalFacilityIds.includes(String(f.id)))
                      .map(f => <SelectItem key={f.id} value={String(f.id)}>{f.name}</SelectItem>)}
                  </SelectContent>
                </Select>
                <FieldSizePicker
                  facility={facs.find(f => String(f.id) === newBooking.facilityId)}
                  value={newBooking}
                  onChange={patch => setNewBooking({ ...newBooking, ...patch })}
                  extrasNote={newBooking.additionalFacilityIds.some(Boolean)}
                  testPrefix="booking"
                />

                {newBooking.additionalFacilityIds.map((extraId, idx) => (
                  <div key={idx} className="flex items-center gap-2 mt-2">
                    <Select
                      value={extraId}
                      onValueChange={v => {
                        const next = [...newBooking.additionalFacilityIds];
                        next[idx] = v;
                        setNewBooking({ ...newBooking, additionalFacilityIds: next });
                      }}
                    >
                      <SelectTrigger className="bg-white/5 border-white/10 text-white flex-1" data-testid={`select-additional-facility-${idx}`}>
                        <SelectValue placeholder="Select facility" />
                      </SelectTrigger>
                      <SelectContent>
                        {facs
                          .filter(f => String(f.id) !== newBooking.facilityId && (String(f.id) === extraId || !newBooking.additionalFacilityIds.includes(String(f.id))))
                          .map(f => <SelectItem key={f.id} value={String(f.id)}>{f.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <button
                      type="button"
                      onClick={() => setNewBooking({
                        ...newBooking,
                        additionalFacilityIds: newBooking.additionalFacilityIds.filter((_, i) => i !== idx),
                      })}
                      className="text-white/30 hover:text-red-400 p-2"
                      data-testid={`button-remove-additional-facility-${idx}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}

                <button
                  type="button"
                  onClick={() => setNewBooking({ ...newBooking, additionalFacilityIds: [...newBooking.additionalFacilityIds, ""] })}
                  className="mt-2 text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1"
                  data-testid="button-add-additional-facility"
                >
                  <Plus className="w-3 h-3" /> Add another facility
                </button>
              </div>

              {/* Date / Start / End */}
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="text-xs text-white/40 mb-1 block">Date</label>
                  <DatePickerInput value={newBooking.bookingDate} onChange={e => setNewBooking({ ...newBooking, bookingDate: e.target.value })} className="bg-white/5 border-white/10 text-white" data-testid="input-booking-date" />
                </div>
                <div>
                  <label className="text-xs text-white/40 mb-1 block">Start</label>
                  <TimePickerInput value={newBooking.startTime} onChange={e => setNewBooking({ ...newBooking, startTime: e.target.value })} className="bg-white/5 border-white/10 text-white" data-testid="input-booking-start" />
                </div>
                <div>
                  <label className="text-xs text-white/40 mb-1 block">End</label>
                  <TimePickerInput value={newBooking.endTime} onChange={e => setNewBooking({ ...newBooking, endTime: e.target.value })} className="bg-white/5 border-white/10 text-white" data-testid="input-booking-end" />
                </div>
              </div>

              {(() => {
                const hits = manualOverlaps(bookings, newBooking);
                if (hits.length === 0) return null;
                return (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200" data-testid="manual-booking-overlap">
                    <div className="font-medium">Overlaps an existing booking on that pitch</div>
                    {hits.slice(0, 3).map(h => (
                      <div key={h.id} className="text-amber-200/80">{h.customerName || h.facility?.name || "Booking"}{sizeLabel(h)} · {h.startTime}–{h.endTime}</div>
                    ))}
                    {hits.length > 3 && <div className="text-amber-200/60">+{hits.length - 3} more</div>}
                    <div className="text-amber-200/60 mt-1">You can still create it — this is a heads-up, not a block.</div>
                  </div>
                );
              })()}

              {/* Repeat */}
              <div>
                <label className="text-xs text-white/40 mb-1 block">Repeat</label>
                <Select
                  value={newBooking.repeatFreq}
                  onValueChange={(v: RepeatFreq) => setNewBooking({ ...newBooking, repeatFreq: v, repeatByDay: [] })}
                >
                  <SelectTrigger className="bg-white/5 border-white/10 text-white" data-testid="select-repeat-freq">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Does not repeat</SelectItem>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="weekly">Weekly (same day each week)</SelectItem>
                    <SelectItem value="weekdays">Every weekday (Mon–Fri)</SelectItem>
                    <SelectItem value="custom">Custom — pick days</SelectItem>
                  </SelectContent>
                </Select>

                {newBooking.repeatFreq === "custom" && (
                  <div className="mt-2 flex items-center gap-1.5" data-testid="weekday-picker">
                    {WEEKDAY_BUTTONS.map(d => {
                      const active = newBooking.repeatByDay.includes(d.n);
                      return (
                        <button
                          key={d.n}
                          type="button"
                          onClick={() => setNewBooking({
                            ...newBooking,
                            repeatByDay: active
                              ? newBooking.repeatByDay.filter(x => x !== d.n)
                              : [...newBooking.repeatByDay, d.n],
                          })}
                          className={`w-8 h-8 rounded-full text-xs font-medium border transition-colors ${active ? "bg-blue-600 border-blue-500 text-white" : "bg-white/5 border-white/10 text-white/50 hover:bg-white/10"}`}
                          data-testid={`button-weekday-${d.n}`}
                        >
                          {d.label}
                        </button>
                      );
                    })}
                  </div>
                )}

                {newBooking.repeatFreq !== "none" && (
                  <div className="mt-2">
                    <label className="text-xs text-white/40 mb-1 block">Repeat until</label>
                    <DatePickerInput
                      value={newBooking.repeatUntil}
                      onChange={e => setNewBooking({ ...newBooking, repeatUntil: e.target.value })}
                      className="bg-white/5 border-white/10 text-white"
                      data-testid="input-repeat-until"
                    />
                  </div>
                )}
              </div>

              {/* Color */}
              <div>
                <label className="text-xs text-white/40 mb-1 block">Color</label>
                <div className="flex items-center gap-2 flex-wrap" data-testid="color-picker">
                  <button
                    type="button"
                    onClick={() => setNewBooking({ ...newBooking, color: "" })}
                    className={`w-7 h-7 rounded-full border-2 flex items-center justify-center text-[10px] text-white/50 ${newBooking.color === "" ? "border-white" : "border-white/20"}`}
                    title="No color (use status color)"
                    data-testid="button-color-none"
                  >
                    <X className="w-3 h-3" />
                  </button>
                  {COLOR_SWATCHES.map(s => (
                    <button
                      key={s.hex}
                      type="button"
                      onClick={() => setNewBooking({ ...newBooking, color: s.hex })}
                      style={{ backgroundColor: s.hex }}
                      className={`w-7 h-7 rounded-full border-2 transition-all ${newBooking.color === s.hex ? "border-white scale-110" : "border-transparent hover:scale-105"}`}
                      title={s.label}
                      data-testid={`button-color-${s.label.toLowerCase()}`}
                    />
                  ))}
                </div>
              </div>

              <div>
                <label className="text-xs text-white/40 mb-1 block">Amount (inc GST)</label>
                <Input type="number" step="0.01" value={newBooking.totalAmount} onChange={e => setNewBooking({ ...newBooking, totalAmount: e.target.value })} className="bg-white/5 border-white/10 text-white" data-testid="input-booking-amount" />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setShowNewBooking(false)} className="text-white/50">Cancel</Button>
              <Button
                onClick={() => {
                  // Filter out any blank "Add another facility" rows the user didn't fill in
                  const cleanedAdditional = newBooking.additionalFacilityIds
                    .filter(s => s && s !== newBooking.facilityId)
                    .map(s => parseInt(s));
                  const repeatPayload = newBooking.repeatFreq === "none"
                    ? undefined
                    : {
                        freq: newBooking.repeatFreq,
                        byDay: newBooking.repeatFreq === "custom" ? newBooking.repeatByDay : undefined,
                        until: newBooking.repeatUntil,
                      };
                  createMutation.mutate({
                    customerName: newBooking.customerName,
                    customerEmail: newBooking.customerEmail,
                    bookingDate: newBooking.bookingDate,
                    startTime: newBooking.startTime,
                    endTime: newBooking.endTime,
                    totalAmount: newBooking.totalAmount,
                    organizationId: orgId,
                    facilityId: parseInt(newBooking.facilityId),
                    additionalFacilityIds: cleanedAdditional,
                    color: newBooking.color || undefined,
                    repeat: repeatPayload,
                    gstAmount: String(Number(newBooking.totalAmount) * 3 / 23),
                    ...sizePayload(newBooking),
                  });
                }}
                disabled={
                  !newBooking.customerName ||
                  !newBooking.facilityId ||
                  !newBooking.bookingDate ||
                  !newBooking.startTime ||
                  !newBooking.endTime ||
                  (newBooking.repeatFreq !== "none" && !newBooking.repeatUntil) ||
                  (newBooking.repeatFreq === "custom" && newBooking.repeatByDay.length === 0) ||
                  createMutation.isPending
                }
                className="bg-blue-600 hover:bg-blue-700 text-white"
                data-testid="button-create-booking"
              >
                {createMutation.isPending ? "Creating..." : "Create Booking"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
