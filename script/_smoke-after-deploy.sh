#!/bin/zsh
# Post-deploy smoke check for app.usg.co.nz.
#
# 🔴 deploy.sh exits 0 even when flyctl fails, so its exit code proves nothing.
# The only trustworthy answer is asking production what it serves. An admin
# route returns 401 if its code is on prod and 404 if it is not — auth runs
# before the DB, so 401 means "the route exists", not "the feature works".
BASE=https://app.usg.co.nz
pass=0; fail=0

chk() {  # name  path  expected
  local got
  got=$(curl -so/dev/null --max-time 15 -w '%{http_code}' "$BASE$2")
  if [ "$got" = "$3" ]; then pass=$((pass+1)); printf "  ok   %-30s %s\n" "$1" "$got"
  else fail=$((fail+1)); printf "  FAIL %-30s got %s want %s\n" "$1" "$got" "$3"; fi
}

echo "\n── The two features this deploy had to carry ─────────────────────────"
chk "warehouse models (NEW)"     /api/admin/warehouse/models          401
chk "catalogue.csv (NEW)"        /api/admin/warehouse/catalogue.csv   401
chk "suggestions (NEW)"          /api/admin/warehouse/suggestions     401
chk "staff refunds (parallel)"   /api/admin/registrations/refund      401
# 🔴 variant-details is POST-only. A GET on it returns 404 in Express, which
# looks EXACTLY like a route that was never deployed. Probe it as a POST.
printf "  "
got=$(curl -so/dev/null --max-time 15 -w '%{http_code}' -X POST \
      -H 'Content-Type: application/json' -d '{"itemIds":[1]}' \
      "$BASE/api/admin/warehouse/variant-details")
[ "$got" = "401" ] && { pass=$((pass+1)); printf "ok   %-30s %s (POST)\n" "variant details (NEW)" "$got"; } \
                   || { fail=$((fail+1)); printf "FAIL %-30s got %s want 401\n" "variant details (NEW)" "$got"; }

echo "\n── Nothing else was removed ──────────────────────────────────────────"
# 🔴 Probe the REAL registered path, never the tab slug. A bare slug gives a
# false 404 and reads as a feature this deploy deleted — the trap that has
# wasted time here before. These match script/preflight-deploy.ts's canaries.
chk "warehouse items"     /api/admin/warehouse/items              401
chk "warehouse locations" /api/admin/warehouse/locations          401
chk "warehouse counts"    /api/admin/warehouse/counts             401
chk "feedback board"      /api/admin/feedback                     401
chk "proposals"           /api/admin/proposals                    401
chk "market research"     /api/admin/market-research              401
chk "content calendar"    /api/admin/content/items                401
chk "staff chat"          /api/admin/chat/bootstrap               401
chk "notifications"       /api/admin/notifications/preferences    401
chk "task tracker"        /api/admin/task-tracker/bootstrap       401
chk "hiring"              /api/admin/hiring/jobs                  401
chk "invoices"            /api/admin/invoices                     401
chk "staff videos"        /api/admin/videos                       401
chk "families / people"   /api/admin/people                       401
chk "sporty NRS"          /api/admin/sporty/overview              401
# 🔴 Parent accounts is a PUBLIC feature (cufc.co.nz/account), not an admin
# tab — there is no /api/admin path for it. It has been silently deleted by a
# deploy once already, so it is worth probing every time, on the right path.
chk "parent accounts"     /api/public/parent/prefill              200
chk "parent accounts API" /api/public/parent/me                   401

echo "\n── Customer-facing, and the one that has silently regressed before ───"
chk "shop catalog (MFL)" /api/public/shop/mfl/catalog 200
printf "  %-35s %s\n" "attribution /t.js content-type" \
  "$(curl -sI --max-time 15 $BASE/t.js | grep -i '^content-type' | tr -d '\r')"
curl -sI --max-time 15 $BASE/t.js | grep -qi 'application/javascript' \
  && { pass=$((pass+1)); echo "  ok   /t.js is JavaScript, not HTML"; } \
  || { fail=$((fail+1)); echo "  FAIL /t.js regressed to HTML — reship"; }

echo "\n$pass passed, $fail failed\n"
[ $fail -eq 0 ]
