import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  BellRing, Send, Loader2, CheckCircle2, AlertTriangle, X, Smartphone,
  TabletSmartphone, Eye,
} from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type Overview = { total: number; ios: number; android: number; disabled: number; lastRegisteredAt: string | null };
type Device = { id: number; platform: string; deviceName: string | null; createdAt: string };
type Campaign = {
  id: number; title: string; body: string; recipientCount: number | null; sentCount: number | null;
  failedCount: number | null; status: string; sentAt: string | null; createdAt: string;
};

const TITLE_MAX = 120;
const BODY_MAX = 1000;

// Push Notifications — broadcast to every CIC Youth app install (iOS + Android)
// through Expo's push service. Devices register their token on app launch;
// counts here grow as people install/update the app.
export default function CicPush() {
  const { toast } = useToast();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [testDeviceId, setTestDeviceId] = useState<string>("");
  const [confirmOpen, setConfirmOpen] = useState(false);

  const { data: overview } = useQuery<Overview>({
    queryKey: ["/api/admin/cic/push/overview"],
    queryFn: () => apiRequest("GET", "/api/admin/cic/push/overview").then((r) => r.json()),
    refetchInterval: 60000,
  });

  const { data: devices = [] } = useQuery<Device[]>({
    queryKey: ["/api/admin/cic/push/devices"],
    queryFn: () => apiRequest("GET", "/api/admin/cic/push/devices").then((r) => r.json()),
  });

  // Poll while a broadcast is in flight — the send runs as a background queue
  // on the server, so progress lands on the campaign row.
  const { data: campaigns = [] } = useQuery<Campaign[]>({
    queryKey: ["/api/admin/cic/push/campaigns"],
    queryFn: () => apiRequest("GET", "/api/admin/cic/push/campaigns").then((r) => r.json()),
    refetchInterval: (query) => (query.state.data ?? []).some((c) => c.status === "sending") ? 3000 : false,
  });

  const testSend = useMutation({
    mutationFn: () => apiRequest("POST", "/api/admin/cic/push/test-send", {
      deviceId: parseInt(testDeviceId), title: title.trim(), body: body.trim(),
    }).then((r) => r.json()),
    onSuccess: (r: { ok: boolean; error?: string }) => toast(r.ok
      ? { title: "Test sent 📲", description: "Check the device — it should buzz within seconds." }
      : { title: "Test failed", description: r.error || "Unknown error", variant: "destructive" }),
    onError: (e: any) => toast({ title: "Couldn't send test", description: e.message, variant: "destructive" }),
  });

  const send = useMutation({
    mutationFn: () => apiRequest("POST", "/api/admin/cic/push/send", { title: title.trim(), body: body.trim() }).then((r) => r.json()),
    onSuccess: (r: { queued: boolean; recipientCount: number }) => {
      setConfirmOpen(false);
      toast({ title: "Sending now 📤", description: `Broadcasting to ${r.recipientCount} devices — watch the progress under Recent sends.` });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/cic/push/campaigns"] });
      setTitle(""); setBody("");
    },
    onError: (e: any) => { setConfirmOpen(false); toast({ title: "Send failed", description: e.message, variant: "destructive" }); },
  });

  const canSend = title.trim().length > 0 && body.trim().length > 0;
  const deviceLabel = (d: Device) =>
    `${d.deviceName || "Unknown device"} · ${d.platform === "ios" ? "iPhone" : d.platform === "android" ? "Android" : "?"} · ${new Date(d.createdAt).toLocaleDateString("en-NZ", { day: "numeric", month: "short" })}`;

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Notifications</h1>
        <p className="text-sm text-white/40 mt-1">Send a push notification to everyone with the CIC Youth app — iPhone and Android</p>
      </div>

      {/* Device stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Devices reachable", value: overview?.total ?? "…", icon: BellRing },
          { label: "iPhone", value: overview?.ios ?? "…", icon: Smartphone },
          { label: "Android", value: overview?.android ?? "…", icon: TabletSmartphone },
          { label: "Uninstalled / off", value: overview?.disabled ?? "…", icon: X },
        ].map((s, i) => (
          <div key={i} className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
            <p className="text-[10px] uppercase tracking-wider text-white/30 flex items-center gap-1.5">
              <s.icon className="w-3 h-3" /> {s.label}
            </p>
            <p className="text-lg font-bold text-white mt-0.5">{s.value}</p>
          </div>
        ))}
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Composer */}
        <div className="lg:col-span-2 space-y-4">
          <div className="space-y-1.5">
            <input value={title} onChange={(e) => setTitle(e.target.value.slice(0, TITLE_MAX))} placeholder="Title — e.g. Finals day is here! 🏆"
              className="w-full px-4 py-3 rounded-xl bg-white/[0.03] border border-white/10 text-white placeholder:text-white/30 font-medium focus:outline-none focus:border-white/25" data-testid="push-title" />
            <p className="text-[11px] text-white/30 px-1">{title.length}/{TITLE_MAX} — keep it under ~40 characters so it never gets cut off on the lock screen</p>
          </div>

          <div className="space-y-1.5">
            <textarea value={body} onChange={(e) => setBody(e.target.value.slice(0, BODY_MAX))} rows={4}
              placeholder="Message — e.g. U11 final kicks off 2pm at English Park. Standings and golden boot are live in the app."
              className="w-full px-4 py-3 rounded-xl bg-white/[0.03] border border-white/10 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-white/25 resize-y" data-testid="push-body" />
            <p className="text-[11px] text-white/30 px-1">{body.length}/{BODY_MAX} — phones show roughly the first 150 characters; front-load the important bit</p>
          </div>

          {/* Lock-screen preview */}
          <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
            <p className="text-[11px] uppercase tracking-wider text-white/30 font-semibold mb-3 flex items-center gap-1.5"><Eye className="w-3 h-3" /> Lock-screen preview</p>
            <div className="max-w-sm mx-auto rounded-2xl bg-white/[0.07] backdrop-blur border border-white/10 p-3 flex gap-3">
              <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-amber-400 to-amber-600 flex items-center justify-center flex-shrink-0">
                <BellRing className="w-5 h-5 text-black" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="text-sm font-semibold text-white truncate">{title.trim() || "Title"}</p>
                  <span className="text-[10px] text-white/40 flex-shrink-0">now</span>
                </div>
                <p className="text-xs text-white/70 mt-0.5 line-clamp-3">{body.trim() || "Your message will appear here"}</p>
              </div>
            </div>
          </div>

          {/* Test + send */}
          <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4 flex items-center gap-3 flex-wrap">
            <Select value={testDeviceId} onValueChange={setTestDeviceId}>
              <SelectTrigger className="premium-input text-white flex-1 min-w-[200px]" data-testid="push-test-device">
                <SelectValue placeholder={devices.length ? "Pick a device for a test…" : "No devices registered yet"} />
              </SelectTrigger>
              <SelectContent>
                {devices.map((d) => <SelectItem key={d.id} value={String(d.id)}>{deviceLabel(d)}</SelectItem>)}
              </SelectContent>
            </Select>
            <button onClick={() => testSend.mutate()} disabled={!canSend || !testDeviceId || testSend.isPending}
              className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg bg-white/10 text-white hover:bg-white/15 disabled:opacity-40" data-testid="push-test-send">
              {testSend.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5" />} Send test
            </button>
            <button onClick={() => setConfirmOpen(true)} disabled={!canSend || !overview?.total}
              className="flex items-center gap-2 text-sm font-semibold px-5 py-2 rounded-lg bg-amber-500 text-black hover:bg-amber-400 disabled:opacity-40" data-testid="push-send">
              <Send className="w-4 h-4" /> Send to {overview?.total ?? 0} devices
            </button>
          </div>
          <p className="text-[11px] text-white/30">
            Goes to every phone with the CIC Youth app installed (and notifications allowed). Device numbers grow as people install or update the app.
          </p>
        </div>

        {/* History */}
        <div className="space-y-3">
          <div className="text-[11px] uppercase tracking-wider text-white/30 font-semibold px-1">Recent sends</div>
          {campaigns.length === 0 ? (
            <div className="rounded-xl border border-white/5 bg-white/[0.02] p-6 text-center text-white/25 text-xs">
              <BellRing className="w-8 h-8 mx-auto mb-2" /> No notifications sent yet.
            </div>
          ) : campaigns.map((c) => (
            <div key={c.id} className="rounded-xl border border-white/5 bg-white/[0.02] p-3.5">
              <div className="text-sm font-medium text-white/85 truncate">{c.title}</div>
              <div className="text-xs text-white/40 truncate mt-0.5">{c.body}</div>
              <div className="flex items-center gap-2 mt-1.5 text-[11px] text-white/40">
                {c.status === "sending"
                  ? <><Loader2 className="w-3 h-3 text-amber-400 animate-spin" /> {c.sentCount ?? 0}/{c.recipientCount ?? 0} sent · sending…</>
                  : <><CheckCircle2 className="w-3 h-3 text-green-400" /> {c.sentCount ?? 0}/{c.recipientCount ?? 0} sent</>}
                {(c.failedCount ?? 0) > 0 && <span className="text-red-400">· {c.failedCount} failed</span>}
                <span className="ml-auto">{c.status === "sending" ? "" : c.sentAt ? new Date(c.sentAt).toLocaleDateString("en-NZ", { day: "numeric", month: "short" }) : "draft"}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Confirm modal */}
      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={() => setConfirmOpen(false)}>
          <div className="bg-[#0a0e1a] border border-amber-500/20 rounded-2xl w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-lg font-bold text-white">Send this notification?</h3>
              <button onClick={() => setConfirmOpen(false)} className="text-white/30 hover:text-white/60"><X className="w-5 h-5" /></button>
            </div>
            <p className="text-sm text-white/60 leading-relaxed">
              This pushes "<span className="text-white">{title.trim()}</span>" to <span className="text-amber-400 font-semibold">{overview?.total ?? 0} devices</span> — every phone with the CIC Youth app. This can't be undone.
            </p>
            <div className="flex items-start gap-2 mt-3 text-[11px] text-white/40 bg-white/[0.03] rounded-lg p-3">
              <AlertTriangle className="w-4 h-4 text-amber-400/70 flex-shrink-0 mt-0.5" /> Send a test to your own phone first if you haven't — there's no recall once it's out.
            </div>
            <div className="grid grid-cols-2 gap-3 mt-5">
              <button onClick={() => setConfirmOpen(false)} className="py-2.5 rounded-lg text-sm font-medium bg-white/10 text-white hover:bg-white/15">Cancel</button>
              <button onClick={() => send.mutate()} disabled={send.isPending}
                className="py-2.5 rounded-lg text-sm font-semibold bg-amber-500 text-black hover:bg-amber-400 disabled:opacity-50 flex items-center justify-center gap-2" data-testid="push-confirm-send">
                {send.isPending ? <><Loader2 className="w-4 h-4 animate-spin" /> Sending…</> : <>Send now</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
