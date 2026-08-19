// Prove the LiveKit credentials actually work — BEFORE the migration, before
// the deploy, before anyone taps a call button in front of a colleague.
//
//   npx tsx --env-file=.env script/_verify-livekit.ts
//
// This does a real round trip against LiveKit: mints a server token, lists
// rooms, creates a room, finds it, deletes it. A key that is merely *present*
// proves nothing — a typo'd secret produces a token that looks perfectly valid
// and is rejected only at the moment someone tries to join a call.
//
// Touches nothing in our database and nothing on prod.

import crypto from "crypto";

const KEY = (process.env.LIVEKIT_API_KEY || "").trim();
const SECRET = (process.env.LIVEKIT_API_SECRET || "").trim();
const URL_RAW = (process.env.LIVEKIT_URL || "").trim();

let failures = 0;
const ok = (msg: string) => console.log(`  ok   ${msg}`);
const bad = (msg: string) => {
  failures++;
  console.log(` FAIL  ${msg}`);
};

console.log("\nLiveKit credential check\n");

// ── 1. Present and shaped right ──────────────────────────────────────────
if (!KEY) bad("LIVEKIT_API_KEY is missing from .env");
else if (!/^API/.test(KEY)) bad(`LIVEKIT_API_KEY looks wrong — LiveKit keys start with "API" (got "${KEY.slice(0, 6)}…")`);
else ok(`LIVEKIT_API_KEY present (${KEY.slice(0, 7)}…)`);

if (!SECRET) bad("LIVEKIT_API_SECRET is missing from .env");
else if (SECRET.length < 30) bad(`LIVEKIT_API_SECRET looks truncated (${SECRET.length} chars — expect ~40+)`);
else ok(`LIVEKIT_API_SECRET present (${SECRET.length} chars)`);

if (!URL_RAW) {
  bad("LIVEKIT_URL is missing from .env");
} else if (!/^wss:\/\//.test(URL_RAW)) {
  // The dashboard shows this as wss://. Pasting the https:// form is the single
  // most common mistake and the browser fails with an opaque connection error.
  bad(`LIVEKIT_URL must start with wss:// (got "${URL_RAW.slice(0, 12)}…")`);
} else if (/\/$/.test(URL_RAW)) {
  ok(`LIVEKIT_URL present (trailing slash will be trimmed)`);
} else {
  ok(`LIVEKIT_URL present (${URL_RAW})`);
}

if (failures) {
  console.error(`\n${failures} problem(s) with the values themselves — fix .env and re-run.\n`);
  process.exit(1);
}

// ── 2. Do LiveKit's servers accept them? ─────────────────────────────────
const httpBase = URL_RAW.replace(/^wss:/, "https:").replace(/^ws:/, "http:").replace(/\/+$/, "");

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function serverToken(): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(
    JSON.stringify({
      iss: KEY,
      sub: "clubos-verify",
      nbf: now - 10,
      exp: now + 60,
      video: { roomAdmin: true, roomList: true, roomCreate: true },
    }),
  );
  const sig = crypto.createHmac("sha256", SECRET).update(`${header}.${body}`).digest();
  return `${header}.${body}.${b64url(sig)}`;
}

async function twirp(method: string, body: unknown): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(`${httpBase}/twirp/livekit.RoomService/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${serverToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(10000),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep the raw text */
  }
  return { status: res.status, json, text };
}

console.log(`\nTalking to ${httpBase}\n`);

try {
  const list = await twirp("ListRooms", {});
  if (list.status === 401 || list.status === 403) {
    bad(`LiveKit rejected the credentials (HTTP ${list.status}). The key and secret must be from the SAME project as the URL.`);
  } else if (list.status !== 200) {
    bad(`ListRooms returned HTTP ${list.status}: ${list.text.slice(0, 200)}`);
  } else {
    ok(`credentials accepted — ListRooms returned ${(list.json?.rooms ?? []).length} live room(s)`);
  }

  if (!failures) {
    // Full round trip: a token that can list is not necessarily a token that
    // can create, and creating is what starting a call actually does.
    const name = `clubos-verify-${crypto.randomBytes(6).toString("hex")}`;
    const created = await twirp("CreateRoom", { name, empty_timeout: 60 });
    if (created.status !== 200) bad(`CreateRoom failed (HTTP ${created.status}): ${created.text.slice(0, 200)}`);
    else ok(`created a test room`);

    if (created.status === 200) {
      const after = await twirp("ListRooms", { names: [name] });
      const found = (after.json?.rooms ?? []).some((r: any) => r.name === name);
      found ? ok("the test room is visible") : bad("created a room but could not read it back");

      const del = await twirp("DeleteRoom", { room: name });
      del.status === 200 ? ok("cleaned the test room up") : bad(`DeleteRoom failed (HTTP ${del.status})`);
    }
  }
} catch (err: any) {
  bad(`could not reach LiveKit: ${err?.message ?? err}`);
}

console.log("");
if (failures) {
  console.error(`${failures} check(s) failed — calls will NOT work. Do not deploy yet.\n`);
  process.exit(1);
}
console.log("✓ LiveKit is wired correctly. Calls will connect once ClubOS is deployed.\n");
