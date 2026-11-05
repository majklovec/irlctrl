import { describe, expect, test } from "bun:test";

describe("overlay schemas in a server process", () => {
    test("load and normalize without browser globals", () => {
        const result = Bun.spawnSync({
            cmd: [
                process.execPath,
                "-e",
                `
                    if (typeof document !== "undefined" || typeof window !== "undefined")
                        throw new Error("unexpected browser globals");
                    const { setLogTranslator, logTranslate } = await import("./shared/log_messages");
                    setLogTranslator(() => "server translator");
                    const { parseElementInput } = await import("./server/pages/overlays/overlay");
                    if (logTranslate("test") !== "server translator")
                        throw new Error("browser translator replaced server translator");
                    const element = parseElementInput({
                        id: "counter-1", name: "Counter", type: "counter",
                        transform: { x: 0, y: 0, width: 100, height: 100, rotation: 0, opacity: 1 },
                        visible: true, locked: false, parentId: null, bindings: {},
                        props: { title: "Test", fontSize: 9999 },
                    });
                    if (element.props.title !== "Test" || element.props.fontSize !== 26)
                        throw new Error("counter normalization failed");
                `,
            ],
            cwd: import.meta.dir + "/..",
            stdout: "pipe",
            stderr: "pipe",
        });
        expect(result.stderr.toString()).toBe("");
        expect(result.exitCode).toBe(0);
    });
});

describe("browser translation initialization", () => {
    test("loads translations and installs the browser log translator", () => {
        const result = Bun.spawnSync({
            cmd: [
                process.execPath,
                "-e",
                `
                    globalThis.document = { documentElement: {} };
                    globalThis.window = { location: { origin: "http://localhost" } };
                    globalThis.fetch = async () => new Response(
                        JSON.stringify({ greeting: "Hello" }),
                        { status: 200, headers: { "content-type": "application/json" } },
                    );
                    const ui = await import("./shared/ui/i18n");
                    await ui.i18nReady;
                    const { logTranslate } = await import("./shared/log_messages");
                    if (document.documentElement.lang !== "en" ||
                        ui.t("greeting") !== "Hello" ||
                        logTranslate("greeting") !== "Hello")
                        throw new Error("browser translations did not initialize");
                `,
            ],
            cwd: import.meta.dir + "/..",
            stdout: "pipe",
            stderr: "pipe",
        });
        expect(result.stderr.toString()).toBe("");
        expect(result.exitCode).toBe(0);
    });
});
