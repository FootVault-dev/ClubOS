// LiveKit — media tokens and room truth for Staff Voice.
//
// A LiveKit access token is just an HS256 JWT signed with the API secret, so
// this is implemented with node:crypto rather than the SDK. Two reasons that
// matter: no new dependency in a bundle that already ships to Fly, and — more
// importantly — minting a token involves NO network call, so a call can never
// half-start because a token request timed out. The row and the token are
// created in the same transaction and either both exist or neither does.
//
// 🔴 The grant in the token is the ONLY thing the media server checks. It does
// not know about staff_channel_members. Everything this module is handed has
// already been through voiceAccess() — never call mintAccessToken() from a path
// that has not.

import crypto from "crypto";
import { MEDIA_TOKEN_TTL_SECONDS } from "@shared/staff-voice";

const API_KEY = process.env.LIVEKIT_API_KEY || "";
const API_SECRET = process.env.LIVEKIT_API_SECRET || "";
// wss://<project>.livekit.cloud — the client connects here.
const WS_URL = (process.env.LIVEKIT_URL || "").trim();

/** The Twirp/HTTP base for server-side calls, derived from the ws URL. */
function httpBase(): string {
  return WS_URL.replace(/^ws:/, "http:").replace(/^wss:/, "https:").replace(/\/+$/, "");
}

/**
 * Voice is OFF until all three are set, and the API says so honestly rather than
 * throwing a 500 into a call button. Everything else in this feature — schema,
 * routes, UI, history — works without them; only the audio itself does not.
 */
export function isLiveKitConfigured(): boolean {
  return Boolean(API_KEY && API_SECRET && WS_URL);
}

export function liveKitWsUrl(): string {
  return WS_URL;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function signJwt(payload: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const signature = crypto
    .createHmac("sha256", API_SECRET)
    .update(`${header}.${body}`)
    .digest();
  return `${header}.${body}.${b64url(signature)}`;
}

export interface MintTokenOptions {
  identity: string;
  name: string;
  roomName: string;
  /** Audio-only for v1. Screen share flips this on for meetings. */
  canPublishScreen?: boolean;
  ttlSeconds?: number;
}

/**
 * A joiner's token. Scoped to ONE room, short-lived, and deliberately without
 * roomAdmin: a participant must not be able to remove other participants or
 * open rooms of their own. Video is off — `canPublishSources` is an allowlist,
 * so a client cannot decide to start a camera we did not grant.
 */
export function mintAccessToken(opts: MintTokenOptions): string {
  if (!isLiveKitConfigured()) {
    throw new Error("LiveKit is not configured");
  }
  const now = Math.floor(Date.now() / 1000);
  const ttl = opts.ttlSeconds ?? MEDIA_TOKEN_TTL_SECONDS;
  const sources = ["microphone"];
  if (opts.canPublishScreen) sources.push("screen_share", "screen_share_audio");

  return signJwt({
    iss: API_KEY,
    sub: opts.identity,
    nbf: now - 10, // small skew allowance; phones' clocks drift
    exp: now + ttl,
    name: opts.name,
    video: {
      room: opts.roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      canPublishSources: sources,
      // Explicitly withheld. Named rather than omitted so the intent survives
      // the next person reading this.
      roomAdmin: false,
      roomCreate: false,
      roomList: false,
    },
  });
}

/** A short-lived server token with the admin grants the Twirp API needs. */
function mintServerToken(roomName?: string): string {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({
    iss: API_KEY,
    sub: "clubos-server",
    nbf: now - 10,
    exp: now + 60,
    video: { roomAdmin: true, roomList: true, ...(roomName ? { room: roomName } : {}) },
  });
}

async function twirp<T>(method: string, body: unknown, roomName?: string): Promise<T | null> {
  if (!isLiveKitConfigured()) return null;
  try {
    const res = await fetch(`${httpBase()}/twirp/livekit.RoomService/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${mintServerToken(roomName)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    // Never let a media-server hiccup take down a page that is mostly history
    // and text. Callers treat null as "could not ask", never as "nobody there".
    return null;
  }
}

export interface LiveKitParticipant {
  identity: string;
  state: string;
  joinedAt: string;
}

/**
 * 🔴 Who is ACTUALLY in the room, according to the media server.
 *
 * This is the authoritative answer and the reason the feature self-heals. A
 * phone that dies mid-call never sends "I left", so left_at stays NULL forever
 * and the room would look permanently occupied — which would also hold the
 * one-live-call-per-channel index and block the next call. Reconciling against
 * this on read fixes that without a cron and without a public webhook endpoint.
 *
 * Returns null when LiveKit could not be reached — which is NOT the same as an
 * empty room, and callers must not treat it as one.
 */
export async function roomParticipants(roomName: string): Promise<LiveKitParticipant[] | null> {
  const out = await twirp<{ participants?: LiveKitParticipant[] }>(
    "ListParticipants",
    { room: roomName },
    roomName,
  );
  if (out == null) return null;
  return out.participants ?? [];
}

/** Hang up on everyone — used when a host ends a call for the whole room. */
export async function deleteRoom(roomName: string): Promise<void> {
  await twirp("DeleteRoom", { room: roomName }, roomName);
}

/** Remove one person (declining from a second device, or a revoked account). */
export async function removeParticipant(roomName: string, identity: string): Promise<void> {
  await twirp("RemoveParticipant", { room: roomName, identity }, roomName);
}
