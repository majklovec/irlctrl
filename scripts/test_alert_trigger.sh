#!/usr/bin/env bash
# Trigger an alert by revaluing a variable on the runtime endpoint.
#
# The runtime page fires every alert whose trigger variable is the revalued
# variable's name, so this single request is the trigger:
#
#   ./scripts/test_alert_trigger.sh <token> <variableName> <value>
#
#   token          the project's overlay token
#   variableName   the variable's name (visible in the editor's Variables panel)
#   value          the new value (numbers as-is, booleans as true/false)
#
# IRLCTRL_BASE defaults to http://localhost:8090.

set -euo pipefail

if [ "$#" -ne 3 ]; then
	echo "usage: $0 <token> <variableName> <value>" >&2
	exit 1
fi

BASE="${IRLCTRL_BASE:-http://localhost:8090}"
TOKEN="$1"
VAR_NAME="$2"
VALUE="$3"

resp=$(curl -sS -G "$BASE/overlay/variables" \
	--data-urlencode "token=$TOKEN" \
	--data-urlencode "$VAR_NAME=$VALUE")

case "$resp" in
*'"ok":true'*) ;;
*)
	echo "✖ revaluation failed: $resp" >&2
	exit 1
	;;
esac

echo "✓ variable revalued: $resp"
