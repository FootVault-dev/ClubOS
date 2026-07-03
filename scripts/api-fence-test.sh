#!/bin/bash
# External API conformance test — the scope-fence matrix. Read-only GETs.
#
# Run after ANY change to the /api/v1 surface or key middleware:
#
#   BASE=https://app.usg.co.nz \
#   ISAAC_KEY=clubos_... ZACH_KEY=clubos_... DANIEL_KEY=clubos_... \
#   bash scripts/api-fence-test.sh
#
# Keys come from env only — never hardcode them here. Sections whose key is
# missing are skipped. DANIEL_KEY falls back to CLUBOS_API_KEY from the AIOS
# root .env if present.

BASE="${BASE:-https://app.usg.co.nz}"
if [ -z "$DANIEL_KEY" ] && [ -f "$HOME/Desktop/AIOS/DanielMeynOS/.env" ]; then
  DANIEL_KEY=$(grep '^CLUBOS_API_KEY=' "$HOME/Desktop/AIOS/DanielMeynOS/.env" | cut -d= -f2 | tr -d '"')
fi

PASS=0; FAIL=0; SKIP=0
check() { # label key path expected_status
  local label="$1" key="$2" path="$3" want="$4" got
  if [ "$key" = "none" ]; then
    got=$(curl -s -o /dev/null -w "%{http_code}" "$BASE$path")
  elif [ -z "$key" ]; then
    SKIP=$((SKIP+1)); return
  else
    got=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $key" "$BASE$path")
  fi
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); echo "PASS  [$label] $path -> $got"
  else FAIL=$((FAIL+1)); echo "FAIL  [$label] $path -> got $got, want $want"; fi
}

echo "── Unauthenticated ──"
check "no-key"  none "/api/v1/overview" 401
check "bad-key" "clubos_deadbeef" "/api/v1/overview" 401

echo "── Security headers ──"
HDRS=$(curl -s -D - -o /dev/null "$BASE/api/v1/overview")
for h in "strict-transport-security" "x-content-type-options" "cache-control: no-store"; do
  if echo "$HDRS" | grep -qi "$h"; then PASS=$((PASS+1)); echo "PASS  [headers] $h present"
  else FAIL=$((FAIL+1)); echo "FAIL  [headers] $h MISSING"; fi
done

echo "── Zach key (overview, camps, registrations on CUFC only) ──"
check "zach" "$ZACH_KEY" "/api/v1/overview?days=7" 200
check "zach" "$ZACH_KEY" "/api/v1/camps" 200
check "zach" "$ZACH_KEY" "/api/v1/registrations?days=7&limit=3" 200
check "zach" "$ZACH_KEY" "/api/v1/order-timing?days=7" 200
check "zach" "$ZACH_KEY" "/api/v1/customers" 403
check "zach" "$ZACH_KEY" "/api/v1/analytics" 403
check "zach" "$ZACH_KEY" "/api/v1/split-tests" 403
check "zach" "$ZACH_KEY" "/api/v1/tournament/summary" 403
check "zach" "$ZACH_KEY" "/api/v1/tournament/teams" 403
check "zach" "$ZACH_KEY" "/api/v1/league/summary" 403
check "zach" "$ZACH_KEY" "/api/v1/league/teams" 403
check "zach" "$ZACH_KEY" "/api/v1/cic7s/registrations" 403
check "zach" "$ZACH_KEY" "/api/v1/sporty/registrations" 403

echo "── Isaac key (CIC + CIC7s + MFL only) ──"
check "isaac" "$ISAAC_KEY" "/api/v1/tournament/summary" 200
check "isaac" "$ISAAC_KEY" "/api/v1/tournament/teams" 200
check "isaac" "$ISAAC_KEY" "/api/v1/tournament/fixtures" 200
check "isaac" "$ISAAC_KEY" "/api/v1/tournament/fixtures?limit=5&offset=2" 200
check "isaac" "$ISAAC_KEY" "/api/v1/tournament/skills" 200
check "isaac" "$ISAAC_KEY" "/api/v1/cic7s/registrations" 200
check "isaac" "$ISAAC_KEY" "/api/v1/league/summary" 200
check "isaac" "$ISAAC_KEY" "/api/v1/league/teams" 200
check "isaac" "$ISAAC_KEY" "/api/v1/league/games?days=30" 200
check "isaac" "$ISAAC_KEY" "/api/v1/overview" 403
check "isaac" "$ISAAC_KEY" "/api/v1/camps" 403
check "isaac" "$ISAAC_KEY" "/api/v1/registrations" 403
check "isaac" "$ISAAC_KEY" "/api/v1/customers" 403
check "isaac" "$ISAAC_KEY" "/api/v1/sporty/registrations" 403

echo "── Full-scope key (regression + sporty + spec) ──"
check "daniel" "$DANIEL_KEY" "/api/v1/overview?days=7" 200
check "daniel" "$DANIEL_KEY" "/api/v1/camps" 200
check "daniel" "$DANIEL_KEY" "/api/v1/registrations?days=7&limit=3" 200
check "daniel" "$DANIEL_KEY" "/api/v1/tournament/summary" 200
check "daniel" "$DANIEL_KEY" "/api/v1/league/summary" 200
check "daniel" "$DANIEL_KEY" "/api/v1/sporty/registrations?program_type=academy&limit=2" 200
check "daniel" "$DANIEL_KEY" "/api/v1/sporty/registrations?program_type=holiday_camp&limit=2" 200
check "daniel" "$DANIEL_KEY" "/api/v1/openapi.json" 200

if [ -n "$DANIEL_KEY" ]; then
  echo "── Forbidden-field scan (Sporty export) ──"
  BODY=$(curl -s -H "Authorization: Bearer $DANIEL_KEY" "$BASE/api/v1/sporty/registrations?program_type=holiday_camp&limit=1" | tr '[:upper:]' '[:lower:]')
  LEAK=""
  for w in stripe medical allerg epi_pen fbclid gclid; do
    echo "$BODY" | grep -q "$w" && LEAK="$LEAK $w"
  done
  if [ -z "$LEAK" ]; then PASS=$((PASS+1)); echo "PASS  [fields] no forbidden fields in sporty export"
  else FAIL=$((FAIL+1)); echo "FAIL  [fields] LEAKED:$LEAK"; fi
fi

echo ""
echo "RESULT: $PASS passed, $FAIL failed, $SKIP skipped (missing keys)"
[ $FAIL -eq 0 ]
