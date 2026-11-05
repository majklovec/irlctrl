/*
 * Emote wall element — the schema half: props contract, defaults and
 * normalization (environment-free, shared by the server's scene validator
 * and the browser editor). The rendering and inspector halves live in
 * emote_wall.tsx. Aggregated in ../overlay_schema.ts.
 */
import type { OverlayElementSchema } from "../../../../../core/overlay_element";
import type { ChannelRow } from "./schema_utils";
import { normalizeChannelRows } from "./schema_utils";

/* ── emote wall (chat-driven) ─────────────────────────────────────────── */
export interface EmoteWallProps {
    channels: ChannelRow[];
    /** How the emotes move. */
    motion: "calm" | "normal" | "chaos" | "bounce";
    /** Max concurrent floating emotes. */
    maxEmotes: number;
    /** Float lifetime in ms. */
    lifetime: number;
    fontSize: number;
    fontFamily: string;
}
export const DEFAULT_EMOTE_WALL_PROPS: Required<EmoteWallProps> = {
    channels: [],
    motion: "normal",
    maxEmotes: 24,
    lifetime: 8000,
    fontSize: 40,
    fontFamily: "Inter, system-ui, sans-serif",
};
export const emoteWallSchema: OverlayElementSchema = {
    type: "emote_wall",
    defaultProps: DEFAULT_EMOTE_WALL_PROPS,
    normalizeProps(props, read) {
        const d = DEFAULT_EMOTE_WALL_PROPS;
        return {
            channels: normalizeChannelRows(props.channels),
            motion: read.oneOf(
                "motion",
                ["calm", "normal", "chaos", "bounce"],
                d.motion,
            ),
            maxEmotes: read.num("maxEmotes", d.maxEmotes, 1, 200),
            lifetime: read.num("lifetime", d.lifetime, 1000, 120000),
            fontSize: read.num("fontSize", d.fontSize, 6, 400),
            fontFamily: read.str("fontFamily", d.fontFamily, 300),
        };
    },
};
