/*
 * Credits element — the schema half: props contract, defaults and
 * normalization (environment-free, shared by the server's scene validator
 * and the browser editor). The rendering and inspector halves live in
 * credits.tsx. Aggregated in ../overlay_schema.ts.
 */
import type { OverlayElementSchema } from "../../../../../core/overlay_element";
import { textRows } from "./schema_utils";

/* ── credits ──────────────────────────────────────────────────────────── */
export interface CreditsProps {
    title: string;
    entries: Array<{ name: string; role: string }>;
    /** Scroll rate: lines per second (higher = faster). */
    speed: number;
    /** Restart the scroll after it completes. */
    loop: boolean;
    color: string;
    accent: string;
    background: string;
    fontSize: number;
    fontFamily: string;
}
export const DEFAULT_CREDITS_PROPS: Required<CreditsProps> = {
    title: "With special thanks to",
    entries: [{ name: "Supporter", role: "Subscriber" }],
    speed: 1,
    loop: true,
    color: "#ffffff",
    accent: "#ffd700",
    background: "#000000",
    fontSize: 24,
    fontFamily: "Inter, system-ui, sans-serif",
};
export const creditsSchema: OverlayElementSchema = {
    type: "credits",
    defaultProps: DEFAULT_CREDITS_PROPS,
    normalizeProps(props, read) {
        const d = DEFAULT_CREDITS_PROPS;
        return {
            title: read.str("title", d.title, 200),
            entries: textRows(props.entries, 64, {
                key: "role",
                kind: "str",
            }).map((r) => ({ name: String(r.label), role: String(r.role) })),
            speed: read.num("speed", d.speed, 0.1, 20),
            loop: read.bool("loop"),
            color: read.hex("color", d.color),
            accent: read.hex("accent", d.accent),
            background: read.hex("background", d.background),
            fontSize: read.num("fontSize", d.fontSize, 6, 400),
            fontFamily: read.str("fontFamily", d.fontFamily, 300),
        };
    },
};
