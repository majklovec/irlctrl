/*
 * Frame element — the schema half: props contract, defaults and
 * normalization (environment-free, shared by the server's scene validator
 * and the browser editor). The rendering and inspector halves live in
 * frame.tsx. Aggregated in ../overlay_schema.ts.
 */
import type { OverlayElementSchema } from "../../../../../core/overlay_element";

/* ── frame ────────────────────────────────────────────────────────────── */
export interface FrameProps {
    border: string;
    borderWidth: number;
    borderStyle: "solid" | "dashed" | "double";
    cornerRadius: number;
    /** The corner/padding fill; "" = fully transparent centre. */
    background: string;
    /** A label pinned in a corner ("" = none). */
    label: string;
    color: string;
    fontSize: number;
    fontFamily: string;
}
export const DEFAULT_FRAME_PROPS: Required<FrameProps> = {
    border: "#f59e0b",
    borderWidth: 8,
    borderStyle: "solid",
    cornerRadius: 0,
    background: "",
    label: "LIVE",
    color: "#ffffff",
    fontSize: 22,
    fontFamily: "Inter, system-ui, sans-serif",
};
export const frameSchema: OverlayElementSchema = {
    type: "frame",
    defaultProps: DEFAULT_FRAME_PROPS,
    normalizeProps(_p, read) {
        const d = DEFAULT_FRAME_PROPS;
        return {
            border: read.hex("border", d.border),
            borderWidth: read.num("borderWidth", d.borderWidth, 0, 200),
            borderStyle: read.oneOf(
                "borderStyle",
                ["solid", "dashed", "double"],
                d.borderStyle,
            ),
            cornerRadius: read.num("cornerRadius", d.cornerRadius, 0, 1000),
            // background is "" (transparent) by design, not a stored hex —
            // normalize it as a string.
            background:
                typeof _p.background === "string" && _p.background !== ""
                    ? read.hex("background", _p.background)
                    : "",
            label: read.str("label", d.label, 24),
            color: read.hex("color", d.color),
            fontSize: read.num("fontSize", d.fontSize, 6, 400),
            fontFamily: read.str("fontFamily", d.fontFamily, 300),
        };
    },
};
