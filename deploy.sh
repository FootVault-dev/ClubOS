#!/bin/zsh
# Canonical ClubOS production deploy.
#
# CRITICAL: Vite inlines VITE_* env vars at BUILD time. The Dockerfile takes
# them as --build-arg. If you run a bare `fly deploy`, the client bundle ships
# with an EMPTY Stripe key + Meta pixel id → blank checkout (Elements can't
# mount) and no Facebook tracking. (This is exactly what broke v114.)
#
# Always deploy with this script so the VITE_* values from .env are passed.
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

echo "==============================================="
echo "  ClubOS deploy → app 'clubos' (Sydney)"
echo "  Stripe key : ${VITE_STRIPE_PUBLISHABLE_KEY:0:11}…  (${#VITE_STRIPE_PUBLISHABLE_KEY} chars)"
echo "  Meta pixel : ${VITE_META_PIXEL_ID:-<none>}"
echo "==============================================="
echo "  ⚠️  Run any DB migration BEFORE this deploy if the schema changed."
echo ""

exec flyctl deploy -a clubos \
  --build-arg VITE_STRIPE_PUBLISHABLE_KEY="$VITE_STRIPE_PUBLISHABLE_KEY" \
  --build-arg VITE_META_PIXEL_ID="$VITE_META_PIXEL_ID" \
  "$@"
