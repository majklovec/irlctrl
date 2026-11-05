/*
 * Chat element — the schema half: props contract, defaults and
 * normalization (environment-free, shared by the server's scene validator
 * and the browser editor). The rendering and inspector halves live in
 * chat.tsx. Aggregated in ../overlay_schema.ts.
 */
import type { OverlayElementSchema } from "../../../../../core/overlay_element";
import { normalizeChannelRows, type ChannelRow } from "./schema_utils";

/* ── chat (full live feed) ────────────────────────────────────────────── */
export interface ChatProps {
    /** The platform channels to display (a dynamic list; empty = nothing). */
    channels: ChannelRow[];
    /** Where new messages enter the feed: "top" (newest first) or "bottom". */
    order: "top" | "bottom";
    /** How moderated (removed) messages present: "strike-through" or "hide". */
    bannedMessages: "strike" | "hide";
    /** Show each message's arrival time. */
    timestamps: "off" | "on";
    /** Show the sender's badges (subscriber/moderator, …) in front of the name. */
    badges: "off" | "on";
    /** Platform icons: "auto" (only when >1 channel), forced "on", or "off". */
    platformIcons: "auto" | "on" | "off";
    /** Feed text size in px. */
    fontSize: number;
    /** Feed text font stack. */
    fontFamily: string;
    /** Feed text colour (`#rrggbb`). */
    color: string;
    /** Feed text weight. */
    fontWeight: number;
    /** Feed text line-height (unitless). */
    lineHeight: number;
    /** Spacing between feed lines in px (0 = none). */
    messageSpacing: number;
    /** Which feed edge fades out into the background. */
    fadeDirection: "off" | "top" | "bottom";
    /** Fade-out size in px. */
    fadeSize: number;
    /** Alignment of the feed text. */
    textAlign: "left" | "center" | "right" | "justify";
}
export const DEFAULT_CHAT_PROPS: Required<ChatProps> = {
    channels: [],
    order: "top",
    bannedMessages: "strike",
    timestamps: "off",
    badges: "on",
    platformIcons: "auto",
    fontSize: 48,
    fontFamily: "Inter, system-ui, sans-serif",
    color: "#ffffff",
    fontWeight: 600,
    lineHeight: 1.2,
    messageSpacing: 0,
    fadeDirection: "off",
    // ~6rem — the size of a few feed lines.
    fadeSize: 96,
    textAlign: "left",
};
export const chatSchema: OverlayElementSchema = {
    type: "chat",
    defaultProps: DEFAULT_CHAT_PROPS,
    normalizeProps(props, read) {
        const d = DEFAULT_CHAT_PROPS;
        return {
            // `channels` is an object array, so it is normalized directly from
            // the raw record (the scalar `read` helpers can't touch it).
            channels: normalizeChannelRows(props.channels),
            order: read.oneOf("order", ["top", "bottom"], d.order),
            bannedMessages: read.oneOf(
                "bannedMessages",
                ["strike", "hide"],
                d.bannedMessages,
            ),
            timestamps: read.oneOf("timestamps", ["off", "on"], d.timestamps),
            badges: read.oneOf("badges", ["off", "on"], d.badges),
            platformIcons: read.oneOf(
                "platformIcons",
                ["auto", "on", "off"],
                d.platformIcons,
            ),
            fontSize: read.num("fontSize", d.fontSize, 1, 2000),
            fontFamily: read.str("fontFamily", d.fontFamily, 300),
            color: read.hex("color", d.color),
            fontWeight: read.num("fontWeight", d.fontWeight, 100, 900),
            lineHeight: read.num("lineHeight", d.lineHeight, 0.1, 10),
            messageSpacing: read.num("messageSpacing", d.messageSpacing, 0, 100),
            fadeDirection: read.oneOf(
                "fadeDirection",
                ["off", "top", "bottom"],
                d.fadeDirection,
            ),
            fadeSize: read.num("fadeSize", d.fadeSize, 1, 500),
            textAlign: read.oneOf(
                "textAlign",
                ["left", "center", "right", "justify"],
                d.textAlign,
            ),
        };
    },
};
