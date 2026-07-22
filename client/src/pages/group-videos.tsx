// ── Videos — the in-house Loom: library ──────────────────────────────────────
// Record screen/camera tutorials with no time limit, share at /v/{token},
// see who watched. This page is the library; recording happens at
// /admin/videos/record, per-video detail (trim/insights/share) at
// /admin/videos/:id. House style copied from feedback.tsx / group-vehicles.tsx.
import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { uploadVideo, StorageFullError, formatBytes } from "@/lib/video-upload";
import { formatClock } from "@/lib/screen-recorder";
import {
  Video, Upload, Link2, Eye, Loader2, AlertTriangle, Clapperboard, Plus,
} from "lucide-react";

interface VideoListItem {
  id: number;
  token: string;
  title: string;
  status: string;
  source: string;
  visibility: string;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
  animatedThumbUrl: string | null;
  viewCount: number;
  ownerName: string;
  mine: boolean;
  createdAt: string;
}

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" });

function StatusPill({ status }: { status: string }) {
  if (status === "ready") return null;
  const cfg =
    status === "error"
      ? { label: "Failed", color: "#ef4444" }
      : status === "uploading"
        ? { label: "Uploading…", color: "#f59e0b" }
        : { label: "Processing…", color: "#3b82f6" };
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full"
      style={{ background: `${cfg.color}22`, color: cfg.color, border: `1px solid ${cfg.color}55` }}
    >
      {status !== "error" && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
      {cfg.label}
    </span>
  );
}

export default function GroupVideos() {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [scope, setScope] = useState<"all" | "mine">("all");
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [storageFull, setStorageFull] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const { data: videos = [], isLoading } = useQuery<VideoListItem[]>({
    queryKey: [`/api/admin/videos?scope=${scope}`],
    refetchInterval: (q) =>
      (q.state.data || []).some((v) => v.status === "processing" || v.status === "uploading") ? 5000 : false,
  });

  const stats = useMemo(
    () => ({
      count: videos.length,
      views: videos.reduce((a, v) => a + (v.viewCount || 0), 0),
      minutes: Math.round(videos.reduce((a, v) => a + (v.durationSeconds || 0), 0) / 60),
    }),
    [videos],
  );

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("video/")) {
      toast({ title: "Not a video file", description: "Pick an MP4, MOV or WebM file.", variant: "destructive" });
      return;
    }
    setUploadPct(0);
    try {
      const { id } = await uploadVideo({
        blob: file,
        title: file.name.replace(/\.[a-z0-9]+$/i, ""),
        source: "upload",
        onProgress: (f) => setUploadPct(Math.round(f * 100)),
      });
      queryClient.invalidateQueries({ queryKey: [`/api/admin/videos?scope=${scope}`] });
      toast({ title: "Uploaded", description: "Processing now — the share link works as soon as it's ready." });
      navigate(`/admin/videos/${id}`);
    } catch (err) {
      if (err instanceof StorageFullError) setStorageFull(true);
      else toast({ title: "Upload failed", description: (err as Error).message, variant: "destructive" });
    } finally {
      setUploadPct(null);
    }
  }

  function copyLink(v: VideoListItem) {
    navigator.clipboard.writeText(`${window.location.origin}/v/${v.token}`);
    toast({ title: "Link copied", description: "Anyone with the link can watch (unless you've restricted it)." });
  }

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div>
          <h1 className="text-xl font-bold text-white/95 flex items-center gap-2">
            <Video className="w-5 h-5 text-amber-400" /> Videos
          </h1>
          <p className="text-sm text-white/40 mt-0.5">
            Record your screen, share a link, see who watched. No time limits.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input ref={fileRef} type="file" accept="video/*" className="hidden" onChange={onPickFile} />
          <button
            onClick={() => fileRef.current?.click()}
            disabled={uploadPct !== null}
            className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-white/80 hover:bg-white/[0.08] disabled:opacity-50"
          >
            {uploadPct !== null ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" /> {uploadPct}%
              </>
            ) : (
              <>
                <Upload className="w-4 h-4" /> Upload video
              </>
            )}
          </button>
          <button
            onClick={() => navigate("/admin/videos/record")}
            className="inline-flex items-center gap-2 rounded-lg bg-amber-500/90 hover:bg-amber-500 px-3 py-2 text-sm font-semibold text-black"
          >
            <Plus className="w-4 h-4" /> New recording
          </button>
        </div>
      </div>

      {storageFull && (
        <div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 p-4 flex gap-3">
          <AlertTriangle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
          <div className="text-sm text-white/80">
            <div className="font-semibold text-red-300">Video storage is full</div>
            The shared Cloudflare Stream account is over its storage quota, so new uploads are rejected. Buy more
            minutes in the Cloudflare dashboard (≈US$5/month per 1,000 minutes) or delete old videos, then try again.
          </div>
        </div>
      )}

      {/* Stats + scope */}
      <div className="flex flex-wrap items-center gap-2 mb-5">
        {[
          { label: "Videos", value: stats.count },
          { label: "Total views", value: stats.views },
          { label: "Minutes stored", value: stats.minutes },
        ].map((s) => (
          <div key={s.label} className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5">
            <span className="text-sm font-bold text-white/90">{s.value}</span>
            <span className="text-[11px] text-white/40 ml-1.5">{s.label}</span>
          </div>
        ))}
        <div className="ml-auto flex rounded-lg border border-white/10 overflow-hidden">
          {(["all", "mine"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setScope(s)}
              className={`px-3 py-1.5 text-xs font-semibold ${
                scope === s ? "bg-amber-500/20 text-amber-300" : "bg-white/[0.02] text-white/50 hover:text-white/80"
              }`}
            >
              {s === "all" ? "Workspace" : "My videos"}
            </button>
          ))}
        </div>
      </div>

      {/* Grid */}
      {isLoading ? (
        <div className="flex items-center justify-center py-24 text-white/40">
          <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
        </div>
      ) : videos.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-white/10 py-20 text-center">
          <Clapperboard className="w-10 h-10 text-white/20 mx-auto mb-3" />
          <div className="text-white/70 font-semibold">No videos yet</div>
          <p className="text-sm text-white/40 mt-1 max-w-sm mx-auto">
            Hit <span className="text-amber-300">New recording</span> to record your screen — a tutorial, a walkthrough,
            a quick “how do I do this” answer — then share the link.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {videos.map((v) => (
            <div
              key={v.id}
              onClick={() => navigate(`/admin/videos/${v.id}`)}
              className="group rounded-xl border border-white/10 bg-white/[0.02] overflow-hidden cursor-pointer hover:border-amber-500/40 hover:bg-white/[0.04] transition-colors"
            >
              <div className="relative aspect-video bg-black/40">
                {v.thumbnailUrl ? (
                  <>
                    <img
                      src={v.thumbnailUrl}
                      alt=""
                      loading="lazy"
                      className="w-full h-full object-cover group-hover:hidden"
                    />
                    <img
                      src={v.animatedThumbUrl || v.thumbnailUrl}
                      alt=""
                      loading="lazy"
                      className="w-full h-full object-cover hidden group-hover:block"
                    />
                  </>
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    {v.status === "error" ? (
                      <AlertTriangle className="w-8 h-8 text-red-400/60" />
                    ) : (
                      <Loader2 className="w-8 h-8 text-white/20 animate-spin" />
                    )}
                  </div>
                )}
                {v.durationSeconds ? (
                  <span className="absolute bottom-1.5 right-1.5 rounded bg-black/80 px-1.5 py-0.5 text-[10px] font-semibold text-white/90">
                    {formatClock(v.durationSeconds)}
                  </span>
                ) : null}
                <div className="absolute top-1.5 left-1.5">
                  <StatusPill status={v.status} />
                </div>
              </div>
              <div className="p-3">
                <div className="text-sm font-semibold text-white/90 truncate" title={v.title}>
                  {v.title}
                </div>
                <div className="mt-1 flex items-center justify-between text-[11px] text-white/40">
                  <span className="truncate">
                    {v.ownerName} · {fmtDate(v.createdAt)}
                  </span>
                  <span className="inline-flex items-center gap-2 shrink-0 ml-2">
                    <span className="inline-flex items-center gap-0.5">
                      <Eye className="w-3 h-3" /> {v.viewCount}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        copyLink(v);
                      }}
                      title="Copy share link"
                      className="text-white/40 hover:text-amber-300"
                    >
                      <Link2 className="w-3.5 h-3.5" />
                    </button>
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
