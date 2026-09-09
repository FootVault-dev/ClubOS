#!/bin/zsh
# Canonical ClubOS production deploy.
#
# CRITICAL: Vite inlines VITE_* env vars at BUILD time. The Dockerfile takes
# them as --build-arg. If you run a bare `fly deploy`, the client bundle ships
# with an EMPTY Stripe key + Meta pixel id → blank checkout (Elements can't
# mount) and no Facebook tracking. (This is exactly what broke v114.)
#
# Always deploy with this script so the VITE_* values from .env are passed.
#
# ── D16: ONE DEPLOY BRANCH (2026-07-09) ──────────────────────────────────────
# app 'clubos' serves ALL branches that get deployed to it — so if you deploy
# from a branch that lacks a merge, you SILENTLY drop that feature from prod.
# This happened to AttributionOS: post-07-04 deploys ran from a branch without
# the loop/attribution merge and /t.js reverted to serving HTML (zero data
# collected for days, nobody noticed). Rule: deploy ONLY from the one canonical
# branch that contains every merged feature. This script now PRINTS the current
# branch before shipping — LOOK AT IT and confirm it's the right one.
#
# ── WHEN THE BUILD HANGS: "Waiting for depot builder..." (2026-07-10) ────────
# Fly's depot builder can hang indefinitely and then fail with
#   Error: ... error building: deadline_exceeded / context deadline exceeded
# even while status.flyio.net says "All Systems Operational". It failed 6x in a row.
#
# Two things fix it, and you need BOTH:
#   1. DROP THE APP TOKEN. `.env`'s FLY_API_TOKEN is app-scoped and cannot
#      provision a builder — with it set, --depot=false dies with
#      "Failed to start remote builder heartbeat: unauthorized".
#      Deploy under the logged-in `systems@unitedsportsgroup.co.nz` session instead.
#   2. WAKE THE LEGACY BUILDER and use it:
#        fly machine list -a fly-builder-mellow-lagoon-2640
#        fly machine start -a fly-builder-mellow-lagoon-2640 <machine-id>
#
#   Then:
#     env -u FLY_API_TOKEN flyctl deploy -a clubos --depot=false --remote-only \
#       --build-arg VITE_STRIPE_PUBLISHABLE_KEY="$VITE_STRIPE_PUBLISHABLE_KEY" \
#       --build-arg VITE_META_PIXEL_ID="$VITE_META_PIXEL_ID"
#
#   (No local Docker on this Mac, so --local-only is not an option.)
#
# ── `fly deploy` SHIPS THE WHOLE WORKING TREE, not your commit ───────────────
# Never deploy while a subagent or a parallel session is mid-edit — the Dockerfile's
# `COPY . .` captures whatever is on disk at that instant, half-written files included.
#
# This is not theoretical. On 2026-07-10 a parallel session had added
# `esign_signers.is_form_signer` to shared/schema.ts with its migration NOT YET
# APPLIED. Deploying that tree would have made every e-sign query select a column
# that does not exist in prod. ALWAYS `git status --short` first.
#
# If someone else IS mid-edit, deploy from a clean worktree at your own commit:
#     W=/tmp/clubos-deploy-$$
#     git worktree add --detach "$W" HEAD && cp .env "$W/.env" && cd "$W"
#     env -u FLY_API_TOKEN flyctl deploy -a clubos --depot=false --remote-only --no-cache \
#       --build-arg VITE_STRIPE_PUBLISHABLE_KEY="…" --build-arg VITE_META_PIXEL_ID="…"
#     cd - && git worktree remove "$W"
# Use --no-cache from a worktree: Fly has served a STALE build layer from one before.
#
# ── PERMANENT POST-DEPLOY SMOKE CHECKLIST (run every time, --no-cache if stale)
#   curl -sI https://app.usg.co.nz/t.js         → content-type: application/javascript  (NOT text/html)
#   curl -sI https://app.usg.co.nz/l/<realkey>  → 302 (NOT 200 HTML)
#   curl -s  https://app.usg.co.nz/api/admin/... → 401 (admin still gated)
#   + a route unique to the NEWEST merge returns its real response (not 404/HTML)
# A text/html /t.js means attribution regressed out again — reship from the right branch.
set -e
cd "$(dirname "$0")"

# Strip our own flags out of "$@" before the rest is passed through to flyctl.
_ALLOW_BEHIND=0
_CHECK_ONLY=0
_ARGS=()
for _a in "$@"; do
  case "$_a" in
    --allow-behind-prod) _ALLOW_BEHIND=1 ;;
    # Run every pre-build safety check and STOP. There was no way to exercise
    # this script's guards without deploying, so verifying a change to them
    # meant shipping one — which started two real builds of the wrong tree on
    # 2026-09-09 before they were killed. A guard you cannot test safely is a
    # guard nobody will test.
    --check-only) _CHECK_ONLY=1 ;;
    *) _ARGS+=("$_a") ;;
  esac
done
set -- "${_ARGS[@]}"

[ -f .env ] || { echo "❌ no .env in $(pwd)"; exit 1; }
VITE_STRIPE_PUBLISHABLE_KEY=$(grep -E '^VITE_STRIPE_PUBLISHABLE_KEY=' .env | cut -d= -f2- | tr -d '\r')
VITE_META_PIXEL_ID=$(grep -E '^VITE_META_PIXEL_ID=' .env | cut -d= -f2- | tr -d '\r')

# Deploy with the app-scoped token from .env so deploys work no matter which
# account the Fly CLI happens to be logged into (the CLI login drifts between
# Daniel's accounts — broke the 2026-07-02 deploy).
_FLY_TOKEN=$(grep -E '^FLY_API_TOKEN=' .env | cut -d= -f2- | tr -d '\r' | sed 's/^"//;s/"$//')
[ -n "$_FLY_TOKEN" ] && export FLY_API_TOKEN="$_FLY_TOKEN"

if [ -z "$VITE_STRIPE_PUBLISHABLE_KEY" ]; then
  echo "❌ VITE_STRIPE_PUBLISHABLE_KEY missing in .env — refusing to ship a broken checkout."
  exit 1
fi
case "$VITE_STRIPE_PUBLISHABLE_KEY" in
  pk_live_*|pk_test_*) ;;
  *) echo "❌ VITE_STRIPE_PUBLISHABLE_KEY doesn't look like a Stripe key — aborting."; exit 1;;
esac

# ── D16 ENFORCED (2026-08-09) ────────────────────────────────────────────────
# Printing the branch and asking a human to "confirm it's the right one" did not
# work: attribution, squads (twice) and parent accounts were all silently
# removed from production by a deploy off a branch that lacked them. This asks
# PRODUCTION what it currently serves and refuses to ship a tree that would
# serve less. Set PREFLIGHT_SKIP=1 only if you have decided to remove a feature
# on purpose.
if [ "${PREFLIGHT_SKIP:-0}" != "1" ]; then
  echo "── Pre-deploy: would this branch remove anything live? ──"
  npx tsx --env-file=.env script/preflight-deploy.ts || {
    echo "❌ Pre-deploy check failed — not shipping. (PREFLIGHT_SKIP=1 to override deliberately.)"
    exit 1
  }
fi

_GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "<unknown>")
_GIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "?")

# ── WHAT AM I ACTUALLY SHIPPING? (added 2026-09-03) ────────────────────────
# `fly deploy` ships the WORKING TREE, not your commit — so anything that
# landed on this branch while you were working goes out with your change,
# under your deploy. On 2026-09-03 a United Prints customer-accounts feature
# was committed mid-session and rode three deploys to production; nobody
# decided to release it, and it was only noticed afterwards.
#
# This does not block anything. It PRINTS the commits going out and any
# uncommitted files, so the operator sees a name they do not recognise before
# the 20-minute build rather than after.
# 🔴 ASK PRODUCTION FIRST, UNCONDITIONALLY. This block used to be wrapped in
# `if [ -f .last-deployed-sha ]`, which meant the production probe — the whole
# point of the endpoint — only ran when the stale local file it was designed to
# REPLACE happened to exist. .last-deployed-sha is gitignored, so a fresh clone
# or a fresh worktree has none... and "deploy from a clean detached worktree" is
# exactly what the deploy doctrine tells you to do. The recommended practice
# disabled the guard. Proven on 2026-09-09: a throwaway worktree five commits
# behind prod, missing the entire Register, passed --check-only with exit 0.
_PROD_SHA=$(curl -s -m 10 https://app.usg.co.nz/api/version 2>/dev/null \
  | sed -n 's/.*"sha":"\([0-9a-f]\{7,40\}\)".*/\1/p')
_LAST=""
[ -f .last-deployed-sha ] && _LAST=$(cat .last-deployed-sha)

if [ -n "$_PROD_SHA" ] && ! git cat-file -e "${_PROD_SHA}^{commit}" 2>/dev/null; then
  # Prod answered with a commit this clone has never seen — someone deployed
  # from a tree that is not here. Refusing beats guessing.
  echo "🔴 production reports ${_PROD_SHA:0:7}, a commit this checkout does not have."
  echo "    Somebody deployed from a tree you cannot see. Fetch it before shipping."
  exit 1
elif [ -n "$_PROD_SHA" ]; then
  [ -n "$_LAST" ] && [ "$_PROD_SHA" != "$_LAST" ] && \
    echo "ℹ️  production reports ${_PROD_SHA:0:7}; the local stamp says ${_LAST:0:7} — trusting production."
  _LAST="$_PROD_SHA"
elif [ -n "$_LAST" ]; then
  echo "⚠️  COULD NOT ASK PRODUCTION WHAT IT RUNS (/api/version gave no sha)."
  echo "    Falling back to .last-deployed-sha (${_LAST:0:7}), which is GITIGNORED —"
  echo "    every worktree keeps its own copy and they drift, so it may be stale."
  echo "    Either prod predates the endpoint, or something is wrong. Confirm by hand:"
  echo "      git merge-base --is-ancestor <the sha prod really runs> HEAD"
  echo ""
else
  # No endpoint AND no stamp: this deploy is completely unguarded against
  # removing live work. Say so in the loudest terms rather than proceeding
  # quietly, which is what a fresh worktree used to do.
  echo "🔴 CANNOT DETERMINE WHAT PRODUCTION RUNS — no /api/version, no local stamp."
  echo "    This deploy is UNGUARDED: it may silently remove live features."
  echo "    Check by hand before continuing:"
  echo "      curl -s https://app.usg.co.nz/api/version"
  echo "      git merge-base --is-ancestor <that sha> HEAD"
  echo ""
fi

if [ -n "$_LAST" ] && git cat-file -e "$_LAST^{commit}" 2>/dev/null; then
    _N=$(git rev-list --count "$_LAST..HEAD" 2>/dev/null || echo 0)
    if [ "$_N" -gt 0 ]; then
      echo "── Shipping $_N commit(s) since the last deploy ──"
      git log --oneline --format="   %h %an  %s" "$_LAST..HEAD" | head -20
      echo ""
    fi
    # ── The OTHER direction: what this tree would REMOVE ────────────────────
    # preflight-deploy.ts probes ROUTES. It cannot see a script, a migration, a
    # seed or a static asset that exists only as a file, so a tree one commit
    # behind prod passes the guard honestly and silently drops that file from
    # the image. Between two sessions the only reliable test is ancestry, and
    # it costs nothing. (Near-miss 2026-09-09: a parallel session's tree was
    # exactly one commit behind and would have dropped a CLI helper.)
    _BEHIND=$(git rev-list --count "HEAD..$_LAST" 2>/dev/null || echo 0)
    if [ "$_BEHIND" -gt 0 ]; then
      echo "🔴 THIS TREE IS $_BEHIND COMMIT(S) BEHIND WHAT WAS LAST DEPLOYED."
      echo "   Deploying it REMOVES the following from production:"
      git log --oneline --format="   %h %an  %s" "HEAD..$_LAST" | head -20
      echo ""
      echo "   The canary guard cannot catch this: it probes routes, not files."
      echo "   Merge the deployed sha first —  git merge $_LAST  — then redeploy."
      echo "   Deliberate removal? ./deploy.sh --allow-behind-prod"
      # Deliberately read from ARGV, never the environment: an exported variable
      # survives a whole shell session, so one deliberate override an hour ago
      # would silently disarm every deploy after it. A flag applies to exactly
      # the invocation a human typed it on.
      [ "${_ALLOW_BEHIND:-0}" = "1" ] || exit 1
      echo "   ⚠️  --allow-behind-prod passed — proceeding with the removal."
      echo ""
    fi
fi
_DIRTY=$(git status --porcelain 2>/dev/null | grep -vE '^\?\? ' | head -10)
if [ -n "$_DIRTY" ]; then
  echo "⚠️  UNCOMMITTED changes — fly ships the working tree, so these go out too:"
  echo "$_DIRTY" | sed 's/^/   /'
  echo ""
fi
echo "==============================================="
echo "  ClubOS deploy → app 'clubos' (Sydney)"
echo "  Branch     : ${_GIT_BRANCH}   ← D16: confirm this is the ONE canonical deploy branch"
echo "  Stripe key : ${VITE_STRIPE_PUBLISHABLE_KEY:0:11}…  (${#VITE_STRIPE_PUBLISHABLE_KEY} chars)"
echo "  Meta pixel : ${VITE_META_PIXEL_ID:-<none>}"
echo "==============================================="
echo "  ⚠️  Run any DB migration BEFORE this deploy if the schema changed."
echo "  ⚠️  After deploy, smoke-test /t.js (must be application/javascript, not text/html)."
echo ""

if [ "$_CHECK_ONLY" = "1" ]; then
  echo "✓ --check-only: every pre-build check passed. Nothing was built or deployed."
  exit 0
fi

# ── CLIENT-ONLY REGRESSION GUARD (added 2026-07-27 after it bit twice) ───────
# The 401/404 route probe CANNOT see a client-only feature. The MFL night badge
# is a schema column + a public-payload field + a React render — it adds no
# admin route — so it was silently deleted from prod twice in one afternoon by
# deploys from branches that lacked its commit, and both deploys probed clean.
#
# Each marker below is a literal string that must be present in the source tree
# whenever it is present in the LIVE bundle. If prod is serving it and the tree
# you are about to ship is not, this deploy would remove a live feature — so it
# stops. Add a line here whenever you ship a client-only feature.
_LIVE_JS_PATH=$(curl -s --max-time 10 https://app.usg.co.nz/ | grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' | head -1)
if [ -n "$_LIVE_JS_PATH" ]; then
  _LIVE_JS=$(curl -s --max-time 25 "https://app.usg.co.nz${_LIVE_JS_PATH}")
  _regress=0
  # marker<TAB>where-it-lives-in-source
  printf '%s\n' \
    "division-badge-|client/src/pages/mfl-landing-page.tsx|MFL league night badge" \
    "Task Tracker|client/src/components/app-sidebar.tsx|Task Tracker universal tab" \
    "First name can't be blank|client/src/components/profile-dialog.tsx|Staff profile name + photo" \
    "Notification settings|client/src/components/app-sidebar.tsx|Notification settings universal tab" \
    "/admin/equipment|client/src/components/app-sidebar.tsx|Equipment Register tab" \
    "/admin/accommodation|client/src/components/app-sidebar.tsx|Accommodation tab" \
    "button-account-menu|client/src/components/account-menu.tsx|Top-right account menu" \
    "Revenue isn't wired up for this workspace|client/src/components/dashboard/revenue-widget.tsx|Dashboard revenue widget" \
    "MOVED_TO_ACCOUNT_MENU|client/src/components/app-sidebar.tsx|Trimmed sidebar (light-only era)" \
  | while IFS='|' read -r _marker _file _label; do
      [ -z "$_marker" ] && continue
      if printf '%s' "$_LIVE_JS" | grep -q -- "$_marker"; then
        if ! grep -rq -- "$_marker" "$_file" 2>/dev/null; then
          echo "❌ REGRESSION: '$_label' is LIVE on prod but missing from this tree ($_file)."
          echo "   Deploying would delete it. Merge the branch that has it, then retry."
          exit 90
        fi
      fi
    done
  _regress=$?
  [ "$_regress" = "90" ] && exit 1
  echo "  ✓ client-only feature guard passed"
else
  echo "  ⚠️  could not read the live bundle — client-only guard SKIPPED (verify by hand after deploy)"
fi
echo ""

# NOT `exec` — we have to still be here afterwards to check what actually
# shipped. (2026-09-03: a deploy that went around this script dropped the
# --build-arg and compiled every checkout down to loadStripe(""). Nothing
# noticed for a day and a half because every route still answered 200.)
# `set -e` is on, so capture the code with `|| _deploy_rc=$?` — a bare
# `_deploy_rc=$?` on the next line never runs, the shell has already exited.
_deploy_rc=0
flyctl deploy -a clubos \
  --build-arg VITE_STRIPE_PUBLISHABLE_KEY="$VITE_STRIPE_PUBLISHABLE_KEY" \
  --build-arg VITE_META_PIXEL_ID="$VITE_META_PIXEL_ID" \
  --build-arg GIT_SHA="$(git rev-parse HEAD 2>/dev/null || echo unknown)" \
  "$@" || _deploy_rc=$?

# ── POST-DEPLOY: did a working checkout actually reach production? ───────────
# The guard above proves the key was in .env. It cannot prove it survived the
# build. This asks the LIVE bundle. Do not remove it: a broken checkout is
# invisible to every route probe we have — the booking still writes, the
# PaymentIntent is still created, and only a human hitting a dead payment step
# ever finds out.
if [ "$_deploy_rc" -ne 0 ]; then
  echo ""
  echo "❌ flyctl exited $_deploy_rc — the deploy FAILED. Production is unchanged."
  exit "$_deploy_rc"
fi

echo ""
echo "── Post-deploy: can production mount a card checkout? ──"
sleep 5
npx tsx --env-file=.env script/_verify-checkout-live.ts || {
  echo ""
  echo "🔴 The deploy landed but production CANNOT TAKE A CARD PAYMENT."
  echo "   Almost always: the VITE_* build args did not reach the build."
  echo "   Re-run ./deploy.sh (never a bare 'flyctl deploy' — it drops them)."
  exit 1
}

echo ""
echo "── Post-deploy: does every page still RENDER? ──"
# Daniel, 2026-09-04: "white screen error again... make sure this never happens
# again as it's happening all the time, particularly around new updates."
#
# tsc passes, the build passes and route probes return 200 while a page is
# white — the failures are at RUNTIME in the browser. Three reached production
# recently: an un-imported icon, a prop named `ref` stripped by React 18, and a
# useMutation below an early return. This opens the real pages in a real browser
# and fails on a blank one.
npx tsx --env-file=.env script/_verify-pages-render.ts || {
  echo ""
  echo "🔴 A page is WHITE-SCREENING on production. Fix it or roll back now —"
  echo "   staff are looking at a blank screen."
  exit 1
}

# Only now — a deploy that landed AND verified — is this the state production
# serves. The next run diffs against it to show what is going out.
git rev-parse HEAD > .last-deployed-sha 2>/dev/null || true
