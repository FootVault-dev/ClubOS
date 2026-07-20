// ── Videos — the recorder ────────────────────────────────────────────────────
// Loom-style in-browser recording: Screen / Screen + Camera / Camera, mic and
// camera pickers, 3-2-1 countdown, pause/resume, NO time limit. Screen+Camera
// bakes a circular webcam bubble into the file (canvas composite) so the
// output is one flat video that plays anywhere. Engine: lib/screen-recorder.ts.
import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import {
  ScreenRecorder,
  formatClock,
  type RecorderMode,
  type BubbleCorner,
  type BubbleSize,
  type RecordingResult,
} from "@/lib/screen-recorder";
import { uploadVideo, StorageFullError, formatBytes } from "@/lib/video-upload";
import {
  Monitor, Camera, User, Mic, MicOff, Pause, Play, Square, X, ArrowLeft,
  Loader2, AlertTriangle, CircleDot,
} from "lucide-react";

type Phase = "setup" | "countdown" | "recording" | "review" | "uploading";

const MODES: Array<{ key: RecorderMode; label: string; hint: string; icon: typeof Monitor }> = [
  { key: "screen-camera", label: "Screen + Camera", hint: "Your screen with a camera bubble — the classic tutorial", icon: Monitor },
  { key: "screen", label: "Screen only", hint: "Just the screen, crisp and clean", icon: Monitor },
  { key: "camera", label: "Camera only", hint: "Talk straight to camera", icon: User },
];

export default function GroupVideoRecord() {
  const { toast } = useToast();
  const [, navigate] = useLocation();

  const [phase, setPhase] = useState<Phase>("setup");
  const [mode, setMode] = useState<RecorderMode>("screen-camera");
  const [micEnabled, setMicEnabled] = useState(true);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [cams, setCams] = useState<MediaDeviceInfo[]>([]);
  const [micId, setMicId] = useState<string>("");
  const [camId, setCamId] = useState<string>("");
  const [bubbleCorner, setBubbleCorner] = useState<BubbleCorner>("bottom-left");
  const [bubbleSize, setBubbleSize] = useState<BubbleSize>("md");
  const [countdown, setCountdown] = useState(3);
  const [elapsed, setElapsed] = useState(0);
  const [paused, setPaused] = useState(false);
  const [cameraHidden, setCameraHidden] = useState(false);
  const [result, setResult] = useState<RecordingResult | null>(null);
  const [title, setTitle] = useState("");
  const [uploadPct, setUploadPct] = useState(0);
  const [storageFull, setStorageFull] = useState(false);

  const recorderRef = useRef<ScreenRecorder | null>(null);
  const previewRef = useRef<HTMLVideoElement>(null);
  const reviewRef = useRef<HTMLVideoElement>(null);
  const reviewUrlRef = useRef<string | null>(null);

  // Populate device pickers (labels appear once permission has been granted).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const probe = await navigator.mediaDevices.getUserMedia({ audio: true, video: true }).catch(() => null);
        const devices = await navigator.mediaDevices.enumerateDevices();
        probe?.getTracks().forEach((t) => t.stop());
        if (cancelled) return;
        setMics(devices.filter((d) => d.kind === "audioinput"));
        setCams(devices.filter((d) => d.kind === "videoinput"));
      } catch {
        /* pickers just stay generic */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Cleanup on unmount — never leave a camera light on.
  useEffect(
    () => () => {
      recorderRef.current?.cancel();
      if (reviewUrlRef.current) URL.revokeObjectURL(reviewUrlRef.current);
    },
    [],
  );

  // Camera bubble live preview while recording (the real bubble is composited
  // into the file; this floating one is so you can see yourself).
  useEffect(() => {
    const stream = recorderRef.current?.cameraPreviewStream;
    if (previewRef.current && stream && (phase === "recording" || phase === "countdown")) {
      previewRef.current.srcObject = stream;
      void previewRef.current.play().catch(() => undefined);
    }
  }, [phase]);

  async function begin() {
    const rec = new ScreenRecorder(
      {
        mode,
        micEnabled,
        micDeviceId: micId || undefined,
        cameraDeviceId: camId || undefined,
        bubbleCorner,
        bubbleSize,
      },
      {
        onTick: (s) => setElapsed(s),
        onError: (m) => toast({ title: "Recording problem", description: m, variant: "destructive" }),
        onExternalStop: () => toast({ title: "Screen sharing ended", description: "Wrapping up your recording…" }),
        onState: (s) => {
          if (s === "stopped") setPhase((p) => (p === "recording" || p === "countdown" ? "review" : p));
        },
      },
    );
    recorderRef.current = rec;
    try {
      await rec.acquire();
    } catch {
      recorderRef.current = null;
      return;
    }
    setPhase("countdown");
    for (const n of [3, 2, 1]) {
      setCountdown(n);
      await new Promise((r) => setTimeout(r, 800));
    }
    rec.start();
    setPhase("recording");
    setPaused(false);
  }

  async function stop() {
    const rec = recorderRef.current;
    if (!rec) return;
    const r = await rec.stop();
    if (r.blob.size === 0) {
      toast({ title: "Nothing recorded", description: "The recording came back empty — try again.", variant: "destructive" });
      setPhase("setup");
      return;
    }
    setResult(r);
    if (!title) setTitle(`Recording — ${new Date().toLocaleDateString("en-NZ", { day: "numeric", month: "short" })}`);
    setPhase("review");
    const url = URL.createObjectURL(r.blob);
    reviewUrlRef.current = url;
    setTimeout(() => {
      if (reviewRef.current) reviewRef.current.src = url;
    }, 0);
  }

  function discard() {
    recorderRef.current?.cancel();
    recorderRef.current = null;
    if (reviewUrlRef.current) URL.revokeObjectURL(reviewUrlRef.current);
    reviewUrlRef.current = null;
    setResult(null);
    setElapsed(0);
    setPhase("setup");
  }

  async function save() {
    if (!result) return;
    setPhase("uploading");
    setUploadPct(0);
    try {
      const { id } = await uploadVideo({
        blob: result.blob,
        title: title.trim() || "Untitled video",
        source: "recording",
        durationSeconds: result.durationSeconds,
        onProgress: (f) => setUploadPct(Math.round(f * 100)),
      });
      toast({ title: "Saved", description: "Processing now — grab the share link from the video page." });
      navigate(`/admin/videos/${id}`);
    } catch (err) {
      if (err instanceof StorageFullError) {
        setStorageFull(true);
        toast({ title: "Storage full", description: err.message, variant: "destructive" });
      } else {
        toast({ title: "Upload failed", description: (err as Error).message, variant: "destructive" });
      }
      setPhase("review"); // the recording is NOT lost — they can retry or download
    }
  }

  function downloadLocal() {
    if (!result || !reviewUrlRef.current) return;
    const a = document.createElement("a");
    a.href = reviewUrlRef.current;
    a.download = `${(title || "recording").replace(/[^\w\- ]+/g, "")}.webm`;
    a.click();
  }

  const selectCls =
    "w-full rounded-lg bg-white/[0.04] border border-white/10 px-3 py-2 text-sm text-white/85 focus:outline-none focus:border-amber-500/50";

  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto">
      <button
        onClick={() => (phase === "recording" || phase === "countdown" ? undefined : navigate("/admin/videos"))}
        className={`inline-flex items-center gap-1.5 text-sm text-white/40 hover:text-white/70 mb-4 ${
          phase === "recording" || phase === "countdown" ? "invisible" : ""
        }`}
      >
        <ArrowLeft className="w-4 h-4" /> Back to Videos
      </button>

      {/* ── SETUP ── */}
      {phase === "setup" && (
        <div>
          <h1 className="text-xl font-bold text-white/95 mb-1">New recording</h1>
          <p className="text-sm text-white/40 mb-5">No time limit. Pause whenever you like. Trim afterwards.</p>

          {storageFull && (
            <div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 p-4 flex gap-3">
              <AlertTriangle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
              <div className="text-sm text-white/80">
                <div className="font-semibold text-red-300">Video storage is full</div>
                Uploads are rejected until more Cloudflare Stream minutes are bought (≈US$5/month per 1,000 minutes)
                or old videos are deleted. You can still record and download the file locally.
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
            {MODES.map((m) => (
              <button
                key={m.key}
                onClick={() => setMode(m.key)}
                className={`rounded-xl border p-4 text-left transition-colors ${
                  mode === m.key
                    ? "border-amber-500/60 bg-amber-500/10"
                    : "border-white/10 bg-white/[0.02] hover:bg-white/[0.05]"
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <m.icon className={`w-4 h-4 ${mode === m.key ? "text-amber-300" : "text-white/50"}`} />
                  {m.key === "screen-camera" && <Camera className={`w-4 h-4 ${mode === m.key ? "text-amber-300" : "text-white/50"}`} />}
                </div>
                <div className={`text-sm font-semibold ${mode === m.key ? "text-amber-200" : "text-white/85"}`}>{m.label}</div>
                <div className="text-[11px] text-white/40 mt-0.5">{m.hint}</div>
              </button>
            ))}
          </div>

          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 space-y-4 mb-5">
            <div className="flex items-center gap-3">
              <button
                onClick={() => setMicEnabled((v) => !v)}
                className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
                  micEnabled
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                    : "border-white/10 bg-white/[0.04] text-white/40"
                }`}
              >
                {micEnabled ? <Mic className="w-4 h-4" /> : <MicOff className="w-4 h-4" />}
                {micEnabled ? "Mic on" : "Mic off"}
              </button>
              {micEnabled && (
                <select value={micId} onChange={(e) => setMicId(e.target.value)} className={selectCls}>
                  <option value="">Default microphone</option>
                  {mics.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || "Microphone"}
                    </option>
                  ))}
                </select>
              )}
            </div>

            {mode !== "screen" && (
              <div className="flex items-center gap-3">
                <span className="inline-flex items-center gap-2 text-sm text-white/60 shrink-0">
                  <Camera className="w-4 h-4" /> Camera
                </span>
                <select value={camId} onChange={(e) => setCamId(e.target.value)} className={selectCls}>
                  <option value="">Default camera</option>
                  {cams.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || "Camera"}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {mode === "screen-camera" && (
              <div className="flex flex-wrap items-center gap-4">
                <div>
                  <div className="text-[11px] text-white/40 mb-1">Bubble corner</div>
                  <div className="grid grid-cols-2 gap-1 w-16">
                    {(["top-left", "top-right", "bottom-left", "bottom-right"] as BubbleCorner[]).map((c) => (
                      <button
                        key={c}
                        onClick={() => setBubbleCorner(c)}
                        title={c}
                        className={`h-7 rounded border ${
                          bubbleCorner === c ? "border-amber-500 bg-amber-500/30" : "border-white/15 bg-white/[0.04]"
                        }`}
                      />
                    ))}
                  </div>
                </div>
                <div>
                  <div className="text-[11px] text-white/40 mb-1">Bubble size</div>
                  <div className="flex gap-1">
                    {(["sm", "md", "lg"] as BubbleSize[]).map((s) => (
                      <button
                        key={s}
                        onClick={() => setBubbleSize(s)}
                        className={`px-3 py-1.5 rounded-lg border text-xs font-semibold ${
                          bubbleSize === s
                            ? "border-amber-500/60 bg-amber-500/15 text-amber-200"
                            : "border-white/10 bg-white/[0.03] text-white/50"
                        }`}
                      >
                        {s.toUpperCase()}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          <button
            onClick={begin}
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-xl bg-red-500 hover:bg-red-400 px-6 py-3 text-sm font-bold text-white"
          >
            <CircleDot className="w-4 h-4" /> Start recording
          </button>
          <p className="text-[11px] text-white/30 mt-3">
            Tip: pick a Chrome tab and tick “share tab audio” if the recording needs computer sound.
          </p>
        </div>
      )}

      {/* ── COUNTDOWN ── */}
      {phase === "countdown" && (
        <div className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center">
          <div className="text-[120px] font-black text-amber-400 tabular-nums animate-pulse">{countdown}</div>
        </div>
      )}

      {/* ── RECORDING HUD ── */}
      {phase === "recording" && (
        <div className="rounded-2xl border border-red-500/30 bg-white/[0.02] p-6 text-center">
          <div className="inline-flex items-center gap-2 text-red-400 font-bold mb-2">
            <span className={`w-3 h-3 rounded-full bg-red-500 ${paused ? "" : "animate-pulse"}`} />
            {paused ? "PAUSED" : "RECORDING"}
          </div>
          <div className="text-5xl font-black text-white/95 tabular-nums mb-6">{formatClock(elapsed)}</div>
          <div className="flex items-center justify-center gap-3">
            <button
              onClick={() => {
                if (paused) {
                  recorderRef.current?.resume();
                  setPaused(false);
                } else {
                  recorderRef.current?.pause();
                  setPaused(true);
                }
              }}
              className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/[0.05] px-5 py-3 text-sm font-semibold text-white/85 hover:bg-white/[0.1]"
            >
              {paused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
              {paused ? "Resume" : "Pause"}
            </button>
            <button
              onClick={stop}
              className="inline-flex items-center gap-2 rounded-xl bg-red-500 hover:bg-red-400 px-6 py-3 text-sm font-bold text-white"
            >
              <Square className="w-4 h-4" /> Stop
            </button>
            <button
              onClick={discard}
              title="Discard this take"
              className="inline-flex items-center gap-2 rounded-xl border border-white/10 px-4 py-3 text-sm text-white/40 hover:text-white/70"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          {mode === "screen-camera" && (
            <button
              onClick={() => {
                const rec = recorderRef.current;
                if (rec) {
                  rec.cameraHidden = !rec.cameraHidden;
                  setCameraHidden(rec.cameraHidden);
                }
              }}
              className="mt-4 text-xs text-white/40 hover:text-white/70 underline underline-offset-2"
            >
              {cameraHidden ? "Show camera bubble" : "Hide camera bubble"}
            </button>
          )}
          <p className="text-[11px] text-white/30 mt-4">
            Switch to the window you're demonstrating — this page keeps recording in the background.
          </p>
        </div>
      )}

      {/* Floating self-view while recording */}
      <video
        ref={previewRef}
        muted
        playsInline
        className={`fixed bottom-4 right-4 z-40 w-32 h-32 rounded-full object-cover border-2 border-amber-400/80 shadow-xl ${
          phase === "recording" && mode !== "screen" && !cameraHidden ? "" : "hidden"
        }`}
      />

      {/* ── REVIEW ── */}
      {(phase === "review" || phase === "uploading") && result && (
        <div>
          <h1 className="text-xl font-bold text-white/95 mb-4">Review your recording</h1>
          <video ref={reviewRef} controls playsInline className="w-full rounded-xl border border-white/10 bg-black mb-4" />
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-white/40 mb-4">
            <span>{formatClock(result.durationSeconds)}</span>·<span>{formatBytes(result.blob.size)}</span>
          </div>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Give it a title people will search for"
            className="w-full rounded-lg bg-white/[0.03] border border-white/10 px-3 py-2.5 text-sm text-white/90 placeholder:text-white/25 focus:outline-none focus:border-amber-500/50 mb-4"
          />
          {storageFull && (
            <div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-white/80">
              <span className="font-semibold text-red-300">Storage full — the upload was rejected.</span> Your recording
              is safe on this page: download it now, and re-upload once storage is sorted.
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={save}
              disabled={phase === "uploading"}
              className="inline-flex items-center gap-2 rounded-xl bg-amber-500/90 hover:bg-amber-500 px-6 py-3 text-sm font-bold text-black disabled:opacity-60"
            >
              {phase === "uploading" ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" /> Uploading {uploadPct}%
                </>
              ) : (
                "Save & get share link"
              )}
            </button>
            <button
              onClick={downloadLocal}
              className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-white/70 hover:bg-white/[0.08]"
            >
              Download file
            </button>
            <button
              onClick={discard}
              disabled={phase === "uploading"}
              className="rounded-xl px-4 py-3 text-sm text-white/40 hover:text-red-400 disabled:opacity-40"
            >
              Discard & re-record
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
