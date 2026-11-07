#!/usr/bin/env bash
# Test script: simulates a moving GPS position and periodically pushes it to a
# map overlay through the variables endpoint. The position is sent as ONE
# `pos` variable in the overlay's `"lon,lat"` wire format (longitude first) —
# the value a `centerPosition` binding expects.
#
# Usage:
#   ./scripts/test_gps.sh                  # run forever, 5 s interval, Ctrl+C to stop
#   INTERVAL=2 COUNT=10 ./scripts/test_gps.sh
#   LAT=48.2082 LON=16.3738 ./scripts/test_gps.sh
set -euo pipefail

OVERLAY_ID="${OVERLAY_ID:-07bde5e0-e2be-4119-b54a-735e9318228d}"
TOKEN="${TOKEN:-e91c2fe89b4b9190d19750298bcf943c010c058642bbde0e}"
BASE_URL="${BASE_URL:-http://localhost:8090}"
LAT="${LAT:-50.0875}"  # start position (Prague)
LON="${LON:-14.4213}"
INTERVAL="${INTERVAL:-5}"  # seconds between updates
COUNT="${COUNT:-0}"        # 0 = run forever
DRIFT="${DRIFT:-0.001}"    # max latitude/longitude change per tick

url="$BASE_URL/overlay/$OVERLAY_ID/variables"

n=0
while :; do
	# random walk: nudge lat/lon by up to ±DRIFT
	read -r LAT LON < <(
		awk -v lat="$LAT" -v lon="$LON" -v d="$DRIFT" 'BEGIN {
			srand();
			printf "%.6f %.6f\n", lat + (rand() - 0.5) * d, lon + (rand() - 0.5) * d
		}'
	)

	# one variable, "lon,lat" (longitude FIRST)
	pos="$LON,$LAT"

	status=$(curl -s -o /dev/null -w '%{http_code}' \
		"$url?token=$TOKEN&pos=$pos" || echo "000")

	n=$((n + 1))
	if [ "$status" = "200" ]; then
		echo "[$(date +%H:%M:%S)] #$n pos=$pos  ->  HTTP $status"
	else
		echo "[$(date +%H:%M:%S)] #$n pos=$pos  ->  HTTP $status (is the server running?)"
	fi

	if [ "$COUNT" != "0" ] && [ "$n" -ge "$COUNT" ]; then
		break
	fi
	sleep "$INTERVAL"
done
