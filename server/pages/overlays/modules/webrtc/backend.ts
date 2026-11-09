/*
 * webrtc backend — the standalone WebRTC element: a live camera/screen feed
 * published from a phone. Its one public surface is the sender page
 * (`/webrtc/send?streamId=…`) plus the signaling WebSocket it dials; both are
 * public (the stream id is the access key — no session cookie). The element
 * itself (rendering + inspector) and its schema are the browser-side entry
 * points of this module; the core wires this route set into the control
 * server like any module's `controlRoutes`.
 */
import { type AnyElysia, Elysia } from "elysia";
import type { ControlRouteContext } from "../../../../../shared/contracts/backend_module";
import { webrtcRoutes } from "./webrtc_routes";

export default {
	id: "webrtc",
	kind: "widget" as const,
	title: "WebRTC",
	controlRoutes: (context: ControlRouteContext): AnyElysia =>
		new Elysia({ name: "webrtc-module" }).use(webrtcRoutes(context)),
};
