#!/usr/bin/env bash
# Trigger an alert by revaluing a variable on the runtime endpoint.
#
# The runtime page fires every alert whose trigger variable is the revalued
# variable's name, so this single request is the trigger:
#
#   ./scripts/test_alert_trigger.sh <scene> <token> <variableId> <value>
#
#   scene       scene slug to run the check against (e.g. scene-1)
#   token       the project's overlay token
#   variableId  the variable's id (visible in the editor's Variables panel)
#   value       the new value (numbers as-is, booleans as true/false)
#
# IRLCTRL_BASE defaults to http://localhost:8090.

set -euo pipefail

if [ "$#" -ne 4 ]; then
    echo "usage: $0 <scene> <token> <variableId> <value>" >&2
    exit 1
fi

BASE="${IRLCTRL_BASE:-http://localhost:8090}"
SCENE="$1"
TOKEN="$2"
VAR_ID="$3"
VALUE="$4"

resp=$(curl -sS -G "$BASE/overlay/variables/$VAR_ID" \
    --data-urlencode "token=$TOKEN" \
    --data-urlencode "value=$VALUE")

case "$resp" in
    *'"ok":true'*) ;;
    *) echo "✖ revaluation failed: $resp" >&2; exit 1 ;;
esac

echo "✓ variable revalued: $resp"
echo "→ watch the runtime page for the alert: $BASE/overlay/$SCENE?token=***"
