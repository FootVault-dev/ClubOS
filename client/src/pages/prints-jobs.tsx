import { DatePickerInput } from "@/components/ui/date-picker-input";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useWorkspace } from "@/lib/workspace-context";
import { apiRequest, queryClient, workspaceFetch } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Search, Filter, Clock, AlertCircle, Plus, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { MoneyInput } from "@/components/ui/money-input";
import { dollarInputToCents } from "@/lib/format";
import type { PrintOrder } from "@shared/schema";

// Six Kanban columns matching the canonical print MIS workflow stages.
// Cancelled and the legacy 'inquiry'/'quoted'/'confirmed' states are
// filtered out — they're either pre-payment (private to the customer
// flow) or terminal (cancelled).
const COLUMNS: { id: string; label: string; sub: string; statuses: string[] }[] = [
  { id: "quote_sent",        label: "Quote sent",       sub: "Awaiting payment",      statuses: ["quote_sent", "quoted"] },
  { id: "paid",              label: "Paid",             sub: "Awaiting artwork",      statuses: ["paid", "artwork_pending", "confirmed"] },
  { id: "in_design",         label: "Design",           sub: "Pre-press",             statuses: ["in_design"] },
  { id: "in_proof",          label: "Proof",            sub: "Awaiting customer",     statuses: ["in_proof"] },
  { id: "in_production",     label: "Production",       sub: "On the press",          statuses: ["in_production", "proof_approved"] },
  { id: "finishing",         label: "Finishing",        sub: "Trim, hem, eyelet",     statuses: ["finishing"] },
  { id: "ready",             label: "Ready",            sub: "Pickup or deliver",     statuses: ["ready", "delivered"] },
];

const STATUS_TARGET_BY_COL: Record<string, string> = {
  quote_sent: "quote_sent",
  paid: "paid",
  in_design: "in_design",
  in_proof: "in_proof",
  in_production: "in_production",
  finishing: "finishing",
  ready: "ready",
};

function money(cents: number | null | undefined): string {
  if (!cents) return "$0.00";
  return `$${(cents / 100).toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function daysOverdue(order: PrintOrder): number {
  if (!order.pickupReadyDate) return 0;
  if (order.status === "ready" || order.status === "delivered" || order.status === "cancelled") return 0;
  const due = new Date(order.pickupReadyDate + "T00:00:00").getTime();
  return Math.floor((Date.now() - due) / (1000 * 60 * 60 * 24));
}

// A job that walked in the door, rang up, or came off a request — anything that
// didn't arrive through the website. Dima types the little he knows and moves it
// along the board like any other.
function AddJobModal({ open, onClose, orgId }: { open: boolean; onClose: () => void; orgId?: number }) {
  const { toast } = useToast();
  const [form, setForm] = useState({
    title: "", customerName: "", customerEmail: "", customerPhone: "",
    description: "", amount: "", dueDate: "", status: "in_design", notes: "",
  });

  const save = useMutation({
    mutationFn: async () => {
      const cents = dollarInputToCents(form.amount);
      const res = await apiRequest("POST", "/api/admin/print-orders", {
        organizationId: orgId,
        title: form.title.trim(),
        // Internal club work usually has no "customer" — default it rather than
        // forcing Dima to invent one.
        customerName: form.customerName.trim() || "Walk-in",
        customerEmail: form.customerEmail.trim() || null,
        customerPhone: form.customerPhone.trim() || null,
        description: form.description.trim() || null,
        status: form.status,
        // Money in dollars in the UI, cents on the wire. `amount` is the legacy
        // decimal column the list view reads; the cents columns are what the
        // board totals from — set both or the card shows $0.00 next to a price.
        amount: cents ? (cents / 100).toFixed(2) : "0.00",
        subtotalCents: cents,
        gstCents: Math.round(cents * 0.15),
        totalCents: cents + Math.round(cents * 0.15),
        paidCents: 0,
        deliveryMethod: "pickup",
        dueDate: form.dueDate || null,
        notes: form.notes.trim() || null,
      });
      return res.json();
    },
    onSuccess: (order: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/print-orders"] });
      toast({ title: order?.orderNumber ? `Job ${order.orderNumber} added` : "Job added" });
      onClose();
    },
    onError: (e: Error) => toast({ title: "Couldn't add the job", description: e.message, variant: "destructive" }),
  });

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-lg rounded-2xl border border-white/10 bg-[#02060E] p-6 max-h-[90vh] overflow-auto">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-lg font-semibold text-white">Add a job</h3>
          <button onClick={onClose} className="text-white/40 hover:text-white" aria-label="Close"><X className="w-4 h-4" /></button>
        </div>
        <p className="text-xs text-white/40 mb-4">For work that didn't come through the website — a walk-in, a phone order, or something you've agreed off the books.</p>

        <div className="space-y-3">
          <div>
            <label className="text-[10px] uppercase tracking-wider text-white/40">What is it</label>
            <Input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })}
              placeholder="e.g. 3m fence banner for Saturday" className="bg-white/[0.02] border-white/10 text-white" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] uppercase tracking-wider text-white/40">Customer</label>
              <Input value={form.customerName} onChange={e => setForm({ ...form, customerName: e.target.value })}
                placeholder="Walk-in" className="bg-white/[0.02] border-white/10 text-white" />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-white/40">Starts in</label>
              <select value={form.status} onChange={e => setForm({ ...form, status: e.target.value })}
                className="w-full px-3 py-2 rounded-md bg-white/[0.02] border border-white/10 text-white text-sm">
                {COLUMNS.map(c => <option key={c.id} value={STATUS_TARGET_BY_COL[c.id]} className="bg-[#02060E]">{c.label}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-white/40">Email</label>
              <Input value={form.customerEmail} onChange={e => setForm({ ...form, customerEmail: e.target.value })}
                placeholder="optional" className="bg-white/[0.02] border-white/10 text-white" />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-white/40">Phone</label>
              <Input value={form.customerPhone} onChange={e => setForm({ ...form, customerPhone: e.target.value })}
                placeholder="optional" className="bg-white/[0.02] border-white/10 text-white" />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-white/40">Price (ex GST)</label>
              <MoneyInput value={form.amount} onChange={v => setForm({ ...form, amount: v })}
                className="bg-white/[0.02] border-white/10 text-white" />
              <div className="text-[10px] text-white/30 mt-0.5">Leave blank if you haven't priced it</div>
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-white/40">Due date</label>
              <DatePickerInput value={form.dueDate} onChange={e => setForm({ ...form, dueDate: e.target.value })}
                className="bg-white/[0.02] border-white/10 text-white" />
            </div>
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-white/40">Details</label>
            <textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })}
              placeholder="Size, material, finishing, artwork — whatever the press needs to know."
              className="w-full px-3 py-2 rounded-md bg-white/[0.02] border border-white/10 text-white text-sm min-h-[70px]" />
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-white/40">Internal notes</label>
            <Input value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })}
              placeholder="optional" className="bg-white/[0.02] border-white/10 text-white" />
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || !form.title.trim()} className="bg-blue-600 hover:bg-blue-700">
            {save.isPending ? "Adding..." : "Add job"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function PrintsJobs() {
  const { currentOrg } = useWorkspace();
  const orgId = currentOrg?.id;
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [draggedId, setDraggedId] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);

  // workspaceFetch, not a bare fetch — see the note in prints-materials.tsx.
  // This route isn't tab-gated today, but the moment it is, a bare fetch breaks
  // for everyone except a super admin and does it silently.
  const { data: orders = [], isLoading } = useQuery<PrintOrder[]>({
    queryKey: ["/api/admin/print-orders", { orgId }],
    queryFn: async () => {
      const res = await workspaceFetch(`/api/admin/print-orders?orgId=${orgId}`);
      if (!res.ok) throw new Error(`Couldn't load jobs (HTTP ${res.status})`);
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    },
    enabled: !!orgId,
    refetchInterval: 30000,  // poll every 30s — Dima's screen stays current
  });

  const updateStatus = useMutation({
    mutationFn: async ({ id, status }: { id: number; status: string }) => {
      const res = await apiRequest("PATCH", `/api/admin/print-orders/${id}`, { status });
      return res.json();
    },
    onMutate: async ({ id, status }) => {
      // Optimistic update — prevents the card snapping back during the request
      await queryClient.cancelQueries({ queryKey: ["/api/admin/print-orders", { orgId }] });
      const previous = queryClient.getQueryData<PrintOrder[]>(["/api/admin/print-orders", { orgId }]);
      queryClient.setQueryData<PrintOrder[]>(["/api/admin/print-orders", { orgId }],
        (old) => old?.map(o => o.id === id ? { ...o, status: status as any } : o) ?? []);
      return { previous };
    },
    onError: (e: Error, _v, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(["/api/admin/print-orders", { orgId }], ctx.previous);
      toast({ title: "Couldn't move card", description: e.message, variant: "destructive" });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["/api/admin/print-orders", { orgId }] }),
  });

  const filtered = orders.filter(o => {
    if (!search) return true;
    const q = search.toLowerCase();
    return o.orderNumber?.toLowerCase().includes(q) ||
           o.customerName.toLowerCase().includes(q) ||
           o.title.toLowerCase().includes(q);
  });

  const byColumn = (col: typeof COLUMNS[0]) =>
    filtered.filter(o => col.statuses.includes(o.status));

  return (
    <div className="p-4 sm:p-6 space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Jobs</h1>
          <p className="text-sm text-white/40 mt-0.5">Drag cards between columns to update status. Customers get an email at every stage.</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />
            <Input
              type="text"
              placeholder="Search by order #, customer, or title..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-10 bg-white/[0.02] border-white/10 text-white w-64 sm:w-80"
            />
          </div>
          <Button onClick={() => setAdding(true)} className="bg-blue-600 hover:bg-blue-700 shrink-0">
            <Plus className="w-4 h-4 mr-1.5" /> Add job
          </Button>
        </div>
      </div>

      <AddJobModal open={adding} onClose={() => setAdding(false)} orgId={orgId} key={adding ? "open" : "closed"} />

      {isLoading ? (
        <div className="text-white/40 text-sm">Loading orders...</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-7 gap-3 overflow-x-auto pb-3">
          {COLUMNS.map(col => {
            const colOrders = byColumn(col);
            return (
              <div
                key={col.id}
                onDragOver={(e) => { e.preventDefault(); }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (draggedId !== null) {
                    const target = STATUS_TARGET_BY_COL[col.id];
                    updateStatus.mutate({ id: draggedId, status: target });
                    setDraggedId(null);
                  }
                }}
                className="rounded-2xl border border-white/5 bg-white/[0.02] p-3 min-h-[400px]"
              >
                <div className="flex items-center justify-between mb-3 px-1">
                  <div>
                    <div className="text-[11px] uppercase tracking-wider font-semibold text-white/60">{col.label}</div>
                    <div className="text-[10px] text-white/30">{col.sub}</div>
                  </div>
                  <div className="text-[11px] font-mono text-white/40 bg-white/[0.04] px-1.5 py-0.5 rounded">{colOrders.length}</div>
                </div>
                <div className="space-y-2">
                  {colOrders.map(o => {
                    const overdue = daysOverdue(o);
                    return (
                      <div
                        key={o.id}
                        draggable
                        onDragStart={() => setDraggedId(o.id)}
                        onDragEnd={() => setDraggedId(null)}
                        onClick={() => setLocation(`/admin/print-orders/${o.id}`)}
                        className={`p-3 rounded-xl border bg-white/[0.04] hover:bg-white/[0.06] cursor-pointer transition ${
                          overdue > 0 ? "border-red-500/30" : "border-white/5"
                        }`}
                      >
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-[10px] font-mono font-semibold text-white/50">{o.orderNumber || `#${o.id}`}</span>
                          <span className="text-xs font-bold text-white">{money(o.totalCents)}</span>
                        </div>
                        <div className="text-sm text-white truncate">{o.title}</div>
                        <div className="text-xs text-white/40 truncate mt-0.5">{o.customerName}</div>
                        <div className="flex items-center justify-between mt-2 text-[10px]">
                          {o.pickupReadyDate ? (
                            <span className={`flex items-center gap-1 ${overdue > 0 ? "text-red-400" : "text-white/40"}`}>
                              {overdue > 0 ? <AlertCircle className="w-3 h-3" /> : <Clock className="w-3 h-3" />}
                              {overdue > 0 ? `${overdue}d overdue` : `Due ${o.pickupReadyDate}`}
                            </span>
                          ) : <span className="text-white/30">No due date</span>}
                          {o.rushRequested && (
                            <span className="text-orange-400 font-bold">RUSH</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  {colOrders.length === 0 && (
                    <div className="text-xs text-white/20 text-center py-6">Drop cards here</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
