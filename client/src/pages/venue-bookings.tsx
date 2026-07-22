// USC workspace — Bookings tab.
//
// A single master ledger of EVERY booking on the calendar, whatever its origin:
//   • paid online through the booking website   (source = "public")
//   • added manually by a staff member          (source = "manual")
//   • a member request a staff member approved   (source = "member_request")
//
// Each row carries a plain-English paper trail — who added it or approved it, or
// that it came straight off the website — so if anyone gets something wrong it's
// traceable. Read-only; manage individual bookings from the Bookings Calendar.

import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspace } from "@/lib/workspace-context";
import { ListChecks, Search } from "lucide-react";
import type { FacilityBooking, Facility } from "@shared/schema";

type BookingWithFacility = FacilityBooking & { facility?: Facility };

type SourceFilter = "all" | "public" | "manual" | "member_request";
type SortKey = "added" | "date";

const STATUS_STYLES: Record<string, { label: string; cls: string }> = {
  pending:   { label: "Pending",   cls: "bg-amber-500/15 text-amber-300 border-amber-500/30" },
  confirmed: { label: "Confirmed", cls: "bg-green-500/15 text-green-300 border-green-500/30" },
  paid:      { label: "Paid",      cls: "bg-blue-500/15 text-blue-300 border-blue-500/30" },
  cancelled: { label: "Cancelled", cls: "bg-red-500/15 text-red-300 border-red-500/30" },
};

const SOURCE_STYLES: Record<string, { label: string; cls: string }> = {
  public:         { label: "Website",  cls: "bg-blue-500/15 text-blue-300 border-blue-500/30" },
  manual:         { label: "Staff",    cls: "bg-slate-500/15 text-slate-300 border-slate-400/30" },
  member_request: { label: "Member",   cls: "bg-indigo-500/15 text-indigo-300 border-indigo-500/30" },
};

function fmtDate(iso: string): string {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-NZ", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}
function fmtTime(t: string): string {
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "pm" : "am";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")}${ampm}`;
}
function fmtAdded(ts: string | Date | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" });
}
function sizeLabel(b: { halfFull: string | null; halfPosition: string | null }): string {
  if (b.halfFull === "half") return b.halfPosition ? ` · ${b.halfPosition} half` : " · half";
  if (b.halfFull === "quarter") return b.halfPosition ? ` · quarter ${b.halfPosition.toUpperCase()}` : " · quarter";
  return "";
}

// Plain-English paper trail for a booking — matches the calendar detail modal.
function attribution(b: BookingWithFacility): string {
  if (b.source === "public") return "Booked online via the website";
  if (b.source === "member_request") return b.createdByName ? `Approved by ${b.createdByName}` : "Member request (approved)";
  if (b.source === "manual") return b.createdByName ? `Added by ${b.createdByName}` : "Added by staff";
  return "—";
}

export default function VenueBookings() {
  const { currentOrg } = useWorkspace();
  const orgId = currentOrg?.id;
  const [source, setSource] = useState<SourceFilter>("all");
  const [sort, setSort] = useState<SortKey>("added");
  const [search, setSearch] = useState("");

  // Same endpoint + query key the Bookings Calendar uses, so this list stays in
  // lock-step with it (and updates when a booking is created/approved).
  const { data: bookings = [], isLoading } = useQuery<BookingWithFacility[]>({
    queryKey: ["/api/admin/venue/bookings", { orgId }],
    queryFn: () => fetch(`/api/admin/venue/bookings?orgId=${orgId}`).then(r => r.json()),
    enabled: !!orgId,
  });

  const counts = useMemo(() => ({
    all: bookings.length,
    public: bookings.filter(b => b.source === "public").length,
    manual: bookings.filter(b => b.source === "manual").length,
    member_request: bookings.filter(b => b.source === "member_request").length,
  }), [bookings]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = bookings.filter(b => source === "all" || b.source === source);
    if (q) {
      list = list.filter(b =>
        (b.customerName || "").toLowerCase().includes(q) ||
        (b.customerEmail || "").toLowerCase().includes(q) ||
        (b.customerClub || "").toLowerCase().includes(q) ||
        (b.facility?.name || "").toLowerCase().includes(q) ||
        (b.createdByName || "").toLowerCase().includes(q) ||
        (b.attributionSource || "").toLowerCase().includes(q)
      );
    }
    return list.slice().sort((a, b) =>
      sort === "added"
        ? new Date(b.createdAt as any).getTime() - new Date(a.createdAt as any).getTime()
        : b.bookingDate.localeCompare(a.bookingDate) || b.startTime.localeCompare(a.startTime)
    );
  }, [bookings, source, search, sort]);

  // Live count + paid revenue for the CURRENT filtered/searched view — so
  // filtering (or searching a campaign tag like "field-hire") answers "how many
  // booked, and how much revenue" at a glance. Revenue = money actually captured
  // (status "paid"); pending holds and $0 staff blocks don't count.
  const summary = useMemo(() => {
    let paidCents = 0, paidCount = 0;
    for (const b of rows) {
      if (b.status === "paid") { paidCents += (b.totalCents ?? 0); paidCount++; }
    }
    return { count: rows.length, paidCount, paidRevenue: paidCents / 100 };
  }, [rows]);

  const FILTERS: { key: SourceFilter; label: string }[] = [
    { key: "all", label: `All (${counts.all})` },
    { key: "public", label: `Website (${counts.public})` },
    { key: "manual", label: `Staff (${counts.manual})` },
    { key: "member_request", label: `Member (${counts.member_request})` },
  ];

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="flex items-start gap-3">
        <ListChecks className="w-6 h-6 text-white/40 flex-shrink-0" />
        <div>
          <h1 className="text-2xl font-bold text-white" data-testid="text-bookings-title">Bookings</h1>
          <p className="text-sm text-white/40">Every booking — paid online, added by staff, or approved from a member request — with a record of who added each one.</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm" data-testid="bookings-summary">
        <div><span className="text-white/40">Showing</span> <span className="text-white font-semibold">{summary.count}</span> <span className="text-white/40">booking{summary.count === 1 ? "" : "s"}</span></div>
        <div><span className="text-white/40">Paid</span> <span className="text-white font-semibold">{summary.paidCount}</span></div>
        <div><span className="text-white/40">Revenue collected</span> <span className="text-green-300 font-semibold">${summary.paidRevenue.toFixed(2)}</span></div>
      </div>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          {FILTERS.map(f => (
            <button
              key={f.key}
              onClick={() => setSource(f.key)}
              data-testid={`filter-source-${f.key}`}
              className={`px-3.5 h-8 rounded-full text-xs font-medium border transition ${
                source === f.key
                  ? "bg-blue-500/20 border-blue-500/40 text-blue-200"
                  : "bg-white/[0.03] border-white/10 text-white/50 hover:text-white/80"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1.5 rounded-full bg-white/[0.03] border border-white/10 px-3 h-8">
            <Search className="w-3.5 h-3.5 text-white/30" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search name, email, facility, tag…"
              className="bg-transparent text-xs text-white placeholder:text-white/30 outline-none w-44"
              data-testid="input-bookings-search"
            />
          </div>
          <div className="flex items-center rounded-full bg-white/[0.03] border border-white/10 p-0.5">
            {([["added", "Recently added"], ["date", "Booking date"]] as [SortKey, string][]).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setSort(k)}
                data-testid={`sort-${k}`}
                className={`px-3 h-7 rounded-full text-[11px] font-medium transition ${
                  sort === k ? "bg-white/10 text-white" : "text-white/40 hover:text-white/70"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {isLoading ? (
        <div className="rounded-2xl border border-blue-500/10 bg-white/[0.02] p-16 text-center text-white/30">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border border-blue-500/10 bg-white/[0.02] p-16 text-center">
          <ListChecks className="w-12 h-12 text-white/10 mx-auto mb-3" />
          <p className="text-white/40 text-lg mb-1">No bookings to show</p>
          <p className="text-white/20 text-sm">Try a different filter or clear your search.</p>
        </div>
      ) : (
        <div className="rounded-2xl border border-blue-500/10 bg-white/[0.02] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left" style={{ tableLayout: "fixed" }} data-testid="bookings-table">
              <colgroup>
                <col style={{ width: "150px" }} />
                <col style={{ width: "110px" }} />
                <col style={{ width: "180px" }} />
                <col style={{ width: "200px" }} />
                <col style={{ width: "100px" }} />
                <col style={{ width: "110px" }} />
                <col style={{ width: "100px" }} />
                <col style={{ width: "200px" }} />
              </colgroup>
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-white/40 border-b border-white/10">
                  <th className="px-3 py-2.5 font-medium">Date</th>
                  <th className="px-3 py-2.5 font-medium">Time</th>
                  <th className="px-3 py-2.5 font-medium">Facility</th>
                  <th className="px-3 py-2.5 font-medium">Customer</th>
                  <th className="px-3 py-2.5 font-medium">Amount</th>
                  <th className="px-3 py-2.5 font-medium">Status</th>
                  <th className="px-3 py-2.5 font-medium">Source</th>
                  <th className="px-3 py-2.5 font-medium">Added / approved by</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(b => {
                  const amount = Number(b.totalAmount || 0);
                  const st = STATUS_STYLES[b.status] || { label: b.status, cls: "bg-white/10 text-white/60 border-white/20" };
                  const sr = b.source ? SOURCE_STYLES[b.source] : null;
                  return (
                    <tr key={b.id} className="border-b border-white/5 hover:bg-white/[0.02] align-top" data-testid={`booking-row-${b.id}`}>
                      <td className="px-3 py-2.5 text-xs text-white/80 truncate">{fmtDate(b.bookingDate)}</td>
                      <td className="px-3 py-2.5 text-xs text-white/50 truncate">{fmtTime(b.startTime)}–{fmtTime(b.endTime)}</td>
                      <td className="px-3 py-2.5 text-xs text-white/80 truncate" title={`${b.facility?.name || "Facility"}${sizeLabel(b)}`}>
                        {b.facility?.name || "Facility"}<span className="text-white/40">{sizeLabel(b)}</span>
                      </td>
                      <td className="px-3 py-2.5 truncate" title={`${b.customerName || ""}${b.customerEmail ? " · " + b.customerEmail : ""}`}>
                        <div className="text-xs text-white/85 truncate">{b.customerName || "—"}</div>
                        {b.customerEmail && <div className="text-[11px] text-white/35 truncate">{b.customerEmail}</div>}
                      </td>
                      <td className="px-3 py-2.5 text-xs text-white/70 truncate">{amount > 0 ? `$${amount.toFixed(2)}` : "—"}</td>
                      <td className="px-3 py-2.5">
                        <span className={`inline-block text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-full border ${st.cls}`}>{st.label}</span>
                      </td>
                      <td className="px-3 py-2.5">
                        {sr
                          ? <span className={`inline-block text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-full border ${sr.cls}`}>{sr.label}</span>
                          : <span className="text-xs text-white/30">—</span>}
                        {b.attributionSource && <div className="text-[10px] text-white/40 truncate mt-1" title={`Came from: ${b.attributionSource}`}>{b.attributionSource}</div>}
                      </td>
                      <td className="px-3 py-2.5 text-xs text-white/55 truncate" title={attribution(b)}>
                        {attribution(b)}
                        <div className="text-[11px] text-white/30 truncate">{fmtAdded(b.createdAt)}</div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
