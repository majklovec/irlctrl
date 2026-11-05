/*
 * Featured element — the schema half: props contract, defaults and
 * normalization (environment-free, shared by the server's scene validator
 * and the browser editor). The rendering and inspector halves live in
 * featured.tsx. Aggregated in ../overlay_schema.ts.
 */
import type { OverlayElementSchema } from "../../../../../core/overlay_element";
import type { ChannelRow } from "./schema_utils";
import { normalizeChannelRows } from "./schema_utils";

/* ── featured (chat-driven) ───────────────────────────────────────────── */
export interface FeaturedProps {
    channels: ChannelRow[];
    /** What to feature: "message" (latest chat line) or "user" (latest sender). */
    kind: "message" | "user";
    color: string;
    accent: string;
    background: string;
    radius: number;
    fontSize: number;
    fontFamily: string;
}
export const DEFAULT_FEATURED_PROPS: Required<FeaturedProps> = {
    channels: [],
    kind: "message",
    color: "#ffffff",
    accent: "#38bdf8",
    background: "#111827",
    radius: 12,
    fontSize: 26,
    fontFamily: "Inter, system-ui, sans-serif",
};
export const featuredSchema: OverlayElementSchema = {
    type: "featured",
    defaultProps: DEFAULT_FEATURED_PROPS,
    normalizeProps(props, read) {
        const d = DEFAULT_FEATURED_PROPS;
        return {
            channels: normalizeChannelRows(props.channels),
            kind: read.oneOf("kind", ["message", "user"], d.kind),
            color: read.hex("color", d.color),
            accent: read.hex("accent", d.accent),
            background: read.hex("background", d.background),
            radius: read.num("radius", d.radius, 0, 500),
            fontSize: read.num("fontSize", d.fontSize, 6, 400),
            fontFamily: read.str("fontFamily", d.fontFamily, 300),
        };
    },
};
