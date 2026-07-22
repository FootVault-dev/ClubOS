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

echo "── Zach key: programme fence (holiday camps + u4-u8 ONLY) ──"
# The scope matrix above proves WHICH ENDPOINTS he reaches. This proves WHAT COMES
# BACK from the ones he does — a 200 on /camps is not a pass if it lists the academy.
# Requires ZACH_KEY to carry a program_filter; skipped otherwise.
if [ -z "$ZACH_KEY" ]; then
  echo "SKIP  [zach-fence] no ZACH_KEY set"; SKIP=$((SKIP+1))
elif ! command -v jq >/dev/null 2>&1; then
  echo "SKIP  [zach-fence] jq not installed"; SKIP=$((SKIP+1))
else
  zget() { curl -s -H "Authorization: Bearer $ZACH_KEY" "$BASE$1"; }

  # The permitted set is derived from the RULE (type is a holiday camp, or the
  # slug is u4-u8) applied to the programme list — NOT from whatever /camps
  # happens to return. Taking /camps at its word would make the registration and
  # revenue checks tautological: with the fence off, every programme is "allowed"
  # and they would pass while the data leaks. Classifying on `type` rather than a
  # name pattern also stops a programme called "Academy Holiday Camp" sneaking in.
  CAMPS_BODY=$(zget "/api/v1/camps")
  ALLOWED=$(echo "$CAMPS_BODY" | jq -r '.camps[] | select(.type == "holiday_camp" or .slug == "u4-u8") | .slug' 2>/dev/null)
  if [ -z "$ALLOWED" ]; then
    FAIL=$((FAIL+1)); echo "FAIL  [zach-fence] /camps returned no parseable programme list — body: $(echo "$CAMPS_BODY" | head -c 200)"
  else
    # 1. /camps itself must contain nothing but holiday camps + u4-u8.
    OFFENDERS=$(echo "$CAMPS_BODY" | jq -r '.camps[] | select(.type != "holiday_camp" and .slug != "u4-u8") | .slug' 2>/dev/null)
    JQ_RC=$?
    if [ $JQ_RC -ne 0 ]; then
      FAIL=$((FAIL+1)); echo "FAIL  [zach-fence] /camps response did not parse (jq rc=$JQ_RC) — an error body must never read as a pass"
    elif [ -n "$OFFENDERS" ]; then
      FAIL=$((FAIL+1)); echo "FAIL  [zach-fence] /camps leaked: $(echo "$OFFENDERS" | tr '\n' ' ')"
    else
      PASS=$((PASS+1)); echo "PASS  [zach-fence] /camps lists only holiday camps + u4-u8 ($(echo "$ALLOWED" | wc -l | tr -d ' ') programmes)"
    fi

    # 2. Every registration, paging the WHOLE year — not just the first page.
    OFF=""; TOTAL=0; OFFSET=0
    while :; do
      PAGE=$(zget "/api/v1/registrations?days=365&limit=200&offset=$OFFSET")
      N=$(echo "$PAGE" | jq -r '.registrations | length' 2>/dev/null)
      if [ -z "$N" ] || [ "$N" = "null" ]; then
        FAIL=$((FAIL+1)); echo "FAIL  [zach-fence] /registrations did not parse at offset $OFFSET"; break
      fi
      [ "$N" -eq 0 ] && break
      TOTAL=$((TOTAL+N))
      BAD=$(echo "$PAGE" | jq -r --argjson allow "$(echo "$ALLOWED" | jq -R . | jq -s .)" \
            '.registrations[] | select([.campSlug] | inside($allow) | not) | .campSlug' 2>/dev/null | sort -u)
      [ -n "$BAD" ] && OFF="$OFF $BAD"
      OFFSET=$((OFFSET+200))
      [ "$OFFSET" -gt 2000 ] && break   # sanity stop
    done
    if [ -n "$(echo "$OFF" | tr -d ' ')" ]; then
      FAIL=$((FAIL+1)); echo "FAIL  [zach-fence] /registrations leaked families from:$(echo "$OFF" | tr '\n' ' ')"
    else
      PASS=$((PASS+1)); echo "PASS  [zach-fence] all $TOTAL registrations (365d, paged) belong to his programmes"
    fi

    # 3. Revenue breakdown must name only permitted programmes.
    REVBAD=$(zget "/api/v1/revenue?days=365" | jq -r --argjson allow "$(echo "$ALLOWED" | jq -R . | jq -s .)" \
             '.camps[] | select([.slug] | inside($allow) | not) | .slug' 2>/dev/null)
    if [ -n "$REVBAD" ]; then
      FAIL=$((FAIL+1)); echo "FAIL  [zach-fence] /revenue leaked: $(echo "$REVBAD" | tr '\n' ' ')"
    else
      PASS=$((PASS+1)); echo "PASS  [zach-fence] /revenue breaks down only his programmes"
    fi
  fi
fi

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
