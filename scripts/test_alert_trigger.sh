#!/usr/bin/env bash
# Trigger an alert on the runtime endpoint.
#
# The alert event is the URL's <name> — the runtime page shows every alert
# element whose Event prop equals it (consecutive triggers queue FIFO).
# Optional name=value pairs set project variables in the same call; the
# values persist (they are never cleared).
#
#   ./scripts/test_alert_trigger.sh <token> <alertName> [name=value]…
#
#   token       the project's overlay token
#   alertName   the event name configured on the alert element
#   name=value  optional variable name → value (numbers as-is, booleans
#               as true/false)
#
# IRLCTRL_BASE defaults to http://localhost:8090.

set -euo pipefail

if [ "$#" -lt 2 ]; then
	echo "usage: $0 <token> <alertName> [name=value]…" >&2
	exit 1
fi

BASE="${IRLCTRL_BASE:-http://localhost:8090}"
TOKEN="$1"
ALERT_NAME="$2"
shift 2

args=(-G "$BASE/overlay/alert/$ALERT_NAME" --data-urlencode "token=$TOKEN")
for pair in "$@"; do
	# curl accepts name=value directly with --data-urlencode and URL-encodes it
	args+=("--data-urlencode" "$pair")
done

resp=$(curl -sS "${args[@]}")

case "$resp" in
*'"ok":true'*) ;;
*)
	echo "✖ alert trigger failed: $resp" >&2
	exit 1
	;;
esac

echo "✓ alert triggered ($ALERT_NAME): $resp"
