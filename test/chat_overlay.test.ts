import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { APP_VERSION } from "../generated/version";
import { chatOverlayRoutes } from "../server/modules/chat/overlay_server";
import type { ChatSnapshot } from "../server/modules/chat/types";
import type { ServerDashboard } from "../shared/contracts/wire";

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

/** Connect and expect the server to refuse the socket with 1008 (no frames).
 * Bun reports a close that races the client handshake as 1002, while a
 * clean post-open close reports the server's 1008 — accept both. */
async function connectRefused(url: string): Promise<void> {
    const socket = new BunWebSocket(url);
    let receivedMessage = false;
    socket.addEventListener("message", () => {
        receivedMessage = true;
    });
    const { code } = await new Promise<CloseEvent>((resolve, reject) => {
        const timeout = setTimeout(() => {
            socket.close();
            reject(new Error(`refusal close timed out: ${url}`));
        }, 5_000);
        socket.addEventListener(
            "close",
            (event: CloseEvent) => {
                clearTimeout(timeout);
                resolve(event);
            },
            { once: true },
        );
    });
    expect([1008, 1002]).toContain(code);
    expect(receivedMessage).toBe(false);
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

function fixture() {
    const config: Record<string, string> = {
        twitch: " Alice ",
        youtube: "Creator",
        token: "secret +/&?",
        order: "bottom",
        history: "10",
        bannedMessages: "hide",
        timestamps: "on",
    };
    const dashboard: ServerDashboard = {
        id: "dashboard",
        owner: "alice",
        name: "Private dashboard",
        version: 1,
        columns: 12,
        widgets: [
            {
                id: "chat",
                deviceId: "",
                type: "chat",
                name: "Chat",
                x: 0,
                y: 0,
                w: 3,
                h: 8,
                visible: true,
                config,
            },
            {
                id: "other",
                deviceId: "",
                type: "chat",
                name: "Other",
                x: 3,
                y: 0,
                w: 3,
                h: 8,
                visible: true,
                config: { twitch: "bob", token: "other-secret" },
            },
        ],
    };
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
    let exists = true;
    const app = chatOverlayRoutes({
        dashboardById: (id) =>
            exists && id === dashboard.id ? dashboard : undefined,
        htmlResponse: (page) => new Response(`<html>${page}</html>`),
        widgetHubSnapshot: () => ({ chat: snapshot }),
        widgetHubTopic: () => "widgets:hub",
    });
    const get = (path: string, token?: string) =>
        app.handle(
            new Request(
                `http://localhost${path}`,
                token === undefined
                    ? undefined
                    : { headers: { authorization: `Bearer ${token}` } },
            ),
        );
    return {
        app,
        config,
        dashboard,
        snapshot,
        get,
        remove: () => {
            exists = false;
        },
    };
}

describe("token-authenticated chat overlay", () => {
    test("does not cache tokenized overlay URLs in the service worker", async () => {
        type Navigation = {
            request: { url: string; method: string; mode: string };
            respondWith(): void;
        };
        let onFetch: ((event: Navigation) => void) | undefined;
        runInNewContext(
            await Bun.file(
                new URL("../shared/assets/pwa/sw.js", import.meta.url),
            ).text(),
            {
                self: {
                    location: { origin: "http://localhost" },
                    addEventListener(
                        name: string,
                        handler: (event: Navigation) => void,
                    ) {
                        if (name === "fetch") onFetch = handler;
                    },
                },
                URL,
            },
        );
        if (!onFetch) throw new Error("Missing service worker fetch listener");
        let intercepted = false;
        onFetch({
            request: {
                url: "http://localhost/chat/dashboard/chat?token=secret",
                method: "GET",
                mode: "navigate",
            },
            respondWith() {
                intercepted = true;
            },
        });
        expect(intercepted).toBe(false);
    });

    test("serves plain chat without a session and prevents caching and referrer leaks", async () => {
        const { get } = fixture();
        const response = await get(
            `/chat/dashboard/chat?token=${encodeURIComponent("secret +/&?")}`,
        );
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("chatoverlay");
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    });

    test("rejects absent, invalid, foreign and disabled tokens on both routes", async () => {
        const { config, get } = fixture();
        for (const prefix of ["/chat", "/api/chat"]) {
            for (const suffix of [
                "/dashboard/chat",
                "/dashboard/chat?token=wrong",
                "/dashboard/chat?token=other-secret",
                "/dashboard/missing?token=other-secret",
                "/missing/other?token=other-secret",
            ]) {
                expect((await get(prefix + suffix)).status).toBe(401);
            }
            config.token = "";
            expect((await get(`${prefix}/dashboard/chat?token=`)).status).toBe(
                401,
            );
            config.token = "secret +/&?";
        }
    });

    test("limits snapshots to configured channels and never returns the token or dashboard", async () => {
        const { get, snapshot, config: widgetConfig } = fixture();
        const response = await get("/api/chat/dashboard/chat", "secret +/&?");
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        const { token, ...config } = widgetConfig;
        expect(await response.json()).toEqual({
            widget: { id: "chat", config },
            chat: {
                "twitch:alice": snapshot["twitch:alice"],
                "youtube:creator": snapshot["youtube:creator"],
            },
            version: APP_VERSION,
        });
    });

    test("revokes access after token rotation, removal, widget removal or dashboard removal", async () => {
        const { get, config, dashboard, remove } = fixture();
        config.token = "rotated";
        expect(
            (await get("/api/chat/dashboard/chat", "secret +/&?")).status,
        ).toBe(401);
        expect((await get("/api/chat/dashboard/chat", "rotated")).status).toBe(
            200,
        );
        delete config.token;
        expect((await get("/api/chat/dashboard/chat", "rotated")).status).toBe(
            401,
        );
        config.token = "rotated";
        dashboard.widgets.splice(0, 1);
        expect((await get("/api/chat/dashboard/chat", "rotated")).status).toBe(
            401,
        );
        remove();
        expect(
            (await get("/api/chat/dashboard/other", "other-secret")).status,
        ).toBe(401);
    });

    test("does not grant access to non-chat widgets", async () => {
        const { get, dashboard } = fixture();
        dashboard.widgets[0].type = "stats";
        expect(
            (await get("/api/chat/dashboard/chat", "secret +/&?")).status,
        ).toBe(401);
    });

    test("requires a Bearer scheme when an authorization header is provided", async () => {
        const { app } = fixture();
        for (const authorization of ["secret +/&?", "Basic secret +/&?"]) {
            const response = await app.handle(
                new Request("http://localhost/api/chat/dashboard/chat", {
                    headers: { authorization },
                }),
            );
            expect(response.status).toBe(401);
        }
    });

    test("returns fresh messages and configuration on each refresh", async () => {
        const { get, config, snapshot } = fixture();
        snapshot["twitch:alice"].messages.unshift({
            id: "2",
            text: "New message",
        });
        config.history = "2";
        config.youtube = "";
        const response = await get("/api/chat/dashboard/chat", "secret +/&?");
        expect(await response.json()).toMatchObject({
            widget: { config: { history: "2" } },
            chat: { "twitch:alice": snapshot["twitch:alice"] },
        });
    });
});

describe("chat overlay websocket", () => {
    function listenFixture() {
        const fix = fixture();
        fix.app.listen({ port: 0 });
        const origin = `ws://127.0.0.1:${fix.app.server?.port ?? 0}`;
        return { ...fix, origin };
    }

    const snapshotFrame = (frame: Record<string, unknown>) =>
        frame.type === "event" && frame.event === "chat.overlay.snapshot";

    test("answers a plain GET on the ws route with 426 (valid token) or 401 (bad token)", async () => {
        const { get } = fixture();
        const valid = encodeURIComponent("secret +/&?");
        expect(
            (await get(`/api/chat/dashboard/chat/ws?token=${valid}`)).status,
        ).toBe(426);
        expect((await get("/api/chat/dashboard/chat/ws")).status).toBe(401);
        expect(
            (await get(`/api/chat/dashboard/chat/ws?token=wrong`)).status,
        ).toBe(401);
        const serverResponse = await get(
            `/api/chat/dashboard/chat/ws?token=${valid}`,
        );
        expect(serverResponse.headers.get("upgrade")).toBe("websocket");
    });

    test("sends the snapshot and streams the hub frames, never the token", async () => {
        const { app, snapshot, origin, remove } = await listenFixture();
        const socket = await connectSocket(
            `${origin}/api/chat/dashboard/chat/ws?token=${encodeURIComponent("secret +/&?")}`,
        );
        try {
            const snap = await nextFrame(socket, snapshotFrame);
            expect(snap.data).toEqual({
                widget: {
                    id: "chat",
                    config: {
                        twitch: " Alice ",
                        youtube: "Creator",
                        order: "bottom",
                        history: "10",
                        bannedMessages: "hide",
                        timestamps: "on",
                    },
                },
                chat: {
                    "twitch:alice": snapshot["twitch:alice"],
                    "youtube:creator": snapshot["youtube:creator"],
                },
                version: APP_VERSION,
            });

            const publish = (
                event: string,
                channel: string,
                extra: Record<string, unknown> = {},
            ) =>
                app.server?.publish(
                    "widgets:hub",
                    JSON.stringify({
                        type: "event",
                        event,
                        data: {
                            channel,
                            text: `hello from ${channel}`,
                            ...extra,
                        },
                    }),
                );

            // a frame for each configured channel is forwarded verbatim
            publish("twitch.chat", "alice");
            const alice = await nextFrame(
                socket,
                (f) =>
                    f.event === "twitch.chat" &&
                    (f.data as { channel?: string }).channel === "alice",
            );
            expect(alice).toEqual({
                type: "event",
                event: "twitch.chat",
                data: { channel: "alice", text: "hello from alice" },
            });

            publish("youtube.chat", "creator", { id: "y1" });
            expect(
                await nextFrame(
                    socket,
                    (f) =>
                        f.event === "youtube.chat" &&
                        (f.data as { channel?: string }).channel === "creator",
                ),
            ).toMatchObject({ event: "youtube.chat" });

            // like the dashboard websocket, the socket subscribes to the
            // whole hub topic — every frame is delivered verbatim and the
            // overlay client narrows the stream to the widget's channels
            const before = frameQueues.get(socket)?.length ?? 0;
            publish("twitch.chat", "bob");
            publish("kick.chat", "nobody");
            publish("widget.snapshot", "irrelevant");
            publish("twitch.reconnect", "alice");
            await Bun.sleep(200);
            const queued = frameQueues.get(socket) ?? [];
            expect(queued).toHaveLength(before + 4);
            expect(JSON.stringify(queued)).not.toContain("secret +/&?");
        } finally {
            socket.close();
            remove();
            app.server?.stop(true);
        }
    });

    test("refuses sockets with a missing or invalid token (1008, no frames)", async () => {
        const { origin, remove } = await listenFixture();
        await connectRefused(`${origin}/api/chat/dashboard/chat/ws`);
        await connectRefused(
            `${origin}/api/chat/dashboard/chat/ws?token=wrong`,
        );
        await connectRefused(
            `${origin}/api/chat/dashboard/chat/ws?token=${encodeURIComponent("other-secret")}`,
        );
        remove();
    });

    test("refuses the socket after the widget is revoked", async () => {
        const { origin, remove } = await listenFixture();
        remove();
        await connectRefused(
            `${origin}/api/chat/dashboard/chat/ws?token=${encodeURIComponent("secret +/&?")}`,
        );
    });
});

// The standalone page script (`modules/chat/overlay.tsx`) is the real artifact
// for auto-reload: bundle it the way the server does, run it against a
// happy-dom window + a fake WebSocket, and feed it snapshot frames the way the
// server sends them (the websocket tests above prove the server stamps the
// snapshot with its build version).
describe("chat overlay auto-reload (headless DOM)", () => {
    let pageBundleText = "";
    let loadCount = 0;
    const pageBundleFiles: URL[] = [];
    let reloadCalls = 0;
    let swUpdates = 0;
    const fakeSockets: {
        url: string;
        onopen: (() => void) | undefined;
        onmessage: ((e: { data: unknown }) => void) | undefined;
        onclose: (() => void) | undefined;
    }[] = [];

    beforeAll(async () => {
        const { Window } = await import("happy-dom");
        const win = new Window();
        const g = globalThis as Record<string, unknown>;
        g.window = win;
        g.document = win.document;
        g.navigator = {
            serviceWorker: {
                getRegistration: () =>
                    Promise.resolve({ update: () => (swUpdates += 1) }),
            },
        };
        // Bun provides no `location`; the page script dereferences bare
        // `location`, so it must exist as an own global property.
        Object.defineProperty(g, "location", {
            value: {
                origin: "http://127.0.0.1:1",
                protocol: "http:",
                pathname: "/chat/dashboard/chat",
                search: "?token=secret",
                reload: () => (reloadCalls += 1),
            },
            configurable: true,
            writable: true,
            enumerable: true,
        });
        g.requestAnimationFrame = win.requestAnimationFrame;
        g.cancelAnimationFrame = win.cancelAnimationFrame;
        g.WebSocket = class {
            url: string;
            onopen: (() => void) | undefined;
            onmessage: ((e: { data: unknown }) => void) | undefined;
            onclose: (() => void) | undefined;
            constructor(url: string) {
                this.url = url;
                fakeSockets.push(this);
            }
        };
        win.document.body.innerHTML = '<div id="app"></div>';

        const i18nStub =
            "export const currentLanguage = () => 'en'; export const t = (k) => k; export const i18nReady = Promise.resolve();";
        const compStub = "export const Badge = {};";
        const result = await Bun.build({
            entrypoints: [
                new URL("../server/modules/chat/overlay.tsx", import.meta.url).pathname,
            ],
            target: "browser",
            // esm: the page script uses a top-level `await i18nReady`;
            // mithril stays inlined so the bundle needs no bare imports.
            format: "esm",
            loader: { ".css": "text" },
            plugins: [
                {
                    name: "chat-overlay-reload-shell",
                    setup(b: { onLoad(o: { filter: RegExp }, cb: () => { contents: string; loader: string }): void }) {
                        b.onLoad({ filter: /shared\/ui\/i18n\.tsx$/ }, () => ({ contents: i18nStub, loader: "js" }));
                        b.onLoad({ filter: /shared\/ui\/components\/index\.tsx$/ }, () => ({ contents: compStub, loader: "js" }));
                    },
                },
            ],
        });
        if (!result.success)
            throw new AggregateError(result.logs, "Overlay reload test bundle failed");
        // A temp file so the ESM bundle (with its top-level `await
        // i18nReady`) can be `import`ed; loadPage() uses a fresh file per
        // load because Bun keys its module cache by URL.
        pageBundleText = await result.outputs[0].text();
    });

    afterAll(async () => {
        for (const file of pageBundleFiles)
            await Bun.file(file).delete().catch(() => {});
    });

    /** Import the bundled page script; it mounts the feed and opens its
     * (fake) websocket after `await i18nReady`, settle for a tick. */
    async function loadPage(): Promise<void> {
        reloadCalls = 0;
        swUpdates = 0;
        fakeSockets.length = 0;
        // The page keeps module-level state (e.g. the `reloading` guard);
        // a distinct URL is a distinct module, so the script reruns from
        // scratch each call, as a fresh page load would.
        const file = new URL(
            `../.tmp-chat-overlay-reload-${++loadCount}.js`,
            import.meta.url,
        );
        pageBundleFiles.push(file);
        await Bun.write(file, pageBundleText);
        await import(file.href);
        await Bun.sleep(10);
    }

    function snapshotFrame(version?: string) {
        return {
            type: "event",
            event: "chat.overlay.snapshot",
            data: {
                widget: { id: "chat", config: { twitch: "alice" } },
                chat: { "twitch:alice": { connected: true, messages: [] } },
                ...(version === undefined ? {} : { version }),
            },
        };
    }

    function deliver(frame: unknown): void {
        fakeSockets[fakeSockets.length - 1].onmessage?.({
            data: JSON.stringify(frame),
        });
    }

    test("reloads the page (and updates the service worker) when the snapshot carries a newer version", async () => {
        await loadPage();
        expect(fakeSockets).toHaveLength(1);
        deliver(snapshotFrame("999.0.0"));
        await Bun.sleep(40);
        expect(reloadCalls).toBe(1);
        expect(swUpdates).toBe(1);
    });

    test("keeps running when the snapshot carries the page's own version", async () => {
        await loadPage();
        deliver(snapshotFrame(APP_VERSION));
        await Bun.sleep(40);
        expect(reloadCalls).toBe(0);
        expect(swUpdates).toBe(0);
    });

    test("ignores a snapshot without a version (a server older than the page)", async () => {
        await loadPage();
        deliver(snapshotFrame());
        await Bun.sleep(40);
        expect(reloadCalls).toBe(0);
        expect(swUpdates).toBe(0);
    });

    test("reloads exactly once even if more foreign snapshots arrive", async () => {
        await loadPage();
        deliver(snapshotFrame("999.0.0"));
        deliver(snapshotFrame("999.0.1"));
        await Bun.sleep(40);
        expect(reloadCalls).toBe(1);
    });
});
