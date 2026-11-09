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
 * the slot in `ws.open`. `sync` requests a fresh room snapshot (the server
 * answers with `room-state`); a peer sends it on open and again after a
 * dropped connection to re-learn the room without a full reconnect. The
 * media-handshake frames are relayed unchanged to the peer holding the
 * other role.
 */
export type WebrtcClientMessage =
	| { type: "offer"; sdp: RTCSessionDescriptionInit }
	| { type: "answer"; sdp: RTCSessionDescriptionInit }
	| { type: "ice"; candidate: RTCIceCandidateInit }
	| { type: "sync" };

/**
 * A snapshot of a room's occupancy: which roles are present. `sender` /
 * `receiver` are booleans (a stream may have several receivers), so they carry
 * no per-peer meaning. `active` is the per-recipient half of a snapshot: it is
 * set ONLY in frames addressed to a receiver and says whether THAT receiver is
 * the one carrying the live media (the `primary`). The single sender reads
 * `receiver` (some receiver is present → offer). A receiver reads `active`:
 * true → it carries the live feed; false → it is a secondary and shows its
 * last frame with a "the overlay has the live feed" note.
 */
export interface RoomState {
	sender: boolean;
	receiver: boolean;
	/** True when addressed to the receiver that currently carries the media. */
	active: boolean;
	/**
	 * Changes whenever the primary receiver is replaced (a new primary takes
	 * the live-media slot, the primary is demoted, or the primary closes).
	 * Only the sender reads it: a change means it must re-offer to the new
	 * primary. Receivers ignore it (they use `active`).
	 */
	primary: number;
}

/**
 * Server → client. `room-state` is the authoritative occupancy snapshot
 * (sent on every join and on every `sync`); `peer-joined` / `peer-left`
 * tell a peer that its counterpart appeared or went away; `hijacked` tells a
 * sender that a SECOND sender opened the same link and took its slot (the
 * displaced sender stops and must not reconnect); `offer` / `answer` / `ice`
 * are the relayed media handshake frames.
 */
export type WebrtcServerMessage =
	| { type: "room-state"; state: RoomState }
	| { type: "peer-joined"; role: WebrtcRole }
	| { type: "peer-left" }
	| { type: "hijacked" }
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
		case "sync":
			return { type: "sync" };
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
