/*
 * Socials element — the schema half: props contract, defaults and
 * normalization (environment-free, shared by the server's scene validator
 * and the browser editor). The rendering and inspector halves live in
 * socials.tsx. Aggregated in ../overlay_schema.ts.
 */
import type { OverlayElementSchema } from "../../../../../core/overlay_element";
import { textRows } from "./schema_utils";

/* ── socials ──────────────────────────────────────────────────────────── */
export interface SocialsProps {
    entries: Array<{ label: string; handle: string }>;
    /** Cycle one entry at a time (slide). */
    slide: boolean;
    /** Per-entry time in ms (slide mode). */
    interval: number;
    color: string;
    background: string;
    accent: string;
    radius: number;
    fontSize: number;
    fontFamily: string;
}
export const DEFAULT_SOCIALS_PROPS: Required<SocialsProps> = {
    entries: [{ label: "Twitch", handle: "twitch.tv/you" }],
    slide: false,
    interval: 4000,
    color: "#ffffff",
    background: "#111827",
    accent: "#38bdf8",
    radius: 10,
    fontSize: 22,
    fontFamily: "Inter, system-ui, sans-serif",
};
export const socialsSchema: OverlayElementSchema = {
    type: "socials",
    defaultProps: DEFAULT_SOCIALS_PROPS,
    normalizeProps(props, read) {
        const d = DEFAULT_SOCIALS_PROPS;
        return {
            entries: textRows(props.entries, 12, { key: "handle", kind: "str" }).map(
                (r) => ({ label: String(r.label), handle: String(r.handle) }),
            ),
            slide: read.bool("slide"),
            interval: read.num("interval", d.interval, 1000, 600000),
            color: read.hex("color", d.color),
            background: read.hex("background", d.background),
            accent: read.hex("accent", d.accent),
            radius: read.num("radius", d.radius, 0, 500),
            fontSize: read.num("fontSize", d.fontSize, 6, 400),
            fontFamily: read.str("fontFamily", d.fontFamily, 300),
        };
    },
};
