#!/usr/bin/env bash
# Trigger a universal event on the runtime endpoint.
#
# The event is the URL's <name> — the runtime page routes it to every
# trigger-driven element (alerts, spin wheel, …) whose Event prop equals it
# (consecutive triggers queue FIFO).
# Optional name=value pairs set project variables in the same call; the
# values persist (they are never cleared).
#
#   ./scripts/test_alert_trigger.sh <token> <overlayId> <eventName> [name=value]…
#
#   token       the overlay owner's user token (profile device token)
#   overlayId   the overlay the event targets (its runtime URL's id)
#   eventName   the event name configured on the element
#   name=value  optional variable name → value (numbers as-is, booleans
#               as true/false)
#
# IRLCTRL_BASE defaults to http://localhost:8090.

set -euo pipefail

if [ "$#" -lt 3 ]; then
	echo "usage: $0 <token> <overlayId> <eventName> [name=value]…" >&2
	exit 1
fi

BASE="${IRLCTRL_BASE:-http://localhost:8090}"
TOKEN="$1"
OVERLAY_ID="$2"
EVENT_NAME="$3"
shift 3

args=(-G "$BASE/overlay/$OVERLAY_ID/event/$EVENT_NAME" --data-urlencode "token=$TOKEN")
for pair in "$@"; do
	# curl accepts name=value directly with --data-urlencode and URL-encodes it
	args+=("--data-urlencode" "$pair")
done

resp=$(curl -sS "${args[@]}")

case "$resp" in
*'"ok":true'*) ;;
*)
	echo "✖ event trigger failed: $resp" >&2
	exit 1
	;;
esac

echo "✓ event triggered ($EVENT_NAME): $resp"
