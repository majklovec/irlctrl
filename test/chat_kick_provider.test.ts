import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// Shorten the staleness window before the provider module is evaluated so the
// test does not block on a real 3-minute silence.
process.env.SRTLA_KICK_CHAT_STALE_MS = "50";

/**
 * The Kick provider rides Pusher, which keeps a half-open socket alive with
 * `pusher:ping` even after the chatroom subscription has silently died. A
 * frozen subscription then reports "connected" forever and the feed only
 * moves on a manual reconnect (switching channels). This test pins the
 * staleness watchdog: subscribe arms it, chat messages keep it reset, and a
 * full window of silence drops the socket so it reconnects on its own.
 */

type WsListener = { event: string; fn: (ev?: unknown) => void };
class FakeWebSocket {
    static instances: FakeWebSocket[] = [];
    readonly listeners: WsListener[] = [];
    sent: string[] = [];
    closed = false;
    constructor(public url: string) {
        FakeWebSocket.instances.push(this);
    }
    addEventListener(type: string, fn: (ev?: unknown) => void): void {
        this.listeners.push({ event: type, fn });
    }
    send(data: string): void {
        this.sent.push(data);
    }
    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.listeners
            .filter((l) => l.event === "close")
            .forEach((l) => l.fn());
    }
    emit(type: string, data?: unknown): void {
        this.listeners
            .filter((l) => l.event === type)
            .forEach((l) => l.fn(data));
    }
}

const originalFetch = globalThis.fetch;
const originalWebSocket = (globalThis as Record<string, unknown>).WebSocket;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

beforeEach(() => {
    FakeWebSocket.instances = [];
    // Resolve the channel as live so connect proceeds to join Pusher.
    globalThis.fetch = (async () =>
        Response.json({ chatroom: { id: 123 }, livestream: { is_live: true } })) as unknown as typeof fetch;
    (globalThis as Record<string, unknown>).WebSocket = FakeWebSocket;
});

afterEach(() => {
    globalThis.fetch = originalFetch;
    // Restore Bun's real WebSocket so other test files are unaffected.
    (globalThis as Record<string, unknown>).WebSocket = originalWebSocket;
});

async function startSubscribedProvider(): Promise<{
    provider: import("../server/modules/chat/providers/kick").KickChatProvider;
    ws: FakeWebSocket;
}> {
    const { KickChatProvider } = await import(
        "../server/modules/chat/providers/kick"
    );
    const provider = new KickChatProvider("example", () => {});
    provider.start();

    for (let i = 0; i < 100 && FakeWebSocket.instances.length === 0; i++) {
        await sleep(0);
    }
    const ws = FakeWebSocket.instances[0];
    if (!ws) throw new Error("No Pusher socket was opened");

    ws.emit("message", { data: JSON.stringify({ event: "pusher:connection_established" }) });
    ws.emit("message", {
        data: JSON.stringify({ event: "pusher_internal:subscription_succeeded" }),
    });
    return { provider, ws };
}

function chatMessage(ws: FakeWebSocket, id: number): void {
    ws.emit("message", {
        data: JSON.stringify({
            event: "App\\Events\\ChatMessageEvent",
            data: JSON.stringify({ id, message: "hi", unique_id: `u-${id}` }),
        }),
    });
}

describe("Kick chat provider staleness watchdog", () => {
    test("rejoins after a full window without chat messages", async () => {
        const { provider, ws } = await startSubscribedProvider();
        expect(provider.connected).toBe(true);

        await sleep(140); // well beyond the 50 ms stale window
        expect(ws.closed).toBe(true);
        expect(provider.connected).toBe(false);
        provider.stop(); // clear the pending reconnect for the next test
    });

    test("chat messages keep resetting the watchdog", async () => {
        const { provider, ws } = await startSubscribedProvider();

        // Most of the window elapses, then a message resets the timer: the
        // socket must not close on the old deadline.
        await sleep(35);
        chatMessage(ws, 1);
        expect(provider.connected).toBe(true);
        await sleep(35);
        expect(ws.closed).toBe(false);

        // A second full window of silence after the last message fires it.
        await sleep(140);
        expect(ws.closed).toBe(true);
        expect(provider.connected).toBe(false);
        provider.stop(); // clear the pending reconnect for the next test
    });

    test("stop clears the watchdog", async () => {
        const { provider, ws } = await startSubscribedProvider();
        expect(provider.connected).toBe(true);

        provider.stop();
        await sleep(140);
        expect(provider.connected).toBe(false);
    });
});

describe("Kick chat provider badge extraction", () => {
    test("sender.identity.badges become message badges on the wire frame", async () => {
        const { KickChatProvider } = await import(
            "../server/modules/chat/providers/kick"
        );
        const frames: string[] = [];
        const provider = new KickChatProvider("example", (msg) => frames.push(msg));
        provider.start();

        for (let i = 0; i < 100 && FakeWebSocket.instances.length === 0; i++) {
            await sleep(0);
        }
        const ws = FakeWebSocket.instances[0];
        if (!ws) throw new Error("No Pusher socket was opened");
        ws.emit("message", JSON.stringify({ event: "pusher:connection_established" }));
        ws.emit(
            "message",
            JSON.stringify({ event: "pusher_internal:subscription_succeeded" }),
        );

        // A chat message whose sender carries identity badges.
        ws.emit("message", {
            data: JSON.stringify({
                event: "App\\Events\\ChatMessageEvent",
                data: JSON.stringify({
                    id: 5,
                    content: "hi",
                    sender: {
                        username: "Tom",
                        identity: {
                            color: "#ff0000",
                            badges: [
                                { type: "subscriber", text: "Subscriber", count: 3 },
                                { type: "moderator", text: "Moderator" },
                            ],
                        },
                    },
                }),
            }),
        });

        const chatFrame = frames
            .map((f) => JSON.parse(f))
            .find((f) => f.event === "kick.chat" && f.data?.message);
        expect(chatFrame).toBeDefined();
        const line = chatFrame.data.message;
        expect(line.username).toBe("Tom");
        expect(line.color).toBe("#ff0000");
        expect(line.badges).toEqual([
            { type: "subscriber", text: "Subscriber", count: 3 },
            { type: "moderator", text: "Moderator" },
        ]);
        provider.stop();
    });

    test("messages without badges carry no badges field", async () => {
        const { KickChatProvider } = await import(
            "../server/modules/chat/providers/kick"
        );
        const frames: string[] = [];
        const provider = new KickChatProvider("example", (msg) => frames.push(msg));
        provider.start();

        for (let i = 0; i < 100 && FakeWebSocket.instances.length === 0; i++) {
            await sleep(0);
        }
        const ws = FakeWebSocket.instances[0];
        if (!ws) throw new Error("No Pusher socket was opened");
        ws.emit("message", JSON.stringify({ event: "pusher:connection_established" }));
        ws.emit(
            "message",
            JSON.stringify({ event: "pusher_internal:subscription_succeeded" }),
        );

        chatMessage(ws, 9); // no sender / no identity badges
        const chatFrame = frames
            .map((f) => JSON.parse(f))
            .find((f) => f.event === "kick.chat" && f.data?.message);
        expect(chatFrame).toBeDefined();
        expect(chatFrame.data.message.badges).toBeUndefined();
        provider.stop();
    });
});
