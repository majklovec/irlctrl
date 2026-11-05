/*
 * Iframe element — the schema half: props contract, defaults and
 * normalization (environment-free, shared by the server's scene validator
 * and the browser editor). The rendering and inspector halves live in
 * iframe.tsx. Aggregated in ../overlay_schema.ts.
 */
import type { OverlayElementSchema } from "../../../../../core/overlay_element";

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
