/*
 * Schemas of the built-in overlay elements (environment-free: shared by the
 * control server's scene validator and the browser editor). The rendering
 * and inspector halves live next to each one in elements/*.tsx.
 */
import type { OverlayElementSchema } from "../../../shared/contracts/overlay_element";

export interface TextProps {
    text: string;
    fontSize: number;
    fontFamily: string;
    color: string;
    weight: number;
    lineHeight: number;
    align: "left" | "center" | "right";
}

export const DEFAULT_TEXT_PROPS: Required<TextProps> = {
    text: "Text",
    fontSize: 48,
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    color: "#ffffff",
    weight: 400,
    lineHeight: 1.2,
    align: "left",
};

export const textSchema: OverlayElementSchema = {
    type: "text",
    defaultProps: DEFAULT_TEXT_PROPS,
    normalizeProps(props, read) {
        const d = DEFAULT_TEXT_PROPS;
        return {
            text: read.str("text", d.text, 10000),
            fontSize: read.num("fontSize", d.fontSize, 1, 2000),
            fontFamily: read.str("fontFamily", d.fontFamily, 300),
            color: read.hex("color", d.color),
            weight: read.num("weight", d.weight, 100, 900),
            lineHeight: read.num("lineHeight", d.lineHeight, 0.1, 10),
            align: read.oneOf("align", ["left", "center", "right"], d.align),
        };
    },
};

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

export interface ImageProps {
    /** id of a project asset; `""` (or a missing asset) renders an empty box */
    assetId: string;
}

export const DEFAULT_IMAGE_PROPS: Required<ImageProps> = { assetId: "" };

export const imageSchema: OverlayElementSchema = {
    type: "image",
    defaultProps: DEFAULT_IMAGE_PROPS,
    assetProps: ["assetId"],
    normalizeProps(_props, read) {
        return { assetId: read.str("assetId", "") };
    },
};

export interface IframeProps {
    /** The page to embed. Any absolute URL; `""` renders a placeholder box. */
    url: string;
}

export const DEFAULT_IFRAME_PROPS: Required<IframeProps> = { url: "" };

export const iframeSchema: OverlayElementSchema = {
    type: "iframe",
    defaultProps: DEFAULT_IFRAME_PROPS,
    // A bare string (no scheme or path checks — the browser decides what a
    // URL is worth loading); a missing value falls back to "".
    normalizeProps(_props, read) {
        return { url: read.str("url", "") };
    },
};

/** A group has no props of its own; it exists to parent other elements. */
export const groupSchema: OverlayElementSchema = {
    type: "group",
    defaultProps: {},
    container: true,
    normalizeProps: () => ({}),
};

export default [
    textSchema,
    imageSchema,
    rectangleSchema,
    ellipseSchema,
    lineSchema,
    progressSchema,
    iframeSchema,
    groupSchema,
];
