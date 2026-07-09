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

_GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "<unknown>")
echo "==============================================="
echo "  ClubOS deploy → app 'clubos' (Sydney)"
echo "  Branch     : ${_GIT_BRANCH}   ← D16: confirm this is the ONE canonical deploy branch"
echo "  Stripe key : ${VITE_STRIPE_PUBLISHABLE_KEY:0:11}…  (${#VITE_STRIPE_PUBLISHABLE_KEY} chars)"
echo "  Meta pixel : ${VITE_META_PIXEL_ID:-<none>}"
echo "==============================================="
echo "  ⚠️  Run any DB migration BEFORE this deploy if the schema changed."
echo "  ⚠️  After deploy, smoke-test /t.js (must be application/javascript, not text/html)."
echo ""

exec flyctl deploy -a clubos \
  --build-arg VITE_STRIPE_PUBLISHABLE_KEY="$VITE_STRIPE_PUBLISHABLE_KEY" \
  --build-arg VITE_META_PIXEL_ID="$VITE_META_PIXEL_ID" \
  "$@"
