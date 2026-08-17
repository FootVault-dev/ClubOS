// Staff Voice — the React layer.
//
// 🔴 Mounted ONCE at app level, not inside the chat page. A call has to survive
// clicking through to Registrations; if the provider lived in the chat route,
// navigating away would unmount the room and hang up on whoever you were
// talking to. This is the same reason the call dock is a fixed overlay rather
// than part of the conversation pane.
//
// Transport is polling, matching chat: two Fly machines share no memory, so the
// database is the bus. 3s while something is happening, 10s when idle — a
// ringing phone cannot wait 10 seconds to find out the caller hung up.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { VoiceRoom, createRingtone, type VoiceRoomState } from "@/lib/voice-room";
import type { StaffCallMode } from "@shared/staff-voice";

export interface CallParticipantView {
  userId: number;
  name: string;
  avatarUrl: string | null;
  present: boolean;
  invited: boolean;
  declined: boolean;
  joinedAt: string | null;
}

export interface CallView {
  id: number;
  mode: StaffCallMode;
  channelId: number | null;
  title: string | null;
  startedBy: number;
  startedByName: string;
  startedAt: string;
  endedAt: string | null;
  live: boolean;
  durationSec: number;
  ringingForMe: boolean;
  outcomeForMe: string | null;
  participants: CallParticipantView[];
}

export interface VoiceChannelView {
  channelId: number;
  callId: number | null;
  occupants: { userId: number; name: string; avatarUrl: string | null }[];
}

interface VoiceConfig {
  enabled: boolean;
  wsUrl: string | null;
  voipReady: boolean;
  maxParticipants: number;
}

interface VoiceContextValue {
  config: VoiceConfig | null;
  /** The call this browser is actually connected to. */
  activeCall: CallView | null;
  room: VoiceRoomState;
  /** Someone is ringing me right now. */
  incoming: CallView | null;
  voiceChannels: VoiceChannelView[];
  busy: boolean;
  startCall: (opts: { channelId: number; mode?: StaffCallMode; inviteeIds?: number[]; title?: string }) => Promise<void>;
  joinCall: (callId: number) => Promise<void>;
  declineCall: (callId: number) => Promise<void>;
  leaveCall: () => Promise<void>;
  endCall: () => Promise<void>;
  toggleMic: () => void;
  occupantsFor: (channelId: number) => VoiceChannelView | undefined;
}

const VoiceContext = createContext<VoiceContextValue | null>(null);

export function useVoice(): VoiceContextValue {
  const ctx = useContext(VoiceContext);
  if (!ctx) {
    throw new Error("useVoice must be used inside <VoiceProvider>");
  }
  return ctx;
}

/** Safe variant for components that may render outside the provider. */
export function useVoiceOptional(): VoiceContextValue | null {
  return useContext(VoiceContext);
}

export function VoiceProvider({ children, meId }: { children: React.ReactNode; meId: number | null }) {
  const { toast } = useToast();
  const [roomState, setRoomState] = useState<VoiceRoomState>({
    status: "idle",
    peers: [],
    micMuted: false,
    error: null,
  });
  const [activeCallId, setActiveCallId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const roomRef = useRef<VoiceRoom | null>(null);
  if (!roomRef.current) roomRef.current = new VoiceRoom(setRoomState);
  const ringtoneRef = useRef<ReturnType<typeof createRingtone> | null>(null);
  if (!ringtoneRef.current) ringtoneRef.current = createRingtone();

  const { data: config } = useQuery<VoiceConfig>({
    queryKey: ["/api/admin/voice/config"],
    enabled: meId != null,
    staleTime: 5 * 60 * 1000,
  });

  const inACall = activeCallId != null || roomState.status === "connecting";

  const { data: state } = useQuery<{ calls: CallView[]; voiceChannels: VoiceChannelView[] }>({
    queryKey: ["/api/admin/voice/state"],
    enabled: Boolean(meId != null && config?.enabled),
    refetchInterval: inACall ? 3000 : 10000,
    refetchIntervalInBackground: true,
  });

  const calls = state?.calls ?? [];
  const voiceChannels = state?.voiceChannels ?? [];

  const activeCall = useMemo(() => calls.find((c) => c.id === activeCallId) ?? null, [calls, activeCallId]);
  const incoming = useMemo(
    () => calls.find((c) => c.ringingForMe && c.id !== activeCallId) ?? null,
    [calls, activeCallId],
  );

  // Ring while something is ringing, and stop the moment it is not — including
  // when the caller gives up, which arrives as the call simply disappearing.
  useEffect(() => {
    const tone = ringtoneRef.current!;
    if (incoming) tone.start();
    else tone.stop();
    return () => tone.stop();
  }, [incoming]);

  // The call I am in ended somewhere else (host hung up, everyone left).
  // Tear the room down rather than sitting in a dead room looking connected.
  useEffect(() => {
    if (activeCallId == null) return;
    if (!state) return;
    const stillLive = calls.some((c) => c.id === activeCallId && c.live);
    if (!stillLive) {
      void roomRef.current!.disconnect();
      setActiveCallId(null);
    }
  }, [state, calls, activeCallId]);

  // Leaving the page mid-call should hang up, not leave a ghost in the room.
  // (The server reconciles against LiveKit anyway — this just makes it instant.)
  useEffect(() => {
    const onUnload = () => {
      if (activeCallId != null) {
        navigator.sendBeacon?.(`/api/admin/voice/calls/${activeCallId}/leave`);
      }
    };
    window.addEventListener("pagehide", onUnload);
    return () => window.removeEventListener("pagehide", onUnload);
  }, [activeCallId]);

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["/api/admin/voice/state"] });
  }, []);

  const connectTo = useCallback(
    async (callId: number) => {
      const res = await apiRequest("POST", `/api/admin/voice/calls/${callId}/join`);
      const { token, wsUrl } = await res.json();
      await roomRef.current!.connect(wsUrl, token);
      setActiveCallId(callId);
      refresh();
    },
    [refresh],
  );

  const startCall = useCallback(
    async (opts: { channelId: number; mode?: StaffCallMode; inviteeIds?: number[]; title?: string }) => {
      if (busy) return;
      setBusy(true);
      try {
        const res = await apiRequest("POST", "/api/admin/voice/calls", {
          channelId: opts.channelId,
          mode: opts.mode ?? "direct",
          inviteeIds: opts.inviteeIds,
          title: opts.title,
          // Retry-safe: a double-click sends the same id and gets the same call
          // back instead of ringing everyone twice.
          clientCallId:
            globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.round(Math.random() * 1e9)}`,
        });
        const { call } = await res.json();
        await connectTo(call.id);
      } catch (err: any) {
        toast({
          title: "Could not start the call",
          description: err?.message ?? "Something went wrong",
          variant: "destructive",
        });
      } finally {
        setBusy(false);
      }
    },
    [busy, connectTo, toast],
  );

  const joinCall = useCallback(
    async (callId: number) => {
      if (busy) return;
      setBusy(true);
      ringtoneRef.current!.stop();
      try {
        await connectTo(callId);
      } catch (err: any) {
        toast({
          title: "Could not join",
          description: err?.message ?? "That call may have ended",
          variant: "destructive",
        });
      } finally {
        setBusy(false);
      }
    },
    [busy, connectTo, toast],
  );

  const declineCall = useCallback(
    async (callId: number) => {
      ringtoneRef.current!.stop();
      try {
        await apiRequest("POST", `/api/admin/voice/calls/${callId}/decline`);
      } catch {
        /* declining is best-effort — the ring times out on its own */
      }
      refresh();
    },
    [refresh],
  );

  const leaveCall = useCallback(async () => {
    const id = activeCallId;
    setActiveCallId(null);
    await roomRef.current!.disconnect();
    if (id != null) {
      try {
        await apiRequest("POST", `/api/admin/voice/calls/${id}/leave`);
      } catch {
        /* the server reconciles against LiveKit regardless */
      }
    }
    refresh();
  }, [activeCallId, refresh]);

  const endCall = useCallback(async () => {
    const id = activeCallId;
    setActiveCallId(null);
    await roomRef.current!.disconnect();
    if (id != null) {
      try {
        await apiRequest("POST", `/api/admin/voice/calls/${id}/end`);
      } catch (err: any) {
        toast({ title: "Could not end the call", description: err?.message, variant: "destructive" });
      }
    }
    refresh();
  }, [activeCallId, refresh, toast]);

  const toggleMic = useCallback(() => {
    void roomRef.current!.toggleMic();
  }, []);

  const occupantsFor = useCallback(
    (channelId: number) => voiceChannels.find((v) => v.channelId === channelId),
    [voiceChannels],
  );

  const value: VoiceContextValue = {
    config: config ?? null,
    activeCall,
    room: roomState,
    incoming,
    voiceChannels,
    busy,
    startCall,
    joinCall,
    declineCall,
    leaveCall,
    endCall,
    toggleMic,
    occupantsFor,
  };

  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>;
}
