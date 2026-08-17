// The browser side of a call. Everything LiveKit-specific lives here so the
// React layer above deals in "who is talking, am I muted" and nothing else.
//
// Audio-only by design for v1: we publish a microphone and subscribe to
// everyone else's. No camera is requested, so no browser ever shows a camera
// indicator for a voice call.

import {
  Room,
  RoomEvent,
  Track,
  ConnectionState,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
  type Participant,
} from "livekit-client";

export interface VoicePeer {
  userId: number;
  identity: string;
  name: string;
  isSpeaking: boolean;
  isMuted: boolean;
  isLocal: boolean;
  connectionQuality: string;
}

export interface VoiceRoomState {
  status: "idle" | "connecting" | "connected" | "reconnecting" | "failed";
  peers: VoicePeer[];
  micMuted: boolean;
  error: string | null;
}

function userIdFromIdentity(identity: string): number {
  const m = /^u(\d+)$/.exec(identity || "");
  return m ? Number(m[1]) : 0;
}

export class VoiceRoom {
  private room: Room | null = null;
  private audioEls = new Map<string, HTMLAudioElement>();
  private onChange: (s: VoiceRoomState) => void;
  private state: VoiceRoomState = { status: "idle", peers: [], micMuted: false, error: null };

  constructor(onChange: (s: VoiceRoomState) => void) {
    this.onChange = onChange;
  }

  private emit(patch: Partial<VoiceRoomState> = {}) {
    this.state = { ...this.state, ...patch, peers: this.collectPeers() };
    this.onChange(this.state);
  }

  private collectPeers(): VoicePeer[] {
    if (!this.room) return [];
    const all: Participant[] = [this.room.localParticipant, ...Array.from(this.room.remoteParticipants.values())];
    return all.map((p) => ({
      userId: userIdFromIdentity(p.identity),
      identity: p.identity,
      name: p.name || "Staff",
      isSpeaking: p.isSpeaking,
      // A participant with no published, unmuted mic track is muted. Derived
      // from the tracks rather than a flag we keep in sync ourselves.
      isMuted: !Array.from(p.audioTrackPublications.values()).some((t) => !t.isMuted),
      isLocal: p === this.room!.localParticipant,
      connectionQuality: String(p.connectionQuality ?? "unknown"),
    }));
  }

  async connect(wsUrl: string, token: string): Promise<void> {
    await this.disconnect();
    this.emit({ status: "connecting", error: null });

    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
      // Speech-tuned capture. Without these a staff call in a noisy clubroom is
      // unusable, and they cost nothing.
      audioCaptureDefaults: {
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    this.room = room;

    room
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub: RemoteTrackPublication, p: RemoteParticipant) => {
        if (track.kind !== Track.Kind.Audio) return;
        // Attaching to a real element (rather than the Web Audio graph) is what
        // lets iOS Safari route to the earpiece/speaker properly.
        const el = track.attach() as HTMLAudioElement;
        el.autoplay = true;
        (el as any).playsInline = true;
        el.style.display = "none";
        document.body.appendChild(el);
        this.audioEls.set(p.identity + track.sid, el);
        this.emit();
      })
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, _pub, p: RemoteParticipant) => {
        const key = p.identity + track.sid;
        const el = this.audioEls.get(key);
        if (el) {
          track.detach(el);
          el.remove();
          this.audioEls.delete(key);
        }
        this.emit();
      })
      .on(RoomEvent.ParticipantConnected, () => this.emit())
      .on(RoomEvent.ParticipantDisconnected, () => this.emit())
      .on(RoomEvent.ActiveSpeakersChanged, () => this.emit())
      .on(RoomEvent.TrackMuted, () => this.emit())
      .on(RoomEvent.TrackUnmuted, () => this.emit())
      .on(RoomEvent.ConnectionQualityChanged, () => this.emit())
      .on(RoomEvent.Reconnecting, () => this.emit({ status: "reconnecting" }))
      .on(RoomEvent.Reconnected, () => this.emit({ status: "connected" }))
      .on(RoomEvent.Disconnected, () => {
        this.cleanupAudio();
        this.emit({ status: "idle" });
      });

    try {
      await room.connect(wsUrl, token);
      // Microphone AFTER connect: if the person denies permission we are still
      // in the room and can hear everyone, which is far better than failing the
      // whole call. They get an honest "your mic is blocked" instead.
      try {
        await room.localParticipant.setMicrophoneEnabled(true);
        this.emit({ status: "connected", micMuted: false });
      } catch (micErr: any) {
        this.emit({
          status: "connected",
          micMuted: true,
          error:
            micErr?.name === "NotAllowedError"
              ? "Microphone blocked — you can hear everyone, but they cannot hear you."
              : "Could not start your microphone.",
        });
      }
    } catch (err: any) {
      this.emit({ status: "failed", error: err?.message || "Could not connect to the call" });
      throw err;
    }
  }

  async toggleMic(): Promise<void> {
    if (!this.room || this.room.state !== ConnectionState.Connected) return;
    const next = !this.state.micMuted;
    try {
      await this.room.localParticipant.setMicrophoneEnabled(!next);
      this.emit({ micMuted: next, error: null });
    } catch {
      this.emit({ error: "Could not change your microphone" });
    }
  }

  private cleanupAudio() {
    // Array.from, not a bare for..of over .values(): this tsconfig predates
    // downlevelIteration and the direct form does not compile.
    for (const el of Array.from(this.audioEls.values())) el.remove();
    this.audioEls.clear();
  }

  async disconnect(): Promise<void> {
    this.cleanupAudio();
    if (this.room) {
      try {
        await this.room.disconnect();
      } catch {
        /* already gone */
      }
      this.room = null;
    }
    this.state = { status: "idle", peers: [], micMuted: false, error: null };
    this.onChange(this.state);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Ringtone
// ─────────────────────────────────────────────────────────────────────────────
// Synthesised rather than shipped as an mp3: no asset to load, no autoplay
// fight over a media file, and it stops cleanly. Two tones, UK-ring cadence.
export function createRingtone(): { start: () => void; stop: () => void } {
  let ctx: AudioContext | null = null;
  let timer: number | null = null;

  const burst = () => {
    if (!ctx) return;
    const now = ctx.currentTime;
    for (const [offset, dur] of [[0, 0.4], [0.6, 0.4]] as const) {
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, now + offset);
      gain.gain.linearRampToValueAtTime(0.14, now + offset + 0.03);
      gain.gain.setValueAtTime(0.14, now + offset + dur - 0.05);
      gain.gain.linearRampToValueAtTime(0, now + offset + dur);
      gain.connect(ctx.destination);
      for (const freq of [440, 480]) {
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = freq;
        osc.connect(gain);
        osc.start(now + offset);
        osc.stop(now + offset + dur);
      }
    }
  };

  return {
    start() {
      if (timer != null) return;
      try {
        ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
        // A browser that has never been interacted with will refuse. That is a
        // silent ring, not a broken page — the visual sheet still appears.
        void ctx.resume().catch(() => {});
        burst();
        timer = window.setInterval(burst, 3000);
      } catch {
        /* no audio available */
      }
    },
    stop() {
      if (timer != null) {
        clearInterval(timer);
        timer = null;
      }
      if (ctx) {
        void ctx.close().catch(() => {});
        ctx = null;
      }
    },
  };
}
