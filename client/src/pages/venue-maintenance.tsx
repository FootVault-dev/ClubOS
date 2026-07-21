// ─────────────────────────────────────────────────────────────────────────────
// MAINTENANCE — the "Maintenance" tab in the venue workspace of ClubOS.
//
// Built for Riley, the facility/grounds staffer — phone-first. Tracks the
// cleaning/consumable supplies (quantity on hand, reorder levels, an
// append-only stock-movement log) and the machines & equipment (mowers,
// tractors… a register with service history and next-service-due dates).
//
// House style follows venue-housing.tsx (dark-glass cards, rounded-2xl,
// white/10 borders, react-query + apiRequest, shadcn Dialog forms, native
// <select> for enums, apiErrorMessage surfacing the server's human-readable
// messages). Vocabularies and status logic all come from @shared/maintenance —
// never redeclared here. Money is always dollars on screen (MoneyInput /
// formatCurrency); dates are always server-derived strings, never `new Date()`
// for anything sent to the API.
//
// Unlike housing, lists render as CARDS on mobile (never a horizontally
// scrolling table) and a proper table from `md` up — Riley is on a phone, and
// a table that scrolls sideways is exactly the thing to avoid for him.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency, dollarInputToCents, centsToDollarInput } from "@/lib/format";
import { MoneyInput } from "@/components/ui/money-input";
import { DatePickerInput } from "@/components/ui/date-picker-input";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
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
  Wrench, Plus, Pencil, Trash2, PackageX, PackageMinus, CalendarClock,
  AlertTriangle, ArrowUpCircle, ArrowDownCircle, History, X, type LucideIcon,
} from "lucide-react";
import {
  SUPPLY_CATEGORIES, SUPPLY_CATEGORY_LABELS,
  STOCK_MOVEMENT_REASONS, STOCK_MOVEMENT_REASON_LABELS,
  ASSET_CATEGORIES, ASSET_CATEGORY_LABELS,
  SERVICE_RECORD_KINDS, SERVICE_RECORD_KIND_LABELS,
  isIsoDate,
  type SupplyCategory, type StockStatus, type StockMovementReason,
  type AssetCategory, type ServiceStatus, type ServiceRecordKind,
} from "@shared/maintenance";

// ── Types — client-local mirrors of the /api/admin/maintenance/* JSON shapes ─

interface OverviewData {
  today: string;
  outOfStock: number;
  lowStock: number;
  servicesOverdue: number;
  servicesDueSoon: number;
  unauditedMachines: number;
}

interface SupplyRow {
  id: number;
  name: string;
  category: SupplyCategory;
  unit: string | null;
  qtyOnHand: number;
  reorderLevel: number | null;
  location: string | null;
  supplier: string | null;
  costCents: number | null;
  notes: string | null;
  status: "active" | "archived";
  stockStatus: StockStatus;
}

interface MovementRow {
  id: number;
  supplyId: number;
  delta: number;
  reason: StockMovementReason;
  note: string | null;
  recordedBy: string | null;
  createdAt: string;
}

interface AssetRow {
  id: number;
  name: string;
  category: AssetCategory;
  make: string | null;
  model: string | null;
  serial: string | null;
  location: string | null;
  purchaseDate: string | null;
  purchaseCostCents: number | null;
  lastServicedOn: string | null;
  nextServiceDueOn: string | null;
  status: "active" | "retired";
  notes: string | null;
  serviceStatus: ServiceStatus;
}

interface ServiceRecordRow {
  id: number;
  assetId: number;
  servicedOn: string;
  kind: ServiceRecordKind;
  performedBy: string | null;
  costCents: number | null;
  nextDueOn: string | null;
  notes: string | null;
  createdAt: string;
}

// ── Local label/colour maps — the vocab itself always comes from @shared ────

const STOCK_STATUS_LABELS: Record<StockStatus, string> = {
  out: "Out of stock", low: "Low stock", no_level: "Set level", ok: "OK",
};
const STOCK_STATUS_COLOR: Record<StockStatus, string> = {
  out: "#ef4444", low: "#eab308", no_level: "#64748b", ok: "#22c55e",
};

const SERVICE_STATUS_LABELS: Record<ServiceStatus, string> = {
  overdue: "Overdue", due_soon: "Due soon", unknown: "Unknown", ok: "OK",
};
const SERVICE_STATUS_COLOR: Record<ServiceStatus, string> = {
  overdue: "#ef4444", due_soon: "#eab308", unknown: "#64748b", ok: "#22c55e",
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const MAINTENANCE_KEYS: string[][] = [
  ["/api/admin/maintenance/overview"],
  ["/api/admin/maintenance/supplies"],
  ["/api/admin/maintenance/assets"],
];

/** Every mutation on this page touches at least two of these aggregates (e.g.
 *  logging a service changes Overview's overdue count AND the asset's own
 *  badge) — invalidate all of them rather than tracking which ones apply. */
function invalidateMaintenance() {
  for (const key of MAINTENANCE_KEYS) queryClient.invalidateQueries({ queryKey: key });
}

/** Best-effort extraction of the server's JSON `message` out of an apiRequest
 *  error, so a 400/409's human-readable reason reaches the toast verbatim. */
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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Format `YYYY-MM-DD` straight from its own calendar parts — never through a
 *  `Date`. Round-tripping an ISO date through `Date` is how this workspace
 *  once printed "18 July" on an invoice due the 17th. */
function fmtNZDate(iso: string | null | undefined): string {
  if (!iso || !isIsoDate(iso)) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso); // a real timestamp (createdAt), safe to construct a Date from
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${d.toLocaleTimeString("en-NZ", { hour: "2-digit", minute: "2-digit" })}`;
}

const inputCls = "w-full rounded-lg bg-white/[0.03] border border-white/10 px-3 py-2 text-sm text-white/90 placeholder:text-white/25 focus:outline-none focus:border-blue-500/50 disabled:opacity-40 disabled:cursor-not-allowed";

// ── Shared small components ──────────────────────────────────────────────────

function StockStatusPill({ status }: { status: StockStatus }) {
  const color = STOCK_STATUS_COLOR[status];
  return (
    <span
      className="inline-flex items-center text-[10px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap"
      style={{ background: `${color}22`, color, border: `1px solid ${color}55` }}
    >
      {STOCK_STATUS_LABELS[status]}
    </span>
  );
}

function ServiceStatusPill({ status }: { status: ServiceStatus }) {
  const color = SERVICE_STATUS_COLOR[status];
  return (
    <span
      className="inline-flex items-center text-[10px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap"
      style={{ background: `${color}22`, color, border: `1px solid ${color}55` }}
    >
      {SERVICE_STATUS_LABELS[status]}
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

function ConfirmDialog({
  open, onOpenChange, title, description, confirmLabel = "Delete", pending, onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  pending: boolean;
  onConfirm: () => void;
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
            className="bg-red-500/90 hover:bg-red-500 text-white border-0"
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

function RowActionButton({ onClick, title, icon: Icon, tone = "default" }: { onClick: () => void; title: string; icon: LucideIcon; tone?: "default" | "danger" }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`w-9 h-9 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center text-white/30 hover:bg-white/[0.06] ${tone === "danger" ? "hover:text-red-400" : "hover:text-white/70"}`}
      data-testid={`button-${title.toLowerCase().replace(/\s+/g, "-")}`}
    >
      <Icon className="w-3.5 h-3.5" />
    </button>
  );
}

// ── Overview stat strip (always visible, above the tabs) ────────────────────

function MaintenanceStatStrip() {
  const { data: overview, isLoading } = useQuery<OverviewData>({ queryKey: ["/api/admin/maintenance/overview"] });

  if (isLoading || !overview) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-20 rounded-2xl bg-white/[0.04]" />)}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard
          label="Out of stock"
          value={String(overview.outOfStock)}
          sub={overview.outOfStock > 0 ? "Needs reordering" : "All clear"}
          icon={PackageX}
          color={overview.outOfStock > 0 ? "#ef4444" : "#22c55e"}
        />
        <StatCard
          label="Low stock"
          value={String(overview.lowStock)}
          sub={overview.lowStock > 0 ? "Order soon" : "All clear"}
          icon={PackageMinus}
          color={overview.lowStock > 0 ? "#eab308" : "#22c55e"}
        />
        <StatCard
          label="Services overdue"
          value={String(overview.servicesOverdue)}
          sub={overview.servicesOverdue > 0 ? "Book these in" : "All clear"}
          icon={Wrench}
          color={overview.servicesOverdue > 0 ? "#ef4444" : "#22c55e"}
        />
        <StatCard
          label="Due in 30 days"
          value={String(overview.servicesDueSoon)}
          sub="Upcoming services"
          icon={CalendarClock}
          color={overview.servicesDueSoon > 0 ? "#eab308" : "#22c55e"}
        />
      </div>
      {overview.unauditedMachines > 0 && (
        <div className="flex items-center gap-2 rounded-xl border border-amber-500/20 bg-amber-500/[0.05] px-3.5 py-2.5" data-testid="nag-unaudited-machines">
          <AlertTriangle className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
          <span className="text-[12px] text-amber-200/90">
            {overview.unauditedMachines} machine{overview.unauditedMachines === 1 ? "" : "s"} {overview.unauditedMachines === 1 ? "has" : "have"} no service date recorded
          </span>
        </div>
      )}
    </div>
  );
}

// ═══ SUPPLIES ═══════════════════════════════════════════════════════════════

function SuppliesSkeleton() {
  return (
    <div className="space-y-3">
      {[1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-2xl bg-white/[0.04]" />)}
    </div>
  );
}

function SupplyFormDialog({ open, onOpenChange, supply }: { open: boolean; onOpenChange: (v: boolean) => void; supply: SupplyRow | undefined }) {
  const { toast } = useToast();
  const isEdit = !!supply;
  const [name, setName] = useState(supply?.name ?? "");
  const [category, setCategory] = useState<SupplyCategory>(supply?.category ?? "cleaning");
  const [unit, setUnit] = useState(supply?.unit ?? "");
  const [qtyOnHand, setQtyOnHand] = useState(String(supply?.qtyOnHand ?? 0));
  const [reorderLevel, setReorderLevel] = useState(supply?.reorderLevel != null ? String(supply.reorderLevel) : "");
  const [location, setLocation] = useState(supply?.location ?? "");
  const [supplier, setSupplier] = useState(supply?.supplier ?? "");
  const [cost, setCost] = useState(centsToDollarInput(supply?.costCents ?? null));
  const [notes, setNotes] = useState(supply?.notes ?? "");

  const mutation = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        name: name.trim(), category, unit: unit.trim() || null,
        reorderLevel: reorderLevel.trim() === "" ? null : Number(reorderLevel),
        location: location.trim() || null,
        supplier: supplier.trim() || null,
        costCents: cost.trim() === "" ? null : dollarInputToCents(cost),
        notes: notes.trim() || null,
      };
      if (!isEdit) body.qtyOnHand = qtyOnHand.trim() === "" ? 0 : Number(qtyOnHand);
      return isEdit && supply
        ? apiRequest("PATCH", `/api/admin/maintenance/supplies/${supply.id}`, body)
        : apiRequest("POST", "/api/admin/maintenance/supplies", body);
    },
    onSuccess: () => { invalidateMaintenance(); toast({ title: isEdit ? "Supply updated" : "Supply added" }); onOpenChange(false); },
    onError: (e: unknown) => toast({ title: "Couldn't save supply", description: apiErrorMessage(e), variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md bg-[#0a0f1a] border border-white/10 text-white/90 max-h-[85vh] overflow-y-auto">
        <h2 className="text-base font-semibold mb-3">{isEdit ? "Edit supply" : "Add supply"}</h2>
        <div className="space-y-3">
          <div>
            <label className="text-[11px] text-white/40 mb-1 block">Name *</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Glass cleaner" className={inputCls} autoFocus data-testid="input-supply-name" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[11px] text-white/40 mb-1 block">Category</label>
              <select value={category} onChange={(e) => setCategory(e.target.value as SupplyCategory)} className={inputCls + " cursor-pointer"} data-testid="select-supply-category">
                {SUPPLY_CATEGORIES.map((c) => <option key={c} value={c}>{SUPPLY_CATEGORY_LABELS[c]}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[11px] text-white/40 mb-1 block">Unit</label>
              <input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="bottles, rolls, L…" className={inputCls} data-testid="input-supply-unit" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {!isEdit && (
              <div>
                <label className="text-[11px] text-white/40 mb-1 block">Qty on hand</label>
                <input
                  inputMode="numeric" value={qtyOnHand}
                  onChange={(e) => setQtyOnHand(e.target.value.replace(/[^0-9]/g, ""))}
                  className={inputCls} data-testid="input-supply-qty"
                />
              </div>
            )}
            <div className={isEdit ? "col-span-2" : ""}>
              <label className="text-[11px] text-white/40 mb-1 block">Reorder level</label>
              <input
                inputMode="numeric" value={reorderLevel}
                onChange={(e) => setReorderLevel(e.target.value.replace(/[^0-9]/g, ""))}
                placeholder="Not set" className={inputCls} data-testid="input-supply-reorder-level"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[11px] text-white/40 mb-1 block">Location</label>
              <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Store room" className={inputCls} data-testid="input-supply-location" />
            </div>
            <div>
              <label className="text-[11px] text-white/40 mb-1 block">Supplier</label>
              <input value={supplier} onChange={(e) => setSupplier(e.target.value)} className={inputCls} data-testid="input-supply-supplier" />
            </div>
          </div>
          <div>
            <label className="text-[11px] text-white/40 mb-1 block">Reference unit cost</label>
            <MoneyInput value={cost} onChange={setCost} data-testid="input-supply-cost" />
          </div>
          <div>
            <label className="text-[11px] text-white/40 mb-1 block">Notes</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} className={inputCls + " min-h-[60px]"} data-testid="input-supply-notes" />
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={() => onOpenChange(false)} className="rounded-xl px-4 py-2 text-sm text-white/50 hover:text-white/80">Cancel</button>
          <button
            onClick={() => mutation.mutate()}
            disabled={!name.trim() || mutation.isPending}
            className="inline-flex items-center gap-2 rounded-xl bg-blue-500/20 border border-blue-500/40 text-blue-200 px-4 py-2 text-sm font-medium hover:bg-blue-500/30 disabled:opacity-50"
            data-testid="button-save-supply"
          >
            {mutation.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AdjustStockDialog({ supply, onClose }: { supply: SupplyRow; onClose: () => void }) {
  const { toast } = useToast();
  const [direction, setDirection] = useState<"add" | "remove">("add");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState<StockMovementReason>("received");
  const [note, setNote] = useState("");

  const setDirectionAndDefaultReason = (dir: "add" | "remove") => {
    setDirection(dir);
    setReason(dir === "add" ? "received" : "used");
  };

  const mutation = useMutation({
    mutationFn: () => {
      const n = Number(amount);
      const delta = direction === "add" ? n : -n;
      return apiRequest("POST", `/api/admin/maintenance/supplies/${supply.id}/movements`, { delta, reason, note: note.trim() || null });
    },
    onSuccess: () => {
      invalidateMaintenance();
      queryClient.invalidateQueries({ queryKey: ["/api/admin/maintenance/supplies", supply.id, "movements"] });
      toast({ title: "Stock updated" });
      onClose();
    },
    onError: (e: unknown) => toast({ title: "Couldn't adjust stock", description: apiErrorMessage(e), variant: "destructive" }),
  });

  const n = Number(amount);
  const canSubmit = amount.trim() !== "" && Number.isFinite(n) && n > 0;

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-sm bg-[#0a0f1a] border border-white/10 text-white/90">
        <h2 className="text-base font-semibold mb-1">Adjust stock</h2>
        <p className="text-[12px] text-white/40 mb-3">
          {supply.name} — {supply.qtyOnHand} {supply.unit || "on hand"}
        </p>
        <div className="space-y-3">
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setDirectionAndDefaultReason("add")}
              className={`flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-[13px] font-medium min-h-[40px] ${direction === "add" ? "bg-emerald-500/15 border-emerald-500/30 text-emerald-300" : "bg-white/[0.02] border-white/10 text-white/40"}`}
              data-testid="button-adjust-direction-add"
            >
              <ArrowUpCircle className="w-4 h-4" /> Add
            </button>
            <button
              onClick={() => setDirectionAndDefaultReason("remove")}
              className={`flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-[13px] font-medium min-h-[40px] ${direction === "remove" ? "bg-red-500/15 border-red-500/30 text-red-300" : "bg-white/[0.02] border-white/10 text-white/40"}`}
              data-testid="button-adjust-direction-remove"
            >
              <ArrowDownCircle className="w-4 h-4" /> Remove
            </button>
          </div>
          <div>
            <label className="text-[11px] text-white/40 mb-1 block">Amount {supply.unit ? `(${supply.unit})` : ""}</label>
            <input
              inputMode="numeric" value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ""))}
              placeholder="0" className={inputCls} autoFocus data-testid="input-adjust-amount"
            />
          </div>
          <div>
            <label className="text-[11px] text-white/40 mb-1 block">Reason</label>
            <select value={reason} onChange={(e) => setReason(e.target.value as StockMovementReason)} className={inputCls + " cursor-pointer"} data-testid="select-adjust-reason">
              {STOCK_MOVEMENT_REASONS.map((r) => <option key={r} value={r}>{STOCK_MOVEMENT_REASON_LABELS[r]}</option>)}
            </select>
          </div>
          <div>
            <label className="text-[11px] text-white/40 mb-1 block">Note (optional)</label>
            <input value={note} onChange={(e) => setNote(e.target.value)} className={inputCls} data-testid="input-adjust-note" />
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="rounded-xl px-4 py-2 text-sm text-white/50 hover:text-white/80">Cancel</button>
          <button
            onClick={() => mutation.mutate()}
            disabled={!canSubmit || mutation.isPending}
            className="inline-flex items-center gap-2 rounded-xl bg-blue-500/20 border border-blue-500/40 text-blue-200 px-4 py-2 text-sm font-medium hover:bg-blue-500/30 disabled:opacity-50"
            data-testid="button-submit-adjust-stock"
          >
            {mutation.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function MovementHistoryDialog({ supply, onClose }: { supply: SupplyRow; onClose: () => void }) {
  const { data, isLoading } = useQuery<{ today: string; movements: MovementRow[] }>({
    queryKey: ["/api/admin/maintenance/supplies", supply.id, "movements"],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/admin/maintenance/supplies/${supply.id}/movements`);
      return res.json();
    },
  });

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-lg bg-[#0a0f1a] border border-white/10 text-white/90 max-h-[80vh] overflow-y-auto">
        <div className="flex items-start justify-between mb-3">
          <div>
            <h2 className="text-base font-semibold">Stock history</h2>
            <p className="text-[12px] text-white/40">{supply.name}</p>
          </div>
          <button onClick={onClose} className="text-white/40 hover:text-white/70"><X className="w-4 h-4" /></button>
        </div>
        {isLoading ? (
          <div className="space-y-2">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 rounded-lg bg-white/[0.04]" />)}</div>
        ) : !data?.movements.length ? (
          <div className="py-10 text-center text-[13px] text-white/30">No stock movements recorded yet.</div>
        ) : (
          <div className="divide-y divide-white/[0.05]">
            {data.movements.map((m) => (
              <div key={m.id} className="flex items-center gap-3 py-2.5" data-testid={`movement-${m.id}`}>
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${m.delta > 0 ? "bg-emerald-500/10" : "bg-red-500/10"}`}>
                  {m.delta > 0 ? <ArrowUpCircle className="w-4 h-4 text-emerald-400" /> : <ArrowDownCircle className="w-4 h-4 text-red-400" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] text-white/85">
                    <span className={m.delta > 0 ? "text-emerald-300 font-medium" : "text-red-300 font-medium"}>{m.delta > 0 ? "+" : ""}{m.delta}</span>
                    <span className="text-white/40"> · {STOCK_MOVEMENT_REASON_LABELS[m.reason]}</span>
                  </div>
                  {m.note && <div className="text-[11px] text-white/35 truncate">{m.note}</div>}
                </div>
                <div className="text-right flex-shrink-0">
                  <div className="text-[11px] text-white/40">{fmtDateTime(m.createdAt)}</div>
                  {m.recordedBy && <div className="text-[10px] text-white/25">{m.recordedBy}</div>}
                </div>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SupplyCard({ supply, onAdjust, onHistory, onEdit, onDelete }: {
  supply: SupplyRow;
  onAdjust: () => void;
  onHistory: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3.5 space-y-2.5" data-testid={`supply-card-${supply.id}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[14px] font-medium text-white/85 truncate">{supply.name}</div>
          <div className="text-[10px] text-white/35 uppercase tracking-wide">{SUPPLY_CATEGORY_LABELS[supply.category]}</div>
        </div>
        <StockStatusPill status={supply.stockStatus} />
      </div>
      <div className="flex items-center justify-between text-[12px]">
        <span className="text-white/70 font-medium">{supply.qtyOnHand} {supply.unit || "on hand"}</span>
        <span className="text-white/35">{supply.reorderLevel != null ? `reorder at ${supply.reorderLevel}` : "no reorder level set"}</span>
      </div>
      {(supply.location || supply.supplier) && (
        <div className="text-[11px] text-white/35 truncate">{[supply.location, supply.supplier].filter(Boolean).join(" · ")}</div>
      )}
      <div className="flex items-center gap-1.5 pt-1">
        <button
          onClick={onAdjust}
          className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg bg-blue-500/15 border border-blue-500/30 text-blue-300 px-3 py-2 text-[12px] font-medium hover:bg-blue-500/25 min-h-[40px]"
          data-testid={`button-adjust-supply-${supply.id}`}
        >
          <Wrench className="w-3.5 h-3.5" /> Adjust stock
        </button>
        <RowActionButton onClick={onHistory} title="History" icon={History} />
        <RowActionButton onClick={onEdit} title="Edit" icon={Pencil} />
        <RowActionButton onClick={onDelete} title="Delete" icon={Trash2} tone="danger" />
      </div>
    </div>
  );
}

function SuppliesTab() {
  const { toast } = useToast();
  const [includeArchived, setIncludeArchived] = useState(false);
  const { data, isLoading } = useQuery<{ today: string; supplies: SupplyRow[] }>({
    queryKey: ["/api/admin/maintenance/supplies", includeArchived],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/admin/maintenance/supplies${includeArchived ? "?includeArchived=true" : ""}`);
      return res.json();
    },
  });

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<SupplyRow | undefined>(undefined);
  const [adjusting, setAdjusting] = useState<SupplyRow | null>(null);
  const [viewingHistory, setViewingHistory] = useState<SupplyRow | null>(null);
  const [deleting, setDeleting] = useState<SupplyRow | null>(null);

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/admin/maintenance/supplies/${id}`),
    onSuccess: async (res) => {
      const result = await res.json().catch(() => ({}));
      invalidateMaintenance();
      toast({ title: result.archived ? "Supply archived" : "Supply deleted", description: result.reason });
      setDeleting(null);
    },
    onError: (e: unknown) => toast({ title: "Couldn't delete supply", description: apiErrorMessage(e), variant: "destructive" }),
  });

  if (isLoading) return <SuppliesSkeleton />;
  const list = data?.supplies ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <label className="flex items-center gap-2 text-[12px] text-white/50 cursor-pointer select-none">
          <Checkbox checked={includeArchived} onCheckedChange={(v) => setIncludeArchived(!!v)} data-testid="checkbox-show-archived-supplies" />
          Show archived
        </label>
        <button
          onClick={() => { setEditing(undefined); setFormOpen(true); }}
          className="inline-flex items-center gap-2 rounded-xl bg-blue-500/15 border border-blue-500/30 text-blue-300 px-4 py-2 text-sm font-medium hover:bg-blue-500/25 min-h-[44px] sm:min-h-0"
          data-testid="button-add-supply"
        >
          <Plus className="w-4 h-4" /> Add supply
        </button>
      </div>

      {list.length === 0 ? (
        <EmptyState icon={PackageX} title="Add your first supply" action={{ label: "Add supply", onClick: () => { setEditing(undefined); setFormOpen(true); } }} />
      ) : (
        <>
          {/* Mobile: stacked cards, never a horizontally-scrolling table. */}
          <div className="grid grid-cols-1 gap-3 md:hidden">
            {list.map((supply) => (
              <SupplyCard
                key={supply.id}
                supply={supply}
                onAdjust={() => setAdjusting(supply)}
                onHistory={() => setViewingHistory(supply)}
                onEdit={() => { setEditing(supply); setFormOpen(true); }}
                onDelete={() => setDeleting(supply)}
              />
            ))}
          </div>

          {/* Desktop: a real table — nothing here needs to scroll sideways. */}
          <div className="hidden md:block rounded-2xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-white/[0.06] text-[11px] uppercase tracking-wide text-white/35">
                  <th className="px-4 py-2.5 font-medium">Supply</th>
                  <th className="px-4 py-2.5 font-medium">Category</th>
                  <th className="px-4 py-2.5 font-medium">On hand</th>
                  <th className="px-4 py-2.5 font-medium">Reorder level</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium">Location / supplier</th>
                  <th className="px-4 py-2.5 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.05]">
                {list.map((supply) => (
                  <tr key={supply.id} data-testid={`row-supply-${supply.id}`}>
                    <td className="px-4 py-3 text-white/85 font-medium">{supply.name}</td>
                    <td className="px-4 py-3 text-white/60">{SUPPLY_CATEGORY_LABELS[supply.category]}</td>
                    <td className="px-4 py-3 text-white/70">{supply.qtyOnHand} {supply.unit || ""}</td>
                    <td className="px-4 py-3 text-white/50">{supply.reorderLevel ?? "—"}</td>
                    <td className="px-4 py-3"><StockStatusPill status={supply.stockStatus} /></td>
                    <td className="px-4 py-3 text-white/50">{[supply.location, supply.supplier].filter(Boolean).join(" · ") || "—"}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <RowActionButton onClick={() => setAdjusting(supply)} title="Adjust stock" icon={Wrench} />
                        <RowActionButton onClick={() => setViewingHistory(supply)} title="History" icon={History} />
                        <RowActionButton onClick={() => { setEditing(supply); setFormOpen(true); }} title="Edit" icon={Pencil} />
                        <RowActionButton onClick={() => setDeleting(supply)} title="Delete" icon={Trash2} tone="danger" />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <SupplyFormDialog open={formOpen} onOpenChange={setFormOpen} supply={editing} />
      {adjusting && <AdjustStockDialog key={`adjust-${adjusting.id}`} supply={adjusting} onClose={() => setAdjusting(null)} />}
      {viewingHistory && <MovementHistoryDialog key={`history-${viewingHistory.id}`} supply={viewingHistory} onClose={() => setViewingHistory(null)} />}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(v) => { if (!v) setDeleting(null); }}
        title={`Delete ${deleting?.name ?? "this supply"}?`}
        description="If it has any stock movements recorded, it will be archived instead of deleted so the history stays on record."
        pending={deleteMut.isPending}
        onConfirm={() => deleting && deleteMut.mutate(deleting.id)}
      />
    </div>
  );
}

// ═══ MACHINES ═══════════════════════════════════════════════════════════════

function MachinesSkeleton() {
  return (
    <div className="space-y-3">
      {[1, 2, 3].map((i) => <Skeleton key={i} className="h-28 rounded-2xl bg-white/[0.04]" />)}
    </div>
  );
}

function AssetFormDialog({ open, onOpenChange, asset }: { open: boolean; onOpenChange: (v: boolean) => void; asset: AssetRow | undefined }) {
  const { toast } = useToast();
  const isEdit = !!asset;
  const [name, setName] = useState(asset?.name ?? "");
  const [category, setCategory] = useState<AssetCategory>(asset?.category ?? "mower");
  const [make, setMake] = useState(asset?.make ?? "");
  const [model, setModel] = useState(asset?.model ?? "");
  const [serial, setSerial] = useState(asset?.serial ?? "");
  const [location, setLocation] = useState(asset?.location ?? "");
  const [purchaseDate, setPurchaseDate] = useState(asset?.purchaseDate ?? "");
  const [purchaseCost, setPurchaseCost] = useState(centsToDollarInput(asset?.purchaseCostCents ?? null));
  const [notes, setNotes] = useState(asset?.notes ?? "");

  const mutation = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        name: name.trim(), category,
        make: make.trim() || null, model: model.trim() || null, serial: serial.trim() || null,
        location: location.trim() || null,
        purchaseCostCents: purchaseCost.trim() === "" ? null : dollarInputToCents(purchaseCost),
        notes: notes.trim() || null,
      };
      // purchaseDate is only ever set at creation — the fixed asset-record
      // fact, unlike the service dates which come from logging a service.
      if (!isEdit) body.purchaseDate = purchaseDate || null;
      return isEdit && asset
        ? apiRequest("PATCH", `/api/admin/maintenance/assets/${asset.id}`, body)
        : apiRequest("POST", "/api/admin/maintenance/assets", body);
    },
    onSuccess: () => { invalidateMaintenance(); toast({ title: isEdit ? "Machine updated" : "Machine added" }); onOpenChange(false); },
    onError: (e: unknown) => toast({ title: "Couldn't save machine", description: apiErrorMessage(e), variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md bg-[#0a0f1a] border border-white/10 text-white/90 max-h-[85vh] overflow-y-auto">
        <h2 className="text-base font-semibold mb-3">{isEdit ? "Edit machine" : "Add machine"}</h2>
        <div className="space-y-3">
          <div>
            <label className="text-[11px] text-white/40 mb-1 block">Name *</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ride-on mower" className={inputCls} autoFocus data-testid="input-asset-name" />
          </div>
          <div>
            <label className="text-[11px] text-white/40 mb-1 block">Category</label>
            <select value={category} onChange={(e) => setCategory(e.target.value as AssetCategory)} className={inputCls + " cursor-pointer"} data-testid="select-asset-category">
              {ASSET_CATEGORIES.map((c) => <option key={c} value={c}>{ASSET_CATEGORY_LABELS[c]}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[11px] text-white/40 mb-1 block">Make</label>
              <input value={make} onChange={(e) => setMake(e.target.value)} className={inputCls} data-testid="input-asset-make" />
            </div>
            <div>
              <label className="text-[11px] text-white/40 mb-1 block">Model</label>
              <input value={model} onChange={(e) => setModel(e.target.value)} className={inputCls} data-testid="input-asset-model" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[11px] text-white/40 mb-1 block">Serial</label>
              <input value={serial} onChange={(e) => setSerial(e.target.value)} className={inputCls} data-testid="input-asset-serial" />
            </div>
            <div>
              <label className="text-[11px] text-white/40 mb-1 block">Location</label>
              <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Shed" className={inputCls} data-testid="input-asset-location" />
            </div>
          </div>
          {!isEdit && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[11px] text-white/40 mb-1 block">Purchase date</label>
                <DatePickerInput value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} data-testid="input-asset-purchase-date" />
              </div>
              <div>
                <label className="text-[11px] text-white/40 mb-1 block">Purchase cost</label>
                <MoneyInput value={purchaseCost} onChange={setPurchaseCost} data-testid="input-asset-purchase-cost" />
              </div>
            </div>
          )}
          <div>
            <label className="text-[11px] text-white/40 mb-1 block">Notes</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} className={inputCls + " min-h-[60px]"} data-testid="input-asset-notes" />
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={() => onOpenChange(false)} className="rounded-xl px-4 py-2 text-sm text-white/50 hover:text-white/80">Cancel</button>
          <button
            onClick={() => mutation.mutate()}
            disabled={!name.trim() || mutation.isPending}
            className="inline-flex items-center gap-2 rounded-xl bg-blue-500/20 border border-blue-500/40 text-blue-200 px-4 py-2 text-sm font-medium hover:bg-blue-500/30 disabled:opacity-50"
            data-testid="button-save-asset"
          >
            {mutation.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function LogServiceDialog({ asset, today, onClose }: { asset: AssetRow; today: string; onClose: () => void }) {
  const { toast } = useToast();
  const [servicedOn, setServicedOn] = useState(today);
  const [kind, setKind] = useState<ServiceRecordKind>("service");
  const [performedBy, setPerformedBy] = useState("");
  const [cost, setCost] = useState("");
  const [nextDueOn, setNextDueOn] = useState("");
  const [notes, setNotes] = useState("");

  const mutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/admin/maintenance/assets/${asset.id}/services`, {
      servicedOn, kind,
      performedBy: performedBy.trim() || null,
      costCents: cost.trim() === "" ? null : dollarInputToCents(cost),
      nextDueOn: nextDueOn || null,
      notes: notes.trim() || null,
    }),
    onSuccess: () => {
      invalidateMaintenance();
      queryClient.invalidateQueries({ queryKey: ["/api/admin/maintenance/assets", asset.id, "services"] });
      toast({ title: "Service logged" });
      onClose();
    },
    onError: (e: unknown) => toast({ title: "Couldn't log service", description: apiErrorMessage(e), variant: "destructive" }),
  });

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-md bg-[#0a0f1a] border border-white/10 text-white/90 max-h-[85vh] overflow-y-auto">
        <h2 className="text-base font-semibold mb-1">Log service</h2>
        <p className="text-[12px] text-white/40 mb-3">{asset.name}</p>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[11px] text-white/40 mb-1 block">Date</label>
              <DatePickerInput value={servicedOn} onChange={(e) => setServicedOn(e.target.value)} data-testid="input-service-date" />
            </div>
            <div>
              <label className="text-[11px] text-white/40 mb-1 block">Type</label>
              <select value={kind} onChange={(e) => setKind(e.target.value as ServiceRecordKind)} className={inputCls + " cursor-pointer"} data-testid="select-service-kind">
                {SERVICE_RECORD_KINDS.map((k) => <option key={k} value={k}>{SERVICE_RECORD_KIND_LABELS[k]}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="text-[11px] text-white/40 mb-1 block">Performed by</label>
            <input value={performedBy} onChange={(e) => setPerformedBy(e.target.value)} placeholder="Riley, an external contractor…" className={inputCls} data-testid="input-service-performed-by" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[11px] text-white/40 mb-1 block">Cost</label>
              <MoneyInput value={cost} onChange={setCost} data-testid="input-service-cost" />
            </div>
            <div>
              <label className="text-[11px] text-white/40 mb-1 block">Next due</label>
              <DatePickerInput value={nextDueOn} onChange={(e) => setNextDueOn(e.target.value)} min={servicedOn} data-testid="input-service-next-due" />
            </div>
          </div>
          <div>
            <label className="text-[11px] text-white/40 mb-1 block">Notes</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} className={inputCls + " min-h-[60px]"} data-testid="input-service-notes" />
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="rounded-xl px-4 py-2 text-sm text-white/50 hover:text-white/80">Cancel</button>
          <button
            onClick={() => mutation.mutate()}
            disabled={!servicedOn || mutation.isPending}
            className="inline-flex items-center gap-2 rounded-xl bg-blue-500/20 border border-blue-500/40 text-blue-200 px-4 py-2 text-sm font-medium hover:bg-blue-500/30 disabled:opacity-50"
            data-testid="button-submit-log-service"
          >
            {mutation.isPending ? "Saving…" : "Log service"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ServiceHistoryDialog({ asset, onClose }: { asset: AssetRow; onClose: () => void }) {
  const { data, isLoading } = useQuery<{ today: string; services: ServiceRecordRow[] }>({
    queryKey: ["/api/admin/maintenance/assets", asset.id, "services"],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/admin/maintenance/assets/${asset.id}/services`);
      return res.json();
    },
  });

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-lg bg-[#0a0f1a] border border-white/10 text-white/90 max-h-[80vh] overflow-y-auto">
        <div className="flex items-start justify-between mb-3">
          <div>
            <h2 className="text-base font-semibold">Service history</h2>
            <p className="text-[12px] text-white/40">{asset.name}</p>
          </div>
          <button onClick={onClose} className="text-white/40 hover:text-white/70"><X className="w-4 h-4" /></button>
        </div>
        {isLoading ? (
          <div className="space-y-2">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-14 rounded-lg bg-white/[0.04]" />)}</div>
        ) : !data?.services.length ? (
          <div className="py-10 text-center text-[13px] text-white/30">No services logged yet.</div>
        ) : (
          <div className="divide-y divide-white/[0.05]">
            {data.services.map((r) => (
              <div key={r.id} className="py-2.5" data-testid={`service-record-${r.id}`}>
                <div className="flex items-center justify-between">
                  <div className="text-[13px] text-white/85 font-medium">{fmtNZDate(r.servicedOn)} · {SERVICE_RECORD_KIND_LABELS[r.kind]}</div>
                  {r.costCents != null && <div className="text-[13px] text-white/60">{formatCurrency(r.costCents, { fromCents: true })}</div>}
                </div>
                <div className="text-[11px] text-white/40">
                  {r.performedBy && <span>{r.performedBy}</span>}
                  {r.nextDueOn && <span>{r.performedBy ? " · " : ""}Next due {fmtNZDate(r.nextDueOn)}</span>}
                </div>
                {r.notes && <div className="text-[11px] text-white/35 mt-0.5">{r.notes}</div>}
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function AssetCard({ asset, onLogService, onHistory, onEdit, onDelete }: {
  asset: AssetRow;
  onLogService: () => void;
  onHistory: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3.5 space-y-2.5" data-testid={`asset-card-${asset.id}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[14px] font-medium text-white/85 truncate">{asset.name}</div>
          <div className="text-[10px] text-white/35 uppercase tracking-wide">
            {ASSET_CATEGORY_LABELS[asset.category]}{asset.make ? ` · ${asset.make}${asset.model ? ` ${asset.model}` : ""}` : ""}
          </div>
        </div>
        <ServiceStatusPill status={asset.serviceStatus} />
      </div>
      <div className="text-[12px] text-white/60">
        Last serviced {fmtNZDate(asset.lastServicedOn)} · Next due {fmtNZDate(asset.nextServiceDueOn)}
      </div>
      {(asset.location || asset.serial) && (
        <div className="text-[11px] text-white/35 truncate">{[asset.location, asset.serial ? `S/N ${asset.serial}` : null].filter(Boolean).join(" · ")}</div>
      )}
      <div className="flex items-center gap-1.5 pt-1">
        <button
          onClick={onLogService}
          className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg bg-blue-500/15 border border-blue-500/30 text-blue-300 px-3 py-2 text-[12px] font-medium hover:bg-blue-500/25 min-h-[40px]"
          data-testid={`button-log-service-${asset.id}`}
        >
          <Wrench className="w-3.5 h-3.5" /> Log service
        </button>
        <RowActionButton onClick={onHistory} title="History" icon={History} />
        <RowActionButton onClick={onEdit} title="Edit" icon={Pencil} />
        <RowActionButton onClick={onDelete} title="Delete" icon={Trash2} tone="danger" />
      </div>
    </div>
  );
}

function MachinesTab() {
  const { toast } = useToast();
  const [includeRetired, setIncludeRetired] = useState(false);
  const { data, isLoading } = useQuery<{ today: string; assets: AssetRow[] }>({
    queryKey: ["/api/admin/maintenance/assets", includeRetired],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/admin/maintenance/assets${includeRetired ? "?includeRetired=true" : ""}`);
      return res.json();
    },
  });

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<AssetRow | undefined>(undefined);
  const [servicing, setServicing] = useState<AssetRow | null>(null);
  const [viewingHistory, setViewingHistory] = useState<AssetRow | null>(null);
  const [deleting, setDeleting] = useState<AssetRow | null>(null);

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/admin/maintenance/assets/${id}`),
    onSuccess: async (res) => {
      const result = await res.json().catch(() => ({}));
      invalidateMaintenance();
      toast({ title: result.retired ? "Machine retired" : "Machine deleted", description: result.reason });
      setDeleting(null);
    },
    onError: (e: unknown) => toast({ title: "Couldn't delete machine", description: apiErrorMessage(e), variant: "destructive" }),
  });

  if (isLoading) return <MachinesSkeleton />;
  const list = data?.assets ?? [];
  const today = data?.today ?? "";

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <label className="flex items-center gap-2 text-[12px] text-white/50 cursor-pointer select-none">
          <Checkbox checked={includeRetired} onCheckedChange={(v) => setIncludeRetired(!!v)} data-testid="checkbox-show-retired-assets" />
          Show retired
        </label>
        <button
          onClick={() => { setEditing(undefined); setFormOpen(true); }}
          className="inline-flex items-center gap-2 rounded-xl bg-blue-500/15 border border-blue-500/30 text-blue-300 px-4 py-2 text-sm font-medium hover:bg-blue-500/25 min-h-[44px] sm:min-h-0"
          data-testid="button-add-asset"
        >
          <Plus className="w-4 h-4" /> Add machine
        </button>
      </div>

      {list.length === 0 ? (
        <EmptyState icon={Wrench} title="Add your first machine" action={{ label: "Add machine", onClick: () => { setEditing(undefined); setFormOpen(true); } }} />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 md:hidden">
            {list.map((asset) => (
              <AssetCard
                key={asset.id}
                asset={asset}
                onLogService={() => setServicing(asset)}
                onHistory={() => setViewingHistory(asset)}
                onEdit={() => { setEditing(asset); setFormOpen(true); }}
                onDelete={() => setDeleting(asset)}
              />
            ))}
          </div>

          <div className="hidden md:block rounded-2xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-white/[0.06] text-[11px] uppercase tracking-wide text-white/35">
                  <th className="px-4 py-2.5 font-medium">Machine</th>
                  <th className="px-4 py-2.5 font-medium">Make / model</th>
                  <th className="px-4 py-2.5 font-medium">Location</th>
                  <th className="px-4 py-2.5 font-medium">Last serviced</th>
                  <th className="px-4 py-2.5 font-medium">Next due</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.05]">
                {list.map((asset) => (
                  <tr key={asset.id} data-testid={`row-asset-${asset.id}`}>
                    <td className="px-4 py-3 text-white/85 font-medium">{asset.name}</td>
                    <td className="px-4 py-3 text-white/60">{[asset.make, asset.model].filter(Boolean).join(" ") || "—"}</td>
                    <td className="px-4 py-3 text-white/50">{asset.location || "—"}</td>
                    <td className="px-4 py-3 text-white/60">{fmtNZDate(asset.lastServicedOn)}</td>
                    <td className="px-4 py-3 text-white/60">{fmtNZDate(asset.nextServiceDueOn)}</td>
                    <td className="px-4 py-3"><ServiceStatusPill status={asset.serviceStatus} /></td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <RowActionButton onClick={() => setServicing(asset)} title="Log service" icon={Wrench} />
                        <RowActionButton onClick={() => setViewingHistory(asset)} title="History" icon={History} />
                        <RowActionButton onClick={() => { setEditing(asset); setFormOpen(true); }} title="Edit" icon={Pencil} />
                        <RowActionButton onClick={() => setDeleting(asset)} title="Delete" icon={Trash2} tone="danger" />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <AssetFormDialog open={formOpen} onOpenChange={setFormOpen} asset={editing} />
      {servicing && <LogServiceDialog key={`service-${servicing.id}`} asset={servicing} today={today} onClose={() => setServicing(null)} />}
      {viewingHistory && <ServiceHistoryDialog key={`history-${viewingHistory.id}`} asset={viewingHistory} onClose={() => setViewingHistory(null)} />}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(v) => { if (!v) setDeleting(null); }}
        title={`Delete ${deleting?.name ?? "this machine"}?`}
        description="If it has any service records, it will be retired instead of deleted so the service history stays on record."
        pending={deleteMut.isPending}
        onConfirm={() => deleting && deleteMut.mutate(deleting.id)}
      />
    </div>
  );
}

// ═══ PAGE SHELL ═══════════════════════════════════════════════════════════════

export default function VenueMaintenance() {
  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Wrench className="w-6 h-6 text-white/40" />
        <div>
          <h1 className="text-2xl font-bold text-white" data-testid="text-venue-maintenance-title">Maintenance</h1>
          <p className="text-sm text-white/40">Cleaning supplies and machines & equipment for the United Sports Centre</p>
        </div>
      </div>

      <MaintenanceStatStrip />

      <Tabs defaultValue="supplies" className="w-full">
        <TabsList
          className="grid h-auto w-full grid-cols-2 gap-1 sm:inline-flex sm:h-10 sm:w-auto sm:justify-start sm:gap-0"
          data-testid="maintenance-tabs"
        >
          <TabsTrigger value="supplies" className="min-h-[44px] sm:min-h-0" data-testid="tab-supplies">Supplies</TabsTrigger>
          <TabsTrigger value="machines" className="min-h-[44px] sm:min-h-0" data-testid="tab-machines">Machines</TabsTrigger>
        </TabsList>
        <TabsContent value="supplies"><SuppliesTab /></TabsContent>
        <TabsContent value="machines"><MachinesTab /></TabsContent>
      </Tabs>
    </div>
  );
}
