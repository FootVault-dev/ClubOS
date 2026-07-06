import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  Radio, Video, Users, Copy, Check, Loader2, Plus, Trash2, Pencil, Image as ImageIcon,
  Download, Send, Globe, Clock, ExternalLink, RadioTower, X,
} from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";

const WATCH_URL = "https://watch.cicyouth.com";

type View = "pitches" | "scoreboard" | "recordings" | "viewers";
type Channel = { id: string; key: string; name: string; field_label: string | null; cloudflare_uid: string | null; status: "live" | "offline"; require_signed: boolean; sort_order: number };
type Recording = { videoUid: string; channelId: string; channelName: string; fieldLabel: string | null; start: string; durationSec: number; state: string; ready: boolean; thumbnail: string; name: string | null; thumbnailTimestampPct: number };
type Viewer = { email: string; name: string | null; phone: string | null; dial_code: string | null; phone_country: string | null; geo_country: string | null; created_at: string; last_seen_at: string; sessions: number; signup_source: string | null };
type Stats = { totalViewers: number; newLast24h: number; newLast7d: number; withPhone: number; watchEvents: number; viewersByCountry: { country: string; n: number }[]; watchByCountry: { country: string; n: number }[]; signupsByDay: { day: string; n: number }[] };

const panel = "rounded-xl border border-white/5 bg-white/[0.02]";
const fmtDur = (s: number) => (s < 0 ? "live" : `${Math.floor(s / 60)}m`);
const fmtDate = (s: string) => new Date(s).toLocaleDateString("en-NZ", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

export default function CicWatch() {
  const [view, setView] = useState<View>("pitches");
  const { data: chData } = useQuery<{ channels: Channel[] }>({ queryKey: ["/api/admin/cic/watch/channels"] });
  const liveCount = (chData?.channels ?? []).filter((c) => c.status === "live").length;

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            Watch
            {liveCount > 0 && (
              <span className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-red-400 bg-red-500/10 border border-red-500/30 rounded-full px-2.5 py-1">
                <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" /> {liveCount} live
              </span>
            )}
          </h1>
          <p className="text-sm text-white/40 mt-1">
            Run the live streaming + replay platform at{" "}
            <a href={WATCH_URL} target="_blank" rel="noreferrer" className="text-amber-300 hover:text-amber-200 inline-flex items-center gap-1">watch.cicyouth.com <ExternalLink className="w-3 h-3" /></a>
          </p>
        </div>
        <div className="inline-flex rounded-lg border border-white/5 bg-white/[0.02] p-0.5">
          {([["pitches", "Live Pitches", Radio], ["scoreboard", "Scoreboard", Clock], ["recordings", "Recordings", Video], ["viewers", "Viewers", Users]] as const).map(([v, label, Icon]) => (
            <button key={v} onClick={() => setView(v)} data-testid={`watch-view-${v}`}
              className={`text-xs font-medium px-3 py-1.5 rounded-md transition-colors inline-flex items-center gap-1.5 ${view === v ? "bg-amber-500/15 text-amber-300" : "text-white/40 hover:text-white/70"}`}>
              <Icon className="w-3.5 h-3.5" /> {label}
            </button>
          ))}
        </div>
      </div>

      {view === "pitches" && <PitchesView />}
      {view === "scoreboard" && <ScoreboardView />}
      {view === "recordings" && <RecordingsView />}
      {view === "viewers" && <ViewersView />}
    </div>
  );
}

// ── Small bits ────────────────────────────────────────────────────────────────
function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-white/30 mb-1">{label}</div>
      <div className="flex items-center gap-2">
        <code className="flex-1 truncate rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-[12px] text-amber-300">{value}</code>
        <button onClick={async () => { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
          className="shrink-0 rounded-lg border border-white/10 px-3 py-2 text-white/70 hover:text-white hover:border-white/25">
          {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
        </button>
      </div>
    </div>
  );
}

// ── Live pitches ───────────────────────────────────────────────────────────────
function PitchesView() {
  const { toast } = useToast();
  const { data, isLoading } = useQuery<{ channels: Channel[] }>({ queryKey: ["/api/admin/cic/watch/channels"] });
  const channels = data?.channels ?? [];
  const [creds, setCreds] = useState<{ name: string; rtmpsUrl: string; streamKey: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ key: "", name: "", field_label: "" });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["/api/admin/cic/watch/channels"] });
  const post = (body: any) => apiRequest("POST", "/api/admin/cic/watch/channels", body).then((r) => r.json());

  const act = useMutation({
    mutationFn: post,
    onSuccess: (r: any, body: any) => {
      if (body.action === "create-live-input" && r.input) {
        const ch = channels.find((c) => c.id === body.id);
        setCreds({ name: ch?.name ?? "New pitch", rtmpsUrl: r.input.rtmpsUrl, streamKey: r.input.streamKey });
      }
      if (body.action === "reveal-creds" && r.creds) {
        const ch = channels.find((c) => c.id === body.id);
        setCreds({ name: ch?.name ?? "Pitch", rtmpsUrl: r.creds.rtmpsUrl, streamKey: r.creds.streamKey });
      }
      refresh();
    },
    onError: (e: any) => toast({ title: "Action failed", description: e.message, variant: "destructive" }),
  });

  return (
    <>
      <div className="flex items-center justify-between">
        <p className="text-sm text-white/40">One channel per pitch/camera. Create a Cloudflare input, paste the RTMP details into Veo, then flip it live.</p>
        <button onClick={() => setAdding((a) => !a)} className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg bg-white/10 text-white hover:bg-white/15" data-testid="watch-add-pitch">
          <Plus className="w-3.5 h-3.5" /> Add pitch
        </button>
      </div>

      {adding && (
        <div className={`${panel} p-4 grid sm:grid-cols-4 gap-3`}>
          <input className="premium-input text-white text-sm" placeholder="Key (e.g. s3)" value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} />
          <input className="premium-input text-white text-sm" placeholder="Name (e.g. S3)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input className="premium-input text-white text-sm" placeholder="Field label (matches fixtures)" value={form.field_label} onChange={(e) => setForm({ ...form, field_label: e.target.value })} />
          <button disabled={!form.key.trim() || !form.name.trim() || act.isPending}
            onClick={async () => { await act.mutateAsync({ action: "upsert", channel: { ...form, field_label: form.field_label || form.name } }); setAdding(false); setForm({ key: "", name: "", field_label: "" }); }}
            className="text-sm font-semibold px-4 py-2 rounded-lg bg-amber-500 text-black hover:bg-amber-400 disabled:opacity-40">Save</button>
        </div>
      )}

      {isLoading ? (
        <div className="text-center py-12 text-white/20 text-sm">Loading pitches…</div>
      ) : channels.length === 0 ? (
        <div className={`${panel} p-10 text-center text-white/25 text-sm`}><Radio className="w-10 h-10 mx-auto mb-3" />No pitches yet — add one above.</div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {channels.map((c) => (
            <div key={c.id} className={`${panel} p-4`} data-testid={`watch-pitch-${c.key}`}>
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-white font-semibold flex items-center gap-2">
                    {c.name}
                    {c.status === "live"
                      ? <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase text-red-400 bg-red-500/10 rounded px-1.5 py-0.5"><span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />Live</span>
                      : <span className="text-[10px] font-bold uppercase text-white/40 bg-white/5 rounded px-1.5 py-0.5">Offline</span>}
                  </div>
                  <div className="text-[11px] text-white/40 mt-0.5">field “{c.field_label ?? "—"}” · {c.cloudflare_uid ? "input ready" : "no input"}</div>
                </div>
              </div>
              <div className="mt-4 flex items-center gap-2 flex-wrap">
                <button disabled={act.isPending} onClick={() => act.mutate({ action: "status", id: c.id, status: c.status === "live" ? "offline" : "live" })}
                  className={`text-xs font-bold uppercase tracking-wide px-3 py-1.5 rounded-lg ${c.status === "live" ? "border border-white/20 text-white/80 hover:border-white/40" : "bg-red-500 text-white hover:bg-red-400"}`}>
                  {c.status === "live" ? "Set offline" : "Go live"}
                </button>
                <button disabled={act.isPending} onClick={() => act.mutate(c.cloudflare_uid ? { action: "reveal-creds", id: c.id } : { action: "create-live-input", id: c.id })}
                  className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-amber-500/40 bg-amber-500/[0.08] text-amber-300 hover:bg-amber-500/15">
                  <RadioTower className="w-3.5 h-3.5" /> {c.cloudflare_uid ? "Veo creds" : "Create input"}
                </button>
                <button disabled={act.isPending} onClick={() => { if (confirm(`Delete pitch “${c.name}”?`)) act.mutate({ action: "delete", id: c.id }); }}
                  className="ml-auto text-white/40 hover:text-red-400"><Trash2 className="w-4 h-4" /></button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={!!creds} onOpenChange={(o) => !o && setCreds(null)}>
        <DialogContent className="bg-[#0a0e1a] border-amber-500/20 text-white">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><RadioTower className="w-4 h-4 text-amber-400" /> Veo custom destination — {creds?.name}</DialogTitle>
            <DialogDescription className="text-white/50">In Veo: Veo Live → Add streaming destination → Custom, paste these, then Go Live in the camera app.</DialogDescription>
          </DialogHeader>
          {creds && <div className="space-y-3"><CopyRow label="RTMP URL" value={creds.rtmpsUrl} /><CopyRow label="Stream key" value={creds.streamKey} /></div>}
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── Recordings ──────────────────────────────────────────────────────────────────
function RecordingsView() {
  const { toast } = useToast();
  const { data, isLoading } = useQuery<{ recordings: Recording[] }>({ queryKey: ["/api/admin/cic/watch/recordings"] });
  const recordings = data?.recordings ?? [];
  const [edit, setEdit] = useState<Recording | null>(null);
  const [name, setName] = useState("");
  const [pct, setPct] = useState(0);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["/api/admin/cic/watch/recordings"] });
  const post = (body: any) => apiRequest("POST", "/api/admin/cic/watch/recordings", body).then((r) => r.json());
  const save = useMutation({
    mutationFn: post,
    onSuccess: () => { setEdit(null); refresh(); toast({ title: "Saved" }); },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const openEdit = (r: Recording) => { setEdit(r); setName(r.name ?? `${r.channelName} — ${fmtDate(r.start)}`); setPct(Math.round((r.thumbnailTimestampPct || 0) * 100)); };

  return (
    <>
      <p className="text-sm text-white/40">Every broadcast is auto-recorded and becomes an on-demand replay on the platform. Rename, set the thumbnail frame, or remove any recording.</p>
      {isLoading ? (
        <div className="text-center py-12 text-white/20 text-sm">Loading recordings…</div>
      ) : recordings.length === 0 ? (
        <div className={`${panel} p-10 text-center text-white/25 text-sm`}><Video className="w-10 h-10 mx-auto mb-3" />No recordings yet — they appear here after a pitch has streamed.</div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {recordings.map((r) => (
            <div key={r.videoUid} className={`${panel} overflow-hidden`} data-testid={`watch-recording-${r.videoUid}`}>
              <div className="relative aspect-video bg-black">
                <img src={r.thumbnail} alt="" className="w-full h-full object-cover" onError={(e) => ((e.currentTarget as HTMLImageElement).style.opacity = "0")} />
                <span className="absolute bottom-2 right-2 text-[10px] font-bold text-white bg-black/70 rounded px-1.5 py-0.5 inline-flex items-center gap-1"><Clock className="w-3 h-3" />{fmtDur(r.durationSec)}</span>
                {!r.ready && <span className="absolute top-2 left-2 text-[10px] font-bold uppercase text-amber-300 bg-black/70 rounded px-1.5 py-0.5">Processing…</span>}
              </div>
              <div className="p-3">
                <div className="text-sm font-medium text-white/90 truncate">{r.name || `${r.channelName} — ${fmtDate(r.start)}`}</div>
                <div className="text-[11px] text-white/40 mt-0.5">{r.channelName} · {fmtDate(r.start)}</div>
                <div className="mt-3 flex items-center gap-2">
                  <button onClick={() => openEdit(r)} className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-white/10 text-white hover:bg-white/15"><Pencil className="w-3.5 h-3.5" /> Manage</button>
                  <a href={`${WATCH_URL}/replay/${r.videoUid}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-white/10 text-white/70 hover:text-white"><ExternalLink className="w-3.5 h-3.5" /> View</a>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)}>
        <DialogContent className="bg-[#0a0e1a] border-white/10 text-white">
          <DialogHeader><DialogTitle>Manage recording</DialogTitle></DialogHeader>
          {edit && (
            <div className="space-y-4">
              <img src={`${edit.thumbnail}${edit.thumbnail.includes("?") ? "&" : "?"}t=${pct / 100}`} alt="" className="w-full aspect-video object-cover rounded-lg bg-black" />
              <div>
                <div className="text-[11px] uppercase tracking-wider text-white/30 mb-1">Title</div>
                <input className="premium-input text-white text-sm w-full" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wider text-white/30 mb-1 flex items-center gap-1.5"><ImageIcon className="w-3.5 h-3.5" /> Thumbnail frame — {pct}% through</div>
                <input type="range" min={0} max={100} value={pct} onChange={(e) => setPct(Number(e.target.value))} className="w-full accent-amber-500" />
              </div>
              <DialogFooter className="flex-row justify-between sm:justify-between gap-2">
                <button onClick={() => { if (confirm("Delete this recording permanently?")) save.mutate({ action: "delete", videoUid: edit.videoUid }); }}
                  className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg border border-white/10 text-white/50 hover:border-red-500/50 hover:text-red-400"><Trash2 className="w-3.5 h-3.5" /> Delete</button>
                <div className="flex items-center gap-2">
                  <button onClick={() => setEdit(null)} className="text-xs font-medium px-3 py-2 rounded-lg bg-white/10 text-white">Cancel</button>
                  <button disabled={save.isPending}
                    onClick={async () => { await save.mutateAsync({ action: "rename", videoUid: edit.videoUid, name }); await save.mutateAsync({ action: "thumbnail", videoUid: edit.videoUid, pct: pct / 100 }); }}
                    className="inline-flex items-center gap-1.5 text-sm font-semibold px-4 py-2 rounded-lg bg-amber-500 text-black hover:bg-amber-400 disabled:opacity-50">
                    {save.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Save"}
                  </button>
                </div>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── Viewers & analytics ─────────────────────────────────────────────────────────
function ViewersView() {
  const { toast } = useToast();
  const { data, isLoading } = useQuery<{ stats: Stats; recent: Viewer[] }>({ queryKey: ["/api/admin/cic/watch/viewers"] });
  const stats = data?.stats;
  const recent = data?.recent ?? [];

  const pushMailer = useMutation({
    mutationFn: () => apiRequest("POST", "/api/admin/cic/watch/push-to-mailer", {}).then((r) => r.json()),
    onSuccess: (r: { added: number; alreadyInMailer: number }) => toast({ title: `Added ${r.added} to the CIC Mailer`, description: `${r.alreadyInMailer} were already there. Find them under Mailer → CIC 7's.` }),
    onError: (e: any) => toast({ title: "Push failed", description: e.message, variant: "destructive" }),
  });

  const exportCsv = async () => {
    const res = await apiRequest("GET", "/api/admin/cic/watch/viewers/export");
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "cic-watch-viewers.csv"; a.click(); URL.revokeObjectURL(a.href);
  };

  const maxCountry = Math.max(1, ...(stats?.viewersByCountry ?? []).map((c) => c.n));
  const maxDay = Math.max(1, ...(stats?.signupsByDay ?? []).map((d) => d.n));

  if (isLoading) return <div className="text-center py-12 text-white/20 text-sm">Loading analytics…</div>;

  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {[
          { label: "Total viewers", value: stats?.totalViewers ?? 0 },
          { label: "New · 24h", value: stats?.newLast24h ?? 0 },
          { label: "New · 7 days", value: stats?.newLast7d ?? 0 },
          { label: "With phone", value: stats?.withPhone ?? 0 },
          { label: "Watch sessions", value: stats?.watchEvents ?? 0 },
        ].map((s, i) => (
          <div key={i} className={`${panel} p-4`}>
            <p className="text-[10px] uppercase tracking-wider text-white/30">{s.label}</p>
            <p className="text-2xl font-bold text-white mt-0.5">{s.value.toLocaleString()}</p>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <button onClick={exportCsv} className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg bg-white/10 text-white hover:bg-white/15" data-testid="watch-export"><Download className="w-3.5 h-3.5" /> Export CSV</button>
        <button onClick={() => pushMailer.mutate()} disabled={pushMailer.isPending} className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-amber-500 text-black hover:bg-amber-400 disabled:opacity-50" data-testid="watch-push-mailer">
          {pushMailer.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />} Add all to CIC Mailer
        </button>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {/* Country breakdown */}
        <div className={`${panel} p-4`}>
          <div className="text-[11px] uppercase tracking-wider text-white/30 font-semibold mb-3 flex items-center gap-1.5"><Globe className="w-3.5 h-3.5" /> Watching from</div>
          <div className="space-y-2">
            {(stats?.viewersByCountry ?? []).slice(0, 10).map((c) => (
              <div key={c.country} className="flex items-center gap-3">
                <span className="w-8 text-xs font-bold text-white/70">{c.country}</span>
                <div className="flex-1 h-2 rounded-full bg-white/5 overflow-hidden"><div className="h-full bg-amber-500/70 rounded-full" style={{ width: `${(c.n / maxCountry) * 100}%` }} /></div>
                <span className="w-10 text-right text-xs text-white/50 tabular-nums">{c.n}</span>
              </div>
            ))}
            {!stats?.viewersByCountry?.length && <p className="text-sm text-white/25">No data yet.</p>}
          </div>
        </div>
        {/* Signups by day */}
        <div className={`${panel} p-4`}>
          <div className="text-[11px] uppercase tracking-wider text-white/30 font-semibold mb-3">Sign-ups · last 30 days</div>
          <div className="flex items-end gap-1 h-28">
            {(stats?.signupsByDay ?? []).map((d) => (
              <div key={d.day} className="flex-1 bg-amber-500/60 hover:bg-amber-400 rounded-t transition-colors" style={{ height: `${(d.n / maxDay) * 100}%` }} title={`${d.day}: ${d.n}`} />
            ))}
            {!stats?.signupsByDay?.length && <p className="text-sm text-white/25">No data yet.</p>}
          </div>
        </div>
      </div>

      {/* Recent sign-ups */}
      <div className={`${panel} overflow-x-auto`}>
        <div className="px-4 py-3 text-[11px] uppercase tracking-wider text-white/30 font-semibold border-b border-white/5">Recent sign-ups</div>
        <table className="w-full min-w-[720px]">
          <thead><tr className="border-b border-white/5">{["Name", "Email", "Phone", "From", "Signed up", "Sessions"].map((h) => <th key={h} className="text-left text-[10px] text-white/30 uppercase px-4 py-2 font-semibold">{h}</th>)}</tr></thead>
          <tbody>
            {recent.map((v, i) => (
              <tr key={v.email + i} className="border-b border-white/[0.02]" data-testid={`watch-viewer-${i}`}>
                <td className="px-4 py-2.5 text-sm text-white/80 font-medium">{v.name || "—"}</td>
                <td className="px-4 py-2.5 text-sm text-white/60">{v.email}</td>
                <td className="px-4 py-2.5 text-sm text-white/50">{v.phone ? `${v.dial_code ?? ""} ${v.phone}` : "—"}</td>
                <td className="px-4 py-2.5 text-sm text-white/50">{v.geo_country || "—"}</td>
                <td className="px-4 py-2.5 text-sm text-white/40">{fmtDate(v.created_at)}</td>
                <td className="px-4 py-2.5 text-sm text-white/40 tabular-nums">{v.sessions}</td>
              </tr>
            ))}
            {recent.length === 0 && <tr><td colSpan={6} className="px-4 py-10 text-center text-white/25 text-sm">No sign-ups yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ── Scoreboard overlay control ──────────────────────────────────────────────────
type Overlay = { channel_id: string; visible: boolean; home_name: string; home_abbr: string; home_color: string; away_name: string; away_abbr: string; away_color: string; home_score: number; away_score: number; period: string; clock_running: boolean; clock_base_ms: number; clock_started_at: string | null };
function ovElapsed(o?: Overlay | null): number { if (!o) return 0; let ms = Number(o.clock_base_ms) || 0; if (o.clock_running && o.clock_started_at) ms += Date.now() - new Date(o.clock_started_at).getTime(); return Math.max(0, ms); }
function ovClock(ms: number): string { const t = Math.floor(ms / 1000); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`; }
function initials(s: string): string { return (s || "").replace(/[^a-zA-Z ]/g, "").split(/\s+/).map((w) => w[0]).join("").toUpperCase().slice(0, 4); }

function ScoreboardView() {
  const { data } = useQuery<{ channels: Channel[] }>({ queryKey: ["/api/admin/cic/watch/channels"] });
  const channels = data?.channels ?? [];
  return (
    <>
      <p className="text-sm text-white/40">The broadcast scoreboard shown top-left of each live stream — teams, score and match clock. Control it live from anywhere; toggle it on to put it on screen.</p>
      {channels.length === 0
        ? <div className={`${panel} p-10 text-center text-white/25 text-sm`}>Add a pitch first, under Live Pitches.</div>
        : <div className="grid gap-4 lg:grid-cols-2">{channels.map((c) => <ChannelOverlayCard key={c.id} channel={c} />)}</div>}
    </>
  );
}

function ChannelOverlayCard({ channel }: { channel: Channel }) {
  const { toast } = useToast();
  const qk = ["/api/admin/cic/watch/overlay", channel.id];
  const { data } = useQuery<{ overlay: Overlay }>({ queryKey: qk, queryFn: () => apiRequest("GET", `/api/admin/cic/watch/overlay?channel=${channel.id}`).then((r) => r.json()) });
  const ov = data?.overlay;

  const [teams, setTeams] = useState({ home_name: "", home_abbr: "", home_color: "#c9a43e", away_name: "", away_abbr: "", away_color: "#3b6fb3", period: "" });
  useEffect(() => { if (ov) setTeams({ home_name: ov.home_name, home_abbr: ov.home_abbr, home_color: ov.home_color, away_name: ov.away_name, away_abbr: ov.away_abbr, away_color: ov.away_color, period: ov.period }); }, [channel.id, !!ov]); // eslint-disable-line

  const [, force] = useState(0);
  useEffect(() => { if (!ov?.clock_running) return; const i = setInterval(() => force((n) => n + 1), 1000); return () => clearInterval(i); }, [ov?.clock_running]);

  const save = useMutation({
    mutationFn: (body: any) => apiRequest("POST", "/api/admin/cic/watch/overlay", { channelId: channel.id, ...body }).then((r) => r.json()),
    onSuccess: (r: { overlay: Overlay }) => queryClient.setQueryData(qk, { overlay: r.overlay }),
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });
  const setScore = (side: "home" | "away", d: number) => { const cur = side === "home" ? (ov?.home_score ?? 0) : (ov?.away_score ?? 0); save.mutate({ overlay: { [`${side}_score`]: Math.max(0, cur + d) } }); };

  async function syncGame() {
    try {
      const ts: any[] = await fetch(`/api/public/tournament/tournaments?orgId=5`).then((r) => r.json());
      const now = new Date(); const p = (n: number) => String(n).padStart(2, "0"); const iso = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
      const per = await Promise.all(ts.map((t) => Promise.all([
        fetch(`/api/public/tournament/tournaments/${t.id}/games?stage=group`).then((r) => r.json()).catch(() => []),
        fetch(`/api/public/tournament/tournaments/${t.id}/games?stage=knockout`).then((r) => r.json()).catch(() => []),
      ]).then(([a, b]) => [...a, ...b])));
      const games = per.flat();
      const fl = (channel.field_label || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const num = (channel.field_label || "").match(/(\d+)\s*$/)?.[1];
      const onField = games.filter((g: any) => { const gf = (g.field || "").toLowerCase().replace(/[^a-z0-9]/g, ""); const gn = (g.field || "").match(/(\d+)\s*$/)?.[1]; return gf === fl || (!!num && num === gn); });
      const g = onField.find((x: any) => x.status === "in_progress") || onField.filter((x: any) => x.gameDate === iso && x.status === "scheduled").sort((a: any, b: any) => (a.startTime || "").localeCompare(b.startTime || ""))[0];
      if (!g) { toast({ title: "No live game on this pitch right now" }); return; }
      save.mutate({ overlay: { home_name: g.homeTeamName || "", home_abbr: initials(g.homeTeamName || ""), away_name: g.awayTeamName || "", away_abbr: initials(g.awayTeamName || ""), home_score: g.homeScore ?? 0, away_score: g.awayScore ?? 0 } });
      toast({ title: `Synced ${g.homeTeamName} v ${g.awayTeamName}` });
    } catch (e: any) { toast({ title: "Sync failed", description: e.message, variant: "destructive" }); }
  }

  const elapsed = ovElapsed(ov);

  return (
    <div className={`${panel} p-4 space-y-4`} data-testid={`watch-overlay-${channel.key}`}>
      <div className="flex items-center justify-between">
        <div className="font-semibold text-white flex items-center gap-2">{channel.name}{channel.status === "live" && <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />}</div>
        <button onClick={() => save.mutate({ overlay: { visible: !ov?.visible } })} data-testid={`overlay-toggle-${channel.key}`}
          className={`text-xs font-bold uppercase tracking-wide px-3 py-1.5 rounded-lg ${ov?.visible ? "bg-green-500/15 text-green-300 border border-green-500/40" : "border border-white/15 text-white/50"}`}>
          {ov?.visible ? "● On screen" : "Off"}
        </button>
      </div>

      {/* live preview of what's on the broadcast */}
      <div className="rounded-lg bg-black/60 p-3 flex items-center justify-center">
        <div className="flex items-stretch overflow-hidden rounded text-white text-xs">
          <span className="w-1" style={{ background: teams.home_color }} />
          <span className="bg-black/80 px-2 py-1 flex items-center gap-1.5"><b>{teams.home_abbr || initials(teams.home_name) || "HOME"}</b> <span className="font-black tabular-nums">{ov?.home_score ?? 0}</span></span>
          <span className="bg-black/80 px-1 py-1 text-white/30">–</span>
          <span className="bg-black/80 px-2 py-1 flex items-center gap-1.5"><span className="font-black tabular-nums">{ov?.away_score ?? 0}</span> <b>{teams.away_abbr || initials(teams.away_name) || "AWAY"}</b></span>
          <span className="w-1" style={{ background: teams.away_color }} />
          <span className="bg-amber-500 text-black px-2 py-1 font-bold tabular-nums">{ovClock(elapsed)}{teams.period ? ` ${teams.period}` : ""}</span>
        </div>
      </div>

      {/* teams + colors + score */}
      <div className="grid grid-cols-2 gap-3">
        {(["home", "away"] as const).map((side) => (
          <div key={side} className="space-y-2">
            <div className="text-[10px] uppercase tracking-wider text-white/30">{side} team</div>
            <div className="flex gap-2">
              <input type="color" value={(teams as any)[`${side}_color`]} onChange={(e) => setTeams({ ...teams, [`${side}_color`]: e.target.value })} className="h-9 w-9 rounded bg-transparent border border-white/10 p-0.5" />
              <input className="premium-input text-white text-sm flex-1" placeholder="Team name" value={(teams as any)[`${side}_name`]} onChange={(e) => setTeams({ ...teams, [`${side}_name`]: e.target.value })} />
            </div>
            <input className="premium-input text-white text-sm w-full" placeholder="Abbr" maxLength={4} value={(teams as any)[`${side}_abbr`]} onChange={(e) => setTeams({ ...teams, [`${side}_abbr`]: e.target.value.toUpperCase() })} />
            <div className="flex items-center justify-center gap-2 pt-1">
              <button onClick={() => setScore(side, -1)} data-testid={`score-${side}-minus`} className="w-8 h-8 rounded-lg bg-white/10 text-white text-lg leading-none">−</button>
              <span className="w-8 text-center text-2xl font-black text-white tabular-nums">{side === "home" ? (ov?.home_score ?? 0) : (ov?.away_score ?? 0)}</span>
              <button onClick={() => setScore(side, 1)} data-testid={`score-${side}-plus`} className="w-8 h-8 rounded-lg bg-amber-500 text-black text-lg leading-none">+</button>
            </div>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <button onClick={syncGame} className="text-xs font-medium px-3 py-2 rounded-lg bg-white/10 text-white hover:bg-white/15">Sync from live game</button>
        <button onClick={() => save.mutate({ overlay: { home_name: teams.home_name, home_abbr: teams.home_abbr, home_color: teams.home_color, away_name: teams.away_name, away_abbr: teams.away_abbr, away_color: teams.away_color, period: teams.period } })}
          className="text-xs font-semibold px-3 py-2 rounded-lg bg-amber-500 text-black hover:bg-amber-400">Save teams</button>
      </div>

      {/* clock */}
      <div className="border-t border-white/5 pt-3">
        <div className="flex items-center justify-between mb-2">
          <div className="text-[10px] uppercase tracking-wider text-white/30">Match clock</div>
          <div className="text-lg font-black text-white tabular-nums">{ovClock(elapsed)}</div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {ov?.clock_running
            ? <button onClick={() => save.mutate({ action: "clock", op: "pause" })} data-testid={`clock-pause-${channel.key}`} className="text-xs font-bold px-3 py-2 rounded-lg bg-white/15 text-white">Pause</button>
            : <button onClick={() => save.mutate({ action: "clock", op: "start" })} data-testid={`clock-start-${channel.key}`} className="text-xs font-bold px-3 py-2 rounded-lg bg-green-500 text-black">Start</button>}
          <button onClick={() => save.mutate({ action: "clock", op: "reset" })} className="text-xs font-medium px-3 py-2 rounded-lg border border-white/15 text-white/60">Reset</button>
          {[0, 45].map((m) => <button key={m} onClick={() => save.mutate({ action: "clock", op: "set", minutes: m })} className="text-xs px-2 py-2 rounded-lg bg-white/5 text-white/60">{m}'</button>)}
          <input className="premium-input text-white text-sm w-32" placeholder="Period (1st Half)" value={teams.period} onChange={(e) => setTeams({ ...teams, period: e.target.value })} onBlur={() => save.mutate({ overlay: { period: teams.period } })} />
        </div>
      </div>
    </div>
  );
}
