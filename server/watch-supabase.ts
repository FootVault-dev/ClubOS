// CIC Watch — server access to the OTT streaming platform.
// The watch platform (watch.cicyouth.com) keeps its data in a SEPARATE Supabase
// project (usg-meet): watch_channels / watch_viewers / watch_access_log. This
// module gives ClubOS's CIC "Watch" tab full management of that platform +
// Cloudflare Stream (live inputs + recordings) — self-contained, no dependency
// on the watch app's own code.
import { createClient } from "@supabase/supabase-js";

const CF_ACCT = process.env.CLOUDFLARE_ACCOUNT_ID || "";
const CF_TOKEN = process.env.CLOUDFLARE_STREAM_TOKEN || "";
const CF_CUSTOMER = process.env.CLOUDFLARE_STREAM_CUSTOMER || "customer-cmfpri2ovjthkmgr";

// Second Supabase client — the usg-meet project, NOT the main clubos one.
export const meetDb = createClient(
  process.env.SUPABASE_MEET_URL || "",
  process.env.SUPABASE_MEET_SERVICE_ROLE_KEY || "",
  { auth: { persistSession: false, autoRefreshToken: false } },
);

// ── Channels (pitches) ───────────────────────────────────────────────────────
export interface WatchChannel {
  id: string;
  key: string;
  name: string;
  field_label: string | null;
  cloudflare_uid: string | null;
  hls_url: string | null;
  status: "live" | "offline";
  require_signed: boolean;
  sort_order: number;
  note: string | null;
  updated_at: string;
}

export async function listChannels(): Promise<WatchChannel[]> {
  const { data, error } = await meetDb
    .from("watch_channels")
    .select("*")
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });
  if (error) throw new Error(error.message);
  return (data as WatchChannel[]) ?? [];
}

export async function getChannel(id: string): Promise<WatchChannel | null> {
  const { data, error } = await meetDb.from("watch_channels").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as WatchChannel) ?? null;
}

export async function upsertChannel(row: Partial<WatchChannel> & { key: string; name: string }): Promise<void> {
  const { error } = await meetDb.from("watch_channels").upsert(
    {
      key: row.key,
      name: row.name,
      field_label: row.field_label ?? null,
      cloudflare_uid: row.cloudflare_uid ?? null,
      hls_url: row.hls_url ?? null,
      status: row.status ?? "offline",
      require_signed: row.require_signed ?? false,
      sort_order: row.sort_order ?? 0,
      note: row.note ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "key" },
  );
  if (error) throw new Error(error.message);
}

export async function setChannelStatus(id: string, status: "live" | "offline"): Promise<void> {
  const { error } = await meetDb
    .from("watch_channels")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(error.message);
}

export async function deleteChannel(id: string): Promise<void> {
  const { error } = await meetDb.from("watch_channels").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

// ── Cloudflare Stream ────────────────────────────────────────────────────────
function cf(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCT}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${CF_TOKEN}`, "Content-Type": "application/json", ...(init?.headers || {}) },
  });
}

export interface LiveInput {
  uid: string;
  rtmpsUrl: string;
  streamKey: string;
  playbackUrl: string;
}

/** Mint a Cloudflare Live Input — the RTMP URL + key go into Veo's custom destination. */
export async function createLiveInput(name: string, requireSigned = false): Promise<LiveInput> {
  const res = await cf(`/stream/live_inputs`, {
    method: "POST",
    body: JSON.stringify({ meta: { name }, recording: { mode: "automatic", requireSignedURLs: requireSigned, timeoutSeconds: 10 } }),
  });
  const body = (await res.json()) as any;
  if (!res.ok || !body.success || !body.result?.rtmps) {
    throw new Error(`createLiveInput: ${res.status} ${(body.errors || []).map((e: any) => e.message).join("; ")}`);
  }
  const r = body.result;
  return {
    uid: r.uid,
    rtmpsUrl: r.rtmps.url,
    streamKey: r.rtmps.streamKey,
    playbackUrl: `https://${CF_CUSTOMER}.cloudflarestream.com/${r.uid}/manifest/video.m3u8`,
  };
}

/** Re-fetch the RTMP creds for an existing input (so the tab can re-show them). */
export async function getInputCreds(uid: string): Promise<{ rtmpsUrl: string; streamKey: string } | null> {
  const res = await cf(`/stream/live_inputs/${uid}`);
  const body = (await res.json()) as any;
  if (!res.ok || !body.result?.rtmps) return null;
  return { rtmpsUrl: body.result.rtmps.url, streamKey: body.result.rtmps.streamKey };
}

/** Is a live input currently receiving a stream? (connected = camera is pushing). */
export async function inputLiveState(uid: string): Promise<string> {
  const res = await cf(`/stream/live_inputs/${uid}`);
  const body = (await res.json()) as any;
  return body?.result?.status?.current?.state ?? "idle";
}

// ── Recordings (Cloudflare auto-records every broadcast) ─────────────────────
export interface Recording {
  videoUid: string;
  channelId: string;
  channelName: string;
  fieldLabel: string | null;
  start: string;
  durationSec: number;
  state: string;
  ready: boolean;
  thumbnail: string;
  name: string | null;
  thumbnailTimestampPct: number;
}

export async function listRecordings(): Promise<Recording[]> {
  const channels = (await listChannels()).filter((c) => c.cloudflare_uid);
  const all: Recording[] = [];
  await Promise.all(
    channels.map(async (ch) => {
      const res = await cf(`/stream/live_inputs/${ch.cloudflare_uid}/videos`);
      if (!res.ok) return;
      const body = (await res.json()) as any;
      for (const v of body.result ?? []) {
        const dur = typeof v.duration === "number" ? v.duration : -1;
        if (dur >= 0 && dur < 60) continue; // skip connection-test stubs
        all.push({
          videoUid: v.uid,
          channelId: ch.id,
          channelName: ch.name,
          fieldLabel: ch.field_label,
          start: v.created,
          durationSec: dur,
          state: v.status?.state ?? "unknown",
          ready: v.readyToStream === true,
          thumbnail: v.thumbnail || `https://${CF_CUSTOMER}.cloudflarestream.com/${v.uid}/thumbnails/thumbnail.jpg`,
          name: v.meta?.name ?? null,
          thumbnailTimestampPct: typeof v.thumbnailTimestampPct === "number" ? v.thumbnailTimestampPct : 0,
        });
      }
    }),
  );
  all.sort((a, b) => b.start.localeCompare(a.start));
  return all;
}

/** Edit a recording's title and/or thumbnail frame (0–1 through the video). */
export async function updateVideo(uid: string, patch: { name?: string; thumbnailTimestampPct?: number }): Promise<void> {
  const bodyObj: any = {};
  if (patch.name !== undefined) bodyObj.meta = { name: patch.name };
  if (patch.thumbnailTimestampPct !== undefined) bodyObj.thumbnailTimestampPct = Math.max(0, Math.min(1, patch.thumbnailTimestampPct));
  const res = await cf(`/stream/${uid}`, { method: "POST", body: JSON.stringify(bodyObj) });
  if (!res.ok) throw new Error(`updateVideo: ${res.status} ${await res.text().catch(() => "")}`);
}

export async function deleteVideo(uid: string): Promise<void> {
  const res = await cf(`/stream/${uid}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw new Error(`deleteVideo: ${res.status}`);
}

// ── Viewers / analytics ──────────────────────────────────────────────────────
export interface Viewer {
  email: string;
  name: string | null;
  phone: string | null;
  dial_code: string | null;
  phone_country: string | null;
  geo_country: string | null;
  created_at: string;
  last_seen_at: string;
  sessions: number;
  signup_source: string | null;
}

export async function adminStats(): Promise<any> {
  const { data, error } = await meetDb.rpc("watch_admin_stats");
  if (error) throw new Error(error.message);
  return data;
}

const VIEWER_COLS = "email,name,phone,dial_code,phone_country,geo_country,created_at,last_seen_at,sessions,signup_source";

export async function recentViewers(limit = 250): Promise<Viewer[]> {
  const { data, error } = await meetDb
    .from("watch_viewers")
    .select(VIEWER_COLS)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data as Viewer[]) ?? [];
}

export async function allViewers(): Promise<Viewer[]> {
  const { data, error } = await meetDb
    .from("watch_viewers")
    .select(VIEWER_COLS)
    .order("created_at", { ascending: false })
    .limit(100000);
  if (error) throw new Error(error.message);
  return (data as Viewer[]) ?? [];
}

// ── Scoreboard overlay (broadcast graphic, controlled from ClubOS) ────────────
export interface Overlay {
  channel_id: string;
  visible: boolean;
  home_name: string; home_abbr: string; home_color: string;
  away_name: string; away_abbr: string; away_color: string;
  home_score: number; away_score: number;
  period: string;
  clock_running: boolean;
  clock_base_ms: number;
  clock_started_at: string | null;
}

function defaultOverlay(channelId: string): Overlay {
  return {
    channel_id: channelId, visible: false,
    home_name: "", home_abbr: "", home_color: "#c9a43e",
    away_name: "", away_abbr: "", away_color: "#3b6fb3",
    home_score: 0, away_score: 0, period: "",
    clock_running: false, clock_base_ms: 0, clock_started_at: null,
  };
}

export async function getOverlay(channelId: string): Promise<Overlay> {
  const { data, error } = await meetDb.from("watch_overlays").select("*").eq("channel_id", channelId).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as Overlay) ?? defaultOverlay(channelId);
}

export async function saveOverlay(channelId: string, patch: Partial<Overlay>): Promise<void> {
  const { channel_id, ...rest } = patch as any;
  const { error } = await meetDb.from("watch_overlays").upsert(
    { channel_id: channelId, ...rest, updated_at: new Date().toISOString() },
    { onConflict: "channel_id" },
  );
  if (error) throw new Error(error.message);
}

/** Clock control that stores base-elapsed + a start timestamp, so the player can
 *  tick locally without per-second writes. op = start | pause | reset | set. */
export async function clockOp(channelId: string, op: string, minutes?: number): Promise<void> {
  const o = await getOverlay(channelId);
  const base = Number(o.clock_base_ms) || 0;
  const runningNow = o.clock_running && o.clock_started_at ? Date.now() - new Date(o.clock_started_at).getTime() : 0;
  const nowIso = new Date().toISOString();
  let patch: Partial<Overlay>;
  if (op === "start") patch = { clock_running: true, clock_started_at: nowIso, clock_base_ms: base };
  else if (op === "pause") patch = { clock_running: false, clock_started_at: null, clock_base_ms: base + runningNow };
  else if (op === "reset") patch = { clock_running: false, clock_started_at: null, clock_base_ms: 0 };
  else if (op === "set") {
    const ms = Math.max(0, Math.round((minutes || 0) * 60000));
    patch = o.clock_running ? { clock_base_ms: ms, clock_started_at: nowIso } : { clock_base_ms: ms };
  } else throw new Error("bad clock op");
  await saveOverlay(channelId, patch);
}
