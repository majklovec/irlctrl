/*
 * Goal element — the schema half: props contract, defaults and
 * normalization (environment-free, shared by the server's scene validator
 * and the browser editor). The rendering and inspector halves live in
 * goal.tsx. Aggregated in ../overlay_schema.ts.
 */
import type { OverlayElementSchema } from "../../../../../core/overlay_element";

/* ── goal ─────────────────────────────────────────────────────────────── */
export interface GoalProps {
    label: string;
    /** The target value to reach. */
    target: number;
    /** Current progress; bind this to a variable to make it live. */
    value: number;
    color: string;
    fill: string;
    background: string;
    radius: number;
    fontSize: number;
    fontFamily: string;
    showValue: boolean;
}
export const DEFAULT_GOAL_PROPS: Required<GoalProps> = {
    label: "Sub goal",
    target: 100,
    value: 0,
    color: "#ffffff",
    fill: "#22c55e",
    background: "#e5e7eb",
    radius: 8,
    fontSize: 20,
    fontFamily: "Inter, system-ui, sans-serif",
    showValue: true,
};
export const goalSchema: OverlayElementSchema = {
    type: "goal",
    defaultProps: DEFAULT_GOAL_PROPS,
    normalizeProps(_p, read) {
        const d = DEFAULT_GOAL_PROPS;
        return {
            label: read.str("label", d.label, 120),
            target: read.num("target", d.target, 1, 1e12),
            value: read.num("value", d.value, 0, 1e12),
            color: read.hex("color", d.color),
            fill: read.hex("fill", d.fill),
            background: read.hex("background", d.background),
            radius: read.num("radius", d.radius, 0, 500),
            fontSize: read.num("fontSize", d.fontSize, 6, 400),
            fontFamily: read.str("fontFamily", d.fontFamily, 300),
            showValue: read.bool("showValue"),
        };
    },
};
