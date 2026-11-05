/*
 * Ellipse element — the schema half: props contract, defaults and
 * normalization (environment-free, shared by the server's scene validator
 * and the browser editor). The rendering and inspector halves live in
 * ellipse.tsx. Aggregated in ../overlay_schema.ts.
 */
import type { OverlayElementSchema } from "../../../../../core/overlay_element";

export interface EllipseProps {
    fill: string;
    stroke: string;
    strokeWidth: number;
}

export const DEFAULT_ELLIPSE_PROPS: Required<EllipseProps> = {
    fill: "#3b82f6",
    stroke: "#000000",
    strokeWidth: 0,
};

export const ellipseSchema: OverlayElementSchema = {
    type: "ellipse",
    defaultProps: DEFAULT_ELLIPSE_PROPS,
    normalizeProps(_props, read) {
        const d = DEFAULT_ELLIPSE_PROPS;
        return {
            fill: read.hex("fill", d.fill),
            stroke: read.hex("stroke", d.stroke),
            strokeWidth: read.num("strokeWidth", d.strokeWidth, 0, 500),
        };
    },
};
