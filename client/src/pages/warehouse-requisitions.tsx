// Warehouse requisitions (T16b, SPEC §4.4) — the D13 internal-draw workflow:
// any staff submits (POST /requisitions is requireAuth-only; this admin page
// itself sits behind requireTab("warehouse") per T17, so only operators with
// tab access reach it — same submit endpoint, just gated by the page around
// it here rather than the route itself), operators approve/decline, pick
// against approved/picking requisitions (reuses T8's generic POST /dispatch
// with sourceKind='requisition' — 'picking'/'ready' are server-derived from
// real pick evidence, never set directly), then mark collected. Second tab
// is the monthly chargeback report (D13's cost-deterrent half).
import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  Search, Plus, X, ClipboardList, Check, Ban, PackageCheck, Loader2, ChevronRight, Receipt,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { REQUISITION_STATUSES, REQUISITION_STATUS_LABELS, type RequisitionStatus, locationLabelWithCode } from "@shared/warehouse";
import type { WhRequisition, WhItem, WhLocation } from "@shared/schema";
import { nzTodayIso } from "@shared/academy";

const ALL = "__all__";
const CHARGE_TO_SUGGESTIONS = ["CUFC", "SIU", "MFL", "CIC", "USC", "Academy", "Office"];

const STATUS_BADGE: Record<RequisitionStatus, string> = {
  submitted: "bg-blue-500/10 text-blue-400",
  approved: "bg-purple-500/10 text-purple-400",
  picking: "bg-amber-500/10 text-amber-400",
  ready: "bg-emerald-500/10 text-emerald-400",
  collected: "bg-white/[0.04] text-white/30",
  declined: "bg-red-500/10 text-red-400",
};

interface RequisitionRow extends WhRequisition {
  requesterName: string;
  lineCount: number;
  totalQtyRequested: number;
  totalQtyPicked: number;
}
interface RequisitionLine {
  id: number;
  itemId: number;
  qtyRequested: number;
  qtyPicked: number;
  itemSku: string;
  itemName: string;
}
interface RequisitionDetail extends WhRequisition {
  requesterName: string;
  lines: RequisitionLine[];
}
interface ChargebackLine {
  chargeTo: string;
  totalCents: number;
  totalQty: number;
  movementCount: number;
}
interface ChargebackReport {
  month: string;
  lines: ChargebackLine[];
  grandTotalCents: number;
}

function qty(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}
function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtDate(d: string | null): string {
  if (!d) return "—";
  return new Date(`${d}T00:00:00`).toLocaleDateString("en-NZ", { day: "numeric", month: "short" });
}
function currentMonth(): string {
  // NZ calendar month, never a UTC one (AGENTS.md house rule) — the server's
  // own chargeback aggregate derives `month` the same way (nzTodayIso().slice
  // (0, 7), warehouse-routes.ts), so the client's default must match it or
  // the two disagree for several hours around every month boundary.
  return nzTodayIso().slice(0, 7);
}

function ItemPicker({
  items, value, onSelect,
}: { items: WhItem[]; value: WhItem | null; onSelect: (item: WhItem) => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const matches = useMemo(() => {
    if (!q.trim()) return items.slice(0, 20);
    const needle = q.trim().toLowerCase();
    return items.filter((i) => i.sku.toLowerCase().includes(needle) || i.name.toLowerCase().includes(needle)).slice(0, 20);
  }, [items, q]);

  return (
    <div className="relative">
      <Input
        value={open ? q : value ? `${value.sku} — ${value.name}` : ""}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => { setQ(""); setOpen(true); }}
        placeholder="Search item SKU or name..."
        className="bg-white/[0.02] border-white/10 text-white font-mono text-sm"
      />
      {open && (
        <div className="absolute z-10 mt-1 w-full max-h-56 overflow-y-auto rounded-lg border border-white/10 bg-[#050B16] shadow-xl">
          {matches.length === 0 ? (
            <div className="px-3 py-2 text-xs text-white/30">No items match.</div>
          ) : (
            matches.map((i) => (
              <button
                key={i.id}
                type="button"
                onClick={() => { onSelect(i); setOpen(false); setQ(""); }}
                className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/[0.06] flex items-center justify-between gap-2"
              >
                <span className="text-white font-mono">{i.sku}</span>
                <span className="text-white/40 truncate">{i.name}</span>
              </button>
            ))
          )}
        </div>
      )}
      {open && <div className="fixed inset-0 z-[5]" onClick={() => setOpen(false)} />}
    </div>
  );
}

interface DraftLine { item: WhItem; qtyRequested: string }

function CreateRequisitionModal({ open, onClose, items }: { open: boolean; onClose: () => void; items: WhItem[] }) {
  const { toast } = useToast();
  const [chargeTo, setChargeTo] = useState("");
  const [neededBy, setNeededBy] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [pickerItem, setPickerItem] = useState<WhItem | null>(null);
  const [pickerQty, setPickerQty] = useState("");

  const reset = () => { setChargeTo(""); setNeededBy(""); setNotes(""); setLines([]); setPickerItem(null); setPickerQty(""); };

  const addLine = () => {
    if (!pickerItem || !pickerQty) return;
    setLines((prev) => [...prev, { item: pickerItem, qtyRequested: pickerQty }]);
    setPickerItem(null); setPickerQty("");
  };

  const submit = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/admin/warehouse/requisitions", {
      chargeTo,
      neededBy: neededBy || null,
      notes: notes || null,
      lines: lines.map((l) => ({ itemId: l.item.id, qtyRequested: l.qtyRequested })),
    })).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/warehouse/requisitions"] });
      toast({ title: "Requisition submitted" });
      reset();
      onClose();
    },
    onError: (e: Error) => toast({ title: "Submit failed", description: e.message, variant: "destructive" }),
  });

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-lg rounded-2xl border border-white/10 bg-[#02060E] p-6 max-h-[90vh] overflow-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-white">New requisition</h3>
          <button onClick={onClose} className="text-white/40 hover:text-white"><X className="w-4 h-4" /></button>
        </div>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] uppercase tracking-wider text-white/40">Charge to</label>
              <Input value={chargeTo} onChange={(e) => setChargeTo(e.target.value)} list="charge-to-suggestions" placeholder="CUFC, SIU, Office..." className="bg-white/[0.02] border-white/10 text-white" />
              <datalist id="charge-to-suggestions">
                {CHARGE_TO_SUGGESTIONS.map((c) => <option key={c} value={c} />)}
              </datalist>
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-white/40">Needed by</label>
              <input type="date" value={neededBy} onChange={(e) => setNeededBy(e.target.value)} className="w-full h-9 px-3 rounded-md bg-white/[0.02] border border-white/10 text-white text-sm" style={{ colorScheme: "dark" }} />
            </div>
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-white/40">Notes</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} className="w-full px-3 py-2 rounded-md bg-white/[0.02] border border-white/10 text-white text-sm min-h-[40px]" />
          </div>

          <div className="pt-2">
            <label className="text-[10px] uppercase tracking-wider text-white/40 mb-1 block">Lines</label>
            {lines.length > 0 && (
              <div className="space-y-1.5 mb-2">
                {lines.map((l, idx) => (
                  <div key={idx} className="flex items-center justify-between p-2 rounded-lg bg-white/[0.02] border border-white/5 text-sm">
                    <span className="text-white font-mono">{l.item.sku}</span>
                    <span className="text-white/50">× {l.qtyRequested}</span>
                    <button onClick={() => setLines((prev) => prev.filter((_, i) => i !== idx))} className="text-white/20 hover:text-red-400">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex gap-2 items-start">
              <div className="flex-1"><ItemPicker items={items} value={pickerItem} onSelect={setPickerItem} /></div>
              <Input type="number" placeholder="Qty" value={pickerQty} onChange={(e) => setPickerQty(e.target.value)} className="w-20 bg-white/[0.02] border-white/10 text-white text-sm" />
              <button onClick={addLine} disabled={!pickerItem || !pickerQty} className="h-9 px-3 rounded-md bg-white/[0.06] hover:bg-white/[0.1] text-white text-xs disabled:opacity-30">Add</button>
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => submit.mutate()} disabled={submit.isPending || !chargeTo || lines.length === 0} className="bg-blue-600 hover:bg-blue-700">
            {submit.isPending ? "Submitting..." : "Submit requisition"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function PickLineRow({
  requisitionId, line, locations,
}: { requisitionId: number; line: RequisitionLine; locations: WhLocation[] }) {
  const { toast } = useToast();
  const remaining = line.qtyRequested - line.qtyPicked;
  const [picking, setPicking] = useState(false);
  const [locationId, setLocationId] = useState("");
  const [pickQty, setPickQty] = useState(String(remaining));
  const realLocations = useMemo(() => locations.filter((l) => l.kind !== "virtual"), [locations]);

  const pick = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/admin/warehouse/dispatch", {
      sourceKind: "requisition",
      sourceId: requisitionId,
      itemId: line.itemId,
      locationId: parseInt(locationId, 10),
      qty: pickQty,
    })).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/warehouse/requisitions", requisitionId] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/warehouse/requisitions", "list"] });
      setPicking(false);
    },
    onError: (e: Error) => toast({ title: "Pick failed", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="p-3 rounded-lg bg-white/[0.02] border border-white/5">
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-sm text-white font-mono truncate">{line.itemSku}</div>
          <div className="text-[11px] text-white/40 truncate">{line.itemName}</div>
        </div>
        <div className="text-xs text-white/60 font-mono flex-shrink-0">{qty(line.qtyPicked)} / {qty(line.qtyRequested)}</div>
        {remaining > 0 && !picking && (
          <button onClick={() => setPicking(true)} className="px-2 py-1 rounded text-[11px] text-blue-400 bg-blue-500/10 hover:bg-blue-500/20 flex-shrink-0">
            Pick
          </button>
        )}
      </div>
      {picking && (
        <div className="mt-2 p-2.5 rounded-lg bg-blue-500/5 border border-blue-500/20 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <Select value={locationId} onValueChange={setLocationId}>
              <SelectTrigger className="bg-white/[0.02] border-white/10 text-white text-sm"><SelectValue placeholder="From location" /></SelectTrigger>
              <SelectContent>
                {realLocations.map((l) => <SelectItem key={l.id} value={String(l.id)}>{locationLabelWithCode(l)}</SelectItem>)}
              </SelectContent>
            </Select>
            <Input type="number" value={pickQty} onChange={(e) => setPickQty(e.target.value)} className="bg-white/[0.02] border-white/10 text-white text-sm" />
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setPicking(false)} className="text-xs text-white/40 hover:text-white/70 px-2">Cancel</button>
            <Button size="sm" onClick={() => pick.mutate()} disabled={pick.isPending || !locationId || !pickQty} className="bg-blue-600 hover:bg-blue-700">
              {pick.isPending ? "Picking..." : "Confirm pick"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function RequisitionDetailModal({
  requisitionId, onClose, locations,
}: { requisitionId: number | null; onClose: () => void; locations: WhLocation[] }) {
  const { toast } = useToast();
  const [declineReason, setDeclineReason] = useState("");
  const [declining, setDeclining] = useState(false);

  const { data: req, isLoading } = useQuery<RequisitionDetail>({
    queryKey: ["/api/admin/warehouse/requisitions", requisitionId],
    queryFn: async () => (await apiRequest("GET", `/api/admin/warehouse/requisitions/${requisitionId}`)).json(),
    enabled: requisitionId !== null,
  });

  const transition = useMutation({
    mutationFn: async (verb: "approve" | "decline" | "collect") => {
      const body = verb === "decline" ? { reason: declineReason || undefined } : undefined;
      return (await apiRequest("POST", `/api/admin/warehouse/requisitions/${requisitionId}/${verb}`, body)).json();
    },
    onSuccess: (_data, verb) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/warehouse/requisitions", requisitionId] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/warehouse/requisitions", "list"] });
      toast({ title: verb === "approve" ? "Approved" : verb === "decline" ? "Declined" : "Marked collected" });
      setDeclining(false); setDeclineReason("");
    },
    onError: (e: Error) => toast({ title: "Action failed", description: e.message, variant: "destructive" }),
  });

  if (requisitionId === null) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-xl rounded-2xl border border-white/10 bg-[#02060E] p-6 max-h-[90vh] overflow-auto">
        {isLoading || !req ? (
          <div className="py-16 flex items-center justify-center gap-2 text-white/40 text-sm">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading...
          </div>
        ) : (
          <>
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="text-lg font-semibold text-white">{req.chargeTo}</h3>
                <div className="flex items-center gap-2 mt-1">
                  <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${STATUS_BADGE[req.status as RequisitionStatus] ?? "bg-white/[0.04] text-white/50"}`}>
                    {REQUISITION_STATUS_LABELS[req.status as RequisitionStatus] ?? req.status}
                  </span>
                  <span className="text-[11px] text-white/40">Requested by {req.requesterName} · Needed {fmtDate(req.neededBy)}</span>
                </div>
              </div>
              <button onClick={onClose} className="text-white/40 hover:text-white"><X className="w-4 h-4" /></button>
            </div>

            {req.notes && <p className="text-xs text-white/40 mb-3">{req.notes}</p>}

            <div className="space-y-1.5 mb-4">
              {req.lines.map((l) => (
                req.status === "approved" || req.status === "picking" ? (
                  <PickLineRow key={l.id} requisitionId={req.id} line={l} locations={locations} />
                ) : (
                  <div key={l.id} className="p-3 rounded-lg bg-white/[0.02] border border-white/5 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-white font-mono truncate">{l.itemSku}</div>
                      <div className="text-[11px] text-white/40 truncate">{l.itemName}</div>
                    </div>
                    <div className="text-xs text-white/60 font-mono flex-shrink-0">{qty(l.qtyPicked)} / {qty(l.qtyRequested)}</div>
                  </div>
                )
              ))}
            </div>

            {declining && (
              <div className="mb-3 p-3 rounded-lg bg-red-500/5 border border-red-500/20 space-y-2">
                <Input placeholder="Reason (optional)" value={declineReason} onChange={(e) => setDeclineReason(e.target.value)} className="bg-white/[0.02] border-white/10 text-white text-sm" />
                <div className="flex justify-end gap-2">
                  <button onClick={() => setDeclining(false)} className="text-xs text-white/40 hover:text-white/70 px-2">Cancel</button>
                  <Button size="sm" onClick={() => transition.mutate("decline")} disabled={transition.isPending} className="bg-red-600 hover:bg-red-700">
                    Confirm decline
                  </Button>
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-3 border-t border-white/5">
              {req.status === "submitted" && !declining && (
                <>
                  <button onClick={() => setDeclining(true)} className="px-3 py-1.5 rounded-lg text-xs text-red-400 bg-red-500/10 hover:bg-red-500/20 flex items-center gap-1.5">
                    <Ban className="w-3.5 h-3.5" /> Decline
                  </button>
                  <Button onClick={() => transition.mutate("approve")} disabled={transition.isPending} className="bg-blue-600 hover:bg-blue-700 flex items-center gap-1.5">
                    <Check className="w-3.5 h-3.5" /> Approve
                  </Button>
                </>
              )}
              {req.status === "ready" && (
                <Button onClick={() => transition.mutate("collect")} disabled={transition.isPending} className="bg-emerald-600 hover:bg-emerald-700 flex items-center gap-1.5">
                  <PackageCheck className="w-3.5 h-3.5" /> Mark collected
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ChargebackReportView() {
  const [month, setMonth] = useState(currentMonth());
  const { data, isLoading } = useQuery<ChargebackReport>({
    queryKey: ["/api/admin/warehouse/chargeback-report", month],
    queryFn: async () => (await apiRequest("GET", `/api/admin/warehouse/chargeback-report?month=${month}`)).json(),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <label className="text-[10px] uppercase tracking-wider text-white/40">Month</label>
        <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="h-9 px-3 rounded-md bg-white/[0.02] border border-white/10 text-white text-sm" style={{ colorScheme: "dark" }} />
      </div>
      {isLoading ? (
        <div className="text-white/40 text-sm py-10 text-center">Loading...</div>
      ) : !data || data.lines.length === 0 ? (
        <div className="py-16 text-center text-sm text-white/30">
          <Receipt className="w-8 h-8 text-white/15 mx-auto mb-2" />
          No picks charged out against a requisition this month.
        </div>
      ) : (
        <div className="rounded-2xl border border-white/5 overflow-hidden">
          <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3 px-4 py-2 bg-white/[0.03] text-[10px] uppercase tracking-wider text-white/40">
            <span>Charge to</span>
            <span>Qty</span>
            <span>Picks</span>
            <span>Total</span>
          </div>
          {data.lines.map((l) => (
            <div key={l.chargeTo} className="grid grid-cols-[1fr_auto_auto_auto] gap-3 px-4 py-2.5 items-center border-t border-white/5">
              <span className="text-sm text-white">{l.chargeTo}</span>
              <span className="text-xs text-white/50 font-mono">{qty(l.totalQty)}</span>
              <span className="text-xs text-white/50 font-mono">{l.movementCount}</span>
              <span className="text-sm text-white font-mono">{money(l.totalCents)}</span>
            </div>
          ))}
          <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3 px-4 py-3 items-center border-t border-white/10 bg-white/[0.02]">
            <span className="text-sm text-white font-semibold">Grand total</span>
            <span></span>
            <span></span>
            <span className="text-sm text-white font-semibold font-mono">{money(data.grandTotalCents)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

export default function WarehouseRequisitions() {
  const [view, setView] = useState<"queue" | "chargeback">("queue");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<string>(ALL);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);

  const params = new URLSearchParams();
  if (status !== ALL) params.set("status", status);
  if (q) params.set("chargeTo", q);

  const { data: requisitions = [], isLoading } = useQuery<RequisitionRow[]>({
    queryKey: ["/api/admin/warehouse/requisitions", "list", status, q],
    queryFn: async () => (await apiRequest("GET", `/api/admin/warehouse/requisitions?${params.toString()}`)).json(),
    enabled: view === "queue",
  });
  const { data: items = [] } = useQuery<WhItem[]>({
    queryKey: ["/api/admin/warehouse/items", "active"],
    queryFn: async () => (await apiRequest("GET", "/api/admin/warehouse/items?active=true")).json(),
  });
  const { data: locations = [] } = useQuery<WhLocation[]>({
    queryKey: ["/api/admin/warehouse/locations", "active"],
    queryFn: async () => (await apiRequest("GET", "/api/admin/warehouse/locations?active=true")).json(),
  });

  return (
    <div className="p-4 sm:p-6 space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Requisitions</h1>
          <p className="text-sm text-white/40 mt-0.5">Internal stock draws — approve, pick, and charge back by brand.</p>
        </div>
        {view === "queue" && (
          <Button onClick={() => setCreating(true)} className="bg-blue-600 hover:bg-blue-700 flex items-center gap-1.5">
            <Plus className="w-4 h-4" /> New requisition
          </Button>
        )}
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={() => setView("queue")}
          className={`px-3 py-1.5 rounded-lg text-xs flex items-center gap-1.5 ${view === "queue" ? "bg-blue-600 text-white" : "bg-white/[0.04] text-white/60 hover:bg-white/[0.08]"}`}
        >
          <ClipboardList className="w-3.5 h-3.5" /> Queue
        </button>
        <button
          onClick={() => setView("chargeback")}
          className={`px-3 py-1.5 rounded-lg text-xs flex items-center gap-1.5 ${view === "chargeback" ? "bg-blue-600 text-white" : "bg-white/[0.04] text-white/60 hover:bg-white/[0.08]"}`}
        >
          <Receipt className="w-3.5 h-3.5" /> Chargeback report
        </button>
      </div>

      {view === "chargeback" ? (
        <ChargebackReportView />
      ) : (
        <>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative flex-1 min-w-[220px]">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />
              <Input placeholder="Filter by exact charge-to..." value={q} onChange={(e) => setQ(e.target.value)} className="pl-10 bg-white/[0.02] border-white/10 text-white" />
            </div>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-48 bg-white/[0.02] border-white/10 text-white"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All statuses</SelectItem>
                {REQUISITION_STATUSES.map((s) => <SelectItem key={s} value={s}>{REQUISITION_STATUS_LABELS[s]}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          {isLoading ? (
            <div className="text-white/40 text-sm py-10 text-center">Loading...</div>
          ) : requisitions.length === 0 ? (
            <div className="py-16 text-center text-sm text-white/30">
              <ClipboardList className="w-8 h-8 text-white/15 mx-auto mb-2" />
              No requisitions match this filter.
            </div>
          ) : (
            <div className="rounded-2xl border border-white/5 overflow-hidden">
              <div className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-3 px-4 py-2 bg-white/[0.03] text-[10px] uppercase tracking-wider text-white/40">
                <span>Charge to / requester</span>
                <span>Status</span>
                <span>Needed by</span>
                <span>Lines</span>
                <span></span>
              </div>
              {requisitions.map((r) => (
                <div
                  key={r.id}
                  className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-3 px-4 py-2.5 items-center border-t border-white/5 hover:bg-white/[0.03] cursor-pointer"
                  onClick={() => setDetailId(r.id)}
                >
                  <div className="min-w-0">
                    <div className="text-sm text-white truncate">{r.chargeTo}</div>
                    <div className="text-[11px] text-white/40 truncate">{r.requesterName}</div>
                  </div>
                  <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded whitespace-nowrap ${STATUS_BADGE[r.status as RequisitionStatus] ?? "bg-white/[0.04] text-white/50"}`}>
                    {REQUISITION_STATUS_LABELS[r.status as RequisitionStatus] ?? r.status}
                  </span>
                  <span className="text-xs text-white/50 whitespace-nowrap">{fmtDate(r.neededBy)}</span>
                  <span className="text-xs text-white/50 font-mono whitespace-nowrap">{r.lineCount} · {qty(r.totalQtyPicked)}/{qty(r.totalQtyRequested)}</span>
                  <ChevronRight className="w-3.5 h-3.5 text-white/20" />
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <CreateRequisitionModal open={creating} onClose={() => setCreating(false)} items={items} />
      <RequisitionDetailModal key={detailId ?? "none"} requisitionId={detailId} onClose={() => setDetailId(null)} locations={locations} />
    </div>
  );
}
