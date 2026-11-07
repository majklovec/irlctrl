#!/usr/bin/env bash
# Test script: simulates a moving GPS route in repeating segments.
#
# Each segment sends SEGMENT positions (default 100) as ONE `pos` variable in
# the overlay's `"lon,lat"` wire format (longitude first) — the value a
# `centerPosition` binding expects — then fires a `path.end/<random name>`
# event, which renames + archives the live `default` route server-side (the
# next position opens a fresh segment). The segments repeat forever
# (Ctrl+C to stop).
#
# Usage:
#   ./scripts/test_gps.sh                               # forever, 5 s ticks
#   SEGMENT=20 SEGMENTS=3 INTERVAL=1 ./scripts/test_gps.sh
#   LAT=48.2082 LON=16.3738 DRIFT=0.0001 ./scripts/test_gps.sh
set -euo pipefail

OVERLAY_ID="${OVERLAY_ID:-07bde5e0-e2be-4119-b54a-735e9318228d}"
TOKEN="${TOKEN:-e91c2fe89b4b9190d19750298bcf943c010c058642bbde0e}"
BASE_URL="${BASE_URL:-http://localhost:8090}"
LAT="${LAT:-50.0875}" # start position (Prague)
LON="${LON:-14.4213}"
INTERVAL="${INTERVAL:-5}" # seconds between updates
SEGMENT="${SEGMENT:-100}" # positions per segment
SEGMENTS="${SEGMENTS:-0}" # segments to send; 0 = forever
DRIFT="${DRIFT:-0.00001}" # max latitude/longitude change per tick

vars_url="$BASE_URL/overlay/$OVERLAY_ID/variables"
event_url="$BASE_URL/overlay/$OVERLAY_ID/event"

# random walk: nudge lat/lon by up to ±DRIFT
drift() {
	awk -v lat="$LAT" -v lon="$LON" -v d="$DRIFT" 'BEGIN {
		srand();
		printf "%.6f %.6f\n", lat + (rand() - 0.5) * d, lon + (rand() - 0.5) * d
	}'
}

# close the segment: rename the live `default` route to a random name
name="route-$(date +%H%M%S)-$RANDOM"
status=$(curl -s -o /dev/null -w '%{http_code}' \
	"$event_url/path.end/$name?token=$TOKEN" || echo "000")

if [ "$status" = "200" ]; then
	echo "[$(date +%H:%M:%S)] closed  ->  path.end/$name  HTTP $status"
else
	echo "[$(date +%H:%M:%S)] closed  ->  path.end/$name  HTTP $status (is the server running?)"
fi

seg=0
while :; do
	seg=$((seg + 1))
	for ((i = 1; i <= SEGMENT; i++)); do
		read -r LAT LON < <(drift)

		# one variable, "lon,lat" (longitude FIRST)
		pos="$LON,$LAT"

		status=$(curl -s -o /dev/null -w '%{http_code}' \
			"$vars_url?token=$TOKEN&pos=$pos" || echo "000")

		if [ "$status" = "200" ]; then
			echo "[$(date +%H:%M:%S)] seg#$seg pos $i/$SEGMENT $pos  ->  HTTP $status"
		else
			echo "[$(date +%H:%M:%S)] seg#$seg pos $i/$SEGMENT $pos  ->  HTTP $status (is the server running?)"
		fi

		if [ "$i" -lt "$SEGMENT" ]; then sleep "$INTERVAL"; fi
	done

	# close the segment: rename the live `default` route to a random name
	name="route-$(date +%H%M%S)-$RANDOM"
	status=$(curl -s -o /dev/null -w '%{http_code}' \
		"$event_url/path.end/$name?token=$TOKEN" || echo "000")

	if [ "$status" = "200" ]; then
		echo "[$(date +%H:%M:%S)] seg#$seg closed  ->  path.end/$name  HTTP $status"
	else
		echo "[$(date +%H:%M:%S)] seg#$seg closed  ->  path.end/$name  HTTP $status (is the server running?)"
	fi

	if [ "$SEGMENTS" != "0" ] && [ "$seg" -ge "$SEGMENTS" ]; then
		break
	fi
	sleep "$INTERVAL"
done
