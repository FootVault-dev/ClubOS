// ─────────────────────────────────────────────────────────────────────────────
// HOUSING — the "Housing" tab in the venue workspace of ClubOS.
//
// Tracks the on-site residency houses: which rooms have a tenant and which are
// free, whether rent is being paid on time, and whether the power/wifi bills
// are getting paid. Four tabs: Overview (the "is anything on fire" screen),
// Houses & rooms (who lives where, at a glance), Tenants (the rent roll), and
// Utilities (the bills).
//
// House style follows venue-addons.tsx / venue-facilities.tsx (dark-glass
// cards, rounded-2xl, white/10 borders) and group-hiring.tsx (react-query +
// apiRequest, shadcn Dialog forms, native <select> for enums, apiErrorMessage
// surfacing the server's human-readable messages). Vocabularies and payment
// logic all come from @shared/housing — never redeclared here. Money is
// always dollars on screen (MoneyInput / formatCurrency); dates are always
// server-derived strings, never `new Date()` for anything sent to the API.
// ─────────────────────────────────────────────────────────────────────────────

import { useMemo, useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency, dollarInputToCents, centsToDollarInput } from "@/lib/format";
import { MoneyInput } from "@/components/ui/money-input";
import { DatePickerInput } from "@/components/ui/date-picker-input";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Home, Plus, Pencil, Trash2, Check, X, Search, DoorOpen, DoorClosed,
  AlertTriangle, CheckCircle2, Users, Zap, Wallet, UserPlus, LogOut,
  Receipt, Undo2, Ban, type LucideIcon,
} from "lucide-react";
import {
  ROOM_TYPES, RENT_FREQUENCIES, RENT_FREQUENCY_LABELS,
  UTILITY_KINDS, UTILITY_KIND_LABELS, PAYMENT_STATE_LABELS,
  parseIso,
  type PaymentState, type RoomType, type RentFrequency, type UtilityKind,
  type PaymentMethod, type TenancyState,
} from "@shared/housing";

// ── Types — client-local mirrors of the /api/admin/housing/* JSON shapes ────

interface OverviewData {
  today: string;
  occupancy: { rooms: number; occupied: number; vacant: number; occupancyPct: number };
  activeTenants: number;
  annualRentCents: number;
  rent: { overdueCount: number; overdueCents: number; dueSoonCount: number; dueSoonCents: number };
  utilities: { accounts: number; overdueCount: number; overdueCents: number; dueSoonCount: number; dueSoonCents: number };
}

interface RoomTenant {
  tenancyId: number;
  contactId: number;
  name: string;
  email: string | null;
  phone: string | null;
  rentCents: number;
  rentFrequency: RentFrequency;
  startDate: string;
  endDate: string | null;
}

interface RoomRow {
  id: number;
  houseId: number;
  name: string;
  roomType: RoomType;
  defaultRentCents: number;
  defaultRentFrequency: RentFrequency;
  notes: string | null;
  tenant: RoomTenant | null;
}

interface HouseWithRooms {
  id: number;
  name: string;
  address: string | null;
  notes: string | null;
  occupied: number;
  vacant: number;
  occupancyPct: number;
  roomCount: number;
  rooms: RoomRow[];
}

interface TenancyRow {
  id: number;
  roomId: number;
  contactId: number;
  rentCents: number;
  rentFrequency: RentFrequency;
  startDate: string;
  endDate: string | null;
  bondCents: number;
  bondReturnedOn: string | null;
  notes: string | null;
  state: TenancyState;
  tenant: { id: number; name: string; email: string | null; phone: string | null };
  room: { id: number; name: string; roomType: RoomType };
  house: { id: number; name: string };
  charges: { total: number; overdue: number; overdueCents: number };
}

interface ChargeRow {
  id: number;
  tenancyId: number;
  dueOn: string;
  amountCents: number;
  paidOn: string | null;
  method: PaymentMethod | null;
  waived: boolean;
  state: PaymentState;
  daysOverdue: number;
  outstandingCents: number;
  tenant: { id: number; name: string; phone: string | null; email: string | null };
  room: { id: number; name: string };
  house: { id: number; name: string };
}

interface UtilityAccountRow {
  id: number;
  houseId: number;
  kind: UtilityKind;
  provider: string | null;
  accountNumber: string | null;
  billingFrequency: string;
  expectedAmountCents: number;
  notes: string | null;
  house: { id: number; name: string };
  bills: { total: number; overdue: number; overdueCents: number };
  nextDue: { id: number; dueOn: string; amountCents: number; state: PaymentState } | null;
}

interface BillRow {
  id: number;
  utilityAccountId: number;
  periodLabel: string | null;
  dueOn: string;
  amountCents: number;
  paidOn: string | null;
  method: PaymentMethod | null;
  waived: boolean;
  state: PaymentState;
  daysOverdue: number;
  outstandingCents: number;
  account: { id: number; kind: UtilityKind; provider: string | null };
  house: { id: number; name: string };
}

interface TenantSearchResult {
  id: number;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  type: string;
}

interface AttentionItem {
  key: string;
  kind: "rent" | "utility";
  id: number;
  title: string;
  subtitle: string;
  amountCents: number;
  daysOverdue: number;
}

// ── Local label/colour maps — vocab itself always comes from @shared/housing ─

const ROOM_TYPE_LABELS: Record<RoomType, string> = {
  single: "Single", double: "Double", twin: "Twin", ensuite: "Ensuite", studio: "Studio", other: "Other",
};

const TENANCY_STATE_LABEL: Record<TenancyState, string> = { upcoming: "Upcoming", active: "Active", ended: "Ended" };
const TENANCY_STATE_COLOR: Record<TenancyState, string> = { upcoming: "#3b82f6", active: "#22c55e", ended: "#64748b" };

const PAYMENT_STATE_COLOR: Record<PaymentState, string> = {
  paid: "#22c55e", waived: "#a78bfa", overdue: "#ef4444", due_soon: "#eab308", upcoming: "#64748b",
};

// Utility billing frequency is a free-text DB column (no shared vocab) — these
// are just sensible presets for the dropdown, not a validated enum.
const BILLING_FREQUENCIES = ["weekly", "fortnightly", "monthly", "bimonthly", "quarterly", "biannual", "annual"] as const;

// ── Helpers ──────────────────────────────────────────────────────────────────

const HOUSING_KEYS: string[][] = [
  ["/api/admin/housing/overview"],
  ["/api/admin/housing/houses"],
  ["/api/admin/housing/tenancies"],
  ["/api/admin/housing/charges"],
  ["/api/admin/housing/utilities"],
  ["/api/admin/housing/bills"],
];

/** Every mutation on this page touches at least two of these aggregates
 *  (e.g. marking a charge paid changes Overview's overdue count AND the
 *  tenancy's owing badge AND the charges list) — invalidate all of them
 *  rather than trying to track which ones apply to which action. */
function invalidateHousing() {
  for (const key of HOUSING_KEYS) queryClient.invalidateQueries({ queryKey: key });
}

/** Best-effort extraction of the server's JSON `message` out of an apiRequest
 *  error, so a 409's human-readable reason reaches the toast verbatim. */
function apiErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e ?? "Something went wrong");
  const idx = raw.indexOf(": ");
  const body = idx >= 0 ? raw.slice(idx + 2) : raw;
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed.message === "string") return parsed.message;
  } catch {
    /* not JSON — fall through to the raw text */
  }
  return raw;
}

/** Display-only date formatting. Anchoring at midday sidesteps the UTC/NZ
 *  midnight bug (see shared/housing.ts) without ever sending a Date anywhere —
 *  this never touches a value bound for the server or a due-date comparison. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Format `YYYY-MM-DD` for display, straight from its own calendar parts.
 *
 *  An ISO date is already a calendar day. Round-tripping it through a `Date` is
 *  how this workspace once printed "18 July" on an invoice due the 17th, so no
 *  `Date` is constructed here at all — there is nothing left to shift. */
function fmtNZDate(iso: string | null | undefined): string {
  const p = parseIso(iso);
  if (!p) return "—";
  return `${p.d} ${MONTHS[p.m - 1]} ${p.y}`;
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

function findRoom(houses: HouseWithRooms[], roomId: string): { house: HouseWithRooms; room: RoomRow } | null {
  for (const h of houses) {
    const r = h.rooms.find((rr) => String(rr.id) === roomId);
    if (r) return { house: h, room: r };
  }
  return null;
}

const inputCls = "w-full rounded-lg bg-white/[0.03] border border-white/10 px-3 py-2 text-sm text-white/90 placeholder:text-white/25 focus:outline-none focus:border-blue-500/50 disabled:opacity-40 disabled:cursor-not-allowed";

// ── Shared small components ──────────────────────────────────────────────────

function PaymentStatePill({ state }: { state: PaymentState }) {
  const color = PAYMENT_STATE_COLOR[state];
  return (
    <span
      className="inline-flex items-center text-[10px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap"
      style={{ background: `${color}22`, color, border: `1px solid ${color}55` }}
    >
      {PAYMENT_STATE_LABELS[state]}
    </span>
  );
}

function TenancyStatePill({ state }: { state: TenancyState }) {
  const color = TENANCY_STATE_COLOR[state];
  return (
    <span
      className="inline-flex items-center text-[10px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap"
      style={{ background: `${color}22`, color, border: `1px solid ${color}55` }}
    >
      {TENANCY_STATE_LABEL[state]}
    </span>
  );
}

function StatCard({ label, value, sub, icon: Icon, color }: { label: string; value: string; sub?: string; icon: LucideIcon; color: string }) {
  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-3.5" data-testid={`stat-${label.toLowerCase().replace(/\s+/g, "-")}`}>
      <div className="flex items-center gap-2 mb-1.5">
        <Icon className="w-3.5 h-3.5" style={{ color }} />
        <span className="text-[11px] text-white/40 uppercase tracking-wide">{label}</span>
      </div>
      <div className="text-xl font-semibold text-white/90">{value}</div>
      {sub && <div className="text-[11px] text-white/35 mt-0.5">{sub}</div>}
    </div>
  );
}

/** Generic destructive-action confirmation. Every delete on this page routes
 *  through here rather than a bare `confirm()`. */
function ConfirmDialog({
  open, onOpenChange, title, description, confirmLabel = "Delete", pending, onConfirm, destructive = true,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  pending: boolean;
  onConfirm: () => void;
  destructive?: boolean;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="bg-[#0a0e1a] border border-white/10 text-white/90 max-w-sm">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-white/90">{title}</AlertDialogTitle>
          <AlertDialogDescription className="text-white/50">{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="bg-white/[0.04] border-white/10 text-white/70 hover:bg-white/[0.08] hover:text-white/90">
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => { e.preventDefault(); onConfirm(); }}
            disabled={pending}
            className={destructive ? "bg-red-500/90 hover:bg-red-500 text-white border-0" : "bg-blue-600 hover:bg-blue-700 text-white border-0"}
          >
            {pending ? "Working…" : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function EmptyState({ icon: Icon, title, action }: { icon: LucideIcon; title: string; action?: { label: string; onClick: () => void } }) {
  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] py-16 text-center">
      <Icon className="w-8 h-8 text-white/20 mx-auto mb-3" />
      <div className="text-white/50 text-sm">{title}</div>
      {action && (
        <button onClick={action.onClick} className="text-blue-400 text-[13px] mt-2 hover:underline">
          {action.label} →
        </button>
      )}
    </div>
  );
}

// ═══ OVERVIEW ═════════════════════════════════════════════════════════════════

function OverviewSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-20 rounded-2xl bg-white/[0.04]" />)}
      </div>
      <Skeleton className="h-48 rounded-2xl bg-white/[0.04]" />
    </div>
  );
}

function OverviewTab() {
  const { toast } = useToast();
  const { data: overview, isLoading: loadingOverview } = useQuery<OverviewData>({ queryKey: ["/api/admin/housing/overview"] });
  const { data: chargesData, isLoading: loadingCharges } = useQuery<{ today: string; charges: ChargeRow[] }>({ queryKey: ["/api/admin/housing/charges"] });
  const { data: billsData, isLoading: loadingBills } = useQuery<{ today: string; bills: BillRow[] }>({ queryKey: ["/api/admin/housing/bills"] });

  // Today comes from the server (NZ time). It is "" only while the first query is
  // in flight — and an empty date sent as `paidOn` is exactly how you would wipe
  // a recorded payment, so nothing is allowed to fire without it.
  const today = overview?.today ?? chargesData?.today ?? billsData?.today ?? "";
  const requireToday = () => {
    if (!today) throw new Error("Still loading today's date — try again in a moment.");
    return today;
  };

  const markChargePaid = useMutation({
    mutationFn: (id: number) => apiRequest("PATCH", `/api/admin/housing/charges/${id}`, { paidOn: requireToday() }),
    onSuccess: () => { invalidateHousing(); toast({ title: "Rent marked paid" }); },
    onError: (e: unknown) => toast({ title: "Couldn't mark paid", description: apiErrorMessage(e), variant: "destructive" }),
  });
  const markBillPaid = useMutation({
    mutationFn: (id: number) => apiRequest("PATCH", `/api/admin/housing/bills/${id}`, { paidOn: requireToday() }),
    onSuccess: () => { invalidateHousing(); toast({ title: "Bill marked paid" }); },
    onError: (e: unknown) => toast({ title: "Couldn't mark paid", description: apiErrorMessage(e), variant: "destructive" }),
  });

  const attention = useMemo<AttentionItem[]>(() => {
    const overdueCharges = (chargesData?.charges ?? []).filter((c) => c.state === "overdue");
    const overdueBills = (billsData?.bills ?? []).filter((b) => b.state === "overdue");
    const items: AttentionItem[] = [
      ...overdueCharges.map((c) => ({
        key: `rent-${c.id}`, kind: "rent" as const, id: c.id,
        title: c.tenant.name, subtitle: `${c.house.name} · ${c.room.name}`,
        amountCents: c.outstandingCents, daysOverdue: c.daysOverdue,
      })),
      ...overdueBills.map((b) => ({
        key: `util-${b.id}`, kind: "utility" as const, id: b.id,
        title: `${UTILITY_KIND_LABELS[b.account.kind]}${b.account.provider ? ` · ${b.account.provider}` : ""}`,
        subtitle: b.house.name, amountCents: b.outstandingCents, daysOverdue: b.daysOverdue,
      })),
    ];
    return items.sort((a, b) => b.daysOverdue - a.daysOverdue);
  }, [chargesData, billsData]);

  if (loadingOverview || loadingCharges || loadingBills || !overview) return <OverviewSkeleton />;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard
          label="Occupancy"
          value={`${overview.occupancy.occupied}/${overview.occupancy.rooms}`}
          sub={`${overview.occupancy.occupancyPct}% full`}
          icon={DoorOpen}
          color="#3b82f6"
        />
        <StatCard
          label="Active tenants"
          value={String(overview.activeTenants)}
          sub={`${formatCurrency(overview.annualRentCents, { fromCents: true })}/yr rent roll`}
          icon={Users}
          color="#8b5cf6"
        />
        <StatCard
          label="Rent overdue"
          value={String(overview.rent.overdueCount)}
          sub={overview.rent.overdueCount > 0 ? formatCurrency(overview.rent.overdueCents, { fromCents: true }) : "All clear"}
          icon={Wallet}
          color={overview.rent.overdueCount > 0 ? "#ef4444" : "#22c55e"}
        />
        <StatCard
          label="Utilities overdue"
          value={String(overview.utilities.overdueCount)}
          sub={overview.utilities.overdueCount > 0 ? formatCurrency(overview.utilities.overdueCents, { fromCents: true }) : "All clear"}
          icon={Zap}
          color={overview.utilities.overdueCount > 0 ? "#ef4444" : "#22c55e"}
        />
      </div>

      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02]">
        <div className="px-4 py-3 border-b border-white/[0.06] flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-400" />
          <h2 className="text-[13px] font-semibold text-white/70">Needs attention</h2>
          {attention.length > 0 && <span className="ml-auto text-[11px] text-white/30">{attention.length}</span>}
        </div>
        {attention.length === 0 ? (
          <div className="py-12 text-center">
            <CheckCircle2 className="w-8 h-8 text-emerald-400/50 mx-auto mb-2" />
            <p className="text-[13px] text-white/40">Nothing overdue — rent and utilities are all up to date.</p>
          </div>
        ) : (
          <div className="divide-y divide-white/[0.05]">
            {attention.map((item) => (
              <div key={item.key} className="flex items-center gap-3 px-4 py-3 flex-wrap sm:flex-nowrap" data-testid={`attention-${item.key}`}>
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${item.kind === "rent" ? "bg-blue-500/10" : "bg-amber-500/10"}`}>
                  {item.kind === "rent" ? <Wallet className="w-4 h-4 text-blue-400" /> : <Zap className="w-4 h-4 text-amber-400" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium text-white/85 truncate">{item.title}</div>
                  <div className="text-[11px] text-white/40 truncate">{item.subtitle}</div>
                </div>
                <div className="text-right">
                  <div className="text-[13px] font-semibold text-red-300">{formatCurrency(item.amountCents, { fromCents: true })}</div>
                  <div className="text-[11px] text-red-400/70">{item.daysOverdue} day{item.daysOverdue === 1 ? "" : "s"} overdue</div>
                </div>
                <button
                  onClick={() => (item.kind === "rent" ? markChargePaid.mutate(item.id) : markBillPaid.mutate(item.id))}
                  disabled={markChargePaid.isPending || markBillPaid.isPending}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 px-3 py-2 text-[12px] font-medium hover:bg-emerald-500/25 transition-colors disabled:opacity-50 min-h-[44px] sm:min-h-0"
                  data-testid={`button-mark-paid-${item.key}`}
                >
                  <Check className="w-3.5 h-3.5" /> Mark paid
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ═══ HOUSES & ROOMS ═══════════════════════════════════════════════════════════

function HousesSkeleton() {
  return (
    <div className="space-y-4">
      {[1, 2].map((i) => <Skeleton key={i} className="h-40 rounded-2xl bg-white/[0.04]" />)}
    </div>
  );
}

function RoomTile({ room, onEdit, onDelete, onAssign }: {
  room: RoomRow;
  onEdit: () => void;
  onDelete: () => void;
  onAssign: () => void;
}) {
  const occupied = !!room.tenant;
  return (
    <div
      className={`rounded-xl border p-3 flex flex-col gap-2 ${occupied ? "border-blue-500/20 bg-blue-500/[0.04]" : "border-dashed border-emerald-500/25 bg-emerald-500/[0.03]"}`}
      data-testid={`room-${room.id}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-white/85 truncate">{room.name}</div>
          <div className="text-[10px] text-white/35">{ROOM_TYPE_LABELS[room.roomType]}</div>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button onClick={onEdit} className="w-7 h-7 rounded-md flex items-center justify-center text-white/25 hover:text-white/60 hover:bg-white/5" title="Edit room" data-testid={`button-edit-room-${room.id}`}>
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button onClick={onDelete} className="w-7 h-7 rounded-md flex items-center justify-center text-white/25 hover:text-red-400 hover:bg-red-500/10" title="Delete room" data-testid={`button-delete-room-${room.id}`}>
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      {occupied && room.tenant ? (
        <div className="space-y-0.5">
          <div className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-blue-300">
            <DoorClosed className="w-3 h-3" /> Occupied
          </div>
          <div className="text-[12px] text-white/80">{room.tenant.name}</div>
          <div className="text-[11px] text-white/40">
            {formatCurrency(room.tenant.rentCents, { fromCents: true })} {RENT_FREQUENCY_LABELS[room.tenant.rentFrequency].toLowerCase()} · since {fmtNZDate(room.tenant.startDate)}
          </div>
        </div>
      ) : (
        <div className="space-y-1.5">
          <div className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-300">
            <DoorOpen className="w-3 h-3" /> Vacant
          </div>
          <div className="text-[11px] text-white/35">
            {formatCurrency(room.defaultRentCents, { fromCents: true })} {RENT_FREQUENCY_LABELS[room.defaultRentFrequency].toLowerCase()} default
          </div>
          <button onClick={onAssign} className="inline-flex items-center gap-1 text-[11px] text-emerald-300 hover:text-emerald-200 font-medium min-h-[32px]" data-testid={`button-assign-room-${room.id}`}>
            <UserPlus className="w-3.5 h-3.5" /> Assign tenant
          </button>
        </div>
      )}
    </div>
  );
}

function HouseCard({ house, onEditHouse, onDeleteHouse, onAddRoom, onEditRoom, onDeleteRoom, onAssignRoom }: {
  house: HouseWithRooms;
  onEditHouse: () => void;
  onDeleteHouse: () => void;
  onAddRoom: () => void;
  onEditRoom: (room: RoomRow) => void;
  onDeleteRoom: (room: RoomRow) => void;
  onAssignRoom: (room: RoomRow) => void;
}) {
  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] overflow-hidden" data-testid={`house-${house.id}`}>
      <div className="px-4 py-3 border-b border-white/[0.06] flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-[15px] font-semibold text-white/90">{house.name}</h3>
            <span className="text-[11px] text-white/40">{house.occupied}/{house.roomCount} occupied</span>
          </div>
          {house.address && <div className="text-[12px] text-white/40 mt-0.5">{house.address}</div>}
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <button onClick={onAddRoom} className="inline-flex items-center gap-1 rounded-lg bg-white/[0.04] border border-white/10 text-white/70 px-2.5 py-1.5 text-[11px] hover:bg-white/[0.08] min-h-[32px]" data-testid={`button-add-room-${house.id}`}>
            <Plus className="w-3.5 h-3.5" /> Room
          </button>
          <button onClick={onEditHouse} className="w-8 h-8 rounded-lg flex items-center justify-center text-white/30 hover:text-white/70 hover:bg-white/[0.06]" title="Edit house" data-testid={`button-edit-house-${house.id}`}>
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button onClick={onDeleteHouse} className="w-8 h-8 rounded-lg flex items-center justify-center text-white/30 hover:text-red-400 hover:bg-white/[0.06]" title="Delete house" data-testid={`button-delete-house-${house.id}`}>
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      <div className="p-4">
        {house.rooms.length === 0 ? (
          <div className="text-center py-6 text-[12px] text-white/30">No rooms yet — add the first one.</div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {house.rooms.map((room) => (
              <RoomTile
                key={room.id}
                room={room}
                onEdit={() => onEditRoom(room)}
                onDelete={() => onDeleteRoom(room)}
                onAssign={() => onAssignRoom(room)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function HouseFormDialog({ open, onOpenChange, house }: { open: boolean; onOpenChange: (v: boolean) => void; house: HouseWithRooms | undefined }) {
  const { toast } = useToast();
  const isEdit = !!house;
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (!open) return;
    setName(house?.name ?? "");
    setAddress(house?.address ?? "");
    setNotes(house?.notes ?? "");
  }, [open, house]);

  const mutation = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), address: address.trim() || null, notes: notes.trim() || null };
      return isEdit && house
        ? apiRequest("PATCH", `/api/admin/housing/houses/${house.id}`, body)
        : apiRequest("POST", "/api/admin/housing/houses", body);
    },
    onSuccess: () => { invalidateHousing(); toast({ title: isEdit ? "House updated" : "House added" }); onOpenChange(false); },
    onError: (e: unknown) => toast({ title: "Couldn't save house", description: apiErrorMessage(e), variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md bg-[#0a0f1a] border border-white/10 text-white/90">
        <h2 className="text-base font-semibold mb-3">{isEdit ? "Edit house" : "Add house"}</h2>
        <div className="space-y-3">
          <div>
            <label className="text-[11px] text-white/40 mb-1 block">Name *</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Riccarton House" className={inputCls} autoFocus data-testid="input-house-name" />
          </div>
          <div>
            <label className="text-[11px] text-white/40 mb-1 block">Address</label>
            <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Street address" className={inputCls} data-testid="input-house-address" />
          </div>
          <div>
            <label className="text-[11px] text-white/40 mb-1 block">Notes</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} className={inputCls + " min-h-[70px]"} data-testid="input-house-notes" />
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={() => onOpenChange(false)} className="rounded-xl px-4 py-2 text-sm text-white/50 hover:text-white/80">Cancel</button>
          <button
            onClick={() => mutation.mutate()}
            disabled={!name.trim() || mutation.isPending}
            className="inline-flex items-center gap-2 rounded-xl bg-blue-500/20 border border-blue-500/40 text-blue-200 px-4 py-2 text-sm font-medium hover:bg-blue-500/30 disabled:opacity-50"
            data-testid="button-save-house"
          >
            {mutation.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RoomFormDialog({ houseId, houseName, room, onClose }: {
  houseId: number;
  houseName: string;
  room: RoomRow | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const isEdit = !!room;
  const [name, setName] = useState(room?.name ?? "");
  const [roomType, setRoomType] = useState<RoomType>(room?.roomType ?? "single");
  const [rent, setRent] = useState(centsToDollarInput(room?.defaultRentCents ?? 0));
  const [frequency, setFrequency] = useState<RentFrequency>(room?.defaultRentFrequency ?? "weekly");
  const [notes, setNotes] = useState(room?.notes ?? "");

  const mutation = useMutation({
    mutationFn: () => {
      const body = {
        houseId, name: name.trim(), roomType, defaultRentFrequency: frequency,
        defaultRentCents: dollarInputToCents(rent || "0"), notes: notes.trim() || null,
      };
      return isEdit && room
        ? apiRequest("PATCH", `/api/admin/housing/rooms/${room.id}`, body)
        : apiRequest("POST", "/api/admin/housing/rooms", body);
    },
    onSuccess: () => { invalidateHousing(); toast({ title: isEdit ? "Room updated" : "Room added" }); onClose(); },
    onError: (e: unknown) => toast({ title: "Couldn't save room", description: apiErrorMessage(e), variant: "destructive" }),
  });

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-md bg-[#0a0f1a] border border-white/10 text-white/90">
        <h2 className="text-base font-semibold mb-1">{isEdit ? "Edit room" : "Add room"}</h2>
        <p className="text-[12px] text-white/40 mb-3">{houseName}</p>
        <div className="space-y-3">
          <div>
            <label className="text-[11px] text-white/40 mb-1 block">Room name *</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Room 1" className={inputCls} autoFocus data-testid="input-room-name" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[11px] text-white/40 mb-1 block">Type</label>
              <select value={roomType} onChange={(e) => setRoomType(e.target.value as RoomType)} className={inputCls + " cursor-pointer"} data-testid="select-room-type">
                {ROOM_TYPES.map((t) => <option key={t} value={t}>{ROOM_TYPE_LABELS[t]}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[11px] text-white/40 mb-1 block">Default frequency</label>
              <select value={frequency} onChange={(e) => setFrequency(e.target.value as RentFrequency)} className={inputCls + " cursor-pointer"} data-testid="select-room-frequency">
                {RENT_FREQUENCIES.map((f) => <option key={f} value={f}>{RENT_FREQUENCY_LABELS[f]}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="text-[11px] text-white/40 mb-1 block">Default rent</label>
            <MoneyInput value={rent} onChange={setRent} data-testid="input-room-rent" />
          </div>
          <div>
            <label className="text-[11px] text-white/40 mb-1 block">Notes</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} className={inputCls + " min-h-[60px]"} />
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="rounded-xl px-4 py-2 text-sm text-white/50 hover:text-white/80">Cancel</button>
          <button
            onClick={() => mutation.mutate()}
            disabled={!name.trim() || mutation.isPending}
            className="inline-flex items-center gap-2 rounded-xl bg-blue-500/20 border border-blue-500/40 text-blue-200 px-4 py-2 text-sm font-medium hover:bg-blue-500/30 disabled:opacity-50"
            data-testid="button-save-room"
          >
            {mutation.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function HousesTab() {
  const { toast } = useToast();
  const { data: houses, isLoading } = useQuery<HouseWithRooms[]>({ queryKey: ["/api/admin/housing/houses"] });

  const [houseDialogOpen, setHouseDialogOpen] = useState(false);
  const [editingHouse, setEditingHouse] = useState<HouseWithRooms | undefined>(undefined);
  const [roomDialogHouse, setRoomDialogHouse] = useState<HouseWithRooms | null>(null);
  const [editingRoom, setEditingRoom] = useState<RoomRow | null>(null);
  const [deleteHouse, setDeleteHouse] = useState<HouseWithRooms | null>(null);
  const [deleteRoom, setDeleteRoom] = useState<RoomRow | null>(null);
  const [assignRoom, setAssignRoom] = useState<RoomRow | null>(null);

  const deleteHouseMut = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/admin/housing/houses/${id}`),
    onSuccess: async (res) => {
      const result = await res.json().catch(() => ({}));
      invalidateHousing();
      toast({ title: result.archived ? "House archived" : "House deleted", description: result.reason });
      setDeleteHouse(null);
    },
    onError: (e: unknown) => toast({ title: "Couldn't delete house", description: apiErrorMessage(e), variant: "destructive" }),
  });

  const deleteRoomMut = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/admin/housing/rooms/${id}`),
    onSuccess: async (res) => {
      const result = await res.json().catch(() => ({}));
      invalidateHousing();
      toast({ title: result.archived ? "Room archived" : "Room deleted", description: result.reason });
      setDeleteRoom(null);
    },
    onError: (e: unknown) => toast({ title: "Couldn't delete room", description: apiErrorMessage(e), variant: "destructive" }),
  });

  if (isLoading) return <HousesSkeleton />;
  const list = houses ?? [];

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button
          onClick={() => { setEditingHouse(undefined); setHouseDialogOpen(true); }}
          className="inline-flex items-center gap-2 rounded-xl bg-blue-500/15 border border-blue-500/30 text-blue-300 px-4 py-2 text-sm font-medium hover:bg-blue-500/25 transition-colors"
          data-testid="button-add-house"
        >
          <Plus className="w-4 h-4" /> Add house
        </button>
      </div>

      {list.length === 0 ? (
        <EmptyState icon={Home} title="No houses yet — add your first house." action={{ label: "Add a house", onClick: () => { setEditingHouse(undefined); setHouseDialogOpen(true); } }} />
      ) : (
        <div className="space-y-4">
          {list.map((h) => (
            <HouseCard
              key={h.id}
              house={h}
              onEditHouse={() => { setEditingHouse(h); setHouseDialogOpen(true); }}
              onDeleteHouse={() => setDeleteHouse(h)}
              onAddRoom={() => { setRoomDialogHouse(h); setEditingRoom(null); }}
              onEditRoom={(r) => { setRoomDialogHouse(h); setEditingRoom(r); }}
              onDeleteRoom={(r) => setDeleteRoom(r)}
              onAssignRoom={(r) => setAssignRoom(r)}
            />
          ))}
        </div>
      )}

      <HouseFormDialog open={houseDialogOpen} onOpenChange={setHouseDialogOpen} house={editingHouse} />

      {roomDialogHouse && (
        <RoomFormDialog
          key={editingRoom?.id ?? `new-${roomDialogHouse.id}`}
          houseId={roomDialogHouse.id}
          houseName={roomDialogHouse.name}
          room={editingRoom}
          onClose={() => { setRoomDialogHouse(null); setEditingRoom(null); }}
        />
      )}

      <ConfirmDialog
        open={!!deleteHouse}
        onOpenChange={(v) => { if (!v) setDeleteHouse(null); }}
        title={`Delete ${deleteHouse?.name ?? "this house"}?`}
        description="If it has ever had a tenant, it will be archived instead of deleted so the payment history stays on record."
        pending={deleteHouseMut.isPending}
        onConfirm={() => deleteHouse && deleteHouseMut.mutate(deleteHouse.id)}
      />
      <ConfirmDialog
        open={!!deleteRoom}
        onOpenChange={(v) => { if (!v) setDeleteRoom(null); }}
        title={`Delete ${deleteRoom?.name ?? "this room"}?`}
        description="If it has ever had a tenancy, it will be archived instead of deleted so rent history stays on record."
        pending={deleteRoomMut.isPending}
        onConfirm={() => deleteRoom && deleteRoomMut.mutate(deleteRoom.id)}
      />

      {assignRoom && (
        <AddTenancyDialog
          key={`assign-${assignRoom.id}`}
          houses={list}
          presetRoomId={assignRoom.id}
          onClose={() => setAssignRoom(null)}
        />
      )}
    </div>
  );
}

// ═══ TENANTS ═══════════════════════════════════════════════════════════════

function TenantsSkeleton() {
  return <Skeleton className="h-64 rounded-2xl bg-white/[0.04]" />;
}

const TENANT_FILTERS = ["active", "upcoming", "ended", "all"] as const;
type TenantFilter = (typeof TENANT_FILTERS)[number];

function AddTenancyDialog({ houses, presetRoomId, onClose }: {
  houses: HouseWithRooms[];
  presetRoomId: number | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const presetFound = presetRoomId != null ? findRoom(houses, String(presetRoomId)) : null;

  const [tenantMode, setTenantMode] = useState<"search" | "new">("search");
  const [q, setQ] = useState("");
  const debouncedQ = useDebouncedValue(q, 250);
  const [pickedContact, setPickedContact] = useState<{ id: number; name: string } | null>(null);
  const [newFirst, setNewFirst] = useState("");
  const [newLast, setNewLast] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newEmail, setNewEmail] = useState("");

  const [roomId, setRoomId] = useState<string>(presetRoomId ? String(presetRoomId) : "");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [rent, setRent] = useState(presetFound ? centsToDollarInput(presetFound.room.defaultRentCents) : "");
  const [rentTouched, setRentTouched] = useState(false);
  const [frequency, setFrequency] = useState<RentFrequency>(presetFound?.room.defaultRentFrequency ?? "weekly");
  const [bond, setBond] = useState("");

  const { data: searchResults = [], isFetching: searching } = useQuery<TenantSearchResult[]>({
    queryKey: ["/api/admin/housing/tenant-search", debouncedQ],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/admin/housing/tenant-search?q=${encodeURIComponent(debouncedQ)}`);
      return res.json();
    },
    enabled: tenantMode === "search" && debouncedQ.trim().length >= 2,
  });

  const createTenantMut = useMutation({
    mutationFn: (body: { firstName: string; lastName: string; phone: string; email: string | null }) =>
      apiRequest("POST", "/api/admin/housing/tenants", body).then((r) => r.json()),
  });

  const createTenancyMut = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiRequest("POST", "/api/admin/housing/tenancies", body),
    onSuccess: () => { invalidateHousing(); toast({ title: "Tenancy created" }); onClose(); },
    onError: (e: unknown) => toast({ title: "Couldn't create tenancy", description: apiErrorMessage(e), variant: "destructive" }),
  });

  const canSubmit =
    (tenantMode === "search" ? !!pickedContact : !!(newFirst.trim() && newLast.trim() && newPhone.trim())) &&
    !!roomId && !!startDate && rent.trim() !== "" && Number(rent) > 0;

  const submit = async () => {
    let contactId = pickedContact?.id ?? null;
    if (tenantMode === "new") {
      try {
        const created = await createTenantMut.mutateAsync({
          firstName: newFirst.trim(), lastName: newLast.trim(), phone: newPhone.trim(),
          email: newEmail.trim() || null,
        });
        contactId = created.id;
      } catch (e) {
        toast({ title: "Couldn't create tenant", description: apiErrorMessage(e), variant: "destructive" });
        return;
      }
    }
    if (!contactId) return;
    createTenancyMut.mutate({
      roomId: Number(roomId),
      contactId,
      startDate,
      endDate: endDate || null,
      rentCents: dollarInputToCents(rent),
      rentFrequency: frequency,
      bondCents: bond ? dollarInputToCents(bond) : 0,
    });
  };

  const busy = createTenantMut.isPending || createTenancyMut.isPending;

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-lg bg-[#0a0f1a] border border-white/10 text-white/90 max-h-[85vh] overflow-y-auto">
        <h2 className="text-base font-semibold mb-1">Add tenancy</h2>
        <p className="text-[12px] text-white/40 mb-3">Move a tenant into a room and set their rent.</p>

        <div className="space-y-3">
          <div>
            <div className="flex items-center gap-1 mb-2">
              <button
                onClick={() => setTenantMode("search")}
                className={`px-3 py-1.5 text-[12px] font-medium rounded-lg border transition-colors ${tenantMode === "search" ? "bg-blue-500/15 border-blue-500/30 text-blue-300" : "bg-white/[0.02] border-white/10 text-white/40"}`}
                data-testid="button-tenant-mode-search"
              >
                Find existing
              </button>
              <button
                onClick={() => setTenantMode("new")}
                className={`px-3 py-1.5 text-[12px] font-medium rounded-lg border transition-colors ${tenantMode === "new" ? "bg-blue-500/15 border-blue-500/30 text-blue-300" : "bg-white/[0.02] border-white/10 text-white/40"}`}
                data-testid="button-tenant-mode-new"
              >
                New tenant
              </button>
            </div>

            {tenantMode === "search" ? (
              pickedContact ? (
                <div className="flex items-center justify-between rounded-lg border border-blue-500/25 bg-blue-500/[0.06] px-3 py-2">
                  <span className="text-[13px] text-white/85">{pickedContact.name}</span>
                  <button onClick={() => setPickedContact(null)} className="text-white/40 hover:text-white/70" data-testid="button-clear-picked-tenant">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="relative">
                    <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-white/30" />
                    <input
                      value={q}
                      onChange={(e) => setQ(e.target.value)}
                      placeholder="Search by name or email…"
                      className={inputCls + " pl-8"}
                      data-testid="input-tenant-search"
                    />
                  </div>
                  {debouncedQ.trim().length >= 2 && (
                    <div className="rounded-lg border border-white/10 bg-white/[0.02] max-h-[160px] overflow-y-auto divide-y divide-white/[0.05]">
                      {searching ? (
                        <div className="p-3 text-[12px] text-white/30">Searching…</div>
                      ) : searchResults.length === 0 ? (
                        <div className="p-3 text-[12px] text-white/30">No matches — try "New tenant" instead.</div>
                      ) : (
                        searchResults.map((r) => (
                          <button
                            key={r.id}
                            onClick={() => setPickedContact({ id: r.id, name: `${r.firstName} ${r.lastName}`.trim() })}
                            className="w-full text-left px-3 py-2 text-[13px] text-white/80 hover:bg-white/[0.04]"
                            data-testid={`tenant-search-result-${r.id}`}
                          >
                            {r.firstName} {r.lastName} <span className="text-white/30 text-[11px]">{r.email || r.phone || ""}</span>
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>
              )
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <input value={newFirst} onChange={(e) => setNewFirst(e.target.value)} placeholder="First name *" className={inputCls} data-testid="input-new-tenant-first" />
                <input value={newLast} onChange={(e) => setNewLast(e.target.value)} placeholder="Last name *" className={inputCls} data-testid="input-new-tenant-last" />
                <input value={newPhone} onChange={(e) => setNewPhone(e.target.value)} placeholder="Phone *" className={inputCls} data-testid="input-new-tenant-phone" />
                <input value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="Email (optional)" className={inputCls} data-testid="input-new-tenant-email" />
              </div>
            )}
          </div>

          <div>
            <label className="text-[11px] text-white/40 mb-1 block">Room</label>
            <select
              value={roomId}
              onChange={(e) => {
                const v = e.target.value;
                setRoomId(v);
                if (!rentTouched) {
                  const found = findRoom(houses, v);
                  if (found) {
                    setRent(centsToDollarInput(found.room.defaultRentCents));
                    setFrequency(found.room.defaultRentFrequency);
                  }
                }
              }}
              className={inputCls + " cursor-pointer"}
              data-testid="select-tenancy-room"
            >
              <option value="">Select a room…</option>
              {houses.map((h) => (
                <optgroup key={h.id} label={h.name}>
                  {h.rooms.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} — {formatCurrency(r.defaultRentCents, { fromCents: true })}/{RENT_FREQUENCY_LABELS[r.defaultRentFrequency].toLowerCase()}{r.tenant ? " (occupied)" : ""}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[11px] text-white/40 mb-1 block">Start date</label>
              <DatePickerInput value={startDate} onChange={(e) => setStartDate(e.target.value)} data-testid="input-tenancy-start" />
            </div>
            <div>
              <label className="text-[11px] text-white/40 mb-1 block">End date (optional)</label>
              <DatePickerInput value={endDate} onChange={(e) => setEndDate(e.target.value)} min={startDate || undefined} data-testid="input-tenancy-end" />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="text-[11px] text-white/40 mb-1 block">Rent</label>
              <MoneyInput value={rent} onChange={(v) => { setRent(v); setRentTouched(true); }} data-testid="input-tenancy-rent" />
            </div>
            <div>
              <label className="text-[11px] text-white/40 mb-1 block">Frequency</label>
              <select value={frequency} onChange={(e) => setFrequency(e.target.value as RentFrequency)} className={inputCls + " cursor-pointer"} data-testid="select-tenancy-frequency">
                {RENT_FREQUENCIES.map((f) => <option key={f} value={f}>{RENT_FREQUENCY_LABELS[f]}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[11px] text-white/40 mb-1 block">Bond</label>
              <MoneyInput value={bond} onChange={setBond} placeholder="0.00" data-testid="input-tenancy-bond" />
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="rounded-xl px-4 py-2 text-sm text-white/50 hover:text-white/80">Cancel</button>
          <button
            onClick={submit}
            disabled={!canSubmit || busy}
            className="inline-flex items-center gap-2 rounded-xl bg-blue-500/20 border border-blue-500/40 text-blue-200 px-4 py-2 text-sm font-medium hover:bg-blue-500/30 disabled:opacity-50"
            data-testid="button-submit-tenancy"
          >
            {busy ? "Saving…" : "Add tenancy"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function EditTenancyDialog({ tenancy, onClose }: { tenancy: TenancyRow; onClose: () => void }) {
  const { toast } = useToast();
  const [startDate, setStartDate] = useState(tenancy.startDate);
  const [endDate, setEndDate] = useState(tenancy.endDate ?? "");
  const [rent, setRent] = useState(centsToDollarInput(tenancy.rentCents));
  const [frequency, setFrequency] = useState<RentFrequency>(tenancy.rentFrequency);
  const [bond, setBond] = useState(centsToDollarInput(tenancy.bondCents));
  const [bondReturnedOn, setBondReturnedOn] = useState(tenancy.bondReturnedOn ?? "");
  const [notes, setNotes] = useState(tenancy.notes ?? "");

  const mutation = useMutation({
    mutationFn: () => apiRequest("PATCH", `/api/admin/housing/tenancies/${tenancy.id}`, {
      startDate,
      endDate: endDate || null,
      rentCents: dollarInputToCents(rent || "0"),
      rentFrequency: frequency,
      bondCents: dollarInputToCents(bond || "0"),
      bondReturnedOn: bondReturnedOn || null,
      notes: notes.trim() || null,
    }),
    onSuccess: () => { invalidateHousing(); toast({ title: "Tenancy updated" }); onClose(); },
    onError: (e: unknown) => toast({ title: "Couldn't save tenancy", description: apiErrorMessage(e), variant: "destructive" }),
  });

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-md bg-[#0a0f1a] border border-white/10 text-white/90 max-h-[85vh] overflow-y-auto">
        <h2 className="text-base font-semibold mb-1">Edit tenancy</h2>
        <p className="text-[12px] text-white/40 mb-3">{tenancy.tenant.name} — {tenancy.house.name} · {tenancy.room.name}</p>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[11px] text-white/40 mb-1 block">Start date</label>
              <DatePickerInput value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div>
              <label className="text-[11px] text-white/40 mb-1 block">End date</label>
              <DatePickerInput value={endDate} onChange={(e) => setEndDate(e.target.value)} min={startDate} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[11px] text-white/40 mb-1 block">Rent</label>
              <MoneyInput value={rent} onChange={setRent} />
            </div>
            <div>
              <label className="text-[11px] text-white/40 mb-1 block">Frequency</label>
              <select value={frequency} onChange={(e) => setFrequency(e.target.value as RentFrequency)} className={inputCls + " cursor-pointer"}>
                {RENT_FREQUENCIES.map((f) => <option key={f} value={f}>{RENT_FREQUENCY_LABELS[f]}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[11px] text-white/40 mb-1 block">Bond</label>
              <MoneyInput value={bond} onChange={setBond} />
            </div>
            <div>
              <label className="text-[11px] text-white/40 mb-1 block">Bond returned</label>
              <DatePickerInput value={bondReturnedOn} onChange={(e) => setBondReturnedOn(e.target.value)} />
            </div>
          </div>
          <div>
            <label className="text-[11px] text-white/40 mb-1 block">Notes</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} className={inputCls + " min-h-[60px]"} />
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="rounded-xl px-4 py-2 text-sm text-white/50 hover:text-white/80">Cancel</button>
          <button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
            className="inline-flex items-center gap-2 rounded-xl bg-blue-500/20 border border-blue-500/40 text-blue-200 px-4 py-2 text-sm font-medium hover:bg-blue-500/30 disabled:opacity-50"
            data-testid="button-save-tenancy-edit"
          >
            {mutation.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function EndTenancyDialog({ tenancy, onClose }: { tenancy: TenancyRow; onClose: () => void }) {
  const { toast } = useToast();
  const [endDate, setEndDate] = useState(tenancy.endDate ?? "");

  const mutation = useMutation({
    mutationFn: () => apiRequest("PATCH", `/api/admin/housing/tenancies/${tenancy.id}`, { endDate: endDate || null }),
    onSuccess: () => { invalidateHousing(); toast({ title: "Tenancy ended" }); onClose(); },
    onError: (e: unknown) => toast({ title: "Couldn't end tenancy", description: apiErrorMessage(e), variant: "destructive" }),
  });

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-sm bg-[#0a0f1a] border border-white/10 text-white/90">
        <h2 className="text-base font-semibold mb-1 flex items-center gap-2"><LogOut className="w-4 h-4 text-amber-400" /> End tenancy</h2>
        <p className="text-[12px] text-white/40 mb-3">{tenancy.tenant.name} — {tenancy.house.name} · {tenancy.room.name}</p>
        <label className="text-[11px] text-white/40 mb-1 block">Last night (end date)</label>
        <DatePickerInput value={endDate} onChange={(e) => setEndDate(e.target.value)} min={tenancy.startDate} data-testid="input-end-tenancy-date" />
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="rounded-xl px-4 py-2 text-sm text-white/50 hover:text-white/80">Cancel</button>
          <button
            onClick={() => mutation.mutate()}
            disabled={!endDate || mutation.isPending}
            className="inline-flex items-center gap-2 rounded-xl bg-amber-500/20 border border-amber-500/40 text-amber-200 px-4 py-2 text-sm font-medium hover:bg-amber-500/30 disabled:opacity-50"
            data-testid="button-confirm-end-tenancy"
          >
            {mutation.isPending ? "Saving…" : "End tenancy"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TenantsTab() {
  const { toast } = useToast();
  const [filter, setFilter] = useState<TenantFilter>("active");
  const [addOpen, setAddOpen] = useState(false);
  const [editTenancy, setEditTenancy] = useState<TenancyRow | null>(null);
  const [endTenancy, setEndTenancy] = useState<TenancyRow | null>(null);
  const [deleteTenancy, setDeleteTenancy] = useState<TenancyRow | null>(null);

  const { data: tenancies, isLoading } = useQuery<TenancyRow[]>({ queryKey: ["/api/admin/housing/tenancies"] });
  const { data: houses } = useQuery<HouseWithRooms[]>({ queryKey: ["/api/admin/housing/houses"] });

  const genScheduleMut = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/admin/housing/tenancies/${id}/charges`, {}).then((r) => r.json()),
    onSuccess: (result: { created: number; skipped: number; total: number; horizon: string }) => {
      invalidateHousing();
      toast({
        title: result.created > 0 ? `${result.created} rent charge${result.created === 1 ? "" : "s"} generated` : "Already up to date",
        description: `Through ${fmtNZDate(result.horizon)}${result.skipped ? ` · ${result.skipped} already existed` : ""}`,
      });
    },
    onError: (e: unknown) => toast({ title: "Couldn't generate schedule", description: apiErrorMessage(e), variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/admin/housing/tenancies/${id}`),
    onSuccess: () => { invalidateHousing(); toast({ title: "Tenancy deleted" }); setDeleteTenancy(null); },
    onError: (e: unknown) => toast({ title: "Couldn't delete tenancy", description: apiErrorMessage(e), variant: "destructive" }),
  });

  if (isLoading) return <TenantsSkeleton />;

  const list = tenancies ?? [];
  const filtered = filter === "all" ? list : list.filter((t) => t.state === filter);
  const counts: Record<TenantFilter, number> = {
    active: list.filter((t) => t.state === "active").length,
    upcoming: list.filter((t) => t.state === "upcoming").length,
    ended: list.filter((t) => t.state === "ended").length,
    all: list.length,
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-1.5 flex-wrap">
          {TENANT_FILTERS.map((f) => {
            const active = filter === f;
            return (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-3 py-1.5 rounded-lg border text-[12px] font-medium transition-colors min-h-[36px] ${active ? "bg-blue-500/15 border-blue-500/30 text-blue-300" : "bg-white/[0.02] border-white/10 text-white/40 hover:text-white/60"}`}
                data-testid={`filter-${f}`}
              >
                {f === "all" ? "All" : f[0].toUpperCase() + f.slice(1)} <span className="opacity-60">{counts[f]}</span>
              </button>
            );
          })}
        </div>
        <button
          onClick={() => setAddOpen(true)}
          className="inline-flex items-center gap-2 rounded-xl bg-blue-500/15 border border-blue-500/30 text-blue-300 px-4 py-2 text-sm font-medium hover:bg-blue-500/25"
          data-testid="button-add-tenancy"
        >
          <UserPlus className="w-4 h-4" /> Add tenancy
        </button>
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon={Users} title={list.length === 0 ? "No tenancies yet." : "Nothing matches this filter."} />
      ) : (
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] overflow-x-auto">
          <table className="w-full text-left text-[13px] min-w-[860px]">
            <thead>
              <tr className="border-b border-white/[0.06] text-[11px] uppercase tracking-wide text-white/35">
                <th className="px-4 py-2.5 font-medium">Tenant</th>
                <th className="px-4 py-2.5 font-medium">House / room</th>
                <th className="px-4 py-2.5 font-medium">Rent</th>
                <th className="px-4 py-2.5 font-medium">Start</th>
                <th className="px-4 py-2.5 font-medium">End</th>
                <th className="px-4 py-2.5 font-medium">State</th>
                <th className="px-4 py-2.5 font-medium">Owing</th>
                <th className="px-4 py-2.5 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.05]">
              {filtered.map((t) => (
                <tr key={t.id} data-testid={`row-tenancy-${t.id}`}>
                  <td className="px-4 py-3">
                    <div className="text-white/85 font-medium">{t.tenant.name}</div>
                    <div className="text-[11px] text-white/35">{t.tenant.phone || "—"}</div>
                  </td>
                  <td className="px-4 py-3 text-white/70">{t.house.name} · {t.room.name}</td>
                  <td className="px-4 py-3 text-white/70">
                    {formatCurrency(t.rentCents, { fromCents: true })} <span className="text-white/35">{RENT_FREQUENCY_LABELS[t.rentFrequency]}</span>
                  </td>
                  <td className="px-4 py-3 text-white/60">{fmtNZDate(t.startDate)}</td>
                  <td className="px-4 py-3 text-white/60">{t.endDate ? fmtNZDate(t.endDate) : "Ongoing"}</td>
                  <td className="px-4 py-3"><TenancyStatePill state={t.state} /></td>
                  <td className="px-4 py-3">
                    {t.charges.overdueCents > 0
                      ? <span className="text-red-300 font-medium">{formatCurrency(t.charges.overdueCents, { fromCents: true })}</span>
                      : <span className="text-white/30">$0.00</span>}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => genScheduleMut.mutate(t.id)} disabled={genScheduleMut.isPending} title="Generate rent schedule" className="w-8 h-8 rounded-lg flex items-center justify-center text-white/30 hover:text-blue-400 hover:bg-white/[0.06]" data-testid={`button-generate-${t.id}`}>
                        <Receipt className="w-3.5 h-3.5" />
                      </button>
                      {t.state !== "ended" && (
                        <button onClick={() => setEndTenancy(t)} title="End tenancy" className="w-8 h-8 rounded-lg flex items-center justify-center text-white/30 hover:text-amber-400 hover:bg-white/[0.06]" data-testid={`button-end-${t.id}`}>
                          <LogOut className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <button onClick={() => setEditTenancy(t)} title="Edit" className="w-8 h-8 rounded-lg flex items-center justify-center text-white/30 hover:text-white/70 hover:bg-white/[0.06]" data-testid={`button-edit-tenancy-${t.id}`}>
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => setDeleteTenancy(t)} title="Delete" className="w-8 h-8 rounded-lg flex items-center justify-center text-white/30 hover:text-red-400 hover:bg-white/[0.06]" data-testid={`button-delete-tenancy-${t.id}`}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {addOpen && <AddTenancyDialog houses={houses ?? []} presetRoomId={null} onClose={() => setAddOpen(false)} />}
      {editTenancy && <EditTenancyDialog key={editTenancy.id} tenancy={editTenancy} onClose={() => setEditTenancy(null)} />}
      {endTenancy && <EndTenancyDialog key={endTenancy.id} tenancy={endTenancy} onClose={() => setEndTenancy(null)} />}
      <ConfirmDialog
        open={!!deleteTenancy}
        onOpenChange={(v) => { if (!v) setDeleteTenancy(null); }}
        title={`Delete ${deleteTenancy?.tenant.name ?? "this"}'s tenancy?`}
        description="This can't be undone. If any rent has been recorded as paid, deletion is blocked — end the tenancy instead."
        pending={deleteMut.isPending}
        onConfirm={() => deleteTenancy && deleteMut.mutate(deleteTenancy.id)}
      />
    </div>
  );
}

// ═══ UTILITIES ═══════════════════════════════════════════════════════════════

function UtilitiesSkeleton() {
  return (
    <div className="space-y-4">
      {[1, 2].map((i) => <Skeleton key={i} className="h-32 rounded-2xl bg-white/[0.04]" />)}
    </div>
  );
}

function UtilityAccountFormDialog({ open, onOpenChange, account, houses }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  account: UtilityAccountRow | undefined;
  houses: HouseWithRooms[];
}) {
  const { toast } = useToast();
  const isEdit = !!account;
  const [houseId, setHouseId] = useState("");
  const [kind, setKind] = useState<UtilityKind>("power");
  const [provider, setProvider] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [billingFrequency, setBillingFrequency] = useState("monthly");
  const [expected, setExpected] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (!open) return;
    setHouseId(account ? String(account.houseId) : (houses[0] ? String(houses[0].id) : ""));
    setKind(account?.kind ?? "power");
    setProvider(account?.provider ?? "");
    setAccountNumber(account?.accountNumber ?? "");
    setBillingFrequency(account?.billingFrequency ?? "monthly");
    setExpected(centsToDollarInput(account?.expectedAmountCents ?? 0));
    setNotes(account?.notes ?? "");
  }, [open, account, houses]);

  const mutation = useMutation({
    mutationFn: () => {
      const body = {
        houseId: Number(houseId), kind, provider: provider.trim() || null,
        accountNumber: accountNumber.trim() || null, billingFrequency,
        expectedAmountCents: dollarInputToCents(expected || "0"), notes: notes.trim() || null,
      };
      return isEdit && account
        ? apiRequest("PATCH", `/api/admin/housing/utilities/${account.id}`, body)
        : apiRequest("POST", "/api/admin/housing/utilities", body);
    },
    onSuccess: () => { invalidateHousing(); toast({ title: isEdit ? "Account updated" : "Account added" }); onOpenChange(false); },
    onError: (e: unknown) => toast({ title: "Couldn't save account", description: apiErrorMessage(e), variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md bg-[#0a0f1a] border border-white/10 text-white/90">
        <h2 className="text-base font-semibold mb-3">{isEdit ? "Edit utility account" : "Add utility account"}</h2>
        <div className="space-y-3">
          {!isEdit && (
            <div>
              <label className="text-[11px] text-white/40 mb-1 block">House *</label>
              <select value={houseId} onChange={(e) => setHouseId(e.target.value)} className={inputCls + " cursor-pointer"} data-testid="select-utility-house">
                <option value="">Select a house…</option>
                {houses.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
              </select>
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[11px] text-white/40 mb-1 block">Type</label>
              <select value={kind} onChange={(e) => setKind(e.target.value as UtilityKind)} className={inputCls + " cursor-pointer"} data-testid="select-utility-kind">
                {UTILITY_KINDS.map((k) => <option key={k} value={k}>{UTILITY_KIND_LABELS[k]}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[11px] text-white/40 mb-1 block">Billing frequency</label>
              <select value={billingFrequency} onChange={(e) => setBillingFrequency(e.target.value)} className={inputCls + " cursor-pointer"} data-testid="select-utility-billing-frequency">
                {BILLING_FREQUENCIES.map((f) => <option key={f} value={f}>{f[0].toUpperCase() + f.slice(1)}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[11px] text-white/40 mb-1 block">Provider</label>
              <input value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="e.g. Contact Energy" className={inputCls} data-testid="input-utility-provider" />
            </div>
            <div>
              <label className="text-[11px] text-white/40 mb-1 block">Account number</label>
              <input value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} className={inputCls} data-testid="input-utility-account-number" />
            </div>
          </div>
          <div>
            <label className="text-[11px] text-white/40 mb-1 block">Expected amount</label>
            <MoneyInput value={expected} onChange={setExpected} data-testid="input-utility-expected" />
          </div>
          <div>
            <label className="text-[11px] text-white/40 mb-1 block">Notes</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} className={inputCls + " min-h-[60px]"} />
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={() => onOpenChange(false)} className="rounded-xl px-4 py-2 text-sm text-white/50 hover:text-white/80">Cancel</button>
          <button
            onClick={() => mutation.mutate()}
            disabled={(!isEdit && !houseId) || mutation.isPending}
            className="inline-flex items-center gap-2 rounded-xl bg-blue-500/20 border border-blue-500/40 text-blue-200 px-4 py-2 text-sm font-medium hover:bg-blue-500/30 disabled:opacity-50"
            data-testid="button-save-utility"
          >
            {mutation.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AddBillDialog({ account, onClose }: { account: UtilityAccountRow; onClose: () => void }) {
  const { toast } = useToast();
  const [dueOn, setDueOn] = useState("");
  const [amount, setAmount] = useState(centsToDollarInput(account.expectedAmountCents));
  const [periodLabel, setPeriodLabel] = useState("");
  const [notes, setNotes] = useState("");

  const mutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/admin/housing/bills", {
      utilityAccountId: account.id, dueOn, amountCents: dollarInputToCents(amount || "0"),
      periodLabel: periodLabel.trim() || null, notes: notes.trim() || null,
    }),
    onSuccess: () => { invalidateHousing(); toast({ title: "Bill added" }); onClose(); },
    onError: (e: unknown) => toast({ title: "Couldn't add bill", description: apiErrorMessage(e), variant: "destructive" }),
  });

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-sm bg-[#0a0f1a] border border-white/10 text-white/90">
        <h2 className="text-base font-semibold mb-1">Add bill</h2>
        <p className="text-[12px] text-white/40 mb-3">{UTILITY_KIND_LABELS[account.kind]} · {account.house.name}</p>
        <div className="space-y-3">
          <div>
            <label className="text-[11px] text-white/40 mb-1 block">Due date *</label>
            <DatePickerInput value={dueOn} onChange={(e) => setDueOn(e.target.value)} data-testid="input-bill-due" />
          </div>
          <div>
            <label className="text-[11px] text-white/40 mb-1 block">Amount *</label>
            <MoneyInput value={amount} onChange={setAmount} data-testid="input-bill-amount" />
          </div>
          <div>
            <label className="text-[11px] text-white/40 mb-1 block">Period (optional)</label>
            <input value={periodLabel} onChange={(e) => setPeriodLabel(e.target.value)} placeholder="e.g. June 2026" className={inputCls} data-testid="input-bill-period" />
          </div>
          <div>
            <label className="text-[11px] text-white/40 mb-1 block">Notes</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} className={inputCls + " min-h-[50px]"} />
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="rounded-xl px-4 py-2 text-sm text-white/50 hover:text-white/80">Cancel</button>
          <button
            onClick={() => mutation.mutate()}
            disabled={!dueOn || !amount || mutation.isPending}
            className="inline-flex items-center gap-2 rounded-xl bg-blue-500/20 border border-blue-500/40 text-blue-200 px-4 py-2 text-sm font-medium hover:bg-blue-500/30 disabled:opacity-50"
            data-testid="button-save-bill"
          >
            {mutation.isPending ? "Saving…" : "Add bill"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function UtilitiesTab() {
  const { toast } = useToast();
  const { data: accounts, isLoading: loadingAccounts } = useQuery<UtilityAccountRow[]>({ queryKey: ["/api/admin/housing/utilities"] });
  const { data: houses } = useQuery<HouseWithRooms[]>({ queryKey: ["/api/admin/housing/houses"] });
  const { data: billsData, isLoading: loadingBills } = useQuery<{ today: string; bills: BillRow[] }>({ queryKey: ["/api/admin/housing/bills"] });

  const [accountDialogOpen, setAccountDialogOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<UtilityAccountRow | undefined>(undefined);
  const [billDialogAccount, setBillDialogAccount] = useState<UtilityAccountRow | null>(null);
  const [deleteAccount, setDeleteAccount] = useState<UtilityAccountRow | null>(null);
  const [deleteBill, setDeleteBill] = useState<BillRow | null>(null);

  const today = billsData?.today ?? "";

  const markPaidMut = useMutation({
    mutationFn: (id: number) => apiRequest("PATCH", `/api/admin/housing/bills/${id}`, { paidOn: today }),
    onSuccess: () => { invalidateHousing(); toast({ title: "Bill marked paid" }); },
    onError: (e: unknown) => toast({ title: "Couldn't mark paid", description: apiErrorMessage(e), variant: "destructive" }),
  });
  const unmarkMut = useMutation({
    mutationFn: (id: number) => apiRequest("PATCH", `/api/admin/housing/bills/${id}`, { paidOn: null }),
    onSuccess: () => { invalidateHousing(); toast({ title: "Payment un-marked" }); },
    onError: (e: unknown) => toast({ title: "Couldn't un-mark", description: apiErrorMessage(e), variant: "destructive" }),
  });
  const waiveMut = useMutation({
    mutationFn: ({ id, waived }: { id: number; waived: boolean }) => apiRequest("PATCH", `/api/admin/housing/bills/${id}`, { waived }),
    onSuccess: (_d, vars) => { invalidateHousing(); toast({ title: vars.waived ? "Bill waived" : "Waiver removed" }); },
    onError: (e: unknown) => toast({ title: "Couldn't update", description: apiErrorMessage(e), variant: "destructive" }),
  });
  const deleteAccountMut = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/admin/housing/utilities/${id}`),
    onSuccess: async (res) => {
      const result = await res.json().catch(() => ({}));
      invalidateHousing();
      toast({ title: result.archived ? "Account archived" : "Account deleted", description: result.reason });
      setDeleteAccount(null);
    },
    onError: (e: unknown) => toast({ title: "Couldn't delete account", description: apiErrorMessage(e), variant: "destructive" }),
  });
  const deleteBillMut = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/admin/housing/bills/${id}`),
    onSuccess: () => { invalidateHousing(); toast({ title: "Bill deleted" }); setDeleteBill(null); },
    onError: (e: unknown) => toast({ title: "Couldn't delete bill", description: apiErrorMessage(e), variant: "destructive" }),
  });

  const grouped = useMemo(() => {
    const map = new Map<number, { house: { id: number; name: string }; accounts: UtilityAccountRow[] }>();
    for (const a of accounts ?? []) {
      if (!map.has(a.house.id)) map.set(a.house.id, { house: a.house, accounts: [] });
      map.get(a.house.id)!.accounts.push(a);
    }
    return Array.from(map.values()).sort((x, y) => x.house.name.localeCompare(y.house.name));
  }, [accounts]);

  if (loadingAccounts || loadingBills) return <UtilitiesSkeleton />;

  const bills = billsData?.bills ?? [];

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <button
          onClick={() => { setEditingAccount(undefined); setAccountDialogOpen(true); }}
          className="inline-flex items-center gap-2 rounded-xl bg-blue-500/15 border border-blue-500/30 text-blue-300 px-4 py-2 text-sm font-medium hover:bg-blue-500/25"
          data-testid="button-add-utility"
        >
          <Plus className="w-4 h-4" /> Add account
        </button>
      </div>

      {grouped.length === 0 ? (
        <EmptyState icon={Zap} title="No utility accounts yet." />
      ) : (
        <div className="space-y-4">
          {grouped.map((g) => (
            <div key={g.house.id} className="rounded-2xl border border-white/[0.06] bg-white/[0.02] overflow-hidden" data-testid={`utility-house-${g.house.id}`}>
              <div className="px-4 py-2.5 border-b border-white/[0.06] text-[13px] font-semibold text-white/70">{g.house.name}</div>
              <div className="divide-y divide-white/[0.05]">
                {g.accounts.map((a) => (
                  <div key={a.id} className="flex items-center gap-3 px-4 py-3 flex-wrap sm:flex-nowrap" data-testid={`utility-account-${a.id}`}>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[13px] font-medium text-white/85">{UTILITY_KIND_LABELS[a.kind]}</span>
                        {a.provider && <span className="text-[12px] text-white/40">{a.provider}</span>}
                        {a.accountNumber && <span className="text-[11px] text-white/25">#{a.accountNumber}</span>}
                      </div>
                      <div className="text-[11px] text-white/35 mt-0.5">
                        Expected {formatCurrency(a.expectedAmountCents, { fromCents: true })} · {a.billingFrequency}
                        {a.bills.overdue > 0 && (
                          <span className="text-red-400"> · {a.bills.overdue} overdue ({formatCurrency(a.bills.overdueCents, { fromCents: true })})</span>
                        )}
                      </div>
                    </div>
                    <div className="text-right">
                      {a.nextDue ? (
                        <>
                          <div className="text-[12px] text-white/60">Next due {fmtNZDate(a.nextDue.dueOn)}</div>
                          <PaymentStatePill state={a.nextDue.state} />
                        </>
                      ) : (
                        <span className="text-[11px] text-white/25">No bills yet</span>
                      )}
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button onClick={() => setBillDialogAccount(a)} title="Add bill" className="w-8 h-8 rounded-lg flex items-center justify-center text-white/30 hover:text-emerald-400 hover:bg-white/[0.06]" data-testid={`button-add-bill-${a.id}`}>
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => { setEditingAccount(a); setAccountDialogOpen(true); }} title="Edit" className="w-8 h-8 rounded-lg flex items-center justify-center text-white/30 hover:text-white/70 hover:bg-white/[0.06]" data-testid={`button-edit-utility-${a.id}`}>
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => setDeleteAccount(a)} title="Delete" className="w-8 h-8 rounded-lg flex items-center justify-center text-white/30 hover:text-red-400 hover:bg-white/[0.06]" data-testid={`button-delete-utility-${a.id}`}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <div>
        <h2 className="text-[13px] font-semibold text-white/60 mb-2">Bills</h2>
        {bills.length === 0 ? (
          <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] py-10 text-center text-[13px] text-white/40">No bills recorded yet.</div>
        ) : (
          <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] overflow-x-auto">
            <table className="w-full text-left text-[13px] min-w-[780px]">
              <thead>
                <tr className="border-b border-white/[0.06] text-[11px] uppercase tracking-wide text-white/35">
                  <th className="px-4 py-2.5 font-medium">House</th>
                  <th className="px-4 py-2.5 font-medium">Utility</th>
                  <th className="px-4 py-2.5 font-medium">Period</th>
                  <th className="px-4 py-2.5 font-medium">Due</th>
                  <th className="px-4 py-2.5 font-medium">Amount</th>
                  <th className="px-4 py-2.5 font-medium">State</th>
                  <th className="px-4 py-2.5 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.05]">
                {bills.map((b) => (
                  <tr key={b.id} data-testid={`row-bill-${b.id}`}>
                    <td className="px-4 py-3 text-white/70">{b.house.name}</td>
                    <td className="px-4 py-3 text-white/70">{UTILITY_KIND_LABELS[b.account.kind]}{b.account.provider ? ` · ${b.account.provider}` : ""}</td>
                    <td className="px-4 py-3 text-white/50">{b.periodLabel || "—"}</td>
                    <td className="px-4 py-3 text-white/60">
                      {fmtNZDate(b.dueOn)}
                      {b.state === "overdue" && <span className="text-red-400 text-[11px]"> · {b.daysOverdue}d overdue</span>}
                    </td>
                    <td className="px-4 py-3 text-white/70">{formatCurrency(b.amountCents, { fromCents: true })}</td>
                    <td className="px-4 py-3"><PaymentStatePill state={b.state} /></td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        {b.paidOn ? (
                          <button onClick={() => unmarkMut.mutate(b.id)} disabled={unmarkMut.isPending} title="Un-mark paid" className="w-8 h-8 rounded-lg flex items-center justify-center text-white/30 hover:text-amber-400 hover:bg-white/[0.06]" data-testid={`button-unmark-${b.id}`}>
                            <Undo2 className="w-3.5 h-3.5" />
                          </button>
                        ) : (
                          <button onClick={() => markPaidMut.mutate(b.id)} disabled={markPaidMut.isPending} title="Mark paid" className="w-8 h-8 rounded-lg flex items-center justify-center text-white/30 hover:text-emerald-400 hover:bg-white/[0.06]" data-testid={`button-mark-paid-bill-${b.id}`}>
                            <Check className="w-3.5 h-3.5" />
                          </button>
                        )}
                        <button
                          onClick={() => waiveMut.mutate({ id: b.id, waived: !b.waived })}
                          disabled={waiveMut.isPending}
                          title={b.waived ? "Remove waiver" : "Waive"}
                          className={`w-8 h-8 rounded-lg flex items-center justify-center hover:bg-white/[0.06] ${b.waived ? "text-purple-300" : "text-white/30 hover:text-purple-300"}`}
                          data-testid={`button-waive-${b.id}`}
                        >
                          <Ban className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={() => setDeleteBill(b)} title="Delete" className="w-8 h-8 rounded-lg flex items-center justify-center text-white/30 hover:text-red-400 hover:bg-white/[0.06]" data-testid={`button-delete-bill-${b.id}`}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <UtilityAccountFormDialog open={accountDialogOpen} onOpenChange={setAccountDialogOpen} account={editingAccount} houses={houses ?? []} />
      {billDialogAccount && <AddBillDialog key={billDialogAccount.id} account={billDialogAccount} onClose={() => setBillDialogAccount(null)} />}
      <ConfirmDialog
        open={!!deleteAccount}
        onOpenChange={(v) => { if (!v) setDeleteAccount(null); }}
        title={`Delete this ${deleteAccount ? UTILITY_KIND_LABELS[deleteAccount.kind] : ""} account?`}
        description="If it has any bills recorded, it will be archived instead of deleted so the payment history stays on record."
        pending={deleteAccountMut.isPending}
        onConfirm={() => deleteAccount && deleteAccountMut.mutate(deleteAccount.id)}
      />
      <ConfirmDialog
        open={!!deleteBill}
        onOpenChange={(v) => { if (!v) setDeleteBill(null); }}
        title="Delete this bill?"
        description="This can't be undone."
        pending={deleteBillMut.isPending}
        onConfirm={() => deleteBill && deleteBillMut.mutate(deleteBill.id)}
      />
    </div>
  );
}

// ═══ PAGE SHELL ═══════════════════════════════════════════════════════════════

export default function VenueHousing() {
  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Home className="w-6 h-6 text-white/40" />
        <div>
          <h1 className="text-2xl font-bold text-white" data-testid="text-venue-housing-title">Housing</h1>
          <p className="text-sm text-white/40">Rooms, tenants, rent and utility bills for the residency houses</p>
        </div>
      </div>

      <Tabs defaultValue="overview" className="w-full">
        {/* Four labels do not fit on a 390px phone in one row — the fourth was
            being clipped at the screen edge with no hint that it was there. Two
            rows on a phone, one row from `sm` up. */}
        <TabsList
          className="grid h-auto w-full grid-cols-2 gap-1 sm:inline-flex sm:h-10 sm:w-auto sm:justify-start sm:gap-0"
          data-testid="housing-tabs"
        >
          <TabsTrigger value="overview" className="min-h-[44px] sm:min-h-0" data-testid="tab-overview">Overview</TabsTrigger>
          <TabsTrigger value="houses" className="min-h-[44px] sm:min-h-0" data-testid="tab-houses">Houses &amp; rooms</TabsTrigger>
          <TabsTrigger value="tenants" className="min-h-[44px] sm:min-h-0" data-testid="tab-tenants">Tenants</TabsTrigger>
          <TabsTrigger value="utilities" className="min-h-[44px] sm:min-h-0" data-testid="tab-utilities">Utilities</TabsTrigger>
        </TabsList>
        <TabsContent value="overview"><OverviewTab /></TabsContent>
        <TabsContent value="houses"><HousesTab /></TabsContent>
        <TabsContent value="tenants"><TenantsTab /></TabsContent>
        <TabsContent value="utilities"><UtilitiesTab /></TabsContent>
      </Tabs>
    </div>
  );
}
