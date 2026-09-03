#!/usr/bin/env bash
# A \uXXXX escape is real in a JS string and LITERAL TEXT in JSX.
#
# 2026-09-03: the QR Code Generator shipped reading
#   "Editable — must be one of our own domains."
# on production, on every screen. tsc passed, the build passed, 27 live checks
# and 17 browser checks passed — every one of them asserted behaviour, and this
# is a thing you can only SEE. Caught by looking at the screenshot.
#
# Matches an escape that is NOT inside quotes on that line, which is the shape
# that only happens in JSX text.
set -u
cd "$(dirname "$0")/.."
hits=$(grep -rnE '^[^"'"'"'`]*\\u[0-9a-fA-F]{4}' client/src --include=*.tsx | grep -vE '\\\\u' || true)
if [ -n "$hits" ]; then
  echo "🔴 Literal \\uXXXX in JSX text — this renders as the escape, not the character:"
  echo "$hits" | sed 's/^/   /'
  exit 1
fi
echo "✓ no literal unicode escapes in JSX text"
