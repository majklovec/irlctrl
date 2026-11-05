/*
 * Progress element — the schema half: props contract, defaults and
 * normalization (environment-free, shared by the server's scene validator
 * and the browser editor). The rendering and inspector halves live in
 * progress.tsx. Aggregated in ../overlay_schema.ts.
 */
import type { OverlayElementSchema } from "../../../../../core/overlay_element";

export interface ProgressProps {
    /** progress percentage, 0–100 */
    value: number;
    /** color of the filled portion */
    fill: string;
    /** color of the empty track behind the fill */
    background: string;
    /** corner radius in px (0 = square corners) */
    radius: number;
}

export const DEFAULT_PROGRESS_PROPS: Required<ProgressProps> = {
    value: 25,
    fill: "#22c55e",
    background: "#e5e7eb",
    radius: 6,
};

export const progressSchema: OverlayElementSchema = {
    type: "progress",
    defaultProps: DEFAULT_PROGRESS_PROPS,
    normalizeProps(_props, read) {
        const d = DEFAULT_PROGRESS_PROPS;
        return {
            value: read.num("value", d.value, 0, 100),
            fill: read.hex("fill", d.fill),
            background: read.hex("background", d.background),
            radius: read.num("radius", d.radius, 0, 10000),
        };
    },
};
