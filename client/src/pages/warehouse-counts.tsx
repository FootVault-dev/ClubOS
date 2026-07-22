// Warehouse cycle counts (T16c, SPEC §4.4/D12) — blind count sessions:
// scope a session (zone/class, or leave both blank for a full stock count),
// counters enter quantities with NO expected number shown (shouldHideExpectedQty
// is what the SERVER enforces — this page just renders whatever
// GET /counts/:id already gave it back, blind or full, per the count's own
// status), submit locks entry, then an approver (who must NOT be the
// counter, D12 — the server's canApproveCount rejects it with a 409 if so)
// reviews the always-full GET /counts/:id/variance list. A flagged line can
// be sent back for a recount via the SAME POST /count endpoint (no status
// transition needed — it's allowed while the session is still 'submitted',
// per T11's own route), then approving posts one adjustment movement per
// genuinely-differing line and reveals the whole session's expected/counted/
// variance for good (blind only ever hides it while in progress).
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  Plus, X, ClipboardCheck, Loader2, ChevronRight, CheckCircle2, AlertTriangle, EyeOff, RotateCcw,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { COUNT_STATUSES, COUNT_STATUS_LABELS, type CountStatus, type CountLineResolution } from "@shared/warehouse";

const ALL = "__all__";

const STATUS_BADGE: Record<CountStatus, string> = {
  open: "bg-blue-500/10 text-blue-400",
  submitted: "bg-amber-500/10 text-amber-400",
  approved: "bg-emerald-500/10 text-emerald-400",
};

interface CountRow {
  id: number;
  scopeZone: string | null;
  scopeClass: string | null;
  blind: boolean;
  status: CountStatus;
  createdAt: string;
  lineCount: number;
  countedLineCount: number;
  recountLineCount: number;
}
interface CountLineView {
  id: number;
  countId: number;
  itemId: number;
  locationId: number;
  locationCode: string;
  itemSku: string;
  itemName: string;
  countedQty: number | null;
  expectedQty?: number;
  resolution?: CountLineResolution | null;
  varianceQty?: number | null;
  needsRecount?: boolean;
  costCents?: number | null;
  allowNegative?: boolean;
}
interface CountDetail {
  id: number;
  scopeZone: string | null;
  scopeClass: string | null;
  blind: boolean;
  status: CountStatus;
  createdAt: string;
  submittedAt: string | null;
  approvedAt: string | null;
  lines: CountLineView[];
}
interface VarianceDetail extends CountDetail {
  recountFlaggedCount: number;
}

function qty(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}
function fmtDateTime(d: string | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-NZ", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function CreateCountModal({
  open, onClose, onCreated,
}: { open: boolean; onClose: () => void; onCreated: (id: number) => void }) {
  const { toast } = useToast();
  const [scopeZone, setScopeZone] = useState("");
  const [scopeClass, setScopeClass] = useState("");
  const [blind, setBlind] = useState(true);

  const reset = () => { setScopeZone(""); setScopeClass(""); setBlind(true); };

  const create = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/admin/warehouse/counts", {
      scopeZone: scopeZone || null,
      scopeClass: scopeClass || null,
      blind,
    })).json(),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/warehouse/counts"] });
      toast({ title: `Count session started — ${data.lineCount} line(s) to count` });
      onCreated(data.id);
      reset();
      onClose();
    },
    onError: (e: Error) => toast({ title: "Couldn't start session", description: e.message, variant: "destructive" }),
  });

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-2xl border border-white/10 bg-[#02060E] p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-white">New count session</h3>
          <button onClick={onClose} className="text-white/40 hover:text-white"><X className="w-4 h-4" /></button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="text-[10px] uppercase tracking-wider text-white/40">Scope zone (optional)</label>
            <Input value={scopeZone} onChange={(e) => setScopeZone(e.target.value)} placeholder="e.g. A, RECEIVING..." className="bg-white/[0.02] border-white/10 text-white" />
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-white/40">Scope class (optional)</label>
            <Input value={scopeClass} onChange={(e) => setScopeClass(e.target.value)} placeholder="Item category..." className="bg-white/[0.02] border-white/10 text-white" />
          </div>
          <p className="text-[11px] text-white/30">Leave both blank to count every bin's current stock.</p>
          <label className="flex items-center gap-2 text-sm text-white/70">
            <input type="checkbox" checked={blind} onChange={(e) => setBlind(e.target.checked)} className="accent-blue-600" />
            Blind count (counter never sees the expected quantity)
          </label>
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => create.mutate()} disabled={create.isPending} className="bg-blue-600 hover:bg-blue-700">
            {create.isPending ? "Starting..." : "Start session"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function CountEntryLine({ line, countId }: { line: CountLineView; countId: number }) {
  const { toast } = useToast();
  const [value, setValue] = useState(line.countedQty !== null ? String(line.countedQty) : "");
  const savedValue = line.countedQty !== null ? String(line.countedQty) : "";

  const save = useMutation({
    mutationFn: async () => (await apiRequest("POST", `/api/admin/warehouse/counts/${countId}/count`, {
      lines: [{ lineId: line.id, countedQty: Number(value) }],
    })).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/warehouse/counts", countId] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/warehouse/counts", "list"] });
    },
    onError: (e: Error) => toast({ title: "Couldn't save count", description: e.message, variant: "destructive" }),
  });

  const dirty = value !== savedValue;

  return (
    <div className="flex items-center gap-3 p-2.5 rounded-lg bg-white/[0.02] border border-white/5">
      <div className="flex-1 min-w-0">
        <div className="text-sm text-white font-mono truncate">{line.itemSku}</div>
        <div className="text-[11px] text-white/40 truncate">{line.itemName} · {line.locationCode}</div>
      </div>
      <Input
        type="number"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Qty"
        className="w-24 bg-white/[0.02] border-white/10 text-white text-sm"
      />
      <Button
        size="sm"
        onClick={() => save.mutate()}
        disabled={save.isPending || value === "" || !dirty}
        className="bg-blue-600 hover:bg-blue-700 flex-shrink-0"
      >
        {save.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : line.countedQty !== null ? "Update" : "Save"}
      </Button>
    </div>
  );
}

function VarianceLine({ line, countId }: { line: CountLineView; countId: number }) {
  const { toast } = useToast();
  const [recounting, setRecounting] = useState(false);
  const [value, setValue] = useState(line.countedQty !== null ? String(line.countedQty) : "");

  const recount = useMutation({
    mutationFn: async () => (await apiRequest("POST", `/api/admin/warehouse/counts/${countId}/count`, {
      lines: [{ lineId: line.id, countedQty: Number(value) }],
    })).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/warehouse/counts", countId, "variance"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/warehouse/counts", countId] });
      setRecounting(false);
      toast({ title: "Recount saved" });
    },
    onError: (e: Error) => toast({ title: "Couldn't save recount", description: e.message, variant: "destructive" }),
  });

  const variance = line.varianceQty ?? 0;
  return (
    <div className={`p-3 rounded-lg border ${line.resolution === "recount" ? "bg-amber-500/5 border-amber-500/20" : "bg-white/[0.02] border-white/5"}`}>
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-sm text-white font-mono truncate">{line.itemSku}</div>
          <div className="text-[11px] text-white/40 truncate">{line.itemName} · {line.locationCode}</div>
        </div>
        <div className="text-xs text-white/60 font-mono flex-shrink-0 text-right">
          <div>{qty(line.expectedQty ?? 0)} expected</div>
          <div>{qty(line.countedQty ?? 0)} counted</div>
        </div>
        <span className={`text-xs font-mono flex-shrink-0 w-16 text-right ${variance > 0 ? "text-emerald-400" : variance < 0 ? "text-red-400" : "text-white/40"}`}>
          {variance > 0 ? "+" : ""}{qty(variance)}
        </span>
        {line.resolution === "recount" && (
          <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 flex-shrink-0">Recount</span>
        )}
      </div>
      {line.resolution === "recount" && (
        recounting ? (
          <div className="mt-2 flex items-center gap-2">
            <Input type="number" value={value} onChange={(e) => setValue(e.target.value)} className="w-24 bg-white/[0.02] border-white/10 text-white text-sm" />
            <Button size="sm" onClick={() => recount.mutate()} disabled={recount.isPending || value === ""} className="bg-amber-600 hover:bg-amber-700">
              {recount.isPending ? "Saving..." : "Save recount"}
            </Button>
            <button onClick={() => setRecounting(false)} className="text-xs text-white/40 hover:text-white/70">Cancel</button>
          </div>
        ) : (
          <button onClick={() => setRecounting(true)} className="mt-2 text-xs text-amber-400 hover:text-amber-300 flex items-center gap-1">
            <RotateCcw className="w-3 h-3" /> Enter a recount
          </button>
        )
      )}
    </div>
  );
}

function CountDetailModal({ countId, onClose }: { countId: number | null; onClose: () => void }) {
  const { toast } = useToast();
  const [approveNote, setApproveNote] = useState("");

  const { data: count, isLoading } = useQuery<CountDetail>({
    queryKey: ["/api/admin/warehouse/counts", countId],
    queryFn: async () => (await apiRequest("GET", `/api/admin/warehouse/counts/${countId}`)).json(),
    enabled: countId !== null,
  });
  const { data: variance } = useQuery<VarianceDetail>({
    queryKey: ["/api/admin/warehouse/counts", countId, "variance"],
    queryFn: async () => (await apiRequest("GET", `/api/admin/warehouse/counts/${countId}/variance`)).json(),
    enabled: countId !== null && count?.status === "submitted",
  });

  const submit = useMutation({
    mutationFn: async () => (await apiRequest("POST", `/api/admin/warehouse/counts/${countId}/submit`)).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/warehouse/counts", countId] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/warehouse/counts", "list"] });
      toast({ title: "Submitted for approval" });
    },
    onError: (e: Error) => toast({ title: "Couldn't submit", description: e.message, variant: "destructive" }),
  });

  const approve = useMutation({
    mutationFn: async () => (await apiRequest("POST", `/api/admin/warehouse/counts/${countId}/approve`, { note: approveNote || undefined })).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/warehouse/counts", countId] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/warehouse/counts", countId, "variance"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/warehouse/counts", "list"] });
      toast({ title: "Count approved — stock adjusted" });
    },
    onError: (e: Error) => toast({ title: "Couldn't approve", description: e.message, variant: "destructive" }),
  });

  if (countId === null) return null;
  const allCounted = count ? count.lines.every((l) => l.countedQty !== null) : false;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-2xl rounded-2xl border border-white/10 bg-[#02060E] p-6 max-h-[90vh] overflow-auto">
        {isLoading || !count ? (
          <div className="py-16 flex items-center justify-center gap-2 text-white/40 text-sm">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading...
          </div>
        ) : (
          <>
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="text-lg font-semibold text-white">
                  Count #{count.id}
                  {count.scopeZone && ` · Zone ${count.scopeZone}`}
                  {count.scopeClass && ` · ${count.scopeClass}`}
                </h3>
                <div className="flex items-center gap-2 mt-1">
                  <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${STATUS_BADGE[count.status]}`}>
                    {COUNT_STATUS_LABELS[count.status]}
                  </span>
                  {count.blind && count.status !== "approved" && (
                    <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-white/[0.04] text-white/40 flex items-center gap-1">
                      <EyeOff className="w-3 h-3" /> Blind
                    </span>
                  )}
                </div>
              </div>
              <button onClick={onClose} className="text-white/40 hover:text-white"><X className="w-4 h-4" /></button>
            </div>

            {count.status !== "approved" && (
              <div className="space-y-1.5 mb-4">
                <div className="text-[11px] uppercase tracking-wider text-white/40 mb-1">
                  Enter counts {count.blind && "— expected quantity is hidden"}
                </div>
                {count.lines.map((l) => (
                  <CountEntryLine key={l.id} line={l} countId={count.id} />
                ))}
              </div>
            )}

            {count.status === "open" && (
              <div className="flex justify-end pt-3 border-t border-white/5">
                <Button onClick={() => submit.mutate()} disabled={submit.isPending || !allCounted} className="bg-blue-600 hover:bg-blue-700 flex items-center gap-1.5">
                  <ClipboardCheck className="w-3.5 h-3.5" /> Submit for approval
                </Button>
              </div>
            )}

            {count.status === "submitted" && (
              <div className="pt-3 border-t border-white/5 space-y-3">
                <div className="text-[11px] uppercase tracking-wider text-white/40">Review & approve</div>
                {!variance ? (
                  <div className="text-sm text-white/40 py-4 text-center"><Loader2 className="w-4 h-4 animate-spin inline" /></div>
                ) : variance.lines.length === 0 ? (
                  <div className="p-3 rounded-lg bg-emerald-500/5 border border-emerald-500/20 text-sm text-emerald-300 flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4" /> Every line matches — nothing to adjust.
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {variance.recountFlaggedCount > 0 && (
                      <div className="text-xs text-amber-400 flex items-center gap-1.5 mb-1">
                        <AlertTriangle className="w-3.5 h-3.5" /> {variance.recountFlaggedCount} line(s) flagged for recount (&gt;10% or &gt;$100 variance)
                      </div>
                    )}
                    {variance.lines.map((l) => <VarianceLine key={l.id} line={l} countId={count.id} />)}
                  </div>
                )}
                <Input
                  placeholder="Approval note (optional)"
                  value={approveNote}
                  onChange={(e) => setApproveNote(e.target.value)}
                  className="bg-white/[0.02] border-white/10 text-white text-sm"
                />
                <div className="flex justify-end">
                  <Button onClick={() => approve.mutate()} disabled={approve.isPending} className="bg-emerald-600 hover:bg-emerald-700 flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5" /> {approve.isPending ? "Approving..." : "Approve & post adjustments"}
                  </Button>
                </div>
              </div>
            )}

            {count.status === "approved" && (
              <div className="pt-3 border-t border-white/5 text-xs text-white/40">
                Approved {fmtDateTime(count.approvedAt)} — stock adjustments have been posted to the ledger.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default function WarehouseCounts() {
  const [status, setStatus] = useState<string>(ALL);
  const [scopeZone, setScopeZone] = useState("");
  const [scopeClass, setScopeClass] = useState("");
  const [detailId, setDetailId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);

  const params = new URLSearchParams();
  if (status !== ALL) params.set("status", status);
  if (scopeZone) params.set("scopeZone", scopeZone);
  if (scopeClass) params.set("scopeClass", scopeClass);

  const { data: counts = [], isLoading } = useQuery<CountRow[]>({
    queryKey: ["/api/admin/warehouse/counts", "list", status, scopeZone, scopeClass],
    queryFn: async () => (await apiRequest("GET", `/api/admin/warehouse/counts?${params.toString()}`)).json(),
  });

  return (
    <div className="p-4 sm:p-6 space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Counts</h1>
          <p className="text-sm text-white/40 mt-0.5">Blind cycle counts — scope it, count it, review variance, approve.</p>
        </div>
        <Button onClick={() => setCreating(true)} className="bg-blue-600 hover:bg-blue-700 flex items-center gap-1.5">
          <Plus className="w-4 h-4" /> New count session
        </Button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-48 bg-white/[0.02] border-white/10 text-white"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All statuses</SelectItem>
            {COUNT_STATUSES.map((s) => <SelectItem key={s} value={s}>{COUNT_STATUS_LABELS[s]}</SelectItem>)}
          </SelectContent>
        </Select>
        <Input placeholder="Exact zone..." value={scopeZone} onChange={(e) => setScopeZone(e.target.value)} className="w-40 bg-white/[0.02] border-white/10 text-white" />
        <Input placeholder="Exact class..." value={scopeClass} onChange={(e) => setScopeClass(e.target.value)} className="w-40 bg-white/[0.02] border-white/10 text-white" />
      </div>

      {isLoading ? (
        <div className="text-white/40 text-sm py-10 text-center">Loading...</div>
      ) : counts.length === 0 ? (
        <div className="py-16 text-center text-sm text-white/30">
          <ClipboardCheck className="w-8 h-8 text-white/15 mx-auto mb-2" />
          No count sessions match this filter.
        </div>
      ) : (
        <div className="rounded-2xl border border-white/5 overflow-hidden">
          <div className="grid grid-cols-[auto_1fr_auto_auto_auto] gap-3 px-4 py-2 bg-white/[0.03] text-[10px] uppercase tracking-wider text-white/40">
            <span>#</span>
            <span>Scope</span>
            <span>Status</span>
            <span>Progress</span>
            <span></span>
          </div>
          {counts.map((c) => (
            <div
              key={c.id}
              className="grid grid-cols-[auto_1fr_auto_auto_auto] gap-3 px-4 py-2.5 items-center border-t border-white/5 hover:bg-white/[0.03] cursor-pointer"
              onClick={() => setDetailId(c.id)}
            >
              <span className="text-xs text-white/40 font-mono">{c.id}</span>
              <div className="min-w-0">
                <div className="text-sm text-white truncate">
                  {c.scopeZone || c.scopeClass
                    ? [c.scopeZone && `Zone ${c.scopeZone}`, c.scopeClass].filter(Boolean).join(" · ")
                    : "Full stock"}
                </div>
                <div className="text-[11px] text-white/40">
                  {fmtDateTime(c.createdAt)}{c.recountLineCount > 0 && ` · ${c.recountLineCount} flagged`}
                </div>
              </div>
              <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded whitespace-nowrap ${STATUS_BADGE[c.status]}`}>
                {COUNT_STATUS_LABELS[c.status]}
              </span>
              <span className="text-xs text-white/50 font-mono whitespace-nowrap">{c.countedLineCount}/{c.lineCount}</span>
              <ChevronRight className="w-3.5 h-3.5 text-white/20" />
            </div>
          ))}
        </div>
      )}

      <CreateCountModal open={creating} onClose={() => setCreating(false)} onCreated={(id) => setDetailId(id)} />
      <CountDetailModal key={detailId ?? "none"} countId={detailId} onClose={() => setDetailId(null)} />
    </div>
  );
}
