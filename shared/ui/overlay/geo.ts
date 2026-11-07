/**
 * Position string parsing, shared by the browser (live_map element) and
 * the server (route-history recording). The wire format is
 * `"lon,lat"` — longitude FIRST, comma-separated, e.g. `"12.4034,50.1635"`.
 * A list of positions (e.g. `markerPositions`) joins them with `";"`.
 */

/** One parsed position, in degrees. */
export interface Position {
	lat: number;
	lon: number;
}

/** Parse one `"lon,lat"` string. `null` when the shape is wrong, a part is
 * not a finite number, or a coordinate is out of range (lat ±90, lon ±180)
 * — callers fall back to their own defaults. */
export function parsePosition(raw: unknown): Position | null {
	if (typeof raw !== "string") return null;
	const parts = raw.split(",");
	if (parts.length !== 2) return null;
	const lon = Number(parts[0].trim());
	const lat = Number(parts[1].trim());
	if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
	if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
	return { lat, lon };
}

/** Format a position back to the `"lon,lat"` wire string (6 decimal places,
 * trailing zeros trimmed). */
export function formatPosition(lon: number, lat: number): string {
	const f = (n: number): string =>
		n.toLocaleString("en", { maximumFractionDigits: 6 }).replace(/,/g, "");
	return `${f(lon)},${f(lat)}`;
}

/** Parse a `";"`-separated position list; empty/invalid entries are
 * dropped, so the result only ever contains usable positions. */
export function parsePositions(raw: unknown): Position[] {
	if (typeof raw !== "string") return [];
	const out: Position[] = [];
	for (const entry of raw.split(";")) {
		if (!entry.trim()) continue;
		const p = parsePosition(entry);
		if (p) out.push(p);
	}
	return out;
}
