// Warehouse equipment loans (T16b, SPEC §4.4, D14) — library/tool-crib
// model. Check-out creates the loan + posts the loan_out movement in one
// call (server/warehouse-routes.ts's own comment: the parent record and the
// movement are the same real-world event, unlike PO/requisition create).
// Return is per-line (a loan line returns in full, one condition grade — no
// partial-quantity return, same v1 scope cut as T5's consumeReservation) —
// this page fires one POST /loans/:id/return per line rather than batching,
// simpler to reason about and the endpoint is batch-capable either way.
// `overdue` is always read off the API response, never recomputed here —
// it's derived server-side from dueOn vs nzTodayIso(), a date/timezone
// computation that stays server-only per AGENTS.md.
import { DatePickerInput } from "@/components/ui/date-picker-input";
import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Search, Plus, X, HandCoins, Undo2, Loader2, ChevronRight, AlertTriangle } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LOAN_STATUSES, type LoanStatus, CONDITION_GRADES, CONDITION_GRADE_LABELS, type ConditionGrade, locationLabel } from "@shared/warehouse";
import type { WhLoan, WhItem, WhLocation } from "@shared/schema";

const ALL = "__all__";

const LOAN_STATUS_LABEL: Record<LoanStatus, string> = { out: "Out", returned: "Returned" };

interface LoanRow extends WhLoan {
  overdue: boolean;
  lineCount: number;
  totalQty: number;
}
interface LoanLine {
  id: number;
  loanId: number;
  itemId: number;
  qty: number;
  conditionGrade: string | null;
  conditionNote: string | null;
  replacementChargedCents: number | null;
  itemSku: string;
  itemName: string;
}
interface LoanDetail extends WhLoan {
  overdue: boolean;
  lines: LoanLine[];
}

function qty(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}
function fmtDate(d: string | null): string {
  if (!d) return "—";
  return new Date(`${d}T00:00:00`).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" });
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
        placeholder="Search loanable item..."
        className="bg-white/[0.02] border-white/10 text-white font-mono text-sm"
      />
      {open && (
        <div className="absolute z-10 mt-1 w-full max-h-56 overflow-y-auto rounded-lg border border-white/10 bg-[#050B16] shadow-xl">
          {matches.length === 0 ? (
            <div className="px-3 py-2 text-xs text-white/30">No loanable items match.</div>
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

interface DraftLine { item: WhItem; qty: string }

function CheckOutModal({ open, onClose, items, locations }: { open: boolean; onClose: () => void; items: WhItem[]; locations: WhLocation[] }) {
  const { toast } = useToast();
  const loanableItems = useMemo(() => items.filter((i) => i.isLoanable), [items]);
  const realLocations = useMemo(() => locations.filter((l) => l.kind !== "virtual"), [locations]);
  const [borrowerName, setBorrowerName] = useState("");
  const [dueOn, setDueOn] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [pickerItem, setPickerItem] = useState<WhItem | null>(null);
  const [pickerQty, setPickerQty] = useState("");

  const reset = () => { setBorrowerName(""); setDueOn(""); setNotes(""); setLines([]); setPickerItem(null); setPickerQty(""); };

  const addLine = () => {
    if (!pickerItem || !pickerQty) return;
    setLines((prev) => [...prev, { item: pickerItem, qty: pickerQty }]);
    setPickerItem(null); setPickerQty("");
  };

  const checkOut = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/admin/warehouse/loans", {
      borrowerName,
      dueOn,
      notes: notes || null,
      lines: lines.map((l) => ({
        itemId: l.item.id,
        qty: l.qty,
        locationId: l.item.defaultLocationId ?? undefined,
      })),
    })).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/warehouse/loans"] });
      toast({ title: "Checked out" });
      reset();
      onClose();
    },
    onError: (e: Error) => toast({ title: "Check-out failed", description: e.message, variant: "destructive" }),
  });

  const needsLocation = lines.some((l) => !l.item.defaultLocationId);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-lg rounded-2xl border border-white/10 bg-[#02060E] p-6 max-h-[90vh] overflow-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-white">Check out equipment</h3>
          <button onClick={onClose} className="text-white/40 hover:text-white"><X className="w-4 h-4" /></button>
        </div>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] uppercase tracking-wider text-white/40">Borrower</label>
              <Input value={borrowerName} onChange={(e) => setBorrowerName(e.target.value)} className="bg-white/[0.02] border-white/10 text-white" />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-white/40">Due back</label>
              <DatePickerInput value={dueOn} onChange={(e) => setDueOn(e.target.value)} className="w-full h-9 px-3 rounded-md bg-white/[0.02] border border-white/10 text-white text-sm" />
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
                    <span className="text-white/50">× {l.qty}</span>
                    {!l.item.defaultLocationId && <span className="text-amber-400/70 text-[10px]">no default location</span>}
                    <button onClick={() => setLines((prev) => prev.filter((_, i) => i !== idx))} className="text-white/20 hover:text-red-400">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex gap-2 items-start">
              <div className="flex-1"><ItemPicker items={loanableItems} value={pickerItem} onSelect={setPickerItem} /></div>
              <Input type="number" placeholder="Qty" value={pickerQty} onChange={(e) => setPickerQty(e.target.value)} className="w-20 bg-white/[0.02] border-white/10 text-white text-sm" />
              <button onClick={addLine} disabled={!pickerItem || !pickerQty} className="h-9 px-3 rounded-md bg-white/[0.06] hover:bg-white/[0.1] text-white text-xs disabled:opacity-30">Add</button>
            </div>
            {needsLocation && (
              <p className="text-[11px] text-amber-400/70 mt-2 flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> Some items have no default location — set one on the item first, or check-out will fail.</p>
            )}
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => checkOut.mutate()} disabled={checkOut.isPending || !borrowerName || !dueOn || lines.length === 0} className="bg-blue-600 hover:bg-blue-700">
            {checkOut.isPending ? "Checking out..." : "Check out"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ReturnLineRow({ loanId, line, locations }: { loanId: number; line: LoanLine; locations: WhLocation[] }) {
  const { toast } = useToast();
  const [returning, setReturning] = useState(false);
  const [locationId, setLocationId] = useState("");
  const [conditionGrade, setConditionGrade] = useState<ConditionGrade>("A");
  const [conditionNote, setConditionNote] = useState("");
  const [replacementChargedCents, setReplacementChargedCents] = useState("");
  const realLocations = useMemo(() => locations.filter((l) => l.kind !== "virtual"), [locations]);

  const returnLine = useMutation({
    mutationFn: async () => (await apiRequest("POST", `/api/admin/warehouse/loans/${loanId}/return`, {
      lines: [{
        loanLineId: line.id,
        locationId: parseInt(locationId, 10),
        conditionGrade,
        conditionNote: conditionNote || undefined,
        replacementChargedCents: replacementChargedCents === "" ? undefined : parseInt(replacementChargedCents, 10),
      }],
    })).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/warehouse/loans", loanId] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/warehouse/loans", "list"] });
      setReturning(false);
    },
    onError: (e: Error) => toast({ title: "Return failed", description: e.message, variant: "destructive" }),
  });

  if (line.conditionGrade) {
    return (
      <div className="p-3 rounded-lg bg-white/[0.02] border border-white/5 flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-sm text-white font-mono truncate">{line.itemSku}</div>
          <div className="text-[11px] text-white/40 truncate">{line.itemName}{line.conditionNote ? ` · ${line.conditionNote}` : ""}</div>
        </div>
        <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 flex-shrink-0">
          {CONDITION_GRADE_LABELS[line.conditionGrade as ConditionGrade] ?? line.conditionGrade}
        </span>
      </div>
    );
  }

  return (
    <div className="p-3 rounded-lg bg-white/[0.02] border border-white/5">
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-sm text-white font-mono truncate">{line.itemSku}</div>
          <div className="text-[11px] text-white/40 truncate">{line.itemName} · qty {qty(line.qty)}</div>
        </div>
        {!returning && (
          <button onClick={() => setReturning(true)} className="px-2 py-1 rounded text-[11px] text-blue-400 bg-blue-500/10 hover:bg-blue-500/20 flex-shrink-0 flex items-center gap-1">
            <Undo2 className="w-3 h-3" /> Return
          </button>
        )}
      </div>
      {returning && (
        <div className="mt-2 p-2.5 rounded-lg bg-blue-500/5 border border-blue-500/20 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <Select value={locationId} onValueChange={setLocationId}>
              <SelectTrigger className="bg-white/[0.02] border-white/10 text-white text-sm"><SelectValue placeholder="Returned to" /></SelectTrigger>
              <SelectContent>
                {realLocations.map((l) => <SelectItem key={l.id} value={String(l.id)}>{locationLabel(l)}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={conditionGrade} onValueChange={(v) => setConditionGrade(v as ConditionGrade)}>
              <SelectTrigger className="bg-white/[0.02] border-white/10 text-white text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                {CONDITION_GRADES.map((g) => <SelectItem key={g} value={g}>{CONDITION_GRADE_LABELS[g]}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <Input placeholder="Note (optional)" value={conditionNote} onChange={(e) => setConditionNote(e.target.value)} className="bg-white/[0.02] border-white/10 text-white text-sm" />
          {(conditionGrade === "C" || conditionGrade === "D") && (
            <Input type="number" placeholder="Replacement charge (cents, optional)" value={replacementChargedCents} onChange={(e) => setReplacementChargedCents(e.target.value)} className="bg-white/[0.02] border-white/10 text-white text-sm" />
          )}
          <div className="flex justify-end gap-2">
            <button onClick={() => setReturning(false)} className="text-xs text-white/40 hover:text-white/70 px-2">Cancel</button>
            <Button size="sm" onClick={() => returnLine.mutate()} disabled={returnLine.isPending || !locationId} className="bg-blue-600 hover:bg-blue-700">
              {returnLine.isPending ? "Saving..." : "Confirm return"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function LoanDetailModal({ loanId, onClose, locations }: { loanId: number | null; onClose: () => void; locations: WhLocation[] }) {
  const { data: loan, isLoading } = useQuery<LoanDetail>({
    queryKey: ["/api/admin/warehouse/loans", loanId],
    queryFn: async () => (await apiRequest("GET", `/api/admin/warehouse/loans/${loanId}`)).json(),
    enabled: loanId !== null,
  });

  if (loanId === null) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-xl rounded-2xl border border-white/10 bg-[#02060E] p-6 max-h-[90vh] overflow-auto">
        {isLoading || !loan ? (
          <div className="py-16 flex items-center justify-center gap-2 text-white/40 text-sm">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading...
          </div>
        ) : (
          <>
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="text-lg font-semibold text-white">{loan.borrowerName}</h3>
                <div className="flex items-center gap-2 mt-1">
                  <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${loan.status === "returned" ? "bg-white/[0.04] text-white/30" : loan.overdue ? "bg-red-500/10 text-red-400" : "bg-blue-500/10 text-blue-400"}`}>
                    {loan.overdue && loan.status === "out" ? "Overdue" : LOAN_STATUS_LABEL[loan.status as LoanStatus] ?? loan.status}
                  </span>
                  <span className="text-[11px] text-white/40">Due {fmtDate(loan.dueOn)}</span>
                </div>
              </div>
              <button onClick={onClose} className="text-white/40 hover:text-white"><X className="w-4 h-4" /></button>
            </div>

            {loan.notes && <p className="text-xs text-white/40 mb-3">{loan.notes}</p>}

            <div className="space-y-1.5">
              {loan.lines.map((l) => <ReturnLineRow key={l.id} loanId={loan.id} line={l} locations={locations} />)}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function WarehouseLoans() {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<string>(ALL);
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [checkingOut, setCheckingOut] = useState(false);

  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (status !== ALL) params.set("status", status);
  if (overdueOnly) params.set("overdue", "true");

  const { data: loans = [], isLoading } = useQuery<LoanRow[]>({
    queryKey: ["/api/admin/warehouse/loans", "list", q, status, overdueOnly],
    queryFn: async () => (await apiRequest("GET", `/api/admin/warehouse/loans?${params.toString()}`)).json(),
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
          <h1 className="text-2xl font-bold text-white">Equipment loans</h1>
          <p className="text-sm text-white/40 mt-0.5">Check out and track loanable gear — who has what, and since when.</p>
        </div>
        <Button onClick={() => setCheckingOut(true)} className="bg-blue-600 hover:bg-blue-700 flex items-center gap-1.5">
          <Plus className="w-4 h-4" /> Check out
        </Button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />
          <Input placeholder="Search borrower..." value={q} onChange={(e) => setQ(e.target.value)} className="pl-10 bg-white/[0.02] border-white/10 text-white" />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-40 bg-white/[0.02] border-white/10 text-white"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All statuses</SelectItem>
            {LOAN_STATUSES.map((s) => <SelectItem key={s} value={s}>{LOAN_STATUS_LABEL[s]}</SelectItem>)}
          </SelectContent>
        </Select>
        <label className="flex items-center gap-2 text-sm text-white/60 flex-shrink-0">
          <input type="checkbox" checked={overdueOnly} onChange={(e) => setOverdueOnly(e.target.checked)} /> Overdue only
        </label>
      </div>

      {isLoading ? (
        <div className="text-white/40 text-sm py-10 text-center">Loading...</div>
      ) : loans.length === 0 ? (
        <div className="py-16 text-center text-sm text-white/30">
          <HandCoins className="w-8 h-8 text-white/15 mx-auto mb-2" />
          No loans match this filter.
        </div>
      ) : (
        <div className="rounded-2xl border border-white/5 overflow-hidden">
          <div className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-3 px-4 py-2 bg-white/[0.03] text-[10px] uppercase tracking-wider text-white/40">
            <span>Borrower</span>
            <span>Status</span>
            <span>Due</span>
            <span>Lines</span>
            <span></span>
          </div>
          {loans.map((l) => (
            <div
              key={l.id}
              className={`grid grid-cols-[1fr_auto_auto_auto_auto] gap-3 px-4 py-2.5 items-center border-t border-white/5 hover:bg-white/[0.03] cursor-pointer ${l.overdue && l.status === "out" ? "bg-red-500/5" : ""}`}
              onClick={() => setDetailId(l.id)}
            >
              <div className="min-w-0 text-sm text-white truncate">{l.borrowerName}</div>
              <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded whitespace-nowrap ${l.status === "returned" ? "bg-white/[0.04] text-white/30" : l.overdue ? "bg-red-500/10 text-red-400" : "bg-blue-500/10 text-blue-400"}`}>
                {l.overdue && l.status === "out" ? "Overdue" : LOAN_STATUS_LABEL[l.status as LoanStatus] ?? l.status}
              </span>
              <span className="text-xs text-white/50 whitespace-nowrap">{fmtDate(l.dueOn)}</span>
              <span className="text-xs text-white/50 font-mono whitespace-nowrap">{l.lineCount} · {qty(l.totalQty)}</span>
              <ChevronRight className="w-3.5 h-3.5 text-white/20" />
            </div>
          ))}
        </div>
      )}

      <CheckOutModal open={checkingOut} onClose={() => setCheckingOut(false)} items={items} locations={locations} />
      <LoanDetailModal key={detailId ?? "none"} loanId={detailId} onClose={() => setDetailId(null)} locations={locations} />
    </div>
  );
}
