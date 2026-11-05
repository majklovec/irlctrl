import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import {
	parseWebrtcClientMessage,
	WEBRTC_STREAM_ID_RE,
} from "../server/pages/overlays/modules/overlay_elements/webrtc_protocol";
import {
	WebrtcRoomManager,
	webrtcSignalingRoutes,
} from "../server/pages/overlays/modules/overlay_elements/webrtc_signaling";

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
	test("an early join sits quietly; the late joiner and incumbent meet", () => {
		const m = new WebrtcRoomManager();
		const sender = new FakeSocket();
		m.join("s1", "sender", sender);
		expect(sender.frames).toEqual([]);
		const receiver = new FakeSocket();
		m.join("s1", "receiver", receiver);
		expect(sender.matches({ type: "peer-joined", role: "receiver" })).toBe(
			true,
		);
		expect(receiver.matches({ type: "peer-joined", role: "sender" })).toBe(
			true,
		);
	});

	test("relay delivers a frame only to the peer holding the other role", () => {
		const m = new WebrtcRoomManager();
		const sender = new FakeSocket();
		const receiver = new FakeSocket();
		m.join("s1", "sender", sender);
		m.join("s1", "receiver", receiver);
		m.relay("s1", "sender", {
			type: "offer",
			sdp: { type: "offer", sdp: "v=0" },
		});
		expect(receiver.frames.at(-1)).toEqual({
			type: "offer",
			sdp: { type: "offer", sdp: "v=0" },
		});
		// the sender saw only its own peer-joined, not the frame it sent
		expect(sender.frames.length).toBe(1);
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

	test("rooms are isolated per stream id (no cross-talk)", () => {
		const m = new WebrtcRoomManager();
		const aSender = new FakeSocket();
		const bSender = new FakeSocket();
		m.join("a", "sender", aSender);
		m.join("b", "sender", bSender);
		const bReceiver = new FakeSocket();
		m.join("b", "receiver", bReceiver);
		expect(aSender.frames).toEqual([]);
		expect(bSender.matches({ type: "peer-joined", role: "receiver" })).toBe(
			true,
		);
		m.relay("b", "receiver", {
			type: "offer",
			sdp: { type: "offer", sdp: "x" },
		});
		expect(aSender.frames).toEqual([]);
	});

	test("leaving tells the other peer and drops the emptied room", () => {
		const m = new WebrtcRoomManager();
		const sender = new FakeSocket();
		const receiver = new FakeSocket();
		m.join("s1", "sender", sender);
		m.join("s1", "receiver", receiver);
		m.leave("s1", "receiver");
		expect(sender.matches({ type: "peer-left" })).toBe(true);
		// the peer that left is not told it left
		expect(receiver.matches({ type: "peer-left" })).toBe(false);
		// the room is gone: a fresh receiver now meets the sender anew
		const fresh = new FakeSocket();
		m.join("s1", "receiver", fresh);
		expect(sender.matches({ type: "peer-joined", role: "receiver" })).toBe(
			true,
		);
	});

	test("a fresh receiver replaces the stale one (the old one is told it left)", () => {
		const m = new WebrtcRoomManager();
		const sender = new FakeSocket();
		const oldReceiver = new FakeSocket();
		m.join("s1", "sender", sender);
		m.join("s1", "receiver", oldReceiver);
		const newReceiver = new FakeSocket();
		m.join("s1", "receiver", newReceiver);
		expect(oldReceiver.matches({ type: "peer-left" })).toBe(true);
		expect(sender.matches({ type: "peer-joined", role: "receiver" })).toBe(
			true,
		);
		expect(newReceiver.matches({ type: "peer-joined", role: "sender" })).toBe(
			true,
		);
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
			// both peers learn about each other once both are connected
			await nextFrame(sender, (f) => f.type === "peer-joined");
			await nextFrame(receiver, (f) => f.type === "peer-joined");
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
