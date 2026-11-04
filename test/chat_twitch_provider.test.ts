import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChatLive } from "../server/pages/dashboards/modules/chat/types";
import { parseTwitchBadges } from "../server/pages/dashboards/modules/chat/providers/twitch_badges";

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
        this.listeners.filter((l) => l.event === "close").forEach((l) => l.fn());
    }
    emit(type: string, data?: unknown): void {
        this.listeners.filter((l) => l.event === type).forEach((l) => l.fn(data));
    }
}

const originalWebSocket = (globalThis as Record<string, unknown>).WebSocket;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// A real PRIVMSG as Twitch's relay sends it (IRCv3 tag block included).
const PRIVMSG = (overrides: Record<string, string>): string => {
    const tags: Record<string, string> = {
        badges: "moderator/1,subscriber/0",
        color: "#ff0000",
        "display-name": "DrAul432",
        id: "twitch-1",
        ...overrides,
    };
    const tagStr = Object.entries(tags)
        .map(([k, v]) => (v ? `${k}=${v}` : k))
        .join(";");
    return `@${tagStr} :draul432!draul432@user.mode-123.twitch.tv PRIVMSG #channel :hello world`;
};

async function startProvider(): Promise<{
    provider: import("../server/pages/dashboards/modules/chat/providers/twitch").TwitchChatProvider;
    ws: FakeWebSocket;
    frames: string[];
}> {
    const { TwitchChatProvider } = await import(
        "../server/pages/dashboards/modules/chat/providers/twitch"
    );
    const frames: string[] = [];
    const provider = new TwitchChatProvider("channel", (msg) => frames.push(msg));
    provider.start();
    for (let i = 0; i < 100 && FakeWebSocket.instances.length === 0; i++) {
        await sleep(0);
    }
    const ws = FakeWebSocket.instances[0];
    if (!ws) throw new Error("No IRC socket was opened");
    ws.emit("open");
    return { provider, ws, frames };
}

function lastMessage(frames: string[]): ChatLive | undefined {
    const chatFrame = frames
        .map((f) => JSON.parse(f))
        .find((f) => f.event === "twitch.chat" && f.data?.message);
    return chatFrame?.data?.message as ChatLive | undefined;
}

beforeEach(() => {
    FakeWebSocket.instances = [];
    (globalThis as Record<string, unknown>).WebSocket = FakeWebSocket;
});

afterEach(() => {
    (globalThis as Record<string, unknown>).WebSocket = originalWebSocket;
});

describe("twitch badge tag parsing", () => {
    test("maps set_id/version pairs to their real CDN GUID urls in tag order", () => {
        const badges = parseTwitchBadges("moderator/1,subscriber/0");
        expect(badges).toEqual([
            {
                type: "moderator",
                text: "Moderator",
                url: "https://static-cdn.jtvnw.net/badges/v1/3267646d-33f0-4b17-b3df-f923a41db1d0/1",
            },
            {
                type: "subscriber",
                text: "Subscriber",
                url: "https://static-cdn.jtvnw.net/badges/v1/5d9f2208-5dd8-11e7-8513-2ff4adfae661/0",
            },
        ]);
    });

    test("turbo badge resolves to the exact current CDN image", () => {
        const badges = parseTwitchBadges("turbo/1");
        expect(badges).toHaveLength(1);
        expect(badges?.[0]).toEqual({
            type: "turbo",
            text: "Turbo",
            url: "https://static-cdn.jtvnw.net/badges/v1/bd444ec6-8f34-4bf9-91f4-af1e3428d80f/1",
        });
    });

    test("skips badges with no known art (channel tiers + unknown), keeps the rest", () => {
        const badges = parseTwitchBadges(
            "turbo/1,bits/5000,subscriber_badge_3/0,subscriber/6,bits/5001,junk",
        );
        // subscriber_badge_3 (channel tier), bits/5001 (no such art) and junk
        // have no catalog entry -> dropped; turbo/bits/subscriber resolve.
        expect(badges?.map((b) => b.type)).toEqual([
            "turbo",
            "bits",
            "subscriber",
        ]);
        expect(badges?.[1]?.text).toBe("cheer 5000");
    });

    test("returns undefined when nothing resolves", () => {
        expect(parseTwitchBadges("")).toBeUndefined();
        expect(parseTwitchBadges("junk/1")).toBeUndefined();
    });
});

describe("Twitch chat provider badge extraction", () => {
    test("PRIVMSG badges ride the wire shape as CDN images", async () => {
        const { provider, ws, frames } = await startProvider();
        ws.emit("message", { data: PRIVMSG({}) });
        provider.stop();

        const msg = lastMessage(frames);
        expect(msg?.username).toBe("DrAul432");
        expect(msg?.badges).toHaveLength(2);
        expect(msg?.badges?.[0].type).toBe("moderator");
        expect(msg?.badges?.[0].url).toBe(
            "https://static-cdn.jtvnw.net/badges/v1/3267646d-33f0-4b17-b3df-f923a41db1d0/1",
        );
    });

    test("messages without a badges tag carry no badges", async () => {
        const { provider, ws, frames } = await startProvider();
        ws.emit("message", { data: PRIVMSG({ badges: "" }) });
        provider.stop();

        const msg = lastMessage(frames);
        expect(msg).toBeDefined();
        expect(msg?.badges).toBeUndefined();
    });
});
