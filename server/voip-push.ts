// VoIP push — the thing that makes an iPhone ring.
//
// 🔴 THREE reasons this cannot go through the existing push path:
//
//  1. Expo's push service does not send VoIP pushes at all. It speaks ordinary
//     alert notifications, which arrive silently, respect Do Not Disturb, and
//     do not wake a closed app. A "call" that behaves like that is a banner.
//  2. A VoIP push must go to the device's PushKit token, which is a DIFFERENT
//     token from the APNs token the device already registered. Sending to the
//     wrong one fails silently — hence device_push_tokens.voip_token.
//  3. APNs requires HTTP/2. Node's global fetch (undici) is HTTP/1.1 only, so
//     this uses node:http2 directly.
//
// 🔴 APPLE'S RULE, and it is enforced by the OS killing the app: every VoIP
// push delivered MUST result in the app reporting an incoming call to CallKit.
// So we only ever send one of these for a real, live, ringing call — never as a
// generic "something happened" nudge, and never for a call that has already
// been answered or cancelled.
//
// Auth is a .p8 token key (ES256), not a legacy VoIP certificate — token auth
// covers VoIP push type, never expires, and one key signs for every app on the
// team.

import crypto from "crypto";
import http2 from "http2";

const KEY_ID = (process.env.APNS_KEY_ID || "").trim();
const TEAM_ID = (process.env.APNS_TEAM_ID || "").trim();
// The full contents of the .p8, newlines and all. In Fly secrets this is set
// with `fly secrets set APNS_PRIVATE_KEY="$(cat AuthKey_XXX.p8)"`.
const PRIVATE_KEY = (process.env.APNS_PRIVATE_KEY || "").replace(/\\n/g, "\n");
const BUNDLE_ID = (process.env.APNS_BUNDLE_ID || "nz.usg.clubos").trim();
// Sandbox for a dev build, production for TestFlight and the App Store.
// TestFlight builds use the PRODUCTION APNs environment — a common and
// invisible way for ringing to "just not work" on a TestFlight build.
const APNS_HOST =
  (process.env.APNS_ENV || "production") === "sandbox"
    ? "https://api.sandbox.push.apple.com"
    : "https://api.push.apple.com";

export function isVoipConfigured(): boolean {
  return Boolean(KEY_ID && TEAM_ID && PRIVATE_KEY);
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Apple throttles providers that mint tokens too often (guidance: no more than
// once every 20 minutes) and rejects tokens older than an hour. Cache one.
let cachedToken: { jwt: string; mintedAt: number } | null = null;

function providerToken(): string {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && now - cachedToken.mintedAt < 30 * 60) return cachedToken.jwt;

  const header = b64url(JSON.stringify({ alg: "ES256", kid: KEY_ID }));
  const payload = b64url(JSON.stringify({ iss: TEAM_ID, iat: now }));
  // ieee-p1363, not DER: a JWT signature is raw r||s, and Node defaults to DER.
  // Getting this wrong yields a token APNs rejects with a bare 403.
  const signature = crypto
    .createSign("SHA256")
    .update(`${header}.${payload}`)
    .sign({ key: PRIVATE_KEY, dsaEncoding: "ieee-p1363" });

  const jwt = `${header}.${payload}.${b64url(signature)}`;
  cachedToken = { jwt, mintedAt: now };
  return jwt;
}

/**
 * 🔴 THIS SHAPE IS A CONTRACT, not our choice.
 *
 * expo-callkit-telecom parses the VoIP push payload NATIVELY, before any
 * JavaScript runs — that is the whole point, because iOS gives the app only
 * milliseconds to report a call to CallKit and cannot wait for a JS bundle to
 * boot. The native parser expects exactly these field names
 * (`IncomingCallEvent` in the module's Calls.types.d.ts). Rename one and the
 * push arrives, the parse fails, no call is reported — and iOS then kills the
 * app for taking a VoIP push without reporting a call.
 *
 * Anything of ours rides in `metadata`, which the module treats as opaque.
 */
export interface VoipCallPayload {
  /** UUID, for dedup — iOS can deliver the same push twice. */
  eventId: string;
  /** Our call id, as a string. The app sends it back to /join. */
  serverCallId: string;
  hasVideo: boolean;
  startedAt?: string;
  caller: {
    id: string;
    displayName?: string;
    avatarUrl?: string;
  };
  metadata?: Record<string, unknown>;
}

export interface VoipSendResult {
  ok: boolean;
  status?: number;
  reason?: string;
  /** APNs told us this device is gone — the caller should retire the token. */
  unregistered?: boolean;
}

/**
 * Send one VoIP push. Resolves rather than throws: a phone that has been wiped
 * must not take down a call to the four people whose phones are fine.
 */
export function sendVoipPush(voipToken: string, payload: VoipCallPayload): Promise<VoipSendResult> {
  if (!isVoipConfigured()) {
    return Promise.resolve({ ok: false, reason: "apns_not_configured" });
  }

  return new Promise((resolve) => {
    let settled = false;
    const done = (r: VoipSendResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    let client: http2.ClientHttp2Session;
    try {
      client = http2.connect(APNS_HOST);
    } catch (err: any) {
      return done({ ok: false, reason: `connect_failed: ${err?.message ?? err}` });
    }

    client.on("error", (err) => {
      done({ ok: false, reason: `session_error: ${err.message}` });
      client.close();
    });

    const body = Buffer.from(JSON.stringify(payload));
    const req = client.request({
      ":method": "POST",
      ":path": `/3/device/${voipToken}`,
      authorization: `bearer ${providerToken()}`,
      // 🔴 The VoIP topic is the bundle id with `.voip` appended. Sending to the
      // bare bundle id gets a 400 BadTopic that reads like a config typo.
      "apns-topic": `${BUNDLE_ID}.voip`,
      "apns-push-type": "voip",
      "apns-priority": "10",
      // Do not let APNs deliver a call 20 minutes late to a phone that was off.
      // A stale ring is worse than a missed one.
      "apns-expiration": String(Math.floor(Date.now() / 1000) + 45),
      "content-type": "application/json",
      "content-length": String(body.length),
    });

    let status = 0;
    let raw = "";

    req.on("response", (headers) => {
      status = Number(headers[":status"]) || 0;
    });
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("error", (err) => {
      done({ ok: false, reason: `request_error: ${err.message}` });
      client.close();
    });
    req.on("end", () => {
      client.close();
      if (status === 200) return done({ ok: true, status });
      let reason = raw;
      try {
        reason = JSON.parse(raw)?.reason ?? raw;
      } catch {
        /* keep the raw body */
      }
      done({
        ok: false,
        status,
        reason,
        // 410 Gone, or 400 BadDeviceToken — this token will never work again.
        unregistered: status === 410 || reason === "BadDeviceToken" || reason === "Unregistered",
      });
    });

    req.setTimeout(8000, () => {
      req.close();
      done({ ok: false, reason: "timeout" });
    });

    req.end(body);
  });
}
