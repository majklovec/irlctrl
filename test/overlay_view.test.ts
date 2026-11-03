import { afterAll, beforeAll, describe, expect, test } from "bun:test";

/**
 * The runtime page script (`server/frontend/ts/overlays/overlay_view.tsx`) is
 * bundled the way the server does and run against a happy-dom window + a fake
 * WebSocket, fed frames the way the server sends them. The chat overlay element
 * is now self-contained (its own token-scoped stream), so the runtime no longer
 * reloads when the dashboard publishes `overlays.channelsChanged` — those frames
 * are ignored here. (The websocket e2e in overlays.test.ts proves the server
 * still publishes the frame to dashboards.)
 */
describe("overlay runtime auto-reload (headless DOM)", () => {
    let pageBundleText = "";
    let loadCount = 0;
    const pageBundleFiles: URL[] = [];
    let reloadCalls = 0;
    let swUpdates = 0;
    // bun test shares globalThis across test files, so the DOM globals set
    // up below must be restored afterwards — a leaked fake `WebSocket`
    // breaks the real-socket tests in other files.
    const savedGlobals: [string, unknown][] = [];
    let globalsSaved = false;
    const fakeSockets: {
        url: string;
        onopen: (() => void) | undefined;
        onmessage: ((e: { data: unknown }) => void) | undefined;
        onclose: (() => void) | undefined;
    }[] = [];

    beforeAll(async () => {
        const { Window } = await import("happy-dom");
        const g = globalThis as Record<string, unknown>;
        for (const key of [
            "window",
            "document",
            "navigator",
            "location",
            "requestAnimationFrame",
            "cancelAnimationFrame",
            "WebSocket",
        ])
            savedGlobals.push([key, g[key]]);
        globalsSaved = true;
        const win = new Window();
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
                host: "127.0.0.1:1",
                pathname: "/overlay/scene-1",
                search: "?token=tok",
                reload: () => (reloadCalls += 1),
            },
            configurable: true,
            writable: true,
            enumerable: true,
        });
        g.requestAnimationFrame = win.requestAnimationFrame;
        g.cancelAnimationFrame = win.cancelAnimationFrame;
        g.WebSocket = class {
            static OPEN = 1;
            url: string;
            readyState = 1;
            onopen: (() => void) | undefined;
            onmessage: ((e: { data: unknown }) => void) | undefined;
            onclose: (() => void) | undefined;
            constructor(url: string) {
                this.url = url;
                fakeSockets.push(this);
            }
            send(_data: string): void {}
        };
        win.document.body.innerHTML = '<div id="app"></div>';

        const i18nStub =
            "export const currentLanguage = () => 'en'; export const t = (k) => k; export const i18nReady = Promise.resolve();";
        // Minimal stand-ins for shared UI components, in case the runtime
        // bundle references them. None are rendered in these tests.
        const compStub = [
            "Actions", "Badge", "Break", "Button", "Card", "Checkbox",
            "CheckField", "DefinitionList", "Field", "FieldGroup", "Form",
            "IconButton", "Input", "NumberField", "Options", "Select",
        ]
            .map((n) => `export const ${n} = {};`)
            .concat(["export const numberAttrs = () => ({});"])
            .join(" ");
        const result = await Bun.build({
            entrypoints: [
                new URL(
                    "../server/frontend/ts/overlays/overlay_view.tsx",
                    import.meta.url,
                ).pathname,
            ],
            target: "browser",
            // esm: mithril stays inlined so the bundle needs no bare imports.
            format: "esm",
            loader: { ".css": "text" },
            plugins: [
                {
                    name: "overlay-runtime-reload-shell",
                    setup(b: {
                        onLoad(
                            o: { filter: RegExp },
                            cb: () => { contents: string; loader: string },
                        ): void;
                    }) {
                        b.onLoad(
                            { filter: /shared\/ui\/i18n\.tsx$/ },
                            () => ({ contents: i18nStub, loader: "js" }),
                        );
                        b.onLoad(
                            { filter: /shared\/ui\/components\/index\.tsx$/ },
                            () => ({ contents: compStub, loader: "js" }),
                        );
                    },
                },
            ],
        });
        if (!result.success)
            throw new AggregateError(
                result.logs,
                "Runtime page reload test bundle failed",
            );
        pageBundleText = await result.outputs[0].text();
    });

    afterAll(async () => {
        for (const file of pageBundleFiles)
            await Bun.file(file).delete().catch(() => {});
        if (globalsSaved)
            for (const [key, value] of savedGlobals) {
                const g = globalThis as Record<string, unknown>;
                if (value === undefined) delete g[key];
                else g[key] = value;
            }
    });

    /** Import the bundled page script; it mounts the canvas and opens its
     * (fake) websocket at the top level — a fresh file per load so Bun's
     * module cache reruns the script from scratch, as a fresh page would. */
    async function loadPage(): Promise<void> {
        reloadCalls = 0;
        swUpdates = 0;
        fakeSockets.length = 0;
        const file = new URL(
            `../.tmp-overlay-runtime-reload-${++loadCount}.js`,
            import.meta.url,
        );
        pageBundleFiles.push(file);
        await Bun.write(file, pageBundleText);
        await import(file.href);
        await Bun.sleep(10);
    }

    /** A scene the way the server's `overlays.snapshot` carries it, with one
     * iframe element per URL. */
    function snapshot(urls: string[]): void {
        frame("overlays.snapshot", {
            scene: {
                id: "scene-1",
                name: "scene",
                slug: "scene-1",
                elements: urls.map((url, i) => ({
                    id: `el-${i}`,
                    name: `embed ${i}`,
                    type: "iframe",
                    transform: {
                        x: 0,
                        y: 0,
                        width: 400,
                        height: 300,
                        rotation: 0,
                        opacity: 1,
                    },
                    visible: true,
                    locked: false,
                    parentId: null,
                    bindings: {},
                    props: { url },
                })),
            },
            variables: [],
            canvas: { width: 1920, height: 1080 },
            assets: [],
        });
    }

    function frame(event: string, data: unknown): void {
        const socket = fakeSockets[fakeSockets.length - 1];
        socket.onmessage?.({
            data: JSON.stringify({ type: "event", event, data }),
        });
    }

    const chatPage = (dashboardId: string, widgetId: string) =>
        `http://127.0.0.1:1/chat/${dashboardId}/${widgetId}?token=ctok`;

    test("does not reload when a chat channel changes (self-contained element)", async () => {
        await loadPage();
        expect(fakeSockets).toHaveLength(1);
        snapshot([chatPage("dash1", "chat1")]);
        frame("overlays.channelsChanged", {
            dashboardId: "dash1",
            widgetId: "chat1",
        });
        await Bun.sleep(40);
        // The chat element streams its own channels; no iframe to refresh, so
        // the dashboard's channel-change frame no longer reloads the runtime.
        expect(reloadCalls).toBe(0);
        expect(swUpdates).toBe(0);
    });

    test("stays put when a different widget changed", async () => {
        await loadPage();
        snapshot([chatPage("dash1", "chat1")]);
        frame("overlays.channelsChanged", {
            dashboardId: "dash2",
            widgetId: "other",
        });
        await Bun.sleep(40);
        expect(reloadCalls).toBe(0);
        expect(swUpdates).toBe(0);
    });

    test("stays put when no element embeds a module page", async () => {
        await loadPage();
        snapshot(["https://example.com/embed", "https://127.0.0.1:1/othersite"]);
        frame("overlays.channelsChanged", {
            dashboardId: "dash1",
            widgetId: "chat1",
        });
        await Bun.sleep(40);
        expect(reloadCalls).toBe(0);
        expect(swUpdates).toBe(0);
    });

    test("ignores a malformed frame (missing ids)", async () => {
        await loadPage();
        snapshot([chatPage("dash1", "chat1")]);
        frame("overlays.channelsChanged", { widgetId: "chat1" });
        await Bun.sleep(40);
        expect(reloadCalls).toBe(0);
    });

    test("does not reload even if more channel frames arrive", async () => {
        await loadPage();
        snapshot([chatPage("dash1", "chat1")]);
        frame("overlays.channelsChanged", {
            dashboardId: "dash1",
            widgetId: "chat1",
        });
        frame("overlays.channelsChanged", {
            dashboardId: "dash1",
            widgetId: "chat1",
        });
        await Bun.sleep(40);
        expect(reloadCalls).toBe(0);
    });
});
