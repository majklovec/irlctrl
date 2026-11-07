import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { kickRoleBadgeUrl } from "../server/pages/dashboards/modules/chat/providers/kick_badges";
import type { ChatLive } from "../server/pages/dashboards/modules/chat/types";

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

/** Per-month subscriber artwork returned by the channel API (the same
 * endpoint that supplies the chatroom id). */
const SUBSCRIPTION_BADGES = [
    {
        months: 1,
        badge_image: {
            src: "https://files.kick.com/channel_subscriber_badges/1/conversion/original-fullsize.png",
        },
    },
    {
        months: 3,
        badge_image: {
            src: "https://files.kick.com/channel_subscriber_badges/3/conversion/original-fullsize.png",
        },
    },
    {
        months: 36,
        badge_image: {
            src: "https://files.kick.com/channel_subscriber_badges/36/conversion/original-fullsize.png",
        },
    },
];

beforeEach(() => {
    FakeWebSocket.instances = [];
    // Resolve the channel as live (with subscriber artwork) so connect
    // proceeds to join Pusher and badges can resolve to images.
    globalThis.fetch = (async () =>
        Response.json({
            chatroom: { id: 123 },
            livestream: { is_live: true },
            subscriber_badges: SUBSCRIPTION_BADGES,
        })) as unknown as typeof fetch;
    (globalThis as Record<string, unknown>).WebSocket = FakeWebSocket;
});

afterEach(() => {
    globalThis.fetch = originalFetch;
    // Restore Bun's real WebSocket so other test files are unaffected.
    (globalThis as Record<string, unknown>).WebSocket = originalWebSocket;
});

async function startSubscribedProvider(): Promise<{
    provider: import("../server/pages/dashboards/modules/chat/providers/kick").KickChatProvider;
    ws: FakeWebSocket;
}> {
    const { KickChatProvider } = await import(
        "../server/pages/dashboards/modules/chat/providers/kick"
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

/** Poll until the watchdog closes the socket. The SUT fires a wall-clock
 * `setTimeout`, which is delayed when bun runs the suite with one file per
 * core; a fixed sleep is not, so wait for the side effect (bounded) instead. */
async function waitUntilClosed(ws: FakeWebSocket, budgetMs: number): Promise<void> {
    const started = Date.now();
    while (!ws.closed && Date.now() - started < budgetMs) await sleep(10);
}

describe("Kick chat provider staleness watchdog", () => {
    test("rejoins after a full window without chat messages", async () => {
        const { provider, ws } = await startSubscribedProvider();
        expect(provider.connected).toBe(true);

        await waitUntilClosed(ws, 5000); // watchdog drops the socket on silence
        expect(ws.closed).toBe(true);
        expect(provider.connected).toBe(false);
        provider.stop(); // clear the pending reconnect for the next test
    }, 15000);

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
        await waitUntilClosed(ws, 5000);
        expect(ws.closed).toBe(true);
        expect(provider.connected).toBe(false);
        provider.stop(); // clear the pending reconnect for the next test
    }, 15000);

    test("stop clears the watchdog", async () => {
        const { provider, ws } = await startSubscribedProvider();
        expect(provider.connected).toBe(true);

        provider.stop();
        await sleep(140);
        expect(provider.connected).toBe(false);
    });
});

describe("Kick chat provider badge extraction", () => {
    async function startProvider(): Promise<{
        provider: import("../server/pages/dashboards/modules/chat/providers/kick").KickChatProvider;
        ws: FakeWebSocket;
        frames: string[];
    }> {
        const { KickChatProvider } = await import(
            "../server/pages/dashboards/modules/chat/providers/kick"
        );
        const frames: string[] = [];
        const provider = new KickChatProvider("example", (msg) =>
            frames.push(msg),
        );
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
        return { provider, ws, frames };
    }

    function lastMessage(frames: string[]): ChatLive | undefined {
        const chatFrame = frames
            .map((f) => JSON.parse(f))
            .find((f) => f.event === "kick.chat" && f.data?.message);
        return chatFrame?.data?.message as ChatLive | undefined;
    }

    test("subscriber badge resolves to its channel artwork image by month", async () => {
        const { provider, ws, frames } = await startProvider();

        // Legacy `badges` array: only the subscriber carries a month `count`.
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

        const line = lastMessage(frames);
        expect(line).toBeDefined();
        expect(line?.username).toBe("Tom");
        // The subscriber resolves to the 3-month channel art; the moderator
        // (a role badge with no CDN image) maps to its inline-SVG data-URI.
        expect(line?.badges).toEqual([
            {
                type: "subscriber",
                text: "Subscriber",
                count: 3,
                url: "https://files.kick.com/channel_subscriber_badges/3/conversion/original-fullsize.png",
            },
            {
                type: "moderator",
                text: "Moderator",
                url: kickRoleBadgeUrl("moderator"),
            },
        ]);
        // The moderator data-URI is a self-contained inline SVG.
        expect(line?.badges?.at(1)?.url).toMatch(
            /^data:image\/svg\+xml;utf8,%3Csvg/,
        );
        provider.stop();
    });

    test("subscriber above the highest tier uses the milestone artwork", async () => {
        const { provider, ws, frames } = await startProvider();
        ws.emit("message", {
            data: JSON.stringify({
                event: "App\\Events\\ChatMessageEvent",
                data: JSON.stringify({
                    id: 6,
                    content: "hi",
                    sender: {
                        username: "Ana",
                        identity: {
                            badges: [
                                { type: "subscriber", text: "Subscriber", count: 42 },
                            ],
                        },
                    },
                }),
            }),
        });
        const line = lastMessage(frames);
        // 42 months has no exact tier -> the highest tier <= 42 (36) is used.
        expect(line?.badges).toEqual([
            {
                type: "subscriber",
                text: "Subscriber",
                count: 42,
                url: "https://files.kick.com/channel_subscriber_badges/36/conversion/original-fullsize.png",
            },
        ]);
        provider.stop();
    });

    test("badges_v2 entries render as images and unselected ones are skipped", async () => {
        const { provider, ws, frames } = await startProvider();
        ws.emit("message", {
            data: JSON.stringify({
                event: "App\\Events\\ChatMessageEvent",
                data: JSON.stringify({
                    id: 7,
                    content: "hi",
                    sender: {
                        username: "Bo",
                        identity: {
                            badges_v2: [
                                {
                                    name: "level",
                                    badge_type: "global",
                                    image_url:
                                        "https://ext.cdn.kick.com/chat/badges/37_019f35ce-472c-749c-8e50-5f53afb1de7b.png",
                                    metadata: { level: 37 },
                                    selected: true,
                                    sort_order: 1,
                                },
                                {
                                    name: "GoldenK",
                                    badge_type: "global",
                                    image_url:
                                        "https://ext.cdn.kick.com/chat/badges/GoldenK_019f591b-0a69-712f-836d-8cc8962acd0c.png?width=72,format=webp,quality=50",
                                    selected: true,
                                    sort_order: 2,
                                },
                                {
                                    name: "Hidden",
                                    badge_type: "channel",
                                    image_url:
                                        "https://ext.cdn.kick.com/chat/badges/Hidden_00000000-0000-4000-8000-000000000000.png",
                                    selected: false,
                                    sort_order: 3,
                                },
                            ],
                        },
                    },
                }),
            }),
        });
        const line = lastMessage(frames);
        // Level + selected custom badge become images; the unselected one is
        // skipped.
        expect(line?.badges).toEqual([
            {
                type: "level",
                text: "Level 37",
                count: 37,
                url: "https://ext.cdn.kick.com/chat/badges/37_019f35ce-472c-749c-8e50-5f53afb1de7b.png",
            },
            {
                type: "GoldenK",
                text: "GoldenK",
                url: "https://ext.cdn.kick.com/chat/badges/GoldenK_019f591b-0a69-712f-836d-8cc8962acd0c.png?width=72,format=webp,quality=50",
            },
        ]);
        provider.stop();
    });

    test("messages without badges carry no badges field", async () => {
        const { provider, ws, frames } = await startProvider();
        chatMessage(ws, 9); // no sender / no identity badges
        const line = lastMessage(frames);
        expect(line).toBeDefined();
        expect(line?.badges).toBeUndefined();
        provider.stop();
    });

    test("legacy role badges map to their inline-SVG data-URIs", async () => {
        const { provider, ws, frames } = await startProvider();
        ws.emit("message", {
            data: JSON.stringify({
                event: "App\\Events\\ChatMessageEvent",
                data: JSON.stringify({
                    id: 10,
                    content: "hi",
                    sender: {
                        username: "Roi",
                        identity: {
                            badges: [
                                { type: "moderator" },
                                { type: "vip" },
                                { type: "verified" },
                                { type: "founder" },
                                { type: "sub_gifter" },
                                { type: "og" },
                                { type: "staff" },
                            ],
                        },
                    },
                }),
            }),
        });
        const line = lastMessage(frames);
        const byType = new Map(
            (line?.badges ?? []).map((b) => [b.type, b.url]),
        );
        for (const role of [
            "moderator",
            "vip",
            "verified",
            "founder",
            "sub_gifter",
            "og",
            "staff",
        ]) {
            const url = byType.get(role);
            expect(url).toBeDefined();
            expect(url).toMatch(/^data:image\/svg\+xml;utf8,%3Csvg/);
            // Each role gets a distinct SVG (not a shared/blank asset).
            expect(kickRoleBadgeUrl(role)).toBe(url);
        }
        // Distinct roles must not collapse into one asset.
        expect(new Set([...byType.values()]).size).toBe(7);
        provider.stop();
    });

    test("badges_v2 role entry without an image falls back to its inline SVG", async () => {
        const { provider, ws, frames } = await startProvider();
        ws.emit("message", {
            data: JSON.stringify({
                event: "App\\Events\\ChatMessageEvent",
                data: JSON.stringify({
                    id: 11,
                    content: "hi",
                    sender: {
                        username: "Sam",
                        identity: {
                            badges_v2: [
                                {
                                    name: "moderator",
                                    badge_type: "channel",
                                    selected: true,
                                    sort_order: 1,
                                },
                            ],
                        },
                    },
                }),
            }),
        });
        const line = lastMessage(frames);
        expect(line?.badges).toEqual([
            {
                type: "moderator",
                text: "moderator",
                url: kickRoleBadgeUrl("moderator"),
            },
        ]);
        provider.stop();
    });
});
