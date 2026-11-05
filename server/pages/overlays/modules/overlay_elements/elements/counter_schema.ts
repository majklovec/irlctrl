/*
 * Counter element — the schema half: props contract, defaults and
 * normalization (environment-free, shared by the server's scene validator
 * and the browser editor). The rendering and inspector halves live in
 * counter.tsx. Aggregated in ../overlay_schema.ts.
 */
import type { OverlayElementSchema } from "../../../../../core/overlay_element";
import { textRows, cleanNum } from "./schema_utils";

/* ── counter ──────────────────────────────────────────────────────────── */
export interface CounterProps {
    title: string;
    /** Up to four counters; `value` is bindable per-counter by variable. */
    counters: Array<{ label: string; value: number }>;
    layout: "row" | "column";
    color: string;
    accent: string;
    background: string;
    radius: number;
    fontSize: number;
    fontFamily: string;
}
export const DEFAULT_COUNTER_PROPS: Required<CounterProps> = {
    title: "",
    counters: [
        { label: "Wins", value: 0 },
        { label: "Losses", value: 0 },
    ],
    layout: "row",
    color: "#ffffff",
    accent: "#f59e0b",
    background: "#111827",
    radius: 10,
    fontSize: 26,
    fontFamily: "Inter, system-ui, sans-serif",
};
export const counterSchema: OverlayElementSchema = {
    type: "counter",
    defaultProps: DEFAULT_COUNTER_PROPS,
    normalizeProps(props, read) {
        const d = DEFAULT_COUNTER_PROPS;
        return {
            title: read.str("title", d.title, 120),
            counters: textRows(props.counters, 4, {
                key: "value",
                kind: "num",
            }).map((r) => ({
                label: String(r.label),
                value: cleanNum(r.value, 0, -1e12, 1e12),
            })),
            layout: read.oneOf("layout", ["row", "column"], d.layout),
            color: read.hex("color", d.color),
            accent: read.hex("accent", d.accent),
            background: read.hex("background", d.background),
            radius: read.num("radius", d.radius, 0, 500),
            fontSize: read.num("fontSize", d.fontSize, 6, 400),
            fontFamily: read.str("fontFamily", d.fontFamily, 300),
        };
    },
};
