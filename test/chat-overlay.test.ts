import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { chatOverlayRoutes } from "../modules/chat/overlay-server";
import type { ChatSnapshot } from "../modules/chat/types";
import type { ServerDashboard } from "../shared/types";

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
                x: 0, y: 0, w: 3, h: 8,
                visible: true,
                config,
            },
            {
                id: "other",
                deviceId: "",
                type: "chat",
                name: "Other",
                x: 3, y: 0, w: 3, h: 8,
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
        dashboardById: (id) => exists && id === dashboard.id ? dashboard : undefined,
        htmlResponse: (page) => new Response(`<html>${page}</html>`),
        widgetHubSnapshot: () => ({ chat: snapshot }),
    });
    const get = (path: string, token?: string) => app.handle(new Request(
        `http://localhost${path}`,
        token === undefined ? undefined : { headers: { authorization: `Bearer ${token}` } },
    ));
    return { app, config, dashboard, snapshot, get, remove: () => { exists = false; } };
}

describe("token-authenticated chat overlay", () => {
    test("does not cache tokenized overlay URLs in the service worker", async () => {
        type Navigation = {
            request: { url: string; method: string; mode: string };
            respondWith(): void;
        };
        let onFetch: ((event: Navigation) => void) | undefined;
        runInNewContext(await Bun.file(new URL("../frontend/pwa/sw.js", import.meta.url)).text(), {
            self: {
                location: { origin: "http://localhost" },
                addEventListener(name: string, handler: (event: Navigation) => void) {
                    if (name === "fetch") onFetch = handler;
                },
            },
            URL,
        });
        if (!onFetch) throw new Error("Missing service worker fetch listener");
        let intercepted = false;
        onFetch({
            request: {
                url: "http://localhost/chat/dashboard/chat?token=secret",
                method: "GET",
                mode: "navigate",
            },
            respondWith() { intercepted = true; },
        });
        expect(intercepted).toBe(false);
    });

    test("serves plain chat without a session and prevents caching and referrer leaks", async () => {
        const { get } = fixture();
        const response = await get(`/chat/dashboard/chat?token=${encodeURIComponent("secret +/&?")}`);
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
            expect((await get(`${prefix}/dashboard/chat?token=`)).status).toBe(401);
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
        });
    });

    test("revokes access after token rotation, removal, widget removal or dashboard removal", async () => {
        const { get, config, dashboard, remove } = fixture();
        config.token = "rotated";
        expect((await get("/api/chat/dashboard/chat", "secret +/&?")).status).toBe(401);
        expect((await get("/api/chat/dashboard/chat", "rotated")).status).toBe(200);
        delete config.token;
        expect((await get("/api/chat/dashboard/chat", "rotated")).status).toBe(401);
        config.token = "rotated";
        dashboard.widgets.splice(0, 1);
        expect((await get("/api/chat/dashboard/chat", "rotated")).status).toBe(401);
        remove();
        expect((await get("/api/chat/dashboard/other", "other-secret")).status).toBe(401);
    });

    test("does not grant access to non-chat widgets", async () => {
        const { get, dashboard } = fixture();
        dashboard.widgets[0].type = "stats";
        expect((await get("/api/chat/dashboard/chat", "secret +/&?")).status).toBe(401);
    });

    test("requires a Bearer scheme when an authorization header is provided", async () => {
        const { app } = fixture();
        for (const authorization of ["secret +/&?", "Basic secret +/&?"]) {
            const response = await app.handle(new Request("http://localhost/api/chat/dashboard/chat", {
                headers: { authorization },
            }));
            expect(response.status).toBe(401);
        }
    });

    test("returns fresh messages and configuration on each refresh", async () => {
        const { get, config, snapshot } = fixture();
        snapshot["twitch:alice"].messages.unshift({ id: "2", text: "New message" });
        config.history = "2";
        config.youtube = "";
        const response = await get("/api/chat/dashboard/chat", "secret +/&?");
        expect(await response.json()).toMatchObject({
            widget: { config: { history: "2" } },
            chat: { "twitch:alice": snapshot["twitch:alice"] },
        });
    });
});
