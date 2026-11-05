/*
 * Spin wheel element — the schema half: props contract, defaults and
 * normalization (environment-free, shared by the server's scene validator
 * and the browser editor). The rendering and inspector halves live in
 * spin_wheel.tsx. Aggregated in ../overlay_schema.ts.
 */
import type { OverlayElementSchema } from "../../../../../core/overlay_element";
import { cleanStr } from "./schema_utils";

/* ── spin wheel ───────────────────────────────────────────────────────── */
export interface SpinWheelProps {
    /** The trigger event that spins the wheel (the universal event channel). */
    event: string;
    prizes: string[];
    /** Spin duration in ms. */
    duration: number;
    color: string;
    accent: string;
    radius: number;
    fontSize: number;
    fontFamily: string;
}
export const DEFAULT_SPIN_WHEEL_PROPS: Required<SpinWheelProps> = {
    event: "spin",
    prizes: ["Prize 1", "Prize 2", "Prize 3", "Prize 4"],
    duration: 4000,
    color: "#ffffff",
    accent: "#f59e0b",
    radius: 0,
    fontSize: 16,
    fontFamily: "Inter, system-ui, sans-serif",
};
export const spinWheelSchema: OverlayElementSchema = {
    type: "spin_wheel",
    defaultProps: DEFAULT_SPIN_WHEEL_PROPS,
    normalizeProps(props, read) {
        const d = DEFAULT_SPIN_WHEEL_PROPS;
        const raw = Array.isArray(props.prizes) ? props.prizes : [];
        return {
            event: read.str("event", d.event, 100),
            // Keep blank entries: they are rows the user just added and is
            // about to type into (the server broadcast replaces the editor
            // state, so filtering them here would make "add prize" vanish).
            // Blank rows are ignored by the wheel's render and onTrigger.
            prizes: raw.map((v) => cleanStr(v, 60)).slice(0, 24),
            duration: read.num("duration", d.duration, 500, 60000),
            color: read.hex("color", d.color),
            accent: read.hex("accent", d.accent),
            radius: read.num("radius", d.radius, 0, 1000),
            fontSize: read.num("fontSize", d.fontSize, 6, 400),
            fontFamily: read.str("fontFamily", d.fontFamily, 300),
        };
    },
};
