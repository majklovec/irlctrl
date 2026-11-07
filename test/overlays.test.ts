import { APP_VERSION } from "../generated/version";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const projectRoot = join(import.meta.dir, "..");
const username = "overlay-test";
const password = "test-password-456";

const BunWebSocket = WebSocket as unknown as new (
    url: string,
    options?: Bun.WebSocketOptions,
) => Bun.WebSocket;

let tempDir: string;
let databasePath: string;
let storagePath: string;
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
            "server/main.ts",
            "--host",
            "127.0.0.1",
            "--port",
            String(port),
            "--db",
            databasePath,
            "--storage",
            storagePath,
        ],
        { cwd: projectRoot, stdout: "ignore", stderr: "ignore" },
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
        `Control server did not start: ${
            lastError instanceof Error ? lastError.message : String(lastError)
        }`,
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
    const registration = await fetch(`${baseUrl}/api/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
    });
    // 201 on first use; a reused user name 403s — the login below is what
    // matters, so both are fine
    expect([201, 403]).toContain(registration.status);
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

/**
 * Frames arrive as soon as the server publishes them, which can be before a
 * matching `nextFrame` call starts listening. Buffer every frame per socket
 * so late listeners can still match what already arrived.
 */
const frameQueues = new WeakMap<Bun.WebSocket, Record<string, unknown>[]>();

async function connectSocket(
    url: string,
    headers: Record<string, string> = {},
): Promise<Bun.WebSocket> {
    const socket = new BunWebSocket(url, { headers });
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

/** Connect and expect the server to refuse the socket (no snapshot).
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
    // replay frames that already arrived while no listener was attached
    const queue = frameQueues.get(socket);
    if (queue) {
        for (let i = 0; i < queue.length; i++) {
            if (matches(queue[i])) return Promise.resolve(queue.splice(i, 1)[0]);
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

describe("overlays (OBS overlay editor) HTTP + WS contracts", () => {
    beforeAll(async () => {
        tempDir = await mkdtemp(join(tmpdir(), "irlctrl-overlays-"));
        databasePath = join(tempDir, "users.sqlite");
        storagePath = join(tempDir, "storage");
        port = await availablePort();
        await startServer();
    });

    afterAll(async () => {
        await stopServer();
        if (tempDir) await rm(tempDir, { recursive: true, force: true });
    });

    type OverlayVariable = {
        id: string;
        name: string;
        type: string;
        value: string | number | boolean;
    };
    type OverlayElement = {
        id: string;
        name: string;
        type: string;
        transform: {
            x: number;
            y: number;
            width: number;
            height: number;
            rotation: number;
            opacity: number;
        };
        visible: boolean;
        locked: boolean;
        parentId: string | null;
        bindings: Record<string, unknown>;
        props: Record<string, unknown>;
    };
    type Overlay = {
        schemaVersion: number;
        name: string;
        canvas: { width: number; height: number };
        variables: OverlayVariable[];
        elements: OverlayElement[];
        rev?: number;
    };
    type OverlaySummary = {
        id: string;
        name: string;
        elementCount: number;
        updatedAt: number;
    };

    // the per-overlay frames carry the full overlay object
    const overlayOf = (frame: Record<string, unknown>): Overlay =>
        (frame.data as { overlay: Overlay }).overlay;
    const variablesOf = (frame: Record<string, unknown>): OverlayVariable[] =>
        overlayOf(frame).variables;

    test("serves the editor, the API, live events, and the token-gated runtime", async () => {
        // unauthenticated access: the API is refused, the editor page
        // redirects to the login/registration form
        expect(
            (await fetch(`${baseUrl}/overlays/`, { redirect: "manual" })).status,
        ).toBe(302);
        expect((await fetch(`${baseUrl}/api/overlays`)).status).toBe(401);

        const cookie = await login();

        // every runtime surface authenticates with this user's device token
        // (owner user-token auth), not a per-overlay token
        const tokenRes = await fetch(`${baseUrl}/api/profile/tokens`, {
            method: "POST",
            headers: { cookie },
        });
        expect(tokenRes.status).toBe(200);
        const tokenBody = (await tokenRes.json()) as {
            ok: boolean;
            token: { token: string };
        };
        expect(tokenBody.ok).toBe(true);
        expect(tokenBody.token.token).toMatch(/^[0-9a-f]{48}$/);
        const token = tokenBody.token.token;

        // the list page and the per-overlay editor page are separate,
        // linkable pages
        const page = await fetch(`${baseUrl}/overlays/`, {
            headers: { cookie },
        });
        expect(page.status).toBe(200);
        const listHtml = await page.text();
        expect(listHtml.toLowerCase()).toContain("overlays");
        expect(listHtml).toContain("/assets/overlay_list-");
        const editorPage = await fetch(`${baseUrl}/overlays/edit/some-overlay/`, {
            headers: { cookie },
        });
        expect(editorPage.status).toBe(200);
        expect(await editorPage.text()).toContain("/assets/overlay_update-");
        expect(
            (
                await fetch(`${baseUrl}/overlays/edit/some-overlay/`, {
                    redirect: "manual",
                })
            ).status,
        ).toBe(302);

        // a fresh user has no overlays yet; the list page data is the
        // OverlaySummary array
        const startRes = await fetch(`${baseUrl}/api/overlays`, {
            headers: { cookie },
        });
        const startBody = (await startRes.json()) as {
            ok: boolean;
            overlays: OverlaySummary[];
        };
        expect(startRes.status).toBe(200);
        expect(startBody.ok).toBe(true);
        expect(startBody.overlays).toHaveLength(0);

        // subscribe before mutating, so the live feed sees every event
        const editorSocket = await connectSocket(
            `${baseUrl.replace(/^http/, "ws")}/dashboards/ws`,
            { cookie },
        );

        try {
            // ── overlays ──
            const createRes = await fetch(`${baseUrl}/api/overlays`, {
                method: "POST",
                headers: { cookie, "content-type": "application/json" },
                body: JSON.stringify({ name: "Intro" }),
            });
            expect(createRes.status).toBe(201);
            const createBody = (await createRes.json()) as {
                ok: boolean;
                id: string;
                overlay: Overlay;
            };
            expect(createBody.ok).toBe(true);
            // the id is a UUID and the key of the runtime URL
            expect(createBody.id).toMatch(
                /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
            );
            expect(createBody.overlay.name).toBe("Intro");
            const overlayId = createBody.id;

            // the list frame carries the overlay summaries
            const listEvent = await nextFrame(
                editorSocket,
                (f) =>
                    f.event === "overlays.overlays" &&
                    ((f.data as { overlays?: OverlaySummary[] })?.overlays?.some(
                        (o) => o.id === overlayId,
                    ) ??
                        false),
            );
            const listSummary = (
                (listEvent.data as { overlays: OverlaySummary[] }).overlays
            ).find((o) => o.id === overlayId)!;
            expect(listSummary.name).toBe("Intro");
            expect(listSummary.elementCount).toBe(0);

            const element: OverlayElement = {
                id: crypto.randomUUID(),
                name: "headline",
                type: "text",
                transform: {
                    x: 40,
                    y: 60,
                    width: 500,
                    height: 100,
                    rotation: 0,
                    opacity: 1,
                },
                visible: true,
                locked: false,
                parentId: null,
                bindings: {},
                props: { text: "Live" },
            };
            const upsertRes = await fetch(
                `${baseUrl}/api/overlays/${overlayId}/elements`,
                {
                    method: "PUT",
                    headers: { cookie, "content-type": "application/json" },
                    body: JSON.stringify({ element }),
                },
            );
            expect(upsertRes.status).toBe(200);
            const upsertBody = (await upsertRes.json()) as {
                ok: boolean;
                overlay: Overlay;
            };
            expect(upsertBody.overlay.elements).toHaveLength(1);

            // the editor feed gets the overlay update
            const overlayEvent = await nextFrame(
                editorSocket,
                (f) =>
                    f.event === "overlays.overlay" &&
                    typeof (f.data as { overlay?: { name?: string } })
                        ?.overlay?.name === "string" &&
                    (f.data as { overlay: Overlay }).overlay.elements
                        .length === 1,
            );
            expect(
                (overlayEvent.data as { overlay: Overlay }).overlay.elements
                    .length,
            ).toBe(1);

            // a duplicate clones the overlay's elements under a fresh id and
            // name
            const dupRes = await fetch(
                `${baseUrl}/api/overlays/${overlayId}/duplicate`,
                { method: "POST", headers: { cookie } },
            );
            expect(dupRes.status).toBe(201);
            const dupBody = (await dupRes.json()) as {
                ok: boolean;
                id: string;
                overlay: Overlay;
            };
            expect(dupBody.ok).toBe(true);
            expect(dupBody.id).not.toBe(overlayId);
            expect(dupBody.overlay.name).toBe("Intro (copy)");
            expect(dupBody.overlay.elements).toHaveLength(1);
            expect(
                (dupBody.overlay.elements[0] as OverlayElement).props
                    ?.text,
            ).toBe("Live");

            // the clone is an independent copy — editing it does not touch
            // the source overlay
            const dupEditRes = await fetch(
                `${baseUrl}/api/overlays/${dupBody.id}/elements`,
                {
                    method: "PUT",
                    headers: { cookie, "content-type": "application/json" },
                    body: JSON.stringify({
                        element: {
                            ...(dupBody.overlay.elements[0] as OverlayElement),
                            props: { text: "Cloned" },
                        } satisfies OverlayElement,
                    }),
                },
            );
            expect(dupEditRes.status).toBe(200);
            const dupEditOverlay = (await dupEditRes.json()) as {
                overlay: Overlay;
            };
            expect(
                (dupEditOverlay.overlay.elements[0] as OverlayElement).props
                    ?.text,
            ).toBe("Cloned");

            // the clone is owned by the same user, so the same user token
            // opens its runtime WS too (owner auth, not a per-overlay token)
            const dupSocket = await connectSocket(
                `${baseUrl.replace(/^http/, "ws")}/overlay/${dupBody.id}/ws?token=${token}`,
            );
            expect(
                (
                    await nextFrame(
                        dupSocket,
                        (f) => f.event === "overlays.snapshot",
                    )
                ).data,
            ).toMatchObject({ overlay: { name: "Intro (copy)" } });
            dupSocket.close();

            const delDupRes = await fetch(`${baseUrl}/api/overlays/${dupBody.id}`, {
                method: "DELETE",
                headers: { cookie },
            });
            expect(delDupRes.status).toBe(200);
            const listAfterDelete = await nextFrame(
                editorSocket,
                (f) =>
                    f.event === "overlays.overlays" &&
                    !(
                        (f.data as { overlays?: OverlaySummary[] })
                            ?.overlays ?? []
                    ).some((o) => o.id === dupBody.id),
            );
            expect(
                (listAfterDelete.data as { overlays: OverlaySummary[] })
                    .overlays.map((o) => o.id),
            ).toEqual([overlayId]);

            // a binding to a nonexistent variable is rejected with a 400 and
            // must not wedge the in-memory overlay — the overlay stays
            // editable afterwards (a failed revalidate used to leave stale
            // state and 500 every later mutation)
            const staleBindingRes = await fetch(
                `${baseUrl}/api/overlays/${overlayId}/elements`,
                {
                    method: "PUT",
                    headers: { cookie, "content-type": "application/json" },
                    body: JSON.stringify({
                        element: {
                            id: crypto.randomUUID(),
                            name: "orphan",
                            type: "text",
                            transform: {
                                x: 0,
                                y: 0,
                                width: 100,
                                height: 20,
                                rotation: 0,
                                opacity: 1,
                            },
                            visible: true,
                            locked: false,
                            parentId: null,
                            bindings: {
                                "props.text": {
                                    variableId: crypto.randomUUID(),
                                },
                            },
                            props: { text: "orphan" },
                        } satisfies OverlayElement,
                    }),
                },
            );
            expect(staleBindingRes.status).toBe(400);
            const healedRes = await fetch(
                `${baseUrl}/api/overlays/${overlayId}/elements`,
                {
                    method: "PUT",
                    headers: { cookie, "content-type": "application/json" },
                    body: JSON.stringify({
                        element: { ...element, props: { text: "Healed" } },
                    }),
                },
            );
            expect(healedRes.status).toBe(200);
            const healedOverlay = (await healedRes.json()) as {
                overlay: Overlay;
            };
            expect(healedOverlay.overlay.elements).toHaveLength(1);
            expect(
                (healedOverlay.overlay.elements[0] as OverlayElement).props
                    ?.text,
            ).toBe("Healed");

            // rename via the single-overlay PUT
            const renameRes = await fetch(`${baseUrl}/api/overlays/${overlayId}`, {
                method: "PUT",
                headers: { cookie, "content-type": "application/json" },
                body: JSON.stringify({ name: "Intro show" }),
            });
            expect(renameRes.status).toBe(200);
            const renameBody = (await renameRes.json()) as {
                ok: boolean;
                overlay: Overlay;
            };
            expect(renameBody.ok).toBe(true);
            expect(renameBody.overlay.name).toBe("Intro show");
            // an empty name is a 400
            expect(
                (
                    await fetch(`${baseUrl}/api/overlays/${overlayId}`, {
                        method: "PUT",
                        headers: { cookie, "content-type": "application/json" },
                        body: JSON.stringify({ name: "   " }),
                    })
                ).status,
            ).toBe(400);

            // a second overlay gets its own unique id
            const secondOverlayRes = await fetch(`${baseUrl}/api/overlays`, {
                method: "POST",
                headers: { cookie, "content-type": "application/json" },
                body: JSON.stringify({ name: "Second" }),
            });
            const secondOverlay = (
                (await secondOverlayRes.json()) as {
                    id: string;
                }
            );
            expect(secondOverlay.id).not.toBe(overlayId);
            const delSecondRes = await fetch(
                `${baseUrl}/api/overlays/${secondOverlay.id}`,
                { method: "DELETE", headers: { cookie } },
            );
            expect(delSecondRes.status).toBe(200);

            // ── variables ──
            const varRes = await fetch(
                `${baseUrl}/api/overlays/${overlayId}/variables`,
                {
                    method: "POST",
                    headers: { cookie, "content-type": "application/json" },
                    body: JSON.stringify({ name: "score", type: "number" }),
                },
            );
            expect(varRes.status).toBe(201);
            const varBody = (await varRes.json()) as {
                ok: boolean;
                variable: { id: string; name: string };
            };
            expect(varBody.variable.name).toBe("score");

            // a second number + a boolean, so the token endpoint's
            // multi-value batches can be tested; the token endpoint keys
            // variables on their NAMES (unique per overlay)
            for (const [name, type] of [
                ["lives", "number"],
                ["live", "boolean"],
            ] as const) {
                const batchVarRes = await fetch(
                    `${baseUrl}/api/overlays/${overlayId}/variables`,
                    {
                        method: "POST",
                        headers: { cookie, "content-type": "application/json" },
                        body: JSON.stringify({ name, type }),
                    },
                );
                expect(batchVarRes.status).toBe(201);
            }

            const setVarRes = await fetch(
                `${baseUrl}/api/overlays/${overlayId}/variables/${varBody.variable.id}`,
                {
                    method: "PUT",
                    headers: { cookie, "content-type": "application/json" },
                    body: JSON.stringify({ value: 42 }),
                },
            );
            expect(setVarRes.status).toBe(200);
            expect(await setVarRes.json()).toMatchObject({
                ok: true,
                variable: { name: "score", value: 42 },
            });

            const variablesEvent = await nextFrame(
                editorSocket,
                (f) =>
                    f.event === "overlays.overlay" &&
                    variablesOf(f).some((v) =>
                        v.name === "score" && v.value === 42,
                    ),
            );
            expect(variablesOf(variablesEvent).map((v) => v.value)).toEqual([
                42, 0, false,
            ]);

            // variable type is enforced
            const badVarRes = await fetch(
                `${baseUrl}/api/overlays/${overlayId}/variables/${varBody.variable.id}`,
                {
                    method: "PUT",
                    headers: { cookie, "content-type": "application/json" },
                    body: JSON.stringify({ value: "not-a-number" }),
                },
            );
            expect(badVarRes.status).toBe(400);

            // ── token-gated variable modification (copy icon in the editor) ──
            // every query param except the token is <name>=<value>
            const tokenVarRes = await fetch(
                `${baseUrl}/overlay/${overlayId}/variables?token=${token}&score=7`,
            );
            expect(tokenVarRes.status).toBe(200);
            expect(await tokenVarRes.json()).toMatchObject({
                ok: true,
                variables: [
                    { name: "score", value: 7 },
                    { name: "lives", value: 0 },
                    { name: "live", value: false },
                ],
            });

            // the editor feed sees the same update
            const tokenVarEvent = await nextFrame(
                editorSocket,
                (f) =>
                    f.event === "overlays.overlay" &&
                    variablesOf(f).some((v) => v.name === "score" && v.value === 7),
            );
            expect(variablesOf(tokenVarEvent).map((v) => v.value)).toEqual([
                7, 0, false,
            ]);

            // bad token → 404 (no existence leak), bad value → 400,
            // unknown name → 404
            expect(
                (
                    await fetch(
                        `${baseUrl}/overlay/${overlayId}/variables?token=deadbeef&score=7`,
                    )
                ).status,
            ).toBe(404);
            expect(
                (
                    await fetch(
                        `${baseUrl}/overlay/${overlayId}/variables?token=${token}&score=not-a-number`,
                    )
                ).status,
            ).toBe(400);
            expect(
                (
                    await fetch(
                        `${baseUrl}/overlay/${overlayId}/variables?token=${token}&live=sometimes`,
                    )
                ).status,
            ).toBe(400);
            expect(
                (
                    await fetch(
                        `${baseUrl}/overlay/${overlayId}/variables?token=${token}&nope=7`,
                    )
                ).status,
            ).toBe(404);
            // a bare token (no <name> params) sets nothing → 400
            expect(
                (await fetch(`${baseUrl}/overlay/${overlayId}/variables?token=${token}`))
                    .status,
            ).toBe(400);

            // the boolean variable maps the querystring's "true"/"false"
            // (a bare !!truthy would turn "false" into true)
            const boolVarRes = await fetch(
                `${baseUrl}/overlay/${overlayId}/variables?token=${token}&live=false`,
            );
            expect(boolVarRes.status).toBe(200);
            expect(await boolVarRes.json()).toMatchObject({
                ok: true,
                variables: [
                    { name: "score", value: 7 },
                    { name: "lives", value: 0 },
                    { name: "live", value: false },
                ],
            });

            // a batch: several <name>=<value> pairs land in one commit +
            // one frame
            const batchRes = await fetch(
                `${baseUrl}/overlay/${overlayId}/variables?token=${token}&score=9&lives=3&live=true`,
            );
            expect(batchRes.status).toBe(200);
            expect(await batchRes.json()).toMatchObject({
                ok: true,
                variables: [
                    { name: "score", value: 9 },
                    { name: "lives", value: 3 },
                    { name: "live", value: true },
                ],
            });
            const batchEvent = await nextFrame(
                editorSocket,
                (f) =>
                    f.event === "overlays.overlay" &&
                    variablesOf(f).length === 3 &&
                    variablesOf(f).every((v) =>
                        (
                            { score: 9, lives: 3, live: true } as Record<
                                string,
                                unknown
                            >
                        )[v.name] === v.value,
                    ),
            );
            expect(variablesOf(batchEvent).map((v) => v.name)).toEqual([
                "score", "lives", "live",
            ]);

            // empty value → clear: the variable is emptied to its type's
            // neutral value (number → 0) and the clear is pushed to the feed
            const clearVarRes = await fetch(
                `${baseUrl}/overlay/${overlayId}/variables?token=${token}&score=`,
            );
            expect(clearVarRes.status).toBe(200);
            expect(await clearVarRes.json()).toMatchObject({
                ok: true,
                variables: [
                    { name: "score", value: 0 },
                    { name: "lives", value: 3 },
                    { name: "live", value: true },
                ],
            });
            const clearVarEvent = await nextFrame(
                editorSocket,
                (f) =>
                    f.event === "overlays.overlay" &&
                    variablesOf(f).length === 3 &&
                    variablesOf(f).every((v) =>
                        (
                            { score: 0, lives: 3, live: true } as Record<
                                string,
                                unknown
                            >
                        )[v.name] === v.value,
                    ),
            );
            expect(variablesOf(clearVarEvent).map((v) => v.name)).toEqual([
                "score", "lives", "live",
            ]);

            // the runtime feed gets the revalue and the clear (this is
            // what the runtime page diffs for trigger firing + auto-empty)
            const clearSocket = await connectSocket(
                `${baseUrl.replace(/^http/, "ws")}/overlay/${overlayId}/ws?token=${token}`,
            );
            try {
                const clearSnapshot = await nextFrame(
                    clearSocket,
                    (f) => f.event === "overlays.snapshot",
                );
                expect(
                    (
                        clearSnapshot.data as { overlay: Overlay }
                    ).overlay.variables.map((v) => v.value),
                ).toEqual([0, 3, true]);
                expect(
                    (
                        await fetch(
                            `${baseUrl}/overlay/${overlayId}/variables?token=${token}&score=5`,
                        )
                    ).status,
                ).toBe(200);
                const clearLive = await nextFrame(
                    clearSocket,
                    (f) =>
                        f.event === "overlays.overlay" &&
                        variablesOf(f).some((v) => v.name === "score" && v.value === 5),
                );
                expect(
                    (clearLive.data as { overlay: Overlay }).overlay.variables.map(
                        (v) => v.value,
                    ),
                ).toEqual([5, 3, true]);
                expect(
                    (
                        await fetch(
                            `${baseUrl}/overlay/${overlayId}/variables?token=${token}&score=`,
                        )
                    ).status,
                ).toBe(200);
                const clearCleared = await nextFrame(
                    clearSocket,
                    (f) =>
                        f.event === "overlays.overlay" &&
                        variablesOf(f).length === 3 &&
                        variablesOf(f).every((v) =>
                            [0, 3, true].includes(
                                v.value as number | boolean,
                            ),
                        ),
                );
                expect(
                    (
                        clearCleared.data as { overlay: Overlay }
                    ).overlay.variables.map((v) => v.value),
                ).toEqual([0, 3, true]);
            } finally {
                clearSocket.close();
            }
            expect(
                (
                    await fetch(
                        `${baseUrl}/overlay/${overlayId}/variables?token=${token}&nope=`,
                    )
                ).status,
            ).toBe(404);
            expect(
                (
                    await fetch(
                        `${baseUrl}/overlay/${overlayId}/variables?token=deadbeef&nope=`,
                    )
                ).status,
            ).toBe(404);

            // ── POST /overlay/:id/variables: JSON body, typed values ──
            const postVarRes = await fetch(
                `${baseUrl}/overlay/${overlayId}/variables?token=${token}`,
                {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ score: 11, lives: 2, live: true }),
                },
            );
            expect(postVarRes.status).toBe(200);
            expect(await postVarRes.json()).toMatchObject({
                ok: true,
                variables: [
                    { name: "score", value: 11 },
                    { name: "lives", value: 2 },
                    { name: "live", value: true },
                ],
            });
            const postVarEvent = await nextFrame(
                editorSocket,
                (f) =>
                    f.event === "overlays.overlay" &&
                    variablesOf(f).length === 3 &&
                    variablesOf(f).every((v) =>
                        (
                            { score: 11, lives: 2, live: true } as Record<
                                string,
                                unknown
                            >
                        )[v.name] === v.value,
                    ),
            );
            expect(variablesOf(postVarEvent).map((v) => v.name)).toEqual([
                "score", "lives", "live",
            ]);

            // null (and "") clear; JSON booleans need no string mapping
            const postClearRes = await fetch(
                `${baseUrl}/overlay/${overlayId}/variables?token=${token}`,
                {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ score: null, lives: "", live: false }),
                },
            );
            expect(postClearRes.status).toBe(200);
            expect(await postClearRes.json()).toMatchObject({
                ok: true,
                variables: [
                    { name: "score", value: 0 },
                    { name: "lives", value: 0 },
                    { name: "live", value: false },
                ],
            });

            // bad bodies → 400, unknown name → 404, bad token → 404
            const badJsonRes = await fetch(
                `${baseUrl}/overlay/${overlayId}/variables?token=${token}`,
                {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: "not json",
                },
            );
            expect(badJsonRes.status).toBe(400);
            expect(
                (
                    await fetch(`${baseUrl}/overlay/${overlayId}/variables?token=${token}`, {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify([1, 2, 3]),
                    })
                ).status,
            ).toBe(400);
            expect(
                (
                    await fetch(`${baseUrl}/overlay/${overlayId}/variables?token=${token}`, {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({}),
                    })
                ).status,
            ).toBe(400);
            expect(
                (
                    await fetch(
                        `${baseUrl}/overlay/${overlayId}/variables?token=${token}`,
                        {
                            method: "POST",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({ nope: 1 }),
                        },
                    )
                ).status,
            ).toBe(404);
            expect(
                (
                    await fetch(`${baseUrl}/overlay/${overlayId}/variables?token=deadbeef`, {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ score: 1 }),
                    })
                ).status,
            ).toBe(404);
            expect(
                (
                    await fetch(
                        `${baseUrl}/overlay/${overlayId}/variables?token=${token}`,
                        {
                            method: "POST",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({ score: "NaN" }),
                        },
                    )
                ).status,
            ).toBe(400);

            // ── runtime page + WS ──
            const runtimePage = await fetch(
                `${baseUrl}/overlay/${overlayId}?token=${token}`,
            );
            expect(runtimePage.status).toBe(200);
            const runtimeHtml = await runtimePage.text();
            // the bundled runtime page ships the overlay stylesheet + script
            expect(runtimeHtml).toContain("/assets/overlay_view-");

            // bad token → same blank page (no error text)
            const badPage = await fetch(
                `${baseUrl}/overlay/${overlayId}?token=deadbeef`,
            );
            expect(badPage.status).toBe(200);
            const badText = await badPage.text();
            expect(badText.toLowerCase()).not.toContain("invalid");
            expect(badText.toLowerCase()).not.toContain("404");

            // bad token → the WS refuses the connection
            await connectRefused(
                `${baseUrl.replace(/^http/, "ws")}/overlay/${overlayId}/ws?token=deadbeef`,
            );

            // unknown overlay id with a good token → also refused
            await connectRefused(
                `${baseUrl.replace(/^http/, "ws")}/overview/ws?token=${token}`,
            );

            // good token → snapshot, then a live overlay update
            const runtimeSocket = await connectSocket(
                `${baseUrl.replace(/^http/, "ws")}/overlay/${overlayId}/ws?token=${token}`,
            );
            try {
                const snapshot = await nextFrame(
                    runtimeSocket,
                    (f) => f.event === "overlays.snapshot",
                );
                expect(
                    (snapshot.data as { overlay: Overlay }).overlay.name,
                ).toBe("Intro show");
                expect(
                    (snapshot.data as { overlay: Overlay }).overlay.variables,
                ).toHaveLength(3);
                // the runtime page compares this to its own bundled version
                // and reloads when a new deployment replaced the server
                expect(
                    (snapshot.data as { version: string }).version,
                ).toBe(APP_VERSION);

                const patchRes = await fetch(
                    `${baseUrl}/api/overlays/${overlayId}/elements`,
                    {
                        method: "PUT",
                        headers: { cookie, "content-type": "application/json" },
                        body: JSON.stringify({
                            element: { ...element, props: { text: "Updated" } },
                        }),
                    },
                );
                expect(patchRes.status).toBe(200);

                const live = await nextFrame(
                    runtimeSocket,
                    (f) => f.event === "overlays.overlay",
                );
                const liveEl = (
                    live.data as { overlay: Overlay }
                ).overlay.elements[0] as OverlayElement;
                expect(liveEl.props?.text).toBe("Updated");
            } finally {
                runtimeSocket.close();
            }

            // ── GET /overlay/:id/event/<name>: the universal event endpoint ──
            // an alert element listens for a named event; the endpoint fires
            // it by name and optional ?<name>=<value> pairs ride with the
            // event — they are written to the overlay variables when the
            // element plays it (the runtime uplinks `overlays.applyEvent`),
            // so a queued element's values never clobber the on-air ones
            // early
            const alertElementId = crypto.randomUUID();
            const alertUpsertRes = await fetch(
                `${baseUrl}/api/overlays/${overlayId}/elements`,
                {
                    method: "PUT",
                    headers: { cookie, "content-type": "application/json" },
                    body: JSON.stringify({
                        element: {
                            id: alertElementId,
                            name: "test alert",
                            type: "alert",
                            transform: {
                                x: 0,
                                y: 0,
                                width: 400,
                                height: 200,
                                rotation: 0,
                                opacity: 1,
                            },
                            visible: true,
                            locked: false,
                            parentId: null,
                            bindings: {},
                            props: { event: "test.alert" },
                        } satisfies OverlayElement,
                    }),
                },
            );
            expect(alertUpsertRes.status).toBe(200);

            const alertSocket = await connectSocket(
                `${baseUrl.replace(/^http/, "ws")}/overlay/${overlayId}/ws?token=${token}`,
            );
            try {
                await nextFrame(
                    alertSocket,
                    (f) => f.event === "overlays.snapshot",
                );

                // values ride along as query pairs, the trigger is the
                // URL's <name>; the response no longer carries (revalued)
                // variables — they persist only when the element plays it
                const alertRes = await fetch(
                    `${baseUrl}/overlay/${overlayId}/event/test.alert?token=${token}&score=4&live=true`,
                );
                expect(alertRes.status).toBe(200);
                expect(await alertRes.json()).toEqual({
                    ok: true,
                    name: "test.alert",
                });

                // the event lands on the runtime socket with the
                // validated + type-coerced payload (string query values
                // → 4 / true); no `overlays.overlay` frame accompanies it —
                // nothing is written to the overlay yet
                const alertEvent = await nextFrame(
                    alertSocket,
                    (f) =>
                        f.event === "overlays.event" &&
                        (f.data as { name?: string }).name === "test.alert",
                );
                expect(alertEvent.data).toMatchObject({
                    name: "test.alert",
                    payload: { score: 4, live: true },
                });

                // the overlay variables are untouched at trigger time:
                // the runtime page applies them when it plays the event
                const beforePlay = (await (
                    await fetch(`${baseUrl}/api/overlays/${overlayId}`, {
                        headers: { cookie },
                    })
                ).json()) as { overlay: Overlay };
                expect(
                    Object.fromEntries(
                        beforePlay.overlay.variables.map((v) => [
                            v.name,
                            v.value,
                        ]),
                    ),
                ).toMatchObject({ score: 0, lives: 0, live: false });

                // the runtime page's uplink: the event went on air, so its
                // values land in the overlay (one commit + one frame)
                alertSocket.send(
                    JSON.stringify({
                        type: "event",
                        event: "overlays.applyEvent",
                        data: { values: { score: 4, live: true } },
                    }),
                );
                await nextFrame(
                    alertSocket,
                    (f) =>
                        f.event === "overlays.overlay" &&
                        variablesOf(f).length === 3 &&
                        variablesOf(f).every((v) =>
                            (
                                { score: 4, lives: 0, live: true } as Record<
                                    string,
                                    unknown
                                >
                            )[v.name] === v.value,
                        ),
                );
                const afterPlay = (await (
                    await fetch(`${baseUrl}/api/overlays/${overlayId}`, {
                        headers: { cookie },
                    })
                ).json()) as { overlay: Overlay };
                expect(
                    Object.fromEntries(
                        afterPlay.overlay.variables.map((v) => [v.name, v.value]),
                    ),
                ).toMatchObject({ score: 4, lives: 0, live: true });

                // unknown variable in the batch → 404, bad token → 404
                expect(
                    (
                        await fetch(
                            `${baseUrl}/overlay/${overlayId}/event/test.alert?token=${token}&nope=1`,
                        )
                    ).status,
                ).toBe(404);
                expect(
                    (
                        await fetch(
                            `${baseUrl}/overlay/${overlayId}/event/test.alert?token=deadbeef`,
                        )
                    ).status,
                ).toBe(404);

                // a bare trigger (no values) is fine — the name just needs
                // to match an element on the client; the event frame is
                // published either way
                const bareAlertRes = await fetch(
                    `${baseUrl}/overlay/${overlayId}/event/no.such.event?token=${token}`,
                );
                expect(bareAlertRes.status).toBe(200);
                expect(await bareAlertRes.json()).toMatchObject({
                    ok: true,
                    name: "no.such.event",
                });
                expect(
                    await nextFrame(
                        alertSocket,
                        (f) =>
                            f.event === "overlays.event" &&
                            (f.data as { name?: string }).name ===
                                "no.such.event",
                    ),
                ).toBeTruthy();
            } finally {
                alertSocket.close();
            }

            // ── owner isolation: the runtime is gated on the owner's user
            // token, so an unknown token (no user) is refused everywhere ──
            await connectRefused(
                `${baseUrl.replace(/^http/, "ws")}/overlay/${overlayId}/ws?token=deadbeef`,
            );
            expect(
                (
                    await fetch(
                        `${baseUrl}/overlay/${overlayId}/variables?token=deadbeef&score=1`,
                    )
                ).status,
            ).toBe(404);

            // the owner's user token opens the WS (a fresh connection sees the
            // canonical snapshot)
            const freshSocket = await connectSocket(
                `${baseUrl.replace(/^http/, "ws")}/overlay/${overlayId}/ws?token=${token}`,
            );
            const freshSnapshot = await nextFrame(
                freshSocket,
                (f) => f.event === "overlays.snapshot",
            );
            expect(
                (freshSnapshot.data as { overlay: Overlay }).overlay.canvas,
            ).toEqual({ width: 1920, height: 1080 });
            freshSocket.close();

            // ── delete cleanup ──
            const delVarRes = await fetch(
                `${baseUrl}/api/overlays/${overlayId}/variables/${varBody.variable.id}`,
                { method: "DELETE", headers: { cookie } },
            );
            expect(delVarRes.status).toBe(200);
            expect(
                (
                    await fetch(
                        `${baseUrl}/api/overlays/${overlayId}/elements/${alertElementId}`,
                        { method: "DELETE", headers: { cookie } },
                    )
                ).status,
            ).toBe(200);
            const delElRes = await fetch(
                `${baseUrl}/api/overlays/${overlayId}/elements/${element.id}`,
                { method: "DELETE", headers: { cookie } },
            );
            expect(delElRes.status).toBe(200);
            expect(
                ((await delElRes.json()) as { overlay: Overlay }).overlay
                    .elements,
            ).toHaveLength(0);
            // unknown ids below that mutation are 404s, not 500s
            expect(
                (
                    await fetch(
                        `${baseUrl}/api/overlays/${overlayId}/elements/nope`,
                        { method: "DELETE", headers: { cookie } },
                    )
                ).status,
            ).toBe(404);

            const delOverlayRes = await fetch(
                `${baseUrl}/api/overlays/${overlayId}`,
                { method: "DELETE", headers: { cookie } },
            );
            expect(delOverlayRes.status).toBe(200);
            const listAfterOverlayDelete = await nextFrame(
                editorSocket,
                (f) =>
                    f.event === "overlays.overlays" &&
                    !(
                        (f.data as { overlays?: OverlaySummary[] })
                            ?.overlays ?? []
                    ).some((o) => o.id === overlayId),
            );
            expect(
                (
                    listAfterOverlayDelete.data as {
                        overlays: OverlaySummary[];
                    }
                ).overlays,
            ).toEqual([]);

            // unknown ids are 404s, not 500s
            expect(
                (
                    await fetch(`${baseUrl}/api/overlays/nope`, {
                        method: "DELETE",
                        headers: { cookie },
                    })
                ).status,
            ).toBe(404);
            expect(
                (
                    await fetch(`${baseUrl}/api/overlays/nope/duplicate`, {
                        method: "POST",
                        headers: { cookie },
                    })
                ).status,
            ).toBe(404);
            expect(
                (
                    await fetch(`${baseUrl}/api/overlays`, {
                        method: "PUT",
                        headers: { cookie, "content-type": "application/json" },
                        body: JSON.stringify({}),
                    })
                ).status,
            ).toBe(405);
        } finally {
            editorSocket.close();
        }

        // ── runtime file serving (asset-library reuse) ─────────────
        // The user's asset library (the server-side asset manager) is what
        // `libraryAssetId` references; the OBS runtime page has no session,
        // so the bytes must be reachable through the owner's user token alone.
        // A dedicated overlay keeps the assertions above (which count the
        // "Intro" overlay's single element) intact.
        const mediaCreate = await fetch(`${baseUrl}/api/overlays`, {
            method: "POST",
            headers: { cookie, "content-type": "application/json" },
            body: JSON.stringify({ name: "Media" }),
        });
        expect(mediaCreate.status).toBe(201);
        const media = (await mediaCreate.json()) as {
            id: string;
        };

        const rootRes = await fetch(`${baseUrl}/api/assets/folders`, {
            headers: { cookie },
        });
        const rootFolder = (
            (await rootRes.json()) as { folders: { id: string }[] }
        ).folders[0].id;
        const form = new FormData();
        form.append("folderId", rootFolder);
        form.append(
            "files",
            new File([new TextEncoder().encode("library-bytes")], "lib.png", {
                type: "image/png",
            }),
        );
        const libUpload = await fetch(`${baseUrl}/api/assets/files`, {
            method: "POST",
            headers: { cookie },
            body: form,
        });
        expect(libUpload.status).toBe(200);
        const libFile = (
            (await libUpload.json()) as { files: { id: string }[] }
        ).files[0];

        const libElement: OverlayElement = {
            id: crypto.randomUUID(),
            name: "library-image",
            type: "image",
            transform: {
                x: 0,
                y: 0,
                width: 120,
                height: 80,
                rotation: 0,
                opacity: 1,
            },
            visible: true,
            locked: false,
            parentId: null,
            bindings: {},
            props: { assetId: "", libraryAssetId: libFile.id },
        };
        const libRes = await fetch(
            `${baseUrl}/api/overlays/${media.id}/elements`,
            {
                method: "PUT",
                headers: { cookie, "content-type": "application/json" },
                body: JSON.stringify({ element: libElement }),
            },
        );
        expect(libRes.status).toBe(200);

        // the owner's file serves through the owner's user token
        const served = await fetch(
            `${baseUrl}/overlay/${media.id}/files/${libFile.id}?token=${token}`,
        );
        expect(served.status).toBe(200);
        expect(served.headers.get("content-type")).toBe("image/png");
        expect(await served.text()).toBe("library-bytes");

        // a bad token, unknown overlay, or unknown file all 404 (the probe
        // must not leak existence, like the runtime page)
        expect(
            (
                await fetch(
                    `${baseUrl}/overlay/${media.id}/files/${libFile.id}?token=deadbeef`,
                )
            ).status,
        ).toBe(404);
        expect(
            (
                await fetch(
                    `${baseUrl}/overlay/nope/files/${libFile.id}?token=${token}`,
                )
            ).status,
        ).toBe(404);
        expect(
            (
                await fetch(
                    `${baseUrl}/overlay/${media.id}/files/00000000-0000-4000-8000-000000000000?token=${token}`,
                )
            ).status,
        ).toBe(404);

        // tidy up so the user is back to no overlays
        const mediaDelete = await fetch(
            `${baseUrl}/api/overlays/${media.id}`,
            { method: "DELETE", headers: { cookie } },
        );
        expect(mediaDelete.status).toBe(200);

        // the overlays from the test are gone; the user is back to none
        const after = (await (
            await fetch(`${baseUrl}/api/overlays`, { headers: { cookie } })
        ).json()) as { overlays: OverlaySummary[] };
        expect(after.overlays).toEqual([]);
    }, 30_000);

    test("live-map route history: path.end renames the live default route", async () => {
        const cookie = await login();
        const tokenRes = await fetch(`${baseUrl}/api/profile/tokens`, {
            method: "POST",
            headers: { cookie },
        });
        const tokenBody = (await tokenRes.json()) as {
            ok: boolean;
            token: { token: string };
        };
        const token = tokenBody.token.token;

        const createRes = await fetch(`${baseUrl}/api/overlays`, {
            method: "POST",
            headers: { cookie, "content-type": "application/json" },
            body: JSON.stringify({ name: "Route" }),
        });
        expect(createRes.status).toBe(201);
        const overlayId = ((await createRes.json()) as { id: string }).id;

        type HistoryPath = {
            id: string;
            name: string;
            startedAt: number;
            endedAt: number | null;
            points: { lat: number; lon: number; at: number }[];
        };
        type HistoryBody = { ok: boolean; paths: HistoryPath[] };
        const history = async (): Promise<HistoryBody> => {
            const res = await fetch(
                `${baseUrl}/overlay/${overlayId}/map-history?token=${token}`,
            );
            expect(res.status).toBe(200);
            return (await res.json()) as HistoryBody;
        };
        const pushFix = async (lat: number, lon: number): Promise<void> => {
            const res = await fetch(
                `${baseUrl}/overlay/${overlayId}/variables?token=${token}&pos=${lon},${lat}`,
            );
            expect(res.status).toBe(200);
        };
        const trigger = async (name: string): Promise<void> => {
            const res = await fetch(
                `${baseUrl}/overlay/${overlayId}/event/${name}?token=${token}`,
            );
            expect(res.status).toBe(200);
            expect(await res.json()).toMatchObject({ ok: true, name });
        };

        // the one variable the map centre is bound to — the phone pushes
        // fixes as `pos` in the `"lon,lat"` wire format and the server
        // records them into the open routes
        const varRes = await fetch(
            `${baseUrl}/api/overlays/${overlayId}/variables`,
            {
                method: "POST",
                headers: { cookie, "content-type": "application/json" },
                body: JSON.stringify({ name: "pos", type: "string" }),
            },
        );
        expect(varRes.status).toBe(201);
        const positionId = (
            (await varRes.json()) as { variable: { id: string } }
        ).variable.id;
        const mapElement: OverlayElement = {
            id: crypto.randomUUID(),
            name: "map",
            type: "live_map",
            transform: {
                x: 0,
                y: 0,
                width: 640,
                height: 420,
                rotation: 0,
                opacity: 1,
            },
            visible: true,
            locked: false,
            parentId: null,
            bindings: {
                "props.centerPosition": {
                    kind: "variable",
                    variableId: positionId,
                },
            },
            props: { keepHistory: true },
        };
        const mapRes = await fetch(
            `${baseUrl}/api/overlays/${overlayId}/elements`,
            {
                method: "PUT",
                headers: { cookie, "content-type": "application/json" },
                body: JSON.stringify({ element: mapElement }),
            },
        );
        expect(mapRes.status).toBe(200);

        // no routes yet
        expect(await history()).toEqual({ ok: true, paths: [] });

        // the first fix opens the implicit `default` route — a live trace is
        // visible from the very first position
        await pushFix(50.1, 12.4);
        let body = await history();
        expect(body.paths).toHaveLength(1);
        expect(body.paths[0].name).toBe("default");
        expect(body.paths[0].endedAt).toBeNull();
        expect(body.paths[0].startedAt).toBeGreaterThan(0);
        expect(body.paths[0].points[0]).toMatchObject({
            lat: 50.1,
            lon: 12.4,
        });

        // more fixes keep landing in the single live `default` route
        await Bun.sleep(5);
        await pushFix(50.1001, 12.4001);
        await Bun.sleep(5);
        await pushFix(50.1002, 12.4002);
        body = await history();
        expect(body.paths).toHaveLength(1);
        expect(body.paths[0].endedAt).toBeNull();
        expect(body.paths[0].points).toHaveLength(3);
        expect(body.paths[0].points[2]).toMatchObject({
            lat: 50.1002,
            lon: 12.4002,
        });

        // path.end/les RENAMES the live `default` route and closes it
        await trigger("path.end/les");
        body = await history();
        expect(body.paths).toHaveLength(1);
        expect(body.paths[0].name).toBe("les");
        expect(body.paths[0].endedAt).not.toBeNull();
        expect(body.paths[0].points).toHaveLength(3);

        // ending again with no live `default` open is a no-op (no duplicate)
        await trigger("path.end/les");
        expect((await history()).paths).toHaveLength(1);

        // the next fix opens a FRESH `default` route, alongside the archived
        // one (which keeps its points)
        await pushFix(50.101, 12.401);
        body = await history();
        expect(body.paths.map((p) => p.name)).toEqual(["les", "default"]);
        expect(body.paths[0].endedAt).not.toBeNull();
        expect(body.paths[0].points).toHaveLength(3);
        expect(body.paths[1].endedAt).toBeNull();
        expect(body.paths[1].points).toHaveLength(1);
        expect(body.paths[1].points[0]).toMatchObject({
            lat: 50.101,
            lon: 12.401,
        });

        // probes: a bad token or a foreign overlay id 404s (no leak)
        expect(
            (
                await fetch(
                    `${baseUrl}/overlay/${overlayId}/map-history?token=deadbeef`,
                )
            ).status,
        ).toBe(404);
        expect(
            (
                await fetch(
                    `${baseUrl}/overlay/nope/map-history?token=${token}`,
                )
            ).status,
        ).toBe(404);

        // tidying up drops the overlay's history rows with it
        const del = await fetch(`${baseUrl}/api/overlays/${overlayId}`, {
            method: "DELETE",
            headers: { cookie },
        });
        expect(del.status).toBe(200);
    }, 30_000);
});
