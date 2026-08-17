// The two things a call puts on screen: the dock you are in, and the sheet that
// rings.
//
// 🔴 Both render through a portal into document.body. A routed page in this app
// keeps a residual transform after its entrance animation finishes, and any
// non-none transform makes that element the containing block for `fixed`
// descendants — which silently turns a full-screen overlay into a box inside the
// page. That bug has been paid for once already in the coaching app.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  Phone,
  PhoneOff,
  Mic,
  MicOff,
  ChevronDown,
  ChevronUp,
  Loader2,
  AlertTriangle,
  Users,
  Signal,
} from "lucide-react";
import { useVoiceOptional, type CallView } from "./voice-provider";
import { formatDuration } from "@shared/staff-voice";

const GOLD = "#c9a43e";

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("") || "?"
  );
}

/** Ticks once a second so the timer moves without re-polling the server. */
function useTicker(active: boolean): number {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => setN((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [active]);
  return Date.now();
}

function callLabel(call: CallView): string {
  if (call.title) return call.title;
  if (call.mode === "direct") {
    const other = call.participants.find((p) => p.userId !== call.startedBy);
    return other?.name ?? call.startedByName;
  }
  if (call.mode === "channel") return "Voice channel";
  if (call.mode === "meeting") return "Meeting";
  return "Group call";
}

function Avatar({ name, url, speaking }: { name: string; url: string | null; speaking: boolean }) {
  return (
    <div
      className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white"
      style={{
        background: url ? undefined : "#1f2937",
        // A speaking ring rather than a waveform: it reads instantly at this
        // size and costs no animation frames.
        boxShadow: speaking ? `0 0 0 2px ${GOLD}` : "none",
      }}
    >
      {url ? (
        <img src={url} alt={name} className="h-9 w-9 rounded-full object-cover" />
      ) : (
        <span>{initials(name)}</span>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The dock — visible for as long as you are in a call, on every page.
// ─────────────────────────────────────────────────────────────────────────────
export function CallDock() {
  const voice = useVoiceOptional();
  const [expanded, setExpanded] = useState(false);
  const active = voice?.activeCall ?? null;
  const connecting = voice?.room.status === "connecting";
  useTicker(Boolean(active));

  if (!voice || (!active && !connecting)) return null;

  const { room, toggleMic, leaveCall, endCall } = voice;
  const peers = room.peers;
  const startedAt = active ? new Date(active.startedAt).getTime() : Date.now();
  const elapsed = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  const canEndForAll = Boolean(active && active.mode !== "channel");

  return createPortal(
    <div className="fixed bottom-4 right-4 z-[60] w-[min(92vw,360px)]">
      <div className="overflow-hidden rounded-2xl border border-white/10 bg-[#0b1220] text-white shadow-[0_18px_50px_-12px_rgba(0,0,0,0.7)]">
        {/* Header */}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-white/5"
        >
          <span className="relative flex h-2.5 w-2.5 shrink-0">
            <span
              className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60"
              style={{ background: room.status === "reconnecting" ? "#f59e0b" : "#22c55e" }}
            />
            <span
              className="relative inline-flex h-2.5 w-2.5 rounded-full"
              style={{ background: room.status === "reconnecting" ? "#f59e0b" : "#22c55e" }}
            />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold">
              {active ? callLabel(active) : "Connecting…"}
            </span>
            <span className="block text-xs text-white/55">
              {room.status === "reconnecting"
                ? "Reconnecting…"
                : connecting
                  ? "Connecting…"
                  : `${formatDuration(elapsed)} · ${peers.length} ${peers.length === 1 ? "person" : "people"}`}
            </span>
          </span>
          {expanded ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-white/50" />
          ) : (
            <ChevronUp className="h-4 w-4 shrink-0 text-white/50" />
          )}
        </button>

        {room.error && (
          <div className="flex items-start gap-2 border-t border-amber-500/20 bg-amber-500/10 px-4 py-2 text-xs text-amber-200">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{room.error}</span>
          </div>
        )}

        {expanded && peers.length > 0 && (
          <div className="max-h-56 space-y-1 overflow-y-auto border-t border-white/10 px-3 py-2">
            {peers.map((p) => (
              <div key={p.identity} className="flex items-center gap-3 rounded-lg px-1 py-1.5">
                <Avatar name={p.name} url={null} speaking={p.isSpeaking} />
                <span className="min-w-0 flex-1 truncate text-sm">
                  {p.name}
                  {p.isLocal && <span className="ml-1 text-white/40">(you)</span>}
                </span>
                {p.connectionQuality === "poor" && (
                  <Signal className="h-3.5 w-3.5 shrink-0 text-amber-400" aria-label="Poor connection" />
                )}
                {p.isMuted ? (
                  <MicOff className="h-4 w-4 shrink-0 text-white/35" />
                ) : (
                  <Mic className="h-4 w-4 shrink-0" style={{ color: p.isSpeaking ? GOLD : "rgba(255,255,255,0.5)" }} />
                )}
              </div>
            ))}
          </div>
        )}

        {/* Controls */}
        <div className="flex items-center gap-2 border-t border-white/10 px-3 py-3">
          <button
            type="button"
            onClick={toggleMic}
            disabled={connecting}
            className="flex h-10 flex-1 items-center justify-center gap-2 rounded-xl text-sm font-medium transition-colors disabled:opacity-40"
            style={{
              background: room.micMuted ? "rgba(239,68,68,0.15)" : "rgba(255,255,255,0.08)",
              color: room.micMuted ? "#fca5a5" : "white",
            }}
          >
            {room.micMuted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
            {room.micMuted ? "Unmute" : "Mute"}
          </button>

          <button
            type="button"
            onClick={() => void leaveCall()}
            className="flex h-10 flex-1 items-center justify-center gap-2 rounded-xl bg-red-500/90 text-sm font-semibold text-white transition-colors hover:bg-red-500"
          >
            <PhoneOff className="h-4 w-4" />
            Leave
          </button>
        </div>

        {canEndForAll && (
          <button
            type="button"
            onClick={() => void endCall()}
            className="w-full border-t border-white/10 px-4 py-2 text-xs text-white/45 transition-colors hover:bg-white/5 hover:text-white/70"
          >
            End for everyone
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The ring
// ─────────────────────────────────────────────────────────────────────────────
export function IncomingCallSheet() {
  const voice = useVoiceOptional();
  const incoming = voice?.incoming ?? null;
  if (!voice || !incoming) return null;

  const { joinCall, declineCall, busy } = voice;
  const caller = incoming.startedByName;
  const context =
    incoming.mode === "direct"
      ? "Incoming call"
      : incoming.title
        ? `Incoming · ${incoming.title}`
        : "Incoming group call";

  return createPortal(
    <div className="fixed inset-x-0 top-0 z-[70] flex justify-center px-3 pt-3 sm:pt-6">
      <div className="w-full max-w-sm overflow-hidden rounded-2xl border border-white/10 bg-[#0b1220] text-white shadow-[0_24px_60px_-12px_rgba(0,0,0,0.8)]">
        <div className="flex items-center gap-3 px-5 pb-4 pt-5">
          <div
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-sm font-bold text-black"
            style={{ background: GOLD }}
          >
            {initials(caller)}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-base font-semibold">{caller}</p>
            <p className="text-xs text-white/55">{context}</p>
          </div>
          {incoming.mode !== "direct" && (
            <span className="flex items-center gap-1 rounded-full bg-white/8 px-2 py-1 text-[11px] text-white/60">
              <Users className="h-3 w-3" />
              {incoming.participants.filter((p) => p.present).length}
            </span>
          )}
        </div>

        <div className="flex gap-2 px-4 pb-4">
          <button
            type="button"
            onClick={() => void declineCall(incoming.id)}
            className="flex h-12 flex-1 items-center justify-center gap-2 rounded-xl bg-white/8 text-sm font-semibold transition-colors hover:bg-white/12"
          >
            <PhoneOff className="h-4 w-4" />
            Decline
          </button>
          <button
            type="button"
            onClick={() => void joinCall(incoming.id)}
            disabled={busy}
            className="flex h-12 flex-1 items-center justify-center gap-2 rounded-xl bg-green-500 text-sm font-semibold text-white transition-colors hover:bg-green-400 disabled:opacity-60"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Phone className="h-4 w-4" />}
            Accept
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Mount once, next to each other, at app level. */
export function VoiceOverlays() {
  return (
    <>
      <IncomingCallSheet />
      <CallDock />
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The button in a conversation header
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Renders nothing at all when voice is not configured — an inert call button is
 * worse than no call button, because someone will press it in front of a
 * colleague. Turns into "Join" when a call is already running in this room, so
 * two people never end up in two rooms.
 */
export function CallButton({
  channel,
}: {
  channel: { id: number; kind: "channel" | "dm"; postPolicy?: string; voiceEnabled?: boolean };
}) {
  const voice = useVoiceOptional();
  if (!voice?.config?.enabled) return null;

  const { activeCall, occupantsFor, startCall, joinCall, busy } = voice;
  const here = occupantsFor(channel.id);
  const liveHere = here?.callId != null;
  const alreadyIn = activeCall?.channelId === channel.id;

  if (alreadyIn) {
    return (
      <span className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-semibold text-green-400">
        <Phone className="h-4 w-4" />
        In call
      </span>
    );
  }

  const onClick = () => {
    if (liveHere && here?.callId != null) void joinCall(here.callId);
    else void startCall({ channelId: channel.id, mode: channel.kind === "dm" ? "direct" : "group" });
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      title={liveHere ? "Join the call in this conversation" : "Start a call"}
      className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 transition-colors hover:bg-white/[0.06] disabled:opacity-40"
      style={{ color: liveHere ? "#4ade80" : "rgba(255,255,255,0.45)" }}
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Phone className="h-4 w-4" />}
      <span className="text-[12px] font-semibold">
        {liveHere ? `Join · ${here!.occupants.length}` : "Call"}
      </span>
    </button>
  );
}

/**
 * The people currently sitting in a channel's voice room, for the sidebar.
 * Renders nothing when the room is empty — a permanent "0 in voice" row is
 * noise on every channel in the list.
 */
export function VoiceChannelOccupants({ channelId }: { channelId: number }) {
  const voice = useVoiceOptional();
  const here = voice?.occupantsFor(channelId);
  if (!voice?.config?.enabled || !here || here.occupants.length === 0) return null;

  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-1 pl-6">
      {here.occupants.slice(0, 5).map((o) => (
        <span
          key={o.userId}
          title={o.name}
          className="flex h-5 w-5 items-center justify-center rounded-full bg-white/10 text-[9px] font-semibold text-white/70"
        >
          {initials(o.name)}
        </span>
      ))}
      {here.occupants.length > 5 && (
        <span className="text-[10px] text-white/40">+{here.occupants.length - 5}</span>
      )}
    </div>
  );
}
