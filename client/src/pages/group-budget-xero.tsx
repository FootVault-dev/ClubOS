import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Plug, RefreshCw, CheckCircle2, AlertCircle, ExternalLink } from "lucide-react";
import { FinanceNav } from "@/components/finance-nav";

interface SyncSummary {
  status: string;
  fromPeriod: string | null;
  toPeriod: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  rowsAdded: number;
  rowsUpdated: number;
  rowsSkipped: number;
  errorMessage: string | null;
}

interface Status {
  connected: boolean;
  tenantName: string | null;
  connectedAt: string | null;
  lastSync: SyncSummary | null;
  connectUrl: string;
}

const fmtDate = (iso: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("en-NZ", { dateStyle: "medium", timeStyle: "short" });
};

export default function GroupBudgetXeroPage() {
  const { toast } = useToast();
  const { data, isLoading, refetch } = useQuery<Status>({
    queryKey: ["/api/admin/budget/xero/status"],
  });

  const [months, setMonths] = useState(14);

  const sync = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/admin/budget/xero/sync", { months })).json(),
    onSuccess: (r: any) => {
      toast({ title: "Xero sync complete", description: `+${r.rowsAdded} new · ${r.rowsUpdated} updated · ${r.rowsSkipped} unchanged${r.errors?.length ? ` · ${r.errors.length} errors` : ""}` });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/budget/xero/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/budget/xero/accounts"] });
    },
    onError: (e: Error) => toast({ title: "Sync failed", description: e.message, variant: "destructive" }),
  });

  if (isLoading) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <Skeleton className="h-8 w-64 mb-6" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const connected = data?.connected ?? false;

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <FinanceNav />

      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-white">Xero — Budget actuals</h1>
        <p className="text-sm text-white/50 mt-1">Pull monthly P&amp;L from Xero, cache it locally, then map each account to a budget cost centre.</p>
      </div>

      {!connected ? (
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6">
          <div className="flex items-start gap-3">
            <Plug className="w-5 h-5 text-amber-300 mt-0.5" />
            <div className="flex-1">
              <h2 className="text-lg font-semibold text-white">Not connected</h2>
              <p className="text-sm text-white/60 mt-1">Connect Xero so ClubOS can pull your P&amp;L on a nightly schedule.</p>
              <p className="text-xs text-white/40 mt-3">
                Before connecting, add this redirect URI in the Xero developer dashboard:
                <code className="block mt-1 text-white/70 bg-white/[0.04] rounded px-2 py-1 break-all">https://app.usg.co.nz/api/integrations/xero/callback</code>
              </p>
              <a
                href={data?.connectUrl ?? "#"}
                className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-500/20 text-blue-200 hover:bg-blue-500/30 text-sm"
              >
                <ExternalLink className="w-4 h-4" /> Connect Xero
              </a>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="rounded-2xl border border-emerald-500/15 bg-emerald-500/[0.04] p-5">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="w-5 h-5 text-emerald-300 mt-0.5" />
              <div className="flex-1">
                <h2 className="text-lg font-semibold text-white">Connected to {data?.tenantName ?? "Xero"}</h2>
                <p className="text-xs text-white/50 mt-1">Linked {fmtDate(data?.connectedAt ?? null)}</p>
              </div>
              <Button variant="outline" size="sm" onClick={() => refetch()}>
                <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Refresh
              </Button>
            </div>
          </div>

          <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
            <h2 className="text-sm font-semibold text-white/90 uppercase tracking-wider mb-3">Sync</h2>
            <div className="flex items-end gap-3">
              <div className="flex-1">
                <label className="text-xs text-white/50 block mb-1">Months to pull</label>
                <input
                  type="number"
                  min={1}
                  max={24}
                  value={months}
                  onChange={(e) => setMonths(Math.max(1, Math.min(24, Number(e.target.value))))}
                  className="w-24 bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white tabular-nums"
                />
              </div>
              <Button onClick={() => sync.mutate()} disabled={sync.isPending}>
                {sync.isPending ? <><RefreshCw className="w-4 h-4 mr-2 animate-spin" /> Syncing…</> : <>Run sync now</>}
              </Button>
            </div>
          </div>

          {data?.lastSync && (
            <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
              <h2 className="text-sm font-semibold text-white/90 uppercase tracking-wider mb-3">Last sync</h2>
              <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                <div className="text-white/50">Status</div>
                <div className={data.lastSync.status === "succeeded" ? "text-emerald-300" : "text-red-300"}>
                  <span className="inline-flex items-center gap-1">
                    {data.lastSync.status === "succeeded" ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
                    {data.lastSync.status}
                  </span>
                </div>
                <div className="text-white/50">Window</div>
                <div className="text-white/80 tabular-nums">{data.lastSync.fromPeriod} → {data.lastSync.toPeriod}</div>
                <div className="text-white/50">Finished</div>
                <div className="text-white/80">{fmtDate(data.lastSync.finishedAt)}</div>
                <div className="text-white/50">Rows added</div>
                <div className="text-white/80 tabular-nums">{data.lastSync.rowsAdded}</div>
                <div className="text-white/50">Rows updated</div>
                <div className="text-white/80 tabular-nums">{data.lastSync.rowsUpdated}</div>
                <div className="text-white/50">Rows unchanged</div>
                <div className="text-white/80 tabular-nums">{data.lastSync.rowsSkipped}</div>
                {data.lastSync.errorMessage && (
                  <>
                    <div className="text-white/50">Errors</div>
                    <div className="text-red-300 text-xs">{data.lastSync.errorMessage}</div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
