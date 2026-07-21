// ── Videos — per-video page: player, share link, trim, insights ─────────────
// Trim uses Cloudflare Stream's clip API and swaps the asset IN PLACE, so the
// share link keeps working after a trim (better than Loom, which paywalled
// trim entirely). Insights exclude staff opens — the house analytics rule.
import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useRoute, useLocation } from "wouter";
import Hls from "hls.js";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { formatClock } from "@/lib/screen-recorder";
import { formatBytes } from "@/lib/video-upload";
import {
  ArrowLeft, Link2, Loader2, Scissors, Captions, Download, Trash2, Eye,
  Users, BarChart3, AlertTriangle, ExternalLink, Check,
} from "lucide-react";

interface VideoDetail {
  id: number;
  token: string;
  title: string;
  description: string | null;
  status: string;
  source: string;
  visibility: string;
  allowDownload: boolean;
  allowComments: boolean;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
  thumbnailUrl: string | null;
  playbackUrl: string | null;
  downloadUrl: string | null;
  captionsStatus: string | null;
  viewCount: number;
  trimming: boolean;
  ownerName: string;
  mine: boolean;
  createdAt: string;
}

interface Insights {
  views: number;
  uniques: number;
  staffViews: number;
  avgWatchPercent: number | null;
  viewers: Array<{ label: string; bestPercent: number; lastSeen: string; device: string | null }>;
  byDay: Array<{ day: string; views: number }>;
  comments: Array<{
    id: number;
    authorName: string | null;
    body: string | null;
    emoji: string | null;
    atSeconds: number | null;
    isStaff: boolean;
    createdAt: string;
  }>;
}

function usePlayer(playbackUrl: string | null) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = videoRef.current;
    if (!el || !playbackUrl) return;
    if (el.canPlayType("application/vnd.apple.mpegurl")) {
      el.src = playbackUrl;
      return;
    }
    const hls = new Hls({ maxBufferLength: 30 });
    hls.loadSource(playbackUrl);
    hls.attachMedia(el);
    return () => hls.destroy();
  }, [playbackUrl]);
  return videoRef;
}

export default function GroupVideoDetail() {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [, params] = useRoute("/admin/videos/:id");
  const id = params?.id;

  const { data: v, isLoading } = useQuery<VideoDetail>({
    queryKey: [`/api/admin/videos/${id}`],
    enabled: !!id,
    refetchInterval: (q) => {
      const d = q.state.data;
      return d && (d.status !== "ready" || d.trimming || d.captionsStatus === "inprogress") ? 2500 : false;
    },
  });
  const { data: insights } = useQuery<Insights>({
    queryKey: [`/api/admin/videos/${id}/insights`],
    enabled: !!id && v?.status === "ready",
  });

  const videoRef = usePlayer(v?.status === "ready" ? v.playbackUrl : null);

  const [copied, setCopied] = useState(false);
  const [trimOpen, setTrimOpen] = useState(false);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const dur = v?.durationSeconds || 0;

  useEffect(() => {
    if (dur && trimEnd === 0) setTrimEnd(Math.floor(dur));
  }, [dur, trimEnd]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: [`/api/admin/videos/${id}`] });
    queryClient.invalidateQueries({ queryKey: [`/api/admin/videos/${id}/insights`] });
  };

  const patchMut = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiRequest("PATCH", `/api/admin/videos/${id}`, body),
    onSuccess: invalidate,
    onError: (e: Error) => toast({ title: "Couldn't save", description: e.message, variant: "destructive" }),
  });
  const trimMut = useMutation({
    mutationFn: () => apiRequest("POST", `/api/admin/videos/${id}/trim`, { startSeconds: trimStart, endSeconds: trimEnd }),
    onSuccess: () => {
      setTrimOpen(false);
      invalidate();
      toast({ title: "Trimming…", description: "The share link stays the same — it plays the trimmed version once ready." });
    },
    onError: (e: Error) => toast({ title: "Trim failed", description: e.message, variant: "destructive" }),
  });
  const captionsMut = useMutation({
    mutationFn: () => apiRequest("POST", `/api/admin/videos/${id}/captions`),
    onSuccess: () => {
      invalidate();
      toast({ title: "Generating captions", description: "English captions will appear in the player when ready." });
    },
    onError: (e: Error) => toast({ title: "Captions failed", description: e.message, variant: "destructive" }),
  });
  const deleteMut = useMutation({
    mutationFn: (forever: boolean) => apiRequest("DELETE", `/api/admin/videos/${id}?forever=${forever ? "1" : "0"}`),
    onSuccess: () => {
      toast({ title: "Deleted" });
      navigate("/admin/videos");
    },
    onError: (e: Error) => toast({ title: "Delete failed", description: e.message, variant: "destructive" }),
  });

  async function fetchDownload() {
    setDownloadBusy(true);
    try {
      for (let i = 0; i < 40; i++) {
        const res = await apiRequest("POST", `/api/admin/videos/${id}/download`);
        const body = await res.json();
        if (body.status === "ready" && body.url) {
          window.open(body.url, "_blank");
          invalidate();
          return;
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
      toast({ title: "Still preparing", description: "The MP4 is taking a while — try again shortly." });
    } catch (e) {
      toast({ title: "Download failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setDownloadBusy(false);
    }
  }

  if (isLoading || !v) {
    return (
      <div className="flex items-center justify-center py-32 text-white/40">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
      </div>
    );
  }

  const shareUrl = `${window.location.origin}/v/${v.token}`;
  const selectCls =
    "rounded-lg bg-white/[0.04] border border-white/10 px-2.5 py-1.5 text-xs text-white/80 focus:outline-none focus:border-amber-500/50 cursor-pointer";

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto">
      <button onClick={() => navigate("/admin/videos")} className="inline-flex items-center gap-1.5 text-sm text-white/40 hover:text-white/70 mb-4">
        <ArrowLeft className="w-4 h-4" /> Back to Videos
      </button>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: player + share + trim */}
        <div className="lg:col-span-2">
          <input
            defaultValue={v.title}
            onBlur={(e) => {
              const t = e.target.value.trim();
              if (t && t !== v.title) patchMut.mutate({ title: t });
            }}
            disabled={!v.mine}
            className="w-full bg-transparent text-lg font-bold text-white/95 focus:outline-none border-b border-transparent focus:border-amber-500/40 mb-1"
          />
          <div className="text-[11px] text-white/35 mb-3">
            {v.ownerName} · {new Date(v.createdAt).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" })}
            {dur ? <> · {formatClock(dur)}</> : null}
            {v.sizeBytes ? <> · {formatBytes(v.sizeBytes)}</> : null}
          </div>

          {v.status === "ready" ? (
            <video ref={videoRef} controls playsInline poster={v.thumbnailUrl || undefined} className="w-full rounded-xl border border-white/10 bg-black" />
          ) : v.status === "error" ? (
            <div className="aspect-video rounded-xl border border-red-500/30 bg-red-500/5 flex flex-col items-center justify-center gap-2 text-red-300">
              <AlertTriangle className="w-8 h-8" />
              <div className="text-sm font-semibold">Processing failed</div>
              <p className="text-xs text-white/40">Delete this video and record again.</p>
            </div>
          ) : (
            <div className="aspect-video rounded-xl border border-white/10 bg-black/40 flex flex-col items-center justify-center gap-3 text-white/50">
              <Loader2 className="w-8 h-8 animate-spin" />
              <div className="text-sm">{v.trimming ? "Applying your trim…" : "Processing — usually under a minute"}</div>
            </div>
          )}

          {/* Share bar */}
          <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.02] p-3 flex flex-wrap items-center gap-2">
            <code className="text-xs text-amber-200/90 bg-black/30 rounded px-2 py-1.5 truncate max-w-full flex-1 min-w-0">{shareUrl}</code>
            <button
              onClick={() => {
                navigator.clipboard.writeText(shareUrl);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500/90 hover:bg-amber-500 px-3 py-1.5 text-xs font-bold text-black"
            >
              {copied ? <Check className="w-3.5 h-3.5" /> : <Link2 className="w-3.5 h-3.5" />} {copied ? "Copied" : "Copy link"}
            </button>
            <a href={shareUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/70 hover:bg-white/[0.06]">
              <ExternalLink className="w-3.5 h-3.5" /> Open
            </a>
          </div>

          {/* Trim */}
          {v.status === "ready" && v.mine && (
            <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.02] p-4">
              <button onClick={() => setTrimOpen((o) => !o)} className="inline-flex items-center gap-2 text-sm font-semibold text-white/85">
                <Scissors className="w-4 h-4 text-amber-300" /> Trim video
              </button>
              {trimOpen && (
                <div className="mt-4 space-y-3">
                  {[
                    { label: "Start", val: trimStart, set: (n: number) => setTrimStart(Math.min(n, trimEnd - 1)) },
                    { label: "End", val: trimEnd, set: (n: number) => setTrimEnd(Math.max(n, trimStart + 1)) },
                  ].map((h) => (
                    <div key={h.label} className="flex items-center gap-3">
                      <span className="text-xs text-white/40 w-10">{h.label}</span>
                      <input
                        type="range"
                        min={0}
                        max={Math.floor(dur)}
                        value={h.val}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          h.set(n);
                          if (videoRef.current) videoRef.current.currentTime = n;
                        }}
                        className="flex-1 accent-amber-400"
                      />
                      <span className="text-xs text-white/70 tabular-nums w-14 text-right">{formatClock(h.val)}</span>
                    </div>
                  ))}
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-white/40">
                      Keeps {formatClock(Math.max(0, trimEnd - trimStart))} · the old version is deleted (frees storage)
                    </span>
                    <button
                      onClick={() => trimMut.mutate()}
                      disabled={trimMut.isPending}
                      className="rounded-lg bg-amber-500/90 hover:bg-amber-500 px-4 py-2 text-xs font-bold text-black disabled:opacity-50"
                    >
                      {trimMut.isPending ? "Trimming…" : "Apply trim"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right: settings + insights */}
        <div className="space-y-4">
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 space-y-3">
            <div className="text-xs font-bold uppercase tracking-wider text-white/35">Sharing</div>
            <label className="flex items-center justify-between gap-2 text-sm text-white/70">
              Who can watch
              <select
                value={v.visibility}
                disabled={!v.mine}
                onChange={(e) => patchMut.mutate({ visibility: e.target.value })}
                className={selectCls}
              >
                <option value="link">Anyone with the link</option>
                <option value="staff">Staff only (must sign in)</option>
                <option value="private">Only me</option>
              </select>
            </label>
            {(
              [
                ["allowComments", "Comments & reactions"],
                ["allowDownload", "Viewers can download"],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="flex items-center justify-between text-sm text-white/70 cursor-pointer">
                {label}
                <input
                  type="checkbox"
                  checked={v[key]}
                  disabled={!v.mine}
                  onChange={(e) => patchMut.mutate({ [key]: e.target.checked })}
                  className="accent-amber-400 w-4 h-4"
                />
              </label>
            ))}
          </div>

          {v.status === "ready" && (
            <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 space-y-2">
              <div className="text-xs font-bold uppercase tracking-wider text-white/35 mb-1">Tools</div>
              <button
                onClick={() => captionsMut.mutate()}
                disabled={v.captionsStatus === "inprogress" || v.captionsStatus === "ready" || captionsMut.isPending}
                className="w-full inline-flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-sm text-white/70 hover:bg-white/[0.06] disabled:opacity-50"
              >
                <Captions className="w-4 h-4" />
                {v.captionsStatus === "ready" ? "Captions ready" : v.captionsStatus === "inprogress" ? "Generating captions…" : "Generate captions"}
              </button>
              <button
                onClick={fetchDownload}
                disabled={downloadBusy}
                className="w-full inline-flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-sm text-white/70 hover:bg-white/[0.06] disabled:opacity-50"
              >
                {downloadBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                {downloadBusy ? "Preparing MP4…" : "Download MP4"}
              </button>
              {v.mine && (
                <button
                  onClick={() => {
                    if (confirm("Delete this video? This also removes it from Cloudflare and frees storage. This can't be undone.")) {
                      deleteMut.mutate(true);
                    }
                  }}
                  className="w-full inline-flex items-center gap-2 rounded-lg border border-red-500/20 px-3 py-2 text-sm text-red-400/80 hover:bg-red-500/10"
                >
                  <Trash2 className="w-4 h-4" /> Delete video
                </button>
              )}
            </div>
          )}

          {/* Insights */}
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
            <div className="text-xs font-bold uppercase tracking-wider text-white/35 mb-3 flex items-center gap-1.5">
              <BarChart3 className="w-3.5 h-3.5" /> Insights
            </div>
            <div className="grid grid-cols-3 gap-2 mb-4">
              {[
                { icon: Eye, label: "Views", value: insights?.views ?? v.viewCount },
                { icon: Users, label: "Viewers", value: insights?.uniques ?? "—" },
                { icon: BarChart3, label: "Avg watched", value: insights?.avgWatchPercent != null ? `${insights.avgWatchPercent}%` : "—" },
              ].map((s) => (
                <div key={s.label} className="rounded-lg bg-white/[0.03] border border-white/5 p-2 text-center">
                  <div className="text-base font-bold text-white/90">{s.value}</div>
                  <div className="text-[10px] text-white/35">{s.label}</div>
                </div>
              ))}
            </div>
            {insights && insights.viewers.length > 0 ? (
              <div className="space-y-1.5 max-h-64 overflow-y-auto">
                {insights.viewers.map((viewer) => (
                  <div key={viewer.label} className="flex items-center gap-2 text-xs">
                    <span className="text-white/60 w-16 shrink-0">{viewer.label}</span>
                    <div className="flex-1 h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
                      <div className="h-full bg-amber-400/70" style={{ width: `${viewer.bestPercent}%` }} />
                    </div>
                    <span className="text-white/40 tabular-nums w-9 text-right">{viewer.bestPercent}%</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-white/30">No external views yet. Staff opens aren't counted.</p>
            )}
            {insights && insights.staffViews > 0 && (
              <p className="text-[10px] text-white/25 mt-2">+{insights.staffViews} staff opens (excluded above)</p>
            )}
          </div>

          {/* Comments */}
          {insights && insights.comments.length > 0 && (
            <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
              <div className="text-xs font-bold uppercase tracking-wider text-white/35 mb-2">Comments & reactions</div>
              <div className="space-y-2 max-h-72 overflow-y-auto">
                {insights.comments.map((c) => (
                  <div key={c.id} className="text-xs">
                    <span className="font-semibold text-white/70">{c.authorName || "Someone"}</span>{" "}
                    {c.atSeconds != null && <span className="text-amber-300/80">@ {formatClock(c.atSeconds)}</span>}{" "}
                    <span className="text-white/60">{c.emoji ? c.emoji : c.body}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
