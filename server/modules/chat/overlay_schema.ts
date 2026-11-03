/*
 * Schema of the chat overlay element: a self-contained live chat in an OBS
 * overlay scene, fed by its own channel list + display options (no dashboard
 * chat widget, no embedded page URL). The browser half is in
 * overlay_elements.tsx.
 */
import type { OverlayElementSchema } from "../../../shared/contracts/overlay_element";
import { normalizeChannels, type ChatChannel } from "./config";

export interface ChatProps {
    /** The platform channels to display (a dynamic list; empty = nothing). */
    channels: ChatChannel[];
    /** How many merged messages are shown. */
    history: number;
    /** Where new messages enter the feed: "top" (newest first) or "bottom". */
    order: "top" | "bottom";
    /** How moderated (removed) messages present: "strike-through" or "hide". */
    bannedMessages: "strike" | "hide";
    /** Show each message's arrival time. */
    timestamps: "off" | "on";
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
    history: 500,
    order: "top",
    bannedMessages: "strike",
    timestamps: "off",
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
            channels: normalizeChannels(props.channels),
            history: read.num("history", d.history, 1, 10_000),
            order: read.oneOf("order", ["top", "bottom"] as const, d.order),
            bannedMessages: read.oneOf(
                "bannedMessages",
                ["strike", "hide"] as const,
                d.bannedMessages,
            ),
            timestamps: read.oneOf(
                "timestamps",
                ["off", "on"] as const,
                d.timestamps,
            ),
            platformIcons: read.oneOf(
                "platformIcons",
                ["auto", "on", "off"] as const,
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
                ["off", "top", "bottom"] as const,
                d.fadeDirection,
            ),
            fadeSize: read.num("fadeSize", d.fadeSize, 1, 500),
            textAlign: read.oneOf(
                "textAlign",
                ["left", "center", "right", "justify"] as const,
                d.textAlign,
            ),
        };
    },
};

export default [chatSchema];
