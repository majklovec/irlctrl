/*
 * Line element — the schema half: props contract, defaults and
 * normalization (environment-free, shared by the server's scene validator
 * and the browser editor). The rendering and inspector halves live in
 * line.tsx. Aggregated in ../overlay_schema.ts.
 */
import type { OverlayElementSchema } from "../../../../../core/overlay_element";

export interface LineProps {
    /** the line's color */
    stroke: string;
    /** the line's thickness in px */
    strokeWidth: number;
    /**
     * Which box diagonal the line runs along. The box is stored in
     * min/abs form (negative deltas are impossible in CSS), so this flag
     * disambiguates: false = top-left → bottom-right, true = top-right →
     * bottom-left.
     */
    flip: boolean;
}

export const DEFAULT_LINE_PROPS: Required<LineProps> = {
    stroke: "#3b82f6",
    strokeWidth: 4,
    flip: false,
};

export const lineSchema: OverlayElementSchema = {
    type: "line",
    defaultProps: DEFAULT_LINE_PROPS,
    normalizeProps(_props, read) {
        const d = DEFAULT_LINE_PROPS;
        return {
            stroke: read.hex("stroke", d.stroke),
            strokeWidth: read.num("strokeWidth", d.strokeWidth, 1, 500),
            flip: read.bool("flip"),
        };
    },
};
