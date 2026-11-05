/*
 * WebRTC signaling wire protocol, shared by the control server's signaling
 * relay and the browser halves (the sender page and the receiver element).
 * The relay never inspects media; it only routes these JSON messages between
 * the two peers that share a stream id. Kept dependency-free so both the
 * server and the bundled frontend can import it.
 */

/** The two roles a peer can take in a stream's room. */
export type WebrtcRole = "sender" | "receiver";

/** The other role of the given one (the relay's forwarding target). */
export const otherRole = (role: WebrtcRole): WebrtcRole =>
	role === "sender" ? "receiver" : "sender";

/** A valid stream id: the same shape as an overlay element id. */
export const WEBRTC_STREAM_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Client → server. A peer joins its room simply by opening the WebSocket
 * (the stream id is the path, the role the query param) — the server claims
 * the slot in `ws.open`. The only frames a client sends afterwards are the
 * media-handshake ones, relayed unchanged to the peer holding the other role.
 */
export type WebrtcClientMessage =
	| { type: "offer"; sdp: RTCSessionDescriptionInit }
	| { type: "answer"; sdp: RTCSessionDescriptionInit }
	| { type: "ice"; candidate: RTCIceCandidateInit };

/**
 * Server → client. `peer-joined` / `peer-left` tell a peer that its counterpart
 * appeared or went away; `offer` / `answer` / `ice` are the relayed media
 * handshake frames.
 */
export type WebrtcServerMessage =
	| { type: "peer-joined"; role: WebrtcRole }
	| { type: "peer-left" }
	| { type: "offer"; sdp: RTCSessionDescriptionInit }
	| { type: "answer"; sdp: RTCSessionDescriptionInit }
	| { type: "ice"; candidate: RTCIceCandidateInit };

/** Parse an incoming signaling frame, narrowing it to a valid client message. */
export function parseWebrtcClientMessage(
	value: unknown,
): WebrtcClientMessage | null {
	if (typeof value !== "object" || value === null) return null;
	const msg = value as Record<string, unknown>;
	switch (msg.type) {
		case "offer":
		case "answer":
			return isSdp(msg.sdp)
				? ({ type: msg.type, sdp: msg.sdp } as WebrtcClientMessage)
				: null;
		case "ice":
			return isCandidate(msg.candidate)
				? { type: "ice", candidate: msg.candidate }
				: null;
		default:
			return null;
	}
}

function isSdp(value: unknown): value is RTCSessionDescriptionInit {
	if (typeof value !== "object" || value === null) return false;
	const sdp = value as Record<string, unknown>;
	return (
		typeof sdp.type === "string" &&
		sdp.type !== "" &&
		typeof sdp.sdp === "string"
	);
}

function isCandidate(value: unknown): value is RTCIceCandidateInit {
	if (typeof value !== "object" || value === null) return false;
	const c = value as Record<string, unknown>;
	// An `end-of-candidates` marker has no `candidate` field; allow it so a
	// peer can signal ICE complete without a real candidate.
	return c.candidate === undefined || typeof c.candidate === "string";
}
