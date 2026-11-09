import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import {
	hmacSha1Base64,
	mintTurnCredential,
	parseWebrtcClientMessage,
	type IceServers,
	type RoomState,
	WEBRTC_STREAM_ID_RE,
} from "../server/pages/overlays/modules/webrtc/webrtc_protocol";
import {
	WebrtcRoomManager,
	webrtcSignalingRoutes,
} from "../server/pages/overlays/modules/webrtc/webrtc_signaling";

// ── wire-protocol parser ────────────────────────────────────────────────────

describe("webrtc protocol parser", () => {
	test("accepts a valid offer, answer and ice", () => {
		expect(
			parseWebrtcClientMessage({
				type: "offer",
				sdp: { type: "offer", sdp: "v=0" },
			}),
		).toEqual({ type: "offer", sdp: { type: "offer", sdp: "v=0" } });
		expect(
			parseWebrtcClientMessage({
				type: "answer",
				sdp: { type: "answer", sdp: "v=0" },
			}),
		).not.toBeNull();
		expect(
			parseWebrtcClientMessage({
				type: "ice",
				candidate: { candidate: "cand 1 1", sdpMid: "0" },
			}),
		).toEqual({
			type: "ice",
			candidate: { candidate: "cand 1 1", sdpMid: "0" },
		});
		// an end-of-candidates marker (no `candidate` field) is accepted
		expect(parseWebrtcClientMessage({ type: "ice", candidate: {} })).toEqual({
			type: "ice",
			candidate: {},
		});
	});

	test("rejects malformed frames", () => {
		expect(parseWebrtcClientMessage(null)).toBeNull();
		expect(parseWebrtcClientMessage("offer")).toBeNull();
		expect(parseWebrtcClientMessage({ type: "nope" })).toBeNull();
		expect(parseWebrtcClientMessage({ type: "offer", sdp: {} })).toBeNull();
		expect(
			parseWebrtcClientMessage({ type: "offer", sdp: { type: "offer" } }),
		).toBeNull();
	});

	test("rejects the removed ice-config frame", () => {
		expect(
			parseWebrtcClientMessage({
				type: "ice-config",
				servers: [{ urls: "stun:stun.l.google.com:19302" }],
			}),
		).toBeNull();
	});

	test("hmacSha1Base64 matches a known HMAC-SHA1 vector", async () => {
		// base64(HMAC-SHA1("key", "The quick brown fox jumps over the lazy dog"))
		const node = await import("node:crypto");
		const expected = node
			.createHmac("sha1", "key")
			.update("The quick brown fox jumps over the lazy dog")
			.digest("base64");
		expect(
			await hmacSha1Base64("key", "The quick brown fox jumps over the lazy dog"),
		).toBe(expected);
	});

	test("mintTurnCredential matches node's HMAC-SHA1 (base64)", async () => {
		const node = await import("node:crypto");
		const host = "turn.example.com";
		const secret = "s3cr3t-turn-key";
		const server = await mintTurnCredential(host, secret, 7200);
		// username is the expiry timestamp (~now + ttl seconds)
		const expiry = Number(server.username);
		const now = Math.floor(Date.now() / 1000);
		expect(expiry).toBeGreaterThan(now + 7100);
		expect(expiry).toBeLessThanOrEqual(now + 7200);
		const expected = node
			.createHmac("sha1", secret)
			.update(String(expiry))
			.digest("base64");
		expect(server.credential).toBe(expected);
		expect(server.urls).toEqual(["turn:turn.example.com:3478?transport=udp"]);
	});

	test("the stream id regex accepts element ids and rejects junk", () => {
		expect(WEBRTC_STREAM_ID_RE.test("abc-123-def")).toBe(true);
		expect(
			WEBRTC_STREAM_ID_RE.test("a0b1c2d3-e4f5-6789-abcd-ef0123456789"),
		).toBe(true);
		expect(WEBRTC_STREAM_ID_RE.test("")).toBe(false);
		expect(WEBRTC_STREAM_ID_RE.test("a/b")).toBe(false);
		expect(WEBRTC_STREAM_ID_RE.test("a b")).toBe(false);
	});
});

// ── room manager (pure, no server) ──────────────────────────────────────────

class FakeSocket {
	readyState = 1;
	sent: string[] = [];
	send(message: string): void {
		this.sent.push(message);
	}
	close(): void {
		this.readyState = 3;
	}
	get frames(): Record<string, unknown>[] {
		return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
	}
	matches(frame: Record<string, unknown>): boolean {
		return this.frames.some((x) => JSON.stringify(x) === JSON.stringify(frame));
	}
}

describe("webrtc room manager", () => {
	// A room-state frame expectation. `active` is true only for the primary
	// receiver; `primary` is the handover token (it changes when the identity
	// of the primary changes, which is what makes the sender renegotiate).
	const st = (
		sender: boolean,
		receiver: boolean,
		active = false,
		primary = 0,
	): { type: "room-state"; state: RoomState } => ({
		type: "room-state",
		state: { sender, receiver, active, primary },
	});

	test("a join announces the room layout to both peers", () => {
		const m = new WebrtcRoomManager();
		const sender = new FakeSocket();
		m.join("s1", "sender", sender);
		// sender-only room: no primary, token 0
		expect(sender.matches(st(true, false, false, 0))).toBe(true);
		const receiver = new FakeSocket();
		m.join("s1", "receiver", receiver);
		// the receiver is the (only) primary; the token bumps 0 -> 1
		expect(sender.matches(st(true, true, false, 1))).toBe(true);
		expect(receiver.matches(st(true, true, true, 1))).toBe(true);
	});

	test("a second sender displaces the first and notifies it", () => {
		const m = new WebrtcRoomManager();
		const oldSender = new FakeSocket();
		m.join("s1", "sender", oldSender);

		const newSender = new FakeSocket();
		m.join("s1", "sender", newSender);

		// The displaced old sender is told it was hijacked.
		expect(oldSender.matches({ type: "hijacked" })).toBe(true);
		// The new sender becomes the slot holder and (with nobody else) has a
		// sender-only room: token 0, no primary.
		expect(newSender.matches(st(true, false, false, 0))).toBe(true);
		// The room now occupies the sender slot.
		expect(m.occupancy()["s1"]).toBeDefined();
	});

	test("room-state carries the deployment's minted ICE servers", () => {
		const servers: IceServers = [
			{ urls: "stun:stun.l.google.com:19302" },
			{
				urls: "turn:turn.example.com:3478?transport=udp",
				username: "1700000000",
				credential: "abc",
			},
		];
		const m = new WebrtcRoomManager(() => servers);
		const sender = new FakeSocket();
		m.join("s1", "sender", sender);
		// The on-join snapshot now includes the minted servers (STUN + TURN);
		// the server is the source of truth — no separate client frame.
		expect(
			sender.matches({
				type: "room-state",
				state: {
					sender: true,
					receiver: false,
					active: false,
					primary: 0,
					iceServers: servers,
				},
			}),
		).toBe(true);
		const receiver = new FakeSocket();
		m.join("s1", "receiver", receiver); // becomes the primary
		expect(
			receiver.matches({
				type: "room-state",
				state: {
					sender: true,
					receiver: true,
					active: true,
					primary: 1,
					iceServers: servers,
				},
			}),
		).toBe(true);
	});

	test("relay delivers a frame only to the primary peer", () => {
		const m = new WebrtcRoomManager();
		const sender = new FakeSocket();
		const receiver = new FakeSocket();
		m.join("s1", "sender", sender);
		m.join("s1", "receiver", receiver); // becomes the primary
		m.relay("s1", "sender", {
			type: "offer",
			sdp: { type: "offer", sdp: "v=0" },
		});
		expect(receiver.frames.at(-1)).toEqual({
			type: "offer",
			sdp: { type: "offer", sdp: "v=0" },
		});
		// the sender saw only its two room-state announcements, not its own frame
		expect(sender.frames.length).toBe(2);
		expect(
			sender.matches({ type: "offer", sdp: { type: "offer", sdp: "v=0" } }),
		).toBe(false);
		m.relay("s1", "receiver", {
			type: "answer",
			sdp: { type: "answer", sdp: "v=0" },
		});
		expect(sender.frames.at(-1)).toEqual({
			type: "answer",
			sdp: { type: "answer", sdp: "v=0" },
		});
	});

	test("an offer from a receiver is dropped, not relayed", () => {
		const m = new WebrtcRoomManager();
		const sender = new FakeSocket();
		const receiver = new FakeSocket();
		m.join("s1", "sender", sender);
		m.join("s1", "receiver", receiver);
		// The sender is the only offerer; a receiver offer would dead-end the
		// negotiation, so the manager drops it.
		m.message("s1", "receiver", receiver, {
			type: "offer",
			sdp: { type: "offer", sdp: "v=0" },
		});
		expect(
			sender.matches({ type: "offer", sdp: { type: "offer", sdp: "v=0" } }),
		).toBe(false);
	});

	test("rooms are isolated per stream id (no cross-talk)", () => {
		const m = new WebrtcRoomManager();
		const aSender = new FakeSocket();
		const bSender = new FakeSocket();
		m.join("a", "sender", aSender);
		m.join("b", "sender", bSender);
		const bReceiver = new FakeSocket();
		m.join("b", "receiver", bReceiver);
		// the stream-a peer only ever hears about its own (empty) room
		expect(aSender.matches(st(true, false, false, 0))).toBe(true);
		expect(aSender.matches(st(true, true, false, 0))).toBe(false);
		expect(bSender.matches({ type: "offer" })).toBe(false);
		m.relay("b", "receiver", {
			type: "offer",
			sdp: { type: "offer", sdp: "x" },
		});
		expect(
			aSender.matches({ type: "offer", sdp: { type: "offer", sdp: "x" } }),
		).toBe(false);
	});

	test("a receiver leaving announces the reduced layout (no peer-left to the sender)", () => {
		const m = new WebrtcRoomManager();
		const sender = new FakeSocket();
		const receiver = new FakeSocket();
		m.join("s1", "sender", sender);
		m.join("s1", "receiver", receiver); // primary, token 1
		m.leave("s1", "receiver", receiver);
		// the sender learns the receiver is gone via room-state, NOT peer-left;
		// the token bumps again (a primary left)
		expect(sender.matches({ type: "peer-left" })).toBe(false);
		expect(sender.frames.at(-1)).toEqual(st(true, false, false, 2));
	});

	test("a second (non-priority) receiver joins as a shadow, not primary", () => {
		const m = new WebrtcRoomManager();
		const sender = new FakeSocket();
		const first = new FakeSocket();
		m.join("s1", "sender", sender);
		m.join("s1", "receiver", first); // primary, token 1
		const second = new FakeSocket();
		m.join("s1", "receiver", second); // slot taken -> shadow
		expect(first.matches(st(true, true, true, 1))).toBe(true);
		expect(second.matches(st(true, true, false, 1))).toBe(true);
		// the token did NOT bump (the primary is unchanged)
		expect(sender.frames.at(-1)).toEqual(st(true, true, false, 1));
	});

	test("a priority receiver (the OBS page) takes the live slot and demotes the primary", () => {
		const m = new WebrtcRoomManager();
		const sender = new FakeSocket();
		const editor = new FakeSocket();
		m.join("s1", "sender", sender);
		m.join("s1", "receiver", editor); // editor is primary, token 1
		const obs = new FakeSocket();
		m.join("s1", "receiver", obs, true); // OBS priority, token 2
		// the editor is demoted to a shadow — told via room-state active:false,
		// NOT peer-left (it keeps its last frame + the note)
		expect(editor.matches({ type: "peer-left" })).toBe(false);
		expect(editor.matches(st(true, true, false, 2))).toBe(true);
		// obs is now the primary (active:true)
		expect(obs.matches(st(true, true, true, 2))).toBe(true);
		// the sender sees the token change -> renegotiates with the new primary
		expect(sender.matches(st(true, true, false, 2))).toBe(true);
		// a fresh offer goes ONLY to the new primary (obs), not the shadow
		m.relay("s1", "sender", {
			type: "offer",
			sdp: { type: "offer", sdp: "obs" },
		});
		expect(obs.frames.at(-1)).toEqual({
			type: "offer",
			sdp: { type: "offer", sdp: "obs" },
		});
		expect(editor.matches({ type: "offer", sdp: { type: "offer", sdp: "obs" } })).toBe(
			false,
		);
	});

	test("when the primary leaves, the newest remaining receiver is promoted", () => {
		const m = new WebrtcRoomManager();
		const sender = new FakeSocket();
		const obs = new FakeSocket();
		const editor = new FakeSocket();
		m.join("s1", "sender", sender);
		m.join("s1", "receiver", obs, true); // obs primary, token 1
		m.join("s1", "receiver", editor); // editor shadow
		m.leave("s1", "receiver", obs); // the primary leaves -> token 2
		// the editor is promoted to primary (active:true)
		expect(editor.matches(st(true, true, true, 2))).toBe(true);
		// the sender sees the token change -> renegotiates with the editor
		expect(sender.frames.at(-1)).toEqual(st(true, true, false, 2));
	});

	test("a receiver that rejoins after the last one left re-meets the sender", () => {
		const m = new WebrtcRoomManager();
		const sender = new FakeSocket();
		const receiver = new FakeSocket();
		m.join("s1", "sender", sender);
		m.join("s1", "receiver", receiver); // token 1
		m.leave("s1", "receiver", receiver); // token 2 (the primary left)
		const fresh = new FakeSocket();
		m.join("s1", "receiver", fresh); // token 3 (a new primary)
		expect(fresh.matches(st(true, true, true, 3))).toBe(true);
		expect(sender.matches(st(true, true, false, 3))).toBe(true);
	});

	test("sync answers with the caller's own room state (active is per-recipient)", () => {
		const m = new WebrtcRoomManager();
		const sender = new FakeSocket();
		const receiver = new FakeSocket();
		m.join("s1", "sender", sender);
		m.join("s1", "receiver", receiver); // primary, token 1
		// the receiver is the primary, so its sync reply says active:true
		expect(m.message("s1", "receiver", receiver, { type: "sync" })).toEqual(
			st(true, true, true, 1),
		);
		// a media-handshake frame is relayed to the primary with no direct reply
		expect(
			m.message("s1", "sender", sender, {
				type: "ice",
				candidate: { candidate: "c", sdpMid: "0" },
			}),
		).toBeNull();
		expect(
			receiver.matches({
				type: "ice",
				candidate: { candidate: "c", sdpMid: "0" },
			}),
		).toBe(true);
	});
});

// ── Elysia route wiring (live WebSocket upgrade + relay) ────────────────────

const BunWebSocket = WebSocket as unknown as new (url: string) => Bun.WebSocket;

const frameQueues = new WeakMap<Bun.WebSocket, Record<string, unknown>[]>();

async function connectSocket(url: string): Promise<Bun.WebSocket> {
	const socket = new BunWebSocket(url);
	const queue: Record<string, unknown>[] = [];
	frameQueues.set(socket, queue);
	socket.addEventListener("message", (event: Event) => {
		if (!("data" in event) || typeof event.data !== "string") return;
		try {
			queue.push(JSON.parse(event.data) as Record<string, unknown>);
		} catch {
			/* ignore non-JSON */
		}
	});
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			socket.close();
			reject(new Error(`WebSocket connection timed out: ${url}`));
		}, 5_000);
		socket.addEventListener(
			"open",
			() => {
				clearTimeout(timeout);
				resolve();
			},
			{ once: true },
		);
		socket.addEventListener(
			"error",
			() => {
				clearTimeout(timeout);
				reject(new Error(`WebSocket connection failed: ${url}`));
			},
			{ once: true },
		);
	});
	return socket;
}

function nextFrame(
	socket: Bun.WebSocket,
	matches: (frame: Record<string, unknown>) => boolean,
	timeoutMs = 5_000,
): Promise<Record<string, unknown>> {
	const queue = frameQueues.get(socket);
	if (queue)
		for (let i = 0; i < queue.length; i++)
			if (matches(queue[i])) return Promise.resolve(queue.splice(i, 1)[0]);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			socket.removeEventListener("message", onMessage);
			reject(new Error("Timed out waiting for a WebRTC frame"));
		}, timeoutMs);
		const onMessage = (event: Event) => {
			if (!("data" in event) || typeof event.data !== "string") return;
			const frame = JSON.parse(event.data) as Record<string, unknown>;
			if (!matches(frame)) return;
			clearTimeout(timer);
			socket.removeEventListener("message", onMessage);
			resolve(frame);
		};
		socket.addEventListener("message", onMessage);
	});
}

describe("webrtc signaling routes (integration)", () => {
	test("a plain GET on the signaling route is answered 426 Upgrade Required", async () => {
		const app = new Elysia({ name: "webrtc-test" }).use(
			webrtcSignalingRoutes(new WebrtcRoomManager()),
		);
		const res = await app.handle(
			new Request("http://localhost/api/webrtc/stream/s1/ws?role=sender"),
		);
		expect(res.status).toBe(426);
	});

	test("sender + receiver pair, offer/answer/ice relay, and peer-left on close", async () => {
		const manager = new WebrtcRoomManager();
		const app = new Elysia({ name: "webrtc-test" }).use(
			webrtcSignalingRoutes(manager),
		);
		app.listen({ port: 0 });
		const origin = `ws://127.0.0.1:${app.server?.port ?? 0}`;
		const sender = await connectSocket(
			`${origin}/api/webrtc/stream/s1/ws?role=sender`,
		);
		const receiver = await connectSocket(
			`${origin}/api/webrtc/stream/s1/ws?role=receiver`,
		);
		try {
			// both peers receive a room-state snapshot reflecting both occupants
			await nextFrame(sender, (f) => {
				if (f.type !== "room-state") return false;
				return (f.state as RoomState).sender && (f.state as RoomState).receiver;
			});
			await nextFrame(receiver, (f) => {
				if (f.type !== "room-state") return false;
				return (f.state as RoomState).sender && (f.state as RoomState).receiver;
			});
			// regression: the room must be keyed by the REAL stream id from the
			// path (…/stream/<id>/ws), not by a stray path segment
			expect(manager.occupancy()).toEqual({ s1: ["sender", "receiver"] });
			// sender offers → receiver gets it
			sender.send(
				JSON.stringify({
					type: "offer",
					sdp: { type: "offer", sdp: "v=0" },
				}),
			);
			const offer = await nextFrame(receiver, (f) => f.type === "offer");
			expect(offer.sdp).toEqual({ type: "offer", sdp: "v=0" });
			// receiver answers → sender gets it
			receiver.send(
				JSON.stringify({
					type: "answer",
					sdp: { type: "answer", sdp: "v=0" },
				}),
			);
			await nextFrame(sender, (f) => f.type === "answer");
			// ice both ways
			sender.send(
				JSON.stringify({
					type: "ice",
					candidate: { candidate: "c", sdpMid: "0" },
				}),
			);
			await nextFrame(receiver, (f) => f.type === "ice");
			// a malformed frame is dropped (no crash, no relay)
			receiver.send("not json");
			// sender closes → receiver is told it left
			sender.close();
			await nextFrame(receiver, (f) => f.type === "peer-left");
		} finally {
			sender.close();
			receiver.close();
			app.stop();
		}
	}, 20_000);
});
