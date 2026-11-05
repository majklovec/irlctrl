/*
 * Lower third element — the schema half: props contract, defaults and
 * normalization (environment-free, shared by the server's scene validator
 * and the browser editor). The rendering and inspector halves live in
 * lower_third.tsx. Aggregated in ../overlay_schema.ts.
 */
import type { OverlayElementSchema } from "../../../../../core/overlay_element";
import { cleanStr } from "./schema_utils";

/* ── lower third ──────────────────────────────────────────────────────── */
export interface LowerThirdProps {
    /** The name/topic lines; rotate cycles through them. */
    entries: Array<{ name: string; topic: string }>;
    rotate: boolean;
    /** Per-entry time in ms (rotation). */
    interval: number;
    color: string;
    background: string;
    accent: string;
    radius: number;
    fontSize: number;
    fontFamily: string;
}
export const DEFAULT_LOWER_THIRD_PROPS: Required<LowerThirdProps> = {
    entries: [{ name: "Your Name", topic: "Your topic here" }],
    rotate: false,
    interval: 6000,
    color: "#ffffff",
    background: "#111827",
    accent: "#38bdf8",
    radius: 8,
    fontSize: 30,
    fontFamily: "Inter, system-ui, sans-serif",
};
export const lowerThirdSchema: OverlayElementSchema = {
    type: "lower_third",
    defaultProps: DEFAULT_LOWER_THIRD_PROPS,
    normalizeProps(props, read) {
        const d = DEFAULT_LOWER_THIRD_PROPS;
        const raw = Array.isArray(props.entries) ? props.entries : [];
        return {
            entries: raw.slice(0, 16).map((item) => {
                const rec =
                    typeof item === "object" && item !== null
                        ? (item as Record<string, unknown>)
                        : {};
                return {
                    name: cleanStr(rec.name, 120),
                    topic: cleanStr(rec.topic, 200),
                };
            }),
            rotate: read.bool("rotate"),
            interval: read.num("interval", d.interval, 1000, 600000),
            color: read.hex("color", d.color),
            background: read.hex("background", d.background),
            accent: read.hex("accent", d.accent),
            radius: read.num("radius", d.radius, 0, 500),
            fontSize: read.num("fontSize", d.fontSize, 6, 400),
            fontFamily: read.str("fontFamily", d.fontFamily, 300),
        };
    },
};
