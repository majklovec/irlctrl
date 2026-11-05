/*
 * Weather element — the schema half: props contract, defaults and
 * normalization (environment-free, shared by the server's scene validator
 * and the browser editor). The rendering and inspector halves live in
 * weather.tsx. Aggregated in ../overlay_schema.ts.
 */
import type { OverlayElementSchema } from "../../../../../core/overlay_element";

/* ── weather ──────────────────────────────────────────────────────────── */
export interface WeatherProps {
    latitude: number;
    longitude: number;
    /** Optional place name shown under the reading. */
    place: string;
    format: "card" | "pill";
    /** Refresh period in seconds. */
    refreshSec: number;
    showTemp: boolean;
    showWind: boolean;
    showHumidity: boolean;
    color: string;
    background: string;
    accent: string;
    radius: number;
    fontSize: number;
    fontFamily: string;
}
export const DEFAULT_WEATHER_PROPS: Required<WeatherProps> = {
    latitude: 50.0755,
    longitude: 14.4378,
    place: "",
    format: "card",
    refreshSec: 900,
    showTemp: true,
    showWind: true,
    showHumidity: false,
    color: "#ffffff",
    background: "#1f2937",
    accent: "#38bdf8",
    radius: 12,
    fontSize: 24,
    fontFamily: "Inter, system-ui, sans-serif",
};
export const weatherSchema: OverlayElementSchema = {
    type: "weather",
    defaultProps: DEFAULT_WEATHER_PROPS,
    normalizeProps(_p, read) {
        const d = DEFAULT_WEATHER_PROPS;
        return {
            latitude: read.num("latitude", d.latitude, -90, 90),
            longitude: read.num("longitude", d.longitude, -180, 180),
            place: read.str("place", "", 120),
            format: read.oneOf("format", ["card", "pill"], d.format),
            refreshSec: read.num("refreshSec", d.refreshSec, 60, 3600),
            // `read.bool` can't express a `true` default (a missing key reads
            // `false`), so keep the stored value unless it is a real boolean.
            showTemp:
                typeof _p.showTemp === "boolean" ? _p.showTemp : d.showTemp,
            showWind: read.bool("showWind"),
            showHumidity: read.bool("showHumidity"),
            color: read.hex("color", d.color),
            background: read.hex("background", d.background),
            accent: read.hex("accent", d.accent),
            radius: read.num("radius", d.radius, 0, 500),
            fontSize: read.num("fontSize", d.fontSize, 6, 400),
            fontFamily: read.str("fontFamily", d.fontFamily, 300),
        };
    },
};
