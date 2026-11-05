/*
 * Emote combo element — the schema half: props contract, defaults and
 * normalization (environment-free, shared by the server's scene validator
 * and the browser editor). The rendering and inspector halves live in
 * emote_combo.tsx. Aggregated in ../overlay_schema.ts.
 */
import type { OverlayElementSchema } from "../../../../../core/overlay_element";
import type { ChannelRow } from "./schema_utils";
import { normalizeChannelRows } from "./schema_utils";

/* ── emote combo (chat-driven) ────────────────────────────────────────── */
export interface EmoteComboProps {
    channels: ChannelRow[];
    /** Window (seconds) in which repeats count as a combo. */
    windowSec: number;
    /** Minimum repeats before the combo shows. */
    threshold: number;
    color: string;
    accent: string;
    background: string;
    radius: number;
    fontSize: number;
    fontFamily: string;
}
export const DEFAULT_EMOTE_COMBO_PROPS: Required<EmoteComboProps> = {
    channels: [],
    windowSec: 5,
    threshold: 3,
    color: "#ffffff",
    accent: "#ffd700",
    background: "#111827",
    radius: 10,
    fontSize: 28,
    fontFamily: "Inter, system-ui, sans-serif",
};
export const emoteComboSchema: OverlayElementSchema = {
    type: "emote_combo",
    defaultProps: DEFAULT_EMOTE_COMBO_PROPS,
    normalizeProps(props, read) {
        const d = DEFAULT_EMOTE_COMBO_PROPS;
        return {
            channels: normalizeChannelRows(props.channels),
            windowSec: read.num("windowSec", d.windowSec, 1, 120),
            threshold: read.num("threshold", d.threshold, 2, 1000),
            color: read.hex("color", d.color),
            accent: read.hex("accent", d.accent),
            background: read.hex("background", d.background),
            radius: read.num("radius", d.radius, 0, 500),
            fontSize: read.num("fontSize", d.fontSize, 6, 400),
            fontFamily: read.str("fontFamily", d.fontFamily, 300),
        };
    },
};
