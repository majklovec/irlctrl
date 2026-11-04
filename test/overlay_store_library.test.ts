import { afterAll, beforeAll, describe, expect, test } from "bun:test";

/**
 * Regression: a library file that fails to load (e.g. a file the owner deleted
 * from the asset manager) must be fetched exactly once and then shown as
 * missing. The editor `ctx()` runs on every redraw, so an un-cached 404 used to
 * re-fire the fetch on every frame — an infinite 404 storm in the network log.
 *
 * The store is bundled the way the server builds it (i18n + the UI component
 * barrel stubbed) and driven with a mocked `fetch`, mirroring the runtime
 * page's headless-DOM harness in `overlay_view.test.ts`.
 */
describe("editor library asset loading (headless DOM)", () => {
    let storeBundleText = "";
    const storeFiles: string[] = [];
    let storeCounter = 0;
    const savedGlobals: [string, unknown][] = [];
    let globalsSaved = false;
    const savedFetch = globalThis.fetch;
    let fetchCalls: string[] = [];

    beforeAll(async () => {
        const { Window } = await import("happy-dom");
        const g = globalThis as Record<string, unknown>;
        for (const key of [
            "window",
            "document",
            "navigator",
            "location",
            "WebSocket",
            "requestAnimationFrame",
            "cancelAnimationFrame",
        ])
            savedGlobals.push([key, g[key]]);
        globalsSaved = true;
        const win = new Window();
        g.window = win;
        g.document = win.document;
        g.navigator = win.navigator;
        // Mithril is inlined in the bundle; `m.redraw()` needs a scheduler at
        // import time (the store never calls m.mount, so it never self-inits).
        g.requestAnimationFrame = win.requestAnimationFrame;
        g.cancelAnimationFrame = win.cancelAnimationFrame;
        // The store pulls in the shared live-feed client, which builds a
        // ws URL from `location` and opens a socket at module load — stub both.
        Object.defineProperty(g, "location", {
            value: {
                origin: "http://127.0.0.1:1",
                protocol: "http:",
                host: "127.0.0.1:1",
                href: "http://127.0.0.1:1/",
                pathname: "/",
                search: "",
            },
            configurable: true,
            writable: true,
            enumerable: true,
        });
        g.WebSocket = class {
            static OPEN = 1;
            readyState = 1;
            url: string;
            onopen: (() => void) | undefined;
            onmessage: ((e: { data: unknown }) => void) | undefined;
            onclose: (() => void) | undefined;
            constructor(url: string) {
                this.url = url;
            }
            send(_data: string): void {}
            close(): void {}
        };

        const i18nStub =
            "export const currentLanguage = () => 'en'; export const t = (k) => k; export const i18nReady = Promise.resolve();";
        const compStub = [
            "Actions", "Badge", "Break", "Button", "Card", "Checkbox",
            "CheckField", "DefinitionList", "Field", "FieldGroup", "Form",
            "IconButton", "Input", "Modal", "NumberField", "Options",
            "Select",
        ]
            .map((n) => `export const ${n} = {};`)
            .concat(["export const numberAttrs = () => ({});"])
            .join(" ");
        const result = await Bun.build({
            entrypoints: [
                new URL(
                    "../server/pages/overlays/client/overlay_store.ts",
                    import.meta.url,
                ).pathname,
            ],
            target: "browser",
            format: "esm",
            loader: { ".css": "text" },
            plugins: [
                {
                    name: "library-store-stubs",
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
                "library store test bundle failed",
            );
        storeBundleText = await result.outputs[0].text();
    });

    afterAll(async () => {
        globalThis.fetch = savedFetch;
        for (const file of storeFiles)
            await Bun.file(file).delete().catch(() => {});
        if (globalsSaved)
            for (const [key, value] of savedGlobals) {
                const g = globalThis as Record<string, unknown>;
                if (value === undefined) delete g[key];
                else g[key] = value;
            }
    });

    /** A fresh store module: Bun caches a file import by URL, so a fresh file
     * per load re-runs the script (fresh module-level state), like a new page. */
    async function freshStore(): Promise<{
        loadLibraryAssets(o: unknown): void;
        releaseLibraryAssets(): void;
    }> {
        fetchCalls = [];
        // 404 for every missing id, 200 for `present-id`.
        globalThis.fetch = (async (input: RequestInfo | URL) => {
            const path = String(input);
            fetchCalls.push(path);
            if (path.includes("present-id"))
                return new Response(
                    new Uint8Array([1, 2, 3]),
                    { status: 200, "content-type": "image/png" },
                );
            return new Response(null, { status: 404 });
        }) as typeof fetch;
        const file = new URL(
            `../.tmp-overlay-store-lib-${++storeCounter}.js`,
            import.meta.url,
        );
        storeFiles.push(file.pathname);
        await Bun.write(file, storeBundleText);
        return (await import(file.href)) as {
            loadLibraryAssets(o: unknown): void;
            releaseLibraryAssets(): void;
        };
    }

    const overlay = (assetIds: string[]) => ({
        schemaVersion: 1,
        name: "o",
        canvas: { width: 1920, height: 1080 },
        variables: [],
        elements: assetIds.map((id, i) => ({
            id: `el-${i}`,
            name: `img ${i}`,
            type: "image",
            transform: {
                x: 0, y: 0, width: 100, height: 100, rotation: 0, opacity: 1,
            },
            visible: true,
            locked: false,
            parentId: null,
            bindings: {},
            props: { libraryAssetId: id },
        })),
    });

    test("a missing file is fetched once, not on every redraw", async () => {
        const store = await freshStore();
        const o = overlay(["missing-1", "missing-2"]);
        for (let i = 0; i < 5; i++) {
            store.loadLibraryAssets(o);
            // let the in-flight fetch resolve (the 404 is cached on failure)
            await Bun.sleep(20);
        }
        // Each missing id appears exactly once — no per-redraw 404 storm.
        const hitsFor = (id: string) =>
            fetchCalls.filter((p) => p.includes(id)).length;
        expect(hitsFor("missing-1")).toBe(1);
        expect(hitsFor("missing-2")).toBe(1);
    });

    test("a present file is fetched once and reused", async () => {
        const store = await freshStore();
        const o = overlay(["present-id"]);
        for (let i = 0; i < 4; i++) {
            store.loadLibraryAssets(o);
            await Bun.sleep(20);
        }
        expect(fetchCalls.filter((p) => p.includes("present-id")).length).toBe(1);
    });

    test("releaseLibraryAssets lets a re-added file be retried", async () => {
        const store = await freshStore();
        const o = overlay(["missing-1"]);
        store.loadLibraryAssets(o);
        await Bun.sleep(20);
        expect(hitsFor("missing-1")).toBe(1);
        // After the overlay switches (release), the same id is tried again.
        store.releaseLibraryAssets();
        store.loadLibraryAssets(o);
        await Bun.sleep(20);
        expect(hitsFor("missing-1")).toBe(2);
    });

    function hitsFor(id: string): number {
        return fetchCalls.filter((p) => p.includes(id)).length;
    }
});
