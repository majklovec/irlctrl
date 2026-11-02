/*
 * Schema of the chat overlay element: embeds a chat module's live overlay
 * page in an OBS overlay scene. The browser half is in overlay_elements.tsx.
 */
import type { OverlayElementSchema } from "../../../shared/contracts/overlay_element";

export interface ChatProps {
    /**
     * The chat module's live overlay URL
     * (`/chat/<dashboardId>/<widgetId>?token=…`), set by the inspector's
     * module picker; no free-form URL (a generic page goes in an iframe
     * element). `""` renders a placeholder box.
     */
    url: string;
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
    url: "",
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
    // The picker always writes the chat overlay URL (`?token=…`), which
    // already contains percent-safe characters as-is.
    normalizeProps(_props, read) {
        const d = DEFAULT_CHAT_PROPS;
        return {
            url: read.str("url", ""),
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
