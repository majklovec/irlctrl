/*
 * The WebRTC element's signaling relay. A room per stream id pairs one sender
 * and one receiver and routes the SDP/ICE handshake between them (the relay
 * never touches media). The room manager is a pure, dependency-free class so
 * the pair/relay/cleanup behaviour can be unit-tested without a live socket.
 *
 * Join order is symmetric: whichever peer joins second is told the first is
 * already present, and the first is told about the newcomer, so the sender
 * (which always offers) starts the negotiation in BOTH orders.
 */
import { type AnyElysia, Elysia } from "elysia";
import { upgradeRequired } from "../../../../../shared/http";
import {
	otherRole,
	parseWebrtcClientMessage,
	WEBRTC_STREAM_ID_RE,
	type WebrtcRole,
	type WebrtcServerMessage,
} from "./webrtc_protocol";

/** The subset of a live WebSocket the relay drives (both roles symmetric). */
interface SignalingSocket {
	readonly readyState: number;
	send(message: string): void;
	close(code?: number, reason?: string): void;
}

/** A socket is only usable for delivery while it is open. */
const OPEN = 1;

interface Room {
	sender?: SignalingSocket;
	receiver?: SignalingSocket;
}

const sendJson = (sock: SignalingSocket, msg: WebrtcServerMessage): void => {
	if (sock.readyState === OPEN) sock.send(JSON.stringify(msg));
};

/**
 * One room per stream id. `join` claims a role slot (replacing a stale holder
 * of the same role), tells both peers about the current occupancy, and `relay`
 * forwards a media-handshake frame to the peer holding the other role.
 */
export class WebrtcRoomManager {
	#rooms = new Map<string, Room>();

	/** Diagnostic: which roles currently occupy which rooms. */
	occupancy(): Record<string, string[]> {
		const out: Record<string, string[]> = {};
		for (const [id, room] of this.#rooms) {
			const roles: string[] = [];
			if (room.sender) roles.push("sender");
			if (room.receiver) roles.push("receiver");
			out[id] = roles;
		}
		return out;
	}

	/** Claim `role` in `streamId`; notify whichever peer is affected. */
	join(streamId: string, role: WebrtcRole, sock: SignalingSocket): void {
		let room = this.#rooms.get(streamId);
		if (!room) {
			room = {};
			this.#rooms.set(streamId, room);
		}
		// A fresh socket takes the role slot; a previous live holder is told it
		// was replaced so it tears down (e.g. the receiver's editor tab reloaded).
		const existing = room[role];
		if (existing && existing !== sock)
			sendJson(existing, { type: "peer-left" });
		room[role] = sock;

		const other = room[otherRole(role)];
		// Tell the newcomer the counterpart is already here, and the counterpart
		// that this peer just arrived — so the sender offers in either order.
		if (other) sendJson(sock, { type: "peer-joined", role: otherRole(role) });
		if (other) sendJson(other, { type: "peer-joined", role });
	}

	/** Forward a handshake frame to the peer holding the other role. */
	relay(streamId: string, from: WebrtcRole, frame: WebrtcServerMessage): void {
		const other = this.#rooms.get(streamId)?.[otherRole(from)];
		if (other) sendJson(other, frame);
	}

	/** Release `role` in `streamId`, telling the other peer it left. */
	leave(streamId: string, role: WebrtcRole): void {
		const room = this.#rooms.get(streamId);
		if (!room) return;
		room[role] = undefined;
		const other = room[otherRole(role)];
		if (other) sendJson(other, { type: "peer-left" });
		if (!room.sender && !room.receiver) this.#rooms.delete(streamId);
	}
}

/** Per-connection state carried on `ws.data` across the handlers. */
interface WebrtcWsData {
	streamId?: string;
	role?: WebrtcRole;
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
				(ws.data as WebrtcWsData).streamId = id;
				(ws.data as WebrtcWsData).role = role;
				manager.join(id, role, ws);
			},
			message(ws, message) {
				const data = ws.data as WebrtcWsData;
				if (!data.streamId || !data.role) return;
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
				// Media-handshake frames are relayed to the peer holding the
				// other role; `join` is implicit in the WebSocket upgrade.
				manager.relay(data.streamId, data.role, parsed);
			},
			close(ws) {
				const data = ws.data as WebrtcWsData;
				if (data.streamId && data.role) manager.leave(data.streamId, data.role);
			},
		});
}
