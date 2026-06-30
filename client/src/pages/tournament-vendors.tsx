// Vendors tab — CIC workspace. Roster of the INCOMING food/beverage vendors
// trading at the Christchurch International Cup (Empire Chicken, Bangkok Wok,
// Frankie's Coffee Cart, …), our own truck, and which days each one is on.
// Distinct from the "Food Truck" tab (which rosters OUR truck's staff).
//
// Hero view: a vendor × day coverage matrix for 5–16 July. Click a cell to
// add/remove a vendor on a day. Below: a vendor directory to manage contacts
// and contract status (sets up the e-sign phase). Internal-only — session +
// "vendors" tab permission.
import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  UtensilsCrossed, Plus, X, Check, Coffee, Star, Truck,
  CalendarDays, Store, AlertTriangle, FileSignature, Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// CIC 2026 tournament window.
const START = "2026-07-05";
const END = "2026-07-16";

// Per-day tournament context (age group + meal trucks required that day).
// Our own truck and the coffee cart are additive — not counted in "required".
const DAY_META: Record<string, { tournament: string; trucksRequired: number }> = {
  "2026-07-05": { tournament: "U14", trucksRequired: 1 },
  "2026-07-06": { tournament: "U14", trucksRequired: 1 },
  "2026-07-07": { tournament: "U14", trucksRequired: 1 },
  "2026-07-08": { tournament: "U15", trucksRequired: 1 },
  "2026-07-09": { tournament: "U15", trucksRequired: 1 },
  "2026-07-10": { tournament: "U15", trucksRequired: 1 },
  "2026-07-11": { tournament: "U9–U11", trucksRequired: 3 },
  "2026-07-12": { tournament: "U9–U11", trucksRequired: 3 },
  "2026-07-13": { tournament: "U9–U11", trucksRequired: 3 },
  "2026-07-14": { tournament: "U12–U13", trucksRequired: 2 },
  "2026-07-15": { tournament: "U12–U13", trucksRequired: 2 },
  "2026-07-16": { tournament: "U12–U13", trucksRequired: 2 },
};

const CATEGORIES = [
  { key: "meal", label: "Meal" },
  { key: "coffee", label: "Coffee" },
  { key: "dessert", label: "Dessert" },
  { key: "drinks", label: "Drinks" },
  { key: "other", label: "Other" },
] as const;

const CONTRACT_STATUSES = [
  { key: "none", label: "No contract", color: "text-white/40 bg-white/5 border-white/10" },
  { key: "pending", label: "Awaiting details", color: "text-amber-300 bg-amber-400/10 border-amber-400/25" },
  { key: "sent", label: "Sent — unsigned", color: "text-sky-300 bg-sky-400/10 border-sky-400/25" },
  { key: "signed", label: "Signed", color: "text-emerald-300 bg-emerald-400/10 border-emerald-400/25" },
] as const;

// Distinct colours for external meal vendors (ours + coffee are overridden).
const PALETTE = ["#60a5fa", "#34d399", "#f472b6", "#a78bfa", "#fb7185", "#22d3ee", "#c084fc", "#4ade80", "#f59e0b"];
const GOLD = "#C9A43E";
const COFFEE = "#d2924a";

interface Vendor {
  id: number;
  name: string;
  category: string;
  isOurs: boolean;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  contractStatus: string;
  notes: string | null;
}
interface Booking {
  id: number;
  vendorId: number;
  bookingDate: string;
  slot: number | null;
  notes: string | null;
}

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
    day: dt.getDate(),
    month: dt.toLocaleDateString("en-NZ", { month: "short" }),
    weekend: dow === 0 || dow === 6,
  };
}

function vendorColor(v: Vendor, mealIndex: number): string {
  if (v.isOurs) return GOLD;
  if (v.category === "coffee") return COFFEE;
  return PALETTE[mealIndex % PALETTE.length];
}

function CategoryIcon({ v }: { v: Vendor }) {
  if (v.isOurs) return <Star className="w-3.5 h-3.5" />;
  if (v.category === "coffee") return <Coffee className="w-3.5 h-3.5" />;
  return <Truck className="w-3.5 h-3.5" />;
}

export default function TournamentVendors() {
  const { toast } = useToast();
  const days = useMemo(() => dayList(START, END), []);

  const { data: vendors = [], isLoading: vLoading } = useQuery<Vendor[]>({ queryKey: ["/api/admin/vendors"] });
  const { data: bookings = [], isLoading: bLoading } = useQuery<Booking[]>({ queryKey: ["/api/admin/vendors/bookings"] });

  const onErr = (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" });
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/admin/vendors"] });
    queryClient.invalidateQueries({ queryKey: ["/api/admin/vendors/bookings"] });
  };

  const createBooking = useMutation({
    mutationFn: (data: { vendorId: number; bookingDate: string }) => apiRequest("POST", "/api/admin/vendors/bookings", data),
    onSuccess: () => invalidate(),
    onError: onErr,
  });
  const deleteBooking = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/admin/vendors/bookings/${id}`),
    onSuccess: () => invalidate(),
    onError: onErr,
  });
  const createVendor = useMutation({
    mutationFn: (data: any) => apiRequest("POST", "/api/admin/vendors", data),
    onSuccess: () => invalidate(),
    onError: onErr,
  });
  const patchVendor = useMutation({
    mutationFn: ({ id, data }: { id: number; data: any }) => apiRequest("PATCH", `/api/admin/vendors/${id}`, data),
    onSuccess: () => invalidate(),
    onError: onErr,
  });
  const deleteVendor = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/admin/vendors/${id}`),
    onSuccess: () => invalidate(),
    onError: onErr,
  });

  // Sort: our truck first, then meal, coffee, others; alpha within.
  const sortedVendors = useMemo(() => {
    const rank = (v: Vendor) => (v.isOurs ? 0 : v.category === "meal" ? 1 : v.category === "coffee" ? 2 : 3);
    return [...vendors].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  }, [vendors]);

  // Assign a stable colour index to external meal vendors only.
  const colorByVendor = useMemo(() => {
    const m = new Map<number, string>();
    let mealIdx = 0;
    for (const v of sortedVendors) {
      m.set(v.id, vendorColor(v, v.isOurs || v.category !== "meal" ? 0 : mealIdx));
      if (!v.isOurs && v.category === "meal") mealIdx++;
    }
    return m;
  }, [sortedVendors]);

  // booking lookup: "vendorId|date" -> bookingId
  const bookingId = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of bookings) m.set(`${b.vendorId}|${b.bookingDate}`, b.id);
    return m;
  }, [bookings]);

  // coverage per day: external meal vendors booked vs required
  const coverage = useMemo(() => {
    const m = new Map<string, { booked: number; required: number }>();
    for (const iso of days) {
      const required = DAY_META[iso]?.trucksRequired ?? 0;
      const booked = bookings.filter((b) => {
        if (b.bookingDate !== iso) return false;
        const v = vendors.find((x) => x.id === b.vendorId);
        return v && !v.isOurs && v.category === "meal";
      }).length;
      m.set(iso, { booked, required });
    }
    return m;
  }, [bookings, vendors, days]);

  const toggle = (vendorId: number, iso: string) => {
    const id = bookingId.get(`${vendorId}|${iso}`);
    if (id) deleteBooking.mutate(id);
    else createBooking.mutate({ vendorId, bookingDate: iso });
  };

  const stats = useMemo(() => {
    const providers = vendors.filter((v) => !v.isOurs).length;
    const fullyCovered = days.filter((iso) => {
      const c = coverage.get(iso)!;
      return c.required > 0 && c.booked >= c.required;
    }).length;
    const signed = vendors.filter((v) => !v.isOurs && v.contractStatus === "signed").length;
    const pending = vendors.filter((v) => !v.isOurs && (v.contractStatus === "pending" || v.contractStatus === "sent" || v.contractStatus === "none")).length;
    return { providers, fullyCovered, signed, pending };
  }, [vendors, coverage, days]);

  const loading = vLoading || bLoading;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2.5">
            <UtensilsCrossed className="w-6 h-6 text-amber-400" />
            Vendors
          </h1>
          <p className="text-sm text-white/40 mt-1">
            Incoming food trucks &amp; carts across the CIC · 5–16 July. Click any cell to roster a vendor on a day.
          </p>
        </div>
        <AddVendor onCreate={(data) => createVendor.mutate(data)} pending={createVendor.isPending} />
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "Providers", value: stats.providers, icon: Store },
          { label: "Days fully covered", value: `${stats.fullyCovered}/${days.length}`, icon: CalendarDays },
          { label: "Contracts signed", value: stats.signed, icon: FileSignature },
          { label: "Contracts to chase", value: stats.pending, icon: AlertTriangle },
        ].map((s) => (
          <div key={s.label} className="bg-white/[0.03] border border-white/5 rounded-2xl p-4">
            <div className="flex items-center gap-2 text-white/40 text-xs mb-1.5">
              <s.icon className="w-3.5 h-3.5" /> {s.label}
            </div>
            <div className="text-2xl font-bold text-white">{s.value}</div>
          </div>
        ))}
      </div>

      {loading ? (
        <div className="text-center text-white/30 py-16">Loading roster…</div>
      ) : (
        <>
          {/* Legend */}
          <div className="flex items-center gap-4 flex-wrap text-xs text-white/45">
            <span className="inline-flex items-center gap-1.5">
              <span className="w-3 h-3 rounded" style={{ background: GOLD }} /> <Star className="w-3 h-3" /> Our truck
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-3 h-3 rounded" style={{ background: COFFEE }} /> <Coffee className="w-3 h-3" /> Coffee cart
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Truck className="w-3 h-3" /> External meal truck
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-3 h-3 rounded bg-emerald-400/70" /> Day fully covered
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-3 h-3 rounded bg-amber-400/70" /> Needs more trucks
            </span>
          </div>

          {/* Coverage matrix */}
          <div className="bg-white/[0.03] border border-white/5 rounded-2xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr>
                    <th className="sticky left-0 z-20 bg-[#15171c] text-left px-4 py-3 min-w-[180px] border-b border-r border-white/5 text-white/50 font-medium text-xs uppercase tracking-wide">
                      Vendor
                    </th>
                    {days.map((iso) => {
                      const f = fmtDay(iso);
                      const meta = DAY_META[iso];
                      const c = coverage.get(iso)!;
                      const ok = c.required > 0 && c.booked >= c.required;
                      return (
                        <th
                          key={iso}
                          className={`px-2 py-2 border-b border-white/5 text-center min-w-[64px] ${f.weekend ? "bg-amber-400/[0.04]" : ""}`}
                        >
                          <div className="text-white/45 text-[10px] uppercase">{f.weekday}</div>
                          <div className="text-white font-bold leading-tight">{f.day}</div>
                          <div className="text-white/35 text-[10px]">{f.month}</div>
                          <div className="mt-1 text-[9px] font-semibold text-white/55 px-1 py-0.5 rounded bg-white/5">{meta?.tournament}</div>
                          <div
                            className={`mt-1 text-[10px] font-bold tabular-nums ${ok ? "text-emerald-400" : "text-amber-400"}`}
                            title={`${c.booked} of ${c.required} meal trucks rostered`}
                          >
                            {c.booked}/{c.required}
                          </div>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {sortedVendors.length === 0 ? (
                    <tr>
                      <td colSpan={days.length + 1} className="text-center text-white/30 py-12">
                        No vendors yet. Add one above to start rostering.
                      </td>
                    </tr>
                  ) : (
                    sortedVendors.map((v) => {
                      const color = colorByVendor.get(v.id)!;
                      return (
                        <tr key={v.id} className="group">
                          <td
                            className={`sticky left-0 z-10 bg-[#15171c] px-4 py-2.5 border-b border-r border-white/5 min-w-[180px] ${v.isOurs ? "bg-[#1b1814]" : ""}`}
                          >
                            <div className="flex items-center gap-2">
                              <span
                                className="inline-flex items-center justify-center w-6 h-6 rounded-md shrink-0"
                                style={{ background: `${color}22`, color }}
                              >
                                <CategoryIcon v={v} />
                              </span>
                              <div className="min-w-0">
                                <div className="text-white font-medium truncate flex items-center gap-1.5">
                                  {v.name}
                                  {v.isOurs && (
                                    <span className="text-[9px] font-bold uppercase tracking-wide text-amber-300 bg-amber-400/15 px-1.5 py-0.5 rounded">Ours</span>
                                  )}
                                </div>
                                <div className="text-white/35 text-[11px] capitalize">{v.category}</div>
                              </div>
                            </div>
                          </td>
                          {days.map((iso) => {
                            const booked = bookingId.has(`${v.id}|${iso}`);
                            const f = fmtDay(iso);
                            return (
                              <td key={iso} className={`p-1 border-b border-white/5 text-center ${f.weekend ? "bg-amber-400/[0.02]" : ""}`}>
                                <button
                                  onClick={() => toggle(v.id, iso)}
                                  title={booked ? `${v.name} — ${f.weekday} ${f.day} ${f.month} (click to remove)` : `Add ${v.name} on ${f.weekday} ${f.day} ${f.month}`}
                                  className="w-full h-9 rounded-md flex items-center justify-center transition-all"
                                  style={
                                    booked
                                      ? { background: color, boxShadow: `0 0 0 1px ${color}` }
                                      : { background: "rgba(255,255,255,0.02)", border: "1px dashed rgba(255,255,255,0.10)" }
                                  }
                                >
                                  {booked ? (
                                    <Check className="w-4 h-4 text-black/80" strokeWidth={3} />
                                  ) : (
                                    <Plus className="w-3.5 h-3.5 text-white/15 group-hover:text-white/30" />
                                  )}
                                </button>
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Vendor directory */}
          <div>
            <h2 className="text-sm font-semibold text-white/50 uppercase tracking-wide mb-3">Vendor directory</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {sortedVendors.map((v) => (
                <VendorCard
                  key={v.id}
                  vendor={v}
                  color={colorByVendor.get(v.id)!}
                  bookedDays={bookings.filter((b) => b.vendorId === v.id).length}
                  onPatch={(data) => patchVendor.mutate({ id: v.id, data })}
                  onDelete={() => deleteVendor.mutate(v.id)}
                />
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function AddVendor({ onCreate, pending }: { onCreate: (d: any) => void; pending: boolean }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("meal");

  const save = () => {
    if (!name.trim()) return;
    onCreate({ name: name.trim(), category });
    setName("");
    setCategory("meal");
    setOpen(false);
  };

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)} className="gap-1.5">
        <Plus className="w-4 h-4" /> Add vendor
      </Button>
    );
  }
  return (
    <div className="flex items-center gap-2 bg-white/[0.04] border border-white/10 rounded-xl p-2">
      <Input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setOpen(false); }}
        placeholder="Vendor name"
        className="h-9 w-44"
      />
      <select
        value={category}
        onChange={(e) => setCategory(e.target.value)}
        className="h-9 rounded-md bg-white/5 border border-white/10 text-white text-sm px-2"
      >
        {CATEGORIES.map((c) => (
          <option key={c.key} value={c.key} className="bg-[#15171c]">{c.label}</option>
        ))}
      </select>
      <Button size="sm" className="h-9" disabled={!name.trim() || pending} onClick={save}>Add</Button>
      <button onClick={() => setOpen(false)} className="text-white/30 hover:text-white/60"><X className="w-4 h-4" /></button>
    </div>
  );
}

function VendorCard({
  vendor, color, bookedDays, onPatch, onDelete,
}: {
  vendor: Vendor;
  color: string;
  bookedDays: number;
  onPatch: (d: any) => void;
  onDelete: () => void;
}) {
  const [email, setEmail] = useState(vendor.contactEmail ?? "");
  const status = CONTRACT_STATUSES.find((s) => s.key === vendor.contractStatus) ?? CONTRACT_STATUSES[0];
  const emailDirty = (email.trim() || null) !== (vendor.contactEmail ?? null);

  return (
    <div className="bg-white/[0.03] border border-white/5 rounded-2xl p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="inline-flex items-center justify-center w-7 h-7 rounded-md shrink-0" style={{ background: `${color}22`, color }}>
            <CategoryIcon v={vendor} />
          </span>
          <div className="min-w-0">
            <div className="text-white font-semibold truncate flex items-center gap-1.5">
              {vendor.name}
              {vendor.isOurs && <span className="text-[9px] font-bold uppercase text-amber-300 bg-amber-400/15 px-1.5 py-0.5 rounded">Ours</span>}
            </div>
            <div className="text-white/35 text-xs capitalize">{vendor.category} · {bookedDays} day{bookedDays === 1 ? "" : "s"}</div>
          </div>
        </div>
        {!vendor.isOurs && (
          <button onClick={onDelete} className="text-white/20 hover:text-red-400 transition-colors shrink-0" title="Remove vendor">
            <Trash2 className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Contract status */}
      <div className="flex items-center gap-2">
        <span className={`text-[11px] font-medium px-2 py-1 rounded border ${status.color}`}>{status.label}</span>
        <select
          value={vendor.contractStatus}
          onChange={(e) => onPatch({ contractStatus: e.target.value })}
          className="h-7 rounded-md bg-white/5 border border-white/10 text-white/70 text-xs px-1.5 ml-auto"
        >
          {CONTRACT_STATUSES.map((s) => (
            <option key={s.key} value={s.key} className="bg-[#15171c]">{s.label}</option>
          ))}
        </select>
      </div>

      {/* Contact email — inline editable (e.g. Frankie's pending) */}
      <div className="flex items-center gap-1.5">
        <Input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && emailDirty) onPatch({ contactEmail: email.trim() || null }); }}
          placeholder="Contact email…"
          className="h-8 text-xs"
        />
        {emailDirty && (
          <Button size="sm" className="h-8 px-2" onClick={() => onPatch({ contactEmail: email.trim() || null })}>Save</Button>
        )}
      </div>
    </div>
  );
}
