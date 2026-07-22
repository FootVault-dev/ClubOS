// Warehouse channel sync (T16c, SPEC §4.3/§4.4/D9) — read-only visibility
// plus manual triggers over server/warehouse-sync.ts's (T12) push/reconcile
// engine. WMS is master (D9): this page never lets anyone type a stock
// number into Shopify — "Push now" reasserts OUR own computed `available`,
// "Run reconcile poll" is the same drift check the (not-yet-cron-wired, per
// T12's own comment) 10-min poll would run — both heal by RE-PUSHING our own
// number, never by adopting whatever Shopify last reported. `pendingPush`
// comes from the in-process debounce queue (GET /sync-state's own
// `pendingPush`, backed by T12's getPendingPushItemIds()) — wh_sync_state's
// own `pending` column is deliberately always false (see that table's
// comment in shared/schema.ts) and is never read on this page.
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  RefreshCw, Zap, AlertTriangle, CheckCircle2, Loader2, Link2, Radio,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";

interface SyncStoreStatus { store: string; configured: boolean }
interface SyncRow {
  itemId: number;
  itemSku: string;
  itemName: string;
  store: string;
  lastPushedQty: number | null;
  lastPushedAt: string | null;
  lastDriftAt: string | null;
  driftNote: string | null;
  pendingPush: boolean;
}
interface SiblingLink {
  id: number;
  itemId: number;
  itemSku: string;
  itemName: string;
  store: string;
  shopifyVariantId: string;
  shopifyInventoryItemId: string;
  note: string | null;
}
interface SyncStateData {
  enabled: boolean;
  stores: SyncStoreStatus[];
  rows: SyncRow[];
  siblingLinks: SiblingLink[];
  driftLog: SyncRow[];
}
interface ReconcileResult {
  checked: number;
  healed: number;
  alerts: Array<{ itemId: number; note: string }>;
}
interface PushOutcome {
  available: number;
  skippedReason?: string;
}

function qty(n: number | null): string {
  if (n === null) return "—";
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}
function fmtDateTime(d: string | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-NZ", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function PushButton({ itemId }: { itemId: number }) {
  const { toast } = useToast();
  const push = useMutation({
    mutationFn: async () => (await apiRequest("POST", `/api/admin/warehouse/sync-state/${itemId}/push`)).json() as Promise<PushOutcome>,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/warehouse/sync-state"] });
      toast({
        title: data.skippedReason ? "Push skipped" : "Pushed",
        description: data.skippedReason ?? `Available: ${data.available}`,
      });
    },
    onError: (e: Error) => toast({ title: "Push failed", description: e.message, variant: "destructive" }),
  });
  return (
    <button
      onClick={() => push.mutate()}
      disabled={push.isPending}
      className="px-2 py-1 rounded text-[11px] text-blue-400 bg-blue-500/10 hover:bg-blue-500/20 flex items-center gap-1 flex-shrink-0 disabled:opacity-40"
    >
      {push.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />} Push now
    </button>
  );
}

export default function WarehouseSync() {
  const { toast } = useToast();
  const [tab, setTab] = useState<"mappings" | "drift">("mappings");

  const { data, isLoading } = useQuery<SyncStateData>({
    queryKey: ["/api/admin/warehouse/sync-state"],
    queryFn: async () => (await apiRequest("GET", "/api/admin/warehouse/sync-state")).json(),
  });

  const reconcile = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/admin/warehouse/reconcile-poll")).json() as Promise<ReconcileResult>,
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/warehouse/sync-state"] });
      toast({
        title: "Reconcile poll complete",
        description: `Checked ${result.checked} · healed ${result.healed}${result.alerts.length ? ` · ${result.alerts.length} alert(s)` : ""}`,
      });
    },
    onError: (e: Error) => toast({ title: "Reconcile failed", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="p-4 sm:p-6 space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Sync</h1>
          <p className="text-sm text-white/40 mt-0.5">Channel mappings, push state, and Shopify drift — WMS is always the master number.</p>
        </div>
        <Button onClick={() => reconcile.mutate()} disabled={reconcile.isPending} className="bg-blue-600 hover:bg-blue-700 flex items-center gap-1.5">
          <RefreshCw className={`w-3.5 h-3.5 ${reconcile.isPending ? "animate-spin" : ""}`} /> Run reconcile poll
        </Button>
      </div>

      {isLoading || !data ? (
        <div className="text-white/40 text-sm py-10 text-center">Loading...</div>
      ) : (
        <>
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-[10px] uppercase tracking-wider px-2 py-1 rounded flex items-center gap-1.5 ${data.enabled ? "bg-emerald-500/10 text-emerald-400" : "bg-white/[0.04] text-white/40"}`}>
              <Radio className="w-3 h-3" /> Push queue {data.enabled ? "enabled" : "disabled (WH_SYNC_ENABLED unset)"}
            </span>
            {data.stores.map((s) => (
              <span
                key={s.store}
                className={`text-[10px] uppercase tracking-wider px-2 py-1 rounded ${s.configured ? "bg-emerald-500/10 text-emerald-400" : "bg-white/[0.04] text-white/40"}`}
              >
                {s.store} {s.configured ? "configured" : "not configured"}
              </span>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setTab("mappings")}
              className={`px-3 py-1.5 rounded-lg text-xs flex items-center gap-1.5 ${tab === "mappings" ? "bg-blue-600 text-white" : "bg-white/[0.04] text-white/60 hover:bg-white/[0.08]"}`}
            >
              <Link2 className="w-3.5 h-3.5" /> Mappings & push state
            </button>
            <button
              onClick={() => setTab("drift")}
              className={`px-3 py-1.5 rounded-lg text-xs flex items-center gap-1.5 ${tab === "drift" ? "bg-blue-600 text-white" : "bg-white/[0.04] text-white/60 hover:bg-white/[0.08]"}`}
            >
              <AlertTriangle className="w-3.5 h-3.5" /> Drift log {data.driftLog.length > 0 && `(${data.driftLog.length})`}
            </button>
          </div>

          {tab === "mappings" ? (
            <>
              {data.rows.length === 0 ? (
                <div className="py-16 text-center text-sm text-white/30">
                  <Link2 className="w-8 h-8 text-white/15 mx-auto mb-2" />
                  No items are mapped to a native or Shopify channel yet.
                </div>
              ) : (
                <div className="rounded-2xl border border-white/5 overflow-hidden">
                  <div className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-3 px-4 py-2 bg-white/[0.03] text-[10px] uppercase tracking-wider text-white/40">
                    <span>Item</span>
                    <span>Store</span>
                    <span>Last pushed</span>
                    <span>Queue</span>
                    <span></span>
                  </div>
                  {data.rows.map((r) => (
                    <div key={`${r.itemId}-${r.store}`} className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-3 px-4 py-2.5 items-center border-t border-white/5">
                      <div className="min-w-0">
                        <div className="text-sm text-white font-mono truncate">{r.itemSku}</div>
                        <div className="text-[11px] text-white/40 truncate">{r.itemName}</div>
                      </div>
                      <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-white/[0.04] text-white/60 whitespace-nowrap">{r.store}</span>
                      <span className="text-xs text-white/50 font-mono whitespace-nowrap">{qty(r.lastPushedQty)} · {fmtDateTime(r.lastPushedAt)}</span>
                      <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded whitespace-nowrap ${r.pendingPush ? "bg-amber-500/10 text-amber-400" : "bg-white/[0.04] text-white/30"}`}>
                        {r.pendingPush ? "Queued" : "Idle"}
                      </span>
                      <PushButton itemId={r.itemId} />
                    </div>
                  ))}
                </div>
              )}

              {data.siblingLinks.length > 0 && (
                <div className="space-y-2">
                  <h2 className="text-sm font-semibold text-white/70">Sibling variant links</h2>
                  <p className="text-[11px] text-white/30">Extra Shopify variants (e.g. Plain / Player / Custom) that receive the same push as their primary-mapped item.</p>
                  <div className="rounded-2xl border border-white/5 overflow-hidden">
                    <div className="grid grid-cols-[1fr_auto_auto_1fr] gap-3 px-4 py-2 bg-white/[0.03] text-[10px] uppercase tracking-wider text-white/40">
                      <span>Item</span>
                      <span>Store</span>
                      <span>Shopify variant</span>
                      <span>Note</span>
                    </div>
                    {data.siblingLinks.map((l) => (
                      <div key={l.id} className="grid grid-cols-[1fr_auto_auto_1fr] gap-3 px-4 py-2.5 items-center border-t border-white/5">
                        <div className="min-w-0">
                          <div className="text-sm text-white font-mono truncate">{l.itemSku}</div>
                          <div className="text-[11px] text-white/40 truncate">{l.itemName}</div>
                        </div>
                        <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-white/[0.04] text-white/60">{l.store}</span>
                        <span className="text-xs text-white/50 font-mono">{l.shopifyVariantId}</span>
                        <span className="text-xs text-white/40 truncate">{l.note ?? "—"}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <>
              {data.driftLog.length === 0 ? (
                <div className="py-16 text-center text-sm text-white/30">
                  <CheckCircle2 className="w-8 h-8 text-white/15 mx-auto mb-2" />
                  No unexplained drift against Shopify.
                </div>
              ) : (
                <div className="rounded-2xl border border-white/5 overflow-hidden">
                  <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3 px-4 py-2 bg-white/[0.03] text-[10px] uppercase tracking-wider text-white/40">
                    <span>Item</span>
                    <span>Store</span>
                    <span>When</span>
                    <span></span>
                  </div>
                  {data.driftLog.map((r) => (
                    <div key={`${r.itemId}-${r.store}`} className="grid grid-cols-[1fr_auto_auto_auto] gap-3 px-4 py-2.5 items-center border-t border-white/5 bg-orange-500/5">
                      <div className="min-w-0">
                        <div className="text-sm text-white font-mono truncate">{r.itemSku}</div>
                        <div className="text-[11px] text-orange-300/70 truncate">{r.driftNote}</div>
                      </div>
                      <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-white/[0.04] text-white/60">{r.store}</span>
                      <span className="text-xs text-white/50 whitespace-nowrap">{fmtDateTime(r.lastDriftAt)}</span>
                      <PushButton itemId={r.itemId} />
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
