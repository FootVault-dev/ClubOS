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
