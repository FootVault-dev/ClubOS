# Staff Voice — calls inside ClubOS Chat

1:1 calls, group calls, always-on voice channels and meetings, on the web app
and the staff phone app. Built 2026-08-17.

**Status: code complete, typechecks clean, native build verified — INERT until
the two keys below are set. Not deployed. Migration not applied.**

---

## 🔴 The two things only Daniel can do

Nothing connects until these exist. Everything else is built and waiting.

### 1. LiveKit Cloud — the media server (~3 minutes, free, no credit card)

1. Go to **https://cloud.livekit.io** and sign up (GitHub or email).
2. Create a project. Call it **clubos**. Pick the region closest to NZ —
   **Sydney / ap-southeast** if offered.
3. Open **Settings → Keys** and create an API key.
4. You get three values. Put them in `apps/clubos/.env`:

```
LIVEKIT_URL=wss://clubos-xxxxxxx.livekit.cloud
LIVEKIT_API_KEY=API...
LIVEKIT_API_SECRET=...
```

Free tier is 5,000 WebRTC minutes and 50GB a month — those are *participant*
minutes, so a four-person half-hour call spends 120 of them. Roughly 40 such
calls a month before it costs anything, and then it is about $0.0005/minute.

LiveKit is open source. If we ever want it fully in-house, the same code runs
against a self-hosted server by changing `LIVEKIT_URL` — no rewrite.

### 2. An APNs key — so an iPhone actually rings (~2 minutes)

Without this, a call arrives as an ordinary notification: silent, no
full-screen ringing, and it will not wake a closed app. With it, the phone
rings like a phone call.

1. **https://developer.apple.com/account** → Certificates, Identifiers &
   Profiles → **Keys** → **+**.
2. Name it `ClubOS Push`, tick **Apple Push Notifications service (APNs)**,
   Continue → Register.
3. Download the `.p8`. **You can only download it once.** Note the **Key ID**
   on that page, and your **Team ID** (top right of the account page — ours is
   `MNAXQH9C7L`).
4. Put in `apps/clubos/.env`:

```
APNS_KEY_ID=XXXXXXXXXX
APNS_TEAM_ID=MNAXQH9C7L
APNS_BUNDLE_ID=nz.usg.clubos
APNS_ENV=production
APNS_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----
...contents of the .p8, newlines and all...
-----END PRIVATE KEY-----"
```

On Fly: `fly secrets set APNS_PRIVATE_KEY="$(cat AuthKey_XXXXXXXXXX.p8)"`.

> 🔴 `APNS_ENV=production`, not sandbox. **A TestFlight build uses the
> production APNs environment.** Pointing at sandbox is a well-known and
> completely invisible way for ringing to "just not work" on TestFlight while
> working perfectly in a local dev build.

---

## Then, to go live

```bash
cd apps/clubos

# 1. Apply the migration (additive — three new tables, two new columns)
psql "$DATABASE_URL" -f migrations/2026-08-17_staff_voice.sql

# 2. 🔴 Required after ANY migration in this workspace
node ../../scripts/security/rls_guard.mjs

# 3. 🔴 Ask production what it currently serves — refuses a tree that serves less
npx tsx --env-file=.env script/preflight-deploy.ts

# 4. Deploy
./deploy.sh
```

Then check it is actually on:

```bash
curl -s https://app.usg.co.nz/api/admin/voice/config    # 401 = deployed, 404 = not
```

---

## How it works

**Four surfaces, one engine.** A 1:1 call, a group call, a voice channel and a
meeting differ only in how the room is created and who gets rung. They are one
table with a `mode`, not four features.

| mode | Rings? | Who is in it | Ends when |
|---|---|---|---|
| `direct` | yes | both DM members | someone leaves, or declined |
| `group` | yes | chosen channel members | last person leaves |
| `channel` | **no** | whoever drops in | empty |
| `meeting` | optional | invited list | host ends it |

**Voice inherits chat's membership exactly.** `voiceAccess()` in
`shared/staff-voice.ts` is the only decider, and it answers from chat's own
membership rows. If you can read the room you can talk in it. There is
deliberately **no super-admin bypass** — a super admin who is not in a DM has
no business dialling into it, and `canAccessTab` failing open for
admin/manager is precisely the hole this must not reproduce.

**Almost nothing is stored.** Live, ringing, present, missed and duration are
all derived. A status column has to be un-set by something, and here that
something is a phone that may have gone into a tunnel.

**It self-heals.** A phone that dies mid-call never says "I left", so its
`left_at` would stay NULL forever, the room would look permanently occupied,
and the one-live-call-per-channel index would block the next call. Every read
path reconciles against LiveKit's own participant list first. No cron, no
public webhook endpoint, and it works across two Fly machines that share no
memory.

### The files

| File | What it is |
|---|---|
| `migrations/2026-08-17_staff_voice.sql` | 3 tables, 2 columns, the invariants |
| `shared/staff-voice.ts` | pure logic — derivations + `voiceAccess()` |
| `server/livekit.ts` | token minting (plain JWT, no SDK) + room truth |
| `server/voip-push.ts` | APNs VoIP push over HTTP/2 — the ring |
| `server/staff-voice-routes.ts` | 9 endpoints |
| `client/src/lib/voice-room.ts` | browser LiveKit wrapper + synthesised ringtone |
| `client/src/components/voice/` | provider, call dock, incoming sheet, call button |
| `../clubos-mobile/src/contexts/VoiceContext.tsx` | CallKit handshake + LiveKit |
| `../clubos-mobile/src/components/CallBar.tsx` | in-call bar + call button |

---

## Traps worth knowing before you touch this

🔴 **The VoIP push payload shape is a contract, not a preference.**
`expo-callkit-telecom` parses it *natively*, before any JavaScript runs,
because iOS gives the app milliseconds to report a call to CallKit. Rename a
field and the push arrives, the parse fails, no call is reported — and iOS
then kills the app for taking a VoIP push without reporting a call. The shape
is pinned and commented in `server/voip-push.ts`.

🔴 **The answer handshake has a deadline.** Answering emits
`CallAnsweredEvent{ id, requestId }`. We then have a bounded window to call
either `fulfillIncomingCallConnected(requestId)` once media is up, or
`failIncomingCallConnected(id, requestId)`. Do neither and CallKit tears the
call down with no explanation — the classic "answers, then instantly hangs
up" bug. Both paths are handled.

🔴 **A PushKit token is not the APNs token.** Same device, two different
tokens. Hence the separate `device_push_tokens.voip_token` column and the
separate registration endpoint — writing one over the other silently breaks
the other channel.

🔴 **The room name is the access boundary.** LiveKit checks the grant in the
token and nothing else. Room names are server-minted random hex, never
derived from the channel id.

🔴 **Two people calling each other at once.** Not a rare edge case — it is what
happens when a call drops and both sides redial. A partial unique index
(`staff_calls (channel_id) WHERE ended_at IS NULL`) means Postgres picks a
winner, and the loser's request *joins the winner's call* rather than erroring.

⚠️ **The minimum iOS version rose to 16.4**, because that is what the WebRTC
pod requires. Anyone on iOS 15 can no longer install the staff app. In 2026
that is nobody, but it is a real change.

⚠️ **`expo-callkit-telecom` is version 0.4.0** — young software. It is the right
choice (Expo-native, New-Architecture-ready, Core-Telecom on Android where
`react-native-callkeep` is legacy), but it is the least battle-tested piece
here and the first place to look if ringing misbehaves.

---

## Deliberately not built

- **Recording.** A club recording internal calls — possibly about a child, or a
  disciplinary matter — is a policy decision, not a feature decision. LiveKit
  supports it; we are not switching it on without Daniel saying so.
- **Video.** The token grant is an allowlist and currently permits microphone
  (plus screen share for meetings and voice channels). Adding camera is one
  line, once someone asks for it.
- **Calling parents or players.** Chat is staff-only and voice inherits that.
  Any wider audience is a separate safeguarding conversation.
- **LiveKit webhooks.** Reconcile-on-read covers the same ground with no public
  endpoint and no raw-body plumbing. Worth revisiting only if polling cost
  becomes real.
