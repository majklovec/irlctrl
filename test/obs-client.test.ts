import { describe, expect, test } from "bun:test";
import { ObsClient, ObsOpCode } from "../shared/obs/client";

/**
 * Stub that records constructed instances. Captures the "message" listener so
 * a test can drive the identify handshake to a live, identified session.
 */
class FakeWebSocket {
	static instances: FakeWebSocket[] = [];
	readyState = 0; // CONNECTING
	onmessage: ((ev: { data: unknown }) => void) | null = null;
	constructor(public url: string) {
		FakeWebSocket.instances.push(this);
	}
	addEventListener(type: string, fn: (ev: never) => void) {
		if (type === "message")
			this.onmessage = fn as (ev: { data: unknown }) => void;
	}
	removeEventListener() {}
	send() {}
	close() {
		this.readyState = 3; // CLOSED
	}
	/** Drive the obs-websocket identify handshake to completion. */
	identify(): void {
		// The client parses ev.data as a JSON string, just like a real socket.
		this.onmessage?.({
			data: JSON.stringify({
				op: ObsOpCode.Hello,
				d: { protocolVersion: 1, authentication: false },
			}),
		});
		this.onmessage?.({
			data: JSON.stringify({ op: ObsOpCode.Identified, d: {} }),
		});
	}
}

function makeClient(url: string): ObsClient {
	return new ObsClient({
		url,
		autoConnect: false,
		disableReconnect: true,
		log: () => {},
	});
}

function withFakeWs(fn: () => Promise<void>): Promise<void> {
	const orig = globalThis.WebSocket;
	FakeWebSocket.instances = [];
	globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
	return fn().finally(() => {
		globalThis.WebSocket = orig;
	});
}

describe("ObsClient.setConnection", () => {
	test("returns false when the endpoint and password are unchanged", () => {
		const obs = makeClient("ws://a:4455");
		expect(obs.setConnection("ws://a:4455", "")).toBe(false);
		expect(obs.setConnection("ws://a:4455")).toBe(false);
	});

	test("detects a password-only change", () => {
		const obs = makeClient("ws://a:4455");
		expect(obs.setConnection("ws://a:4455", "secret")).toBe(true);
	});

	test("applies the new endpoint on the next connect", async () => {
		await withFakeWs(async () => {
			const obs = makeClient("ws://a:4455");
			expect(obs.setConnection("ws://b:4455", "pw")).toBe(true);
			const p = obs.connect(); // the stub socket is created synchronously
			FakeWebSocket.instances[0].identify();
			await p;
			expect(obs.identified).toBe(true);
			expect(FakeWebSocket.instances.map((w) => w.url)).toEqual([
				"ws://b:4455",
			]);
		});
	});

	test("reconnects to the new endpoint when a session is live", async () => {
		await withFakeWs(async () => {
			const obs = makeClient("ws://a:4455");
			const p = obs.connect();
			FakeWebSocket.instances[0].identify();
			await p;
			expect(obs.identified).toBe(true);

			expect(obs.setConnection("ws://b:4455", "pw")).toBe(true);
			// the old socket is closed and a fresh one dials the new URL
			expect(FakeWebSocket.instances.map((w) => w.url)).toEqual([
				"ws://a:4455",
				"ws://b:4455",
			]);
			expect(FakeWebSocket.instances[0].readyState).toBe(3);
			expect(obs.identified).toBe(false);
		});
	});
});
