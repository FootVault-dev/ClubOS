/* Screen/camera recorder engine — the Loom-style capture core.
 *
 * Pure browser-API module, no React. Three modes:
 *   screen         — records the display stream's video track directly (no canvas
 *                    round-trip, so the screen stays pixel-crisp) + mixed audio.
 *   screen-camera  — composites a circular webcam bubble onto a canvas each frame
 *                    (the bubble is baked into the file, Loom-style: one flat video
 *                    that plays anywhere, downloads as-is, and needs no player tricks).
 *   camera         — records the webcam + mic directly.
 *
 * Audio is always mixed through an AudioContext (mic + tab/system audio when the
 * user ticked "share audio") — MediaRecorder only records ONE audio track, so two
 * sources must be mixed, not concatenated.
 *
 * Chunks are collected with a 2s timeslice; Chrome spills large Blobs to disk, so
 * long recordings do not sit in RAM. Elapsed time is wall-clock (performance.now()
 * minus paused spans) — never inferred from chunk counts, which drift.
 */

export type RecorderMode = "screen" | "screen-camera" | "camera";
export type BubbleCorner = "bottom-left" | "bottom-right" | "top-left" | "top-right";
export type BubbleSize = "sm" | "md" | "lg";
export type RecorderState = "idle" | "acquiring" | "countdown" | "recording" | "paused" | "stopped" | "error";

export interface RecorderOptions {
  mode: RecorderMode;
  micDeviceId?: string;      // undefined → default mic; null-like "" → no mic
  micEnabled: boolean;
  cameraDeviceId?: string;
  bubbleCorner: BubbleCorner;
  bubbleSize: BubbleSize;
  /** Max long-edge for the composite canvas. Screen-only mode records native. */
  maxCompositeEdge?: number; // default 1920
}

export interface RecordingResult {
  blob: Blob;
  mimeType: string;
  durationSeconds: number;
}

/** Diameter of the camera bubble as a fraction of canvas height. */
const BUBBLE_FRACTION: Record<BubbleSize, number> = { sm: 0.17, md: 0.24, lg: 0.33 };
const BUBBLE_MARGIN = 24;

/** First supported mime wins. Stream transcodes server-side, so container variety is fine. */
export function pickMimeType(): string {
  const ladder = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
    "video/mp4", // Safari 14.1+
  ];
  for (const m of ladder) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch {
      /* isTypeSupported can throw on ancient browsers */
    }
  }
  return "";
}

export interface RecorderEvents {
  onState?: (state: RecorderState) => void;
  /** Fires ~4×/second while recording with elapsed seconds (paused time excluded). */
  onTick?: (elapsedSeconds: number) => void;
  /** The user hit the browser's own "Stop sharing" bar, or a track died. */
  onExternalStop?: () => void;
  onError?: (message: string) => void;
}

export class ScreenRecorder {
  private opts: RecorderOptions;
  private events: RecorderEvents;

  private displayStream: MediaStream | null = null;
  private cameraStream: MediaStream | null = null;
  private micStream: MediaStream | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private screenVideo: HTMLVideoElement | null = null;
  private cameraVideo: HTMLVideoElement | null = null;
  private audioCtx: AudioContext | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private rafId = 0;
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  private startedAt = 0;
  private pausedAt = 0;
  private pausedTotal = 0;
  private mimeType = "";
  private stopResolve: ((r: RecordingResult) => void) | null = null;

  public state: RecorderState = "idle";
  /** Live-updatable bubble placement (drag support): fractions of canvas size. */
  public bubbleX: number | null = null;
  public bubbleY: number | null = null;
  public cameraHidden = false;

  constructor(opts: RecorderOptions, events: RecorderEvents = {}) {
    this.opts = opts;
    this.events = events;
  }

  private setState(s: RecorderState) {
    this.state = s;
    this.events.onState?.(s);
  }

  /** The camera preview stream, for the setup screen + live bubble preview. */
  get cameraPreviewStream(): MediaStream | null {
    return this.cameraStream;
  }

  get elapsedSeconds(): number {
    if (!this.startedAt) return 0;
    const until = this.state === "paused" ? this.pausedAt : performance.now();
    return Math.max(0, (until - this.startedAt - this.pausedTotal) / 1000);
  }

  /** Acquire devices/screen. Separate from start() so the UI can show a setup
   *  preview and a countdown between permission grant and recording. */
  async acquire(): Promise<void> {
    this.setState("acquiring");
    try {
      if (this.opts.mode !== "camera") {
        this.displayStream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: 30 },
          audio: true, // tab/system audio when the user ticks it; harmless otherwise
        });
        // Browser's own "Stop sharing" bar must end the recording gracefully.
        this.displayStream.getVideoTracks()[0]?.addEventListener("ended", () => {
          if (this.state === "recording" || this.state === "paused") {
            this.events.onExternalStop?.();
            void this.stop();
          }
        });
      }
      if (this.opts.mode !== "screen") {
        this.cameraStream = await navigator.mediaDevices.getUserMedia({
          video: {
            deviceId: this.opts.cameraDeviceId ? { exact: this.opts.cameraDeviceId } : undefined,
            width: { ideal: this.opts.mode === "camera" ? 1920 : 960 },
            height: { ideal: this.opts.mode === "camera" ? 1080 : 720 },
            frameRate: { ideal: 30 },
          },
          audio: false,
        });
      }
      if (this.opts.micEnabled) {
        this.micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: this.opts.micDeviceId ? { exact: this.opts.micDeviceId } : undefined,
            echoCancellation: true,
            noiseSuppression: true,
          },
          video: false,
        });
      }
    } catch (err) {
      this.releaseStreams();
      this.setState("error");
      const name = (err as DOMException)?.name;
      this.events.onError?.(
        name === "NotAllowedError"
          ? "Permission was declined. Allow screen/camera access and try again."
          : `Could not start capture: ${(err as Error)?.message || name || "unknown error"}`
      );
      throw err;
    }
  }

  /** Begin recording (call after acquire(), typically after a 3-2-1 countdown). */
  start(): void {
    const videoStream = this.buildVideoStream();
    const audioTrack = this.buildMixedAudioTrack();
    const tracks = [...videoStream.getVideoTracks()];
    if (audioTrack) tracks.push(audioTrack);
    const combined = new MediaStream(tracks);

    this.mimeType = pickMimeType();
    this.recorder = new MediaRecorder(combined, {
      ...(this.mimeType ? { mimeType: this.mimeType } : {}),
      videoBitsPerSecond: 8_000_000,
      audioBitsPerSecond: 128_000,
    });
    this.chunks = [];
    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.onstop = () => this.finalize();
    this.recorder.start(2000);

    this.startedAt = performance.now();
    this.pausedTotal = 0;
    this.tickTimer = setInterval(() => this.events.onTick?.(this.elapsedSeconds), 250);
    this.setState("recording");
  }

  pause(): void {
    if (this.state !== "recording" || !this.recorder) return;
    this.recorder.pause();
    this.pausedAt = performance.now();
    this.setState("paused");
  }

  resume(): void {
    if (this.state !== "paused" || !this.recorder) return;
    this.recorder.resume();
    this.pausedTotal += performance.now() - this.pausedAt;
    this.setState("recording");
  }

  /** Stop and resolve with the final blob. */
  stop(): Promise<RecordingResult> {
    return new Promise((resolve) => {
      if (!this.recorder || this.state === "stopped" || this.state === "idle") {
        resolve({ blob: new Blob(this.chunks, { type: this.mimeType || "video/webm" }), mimeType: this.mimeType, durationSeconds: this.elapsedSeconds });
        return;
      }
      if (this.state === "paused") {
        // resume paused-time bookkeeping so duration is correct
        this.pausedTotal += performance.now() - this.pausedAt;
      }
      this.stopResolve = resolve;
      this.recorder.stop();
    });
  }

  /** Abandon the take entirely. */
  cancel(): void {
    try {
      if (this.recorder && this.recorder.state !== "inactive") {
        this.recorder.ondataavailable = null;
        this.recorder.onstop = null;
        this.recorder.stop();
      }
    } catch { /* already stopped */ }
    this.chunks = [];
    this.teardown();
    this.setState("idle");
  }

  private finalize(): void {
    const duration = this.elapsedSeconds;
    const blob = new Blob(this.chunks, { type: this.mimeType || "video/webm" });
    this.teardown();
    this.setState("stopped");
    this.stopResolve?.({ blob, mimeType: this.mimeType || "video/webm", durationSeconds: duration });
    this.stopResolve = null;
  }

  /* ---------- internals ---------- */

  private buildVideoStream(): MediaStream {
    if (this.opts.mode === "camera") return this.cameraStream!;
    if (this.opts.mode === "screen" || !this.cameraStream) return this.displayStream!;
    return this.buildComposite();
  }

  /** Canvas composite: screen + circular camera bubble, 30fps. */
  private buildComposite(): MediaStream {
    const settings = this.displayStream!.getVideoTracks()[0].getSettings();
    const maxEdge = this.opts.maxCompositeEdge ?? 1920;
    let w = settings.width || 1920;
    let h = settings.height || 1080;
    if (Math.max(w, h) > maxEdge) {
      const scale = maxEdge / Math.max(w, h);
      w = Math.round(w * scale);
      h = Math.round(h * scale);
    }
    // even dimensions keep encoders happy
    w -= w % 2;
    h -= h % 2;

    this.canvas = document.createElement("canvas");
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx = this.canvas.getContext("2d", { alpha: false })!;

    this.screenVideo = this.attachVideo(this.displayStream!);
    this.cameraVideo = this.attachVideo(this.cameraStream!);

    const draw = () => {
      const ctx = this.ctx!;
      ctx.drawImage(this.screenVideo!, 0, 0, w, h);
      if (!this.cameraHidden && this.cameraVideo!.readyState >= 2) {
        const d = Math.round(h * BUBBLE_FRACTION[this.opts.bubbleSize]);
        const { x, y } = this.bubblePosition(w, h, d);
        ctx.save();
        ctx.beginPath();
        ctx.arc(x + d / 2, y + d / 2, d / 2, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        // cover-fit the camera frame into the circle
        const vw = this.cameraVideo!.videoWidth || 960;
        const vh = this.cameraVideo!.videoHeight || 720;
        const s = Math.max(d / vw, d / vh);
        ctx.drawImage(this.cameraVideo!, x - (vw * s - d) / 2, y - (vh * s - d) / 2, vw * s, vh * s);
        ctx.restore();
        // subtle ring
        ctx.beginPath();
        ctx.arc(x + d / 2, y + d / 2, d / 2, 0, Math.PI * 2);
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(255,255,255,0.85)";
        ctx.stroke();
      }
      this.rafId = requestAnimationFrame(draw);
    };
    this.rafId = requestAnimationFrame(draw);
    return this.canvas.captureStream(30);
  }

  private bubblePosition(w: number, h: number, d: number): { x: number; y: number } {
    if (this.bubbleX !== null && this.bubbleY !== null) {
      return {
        x: Math.min(Math.max(0, this.bubbleX * w - d / 2), w - d),
        y: Math.min(Math.max(0, this.bubbleY * h - d / 2), h - d),
      };
    }
    const c = this.opts.bubbleCorner;
    const x = c.includes("left") ? BUBBLE_MARGIN : w - d - BUBBLE_MARGIN;
    const y = c.includes("top") ? BUBBLE_MARGIN : h - d - BUBBLE_MARGIN;
    return { x, y };
  }

  private attachVideo(stream: MediaStream): HTMLVideoElement {
    const v = document.createElement("video");
    v.srcObject = stream;
    v.muted = true;
    v.playsInline = true;
    void v.play();
    return v;
  }

  /** Mix mic + tab/system audio into one track (MediaRecorder takes ONE audio track). */
  private buildMixedAudioTrack(): MediaStreamTrack | null {
    const sources: MediaStream[] = [];
    if (this.micStream && this.micStream.getAudioTracks().length) sources.push(this.micStream);
    if (this.displayStream && this.displayStream.getAudioTracks().length) sources.push(this.displayStream);
    if (!sources.length) return null;
    if (sources.length === 1 && sources[0] === this.micStream) {
      // single source: no mixing needed, avoid the AudioContext entirely
      return this.micStream.getAudioTracks()[0];
    }
    this.audioCtx = new AudioContext();
    const dest = this.audioCtx.createMediaStreamDestination();
    for (const s of sources) {
      this.audioCtx.createMediaStreamSource(s).connect(dest);
    }
    return dest.stream.getAudioTracks()[0];
  }

  private releaseStreams(): void {
    for (const s of [this.displayStream, this.cameraStream, this.micStream]) {
      s?.getTracks().forEach((t) => t.stop());
    }
    this.displayStream = this.cameraStream = this.micStream = null;
  }

  private teardown(): void {
    cancelAnimationFrame(this.rafId);
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    void this.audioCtx?.close().catch(() => undefined);
    this.audioCtx = null;
    this.releaseStreams();
    this.screenVideo = this.cameraVideo = null;
    this.canvas = null;
    this.ctx = null;
    this.recorder = null;
  }
}

export function formatClock(totalSeconds: number): string {
  const s = Math.floor(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}
