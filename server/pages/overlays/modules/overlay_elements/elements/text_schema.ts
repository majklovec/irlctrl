/*
 * Text element — the schema half: props contract, defaults and
 * normalization (environment-free, shared by the server's scene validator
 * and the browser editor). The rendering and inspector halves live in
 * text.tsx. Aggregated in ../overlay_schema.ts.
 */
import type { OverlayElementSchema } from "../../../../../core/overlay_element";

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
