/*
 * Rectangle element — the schema half: props contract, defaults and
 * normalization (environment-free, shared by the server's scene validator
 * and the browser editor). The rendering and inspector halves live in
 * rectangle.tsx. Aggregated in ../overlay_schema.ts.
 */
import type { OverlayElementSchema } from "../../../../../core/overlay_element";

/** Rectangle / ellipse / line are distinct element types; each carries its
 * own (slimmer) prop set instead of one `shape` discriminator. */
export interface RectangleProps {
    fill: string;
    stroke: string;
    strokeWidth: number;
    /** corner radius in px (0 = square corners) */
    radius: number;
}

export const DEFAULT_RECTANGLE_PROPS: Required<RectangleProps> = {
    fill: "#3b82f6",
    stroke: "#000000",
    strokeWidth: 0,
    radius: 0,
};

export const rectangleSchema: OverlayElementSchema = {
    type: "rectangle",
    defaultProps: DEFAULT_RECTANGLE_PROPS,
    normalizeProps(_props, read) {
        const d = DEFAULT_RECTANGLE_PROPS;
        return {
            fill: read.hex("fill", d.fill),
            stroke: read.hex("stroke", d.stroke),
            strokeWidth: read.num("strokeWidth", d.strokeWidth, 0, 500),
            radius: read.num("radius", d.radius, 0, 10000),
        };
    },
};
