// Warehouse purchase orders (T16b, SPEC §4.4) — PO lifecycle (draft → sent →
// partial/received → closed/cancelled, free-form via PATCH — unlike
// requisitions/loans there's no transition graph for POs, T6's own comment)
// + receiving against lines. Detail modal covers the full flow: create →
// mark sent → add lines → receive (qtyGood/qtyDamaged split, damaged always
// routes to QUARANTINE server-side) → status auto-advances from derived
// qty_received. Item picker + locations list reused verbatim from the T16a
// items/locations pages' "fetch once, filter client-side" pattern.
import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Search, Plus, X, Truck, PackageCheck, Trash2, Loader2, ChevronRight } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { askConfirm } from "@/components/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PO_STATUSES, PO_STATUS_LABELS, type PoStatus, receiveDiscrepancyNote, type ReceiveDiscrepancy, locationLabel } from "@shared/warehouse";
import type { WhPurchaseOrder, WhItem, WhLocation } from "@shared/schema";

const ALL = "__all__";

// Mirrors server/warehouse-routes.ts's module-private RECEIVABLE_PO_STATUSES
// — a UX nicety only (hides the Receive button before it would 400); the
// server remains the real gate.
const RECEIVABLE_STATUSES = new Set<PoStatus>(["sent", "partial", "received"]);

const STATUS_BADGE: Record<PoStatus, string> = {
  draft: "bg-white/[0.04] text-white/50",
  sent: "bg-blue-500/10 text-blue-400",
  partial: "bg-amber-500/10 text-amber-400",
  received: "bg-emerald-500/10 text-emerald-400",
  closed: "bg-white/[0.04] text-white/30",
  cancelled: "bg-red-500/10 text-red-400",
};

interface PoRow extends WhPurchaseOrder {
  lineCount: number;
  totalOrderedQty: number;
}
interface PoLineRow {
  id: number;
  poId: number;
  itemId: number;
  qtyOrdered: string;
  unitCostCents: number | null;
  notes: string | null;
  itemSku: string;
  itemName: string;
  qtyReceivedGood: number;
  qtyReceivedDamaged: number;
  qtyReceived: number;
  qtyRemaining: number;
}
interface PoDetail extends WhPurchaseOrder {
  lines: PoLineRow[];
}

function qty(raw: string | number): string {
  const n = Number(raw);
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}
function money(cents: number | null): string {
  if (cents === null) return "—";
  return `$${(cents / 100).toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtDate(d: string | null): string {
  if (!d) return "—";
  return new Date(`${d}T00:00:00`).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" });
}

// Small "type to filter" picker over the already-fetched active items list —
// same reasoning as warehouse-items.tsx fetching all active locations once
// rather than a per-keystroke round trip (the catalog is warehouse-scale,
// not e-commerce-scale).
function ItemPicker({
  items, value, onSelect, placeholder,
}: { items: WhItem[]; value: WhItem | null; onSelect: (item: WhItem) => void; placeholder?: string }) {
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
        placeholder={placeholder ?? "Search item SKU or name..."}
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

function CreatePoModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const [supplierName, setSupplierName] = useState("");
  const [status, setStatus] = useState<PoStatus>("draft");
  const [expectedOn, setExpectedOn] = useState("");
  const [notes, setNotes] = useState("");

  const create = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/admin/warehouse/pos", {
      supplierName, status, expectedOn: expectedOn || null, notes: notes || null,
    })).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/warehouse/pos"] });
      toast({ title: "Purchase order created" });
      setSupplierName(""); setStatus("draft"); setExpectedOn(""); setNotes("");
      onClose();
    },
    onError: (e: Error) => toast({ title: "Create failed", description: e.message, variant: "destructive" }),
  });

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-2xl border border-white/10 bg-[#02060E] p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-white">New purchase order</h3>
          <button onClick={onClose} className="text-white/40 hover:text-white"><X className="w-4 h-4" /></button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="text-[10px] uppercase tracking-wider text-white/40">Supplier</label>
            <Input value={supplierName} onChange={(e) => setSupplierName(e.target.value)} className="bg-white/[0.02] border-white/10 text-white" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] uppercase tracking-wider text-white/40">Status</label>
              <Select value={status} onValueChange={(v) => setStatus(v as PoStatus)}>
                <SelectTrigger className="bg-white/[0.02] border-white/10 text-white"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PO_STATUSES.map((s) => <SelectItem key={s} value={s}>{PO_STATUS_LABELS[s]}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-white/40">Expected</label>
              <input type="date" value={expectedOn} onChange={(e) => setExpectedOn(e.target.value)} className="w-full h-9 px-3 rounded-md bg-white/[0.02] border border-white/10 text-white text-sm" style={{ colorScheme: "dark" }} />
            </div>
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-white/40">Notes</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} className="w-full px-3 py-2 rounded-md bg-white/[0.02] border border-white/10 text-white text-sm min-h-[50px]" />
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => create.mutate()} disabled={create.isPending || !supplierName} className="bg-blue-600 hover:bg-blue-700">
            {create.isPending ? "Creating..." : "Create PO"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function AddLineForm({ poId, items }: { poId: number; items: WhItem[] }) {
  const { toast } = useToast();
  const [item, setItem] = useState<WhItem | null>(null);
  const [qtyOrdered, setQtyOrdered] = useState("");
  const [unitCostCents, setUnitCostCents] = useState("");
  const [adding, setAdding] = useState(false);

  const addLine = useMutation({
    mutationFn: async () => (await apiRequest("POST", `/api/admin/warehouse/pos/${poId}/lines`, {
      itemId: item!.id,
      qtyOrdered,
      unitCostCents: unitCostCents === "" ? null : parseInt(unitCostCents, 10),
    })).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/warehouse/pos", poId] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/warehouse/pos", "list"] });
      setItem(null); setQtyOrdered(""); setUnitCostCents(""); setAdding(false);
    },
    onError: (e: Error) => toast({ title: "Couldn't add line", description: e.message, variant: "destructive" }),
  });

  if (!adding) {
    return (
      <button onClick={() => setAdding(true)} className="text-xs text-blue-400/70 hover:text-blue-400 flex items-center gap-1.5">
        <Plus className="w-3.5 h-3.5" /> Add line
      </button>
    );
  }
  return (
    <div className="p-3 rounded-lg bg-white/[0.02] border border-white/5 space-y-2">
      <ItemPicker items={items} value={item} onSelect={setItem} />
      <div className="grid grid-cols-2 gap-2">
        <Input type="number" placeholder="Qty ordered" value={qtyOrdered} onChange={(e) => setQtyOrdered(e.target.value)} className="bg-white/[0.02] border-white/10 text-white text-sm" />
        <Input type="number" placeholder="Unit cost (cents)" value={unitCostCents} onChange={(e) => setUnitCostCents(e.target.value)} className="bg-white/[0.02] border-white/10 text-white text-sm" />
      </div>
      <div className="flex justify-end gap-2">
        <button onClick={() => setAdding(false)} className="text-xs text-white/40 hover:text-white/70 px-2">Cancel</button>
        <Button
          size="sm"
          onClick={() => addLine.mutate()}
          disabled={addLine.isPending || !item || !qtyOrdered}
          className="bg-blue-600 hover:bg-blue-700"
        >
          {addLine.isPending ? "Adding..." : "Add"}
        </Button>
      </div>
    </div>
  );
}

function ReceiveForm({ poId, line, locations, onDone }: { poId: number; line: PoLineRow; locations: WhLocation[]; onDone: () => void }) {
  const { toast } = useToast();
  const realLocations = useMemo(() => locations.filter((l) => l.kind !== "virtual"), [locations]);
  const [qtyGood, setQtyGood] = useState(String(line.qtyRemaining || ""));
  const [qtyDamaged, setQtyDamaged] = useState("0");
  const [locationId, setLocationId] = useState("");
  const [note, setNote] = useState("");

  const receive = useMutation({
    mutationFn: async () => (await apiRequest("POST", `/api/admin/warehouse/pos/${poId}/receive`, {
      poLineId: line.id,
      qtyGood: Number(qtyGood) || 0,
      qtyDamaged: Number(qtyDamaged) || 0,
      locationId: locationId ? parseInt(locationId, 10) : undefined,
      note: note || undefined,
    })).json() as Promise<{ discrepancy: ReceiveDiscrepancy }>,
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/warehouse/pos", poId] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/warehouse/pos", "list"] });
      const note2 = receiveDiscrepancyNote(result.discrepancy);
      toast({ title: "Received", description: note2 ?? "Matched expected quantity." });
      onDone();
    },
    onError: (e: Error) => toast({ title: "Receive failed", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="p-3 rounded-lg bg-blue-500/5 border border-blue-500/20 space-y-2 mt-2">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[10px] uppercase tracking-wider text-white/40">Qty good</label>
          <Input type="number" value={qtyGood} onChange={(e) => setQtyGood(e.target.value)} className="bg-white/[0.02] border-white/10 text-white text-sm" />
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wider text-white/40">Qty damaged</label>
          <Input type="number" value={qtyDamaged} onChange={(e) => setQtyDamaged(e.target.value)} className="bg-white/[0.02] border-white/10 text-white text-sm" />
        </div>
      </div>
      <div>
        <label className="text-[10px] uppercase tracking-wider text-white/40">Location (for good stock)</label>
        <Select value={locationId} onValueChange={setLocationId}>
          <SelectTrigger className="bg-white/[0.02] border-white/10 text-white text-sm"><SelectValue placeholder="Choose a location" /></SelectTrigger>
          <SelectContent>
            {realLocations.map((l) => <SelectItem key={l.id} value={String(l.id)}>{locationLabel(l)}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <Input placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} className="bg-white/[0.02] border-white/10 text-white text-sm" />
      <div className="flex justify-end gap-2">
        <button onClick={onDone} className="text-xs text-white/40 hover:text-white/70 px-2">Cancel</button>
        <Button
          size="sm"
          onClick={() => receive.mutate()}
          disabled={receive.isPending || (Number(qtyGood) <= 0 && Number(qtyDamaged) <= 0) || (Number(qtyGood) > 0 && !locationId)}
          className="bg-blue-600 hover:bg-blue-700"
        >
          {receive.isPending ? "Receiving..." : "Confirm receipt"}
        </Button>
      </div>
    </div>
  );
}

function PoLineRowView({ poId, line, locations }: { poId: number; line: PoLineRow; locations: WhLocation[] }) {
  const { toast } = useToast();
  const [receiving, setReceiving] = useState(false);

  const removeLine = useMutation({
    mutationFn: async () => (await apiRequest("DELETE", `/api/admin/warehouse/pos/lines/${line.id}`)).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/warehouse/pos", poId] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/warehouse/pos", "list"] });
    },
    onError: (e: Error) => toast({ title: "Couldn't delete line", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="p-3 rounded-lg bg-white/[0.02] border border-white/5">
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-sm text-white font-mono truncate">{line.itemSku}</div>
          <div className="text-[11px] text-white/40 truncate">{line.itemName}</div>
        </div>
        <div className="text-xs text-white/60 font-mono text-right flex-shrink-0">
          {qty(line.qtyReceived)} / {qty(line.qtyOrdered)}
          {line.qtyReceivedDamaged > 0 && <span className="text-red-400/70"> ({qty(line.qtyReceivedDamaged)} dmg)</span>}
        </div>
        <div className="text-xs text-white/40 flex-shrink-0 w-20 text-right">{money(line.unitCostCents)}</div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {line.qtyRemaining > 0 && !receiving && (
            <button onClick={() => setReceiving(true)} className="px-2 py-1 rounded text-[11px] text-blue-400 bg-blue-500/10 hover:bg-blue-500/20 flex items-center gap-1">
              <PackageCheck className="w-3 h-3" /> Receive
            </button>
          )}
          {line.qtyReceived === 0 && (
            <button
              onClick={async () => {
                if (await askConfirm(`Remove ${line.itemSku} from this PO?`,
                  { title: "Remove this line?", confirmLabel: "Remove" })) removeLine.mutate();
              }}
              disabled={removeLine.isPending}
              className="text-white/20 hover:text-red-400"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
      {receiving && <ReceiveForm poId={poId} line={line} locations={locations} onDone={() => setReceiving(false)} />}
    </div>
  );
}

function PoDetailModal({
  poId, onClose, items, locations,
}: { poId: number | null; onClose: () => void; items: WhItem[]; locations: WhLocation[] }) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [supplierName, setSupplierName] = useState("");
  const [status, setStatus] = useState<PoStatus>("draft");
  const [expectedOn, setExpectedOn] = useState("");
  const [notes, setNotes] = useState("");

  const { data: po, isLoading } = useQuery<PoDetail>({
    queryKey: ["/api/admin/warehouse/pos", poId],
    queryFn: async () => (await apiRequest("GET", `/api/admin/warehouse/pos/${poId}`)).json(),
    enabled: poId !== null,
  });

  const save = useMutation({
    mutationFn: async () => (await apiRequest("PATCH", `/api/admin/warehouse/pos/${poId}`, {
      supplierName, status, expectedOn: expectedOn || null, notes: notes || null,
    })).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/warehouse/pos", poId] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/warehouse/pos", "list"] });
      toast({ title: "Saved" });
      setEditing(false);
    },
    onError: (e: Error) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  const remove = useMutation({
    mutationFn: async () => (await apiRequest("DELETE", `/api/admin/warehouse/pos/${poId}`)).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/warehouse/pos", "list"] });
      toast({ title: "Purchase order deleted" });
      onClose();
    },
    onError: (e: Error) => toast({ title: "Delete failed", description: e.message, variant: "destructive" }),
  });

  if (poId === null) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-2xl rounded-2xl border border-white/10 bg-[#02060E] p-6 max-h-[90vh] overflow-auto">
        {isLoading || !po ? (
          <div className="py-16 flex items-center justify-center gap-2 text-white/40 text-sm">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading...
          </div>
        ) : (
          <>
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="text-lg font-semibold text-white">{po.supplierName}</h3>
                <div className="flex items-center gap-2 mt-1">
                  <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${STATUS_BADGE[po.status as PoStatus] ?? "bg-white/[0.04] text-white/50"}`}>
                    {PO_STATUS_LABELS[po.status as PoStatus] ?? po.status}
                  </span>
                  <span className="text-[11px] text-white/40">Expected {fmtDate(po.expectedOn)}</span>
                </div>
              </div>
              <button onClick={onClose} className="text-white/40 hover:text-white"><X className="w-4 h-4" /></button>
            </div>

            {editing ? (
              <div className="space-y-3 mb-4">
                <div>
                  <label className="text-[10px] uppercase tracking-wider text-white/40">Supplier</label>
                  <Input value={supplierName} onChange={(e) => setSupplierName(e.target.value)} className="bg-white/[0.02] border-white/10 text-white" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] uppercase tracking-wider text-white/40">Status</label>
                    <Select value={status} onValueChange={(v) => setStatus(v as PoStatus)}>
                      <SelectTrigger className="bg-white/[0.02] border-white/10 text-white"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {PO_STATUSES.map((s) => <SelectItem key={s} value={s}>{PO_STATUS_LABELS[s]}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <label className="text-[10px] uppercase tracking-wider text-white/40">Expected</label>
                    <input type="date" value={expectedOn} onChange={(e) => setExpectedOn(e.target.value)} className="w-full h-9 px-3 rounded-md bg-white/[0.02] border border-white/10 text-white text-sm" style={{ colorScheme: "dark" }} />
                  </div>
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-wider text-white/40">Notes</label>
                  <textarea value={notes} onChange={(e) => setNotes(e.target.value)} className="w-full px-3 py-2 rounded-md bg-white/[0.02] border border-white/10 text-white text-sm min-h-[50px]" />
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
                  <Button onClick={() => save.mutate()} disabled={save.isPending} className="bg-blue-600 hover:bg-blue-700">
                    {save.isPending ? "Saving..." : "Save changes"}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between mb-4">
                {po.notes && <p className="text-xs text-white/40 flex-1">{po.notes}</p>}
                <button
                  onClick={() => {
                    setSupplierName(po.supplierName); setStatus(po.status as PoStatus);
                    setExpectedOn(po.expectedOn ?? ""); setNotes(po.notes ?? ""); setEditing(true);
                  }}
                  className="text-xs text-blue-400/70 hover:text-blue-400 flex-shrink-0"
                >
                  Edit details
                </button>
              </div>
            )}

            <div className="space-y-2 mb-4">
              <h4 className="text-xs uppercase tracking-wider text-white/40 flex items-center gap-1.5">
                <Truck className="w-3.5 h-3.5" /> Lines
              </h4>
              {po.lines.length === 0 ? (
                <div className="text-sm text-white/30 py-4 text-center rounded-lg bg-white/[0.02] border border-white/5">No lines yet.</div>
              ) : (
                <div className="space-y-1.5">
                  {po.lines.map((l) => <PoLineRowView key={l.id} poId={po.id} line={l} locations={locations} />)}
                </div>
              )}
              <AddLineForm poId={po.id} items={items} />
            </div>

            {RECEIVABLE_STATUSES.has(po.status as PoStatus) || (
              <p className="text-[11px] text-white/30 mb-4">
                {po.status === "draft" ? "Mark this PO as sent before receiving stock against it." : "This PO is closed to further receiving."}
              </p>
            )}

            <div className="flex justify-between items-center pt-3 border-t border-white/5">
              <button
                onClick={async () => {
                  if (await askConfirm(`Delete this PO from ${po.supplierName}? This can't be undone.`,
                    { title: "Delete this purchase order?", confirmLabel: "Delete" })) remove.mutate();
                }}
                disabled={remove.isPending}
                className="text-xs text-red-400/70 hover:text-red-400 flex items-center gap-1.5"
              >
                <Trash2 className="w-3.5 h-3.5" /> Delete PO
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function WarehousePOs() {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<string>(ALL);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);

  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (status !== ALL) params.set("status", status);

  const { data: pos = [], isLoading } = useQuery<PoRow[]>({
    queryKey: ["/api/admin/warehouse/pos", "list", q, status],
    queryFn: async () => (await apiRequest("GET", `/api/admin/warehouse/pos?${params.toString()}`)).json(),
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
          <h1 className="text-2xl font-bold text-white">Purchase orders</h1>
          <p className="text-sm text-white/40 mt-0.5">Order, track and receive stock from suppliers.</p>
        </div>
        <Button onClick={() => setCreating(true)} className="bg-blue-600 hover:bg-blue-700 flex items-center gap-1.5">
          <Plus className="w-4 h-4" /> New PO
        </Button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />
          <Input placeholder="Search supplier..." value={q} onChange={(e) => setQ(e.target.value)} className="pl-10 bg-white/[0.02] border-white/10 text-white" />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-48 bg-white/[0.02] border-white/10 text-white"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All statuses</SelectItem>
            {PO_STATUSES.map((s) => <SelectItem key={s} value={s}>{PO_STATUS_LABELS[s]}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="text-white/40 text-sm py-10 text-center">Loading...</div>
      ) : pos.length === 0 ? (
        <div className="py-16 text-center text-sm text-white/30">
          <Truck className="w-8 h-8 text-white/15 mx-auto mb-2" />
          No purchase orders match this filter.
        </div>
      ) : (
        <div className="rounded-2xl border border-white/5 overflow-hidden">
          <div className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-3 px-4 py-2 bg-white/[0.03] text-[10px] uppercase tracking-wider text-white/40">
            <span>Supplier</span>
            <span>Status</span>
            <span>Expected</span>
            <span>Lines</span>
            <span></span>
          </div>
          {pos.map((po) => (
            <div
              key={po.id}
              className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-3 px-4 py-2.5 items-center border-t border-white/5 hover:bg-white/[0.03] cursor-pointer"
              onClick={() => setDetailId(po.id)}
            >
              <div className="min-w-0 text-sm text-white truncate">{po.supplierName}</div>
              <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded whitespace-nowrap ${STATUS_BADGE[po.status as PoStatus] ?? "bg-white/[0.04] text-white/50"}`}>
                {PO_STATUS_LABELS[po.status as PoStatus] ?? po.status}
              </span>
              <span className="text-xs text-white/50 whitespace-nowrap">{fmtDate(po.expectedOn)}</span>
              <span className="text-xs text-white/50 font-mono whitespace-nowrap">{po.lineCount} · {qty(po.totalOrderedQty)}</span>
              <ChevronRight className="w-3.5 h-3.5 text-white/20" />
            </div>
          ))}
        </div>
      )}

      <CreatePoModal open={creating} onClose={() => setCreating(false)} />
      <PoDetailModal key={detailId ?? "none"} poId={detailId} onClose={() => setDetailId(null)} items={items} locations={locations} />
    </div>
  );
}
