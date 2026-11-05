/*
 * WebRTC element routes: the public sender page (`/webrtc/send?streamId=…`)
 * plus the signaling WebSocket it dials. Both are public (the stream id is the
 * access key — no session cookie), matching how the OBS overlay runtime page
 * is served. The `overlay_elements` module's `controlRoutes` composes these
 * with the chat overlay routes.
 */
import { type AnyElysia, Elysia } from "elysia";
import type { ControlRouteContext } from "../../../../../shared/contracts/backend_module";
import { text } from "../../../../../shared/http";
import { WEBRTC_STREAM_ID_RE } from "./webrtc_protocol";
import { WebrtcRoomManager, webrtcSignalingRoutes } from "./webrtc_signaling";

/** One room manager for the whole server: rooms persist across connections. */
const rooms = new WebrtcRoomManager();

/** The module's web-UI entry point for the sender page (bundled by gen_pages). */
const SENDER_PAGE = "webrtc_send";

export function webrtcRoutes(context: ControlRouteContext): AnyElysia {
	return new Elysia({ name: "webrtc" })
		.get("/webrtc/send", ({ request, set }) => {
			const streamId = new URL(request.url).searchParams.get("streamId") ?? "";
			if (!WEBRTC_STREAM_ID_RE.test(streamId)) {
				set.status = 400;
				return text("Missing or invalid streamId", 400);
			}
			return context.htmlResponse(SENDER_PAGE);
		})
		.use(webrtcSignalingRoutes(rooms));
}
