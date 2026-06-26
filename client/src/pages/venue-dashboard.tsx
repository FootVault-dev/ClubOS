import { useQuery } from "@tanstack/react-query";
import { useWorkspace } from "@/lib/workspace-context";
import { DollarSign, TrendingUp, Calendar, Clock, Sparkles } from "lucide-react";
import type { FacilityBooking, Facility } from "@shared/schema";

type BookingWithFacility = FacilityBooking & { facility?: Facility };

import { formatCurrency as _formatCurrency } from "@/lib/format";
function formatCurrency(amount: string | number) {
  return _formatCurrency(amount);
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-NZ", { day: "numeric", month: "short" });
}

const statusColors: Record<string, string> = {
  confirmed: "text-green-400",
  paid: "text-blue-400",
  pending: "text-yellow-400",
  cancelled: "text-red-400",
};

const statusDots: Record<string, string> = {
  confirmed: "bg-green-500",
  paid: "bg-blue-500",
  pending: "bg-yellow-500",
  cancelled: "bg-red-500",
};

export default function VenueDashboard() {
  const { currentOrg } = useWorkspace();
  const orgId = currentOrg?.id;

  const { data: bookings = [] } = useQuery<BookingWithFacility[]>({
    queryKey: ["/api/admin/venue/bookings", { orgId }],
    queryFn: () => fetch(`/api/admin/venue/bookings?orgId=${orgId}`).then(r => r.json()),
    enabled: !!orgId,
  });

  const { data: allFacilities = [] } = useQuery<Facility[]>({
    queryKey: ["/api/admin/venue/facilities", { orgId }],
    queryFn: () => fetch(`/api/admin/venue/facilities?orgId=${orgId}`).then(r => r.json()),
    enabled: !!orgId,
  });

  const totalRevenue = bookings.filter(b => b.status !== "cancelled").reduce((sum, b) => sum + Number(b.totalAmount), 0);
  const thisMonthBookings = bookings.filter(b => {
    const d = new Date(b.bookingDate);
    const now = new Date();
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear() && b.status !== "cancelled";
  });
  const thisMonthRevenue = thisMonthBookings.reduce((sum, b) => sum + Number(b.totalAmount), 0);
  // "Paid" = revenue-generating bookings only. Internal academy/training blocks are
  // created as $0 "confirmed" rows just to reserve the slot, so they must be excluded
  // from the headline counts — otherwise the dashboard overstates real commercial activity.
  const paidBookings = bookings.filter(b => b.status !== "cancelled" && Number(b.totalAmount) > 0);
  const paidThisMonth = paidBookings.filter(b => {
    const d = new Date(b.bookingDate);
    const now = new Date();
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  });

  const today = new Date().toISOString().split("T")[0];
  const todayBookings = bookings.filter(b => b.bookingDate === today && b.status !== "cancelled");

  const facilityBookingCounts = allFacilities.map(f => ({
    name: f.name,
    count: bookings.filter(b => b.facilityId === f.id && b.status !== "cancelled").length,
  })).sort((a, b) => b.count - a.count);

  const revenueByDate: Record<string, number> = {};
  bookings.filter(b => b.status !== "cancelled").forEach(b => {
    const d = b.bookingDate;
    revenueByDate[d] = (revenueByDate[d] || 0) + Number(b.totalAmount);
  });
  const sortedDates = Object.keys(revenueByDate).sort();
  const maxRevenue = Math.max(...Object.values(revenueByDate), 1);

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white" data-testid="text-venue-dashboard-title">Dashboard</h1>
        <p className="text-sm text-white/40 mt-1">Overview of your sports centre</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-2xl border border-blue-500/15 bg-gradient-to-br from-blue-500/10 to-blue-500/5 p-5" data-testid="stat-total-revenue">
          <DollarSign className="w-5 h-5 text-white/50 mb-3" />
          <p className="text-2xl font-bold text-white">{formatCurrency(totalRevenue)}</p>
          <p className="text-xs text-white/40 mt-1">Total Revenue</p>
          <p className="text-[10px] text-white/25">Inc GST</p>
        </div>
        <div className="rounded-2xl border border-blue-500/15 bg-gradient-to-br from-blue-500/10 to-blue-500/5 p-5" data-testid="stat-this-month">
          <TrendingUp className="w-5 h-5 text-white/50 mb-3" />
          <p className="text-2xl font-bold text-white">{formatCurrency(thisMonthRevenue)}</p>
          <p className="text-xs text-white/40 mt-1">This Month</p>
          <p className="text-[10px] text-white/25">Inc GST</p>
        </div>
        <div className="rounded-2xl border border-blue-500/15 bg-gradient-to-br from-blue-500/10 to-blue-500/5 p-5" data-testid="stat-total-bookings">
          <Calendar className="w-5 h-5 text-white/50 mb-3" />
          <p className="text-2xl font-bold text-white">{paidBookings.length}</p>
          <p className="text-xs text-white/40 mt-1">Paid Bookings</p>
          <p className="text-[10px] text-white/25">Excludes internal / $0</p>
        </div>
        <div className="rounded-2xl border border-blue-500/15 bg-gradient-to-br from-blue-500/10 to-blue-500/5 p-5" data-testid="stat-confirmed">
          <Clock className="w-5 h-5 text-white/50 mb-3" />
          <p className="text-2xl font-bold text-white">{paidThisMonth.length}</p>
          <p className="text-xs text-white/40 mt-1">Paid This Month</p>
        </div>
      </div>

      <div className="rounded-2xl border border-blue-500/10 bg-white/[0.02] p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-white/40" />
            <h3 className="text-sm font-semibold text-white">Today's Schedule</h3>
          </div>
          <span className="text-xs text-white/30">{todayBookings.length} bookings</span>
        </div>
        {todayBookings.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-white/20">
            <Calendar className="w-10 h-10 mb-2" />
            <p className="text-sm">No bookings today</p>
          </div>
        ) : (
          <div className="space-y-2">
            {todayBookings.map(b => (
              <div key={b.id} className="flex items-center justify-between py-2 border-b border-white/5 last:border-0">
                <div className="flex items-center gap-3">
                  <div className={`w-2 h-2 rounded-full ${statusDots[b.status]}`} />
                  <div>
                    <p className="text-sm text-white/80">{b.customerName}</p>
                    <p className="text-xs text-white/30">{b.facility?.name} · {b.startTime} - {b.endTime}</p>
                  </div>
                </div>
                <span className="text-sm text-white/60">{formatCurrency(b.totalAmount)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-blue-500/10 bg-white/[0.02] p-5">
        <h3 className="text-sm font-semibold text-white mb-4">Recent Bookings</h3>
        {bookings.length === 0 ? (
          <p className="text-sm text-white/20 text-center py-6">No bookings yet</p>
        ) : (
          <div className="space-y-1">
            {bookings.slice(0, 10).map(b => (
              <div key={b.id} className="flex items-center justify-between py-3 border-b border-white/5 last:border-0" data-testid={`booking-row-${b.id}`}>
                <div className="flex items-center gap-3">
                  <div className={`w-2.5 h-2.5 rounded-full ${statusDots[b.status]}`} />
                  <div>
                    <p className="text-sm font-medium text-white/80">{b.customerName}</p>
                    <p className="text-xs text-white/30">@ {b.facility?.name || "—"} · {formatDate(b.bookingDate)}</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-sm font-medium text-white/70">{formatCurrency(b.totalAmount)}</p>
                  <p className={`text-xs capitalize ${statusColors[b.status]}`}>{b.status === "paid" ? "Paid" : b.status.charAt(0).toUpperCase() + b.status.slice(1)}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-blue-500/10 bg-white/[0.02] p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-white flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-white/40" />
            Revenue Chart
          </h3>
        </div>
        <p className="text-2xl font-bold text-white mb-1">{formatCurrency(totalRevenue)}</p>
        <p className="text-xs text-white/30 mb-4">{bookings.filter(b => b.status !== "cancelled").length} bookings</p>
        {sortedDates.length > 0 ? (
          <div className="h-40 flex items-end gap-1">
            {sortedDates.slice(-30).map(d => (
              <div key={d} className="flex-1 min-w-[4px]" title={`${d}: ${formatCurrency(revenueByDate[d])}`}>
                <div
                  className="bg-blue-500 rounded-t w-full transition-all"
                  style={{ height: `${(revenueByDate[d] / maxRevenue) * 100}%`, minHeight: "2px" }}
                />
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-white/20 text-center py-8">No revenue data yet</p>
        )}
      </div>

      <div className="rounded-2xl border border-blue-500/10 bg-white/[0.02] p-5">
        <div className="flex items-center gap-2 mb-4">
          <h3 className="text-sm font-semibold text-white">Popular Facilities</h3>
        </div>
        {facilityBookingCounts.length === 0 ? (
          <p className="text-sm text-white/20 text-center py-6">No facility data yet</p>
        ) : (
          <div className="space-y-3">
            {facilityBookingCounts.map(f => (
              <div key={f.name} className="flex items-center gap-3">
                <span className="text-xs text-white/50 w-28 text-right truncate">{f.name}</span>
                <div className="flex-1 h-5 bg-white/5 rounded overflow-hidden">
                  <div
                    className="h-full bg-blue-500 rounded"
                    style={{ width: `${(f.count / (facilityBookingCounts[0]?.count || 1)) * 100}%` }}
                  />
                </div>
                <span className="text-xs text-white/30 w-6">{f.count}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
