// Requests — internal print requests from club staff.
//
// One page, two jobs, decided by the server:
//   • Anyone with the tab can submit a request and track their own.
//   • Only the print shop (workspace admin/manager, or a super admin) sees
//     Approve / Decline. `canDecide` comes from the API — the buttons are drawn
//     from the server's answer, never inferred from a role in the browser, and
//     the endpoint re-checks it anyway.
//
// Approving creates a real job on the Jobs board and links the two.

import { DatePickerInput } from "@/components/ui/date-picker-input";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useWorkspace } from "@/lib/workspace-context";
import { apiRequest, queryClient, workspaceFetch } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  Plus, X, Check, Ban, Clock, AlertTriangle, Shirt, Flag, Square,
  Sticker, FileImage, Package, ExternalLink, Trash2,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

type GarmentLine = { size: string; qty: number; name: string; number: string };

type PrintRequest = {
  id: number;
  status: "new" | "approved" | "declined";
  requestType: string;
  title: string;
  forBrand: string | null;
  quantity: number;
  widthMm: number | null;
  heightMm: number | null;
  sizeNote: string | null;
  garmentDetailsJson: GarmentLine[];
  printLocation: string | null;
  details: string | null;
  artworkUrl: string | null;
  artworkNote: string | null;
  neededBy: string | null;
  urgency: "standard" | "urgent";
  declineReason: string | null;
  printOrderId: number | null;
  createdAt: string;
  requesterName: string;
  decidedByName: string | null;
  decidedAt: string | null;
  isMine: boolean;
};

const TYPE_LABEL: Record<string, string> = {
  banner: "Banner",
  corflute: "Corflute sign",
  signage: "Signage",
  garment: "Shirt / garment printing",
  sticker_decal: "Stickers / decals",
  poster: "Poster",
  other: "Something else",
};

const TYPE_ICON: Record<string, any> = {
  banner: Flag, corflute: Square, signage: Package,
  garment: Shirt, sticker_decal: Sticker, poster: FileImage, other: Package,
};

// Sizes worth offering by default for kit work. Free text stays available.
const GARMENT_SIZES = ["4", "6", "8", "10", "12", "14", "XS", "S", "M", "L", "XL", "2XL", "3XL"];

function niceDate(d: string | null): string {
  if (!d) return "";
  // Bare ISO date — never through a Date, which shifts a day in NZ.
  const [y, m, day] = d.slice(0, 10).split("-");
  if (!y || !m || !day) return d;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${Number(day)} ${months[Number(m) - 1]} ${y}`;
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    new: "bg-amber-500/15 text-amber-300 border-amber-500/30",
    approved: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    declined: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
  };
  const label: Record<string, string> = { new: "Waiting", approved: "Approved", declined: "Declined" };
  return <span className={`text-[10px] px-2 py-0.5 rounded-full border ${map[status]}`}>{label[status] ?? status}</span>;
}

// ── The request form ─────────────────────────────────────────────────────────
function NewRequestModal({ open, onClose, brands }: { open: boolean; onClose: () => void; brands: string[] }) {
  const { toast } = useToast();
  const [f, setF] = useState({
    requestType: "banner", title: "", forBrand: "", quantity: "1",
    widthMm: "", heightMm: "", sizeNote: "", printLocation: "",
    details: "", artworkUrl: "", artworkNote: "", neededBy: "", urgency: "standard",
  });
  const [garment, setGarment] = useState<GarmentLine[]>([{ size: "", qty: 1, name: "", number: "" }]);

  const isGarment = f.requestType === "garment";
  // Only sized products need a width and height. A shirt doesn't, and asking
  // for one is how you get 0 × 0 in the database.
  const needsSize = ["banner", "corflute", "signage", "sticker_decal", "poster"].includes(f.requestType);

  const save = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/print-requests", {
        ...f,
        quantity: Number(f.quantity) || 1,
        widthMm: f.widthMm ? Number(f.widthMm) : null,
        heightMm: f.heightMm ? Number(f.heightMm) : null,
        garmentDetails: isGarment ? garment.filter(g => g.size || g.name || g.number) : [],
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/print-requests"] });
      toast({ title: "Request sent", description: "The print shop has been emailed. You'll hear back once they've looked at it." });
      onClose();
    },
    onError: (e: Error) => toast({ title: "Couldn't send it", description: e.message, variant: "destructive" }),
  });

  if (!open) return null;

  const garmentTotal = garment.reduce((a, g) => a + (Number(g.qty) || 0), 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-2xl rounded-2xl border border-white/10 bg-[#02060E] p-6 max-h-[90vh] overflow-auto">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-lg font-semibold text-white">Request a print job</h3>
          <button onClick={onClose} className="text-white/40 hover:text-white" aria-label="Close"><X className="w-4 h-4" /></button>
        </div>
        <p className="text-xs text-white/40 mb-4">The print shop reviews this and either starts the job or comes back to you.</p>

        <div className="space-y-4">
          {/* Type first — it decides what else we ask for. */}
          <div>
            <label className="text-[10px] uppercase tracking-wider text-white/40">What do you need printed</label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-1.5">
              {Object.keys(TYPE_LABEL).map(k => {
                const Icon = TYPE_ICON[k];
                const on = f.requestType === k;
                return (
                  <button key={k} type="button" onClick={() => setF({ ...f, requestType: k })}
                    className={`flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-[11px] leading-tight text-center transition ${
                      on ? "border-blue-500/50 bg-blue-500/10 text-white" : "border-white/10 bg-white/[0.02] text-white/60 hover:border-white/20"
                    }`}>
                    <Icon className="w-4 h-4" />
                    {TYPE_LABEL[k]}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="sm:col-span-2">
              <label className="text-[10px] uppercase tracking-wider text-white/40">Short description</label>
              <Input value={f.title} onChange={e => setF({ ...f, title: e.target.value })}
                placeholder={isGarment ? "e.g. Name and number for Anderson #22" : "e.g. Fence banner for Saturday's home game"}
                className="bg-white/[0.02] border-white/10 text-white" />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-white/40">Which brand / team</label>
              <select value={f.forBrand} onChange={e => setF({ ...f, forBrand: e.target.value })}
                className="w-full px-3 py-2 rounded-md bg-white/[0.02] border border-white/10 text-white text-sm">
                <option value="" className="bg-[#02060E]">Not sure / general</option>
                {brands.map(b => <option key={b} value={b} className="bg-[#02060E]">{b}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-white/40">Needed by</label>
              <DatePickerInput value={f.neededBy} onChange={e => setF({ ...f, neededBy: e.target.value })}
                className="bg-white/[0.02] border-white/10 text-white" />
            </div>
          </div>

          {needsSize && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="text-[10px] uppercase tracking-wider text-white/40">Width (mm)</label>
                <Input type="number" value={f.widthMm} onChange={e => setF({ ...f, widthMm: e.target.value })}
                  placeholder="3000" className="bg-white/[0.02] border-white/10 text-white" />
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider text-white/40">Height (mm)</label>
                <Input type="number" value={f.heightMm} onChange={e => setF({ ...f, heightMm: e.target.value })}
                  placeholder="800" className="bg-white/[0.02] border-white/10 text-white" />
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider text-white/40">How many</label>
                <Input type="number" min={1} value={f.quantity} onChange={e => setF({ ...f, quantity: e.target.value })}
                  className="bg-white/[0.02] border-white/10 text-white" />
              </div>
              <div className="sm:col-span-3">
                <div className="text-[11px] text-white/40">
                  Don't know the exact size? Leave it blank and describe it below — the shop's printer runs a 1.6m roll with any length.
                </div>
              </div>
            </div>
          )}

          {isGarment && (
            <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
              <div className="flex items-center justify-between mb-2">
                <label className="text-[10px] uppercase tracking-wider text-white/40">Shirts — one line each</label>
                <span className="text-[11px] text-white/40">{garmentTotal} item{garmentTotal === 1 ? "" : "s"}</span>
              </div>
              <div className="space-y-2">
                {garment.map((g, i) => (
                  <div key={i} className="grid grid-cols-[80px_60px_1fr_70px_28px] gap-2 items-center">
                    <select value={g.size} onChange={e => setGarment(garment.map((x, j) => j === i ? { ...x, size: e.target.value } : x))}
                      className="px-2 py-1.5 rounded-md bg-white/[0.02] border border-white/10 text-white text-xs">
                      <option value="" className="bg-[#02060E]">Size</option>
                      {GARMENT_SIZES.map(s => <option key={s} value={s} className="bg-[#02060E]">{s}</option>)}
                    </select>
                    <Input type="number" min={1} value={g.qty}
                      onChange={e => setGarment(garment.map((x, j) => j === i ? { ...x, qty: Number(e.target.value) || 1 } : x))}
                      className="bg-white/[0.02] border-white/10 text-white text-xs h-[34px]" />
                    <Input value={g.name} placeholder="Name on the back"
                      onChange={e => setGarment(garment.map((x, j) => j === i ? { ...x, name: e.target.value } : x))}
                      className="bg-white/[0.02] border-white/10 text-white text-xs h-[34px]" />
                    <Input value={g.number} placeholder="No."
                      onChange={e => setGarment(garment.map((x, j) => j === i ? { ...x, number: e.target.value } : x))}
                      className="bg-white/[0.02] border-white/10 text-white text-xs h-[34px]" />
                    <button type="button" onClick={() => setGarment(garment.length > 1 ? garment.filter((_, j) => j !== i) : garment)}
                      className="text-white/30 hover:text-red-400" aria-label="Remove line">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
              <button type="button" onClick={() => setGarment([...garment, { size: "", qty: 1, name: "", number: "" }])}
                className="mt-2 text-[11px] text-blue-300 hover:text-blue-200">+ Add another shirt</button>
              <div className="mt-3">
                <label className="text-[10px] uppercase tracking-wider text-white/40">Where does it go</label>
                <Input value={f.printLocation} onChange={e => setF({ ...f, printLocation: e.target.value })}
                  placeholder="e.g. name across the back, number below" className="bg-white/[0.02] border-white/10 text-white" />
              </div>
            </div>
          )}

          {!needsSize && !isGarment && (
            <div>
              <label className="text-[10px] uppercase tracking-wider text-white/40">How many</label>
              <Input type="number" min={1} value={f.quantity} onChange={e => setF({ ...f, quantity: e.target.value })}
                className="bg-white/[0.02] border-white/10 text-white sm:w-40" />
            </div>
          )}

          <div>
            <label className="text-[10px] uppercase tracking-wider text-white/40">Anything else the shop needs to know</label>
            <textarea value={f.details} onChange={e => setF({ ...f, details: e.target.value })}
              placeholder="Colours, material, where it's going, how it's mounted, who it's for…"
              className="w-full px-3 py-2 rounded-md bg-white/[0.02] border border-white/10 text-white text-sm min-h-[80px]" />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] uppercase tracking-wider text-white/40">Artwork link</label>
              <Input value={f.artworkUrl} onChange={e => setF({ ...f, artworkUrl: e.target.value })}
                placeholder="Drive / Dropbox link" className="bg-white/[0.02] border-white/10 text-white" />
              {/* Honest about the gap: there is no upload on this path yet. */}
              <div className="text-[10px] text-white/30 mt-0.5">Paste a link — files can't be uploaded here yet.</div>
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-white/40">How urgent</label>
              <select value={f.urgency} onChange={e => setF({ ...f, urgency: e.target.value })}
                className="w-full px-3 py-2 rounded-md bg-white/[0.02] border border-white/10 text-white text-sm">
                <option value="standard" className="bg-[#02060E]">Standard</option>
                <option value="urgent" className="bg-[#02060E]">Urgent</option>
              </select>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || !f.title.trim()} className="bg-blue-600 hover:bg-blue-700">
            {save.isPending ? "Sending..." : "Send request"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Decline, with a reason ───────────────────────────────────────────────────
function DeclineModal({ id, onClose }: { id: number | null; onClose: () => void }) {
  const { toast } = useToast();
  const [reason, setReason] = useState("");
  const go = useMutation({
    mutationFn: async () => (await apiRequest("PATCH", `/api/admin/print-requests/${id}/decide`, { action: "decline", reason })).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/print-requests"] });
      toast({ title: "Declined", description: "They've been emailed with your reason." });
      onClose();
    },
    onError: (e: Error) => toast({ title: "Couldn't decline it", description: e.message, variant: "destructive" }),
  });
  if (!id) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-2xl border border-white/10 bg-[#02060E] p-6">
        <h3 className="text-lg font-semibold text-white">Decline this request</h3>
        <p className="text-xs text-white/40 mt-1 mb-3">They'll get an email with whatever you write here — a line is plenty.</p>
        <textarea value={reason} onChange={e => setReason(e.target.value)}
          placeholder="e.g. Too big for our printer — come and see me and we'll do it as two panels."
          className="w-full px-3 py-2 rounded-md bg-white/[0.02] border border-white/10 text-white text-sm min-h-[90px]" />
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => go.mutate()} disabled={go.isPending} className="bg-red-600 hover:bg-red-700">
            {go.isPending ? "Declining..." : "Decline"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── A request card ───────────────────────────────────────────────────────────
function RequestCard({ r, canDecide, onDecline }: { r: PrintRequest; canDecide: boolean; onDecline: (id: number) => void }) {
  const { toast } = useToast();
  const Icon = TYPE_ICON[r.requestType] ?? Package;
  const approve = useMutation({
    mutationFn: async () => (await apiRequest("PATCH", `/api/admin/print-requests/${r.id}/decide`, { action: "approve" })).json(),
    onSuccess: (d: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/print-requests"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/print-orders"] });
      toast({ title: `Approved — job ${d?.orderNumber ?? ""}`.trim(), description: "It's on the Jobs board now, and they've been emailed." });
    },
    onError: (e: Error) => toast({ title: "Couldn't approve it", description: e.message, variant: "destructive" }),
  });
  const withdraw = useMutation({
    mutationFn: async () => { await apiRequest("DELETE", `/api/admin/print-requests/${r.id}`); },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/admin/print-requests"] }); toast({ title: "Request withdrawn" }); },
    onError: (e: Error) => toast({ title: "Couldn't withdraw it", description: e.message, variant: "destructive" }),
  });

  const size = r.widthMm && r.heightMm ? `${r.widthMm} × ${r.heightMm} mm` : r.sizeNote;
  const garment = Array.isArray(r.garmentDetailsJson) ? r.garmentDetailsJson : [];

  return (
    <div className={`rounded-xl border p-4 ${
      r.urgency === "urgent" && r.status === "new"
        ? "border-amber-500/40 bg-amber-500/[0.05]"
        : "border-white/5 bg-white/[0.02]"
    }`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Icon className="w-3.5 h-3.5 text-white/40 shrink-0" />
            <span className="text-[10px] uppercase tracking-wider text-white/40">{TYPE_LABEL[r.requestType] ?? r.requestType}</span>
            {r.forBrand && <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.06] text-white/60">{r.forBrand}</span>}
            {r.urgency === "urgent" && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 inline-flex items-center gap-1">
                <AlertTriangle className="w-2.5 h-2.5" /> Urgent
              </span>
            )}
          </div>
          <div className="font-bold text-white text-sm mt-1">{r.title}</div>
          <div className="text-[11px] text-white/40 mt-0.5">
            {r.requesterName}{r.isMine ? " (you)" : ""} · {niceDate(r.createdAt)}
            {r.neededBy && <> · <span className="text-white/60">needed by {niceDate(r.neededBy)}</span></>}
          </div>
        </div>
        <div className="shrink-0"><StatusPill status={r.status} /></div>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-white/60">
        <span>Qty {r.quantity}</span>
        {size && <span>{size}</span>}
        {r.printLocation && <span>{r.printLocation}</span>}
      </div>

      {garment.length > 0 && (
        <div className="mt-2 rounded-lg border border-white/5 bg-black/20 p-2 text-[11px] text-white/70 space-y-0.5">
          {garment.map((g, i) => (
            <div key={i}>
              {g.size && <span className="text-white/40">{g.size} </span>}
              ×{g.qty}
              {g.name && <> · {g.name}</>}
              {g.number && <> · #{g.number}</>}
            </div>
          ))}
        </div>
      )}

      {r.details && <p className="mt-2 text-xs text-white/60 whitespace-pre-wrap">{r.details}</p>}

      {r.artworkUrl && (
        <a href={r.artworkUrl} target="_blank" rel="noreferrer"
          className="mt-2 inline-flex items-center gap-1 text-xs text-blue-300 hover:text-blue-200">
          Artwork <ExternalLink className="w-3 h-3" />
        </a>
      )}

      {r.status === "declined" && (
        <div className="mt-3 rounded-lg border border-white/10 bg-black/20 p-2 text-xs text-white/60">
          Declined by {r.decidedByName ?? "someone"}{r.declineReason ? ` — ${r.declineReason}` : ""}
        </div>
      )}
      {r.status === "approved" && (
        <div className="mt-3 text-xs text-emerald-300/80">
          Approved by {r.decidedByName ?? "the print shop"} — it's a job on the Jobs board.
        </div>
      )}

      {r.status === "new" && (
        <div className="mt-3 flex items-center gap-2 pt-3 border-t border-white/5">
          {canDecide ? (
            <>
              <Button onClick={() => approve.mutate()} disabled={approve.isPending}
                className="bg-emerald-600 hover:bg-emerald-700 h-8 px-3 text-xs">
                <Check className="w-3.5 h-3.5 mr-1" /> {approve.isPending ? "Approving..." : "Approve"}
              </Button>
              <Button onClick={() => onDecline(r.id)} variant="ghost" className="h-8 px-3 text-xs text-white/60 hover:text-red-300">
                <Ban className="w-3.5 h-3.5 mr-1" /> Decline
              </Button>
            </>
          ) : (
            <span className="text-[11px] text-white/40 inline-flex items-center gap-1.5">
              <Clock className="w-3 h-3" /> Waiting on the print shop
            </span>
          )}
          {r.isMine && (
            <button onClick={() => withdraw.mutate()} disabled={withdraw.isPending}
              className="ml-auto text-[11px] text-white/30 hover:text-red-300">Withdraw</button>
          )}
        </div>
      )}
    </div>
  );
}

export default function PrintsRequests() {
  const { currentOrg } = useWorkspace();
  const orgId = currentOrg?.id;
  const [tab, setTab] = useState<"new" | "approved" | "declined" | "all">("new");
  const [adding, setAdding] = useState(false);
  const [declining, setDeclining] = useState<number | null>(null);

  const { data, isLoading, error } = useQuery<{
    requests: PrintRequest[]; canDecide: boolean; vocab: { brands: string[] };
  }>({
    queryKey: ["/api/admin/print-requests", { orgId }],
    queryFn: async () => {
      const res = await workspaceFetch(`/api/admin/print-requests`);
      if (!res.ok) {
        const b = await res.json().catch(() => null);
        throw new Error(b?.message || `Couldn't load requests (HTTP ${res.status})`);
      }
      return res.json();
    },
    enabled: !!orgId,
    refetchInterval: 60000,
  });

  const all = data?.requests ?? [];
  const canDecide = data?.canDecide ?? false;
  const brands = data?.vocab?.brands ?? [];
  const shown = tab === "all" ? all : all.filter(r => r.status === tab);
  const waiting = all.filter(r => r.status === "new").length;

  return (
    <div className="p-4 sm:p-6 space-y-5">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Requests</h1>
          <p className="text-sm text-white/40 mt-0.5">
            {canDecide
              ? "Print jobs the club has asked for. Approve one and it lands on the Jobs board."
              : "Ask the print shop for something. You'll get an email when they've looked at it."}
          </p>
        </div>
        <Button onClick={() => setAdding(true)} className="bg-blue-600 hover:bg-blue-700 shrink-0">
          <Plus className="w-4 h-4 mr-1.5" /> New request
        </Button>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        {([
          ["new", `Waiting${waiting ? ` (${waiting})` : ""}`],
          ["approved", "Approved"],
          ["declined", "Declined"],
          ["all", "All"],
        ] as const).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
              tab === k ? "bg-white/[0.09] text-white" : "text-white/50 hover:text-white/80 hover:bg-white/[0.04]"
            }`}>{label}</button>
        ))}
      </div>

      {error ? (
        <div className="rounded-xl border border-red-500/30 bg-red-500/[0.06] p-4">
          <div className="text-sm font-semibold text-white">Requests didn't load</div>
          <div className="mt-1 text-sm text-white/60">{(error as Error).message}</div>
          <Button onClick={() => queryClient.invalidateQueries({ queryKey: ["/api/admin/print-requests"] })}
            className="mt-3 bg-blue-600 hover:bg-blue-700">Try again</Button>
        </div>
      ) : isLoading ? (
        <div className="text-white/40 text-sm">Loading...</div>
      ) : shown.length === 0 ? (
        <div className="rounded-xl border border-white/5 bg-white/[0.02] p-8 text-center">
          <Package className="w-8 h-8 text-white/20 mx-auto" />
          <div className="mt-3 text-sm text-white/60">
            {tab === "new" ? "Nothing waiting." : `No ${tab} requests.`}
          </div>
          <div className="mt-1 text-xs text-white/35">
            {canDecide ? "Requests from staff will show up here." : "Hit New request to ask for something."}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {shown.map(r => (
            <RequestCard key={r.id} r={r} canDecide={canDecide} onDecline={setDeclining} />
          ))}
        </div>
      )}

      <NewRequestModal open={adding} onClose={() => setAdding(false)} brands={brands} key={adding ? "open" : "closed"} />
      <DeclineModal id={declining} onClose={() => setDeclining(null)} key={declining ?? "none"} />
    </div>
  );
}
