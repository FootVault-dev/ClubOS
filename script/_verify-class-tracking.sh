#!/bin/zsh
# Post-deploy verification for the class-book Meta Purchase fix.
#
# Two things a route probe CANNOT tell you, so both are checked here:
#   1. that nothing else was removed by this deploy (the silent-deletion failure mode)
#   2. that the CLIENT bundle actually carries the pixel — the server route
#      answering 200 says nothing about whether initPixel shipped
#
# `deploy.sh` and flyctl both exit 0 on failure, so never trust the deploy's exit
# code. Run this instead. Uses /usr/bin/curl explicitly: node's fetch is dead on
# this Mac (reference_clubos_node_fetch_broken) and `curl` drops out of PATH
# inside a `while read` loop.
set -u
CURL=/usr/bin/curl
BASE=https://app.usg.co.nz
fail=0

echo "── 1. nothing removed (canary probe) ────────────────────────────────"
probe() {  # feature | path
  local code
  code=$($CURL -so/dev/null -w '%{http_code}' --max-time 20 --retry 2 "$BASE$2")
  case "$code" in
    200|204|401|403|405) printf "  ✓ %-24s %s\n" "$1" "$code" ;;
    404) printf "  ❌ %-24s GONE (404)\n" "$1"; fail=1 ;;
    *)   printf "  ⚠ %-24s %s (recheck)\n" "$1" "$code" ;;
  esac
}
probe "parent accounts"   /api/public/parent/me
probe "staff chat"        /api/admin/chat/bootstrap
probe "task tracker"      /api/admin/task-tracker/bootstrap
probe "families"          "/api/admin/people?q=a"
probe "hiring"            /api/admin/hiring/jobs
probe "invoices"          /api/admin/invoices
probe "warehouse"         /api/admin/warehouse/items
probe "knowledge base"    /api/admin/kb/articles
probe "club drive"        /api/admin/drive/bootstrap
probe "equipment"         /api/admin/equipment/overview
probe "fines"             /api/admin/fines
probe "coding budget"     /api/admin/coding-budget
probe "accommodation"     /api/admin/housing/overview
probe "ethnic cup"        /api/admin/ethnic-cup/registrations
probe "market research"   /api/admin/market-research
probe "proposals"         /api/admin/proposals
probe "sponsor traffic"   /api/admin/sponsor-traffic
probe "videos"            /api/admin/videos
probe "CUGC mailer"       /api/admin/cugc/mailer/contacts
probe "print requests"    /api/admin/print-requests
probe "UP quote materials" /api/public/unitedprints/quote-materials
probe "shop (MFL)"        /api/public/shop/mfl/catalog
probe "attribution /t.js" /t.js

echo ""
echo "── 2. /t.js is JavaScript, not the SPA's HTML ───────────────────────"
ct=$($CURL -so/dev/null -w '%{content_type}' --max-time 20 "$BASE/t.js")
case "$ct" in
  *javascript*) echo "  ✓ $ct" ;;
  *) echo "  ❌ /t.js serving '$ct' — AttributionOS is broken"; fail=1 ;;
esac

echo ""
echo "── 3. the client bundle carries the class-book pixel ────────────────"
chunk=$($CURL -s --max-time 20 "$BASE/" | grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' | head -1)
echo "  bundle: $chunk"
js=$($CURL -s --max-time 90 "$BASE$chunk")
echo "  bytes:  $(printf '%s' "$js" | wc -c | tr -d ' ')"
for m in "Term Programme" "class-book" "fbevents.js"; do
  if printf '%s' "$js" | grep -q -- "$m"; then echo "  ✓ found: $m"
  else echo "  ❌ MISSING from bundle: $m"; fail=1; fi
done

echo ""
echo "── 4. admin tabs still in the bundle ────────────────────────────────"
for m in /admin/coding-budget /admin/fines /admin/equipment /admin/accommodation \
         /admin/ethnic-cup /admin/task-tracker /admin/drive /admin/knowledge-base; do
  printf '%s' "$js" | grep -q -- "$m" && echo "  ✓ $m" || { echo "  ❌ GONE: $m"; fail=1; }
done

echo ""
[ "$fail" = 0 ] && echo "✅ ALL CHECKS PASSED" || echo "❌ FAILURES ABOVE — do not walk away"
exit $fail
