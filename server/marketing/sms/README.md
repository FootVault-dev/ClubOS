# SMS provider library (`server/marketing/sms/`)

Phase F part 1 of the ClubOS Marketing Suite. A Stripe-adapter-style SMS layer:
one `SmsProvider` interface (`types.ts`), N swappable adapters
(`providers/dryrun.ts`, `providers/tnz.ts`, `providers/websms.ts`), and a
factory + NZ compliance constants (`index.ts`). Nothing outside `providers/*.ts`
talks to a vendor API directly.

Grounded in the deep-research BUILD SPEC:
`outputs/deep-research/2026-07-09-clubos-marketing-suite/04-sms-marketing-nz.md`
and `synthesis.md`.

**This library only defines behaviour — it does not touch the DB or Express.**
Wiring it into routes/webhooks/the send worker is a parallel agent's job (see
`server/marketing/routes.ts`).

## Files

| File | What it does |
|---|---|
| `types.ts` | The `SmsProvider` contract + shared shapes (`SmsSendInput/Result`, `SmsDeliveryReceipt`, `SmsInboundMessage`, `ProviderRequest`). |
| `encoding.ts` | GSM-7 vs UCS-2 detection, segment/cost math, a sanitiser that guarantees GSM-7 output. |
| `index.ts` | `getSmsProvider()` factory (env `SMS_PROVIDER`), NZ quiet-hours window (DST-safe), STOP/HELP keyword matching, opt-out suffix. |
| `providers/dryrun.ts` | Default/no-op provider — logs sends, computes real segments/cost, never touches a network. **The default when `SMS_PROVIDER` is unset, on purpose** — no real SMS account is open yet, so an unset env var must never accidentally hit a live carrier. |
| `providers/tnz.ts` | TNZ Group (tnz.co.nz) adapter. |
| `providers/websms.ts` | WebSMS (websms.co.nz) adapter. |

Run the self-test any time (no DB, no network): `npx tsx script/test-sms-lib.ts`

## Why TNZ / WebSMS, not Twilio

Per the research (04-sms-marketing-nz.md, Finding 7/8 + synthesis.md): NZ
carriers require ordinary two-way **marketing** SMS to go via a **short code**
(alphanumeric sender IDs are one-way/no-reply). NZ-native aggregators — TNZ,
WebSMS, SMS Everyone — give **~10c NZD/segment on a free shared, zero-rated
short code with zero provisioning wait**. Twilio is ~75% dearer NZD-equivalent
**and** requires a mandatory dedicated short code with a 5–6 week wait. Both
adapters here are kept swappable behind the same `SmsProvider` interface;
Twilio/MessageMedia/Modica can be added later the same way if volume/brand
ever justifies a dedicated code.

## Provider setup (for Daniel — before flipping `SMS_PROVIDER` off `dryrun`)

Neither account is open yet. To go live with either provider:

**TNZ Group** (tnz.co.nz)
1. Sign up / talk to TNZ sales for an NZ shared short-code SMS account (~$20/mo subscription + ~10c/segment, per the research doc's pricing table).
2. In their dashboard, create an API user token (this becomes `TNZ_API_KEY`) and confirm the **account login email** used to authenticate (this becomes `TNZ_ACCOUNT_EMAIL` — TNZ's API oddly calls this field "Sender" in the request body, but it's the *account* identity, not the SMS sender ID recipients see).
3. **Before trusting this adapter for anything but a sandbox `Mode=Test` send:** TNZ's own docs gave inconsistent detail across pages for the JSON REST API (host, request nesting, response envelope, webhook payload shape — none of it corroborated by a real example we could fetch). Every uncertain spot is marked `TODO(verify-live)` in `providers/tnz.ts` — grep that file for the tag and confirm each one against a real test send + a real webhook payload once the account exists.
4. Register a webhook callback URL in the dashboard for delivery receipts + inbound SMS once the parallel agent's webhook route exists.

**WebSMS** (websms.co.nz)
1. Sign up for a WebSMS account (~10c/segment, no monthly fee, no setup fee, per the research doc's pricing table).
2. Note the account `username`/`password` — these become `WEBSMS_USERNAME` / `WEBSMS_PASSWORD`.
3. This adapter targets WebSMS's **legacy `send.php` API** (concrete, worked examples in their docs) rather than their newer "Connexus" API (which WebSMS's site says to prefer for new integrations, but whose exact field names we could only extract via an AI-summarized OpenAPI read — lower confidence). See the `TODO(verify-live)` notes in `providers/websms.ts` for the Connexus migration path once the account exists and the OpenAPI spec can be checked directly (e.g. for a `messageId`/client-reference field the legacy API lacks).
4. Once the parallel agent's webhook route has a public URL, set `WEBSMS_CALLBACK_URL` to it — WebSMS's legacy API registers the delivery-receipt/inbound-reply callback **per send** via a `dlrurl` query param (there's no separate "register a webhook" step like Connexus has).

## Environment variables

| Var | Used by | Notes |
|---|---|---|
| `SMS_PROVIDER` | `index.ts` factory | `dryrun` (default) \| `tnz` \| `websms`. Anything else falls back to `dryrun` with a console warning. |
| `SMS_SENDER_ID` | *(reserved, not yet wired)* | Per-message sender-ID override. **Not currently sent to either live provider** — NZ marketing SMS runs on a shared short code, and neither TNZ's nor WebSMS's documented API has a confirmed per-message sender-ID field to put it in. Revisit if/when a dedicated/branded short code is provisioned. |
| `SMS_COST_CENTS_PER_SEGMENT` | all providers + `encoding.ts`'s `estimateCost` | Default `10` (matches the research doc's ~10c NZD/segment finding for both TNZ and WebSMS). |
| `TNZ_API_KEY` | `providers/tnz.ts` | The API token generated in TNZ's dashboard. |
| `TNZ_ACCOUNT_EMAIL` | `providers/tnz.ts` | The TNZ account login email — TNZ's JSON body calls this field `Sender`, which is confusing (it's account auth, not the SMS sender ID). |
| `TNZ_API_BASE_URL` | `providers/tnz.ts` | Override for the JSON REST API host. Default is a best guess (`api.tnz.net.nz`) — TNZ's own docs disagree with themselves on this, see the `TODO(verify-live)` at the top of the file. |
| `WEBSMS_USERNAME` / `WEBSMS_PASSWORD` | `providers/websms.ts` | WebSMS account credentials (sent as query params on every send — that's how their legacy API authenticates). |
| `WEBSMS_API_BASE_URL` | `providers/websms.ts` | Override for the API host. Default `https://websms.co.nz/api`. |
| `WEBSMS_CALLBACK_URL` | `providers/websms.ts` | The `dlrurl` registered on every send — handles BOTH delivery receipts and inbound replies (same endpoint, per WebSMS's docs). |

## Cost math (worked example)

`estimateCost(segments, recipients, centsPerSegment)` = `segments × recipients × centsPerSegment`, in whole NZD cents, **ex-GST**.

> 2,000 recipients × 1 segment (a normal GSM-7 SMS ≤160 chars) × 10c/segment
> = 20,000 cents = **$200.00 ex-GST**
> + 15% GST ($30.00) = **$230.00 total**

The GSM-7/UCS-2 trap this library exists to catch (see `encoding.ts`'s file
header and Finding 7 in the research doc): a **single emoji, curly quote, or
em-dash** flips the *entire* message from GSM-7 (160/153 chars per segment) to
UCS-2 (70/67 chars per segment) — on an otherwise-160-char message that's 1
segment → 3 segments, i.e. **triple the cost** for a change that looks
invisible in a text box. `sanitizeToGsm7()` normalises smart punctuation and
strips anything else non-GSM-7 (reporting what it removed) so a marketing send
doesn't silently 3x its bill from a pasted em-dash.

## NZ compliance (Unsolicited Electronic Messages Act 2007)

Handled by `index.ts`, enforced by whatever wires this into the send path:

- **Quiet hours**: `isQuietHours()` / `nextSendableTime()` — sendable window is
  08:00–20:00 `Pacific/Auckland`, DST-safe (computed via `Intl`, no date
  library). Marketing sends queued outside this window should be deferred to
  the next 08:00 NZ via `nextSendableTime()`.
- **Opt-out**: `appendOptOutSuffix()` — every marketing SMS must carry
  "Reply STOP to opt out" (won't double it up if already present). Note this
  suffix **counts toward the segment/cost math** — call it before
  `analyzeSms()`/`estimateCost()`.
- **STOP/HELP**: `matchStopKeyword()` / `matchHelpKeyword()` — **exact match**
  on the trimmed, case-insensitive full message body (not a substring/word
  search). `"STOP"` opts out; `"stop it"` or `"can you stop the 8am ones"`
  does **not** — see the doc comment on `matchStopKeyword` in `index.ts` for
  the full rationale (a false-negative opt-out is a compliance risk; a
  false-positive silently unsubscribes someone who didn't ask to be — exact
  match is the conservative choice for this gate specifically).
- Civil penalties under the Act run up to **$200,000 (individual)** /
  **$500,000 (organisation)**, enforced by the DIA.

## Webhook signature verification — an honest gap

Neither TNZ's nor WebSMS's documentation (everything fetchable as of
2026-07-09) describes a signature/HMAC scheme for verifying that a delivery-
receipt or inbound-SMS webhook genuinely came from them. Per `types.ts`'s
`SmsProvider.verifyWebhook()` contract, both adapters **return `true`** (so
sends/inbound processing aren't blocked) but **log a loud console warning the
first time**, so this is visible in ops rather than silently trusted forever.
Ask each provider's support for a signing scheme before this matters in
practice (e.g. once a webhook route is public and STOP-driven unsubscribes are
wired to something automatic).

## `TODO(verify-live)` — full list

Everything below needs a real provider account + a real test send/webhook to
confirm. Grep the tag in `providers/tnz.ts` / `providers/websms.ts` for exact
line context.

**`providers/tnz.ts`**
- Correct JSON REST API host (`api.tnz.net.nz` vs `api.tnz.co.nz` — TNZ's own docs disagree).
- Exact endpoint path (`{base}/send` assumed; the separate simple-HTTPS API uses a different shape entirely — `Sender`/`Token`/`Number`/`Message`, no `MessageData` nesting).
- `MessageData.Destinations` shape — flat string array vs array of `{Recipient}` objects (docs show both).
- Response envelope on a successful send — flat `{Result, MessageID}` vs nested `{Result, Data: {MessageID, JobNum, Status}}` (docs show both; some pages describe a plain-text `"200 OK, Job %JOBNUMBER%"` response instead of JSON).
- Delivery-receipt ("SMS Status") webhook payload field names — not found in anything fetchable; best-guessed from TNZ's own status-polling response shape.
- Inbound-SMS ("SMS Received") webhook payload field names — same gap.
- No documented webhook signature scheme (see above).

**`providers/websms.ts`**
- Whether the legacy `send.php` API is still the right choice vs migrating to Connexus (WebSMS recommends Connexus for new integrations; this adapter chose legacy for its concrete, verifiable examples — revisit once the OpenAPI spec can be read directly with real credentials).
- The replying phone number's field name on the inbound-reply callback — the only documented worked example (`id=+109720&reply=Reply Text`) doesn't show it; `from`/`cellnum`/`msisdn`/`mobile`/`sender` are tried as aliases.
- No documented webhook signature scheme (see above).
