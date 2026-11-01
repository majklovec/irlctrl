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
}

export const DEFAULT_CHAT_PROPS: Required<ChatProps> = { url: "" };

export const chatSchema: OverlayElementSchema = {
    type: "chat",
    defaultProps: DEFAULT_CHAT_PROPS,
    // The picker always writes the chat overlay URL (`?token=…`), which
    // already contains percent-safe characters as-is.
    normalizeProps(_props, read) {
        return { url: read.str("url", "") };
    },
};

export default [chatSchema];
