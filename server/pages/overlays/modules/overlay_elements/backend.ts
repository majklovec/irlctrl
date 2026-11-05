/*
 * overlay_elements backend — the built-in overlay elements are frontend-only,
 * but their one networked element (the `chat` full feed) needs its
 * scene-token endpoint + WebSocket (overlay_server.ts). The chat channel hub
 * they stream from lives in the dashboards chat module; the core wires this
 * route set into the control server like any module's `controlRoutes`.
 */
import { type AnyElysia, Elysia } from "elysia";
import type { ControlRouteContext } from "../../../../../shared/contracts/backend_module";
import { chatOverlayRoutes } from "./overlay_server";
import { webrtcRoutes } from "./webrtc_routes";

export default {
	id: "overlay_elements",
	kind: "widget" as const,
	title: "Overlay elements",
	controlRoutes: (context: ControlRouteContext): AnyElysia =>
		new Elysia({ name: "overlay-elements" })
			.use(chatOverlayRoutes(context))
			.use(webrtcRoutes(context)),
};
