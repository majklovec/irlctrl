import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDeviceApiApp } from "../backend/client/api";

const BunWebSocket = WebSocket as unknown as new (
    url: string,
    options?: Bun.WebSocketOptions,
) => WebSocket;

let app: Awaited<ReturnType<typeof createDeviceApiApp>>;
let baseUrl: string;

function receiveResponse(
    socket: WebSocket,
    id: string,
): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(
            () => reject(new Error("Timed out waiting for device RPC response")),
            5_000,
        );
        const onMessage = (message: MessageEvent) => {
            if (typeof message.data !== "string") return;
            const frame = JSON.parse(message.data) as Record<string, unknown>;
            if (frame.id !== id) return;
            clearTimeout(timeout);
            socket.removeEventListener("message", onMessage);
            resolve(frame);
        };
        socket.addEventListener("message", onMessage);
    });
}

describe("device API Elysia plugins", () => {
    beforeAll(async () => {
        app = (await createDeviceApiApp()).listen({
            hostname: "127.0.0.1",
            port: 0,
        });
        const port = app.server?.port;
        if (port === undefined) throw new Error("Device API failed to start");
        baseUrl = `http://127.0.0.1:${port}`;
    });

    afterAll(async () => {
        await app.stop(true);
    });

    test("preserves page redirects and serves the encoder pipeline editor", async () => {
        const redirect = await fetch(`${baseUrl}/settings`, {
            redirect: "manual",
        });
        expect(redirect.status).toBe(308);
        expect(redirect.headers.get("location")).toBe("/settings/");

        const editor = await fetch(`${baseUrl}/pipelines/new/`);
        expect(editor.status).toBe(200);
        expect(editor.headers.get("content-type")).toContain("text/html");
        expect(await editor.text()).toContain("Pipeline");

        const missing = await fetch(`${baseUrl}/missing`);
        expect(missing.status).toBe(404);
        expect(await missing.text()).toBe("Not found\n");
    });

    test("preserves WebSocket RPC response envelopes", async () => {
        const socket = new BunWebSocket(
            `${baseUrl.replace(/^http/, "ws")}/ws`,
        );
        await new Promise<void>((resolve, reject) => {
            socket.addEventListener("open", () => resolve(), { once: true });
            socket.addEventListener(
                "error",
                () => reject(new Error("Device RPC socket failed")),
                { once: true },
            );
        });

        try {
            const response = receiveResponse(socket, "unknown-1");
            socket.send(
                JSON.stringify({
                    id: "unknown-1",
                    method: "not-a-method",
                }),
            );
            expect(await response).toMatchObject({
                id: "unknown-1",
                method: "not-a-method",
                ok: false,
            });
        } finally {
            socket.close();
        }
    });

    test("rejects cross-origin WebSocket upgrades", async () => {
        const socket = new BunWebSocket(
            `${baseUrl.replace(/^http/, "ws")}/ws`,
            { headers: { origin: "http://evil.example" } },
        );
        const opened = await new Promise<boolean>((resolve) => {
            const timeout = setTimeout(() => resolve(false), 3_000);
            socket.addEventListener(
                "open",
                () => {
                    clearTimeout(timeout);
                    resolve(true);
                },
                { once: true },
            );
            socket.addEventListener(
                "error",
                () => {
                    clearTimeout(timeout);
                    resolve(false);
                },
                { once: true },
            );
        });
        socket.close();
        expect(opened).toBe(false);
    });
});
