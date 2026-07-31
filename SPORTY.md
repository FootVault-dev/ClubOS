# Sporty / NZ Football NRS Integration — Runbook

ClubOS pushes CUFC player registrations into NZ Football's **National Registration
System** (Sporty Football API v1.1) — the same third-party pathway Friendly Manager
and Club Hub use. NZF approval: **Rodrigo Stephanou** (Systems Development & Insights
Lead — Community Football, rodrigo.stephanou@nzfootball.co.nz, 021 197 5429),
2026-07-20. Contract archived: AIOS repo
`outputs/sporty-api-brief/sporty-football-api-swagger-2026-07-21.json`.

**The path NZF set out:** build → tell Rodrigo development is done → Sporty issues
**UAT keys** → test on uat.sporty.co.nz → sign the **Club deed** AND the
**Third-Party Provider deed** (we're both) → **live keys** for next season.

## Architecture

| Piece | File | What it does |
|---|---|---|
| Pure core | `shared/sporty.ts` | API types, contact→RegisterPerson mapper, preflight validation, error taxonomy, reference matching, payload hashing. No side effects — runs in server, client and tests. |
| API client | `server/sporty-client.ts` | Token lifecycle (24h JWT, single-flight, refresh), pacing (700ms between calls vs their 2/s limit), jittered 429 backoff, 401 re-auth, one 5xx retry. 400s are returned as values (business outcomes), transport failures throw. |
| Engine | `server/sporty-engine.ts` | Candidate discovery (confirmed football registrations → player contacts), preview builds, sequential push, SportyId doctrine, reference cache, audit log. |
| Admin API | `server/sporty-routes.ts` | `/api/admin/sporty/*` — requireTab("sporty"), org from X-Workspace-Slug. |
| Auto-sync | `server/sporty-cron.ts` | Hourly push of new/changed players. **No-op unless `SPORTY_AUTOSYNC=1`** (XERO_AUTOPOST doctrine). |
| UI | `client/src/pages/sporty-sync.tsx` | The Sporty NRS tab (CUFC workspace, **SUPER_ADMIN_ONLY** through UAT). |
| Tables | `migrations/2026-07-21_sporty_sync.sql` | `sporty_sync_state` / `sporty_push_log` / `sporty_reference_cache`. **APPLIED to prod DB 2026-07-21** (additive, inert until deploy). |

## 🟢 UAT STATUS — keys received + tested 2026-07-27

Rodrigo issued UAT credentials 2026-07-27 (link expired 2026-08-03; the values
are in `.env`). **Connected, reference data pulled, 11 registrations pushed,
update semantics proven.** Harness: `script/sporty-uat.ts`.

```
npx tsx --env-file=.env script/sporty-uat.ts connect     # auth + reachability
npx tsx --env-file=.env script/sporty-uat.ts reference   # pull + cache their real vocab
npx tsx --env-file=.env script/sporty-uat.ts scenarios --dry-run
npx tsx --env-file=.env script/sporty-uat.ts scenarios   # push the 16-case matrix
npx tsx --env-file=.env script/sporty-uat.ts verify      # re-send with stored ids → no duplicates
npx tsx --env-file=.env script/sporty-uat.ts engine      # the REAL engine path vs real UAT
npx tsx --env-file=.env script/sporty-uat.ts readiness   # how many real players would push
```

### 🔴 What UAT proved that the swagger got wrong

1. **All six address fields are mandatory** — `StreetAddress`, `Suburb`, `City`,
   **`Region`**, `AlphaPostCode`, `Country`. Their swagger marks NONE required
   and shows Region as an optional string, and every failure returns the same
   unhelpful `"Address is required."` whichever part is missing. Preflight now
   names the missing part itself. Region is derived from the city
   (`nzRegionForCity`) — an unrecognised city yields no region and blocks.
2. **Country codes are FIFA/IOC-style, not ISO 3166-1 alpha-3** as documented:
   Samoa `SAM` (not WSM), Tonga `TGA`, Fiji `FIJ`, South Africa `RSA`, Germany
   `GER`, Netherlands `NED`; ENG/SCO/WAL exist alongside GBR. Codes are now
   always read off THEIR list; aliases resolve via canonical country name.
3. **Their ethnicity groups are NOT the six Stats-NZ groups our form collects.**
   Theirs: NZ European(1) · Māori(2) · Pacific Peoples(3) · Asian(4) ·
   Other(5) · MELAA(6) · Other European(7). So "European" matches TWO groups
   (blocked unless the sub-ethnicity settles it) and "Other Ethnicity" is their
   "Other" group + selection 294.
4. **Substring matching silently mis-registered people.** Exact match now wins,
   and a tie is refused: `Indian`→"Anglo Indian", `Chinese`→"Cambodian Chinese",
   `Syrian`→"Assyrian", `Russian`→"Belorussian", `Ngāti Kahu`→a different iwi.
5. **Overseas clearance is normal, not an error** — a non-NZ nationality or
   country of birth returns 400 "Overseas clearance is required" WITH a
   SportyId. The registration exists but is inactive pending NZF's process.

### 🔴 Environment namespacing (added 2026-07-27, migration applied)

ClubOS runs ONE database, so UAT and production share it. A SportyId only means
something in the environment that issued it, and the doctrine sends any stored
id on every later push — so a UAT id in the row the live push reads would be
sent to the real register for a real child. `sporty_sync_state` and
`sporty_reference_cache` are therefore keyed by `(natural key, environment)`;
`environment` is NOT NULL with **no default** so a writer that doesn't name its
environment fails loudly. Production is an explicit host allowlist
(`sportyEnvironmentFor`) — an unknown host gets its own namespace, never `prod`.
Migration: `migrations/2026-07-27_sporty_environment.sql` (applied + verified).

### Data readiness (the real blocker, not the code)

**2026-07-31 re-run: 16 of 126 ready** (110 needs_data). Blockers: 69 ambiguous
ethnicity group · 29 ethnicity selection required · 27 address incomplete · 26 no
address · 15 nationality · 3 country of birth · 1 ambiguous selection. Read it
against the 27 July baseline below: registrants rose by 10 and ready rose by 8,
while **every legacy blocker count stood still**. That is the structured-identity
form working exactly as designed — it fixes the NEXT registration and never the
last one. The 110 are a backfill campaign, not a code problem.

`readiness` on 2026-07-27: **8 of 116** confirmed academy registrants would push
cleanly. Blockers: 68 bare "European" ethnicity · 29 need a specific ethnicity
selection · 53 address problems (26 no address, 27 incomplete) · 14 nationality
values that are demonyms-of-two or an ethnicity in the wrong field · 3 country
of birth (incl. "Christchurch" and "ニュージーランド"). These are data-collection
gaps in the club's own records. The registration form should collect a country
from a list, ethnicity in Sporty's seven groups, and address as split fields.

## The five rules (why the code looks like it does)

1. **SportyId doctrine.** Any response carrying a SportyId — success OR error
   ("Player already registered" / "Overseas clearance" / "Termination required") —
   writes it to `sporty_sync_state` immediately, and every later push for that
   player sends it. A null SportyId always attempts a CREATE and duplicates.
   That's why `contact_id` is `ON DELETE RESTRICT`.
2. **Never invent identity data.** gender "other", unmappable nationality/country/
   ethnicity, missing guardian for a minor → preflight BLOCKER shown to staff, the
   player is skipped. The one allowed inference: a minor's email/phone/address fall
   back to their guardian's (like the paper forms). Mapping is validated against
   Sporty's own reference endpoints once fetched; before that it's flagged provisional.
3. **Only CONFIRMED registrations push.** Unpaid/pending people are not registered
   with the national body. Financial red-flagging happens inside Sporty, not via
   this API (RegisterPerson carries no paid flag).
4. **Unchanged data never re-sends** (payload hash, SportyId excluded from the hash).
5. **Preflight problems are derived, never stored.** Only push outcomes are state.

## Env (in `.env`; see `.env.example`)

```
SPORTY_BASE_URL=https://uat.sporty.co.nz   # PROD (www.sporty.co.nz) must be set EXPLICITLY
SPORTY_API_KEY=
SPORTY_API_USERNAME=
SPORTY_API_PASSWORD=
SPORTY_AUTOSYNC=0                          # 1 = hourly auto-push (leave 0 through UAT)
```

## Tests (all green 2026-07-21)

```
npx tsx script/test-sporty-shared.ts                 # 21 unit tests — mapper/validators/taxonomy/hash
npx tsx --env-file=.env script/test-sporty-e2e.ts    # 16 E2E — real client+engine vs mock + real DB (cleans up after itself)
npx tsx script/mock-sporty.ts                        # run the Sporty mock standalone (:4599)
npx tsx --env-file=.env script/apply-sporty-sync.ts --dry-run   # migration rehearsal (rolled back)
```

The mock (`script/mock-sporty.ts`) is faithful to their swagger: auth flow, 2/s
rate limits, every documented RegisterPerson error, reference vocab incl. MELAA
min-selection rules. Keep using it — tests must never depend on their UAT being up.

## UAT onboarding (done 2026-07-27 — kept for the production repeat)

1. Paste the three `SPORTY_*` values into `.env` (base URL stays UAT).
2. Sporty tab → **Test connection** (proves key + credentials + reachability).
3. **Refresh reference data** — pulls their real countries/genders/ethnicity
   groups; provisional-mapping warnings disappear; MELAA selection rules go live.
4. Review the **Needs data** queue — fix contacts (gender, country of birth,
   guardian email…) until the players you care about are **Ready**.
5. Expand a row → eyeball the **payload preview** (exactly what will be sent).
6. Push ONE player → check with Rodrigo/Sporty that it landed correctly in UAT →
   then push the rest. Blocked queue (overseas clearance / termination / red flag)
   is expected behaviour, handled with NZF, not a bug.
7. Report results to Rodrigo → deeds arrive → legal review (we sign BOTH: club +
   third-party provider) → live keys.

## Go-live checklist (after deeds signed)

🟢 **No deploy is required — verified 2026-07-31.** The post-UAT-fix code is ALREADY on
prod. Proof: the public vocabulary endpoint
`/api/public/academy/programmes/u4-u8` serves 247 countries / their 7 ethnicity groups /
15 regions with **Samoa = `SAM`, Tonga `TGA`, Germany `GER`, South Africa `RSA`** — FIFA/IOC
codes that only exist in the generated vocabulary shipped with the 27 July fixes. Confirmed
structurally too: `8c31eeb` (structured identity, deployed v373) is a **descendant of
`15a4576`** (the UAT fixes), so exact-match reference lookup, environment namespacing,
region derivation and the FIFA-code path are all live. `/api/admin/sporty/overview` → 401.
**Going live is a credentials change, not a release** — which also means it does NOT drag
any other branch's in-flight work onto prod.

- [ ] `SPORTY_BASE_URL=https://www.sporty.co.nz` + live keys as prod **Fly secrets**
      (nothing can send today: prod holds no `SPORTY_*` secrets at all)
- [ ] Re-probe `/api/admin/sporty/overview` → 401 after the secrets restart
- [ ] Migration already applied (2026-07-21 + 2026-07-27 environment) — verify:
      `SELECT to_regclass('sporty_sync_state')`
- [ ] 🔴 Confirm the environment resolves to `prod` for the live host BEFORE the first push —
      a UAT SportyId reaching the real register is the one unrecoverable failure here
- [ ] First live push: ONE player, verify with NZF, then the season
- [ ] Consider `SPORTY_AUTOSYNC=1` once a full manual season-push has been verified
- [ ] Tab stays super-admin-only until Daniel opens it (delete "sporty" from
      `SUPER_ADMIN_ONLY_TABS` in `shared/tabs.ts`)

## Known limitations (deliberate)

- **Address** is one free-text field in ClubOS; a conservative parser splits
  street/suburb/city/postcode, derives the region from the city, and BLOCKS when
  any of Sporty's six mandatory parts is absent (verified in UAT 2026-07-27 —
  see above). Splitting the address on the registration form is the real fix.
- **Coaches/officials/volunteers**: their API v1 is player-registration only.
  Ask Rodrigo where non-player roles register.
- **Fantail endpoints** are implemented in the client but unwired — CUFC has no
  Fantail programme in ClubOS. Form-option IDs change each season if we ever use it.
- **Gender**: Sporty accepts Male/Female/Non-binary; ClubOS "other" is a blocker
  requiring a human decision, never auto-mapped.

## Message to Rodrigo when ready for keys

> Hi Rodrigo — development of our Sporty integration is complete. We've built
> against the Football API documentation you sent (registration create/update with
> SportyId handling, the reference-data endpoints, and your rate limits), and it's
> passing our full test suite against a local simulation of the API. Ready for UAT
> keys whenever suits — happy to jump on a call while we run the first test
> registrations through. Daniel
