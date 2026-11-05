/*
 * overlay_elements backend — the built-in overlay elements are frontend-only,
 * but their one networked element (the `chat` full feed) needs its
 * scene-token endpoint + WebSocket (overlay_server.ts). The chat channel hub
 * they stream from lives in the dashboards chat module; the core wires this
 * route set into the control server like any module's `controlRoutes`.
 */
import { chatOverlayRoutes } from "./overlay_server";

export default {
    id: "overlay_elements",
    kind: "widget" as const,
    title: "Overlay elements",
    controlRoutes: chatOverlayRoutes,
};
