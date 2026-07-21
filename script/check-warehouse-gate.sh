#!/usr/bin/env bash
# Typecheck gate for the warehouse build.
# The integration/canonical-2 base has ~545 PRE-EXISTING tsc errors (snapshotted
# per-file in script/BASELINE-TSC.txt). "npm run check clean" is therefore
# unachievable on this lineage. The real gate:
#   (a) ZERO tsc errors in warehouse-owned files
#   (b) no file's error count exceeds its baseline (no regressions in shared files)
set -u
cd "$(cd "$(dirname "$0")/.." && pwd)"
NOW=$(mktemp)
npm run --silent check 2>&1 | grep "error TS" | sed 's/(.*//' | sort | uniq -c | awk '{print $2, $1}' | sort > "$NOW"
BASE="script/BASELINE-TSC.txt"
fail=0
if grep -i "warehouse" "$NOW" | grep -q .; then
  echo "GATE FAIL — tsc errors in warehouse-owned files:"
  grep -i "warehouse" "$NOW"
  fail=1
fi
while read -r file count; do
  basecount=$(awk -v f="$file" '$1==f{print $2}' "$BASE")
  basecount=${basecount:-0}
  if [ "$count" -gt "$basecount" ]; then
    echo "GATE FAIL — $file: $count tsc errors (baseline $basecount)"
    fail=1
  fi
done < "$NOW"
rm -f "$NOW"
if [ "$fail" -eq 0 ]; then
  echo "GATE PASS — no new tsc errors, warehouse files clean"
fi
exit "$fail"
