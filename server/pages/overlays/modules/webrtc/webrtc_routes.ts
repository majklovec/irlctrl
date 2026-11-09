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
import {
	WEBRTC_STREAM_ID_RE,
	mintTurnCredential,
	type IceServers,
} from "./webrtc_protocol";
import { WebrtcRoomManager, webrtcSignalingRoutes } from "./webrtc_signaling";

/** The STUN server every peer uses (the TURN server is added when configured). */
const STUN_SERVER: RTCIceServer = { urls: "stun:stun.l.google.com:19302" };

/**
 * MINTED TURN credentials. The deployment runs coturn with `use-auth-secret`
 * (a shared secret, no static users — see `irlctrl.nomad`), so there is no fixed
 * username/password to type into the element. When `TURN_HOST` (or `DOMAIN`) and
 * `TURN_SECRET` are set in the environment, the server mints a time-limited
 * username/credential pair (username = expiry timestamp, credential =
 * HMAC-SHA1 of it under the secret) and rotates it on an interval well inside
 * its TTL. Both peers receive these on `room-state` and so agree on the same
 * servers — a phone behind a restrictive NAT can still reach the receiver.
 * Absent → the app falls back to STUN-only (the browser default).
 */
const TURN_TTL_SECONDS = 7200; // credentials stay valid for two hours
const TURN_REFRESH_MS = 30 * 60 * 1000; // rotate every 30 minutes (well inside TTL)

let turnServers: IceServers | undefined;

async function refreshTurnServers(): Promise<void> {
	const domain = process.env.DOMAIN;
	const host =
		process.env.TURN_HOST ?? (domain ? `turn.${domain}` : undefined);
	const secret = process.env.TURN_SECRET;
	if (!host || !secret) {
		turnServers = undefined;
		return;
	}
	try {
		const turn = await mintTurnCredential(host, secret, TURN_TTL_SECONDS);
		turnServers = [STUN_SERVER, turn];
	} catch (err) {
		// Keep the previous (still-valid) set on a minting failure.
		console.error("[webrtc] failed to mint TURN credential", err);
	}
}

void refreshTurnServers();
// `unref` so the rotation timer alone never keeps the process alive.
{
	const t = setInterval(() => void refreshTurnServers(), TURN_REFRESH_MS);
	t.unref?.();
}

/** One room manager for the whole server: rooms persist across connections. */
const rooms = new WebrtcRoomManager(() => turnServers);

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
