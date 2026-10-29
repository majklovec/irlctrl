import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const projectRoot = join(import.meta.dir, "..");
const username = "refactor-test";
const password = "test-password-123";
const deviceId = "device-refactor-test";
const BunWebSocket = WebSocket as unknown as new (
    url: string,
    options?: Bun.WebSocketOptions,
) => Bun.WebSocket;

let tempDir: string;
let databasePath: string;
let port: number;
let serverProcess: ReturnType<typeof Bun.spawn> | undefined;
let baseUrl: string;

async function availablePort(): Promise<number> {
    const listener = createServer();
    await new Promise<void>((resolve, reject) => {
        listener.once("error", reject);
        listener.listen(0, "127.0.0.1", () => resolve());
    });
    const address = listener.address();
    if (!address || typeof address === "string")
        throw new Error("Unable to allocate a local TCP port");
    await new Promise<void>((resolve, reject) => {
        listener.close((error) => (error ? reject(error) : resolve()));
    });
    return address.port;
}

async function startServer(): Promise<void> {
    serverProcess = Bun.spawn(
        [
            process.execPath,
            "backend/server/server.ts",
            "--host",
            "127.0.0.1",
            "--port",
            String(port),
            "--db",
            databasePath,
        ],
        {
            cwd: projectRoot,
            stdout: "ignore",
            stderr: "ignore",
        },
    );
    baseUrl = `http://127.0.0.1:${port}`;

    const deadline = Date.now() + 30_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`${baseUrl}/healthz`, {
                signal: AbortSignal.timeout(500),
            });
            if (response.ok) return;
            lastError = new Error(`Health check returned ${response.status}`);
        } catch (error) {
            lastError = error;
        }
        await Bun.sleep(50);
    }

    await stopServer();
    throw new Error(
        `Control server did not start: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
}

async function stopServer(): Promise<void> {
    const child = serverProcess;
    serverProcess = undefined;
    if (!child) return;
    child.kill();
    await child.exited;
}

async function login(): Promise<string> {
    const response = await fetch(`${baseUrl}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
    });
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) throw new Error("Login did not set a session cookie");
    return cookie;
}

async function connectSocket(
    url: string,
    headers: Record<string, string>,
): Promise<Bun.WebSocket> {
    const socket = new BunWebSocket(url, { headers });
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
): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            socket.removeEventListener("message", onMessage);
            reject(new Error("Timed out waiting for a WebSocket frame"));
        }, 5_000);
        const onMessage = (event: Event) => {
            if (!("data" in event) || typeof event.data !== "string") return;
            const frame = JSON.parse(event.data) as Record<string, unknown>;
            if (!matches(frame)) return;
            clearTimeout(timeout);
            socket.removeEventListener("message", onMessage);
            resolve(frame);
        };
        socket.addEventListener("message", onMessage);
    });
}

describe("control server HTTP contracts", () => {
    beforeAll(async () => {
        tempDir = await mkdtemp(join(tmpdir(), "irlctrl-control-server-"));
        databasePath = join(tempDir, "users.sqlite");
        port = await availablePort();
        await startServer();
    });

    afterAll(async () => {
        await stopServer();
        if (tempDir) await rm(tempDir, { recursive: true, force: true });
    });

    test("authenticates users, forwards device requests, and persists dashboards", async () => {
        const health = await fetch(`${baseUrl}/healthz`);
        expect(health.status).toBe(200);
        expect(await health.text()).toBe("ok\n");

        // PWA: the service worker answers at the origin root (scope "/"), the
        // icons at their fixed manifest paths, and the manifest rides with the
        // bundled pages — all without a session.
        const serviceWorker = await fetch(`${baseUrl}/sw.js`);
        expect(serviceWorker.status).toBe(200);
        expect(serviceWorker.headers.get("content-type")).toContain(
            "application/javascript",
        );
        expect(await serviceWorker.text()).toContain(
            'addEventListener("fetch"',
        );
        const icon = await fetch(`${baseUrl}/icons/icon-192.png`);
        expect(icon.status).toBe(200);
        expect(icon.headers.get("content-type")).toBe("image/png");
        expect((await fetch(`${baseUrl}/icons/missing.png`)).status).toBe(404);
        const registerPage = await (await fetch(`${baseUrl}/register`)).text();
        const manifestPath = registerPage.match(
            /href="(\/assets\/manifest-[^"]+\.webmanifest)"/,
        )?.[1];
        expect(manifestPath).toBeDefined();
        const manifest = await fetch(`${baseUrl}${manifestPath}`);
        expect(manifest.status).toBe(200);
        expect(manifest.headers.get("content-type")).toContain(
            "application/manifest+json",
        );
        expect(await manifest.json()).toMatchObject({
            name: "IRLCTRL",
            scope: "/",
            start_url: "/",
            display: "standalone",
        });
        expect(registerPage).toContain('serviceWorker.register("/sw.js")');

        const privateList = await fetch(`${baseUrl}/api/devices`);
        expect(privateList.status).toBe(401);

        const registration = await fetch(`${baseUrl}/api/register`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ username, password }),
        });
        expect(registration.status).toBe(201);
        expect(await registration.json()).toMatchObject({
            ok: true,
            user: username,
            admin: true,
        });

        const cookie = await login();
        const whoami = await fetch(`${baseUrl}/api/whoami`, {
            headers: { cookie },
        });
        expect(await whoami.json()).toMatchObject({
            ok: true,
            user: username,
        });
        const deviceList = await fetch(`${baseUrl}/api/devices`, {
            headers: { cookie },
        });
        expect(await deviceList.json()).toEqual([]);

        const dashboardSocket = await connectSocket(
            `${baseUrl.replace(/^http/, "ws")}/dashboards/ws`,
            { cookie },
        );
        try {
            const widgets = await nextFrame(
                dashboardSocket,
                (frame) => frame.event === "widget.snapshot",
            );
            const dashboardSnapshot = await nextFrame(
                dashboardSocket,
                (frame) => frame.event === "dashboards.snapshot",
            );
            const devicesSnapshot = await nextFrame(
                dashboardSocket,
                (frame) => frame.event === "devices.snapshot",
            );
            expect(widgets.type).toBe("event");
            expect(dashboardSnapshot.type).toBe("event");
            expect(devicesSnapshot).toMatchObject({
                type: "event",
                data: [],
            });
        } finally {
            dashboardSocket.close();
        }

        const tokenResponse = await fetch(`${baseUrl}/api/profile/tokens`, {
            method: "POST",
            headers: { cookie },
        });
        const tokenResult = (await tokenResponse.json()) as {
            token: { token: string };
        };
        const device = await connectSocket(`${baseUrl}/device`, {
            authorization: `Bearer ${tokenResult.token.token}`,
            "x-device-id": deviceId,
            "x-device-role": "relay",
        });
        const viewer = await connectSocket(
            `${baseUrl.replace(/^http/, "ws")}/d/${deviceId}/ws`,
            { cookie },
        );
        try {
            const pipelineEditor = await fetch(
                `${baseUrl}/d/${deviceId}/pipelines/new/`,
                { headers: { cookie } },
            );
            expect(pipelineEditor.status).toBe(200);
            expect(pipelineEditor.headers.get("content-type")).toContain(
                "text/html",
            );

            const forwardedFrame = nextFrame(
                device,
                (frame) => frame.method === "probe",
            );
            const viewerResponse = nextFrame(
                viewer,
                (frame) => frame.type === "response" && frame.id === "viewer-1",
            );
            viewer.send(
                JSON.stringify({
                    id: "viewer-1",
                    method: "probe",
                    params: { value: 7 },
                }),
            );
            const request = await forwardedFrame;
            expect(request).toMatchObject({
                method: "probe",
                params: { value: 7 },
            });
            device.send(
                JSON.stringify({
                    type: "response",
                    id: request.id,
                    method: "probe",
                    ok: true,
                    result: { value: 7 },
                }),
            );
            expect(await viewerResponse).toMatchObject({
                id: "viewer-1",
                method: "probe",
                ok: true,
                result: { value: 7 },
            });
        } finally {
            device.close();
            viewer.close();
        }

        const invalidDashboard = await fetch(`${baseUrl}/api/dashboards`, {
            method: "POST",
            headers: {
                cookie,
                "content-type": "application/json",
            },
            body: JSON.stringify({
                name: "Invalid",
                widgets: [{ type: "unknown" }],
            }),
        });
        expect(invalidDashboard.status).toBe(200);
        expect(await invalidDashboard.json()).toMatchObject({
            ok: false,
            code: 400,
        });

        const createDashboard = await fetch(`${baseUrl}/api/dashboards`, {
            method: "POST",
            headers: {
                cookie,
                "content-type": "application/json",
            },
            body: JSON.stringify({
                name: "Operations",
                color: "#ff0000",
                widgets: [],
            }),
        });
        expect(createDashboard.status).toBe(201);
        const created = (await createDashboard.json()) as {
            dashboard: {
                id: string;
                version: number;
                columns: number;
                color?: string;
            };
        };
        expect(created.dashboard).toMatchObject({
            version: 1,
            columns: 12,
            color: "#ff0000",
        });

        const invalidColor = await fetch(
            `${baseUrl}/api/dashboards/${created.dashboard.id}`,
            {
                method: "PUT",
                headers: {
                    cookie,
                    "content-type": "application/json",
                },
                body: JSON.stringify({
                    name: "Operations",
                    color: "not-a-color",
                    widgets: [],
                    version: created.dashboard.version,
                }),
            },
        );
        expect(invalidColor.status).toBe(200);
        expect(await invalidColor.json()).toMatchObject({ ok: false, code: 400 });

        const recolorDashboard = await fetch(
            `${baseUrl}/api/dashboards/${created.dashboard.id}`,
            {
                method: "PUT",
                headers: {
                    cookie,
                    "content-type": "application/json",
                },
                body: JSON.stringify({
                    name: "Operations",
                    color: "#00ff00",
                    widgets: [],
                    version: created.dashboard.version,
                }),
            },
        );
        expect(recolorDashboard.status).toBe(200);
        expect(await recolorDashboard.json()).toMatchObject({
            ok: true,
            dashboard: { color: "#00ff00", version: 2 },
        });

        await stopServer();
        await startServer();

        const restoredCookie = await login();
        const dashboards = await fetch(`${baseUrl}/api/dashboards`, {
            headers: { cookie: restoredCookie },
        });
        expect(dashboards.status).toBe(200);
        expect(await dashboards.json()).toMatchObject({
            ok: true,
            dashboards: [
                {
                    id: created.dashboard.id,
                    name: "Operations",
                    color: "#00ff00",
                    version: 2,
                    widgets: [],
                },
            ],
        });

        // A PUT without a color clears it
        const clearColor = await fetch(
            `${baseUrl}/api/dashboards/${created.dashboard.id}`,
            {
                method: "PUT",
                headers: {
                    cookie: restoredCookie,
                    "content-type": "application/json",
                },
                body: JSON.stringify({
                    name: "Operations",
                    widgets: [],
                    version: 2,
                }),
            },
        );
        expect(clearColor.status).toBe(200);
        expect(await clearColor.json()).toMatchObject({
            ok: true,
            dashboard: { version: 3 },
        });
        expect(
            ((await (
                await fetch(
                    `${baseUrl}/api/dashboards/${created.dashboard.id}`,
                    { headers: { cookie: restoredCookie } },
                )
            ).json()) as { dashboard: { color?: string } })
                .dashboard.color,
        ).toBeUndefined();
    }, 60_000);
});
