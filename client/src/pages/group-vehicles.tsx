// ─────────────────────────────────────────────────────────────────────────────
// VEHICLES — company-vehicle fleet register. United Sports Group workspace,
// super-admin only (see server/vehicles-routes.ts: "vehicles" is a
// SUPER_ADMIN_ONLY_TAB, checked before the usual admin/manager escalation).
//
// A list of vehicles (stat chips that double as filters, sorted so problems
// float to the top) → a create/edit dialog → a per-vehicle detail dialog with
// four child collections (assignments / insurance / servicing / costs).
//
// All compliance-status maths (WOF/COF/rego/RUC/insurance/service → one
// ok|due_soon|expired|unknown per vehicle) is computed server-side by
// @shared/vehicles and shipped down ready-to-render — this file never
// recomputes a status, it only colours and labels the ones it's given.
//
// Hard rule inherited from @shared/vehicles: every date here is a calendar
// date ("2026-07-17"), never round-tripped through `new Date()` to display —
// that bug already shipped once on the invoice page (due-the-17th printed as
// "18 July"). `formatNzDate` below splits the string instead. Any "N days"
// maths uses `today` from the API response, never the browser clock.
//
// House style copied from group-hiring.tsx / feedback.tsx: stat chips that
// filter, a shadcn Dialog for create/edit, inline <select> mutations,
// dark-glass Tailwind, page-local types mirroring the server response.
// ─────────────────────────────────────────────────────────────────────────────

import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { MoneyInput } from "@/components/ui/money-input";
import { centsToDollarInput, dollarInputToCents, formatCurrency, formatNumber } from "@/lib/format";
import {
  Car, Plus, Search, Trash2, Pencil, Check, AlertTriangle, Wrench,
  Wallet, Users, ShieldCheck,
} from "lucide-react";
import {
  VEHICLE_TYPES, FUEL_TYPES, VEHICLE_STATUSES, OWNERSHIP_TYPES, COMPLIANCE_TYPES,
  INSURANCE_COVER_TYPES, SERVICE_TYPES, COST_CATEGORIES, FBT_EXEMPTIONS,
  suggestRucRequired, suggestComplianceType, daysUntil,
  type VehicleType, type FuelType, type VehicleStatus, type OwnershipType,
  type ComplianceType, type InsuranceCoverType, type ServiceType, type CostCategory,
  type FbtExemption, type ExpiryStatus, type VehicleCompliance,
} from "@shared/vehicles";

// ── Types (mirror server/vehicles-routes.ts response shapes) ────────────────
interface VehicleHolderSummary {
  id: number;
  name: string;
  since: string;
  userId: number | null;
}

interface VehicleRow {
  id: number;
  organizationId: number;
  plate: string;
  make: string;
  model: string;
  variant: string | null;
  year: number | null;
  colour: string | null;
  vin: string | null;
  engineNumber: string | null;
  vehicleType: VehicleType;
  fuelType: FuelType;
  transmission: string | null;
  seats: number | null;
  odometerKm: number | null;
  odometerAt: string | null;
  complianceType: ComplianceType;
  wofExpiresOn: string | null;
  cofExpiresOn: string | null;
  regoExpiresOn: string | null;
  rucRequired: boolean;
  rucValidToKm: number | null;
  ownership: OwnershipType;
  lessor: string | null;
  leaseEndsOn: string | null;
  leaseMonthlyCents: number | null;
  purchasedOn: string | null;
  purchasePriceCents: number | null;
  supplier: string | null;
  disposedOn: string | null;
  disposalPriceCents: number | null;
  status: VehicleStatus;
  nextServiceDueOn: string | null;
  nextServiceDueKm: number | null;
  fbtPrivateUse: boolean;
  fbtExemption: FbtExemption;
  fbtNotes: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: number | null;
  compliance: VehicleCompliance;
  holder: VehicleHolderSummary | null;
}

interface Summary {
  total: number;
  active: number;
  expired: number;
  dueSoon: number;
  unknown: number;
  unassigned: number;
}

interface VehiclesListResponse {
  vehicles: VehicleRow[];
  summary: Summary;
  today: string;
}

interface Assignment {
  id: number;
  vehicleId: number;
  organizationId: number;
  holderUserId: number | null;
  holderName: string;
  holderEmail: string | null;
  holderPhone: string | null;
  licenceClass: string | null;
  licenceExpiresOn: string | null;
  assignedOn: string;
  returnedOn: string | null;
  odometerStartKm: number | null;
  odometerEndKm: number | null;
  purpose: string | null;
  notes: string | null;
}

interface InsurancePolicy {
  id: number;
  vehicleId: number;
  organizationId: number;
  insurer: string;
  policyNumber: string;
  coverType: InsuranceCoverType;
  startsOn: string;
  expiresOn: string;
  excessCents: number | null;
  premiumCents: number | null;
  agreedValueCents: number | null;
  contactName: string | null;
  contactPhone: string | null;
  notes: string | null;
}

interface ServiceRecord {
  id: number;
  vehicleId: number;
  organizationId: number;
  servicedOn: string;
  serviceType: ServiceType;
  provider: string | null;
  odometerKm: number | null;
  description: string | null;
  costCents: number | null;
  invoiceRef: string | null;
  nextServiceDueOn: string | null;
  nextServiceDueKm: number | null;
  notes: string | null;
}

interface CostRecord {
  id: number;
  vehicleId: number;
  organizationId: number;
  incurredOn: string;
  category: CostCategory;
  amountCents: number;
  supplier: string | null;
  reference: string | null;
  odometerKm: number | null;
  litres: number | null;
  notes: string | null;
}

interface CostSummary {
  totalCents: number;
  last12mCents: number;
  byCategory: Record<string, number>;
  fuelLitres: number | null;
  centsPerLitre: number | null;
  litresPer100km: number | null;
}

interface VehicleDetailResponse {
  vehicle: VehicleRow;
  compliance: VehicleCompliance;
  holder: Assignment | null;
  assignments: Assignment[];
  policies: InsurancePolicy[];
  services: ServiceRecord[];
  costs: CostRecord[];
  costSummary: CostSummary;
  today: string;
}

// ── Config: labels, one colour map for every status pill ────────────────────

const VEHICLE_TYPE_LABELS: Record<VehicleType, string> = {
  car: "Car", van: "Van", minibus: "Minibus", ute: "Ute", truck: "Truck", trailer: "Trailer", other: "Other",
};
const FUEL_TYPE_LABELS: Record<FuelType, string> = {
  petrol: "Petrol", diesel: "Diesel", hybrid: "Hybrid", plug_in_hybrid: "Plug-in hybrid",
  electric: "Electric", lpg: "LPG", other: "Other",
};
const VEHICLE_STATUS_META: Record<VehicleStatus, { label: string; color: string }> = {
  active: { label: "Active", color: "#22c55e" },
  in_workshop: { label: "In workshop", color: "#f59e0b" },
  off_road: { label: "Off road", color: "#6b7280" },
  disposed: { label: "Disposed", color: "#64748b" },
};
const OWNERSHIP_LABELS: Record<OwnershipType, string> = { owned: "Owned", leased: "Leased", financed: "Financed" };
const COMPLIANCE_TYPE_LABELS: Record<ComplianceType, string> = { wof: "WOF", cof: "COF" };
const INSURANCE_COVER_LABELS: Record<InsuranceCoverType, string> = {
  comprehensive: "Comprehensive", third_party_fire_theft: "Third party, fire & theft",
  third_party: "Third party", mechanical_breakdown: "Mechanical breakdown", other: "Other",
};
const SERVICE_TYPE_LABELS: Record<ServiceType, string> = {
  service: "Service", repair: "Repair", wof_check: "WOF check", cof_check: "COF check",
  tyres: "Tyres", recall: "Recall", other: "Other",
};
const COST_CATEGORY_LABELS: Record<CostCategory, string> = {
  fuel: "Fuel", ruc: "RUC", rego: "Rego", wof: "WOF", cof: "COF", insurance: "Insurance",
  service: "Service", repair: "Repair", tyres: "Tyres", cleaning: "Cleaning", fine: "Fine",
  toll: "Toll", parking: "Parking", lease: "Lease", other: "Other",
};
const FBT_EXEMPTION_LABELS: Record<FbtExemption, string> = {
  none: "None", work_related_vehicle: "Work-related vehicle", emergency_call: "Emergency call vehicle", other: "Other",
};

/** The one place every status pill gets its colour. `unknown` is deliberately
 *  NOT green — it means nobody has entered this yet, and a dashed border
 *  invites a click rather than reading as "fine". */
const STATUS_STYLES: Record<ExpiryStatus, { label: string; color: string; dashed: boolean }> = {
  ok: { label: "OK", color: "#22c55e", dashed: false },
  due_soon: { label: "Due soon", color: "#f59e0b", dashed: false },
  expired: { label: "Expired", color: "#ef4444", dashed: false },
  unknown: { label: "Unknown", color: "#94a3b8", dashed: true },
};

// ── Date helpers — ISO calendar strings in, ISO calendar strings out ────────
// NEVER `new Date(isoDateString)` to display a date: an ISO date is already a
// NZ calendar day, and constructing/formatting a Date can roll it to the
// previous day depending on the machine's timezone. Build the display string
// from the parts instead.

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatNzDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const parts = iso.split("-");
  if (parts.length !== 3) return iso;
  const [y, m, d] = parts;
  const mi = Number(m) - 1;
  if (!y || mi < 0 || mi > 11 || !d) return iso;
  return `${Number(d)} ${MONTHS_SHORT[mi]} ${y}`;
}

function formatNzMonthYear(iso: string | null | undefined): string {
  if (!iso) return "—";
  const parts = iso.split("-");
  if (parts.length !== 3) return iso;
  const [y, m] = parts;
  const mi = Number(m) - 1;
  if (!y || mi < 0 || mi > 11) return iso;
  return `${MONTHS_SHORT[mi]} ${y}`;
}

/** Whole days between an ISO calendar date and `today` (also ISO) — pure
 *  string/UTC-midnight arithmetic via @shared/vehicles, never the local clock. */
function daysOld(iso: string | null | undefined, todayIso: string): number | null {
  if (!iso) return null;
  const d = daysUntil(iso, todayIso);
  return d === null ? null : -d;
}

/** Best-effort extraction of the server's JSON `message` out of an apiRequest error. */
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

// Sort order for the vehicle list: problems float to the top.
const SORT_RANK: Record<ExpiryStatus, number> = { expired: 0, due_soon: 1, unknown: 2, ok: 3 };

// ── Shared little bits ───────────────────────────────────────────────────────

const inputCls = "w-full rounded-lg bg-white/[0.03] border border-white/10 px-3 py-2 text-sm text-white/90 placeholder:text-white/25 focus:outline-none focus:border-blue-500/50 disabled:opacity-40 disabled:cursor-not-allowed";
const selectCls = "rounded-lg bg-white/[0.04] border border-white/10 px-2 py-1 text-[11px] text-white/80 focus:outline-none focus:border-blue-500/50 cursor-pointer";
const labelCls = "text-[11px] text-white/40 mb-1 block";

function Pill({ label, color }: { label: string; color: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap"
      style={{ background: `${color}22`, color, border: `1px solid ${color}55` }}
    >
      {label}
    </span>
  );
}

/** One status pill. Colour always comes from STATUS_STYLES — never an ad-hoc
 *  colour picked inline. `sub` is a pre-formatted string (a date or a km
 *  figure) shown underneath; the caller formats it so this component never
 *  has to guess whether it's a date or a distance. */
function StatusPill({ label, status, sub }: { label: string; status: ExpiryStatus; sub?: string | null }) {
  const s = STATUS_STYLES[status];
  return (
    <div
      className="rounded-lg px-2 py-1 text-center min-w-[62px]"
      style={{ background: `${s.color}16`, borderWidth: 1, borderStyle: s.dashed ? "dashed" : "solid", borderColor: `${s.color}55` }}
      title={`${label}: ${s.label}`}
    >
      <div className="text-[9.5px] font-semibold uppercase tracking-wide" style={{ color: s.color }}>{label}</div>
      <div className="text-[9px] text-white/40 mt-0.5 leading-tight">{sub ?? s.label}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-white/[0.06] pt-3 mt-3 first:border-t-0 first:pt-0 first:mt-0">
      <div className="text-[11px] uppercase tracking-wider text-white/40 font-semibold mb-2">{title}</div>
      <div className="space-y-2.5">{children}</div>
    </div>
  );
}

/** Generic create/update/delete mutation trio for one child collection of a
 *  vehicle (assignments / insurance / services / costs) — same shape four
 *  times over, so it's a hook rather than four copy-pasted blocks. */
function useChildMutations(
  vehicleId: number | null,
  path: "assignments" | "insurance" | "services" | "costs",
  onDone: () => void,
  toast: ReturnType<typeof useToast>["toast"],
) {
  const createMut = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiRequest("POST", `/api/admin/vehicles/${vehicleId}/${path}`, body),
    onSuccess: () => { onDone(); toast({ title: "Added" }); },
    onError: (e: unknown) => toast({ title: "Couldn't save", description: apiErrorMessage(e), variant: "destructive" }),
  });
  const updateMut = useMutation({
    mutationFn: ({ id, ...body }: { id: number } & Record<string, unknown>) =>
      apiRequest("PATCH", `/api/admin/vehicles/${vehicleId}/${path}/${id}`, body),
    onSuccess: () => { onDone(); toast({ title: "Saved" }); },
    onError: (e: unknown) => toast({ title: "Couldn't save", description: apiErrorMessage(e), variant: "destructive" }),
  });
  const deleteMut = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/admin/vehicles/${vehicleId}/${path}/${id}`),
    onSuccess: () => { onDone(); toast({ title: "Deleted" }); },
    onError: (e: unknown) => toast({ title: "Couldn't delete", description: apiErrorMessage(e), variant: "destructive" }),
  });
  return { createMut, updateMut, deleteMut };
}

const LIST_KEY = ["/api/admin/vehicles"];

// ═════════════════════════════════════════════════════════════════════════════
export default function GroupVehicles() {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [chipFilter, setChipFilter] = useState<"all" | "expired" | "due_soon" | "unknown" | "unassigned">("all");
  const [statusFilter, setStatusFilter] = useState<"all" | VehicleStatus>("all");
  const [showDisposed, setShowDisposed] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editingVehicle, setEditingVehicle] = useState<VehicleRow | undefined>(undefined);
  const [detailId, setDetailId] = useState<number | null>(null);

  const { data, isLoading } = useQuery<VehiclesListResponse>({ queryKey: LIST_KEY });
  const vehicles = data?.vehicles ?? [];
  const summary = data?.summary;
  // `today` always comes from the server, which computes it in Pacific/Auckland.
  // The browser's own clock is NOT a safe fallback: `toISOString()` is UTC, and
  // for most of a New Zealand working day that is yesterday's date — which would
  // quietly shift the "odometer reading is N days old" warning and prefill
  // handover dates a day early. No date beats a wrong date: an empty string
  // makes `daysOld` return null, so the warning simply doesn't render.
  const today = data?.today ?? "";

  const invalidateList = () => queryClient.invalidateQueries({ queryKey: LIST_KEY });

  const createMut = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiRequest("POST", "/api/admin/vehicles", body),
    onSuccess: () => { invalidateList(); setFormOpen(false); toast({ title: "Vehicle added" }); },
    onError: (e: unknown) => toast({ title: "Couldn't add vehicle", description: apiErrorMessage(e), variant: "destructive" }),
  });
  const updateMut = useMutation({
    mutationFn: ({ id, ...body }: { id: number } & Record<string, unknown>) => apiRequest("PATCH", `/api/admin/vehicles/${id}`, body),
    onSuccess: (_res, vars) => {
      invalidateList();
      queryClient.invalidateQueries({ queryKey: [`/api/admin/vehicles/${vars.id}`] });
      setFormOpen(false);
      toast({ title: "Vehicle saved" });
    },
    onError: (e: unknown) => toast({ title: "Couldn't save vehicle", description: apiErrorMessage(e), variant: "destructive" }),
  });
  const deleteMut = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/admin/vehicles/${id}`),
    onSuccess: async (res: Response) => {
      invalidateList();
      let archived = false;
      let message: string | undefined;
      try {
        const body = await res.json();
        archived = !!body.archived;
        message = body.message;
      } catch {
        /* ignore — still deleted/archived either way */
      }
      toast({ title: archived ? "Vehicle archived" : "Vehicle deleted", description: message });
    },
    onError: (e: unknown) => toast({ title: "Couldn't delete vehicle", description: apiErrorMessage(e), variant: "destructive" }),
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return vehicles
      .filter((v) => {
        if (v.status === "disposed" && !showDisposed && statusFilter !== "disposed") return false;
        if (statusFilter !== "all" && v.status !== statusFilter) return false;
        if (chipFilter === "expired" && v.compliance.overall !== "expired") return false;
        if (chipFilter === "due_soon" && v.compliance.overall !== "due_soon") return false;
        if (chipFilter === "unknown" && v.compliance.overall !== "unknown") return false;
        if (chipFilter === "unassigned" && v.holder) return false;
        if (q && !`${v.plate} ${v.make} ${v.model}`.toLowerCase().includes(q)) return false;
        return true;
      })
      .sort((a, b) => {
        const r = SORT_RANK[a.compliance.overall] - SORT_RANK[b.compliance.overall];
        return r !== 0 ? r : a.plate.localeCompare(b.plate);
      });
  }, [vehicles, search, chipFilter, statusFilter, showDisposed]);

  const openCreate = () => { setEditingVehicle(undefined); setFormOpen(true); };
  const openEdit = (v: VehicleRow) => { setEditingVehicle(v); setFormOpen(true); };

  const chips = summary
    ? ([
        // Counts what the list can actually show. `summary.total` includes
        // disposed vehicles and every OTHER tile deliberately excludes them, so
        // with a retired vehicle on file the tile read 8 above a list of 6 and
        // invited "where are the other two?". Harmless until the fleet had its
        // first archived vehicle (Aug 2026), which is when it stopped being
        // theoretical.
        { key: "all" as const, label: "Total", value: showDisposed ? summary.total : summary.active, color: "#3b82f6" },
        { key: "expired" as const, label: "Needs attention", value: summary.expired, color: STATUS_STYLES.expired.color },
        { key: "due_soon" as const, label: "Due soon", value: summary.dueSoon, color: STATUS_STYLES.due_soon.color },
        { key: "unknown" as const, label: "Missing info", value: summary.unknown, color: STATUS_STYLES.unknown.color },
        { key: "unassigned" as const, label: "Unassigned", value: summary.unassigned, color: "#a855f7" },
      ])
    : [];

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto text-white/90">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Car className="w-5 h-5 text-blue-400" /> Vehicles
          </h1>
          <p className="text-[13px] text-white/40 mt-1 max-w-xl">
            The company fleet — who has each vehicle, and whether its WOF/COF, rego, RUC, insurance and servicing are up to date.
          </p>
        </div>
        <button
          onClick={openCreate}
          data-testid="button-new-vehicle"
          className="inline-flex items-center gap-2 rounded-xl bg-blue-500/15 border border-blue-500/30 text-blue-300 px-4 py-2 text-sm font-medium hover:bg-blue-500/25 transition-colors"
        >
          <Plus className="w-4 h-4" /> Add vehicle
        </button>
      </div>

      {!isLoading && vehicles.length > 0 && (
        <>
          {/* stat chips — filters */}
          <div className="flex flex-wrap gap-2 mb-4">
            {chips.map((c) => {
              const active = chipFilter === c.key;
              return (
                <button
                  key={c.key}
                  onClick={() => setChipFilter(active ? "all" : c.key)}
                  data-testid={`filter-chip-${c.key}`}
                  className="rounded-xl border px-3 py-2 text-left transition-colors"
                  style={{
                    borderColor: active ? `${c.color}88` : "rgba(255,255,255,0.06)",
                    background: active ? `${c.color}18` : "rgba(255,255,255,0.02)",
                  }}
                >
                  <div className="text-[10px] font-medium" style={{ color: c.color }}>{c.label}</div>
                  <div className="text-lg font-semibold mt-0.5">{c.value}</div>
                </button>
              );
            })}
          </div>

          {/* toolbar */}
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as "all" | VehicleStatus)}
              data-testid="select-status-filter"
              className={selectCls}
            >
              <option value="all">All statuses</option>
              {VEHICLE_STATUSES.map((s) => <option key={s} value={s}>{VEHICLE_STATUS_META[s].label}</option>)}
            </select>
            <label className="flex items-center gap-1.5 text-[11px] text-white/45 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showDisposed}
                onChange={(e) => setShowDisposed(e.target.checked)}
                className="accent-blue-500"
              />
              Show disposed
            </label>
            <div className="relative ml-auto">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-white/30" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search plate, make, model…"
                data-testid="input-search-vehicles"
                className="rounded-lg bg-white/[0.03] border border-white/10 pl-8 pr-3 py-1.5 text-[13px] text-white/90 placeholder:text-white/25 focus:outline-none focus:border-blue-500/50 w-full sm:w-64"
              />
            </div>
          </div>
        </>
      )}

      {isLoading ? (
        <div className="text-white/30 text-sm py-16 text-center">Loading…</div>
      ) : !vehicles.length ? (
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] py-16 text-center">
          <Car className="w-8 h-8 text-white/20 mx-auto mb-3" />
          <div className="text-white/50 text-sm max-w-sm mx-auto">
            No vehicles on the fleet yet. Add the club's vans, cars and trailers to track their WOF, rego, RUC, insurance and servicing in one place.
          </div>
          <button onClick={openCreate} className="text-blue-400 text-[13px] mt-2 hover:underline">
            Add the first one →
          </button>
        </div>
      ) : !filtered.length ? (
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] py-16 text-center">
          <div className="text-white/50 text-sm">Nothing matches your filters.</div>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((v) => (
            <VehicleCard
              key={v.id}
              v={v}
              today={today}
              onOpen={() => setDetailId(v.id)}
              onEdit={() => openEdit(v)}
              onDelete={() => {
                if (confirm(`Remove ${v.plate} from the fleet?`)) deleteMut.mutate(v.id);
              }}
            />
          ))}
        </div>
      )}

      <VehicleFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        vehicle={editingVehicle}
        saving={createMut.isPending || updateMut.isPending}
        onSubmit={(body) => {
          if (editingVehicle) updateMut.mutate({ id: editingVehicle.id, ...body });
          else createMut.mutate(body);
        }}
      />

      <VehicleDetailDialog
        vehicleId={detailId}
        onClose={() => setDetailId(null)}
        onEdit={(v) => { setDetailId(null); openEdit(v); }}
      />
    </div>
  );
}

// ═══ VEHICLE CARD ═════════════════════════════════════════════════════════════
function VehicleCard({ v, today, onOpen, onEdit, onDelete }: {
  v: VehicleRow;
  today: string;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const statusMeta = VEHICLE_STATUS_META[v.status] ?? VEHICLE_STATUS_META.active;
  const age = v.rucRequired ? daysOld(v.odometerAt, today) : null;

  return (
    <div
      onClick={onOpen}
      data-testid={`card-vehicle-${v.id}`}
      className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4 hover:border-white/10 transition-colors cursor-pointer"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="font-mono text-[15px] font-bold tracking-wide text-white/95">{v.plate}</span>
            <Pill label={statusMeta.label} color={statusMeta.color} />
          </div>
          <div className="text-[13px] text-white/60 truncate">
            {v.year ? `${v.year} ` : ""}{v.make} {v.model}{v.variant ? ` ${v.variant}` : ""}
            <span className="text-white/30"> · {VEHICLE_TYPE_LABELS[v.vehicleType]}</span>
          </div>
          <div className="flex items-center gap-2 flex-wrap mt-1 text-[12px] text-white/45">
            {v.holder ? (
              <span>Held by <span className="text-white/70">{v.holder.name}</span> since {formatNzDate(v.holder.since)}</span>
            ) : (
              <span className="text-white/30 italic">Unassigned</span>
            )}
            {v.odometerKm != null && (
              <span className="text-white/30">· {formatNumber(v.odometerKm)} km{v.odometerAt ? ` as at ${formatNzDate(v.odometerAt)}` : ""}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
          <button onClick={onEdit} className="w-7 h-7 rounded-lg text-white/30 hover:text-white hover:bg-white/[0.06] flex items-center justify-center" title="Edit">
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button onClick={onDelete} className="w-7 h-7 rounded-lg text-white/30 hover:text-red-400 hover:bg-white/[0.06] flex items-center justify-center" title="Remove">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5 mt-3">
        <StatusPill label={v.compliance.complianceLabel} status={v.compliance.compliance} sub={formatNzDate(v.compliance.complianceExpiresOn)} />
        <StatusPill label="Rego" status={v.compliance.rego} sub={formatNzDate(v.regoExpiresOn)} />
        {v.rucRequired && (
          <StatusPill label="RUC" status={v.compliance.ruc} sub={v.rucValidToKm != null ? `to ${formatNumber(v.rucValidToKm)} km` : null} />
        )}
        <StatusPill label="Insurance" status={v.compliance.insurance} sub={formatNzDate(v.compliance.insuranceExpiresOn)} />
        <StatusPill label="Service" status={v.compliance.service} sub={v.nextServiceDueOn ? formatNzDate(v.nextServiceDueOn) : null} />
      </div>

      {v.rucRequired && v.compliance.odometerStale && (
        <div className="mt-2 flex items-center gap-1.5 text-[11px] text-amber-300/80">
          <AlertTriangle className="w-3 h-3 shrink-0" />
          {v.odometerAt
            ? `Odometer reading is ${age ?? "many"} days old — RUC status can't be trusted until it's refreshed.`
            : "No odometer reading recorded — RUC status is unknown."}
        </div>
      )}
    </div>
  );
}

// ═══ CREATE / EDIT DIALOG ═════════════════════════════════════════════════════
function VehicleFormDialog({ open, onOpenChange, vehicle, saving, onSubmit }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  vehicle: VehicleRow | undefined;
  saving: boolean;
  onSubmit: (body: Record<string, unknown>) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl bg-[#0a0f1a] border border-white/10 text-white/90 max-h-[85vh] overflow-y-auto">
        <VehicleForm
          key={vehicle?.id ?? "new"}
          vehicle={vehicle}
          saving={saving}
          onCancel={() => onOpenChange(false)}
          onSubmit={onSubmit}
        />
      </DialogContent>
    </Dialog>
  );
}

function VehicleForm({ vehicle, saving, onCancel, onSubmit }: {
  vehicle: VehicleRow | undefined;
  saving: boolean;
  onCancel: () => void;
  onSubmit: (body: Record<string, unknown>) => void;
}) {
  const isEdit = !!vehicle;

  const [plate, setPlate] = useState(vehicle?.plate ?? "");
  const [make, setMake] = useState(vehicle?.make ?? "");
  const [model, setModel] = useState(vehicle?.model ?? "");
  const [variant, setVariant] = useState(vehicle?.variant ?? "");
  const [year, setYear] = useState(vehicle?.year != null ? String(vehicle.year) : "");
  const [colour, setColour] = useState(vehicle?.colour ?? "");
  const [vin, setVin] = useState(vehicle?.vin ?? "");
  const [engineNumber, setEngineNumber] = useState(vehicle?.engineNumber ?? "");
  const [vehicleType, setVehicleType] = useState<VehicleType>(vehicle?.vehicleType ?? "car");
  const [fuelType, setFuelType] = useState<FuelType>(vehicle?.fuelType ?? "petrol");
  const [transmission, setTransmission] = useState(vehicle?.transmission ?? "");
  const [seats, setSeats] = useState(vehicle?.seats != null ? String(vehicle.seats) : "");
  const [status, setStatus] = useState<VehicleStatus>(vehicle?.status ?? "active");

  const [odometerKm, setOdometerKm] = useState(vehicle?.odometerKm != null ? String(vehicle.odometerKm) : "");
  const [odometerAt, setOdometerAt] = useState(vehicle?.odometerAt ?? "");

  const [complianceType, setComplianceType] = useState<ComplianceType>(vehicle?.complianceType ?? "wof");
  const [complianceTypeTouched, setComplianceTypeTouched] = useState(isEdit);
  const [wofExpiresOn, setWofExpiresOn] = useState(vehicle?.wofExpiresOn ?? "");
  const [cofExpiresOn, setCofExpiresOn] = useState(vehicle?.cofExpiresOn ?? "");
  const [regoExpiresOn, setRegoExpiresOn] = useState(vehicle?.regoExpiresOn ?? "");
  const [rucRequired, setRucRequired] = useState(vehicle?.rucRequired ?? false);
  const [rucTouched, setRucTouched] = useState(isEdit);
  const [rucValidToKm, setRucValidToKm] = useState(vehicle?.rucValidToKm != null ? String(vehicle.rucValidToKm) : "");
  const [nextServiceDueOn, setNextServiceDueOn] = useState(vehicle?.nextServiceDueOn ?? "");
  const [nextServiceDueKm, setNextServiceDueKm] = useState(vehicle?.nextServiceDueKm != null ? String(vehicle.nextServiceDueKm) : "");

  const [ownership, setOwnership] = useState<OwnershipType>(vehicle?.ownership ?? "owned");
  const [lessor, setLessor] = useState(vehicle?.lessor ?? "");
  const [leaseEndsOn, setLeaseEndsOn] = useState(vehicle?.leaseEndsOn ?? "");
  const [leaseMonthly, setLeaseMonthly] = useState(centsToDollarInput(vehicle?.leaseMonthlyCents));
  const [purchasedOn, setPurchasedOn] = useState(vehicle?.purchasedOn ?? "");
  const [purchasePrice, setPurchasePrice] = useState(centsToDollarInput(vehicle?.purchasePriceCents));
  const [supplier, setSupplier] = useState(vehicle?.supplier ?? "");
  const [disposedOn, setDisposedOn] = useState(vehicle?.disposedOn ?? "");
  const [disposalPrice, setDisposalPrice] = useState(centsToDollarInput(vehicle?.disposalPriceCents));

  const [fbtPrivateUse, setFbtPrivateUse] = useState(vehicle?.fbtPrivateUse ?? false);
  const [fbtExemption, setFbtExemption] = useState<FbtExemption>(vehicle?.fbtExemption ?? "none");
  const [fbtNotes, setFbtNotes] = useState(vehicle?.fbtNotes ?? "");

  const [notes, setNotes] = useState(vehicle?.notes ?? "");

  const handleFuelTypeChange = (v: FuelType) => {
    setFuelType(v);
    if (!isEdit && !rucTouched) setRucRequired(suggestRucRequired(v));
  };
  const handleVehicleTypeChange = (v: VehicleType) => {
    setVehicleType(v);
    if (!isEdit && !complianceTypeTouched) setComplianceType(suggestComplianceType(v));
  };

  const canSubmit = plate.trim() !== "" && make.trim() !== "" && model.trim() !== "";

  const submit = () => {
    if (!canSubmit) return;
    const leased = ownership !== "owned";
    const disposing = status === "disposed";
    onSubmit({
      plate: plate.trim(),
      make: make.trim(),
      model: model.trim(),
      variant: variant.trim() || null,
      year: year.trim() ? Number(year) : null,
      colour: colour.trim() || null,
      vin: vin.trim() || null,
      engineNumber: engineNumber.trim() || null,
      vehicleType,
      fuelType,
      transmission: transmission.trim() || null,
      seats: seats.trim() ? Number(seats) : null,

      odometerKm: odometerKm.trim() ? Number(odometerKm) : null,
      odometerAt: odometerAt || null,

      complianceType,
      wofExpiresOn: complianceType === "wof" ? (wofExpiresOn || null) : null,
      cofExpiresOn: complianceType === "cof" ? (cofExpiresOn || null) : null,
      regoExpiresOn: regoExpiresOn || null,
      rucRequired,
      rucValidToKm: rucRequired && rucValidToKm.trim() ? Number(rucValidToKm) : null,
      nextServiceDueOn: nextServiceDueOn || null,
      nextServiceDueKm: nextServiceDueKm.trim() ? Number(nextServiceDueKm) : null,

      ownership,
      lessor: leased ? (lessor.trim() || null) : null,
      leaseEndsOn: leased ? (leaseEndsOn || null) : null,
      leaseMonthlyCents: leased && leaseMonthly.trim() ? dollarInputToCents(leaseMonthly) : null,
      purchasedOn: purchasedOn || null,
      purchasePriceCents: purchasePrice.trim() ? dollarInputToCents(purchasePrice) : null,
      supplier: supplier.trim() || null,
      disposedOn: disposing ? (disposedOn || null) : null,
      disposalPriceCents: disposing && disposalPrice.trim() ? dollarInputToCents(disposalPrice) : null,

      status,

      fbtPrivateUse,
      fbtExemption: fbtPrivateUse ? fbtExemption : "none",
      fbtNotes: fbtPrivateUse ? (fbtNotes.trim() || null) : null,

      notes: notes.trim() || null,
    });
  };

  return (
    <>
      <div className="mb-1">
        <h2 className="text-base font-semibold">{isEdit ? `Edit ${vehicle!.plate}` : "Add vehicle"}</h2>
      </div>

      <Section title="Identity">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
          <div>
            <label className={labelCls}>Plate *</label>
            <input value={plate} onChange={(e) => setPlate(e.target.value)} placeholder="ABC123" data-testid="input-plate" className={inputCls + " font-mono uppercase"} autoFocus />
          </div>
          <div>
            <label className={labelCls}>Make *</label>
            <input value={make} onChange={(e) => setMake(e.target.value)} placeholder="Toyota" data-testid="input-make" className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Model *</label>
            <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="Hiace" data-testid="input-model" className={inputCls} />
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
          <div>
            <label className={labelCls}>Variant</label>
            <input value={variant} onChange={(e) => setVariant(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Year</label>
            <input type="number" value={year} onChange={(e) => setYear(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Colour</label>
            <input value={colour} onChange={(e) => setColour(e.target.value)} className={inputCls} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          <div>
            <label className={labelCls}>VIN</label>
            <input value={vin} onChange={(e) => setVin(e.target.value)} className={inputCls + " font-mono uppercase text-[12px]"} />
          </div>
          <div>
            <label className={labelCls}>Engine number</label>
            <input value={engineNumber} onChange={(e) => setEngineNumber(e.target.value)} className={inputCls} />
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
          <div>
            <label className={labelCls}>Vehicle type</label>
            <select value={vehicleType} onChange={(e) => handleVehicleTypeChange(e.target.value as VehicleType)} className={inputCls + " cursor-pointer"}>
              {VEHICLE_TYPES.map((t) => <option key={t} value={t}>{VEHICLE_TYPE_LABELS[t]}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls}>Fuel type</label>
            <select value={fuelType} onChange={(e) => handleFuelTypeChange(e.target.value as FuelType)} className={inputCls + " cursor-pointer"}>
              {FUEL_TYPES.map((t) => <option key={t} value={t}>{FUEL_TYPE_LABELS[t]}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls}>Transmission</label>
            <input value={transmission} onChange={(e) => setTransmission(e.target.value)} placeholder="Auto / Manual" className={inputCls} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          <div>
            <label className={labelCls}>Seats</label>
            <input type="number" min={1} value={seats} onChange={(e) => setSeats(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Status</label>
            <select value={status} onChange={(e) => setStatus(e.target.value as VehicleStatus)} className={inputCls + " cursor-pointer"}>
              {VEHICLE_STATUSES.map((s) => <option key={s} value={s}>{VEHICLE_STATUS_META[s].label}</option>)}
            </select>
          </div>
        </div>
      </Section>

      <Section title="Odometer">
        <div className="grid grid-cols-2 gap-2.5">
          <div>
            <label className={labelCls}>Odometer (km)</label>
            <input type="number" min={0} value={odometerKm} onChange={(e) => setOdometerKm(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Reading taken on</label>
            <input type="date" value={odometerAt} onChange={(e) => setOdometerAt(e.target.value)} className={inputCls} />
          </div>
        </div>
      </Section>

      <Section title="Compliance">
        <div className="grid grid-cols-2 gap-2.5">
          <div>
            <label className={labelCls}>Compliance type</label>
            <select
              value={complianceType}
              onChange={(e) => { setComplianceType(e.target.value as ComplianceType); setComplianceTypeTouched(true); }}
              className={inputCls + " cursor-pointer"}
            >
              {COMPLIANCE_TYPES.map((t) => <option key={t} value={t}>{COMPLIANCE_TYPE_LABELS[t]}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls}>{complianceType === "cof" ? "COF expiry" : "WOF expiry"}</label>
            <input
              type="date"
              value={complianceType === "cof" ? cofExpiresOn : wofExpiresOn}
              onChange={(e) => (complianceType === "cof" ? setCofExpiresOn(e.target.value) : setWofExpiresOn(e.target.value))}
              className={inputCls}
            />
          </div>
        </div>

        <div>
          <label className={labelCls}>Rego expiry</label>
          <input type="date" value={regoExpiresOn} onChange={(e) => setRegoExpiresOn(e.target.value)} className={inputCls} />
        </div>

        <div className="rounded-lg border border-white/10 bg-white/[0.02] p-2.5">
          <label className="flex items-center gap-2 text-[13px] text-white/80 cursor-pointer">
            <input
              type="checkbox"
              checked={rucRequired}
              onChange={(e) => { setRucRequired(e.target.checked); setRucTouched(true); }}
              className="accent-blue-500"
            />
            RUC required
          </label>
          <p className="text-[11px] text-white/35 mt-1">
            Diesel, electric and plug-in hybrids buy RUC in blocks of distance — it expires at an odometer reading, not a date.
          </p>
          {rucRequired && (
            <div className="mt-2">
              <label className={labelCls}>RUC licence valid to (km)</label>
              <input type="number" min={0} value={rucValidToKm} onChange={(e) => setRucValidToKm(e.target.value)} className={inputCls} />
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          <div>
            <label className={labelCls}>Next service due</label>
            <input type="date" value={nextServiceDueOn} onChange={(e) => setNextServiceDueOn(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Next service due (km)</label>
            <input type="number" min={0} value={nextServiceDueKm} onChange={(e) => setNextServiceDueKm(e.target.value)} className={inputCls} />
          </div>
        </div>
      </Section>

      <Section title="Ownership">
        <div>
          <label className={labelCls}>Ownership</label>
          <select value={ownership} onChange={(e) => setOwnership(e.target.value as OwnershipType)} className={inputCls + " cursor-pointer"}>
            {OWNERSHIP_TYPES.map((o) => <option key={o} value={o}>{OWNERSHIP_LABELS[o]}</option>)}
          </select>
        </div>

        {ownership !== "owned" && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            <div>
              <label className={labelCls}>Lessor</label>
              <input value={lessor} onChange={(e) => setLessor(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>Lease ends</label>
              <input type="date" value={leaseEndsOn} onChange={(e) => setLeaseEndsOn(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>Lease monthly</label>
              <MoneyInput value={leaseMonthly} onChange={setLeaseMonthly} className={inputCls} />
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
          <div>
            <label className={labelCls}>Purchased on</label>
            <input type="date" value={purchasedOn} onChange={(e) => setPurchasedOn(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Purchase price</label>
            <MoneyInput value={purchasePrice} onChange={setPurchasePrice} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Supplier</label>
            <input value={supplier} onChange={(e) => setSupplier(e.target.value)} className={inputCls} />
          </div>
        </div>

        {status === "disposed" && (
          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className={labelCls}>Disposed on</label>
              <input type="date" value={disposedOn} onChange={(e) => setDisposedOn(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>Disposal price</label>
              <MoneyInput value={disposalPrice} onChange={setDisposalPrice} className={inputCls} />
            </div>
          </div>
        )}
      </Section>

      <Section title="FBT">
        <div className="rounded-lg border border-white/10 bg-white/[0.02] p-2.5">
          <label className="flex items-center gap-2 text-[13px] text-white/80 cursor-pointer">
            <input type="checkbox" checked={fbtPrivateUse} onChange={(e) => setFbtPrivateUse(e.target.checked)} className="accent-blue-500" />
            Available for private use
          </label>
          <p className="text-[11px] text-white/35 mt-1">
            In NZ, a vehicle available for an employee's private use attracts Fringe Benefit Tax — availability, not actual use, is the test. Check the exemption with the accountant.
          </p>
          {fbtPrivateUse && (
            <div className="mt-2 space-y-2">
              <div>
                <label className={labelCls}>FBT exemption</label>
                <select value={fbtExemption} onChange={(e) => setFbtExemption(e.target.value as FbtExemption)} className={inputCls + " cursor-pointer"}>
                  {FBT_EXEMPTIONS.map((f) => <option key={f} value={f}>{FBT_EXEMPTION_LABELS[f]}</option>)}
                </select>
              </div>
              <div>
                <label className={labelCls}>FBT notes</label>
                <textarea value={fbtNotes} onChange={(e) => setFbtNotes(e.target.value)} className={inputCls + " min-h-[60px]"} />
              </div>
            </div>
          )}
        </div>
      </Section>

      <Section title="Notes">
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} className={inputCls + " min-h-[70px]"} placeholder="Anything else worth knowing about this vehicle…" />
      </Section>

      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onCancel} className="rounded-xl px-4 py-2 text-sm text-white/50 hover:text-white/80">Cancel</button>
        <button
          onClick={submit}
          disabled={!canSubmit || saving}
          data-testid="button-submit-vehicle"
          className="inline-flex items-center gap-2 rounded-xl bg-blue-500/20 border border-blue-500/40 text-blue-200 px-4 py-2 text-sm font-medium hover:bg-blue-500/30 disabled:opacity-50 transition-colors"
        >
          <Check className="w-4 h-4" /> {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </>
  );
}

// ═══ DETAIL DIALOG ════════════════════════════════════════════════════════════
const DETAIL_TABS = [
  { key: "overview", label: "Overview", icon: Car },
  { key: "assignments", label: "Assignments", icon: Users },
  { key: "insurance", label: "Insurance", icon: ShieldCheck },
  { key: "servicing", label: "Servicing", icon: Wrench },
  { key: "costs", label: "Costs", icon: Wallet },
] as const;
type DetailTab = (typeof DETAIL_TABS)[number]["key"];

function VehicleDetailDialog({ vehicleId, onClose, onEdit }: {
  vehicleId: number | null;
  onClose: () => void;
  onEdit: (v: VehicleRow) => void;
}) {
  const { toast } = useToast();
  const [tab, setTab] = useState<DetailTab>("overview");

  const detailKey = [`/api/admin/vehicles/${vehicleId}`];
  const { data, isLoading } = useQuery<VehicleDetailResponse>({
    queryKey: detailKey,
    enabled: vehicleId != null,
  });

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: LIST_KEY });
    queryClient.invalidateQueries({ queryKey: detailKey });
  };

  const assignmentsMut = useChildMutations(vehicleId, "assignments", invalidateAll, toast);
  const insuranceMut = useChildMutations(vehicleId, "insurance", invalidateAll, toast);
  const servicesMut = useChildMutations(vehicleId, "services", invalidateAll, toast);
  const costsMut = useChildMutations(vehicleId, "costs", invalidateAll, toast);

  return (
    <Dialog open={vehicleId != null} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-3xl bg-[#0a0f1a] border border-white/10 text-white/90 max-h-[85vh] overflow-y-auto">
        {isLoading || !data ? (
          <div className="text-white/30 text-sm py-16 text-center">Loading…</div>
        ) : (
          <>
            <div className="flex flex-wrap items-start justify-between gap-3 mb-1">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-lg font-bold tracking-wide">{data.vehicle.plate}</span>
                  <Pill label={VEHICLE_STATUS_META[data.vehicle.status].label} color={VEHICLE_STATUS_META[data.vehicle.status].color} />
                </div>
                <div className="text-[13px] text-white/50">
                  {data.vehicle.year ? `${data.vehicle.year} ` : ""}{data.vehicle.make} {data.vehicle.model}{data.vehicle.variant ? ` ${data.vehicle.variant}` : ""}
                </div>
              </div>
              <button
                onClick={() => onEdit(data.vehicle)}
                className="inline-flex items-center gap-2 rounded-xl bg-white/[0.04] border border-white/10 text-white/70 px-3 py-2 text-sm font-medium hover:bg-white/[0.08] transition-colors shrink-0"
              >
                <Pencil className="w-3.5 h-3.5" /> Edit
              </button>
            </div>

            <div className="flex flex-wrap gap-1.5 mb-2">
              <StatusPill label={data.compliance.complianceLabel} status={data.compliance.compliance} sub={formatNzDate(data.compliance.complianceExpiresOn)} />
              <StatusPill label="Rego" status={data.compliance.rego} sub={formatNzDate(data.vehicle.regoExpiresOn)} />
              {data.vehicle.rucRequired && (
                <StatusPill label="RUC" status={data.compliance.ruc} sub={data.vehicle.rucValidToKm != null ? `to ${formatNumber(data.vehicle.rucValidToKm)} km` : null} />
              )}
              <StatusPill label="Insurance" status={data.compliance.insurance} sub={formatNzDate(data.compliance.insuranceExpiresOn)} />
              <StatusPill label="Service" status={data.compliance.service} sub={data.vehicle.nextServiceDueOn ? formatNzDate(data.vehicle.nextServiceDueOn) : null} />
            </div>

            <div className="flex gap-1 border-b border-white/[0.06] mb-3 overflow-x-auto">
              {DETAIL_TABS.map((t) => {
                const Icon = t.icon;
                const active = tab === t.key;
                return (
                  <button
                    key={t.key}
                    onClick={() => setTab(t.key)}
                    data-testid={`detail-tab-${t.key}`}
                    className={`inline-flex items-center gap-1.5 px-3 py-2 text-[12px] font-medium border-b-2 whitespace-nowrap transition-colors ${
                      active ? "border-blue-400 text-blue-300" : "border-transparent text-white/40 hover:text-white/70"
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" /> {t.label}
                  </button>
                );
              })}
            </div>

            {tab === "overview" && <OverviewTab data={data} />}
            {tab === "assignments" && <AssignmentsTab today={data.today} assignments={data.assignments} mut={assignmentsMut} />}
            {tab === "insurance" && <InsuranceTab policies={data.policies} mut={insuranceMut} />}
            {tab === "servicing" && <ServicingTab services={data.services} mut={servicesMut} />}
            {tab === "costs" && <CostsTab costs={data.costs} costSummary={data.costSummary} mut={costsMut} />}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Overview tab ─────────────────────────────────────────────────────────────
function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-white/30">{label}</div>
      <div className="text-[13px] text-white/85 mt-0.5">{value ?? "—"}</div>
    </div>
  );
}

function OverviewTab({ data }: { data: VehicleDetailResponse }) {
  const v = data.vehicle;
  return (
    <div className="space-y-4 pb-2">
      <Section title="Identity">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <Field label="Vehicle type" value={VEHICLE_TYPE_LABELS[v.vehicleType]} />
          <Field label="Fuel type" value={FUEL_TYPE_LABELS[v.fuelType]} />
          <Field label="Transmission" value={v.transmission} />
          <Field label="Colour" value={v.colour} />
          <Field label="Seats" value={v.seats} />
          <Field label="VIN" value={v.vin} />
          <Field label="Engine number" value={v.engineNumber} />
        </div>
      </Section>
      <Section title="Odometer">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Reading" value={v.odometerKm != null ? `${formatNumber(v.odometerKm)} km` : null} />
          <Field label="As at" value={formatNzDate(v.odometerAt)} />
        </div>
      </Section>
      <Section title="Ownership">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <Field label="Ownership" value={OWNERSHIP_LABELS[v.ownership]} />
          {v.ownership !== "owned" && <Field label="Lessor" value={v.lessor} />}
          {v.ownership !== "owned" && <Field label="Lease ends" value={formatNzDate(v.leaseEndsOn)} />}
          {v.ownership !== "owned" && <Field label="Lease monthly" value={v.leaseMonthlyCents != null ? formatCurrency(v.leaseMonthlyCents, { fromCents: true }) : null} />}
          <Field label="Purchased" value={formatNzDate(v.purchasedOn)} />
          <Field label="Purchase price" value={v.purchasePriceCents != null ? formatCurrency(v.purchasePriceCents, { fromCents: true }) : null} />
          <Field label="Supplier" value={v.supplier} />
          {v.status === "disposed" && <Field label="Disposed" value={formatNzDate(v.disposedOn)} />}
          {v.status === "disposed" && <Field label="Disposal price" value={v.disposalPriceCents != null ? formatCurrency(v.disposalPriceCents, { fromCents: true }) : null} />}
        </div>
      </Section>
      <Section title="FBT">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Available for private use" value={v.fbtPrivateUse ? "Yes" : "No"} />
          {v.fbtPrivateUse && <Field label="Exemption" value={FBT_EXEMPTION_LABELS[v.fbtExemption]} />}
        </div>
        {v.fbtPrivateUse && v.fbtNotes && <div className="text-[13px] text-white/70 whitespace-pre-wrap mt-1">{v.fbtNotes}</div>}
      </Section>
      {v.notes && (
        <Section title="Notes">
          <div className="text-[13px] text-white/70 whitespace-pre-wrap">{v.notes}</div>
        </Section>
      )}
    </div>
  );
}

// ── Assignments tab ──────────────────────────────────────────────────────────
function AssignmentsTab({ today, assignments, mut }: {
  today: string;
  assignments: Assignment[];
  mut: ReturnType<typeof useChildMutations>;
}) {
  const [adding, setAdding] = useState(false);
  const [returningId, setReturningId] = useState<number | null>(null);

  const open = assignments.find((a) => a.returnedOn === null) ?? null;
  const past = assignments.filter((a) => a.returnedOn !== null);

  return (
    <div className="space-y-3 pb-2">
      {open && (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/[0.06] p-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="text-[13px] font-medium text-emerald-200">Currently with {open.holderName}</div>
              <div className="text-[11px] text-white/45 mt-0.5">Since {formatNzDate(open.assignedOn)}{open.purpose ? ` · ${open.purpose}` : ""}</div>
              {(open.holderEmail || open.holderPhone) && (
                <div className="text-[11px] text-white/40 mt-0.5">{open.holderEmail ?? "—"} · {open.holderPhone ?? "—"}</div>
              )}
            </div>
            <button
              onClick={() => setReturningId(returningId === open.id ? null : open.id)}
              className="text-[11px] rounded-lg border border-white/10 bg-white/[0.04] text-white/70 px-2.5 py-1.5 hover:bg-white/[0.08] shrink-0"
            >
              Mark returned
            </button>
          </div>
          {returningId === open.id && (
            <ReturnForm
              defaultDate={today}
              onCancel={() => setReturningId(null)}
              onSubmit={(returnedOn, odometerEndKm) => {
                mut.updateMut.mutate({ id: open.id, returnedOn, odometerEndKm });
                setReturningId(null);
              }}
              saving={mut.updateMut.isPending}
            />
          )}
        </div>
      )}

      <div className="space-y-1.5">
        {past.map((a) => (
          <div key={a.id} className="flex items-center justify-between gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2">
            <div className="text-[12px] text-white/70">
              {a.holderName} <span className="text-white/35">· {formatNzMonthYear(a.assignedOn)} – {formatNzMonthYear(a.returnedOn)}</span>
              {a.purpose && <span className="text-white/30"> · {a.purpose}</span>}
            </div>
            <button onClick={() => { if (confirm("Delete this assignment record?")) mut.deleteMut.mutate(a.id); }} className="text-white/20 hover:text-red-400 shrink-0">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
        {!assignments.length && <div className="text-[12px] text-white/30">No assignment history yet.</div>}
      </div>

      {adding ? (
        <AssignmentForm onCancel={() => setAdding(false)} saving={mut.createMut.isPending} onSubmit={(body) => { mut.createMut.mutate(body); setAdding(false); }} />
      ) : (
        <button onClick={() => setAdding(true)} className="inline-flex items-center gap-1.5 text-[12px] text-blue-300 hover:text-blue-200">
          <Plus className="w-3.5 h-3.5" /> Add assignment
        </button>
      )}
    </div>
  );
}

function ReturnForm({ defaultDate, onCancel, onSubmit, saving }: {
  defaultDate: string;
  onCancel: () => void;
  onSubmit: (returnedOn: string, odometerEndKm: number | null) => void;
  saving: boolean;
}) {
  const [returnedOn, setReturnedOn] = useState(defaultDate);
  const [odometerEndKm, setOdometerEndKm] = useState("");
  return (
    <div className="mt-2 pt-2 border-t border-white/10 flex flex-wrap items-end gap-2">
      <div>
        <label className={labelCls}>Returned on</label>
        <input type="date" value={returnedOn} onChange={(e) => setReturnedOn(e.target.value)} className={inputCls} />
      </div>
      <div>
        <label className={labelCls}>Odometer at return (km)</label>
        <input type="number" min={0} value={odometerEndKm} onChange={(e) => setOdometerEndKm(e.target.value)} className={inputCls} />
      </div>
      <button onClick={onCancel} className="text-[12px] text-white/40 hover:text-white/70 px-2 py-2">Cancel</button>
      <button
        disabled={!returnedOn || saving}
        onClick={() => onSubmit(returnedOn, odometerEndKm.trim() ? Number(odometerEndKm) : null)}
        className="inline-flex items-center gap-1.5 rounded-lg bg-blue-500/20 border border-blue-500/40 text-blue-200 px-3 py-2 text-[12px] font-medium hover:bg-blue-500/30 disabled:opacity-50"
      >
        <Check className="w-3.5 h-3.5" /> {saving ? "Saving…" : "Confirm return"}
      </button>
    </div>
  );
}

function AssignmentForm({ onCancel, onSubmit, saving }: {
  onCancel: () => void;
  onSubmit: (body: Record<string, unknown>) => void;
  saving: boolean;
}) {
  const [holderName, setHolderName] = useState("");
  const [holderEmail, setHolderEmail] = useState("");
  const [holderPhone, setHolderPhone] = useState("");
  const [licenceClass, setLicenceClass] = useState("");
  const [licenceExpiresOn, setLicenceExpiresOn] = useState("");
  const [assignedOn, setAssignedOn] = useState("");
  const [odometerStartKm, setOdometerStartKm] = useState("");
  const [purpose, setPurpose] = useState("");
  const [notes, setNotes] = useState("");

  const canSubmit = holderName.trim() !== "" && assignedOn !== "";

  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3 space-y-2.5">
      <div className="grid grid-cols-2 gap-2.5">
        <div>
          <label className={labelCls}>Who has it *</label>
          <input value={holderName} onChange={(e) => setHolderName(e.target.value)} className={inputCls} autoFocus />
        </div>
        <div>
          <label className={labelCls}>Assigned on *</label>
          <input type="date" value={assignedOn} onChange={(e) => setAssignedOn(e.target.value)} className={inputCls} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2.5">
        <div>
          <label className={labelCls}>Email</label>
          <input value={holderEmail} onChange={(e) => setHolderEmail(e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>Phone</label>
          <input value={holderPhone} onChange={(e) => setHolderPhone(e.target.value)} className={inputCls} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2.5">
        <div>
          <label className={labelCls}>Licence class</label>
          <input value={licenceClass} onChange={(e) => setLicenceClass(e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>Licence expiry</label>
          <input type="date" value={licenceExpiresOn} onChange={(e) => setLicenceExpiresOn(e.target.value)} className={inputCls} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2.5">
        <div>
          <label className={labelCls}>Odometer at handover (km)</label>
          <input type="number" min={0} value={odometerStartKm} onChange={(e) => setOdometerStartKm(e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>Purpose</label>
          <input value={purpose} onChange={(e) => setPurpose(e.target.value)} className={inputCls} />
        </div>
      </div>
      <div>
        <label className={labelCls}>Notes</label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} className={inputCls + " min-h-[50px]"} />
      </div>
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="text-[12px] text-white/40 hover:text-white/70 px-2 py-2">Cancel</button>
        <button
          disabled={!canSubmit || saving}
          onClick={() => onSubmit({
            holderName: holderName.trim(),
            holderEmail: holderEmail.trim() || null,
            holderPhone: holderPhone.trim() || null,
            licenceClass: licenceClass.trim() || null,
            licenceExpiresOn: licenceExpiresOn || null,
            assignedOn,
            odometerStartKm: odometerStartKm.trim() ? Number(odometerStartKm) : null,
            purpose: purpose.trim() || null,
            notes: notes.trim() || null,
          })}
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-500/20 border border-blue-500/40 text-blue-200 px-3 py-2 text-[12px] font-medium hover:bg-blue-500/30 disabled:opacity-50"
        >
          <Check className="w-3.5 h-3.5" /> {saving ? "Saving…" : "Add"}
        </button>
      </div>
    </div>
  );
}

// ── Insurance tab ────────────────────────────────────────────────────────────
function InsuranceTab({ policies, mut }: { policies: InsurancePolicy[]; mut: ReturnType<typeof useChildMutations> }) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);

  return (
    <div className="space-y-2 pb-2">
      {policies.map((p) =>
        editingId === p.id ? (
          <InsuranceForm
            key={p.id}
            policy={p}
            onCancel={() => setEditingId(null)}
            saving={mut.updateMut.isPending}
            onSubmit={(body) => { mut.updateMut.mutate({ id: p.id, ...body }); setEditingId(null); }}
          />
        ) : (
          <div key={p.id} className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[13px] font-medium text-white/90">{p.insurer} <span className="text-white/35 font-normal">· {p.policyNumber}</span></div>
                <div className="text-[11px] text-white/45 mt-0.5">{INSURANCE_COVER_LABELS[p.coverType]} · {formatNzDate(p.startsOn)} – {formatNzDate(p.expiresOn)}</div>
                <div className="flex flex-wrap gap-x-3 text-[11px] text-white/40 mt-1">
                  {p.excessCents != null && <span>Excess {formatCurrency(p.excessCents, { fromCents: true })}</span>}
                  {p.premiumCents != null && <span>Premium {formatCurrency(p.premiumCents, { fromCents: true })}</span>}
                  {p.agreedValueCents != null && <span>Agreed value {formatCurrency(p.agreedValueCents, { fromCents: true })}</span>}
                </div>
                {(p.contactName || p.contactPhone) && <div className="text-[11px] text-white/35 mt-1">{p.contactName ?? "—"} · {p.contactPhone ?? "—"}</div>}
                {p.notes && <div className="text-[12px] text-white/50 mt-1 whitespace-pre-wrap">{p.notes}</div>}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button onClick={() => setEditingId(p.id)} className="w-7 h-7 rounded-lg text-white/30 hover:text-white hover:bg-white/[0.06] flex items-center justify-center"><Pencil className="w-3.5 h-3.5" /></button>
                <button onClick={() => { if (confirm("Delete this policy?")) mut.deleteMut.mutate(p.id); }} className="w-7 h-7 rounded-lg text-white/30 hover:text-red-400 hover:bg-white/[0.06] flex items-center justify-center"><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
            </div>
          </div>
        ),
      )}
      {!policies.length && !adding && <div className="text-[12px] text-white/30">No insurance policies recorded yet.</div>}

      {adding ? (
        <InsuranceForm onCancel={() => setAdding(false)} saving={mut.createMut.isPending} onSubmit={(body) => { mut.createMut.mutate(body); setAdding(false); }} />
      ) : (
        <button onClick={() => setAdding(true)} className="inline-flex items-center gap-1.5 text-[12px] text-blue-300 hover:text-blue-200">
          <Plus className="w-3.5 h-3.5" /> Add policy
        </button>
      )}
    </div>
  );
}

function InsuranceForm({ policy, onCancel, onSubmit, saving }: {
  policy?: InsurancePolicy;
  onCancel: () => void;
  onSubmit: (body: Record<string, unknown>) => void;
  saving: boolean;
}) {
  const [insurer, setInsurer] = useState(policy?.insurer ?? "");
  const [policyNumber, setPolicyNumber] = useState(policy?.policyNumber ?? "");
  const [coverType, setCoverType] = useState<InsuranceCoverType>(policy?.coverType ?? "comprehensive");
  const [startsOn, setStartsOn] = useState(policy?.startsOn ?? "");
  const [expiresOn, setExpiresOn] = useState(policy?.expiresOn ?? "");
  const [excess, setExcess] = useState(centsToDollarInput(policy?.excessCents));
  const [premium, setPremium] = useState(centsToDollarInput(policy?.premiumCents));
  const [agreedValue, setAgreedValue] = useState(centsToDollarInput(policy?.agreedValueCents));
  const [contactName, setContactName] = useState(policy?.contactName ?? "");
  const [contactPhone, setContactPhone] = useState(policy?.contactPhone ?? "");
  const [notes, setNotes] = useState(policy?.notes ?? "");

  const canSubmit = insurer.trim() !== "" && policyNumber.trim() !== "" && startsOn !== "" && expiresOn !== "";

  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3 space-y-2.5">
      <div className="grid grid-cols-2 gap-2.5">
        <div>
          <label className={labelCls}>Insurer *</label>
          <input value={insurer} onChange={(e) => setInsurer(e.target.value)} className={inputCls} autoFocus />
        </div>
        <div>
          <label className={labelCls}>Policy number *</label>
          <input value={policyNumber} onChange={(e) => setPolicyNumber(e.target.value)} className={inputCls} />
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
        <div>
          <label className={labelCls}>Cover type</label>
          <select value={coverType} onChange={(e) => setCoverType(e.target.value as InsuranceCoverType)} className={inputCls + " cursor-pointer"}>
            {INSURANCE_COVER_TYPES.map((c) => <option key={c} value={c}>{INSURANCE_COVER_LABELS[c]}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls}>Starts *</label>
          <input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>Expires *</label>
          <input type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} className={inputCls} />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2.5">
        <div>
          <label className={labelCls}>Excess</label>
          <MoneyInput value={excess} onChange={setExcess} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>Premium</label>
          <MoneyInput value={premium} onChange={setPremium} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>Agreed value</label>
          <MoneyInput value={agreedValue} onChange={setAgreedValue} className={inputCls} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2.5">
        <div>
          <label className={labelCls}>Contact name</label>
          <input value={contactName} onChange={(e) => setContactName(e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>Contact phone</label>
          <input value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} className={inputCls} />
        </div>
      </div>
      <div>
        <label className={labelCls}>Notes</label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} className={inputCls + " min-h-[50px]"} />
      </div>
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="text-[12px] text-white/40 hover:text-white/70 px-2 py-2">Cancel</button>
        <button
          disabled={!canSubmit || saving}
          onClick={() => onSubmit({
            insurer: insurer.trim(),
            policyNumber: policyNumber.trim(),
            coverType,
            startsOn,
            expiresOn,
            excessCents: excess.trim() ? dollarInputToCents(excess) : null,
            premiumCents: premium.trim() ? dollarInputToCents(premium) : null,
            agreedValueCents: agreedValue.trim() ? dollarInputToCents(agreedValue) : null,
            contactName: contactName.trim() || null,
            contactPhone: contactPhone.trim() || null,
            notes: notes.trim() || null,
          })}
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-500/20 border border-blue-500/40 text-blue-200 px-3 py-2 text-[12px] font-medium hover:bg-blue-500/30 disabled:opacity-50"
        >
          <Check className="w-3.5 h-3.5" /> {saving ? "Saving…" : policy ? "Save" : "Add"}
        </button>
      </div>
    </div>
  );
}

// ── Servicing tab ────────────────────────────────────────────────────────────
function ServicingTab({ services, mut }: { services: ServiceRecord[]; mut: ReturnType<typeof useChildMutations> }) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);

  return (
    <div className="space-y-2 pb-2">
      {services.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-white/[0.06]">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-white/35 border-b border-white/[0.06]">
                <th className="px-3 py-2 font-medium">Date</th>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium">Provider</th>
                <th className="px-3 py-2 font-medium">Odometer</th>
                <th className="px-3 py-2 font-medium">Cost</th>
                <th className="px-3 py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {services.map((s) => (
                <tr key={s.id} className="border-b border-white/[0.04] last:border-0">
                  <td className="px-3 py-2 whitespace-nowrap text-white/70">{formatNzDate(s.servicedOn)}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-white/70">{SERVICE_TYPE_LABELS[s.serviceType]}</td>
                  <td className="px-3 py-2 text-white/60">{s.provider ?? "—"}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-white/60">{s.odometerKm != null ? `${formatNumber(s.odometerKm)} km` : "—"}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-white/60">{s.costCents != null ? formatCurrency(s.costCents, { fromCents: true }) : "—"}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-right">
                    <button onClick={() => setEditingId(s.id)} className="text-white/30 hover:text-white mr-2"><Pencil className="w-3.5 h-3.5 inline" /></button>
                    <button onClick={() => { if (confirm("Delete this service record?")) mut.deleteMut.mutate(s.id); }} className="text-white/30 hover:text-red-400"><Trash2 className="w-3.5 h-3.5 inline" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!services.length && !adding && <div className="text-[12px] text-white/30">No servicing history yet.</div>}

      {editingId != null && (
        <ServiceForm
          service={services.find((s) => s.id === editingId)}
          onCancel={() => setEditingId(null)}
          saving={mut.updateMut.isPending}
          onSubmit={(body) => { mut.updateMut.mutate({ id: editingId, ...body }); setEditingId(null); }}
        />
      )}

      {adding ? (
        <ServiceForm onCancel={() => setAdding(false)} saving={mut.createMut.isPending} onSubmit={(body) => { mut.createMut.mutate(body); setAdding(false); }} />
      ) : (
        <button onClick={() => setAdding(true)} className="inline-flex items-center gap-1.5 text-[12px] text-blue-300 hover:text-blue-200">
          <Plus className="w-3.5 h-3.5" /> Add service record
        </button>
      )}
    </div>
  );
}

function ServiceForm({ service, onCancel, onSubmit, saving }: {
  service?: ServiceRecord;
  onCancel: () => void;
  onSubmit: (body: Record<string, unknown>) => void;
  saving: boolean;
}) {
  const [servicedOn, setServicedOn] = useState(service?.servicedOn ?? "");
  const [serviceType, setServiceType] = useState<ServiceType>(service?.serviceType ?? "service");
  const [provider, setProvider] = useState(service?.provider ?? "");
  const [odometerKm, setOdometerKm] = useState(service?.odometerKm != null ? String(service.odometerKm) : "");
  const [description, setDescription] = useState(service?.description ?? "");
  const [cost, setCost] = useState(centsToDollarInput(service?.costCents));
  const [invoiceRef, setInvoiceRef] = useState(service?.invoiceRef ?? "");
  const [nextServiceDueOn, setNextServiceDueOn] = useState(service?.nextServiceDueOn ?? "");
  const [nextServiceDueKm, setNextServiceDueKm] = useState(service?.nextServiceDueKm != null ? String(service.nextServiceDueKm) : "");
  const [notes, setNotes] = useState(service?.notes ?? "");

  const canSubmit = servicedOn !== "";

  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3 space-y-2.5">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
        <div>
          <label className={labelCls}>Date *</label>
          <input type="date" value={servicedOn} onChange={(e) => setServicedOn(e.target.value)} className={inputCls} autoFocus />
        </div>
        <div>
          <label className={labelCls}>Type</label>
          <select value={serviceType} onChange={(e) => setServiceType(e.target.value as ServiceType)} className={inputCls + " cursor-pointer"}>
            {SERVICE_TYPES.map((t) => <option key={t} value={t}>{SERVICE_TYPE_LABELS[t]}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls}>Provider</label>
          <input value={provider} onChange={(e) => setProvider(e.target.value)} className={inputCls} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2.5">
        <div>
          <label className={labelCls}>Odometer (km)</label>
          <input type="number" min={0} value={odometerKm} onChange={(e) => setOdometerKm(e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>Cost</label>
          <MoneyInput value={cost} onChange={setCost} className={inputCls} />
        </div>
      </div>
      <div>
        <label className={labelCls}>Description</label>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} className={inputCls + " min-h-[50px]"} />
      </div>
      <div>
        <label className={labelCls}>Invoice reference</label>
        <input value={invoiceRef} onChange={(e) => setInvoiceRef(e.target.value)} className={inputCls} />
      </div>
      <div className="grid grid-cols-2 gap-2.5">
        <div>
          <label className={labelCls}>Next service due</label>
          <input type="date" value={nextServiceDueOn} onChange={(e) => setNextServiceDueOn(e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>Next service due (km)</label>
          <input type="number" min={0} value={nextServiceDueKm} onChange={(e) => setNextServiceDueKm(e.target.value)} className={inputCls} />
        </div>
      </div>
      <div>
        <label className={labelCls}>Notes</label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} className={inputCls + " min-h-[50px]"} />
      </div>
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="text-[12px] text-white/40 hover:text-white/70 px-2 py-2">Cancel</button>
        <button
          disabled={!canSubmit || saving}
          onClick={() => onSubmit({
            servicedOn,
            serviceType,
            provider: provider.trim() || null,
            odometerKm: odometerKm.trim() ? Number(odometerKm) : null,
            description: description.trim() || null,
            costCents: cost.trim() ? dollarInputToCents(cost) : null,
            invoiceRef: invoiceRef.trim() || null,
            nextServiceDueOn: nextServiceDueOn || null,
            nextServiceDueKm: nextServiceDueKm.trim() ? Number(nextServiceDueKm) : null,
            notes: notes.trim() || null,
          })}
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-500/20 border border-blue-500/40 text-blue-200 px-3 py-2 text-[12px] font-medium hover:bg-blue-500/30 disabled:opacity-50"
        >
          <Check className="w-3.5 h-3.5" /> {saving ? "Saving…" : service ? "Save" : "Add"}
        </button>
      </div>
    </div>
  );
}

// ── Costs tab ────────────────────────────────────────────────────────────────
function CostsTab({ costs, costSummary, mut }: {
  costs: CostRecord[];
  costSummary: CostSummary;
  mut: ReturnType<typeof useChildMutations>;
}) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<"all" | CostCategory>("all");

  const filtered = categoryFilter === "all" ? costs : costs.filter((c) => c.category === categoryFilter);
  const categoriesWithCosts = COST_CATEGORIES.filter((c) => (costSummary.byCategory[c] ?? 0) > 0);

  return (
    <div className="space-y-3 pb-2">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5">
          <div className="text-[10px] text-white/35 uppercase tracking-wide">Total</div>
          <div className="text-[14px] font-semibold text-white/90 mt-0.5">{formatCurrency(costSummary.totalCents, { fromCents: true })}</div>
        </div>
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5">
          <div className="text-[10px] text-white/35 uppercase tracking-wide">Last 12 months</div>
          <div className="text-[14px] font-semibold text-white/90 mt-0.5">{formatCurrency(costSummary.last12mCents, { fromCents: true })}</div>
        </div>
        {costSummary.centsPerLitre != null && (
          <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5">
            <div className="text-[10px] text-white/35 uppercase tracking-wide">Cost per litre</div>
            <div className="text-[14px] font-semibold text-white/90 mt-0.5">{formatCurrency(costSummary.centsPerLitre, { fromCents: true })}</div>
          </div>
        )}
        {costSummary.litresPer100km != null && (
          <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5">
            <div className="text-[10px] text-white/35 uppercase tracking-wide">L / 100km</div>
            <div className="text-[14px] font-semibold text-white/90 mt-0.5">{costSummary.litresPer100km}</div>
          </div>
        )}
      </div>

      {categoriesWithCosts.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {categoriesWithCosts.map((c) => (
            <span key={c} className="text-[11px] rounded-full bg-white/[0.04] border border-white/10 text-white/60 px-2 py-0.5">
              {COST_CATEGORY_LABELS[c]} · {formatCurrency(costSummary.byCategory[c] ?? 0, { fromCents: true })}
            </span>
          ))}
        </div>
      )}

      <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value as "all" | CostCategory)} className={selectCls}>
        <option value="all">All categories</option>
        {COST_CATEGORIES.map((c) => <option key={c} value={c}>{COST_CATEGORY_LABELS[c]}</option>)}
      </select>

      {filtered.length > 0 ? (
        <div className="overflow-x-auto rounded-xl border border-white/[0.06]">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-white/35 border-b border-white/[0.06]">
                <th className="px-3 py-2 font-medium">Date</th>
                <th className="px-3 py-2 font-medium">Category</th>
                <th className="px-3 py-2 font-medium">Amount</th>
                <th className="px-3 py-2 font-medium">Supplier</th>
                <th className="px-3 py-2 font-medium">Odometer</th>
                <th className="px-3 py-2 font-medium">Litres</th>
                <th className="px-3 py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.id} className="border-b border-white/[0.04] last:border-0">
                  <td className="px-3 py-2 whitespace-nowrap text-white/70">{formatNzDate(c.incurredOn)}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-white/70">{COST_CATEGORY_LABELS[c.category]}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-white/60">{formatCurrency(c.amountCents, { fromCents: true })}</td>
                  <td className="px-3 py-2 text-white/60">{c.supplier ?? "—"}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-white/60">{c.odometerKm != null ? `${formatNumber(c.odometerKm)} km` : "—"}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-white/60">{c.litres != null ? c.litres : "—"}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-right">
                    <button onClick={() => setEditingId(c.id)} className="text-white/30 hover:text-white mr-2"><Pencil className="w-3.5 h-3.5 inline" /></button>
                    <button onClick={() => { if (confirm("Delete this cost record?")) mut.deleteMut.mutate(c.id); }} className="text-white/30 hover:text-red-400"><Trash2 className="w-3.5 h-3.5 inline" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="text-[12px] text-white/30">No costs recorded{categoryFilter !== "all" ? " in this category" : ""} yet.</div>
      )}

      {editingId != null && (
        <CostForm
          cost={costs.find((c) => c.id === editingId)}
          onCancel={() => setEditingId(null)}
          saving={mut.updateMut.isPending}
          onSubmit={(body) => { mut.updateMut.mutate({ id: editingId, ...body }); setEditingId(null); }}
        />
      )}

      {adding ? (
        <CostForm onCancel={() => setAdding(false)} saving={mut.createMut.isPending} onSubmit={(body) => { mut.createMut.mutate(body); setAdding(false); }} />
      ) : (
        <button onClick={() => setAdding(true)} className="inline-flex items-center gap-1.5 text-[12px] text-blue-300 hover:text-blue-200">
          <Plus className="w-3.5 h-3.5" /> Add cost
        </button>
      )}
    </div>
  );
}

function CostForm({ cost, onCancel, onSubmit, saving }: {
  cost?: CostRecord;
  onCancel: () => void;
  onSubmit: (body: Record<string, unknown>) => void;
  saving: boolean;
}) {
  const [incurredOn, setIncurredOn] = useState(cost?.incurredOn ?? "");
  const [category, setCategory] = useState<CostCategory>(cost?.category ?? "fuel");
  const [amount, setAmount] = useState(centsToDollarInput(cost?.amountCents));
  const [supplier, setSupplier] = useState(cost?.supplier ?? "");
  const [reference, setReference] = useState(cost?.reference ?? "");
  const [odometerKm, setOdometerKm] = useState(cost?.odometerKm != null ? String(cost.odometerKm) : "");
  const [litres, setLitres] = useState(cost?.litres != null ? String(cost.litres) : "");
  const [notes, setNotes] = useState(cost?.notes ?? "");

  const canSubmit = incurredOn !== "" && amount.trim() !== "";

  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3 space-y-2.5">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
        <div>
          <label className={labelCls}>Date *</label>
          <input type="date" value={incurredOn} onChange={(e) => setIncurredOn(e.target.value)} className={inputCls} autoFocus />
        </div>
        <div>
          <label className={labelCls}>Category *</label>
          <select value={category} onChange={(e) => setCategory(e.target.value as CostCategory)} className={inputCls + " cursor-pointer"}>
            {COST_CATEGORIES.map((c) => <option key={c} value={c}>{COST_CATEGORY_LABELS[c]}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls}>Amount *</label>
          <MoneyInput value={amount} onChange={setAmount} className={inputCls} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2.5">
        <div>
          <label className={labelCls}>Supplier</label>
          <input value={supplier} onChange={(e) => setSupplier(e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>Reference</label>
          <input value={reference} onChange={(e) => setReference(e.target.value)} className={inputCls} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2.5">
        <div>
          <label className={labelCls}>Odometer (km)</label>
          <input type="number" min={0} value={odometerKm} onChange={(e) => setOdometerKm(e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>Litres {category === "fuel" ? "" : "(fuel only)"}</label>
          <input type="number" min={0} step="0.01" value={litres} onChange={(e) => setLitres(e.target.value)} className={inputCls} />
        </div>
      </div>
      <div>
        <label className={labelCls}>Notes</label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} className={inputCls + " min-h-[50px]"} />
      </div>
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="text-[12px] text-white/40 hover:text-white/70 px-2 py-2">Cancel</button>
        <button
          disabled={!canSubmit || saving}
          onClick={() => onSubmit({
            incurredOn,
            category,
            amountCents: dollarInputToCents(amount),
            supplier: supplier.trim() || null,
            reference: reference.trim() || null,
            odometerKm: odometerKm.trim() ? Number(odometerKm) : null,
            litres: litres.trim() ? Number(litres) : null,
            notes: notes.trim() || null,
          })}
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-500/20 border border-blue-500/40 text-blue-200 px-3 py-2 text-[12px] font-medium hover:bg-blue-500/30 disabled:opacity-50"
        >
          <Check className="w-3.5 h-3.5" /> {saving ? "Saving…" : cost ? "Save" : "Add"}
        </button>
      </div>
    </div>
  );
}
