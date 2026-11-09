/*
 * The WebRTC element's signaling relay. A room per stream id pairs one sender
 * with one or more receivers and routes the SDP/ICE handshake between the
 * sender and the PRIME receiver (the relay never touches media). The room
 * manager is a pure, dependency-free class so the join/relay/cleanup behaviour
 * can be unit-tested without a live socket.
 *
 * Only ONE receiver — the `primary` — carries the live media. The OBS runtime
 * page joins with `priority=1` so it is always the primary (its feed is the
 * one actually streamed to viewers); any concurrent receiver (the editor's
 * live preview) is a shadow: it is relayed no media and its UI shows its last
 * frame with a note that the overlay has the feed. When the primary leaves,
 * the next receiver promotes and the sender re-offers to it.
 *
 * Join order is symmetric: the sender (which always offers) learns a receiver
 * is present via `room-state.receiver` in BOTH orders and offers it.
 */
import { type AnyElysia, Elysia } from "elysia";
import { upgradeRequired } from "../../../../../shared/http";
import {
	otherRole,
	parseWebrtcClientMessage,
	type IceServers,
	type RoomState,
	WEBRTC_STREAM_ID_RE,
	type WebrtcClientMessage,
	type WebrtcRole,
	type WebrtcServerMessage,
} from "./webrtc_protocol";

/** The contract the relay drives (both roles symmetric; tests fake it). */
interface SignalingSocket {
	readonly readyState: number;
	send(message: string): void;
	close(code?: number, reason?: string): void;
}

/**
 * A STABLE handle for one signaling connection. Elysia hands a DIFFERENT `ws`
 * object to `open` than to `close` (only `ws.data` survives the lifecycle), so
 * a manager that compares the raw socket with `===` would never recognise the
 * peer that is leaving. The handle is created once per connection and stored in
 * `ws.data`, so its identity is stable; it delegates `send`/`readyState`/
 * `close` to whichever live socket Elysia most recently passed, so delivery
 * always reaches the real connection.
 */
class ConnectionHandle implements SignalingSocket {
	#live: SignalingSocket | null = null;

	/** Point the handle at the current live socket (call on every event). */
	attach(socket: SignalingSocket): void {
		this.#live = socket;
	}

	get readyState(): number {
		return this.#live?.readyState ?? 3;
	}

	send(message: string): void {
		this.#live?.send(message);
	}

	close(code?: number, reason?: string): void {
		this.#live?.close(code, reason);
	}
}

/** A socket is only usable for delivery while it is open. */
const OPEN = 1;

interface Room {
	sender?: SignalingSocket;
	/** Every connected receiver; at most one is the `primary` (live media). */
	receivers: SignalingSocket[];
	/** Increments whenever the primary-identity changes (handover/new primary). */
	primaryGen: number;
}

const sendJson = (sock: SignalingSocket, msg: WebrtcServerMessage): void => {
	if (sock.readyState === OPEN) sock.send(JSON.stringify(msg));
};

/** The receiver that carries the live media (the slot the sender offers). */
const primary = (room: Room | undefined): SignalingSocket | undefined =>
	room?.receivers.find((s) => s.readyState === OPEN);

/** The room's shared state (no per-peer `active` — that is added per socket). */
const baseState = (room: Room | undefined): RoomState => ({
	sender: !!room?.sender,
	receiver: (room?.receivers.length ?? 0) > 0,
	active: false,
	primary: room?.primaryGen ?? 0,
});

/**
 * One room per stream id. A single sender plus any number of receivers: the
 * FIRST open receiver is the `primary` and carries the live media, the rest are
 * shadows (their UI shows a note + last frame). `join` adds a receiver (a
 * `priority` join — the OBS runtime page — takes the primary slot immediately,
 * a non-priority one only when none exists) and `relay` forwards media frames
 * ONLY to the primary. `announce` tells every occupant the role layout plus its
 * own `active` flag, so a receiver demoted to shadow degrades in place.
 */
export class WebrtcRoomManager {
	#rooms = new Map<string, Room>();

	/**
	 * Lazily supplies the deployment's ICE servers (STUN + the minted TURN
	 * credential, when `TURN_SECRET`/`TURN_HOST` are set). Called on every
	 * snapshot — the minted credential is time-limited, so reading it fresh
	 * each time keeps every snapshot's servers current. Absent → peers fall
	 * back to STUN-only (the browser default).
	 */
	constructor(private readonly turnServers?: () => IceServers | undefined) {}

	/** Diagnostic: which roles currently occupy which rooms. */
	occupancy(): Record<string, string[]> {
		const out: Record<string, string[]> = {};
		for (const [id, room] of this.#rooms) {
			const roles: string[] = [];
			if (room.sender) roles.push("sender");
			for (let i = 0; i < room.receivers.length; i++)
				roles.push(i === 0 ? "receiver" : "receiver*");
			out[id] = roles;
		}
		return out;
	}

	/** A snapshot of the room addressed to `sock`: the role flags are the
	 * same for everyone; `active` is true only when `sock` is the primary. */
	stateFor(streamId: string, sock: SignalingSocket): RoomState {
		const room = this.#rooms.get(streamId);
		return {
			...baseState(room),
			active: primary(room) === sock,
			iceServers: this.turnServers?.(),
		};
	}

	/**
	 * Handle one parsed client frame and return the response frame to send back
	 * to the caller (if any). A `sync` frame is answered with a `room-state`
	 * snapshot addressed to the caller — this is the reliable re-sync path,
	 * since the on-join snapshot can race the client's `onopen` listener setup.
	 * Media-handshake frames are relayed to the primary receiver and have no
	 * direct reply.
	 */
	message(
		streamId: string,
		role: WebrtcRole,
		sock: SignalingSocket,
		frame: WebrtcClientMessage,
	): WebrtcServerMessage | null {
		if (frame.type === "sync") {
			return { type: "room-state", state: this.stateFor(streamId, sock) };
		}
		if (frame.type === "offer" && role === "receiver") {
			// The sender is the ONLY offerer. A receiver offer would dead-end
			// the negotiation (the sender only answers), so drop it.
			return null;
		}
		this.relay(streamId, role, frame);
		return null;
	}

	/** Broadcast the room state to every occupant, each addressed to itself. */
	announce(streamId: string): void {
		const room = this.#rooms.get(streamId);
		if (!room) return;
		if (room.sender)
			sendJson(room.sender, {
				type: "room-state",
				state: this.stateFor(streamId, room.sender),
			});
		for (const s of room.receivers)
			sendJson(s, {
				type: "room-state",
				state: this.stateFor(streamId, s),
			});
	}

	/**
	 * Add `sock` to `streamId` in `role`. A sender claims the single sender
	 * slot; a different sender already holding it is displaced and told
	 * `hijacked` (it stops and must not reconnect). A receiver is promoted to
	 * the primary slot when `priority` (or the slot is empty); a displaced
	 * primary is demoted to shadow (not told `peer-left`), so it keeps its last
	 * frame and shows the "overlay has the feed" note. An existing socket
	 * reconnecting is left in place. `announce` refreshes everyone.
	 */
	join(
		streamId: string,
		role: WebrtcRole,
		sock: SignalingSocket,
		priority = false,
	): void {
		let room = this.#rooms.get(streamId);
		if (!room) {
			room = { receivers: [], primaryGen: 0 };
			this.#rooms.set(streamId, room);
		}
		if (role === "sender") {
			const existing = room.sender;
			if (existing && existing !== sock)
				// A SECOND sender opened the same link: the first one is
				// displaced and learns it specifically (it stops and does not
				// reconnect — reconnecting would just re-trigger the hijack).
				sendJson(existing, { type: "hijacked" });
			room.sender = sock;
			// The stream's ICE servers (STUN + the minted TURN, when set) travel
			// on the room-state snapshot the new sender is about to receive —
			// the server is the source of truth, so no separate frame is sent.
		} else {
			if (room.receivers.includes(sock)) {
				// Reconnect/duplicate: just re-announce the layout.
				this.announce(streamId);
				return;
			}
			const cur = primary(room);
			const goPrimary = priority || !cur;
			if (goPrimary) {
				room.receivers.unshift(sock);
				// A new receiver will carry the media — the sender renegotiates
				// with it after seeing `primary` change in the room-state.
				room.primaryGen += 1;
			} else {
				room.receivers.push(sock);
			}
		}
		this.announce(streamId);
	}

	/**
	 * Forward a media-handshake frame. From the sender it goes ONLY to the
	 * primary receiver (shadows never see the media — that is how they stay
	 * lightweight); from the primary receiver it goes to the sender.
	 */
	relay(streamId: string, from: WebrtcRole, frame: WebrtcServerMessage): void {
		const room = this.#rooms.get(streamId);
		if (!room) return;
		const target =
			from === "sender"
				? primary(room)
				: from === "receiver" && primary(room)
					? room.sender
					: undefined;
		if (target) sendJson(target, frame);
	}

	/**
	 * Remove `sock` from `role` in `streamId`. If the primary receiver left,
	 * the remaining receivers promote (the new primary re-arms and the sender
	 * re-offers via `room-state.receiver`); if the sender left, every receiver
	 * is told `peer-left` so non-active ones clear to "waiting for a sender".
	 */
	leave(streamId: string, role: WebrtcRole, sock: SignalingSocket): void {
		const room = this.#rooms.get(streamId);
		if (!room) return;
		if (role === "sender") {
			if (room.sender === sock) room.sender = undefined;
			if (room.sender) return; // a (re)connected sender is present
			for (const s of room.receivers)
				if (s.readyState === OPEN)
					sendJson(s, { type: "peer-left" });
		} else {
			const i = room.receivers.indexOf(sock);
			if (i >= 0) {
				const wasPrimary = primary(room) === sock;
				room.receivers.splice(i, 1);
				if (wasPrimary) room.primaryGen += 1; // primary identity changed
			}
		}
		if (!room.sender && room.receivers.length === 0)
			this.#rooms.delete(streamId);
		else this.announce(streamId);
	}
}

/** Per-connection state carried on `ws.data` across the handlers. */
interface WebrtcWsData {
	streamId?: string;
	role?: WebrtcRole;
	/**
	 * The STABLE handle for this connection. Elysia gives a fresh `ws` object to
	 * each lifecycle event, so `ws.data` (stable) carries the handle and every
	 * handler attaches the current socket to it before the room manager sees it.
	 */
	sock?: ConnectionHandle;
}

/**
 * The signaling routes: a GET upgrade guard + the WebSocket. Mounted by the
 * `overlay_elements` module's `controlRoutes`, so it lives with the element
 * whose media it carries. The stream id is a path segment (validated), the
 * role a query param.
 */
export function webrtcSignalingRoutes(manager: WebrtcRoomManager): AnyElysia {
	const path = "/api/webrtc/stream/:id/ws";
	return new Elysia({ name: "webrtc-signaling" })
		.get(path, () => upgradeRequired())
		.ws(path, {
			open(ws) {
				const url = new URL(ws.data.request.url);
				// the stream id is the second-to-last segment (/api/webrtc/stream/<id>/ws)
				const segments = url.pathname.split("/").filter(Boolean);
				const id = decodeURIComponent(segments.at(-2) ?? "");
				const role = url.searchParams.get("role");
				if (!WEBRTC_STREAM_ID_RE.test(id))
					return ws.close(1008, "Invalid stream id");
				if (role !== "sender" && role !== "receiver")
					return ws.close(1008, "Invalid role");
				// One stable handle per connection (Elysia's raw `ws` differs per
				// event); it is stored on ws.data so close() can find it.
				const sock = new ConnectionHandle();
				sock.attach(ws);
				const data = ws.data as WebrtcWsData;
				data.streamId = id;
				data.role = role;
				data.sock = sock;
				// A runtime (OBS) overlay page passes `priority=1` so it wins
				// the live-media receiver slot and any concurrent editor preview
				// degrades to a shadow. The editor omits it.
				manager.join(
					id,
					role,
					sock,
					url.searchParams.get("priority") === "1",
				);
			},
			message(ws, message) {
				const data = ws.data as WebrtcWsData;
				if (!data.streamId || !data.role || !data.sock) return;
				data.sock.attach(ws);
				// Elysia pre-parses JSON text frames (a non-JSON frame stays a
				// string). Restore an object, tolerating a malformed frame.
				let frame: unknown;
				try {
					frame = typeof message === "string" ? JSON.parse(message) : message;
				} catch {
					return;
				}
				const parsed = parseWebrtcClientMessage(frame);
				if (!parsed) return;
				// `sync` asks for the room layout; the manager answers with a
				// snapshot addressed to this peer (the reliable re-sync path —
				// a snapshot sent during the connection upgrade can race the
				// client's listener setup). Media-handshake frames are relayed
				// to the primary receiver only, with no direct reply.
				const reply = manager.message(
					data.streamId,
					data.role,
					data.sock,
					parsed,
				);
				if (reply) sendJson(ws, reply);
			},
			close(ws) {
				const data = ws.data as WebrtcWsData;
				if (data.streamId && data.role && data.sock)
					manager.leave(data.streamId, data.role, data.sock);
			},
		});
}
