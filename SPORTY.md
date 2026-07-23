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

## UAT onboarding (when Rodrigo sends keys)

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

- [ ] `SPORTY_BASE_URL=https://www.sporty.co.nz` + live keys in prod Fly secrets
- [ ] Deploy per D16 doctrine: re-read memory `reference_clubos_prod_state`, union-merge
      whatever prod runs into `feat/sporty-sync`, deploy from a clean detached
      worktree, probe `/api/admin/sporty/overview` → 401
- [ ] Migration already applied (2026-07-21) — verify: `SELECT to_regclass('sporty_sync_state')`
- [ ] First live push: ONE player, verify with NZF, then the season
- [ ] Consider `SPORTY_AUTOSYNC=1` once a full manual season-push has been verified
- [ ] Tab stays super-admin-only until Daniel opens it (delete "sporty" from
      `SUPER_ADMIN_ONLY_TABS` in `shared/tabs.ts`)

## Known limitations (deliberate)

- **Address** is one free-text field in ClubOS; a conservative parser splits
  street/suburb/city/postcode and flags anything unconfident for human eyeballing
  in the preview. Verify Sporty's actual sub-field requirements during UAT.
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
