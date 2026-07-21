// ── /v/{token} — the public video share page (the in-house Loom viewer) ──────
// Anonymous, premium-dark, noindex. Speed controls, timestamped emoji
// reactions, comments, view tracking (view on open, play once, milestones at
// 25/50/75/95% — staff sessions flagged and excluded from headline counts).
import { useEffect, useRef, useState } from "react";
import { useRoute } from "wouter";
import Hls from "hls.js";
import { Loader2, Lock, VideoOff, Download, Eye } from "lucide-react";

interface ShareComment {
  id: number;
  authorName: string;
  body: string | null;
  atSeconds: number | null;
  isStaff: boolean;
  createdAt: string;
}
interface SharePayload {
  token: string;
  title: string;
  description: string | null;
  ownerName: string | null;
  status: string;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
  playbackUrl: string | null;
  downloadUrl: string | null;
  allowComments: boolean;
  captionsReady: boolean;
  viewCount: number;
  createdAt: string;
  reactions: Record<string, number>;
  reactionPins: Array<{ emoji: string; atSeconds: number }>;
  comments: ShareComment[];
}

const EMOJIS = ["👍", "❤️", "😂", "🎉", "👏"];
const SPEEDS = [1, 1.25, 1.5, 1.75, 2];

const clock = (s: number) => {
  const t = Math.floor(s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  return `${h ? `${h}:` : ""}${h ? String(m).padStart(2, "0") : m}:${String(t % 60).padStart(2, "0")}`;
};

export default function VideoShare() {
  const [, params] = useRoute("/v/:token");
  const token = params?.token || "";

  const [data, setData] = useState<SharePayload | null>(null);
  const [errKind, setErrKind] = useState<"" | "staff_only" | "private" | "gone">("");
  const [speed, setSpeed] = useState(1);
  const [name, setName] = useState(() => localStorage.getItem("usg_video_name") || "");
  const [comment, setComment] = useState("");
  const [atTime, setAtTime] = useState(true);
  const [posting, setPosting] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const sentRef = useRef<{ view: boolean; play: boolean; milestones: Set<number>; maxPct: number }>({
    view: false,
    play: false,
    milestones: new Set(),
    maxPct: 0,
  });

  // noindex — these pages must never be crawlable.
  useEffect(() => {
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex, nofollow";
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);
  useEffect(() => {
    if (data?.title) document.title = `${data.title} — United Sports Group`;
  }, [data?.title]);

  async function load() {
    const res = await fetch(`/api/public/videos/${token}`, { credentials: "include" });
    if (res.status === 401) return setErrKind("staff_only");
    if (res.status === 403) return setErrKind("private");
    if (!res.ok) return setErrKind("gone");
    setData(await res.json());
  }
  useEffect(() => {
    if (token) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Keep polling while processing.
  useEffect(() => {
    if (data && data.status !== "ready") {
      const t = setInterval(load, 4000);
      return () => clearInterval(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.status]);

  function sendEvent(kind: string, extra: Record<string, unknown> = {}) {
    void fetch(`/api/public/videos/${token}/events`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, ...extra }),
    }).catch(() => undefined);
  }

  // View event on first successful load.
  useEffect(() => {
    if (data && !sentRef.current.view) {
      sentRef.current.view = true;
      sendEvent("view");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // Player wiring.
  useEffect(() => {
    const el = videoRef.current;
    const url = data?.status === "ready" ? data.playbackUrl : null;
    if (!el || !url) return;
    if (el.canPlayType("application/vnd.apple.mpegurl")) {
      el.src = url;
    } else {
      const hls = new Hls();
      hlsRef.current = hls;
      hls.loadSource(url);
      hls.attachMedia(el);
    }
    const onPlay = () => {
      if (!sentRef.current.play) {
        sentRef.current.play = true;
        sendEvent("play");
      }
    };
    const onTime = () => {
      const dur = el.duration || data?.durationSeconds || 0;
      if (!dur) return;
      const pct = Math.round((el.currentTime / dur) * 100);
      if (pct > sentRef.current.maxPct) sentRef.current.maxPct = pct;
      for (const m of [25, 50, 75, 95]) {
        if (pct >= m && !sentRef.current.milestones.has(m)) {
          sentRef.current.milestones.add(m);
          sendEvent("milestone", { percent: m, positionSeconds: el.currentTime });
        }
      }
    };
    el.addEventListener("play", onPlay);
    el.addEventListener("timeupdate", onTime);
    return () => {
      el.removeEventListener("play", onPlay);
      el.removeEventListener("timeupdate", onTime);
      hlsRef.current?.destroy();
      hlsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.playbackUrl, data?.status]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = speed;
  }, [speed]);

  async function react(emoji: string) {
    const at = videoRef.current?.currentTime ?? null;
    setData((d) => (d ? { ...d, reactions: { ...d.reactions, [emoji]: (d.reactions[emoji] || 0) + 1 } } : d));
    await fetch(`/api/public/videos/${token}/comments`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emoji, atSeconds: at, name: name || undefined }),
    }).catch(() => undefined);
  }

  async function postComment() {
    if (!comment.trim() || posting) return;
    setPosting(true);
    try {
      if (name) localStorage.setItem("usg_video_name", name);
      const res = await fetch(`/api/public/videos/${token}/comments`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name || undefined,
          body: comment.trim(),
          atSeconds: atTime ? (videoRef.current?.currentTime ?? null) : null,
        }),
      });
      if (res.ok) {
        setComment("");
        await load();
      }
    } finally {
      setPosting(false);
    }
  }

  // ── Error states ──
  if (errKind) {
    const cfg = {
      staff_only: { icon: Lock, title: "Staff only", body: "Sign in to ClubOS to watch this video.", cta: { href: "/admin/login", label: "Sign in" } },
      private: { icon: Lock, title: "This video is private", body: "Only its owner can watch it.", cta: null },
      gone: { icon: VideoOff, title: "Video not found", body: "This video doesn't exist or was deleted.", cta: null },
    }[errKind];
    return (
      <div className="min-h-screen bg-[#0b0f17] flex items-center justify-center p-6">
        <div className="text-center">
          <cfg.icon className="w-10 h-10 text-white/20 mx-auto mb-4" />
          <h1 className="text-lg font-bold text-white/90">{cfg.title}</h1>
          <p className="text-sm text-white/40 mt-1">{cfg.body}</p>
          {cfg.cta && (
            <a href={cfg.cta.href} className="inline-block mt-4 rounded-lg bg-amber-500 px-4 py-2 text-sm font-bold text-black">
              {cfg.cta.label}
            </a>
          )}
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="min-h-screen bg-[#0b0f17] flex items-center justify-center">
        <Loader2 className="w-6 h-6 text-white/30 animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0b0f17] text-white">
      <div className="max-w-4xl mx-auto px-4 py-6 sm:py-10">
        {/* Header */}
        <div className="mb-4">
          <h1 className="text-xl sm:text-2xl font-bold text-white/95">{data.title}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-white/40">
            {data.ownerName && <span>{data.ownerName}</span>}
            <span>{new Date(data.createdAt).toLocaleDateString("en-NZ", { day: "numeric", month: "long", year: "numeric" })}</span>
            <span className="inline-flex items-center gap-1">
              <Eye className="w-3.5 h-3.5" /> {data.viewCount} view{data.viewCount === 1 ? "" : "s"}
            </span>
          </div>
        </div>

        {/* Player */}
        {data.status === "ready" ? (
          <div className="rounded-2xl overflow-hidden border border-white/10 bg-black shadow-2xl">
            <video ref={videoRef} controls playsInline crossOrigin="anonymous" poster={data.thumbnailUrl || undefined} className="w-full" />
          </div>
        ) : (
          <div className="aspect-video rounded-2xl border border-white/10 bg-black/50 flex flex-col items-center justify-center gap-3 text-white/50">
            <Loader2 className="w-8 h-8 animate-spin" />
            <div className="text-sm">This video is still processing — it'll start automatically.</div>
          </div>
        )}

        {/* Controls row: speed + reactions + download */}
        {data.status === "ready" && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <div className="flex rounded-lg border border-white/10 overflow-hidden">
              {SPEEDS.map((s) => (
                <button
                  key={s}
                  onClick={() => setSpeed(s)}
                  className={`px-2.5 py-1.5 text-[11px] font-semibold ${
                    speed === s ? "bg-amber-500/25 text-amber-300" : "bg-white/[0.03] text-white/45 hover:text-white/80"
                  }`}
                >
                  {s}×
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1">
              {EMOJIS.map((e) => (
                <button
                  key={e}
                  onClick={() => react(e)}
                  className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-sm hover:bg-white/[0.1] active:scale-110 transition-transform"
                  title="React (pinned to the current moment)"
                >
                  {e}
                  {data.reactions[e] ? <span className="ml-1 text-[10px] text-white/50">{data.reactions[e]}</span> : null}
                </button>
              ))}
            </div>
            {data.downloadUrl && (
              <a
                href={data.downloadUrl}
                className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[11px] font-semibold text-white/60 hover:text-white/90"
              >
                <Download className="w-3.5 h-3.5" /> Download
              </a>
            )}
          </div>
        )}

        {data.description && <p className="mt-4 text-sm text-white/60 whitespace-pre-wrap">{data.description}</p>}

        {/* Comments */}
        {data.allowComments && (
          <div className="mt-8">
            <h2 className="text-sm font-bold text-white/70 mb-3">
              Comments{data.comments.length ? ` (${data.comments.length})` : ""}
            </h2>
            <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3 mb-4">
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your name"
                  className="sm:w-44 rounded-lg bg-white/[0.04] border border-white/10 px-3 py-2 text-sm text-white/85 placeholder:text-white/25 focus:outline-none focus:border-amber-500/50"
                />
                <input
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && postComment()}
                  placeholder="Leave a comment…"
                  className="flex-1 rounded-lg bg-white/[0.04] border border-white/10 px-3 py-2 text-sm text-white/85 placeholder:text-white/25 focus:outline-none focus:border-amber-500/50"
                />
                <button
                  onClick={postComment}
                  disabled={posting || !comment.trim()}
                  className="rounded-lg bg-amber-500/90 hover:bg-amber-500 px-4 py-2 text-sm font-bold text-black disabled:opacity-40"
                >
                  Post
                </button>
              </div>
              <label className="mt-2 flex items-center gap-1.5 text-[11px] text-white/35 cursor-pointer">
                <input type="checkbox" checked={atTime} onChange={(e) => setAtTime(e.target.checked)} className="accent-amber-400" />
                Pin to the current moment in the video
              </label>
            </div>
            <div className="space-y-3">
              {data.comments.map((c) => (
                <div key={c.id} className="rounded-lg border border-white/5 bg-white/[0.02] p-3">
                  <div className="flex items-center gap-2 text-xs mb-1">
                    <span className="font-semibold text-white/75">{c.authorName}</span>
                    {c.atSeconds != null && (
                      <button
                        onClick={() => {
                          if (videoRef.current) {
                            videoRef.current.currentTime = c.atSeconds!;
                            void videoRef.current.play();
                          }
                        }}
                        className="text-amber-300/90 hover:underline"
                      >
                        {clock(c.atSeconds)}
                      </button>
                    )}
                    <span className="text-white/25">
                      {new Date(c.createdAt).toLocaleDateString("en-NZ", { day: "numeric", month: "short" })}
                    </span>
                  </div>
                  <p className="text-sm text-white/70 whitespace-pre-wrap">{c.body}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mt-12 pb-6 text-center text-[11px] text-white/25">United Sports Group · Christchurch, NZ</div>
      </div>
    </div>
  );
}
