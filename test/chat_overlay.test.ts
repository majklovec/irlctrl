import { describe, expect, test } from "bun:test";
import { APP_VERSION } from "../generated/version";
import { chatOverlayRoutes } from "../server/modules/chat/overlay_server";
import type { ChatSnapshot } from "../server/modules/chat/types";

const BunWebSocket = WebSocket as unknown as new (
    url: string,
    options?: Bun.WebSocketOptions,
) => Bun.WebSocket;

/** Frames arrive as soon as the server sends them, which can be before a
 * matching `nextFrame` call starts listening. Buffer every frame per socket
 * so late listeners can still match what already arrived. */
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
            // ignore non-JSON frames
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
    if (queue) {
        for (let i = 0; i < queue.length; i++) {
            if (matches(queue[i]))
                return Promise.resolve(queue.splice(i, 1)[0]);
        }
    }
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            socket.removeEventListener("message", onMessage);
            reject(new Error("Timed out waiting for a WebSocket frame"));
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

/** Poll `predicate` until true (or the timeout), for async server-side
 * side effects (e.g. a WebSocket close handler releasing channels). */
async function waitFor(
    predicate: () => boolean,
    timeoutMs = 2_000,
): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs)
            throw new Error("waitFor timed out");
        await new Promise((r) => setTimeout(r, 10));
    }
}

function fixture() {
    const snapshot: ChatSnapshot = {
        "twitch:alice": {
            connected: true,
            messages: [{ id: "1", username: "Viewer", text: "Hello", ts: 1 }],
        },
        "youtube:creator": { connected: false, messages: [] },
        "twitch:bob": {
            connected: true,
            messages: [{ id: "private", text: "Another widget" }],
        },
    };
    // The scene-token endpoint's model: a project token + scene id map to the
    // chat channels that scene renders. Everything else is refused.
    const sceneChannels: Record<string, string[]> = {
        "scene-token": ["twitch:alice", "youtube:creator"],
    };
    const acquires: string[][] = [];
    const releases: string[][] = [];
    // `dashboardById`/`htmlResponse` are part of the shared ControlRouteContext
    // type but unused by the scene-token routes; stubs satisfy the contract.
    const app = chatOverlayRoutes({
        dashboardById: () => undefined,
        htmlResponse: (page: string) => new Response(`<html>${page}</html>`),
        widgetHubSnapshot: () => ({ chat: snapshot }),
        widgetHubTopic: () => "widgets:hub",
        acquireChatChannels: (specs) => {
            acquires.push(specs);
        },
        releaseChatChannels: (specs) => {
            releases.push(specs);
        },
        overlayChatOverlaySpecs: (token, overlayId) =>
            token === "scene-token" && overlayId === "mystream"
                ? sceneChannels["scene-token"]
                : null,
    });
    const get = (path: string) =>
        app.handle(new Request(`http://localhost${path}`));
    return { app, snapshot, get, acquires, releases };
}

describe("scene-token chat overlay (self-contained element)", () => {
    const snapshotFrame = (frame: Record<string, unknown>) =>
        frame.type === "event" && frame.event === "chat.overlay.snapshot";

    test("narrows the snapshot to the scene's channels (no other widgets, no token)", async () => {
        const { get, snapshot } = fixture();
        const res = await get("/api/overlay/chat/mystream?token=scene-token");
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            chat: Record<string, unknown>;
            version: string;
        };
        expect(body.version).toBe(APP_VERSION);
        // only the scene's two channels — `twitch:bob` (the other widget) is
        // excluded, and the token never leaves the server.
        expect(Object.keys(body.chat).sort()).toEqual([
            "twitch:alice",
            "youtube:creator",
        ]);
        expect(body.chat["twitch:alice"]).toEqual(snapshot["twitch:alice"]);
        expect(JSON.stringify(body)).not.toContain("scene-token");
    });

    test("refuses a bad token, unknown scene, or missing token", async () => {
        const { get } = fixture();
        expect(
            (await get("/api/overlay/chat/mystream?token=****")).status,
        ).toBe(401);
        expect(
            (await get("/api/overlay/chat/other?token=scene-token")).status,
        ).toBe(401);
        expect((await get("/api/overlay/chat/mystream")).status).toBe(401);
    });

    test("answers a plain GET on the scene ws route with 426 (valid) / 401 (bad)", async () => {
        const { get } = fixture();
        expect(
            (await get("/api/overlay/chat/mystream/ws?token=scene-token"))
                .status,
        ).toBe(426);
        expect((await get("/api/overlay/chat/mystream/ws")).status).toBe(401);
        expect(
            (await get("/api/overlay/chat/mystream/ws?token=****")).status,
        ).toBe(401);
    });

    test("streams the narrowed snapshot, acquires the channels, releases on close", async () => {
        const fix = fixture();
        fix.app.listen({ port: 0 });
        const origin = `ws://127.0.0.1:${fix.app.server?.port ?? 0}`;
        const socket = await connectSocket(
            `${origin}/api/overlay/chat/mystream/ws?token=scene-token`,
        );
        try {
            const snap = await nextFrame(socket, snapshotFrame);
            const chat = (snap.data as { chat: Record<string, unknown> }).chat;
            expect(Object.keys(chat).sort()).toEqual([
                "twitch:alice",
                "youtube:creator",
            ]);
            expect(fix.acquires).toEqual([
                ["twitch:alice", "youtube:creator"],
            ]);
            socket.close();
            await waitFor(() => fix.releases.length === 1);
            expect(fix.releases).toEqual([
                ["twitch:alice", "youtube:creator"],
            ]);
        } finally {
            socket.close();
            fix.app.stop();
        }
    });
});
